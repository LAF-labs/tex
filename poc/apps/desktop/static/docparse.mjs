// 샌드박스 안 문서 파싱(ADR-014). 네트워크 없음, 저장 없음(tesseract cacheMethod none).
// 이미지 {bytes} → {text, confidence}.
// PDF {kind:'pdf', bytes, maxPages, ocrPages, forceOcr, password?} → {text, pages, totalPages, hasTextLayer, scanned, ocrConfidence, timing}.
//   hasTextLayer: 쓸 만한 텍스트 층이 있다. scanned: 그 층이 보이지 않는 글자(스캐너·복합기 OCR)다. ocrConfidence: text를 여기서 OCR로 읽었으면 신뢰도.
// pdf.js 워커는 직접 띄워 workerPort로 넘긴다. workerSrc로 두면 워커를 못 띄울 때 메인 스레드로 조용히 넘어간다.
import * as pdfjs from 'sax-docparse://app/pdfjs/pdf.min.mjs';
import { cleanForOcr } from 'sax-docparse://app/docparse-image.mjs';
import { assessTextLayer, itemsToLines, tidyText } from 'sax-docparse://app/docparse-text.mjs';

const BASE = 'sax-docparse://app/';
const PDFJS = `${BASE}pdfjs/`;
/** OCR 렌더링 해상도: 300dpi(Tesseract 권장), 긴 변은 3500px까지(A4 300dpi ≈ 3508px). */
const OCR_DPI = 300;
const OCR_MAX_SIDE = 3500;

class JobError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function tesseractWorker() {
  return Tesseract.createWorker('kor', 1, {
    workerPath: `${BASE}worker.min.js`,
    corePath: `${BASE}core`,
    langPath: `${BASE}lang`,
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
  });
}

async function ocrImage({ bytes }) {
  const worker = await tesseractWorker();
  try {
    const { data: r } = await worker.recognize(new Blob([bytes]));
    return { text: String(r.text || ''), confidence: Number(r.confidence || 0) };
  } finally {
    await worker.terminate();
  }
}

function pdfWorker() {
  const worker = new Worker(`${PDFJS}pdf.worker.min.mjs`, { type: 'module' });
  const failed = new Promise((_, reject) => worker.addEventListener('error', () => reject(new JobError('worker_failed')), { once: true }));
  failed.catch(() => {});
  return { worker, failed };
}

function pdfError(e) {
  if (e instanceof JobError) return e;
  if (e?.name === 'PasswordException') return new JobError(e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'password_incorrect' : 'password_required');
  if (e?.name === 'InvalidPDFException') return new JobError('invalid_pdf');
  return new JobError('parse_failed');
}

async function renderForOcr(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(OCR_DPI / 72, OCR_MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  // intent print: 숨김 창에서 멈출 수 있는 requestAnimationFrame을 쓰지 않는다.
  await page.render({ canvas, viewport, intent: 'print' }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  cleanForOcr(img.data, img.width, img.height);
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new JobError('render_failed');
  return blob;
}

/** 보이지 않게 그리는 글자(렌더 모드 3·7)가 있으면 남이 OCR로 덧입힌 층이다. 원본 텍스트로 믿지 않는다. */
async function hasInvisibleText(doc, pages) {
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const ops = await page.getOperatorList();
    page.cleanup();
    for (let k = 0; k < ops.fnArray.length; k++) {
      if (ops.fnArray[k] === pdfjs.OPS.setTextRenderingMode && (ops.argsArray[k][0] & 3) === 3) return true;
    }
  }
  return false;
}

async function parsePdf({ bytes, maxPages, ocrPages, forceOcr, password }) {
  const t0 = performance.now();
  const { worker, failed } = pdfWorker();
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  let task = null;
  try {
    task = pdfjs.getDocument({
      data: bytes,
      password: typeof password === 'string' ? password : undefined,
      cMapUrl: `${PDFJS}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS}standard_fonts/`,
      wasmUrl: `${PDFJS}wasm/`,
      useWorkerFetch: false, // 커스텀 스킴은 메인 스레드 XHR로 받는다
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      stopAtErrors: false,
      maxImageSize: 25_000_000,
    });
    const doc = await Promise.race([task.promise, failed]);
    const tLoaded = performance.now();
    const pages = Math.min(doc.numPages, maxPages);
    const lines = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      lines.push(...itemsToLines(tc.items));
      page.cleanup();
    }
    const layerText = tidyText(lines.join('\n'));
    const tText = performance.now();
    const layer = assessTextLayer(layerText, pages);
    const scanned = layer.ok && (await hasInvisibleText(doc, pages));
    const timing = { loadMs: Math.round(tLoaded - t0), textMs: Math.round(performance.now() - tLoaded), ocrMs: 0 };
    if ((layer.ok && !forceOcr) || ocrPages === 0) return { text: layerText, pages, totalPages: doc.numPages, hasTextLayer: layer.ok, scanned, ocrConfidence: null, timing };
    // 텍스트 층이 없거나 깨졌다(또는 층에서 핵심 칸을 못 뽑아 엔진이 다시 읽기를 청했다): 같은 창에서 앞쪽만 그려 OCR한다.
    const ocr = await tesseractWorker();
    try {
      const texts = [];
      let conf = 0;
      const n = Math.min(pages, ocrPages);
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const png = await renderForOcr(page);
        page.cleanup();
        const { data: r } = await ocr.recognize(png);
        texts.push(String(r.text || ''));
        conf += Number(r.confidence || 0);
      }
      timing.ocrMs = Math.round(performance.now() - tText);
      return { text: tidyText(texts.join('\n')), pages, totalPages: doc.numPages, hasTextLayer: layer.ok, scanned, ocrConfidence: Math.round(conf / n), timing };
    } finally {
      await ocr.terminate();
    }
  } catch (e) {
    throw pdfError(e);
  } finally {
    await task?.destroy().catch(() => {});
    worker.terminate(); // workerPort로 넘긴 워커는 loadingTask.destroy가 끝내지 않는다
  }
}

window.addEventListener('message', (ev) => {
  if (ev.data !== 'docparse-port' || !ev.ports[0]) return;
  const port = ev.ports[0];
  port.onmessage = async ({ data }) => {
    try {
      port.postMessage(data?.kind === 'pdf' ? await parsePdf(data) : await ocrImage(data));
    } catch (e) {
      port.postMessage({ error: e instanceof JobError ? e.code : 'ocr_failed' });
    }
  };
});
