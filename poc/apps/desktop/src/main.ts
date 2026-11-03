// 개발 콘솔 main(D01 §2.1): 프로필·거래처·보관함·진위확인 키 화면. DB 키 없음(엔진 읽기 IPC), 비밀 평문을 중계하지 않는다.
// 셸과 같은 하드닝·같은 엔진 호스트(utilityProcess 금고 + 엔진 게이트 포트)로 띄운다. 전용 Chrome 수동 열기·비밀 입력 창·승인 바 시험은 없다.
// PoC-3 실 홈택스 시험은 pnpm start:hometax(셸)로만 한다(ADR-025 결정 8). 이 파일 전체 삭제는 Phase 1(RETRO B-04).
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { app, BrowserWindow, dialog, ipcMain, protocol, session } from 'electron';
import { COMMANDS, MAIN_ONLY, READ_QUERIES } from '@sax/engine/protocol';
import { appPaths, defaultAppRoot, FileEventLog, prepareLayout, type PreparedLayout } from '@sax/platform';
import { DOCPARSE_SCHEME, ocrInSandbox } from './docparse.ts';
import { EngineHost } from './engine-host.ts';
import { GestureClock, isGestureKey } from './gesture.ts';
import { hardenApp, hardenSession, hardenWindow } from './harden.ts';
import { fatalText } from './shell-runs.ts';
import { cancelPick, importPdf } from './vault-import.ts';

const STATIC = path.join(import.meta.dirname, '../static');
const APP_SCHEME = 'sax-app';
const root = defaultAppRoot();
const paths = appPaths(root);

hardenApp(app, [`${APP_SCHEME}:`, `${DOCPARSE_SCHEME}:`]);
// D07 §1.1: 로밍 %APPDATA% 대신 %LOCALAPPDATA%\SovereignAX 아래로, ready 이전에 설정한다.
// 폴더 확인·복구를 setPath 앞에서 끝낸다. Electron은 넘겨받은 폴더에 ready 무렵부터 쓰므로, 그 자리의 링크를 치우기 전에 넘기면 루트 밖에 쓴다.
// ESM 진입점의 최상위 await가 끝날 때까지 ready가 오지 않는다(Electron 45 실측). ready 전 app.exit는 바로 끝낸다.
const layout = await prepareAppLayout();
if (layout) {
  app.setPath('userData', paths.userData);
  app.setPath('logs', paths.logs);
  app.setPath('crashDumps', paths.crashDumps);
} else {
  app.exit(1); // exit가 바로 끝나지 않는 Electron이어도 확인 안 된 경로는 넘기지 않는다
}
// 두 번째 실행은 첫 실행의 창을 앞으로 가져오고 끝난다(N-29). 잠금은 userData 기준이라 setPath 뒤에 잡는다.
if (!app.requestSingleInstanceLock()) app.exit(0);
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const log = new FileEventLog(null, 'main');
let host: EngineHost | null = null;
let win: BrowserWindow | null = null;
/** 메인 창에서 main이 직접 본 마지막 실제 입력(파일 대화상자는 3초 안의 입력에만 연다, ADR-027 결정 8). */
const gesture = new GestureClock();

function serveStatic(): void {
  const files: Record<string, string> = { '/app.html': 'text/html; charset=utf-8', '/app.js': 'text/javascript', '/app.css': 'text/css', '/vault-panel.js': 'text/javascript' };
  protocol.handle(APP_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    const type = files[p];
    if (!type) return new Response('', { status: 404 });
    return new Response(await fs.readFile(path.join(STATIC, p.slice(1))), { headers: { 'content-type': type } });
  });
  // 렌더러는 네트워크가 없다(D01 §2.1). 기본 세션에서 자기 스킴 밖 요청을 취소한다.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${APP_SCHEME}://`) && !d.url.startsWith('devtools://') }));
  hardenSession(session.defaultSession);
}

// main 전용 명령(MAIN_ONLY: docparse 결과를 붙이는 명령, 보관함 파일 경로)은 렌더러에 열지 않는다.
const RENDERER_METHODS = new Set<string>([...READ_QUERIES, ...COMMANDS.filter((c) => !MAIN_ONLY.includes(c))]);

const needGesture = () => {
  if (!gesture.within(performance.now(), 3_000)) throw new Error('gesture_required');
};

async function handleRenderer(method: string, params: Record<string, unknown>): Promise<unknown> {
  const h = host!;
  await h.ready;
  if (RENDERER_METHODS.has(method)) return h.rpc(method, params);
  switch (method) {
    case 'app.status': {
      const [engine, key] = await Promise.all([h.rpc('engine.status'), h.rpc('bizverify.hasKey')]);
      return { engine, hasKey: (key as { hasKey: boolean }).hasKey };
    }
    case 'vault.importPdf':
      if (typeof params.pickId !== 'string') needGesture();
      return importPdf(params, (m, p) => h.rpc(m, p), win ?? undefined);
    case 'vault.importCancel':
      cancelPick(params.pickId);
      return {};
    case 'ocr.bizcert': {
      // 사용자가 고른 파일만 파싱한다(ADR-014 자동 파싱 축소). PDF는 PoC-8(docparse pdf.js)에서.
      needGesture();
      const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: '사업자등록증 이미지', extensions: ['png', 'jpg', 'jpeg'] }] };
      const pick = await (win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts));
      if (pick.canceled || !pick.filePaths[0]) return null;
      const bytes = new Uint8Array(await fs.readFile(pick.filePaths[0]));
      const ocr = await ocrInSandbox(bytes);
      const parse = await h.rpc('bizcert.parse', { text: ocr.text });
      return { parse, confidence: ocr.confidence, ms: ocr.ms };
    }
  }
  throw new Error('unknown_method');
}

/** 루트와 하위 폴더를 준비한다. 못 하면 알리고 null. 대화상자는 ready 전에도 띄울 수 있다. */
async function prepareAppLayout(): Promise<PreparedLayout | null> {
  // 준비 중 예외(이름 바꾸기 거부 등)도 창 없이 멈추지 않고 알린 뒤 끝낸다. Error가 아닌 값이 던져져도 같다.
  let prepared: PreparedLayout;
  try {
    prepared = await prepareLayout(root);
  } catch (e) {
    dialog.showErrorBox('저장소 권한', `앱 폴더를 준비하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (!prepared.root.ok) {
    dialog.showErrorBox('저장소 권한', `앱 폴더 권한을 사용자 전용으로 설정하지 못했습니다: ${prepared.root.problems.join(', ')}`);
    return null;
  }
  // 치운 항목은 원인을 나중에 볼 수 있게 로그 파일에 남긴다(main 기본 로그는 메모리 전용).
  const layoutLog = new FileEventLog(prepared.paths.logs, 'main');
  for (const name of prepared.setAside) layoutLog.event('main.layout_set_aside', { name });
  return prepared;
}

app.on('second-instance', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.focus();
});

app.whenReady().then(async () => {
  if (!layout) return; // 위에서 끝냈다
  serveStatic();
  host = new EngineHost({ vault: 'process', portal: { kind: 'hometax' }, log });
  host.ready.catch((e: Error) => {
    const text = fatalText(e.message);
    if (text) dialog.showErrorBox('소버린 AX', text);
  });
  ipcMain.handle('sax', async (e, req: { method?: unknown; params?: unknown }) => {
    // 메인 UI 창에서 온 호출만 받는다.
    // senderFrame은 null일 수 있다(프레임이 사라진 뒤 도착한 호출 등). null이면 거부한다.
    const url = e.senderFrame?.url;
    if (e.sender !== win?.webContents || typeof url !== 'string' || !url.startsWith(`${APP_SCHEME}://app/app.html`)) throw new Error('forbidden');
    if (typeof req?.method !== 'string') throw new Error('bad_request');
    return handleRenderer(req.method, (req.params ?? {}) as Record<string, unknown>);
  });
  win = new BrowserWindow({
    width: 1100, height: 860, title: '소버린 AX PoC',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(STATIC, 'preload-app.cjs') },
  });
  hardenWindow(win);
  win.webContents.on('before-mouse-event', (_e, m) => {
    if (m.type === 'mouseUp') gesture.note(performance.now());
  });
  win.webContents.on('before-input-event', (_e, i) => {
    if (isGestureKey(i)) gesture.note(performance.now());
  });
  await win.loadURL(`${APP_SCHEME}://app/app.html`);
});

app.on('window-all-closed', () => {
  void (host?.shutdown() ?? Promise.resolve()).finally(() => app.quit());
});
