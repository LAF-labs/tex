// Electron main(D01 §2.1): 수명주기·창·IPC 라우터·승인 창. DB 키 없음(엔진 읽기 IPC), 비밀 평문을 중계하지 않는다.
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, MessageChannelMain, protocol, session, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import { COMMANDS, READ_QUERIES } from '@sax/engine/protocol';
import { appPaths, defaultAppRoot, FileEventLog, prepareLayout } from '@sax/platform';
import { verifyLocalApproval } from './approval-gate.ts';
import { APPROVAL_SCHEME, ApprovalBar, bottomStrip, demoGateRequest } from './approval-bar.ts';
import { DOCPARSE_SCHEME, ocrInSandbox } from './docparse.ts';
import { cancelPick, importPdf } from './vault-import.ts';

const require = createRequire(import.meta.url);
const STATIC = path.join(import.meta.dirname, '../static');
const APP_SCHEME = 'sax-app';
const root = defaultAppRoot();
const paths = appPaths(root);

// D07 §1.1: 로밍 %APPDATA% 대신 %LOCALAPPDATA%\SovereignAX 아래로, ready 이전에 설정한다.
app.setPath('userData', paths.userData);
app.setPath('logs', paths.logs);
app.setPath('crashDumps', paths.crashDumps);
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  { scheme: APPROVAL_SCHEME, privileges: { standard: true, secure: true } },
]);

const log = new FileEventLog(null, 'main');
let vaultProc: UtilityProcess;
let engineProc: UtilityProcess;
let controlPort: MessagePortMain;
/** main↔금고가 기동 시 공유하는 LocalApproval 서명 키(ADR-014). Phase 2에 금고가 직접 검증한다. */
const approvalKey = new Uint8Array(randomBytes(32));
/** 개발 콘솔 창 아래 띠에 붙인 승인 바(ADR-021). 셸의 대화 열 배치는 shell-app.ts. */
let devBar: ApprovalBar | null = null;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let nextId = 1;
let engineReady: Promise<void>;

function rpc(target: 'engine' | 'control', method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    const msg = { t: 'rpc', id, method, params };
    if (target === 'engine') engineProc.postMessage(msg);
    else controlPort.postMessage(msg);
  });
}

function onRpcReply(msg: { t?: string; id?: number; result?: unknown; error?: string }): void {
  if (msg?.t !== 'rpc' || typeof msg.id !== 'number') return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  if (!p) return;
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
}

function startProcesses(): void {
  vaultProc = utilityProcess.fork(require.resolve('@sax/vault/entry'), [], { serviceName: 'sax-vault', stdio: 'ignore' });
  engineProc = utilityProcess.fork(require.resolve('@sax/engine/entry'), [], { serviceName: 'sax-engine', stdio: 'ignore' });
  const relay = new MessageChannelMain();
  const ctl = new MessageChannelMain();
  controlPort = ctl.port2;
  controlPort.on('message', (e) => onRpcReply(e.data));
  controlPort.start();
  vaultProc.postMessage({ ports: ['engine', 'control'] }, [relay.port1, ctl.port1]);
  engineReady = new Promise((resolve, reject) => {
    engineProc.on('message', (m: { t?: string; code?: string }) => {
      if (m?.t === 'ready') resolve();
      else if (m?.t === 'fatal') reject(new Error(m.code));
      else onRpcReply(m);
    });
  });
  engineProc.postMessage({ t: 'vault-port' }, [relay.port2]);
  vaultProc.on('exit', (c) => log.event('main.vault_exit', { code: c }));
  engineProc.on('exit', (c) => log.event('main.engine_exit', { code: c }));
}

function serveStatic(): void {
  const files: Record<string, string> = { '/app.html': 'text/html; charset=utf-8', '/app.js': 'text/javascript', '/app.css': 'text/css', '/secret.html': 'text/html; charset=utf-8', '/secret.js': 'text/javascript', '/vault-panel.js': 'text/javascript' };
  protocol.handle(APP_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    const type = files[p];
    if (!type) return new Response('', { status: 404 });
    return new Response(await fs.readFile(path.join(STATIC, p.slice(1))), { headers: { 'content-type': type } });
  });
  // 렌더러는 네트워크가 없다(D01 §2.1). 기본 세션에서 자기 스킴 밖 요청을 취소한다.
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${APP_SCHEME}://`) && !d.url.startsWith('devtools://') }));
  session.defaultSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
}

/** 비밀 입력 창: 금고 직결 MessagePort. main은 포트를 넘기기만 하고 내용을 읽지 않는다. */
function openSecretInput(kind: string, scope: string): void {
  const win = new BrowserWindow({
    width: 420, height: 300, resizable: false, title: '비밀 입력',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false, preload: path.join(STATIC, 'preload-secret.cjs') },
  });
  win.setContentProtection(true);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const ch = new MessageChannelMain();
  vaultProc.postMessage({ ports: ['secretInput'] }, [ch.port1]);
  void win.loadURL(`${APP_SCHEME}://app/secret.html#kind=${encodeURIComponent(kind)}&scope=${encodeURIComponent(scope)}`).then(() => {
    win.webContents.postMessage('vault-secret-port', null, [ch.port2]);
  });
}

// bizcert.parse·document.import는 main이 docparse 결과를 붙여 부른다. 렌더러가 텍스트·바이트를 지어 보낼 수 없다.
const RENDERER_METHODS = new Set<string>([...READ_QUERIES, ...COMMANDS.filter((c) => c !== 'bizcert.parse' && c !== 'document.import')]);

async function handleRenderer(method: string, params: Record<string, unknown>): Promise<unknown> {
  await engineReady;
  if (RENDERER_METHODS.has(method)) return rpc('engine', method, params);
  switch (method) {
    case 'app.status': {
      const [engine, key] = await Promise.all([rpc('engine', 'engine.status'), rpc('engine', 'bizverify.hasKey')]);
      return { engine, hasKey: (key as { hasKey: boolean }).hasKey };
    }
    case 'browser.open': {
      const runId = randomUUID();
      await rpc('control', 'run.begin', { runId, trigger: 'local' });
      return rpc('engine', 'browser.open', { portal: params.portal === 'hometax' ? 'hometax' : undefined });
    }
    case 'browser.close':
      return rpc('engine', 'browser.close');
    case 'secret.openInput':
      openSecretInput(String(params.kind ?? 'cert_password'), String(params.scope ?? 'business'));
      return {};
    case 'vault.importPdf':
      return importPdf(params, (m, p) => rpc('engine', m, p));
    case 'vault.importCancel':
      cancelPick(params.pickId);
      return {};
    case 'ocr.bizcert': {
      // 사용자가 고른 파일만 파싱한다(ADR-014 자동 파싱 축소). PDF는 PoC-8(docparse pdf.js)에서.
      const pick = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '사업자등록증 이미지', extensions: ['png', 'jpg', 'jpeg'] }] });
      if (pick.canceled || !pick.filePaths[0]) return null;
      const bytes = new Uint8Array(await fs.readFile(pick.filePaths[0]));
      const ocr = await ocrInSandbox(bytes);
      const parse = await rpc('engine', 'bizcert.parse', { text: ocr.text });
      return { parse, confidence: ocr.confidence, ms: ocr.ms };
    }
    case 'approval.demo': {
      // 승인 바 시험(PoC-4 승인 창을 대체). 실제 게이트 요청은 PoC-6에서 엔진 신뢰 계획값으로 만든다.
      if (!devBar) throw new Error('not_ready');
      const r = await devBar.open(demoGateRequest());
      return { decision: r.decision, verified: r.decision === 'approve' ? verifyLocalApproval(approvalKey, r.approval) : false };
    }
  }
  throw new Error('unknown_method');
}

app.whenReady().then(async () => {
  const layout = await prepareLayout(root);
  if (!layout.root.ok) {
    dialog.showErrorBox('저장소 권한', `앱 폴더 권한을 사용자 전용으로 설정하지 못했습니다: ${layout.root.problems.join(', ')}`);
    app.quit();
    return;
  }
  serveStatic();
  startProcesses();
  ipcMain.handle('sax', async (e, req: { method?: unknown; params?: unknown }) => {
    // 메인 UI 창에서 온 호출만 받는다.
    // senderFrame은 null일 수 있다(프레임이 사라진 뒤 도착한 호출 등). null이면 거부한다.
    const url = e.senderFrame?.url;
    if (typeof url !== 'string' || !url.startsWith(`${APP_SCHEME}://app/app.html`)) throw new Error('forbidden');
    if (typeof req?.method !== 'string') throw new Error('bad_request');
    return handleRenderer(req.method, (req.params ?? {}) as Record<string, unknown>);
  });
  const win = new BrowserWindow({
    width: 1100, height: 860, title: '소버린 AX PoC',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload: path.join(STATIC, 'preload-app.cjs') },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (ev) => ev.preventDefault());
  devBar = new ApprovalBar(win, approvalKey, bottomStrip);
  await win.loadURL(`${APP_SCHEME}://app/app.html`);
});

app.on('window-all-closed', () => {
  vaultProc?.kill();
  engineProc?.kill();
  app.quit();
});
