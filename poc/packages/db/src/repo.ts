import { randomUUID } from 'node:crypto';
import { isValidBizNo, normalizeBizNo } from './bizno.ts';
import type { Db } from './open.ts';

export type ProfileKind = 'personal' | 'business';
export type SignMethod = 'cert' | 'simple_auth' | 'security_card' | null;

export interface Profile {
  id: string;
  kind: ProfileKind;
  displayName: string;
  bizNo: string | null;
  corpNo: string | null;
  repName: string | null;
  bizType: string | null;
  bizItem: string | null;
  address: string | null;
  email: string | null;
  signMethod: SignMethod;
  keepSession: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ProfileInput = Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'keepSession'> & { keepSession?: boolean };

export interface Counterparty {
  id: string;
  bizNo: string;
  name: string;
  repName: string | null;
  address: string | null;
  email: string | null;
  verifiedAt: string | null;
  verifiedStatus: string | null;
  source: 'manual' | 'ocr' | 'hometax';
  lastUsedAt: string | null;
  useCount: number;
  localApprovedAt: string | null;
}

export type CounterpartyInput = Pick<Counterparty, 'bizNo' | 'name'> & Partial<Pick<Counterparty, 'repName' | 'address' | 'email' | 'source'>>;

export class ValidationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

const toProfile = (r: Row): Profile => ({
  id: String(r.id),
  kind: r.kind as ProfileKind,
  displayName: String(r.display_name),
  bizNo: (r.biz_no as string) ?? null,
  corpNo: (r.corp_no as string) ?? null,
  repName: (r.rep_name as string) ?? null,
  bizType: (r.biz_type as string) ?? null,
  bizItem: (r.biz_item as string) ?? null,
  address: (r.address as string) ?? null,
  email: (r.email as string) ?? null,
  signMethod: (r.sign_method as SignMethod) ?? null,
  keepSession: r.keep_session === 1,
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toCounterparty = (r: Row): Counterparty => ({
  id: String(r.id),
  bizNo: String(r.biz_no),
  name: String(r.name),
  repName: (r.rep_name as string) ?? null,
  address: (r.address as string) ?? null,
  email: (r.email as string) ?? null,
  verifiedAt: (r.verified_at as string) ?? null,
  verifiedStatus: (r.verified_status as string) ?? null,
  source: r.source as Counterparty['source'],
  lastUsedAt: (r.last_used_at as string) ?? null,
  useCount: Number(r.use_count),
  localApprovedAt: (r.local_approved_at as string) ?? null,
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function checkEmail(email: string | null | undefined): void {
  if (email && !EMAIL.test(email)) throw new ValidationError('invalid_email');
}

/** 프로필: 개인 1 + 사업자 1(ux_profiles_kind). 비밀 컬럼 없음. */
export class ProfileRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(): Profile[] {
    return this.db.prepare('SELECT * FROM profiles ORDER BY kind').all().map((r) => toProfile(r as Row));
  }

  get(id: string): Profile | null {
    const r = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return r ? toProfile(r as Row) : null;
  }

  byKind(kind: ProfileKind): Profile | null {
    const r = this.db.prepare('SELECT * FROM profiles WHERE kind = ?').get(kind);
    return r ? toProfile(r as Row) : null;
  }

  /** 종류별 1개: 같은 종류가 있으면 갱신, 없으면 만든다. */
  upsert(input: ProfileInput): Profile {
    if (!input.displayName.trim()) throw new ValidationError('display_name_required');
    let bizNo = input.bizNo ? normalizeBizNo(input.bizNo) : null;
    if (input.kind === 'business') {
      if (!bizNo || !isValidBizNo(bizNo)) throw new ValidationError('invalid_biz_no');
    } else {
      bizNo = null; // 개인 프로필에는 사업자번호를 두지 않는다
    }
    checkEmail(input.email);
    const existing = this.byKind(input.kind);
    const t = now();
    const row = {
      id: existing?.id ?? randomUUID(),
      kind: input.kind,
      display_name: input.displayName.trim(),
      biz_no: bizNo,
      corp_no: input.corpNo ? input.corpNo.replace(/\D/g, '') : null,
      rep_name: input.repName ?? null,
      biz_type: input.bizType ?? null,
      biz_item: input.bizItem ?? null,
      address: input.address ?? null,
      email: input.email ?? null,
      sign_method: input.signMethod ?? null,
      keep_session: input.keepSession ? 1 : 0,
      created_at: existing?.createdAt ?? t,
      updated_at: t,
    };
    this.db
      .prepare(`INSERT INTO profiles (id, kind, display_name, biz_no, corp_no, rep_name, biz_type, biz_item, address, email, sign_method, keep_session, created_at, updated_at)
        VALUES (@id, @kind, @display_name, @biz_no, @corp_no, @rep_name, @biz_type, @biz_item, @address, @email, @sign_method, @keep_session, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, biz_no=excluded.biz_no, corp_no=excluded.corp_no, rep_name=excluded.rep_name,
          biz_type=excluded.biz_type, biz_item=excluded.biz_item, address=excluded.address, email=excluded.email, sign_method=excluded.sign_method,
          keep_session=excluded.keep_session, updated_at=excluded.updated_at`)
      .run(row);
    return this.get(row.id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM profiles WHERE id = ?').run(id).changes > 0;
  }
}

export class CounterpartyRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(q?: string): Counterparty[] {
    if (q?.trim()) {
      const like = `%${q.trim()}%`;
      const digits = normalizeBizNo(q);
      return this.db
        .prepare(`SELECT * FROM counterparties WHERE name LIKE ? OR (? <> '' AND biz_no LIKE ?) ORDER BY use_count DESC, name`)
        .all(like, digits, `%${digits}%`)
        .map((r) => toCounterparty(r as Row));
    }
    return this.db.prepare('SELECT * FROM counterparties ORDER BY use_count DESC, name').all().map((r) => toCounterparty(r as Row));
  }

  get(id: string): Counterparty | null {
    const r = this.db.prepare('SELECT * FROM counterparties WHERE id = ?').get(id);
    return r ? toCounterparty(r as Row) : null;
  }

  byBizNo(bizNo: string): Counterparty | null {
    const r = this.db.prepare('SELECT * FROM counterparties WHERE biz_no = ?').get(normalizeBizNo(bizNo));
    return r ? toCounterparty(r as Row) : null;
  }

  create(input: CounterpartyInput): Counterparty {
    const bizNo = normalizeBizNo(input.bizNo);
    if (!isValidBizNo(bizNo)) throw new ValidationError('invalid_biz_no');
    if (!input.name.trim()) throw new ValidationError('name_required');
    checkEmail(input.email);
    if (this.byBizNo(bizNo)) throw new ValidationError('duplicate_biz_no');
    const id = randomUUID();
    this.db
      .prepare(`INSERT INTO counterparties (id, biz_no, name, rep_name, address, email, source) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, bizNo, input.name.trim(), input.repName ?? null, input.address ?? null, input.email ?? null, input.source ?? 'manual');
    return this.get(id)!;
  }

  update(id: string, patch: Partial<Omit<CounterpartyInput, 'bizNo'>>): Counterparty {
    const cur = this.get(id);
    if (!cur) throw new ValidationError('not_found');
    checkEmail(patch.email);
    const next = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    if (!String(next.name).trim()) throw new ValidationError('name_required');
    // 정보가 바뀌면 진위확인 결과를 비운다(다시 확인해야 한다).
    const changed = next.name !== cur.name || next.repName !== cur.repName;
    this.db
      .prepare(`UPDATE counterparties SET name=?, rep_name=?, address=?, email=?, verified_at=?, verified_status=? WHERE id=?`)
      .run(next.name, next.repName ?? null, next.address ?? null, next.email ?? null, changed ? null : cur.verifiedAt, changed ? null : cur.verifiedStatus, id);
    return this.get(id)!;
  }

  setVerification(id: string, status: string, at: string = now()): Counterparty {
    if (this.db.prepare('UPDATE counterparties SET verified_status=?, verified_at=? WHERE id=?').run(status, at, id).changes === 0) throw new ValidationError('not_found');
    return this.get(id)!;
  }

  markUsed(id: string): void {
    this.db.prepare('UPDATE counterparties SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM counterparties WHERE id = ?').run(id).changes > 0;
  }
}
