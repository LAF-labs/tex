import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, MessageChannelMain, session, type MessagePortMain, type Session } from 'electron';
import { hardenWindow } from './harden.ts';

// ADR-014 결정 1: docparse는 Chromium 렌더러 샌드박스에서 돈다. 숨김 창, 네트워크 차단 파티션,
// preload는 MessagePort 수신 하나만. 입력은 main이 읽은 바이트, 출력은 main이 스키마로 검증한 값뿐.
// PDF는 pdf.js(6.4.299 고정, CVE-2026-16633 수정판 이상. 6.x에는 eval 경로가 없어 isEvalSupported가 없다)로 읽고,
// 텍스트 층이 없거나 깨졌으면 같은 창에서 앞쪽을 그려 tesseract로 읽는다(D17 §3).

export const DOCPARSE_SCHEME = 'sax-docparse';
const require = createRequire(import.meta.url);
const STATIC = path.join(import.meta.dirname, '../static');
/** 워커는 페이지 CSP를 물려받지 않는다. 워커 스크립트 응답에 직접 붙인다(tesseract 워커는 언어 데이터를 자기 스킴에서 받는다). */
const WORKER_CSP: Record<string, string> = {
  '/pdfjs/pdf.worker.min.mjs': "default-src 'none'; script-src sax-docparse: 'wasm-unsafe-eval'",
  '/worker.min.js': "default-src 'none'; script-src sax-docparse: 'wasm-unsafe-eval'; connect-src sax-docparse:",
};
/** 죽은 프록시: WebRTC TURN(TCP)·혹시 남은 http 송신이 이리로 가서 끊긴다. 루프백도 우회하지 않는다. */
const DEAD_PROXY = { proxyRules: 'socks5://127.0.0.1:9', proxyBypassRules: '<-loopback>' };
/** 동시에 띄우는 docparse 창 수(창 하나가 OCR이면 약 600MB). 넘치면 줄을 선다. */
const MAX_CONCURRENT = 2;

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
/** 동기 설정(스킴 처리기·요청 차단·다운로드·권한)은 세션에 한 번만 건다. 같은 파티션에 다시 걸면 스킴이 이미 등록됐다며 실패한다. */
let configured: Session | null = null;
/** 죽은 프록시 설정(비동기). 실패하면 다음 작업이 이것만 다시 시도한다(재시작 전까지 막히지 않게). */
let proxied: Promise<void> | null = null;

function configureSession(): Session {
  if (configured) return configured;
  const assets = assetMap(); // 자산 목록을 못 만들면 아무것도 등록하지 않고 실패한다(다음에 처음부터 다시)
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
  // 모든 네트워크 요청 취소(자기 스킴의 정적 자산만 허용). webRequest를 지나지 않는 WebRTC는 창 정책과 죽은 프록시로 막는다.
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

/** docparse 창 하나(숨김, 샌드박스, 차단 세션, WebRTC 직접 UDP 금지). 작업마다 새로 만들고 끝나면 파기한다. e2e의 송신 시험도 이 창을 쓴다. */
export async function createDocparseWindow(): Promise<BrowserWindow> {
  // 세션을 준비하지 못하면(프록시 설정 실패 등) 창을 띄우지 않는다. 송신 차단 없이 PDF를 열지 않는다.
  const ses = await docparseSession().catch(() => {
    throw new DocparseError('session_failed');
  });
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, devTools: false, spellcheck: false,
      // 악성 PDF가 alert·confirm으로 main을 멈추지 못하게(N-68).
      disableDialogs: true,
      backgroundThrottling: false, // 숨김 창에서 타이머·렌더가 늦춰지지 않게
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

/**
 * 작업마다 새 창, 끝나면 파기. 시간 상한(창 띄우기부터)·메모리 상한을 넘기거나 렌더러가 죽으면 파기하고 코드로 실패한다.
 * 동시에는 MAX_CONCURRENT개까지 돌고, 시간 상한은 차례가 온 뒤부터 잰다.
 */
function runJob(payload: Record<string, unknown>, timeoutMs: number, memoryLimitKb = MEMORY_LIMIT_KB): Promise<JobRun> {
  return withSlot(() => runJobNow(payload, timeoutMs, memoryLimitKb));
}

async function runJobNow(payload: Record<string, unknown>, timeoutMs: number, memoryLimitKb: number): Promise<JobRun> {
  const started = Date.now();
  // 창을 띄운 뒤에는 무엇이 실패해도 finally에서 파기한다(창을 띄우기 전 실패는 남길 것이 없다)
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
    sample(); // 짧은 작업은 폴링 전에 끝난다
    if (!out || typeof out !== 'object') throw new DocparseError('schema');
    const o = out as Record<string, unknown>;
    if ('error' in o) throw new DocparseError(typeof o.error === 'string' && SANDBOX_ERRORS.has(o.error) && Object.keys(o).length === 1 ? o.error : 'schema');
    return { out: o, ms: Date.now() - started, peakMemoryKb };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    port1?.close();
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
  /** 텍스트 층이 보이지 않는 글자다(스캐너·복합기가 OCR로 덧입힌 층). 원본 텍스트로 믿지 않는다. */
  scanned: boolean;
  /** text를 텍스트 층 대신 OCR로 읽었으면 평균 신뢰도(0~100), 아니면 null */
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
  if (!exactKeys(o, 'hasTextLayer,ocrConfidence,pages,scanned,text,timing,totalPages')) return null;
  const t = o.timing as Record<string, unknown> | null;
  if (typeof o.text !== 'string' || o.text.length > MAX_TEXT || !isCount(o.pages, PDF_MAX_PAGES) || !isCount(o.totalPages, 100_000) || typeof o.hasTextLayer !== 'boolean' || typeof o.scanned !== 'boolean') return null;
  if (o.ocrConfidence !== null && !(typeof o.ocrConfidence === 'number' && o.ocrConfidence >= 0 && o.ocrConfidence <= 100)) return null;
  if (!t || typeof t !== 'object' || !exactKeys(t, 'loadMs,ocrMs,textMs') || ![t.loadMs, t.textMs, t.ocrMs].every((v) => isCount(v, 3_600_000))) return null;
  return { text: o.text, pages: o.pages as number, totalPages: o.totalPages as number, hasTextLayer: o.hasTextLayer, scanned: o.scanned, ocrConfidence: o.ocrConfidence as number | null, timing: { loadMs: t.loadMs as number, textMs: t.textMs as number, ocrMs: t.ocrMs as number } };
}

export interface PdfOptions {
  /** 열기 암호. 사용자가 입력한 값을 이 작업에만 쓰고 저장하지 않는다. */
  password?: string;
  /** 텍스트 층이 없을 때 OCR할 앞쪽 쪽수(0이면 OCR 안 함). 증명서는 한 쪽이다. */
  ocrPages?: number;
  /** 텍스트 층이 있어도 OCR로 읽는다(층에서 핵심 칸을 못 뽑았을 때 다시 읽기) */
  forceOcr?: boolean;
  timeoutMs?: number;
  memoryLimitKb?: number;
}

/** PDF 텍스트 추출(앞 5쪽). 실패는 DocparseError 코드로만 알린다(파일 내용·경로를 남기지 않는다). */
export async function parsePdfInSandbox(bytes: Uint8Array, opts: PdfOptions = {}): Promise<PdfExtractRun> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new DocparseError('input_size');
  if (Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new DocparseError('not_pdf');
  const ocrPages = Math.max(0, Math.min(opts.ocrPages ?? 2, PDF_MAX_PAGES));
  const timeoutMs = opts.timeoutMs ?? (ocrPages ? 90_000 : 20_000);
  const forceOcr = opts.forceOcr === true && ocrPages > 0;
  // 넘긴 버퍼는 pdf.js 워커로 옮겨지며 비워진다. 부른 쪽 바이트는 그대로 둔다.
  const { out, ms, peakMemoryKb } = await runJob({ kind: 'pdf', bytes: bytes.slice(), maxPages: PDF_MAX_PAGES, ocrPages, forceOcr, password: opts.password }, timeoutMs, opts.memoryLimitKb);
  const v = validatePdf(out);
  if (!v) throw new DocparseError('schema');
  return { ...v, ms, peakMemoryKb };
}
