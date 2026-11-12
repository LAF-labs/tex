// 셸(shell-app.ts·진입점 shell.ts)과 승인 바·docparse·비밀 창이 같이 쓰는 하드닝(ADR-025 결정 8, D11 §4).
// Electron 값은 인자로만 받는다(타입 import만). node --test에서 상수·판정을 불러 시험할 수 있다.
import path from 'node:path';
import type { App, BrowserWindow, Session, WebContents, WebPreferences } from 'electron';

/**
 * 앱 페이지(셸·개발 콘솔) 응답 헤더 CSP(D11 §4 CSP 행). meta CSP는 frame-ancestors·trusted-types를 못 걸어 헤더로도 보낸다(둘은 겹쳐 걸린다).
 * style-src는 default-src와 같은 'self'를 그대로 적어 둔다(인라인 style 속성 금지). 렌더러 스크립트에는 innerHTML 같은 TT 싱크가 없다.
 */
export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'; img-src 'self' data:; require-trusted-types-for 'script'";
/** 비밀 입력 창 페이지(main이 만든다): 스크립트·스타일은 자기 스킴 파일만, 이미지·연결 없음. */
export const SECRET_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'; require-trusted-types-for 'script'";
/** 폰 연결 창: SECRET_CSP에 QR 이미지(main이 만든 SVG data URL)만 더 연다. */
export const PAIR_CSP = `${SECRET_CSP}; img-src data:`;

/** 앱 스킴 응답 헤더: 형식, CSP, 형식 추측 금지. */
export function appHeaders(type: string, csp: string = APP_CSP): Record<string, string> {
  return { 'content-type': type, 'content-security-policy': csp, 'x-content-type-options': 'nosniff' };
}

/**
 * 창 webPreferences 자기 점검(D11 §4 렌더러 행): 지켜야 할 값이 아니면 문제 이름. 빈 배열이면 통과.
 * sandbox는 명시적 true만 받는다(app.enableSandbox를 건너뛴 --no-sandbox 개발 환경에서도 창마다 직접 단다).
 */
export function webPrefsProblems(p: WebPreferences | null | undefined): string[] {
  if (!p) return ['webprefs_unknown'];
  const out: string[] = [];
  if (p.sandbox !== true) out.push('sandbox');
  if (p.contextIsolation === false) out.push('contextIsolation');
  if (p.nodeIntegration === true) out.push('nodeIntegration');
  if (p.nodeIntegrationInSubFrames === true) out.push('nodeIntegrationInSubFrames');
  if (p.nodeIntegrationInWorker === true) out.push('nodeIntegrationInWorker');
  if (p.webviewTag === true) out.push('webviewTag');
  if (p.webSecurity === false) out.push('webSecurity');
  if (p.allowRunningInsecureContent === true) out.push('allowRunningInsecureContent');
  if (p.experimentalFeatures === true) out.push('experimentalFeatures');
  if (p.enableBlinkFeatures) out.push('enableBlinkFeatures');
  return out;
}

/** Electron 45에 있지만 타입 선언에 없는 getLastWebPreferences(기본값까지 채운 실제 값, 실측). 없으면 null. */
export function lastWebPrefs(wc: object): WebPreferences | null {
  const get = (wc as { getLastWebPreferences?: () => WebPreferences | null }).getLastWebPreferences;
  return typeof get === 'function' ? get.call(wc) : null;
}

/** 점검에 걸리면 던진다(부르는 쪽이 창을 치운다). 값을 읽지 못해도(webprefs_unknown) 던진다. */
export function assertWebPrefs(wc: object): void {
  const bad = webPrefsProblems(lastWebPrefs(wc));
  if (bad.length) throw new Error(`harden.webprefs:${bad.join(',')}`);
}

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
    // 하위 프레임 이동도 막는다(will-navigate는 최상위 프레임만). loadURL 같은 main의 이동에는 오지 않는다.
    wc.on('will-frame-navigate', (ev) => {
      if (!ev.isMainFrame) ev.preventDefault();
    });
    wc.on('will-redirect', (ev) => {
      if (!allowSchemes.some((s) => ev.url.startsWith(s))) ev.preventDefault();
    });
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}

/** ready 뒤 기본 세션: 권한 요청·확인·장치(USB·HID·직렬) 접근을 모두 거부하고, 내려받기를 막고, 맞춤법 사전(네트워크로 받는다)을 끈다. */
export function hardenSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  ses.setSpellCheckerEnabled(false);
}

/** 창마다: webPreferences 자기 점검(걸리면 던진다), 렌더러가 창을 옮기거나 키우지 못하고(window.moveTo 등), 배율은 1로 고정한다. */
export function hardenWindow(win: BrowserWindow): void {
  const wc = win.webContents;
  assertWebPrefs(wc);
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('content-bounds-updated', (e) => e.preventDefault());
  wc.on('did-finish-load', () => {
    wc.setZoomFactor(1);
    void wc.setVisualZoomLevelLimits(1, 1);
  });
}

// ---- 설치본 자기 점검(#76 인계, apps/desktop/build/README.md "기동 자기 점검") ----

/** 앱 안 build-info.json(scripts/package-win.mjs가 쓴다). */
export interface BuildInfo {
  productName: string;
  version: string;
  channel: 'stable' | 'beta';
  /** azure: Windows Artifact Signing, developer_id: macOS Developer ID 서명·공증, unsigned: 미서명·애드혹. */
  signing: 'azure' | 'developer_id' | 'unsigned';
  commit: string;
  devOnlyIncluded: string[];
  /**
   * 실계정 시험 빌드(package-win --test-build, 팀장 결정 11-05). 이 빌드만 업데이트 투명성 확인을 설정으로 끌 수 있다(update-host updatePolicy).
   * 없으면 제품 빌드다(이 칸이 생기기 전 build-info도 그대로 받는다). 배포 가능 판정은 막힌다(release-readiness test_build).
   */
  testBuild?: boolean;
}

export function isBuildInfo(x: unknown): x is BuildInfo {
  const b = x as Partial<BuildInfo> | null;
  return (
    !!b &&
    typeof b === 'object' &&
    typeof b.productName === 'string' &&
    !!b.productName &&
    typeof b.version === 'string' &&
    (b.channel === 'stable' || b.channel === 'beta') &&
    (b.signing === 'azure' || b.signing === 'developer_id' || b.signing === 'unsigned') &&
    typeof b.commit === 'string' &&
    Array.isArray(b.devOnlyIncluded) &&
    b.devOnlyIncluded.every((f) => typeof f === 'string') &&
    (b.testBuild === undefined || typeof b.testBuild === 'boolean')
  );
}

/** 실계정 시험 빌드인가. 모양이 틀리거나 칸이 없으면 제품 빌드(false, fail-closed). */
export const isTestBuild = (x: unknown): boolean => isBuildInfo(x) && x.testBuild === true;

/** 화면 상단 배지 문구(warn:만). 사실만 적는다. */
export const BUILD_WARN_TEXT: Record<string, string> = {
  unsigned_build: '미서명 빌드',
  dev_code_included: '개발용 코드 포함 빌드',
  install_unexpected: '예상 밖 설치 위치',
  test_build: '실계정 시험 빌드',
};

/**
 * 패키지된 앱만(isPackaged). 빈 배열이면 통과. 'fatal:'이면 열지 않고, 'warn:'이면 상단 배지(BUILD_WARN_TEXT).
 * - fatal:not_asar             appPath가 resources\app.asar가 아니다(OnlyLoadAppFromAsar 퓨즈가 꺼졌거나 다른 실행 파일)
 * - fatal:install_in_data_root execPath가 데이터 루트(%LOCALAPPDATA%\SovereignAX) 아래다(D07 §1.1 DACL 루트와 섞임)
 * - fatal:build_info_missing   build-info.json이 없거나 모양이 틀리다
 * - warn:install_unexpected    %LOCALAPPDATA%\Programs\<productName> 밖(사용자 /D 설치·복사본)
 * - warn:unsigned_build        signing === 'unsigned'(Azure·Developer ID 서명이 아니다. 배포 가능 여부는 채널별로 release-readiness betaDistributable이 정한다: beta는 미서명 허용, SIGNING-SETUP.md §4)
 * - warn:dev_code_included     devOnlyIncluded가 비어 있지 않다
 * - warn:test_build            testBuild가 true다(실계정 시험 빌드, 배포본이 아니다)
 * Windows 경로는 대소문자를 가리지 않는다. 데이터 루트 이름은 productName이 아니라 고정 'SovereignAX'다(@sax/platform 데이터 루트).
 */
export function packagedProblems(o: { isPackaged: boolean; appPath: string; execPath: string; localAppData: string; buildInfo: unknown; platform?: NodeJS.Platform }): string[] {
  if (!o.isPackaged) return [];
  const p = (o.platform ?? process.platform) === 'win32' ? path.win32 : path.posix;
  const norm = (s: string) => {
    const r = p.resolve(s);
    return p === path.win32 ? r.toLowerCase() : r;
  };
  const under = (child: string, parent: string) => {
    const rel = p.relative(norm(parent), norm(child));
    return rel === '' || (!!rel && !rel.startsWith('..') && !p.isAbsolute(rel));
  };
  const out: string[] = [];
  const app = norm(o.appPath);
  // Windows: resources\app.asar, macOS: Contents/Resources/app.asar
  if (p.basename(app) !== 'app.asar' || p.basename(p.dirname(app)).toLowerCase() !== 'resources') out.push('fatal:not_asar');
  if (o.localAppData && under(o.execPath, p.join(o.localAppData, 'SovereignAX'))) out.push('fatal:install_in_data_root');
  const info = isBuildInfo(o.buildInfo) ? o.buildInfo : null;
  if (!info) out.push('fatal:build_info_missing');
  if (info && o.localAppData && !under(o.execPath, p.join(o.localAppData, 'Programs', info.productName))) out.push('warn:install_unexpected');
  if (info && info.signing === 'unsigned') out.push('warn:unsigned_build');
  if (info && info.devOnlyIncluded.length) out.push('warn:dev_code_included');
  if (info?.testBuild === true) out.push('warn:test_build');
  return out;
}
