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
  scanned: boolean;
  ocrConfidence: number | null;
}

/** 보관함 저장 형식(meta_json). 원문 텍스트는 두지 않는다. */
export interface StoredMeta {
  v: 1;
  extractor: DocMetaExtract['extractor'] | 'run_artifact';
  kind: DetectedKind;
  fields: Pick<DocMetaExtract, 'issuedOn' | 'validUntil' | 'issuer' | 'docNo' | 'subjectBizNo'>;
  expiry: { source: ExpirySource | null; needsUser: boolean; reasons: string[] };
  text: Omit<PdfText, 'text'> & { source: TextSource };
  subjectMismatch: boolean;
  confirmedAt: string | null;
}

/**
 * tax_invoice·vat_tax_base_cert·financial_statements_cert: 앱이 실행에서 발급하고 보관한 서류(importRunArtifact)로만 생긴다. 사용자 가져오기의 종류(DocType)에는 없다.
 * national_tax_cert·biz_registration_cert는 가져오기 종류이면서 민원증명 실행 산출물이기도 하다(앱 발급 여부는 run_id로 가른다).
 */
export type StoredDocType = DocType | 'tax_invoice' | 'vat_tax_base_cert' | 'financial_statements_cert' | 'other';
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
  daysLeft: number | null;
  needsUser: boolean;
  reasons: string[];
  suggested: { issuedOn?: string; validUntil?: string };
  issuer: string | null;
  docNo: string | null;
  subjectBizNo: string | null;
  subjectMismatch: boolean;
  source: 'app' | 'import';
  textSource: TextSource;
  bytes: number;
  createdAt: string;
  runId: string | null;
  duplicate?: boolean;
}

/** 텍스트 층에서 핵심 칸을 못 뽑아 OCR로 다시 읽어 달라는 답. main이 다시 읽고 final로 부른다. */
export interface NeedsOcr {
  needsOcr: true;
}

const DISPLAY: Record<StoredDocType, string> = {
  national_tax_cert: '납세증명서(국세)',
  biz_registration_cert: '사업자등록증명',
  vat_tax_base_cert: '부가가치세 과세표준증명',
  financial_statements_cert: '표준재무제표증명',
  tax_invoice: '전자세금계산서',
  other: '서류',
};
/** 실행 산출물로 보관할 수 있는 종류(save_pdf docType): H-01 세금계산서와 민원증명 4종(H-04·H-03·H-08·H-09). */
export const RUN_ARTIFACT_DOC_TYPES: ReadonlySet<string> = new Set(['tax_invoice', 'national_tax_cert', 'biz_registration_cert', 'vat_tax_base_cert', 'financial_statements_cert']);
const KIND_DISPLAY: Partial<Record<DetectedKind, string>> = { localtax_cert: '지방세 납세증명서', biz_registration: '사업자등록증', closure_cert: '휴업·폐업 사실증명', english_cert: '영문 증명' };
const MAX_PDF = 15 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_ID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const shortId = () => [...randomBytes(4)].map((b) => SHORT_ID[b & 31]).join('');
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

  import(bytes: unknown, extract: unknown, opts: { altText?: unknown; final?: boolean } = {}): Promise<DocumentView | NeedsOcr> {
    const run = this.chain.then(() => this.importNow(bytes, extract, opts));
    this.chain = run.catch(() => {});
    return run;
  }

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
        meta = layer;
        used = pdf.scanned ? 'scan' : 'text';
      }
    }
    const ocrGrade = used !== 'text';
    const docType: StoredDocType = meta.docType ?? 'other';
    const expiry = decideExpiry(meta, today, meta.docType ? this.repo.overrideDays(meta.docType) : null);
    const subject = meta.subjectBizNo.value;
    const subjectMismatch = !!subject && !!business.bizNo && subject !== business.bizNo;
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
      await fs.unlink(file).catch(() => {});
      throw e;
    }
  }

  update(id: string, patch: { docType?: unknown; issuedOn?: unknown; expiresOn?: unknown }, seen?: unknown): DocumentView {
    const row = this.repo.get(id);
    if (!row) throw new ValidationError('not_found');
    const s = (seen ?? null) as Record<string, unknown> | null;
    const dateOrNull = (v: unknown) => v === null || typeof v === 'string';
    if (typeof s !== 'object' || s === null || typeof s.docType !== 'string' || !dateOrNull(s.issuedOn) || !dateOrNull(s.expiresOn)) throw new ValidationError('seen_required');
    if (s.docType !== row.docType || s.issuedOn !== row.issuedAt || s.expiresOn !== row.expiresAt) throw new ValidationError('stale');
    if (row.runId) throw new ValidationError('app_document');
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
    const missing = () => [...(typed && !issuedOn ? ['issued_on_missing'] : []), ...(typed === 'national_tax_cert' && !expiresOn ? ['expires_on_missing'] : [])];
    const carried = (meta.expiry?.reasons ?? []).filter((r) => SUBJECT_REASONS.includes(r));
    const withReasons = (source: ExpirySource | null, reasons: string[]): StoredMeta['expiry'] => ({ source, needsUser: reasons.length > 0, reasons });
    if (expiresChanged) {
      expiresOn = expiresIn;
      expiry = withReasons(expiresOn ? 'user' : null, [...missing(), ...carried]);
    } else if (!typed && typeChanged) {
      expiry = withReasons(row.expiresAt ? (meta.expiry?.source ?? 'user') : null, carried);
    } else if (typeChanged || issuedChanged) {
      const unknown: Field = { value: null, reason: 'not_found' };
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
      const fromOcr = d.source === 'document' || !issuedChanged ? ocrReason(meta.text?.source) : null;
      const unseen = d.expiresOn !== row.expiresAt ? 'expiry_recomputed' : null;
      expiresOn = d.expiresOn;
      expiry = withReasons(d.source, [...d.reasons, ...(fromOcr ? [fromOcr] : []), ...(unseen ? [unseen] : []), ...carried]);
    } else {
      const cur = meta.expiry ?? { source: null, needsUser: false, reasons: [] };
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

  private async writeFile(bytes: Uint8Array, docType: StoredDocType, day: string): Promise<string> {
    const dir = this.vaultDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!this.tmpCleared) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isFile() && e.name.startsWith('.tmp-')) await fs.rm(path.join(dir, e.name), { force: true }).catch(() => {});
      this.tmpCleared = true;
    }
    const tmp = path.join(dir, `.tmp-${randomUUID()}`);
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
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

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
