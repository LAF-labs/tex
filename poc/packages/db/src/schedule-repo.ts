// 서류 유효기간 규칙표(D07 validity_rules, §3)와 갱신 일정(D07 schedules, D10). 데몬(@sax/daemon #98)이 엔진 읽기 질의(#91 data-service,
// daemon.snapshot)로 받는 행 모양을 그대로 낸다: ValidityRuleRow·ScheduleRow(@sax/daemon과 구조가 같다. db는 daemon을 가져오지 않는다).
// Phase 1 데몬은 notify뿐이다(D10 §2). semi_auto·auto 행은 동의 객체(B-27)가 결속될 때만 저장하고, 데몬은 그래도 notify로 강등한다.
// 값·비밀은 없다: 서류 종류·날짜·창·동의 서명만.
import { randomUUID } from 'node:crypto';
import type { Db } from './open.ts';
import { ValidationError } from './repo.ts';

const need = (ok: boolean, code: string): void => {
  if (!ok) throw new ValidationError(code);
};
type Row = Record<string, unknown>;

// ---- 유효기간 규칙표 ----

export type ValidityRuleKind = 'fixed_days' | 'fiscal_year_rule' | 'none';

/** D07 validity_rules 한 행(@sax/daemon ValidityRuleRow와 같은 모양) */
export interface ValidityRuleRow {
  docType: string;
  defaultDays: number | null;
  rule: ValidityRuleKind;
  userOverrideDays: number | null;
  /** 만료 n일 전 알림(쉼표 구분, 큰 것부터). D07 기본 '7,1' */
  remindDays: string;
}

export const DEFAULT_REMIND_DAYS = '7,1';

/** D07 §3 초기값(사용자 조정 가능). 표의 "한 행 두 종류"(등본/초본, 토지·건축물대장)는 종류마다 한 행 */
export const DEFAULT_VALIDITY_RULES: readonly Omit<ValidityRuleRow, 'userOverrideDays' | 'remindDays'>[] = Object.freeze([
  { docType: 'tax_invoice', defaultDays: null, rule: 'none' },
  { docType: 'biz_registration_cert', defaultDays: 90, rule: 'fixed_days' },
  { docType: 'national_tax_cert', defaultDays: 30, rule: 'fixed_days' },
  { docType: 'resident_copy', defaultDays: 90, rule: 'fixed_days' },
  { docType: 'resident_abstract', defaultDays: 90, rule: 'fixed_days' },
  { docType: 'localtax_cert', defaultDays: 30, rule: 'fixed_days' },
  { docType: 'localtax_item_cert', defaultDays: 90, rule: 'fixed_days' },
  { docType: 'nhis_eligibility', defaultDays: 90, rule: 'fixed_days' },
  { docType: 'land_register', defaultDays: 90, rule: 'fixed_days' },
  { docType: 'building_register', defaultDays: 90, rule: 'fixed_days' },
  { docType: 'sme_cert', defaultDays: null, rule: 'fiscal_year_rule' },
  { docType: 'insure4_cert', defaultDays: 30, rule: 'fixed_days' },
  { docType: 'paper_receipt', defaultDays: null, rule: 'none' },
  { docType: 'insurance_notice', defaultDays: null, rule: 'none' },
  { docType: 'settlement_file', defaultDays: null, rule: 'none' },
  { docType: 'payroll_ledger', defaultDays: null, rule: 'none' },
  { docType: 'pay_statement', defaultDays: null, rule: 'none' },
  { docType: 'bundle_export', defaultDays: null, rule: 'none' },
] as const);

const DOC_TYPE = /^[a-z0-9_]{1,40}$/;

/**
 * '7,1' 모양으로 맞춘다: 0~365 정수 1~5개, 중복 제거, 큰 것부터. 틀리면 bad_remind_days.
 * (데몬 parseRemindDays는 틀린 값을 기본값으로 읽지만, 저장은 틀린 값을 받지 않는다)
 */
export function normalizeRemindDays(v: string | readonly number[]): string {
  const parts = typeof v === 'string' ? v.split(',').map((s) => s.trim()) : v.map(String);
  need(parts.length >= 1 && parts.length <= 5 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 365), 'bad_remind_days');
  return [...new Set(parts.map(Number))].sort((a, b) => b - a).join(',');
}

const toRule = (r: Row): ValidityRuleRow => ({
  docType: String(r.doc_type),
  defaultDays: r.default_days === null || r.default_days === undefined ? null : Number(r.default_days),
  rule: r.rule as ValidityRuleKind,
  userOverrideDays: r.user_override_days === null || r.user_override_days === undefined ? null : Number(r.user_override_days),
  remindDays: String(r.remind_days),
});

/**
 * 유효기간 규칙표. 표에 행이 없는 종류는 D07 §3 초기값으로 읽는다(설치 때 씨앗 행을 넣지 않는다: 초기값이 바뀌면 코드만 바뀐다).
 * 사용자가 바꾼 종류만 행으로 남는다. 규칙 종류·기본 일수는 사용자가 바꾸지 않는다(유효 일수 덮어쓰기·알림 날만).
 */
export class ValidityRuleRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** 초기값 + 저장된 행(저장된 행이 이긴다). 종류 이름 순 */
  list(): ValidityRuleRow[] {
    const stored = new Map((this.db.prepare('SELECT * FROM validity_rules').all() as Row[]).map((r) => [String(r.doc_type), toRule(r)]));
    const base = DEFAULT_VALIDITY_RULES.map((d) => stored.get(d.docType) ?? { ...d, userOverrideDays: null, remindDays: DEFAULT_REMIND_DAYS });
    const extra = [...stored.values()].filter((r) => !DEFAULT_VALIDITY_RULES.some((d) => d.docType === r.docType));
    return [...base, ...extra].sort((a, b) => (a.docType < b.docType ? -1 : a.docType > b.docType ? 1 : 0));
  }

  get(docType: string): ValidityRuleRow | null {
    const r = this.db.prepare('SELECT * FROM validity_rules WHERE doc_type = ?').get(docType) as Row | undefined;
    if (r) return toRule(r);
    const d = DEFAULT_VALIDITY_RULES.find((x) => x.docType === docType);
    return d ? { ...d, userOverrideDays: null, remindDays: DEFAULT_REMIND_DAYS } : null;
  }

  /** 사용자 유효 일수(1~3650일). null이면 초기값으로 되돌린다. 만료 개념이 없는 종류(none)는 거부 */
  setOverrideDays(docType: string, days: number | null): ValidityRuleRow {
    need(days === null || (Number.isSafeInteger(days) && days >= 1 && days <= 3650), 'bad_override_days');
    const cur = this.known(docType);
    need(days === null || cur.rule !== 'none', 'rule_has_no_expiry');
    return this.put({ ...cur, userOverrideDays: days });
  }

  /** 알림 날(만료 n일 전). '7,1' 또는 [7, 1] */
  setRemindDays(docType: string, remindDays: string | readonly number[]): ValidityRuleRow {
    const cur = this.known(docType);
    return this.put({ ...cur, remindDays: normalizeRemindDays(remindDays) });
  }

  /** 사용자가 바꾼 것을 지우고 초기값으로 */
  reset(docType: string): boolean {
    return this.db.prepare('DELETE FROM validity_rules WHERE doc_type = ?').run(docType).changes > 0;
  }

  private known(docType: string): ValidityRuleRow {
    need(DOC_TYPE.test(docType), 'bad_doc_type');
    const cur = this.get(docType);
    need(cur !== null, 'unknown_doc_type');
    return cur!;
  }

  private put(r: ValidityRuleRow): ValidityRuleRow {
    this.db
      .prepare(`INSERT INTO validity_rules (doc_type, default_days, rule, user_override_days, remind_days) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(doc_type) DO UPDATE SET user_override_days = excluded.user_override_days, remind_days = excluded.remind_days`)
      .run(r.docType, r.defaultDays, r.rule, r.userOverrideDays, r.remindDays);
    return this.get(r.docType)!;
  }
}

// ---- 갱신 일정 ----

export type ScheduleMode = 'notify' | 'semi_auto' | 'auto';

/** D07 schedules 한 행(@sax/daemon ScheduleRow와 같은 모양 + lastRunId) */
export interface ScheduleRow {
  id: string;
  profileId: string;
  docType: string;
  playbookId: string;
  mode: ScheduleMode;
  /** {"days":[0..6],"from":"HH:MM","to":"HH:MM"}(한국 시간, 0 = 일요일) */
  windowJson: string | null;
  /** B-27 동의 객체 JSON. notify는 동의가 필요 없어 null */
  consentJson: string | null;
  nextDueAt: string | null;
  lastRunId: string | null;
  enabled: boolean;
}

/** 실행 창. 데몬 기본 창은 매일 09:00~18:00(daemon DEFAULT_WINDOW) */
export interface ScheduleWindow {
  days: number[];
  from: string;
  to: string;
}
export const DEFAULT_SCHEDULE_WINDOW: Readonly<ScheduleWindow> = Object.freeze({ days: [0, 1, 2, 3, 4, 5, 6], from: '09:00', to: '18:00' });

/** B-27 동의 객체(D10 §2.1). deviceSig는 SAX-consent-v1 서명(D08 §2.1). 저장소는 형식·결속만 보고 서명은 검증하지 않는다(엔진이 받기 전에 검증) */
export interface ScheduleConsent {
  playbookId: string;
  major: number;
  effects: string[];
  docType: string;
  profileId: string;
  consentedAt: string;
  deviceSig: string;
}

export interface ScheduleInput {
  /** 빼면 새 id */
  id?: string;
  profileId: string;
  docType: string;
  playbookId: string;
  mode?: ScheduleMode;
  window?: ScheduleWindow;
  /** semi_auto·auto면 필수(이 일정의 profileId·docType·playbookId와 결속) */
  consent?: ScheduleConsent | null;
  enabled?: boolean;
  nextDueAt?: string | null;
}

const PLAYBOOK_ID = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z)?$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (s: string): number => (s === '24:00' ? 1440 : Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5)));

/** 창 검사·정규화(데몬 parseWindow가 받는 모양). 틀리면 bad_window */
export function normalizeWindow(w: ScheduleWindow): string {
  need(Array.isArray(w.days) && w.days.length > 0 && w.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6), 'bad_window');
  need(typeof w.from === 'string' && HHMM.test(w.from) && typeof w.to === 'string' && (HHMM.test(w.to) || w.to === '24:00'), 'bad_window');
  need(minutes(w.to) > minutes(w.from), 'bad_window');
  return JSON.stringify({ days: [...new Set(w.days)].sort((a, b) => a - b), from: w.from, to: w.to });
}

function consentProblem(c: ScheduleConsent, s: { profileId: string; docType: string; playbookId: string }): boolean {
  const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 512;
  return !(
    str(c.playbookId) && str(c.docType) && str(c.profileId) && str(c.consentedAt) && ISO.test(c.consentedAt) && str(c.deviceSig) &&
    Number.isInteger(c.major) && c.major >= 0 && Array.isArray(c.effects) && c.effects.every((e) => typeof e === 'string' && /^[a-z_]{1,32}$/.test(e)) &&
    c.playbookId === s.playbookId && c.docType === s.docType && c.profileId === s.profileId
  );
}

const toSchedule = (r: Row): ScheduleRow => {
  const consent = String(r.consent_json);
  return {
    id: String(r.id),
    profileId: String(r.profile_id),
    docType: String(r.doc_type),
    playbookId: String(r.playbook_id),
    mode: r.mode as ScheduleMode,
    windowJson: String(r.window_json),
    consentJson: consent === '' || consent === 'null' ? null : consent,
    nextDueAt: (r.next_due_at as string) ?? null,
    lastRunId: (r.last_run_id as string) ?? null,
    enabled: Number(r.enabled) === 1,
  };
};

/**
 * 갱신 일정(D07 schedules). consent_json·window_json은 NOT NULL이라 notify는 consent_json에 'null'을 넣고 null로 읽는다.
 * 데몬은 enabled 행을 서류 종류별로 묶어 notify로만 쓴다(Phase 1).
 */
export class ScheduleRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** 프로필의 일정(서류 종류 → id 순). profileId를 빼면 전부 */
  list(profileId?: string): ScheduleRow[] {
    const rows = profileId
      ? this.db.prepare('SELECT * FROM schedules WHERE profile_id = ? ORDER BY doc_type, id').all(profileId)
      : this.db.prepare('SELECT * FROM schedules ORDER BY profile_id, doc_type, id').all();
    return (rows as Row[]).map(toSchedule);
  }

  get(id: string): ScheduleRow | null {
    const r = this.db.prepare('SELECT * FROM schedules WHERE id = ?').get(id) as Row | undefined;
    return r ? toSchedule(r) : null;
  }

  /** 새로 넣거나(id 없음·없는 id) 바꾼다. 바꿀 때 빠진 칸은 그대로 둔다(mode를 notify로 내리면 동의는 지운다) */
  upsert(input: ScheduleInput): ScheduleRow {
    const cur = input.id ? this.get(input.id) : null;
    need(!cur || cur.profileId === input.profileId, 'schedule_profile_mismatch');
    need(!!this.db.prepare('SELECT 1 FROM profiles WHERE id = ?').get(input.profileId), 'profile_not_found');
    need(DOC_TYPE.test(input.docType), 'bad_doc_type');
    need(new ValidityRuleRepo(this.db).get(input.docType)?.rule !== 'none', 'doc_type_not_renewable');
    need(PLAYBOOK_ID.test(input.playbookId) && input.playbookId.length <= 128, 'bad_playbook_id');
    const mode = input.mode ?? cur?.mode ?? 'notify';
    need(mode === 'notify' || mode === 'semi_auto' || mode === 'auto', 'bad_mode');
    const windowJson = input.window ? normalizeWindow(input.window) : (cur?.windowJson ?? normalizeWindow(DEFAULT_SCHEDULE_WINDOW));
    let consent: ScheduleConsent | null = input.consent === undefined ? (cur?.consentJson ? (JSON.parse(cur.consentJson) as ScheduleConsent) : null) : input.consent;
    if (mode === 'notify') consent = null;
    else need(consent !== null && !consentProblem(consent, input), 'consent_required');
    const nextDueAt = input.nextDueAt === undefined ? (cur?.nextDueAt ?? null) : input.nextDueAt;
    need(nextDueAt === null || ISO.test(nextDueAt), 'bad_next_due_at');
    const enabled = input.enabled ?? cur?.enabled ?? true;
    const id = input.id ?? randomUUID();
    const consentJson = consent
      ? JSON.stringify({ playbookId: consent.playbookId, major: consent.major, effects: [...consent.effects], docType: consent.docType, profileId: consent.profileId, consentedAt: consent.consentedAt, deviceSig: consent.deviceSig })
      : 'null';
    this.db
      .prepare(`INSERT INTO schedules (id, profile_id, doc_type, playbook_id, mode, window_json, consent_json, next_due_at, last_run_id, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET doc_type = excluded.doc_type, playbook_id = excluded.playbook_id, mode = excluded.mode, window_json = excluded.window_json,
          consent_json = excluded.consent_json, next_due_at = excluded.next_due_at, enabled = excluded.enabled`)
      .run(id, input.profileId, input.docType, input.playbookId, mode, windowJson, consentJson, nextDueAt, enabled ? 1 : 0);
    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean): ScheduleRow {
    need(this.db.prepare('UPDATE schedules SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id).changes > 0, 'schedule_not_found');
    return this.get(id)!;
  }

  /** 다음 예정(데몬·엔진이 만료 계산 뒤 남긴다). null이면 미정 */
  setNextDue(id: string, nextDueAt: string | null): ScheduleRow {
    need(nextDueAt === null || ISO.test(nextDueAt), 'bad_next_due_at');
    need(this.db.prepare('UPDATE schedules SET next_due_at = ? WHERE id = ?').run(nextDueAt, id).changes > 0, 'schedule_not_found');
    return this.get(id)!;
  }

  /** 이 일정으로 돈 마지막 실행(Phase 2 semi_auto부터. runs 행이 있어야 한다) */
  recordRun(id: string, runId: string): ScheduleRow {
    need(!!this.db.prepare('SELECT 1 FROM runs WHERE id = ?').get(runId), 'run_not_found');
    need(this.db.prepare('UPDATE schedules SET last_run_id = ? WHERE id = ?').run(runId, id).changes > 0, 'schedule_not_found');
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }
}

// ---- 데몬 스냅숏의 db 몫(엔진 daemon.snapshot이 문서·missingReport와 합친다) ----

/** 설정 키(D07 §2 끝: 프로필마다) */
export const DAEMON_SETTING_KEYS = {
  reminderDay: (profileId: string) => `profile.${profileId}.bundle.reminderDay`,
  halfYearWithholding: (profileId: string) => `profile.${profileId}.payroll.halfYearWithholding`,
  fiscalYearEndMonth: (profileId: string) => `profile.${profileId}.fiscalYearEndMonth`,
  leadDays: (profileId: string) => `profile.${profileId}.daemon.leadDays`,
} as const;
/** bundle.reminderDay 기본값(설정 전): 매달 5일 */
export const DEFAULT_REMINDER_DAY = 5;

export interface DaemonSettings {
  reminderDay: number;
  halfYearWithholding: boolean;
  fiscalYearEndMonth?: number;
  leadDays?: number;
}

export interface DaemonProfileInputs {
  profileId: string;
  validityRules: ValidityRuleRow[];
  schedules: ScheduleRow[];
  settings: DaemonSettings;
  /** 보냈어요 표시가 있는 꾸러미 달(bundle_exports.sent_marked_at, 급여 기록 내보내기 'payroll:…'은 뺀다) */
  bundleSentPeriods: string[];
  /** 사업용 카드 마지막 최신화 날짜(한국 날짜) */
  cardFetchedOn: string | null;
}

const kstDay = (iso: string): string => new Date(Date.parse(iso) + 9 * 3_600_000).toISOString().slice(0, 10);

/** 데몬 설정 읽기·쓰기. 값은 정수·불리언만 */
export class DaemonSettingsRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private read(key: string): unknown {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
    if (v === undefined) return undefined;
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return undefined;
    }
  }

  private write(key: string, value: unknown): void {
    if (value === undefined) this.db.prepare('DELETE FROM settings WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(key, JSON.stringify(value));
  }

  /** 틀린 값이 저장돼 있으면 기본값으로 읽는다 */
  get(profileId: string): DaemonSettings {
    const k = DAEMON_SETTING_KEYS;
    const day = this.read(k.reminderDay(profileId));
    const half = this.read(k.halfYearWithholding(profileId));
    const fy = this.read(k.fiscalYearEndMonth(profileId));
    const lead = this.read(k.leadDays(profileId));
    const int = (v: unknown, lo: number, hi: number): v is number => Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi;
    return {
      reminderDay: int(day, 1, 28) ? day : DEFAULT_REMINDER_DAY,
      halfYearWithholding: half === true,
      ...(int(fy, 1, 12) ? { fiscalYearEndMonth: fy } : {}),
      ...(int(lead, 0, 90) ? { leadDays: lead } : {}),
    };
  }

  /** 빠진 칸은 그대로, undefined 아닌 null은 지움(기본값으로) */
  set(profileId: string, patch: { reminderDay?: number | null; halfYearWithholding?: boolean | null; fiscalYearEndMonth?: number | null; leadDays?: number | null }): DaemonSettings {
    const k = DAEMON_SETTING_KEYS;
    const int = (v: number | null | undefined, lo: number, hi: number, code: string) => need(v === undefined || v === null || (Number.isInteger(v) && v >= lo && v <= hi), code);
    int(patch.reminderDay, 1, 28, 'bad_reminder_day');
    int(patch.fiscalYearEndMonth, 1, 12, 'bad_fiscal_year_end_month');
    int(patch.leadDays, 0, 90, 'bad_lead_days');
    need(patch.halfYearWithholding === undefined || patch.halfYearWithholding === null || typeof patch.halfYearWithholding === 'boolean', 'bad_half_year');
    this.db.transaction(() => {
      if (patch.reminderDay !== undefined) this.write(k.reminderDay(profileId), patch.reminderDay ?? undefined);
      if (patch.halfYearWithholding !== undefined) this.write(k.halfYearWithholding(profileId), patch.halfYearWithholding ?? undefined);
      if (patch.fiscalYearEndMonth !== undefined) this.write(k.fiscalYearEndMonth(profileId), patch.fiscalYearEndMonth ?? undefined);
      if (patch.leadDays !== undefined) this.write(k.leadDays(profileId), patch.leadDays ?? undefined);
    })();
    return this.get(profileId);
  }
}

/** 데몬 ProfileSnapshot 중 db에서 바로 읽는 칸. 엔진은 documents(DocumentRepo)·missing(@sax/bundle missingReport)만 더한다 */
export function daemonProfileInputs(db: Db, profileId: string): DaemonProfileInputs {
  const sent = db
    .prepare(`SELECT DISTINCT period FROM bundle_exports WHERE profile_id = ? AND sent_marked_at IS NOT NULL AND period NOT LIKE 'payroll:%' ORDER BY period`)
    .pluck()
    .all(profileId) as string[];
  const last = db.prepare('SELECT completed_at FROM card_fetches WHERE profile_id = ? ORDER BY completed_at DESC LIMIT 1').pluck().get(profileId) as string | undefined;
  return {
    profileId,
    validityRules: new ValidityRuleRepo(db).list(),
    schedules: new ScheduleRepo(db).list(profileId),
    settings: new DaemonSettingsRepo(db).get(profileId),
    bundleSentPeriods: sent,
    cardFetchedOn: last ? kstDay(last) : null,
  };
}
