import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, MessageChannelMain, session, type Session } from 'electron';

// ADR-014 결정 1: docparse는 Chromium 렌더러 샌드박스에서 돈다. 숨김 창, 네트워크 차단 파티션,
// preload는 MessagePort 수신 하나만. 입력은 main이 읽은 바이트, 출력은 main이 스키마로 검증한 값뿐.
// PDF는 pdf.js(6.4.299 고정, CVE-2026-16633 수정판 이상. 6.x에는 eval 경로가 없어 isEvalSupported가 없다)로 읽고,
// 텍스트 층이 없거나 깨졌으면 같은 창에서 앞쪽을 그려 tesseract로 읽는다(D17 §3).

export const DOCPARSE_SCHEME = 'sax-docparse';
const require = createRequire(import.meta.url);
const STATIC = path.join(import.meta.dirname, '../static');
/** pdf.js 워커는 페이지 CSP를 물려받지 않는다. 워커 응답에 직접 붙인다. */
const WORKER_CSP = "default-src 'none'; script-src sax-docparse: 'wasm-unsafe-eval'";

function dirAssets(urlDir: string, dir: string, keep: (f: string) => boolean): Record<string, string> {
  return Object.fromEntries(fs.readdirSync(dir).filter(keep).map((f) => [`${urlDir}/${f}`, path.join(dir, f)]));
}

function assetMap(): Record<string, string> {
  const tdir = path.dirname(require.resolve('tesseract.js/package.json'));
  const core = path.dirname(require.resolve('tesseract.js-core/package.json', { paths: [tdir] }));
  const kor = (require('@tesseract.js-data/kor') as { langPath: string }).langPath;
  const pdf = path.dirname(require.resolve('pdfjs-dist/package.json'));
  return {
    '/index.html': path.join(STATIC, 'docparse.html'),
    '/docparse.mjs': path.join(STATIC, 'docparse.mjs'),
    '/docparse-text.mjs': path.join(STATIC, 'docparse-text.mjs'),
    '/docparse-image.mjs': path.join(STATIC, 'docparse-image.mjs'),
    '/tesseract.min.js': path.join(tdir, 'dist/tesseract.min.js'),
    '/worker.min.js': path.join(tdir, 'dist/worker.min.js'),
    '/lang/kor.traineddata.gz': path.join(kor, 'kor.traineddata.gz'),
    ...Object.fromEntries(['tesseract-core.wasm.js', 'tesseract-core-simd.wasm.js', 'tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js'].map((f) => [`/core/${f}`, path.join(core, f)])),
    '/pdfjs/pdf.min.mjs': path.join(pdf, 'build/pdf.min.mjs'),
    '/pdfjs/pdf.worker.min.mjs': path.join(pdf, 'build/pdf.worker.min.mjs'),
    // 한글 CID 폰트(Adobe-Korea1, ToUnicode 없음)를 유니코드로 되돌리는 데 필요하다
    ...dirAssets('/pdfjs/cmaps', path.join(pdf, 'cmaps'), (f) => f.endsWith('.bcmap')),
    // 비임베디드 표준 폰트: OCR 렌더링용
    ...dirAssets('/pdfjs/standard_fonts', path.join(pdf, 'standard_fonts'), (f) => /\.(pfb|ttf)$/.test(f)),
    // JPX·JBIG2·ICC 디코더: 스캔 PDF를 OCR용으로 그릴 때. 스크립팅용 quickjs는 싣지 않는다.
    ...dirAssets('/pdfjs/wasm', path.join(pdf, 'wasm'), (f) => /^(openjpeg|jbig2|qcms_bg)\.wasm$|_nowasm_fallback\.js$/.test(f)),
  };
}

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.gz': 'application/octet-stream', '.wasm': 'application/wasm' };
let ses: Session | null = null;

function docparseSession(): Session {
  if (ses) return ses;
  const assets = assetMap();
  ses = session.fromPartition('sax-docparse');
  ses.protocol.handle(DOCPARSE_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    const file = assets[p];
    if (!file) return new Response('', { status: 404 });
    const headers: Record<string, string> = { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'x-content-type-options': 'nosniff' };
    if (p === '/pdfjs/pdf.worker.min.mjs') headers['content-security-policy'] = WORKER_CSP;
    return new Response(await fsp.readFile(file), { headers });
  });
  // 모든 네트워크 요청 취소(자기 스킴의 정적 자산만 허용)
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${DOCPARSE_SCHEME}://`) && !d.url.startsWith('blob:') && !d.url.startsWith('data:') }));
  ses.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  return ses;
}

export class DocparseError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

/** 샌드박스가 돌려줄 수 있는 실패 코드. 그 밖의 값은 schema로 본다. */
const SANDBOX_ERRORS = new Set(['password_required', 'password_incorrect', 'invalid_pdf', 'worker_failed', 'parse_failed', 'render_failed', 'ocr_failed']);
const MAX_INPUT = 15 * 1024 * 1024;
/** 렌더러 프로세스 작업 집합 상한(KB). 넘으면 창을 파기한다. pdf.js 워커·tesseract 워커도 같은 프로세스의 스레드다. */
const MEMORY_LIMIT_KB = 1_500_000;

interface JobRun {
  out: Record<string, unknown>;
  ms: number;
  peakMemoryKb: number;
}

function rendererMemoryKb(pid: number): number {
  return app.getAppMetrics().find((m) => m.pid === pid)?.memory.workingSetSize ?? 0;
}

/** 작업마다 새 창, 끝나면 파기. 시간·메모리 상한을 넘기거나 렌더러가 죽으면 파기하고 코드로 실패한다. */
async function runJob(payload: Record<string, unknown>, timeoutMs: number, memoryLimitKb = MEMORY_LIMIT_KB): Promise<JobRun> {
  const started = Date.now();
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: docparseSession(), sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false,
      backgroundThrottling: false, // 숨김 창에서 타이머·렌더가 늦춰지지 않게
      preload: path.join(STATIC, 'preload-docparse.cjs'),
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  let peakMemoryKb = 0;
  let poll: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    await win.loadURL(`${DOCPARSE_SCHEME}://app/index.html`);
    const pid = win.webContents.getOSProcessId();
    const sample = () => (peakMemoryKb = Math.max(peakMemoryKb, rendererMemoryKb(pid)));
    sample();
    const { port1, port2 } = new MessageChannelMain();
    const out = await new Promise<unknown>((resolve, reject) => {
      timer = setTimeout(() => reject(new DocparseError('timeout')), timeoutMs);
      const guard = () => {
        if (sample() > memoryLimitKb) reject(new DocparseError('memory_limit'));
      };
      guard();
      poll = setInterval(guard, 50);
      win.webContents.once('render-process-gone', () => reject(new DocparseError('renderer_gone')));
      port1.on('message', (e) => resolve(e.data));
      port1.start();
      win.webContents.postMessage('docparse-port', null, [port2]);
      port1.postMessage(payload);
    });
    port1.close();
    sample(); // 짧은 작업은 폴링 전에 끝난다
    if (!out || typeof out !== 'object') throw new DocparseError('schema');
    const o = out as Record<string, unknown>;
    if ('error' in o) throw new DocparseError(typeof o.error === 'string' && SANDBOX_ERRORS.has(o.error) && Object.keys(o).length === 1 ? o.error : 'schema');
    return { out: o, ms: Date.now() - started, peakMemoryKb };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    if (!win.isDestroyed()) win.destroy();
  }
}

const exactKeys = (o: Record<string, unknown>, keys: string) => Object.keys(o).sort().join(',') === keys;
const isCount = (v: unknown, max: number) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= max;

export interface OcrResult {
  text: string;
  confidence: number;
  ms: number;
}

function validateOcr(o: Record<string, unknown>): { text: string; confidence: number } | null {
  if (!exactKeys(o, 'confidence,text') || typeof o.text !== 'string' || o.text.length > 50_000 || typeof o.confidence !== 'number') return null;
  return { text: o.text, confidence: o.confidence };
}

/** 이미지 OCR(사업자등록증 사진 등). */
export async function ocrInSandbox(bytes: Uint8Array, timeoutMs = 60_000): Promise<OcrResult> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new Error('input_size');
  const { out, ms } = await runJob({ bytes }, timeoutMs);
  const v = validateOcr(out);
  if (!v) throw new Error('schema');
  return { ...v, ms };
}

/** D17 §3 extract 출력 + OCR 폴백 정보. text ≤ 1MB, pages ≤ 5. */
export interface PdfExtract {
  text: string;
  pages: number;
  totalPages: number;
  hasTextLayer: boolean;
  /** 텍스트 층 대신 OCR로 읽었으면 평균 신뢰도(0~100), 아니면 null */
  ocrConfidence: number | null;
}

export interface PdfExtractRun extends PdfExtract {
  ms: number;
  timing: { loadMs: number; textMs: number; ocrMs: number };
  peakMemoryKb: number;
}

export const PDF_MAX_PAGES = 5;
const MAX_TEXT = 1024 * 1024;

function validatePdf(o: Record<string, unknown>): (PdfExtract & { timing: PdfExtractRun['timing'] }) | null {
  if (!exactKeys(o, 'hasTextLayer,ocrConfidence,pages,text,timing,totalPages')) return null;
  const t = o.timing as Record<string, unknown> | null;
  if (typeof o.text !== 'string' || o.text.length > MAX_TEXT || !isCount(o.pages, PDF_MAX_PAGES) || !isCount(o.totalPages, 100_000) || typeof o.hasTextLayer !== 'boolean') return null;
  if (o.ocrConfidence !== null && !(typeof o.ocrConfidence === 'number' && o.ocrConfidence >= 0 && o.ocrConfidence <= 100)) return null;
  if (!t || typeof t !== 'object' || !exactKeys(t, 'loadMs,ocrMs,textMs') || ![t.loadMs, t.textMs, t.ocrMs].every((v) => isCount(v, 3_600_000))) return null;
  return { text: o.text, pages: o.pages as number, totalPages: o.totalPages as number, hasTextLayer: o.hasTextLayer, ocrConfidence: o.ocrConfidence as number | null, timing: { loadMs: t.loadMs as number, textMs: t.textMs as number, ocrMs: t.ocrMs as number } };
}

export interface PdfOptions {
  /** 열기 암호. 사용자가 입력한 값을 이 작업에만 쓰고 저장하지 않는다. */
  password?: string;
  /** 텍스트 층이 없을 때 OCR할 앞쪽 쪽수(0이면 OCR 안 함). 증명서는 한 쪽이다. */
  ocrPages?: number;
  timeoutMs?: number;
  memoryLimitKb?: number;
}

/** PDF 텍스트 추출(앞 5쪽). 실패는 DocparseError 코드로만 알린다(파일 내용·경로를 남기지 않는다). */
export async function parsePdfInSandbox(bytes: Uint8Array, opts: PdfOptions = {}): Promise<PdfExtractRun> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new DocparseError('input_size');
  if (Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new DocparseError('not_pdf');
  const ocrPages = Math.max(0, Math.min(opts.ocrPages ?? 2, PDF_MAX_PAGES));
  const timeoutMs = opts.timeoutMs ?? (ocrPages ? 90_000 : 20_000);
  // 넘긴 버퍼는 pdf.js 워커로 옮겨지며 비워진다. 부른 쪽 바이트는 그대로 둔다.
  const { out, ms, peakMemoryKb } = await runJob({ kind: 'pdf', bytes: bytes.slice(), maxPages: PDF_MAX_PAGES, ocrPages, password: opts.password }, timeoutMs, opts.memoryLimitKb);
  const v = validatePdf(out);
  if (!v) throw new DocparseError('schema');
  return { ...v, ms, peakMemoryKb };
}
