// PC 파일을 보관함에 넣는다(08 D-05, D14 M6-2·M6-4): 종이 증빙 사진·PDF(receipt.pcStore), 꾸러미 항목 파일 칸(bundle.attachFile).
// 사장님이 넣는 파일은 신뢰하지 않는 입력이라 여기서는 열지 않는다. 머리 바이트가 말한 형식과 맞는지와 크기만 본다(내용 읽기·OCR은 docparse 샌드박스 몫).
// main이 샌드박스에서 받은 읽기 결과(ocr)는 후보로 기록만 한다. 사장님이 receipt.confirm으로 확인한 값만 대조·내보내기에 쓴다.
// 보관함 파일 이름에는 PII를 넣지 않는다({종류}_{yyyyMMdd}_{shortId}.{ext}). 원래 파일 이름은 쓰지 않는다(displayName은 DB에만, 선택).
// 쓰기 순서는 폰 수신(PhoneIntake)과 같다: 보관함 파일 → 한 트랜잭션(documents + receipts|bundle_entries). 실패하면 롤백하고 파일을 지운다(고아 0).
// 같은 파일(sha256)을 같은 프로필에 다시 넣으면 새로 쓰지 않고 있던 문서를 쓴다. 모델·네트워크·로그를 쓰지 않는다.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BundleRepo, DocumentRepo, ProfileRepo, ReceiptRepo, ValidationError, type BundleEntry, type Db } from '@sax/db';
import { BundleError, periodFor } from './items.ts';

export class PcFileError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new PcFileError(code);
};

type Params = Record<string, unknown>;

/** PC 파일 상한(docparse 입력 상한 MAX_INPUT_BYTES와 같다) */
export const PC_FILE_MAX = 15 * 1024 * 1024;
/** 읽기 결과(후보) JSON 상한 */
export const PC_OCR_MAX = 16_384;
export const PC_DISPLAY_NAME_MAX = 100;

/** 형식 → 머리 바이트. main이 파일 확장자로 형식을 말하고, 엔진은 머리가 맞는지만 본다 */
const MAGIC: Record<string, readonly number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  xlsx: [0x50, 0x4b, 0x03, 0x04], // ZIP(OOXML)
  docx: [0x50, 0x4b, 0x03, 0x04],
  xls: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], // OLE(xls·hwp)
  hwp: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
};
/** 종이 증빙은 사진·PDF만 */
export const RECEIPT_FORMATS = ['jpg', 'png', 'pdf'] as const;
/** 꾸러미 파일 칸 */
export const ATTACH_FORMATS = ['pdf', 'jpg', 'png', 'xlsx', 'xls', 'docx', 'hwp'] as const;

const SHORT_ID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const shortId = () => [...randomBytes(4)].map((b) => SHORT_ID[b & 31]).join('');
const TMP_PREFIX = '.pc-tmp-';
const kstDay = (d: Date): string => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const isObj = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v);

function fileOf(bytes: unknown, format: unknown, allowed: readonly string[]): { bytes: Uint8Array; format: string } {
  if (typeof format !== 'string' || !allowed.includes(format)) return fail('bad_format');
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > PC_FILE_MAX) return fail('input_size');
  const magic = MAGIC[format]!;
  if (bytes.length < magic.length || magic.some((b, i) => bytes[i] !== b)) return fail('format_mismatch');
  return { bytes, format };
}

function ocrOf(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (!isObj(v) || JSON.stringify(v).length > PC_OCR_MAX) return fail('bad_ocr');
  return v;
}

function displayNameOf(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || v.length > PC_DISPLAY_NAME_MAX) return fail('bad_display_name');
  // 경로 조각은 남기지 않는다(이름만)
  const name = v.split(/[\\/]/).pop()!.trim();
  return name || null;
}

export interface PcFileOptions {
  /** 보관함 폴더(엔진 appPaths().vault) */
  vaultDir: string;
  now?: () => Date;
  /** 시험용: 트랜잭션 안에서 문서를 넣은 뒤 부른다(트랜잭션 실패 흉내) */
  beforeLink?: () => void;
}

export class PcFileIntake {
  private readonly db: Db;
  private readonly opts: PcFileOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private tmpCleared = false;

  constructor(db: Db, opts: PcFileOptions) {
    this.db = db;
    this.opts = opts;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async handle(method: string, p: Params): Promise<unknown> {
    try {
      // 한 번에 하나(같은 파일을 두 번 동시에 넣어도 보관함에 하나만 남게)
      const run = this.chain.then(() => this.dispatch(method, p ?? {}));
      this.chain = run.catch(() => {});
      return await run;
    } catch (e) {
      if (e instanceof PcFileError) throw e;
      if (e instanceof ValidationError || e instanceof BundleError) throw new PcFileError(e.code);
      throw e;
    }
  }

  private dispatch(method: string, p: Params): Promise<unknown> {
    switch (method) {
      case 'receipt.pcStore':
        return this.storeReceipt(p);
      case 'bundle.attachFile':
        return this.attach(p);
      default:
        return Promise.resolve(fail('unknown_method'));
    }
  }

  private profile(v: unknown): string {
    return typeof v === 'string' && v && new ProfileRepo(this.db).get(v) ? v : fail('profile_not_found');
  }

  /** 같은 프로필·같은 종류에 같은 내용(sha256)이 있으면 그 문서 id */
  private sameDoc(profileId: string, docType: string, sha256: string): string | null {
    return (this.db.prepare('SELECT id FROM documents WHERE profile_id = ? AND doc_type = ? AND sha256 = ? ORDER BY created_at LIMIT 1').pluck().get(profileId, docType, sha256) as string | undefined) ?? null;
  }

  /**
   * 파일을 쓰고 한 트랜잭션에서 문서 행과 link(receipts·bundle_entries)를 넣는다. 같은 내용이 있으면 파일을 쓰지 않고 link만 한다.
   * 실패하면 롤백하고 새로 쓴 파일을 지운다.
   */
  private async put<T>(profileId: string, docType: string, displayName: string, file: { bytes: Uint8Array; format: string }, link: (docId: string, duplicate: boolean) => T): Promise<T> {
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    const prev = this.sameDoc(profileId, docType, sha256);
    if (prev) return this.db.transaction(() => link(prev, true))();
    const at = this.now();
    const dest = await this.writeFile(file.bytes, docType, kstDay(at), file.format);
    try {
      return this.db.transaction(() => {
        const id = randomUUID();
        new DocumentRepo(this.db).insert(
          { id, profileId, docType, displayName, issuedAt: null, expiresAt: null, issuer: null, path: dest, bytes: file.bytes.length, sha256, meta: { v: 1, source: 'pc_file', format: file.format }, runId: null },
          at.toISOString(),
        );
        this.opts.beforeLink?.();
        return link(id, false);
      })();
    } catch (e) {
      await fs.unlink(dest).catch(() => {});
      throw e;
    }
  }

  /** receipt.pcStore {profileId, bytes, format: jpg|png|pdf, ocr?} → {docId, duplicate} */
  private async storeReceipt(p: Params): Promise<{ docId: string; duplicate: boolean }> {
    const profileId = this.profile(p.profileId);
    const file = fileOf(p.bytes, p.format, RECEIPT_FORMATS);
    const ocr = ocrOf(p.ocr);
    return this.put(profileId, 'paper_receipt', '종이 증빙', file, (docId, duplicate) => {
      const receipts = new ReceiptRepo(this.db);
      // 같은 파일을 다시 넣으면 읽기 후보만 새로(확인한 값은 그대로)
      if (duplicate && receipts.get(docId)) {
        if (ocr !== null) receipts.setOcr(docId, ocr);
      } else receipts.add({ docId, source: 'pc_file', ocr });
      return { docId, duplicate };
    });
  }

  /**
   * bundle.attachFile {profileId, itemId, month, bytes, format, displayName?} → {docId, duplicate, period, entry}.
   * 그달(항목 주기의 기간) 표시에 문서를 더한다. 표시가 없었으면 '다 됨'(ready)으로, 있었으면 상태는 그대로 둔다.
   * 앱이 기록에서 세는 항목(사업용 카드, 급여를 쓰는 업체의 급여대장)에는 붙이지 않는다(entry_derived).
   */
  private async attach(p: Params): Promise<{ docId: string; duplicate: boolean; period: string; entry: BundleEntry }> {
    const profileId = this.profile(p.profileId);
    const repo = new BundleRepo(this.db);
    const item = typeof p.itemId === 'string' && p.itemId.length <= 64 ? repo.item(p.itemId) : null;
    if (!item || item.profileId !== profileId) return fail('item_not_found');
    if (typeof p.month !== 'string') return fail('bad_month');
    const period = periodFor(p.month, item.cadence);
    if (item.kind === 'card' || (item.kind === 'payroll' && this.payrollEnabled(profileId))) return fail('entry_derived');
    const file = fileOf(p.bytes, p.format, ATTACH_FORMATS);
    const displayName = displayNameOf(p.displayName) ?? item.name;
    return this.put(profileId, 'bundle_file', displayName, file, (docId, duplicate) => {
      const cur = repo.entry(item.id, period);
      const docIds = [...(cur?.docIds ?? []), docId];
      const entry = repo.setEntry({ itemId: item.id, period, status: cur?.status ?? 'ready', docIds }, this.now().toISOString());
      return { docId, duplicate, period, entry };
    });
  }

  /** BundleService.payrollEnabled와 같은 규칙: 설정이 있으면 그것, 없으면 직원이 한 명이라도 있는가 */
  private payrollEnabled(profileId: string): boolean {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(`profile.${profileId}.payroll.enabled`) as string | undefined;
    if (v !== undefined) return JSON.parse(v) === true;
    return this.db.prepare('SELECT 1 FROM employees WHERE profile_id = ? LIMIT 1').get(profileId) !== undefined;
  }

  /** 임시 파일 → fsync → 덮어쓰지 않는 이름 붙이기(PhoneIntake·엔진 DocumentService와 같은 방식). 이름에 PII 없음 */
  private async writeFile(bytes: Uint8Array, docType: string, day: string, ext: string): Promise<string> {
    const dir = this.opts.vaultDir;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    if (!this.tmpCleared) {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) if (e.isFile() && e.name.startsWith(TMP_PREFIX)) await fs.rm(path.join(dir, e.name), { force: true }).catch(() => {});
      this.tmpCleared = true;
    }
    const tmp = path.join(dir, `${TMP_PREFIX}${randomUUID()}`);
    try {
      const fh = await fs.open(tmp, 'wx', 0o600);
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      for (let i = 0; i < 8; i++) {
        const dest = path.join(dir, `${docType}_${day.replace(/-/g, '')}_${shortId()}.${ext}`);
        if (await place(tmp, dest)) {
          await fs.open(dir, 'r').then((h) => h.sync().finally(() => h.close())).catch(() => {});
          return dest;
        }
      }
      return fail('vault_name_exhausted');
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
}

async function place(tmp: string, dest: string): Promise<boolean> {
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
