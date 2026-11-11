// 보관함(D07 §1.3·§4): 엔진이 PDF를 보관함 폴더에 쓰고 DB에 등록한다. main은 사용자가 고른 파일의 바이트와 docparse 추출 텍스트만 넘긴다.
// 파일명에는 PII를 넣지 않는다({docType}_{yyyyMMdd}_{shortId}.pdf). 같은 파일(sha256)은 다시 쓰지 않고 기존 항목을 돌려준다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DocumentRepo, ProfileRepo, ValidationError, type Db, type DocumentRow } from '@sax/db';
import { DOC_TYPES, VALIDITY_RULES, addDays, decideExpiry, daysLeft, extractDocMeta, kstToday, readScore, validateDocMeta, validityCandidate, worthOcr, type DetectedKind, type DocMetaExtract, type DocType, type ExpirySource, type Field } from './docmeta/index.ts';

/** docparse 추출 결과(D17 §3 extract + OCR 폴백 정보). main이 검증한 값이고, 엔진도 모양을 다시 본다. */
export interface PdfText {
  text: string;
  pages: number;
  totalPages: number;
  hasTextLayer: boolean;
  /** 텍스트 층이 보이지 않는 글자(스캐너·복합기 OCR)다 */
  scanned: boolean;
  /** text를 docparse가 OCR로 읽었으면 신뢰도, 아니면 null */
  ocrConfidence: number | null;
}

/** 보관함 저장 형식(meta_json). 원문 텍스트는 두지 않는다. */
export interface StoredMeta {
  v: 1;
  /** run_artifact: 실행이 보관한 발급 결과(글자를 읽지 않았다) */
  extractor: DocMetaExtract['extractor'] | 'run_artifact';
  kind: DetectedKind;
  fields: Pick<DocMetaExtract, 'issuedOn' | 'validUntil' | 'issuer' | 'docNo' | 'subjectBizNo'>;
  expiry: { source: ExpirySource | null; needsUser: boolean; reasons: string[] };
  /** source: 저장한 메타를 어느 글자에서 읽었나(원본 텍스트 층·docparse OCR·스캐너가 덧입힌 층) */
  text: Omit<PdfText, 'text'> & { source: TextSource };
  /** 대상 사업자번호가 내 사업장과 다르다 */
  subjectMismatch: boolean;
  confirmedAt: string | null;
}

/** tax_invoice: 앱이 실행에서 발급하고 보관한 전자세금계산서(importRunArtifact). 사용자 가져오기의 종류(DocType)에는 없다. */
export type StoredDocType = DocType | 'tax_invoice' | 'other';
export type TextSource = 'text' | 'ocr' | 'scan';

/** 렌더러에 주는 보관함 항목. 파일 경로는 주지 않는다. */
export interface DocumentView {
  id: string;
  displayName: string;
  docType: StoredDocType;
  kind: DetectedKind;
  issuedOn: string | null;
  expiresOn: string | null;
  expirySource: ExpirySource | null;
  /** 한국 시간 오늘 기준 남은 날(당일 0, 지나면 음수). 만료일이 없으면 null */
  daysLeft: number | null;
  needsUser: boolean;
  reasons: string[];
  /** 정하지 못한 칸의 후보(확인 화면에 먼저 채운다) */
  suggested: { issuedOn?: string; validUntil?: string };
  issuer: string | null;
  docNo: string | null;
  subjectBizNo: string | null;
  subjectMismatch: boolean;
  source: 'app' | 'import';
  /** text: 원본 텍스트 층, ocr: docparse OCR, scan: 스캐너가 덧입힌 보이지 않는 글자 층 */
  textSource: TextSource;
  bytes: number;
  createdAt: string;
  /** 실행이 보관한 서류(source app)의 실행 id */
  runId: string | null;
  /** 같은 파일이 이미 있어 새로 저장하지 않았다 */
  duplicate?: boolean;
}

/** 텍스트 층에서 핵심 칸을 못 뽑아 OCR로 다시 읽어 달라는 답. main이 다시 읽고 final로 부른다. */
export interface NeedsOcr {
  needsOcr: true;
}

const DISPLAY: Record<StoredDocType, string> = { national_tax_cert: '납세증명서(국세)', biz_registration_cert: '사업자등록증명', tax_invoice: '전자세금계산서', other: '서류' };
/** 실행 산출물로 보관할 수 있는 종류(save_pdf docType). */
export const RUN_ARTIFACT_DOC_TYPES: ReadonlySet<string> = new Set(['tax_invoice']);
const KIND_DISPLAY: Partial<Record<DetectedKind, string>> = { localtax_cert: '지방세 납세증명서', biz_registration: '사업자등록증', closure_cert: '휴업·폐업 사실증명', english_cert: '영문 증명' };
const MAX_PDF = 15 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_ID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const shortId = () => [...randomBytes(4)].map((b) => SHORT_ID[b & 31]).join('');
/** 서류의 대상이 내 사업장인지 확인하지 못한 이유. 사용자가 확인하기 전까지 남는다(수정해도 남고, 확인하면 지운다). */
const SUBJECT_REASONS = ['subject_mismatch', 'subject_unverified'];
const ocrReason = (source: TextSource | undefined) => (source === 'scan' ? 'scanned_text_layer' : source === 'ocr' ? 'read_by_ocr' : null);
const isRealDate = (v: string) => ISO.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function checkPdfText(v: unknown): PdfText {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.text !== 'string' || o.text.length > MAX_TEXT || !Number.isInteger(o.pages) || !Number.isInteger(o.totalPages) || typeof o.hasTextLayer !== 'boolean' || typeof o.scanned !== 'boolean') throw new ValidationError('bad_extract');
  if (o.ocrConfidence !== null && typeof o.ocrConfidence !== 'number') throw new ValidationError('bad_extract');
  return { text: o.text, pages: o.pages as number, totalPages: o.totalPages as number, hasTextLayer: o.hasTextLayer, scanned: o.scanned, ocrConfidence: o.ocrConfidence as number | null };
}

function extractChecked(text: string): DocMetaExtract {
  const meta = validateDocMeta(extractDocMeta(text));
  if (!meta) throw new ValidationError('schema');
  return meta;
}


export class DocumentService {
  readonly repo: DocumentRepo;
  private readonly profiles: ProfileRepo;
  private readonly vaultDir: () => string;
  private readonly now: () => Date;
  private tmpCleared = false;
  /** 가져오기는 한 번에 하나(같은 파일 동시 가져오기·임시 파일 정리 경쟁 방지) */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(db: Db, vaultDir: () => string, now: () => Date = () => new Date()) {
    this.repo = new DocumentRepo(db);
    this.profiles = new ProfileRepo(db);
    this.vaultDir = vaultDir;
    this.now = now;
  }

  list(): DocumentView[] {
    const today = kstToday(this.now());
    return this.repo.list().map((r) => this.view(r, today));
  }

  /**
   * 사용자가 고른 PDF를 보관함에 넣는다. 추출이 덜 됐어도 저장하고 needsUser로 확인을 받는다.
   * 텍스트 층에서 핵심 칸을 못 뽑았으면 저장하지 않고 {needsOcr}를 돌려준다. main이 OCR로 다시 읽어
   * final:true와 처음 텍스트(altText)를 함께 보내면 둘 중 나은 쪽으로 저장한다.
   */
  import(bytes: unknown, extract: unknown, opts: { altText?: unknown; final?: boolean } = {}): Promise<DocumentView | NeedsOcr> {
    const run = this.chain.then(() => this.importNow(bytes, extract, opts));
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * 실행 산출물(save_pdf, D07 §1): 금고가 인쇄해 staging에 둔 발급 결과 PDF를 보관함에 넣는다. 방금 이 앱이 발급한 서류라 종류·발급일(KST 오늘)을 안다.
   * 그래서 글자를 읽지 않는다(엔진은 PDF를 파싱하지 않는다, ADR-014). 확인 필요 없음, 만료일 없음, run_id로 실행과 잇는다(source 'app').
   * 같은 파일(sha256)이 이미 있으면 그 줄을 준다.
   */
  importRunArtifact(bytes: unknown, o: { runId: string; docType: string }): Promise<DocumentView> {
    const run = this.chain.then(() => this.importArtifactNow(bytes, o));
    this.chain = run.catch(() => {});
    return run;
  }

  private async importArtifactNow(bytes: unknown, o: { runId: string; docType: string }): Promise<DocumentView> {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PDF) throw new ValidationError('input_size');
    if (Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new ValidationError('not_pdf');
    if (!RUN_ARTIFACT_DOC_TYPES.has(o.docType)) throw new ValidationError('invalid_doc_type');
    if (typeof o.runId !== 'string' || !o.runId || o.runId.length > 100) throw new ValidationError('bad_run');
    const docType = o.docType as StoredDocType;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const today = kstToday(this.now());
    const existing = this.repo.bySha256(sha256);
    if (existing) return { ...this.view(await this.restoreFile(existing, bytes), today), duplicate: true };
    const business = this.profiles.byKind('business');
    if (!business) throw new ValidationError('profile_required');
    const none: Field = { value: null, reason: 'not_applicable' };
    const stored: StoredMeta = {
      v: 1,
      extractor: 'run_artifact',
      kind: 'unknown',
      fields: { issuedOn: { value: today, reason: null }, validUntil: none, issuer: { value: '국세청 홈택스', reason: null }, docNo: none, subjectBizNo: business.bizNo ? { value: business.bizNo, reason: null } : none },
      expiry: { source: null, needsUser: false, reasons: [] },
      text: { pages: 0, totalPages: 0, hasTextLayer: false, scanned: false, ocrConfidence: null, source: 'text' },
      subjectMismatch: false,
      confirmedAt: today,
    };
    const file = await this.writeFile(bytes, docType, today);
    try {
      const row = this.repo.insert({
        id: randomUUID(), profileId: business.id, docType, displayName: DISPLAY[docType], issuedAt: today, expiresAt: null, issuer: '국세청 홈택스',
        path: file, bytes: bytes.length, sha256, meta: stored as unknown as Record<string, unknown>, runId: o.runId,
      });
      return this.view(row, today);
    } catch (e) {
      await fs.unlink(file).catch(() => {});
      throw e;
    }
  }

  private async importNow(bytes: unknown, extract: unknown, opts: { altText?: unknown; final?: boolean }): Promise<DocumentView | NeedsOcr> {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PDF) throw new ValidationError('input_size');
    if (Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new ValidationError('not_pdf');
    const pdf = checkPdfText(extract);
    if (opts.altText !== undefined && opts.altText !== null && (typeof opts.altText !== 'string' || opts.altText.length > MAX_TEXT)) throw new ValidationError('bad_extract');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const today = kstToday(this.now());
    const existing = this.repo.bySha256(sha256);
    if (existing) return { ...this.view(await this.restoreFile(existing, bytes), today), duplicate: true };
    const business = this.profiles.byKind('business');
    if (!business) throw new ValidationError('profile_required');

    let meta = extractChecked(pdf.text);
    let used: TextSource = pdf.ocrConfidence !== null ? 'ocr' : pdf.scanned ? 'scan' : 'text';
    if (!opts.final && used !== 'ocr' && worthOcr(meta, pdf.text)) return { needsOcr: true };
    if (typeof opts.altText === 'string') {
      const layer = extractChecked(opts.altText);
      if (readScore(layer) >= readScore(meta)) {
        meta = layer; // OCR이 낫지 않으면 처음 텍스트 층 결과를 쓴다
        used = pdf.scanned ? 'scan' : 'text';
      }
    }
    // OCR급 글자(docparse OCR, 스캐너가 덧입힌 층)는 형식이 맞는 오독이 규칙에 걸리지 않는다. 확인 전에는 만료일을 확정하지 않는다.
    const ocrGrade = used !== 'text';
    const docType: StoredDocType = meta.docType ?? 'other';
    const expiry = decideExpiry(meta, today, meta.docType ? this.repo.overrideDays(meta.docType) : null);
    const subject = meta.subjectBizNo.value;
    const subjectMismatch = !!subject && !!business.bizNo && subject !== business.bizNo;
    // 확인 필요 이유: 만료 규칙 + OCR급 글자 + 대상 사업자(다르거나 읽지 못함, D17 §1 4단계 "이 파일이 맞나요?")
    const reasons = [...expiry.reasons, ...(ocrGrade ? [ocrReason(used)!] : []), ...(subjectMismatch ? ['subject_mismatch'] : meta.docType && !subject ? ['subject_unverified'] : [])];
    const stored: StoredMeta = {
      v: 1,
      extractor: meta.extractor,
      kind: meta.kind,
      fields: { issuedOn: meta.issuedOn, validUntil: meta.validUntil, issuer: meta.issuer, docNo: meta.docNo, subjectBizNo: meta.subjectBizNo },
      expiry: { source: expiry.source, needsUser: expiry.needsUser || reasons.length > 0, reasons },
      text: { pages: pdf.pages, totalPages: pdf.totalPages, hasTextLayer: pdf.hasTextLayer, scanned: pdf.scanned, ocrConfidence: used === 'ocr' ? pdf.ocrConfidence : null, source: used },
      subjectMismatch,
      confirmedAt: null,
    };
    const file = await this.writeFile(bytes, docType, meta.issuedOn.value ?? today);
    try {
      const row = this.repo.insert({
        id: randomUUID(),
        profileId: business.id,
        docType,
        displayName: meta.docType ? DISPLAY[docType] : (KIND_DISPLAY[meta.kind] ?? DISPLAY.other),
        issuedAt: meta.issuedOn.value,
        expiresAt: expiry.expiresOn,
        issuer: meta.issuer.value,
        path: file,
        bytes: bytes.length,
        sha256,
        meta: stored as unknown as Record<string, unknown>,
        runId: null,
      });
      return this.view(row, today);
    } catch (e) {
      await fs.unlink(file).catch(() => {}); // 등록 못 한 파일을 남기지 않는다
      throw e;
    }
  }

  /**
   * 사용자 확인·수정. 화면은 바뀐 칸만 보낸다(저장값과 같은 값은 바뀌지 않은 것으로 본다).
   * - 만료일을 바꾸면 그 값(확인함). 납세증명서는 발급일 + 30일을 넘을 수 없다.
   * - 종류·발급일만 바꾸면 만료일을 규칙으로 다시 정한다. 다시 정한 값이 화면에 보였던 값과 다르면(사용자가 본 적 없는 값)
   *   확인 필요로 남기고, OCR급 글자에서 읽은 유효기간을 되살렸으면 그 이유도 남긴다.
   * - 아무것도 바꾸지 않으면 지금 값을 확인한 것(추정 → 확인함, 대상 사업자 확인 포함).
   * 대상 사업자 이유(SUBJECT_REASONS)는 '아무것도 바꾸지 않은 확인'에서만 지운다.
   * seen: 화면이 보여 준 값(종류·발급일·만료일). 저장값과 다르면 stale로 거부한다. 같은 요청을 다시 보내면
   * 두 번째는 '바뀐 칸 없음 = 확인'이 되어 사용자가 본 적 없는 재계산 값이 확인되므로, 확인은 본 값에 대해서만 받는다.
   */
  update(id: string, patch: { docType?: unknown; issuedOn?: unknown; expiresOn?: unknown }, seen?: unknown): DocumentView {
    const row = this.repo.get(id);
    if (!row) throw new ValidationError('not_found');
    const s = (seen ?? null) as Record<string, unknown> | null;
    const dateOrNull = (v: unknown) => v === null || typeof v === 'string';
    if (typeof s !== 'object' || s === null || typeof s.docType !== 'string' || !dateOrNull(s.issuedOn) || !dateOrNull(s.expiresOn)) throw new ValidationError('seen_required');
    if (s.docType !== row.docType || s.issuedOn !== row.issuedAt || s.expiresOn !== row.expiresAt) throw new ValidationError('stale');
    // 앱이 발급해 보관한 서류는 고칠 칸이 없다(종류·발급일은 실행이 정했다).
    if (RUN_ARTIFACT_DOC_TYPES.has(row.docType)) throw new ValidationError('app_document');
    const today = kstToday(this.now());
    const date = (v: unknown, code: string) => {
      if (v === null) return null;
      if (typeof v !== 'string' || !isRealDate(v)) throw new ValidationError(code);
      return v;
    };
    const docType = patch.docType === undefined ? (row.docType as StoredDocType) : patch.docType;
    if (docType !== 'other' && !(DOC_TYPES as readonly unknown[]).includes(docType)) throw new ValidationError('invalid_doc_type');
    const issuedOn = patch.issuedOn === undefined ? row.issuedAt : date(patch.issuedOn, 'invalid_issued_on');
    if (issuedOn && issuedOn > today) throw new ValidationError('issued_in_future');
    const expiresIn = patch.expiresOn === undefined ? undefined : date(patch.expiresOn, 'invalid_expires_on');
    const typeChanged = docType !== row.docType;
    const issuedChanged = issuedOn !== row.issuedAt;
    const expiresChanged = expiresIn !== undefined && expiresIn !== row.expiresAt;
    const meta = (row.meta ?? {}) as unknown as StoredMeta;
    const typed = docType === 'other' ? null : (docType as DocType);
    let expiresOn = row.expiresAt;
    let expiry: StoredMeta['expiry'];
    // 종류를 정한 서류에 발급일이 없거나(만료 경고가 영영 안 뜬다), 납세증명서에 만료일이 없으면 확인을 끝내지 않는다.
    // 사업자등록증명의 만료일은 사용자가 지울 수 있다(법정 유효기간 없음, 2026-11-01 결정).
    const missing = () => [...(typed && !issuedOn ? ['issued_on_missing'] : []), ...(typed === 'national_tax_cert' && !expiresOn ? ['expires_on_missing'] : [])];
    const carried = (meta.expiry?.reasons ?? []).filter((r) => SUBJECT_REASONS.includes(r));
    const withReasons = (source: ExpirySource | null, reasons: string[]): StoredMeta['expiry'] => ({ source, needsUser: reasons.length > 0, reasons });
    if (expiresChanged) {
      expiresOn = expiresIn;
      expiry = withReasons(expiresOn ? 'user' : null, [...missing(), ...carried]);
    } else if (!typed && typeChanged) {
      // 사용자가 '그 밖의 서류'로 고르면 규칙이 없으니 만료일은 그대로 두고 확인한 것으로 본다
      expiry = withReasons(row.expiresAt ? (meta.expiry?.source ?? 'user') : null, carried);
    } else if (typeChanged || issuedChanged) {
      const unknown: Field = { value: null, reason: 'not_found' };
      // 처음에 종류를 몰라 비워 둔 칸(unsupported_doc)은 '못 찾음'으로 다시 본다
      const kept = (f: Field | undefined) => (f && f.reason !== 'unsupported_doc' && f.reason !== 'not_applicable' ? f : unknown);
      const d = decideExpiry(
        {
          extractor: 'docmeta-v1',
          kind: typed ?? meta.kind ?? 'unknown',
          docType: typed,
          issuedOn: issuedOn ? { value: issuedOn, reason: null } : unknown,
          validUntil: typed === 'national_tax_cert' ? kept(meta.fields?.validUntil) : { value: null, reason: 'not_applicable' },
          issuer: kept(meta.fields?.issuer),
          docNo: kept(meta.fields?.docNo),
          subjectBizNo: kept(meta.fields?.subjectBizNo),
          uncertain: [],
          candidates: [],
        },
        today,
        typed ? this.repo.overrideDays(typed) : null,
      );
      // OCR급 글자에서 읽은 값이 남아 있으면(되살린 유효기간, 또는 사용자가 고치지 않은 발급일) 그 이유도 남긴다
      const fromOcr = d.source === 'document' || !issuedChanged ? ocrReason(meta.text?.source) : null;
      const unseen = d.expiresOn !== row.expiresAt ? 'expiry_recomputed' : null;
      expiresOn = d.expiresOn;
      expiry = withReasons(d.source, [...d.reasons, ...(fromOcr ? [fromOcr] : []), ...(unseen ? [unseen] : []), ...carried]);
    } else {
      const cur = meta.expiry ?? { source: null, needsUser: false, reasons: [] };
      // 추정(규칙)이었거나 문서가 유효기간을 하나로 적지 않았던 값(정하지 못한 후보)을 확인하면 확인함
      const decided = cur.source === 'rule' || cur.reasons.some((r) => r.startsWith('valid_until_'));
      expiry = withReasons(decided && cur.source ? 'user' : cur.source, missing());
    }
    if (issuedOn && expiresOn && expiresOn < issuedOn) throw new ValidationError('expires_before_issued');
    if (typed === 'national_tax_cert' && issuedOn && expiresOn && expiresOn > addDays(issuedOn, VALIDITY_RULES.national_tax_cert.days)) throw new ValidationError('expires_after_legal_max');
    const next = this.repo.update(id, {
      docType: docType as string,
      displayName: typeChanged ? DISPLAY[docType as StoredDocType] : row.displayName,
      issuedAt: issuedOn,
      expiresAt: expiresOn,
      meta: { ...meta, expiry, confirmedAt: this.now().toISOString() } as unknown as Record<string, unknown>,
    });
    return this.view(next, today);
  }

  /** 보관함 파일 경로(main이 사용자 기본 뷰어로 열 때만). 렌더러 보기에는 경로를 넣지 않는다. 파일이 없으면 file_missing. */
  async filePath(id: string): Promise<string> {
    const row = this.repo.get(id);
    if (!row) throw new ValidationError('not_found');
    if (!(await fs.access(row.path).then(() => true, () => false))) throw new ValidationError('file_missing');
    return row.path;
  }

  private view(r: DocumentRow, today: string): DocumentView {
    const m = (r.meta ?? {}) as Partial<StoredMeta>;
    const f = m.fields;
    const value = (x: Field | undefined) => x?.value ?? null;
    const suggested: DocumentView['suggested'] = {};
    if (f?.issuedOn?.suggested) suggested.issuedOn = f.issuedOn.suggested;
    // 유효기간 후보는 지금 발급일 이후 것 중 가장 이른 날짜(발급일을 고친 뒤에도 쓸 수 있는 후보를 보여 준다)
    const valid = f?.validUntil ? validityCandidate(f.validUntil, r.issuedAt) : undefined;
    if (valid) suggested.validUntil = valid;
    return {
      id: r.id,
      displayName: r.displayName ?? DISPLAY.other,
      docType: r.docType as StoredDocType,
      kind: m.kind ?? 'unknown',
      issuedOn: r.issuedAt,
      expiresOn: r.expiresAt,
      expirySource: m.expiry?.source ?? null,
      daysLeft: r.expiresAt ? daysLeft(r.expiresAt, today) : null,
      needsUser: m.expiry?.needsUser ?? false,
      reasons: m.expiry?.reasons ?? [],
      suggested,
      issuer: r.issuer,
      docNo: value(f?.docNo),
      subjectBizNo: value(f?.subjectBizNo),
      subjectMismatch: m.subjectMismatch ?? false,
      source: r.runId ? 'app' : 'import',
      runId: r.runId ?? null,
      textSource: m.text?.source ?? 'text',
      bytes: r.bytes,
      createdAt: r.createdAt,
    };
  }

  /** 같은 파일을 다시 넣었는데 보관함 파일이 없어졌으면(사용자가 지움) 다시 써서 잇는다. */
  private async restoreFile(row: DocumentRow, bytes: Uint8Array): Promise<DocumentRow> {
    if (await fs.access(row.path).then(() => true, () => false)) return row;
    const file = await this.writeFile(bytes, row.docType as StoredDocType, row.issuedAt ?? kstToday(this.now()));
    try {
      return this.repo.update(row.id, { path: file });
    } catch (e) {
      await fs.unlink(file).catch(() => {});
      throw e;
    }
  }

  /** 임시 파일 → fsync → 이름 붙이기. 같은 이름이 있으면 덮어쓰지 않고 다른 shortId로 다시 한다. */
  private async writeFile(bytes: Uint8Array, docType: StoredDocType, day: string): Promise<string> {
    const dir = this.vaultDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!this.tmpCleared) {
      // 엔진만 이 폴더에 쓰고 가져오기는 한 번에 하나다. 지난 실행이 남긴 임시 파일은 지운다(못 지워도 가져오기는 막지 않는다).
      for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isFile() && e.name.startsWith('.tmp-')) await fs.rm(path.join(dir, e.name), { force: true }).catch(() => {});
      this.tmpCleared = true;
    }
    const tmp = path.join(dir, `.tmp-${randomUUID()}`);
    // 이름을 붙인 뒤 폴더 항목까지 디스크에 남긴다(POSIX만. Windows는 폴더를 열 수 없어 건너뛴다).
    const syncDir = () => fs.open(dir, 'r').then((h) => h.sync().finally(() => h.close())).catch(() => {});
    try {
      const fh = await fs.open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      for (let i = 0; i < 8; i++) {
        const dest = path.join(dir, `${docType}_${day.replace(/-/g, '')}_${shortId()}.pdf`);
        if (await this.place(tmp, dest)) {
          await syncDir();
          return dest;
        }
      }
      throw new Error('vault_name_exhausted');
    } finally {
      // 이름을 붙인 뒤 임시 파일을 못 지워도(백신 잠금 등) 가져오기는 성공이다. 남은 것은 다음 실행에 지운다.
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  /** 덮어쓰지 않는 이름 붙이기: 하드 링크(있으면 EEXIST). 링크를 못 거는 파일 시스템이면 없는 것을 확인하고 복사(COPYFILE_EXCL). */
  private async place(tmp: string, dest: string): Promise<boolean> {
    try {
      await fs.link(tmp, dest);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'EINVAL') throw e;
    }
    try {
      await fs.copyFile(tmp, dest, fs.constants.COPYFILE_EXCL);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  }
}
