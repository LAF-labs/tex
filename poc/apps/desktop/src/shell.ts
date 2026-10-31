// PoC-9 데모 UI 셸 진입점. 실행: pnpm demo (electron apps/desktop/dist/shell.js). 앱 폴더·키체인을 쓰지 않는다.
import path from 'node:path';
import { app } from 'electron';
import { registerShellSchemes, startShell } from './shell-app.ts';

registerShellSchemes();
app.setPath('userData', path.join(app.getPath('temp'), 'sax-shell-demo'));
app.on('window-all-closed', () => app.quit());
const speed = Number(process.env.SAX_DEMO_SPEED ?? '1');
void app.whenReady().then(() => startShell({ speed: Number.isFinite(speed) && speed > 0 ? speed : 1 }));
