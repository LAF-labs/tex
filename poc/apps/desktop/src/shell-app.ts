// PoC-9 데모 UI 셸의 main(PoC-6부터 엔진·금고를 띄운다). 승인 바는 main 소유 WebContentsView다(ADR-021).
// 렌더러는 바 자리를 비우기만 하고 바를 그리거나 숨기지 못한다. 승인 근거는 바 → main → 게이트 포트(엔진)로만 간다.
// 기본은 fixture 모드(가짜 H-01 페이지, 시험 정책 금고, 임시 앱 폴더). 홈택스 실제 화면은 PoC-3 셀렉터가 들어온 뒤.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Counterparty as DbCounterparty, Profile as DbProfile } from '@sax/db';
import type { EnginePortal } from '@sax/engine/protocol';
import { appPaths, defaultAppRoot, FileEventLog } from '@sax/platform';
import { app, BrowserWindow, clipboard, ipcMain, Menu, protocol, session, shell as desktop } from 'electron';
import { verifyLocalApproval } from './approval-gate.ts';
import { APPROVAL_SCHEME, ApprovalBar } from './approval-bar.ts';
import { DOCPARSE_SCHEME } from './docparse.ts';
import { EngineHost } from './engine-host.ts';
import { startFixtureMode, type FixtureMode } from './fixture-mode.ts';
import { barBounds, SHELL } from './shell-layout.ts';
import { g24Candidates, interpret, MockStore, PROFILES, QUICK, seedTimeline, type Counterparty, type G24Doc, type Profile, type VatMode } from './shell-mock.ts';
import { engineDocsProvider, type DocsProvider } from './shell-docs.ts';
import { ShellRuns } from './shell-runs.ts';
import { bundleCss, tokensCss } from './shell-tokens.ts';
import { cancelPick, importPdf } from './vault-import.ts';

const STATIC = path.join(import.meta.dirname, '../static');
export const SHELL_SCHEME = 'sax-shell';
const SHELL_URL = `${SHELL_SCHEME}://shell/shell.html`;

export function registerShellSchemes(): void {
  // 한 번만 부를 수 있다(ready 전). 문서함 PDF 가져오기가 docparse 샌드박스를 쓰므로 그 스킴도 여기서 등록한다.
  protocol.registerSchemesAsPrivileged([
    { scheme: SHELL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: APPROVAL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/** 문서함 오류 중 렌더러에 그대로 보낼 코드. 나머지(fs 오류 등, 경로가 들어 있을 수 있다)는 main 로그에만 남기고 'failed'로 보낸다. */
const DOC_CODES = new Set([
  'bad_request', 'busy', 'profile_required', 'not_pdf', 'input_size', 'read_failed', 'invalid_pdf', 'timeout', 'memory_limit', 'session_failed', 'renderer_gone',
  'pick_expired', 'password_too_long', 'schema', 'issued_in_future', 'expires_before_issued', 'expires_after_legal_max', 'invalid_issued_on', 'invalid_expires_on',
  'not_found', 'invalid_doc_type', 'file_missing', 'open_failed', 'seen_required', 'stale',
  'worker_failed', 'parse_failed', 'render_failed', 'ocr_failed', 'bad_extract',
]);

/** 문서함 오류를 렌더러에 보낼 오류로: 알려진 코드만, 나머지는 로그(앞 코드만)와 'failed' */
function docsError(e: unknown): Error {
  const code = (e as { code?: unknown }).code ?? (e as Error).message;
  if (typeof code === 'string' && DOC_CODES.has(code)) return new Error(code);
  console.error('docs failed', typeof code === 'string' ? code.split(':')[0] : (e as Error).name); // fs 오류 메시지에는 경로가 있어 앞 코드만
  return new Error('failed');
}

const FILES: Record<string, string> = {
  '/shell.html': 'text/html; charset=utf-8',
  '/shell.css': 'text/css',
  '/shell.js': 'text/javascript',
  '/shell-views.js': 'text/javascript',
  '/shell-g24.js': 'text/javascript',
};

function serve(): void {
  protocol.handle(SHELL_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/tokens.css') return new Response(tokensCss(), { headers: { 'content-type': 'text/css' } });
    if (p === '/bundle.css') return new Response(bundleCss(), { headers: { 'content-type': 'text/css' } });
    const type = FILES[p];
    if (!type) return new Response('', { status: 404 });
    return new Response(await fs.readFile(path.join(STATIC, 'shell', p.slice(1))), { headers: { 'content-type': type } });
  });
  // 렌더러는 네트워크가 없다(D01 §2.1). 자기 스킴 밖 요청을 취소한다.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${SHELL_SCHEME}://`) && !d.url.startsWith('devtools://') }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
}

export interface ShellOptions {
  width?: number;
  height?: number;
  show?: boolean;
  /** e2e: OS 커서 위치를 바꿔 끼운다. */
  cursorPoint?: () => { x: number; y: number };
  /** 앱 금고(utilityProcess·OS 키체인)와 앱 폴더로 띄운다. 없으면 fixture 모드. */
  engine?: { root?: string; portal: EnginePortal };
  /** fixture 모드에서 실행 Chrome을 화면에 띄운다(시연). */
  headful?: boolean;
  /** 문서함 보관함 공급자(shell-docs.ts). 없으면 이 셸의 엔진(host.rpc)을 쓴다. e2e가 감싸서 넘긴다. */
  docs?: DocsProvider;
}

export interface Shell {
  win: BrowserWindow;
  bar: ApprovalBar;
  runs: ShellRuns;
  store: MockStore;
  host: EngineHost;
  /** fixture 모드면 가짜 페이지·임시 앱 폴더. */
  fixture: FixtureMode | null;
  ready: Promise<void>;
  /** 렌더러가 부를 수 있는 메서드 전부(e2e가 승인 경로가 없는지 훑는다). */
  methods: string[];
  close(): Promise<void>;
}

const SIGN: Record<string, string> = { simple_auth: '사업자 간편인증', cert: '공동·금융인증서', security_card: '보안카드' };

function profileView(p: DbProfile): Profile {
  return { kind: p.kind, name: p.displayName, bizNo: p.bizNo ?? undefined, rep: p.repName ?? undefined, email: p.email ?? '', auth: SIGN[p.signMethod ?? ''] ?? '발급 인증 미설정' };
}

/** DB 거래처 → 셸 화면 모델. 품목 열이 DB에 없어 fixture 시연 값(itemHints)을 쓴다. */
function counterpartyView(c: DbCounterparty, items: Record<string, string>): Counterparty {
  return {
    id: c.id,
    name: c.name,
    bizNo: c.bizNo,
    rep: c.repName ?? '',
    email: c.email ?? '',
    item: items[c.bizNo] ?? '',
    status: c.verifiedStatus ?? '확인 전',
    checkedOn: c.verifiedAt?.slice(0, 10) ?? '',
    lastIssuedOn: c.lastUsedAt?.slice(0, 10) ?? null,
  };
}

export async function startShell(opts: ShellOptions = {}): Promise<Shell> {
  // CDP로 넣은 마우스 이벤트도 before-mouse-event를 일으키므로 원격 디버깅 스위치가 있으면 끝낸다(ADR-021, 값싼 차단).
  if (app.commandLine.hasSwitch('remote-debugging-port') || app.commandLine.hasSwitch('remote-debugging-pipe')) {
    app.exit(1);
    throw new Error('remote_debugging_switch');
  }
  serve();
  // 확대·축소 메뉴를 두지 않는다(렌더러 배율은 1, 바 자리는 DIP 고정). 접근성 배율은 Phase 1.
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { label: '창', submenu: [{ role: 'minimize' }, { role: 'close' }] }]));
  const key = new Uint8Array(randomBytes(32));
  const store = new MockStore();
  const fixture = opts.engine ? null : await startFixtureMode({ headful: opts.headful });
  const made: { host?: EngineHost } = {};
  try {
    return wireShell(opts, fixture, key, store, made);
  } catch (e) {
    // 창·바를 만들다 실패하면 엔진을 먼저 끝내고(DB가 열린 채 지우지 않게) 가짜 페이지 서버·main 안 금고·임시 앱 폴더를 지운다.
    await made.host?.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
    throw e;
  }
}

function wireShell(opts: ShellOptions, fixture: FixtureMode | null, key: Uint8Array, store: MockStore, made: { host?: EngineHost }): Shell {
  const root = fixture?.root ?? opts.engine?.root;
  const log = new FileEventLog(appPaths(root ?? defaultAppRoot()).logs, 'main');
  const host = new EngineHost({ vault: fixture ? fixture.vault : 'process', root, portal: fixture?.portal ?? opts.engine!.portal, log });
  made.host = host;
  let business: Profile | null = null;
  let cps: Counterparty[] = [];
  const refresh = async () => {
    const ps = (await host.rpc('db.query.profiles.list')) as DbProfile[];
    const b = ps.find((p) => p.kind === 'business');
    business = b ? profileView(b) : null;
    cps = ((await host.rpc('db.query.counterparties.list')) as DbCounterparty[]).map((c) => counterpartyView(c, fixture?.itemHints ?? {}));
  };
  const profiles = () => ({ business: business ?? PROFILES.business, personal: PROFILES.personal });
  const runs = new ShellRuns(host, { counterparties: () => cps, auth: () => profiles().business.auth });
  let profile: Profile['kind'] = 'business';
  const docs = opts.docs ?? engineDocsProvider((m, p) => host.rpc(m, p), importPdf);
  /** 문서함 = 보관함 서류 + 실행이 만든 서류(세금계산서·정부24 목업) */
  const listDocs = async () => {
    try {
      return [...(await docs.list()), ...store.docs];
    } catch (e) {
      throw docsError(e);
    }
  };
  /** 문서함 처리기: 오류는 docsError로 바꿔 던진다(원래 오류는 cause로 붙이지 않는다. ipcMain이 cause까지 출력하고 fs 오류에는 경로가 있다) */
  const docsCall =
    (fn: (p: Record<string, unknown>) => unknown) =>
    async (p: Record<string, unknown>): Promise<unknown> => {
      try {
        return await fn(p);
      } catch (e) {
        throw docsError(e);
      }
    };
  let importing = false;

  const win = new BrowserWindow({
    width: opts.width ?? 1280,
    height: opts.height ?? 820,
    useContentSize: true,
    minHeight: 560,
    show: opts.show ?? true,
    title: fixture ? '소버린 AX (PoC 데모 · 가짜 홈택스 페이지)' : '소버린 AX (PoC 데모)',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      disableDialogs: true,
      spellcheck: false,
      preload: path.join(STATIC, 'preload-shell.cjs'),
    },
  });
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  // 렌더러의 window.moveTo·resizeTo로 창이 움직이지 않게 한다.
  wc.on('content-bounds-updated', (e) => e.preventDefault());
  wc.on('did-finish-load', () => {
    wc.setZoomFactor(1);
    void wc.setVisualZoomLevelLimits(1, 1);
  });

  const bar = new ApprovalBar(win, key, barBounds, { cursorPoint: opts.cursorPoint });
  const send = (ev: Record<string, unknown>) => {
    if (!win.isDestroyed()) wc.send('sax:event', ev);
  };
  // 렌더러에는 바 자리를 비울지와 띠 여부만 알린다(배치용). 바 내용·좌표는 보내지 않는다.
  bar.on('shown', (e: { band: boolean }) => send({ type: 'bar', active: true, band: e.band }));
  bar.on('layout', (e: { band: boolean }) => send({ type: 'bar-layout', band: e.band }));
  bar.on('hidden', (reason: string) => send({ type: 'bar', active: false, reason }));
  runs.on('update', (run) => send({ type: 'run', run }));
  runs.on('doc', (doc) => {
    store.docs.unshift(doc);
    send({ type: 'doc', doc });
    void refresh().catch(() => {});
  });
  runs.on('gate-closed', (_runId: string, reqId: string, reason: string) => bar.close(reason, reqId));
  // 엔진이 끝나면 열린 게이트도 끝이다(근거를 받을 곳이 없다). 실행 카드는 ShellRuns가 끝낸다.
  host.on('exit', (who: string) => {
    if (who === 'engine') bar.close('engine_exit');
  });
  // 게이트 요청(엔진 → 게이트 포트 → main). main이 fields로 해시를 다시 계산해 맞을 때만 바를 무장한다(approval-bar).
  // 승인 근거는 바가 관찰한 클릭으로 main이 발급하고, 게이트 포트로만 엔진에 보낸다. 렌더러에는 이 경로가 없다.
  runs.on('gate', (runId: string, req) => {
    void bar.open(req).then(async (o) => {
      if (o.decision === 'approve') {
        if (!verifyLocalApproval(key, o.approval)) return runs.abortGate(runId, 'answer.rejected');
        // 보내기 전에 표시한다. 보낸 뒤 엔진이 끝나면 발급됐는지 모르는 쪽(in_doubt)으로 다룬다.
        runs.approved(runId);
        const r = await host.answerGate(o.approval);
        if (!r.ok) log.event('main.gate_answer_not_ok', { code: r.code ?? '', verdict: r.verdict });
        await runs.onAnswer(runId, r);
      } else if (o.reason === 'load_failed') await runs.abortGate(runId, 'bar.load_failed');
      else if (o.reason === 'busy') log.event('main.gate_while_open');
    });
  });

  const g24Doc = (v: unknown): G24Doc => {
    if (v !== '주민등록표 등본' && v !== '주민등록표 초본') throw new Error('bad_doc');
    return v;
  };
  const handlers: Record<string, (p: Record<string, unknown>) => unknown> = {
    'shell.bootstrap': async () => ({
      layout: SHELL,
      profiles: profiles(),
      profile,
      counterparties: cps,
      docs: await listDocs(),
      timeline: seedTimeline(),
      quick: QUICK,
      platform: process.platform,
    }),
    'profile.set': (p) => {
      if (p.kind !== 'business' && p.kind !== 'personal') throw new Error('bad_profile');
      profile = p.kind;
      return { profile };
    },
    'request.send': (p) => {
      const vat = p.vat === 'separate' || p.vat === 'included' ? (p.vat as VatMode) : null;
      return interpret(String(p.text ?? '').slice(0, 2000), vat, profile, runs);
    },
    'draft.update': (p) =>
      runs.updateDraft(String(p.id), {
        vat: p.vat === 'separate' || p.vat === 'included' ? p.vat : undefined,
        amount: typeof p.amount === 'number' ? p.amount : undefined,
        amountText: typeof p.amountText === 'string' ? p.amountText.slice(0, 100) : undefined,
      }),
    'run.prepare': (p) => runs.prepare(String(p.id)),
    'run.stop': (p) => runs.stop(String(p.id)),
    'docs.list': () => listDocs(),
    // 파일 고르기 대화상자는 렌더러가 pick을 보낼 때만 연다(가져오기 버튼. 사용자 클릭인지 main이 확인하는 것은 Phase 1).
    // 열기 암호를 다시 물을 때는 pickId로 부른다. 가져오기는 한 번에 하나(대화상자가 겹쳐 뜨지 않게).
    'docs.import': docsCall(async (p) => {
      if (p.pick !== true && typeof p.pickId !== 'string') throw new Error('bad_request');
      if (importing) throw new Error('busy');
      importing = true;
      try {
        return await docs.importPdf({ pickId: p.pickId, password: p.password });
      } finally {
        importing = false;
      }
    }),
    'docs.importCancel': (p) => {
      cancelPick(p.pickId);
      return {};
    },
    'docs.update': docsCall((p) => {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      const seen = (p.seen ?? {}) as Record<string, unknown>;
      return docs.update(String(p.id), { docType: patch.docType, issuedOn: patch.issuedOn, expiresOn: patch.expiresOn }, { docType: seen.docType, issuedOn: seen.issuedOn, expiresOn: seen.expiresOn });
    }),
    // 보관함 PDF를 사용자 기본 뷰어로 연다(값을 PDF와 맞춰 보게). 경로는 main 안에서만 쓰고, PDF가 아니면 열지 않는다(실행 파일을 띄우지 않게).
    'docs.open': docsCall(async (p) => {
      const file = await docs.filePath(String(p.id));
      if (path.extname(file).toLowerCase() !== '.pdf') throw new Error('open_failed');
      if (await desktop.openPath(file)) throw new Error('open_failed');
      return {};
    }),
    'counterparties.list': async () => {
      await refresh();
      return cps;
    },
    'g24.candidates': (p) => g24Candidates(g24Doc(p.doc), Number(p.startedAt)),
    'g24.save': (p) => store.g24Save(String(p.id), g24Doc(p.doc)),
    // 비밀이 아닌 값(승인번호·사업자번호·주소)만. 클립보드 기록 제외 형식은 Phase 1(D17 §1.2).
    'clipboard.copy': (p) => {
      clipboard.writeText(String(p.text ?? '').slice(0, 200));
      return {};
    },
  };

  ipcMain.handle('sax', async (e, req: { method?: unknown; params?: unknown }) => {
    // 메인 창의 셸 페이지에서 온 호출만 받는다. 승인 바(javascript:false)는 IPC가 없다.
    if (e.sender !== wc || e.senderFrame?.url !== SHELL_URL) throw new Error('forbidden');
    if (typeof req?.method !== 'string') throw new Error('bad_request');
    const h = handlers[req.method];
    if (!h) throw new Error('unknown_method');
    return h((req.params ?? {}) as Record<string, unknown>);
  });

  const ready = (async () => {
    await host.ready;
    if (fixture) await fixture.seed(host);
    await refresh();
    await win.loadURL(SHELL_URL);
  })();
  const close = async () => {
    // 엔진이 실제로 끝난 뒤에 임시 앱 폴더를 지운다(DB·WAL이 열린 채 지우지 않게).
    await host.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
  };
  return { win, bar, runs, store, host, fixture, ready, methods: Object.keys(handlers), close };
}
