import path from 'node:path';
import { app } from 'electron';
import { DEMO_DEV } from './demo-dev.ts';
import { DemoModel, demoModelConfig } from './demo-model.ts';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';

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
    app.focus({ steal: true });
  } catch (e) {
    console.error('shell start failed:', (e as Error).message);
    await shell?.close().catch(() => {});
    app.exit(1);
  }
});
