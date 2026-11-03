// PoC-9 데모 UI 셸 진입점. 실행: pnpm demo (electron apps/desktop/dist/shell.js).
// PoC-6부터 엔진·금고를 띄우고 가짜 H-01 페이지(127.0.0.1)에서 발급 흐름을 돈다(fixture 모드: 임시 앱 폴더, 메모리 키, 키체인 안 씀).
// 실행 Chrome은 화면에 뜬다. 숨기려면 SAX_DEMO_HEADLESS=1.
// --portal=hometax(pnpm start:hometax)면 실제 앱 폴더·utilityProcess 금고·OS 키체인으로 홈택스에 붙는다. PoC-3 실 홈택스 시험은 이 길 하나다(ADR-025 결정 8).
import path from 'node:path';
import { appPaths, defaultAppRoot, prepareLayout } from '@sax/platform';
import { app, dialog } from 'electron';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';

const hometax = process.argv.includes('--portal=hometax');
registerShellSchemes();
if (hometax) {
  // 앱 폴더를 확인·복구한 뒤에만 Electron에 넘긴다(main.ts와 같은 순서). 사용자 전용 권한을 못 걸면 열지 않는다.
  const root = defaultAppRoot();
  const prepared = await prepareLayout(root).catch(() => null);
  if (!prepared?.root.ok) {
    dialog.showErrorBox('저장소 권한', '앱 폴더를 사용자 전용으로 준비하지 못해 열지 않았어요.');
    app.exit(1);
  } else {
    const paths = appPaths(root);
    app.setPath('userData', paths.userData);
    app.setPath('logs', paths.logs);
    app.setPath('crashDumps', paths.crashDumps);
  }
} else app.setPath('userData', path.join(app.getPath('temp'), 'sax-shell-demo'));
// 두 번째 실행은 첫 실행의 창을 앞으로 가져오고 끝난다(N-29). 잠금은 userData 기준이라 setPath 뒤에 잡는다.
if (!app.requestSingleInstanceLock()) app.exit(0);
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
  try {
    shell = await startShell(hometax ? { engine: { portal: { kind: 'hometax' } } } : { headful: process.env.SAX_DEMO_HEADLESS !== '1' });
    await shell.ready;
  } catch (e) {
    console.error('shell start failed:', (e as Error).message);
    await shell?.close().catch(() => {});
    app.exit(1);
  }
});
