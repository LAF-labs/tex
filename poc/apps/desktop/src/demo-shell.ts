// 시연 진입점(pnpm demo: electron apps/desktop/dist/demo-shell.js). 제품 빌드에 들어가지 않는다(ADR-035 W-7, package-win 포함 목록).
// 가짜 H-01 페이지(127.0.0.1)에서 발급 흐름을 돈다(fixture 모드: 임시 앱 폴더, 메모리 키, 키체인 안 씀). 시연 씨앗을 넣는다.
// 실행 Chrome은 화면에 뜬다. 숨기려면 SAX_DEMO_HEADLESS=1. 채팅 해석에 모델을 쓰려면 SAX_DEMO_MODEL=openrouter(pnpm demo:model, demo-model.ts).
// 실제 홈택스는 제품 진입점(shell.ts, pnpm start:hometax)으로만 붙는다.
import path from 'node:path';
import { app } from 'electron';
import { DEMO_DEV } from './demo-dev.ts';
import { DemoModel, demoModelConfig } from './demo-model.ts';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';

// 시연 모델(SAX_DEMO_MODEL=openrouter): 키를 읽고 바로 process.env에서 지운다(자식·Chrome에 안 감).
const demoCfg = demoModelConfig(process.env, undefined, true);
registerShellSchemes();
app.setPath('userData', path.join(app.getPath('temp'), 'sax-shell-demo'));
let refused = false;
if (!app.requestSingleInstanceLock()) {
  refused = true;
  app.exit(0);
}
let shell: Shell | null = null;
app.on('second-instance', () => {
  const w = shell?.win;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  app.focus({ steal: true });
  w.focus();
});
app.on('window-all-closed', () => {
  void (shell?.close() ?? Promise.resolve()).finally(() => app.quit());
});
void app.whenReady().then(async () => {
  if (refused) return;
  try {
    shell = await startShell({ dev: DEMO_DEV, headful: process.env.SAX_DEMO_HEADLESS !== '1', demoModel: demoCfg ? new DemoModel(demoCfg) : null, demoSeed: true });
    await shell.ready;
    // 실행기(Dock)에서 뒤에서 띄우면 창이 다른 앱 뒤에 열릴 수 있다. 시연에서만 앞으로 가져온다.
    app.focus({ steal: true });
  } catch (e) {
    console.error('shell start failed:', (e as Error).message);
    await shell?.close().catch(() => {});
    app.exit(1);
  }
});
