import { createRequire } from 'node:module';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, MessageChannelMain, session, type MessagePortMain, type Session } from 'electron';
import { CERT_MAX_BYTES, DocparseError, MAX_INPUT_BYTES, parse, SANDBOX_ERRORS as SANDBOX_ERROR_LIST, validateSandboxOutput, type CertInfo, type DocKind, type DocparseHost, type ImageOcr, type ParseOptions, type ParseOutcome, type PdfExtract, type SheetOutput } from '@sax/docparse';
import { hardenWindow } from './harden.ts';

export { DocparseError };
export type { PdfExtract };

// ADR-014 결정 1: docparse는 Chromium 렌더러 샌드박스에서 돈다. 숨김 창, 네트워크 차단 파티션,
// preload는 MessagePort 수신 하나만. 입력은 main이 읽은 바이트, 출력은 main이 스키마로 검증한 값뿐.
// PDF는 pdf.js(6.4.299 고정, CVE-2026-16633 수정판 이상. 6.x에는 eval 경로가 없어 isEvalSupported가 없다)로 읽고,
// 텍스트 층이 없거나 깨졌으면 같은 창에서 앞쪽을 그려 tesseract로 읽는다(D17 §3).
// 이 파일은 @sax/docparse의 샌드박스 어댑터다: 창·파티션·상한을 맡고, 입출력 모양은 패키지 schema/sandbox-output.schema.json으로 검증한다.
// 그림(종이 증빙·폰 사진)과 표(xlsx·xls·HTML 표·CSV)도 같은 창에서 읽는다(M6-4·M6-5). 폰에서 E2EE로 받은 사진(M7-4)은 sandboxHost.image(photo)로 들어온다.

export const DOCPARSE_SCHEME = 'sax-docparse';
const require = createRequire(import.meta.url);
const STATIC = path.join(import.meta.dirname, '../static');
const PAGE = path.join(STATIC, 'docparse');
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
  // @sax/docparse의 샌드박스 순수 모듈(빌드된 JS). 상대 경로 import만 있어 /lib/ 아래에서 그대로 돈다
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


/** 샌드박스가 돌려줄 수 있는 실패 코드. 그 밖의 값은 schema로 본다. */
const SANDBOX_ERRORS = new Set<string>(SANDBOX_ERROR_LIST);
const MAX_INPUT = MAX_INPUT_BYTES;
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
    if ('error' in o) throw new DocparseError(validateSandboxOutput('error', o) && SANDBOX_ERRORS.has(o.error as string) ? (o.error as string) : 'schema');
    return { out: o, ms: Date.now() - started, peakMemoryKb };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    port1?.close();
    if (!win.isDestroyed()) win.destroy();
  }
}

export interface OcrResult {
  text: string;
  confidence: number;
  ms: number;
}

/** 이미지 OCR(사업자등록증 사진 등). */
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

export const PDF_MAX_PAGES = 5;
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
  const v = validateSandboxOutput('pdf', out);
  if (!v) throw new DocparseError('schema');
  return { ...v, ms, peakMemoryKb };
}

/**
 * tesseract 언어 데이터(@tesseract.js-data/kor). tessdata = 4.0.0(레거시+LSTM), best_int = 4.0.0_best_int(LSTM 전용 정수).
 * D14 M6-4의 `kor_fast`는 이 패키지에 없어서, LSTM 전용인 best_int를 사진 기본으로 쓴다(합성 영수증 24장 실측: 상호 24/24 대 23/24, 사업자번호 21 대 18,
 * 틀렸는데 신뢰도 ≥ 0.8인 칸 0 대 2, 중앙 451ms 대 545ms). 증명서(document)는 PoC-8에서 잰 tessdata를 그대로 둔다.
 */
export type OcrModel = 'tessdata' | 'best_int';

export interface ImageOptions {
  /** document: 고정 임계 흑백 + 표 선 지우기(증명서 사진). photo: 국소 임계(종이 증빙·폰 사진) */
  mode: 'document' | 'photo';
  model?: OcrModel;
  timeoutMs?: number;
  memoryLimitKb?: number;
}

/** 그림 OCR(JPEG·PNG). 크기 머리 검사 → 디코드 → 전처리 → tesseract 블록(줄마다 신뢰도). */
export async function ocrImageInSandbox(bytes: Uint8Array, opts: ImageOptions): Promise<ImageOcr & { ms: number; peakMemoryKb: number }> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new DocparseError('input_size');
  const model = opts.model ?? (opts.mode === 'photo' ? 'best_int' : 'tessdata');
  const { out, ms, peakMemoryKb } = await runJob({ kind: 'image', bytes: bytes.slice(), mode: opts.mode, model }, opts.timeoutMs ?? 60_000, opts.memoryLimitKb);
  const v = validateSandboxOutput('image', out);
  if (!v) throw new DocparseError('schema');
  return { ...v, ms, peakMemoryKb };
}

/** 표 읽기(xlsx·xls·HTML 표·CSV). OCR이 없어 메모리 상한을 낮게 둔다 */
export async function readSheetInSandbox(bytes: Uint8Array, opts: { timeoutMs?: number; memoryLimitKb?: number } = {}): Promise<SheetOutput & { ms: number; peakMemoryKb: number }> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT) throw new DocparseError('input_size');
  const { out, ms, peakMemoryKb } = await runJob({ kind: 'sheet', bytes: bytes.slice() }, opts.timeoutMs ?? 20_000, opts.memoryLimitKb ?? 900_000);
  const v = validateSandboxOutput('sheet', out);
  if (!v) throw new DocparseError('schema');
  return { ...v, ms, peakMemoryKb };
}

/**
 * 공동인증서(NPKI signCert.der) → 고정 4필드(D05 §6 (2), D17 §3 certInfo, #95). main은 DER를 읽지 않는다: 샌드박스가 읽고 main은 스키마로 검증만 한다.
 * 금고 npki.list가 준 바이트(비신뢰, 1~8192바이트)만. 범위 밖은 input_size, 해석 실패는 cert_invalid, 모양이 틀리면 schema.
 */
export async function certInfoInSandbox(der: Uint8Array, opts: { timeoutMs?: number } = {}): Promise<CertInfo> {
  if (!(der instanceof Uint8Array) || der.length === 0 || der.length > CERT_MAX_BYTES) throw new DocparseError('input_size');
  const { out } = await runJob({ kind: 'certInfo', bytes: der.slice() }, opts.timeoutMs ?? 10_000, 600_000);
  const v = validateSandboxOutput('certInfo', out);
  if (!v) throw new DocparseError('schema');
  return v;
}

/** @sax/docparse parse()가 부르는 샌드박스 host. ms·메모리 같은 측정값은 떼고 스키마 모양만 넘긴다 */
export function sandboxHost(o: { model?: OcrModel } = {}): DocparseHost {
  // 측정값(ms·peakMemoryKb)을 떼고 넘긴다. parse()가 스키마로 다시 검증한다(추가 필드가 있으면 schema 오류)
  const strip = <T extends object>(r: T, keys: string[]) => Object.fromEntries(Object.entries(r).filter(([k]) => !keys.includes(k)));
  return {
    pdf: async (bytes, opts) => strip(await parsePdfInSandbox(bytes, { password: opts.password, ocrPages: opts.ocrPages, forceOcr: opts.forceOcr }), ['ms', 'peakMemoryKb']) as unknown as PdfExtract,
    image: async (bytes, opts) => strip(await ocrImageInSandbox(bytes, { mode: opts.mode, model: o.model }), ['ms', 'peakMemoryKb']) as unknown as ImageOcr,
    sheet: async (bytes) => strip(await readSheetInSandbox(bytes), ['ms', 'peakMemoryKb']) as unknown as SheetOutput,
  };
}

/** 공개 입구(main 전용): 사용자가 고른 파일의 바이트 → 샌드박스 → 규칙 → 스키마 통과 결과. 실패는 DocparseError 코드 */
export function parseInSandbox(bytes: Uint8Array, kind: DocKind, opts: ParseOptions & { model?: OcrModel } = {}): Promise<ParseOutcome> {
  return parse(bytes, kind, sandboxHost({ model: opts.model }), opts);
}
