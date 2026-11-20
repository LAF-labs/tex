import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, MessageChannelMain, session, type MessagePortMain, type Session } from 'electron';
import { CERT_MAX_BYTES, DocparseError, MAX_INPUT_BYTES, parse, SANDBOX_ERRORS as SANDBOX_ERROR_LIST, validateSandboxOutput, type CertInfo, type DocKind, type DocparseHost, type ImageOcr, type ParseOptions, type ParseOutcome, type PdfExtract, type SheetOutput } from '@sax/docparse';
import { hardenWindow } from './harden.ts';

export { DocparseError };
export type { PdfExtract };


export const DOCPARSE_SCHEME = 'sax-docparse';
const require = createRequire(import.meta.url);
const STATIC = path.join(import.meta.dirname, '../static');
const PAGE = path.join(STATIC, 'docparse');
const WORKER_CSP: Record<string, string> = {
  '/pdfjs/pdf.worker.min.mjs': "default-src 'none'; script-src sax-docparse: 'wasm-unsafe-eval'",
  '/worker.min.js': "default-src 'none'; script-src sax-docparse: 'wasm-unsafe-eval'; connect-src sax-docparse:",
};
const DEAD_PROXY = { proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>' };
const MAX_CONCURRENT = 2;

function dirAssets(urlDir: string, dir: string, keep: (f: string) => boolean): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(dir).filter(keep).map((f) => [`${urlDir}/${f}`, path.join(dir, f)]));
}

function assetMap(): Record<string, string> {
  const tdir = path.dirname(require.resolve('tesseract.js/package.json'));
  const core = path.dirname(require.resolve('tesseract.js-core/package.json', { paths: [tdir] }));
  const kor = (require('@tesseract.js-data/kor') as { langPath: string }).langPath;
  const pdf = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const lib = path.join(path.dirname(require.resolve('@sax/docparse/package.json')), 'dist/sandbox');
  return {
    '/index.html': path.join(PAGE, 'index.html'),
    '/docparse.mjs': path.join(PAGE, 'docparse.mjs'),
    ...dirAssets('/lib', lib, (f) => f.endsWith('.js')),
    '/tesseract.min.js': path.join(tdir, 'dist/tesseract.min.js'),
    '/worker.min.js': path.join(tdir, 'dist/worker.min.js'),
    '/lang/kor.traineddata.gz': path.join(kor, 'kor.traineddata.gz'),
    '/lang-best-int/kor.traineddata.gz': path.join(kor, '../4.0.0_best_int/kor.traineddata.gz'),
    ...Object.fromEntries(['tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [`/core/${f}`, path.join(core, f)])),
    '/pdfjs/pdf.min.mjs': path.join(pdf, 'build/pdf.min.mjs'),
    '/pdfjs/pdf.worker.min.mjs': path.join(pdf, 'build/pdf.worker.min.mjs'),
    ...dirAssets('/pdfjs/cmaps', path.join(pdf, 'cmaps'), (f) => f.endsWith('.bcmap')),
    ...dirAssets('/pdfjs/standard_fonts', path.join(pdf, 'standard_fonts'), (f) => /\.(pfb|ttf)$/.test(f)),
    ...dirAssets('/pdfjs/wasm', path.join(pdf, 'wasm'), (f) => /^(openjpeg|jbig2|qcms_bg)\.wasm$|_nowasm_fallback\.js$/.test(f)),
  };
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.gz': 'application/octet-stream', '.wasm': 'application/wasm' };
let configured: Session | null = null;
let proxied: Promise<void> | null = null;

function configureSession(): Session {
  if (configured) return configured;
  const assets = assetMap();
  const s = session.fromPartition('sax-docparse');
  if (!s.protocol.isProtocolHandled(DOCPARSE_SCHEME)) {
    s.protocol.handle(DOCPARSE_SCHEME, async (req) => {
      const p = new URL(req.url).pathname;
      const file = assets[p];
      if (!file) return new Response('', { status: 404 });
      const headers: Record<string, string> = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' };
      if (WORKER_CSP[p]) headers['content-security-policy'] = WORKER_CSP[p];
      return new Response(await fsp.readFile(file), { headers });
    });
  }
  s.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${DOCPARSE_SCHEME}://`) && !d.url.startsWith('blob:') && !d.url.startsWith('data:') }));
  s.on('will-download', (e) => e.preventDefault());
  s.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  s.setPermissionCheckHandler(() => false);
  configured = s;
  return s;
}

async function docparseSession(): Promise<Session> {
  const s = configureSession();
  const ready = (proxied ??= s.setProxy(DEAD_PROXY));
  try {
    await ready;
  } catch (e) {
    if (proxied === ready) proxied = null;
    throw e;
  }
  return s;
}

export async function createDocparseWindow(): Promise<BrowserWindow> {
  const ses = await docparseSession().catch(() => {
    throw new DocparseError('session_failed');
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false,
      disableDialogs: true,
      backgroundThrottling: false,
      preload: path.join(STATIC, 'preload-docparse.cjs'),
    },
  });
  win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  hardenWindow(win);
  return win;
}

let active = 0;
const waiting: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}


const SANDBOX_ERRORS = new Set<string>(SANDBOX_ERROR_LIST);
const MAX_INPUT = MAX_INPUT_BYTES;
const MEMORY_LIMIT_KB = 1_500_000;

interface JobRun {
  out: Record<string, unknown>;
  ms: number;
  peakMemoryKb: number;
}

function rendererMemoryKb(pid: number): number {
  return app.getAppMetrics().find((m) => m.pid === pid)?.memory.workingSetSize ?? 0;
}

function runJob(payload: Record<string, unknown>, timeoutMs: number, memoryLimitKb = MEMORY_LIMIT_KB): Promise<JobRun> {
  return withSlot(() => runJobNow(payload, timeoutMs, memoryLimitKb));
}

async function runJobNow(payload: Record<string, unknown>, timeoutMs: number, memoryLimitKb: number): Promise<JobRun> {
  const started = Date.now();
  const win = await createDocparseWindow();
  let peakMemoryKb = 0;
  let poll: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  let port1: MessagePortMain | null = null;
  try {
    const channel = new MessageChannelMain();
    port1 = channel.port1;
    const port2 = channel.port2;
    const port = port1;
    const timedOut = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new DocparseError('timeout')), timeoutMs)));
    timedOut.catch(() => {});
    await Promise.race([win.loadURL(`${DOCPARSE_SCHEME}://app/index.html`), timedOut]);
    const pid = win.webContents.getOSProcessId();
    const sample = () => (peakMemoryKb = Math.max(peakMemoryKb, rendererMemoryKb(pid)));
    const out = await new Promise<unknown>((resolve, reject) => {
      timedOut.catch(reject);
      const guard = () => {
        if (sample() > memoryLimitKb) reject(new DocparseError('memory_limit'));
      };
      guard();
      poll = setInterval(guard, 50);
      win.webContents.once('render-process-gone', () => reject(new DocparseError('renderer_gone')));
      port.on('message', (e) => resolve(e.data));
      port.start();
      win.webContents.postMessage('docparse-port', null, [port2]);
      port.postMessage(payload);
    });
    sample();
    if (!out || typeof out !== 'object') throw new DocparseError('schema');
    const o = out as Record<string, unknown>;
    if ('error' in o) throw new DocparseError(validateSandboxOutput('error', o) && SANDBOX_ERRORS.has(o.error as string) ? (o.error as string) : 'schema');
    return { out: o, ms: Date.now() - started, peakMemoryKb };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    port1?.close();
    if (!win.isDestroyed()) win.destroy();
  }
}

interface OcrResult {
  text: string;
  confidence: number;
  ms: number;
}

export async function ocrInSandbox(bytes: Uint8Array, timeoutMs = 60_000): Promise<OcrResult> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new Error('input_size');
  const { out, ms } = await runJob({ bytes }, timeoutMs);
  const v = validateSandboxOutput('legacyOcr', out);
  if (!v) throw new Error('schema');
  return { text: v.text, confidence: v.confidence, ms };
}

export interface PdfExtractRun extends PdfExtract {
  ms: number;
  timing: { loadMs: number; textMs: number; ocrMs: number };
  peakMemoryKb: number;
}

const PDF_MAX_PAGES = 5;
export interface PdfOptions {
  password?: string;
  ocrPages?: number;
  forceOcr?: boolean;
  timeoutMs?: number;
  memoryLimitKb?: number;
}

export async function parsePdfInSandbox(bytes: Uint8Array, opts: PdfOptions = {}): Promise<PdfExtractRun> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new DocparseError('input_size');
  if (Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new DocparseError('not_pdf');
  const ocrPages = Math.max(0, Math.min(opts.ocrPages ?? 2, PDF_MAX_PAGES));
  const timeoutMs = opts.timeoutMs ?? (ocrPages ? 90_000 : 20_000);
  const forceOcr = opts.forceOcr === true && ocrPages > 0;
  const { out, ms, peakMemoryKb } = await runJob({ kind: 'pdf', bytes: bytes.slice(), maxPages: PDF_MAX_PAGES, ocrPages, forceOcr, password: opts.password }, timeoutMs, opts.memoryLimitKb);
  const v = validateSandboxOutput('pdf', out);
  if (!v) throw new DocparseError('schema');
  return { ...v, ms, peakMemoryKb };
}

export type OcrModel = 'tessdata' | 'best_int';

interface ImageOptions {
  mode: 'document' | 'photo';
  model?: OcrModel;
  timeoutMs?: number;
  memoryLimitKb?: number;
}

export async function ocrImageInSandbox(bytes: Uint8Array, opts: ImageOptions): Promise<ImageOcr & { ms: number; peakMemoryKb: number }> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new DocparseError('input_size');
  const model = opts.model ?? (opts.mode === 'photo' ? 'best_int' : 'tessdata');
  const { out, ms, peakMemoryKb } = await runJob({ kind: 'image', bytes: bytes.slice(), mode: opts.mode, model }, opts.timeoutMs ?? 60_000, opts.memoryLimitKb);
  const v = validateSandboxOutput('image', out);
  if (!v) throw new DocparseError('schema');
  return { ...v, ms, peakMemoryKb };
}

export async function readSheetInSandbox(bytes: Uint8Array, opts: { timeoutMs?: number; memoryLimitKb?: number } = {}): Promise<SheetOutput & { ms: number; peakMemoryKb: number }> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new DocparseError('input_size');
  const { out, ms, peakMemoryKb } = await runJob({ kind: 'sheet', bytes: bytes.slice() }, opts.timeoutMs ?? 20_000, opts.memoryLimitKb ?? 900_000);
  const v = validateSandboxOutput('sheet', out);
  if (!v) throw new DocparseError('schema');
  return { ...v, ms, peakMemoryKb };
}

export async function certInfoInSandbox(der: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<CertInfo> {
  if (!(der instanceof Uint8Array) || der.length === 0 || der.length > CERT_MAX_BYTES) throw new DocparseError('input_size');
  const { out } = await runJob({ kind: 'certInfo', bytes: der.slice() }, opts.timeoutMs ?? 10_000, 600_000);
  const v = validateSandboxOutput('certInfo', out);
  if (!v) throw new DocparseError('schema');
  return v;
}

export function sandboxHost(o: { model?: OcrModel } = {}): DocparseHost {
  const strip = <T extends object>(r: T, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
  return {
    pdf: async (bytes, opts) => strip(await parsePdfInSandbox(bytes, { password: opts.password, ocrPages: opts.ocrPages, forceOcr: opts.forceOcr }), ['ms', 'peakMemoryKb']) as unknown as PdfExtract,
    image: async (bytes, opts) => strip(await ocrImageInSandbox(bytes, { mode: opts.mode, model: o.model }), ['ms', 'peakMemoryKb']) as unknown as ImageOcr,
    sheet: async (bytes) => strip(await readSheetInSandbox(bytes), ['ms', 'peakMemoryKb']) as unknown as SheetOutput,
  };
}

export function parseInSandbox(bytes: Uint8Array, kind: DocKind, opts: ParseOptions & { model?: OcrModel } = {}): Promise<ParseOutcome> {
  return parse(bytes, kind, sandboxHost({ model: opts.model }), opts);
}
