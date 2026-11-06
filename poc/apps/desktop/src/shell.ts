// 제품 진입점(app-identity.json entry = dist/shell.js). 실제 앱 폴더·utilityProcess 금고·OS 키체인으로 홈택스에 붙는다.
// 실비밀 진입점은 하드닝된 이 셸 하나다(ADR-025 결정 8). PoC-3 실 홈택스 시험도 이 길이다(pnpm start:hometax).
// 가짜 홈택스·시연 씨앗·시연 모델은 시연 진입점(demo-shell.ts, pnpm demo)에만 있고, 이 파일은 그 코드에 닿지 않는다(ADR-035 W-7).
import fs from 'node:fs';
import path from 'node:path';
import { appPaths, defaultAppRoot, FileEventLog, prepareLayout, type PreparedLayout } from '@sax/platform';
import { app, dialog } from 'electron';
import { BUILD_WARN_TEXT, packagedProblems } from './harden.ts';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';

registerShellSchemes();
// app.exit가 바로 끝나지 않는 Electron이어도 확인 안 된 앱 폴더로 엔진·금고를 띄우지 않는다.
let refused = false;
// 설치본 자기 점검(#76 인계): asar에서 로드됐는지, 데이터 루트 안에 설치되지 않았는지, build-info.json. 개발 실행(isPackaged 아님)은 건너뛴다.
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
// 앱 폴더를 확인·복구한 뒤에만 Electron에 넘긴다. Electron은 넘겨받은 폴더에 ready 무렵부터 쓰므로, 그 자리의 링크를 치우기 전에 넘기면 루트 밖에 쓴다.
// ESM 진입점의 최상위 await가 끝날 때까지 ready가 오지 않는다(Electron 45 실측). 사용자 전용 권한을 못 걸면 열지 않는다.
const root = defaultAppRoot();
const prepared: PreparedLayout | null = refused ? null : await prepareLayout(root).catch(() => null);
if (refused) {
  // 설치 점검에서 멈췄다
} else if (!prepared?.root.ok) {
  dialog.showErrorBox('저장소 권한', '앱 폴더를 사용자 전용으로 준비하지 못해 열지 않았어요.');
  refused = true;
  app.exit(1);
} else {
  // 치운 항목(루트 밖으로 가는 링크 등)은 원인을 나중에 볼 수 있게 로그 파일에 남긴다(값·경로 없음, 이름만).
  const layoutLog = new FileEventLog(prepared.paths.logs, 'main');
  for (const name of prepared.setAside) layoutLog.event('main.layout_set_aside', { name });
  const paths = appPaths(root);
  app.setPath('userData', paths.userData);
  app.setPath('logs', paths.logs);
  app.setPath('crashDumps', paths.crashDumps);
}
// 두 번째 실행은 첫 실행의 창을 앞으로 가져오고 끝난다(N-29). 잠금은 userData 기준이라 setPath 뒤에 잡는다.
if (!refused && !app.requestSingleInstanceLock()) {
  refused = true;
  app.exit(0);
}
let shell: Shell | null = null;
app.on('second-instance', () => {
  const w = shell?.win;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.focus();
});
app.on('window-all-closed', () => {
  void (shell?.close() ?? Promise.resolve()).finally(() => app.quit());
});
void app.whenReady().then(async () => {
  if (refused) return;
  try {
    shell = await startShell({ engine: { portal: { kind: 'hometax' } }, buildBadges });
    await shell.ready;
  } catch (e) {
    console.error('shell start failed:', (e as Error).message);
    await shell?.close().catch(() => {});
    app.exit(1);
  }
});
