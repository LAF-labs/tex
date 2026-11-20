import { extractDocMeta, kstToday, readScore, worthOcr, type DocMetaExtract } from '@sax/engine/docmeta';
import { DocparseError } from './errors.ts';
import { parseInsuranceNotice } from './insurance.ts';
import { parseReceipt } from './receipt.ts';
import { imageInfo, MAX_INPUT_BYTES, sniffFormat, type InputFormat, SandboxError } from './sandbox/index.ts';
import { validateParseOutcome, validateSandboxOutput } from './schema.ts';
import { parseSettlement } from './settlement.ts';
import type { DocKind, DocparseHost, ImageOcr, ParseOptions, ParseOutcome, ParseResult, ParseSource, PdfExtract, SheetOutput, WarningCode } from './types.ts';
import { conf } from './util.ts';

/** 종류별로 받는 형식. 그 밖은 wrong_kind(예: 영수증 칸에 엑셀) */
export const ACCEPTS: Record<DocKind, readonly InputFormat[]> = {
  certificate: ['pdf', 'jpeg', 'png'],
  receipt: ['jpeg', 'png', 'pdf'],
  settlement: ['xlsx', 'xls', 'html', 'csv'],
  insurance_notice: ['xlsx', 'xls', 'html', 'csv'],
};

const LOW_OCR = 60;
const MAX_TEXT = 65536;

async function pdfVia(host: DocparseHost, bytes: Uint8Array, opts: { password?: string; ocrPages: number; forceOcr: boolean }): Promise<PdfExtract> {
  const out = validateSandboxOutput('pdf', await host.pdf(bytes, opts));
  if (!out) throw new DocparseError('schema');
  return out;
}

async function imageVia(host: DocparseHost, bytes: Uint8Array, mode: 'document' | 'photo'): Promise<ImageOcr> {
  const out = validateSandboxOutput('image', await host.image(bytes, { mode }));
  if (!out) throw new DocparseError('schema');
  return out;
}

async function sheetVia(host: DocparseHost, bytes: Uint8Array): Promise<SheetOutput> {
  const out = validateSandboxOutput('sheet', await host.sheet(bytes));
  if (!out) throw new DocparseError('schema');
  return out;
}

function baseSource(format: InputFormat): ParseSource {
  return { format, textLayer: null, ocr: false, ocrConfidence: null, pages: null, image: null };
}

function pdfSource(r: PdfExtract, warnings: Set<WarningCode>): ParseSource {
  const ocr = r.ocrConfidence !== null;
  if (ocr) warnings.add('ocr_used');
  if (ocr && r.ocrConfidence! < LOW_OCR) warnings.add('low_ocr_confidence');
  if (r.scanned) warnings.add('scanned_text_layer');
  if (r.totalPages > r.pages) warnings.add('pages_truncated');
  return { format: 'pdf', textLayer: r.hasTextLayer, ocr, ocrConfidence: r.ocrConfidence, pages: r.pages, image: null };
}

function imageSource(format: InputFormat, r: ImageOcr, warnings: Set<WarningCode>): ParseSource {
  warnings.add('ocr_used');
  if (r.confidence < LOW_OCR) warnings.add('low_ocr_confidence');
  if (r.exif) warnings.add('exif_present');
  return { format, textLayer: null, ocr: true, ocrConfidence: Math.round(r.confidence), pages: null, image: { width: r.width, height: r.height } };
}

function certConfidence(m: DocMetaExtract, ocr: number | null): number {
  if (!m.docType) return 0;
  const f = [m.issuedOn, m.validUntil, m.issuer, m.subjectBizNo].map((x) => (x.value !== null || x.reason === 'not_applicable' ? 1 : 0));
  const base = f.reduce<number>((s, x) => s + x, 0) / f.length;
  return conf(base * (m.uncertain.length ? 0.8 : 1) * (ocr === null ? 1 : 0.55 + 0.45 * Math.min(1, ocr / 100)));
}

async function certificate(bytes: Uint8Array, format: InputFormat, host: DocparseHost, o: ParseOptions, warnings: Set<WarningCode>): Promise<{ result: DocMetaExtract; source: ParseSource; text: string; confidence: number }> {
  if (format === 'pdf') {
    let r = await pdfVia(host, bytes, { password: o.password, ocrPages: 2, forceOcr: o.forceOcr === true });
    let meta = extractDocMeta(r.text);
    if (r.ocrConfidence === null && r.hasTextLayer && worthOcr(meta, r.text)) {
      const again = await pdfVia(host, bytes, { password: o.password, ocrPages: 2, forceOcr: true });
      const m2 = extractDocMeta(again.text);
      if (readScore(m2) > readScore(meta)) {
        r = again;
        meta = m2;
      }
    }
    return { result: meta, source: pdfSource(r, warnings), text: r.text, confidence: certConfidence(meta, r.ocrConfidence) };
  }
  const img = await imageVia(host, bytes, 'document');
  const meta = extractDocMeta(img.text);
  return { result: meta, source: imageSource(format, img, warnings), text: img.text, confidence: certConfidence(meta, img.confidence) };
}

/**
 * 공개 인터페이스. bytes는 main이 읽은 파일 내용(경로가 아님), kind는 사장님이 넣은 칸.
 * 실패는 DocparseError 코드로만 끝난다. 성공 결과는 parse-result.schema.json을 통과한 값이다.
 */
export async function parse(bytes: Uint8Array, kind: DocKind, host: DocparseHost, opts: ParseOptions = {}): Promise<ParseOutcome> {
  if (bytes.length === 0 || bytes.length > MAX_INPUT_BYTES) throw new DocparseError('input_size');
  const sniffed = sniffFormat(bytes);
  if (!('format' in sniffed)) throw new DocparseError('unsupported_format', sniffed.rejected);
  const format = sniffed.format;
  if (!ACCEPTS[kind].includes(format)) throw new DocparseError('wrong_kind', format);
  if (format === 'jpeg' || format === 'png') {
    try {
      imageInfo(bytes);
    } catch (e) {
      throw new DocparseError(e instanceof SandboxError ? e.code : 'image_decode_failed');
    }
  }
  const today = opts.today ?? kstToday();
  const warnings = new Set<WarningCode>();
  let result: ParseResult;
  let source: ParseSource;
  let text = '';
  let confidence: number;
  let needsManual: boolean;
  switch (kind) {
    case 'certificate': {
      const c = await certificate(bytes, format, host, opts, warnings);
      ({ result, source, text, confidence } = c);
      needsManual = c.result.docType === null || c.result.issuedOn.value === null;
      break;
    }
    case 'receipt': {
      let input: { text: string; lines?: ImageOcr['lines']; ocrConfidence: number | null };
      if (format === 'pdf') {
        const r = await pdfVia(host, bytes, { password: opts.password, ocrPages: 1, forceOcr: opts.forceOcr === true });
        source = pdfSource(r, warnings);
        input = { text: r.text, ocrConfidence: r.ocrConfidence };
      } else {
        const r = await imageVia(host, bytes, 'photo');
        source = imageSource(format, r, warnings);
        input = { text: r.text, lines: r.lines, ocrConfidence: r.confidence };
      }
      const p = parseReceipt({ ...input, today });
      p.warnings.forEach((w) => warnings.add(w));
      ({ result, confidence } = p);
      text = input.text;
      needsManual = p.result.amount.value === null || p.result.issuedOn.value === null;
      break;
    }
    case 'settlement':
    case 'insurance_notice': {
      const sheet = await sheetVia(host, bytes);
      source = baseSource(format);
      const p = kind === 'settlement' ? parseSettlement(sheet, opts.expectedChannel) : parseInsuranceNotice(sheet);
      p.warnings.forEach((w) => warnings.add(w));
      if (!p.result) throw new DocparseError('format_not_recognized');
      result = p.result;
      confidence = p.confidence;
      needsManual = p.result.rows.length === 0 || ('month' in p.result && p.result.month.value === null);
      break;
    }
  }
  const outcome: ParseOutcome = { schema: 'sax.docparse/v1', kind, result, confidence, warnings: [...warnings], needsManual, source, text: text.slice(0, MAX_TEXT) };
  const ok = validateParseOutcome(outcome);
  if (!ok) throw new DocparseError('schema');
  return ok;
}
