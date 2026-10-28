import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BrowserWindow, MessageChannelMain, session, type Session } from 'electron';

// ADR-014 결정 1: docparse는 Chromium 렌더러 샌드박스에서 돈다. 숨김 창, 네트워크 차단 파티션,
// preload는 MessagePort 수신 하나만. 입력은 main이 읽은 바이트, 출력은 스키마 검증한 {text, confidence}뿐.

export const DOCPARSE_SCHEME = 'sax-docparse';
const require = createRequire(import.meta.url);
const STATIC = path.join(import.meta.dirname, '../static');

function assetMap(): Record<string, string> {
  const tdir = path.dirname(require.resolve('tesseract.js/package.json'));
  const core = path.dirname(require.resolve('tesseract.js-core/package.json', { paths: [tdir] }));
  const kor = (require('@tesseract.js-data/kor') as { langPath: string }).langPath;
  return {
    '/index.html': path.join(STATIC, 'docparse.html'),
    '/docparse.js': path.join(STATIC, 'docparse.js'),
    '/tesseract.min.js': path.join(tdir, 'dist/tesseract.min.js'),
    '/worker.min.js': path.join(tdir, 'dist/worker.min.js'),
    '/lang/kor.traineddata.gz': path.join(kor, 'kor.traineddata.gz'),
    ...Object.fromEntries(['tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [`/core/${f}`, path.join(core, f)])),
  };
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.gz': 'application/octet-stream', '.wasm': 'application/wasm' };
let ses: Session | null = null;

function docparseSession(): Session {
  if (ses) return ses;
  const assets = assetMap();
  ses = session.fromPartition('sax-docparse');
  ses.protocol.handle(DOCPARSE_SCHEME, async (req) => {
    const file = assets[new URL(req.url).pathname];
    if (!file) return new Response('', { status: 404 });
    return new Response(await fs.readFile(file), { headers: { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' } });
  });
  // 모든 네트워크 요청 취소(자기 스킴의 정적 자산만 허용)
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${DOCPARSE_SCHEME}://`) && !d.url.startsWith('blob:') && !d.url.startsWith('data:') }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

export interface OcrResult {
  text: string;
  confidence: number;
  ms: number;
}

const MAX_INPUT = 15 * 1024 * 1024;

function validate(out: unknown): { text: string; confidence: number } | null {
  if (!out || typeof out !== 'object') return null;
  const o = out as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(',');
  if (keys !== 'confidence,text' || typeof o.text !== 'string' || o.text.length > 50_000 || typeof o.confidence !== 'number') return null;
  return { text: o.text, confidence: o.confidence };
}

/** 작업마다 새 창, 끝나면 파기. 시간 상한을 넘기면 파기. */
export async function ocrInSandbox(bytes: Uint8Array, timeoutMs = 60_000): Promise<OcrResult> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new Error('input_size');
  const started = Date.now();
  const win = new BrowserWindow({
    show: false,
    webPreferences: { session: docparseSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false, preload: path.join(STATIC, 'preload-docparse.cjs') },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  try {
    await win.loadURL(`${DOCPARSE_SCHEME}://app/index.html`);
    const { port1, port2 } = new MessageChannelMain();
    const out = await new Promise<unknown>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      port1.on('message', (e) => {
        clearTimeout(t);
        resolve(e.data);
      });
      port1.start();
      win.webContents.postMessage('docparse-port', null, [port2]);
      port1.postMessage({ bytes });
    });
    port1.close();
    const v = validate(out);
    if (!v) throw new Error('schema');
    return { ...v, ms: Date.now() - started };
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}
