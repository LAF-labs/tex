import { randomUUID } from 'node:crypto';
import type { ColumnCipher } from './column.ts';
import type { Db } from './open.ts';
import { ValidationError } from './repo.ts';

type Row = Record<string, unknown>;
const nowIso = () => new Date().toISOString();
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const isInt = (n: unknown, min = 0): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;
const need = (ok: boolean, code: string): void => {
  if (!ok) throw new ValidationError(code);
};
const validDay = (d: string): boolean => DAY.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;

export type PayType = 'monthly' | 'hourly';
export type WithholdingPct = 80 | 100 | 120;

export interface Employee {
  id: string;
  profileId: string;
  name: string;
  birthDate: string;
  hasRrn: boolean;
  hiredOn: string;
  leftOn: string | null;
  job: string | null;
  payType: PayType;
  basePay: number;
  nontax: Record<string, number>;
  dependents: number;
  children8to20: number;
  withholdingPct: WithholdingPct;
  pensionApplies: boolean;
  healthApplies: boolean;
  employmentApplies: boolean;
  pensionBase: number | null;
  healthBase: number | null;
  createdAt: string;
  updatedAt: string;
}

export type EmployeeInput = Omit<Employee, 'id' | 'hasRrn' | 'createdAt' | 'updatedAt' | 'leftOn' | 'job' | 'payType' | 'nontax' | 'children8to20' | 'withholdingPct' | 'pensionApplies' | 'healthApplies' | 'employmentApplies' | 'pensionBase' | 'healthBase'> &
  Partial<Pick<Employee, 'leftOn' | 'job' | 'payType' | 'nontax' | 'children8to20' | 'withholdingPct' | 'pensionApplies' | 'healthApplies' | 'employmentApplies' | 'pensionBase' | 'healthBase'>> & {
    rrn?: string | null;
  };

export type EmployeePatch = Partial<Omit<EmployeeInput, 'profileId'>>;

const toEmployee = (r: Row): Employee => ({
  id: String(r.id),
  profileId: String(r.profile_id),
  name: String(r.name),
  birthDate: String(r.birth_date),
  hasRrn: r.rrn_enc != null,
  hiredOn: String(r.hired_on),
  leftOn: (r.left_on as string) ?? null,
  job: (r.job as string) ?? null,
  payType: r.pay_type as PayType,
  basePay: Number(r.base_pay),
  nontax: JSON.parse(String(r.nontax_json)) as Record<string, number>,
  dependents: Number(r.dependents),
  children8to20: Number(r.children_8_20),
  withholdingPct: Number(r.withholding_pct) as WithholdingPct,
  pensionApplies: r.pension_applies === 1,
  healthApplies: r.health_applies === 1,
  employmentApplies: r.employment_applies === 1,
  pensionBase: r.pension_base == null ? null : Number(r.pension_base),
  healthBase: r.health_base == null ? null : Number(r.health_base),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

/** 주민번호를 숫자 13자리로. 형식이 틀리면 ValidationError('invalid_rrn'). */
export function normalizeRrn(rrn: string): string {
  const d = rrn.replace(/[\s-]/g, '');
  if (!/^\d{13}$/.test(d)) throw new ValidationError('invalid_rrn');
  return d;
}

/** 주민번호 앞 7자리(생년월일·성별 자리)가 생년월일과 맞는지. 뒤 6자리는 보지 않는다. */
export function rrnMatchesBirthDate(rrn: string, birthDate: string): boolean {
  const d = normalizeRrn(rrn);
  const g = d[6]!;
  const century = '12'.includes(g) || '56'.includes(g) ? '19' : '34'.includes(g) || '78'.includes(g) ? '20' : '90'.includes(g) ? '18' : null;
  if (!century) return false;
  return `${century}${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4, 6)}` === birthDate;
}

/** 화면 표시용: 900101-1****** */
export const maskRrn = (rrn: string): string => {
  const d = normalizeRrn(rrn);
  return `${d.slice(0, 6)}-${d[6]}******`;
};

function checkEmployee(e: Omit<Employee, 'id' | 'hasRrn' | 'createdAt' | 'updatedAt'>): void {
  need(!!e.name.trim(), 'name_required');
  need(validDay(e.birthDate), 'invalid_birth_date');
  need(validDay(e.hiredOn), 'invalid_hired_on');
  need(e.leftOn === null || (validDay(e.leftOn) && e.leftOn >= e.hiredOn), 'invalid_left_on');
  need(e.payType === 'monthly' || e.payType === 'hourly', 'invalid_pay_type');
  need(isInt(e.basePay), 'invalid_base_pay');
  need(isInt(e.dependents, 1), 'invalid_dependents');
  need(isInt(e.children8to20) && e.children8to20 <= e.dependents - 1, 'invalid_children_8_20');
  need([80, 100, 120].includes(e.withholdingPct), 'invalid_withholding_pct');
  need(e.pensionBase === null || isInt(e.pensionBase), 'invalid_pension_base');
  need(e.healthBase === null || isInt(e.healthBase), 'invalid_health_base');
  need(typeof e.nontax === 'object' && e.nontax !== null && !Array.isArray(e.nontax), 'invalid_nontax');
  for (const [k, v] of Object.entries(e.nontax)) need(!!k.trim() && isInt(v), 'invalid_nontax');
}

const rrnAad = (id: string) => `employees.rrn_enc:${id}`;

export class EmployeeRepo {
  private readonly db: Db;
  private readonly cipher: ColumnCipher;
  constructor(db: Db, cipher: ColumnCipher) {
    this.db = db;
    this.cipher = cipher;
  }

  get(id: string): Employee | null {
    const r = this.db.prepare('SELECT * FROM employees WHERE id = ?').get(id);
    return r ? toEmployee(r as Row) : null;
  }

  list(profileId: string, opts: { activeInMonth?: string } = {}): Employee[] {
    const rows = this.db.prepare('SELECT * FROM employees WHERE profile_id = ? ORDER BY hired_on, name, id').all(profileId).map((r) => toEmployee(r as Row));
    const m = opts.activeInMonth;
    if (!m) return rows;
    need(MONTH.test(m), 'invalid_month');
    return rows.filter((e) => e.hiredOn <= `${m}-31` && (e.leftOn === null || e.leftOn >= `${m}-01`));
  }

  create(input: EmployeeInput, at: string = nowIso()): Employee {
    const e = {
      profileId: input.profileId,
      name: input.name.trim(),
      birthDate: input.birthDate,
      hiredOn: input.hiredOn,
      leftOn: input.leftOn ?? null,
      job: input.job ?? null,
      payType: input.payType ?? 'monthly',
      basePay: input.basePay,
      nontax: input.nontax ?? {},
      dependents: input.dependents,
      children8to20: input.children8to20 ?? 0,
      withholdingPct: input.withholdingPct ?? 100,
      pensionApplies: input.pensionApplies ?? true,
      healthApplies: input.healthApplies ?? true,
      employmentApplies: input.employmentApplies ?? true,
      pensionBase: input.pensionBase ?? null,
      healthBase: input.healthBase ?? null,
    };
    checkEmployee(e);
    const id = randomUUID();
    const rrnEnc = this.sealRrn(id, input.rrn, e.birthDate);
    this.db
      .prepare(`INSERT INTO employees (id, profile_id, name, birth_date, rrn_enc, hired_on, left_on, job, pay_type, base_pay, nontax_json, dependents, children_8_20,
          withholding_pct, pension_applies, health_applies, employment_applies, pension_base, health_base, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, e.profileId, e.name, e.birthDate, rrnEnc, e.hiredOn, e.leftOn, e.job, e.payType, e.basePay, JSON.stringify(e.nontax), e.dependents, e.children8to20,
        e.withholdingPct, e.pensionApplies ? 1 : 0, e.healthApplies ? 1 : 0, e.employmentApplies ? 1 : 0, e.pensionBase, e.healthBase, at, at);
    return this.get(id)!;
  }

  update(id: string, patch: EmployeePatch, at: string = nowIso()): Employee {
    const cur = this.get(id);
    if (!cur) throw new ValidationError('not_found');
    const defined = Object.fromEntries(Object.entries(patch).filter(([k, v]) => v !== undefined && k !== 'rrn'));
    const next = { ...cur, ...defined } as Employee;
    next.name = next.name.trim();
    checkEmployee(next);
    const rrnEnc = patch.rrn !== undefined ? this.sealRrn(id, patch.rrn, next.birthDate) : undefined;
    if (rrnEnc === undefined && cur.hasRrn && next.birthDate !== cur.birthDate && !rrnMatchesBirthDate(this.revealRrn(id)!, next.birthDate)) {
      throw new ValidationError('rrn_birth_mismatch');
    }
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE employees SET name=?, birth_date=?, hired_on=?, left_on=?, job=?, pay_type=?, base_pay=?, nontax_json=?, dependents=?, children_8_20=?,
            withholding_pct=?, pension_applies=?, health_applies=?, employment_applies=?, pension_base=?, health_base=?, updated_at=? WHERE id=?`)
        .run(next.name, next.birthDate, next.hiredOn, next.leftOn, next.job, next.payType, next.basePay, JSON.stringify(next.nontax), next.dependents, next.children8to20,
          next.withholdingPct, next.pensionApplies ? 1 : 0, next.healthApplies ? 1 : 0, next.employmentApplies ? 1 : 0, next.pensionBase, next.healthBase, at, id);
      if (rrnEnc !== undefined) this.db.prepare('UPDATE employees SET rrn_enc=? WHERE id=?').run(rrnEnc, id);
    })();
    return this.get(id)!;
  }

  revealRrn(id: string): string | null {
    const r = this.db.prepare('SELECT rrn_enc FROM employees WHERE id = ?').get(id) as { rrn_enc: Uint8Array | null } | undefined;
    if (!r) throw new ValidationError('not_found');
    return r.rrn_enc ? this.cipher.open(r.rrn_enc, rrnAad(id)) : null;
  }

  maskedRrn(id: string): string | null {
    const rrn = this.revealRrn(id);
    return rrn ? maskRrn(rrn) : null;
  }

  private sealRrn(id: string, rrn: string | null | undefined, birthDate: string): Buffer | null {
    if (rrn == null || rrn === '') return null;
    const d = normalizeRrn(rrn);
    if (!rrnMatchesBirthDate(d, birthDate)) throw new ValidationError('rrn_birth_mismatch');
    return this.cipher.seal(d, rrnAad(id));
  }
}

export type PayrollStatus = 'draft' | 'confirmed';

export interface PayrollMonth {
  profileId: string;
  month: string;
  revision: number;
  status: PayrollStatus;
  paidOn: string | null;
  rateTableIds: string[];
  noticeDocIds: string[];
  confirmedAt: string | null;
}

export interface PayItem {
  name: string;
  amount: number;
  taxable: boolean;
  calc: string;
}

export interface EmployerShare {
  pensionEst: number;
  healthEst: number;
  ltcEst: number;
  employmentEst: number;
  industrialAccidentEst: number | null;
  pensionNotice: number | null;
  healthNotice: number | null;
  ltcNotice: number | null;
  employmentNotice: number | null;
  industrialAccidentNotice: number | null;
}

export interface PayrollLine {
  employeeId: string;
  workDays: number | null;
  workMinutes: number | null;
  overtimeMinutes: number | null;
  nightMinutes: number | null;
  holidayMinutes: number | null;
  items: PayItem[];
  gross: number;
  nontax: number;
  incomeTax: number;
  localIncomeTax: number;
  pensionEst: number;
  healthEst: number;
  ltcEst: number;
  employmentEst: number;
  pensionNotice: number | null;
  healthNotice: number | null;
  ltcNotice: number | null;
  employmentNotice: number | null;
  employer: EmployerShare;
  netPay: number;
}

const toMonth = (r: Row): PayrollMonth => ({
  profileId: String(r.profile_id),
  month: String(r.month),
  revision: Number(r.revision),
  status: r.status as PayrollStatus,
  paidOn: (r.paid_on as string) ?? null,
  rateTableIds: JSON.parse(String(r.rate_table_ids_json)) as string[],
  noticeDocIds: JSON.parse(String(r.notice_doc_ids_json)) as string[],
  confirmedAt: (r.confirmed_at as string) ?? null,
});

const n = (v: unknown): number | null => (v == null ? null : Number(v));

const toLine = (r: Row): PayrollLine => ({
  employeeId: String(r.employee_id),
  workDays: n(r.work_days),
  workMinutes: n(r.work_minutes),
  overtimeMinutes: n(r.overtime_minutes),
  nightMinutes: n(r.night_minutes),
  holidayMinutes: n(r.holiday_minutes),
  items: JSON.parse(String(r.items_json)) as PayItem[],
  gross: Number(r.gross),
  nontax: Number(r.nontax),
  incomeTax: Number(r.income_tax),
  localIncomeTax: Number(r.local_income_tax),
  pensionEst: Number(r.pension_est),
  healthEst: Number(r.health_est),
  ltcEst: Number(r.ltc_est),
  employmentEst: Number(r.employment_est),
  pensionNotice: n(r.pension_notice),
  healthNotice: n(r.health_notice),
  ltcNotice: n(r.ltc_notice),
  employmentNotice: n(r.employment_notice),
  employer: JSON.parse(String(r.employer_json)) as EmployerShare,
  netPay: Number(r.net_pay),
});

function checkLine(l: PayrollLine): void {
  for (const k of ['workDays', 'workMinutes', 'overtimeMinutes', 'nightMinutes', 'holidayMinutes', 'pensionNotice', 'healthNotice', 'ltcNotice', 'employmentNotice'] as const) {
    need(l[k] === null || isInt(l[k]), `invalid_${k}`);
  }
  for (const k of ['gross', 'nontax', 'incomeTax', 'localIncomeTax', 'pensionEst', 'healthEst', 'ltcEst', 'employmentEst'] as const) need(isInt(l[k]), `invalid_${k}`);
  need(Number.isSafeInteger(l.netPay), 'invalid_netPay');
  need(Array.isArray(l.items) && l.items.every((i) => !!i.name && Number.isSafeInteger(i.amount) && typeof i.taxable === 'boolean' && typeof i.calc === 'string'), 'invalid_items');
  need(l.items.reduce((s, i) => s + i.amount, 0) === l.gross, 'items_gross_mismatch');
  need(l.items.filter((i) => !i.taxable).reduce((s, i) => s + i.amount, 0) === l.nontax, 'items_nontax_mismatch');
}

/**
 * 급여대장 달·개정. 규칙(ADR-031, 08 D-06):
 * - 달마다 개정 번호가 있다. 확인(confirmed)한 개정은 고치지 않는다. 고치려면 revise()로 다음 개정 초안을 만든다(이미 준 명세서와 구분).
 * - 초안은 달마다 하나만 있다(가장 큰 개정).
 */
export class PayrollRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  latest(profileId: string, month: string): PayrollMonth | null {
    const r = this.db.prepare('SELECT * FROM payroll_months WHERE profile_id = ? AND month = ? ORDER BY revision DESC LIMIT 1').get(profileId, month);
    return r ? toMonth(r as Row) : null;
  }

  latestConfirmed(profileId: string, month: string): PayrollMonth | null {
    const r = this.db.prepare(`SELECT * FROM payroll_months WHERE profile_id = ? AND month = ? AND status = 'confirmed' ORDER BY revision DESC LIMIT 1`).get(profileId, month);
    return r ? toMonth(r as Row) : null;
  }

  get(profileId: string, month: string, revision: number): PayrollMonth | null {
    const r = this.db.prepare('SELECT * FROM payroll_months WHERE profile_id = ? AND month = ? AND revision = ?').get(profileId, month, revision);
    return r ? toMonth(r as Row) : null;
  }

  revisions(profileId: string, month: string): PayrollMonth[] {
    return this.db.prepare('SELECT * FROM payroll_months WHERE profile_id = ? AND month = ? ORDER BY revision').all(profileId, month).map((r) => toMonth(r as Row));
  }

  months(profileId: string): string[] {
    return (this.db.prepare('SELECT DISTINCT month FROM payroll_months WHERE profile_id = ? ORDER BY month').all(profileId) as Row[]).map((r) => String(r.month));
  }

  openDraft(profileId: string, month: string, rateTableIds: string[], paidOn: string | null = null): PayrollMonth {
    need(MONTH.test(month), 'invalid_month');
    need(paidOn === null || validDay(paidOn), 'invalid_paid_on');
    const cur = this.latest(profileId, month);
    if (cur?.status === 'draft') return cur;
    if (cur) throw new ValidationError('month_confirmed_use_revise');
    this.db
      .prepare(`INSERT INTO payroll_months (profile_id, month, revision, status, paid_on, rate_table_ids_json) VALUES (?, ?, 1, 'draft', ?, ?)`)
      .run(profileId, month, paidOn, JSON.stringify(rateTableIds));
    return this.get(profileId, month, 1)!;
  }

  revise(profileId: string, month: string): PayrollMonth {
    return this.db.transaction(() => {
      const cur = this.latest(profileId, month);
      if (!cur) throw new ValidationError('not_found');
      if (cur.status === 'draft') return cur;
      const rev = cur.revision + 1;
      this.db
        .prepare(`INSERT INTO payroll_months (profile_id, month, revision, status, paid_on, rate_table_ids_json, notice_doc_ids_json) VALUES (?, ?, ?, 'draft', ?, ?, ?)`)
        .run(profileId, month, rev, cur.paidOn, JSON.stringify(cur.rateTableIds), JSON.stringify(cur.noticeDocIds));
      this.db
        .prepare(`INSERT INTO payroll_lines SELECT profile_id, month, ?, employee_id, work_days, work_minutes, overtime_minutes, night_minutes, holiday_minutes, items_json,
            gross, nontax, income_tax, local_income_tax, pension_est, health_est, ltc_est, employment_est, pension_notice, health_notice, ltc_notice, employment_notice,
            employer_json, net_pay FROM payroll_lines WHERE profile_id = ? AND month = ? AND revision = ?`)
        .run(rev, profileId, month, cur.revision);
      return this.get(profileId, month, rev)!;
    })();
  }

  private requireDraft(profileId: string, month: string, revision: number): PayrollMonth {
    const m = this.get(profileId, month, revision);
    if (!m) throw new ValidationError('not_found');
    if (m.status !== 'draft') throw new ValidationError('month_confirmed');
    return m;
  }

  updateDraft(profileId: string, month: string, revision: number, patch: { paidOn?: string | null; rateTableIds?: string[]; noticeDocIds?: string[] }): PayrollMonth {
    const m = this.requireDraft(profileId, month, revision);
    const paidOn = patch.paidOn === undefined ? m.paidOn : patch.paidOn;
    need(paidOn === null || validDay(paidOn), 'invalid_paid_on');
    this.db
      .prepare('UPDATE payroll_months SET paid_on=?, rate_table_ids_json=?, notice_doc_ids_json=? WHERE profile_id=? AND month=? AND revision=?')
      .run(paidOn, JSON.stringify(patch.rateTableIds ?? m.rateTableIds), JSON.stringify(patch.noticeDocIds ?? m.noticeDocIds), profileId, month, revision);
    return this.get(profileId, month, revision)!;
  }

  putLine(profileId: string, month: string, revision: number, line: PayrollLine): void {
    this.requireDraft(profileId, month, revision);
    checkLine(line);
    this.db
      .prepare(`INSERT INTO payroll_lines (profile_id, month, revision, employee_id, work_days, work_minutes, overtime_minutes, night_minutes, holiday_minutes, items_json,
          gross, nontax, income_tax, local_income_tax, pension_est, health_est, ltc_est, employment_est, pension_notice, health_notice, ltc_notice, employment_notice, employer_json, net_pay)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, month, revision, employee_id) DO UPDATE SET work_days=excluded.work_days, work_minutes=excluded.work_minutes,
          overtime_minutes=excluded.overtime_minutes, night_minutes=excluded.night_minutes, holiday_minutes=excluded.holiday_minutes, items_json=excluded.items_json,
          gross=excluded.gross, nontax=excluded.nontax, income_tax=excluded.income_tax, local_income_tax=excluded.local_income_tax, pension_est=excluded.pension_est,
          health_est=excluded.health_est, ltc_est=excluded.ltc_est, employment_est=excluded.employment_est, pension_notice=excluded.pension_notice,
          health_notice=excluded.health_notice, ltc_notice=excluded.ltc_notice, employment_notice=excluded.employment_notice, employer_json=excluded.employer_json,
          net_pay=excluded.net_pay`)
      .run(profileId, month, revision, line.employeeId, line.workDays, line.workMinutes, line.overtimeMinutes, line.nightMinutes, line.holidayMinutes, JSON.stringify(line.items),
        line.gross, line.nontax, line.incomeTax, line.localIncomeTax, line.pensionEst, line.healthEst, line.ltcEst, line.employmentEst, line.pensionNotice, line.healthNotice,
        line.ltcNotice, line.employmentNotice, JSON.stringify(line.employer), line.netPay);
  }

  removeLine(profileId: string, month: string, revision: number, employeeId: string): boolean {
    this.requireDraft(profileId, month, revision);
    return this.db.prepare('DELETE FROM payroll_lines WHERE profile_id=? AND month=? AND revision=? AND employee_id=?').run(profileId, month, revision, employeeId).changes > 0;
  }

  lines(profileId: string, month: string, revision: number): PayrollLine[] {
    return this.db
      .prepare('SELECT * FROM payroll_lines WHERE profile_id = ? AND month = ? AND revision = ? ORDER BY employee_id')
      .all(profileId, month, revision)
      .map((r) => toLine(r as Row));
  }

  confirm(profileId: string, month: string, revision: number, at: string = nowIso()): PayrollMonth {
    this.requireDraft(profileId, month, revision);
    need(this.lines(profileId, month, revision).length > 0, 'no_lines');
    this.db.prepare(`UPDATE payroll_months SET status='confirmed', confirmed_at=? WHERE profile_id=? AND month=? AND revision=?`).run(at, profileId, month, revision);
    return this.get(profileId, month, revision)!;
  }
}

export interface Shift {
  id: string;
  profileId: string;
  employeeId: string;
  workDay: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
  kind: 'planned' | 'actual';
  updatedAt: string;
}

const toShift = (r: Row): Shift => ({
  id: String(r.id),
  profileId: String(r.profile_id),
  employeeId: String(r.employee_id),
  workDay: String(r.work_day),
  startsAt: String(r.starts_at),
  endsAt: String(r.ends_at),
  breakMinutes: Number(r.break_minutes),
  kind: r.kind as Shift['kind'],
  updatedAt: String(r.updated_at),
});

export class ShiftRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  put(s: Omit<Shift, 'id' | 'updatedAt' | 'kind'> & { id?: string; kind?: Shift['kind'] }, at: string = nowIso()): Shift {
    need(validDay(s.workDay), 'invalid_work_day');
    need(HHMM.test(s.startsAt) && HHMM.test(s.endsAt), 'invalid_time');
    need(s.startsAt !== s.endsAt, 'empty_shift');
    need(isInt(s.breakMinutes), 'invalid_break');
    const id = s.id ?? randomUUID();
    this.db
      .prepare(`INSERT INTO shifts (id, profile_id, employee_id, work_day, starts_at, ends_at, break_minutes, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET work_day=excluded.work_day, starts_at=excluded.starts_at, ends_at=excluded.ends_at, break_minutes=excluded.break_minutes,
          kind=excluded.kind, updated_at=excluded.updated_at`)
      .run(id, s.profileId, s.employeeId, s.workDay, s.startsAt, s.endsAt, s.breakMinutes, s.kind ?? 'actual', at);
    return toShift(this.db.prepare('SELECT * FROM shifts WHERE id = ?').get(id) as Row);
  }

  month(profileId: string, employeeId: string, month: string, kind: Shift['kind'] = 'actual'): Shift[] {
    need(MONTH.test(month), 'invalid_month');
    return this.db
      .prepare(`SELECT * FROM shifts WHERE profile_id = ? AND employee_id = ? AND kind = ? AND work_day >= ? AND work_day <= ? ORDER BY work_day, starts_at`)
      .all(profileId, employeeId, kind, `${month}-01`, `${month}-31`)
      .map((r) => toShift(r as Row));
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM shifts WHERE id = ?').run(id).changes > 0;
  }
}

export type RateTableKind = 'insurance_rate' | 'pension_bounds' | 'simple_tax_table' | 'nontax_limits';

export interface RateTableRow {
  id: string;
  kind: RateTableKind;
  effectiveFrom: string;
  effectiveTo: string | null;
  body: unknown;
  rounding: string;
  packageVersion: string;
  signatureOk: boolean;
}

const toRate = (r: Row): RateTableRow => ({
  id: String(r.id),
  kind: r.kind as RateTableKind,
  effectiveFrom: String(r.effective_from),
  effectiveTo: (r.effective_to as string) ?? null,
  body: JSON.parse(String(r.body_json)) as unknown,
  rounding: String(r.rounding),
  packageVersion: String(r.package_version),
  signatureOk: r.signature_ok === 1,
});

type Span = { effectiveFrom: string; effectiveTo: string | null };
const dayBefore = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
const endAgainst = (x: Span, other: Span): string => x.effectiveTo ?? (other.effectiveFrom > x.effectiveFrom ? dayBefore(other.effectiveFrom) : '9999-12-31');
/** 두 표가 같은 날을 덮는가(시작일이 같거나, 닫힌 기간이 다른 표의 기간과 겹친다) */
export const rateSpansConflict = (a: Span, b: Span): boolean => a.effectiveFrom <= endAgainst(b, a) && b.effectiveFrom <= endAgainst(a, b);

export interface InstalledRatePackage {
  version: string;
  digest: string;
  installedAt: string;
}
export interface RatePackageInstall {
  added: string[];
  closed: string[];
  unchanged: string[];
}
const packageKey = (packageId: string): string => `rate_tables.package.${packageId}`;

/** 시행일 표 저장(D07 rate_tables). 패키지 검증(서명·스키마)은 설치 전에 끝나 있어야 한다. 기간이 겹치면 거부한다 */
export class RateTableRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  list(kind?: RateTableKind): RateTableRow[] {
    const rows = kind
      ? this.db.prepare('SELECT * FROM rate_tables WHERE kind = ? ORDER BY effective_from').all(kind)
      : this.db.prepare('SELECT * FROM rate_tables ORDER BY kind, effective_from').all();
    return rows.map((r) => toRate(r as Row));
  }

  get(id: string): RateTableRow | null {
    const r = this.db.prepare('SELECT * FROM rate_tables WHERE id = ?').get(id);
    return r ? toRate(r as Row) : null;
  }

  install(t: RateTableRow): void {
    need(validDay(t.effectiveFrom) && (t.effectiveTo === null || (validDay(t.effectiveTo) && t.effectiveTo >= t.effectiveFrom)), 'invalid_effective_range');
    need(t.signatureOk, 'rate_table_unsigned');
    this.db.transaction(() => {
      const same = this.get(t.id);
      if (same) {
        const sig = (x: RateTableRow) => JSON.stringify([x.kind, x.effectiveFrom, x.body, x.rounding, x.packageVersion]);
        need(sig(same) === sig(t), 'rate_table_id_reused');
        if (same.effectiveTo === t.effectiveTo) return;
        need(same.effectiveTo === null && t.effectiveTo !== null, 'rate_table_id_reused');
        for (const o of this.list(t.kind)) if (o.id !== t.id) need(!rateSpansConflict(o, t), 'rate_table_overlap');
        this.db.prepare('UPDATE rate_tables SET effective_to = ? WHERE id = ?').run(t.effectiveTo, t.id);
        return;
      }
      for (const o of this.list(t.kind)) need(!rateSpansConflict(o, t), 'rate_table_overlap');
      this.db
        .prepare('INSERT INTO rate_tables (id, kind, effective_from, effective_to, body_json, rounding, package_version, signature_ok) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(t.id, t.kind, t.effectiveFrom, t.effectiveTo, JSON.stringify(t.body), t.rounding, t.packageVersion, 1);
    })();
  }

  installedPackage(packageId: string): InstalledRatePackage | null {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(packageKey(packageId)) as string | undefined;
    return v ? (JSON.parse(v) as InstalledRatePackage) : null;
  }

  installPackage(pkg: { id: string; version: string; digest: string }, rows: readonly RateTableRow[], at: string = new Date().toISOString()): RatePackageInstall {
    need(/^[a-z0-9]+(\.[a-z0-9_-]+)+$/.test(pkg.id) && pkg.id.length <= 128, 'invalid_package_id');
    need(/^\d+\.\d+\.\d+$/.test(pkg.version), 'invalid_package_version');
    need(/^[0-9a-f]{64}$/.test(pkg.digest), 'invalid_package_digest');
    need(rows.length > 0, 'empty_package');
    const out: RatePackageInstall = { added: [], closed: [], unchanged: [] };
    this.db.transaction(() => {
      for (const t of rows) {
        const same = this.get(t.id);
        this.install(same ? { ...t, packageVersion: same.packageVersion } : t);
        (!same ? out.added : same.effectiveTo === t.effectiveTo ? out.unchanged : out.closed).push(t.id);
      }
      const rec: InstalledRatePackage = { version: pkg.version, digest: pkg.digest, installedAt: at };
      this.db
        .prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json')
        .run(packageKey(pkg.id), JSON.stringify(rec));
    })();
    return out;
  }

  effectiveOn(kind: RateTableKind, day: string): RateTableRow | null {
    const r = this.db.prepare(`SELECT * FROM rate_tables WHERE kind = ? AND signature_ok = 1 AND effective_from <= ? ORDER BY effective_from DESC LIMIT 1`).get(kind, day);
    if (!r) return null;
    const t = toRate(r as Row);
    return t.effectiveTo === null || t.effectiveTo >= day ? t : null;
  }
}
