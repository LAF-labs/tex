// 내 사업장(D-03) 사업자 프로필 고치기(사용자 요구 2026-11-10 "내 사업장 정보를 수정할 수도 있어야 한다", 0.1.6 실사용).
// - 칸 검사는 온보딩 O-02와 같다(BIZ_FIELD_MAX 길이, DB 체크섬 isValidBizNo, 이메일 모양 emailOk). 저장은 기존 엔진 profile.upsert(계약 그대로)다.
// - 사업자번호가 바뀌면(또는 프로필이 처음이면) 온보딩처럼 국세청 상태조회를 거친다: 계속사업자면 저장, 휴·폐업이면 막고,
//   조회하지 못하면 사용자가 [맞습니다]를 눌러야 저장한다(같은 번호를 이 편집기가 "조회 못 함"으로 본 뒤에만).
// - 발급 인증·포털 아이디·세션 유지·법인번호는 이 화면에서 고치지 않는다: 있던 값을 그대로 다시 쓴다(인증 바꾸기는 onboarding.reopen auth).
// - 실행 중이면 저장하지 않는다(발급 중 공급자 정보가 바뀌지 않게). 고친 기록(ProfileEditLog)에는 어느 칸을 고쳤는지만 남긴다(값 없음).
import fs from 'node:fs';
import path from 'node:path';
import { isValidBizNo, type Profile as DbProfile } from '@sax/db';
import { BIZ_FIELD_KEYS, BIZ_FIELD_MAX, emailOk, type BizCheck, type BizFields } from './onboarding.ts';

export type BizFieldKey = (typeof BIZ_FIELD_KEYS)[number];
/** 화면 칸 이름(활동 기록의 "어느 칸"). */
export const BIZ_FIELD_LABEL: Record<BizFieldKey, string> = { name: '상호', bizNo: '사업자번호', rep: '대표자', bizType: '업태', bizItem: '종목', address: '주소', email: '이메일' };
/** 번호를 바꿀 때 한 줄 안내(발급 때 엔진 assert.supplier_mismatch가 멈추는 그 검사). */
export const BIZ_NO_CHANGE_NOTE = '사업자번호를 바꾸면 홈택스에 로그인한 사업자와 달라질 수 있어요. 다르면 발급 때 멈추고 알려 드려요.';

const onlyDigits = (s: string) => s.replace(/[^0-9]/g, '');
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

/**
 * 상호가 비었거나 사업자번호를 이름으로 저장한 프로필인가(0.1.6: O-02가 상호 없이 확정되면 displayName = 번호였다).
 * 화면은 번호를 이름처럼 보이지 않고 중립 표기("내 사업장")를 쓰고, 고치기 폼의 상호 칸은 비워 둔다.
 */
export function nameMissing(p: Pick<DbProfile, 'displayName' | 'bizNo'>): boolean {
  const n = p.displayName.trim();
  return !n || (!!p.bizNo && !/[^0-9\s-]/.test(n) && n.replace(/[^0-9]/g, '') === p.bizNo);
}

/** DB 프로필 → 화면 칸. 없으면 빈 칸. 번호로 저장된 상호는 빈 칸(채우라고 묻는다). */
export function bizFieldsOf(p: DbProfile | undefined | null): BizFields {
  return {
    name: p && !nameMissing(p) ? p.displayName : '',
    bizNo: p?.bizNo ?? '',
    rep: p?.repName ?? '',
    bizType: p?.bizType ?? '',
    bizItem: p?.bizItem ?? '',
    address: p?.address ?? '',
    email: p?.email ?? '',
  };
}

/** 폼 값 → 칸(온보딩 biz-confirm [고칠게요]와 같은 자르기·검사). 보내지 않은 칸은 base 그대로. */
export function cleanBizEdit(input: Partial<Record<BizFieldKey, unknown>>, base: BizFields): BizFields {
  const next = { ...base };
  for (const k of BIZ_FIELD_KEYS) if (typeof input[k] === 'string') next[k] = clip(input[k], BIZ_FIELD_MAX[k]);
  next.bizNo = onlyDigits(next.bizNo);
  if (!next.name) throw new Error('name_required');
  if (!isValidBizNo(next.bizNo)) throw new Error('bad_biz_no');
  if (!emailOk(next.email)) throw new Error('bad_email');
  return next;
}

export const changedKeys = (a: BizFields, b: BizFields): BizFieldKey[] => BIZ_FIELD_KEYS.filter((k) => a[k] !== b[k]);

export interface ProfileEditPorts {
  list(): Promise<DbProfile[]>;
  upsert(row: Record<string, unknown>): Promise<DbProfile>;
  /** 국세청 상태조회(온보딩 checkBizNo와 같은 포트). */
  checkBizNo(bizNo: string): Promise<BizCheck>;
  /** 저장한 뒤(온보딩 상태 맞추기·기록·화면 새로 고침). */
  saved(biz: BizFields, changed: BizFieldKey[]): Promise<void>;
}

export type BizEditResult = { ok: true; changed: BizFieldKey[] } | { ok: false; confirm: BizCheck };

export class ProfileEditor {
  private readonly ports: ProfileEditPorts;
  /** 이 편집기가 "조회하지 못함"으로 본 번호. [맞습니다]는 이 번호에만 통한다. */
  private unverified: string | null = null;
  private busy = false;
  constructor(ports: ProfileEditPorts) {
    this.ports = ports;
  }

  /** 지금 사업자 프로필 칸(폼 처음 값). */
  async current(): Promise<BizFields> {
    return bizFieldsOf((await this.ports.list()).find((p) => p.kind === 'business'));
  }

  async save(input: Partial<Record<BizFieldKey, unknown>>, confirmUnverified = false): Promise<BizEditResult> {
    if (this.busy) throw new Error('busy');
    this.busy = true;
    try {
      const cur = (await this.ports.list()).find((p) => p.kind === 'business');
      const base = bizFieldsOf(cur);
      const next = cleanBizEdit(input, base);
      const changed = changedKeys(base, next);
      if (cur && !changed.length) return { ok: true, changed };
      if (!cur || changed.includes('bizNo')) {
        if (!(confirmUnverified && this.unverified === next.bizNo)) {
          const check = await this.ports.checkBizNo(next.bizNo).catch((): BizCheck => ({ status: 'unknown', label: '조회하지 못했어요', taxType: null, source: '국세청 조회' }));
          if (check.status === 'unknown') {
            this.unverified = next.bizNo;
            return { ok: false, confirm: check };
          }
          if (check.status !== 'active') throw new Error('biz_inactive');
        }
      }
      await this.ports.upsert({
        kind: 'business',
        displayName: next.name,
        bizNo: next.bizNo,
        corpNo: cur?.corpNo ?? null,
        repName: next.rep || null,
        bizType: next.bizType || null,
        bizItem: next.bizItem || null,
        address: next.address || null,
        email: next.email || null,
        signMethod: cur?.signMethod ?? null,
        keepSession: cur?.keepSession ?? false,
      });
      this.unverified = null;
      await this.ports.saved(next, changed);
      return { ok: true, changed };
    } finally {
      this.busy = false;
    }
  }
}

/** 고친 기록 한 줄(값 없음: 시각과 고친 칸 이름만). */
export interface ProfileEditEntry {
  at: string;
  kind: 'business';
  fields: BizFieldKey[];
}
export const PROFILE_EDIT_LOG_MAX = 50;

/** 고친 기록 파일(userData/profile-edits.json, 0600). 새것이 뒤, 최근 PROFILE_EDIT_LOG_MAX개. 모양이 틀린 줄은 버린다. */
export class ProfileEditLog {
  private readonly file: string;
  constructor(dir: string) {
    this.file = path.join(dir, 'profile-edits.json');
  }
  list(): ProfileEditEntry[] {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (e): e is ProfileEditEntry =>
          typeof e === 'object' &&
          e !== null &&
          typeof e.at === 'string' &&
          !Number.isNaN(Date.parse(e.at)) &&
          e.kind === 'business' &&
          Array.isArray(e.fields) &&
          e.fields.length > 0 &&
          e.fields.every((f: unknown) => typeof f === 'string' && (BIZ_FIELD_KEYS as readonly string[]).includes(f)),
      )
      .map((e) => ({ at: e.at, kind: e.kind, fields: [...e.fields] }))
      .slice(-PROFILE_EDIT_LOG_MAX);
  }
  add(e: ProfileEditEntry): ProfileEditEntry[] {
    const all = [...this.list(), { at: e.at, kind: e.kind, fields: [...e.fields] }].slice(-PROFILE_EDIT_LOG_MAX);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return all;
  }
}
