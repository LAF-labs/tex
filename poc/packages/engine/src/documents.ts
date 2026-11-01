// 보관함(D07 §1.3·§4): 엔진이 PDF를 보관함 폴더에 쓰고 DB에 등록한다. main은 사용자가 고른 파일의 바이트와 docparse 추출 텍스트만 넘긴다.
// 파일명에는 PII를 넣지 않는다({docType}_{yyyyMMdd}_{shortId}.pdf). 같은 파일(sha256)은 다시 쓰지 않고 기존 항목을 돌려준다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DocumentRepo, ProfileRepo, ValidationError, type Db, type DocumentRow } from '@sax/db';
import { DOC_TYPES, decideExpiry, daysLeft, extractDocMeta, kstToday, validateDocMeta, type DetectedKind, type DocMetaExtract, type DocType, type ExpirySource, type Field } from './docmeta/index.ts';

/** docparse 추출 결과(D17 §3 extract + OCR 폴백 정보). main이 검증한 값이고, 엔진도 모양을 다시 본다. */
export interface PdfText {
  text: string;
  pages: number;
  totalPages: number;
  hasTextLayer: boolean;
  ocrConfidence: number | null;
}

/** 보관함 저장 형식(meta_json). 원문 텍스트는 두지 않는다. */
export interface StoredMeta {
  v: 1;
  extractor: DocMetaExtract['extractor'];
  kind: DetectedKind;
  fields: Pick<DocMetaExtract, 'issuedOn' | 'validUntil' | 'issuer' | 'docNo' | 'subjectBizNo'>;
  expiry: { source: ExpirySource | null; needsUser: boolean; reasons: string[] };
  text: Omit<PdfText, 'text'>;
  /** 대상 사업자번호가 내 사업장과 다르다 */
  subjectMismatch: boolean;
  confirmedAt: string | null;
}

export type StoredDocType = DocType | 'other';

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
  issuer: string | null;
  docNo: string | null;
  subjectBizNo: string | null;
  subjectMismatch: boolean;
  source: 'app' | 'import';
  textSource: 'text' | 'ocr';
  bytes: number;
  createdAt: string;
  /** 같은 파일이 이미 있어 새로 저장하지 않았다 */
  duplicate?: boolean;
}

const DISPLAY: Record<StoredDocType, string> = { national_tax_cert: '납세증명서(국세)', biz_registration_cert: '사업자등록증명', other: '서류' };
const KIND_DISPLAY: Partial<Record<DetectedKind, string>> = { localtax_cert: '지방세 납세증명서', biz_registration: '사업자등록증', closure_cert: '휴업·폐업 사실증명', english_cert: '영문 증명' };
const MAX_PDF = 15 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const SHORT_ID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const shortId = () => [...randomBytes(4)].map((b) => SHORT_ID[b & 31]).join('');
const isRealDate = (v: string) => ISO.test(v) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

function checkPdfText(v: unknown): PdfText {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object' || typeof o.text !== 'string' || o.text.length > MAX_TEXT || !Number.isInteger(o.pages) || !Number.isInteger(o.totalPages) || typeof o.hasTextLayer !== 'boolean') throw new ValidationError('bad_extract');
  if (o.ocrConfidence !== null && typeof o.ocrConfidence !== 'number') throw new ValidationError('bad_extract');
  return { text: o.text, pages: o.pages as number, totalPages: o.totalPages as number, hasTextLayer: o.hasTextLayer, ocrConfidence: o.ocrConfidence as number | null };
}

export class DocumentService {
  readonly repo: DocumentRepo;
  private readonly profiles: ProfileRepo;
  private readonly vaultDir: () => string;
  private readonly now: () => Date;
  private tmpCleared = false;

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

  /** 사용자가 고른 PDF를 보관함에 넣는다. 추출이 덜 됐어도 저장하고 needsUser로 확인을 받는다. */
  async import(bytes: unknown, extract: unknown): Promise<DocumentView> {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_PDF) throw new ValidationError('input_size');
    if (Buffer.from(bytes.subarray(0, 1024)).indexOf('%PDF-') < 0) throw new ValidationError('not_pdf');
    const pdf = checkPdfText(extract);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const today = kstToday(this.now());
    const existing = this.repo.bySha256(sha256);
    if (existing) return { ...this.view(existing, today), duplicate: true };
    const business = this.profiles.byKind('business');
    if (!business) throw new ValidationError('profile_required');

    const meta = validateDocMeta(extractDocMeta(pdf.text));
    if (!meta) throw new ValidationError('schema');
    const docType: StoredDocType = meta.docType ?? 'other';
    const expiry = decideExpiry(meta, today, meta.docType ? this.repo.overrideDays(meta.docType) : null);
    const subject = meta.subjectBizNo.value;
    const stored: StoredMeta = {
      v: 1,
      extractor: meta.extractor,
      kind: meta.kind,
      fields: { issuedOn: meta.issuedOn, validUntil: meta.validUntil, issuer: meta.issuer, docNo: meta.docNo, subjectBizNo: meta.subjectBizNo },
      // OCR로 읽은 날짜는 틀려도 형식이 맞아 걸러지지 않는다. 확인을 받기 전에는 만료일을 확정하지 않는다.
      expiry: pdf.hasTextLayer ? { source: expiry.source, needsUser: expiry.needsUser, reasons: expiry.reasons } : { source: expiry.source, needsUser: true, reasons: [...expiry.reasons, 'read_by_ocr'] },
      text: { pages: pdf.pages, totalPages: pdf.totalPages, hasTextLayer: pdf.hasTextLayer, ocrConfidence: pdf.ocrConfidence },
      subjectMismatch: !!subject && !!business.bizNo && subject !== business.bizNo,
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

  /** 사용자 확인·수정. 날짜를 주면 그 값(확인함), 종류·발급일만 바꾸면 만료일을 규칙으로 다시 정한다. 무엇이든 부르면 확인한 것으로 본다. */
  update(id: string, patch: { docType?: unknown; issuedOn?: unknown; expiresOn?: unknown }): DocumentView {
    const row = this.repo.get(id);
    if (!row) throw new ValidationError('not_found');
    const date = (v: unknown, code: string) => {
      if (v === null) return null;
      if (typeof v !== 'string' || !isRealDate(v)) throw new ValidationError(code);
      return v;
    };
    const docType = patch.docType === undefined ? (row.docType as StoredDocType) : patch.docType;
    if (docType !== 'other' && !(DOC_TYPES as readonly unknown[]).includes(docType)) throw new ValidationError('invalid_doc_type');
    const issuedOn = patch.issuedOn === undefined ? row.issuedAt : date(patch.issuedOn, 'invalid_issued_on');
    const meta = (row.meta ?? {}) as unknown as StoredMeta;
    const today = kstToday(this.now());
    let expiresOn = row.expiresAt;
    let expiry = meta.expiry ?? { source: null, needsUser: false, reasons: [] };
    if (patch.expiresOn !== undefined) {
      expiresOn = date(patch.expiresOn, 'invalid_expires_on');
      expiry = { source: expiresOn ? 'user' : null, needsUser: false, reasons: [] };
    } else if (patch.docType !== undefined || patch.issuedOn !== undefined) {
      const typed = docType === 'other' ? null : (docType as DocType);
      const unknown: Field = { value: null, reason: 'not_found' };
      const d = decideExpiry(
        {
          extractor: 'docmeta-v1',
          kind: meta.kind ?? 'unknown',
          docType: typed,
          issuedOn: issuedOn ? { value: issuedOn, reason: null } : unknown,
          validUntil: meta.fields?.validUntil ?? unknown,
          issuer: meta.fields?.issuer ?? unknown,
          docNo: meta.fields?.docNo ?? unknown,
          subjectBizNo: meta.fields?.subjectBizNo ?? unknown,
          candidates: [],
        },
        today,
        typed ? this.repo.overrideDays(typed) : null,
      );
      expiresOn = d.expiresOn;
      expiry = { source: d.source, needsUser: false, reasons: d.reasons };
    } else {
      expiry = { source: expiry.source === 'rule' ? 'user' : expiry.source, needsUser: false, reasons: [] };
    }
    if (issuedOn && expiresOn && expiresOn < issuedOn) throw new ValidationError('expires_before_issued');
    const next = this.repo.update(id, {
      docType: docType as string,
      displayName: docType === row.docType ? row.displayName : DISPLAY[docType as StoredDocType],
      issuedAt: issuedOn,
      expiresAt: expiresOn,
      meta: { ...meta, expiry, confirmedAt: this.now().toISOString() } as unknown as Record<string, unknown>,
    });
    return this.view(next, today);
  }

  private view(r: DocumentRow, today: string): DocumentView {
    const m = (r.meta ?? {}) as Partial<StoredMeta>;
    const f = m.fields;
    const value = (x: Field | undefined) => x?.value ?? null;
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
      issuer: r.issuer,
      docNo: value(f?.docNo),
      subjectBizNo: value(f?.subjectBizNo),
      subjectMismatch: m.subjectMismatch ?? false,
      source: r.runId ? 'app' : 'import',
      textSource: m.text?.hasTextLayer === false && m.text.ocrConfidence !== null ? 'ocr' : 'text',
      bytes: r.bytes,
      createdAt: r.createdAt,
    };
  }

  /** 임시 파일 → fsync → 이름 붙이기. 같은 이름이 있으면 덮어쓰지 않고 다른 shortId로 다시 한다. */
  private async writeFile(bytes: Uint8Array, docType: StoredDocType, day: string): Promise<string> {
    const dir = this.vaultDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!this.tmpCleared) {
      // 엔진만 이 폴더에 쓴다. 지난 실행이 남긴 임시 파일은 지운다.
      for (const n of await fs.readdir(dir)) if (n.startsWith('.tmp-')) await fs.rm(path.join(dir, n), { force: true });
      this.tmpCleared = true;
    }
    const tmp = path.join(dir, `.tmp-${randomUUID()}`);
    const fh = await fs.open(tmp, 'wx', 0o600);
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    try {
      for (let i = 0; i < 8; i++) {
        const dest = path.join(dir, `${docType}_${day.replace(/-/g, '')}_${shortId()}.pdf`);
        if (await this.place(tmp, dest)) return dest;
      }
      throw new Error('vault_name_exhausted');
    } finally {
      await fs.rm(tmp, { force: true });
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
