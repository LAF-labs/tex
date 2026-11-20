import fs from 'node:fs';
import path from 'node:path';
import { appPaths, defaultAppRoot, FileEventLog, prepareLayout, type PreparedLayout } from '@sax/platform';
import { Egress, REGISTRY_ORIGIN } from '@sax/net';
import type { TrustRoot } from '@sax/updater';
import { app, dialog } from 'electron';
import { BUILD_WARN_TEXT, isBuildInfo, isTestBuild, packagedProblems } from './harden.ts';
import { productRemote } from './remote-wiring.ts';
import { registerShellSchemes, startShell, type Shell, type UpdateWiring } from './shell-app.ts';

registerShellSchemes();
let refused = false;
const readBuildInfo = (): unknown => {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'build-info.json'), 'utf8'));
  } catch {
    return null;
  }
};
const problems = app.isPackaged ? packagedProblems({ isPackaged: true, appPath: app.getAppPath(), execPath: process.execPath, localAppData: process.env.LOCALAPPDATA ?? '', buildInfo: readBuildInfo() }) : [];
if (problems.some((p) => p.startsWith('fatal:'))) {
  dialog.showErrorBox('소버린 AX', `설치 상태를 확인하지 못해 열지 않았어요(${problems.filter((p) => p.startsWith('fatal:')).join(', ')}). 설치 파일로 다시 설치해 주세요.`);
  refused = true;
  app.exit(1);
}
const buildBadges = problems.filter((p) => p.startsWith('warn:')).map((p) => BUILD_WARN_TEXT[p.slice(5)] ?? p.slice(5));
const updateWiring = (): UpdateWiring | undefined => {
  if (!app.isPackaged) return undefined;
  const info = readBuildInfo();
  const testBuild = isTestBuild(info);
  const channel = isBuildInfo(info) ? info.channel : 'stable';
  const feed = testBuild ? process.env.SAX_UPDATE_FEED : undefined;
  if (!feed) return { channel, origin: REGISTRY_ORIGIN, egress: new Egress({ env: process.env }), testBuild };
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{1,5}$/.test(feed)) return undefined;
  let trust: TrustRoot;
  try {
    trust = JSON.parse(fs.readFileSync(process.env.SAX_UPDATE_TRUST ?? '', 'utf8')) as TrustRoot;
  } catch {
    return undefined;
  }
  return { channel, origin: feed, egress: new Egress({ env: process.env, testOrigins: { registry: feed } }), trust, loopback: true, relaunch: false, testBuild };
};
const root = defaultAppRoot();
const prepared: PreparedLayout | null = refused ? null : await prepareLayout(root).catch(() => null);
if (refused) {
  // 설치 점검에서 멈췄다
} else if (!prepared?.root.ok) {
  dialog.showErrorBox('저장소 권한', '앱 폴더를 사용자 전용으로 준비하지 못해 열지 않았어요.');
  refused = true;
  app.exit(1);
} else {
  const layoutLog = new FileEventLog(prepared.paths.logs, 'main');
  for (const name of prepared.setAside) layoutLog.event('main.layout_set_aside', { name });
  const paths = appPaths(root);
  app.setPath('userData', paths.userData);
  app.setPath('logs', paths.logs);
  app.setPath('crashDumps', paths.crashDumps);
}
if (!refused && !app.requestSingleInstanceLock()) {
  refused = true;
  app.exit(0);
}
let shell: Shell | null = null;
app.on('second-instance', () => {
  const w = shell?.win;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
});
app.on('window-all-closed', () => {
  void (shell?.close() ?? Promise.resolve()).finally(() => app.quit());
});
void app.whenReady().then(async () => {
  if (refused) return;
  try {
    shell = await startShell({ engine: { portal: { kind: 'hometax' } }, buildBadges, remote: productRemote({ isPackaged: app.isPackaged, env: process.env }), update: updateWiring(), externalChrome: process.env.SAX_EXTERNAL_CHROME === '1' });
    await shell.ready;
  } catch (e) {
    console.error('shell start failed:', (e as Error).message);
    await shell?.close().catch(() => {});
    app.exit(1);
  }
});
