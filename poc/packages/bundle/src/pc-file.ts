import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { BundleRepo, DocumentRepo, ProfileRepo, ReceiptRepo, ValidationError, type BundleEntry, type BundleEntryStatus, type BundleItem, type Db } from '@sax/db';
import { BundleError, monthRange, periodFor } from './items.ts';
import { coversMonth, SettlementInputError, settlementSummary } from './settlement.ts';

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

const MAGIC: Record<string, readonly number[]> = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d],
  jpg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  xlsx: [0x50, 0x4b, 0x03, 0x04],
  docx: [0x50, 0x4b, 0x03, 0x04],
  xls: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  hwp: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
  csv: [],
};
/** 종이 증빙은 사진·PDF만 */
export const RECEIPT_FORMATS = ['jpg', 'png', 'pdf'] as const;
/** 꾸러미 파일 칸 */
export const ATTACH_FORMATS = ['pdf', 'jpg', 'png', 'xlsx', 'xls', 'docx', 'hwp'] as const;
/** 정산내역(docparse 입력 형식과 같다) */
export const SETTLEMENT_FORMATS = ['xlsx', 'csv'] as const;

/**
 * 파일 칸 문서의 doc_type(D07 §2: 서버 색인을 끈 채 고정하는 종류). 정산 품목은 settlement_file, 급여대장 파일 칸은 payroll_ledger,
 * 그 밖(3층 추가 항목 등)은 bundle_file.
 */
export function attachDocType(kind: string): 'settlement_file' | 'payroll_ledger' | 'bundle_file' {
  return kind === 'settlement_delivery' || kind === 'settlement_market' ? 'settlement_file' : kind === 'payroll' ? 'payroll_ledger' : 'bundle_file';
}

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
  if (format === 'csv' && bytes.subarray(0, 4096).includes(0)) return fail('format_mismatch');
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
  const name = v.split(/[\\/]/).pop()!.trim();
  return name || null;
}

export interface PcFileOptions {
  vaultDir: string;
  now?: () => Date;
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
      const run = this.chain.then(() => this.dispatch(method, p ?? {}));
      this.chain = run.catch(() => {});
      return await run;
    } catch (e) {
      if (e instanceof PcFileError) throw e;
      if (e instanceof ValidationError || e instanceof BundleError || e instanceof SettlementInputError) throw new PcFileError(e.code);
      throw e;
    }
  }

  private dispatch(method: string, p: Params): Promise<unknown> {
    switch (method) {
      case 'receipt.pcStore':
        return this.storeReceipt(p);
      case 'bundle.attachFile':
        return this.attach(p);
      case 'settlement.store':
        return this.storeSettlement(p);
      default:
        return Promise.resolve(fail('unknown_method'));
    }
  }

  private profile(v: unknown): string {
    return typeof v === 'string' && v && new ProfileRepo(this.db).get(v) ? v : fail('profile_not_found');
  }

  private sameDoc(profileId: string, docType: string, sha256: string): string | null {
    return (this.db.prepare('SELECT id FROM documents WHERE profile_id = ? AND doc_type = ? AND sha256 = ? ORDER BY created_at LIMIT 1').pluck().get(profileId, docType, sha256) as string | undefined) ?? null;
  }

  private async put<T>(
    profileId: string, docType: string, displayName: string, file: { bytes: Uint8Array; format: string }, link: (docId: string, duplicate: boolean) => T, extraMeta: Record<string, unknown> = {},
  ): Promise<T> {
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    const prev = this.sameDoc(profileId, docType, sha256);
    if (prev) return this.db.transaction(() => link(prev, true))();
    const at = this.now();
    const dest = await this.writeFile(file.bytes, docType, kstDay(at), file.format);
    try {
      return this.db.transaction(() => {
        const id = randomUUID();
        new DocumentRepo(this.db).insert(
          { id, profileId, docType, displayName, issuedAt: null, expiresAt: null, issuer: null, path: dest, bytes: file.bytes.length, sha256, meta: { v: 1, source: 'pc_file', format: file.format, ...extraMeta }, runId: null },
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

  private async storeReceipt(p: Params): Promise<{ docId: string; duplicate: boolean }> {
    const profileId = this.profile(p.profileId);
    const file = fileOf(p.bytes, p.format, RECEIPT_FORMATS);
    const ocr = ocrOf(p.ocr);
    return this.put(profileId, 'paper_receipt', '종이 증빙', file, (docId, duplicate) => {
      const receipts = new ReceiptRepo(this.db);
      if (duplicate && receipts.get(docId)) {
        if (ocr !== null) receipts.setOcr(docId, ocr);
      } else receipts.add({ docId, source: 'pc_file', ocr });
      return { docId, duplicate };
    });
  }

  private async attach(p: Params): Promise<{ docId: string; duplicate: boolean; period: string; entry: BundleEntry }> {
    const { profileId, item, period } = this.slot(p);
    const file = fileOf(p.bytes, p.format, ATTACH_FORMATS);
    const displayName = displayNameOf(p.displayName) ?? item.name;
    return this.put(profileId, attachDocType(item.kind), displayName, file, (docId, duplicate) => ({ docId, duplicate, period, entry: this.link(item, period, docId, 'ready') }));
  }

  private async storeSettlement(p: Params) {
    const { profileId, item, period } = this.slot(p);
    if (item.kind !== 'settlement_delivery' && item.kind !== 'settlement_market') return fail('not_settlement_item');
    const file = fileOf(p.bytes, p.format, SETTLEMENT_FORMATS);
    const summary = settlementSummary(p.parsed, item);
    const displayName = displayNameOf(p.displayName) ?? item.name;
    const { from, to } = monthRange(p.month as string);
    const status: BundleEntryStatus = coversMonth(summary, from, to) ? 'ready' : 'partial';
    return this.put(profileId, 'settlement_file', displayName, file, (docId, duplicate) => ({ docId, duplicate, period, entry: this.link(item, period, docId, status), summary }), { settlement: summary });
  }

  private slot(p: Params): { profileId: string; item: BundleItem; period: string } {
    const profileId = this.profile(p.profileId);
    const item = typeof p.itemId === 'string' && p.itemId.length <= 64 ? new BundleRepo(this.db).item(p.itemId) : null;
    if (!item || item.profileId !== profileId) return fail('item_not_found');
    if (typeof p.month !== 'string') return fail('bad_month');
    const period = periodFor(p.month, item.cadence);
    if (item.kind === 'card' || (item.kind === 'payroll' && this.payrollEnabled(profileId))) return fail('entry_derived');
    return { profileId, item, period };
  }

  private link(item: BundleItem, period: string, docId: string, status: BundleEntryStatus): BundleEntry {
    const repo = new BundleRepo(this.db);
    const cur = repo.entry(item.id, period);
    return repo.setEntry({ itemId: item.id, period, status: cur?.status ?? status, docIds: [...(cur?.docIds ?? []), docId] }, this.now().toISOString());
  }

  private payrollEnabled(profileId: string): boolean {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(`profile.${profileId}.payroll.enabled`) as string | undefined;
    if (v !== undefined) return JSON.parse(v) === true;
    return this.db.prepare('SELECT 1 FROM employees WHERE profile_id = ? LIMIT 1').get(profileId) !== undefined;
  }

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
