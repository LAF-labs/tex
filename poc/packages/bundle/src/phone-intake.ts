// 폰 사진·현금 수신(데스크톱 ③c 계약, 팀장 결정 2026-11-06). 엔진 main 전용 명령 receipt.phoneHas·receipt.phoneStore·cash.phonePut.
// main은 DB를 열지 않는다. 폰 큐(ReceiveSink)가 엔진 rpc에 얇게 붙고, 중복·고아 방지는 여기서 한다.
// - 중복은 msgId(receipts.phone_msg_id)로만 본다. SHA는 기록만 한다(같은 영수증을 두 번 찍어도 다른 메시지면 둘 다 받는다).
// - 쓰기 전에 msgId를 본다. 없으면 보관함 파일 → 한 트랜잭션(documents + receipts). 실패·경합이면 롤백하고 파일을 지운다.
// - 받기는 한 번에 하나(같은 msgId가 동시에 두 번 와도 파일이 하나만 남게).
// 사진은 사장님이 넣는 신뢰하지 않는 입력이라 여기서는 열지 않는다(JPEG 머리·크기만 본다, OCR·파싱은 docparse 샌드박스 몫).
// 로그를 남기지 않는다(msgId·금액·파일 이름이 섞이지 않게).
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
/** 폰 메시지 id는 ULID다(@sax/remote 스키마 $defs/ulid). 재전송해도 같다 */
const MSG_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const OCR_ENGINES = ['ios_vision', 'android_mlkit', 'none'] as const;
const SHORT_ID = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const shortId = () => [...randomBytes(4)].map((b) => SHORT_ID[b & 31]).join('');
/** 엔진 DocumentService의 '.tmp-' 정리와 섞이지 않게 다른 머리를 쓴다 */
const TMP_PREFIX = '.phone-tmp-';
const kstDay = (d: Date): string => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const isObj = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v);

const msgIdOf = (v: unknown): string => (typeof v === 'string' && MSG_ID.test(v) ? v : fail('bad_msg_id'));
/** 폰 시각(밀리초, @sax/remote 스키마 integer ≥ 0) → ISO UTC */
const msTime = (v: unknown, code: string): string => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) < 8_640_000_000_000 ? new Date(v as number).toISOString() : fail(code));

/** 폰 OCR 결과(후보)는 기록만 한다. 모양이 맞는 작은 값만 받는다 */
interface PhoneOffer {
  capturedAt: string;
  width: number | null;
  height: number | null;
  ocrEngine: string;
  ownerConfirmed: boolean;
  candidates: unknown;
}

function offerOf(v: unknown): PhoneOffer {
  if (!isObj(v)) return fail('bad_offer');
  const dim = (x: unknown) => (x === undefined || x === null ? null : Number.isSafeInteger(x) && (x as number) > 0 && (x as number) <= 20_000 ? (x as number) : fail('bad_offer'));
  if (!(OCR_ENGINES as readonly unknown[]).includes(v.ocrEngine)) return fail('bad_offer');
  if (typeof v.ownerConfirmed !== 'boolean') return fail('bad_offer');
  const candidates = v.candidates === undefined ? null : v.candidates;
  if (candidates !== null && JSON.stringify(candidates).length > 16_384) return fail('bad_offer');
  return { capturedAt: msTime(v.capturedAt, 'bad_offer'), width: dim(v.width), height: dim(v.height), ocrEngine: v.ocrEngine as string, ownerConfirmed: v.ownerConfirmed, candidates };
}

function jpegOf(v: unknown): Uint8Array {
  if (!(v instanceof Uint8Array) || v.length < 4 || v.length > PHONE_JPEG_MAX) return fail('input_size');
  // JPEG SOI(FF D8 FF). 내용은 열지 않는다
  if (v[0] !== 0xff || v[1] !== 0xd8 || v[2] !== 0xff) return fail('not_jpeg');
  return v;
}

export interface PhoneIntakeOptions {
  /** 보관함 폴더(엔진 appPaths().vault) */
  vaultDir: string;
  now?: () => Date;
  /** 시험용: msgId 검사 뒤·파일 쓰기 전에 부른다(그 사이 다른 쪽이 같은 msgId를 넣는 UNIQUE 경합 흉내) */
  afterDuplicateCheck?: (msgId: string) => void;
  /** 시험용: 트랜잭션 안에서 receipts를 넣기 직전에 부른다(트랜잭션 실패 흉내) */
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

  /** 이 msgId로 이미 받은 영수증의 문서 id */
  private existing(msgId: string): string | null {
    return (this.db.prepare('SELECT doc_id FROM receipts WHERE phone_msg_id = ?').pluck().get(msgId) as string | undefined) ?? null;
  }

  /** 폰 사진은 사업자 프로필 증빙이다(꾸러미 1층 종이 증빙) */
  private profileId(): string {
    return new ProfileRepo(this.db).byKind('business')?.id ?? fail('profile_required');
  }

  private async store(p: Params): Promise<{ docId: string; duplicate: boolean }> {
    const msgId = msgIdOf(p.msgId);
    if (typeof p.pairId !== 'string' || !p.pairId || p.pairId.length > 128) return fail('bad_pair_id');
    const jpeg = jpegOf(p.jpeg);
    const offer = offerOf(p.offer);
    // 1. 쓰기 전에 msgId를 본다. 있으면 아무것도 쓰지 않는다
    const prev = this.existing(msgId);
    if (prev) return { docId: prev, duplicate: true };
    const profileId = this.profileId();
    this.opts.afterDuplicateCheck?.(msgId);
    const day = kstDay(new Date(Date.parse(offer.capturedAt)));
    // 2. 보관함 파일 → 한 트랜잭션(documents + receipts)
    const file = await this.writeFile(jpeg, day);
    const docId = randomUUID();
    let result: { docId: string; duplicate: boolean };
    try {
      result = this.db.transaction(() => {
        new DocumentRepo(this.db).insert(
          {
            id: docId, profileId, docType: 'paper_receipt', displayName: '종이 증빙', issuedAt: null, expiresAt: null, issuer: null,
            path: file, bytes: jpeg.length, sha256: createHash('sha256').update(jpeg).digest('hex'),
            meta: { v: 1, source: 'phone_capture', capturedAt: offer.capturedAt, width: offer.width, height: offer.height }, runId: null,
          },
          this.now().toISOString(),
        );
        this.opts.beforeReceiptInsert?.(msgId);
        const added = new ReceiptRepo(this.db).add({
          docId, source: 'phone_capture', phoneMsgId: msgId,
          phoneOcr: { ocrEngine: offer.ocrEngine, ownerConfirmed: offer.ownerConfirmed, candidates: offer.candidates },
        });
        // UNIQUE 경합(그 사이 같은 msgId가 들어옴): 롤백해서 documents 행을 남기지 않는다
        if (!added) throw new DuplicateRace();
        return { docId, duplicate: false };
      })();
    } catch (e) {
      // 3. 실패·경합이면 파일을 지운다(고아 파일·문서 0)
      await fs.unlink(file).catch(() => {});
      if (e instanceof DuplicateRace) return { docId: this.existing(msgId) ?? fail('duplicate_race'), duplicate: true };
      throw e;
    }
    return result;
  }

  /**
   * 폰 현금 매출 하루 숫자. cash_sales에는 msg_id 칸이 없어 enteredAt으로 멱등을 맞춘다:
   * 들어온 enteredAt이 저장값보다 늦을 때만 바꾼다. 같은 메시지를 다시 받으면(같은 enteredAt) 바꾸지 않는다.
   */
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

  /** 임시 파일 → fsync → 덮어쓰지 않는 이름 붙이기(엔진 DocumentService.writeFile과 같은 방식). 이름에 PII 없음 */
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
