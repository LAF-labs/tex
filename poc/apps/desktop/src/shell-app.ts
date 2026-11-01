// PoC-9 데모 UI 셸의 main. 엔진·금고를 띄우지 않고 목업 실행기(shell-mock)가 엔진 자리를 대신한다.
// 승인 바는 main 소유 WebContentsView다(ADR-021). 렌더러는 바 자리를 비우기만 하고 바를 그리거나 숨기지 못한다.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, clipboard, ipcMain, Menu, protocol, session } from 'electron';
import { verifyLocalApproval } from './approval-gate.ts';
import { APPROVAL_SCHEME, ApprovalBar } from './approval-bar.ts';
import { DOCPARSE_SCHEME } from './docparse.ts';
import { demoDocsProvider, type DocsProvider } from './shell-docs.ts';
import { barBounds, SHELL } from './shell-layout.ts';
import { g24Candidates, interpret, MockRuns, MockStore, PROFILES, QUICK, seedTimeline, type G24Doc, type Profile, type VatMode } from './shell-mock.ts';
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
  /** 목업 실행기 시간 배율(1 = 시연). */
  speed?: number;
  width?: number;
  height?: number;
  show?: boolean;
  /** e2e: OS 커서 위치를 바꿔 끼운다. */
  cursorPoint?: () => { x: number; y: number };
  /** 문서함 보관함 공급자(shell-docs.ts). 없으면 데모 공급자(임시 폴더 DB, 엔진 보관함 코드 그대로). PoC-6은 엔진 공급자를 넘긴다. */
  docs?: DocsProvider;
}

export interface Shell {
  win: BrowserWindow;
  bar: ApprovalBar;
  runs: MockRuns;
  store: MockStore;
  ready: Promise<void>;
  /** 렌더러가 부를 수 있는 메서드 전부(e2e가 승인 경로가 없는지 훑는다). */
  methods: string[];
}

export function startShell(opts: ShellOptions = {}): Shell {
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
  const runs = new MockRuns(store, opts.speed ?? 1);
  const docs = opts.docs ?? demoDocsProvider({ dir: path.join(app.getPath('userData'), 'docs-demo'), profile: PROFILES.business, importer: importPdf });
  app.once('will-quit', () => docs.close?.());
  /** 문서함 = 보관함 서류 + 목업 실행이 만든 서류(세금계산서·정부24 목업) */
  const listDocs = async () => [...(await docs.list()), ...store.docs];
  let profile: Profile['kind'] = 'business';

  const win = new BrowserWindow({
    width: opts.width ?? 1280,
    height: opts.height ?? 820,
    useContentSize: true,
    minHeight: 560,
    show: opts.show ?? true,
    title: '소버린 AX (PoC 데모)',
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
  runs.on('doc', (doc) => send({ type: 'doc', doc }));
  runs.on('gate-closed', (runId: string) => {
    if (bar.runId === runId) bar.close('stopped');
  });
  runs.on('gate', (runId: string, req) => {
    void bar.open(req).then((o) => {
      // PoC-6: 근거는 main↔엔진 전용 포트로 넘기고 엔진이 게이트 토큰으로 바꾼다. 목업은 main에서 검증만 한다.
      if (o.decision === 'approve' && verifyLocalApproval(key, o.approval)) runs.approved(runId);
      else if (o.decision === 'closed' && o.reason === 'busy') console.error('gate while another gate is open', runId);
    });
  });

  const g24Doc = (v: unknown): G24Doc => {
    if (v !== '주민등록표 등본' && v !== '주민등록표 초본') throw new Error('bad_doc');
    return v;
  };
  const handlers: Record<string, (p: Record<string, unknown>) => unknown> = {
    'shell.bootstrap': async () => ({
      layout: SHELL,
      profiles: PROFILES,
      profile,
      counterparties: store.counterparties,
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
    // 파일 고르기 대화상자는 사용자가 누른 가져오기 버튼에서만 연다(pick). 열기 암호를 다시 물을 때는 pickId로 부른다.
    'docs.import': (p) => {
      if (p.pick !== true && typeof p.pickId !== 'string') throw new Error('bad_request');
      return docs.importPdf({ pickId: p.pickId, password: p.password });
    },
    'docs.importCancel': (p) => {
      cancelPick(p.pickId);
      return {};
    },
    'docs.update': (p) => {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      return docs.update(String(p.id), { docType: patch.docType, issuedOn: patch.issuedOn, expiresOn: patch.expiresOn });
    },
    'counterparties.list': () => store.counterparties,
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

  const ready = win.loadURL(SHELL_URL);
  return { win, bar, runs, store, ready, methods: Object.keys(handlers) };
}
