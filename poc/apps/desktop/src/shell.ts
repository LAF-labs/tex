// PoC-9 데모 UI 셸 진입점. 실행: pnpm demo (electron apps/desktop/dist/shell.js).
// PoC-6부터 엔진·금고를 띄우고 가짜 H-01 페이지(127.0.0.1)에서 발급 흐름을 돈다(fixture 모드: 임시 앱 폴더, 메모리 키, 키체인 안 씀).
// 실행 Chrome은 화면에 뜬다. 숨기려면 SAX_DEMO_HEADLESS=1.
import path from 'node:path';
import { app } from 'electron';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';

registerShellSchemes();
app.setPath('userData', path.join(app.getPath('temp'), 'sax-shell-demo'));
let shell: Shell | null = null;
app.on('window-all-closed', () => {
  void (shell?.close() ?? Promise.resolve()).finally(() => app.quit());
});
void app.whenReady().then(async () => {
  shell = await startShell({ headful: process.env.SAX_DEMO_HEADLESS !== '1' });
  await shell.ready;
});
