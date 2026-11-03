// PoC-9 데모 UI 셸의 main(PoC-6부터 엔진·금고를 띄운다). 승인 바는 main 소유 WebContentsView다(ADR-021).
// 렌더러는 바 자리를 비우기만 하고 바를 그리거나 숨기지 못한다. 승인 근거는 바 → main → 게이트 포트(엔진)로만 간다.
// 기본은 fixture 모드(가짜 H-01 페이지, 시험 정책 금고, 임시 앱 폴더). 홈택스 실제 화면은 PoC-3 셀렉터가 들어온 뒤.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Counterparty as DbCounterparty, Profile as DbProfile } from '@sax/db';
import type { EnginePortal } from '@sax/engine/protocol';
import { appPaths, defaultAppRoot, FileEventLog } from '@sax/platform';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, protocol, session, shell as desktop } from 'electron';
import { verifyLocalApproval } from './approval-gate.ts';
import { APPROVAL_SCHEME, ApprovalBar } from './approval-bar.ts';
import { DOCPARSE_SCHEME } from './docparse.ts';
import { EngineHost } from './engine-host.ts';
import { startFixtureMode, type FixtureMode } from './fixture-mode.ts';
import { GestureClock, isGestureKey, RateWindow } from './gesture.ts';
import { assertNoDebugSwitches, hardenApp, hardenSession, hardenWindow } from './harden.ts';
import { secretPageHtml, SecretWindowCoordinator } from './secret-labels.ts';
import { openSecretWindow } from './secret-window.ts';
import { barBounds, SHELL } from './shell-layout.ts';
import { g24Candidates, interpret, MockStore, PROFILES, QUICK, seedTimeline, type Counterparty, type G24Doc, type Profile, type VatMode } from './shell-mock.ts';
import { engineDocsProvider, type DocsProvider } from './shell-docs.ts';
import { fatalText, ShellRuns, vaultNotice } from './shell-runs.ts';
import { bundleCss, tokensCss } from './shell-tokens.ts';
import { cancelPick, importPdf } from './vault-import.ts';

const STATIC = path.join(import.meta.dirname, '../static');
export const SHELL_SCHEME = 'sax-shell';
const SHELL_URL = `${SHELL_SCHEME}://shell/shell.html`;

export function registerShellSchemes(): void {
  // 한 번만 부를 수 있다(ready 전). 문서함 PDF 가져오기가 docparse 샌드박스를 쓰므로 그 스킴도 여기서 등록한다.
  // 공용 하드닝(디버그 스위치·샌드박스·새 창·이동·webview 거부)도 ready 전에 여기서 건다(ADR-025 결정 8).
  hardenApp(app, [`${SHELL_SCHEME}:`, `${APPROVAL_SCHEME}:`, `${DOCPARSE_SCHEME}:`]);
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
  'gesture_required', 'throttled', 'pick_password_tries',
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
  '/secret.js': 'text/javascript',
  '/secret.css': 'text/css',
};

/** 지금 열린 비밀 창의 페이지(main이 만든다). 열린 창이 없으면 null(404). */
let secretPage: () => string | null = () => null;

function serve(): void {
  protocol.handle(SHELL_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/tokens.css') return new Response(tokensCss(), { headers: { 'content-type': 'text/css' } });
    if (p === '/secret.html') {
      const html = secretPage();
      return html ? new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } }) : new Response('', { status: 404 });
    }
    if (p === '/bundle.css') return new Response(bundleCss(), { headers: { 'content-type': 'text/css' } });
    const type = FILES[p];
    if (!type) return new Response('', { status: 404 });
    return new Response(await fs.readFile(path.join(STATIC, 'shell', p.slice(1))), { headers: { 'content-type': type } });
  });
  // 렌더러는 네트워크가 없다(D01 §2.1). 자기 스킴 밖 요청을 취소한다.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${SHELL_SCHEME}://`) && !d.url.startsWith('devtools://') }));
  hardenSession(session.defaultSession);
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
  /** e2e: [홈택스에서 준비] 분당 상한(기본 3, 사람 속도). 렌더러가 바꿀 수 없다(진입점이 정한다). */
  preparePerMin?: number;
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
  /** 지금 열린 비밀 입력 창(금고 secret.needed로만 열린다). */
  secretWindow(): BrowserWindow | null;
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
  // CDP로 넣은 마우스 이벤트도 before-mouse-event를 일으키므로 디버그 스위치가 있으면 끝낸다(ADR-021·ADR-025 결정 8, 값싼 차단).
  assertNoDebugSwitches(app);
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
  // 파일 대화상자는 메인 창을 부모로 띄운다(win은 아래에서 만든다).
  const docs = opts.docs ?? engineDocsProvider((m, p) => host.rpc(m, p), (params, engine) => importPdf(params, engine, win));
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
  // 새 창·이동 거부, 렌더러의 window.moveTo·resizeTo 무시, 배율 1 고정.
  hardenWindow(win);
  // 사용자 동작 결속(ADR-027 결정 8): main이 메인 창에서 직접 본 실제 입력(mouseUp, 수식키 없는 Enter·Space) 시각.
  const gesture = new GestureClock();
  wc.on('before-mouse-event', (_e, m) => {
    if (m.type === 'mouseUp') gesture.note(performance.now());
  });
  wc.on('before-input-event', (_e, i) => {
    if (isGestureKey(i)) gesture.note(performance.now());
  });
  const prepareRate = new RateWindow(opts.preparePerMin ?? 3, 60_000);
  const openRate = new RateWindow(5, 60_000);
  /** 실제 입력이 ms 안에 없으면 gesture_required. */
  const needGesture = (ms: number) => {
    if (!gesture.within(performance.now(), ms)) throw new Error('gesture_required');
  };

  const bar = new ApprovalBar(win, key, barBounds, { cursorPoint: opts.cursorPoint, log });
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

  // 금고가 부르는 비밀 입력 창(ADR-025 결정 10). 열린 창은 하나, 활성 실행의 요청만, 라벨은 main 내장 표.
  const secrets = new SecretWindowCoordinator((runId) => runs.isActive(runId));
  let secretWin: BrowserWindow | null = null;
  secretPage = () => {
    const r = secrets.open;
    return r ? secretPageHtml(r, profiles()[r.scope].name) : null;
  };
  // main이 닫은 창(실행 끝·종료)은 사용자가 돌아온 것이 아니다: 핸드오프 복귀로 치지 않는다.
  let appClosing: BrowserWindow | null = null;
  // 메인 창이 닫히는 중이면 비밀 창을 새로 열지 않는다(들고 있던 다음 요청 포함).
  let mainClosing = false;
  win.once('close', () => {
    mainClosing = true;
  });
  const closeSecret = () => {
    if (!secretWin || secretWin.isDestroyed()) return;
    appClosing = secretWin;
    secretWin.close();
  };
  const openSecret = (data: unknown): void => {
    // 메인 창부터 본다: 열 수 없는데 조정자에 '열림'을 남기면 이후 비밀 창이 영영 열리지 않는다.
    if (mainClosing || win.isDestroyed()) return log.event('main.secret_needed_ignored');
    const r = secrets.request(data);
    if (!r) return log.event(secrets.open ? 'main.secret_needed_queued' : 'main.secret_needed_ignored');
    const bind = { runId: r.runId, kind: r.kind, scope: r.scope, ...(r.row !== undefined ? { row: r.row } : {}) };
    let w: BrowserWindow;
    try {
      w = openSecretWindow(win, bind, host.secretInputPort(bind), `${SHELL_SCHEME}://shell/secret.html`);
    } catch (e) {
      // 열지 못했으면 '열림'을 남기지 않는다(남으면 이후 요청이 줄만 서고 창이 영영 안 열린다). 든 요청도 버린다.
      secrets.closed();
      return log.event('main.secret_open_failed', { error: (e as Error).message.slice(0, 120) });
    }
    secretWin = w;
    // 사용자가 앱이 연 창에서 돌아옴: 다음 활성화 한 번만 클릭 활성화 예외(ADR-027 결정 5). 메인 창이 포커스를 받기 전에
    // 표시해야 그 활성화가 표시를 쓴다('closed'는 포커스보다 늦을 수 있다).
    let byApp = false;
    w.on('close', () => {
      byApp = appClosing === w;
      if (byApp) appClosing = null;
      else bar.noteHandoff();
    });
    w.on('closed', () => {
      if (secretWin === w) secretWin = null;
      const next = secrets.closed();
      // 들고 있던 요청은 사용자가 창을 마쳤을 때만 이어서 연다. main이 닫은 창(실행 끝·종료)이면 버린다.
      if (next && !byApp) openSecret(next);
    });
  };
  host.on('vault-event', (name: string, data: unknown) => {
    if (name === 'secret.needed') return openSecret(data);
    const n = vaultNotice(name, data);
    if (n) runs.notice(n.runId, n.text);
  });
  // 실행이 끝나면 그 실행의 비밀 창도 닫는다.
  runs.on('update', (run: { id: string }) => {
    if (secrets.open?.runId === run.id && !runs.isActive(run.id)) closeSecret();
  });
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
    // 실행 시작은 2초 안의 실제 입력이 있어야 하고, 사람 속도(분당 3회)·게이트 없이 끝난 연속 3회에서 멈춘다.
    'run.prepare': (p) => {
      needGesture(2_000);
      if (runs.prepareThrottled() || !prepareRate.take(performance.now())) {
        log.event('main.prepare_throttled');
        throw new Error('throttled');
      }
      return runs.prepare(String(p.id));
    },
    'run.stop': (p) => runs.stop(String(p.id)),
    'docs.list': () => listDocs(),
    // 파일 고르기 대화상자는 렌더러가 pick을 보내고 3초 안에 실제 입력이 있었을 때만 연다(가져오기 버튼).
    // 열기 암호를 다시 물을 때는 pickId로 부른다. 가져오기는 한 번에 하나(대화상자가 겹쳐 뜨지 않게).
    'docs.import': docsCall(async (p) => {
      if (p.pick !== true && typeof p.pickId !== 'string') throw new Error('bad_request');
      if (typeof p.pickId !== 'string') needGesture(3_000);
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
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
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
    try {
      await host.ready;
    } catch (e) {
      // 금고 키 유실·환경 변수 변조 등은 사실 문장으로 알리고 열지 않는다(복구 화면은 Phase 1).
      const text = fatalText((e as Error).message);
      if (text) dialog.showErrorBox('소버린 AX', text);
      throw e;
    }
    if (fixture) await fixture.seed(host);
    await refresh();
    await win.loadURL(SHELL_URL);
  })();
  const close = async () => {
    closeSecret();
    // 엔진이 실제로 끝난 뒤에 임시 앱 폴더를 지운다(DB·WAL이 열린 채 지우지 않게).
    await host.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
  };
  return { win, bar, runs, store, host, fixture, ready, methods: Object.keys(handlers), secretWindow: () => secretWin, close };
}
