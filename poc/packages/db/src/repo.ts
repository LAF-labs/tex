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
  /** 홈택스 아이디 로그인(보안카드 경로)의 아이디. 비밀이 아니라 프로필 정보다(팀장 결정 2026-11-05). 비밀번호·보안카드는 금고만 */
  portalLoginId: string | null;
  /** 홈택스 인증서 창에서 고를 인증서 이름(인증서 소유자 글, 공개 정보). 실행이 사람이 고른 행에서 저장한다(H-01 2.3.0). 비밀 아님 */
  certName: string | null;
  createdAt: string;
  updatedAt: string;
  /** 홈택스 화면에서 채운 칸 중 값이 그대로인 칸(fillFromPortal). 사용자가 고치면 빠진다. */
  fromPortal: PortalProfileKey[];
}

/** 홈택스 화면(공급자 칸)에서 비어 있을 때만 채우는 프로필 칸. */
export const PORTAL_PROFILE_MAX = { displayName: 100, repName: 100, bizType: 100, bizItem: 100, address: 200, email: 320 } as const;
export type PortalProfileKey = keyof typeof PORTAL_PROFILE_MAX;
const PORTAL_PROFILE_COL: Record<PortalProfileKey, string> = { displayName: 'display_name', repName: 'rep_name', bizType: 'biz_type', bizItem: 'biz_item', address: 'address', email: 'email' };
const portalMarksKey = (profileId: string) => `profile.portal_filled.${profileId}`;

/** 상호가 비었거나 사업자번호를 이름으로 저장한 프로필(0.1.6: O-02가 상호 없이 확정되면 displayName = 번호였다). */
export function nameMissing(p: Pick<Profile, 'displayName' | 'bizNo'>): boolean {
  const n = p.displayName.trim();
  return !n || (!!p.bizNo && !/[^0-9\s-]/.test(n) && n.replace(/[^0-9]/g, '') === p.bizNo);
}

/** portalLoginId를 빼면(undefined) 저장된 값을 그대로 둔다(금고 등록 결과로 따로 들어온다) */
export type ProfileInput = Omit<Profile, 'id' | 'createdAt' | 'updatedAt' | 'keepSession' | 'portalLoginId' | 'certName' | 'fromPortal'> & { keepSession?: boolean; portalLoginId?: string | null };

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

/** 거래처 저장 품목(08 §144 "자주 쓰는 품목을 저장한다"). 세금계산서 요청 때 고르는 후보일 뿐 발급 값이 아니다 */
export interface CounterpartyItem {
  name: string;
  /** 원 단위 정수(0 이상). 정하지 않았으면 null */
  unitPrice: number | null;
  /** 예: 개, 식, 시간. 없으면 null */
  unit: string | null;
}

/** 거래처 하나에 저장하는 품목 수 상한 */
export const COUNTERPARTY_ITEMS_MAX = 20;
export const COUNTERPARTY_ITEM_NAME_MAX = 100;
export const COUNTERPARTY_ITEM_UNIT_MAX = 20;
const ITEM_PRICE_MAX = 999_999_999_999;

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

const toProfile = (r: Row): Omit<Profile, 'fromPortal'> => ({
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
  portalLoginId: (r.portal_login_id as string) ?? null,
  certName: (r.cert_name as string) ?? null,
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

/** 포털 아이디: 앞뒤 공백을 뗀 1~64자, 공백·제어 문자 없음. 틀리면 bad_login_id */
export function normalizeLoginId(raw: string): string {
  const id = raw.trim();
  if (!id || id.length > 64 || /[\s\p{Cc}]/u.test(id)) throw new ValidationError('bad_login_id');
  return id;
}

const itemText = (v: unknown, max: number, code: string, required: boolean): string | null => {
  if (v === undefined || v === null || (typeof v === 'string' && !v.trim() && !required)) {
    if (required) throw new ValidationError(code);
    return null;
  }
  if (typeof v !== 'string') throw new ValidationError(code);
  const t = v.trim();
  if (!t || [...t].length > max || /\p{Cc}/u.test(t)) throw new ValidationError(code);
  return t;
};

/** 저장 품목 목록 검사: 배열, 상한 이하, 이름 필수·겹치지 않음, 단가는 0 이상 정수 또는 null. 다른 칸은 버린다 */
export function normalizeCounterpartyItems(raw: unknown): CounterpartyItem[] {
  if (!Array.isArray(raw)) throw new ValidationError('bad_items');
  if (raw.length > COUNTERPARTY_ITEMS_MAX) throw new ValidationError('too_many_items');
  const seen = new Set<string>();
  return raw.map((it) => {
    if (typeof it !== 'object' || it === null || Array.isArray(it)) throw new ValidationError('bad_items');
    const r = it as Record<string, unknown>;
    const name = itemText(r.name, COUNTERPARTY_ITEM_NAME_MAX, 'bad_item_name', true)!;
    if (seen.has(name)) throw new ValidationError('item_name_twice');
    seen.add(name);
    const p = r.unitPrice;
    if (p !== undefined && p !== null && !(Number.isSafeInteger(p) && (p as number) >= 0 && (p as number) <= ITEM_PRICE_MAX)) throw new ValidationError('bad_item_price');
    return { name, unitPrice: (p as number | null | undefined) ?? null, unit: itemText(r.unit, COUNTERPARTY_ITEM_UNIT_MAX, 'bad_item_unit', false) };
  });
}

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
    return this.db.prepare('SELECT * FROM profiles ORDER BY kind').all().map((r) => this.withMarks(r as Row));
  }

  get(id: string): Profile | null {
    const r = this.db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
    return r ? this.withMarks(r as Row) : null;
  }

  byKind(kind: ProfileKind): Profile | null {
    const r = this.db.prepare('SELECT * FROM profiles WHERE kind = ?').get(kind);
    return r ? this.withMarks(r as Row) : null;
  }

  private marks(id: string): Partial<Record<PortalProfileKey, string>> {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(portalMarksKey(id)) as string | undefined;
    try {
      return v ? (JSON.parse(v) as Partial<Record<PortalProfileKey, string>>) : {};
    } catch {
      return {};
    }
  }

  private withMarks(r: Row): Profile {
    const p = toProfile(r);
    const m = this.marks(p.id);
    return { ...p, fromPortal: (Object.keys(PORTAL_PROFILE_COL) as PortalProfileKey[]).filter((k) => m[k] !== undefined && m[k] === p[k]) };
  }

  /**
   * 홈택스 화면의 공급자 값으로 비어 있는 칸만 채운다(상호는 nameMissing일 때). 있는 값은 건드리지 않는다.
   * 채운 칸은 settings에 값과 함께 적어 두고, 값이 그대로인 동안만 fromPortal로 보인다. 채운 칸 키를 돌려준다.
   */
  fillFromPortal(id: string, values: Partial<Record<PortalProfileKey, string>>): PortalProfileKey[] {
    return this.db.transaction(() => {
      const cur = this.get(id);
      if (!cur) throw new ValidationError('profile_not_found');
      const filled: PortalProfileKey[] = [];
      for (const k of Object.keys(PORTAL_PROFILE_COL) as PortalProfileKey[]) {
        const v = values[k]?.replace(/\s+/g, ' ').trim().slice(0, PORTAL_PROFILE_MAX[k]);
        if (!v) continue;
        const empty = k === 'displayName' ? nameMissing(cur) : !cur[k]?.trim();
        if (!empty || (k === 'email' && !EMAIL.test(v))) continue;
        this.db.prepare(`UPDATE profiles SET ${PORTAL_PROFILE_COL[k]} = ?, updated_at = ? WHERE id = ?`).run(v, now(), id);
        filled.push(k);
      }
      if (filled.length) {
        const m = this.marks(id);
        const next = this.get(id)!;
        for (const k of filled) m[k] = next[k] as string;
        this.db
          .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
          .run(portalMarksKey(id), JSON.stringify(m));
      }
      return filled;
    })();
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
      // 고르지 않았으면 공동인증서(대표 지시 2026-11-14: 서비스 기본 발급 인증). 간편인증은 사용자가 고를 때만.
      sign_method: input.signMethod ?? existing?.signMethod ?? 'cert',
      keep_session: input.keepSession ? 1 : 0,
      portal_login_id: input.portalLoginId === undefined ? (existing?.portalLoginId ?? null) : input.portalLoginId === null ? null : normalizeLoginId(input.portalLoginId),
      created_at: existing?.createdAt ?? t,
      updated_at: t,
    };
    this.db
      .prepare(`INSERT INTO profiles (id, kind, display_name, biz_no, corp_no, rep_name, biz_type, biz_item, address, email, sign_method, keep_session, portal_login_id, created_at, updated_at)
        VALUES (@id, @kind, @display_name, @biz_no, @corp_no, @rep_name, @biz_type, @biz_item, @address, @email, @sign_method, @keep_session, @portal_login_id, @created_at, @updated_at)
        ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name, biz_no=excluded.biz_no, corp_no=excluded.corp_no, rep_name=excluded.rep_name,
          biz_type=excluded.biz_type, biz_item=excluded.biz_item, address=excluded.address, email=excluded.email, sign_method=excluded.sign_method,
          keep_session=excluded.keep_session, portal_login_id=excluded.portal_login_id, updated_at=excluded.updated_at`)
      .run(row);
    return this.get(row.id)!;
  }

  /** 금고 등록(T-06) 결과의 포털 아이디만 바꾼다. null이면 지운다. 없는 프로필은 profile_not_found */
  setPortalLoginId(id: string, loginId: string | null): Profile {
    const v = loginId === null ? null : normalizeLoginId(loginId);
    const n = this.db.prepare('UPDATE profiles SET portal_login_id = ?, updated_at = ? WHERE id = ?').run(v, now(), id).changes;
    if (!n) throw new ValidationError('profile_not_found');
    return this.get(id)!;
  }

  /** 인증서 이름만 바꾼다(실행의 pick.remember, 지우기는 null). NFKC·공백 접기, 100자까지. 없는 프로필은 profile_not_found */
  setCertName(id: string, name: string | null): Profile {
    const v = name === null ? null : name.normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 100) || null;
    const n = this.db.prepare('UPDATE profiles SET cert_name = ?, updated_at = ? WHERE id = ?').run(v, now(), id).changes;
    if (!n) throw new ValidationError('profile_not_found');
    return this.get(id)!;
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

  /** 홈택스 화면 값으로 비어 있는 대표자·주소만 채운다. 홈택스가 보인 값이라 진위확인 결과는 그대로 둔다. */
  fillFromPortal(id: string, values: { repName?: string; address?: string }): Array<'repName' | 'address'> {
    const cur = this.get(id);
    if (!cur) throw new ValidationError('not_found');
    const filled: Array<'repName' | 'address'> = [];
    for (const [k, col, max] of [['repName', 'rep_name', 100], ['address', 'address', 200]] as const) {
      const v = values[k]?.replace(/\s+/g, ' ').trim().slice(0, max);
      if (!v || cur[k]?.trim()) continue;
      this.db.prepare(`UPDATE counterparties SET ${col} = ? WHERE id = ?`).run(v, id);
      filled.push(k);
    }
    return filled;
  }

  setVerification(id: string, status: string, at: string = now()): Counterparty {
    if (this.db.prepare('UPDATE counterparties SET verified_status=?, verified_at=? WHERE id=?').run(status, at, id).changes === 0) throw new ValidationError('not_found');
    return this.get(id)!;
  }

  /** 저장 품목(저장 순서). 거래처가 없으면 not_found */
  getItems(id: string): CounterpartyItem[] {
    const r = this.db.prepare('SELECT saved_items_json FROM counterparties WHERE id = ?').get(id) as { saved_items_json: string | null } | undefined;
    if (!r) throw new ValidationError('not_found');
    if (!r.saved_items_json) return [];
    try {
      return normalizeCounterpartyItems(JSON.parse(r.saved_items_json));
    } catch {
      return [];
    }
  }

  /** 저장 품목을 통째로 바꾼다(빈 배열이면 지운다). 검사한 목록을 돌려준다 */
  setItems(id: string, items: unknown): CounterpartyItem[] {
    const list = normalizeCounterpartyItems(items);
    const json = list.length ? JSON.stringify(list) : null;
    if (this.db.prepare('UPDATE counterparties SET saved_items_json = ? WHERE id = ?').run(json, id).changes === 0) throw new ValidationError('not_found');
    return list;
  }

  markUsed(id: string): void {
    this.db.prepare('UPDATE counterparties SET use_count = use_count + 1, last_used_at = ? WHERE id = ?').run(now(), id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM counterparties WHERE id = ?').run(id).changes > 0;
  }
}
