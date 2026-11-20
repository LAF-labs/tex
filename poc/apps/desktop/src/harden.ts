import path from 'node:path';
import type { App, BrowserWindow, Session, WebContents, WebPreferences } from 'electron';

export const APP_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'; img-src 'self' data:; require-trusted-types-for 'script'";
export const SECRET_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'; require-trusted-types-for 'script'";

export function appHeaders(type: string, csp: string = APP_CSP): Record<string, string> {
  return { 'content-type': type, 'content-security-policy': csp, 'x-content-type-options': 'nosniff' };
}

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

export function lastWebPrefs(wc: object): WebPreferences | null {
  const get = (wc as { getLastWebPreferences?: () => WebPreferences | null }).getLastWebPreferences;
  return typeof get === 'function' ? get.call(wc) : null;
}

export function assertWebPrefs(wc: object): void {
  const bad = webPrefsProblems(lastWebPrefs(wc));
  if (bad.length) throw new Error(`harden.webprefs:${bad.join(',')}`);
}

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

export function findDebugSwitch(hasSwitch: (s: string) => boolean, argv: readonly string[] = []): string | null {
  for (const s of DEBUG_SWITCHES) {
    if (hasSwitch(s)) return s;
    if (argv.some((a) => a === `--${s}` || a.startsWith(`--${s}=`))) return s;
  }
  return null;
}

export function assertNoDebugSwitches(app: Pick<App, 'commandLine' | 'exit'>): void {
  const hit = findDebugSwitch((s) => app.commandLine.hasSwitch(s), [...process.argv, ...process.execArgv]);
  if (!hit) return;
  app.exit(1);
  throw new Error(`debug_switch:${hit}`);
}

export const NAV_EXEMPT_SESSIONS = new WeakSet<Session>();

export function hardenApp(app: App, allowSchemes: readonly string[]): void {
  assertNoDebugSwitches(app);
  if (!app.commandLine.hasSwitch('no-sandbox')) app.enableSandbox();
  app.on('web-contents-created', (_e, wc: WebContents) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    const exempt = () => NAV_EXEMPT_SESSIONS.has(wc.session);
    wc.on('will-navigate', (ev) => {
      if (!exempt()) ev.preventDefault();
    });
    wc.on('will-frame-navigate', (ev) => {
      if (!ev.isMainFrame && !exempt()) ev.preventDefault();
    });
    wc.on('will-redirect', (ev) => {
      if (!allowSchemes.some((s) => ev.url.startsWith(s)) && !exempt()) ev.preventDefault();
    });
    wc.on('will-attach-webview', (ev) => ev.preventDefault());
  });
}

export function hardenSession(ses: Session): void {
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault());
  ses.setSpellCheckerEnabled(false);
}

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

interface BuildInfo {
  productName: string;
  version: string;
  channel: 'stable' | 'beta';
  signing: 'azure' | 'developer_id' | 'unsigned';
  commit: string;
  devOnlyIncluded: string[];
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

export const isTestBuild = (x: unknown): boolean => isBuildInfo(x) && x.testBuild === true;

export const BUILD_WARN_TEXT: Record<string, string> = {
  unsigned_build: '미서명 빌드',
  dev_code_included: '개발용 코드 포함 빌드',
  install_unexpected: '예상 밖 설치 위치',
  test_build: '실계정 시험 빌드',
};

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
