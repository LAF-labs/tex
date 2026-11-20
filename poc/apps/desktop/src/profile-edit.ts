import fs from 'node:fs';
import path from 'node:path';
import { isValidBizNo, nameMissing, type Profile as DbProfile } from '@sax/db';
import { BIZ_FIELD_KEYS, BIZ_FIELD_MAX, emailOk, type BizCheck, type BizFields } from './onboarding.ts';

export type BizFieldKey = (typeof BIZ_FIELD_KEYS)[number];
export const BIZ_FIELD_LABEL: Record<BizFieldKey, string> = { name: '상호', bizNo: '사업자번호', rep: '대표자', bizType: '업태', bizItem: '종목', address: '주소', email: '이메일' };
export const BIZ_NO_CHANGE_NOTE = '사업자번호를 바꾸면 홈택스에 로그인한 사업자와 달라질 수 있어요. 다르면 발급 때 멈추고 알려 드려요.';

const onlyDigits = (s: string) => s.replace(/[^0-9]/g, '');
const clip = (s: unknown, n: number) => (typeof s === 'string' ? s.trim().slice(0, n) : '');

export { nameMissing };

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

interface ProfileEditPorts {
  list(): Promise<DbProfile[]>;
  upsert(row: Record<string, unknown>): Promise<DbProfile>;
  checkBizNo(bizNo: string): Promise<BizCheck>;
  saved(biz: BizFields, changed: BizFieldKey[]): Promise<void>;
}

type BizEditResult = { ok: true; changed: BizFieldKey[] } | { ok: false; confirm: BizCheck };

export class ProfileEditor {
  private readonly ports: ProfileEditPorts;
  private unverified: string | null = null;
  private busy = false;
  constructor(ports: ProfileEditPorts) {
    this.ports = ports;
  }

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
        signMethod: cur?.signMethod ?? 'cert',
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

interface ProfileEditEntry {
  at: string;
  kind: 'business';
  fields: BizFieldKey[];
}
export const PROFILE_EDIT_LOG_MAX = 50;

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
