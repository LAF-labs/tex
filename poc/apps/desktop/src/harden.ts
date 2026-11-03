// 두 main(셸 shell-app.ts·개발 콘솔 main.ts)이 같이 쓰는 하드닝(ADR-022 결정 8, D11 §4).
// Electron 값은 인자로만 받는다(타입 import만). node --test에서 상수·판정을 불러 시험할 수 있다.
import type { App, BrowserWindow, Session, WebContents } from 'electron';

/** 이 중 하나라도 있으면 앱을 열지 않는다. CDP·Node 검사기·로그 파일로 바 입력·비밀·세션이 새는 길이다. */
export const DEBUG_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-pipe',
  'remote-allow-origins',
  'enable-logging',
  'log-file',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'js-flags',
] as const;

/** 찾은 디버그 스위치 이름, 없으면 null. Chromium 명령줄과 Node 인자(--inspect 등)를 함께 본다. */
export function findDebugSwitch(hasSwitch: (s: string) => boolean, argv: readonly string[] = []): string | null {
  for (const s of DEBUG_SWITCHES) {
    if (hasSwitch(s)) return s;
    if (argv.some((a) => a === `--${s}` || a.startsWith(`--${s}=`))) return s;
  }
  return null;
}

/** 디버그 스위치가 있으면 끝내고 던진다(ApprovalBar 생성자·진입점 첫 줄). */
export function assertNoDebugSwitches(app: Pick<App, 'commandLine' | 'exit'>): void {
  const hit = findDebugSwitch((s) => app.commandLine.hasSwitch(s), [...process.argv, ...process.execArgv]);
  if (!hit) return;
  app.exit(1);
  throw new Error(`debug_switch:${hit}`);
}

/**
 * ready 전에 부른다: 디버그 스위치 검사, 모든 렌더러 샌드박스, 모든 webContents의 새 창·이동·webview 거부.
 * allowSchemes는 리디렉트를 허용할 앱 스킴(예: 'sax-shell:'). 렌더러가 시작한 이동(will-navigate)은 모두 막는다.
 */
export function hardenApp(app: App, allowSchemes: readonly string[]): void {
  assertNoDebugSwitches(app);
  // --no-sandbox(root 컨테이너 개발 환경)에서는 enableSandbox가 자식 프로세스를 FATAL로 끝낸다(Electron 45 실측).
  // 그때는 건너뛴다. 렌더러 창은 모두 webPreferences.sandbox:true를 직접 단다.
  if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
  app.on('web-contents-created', (_e, wc: WebContents) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (ev) => ev.preventDefault());
    wc.on('will-redirect', (ev) => {
      if (!allowSchemes.some((s) => ev.url.startsWith(s))) ev.preventDefault();
    });
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}

/** ready 뒤 기본 세션: 권한 요청·확인을 모두 거부한다(카메라·알림·클립보드 읽기 등). */
export function hardenSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

/** 창마다: 렌더러가 창을 옮기거나 키우지 못하고(window.moveTo 등), 배율은 1로 고정한다. */
export function hardenWindow(win: BrowserWindow): void {
  const wc = win.webContents;
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('content-bounds-updated', (e) => e.preventDefault());
  wc.on('did-finish-load', () => {
    wc.setZoomFactor(1);
    void wc.setVisualZoomLevelLimits(1, 1);
  });
}
