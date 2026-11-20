import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CashSalesRepo, DocumentRepo, ProfileRepo, ReceiptRepo, ValidationError, type Db } from '@sax/db';

export class PhoneIntakeError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new PhoneIntakeError(code);
};

type Params = Record<string, unknown>;

/** 폰 사진 상한(계약 ≤ 4 MiB) */
export const PHONE_JPEG_MAX = 4 * 1024 * 1024;
const MSG_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const OCR_ENGINES = ['ios_vision', 'android_mlkit', 'none'] as const;
const SHORT_ID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const shortId = () => [...randomBytes(4)].map((b) => SHORT_ID[b & 31]).join('');
const TMP_PREFIX = '.phone-tmp-';
const kstDay = (d: Date): string => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const isObj = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v);

const msgIdOf = (v: unknown): string => (typeof v === 'string' && MSG_ID.test(v) ? v : fail('bad_msg_id'));
const msTime = (v: unknown, code: string): string => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < 8_640_000_000_000 ? new Date(v as number).toISOString() : fail(code));

interface PhoneOffer {
  capturedAt: string;
  width: number | null;
  height: number | null;
  ocrEngine: string;
  ownerConfirmed: boolean;
  candidates: unknown;
  paperInvoice: unknown;
  paperIssues: string[] | null;
}

function offerOf(v: unknown): PhoneOffer {
  if (!isObj(v)) return fail('bad_offer');
  const dim = (x: unknown) => (x === undefined || x === null ? null : Number.isSafeInteger(x) && (x as number) > 0 && (x as number) <= 20_000 ? (x as number) : fail('bad_offer'));
  if (!(OCR_ENGINES as readonly unknown[]).includes(v.ocrEngine)) return fail('bad_offer');
  if (typeof v.ownerConfirmed !== 'boolean') return fail('bad_offer');
  const candidates = v.candidates === undefined ? null : v.candidates;
  if (candidates !== null && JSON.stringify(candidates).length > 16_384) return fail('bad_offer');
  const paperInvoice = v.paperInvoice === undefined ? null : v.paperInvoice;
  if (paperInvoice !== null && (!isObj(paperInvoice) || JSON.stringify(paperInvoice).length > 16_384)) return fail('bad_offer');
  const issues = v.paperIssues === undefined ? null : v.paperIssues;
  if (issues !== null && !(Array.isArray(issues) && issues.length <= 40 && issues.every((x) => typeof x === 'string' && /^[A-Za-z.]{1,40}$/.test(x)))) return fail('bad_offer');
  return { capturedAt: msTime(v.capturedAt, 'bad_offer'), width: dim(v.width), height: dim(v.height), ocrEngine: v.ocrEngine as string, ownerConfirmed: v.ownerConfirmed, candidates, paperInvoice, paperIssues: issues as string[] | null };
}

function jpegOf(v: unknown): Uint8Array {
  if (!(v instanceof Uint8Array) || v.length < 4 || v.length > PHONE_JPEG_MAX) return fail('input_size');
  if (v[0] !== 0xff || v[1] !== 0xd8 || v[2] !== 0xff) return fail('not_jpeg');
  return v;
}

export interface PhoneIntakeOptions {
  vaultDir: string;
  now?: () => Date;
  afterDuplicateCheck?: (msgId: string) => void;
  beforeReceiptInsert?: (msgId: string) => void;
}

export class PhoneIntake {
  private readonly db: Db;
  private readonly opts: PhoneIntakeOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private tmpCleared = false;

  constructor(db: Db, opts: PhoneIntakeOptions) {
    this.db = db;
    this.opts = opts;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  async handle(method: string, p: Params): Promise<unknown> {
    try {
      switch (method) {
        case 'receipt.phoneHas':
          return { has: this.existing(msgIdOf(p?.msgId)) !== null };
        case 'receipt.phoneStore': {
          const run = this.chain.then(() => this.store(p ?? {}));
          this.chain = run.catch(() => {});
          return await run;
        }
        case 'cash.phonePut':
          return this.cashPut(p ?? {});
        default:
          return fail('unknown_method');
      }
    } catch (e) {
      if (e instanceof PhoneIntakeError) throw e;
      if (e instanceof ValidationError) throw new PhoneIntakeError(e.code);
      throw e;
    }
  }

  private existing(msgId: string): string | null {
    return (this.db.prepare('SELECT doc_id FROM receipts WHERE phone_msg_id = ?').pluck().get(msgId) as string | undefined) ?? null;
  }

  private profileId(): string {
    return new ProfileRepo(this.db).byKind('business')?.id ?? fail('profile_required');
  }

  private async store(p: Params): Promise<{ docId: string; duplicate: boolean }> {
    const msgId = msgIdOf(p.msgId);
    if (typeof p.pairId !== 'string' || !p.pairId || p.pairId.length > 128) return fail('bad_pair_id');
    const jpeg = jpegOf(p.jpeg);
    const offer = offerOf(p.offer);
    const prev = this.existing(msgId);
    if (prev) return { docId: prev, duplicate: true };
    const profileId = this.profileId();
    this.opts.afterDuplicateCheck?.(msgId);
    const day = kstDay(new Date(Date.parse(offer.capturedAt)));
    const file = await this.writeFile(jpeg, day);
    const docId = randomUUID();
    let result: { docId: string; duplicate: boolean };
    try {
      result = this.db.transaction(() => {
        new DocumentRepo(this.db).insert(
          {
            id: docId, profileId, docType: 'paper_receipt', displayName: offer.paperInvoice ? '종이 세금계산서' : '종이 증빙', issuedAt: null, expiresAt: null, issuer: null,
            path: file, bytes: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex'),
            meta: { v: 1, source: 'phone_capture', capturedAt: offer.capturedAt, width: offer.width, height: offer.height }, runId: null,
          },
          this.now().toISOString(),
        );
        this.opts.beforeReceiptInsert?.(msgId);
        const added = new ReceiptRepo(this.db).add({
          docId, source: 'phone_capture', phoneMsgId: msgId,
          phoneOcr: {
            ocrEngine: offer.ocrEngine, ownerConfirmed: offer.ownerConfirmed, candidates: offer.candidates,
            ...(offer.paperInvoice ? { paperInvoice: offer.paperInvoice, paperIssues: offer.paperIssues ?? [] } : {}),
          },
        });
        if (!added) throw new DuplicateRace();
        return { docId, duplicate: false };
      })();
    } catch (e) {
      await fs.unlink(file).catch(() => {});
      if (e instanceof DuplicateRace) return { docId: this.existing(msgId) ?? fail('duplicate_race'), duplicate: true };
      throw e;
    }
    return result;
  }

  private cashPut(p: Params): { applied: boolean } {
    msgIdOf(p.msgId);
    const day = typeof p.day === 'string' && DAY.test(p.day) ? p.day : fail('bad_day');
    const amount = Number.isSafeInteger(p.amount) && (p.amount as number) >= 0 ? (p.amount as number) : fail('bad_amount');
    const enteredAt = msTime(p.enteredAt, 'bad_entered_at');
    const profileId = this.profileId();
    const repo = new CashSalesRepo(this.db);
    return this.db.transaction(() => {
      const cur = repo.get(profileId, day);
      if (cur && Date.parse(cur.enteredAt) >= Date.parse(enteredAt)) return { applied: false };
      repo.put({ profileId, day, amount, source: 'phone' }, enteredAt);
      return { applied: true };
    })();
  }

  private async writeFile(bytes: Uint8Array, day: string): Promise<string> {
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
        const dest = path.join(dir, `paper_receipt_${day.replace(/-/g, '')}_${shortId()}.jpg`);
        if (await place(tmp, dest)) {
          await fs.open(dir, 'r').then((h) => h.sync().finally(() => h.close())).catch(() => {});
          return dest;
        }
      }
      throw new PhoneIntakeError('vault_name_exhausted');
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }
}

class DuplicateRace extends Error {}

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
