import path from 'node:path';
import {
  BundleExportRepo, BundleRepo, CardRepo, ColumnCipherError, DocumentRepo, EmployeeRepo, PayrollRepo, ProfileRepo, RateTableRepo, ShiftRepo, ValidationError,
  type BundleCadence, type ColumnCipher, type Db, type Employee,
} from '@sax/db';
import {
  availableTables, checkStatementCompleteness, computePayroll, loadBundledPackage, pickTables, RATE_TABLES_PACKAGE_ID, ShiftError, statementFromPayroll, TableError, tableIds,
  takeHome, withholdingSummary, type EmployerSizeBand, type ExtraItem, type NoticeAmounts, type PayrollEmployee, type PayrollResult, type TableSet, type TakeHomeSettings,
} from '@sax/payroll';
import { exportBundle, exportPayrollRecord, generatePassword } from './export.ts';
import { addCustomItem, BundleError, ensureItems, INDUSTRIES, type Industry } from './items.ts';
import { missingView } from './missing-view.ts';
import { clearCardSlipEnough, markCardSlipEnough, missingReport, monthStatus, type MonthContext, type TaxInvoiceRow } from './month.ts';
import { daemonSnapshot, type DaemonSnapshotSources } from './daemon-snapshot.ts';
import { requestCandidates } from './request-paste.ts';
import { cardMonthView } from './card-view.ts';
import { cashMonthView, cashPut, cashRemove, PcEntryError, receiptConfirm, receiptMonthView, setEntry } from './pc-entry.ts';
import { carryOver, EmployeeInputError, employeeInput, employeePatch, employeeView, ownEmployee } from './employees.ts';
import { confirmNoticeCard, noticeConfirmCard, type InsuranceKind, type InsuranceNoticeMatchInput } from './notice-match.ts';

type Params = Record<string, unknown>;

export class BundleServiceError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new BundleServiceError(code);
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const isObj = (v: unknown): v is Params => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const month = (v: unknown): string => (typeof v === 'string' && MONTH.test(v) ? v : fail('bad_month'));
const optMonth = (v: unknown): string | undefined => (v === undefined || v === null ? undefined : month(v));
const day = (v: unknown, code: string): string => (typeof v === 'string' && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : fail(code));
const bool = (v: unknown, code: string): boolean => (typeof v === 'boolean' ? v : fail(code));
const text = (v: unknown, code: string, max = 200): string => (typeof v === 'string' && v.trim() && v.length <= max ? v : fail(code));
const optText = (v: unknown, code: string, max = 200): string | null => (v === undefined || v === null ? null : typeof v === 'string' && v.length <= max ? v : fail(code));
const nullableInt = (v: unknown, code: string): number | null => (v === undefined || v === null ? null : isInt(v) ? v : fail(code));
const idOf = (v: unknown, code: string): string => (typeof v === 'string' && v && v.length <= 64 ? v : fail(code));

const NOTICE_KINDS = ['pension', 'health', 'ltc', 'employment'] as const;
const INSURANCE_KINDS: readonly InsuranceKind[] = ['pension', 'health', 'ltc', 'employment', 'industrial'];
const EMPLOYER_SIZES: readonly EmployerSizeBand[] = ['under150', 'priority150plus', 'from150to999', 'over1000'];
const CADENCES: readonly BundleCadence[] = ['monthly', 'quarterly', 'once'];
const MAX_ROWS = 2000;

function extras(v: unknown): ExtraItem[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 50) return fail('bad_extras');
  return v.map((x): ExtraItem => {
    if (!isObj(x) || !Number.isSafeInteger(x.amount)) return fail('bad_extras');
    return { name: text(x.name, 'bad_extras', 50), amount: x.amount as number, calc: typeof x.calc === 'string' && x.calc.length <= 200 ? x.calc : fail('bad_extras') };
  });
}

function notices(v: unknown): Partial<NoticeAmounts> | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) return fail('bad_notices');
  const out: Partial<NoticeAmounts> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!(NOTICE_KINDS as readonly string[]).includes(k)) return fail('bad_notices');
    out[k as (typeof NOTICE_KINDS)[number]] = nullableInt(n, 'bad_notices');
  }
  return out;
}

interface LineInput {
  extras?: ExtraItem[];
  workDays?: number | null;
  workMinutes?: number | null;
  notices?: Partial<NoticeAmounts>;
}

function lineInputs(v: unknown): Map<string, LineInput> {
  const out = new Map<string, LineInput>();
  if (v === undefined || v === null) return out;
  if (!isObj(v)) return fail('bad_inputs');
  for (const [employeeId, x] of Object.entries(v)) {
    if (!isObj(x)) return fail('bad_inputs');
    out.set(employeeId, {
      extras: extras(x.extras),
      workDays: nullableInt(x.workDays, 'bad_work_days'),
      workMinutes: nullableInt(x.workMinutes, 'bad_work_minutes'),
      notices: notices(x.notices),
    });
  }
  return out;
}

function takeHomeSettings(v: unknown): TakeHomeSettings {
  if (!isObj(v)) return fail('bad_settings');
  const nontax = v.nontax === undefined ? {} : isObj(v.nontax) ? (v.nontax as TakeHomeSettings['nontax']) : fail('bad_settings');
  return {
    nontax,
    dependents: v.dependents as number,
    children8to20: v.children8to20 as number,
    withholdingPct: v.withholdingPct as TakeHomeSettings['withholdingPct'],
    pensionApplies: bool(v.pensionApplies, 'bad_settings'),
    healthApplies: bool(v.healthApplies, 'bad_settings'),
    employmentApplies: bool(v.employmentApplies, 'bad_settings'),
    pensionBase: nullableInt(v.pensionBase, 'bad_settings'),
    healthBase: nullableInt(v.healthBase, 'bad_settings'),
  };
}

function noticeRows(v: unknown): InsuranceNoticeMatchInput['rows'] {
  if (!Array.isArray(v) || v.length > MAX_ROWS) return fail('bad_notice_rows');
  return v.map((r) => {
    if (!isObj(r) || !(INSURANCE_KINDS as readonly unknown[]).includes(r.insurance)) return fail('bad_notice_rows');
    return {
      rowId: idOf(r.rowId, 'bad_notice_rows'),
      name: text(r.name, 'bad_notice_rows', 50),
      birthDate: r.birthDate === null || r.birthDate === undefined ? null : day(r.birthDate, 'bad_notice_rows'),
      insurance: r.insurance as InsuranceKind,
      base: nullableInt(r.base, 'bad_notice_rows'),
      total: nullableInt(r.total, 'bad_notice_rows'),
      employee: nullableInt(r.employee, 'bad_notice_rows'),
      employer: nullableInt(r.employer, 'bad_notice_rows'),
    };
  });
}

function choices(v: unknown): Record<string, string | null> {
  if (!isObj(v)) return fail('bad_choices');
  for (const c of Object.values(v)) if (c !== null && typeof c !== 'string') return fail('bad_choices');
  return v as Record<string, string | null>;
}

function taxInvoices(v: unknown): TaxInvoiceRow[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 20_000) return fail('bad_tax_invoices');
  return v.map((r): TaxInvoiceRow => {
    if (!isObj(r) || (r.direction !== 'sales' && r.direction !== 'purchase')) return fail('bad_tax_invoices');
    for (const k of ['supplyAmount', 'vatAmount', 'total'] as const) if (!Number.isSafeInteger(r[k])) return fail('bad_tax_invoices');
    return {
      direction: r.direction,
      issueDate: day(r.issueDate, 'bad_tax_invoices'),
      approvalNo: text(r.approvalNo, 'bad_tax_invoices', 64),
      counterpartyBizNo: typeof r.counterpartyBizNo === 'string' && r.counterpartyBizNo.length <= 20 ? r.counterpartyBizNo : fail('bad_tax_invoices'),
      counterpartyName: typeof r.counterpartyName === 'string' && r.counterpartyName.length <= 200 ? r.counterpartyName : fail('bad_tax_invoices'),
      supplyAmount: r.supplyAmount as number,
      vatAmount: r.vatAmount as number,
      total: r.total as number,
    };
  });
}

const toPayrollEmployee = (e: Employee): PayrollEmployee => ({
  payType: e.payType,
  basePay: e.basePay,
  nontax: e.nontax as PayrollEmployee['nontax'],
  dependents: e.dependents,
  children8to20: e.children8to20,
  withholdingPct: e.withholdingPct,
  pensionApplies: e.pensionApplies,
  healthApplies: e.healthApplies,
  employmentApplies: e.employmentApplies,
  pensionBase: e.pensionBase,
  healthBase: e.healthBase,
});

const toLine = (employeeId: string, r: PayrollResult) => ({
  employeeId,
  workDays: r.workDays, workMinutes: r.workMinutes, overtimeMinutes: r.overtimeMinutes, nightMinutes: r.nightMinutes, holidayMinutes: r.holidayMinutes,
  items: r.items, gross: r.gross, nontax: r.nontax, incomeTax: r.incomeTax, localIncomeTax: r.localIncomeTax,
  pensionEst: r.pensionEst, healthEst: r.healthEst, ltcEst: r.ltcEst, employmentEst: r.employmentEst,
  pensionNotice: r.pensionNotice, healthNotice: r.healthNotice, ltcNotice: r.ltcNotice, employmentNotice: r.employmentNotice,
  employer: r.employer, netPay: r.netPay,
});

const payrollEnabledKey = (profileId: string): string => `profile.${profileId}.payroll.enabled`;

export interface BundleServiceOptions {
  exportDir: string;
  now?: () => Date;
  daemon?: DaemonSnapshotSources;
}

/**
 * 급여·꾸러미·S-06 명령. db·cipher는 엔진 entry.ts가 연 것과 DB 키에서 파생한 컬럼 키다(키는 이 프로세스 밖으로 나가지 않는다).
 * 모든 명령은 profileId를 받고, 그 프로필이 없으면 profile_not_found다. 직원·문서·내보내기 기록도 그 프로필 것만 받는다.
 */
export class BundleService {
  private readonly db: Db;
  private readonly cipher: ColumnCipher;
  private readonly opts: BundleServiceOptions;

  constructor(db: Db, cipher: ColumnCipher, opts: BundleServiceOptions) {
    this.db = db;
    this.cipher = cipher;
    this.opts = opts;
  }

  async handle(method: string, p: Params): Promise<unknown> {
    try {
      return await this.dispatch(method, p ?? {});
    } catch (e) {
      if (e instanceof BundleServiceError) throw e;
      if (e instanceof ValidationError || e instanceof TableError || e instanceof ShiftError || e instanceof BundleError || e instanceof ColumnCipherError || e instanceof EmployeeInputError || e instanceof PcEntryError) throw new BundleServiceError(e.code);
      throw e;
    }
  }

  private profile(v: unknown): string {
    if (typeof v !== 'string' || !v || !new ProfileRepo(this.db).get(v)) return fail('profile_not_found');
    return v;
  }

  private payrollEnabled(profileId: string): boolean {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(payrollEnabledKey(profileId)) as string | undefined;
    if (v !== undefined) return JSON.parse(v) === true;
    return new EmployeeRepo(this.db, this.cipher).list(profileId).length > 0;
  }

  private ctx(p: Params): MonthContext {
    const profileId = this.profile(p.profileId);
    return { db: this.db, cipher: this.cipher, profileId, month: month(p.month), payrollEnabled: this.payrollEnabled(profileId), taxInvoices: taxInvoices(p.taxInvoices) };
  }

  private outDir(profileId: string): string {
    return path.join(this.opts.exportDir, profileId);
  }

  private tables(taxDate: string, monthValue: string): TableSet {
    return pickTables(availableTables(new RateTableRepo(this.db).list(), loadBundledPackage()), { taxDate, insuranceDate: `${monthValue}-01` });
  }

  private compute(p: Params) {
    const profileId = this.profile(p.profileId);
    const m = month(p.month);
    const paidOn = day(p.paidOn, 'bad_paid_on');
    const inputs = lineInputs(p.inputs);
    const employerSize = p.employerSize === undefined || p.employerSize === null ? undefined : EMPLOYER_SIZES.includes(p.employerSize as EmployerSizeBand) ? (p.employerSize as EmployerSizeBand) : fail('bad_employer_size');
    const industrialAccidentPpm = nullableInt(p.industrialAccidentPpm, 'bad_industrial_accident_ppm');
    const T = this.tables(paidOn, m);
    const employees = new EmployeeRepo(this.db, this.cipher).list(profileId, { activeInMonth: m });
    for (const k of inputs.keys()) if (!employees.some((e) => e.id === k)) fail('employee_not_found');
    const shifts = new ShiftRepo(this.db);
    const lines = employees.map((e) => {
      const x = inputs.get(e.id) ?? {};
      const result = computePayroll(
        {
          month: m, employee: toPayrollEmployee(e), extras: x.extras, workDays: x.workDays, workMinutes: x.workMinutes, notices: x.notices, employerSize, industrialAccidentPpm,
          ...(e.payType === 'hourly' ? { shifts: shifts.month(profileId, e.id, m) } : {}),
        },
        T,
      );
      const statementMissing = checkStatementCompleteness(statementFromPayroll(result, { name: e.name, birthDate: e.birthDate, payDate: paidOn })).missing;
      return { employeeId: e.id, name: e.name, result, statementMissing };
    });
    return { profileId, month: m, paidOn, rateTableIds: tableIds(T), lines, summary: withholdingSummary(m, lines.map((l) => l.result)) };
  }

  private noticeInput(p: Params): InsuranceNoticeMatchInput {
    const profileId = this.profile(p.profileId);
    const noticeDocId = idOf(p.noticeDocId, 'document_not_found');
    if (new DocumentRepo(this.db).get(noticeDocId)?.profileId !== profileId) fail('document_not_found');
    return { profileId, month: month(p.month), noticeDocId, rows: noticeRows(p.rows) };
  }

  private exportRecord(profileId: string, v: unknown) {
    const r = new BundleExportRepo(this.db).get(idOf(v, 'export_not_found'));
    return r && r.profileId === profileId ? r : fail('export_not_found');
  }

  private async dispatch(method: string, p: Params): Promise<unknown> {
    switch (method) {
      case 'db.query.payroll.month': {
        const profileId = this.profile(p.profileId);
        const m = month(p.month);
        const pr = new PayrollRepo(this.db);
        const revisions = pr.revisions(profileId, m);
        const cur = p.revision === undefined || p.revision === null ? (revisions.at(-1) ?? null) : (pr.get(profileId, m, isInt(p.revision, 1) ? p.revision : fail('bad_revision')) ?? fail('not_found'));
        const lines = cur ? pr.lines(profileId, m, cur.revision) : [];
        return { month: m, current: cur, revisions, lines, summary: withholdingSummary(m, lines) };
      }
      case 'db.query.payroll.employees': {
        const profileId = this.profile(p.profileId);
        const repo = new EmployeeRepo(this.db, this.cipher);
        const m = p.month === undefined || p.month === null ? undefined : month(p.month);
        return repo.list(profileId, m ? { activeInMonth: m } : {}).map((e) => employeeView(repo, e));
      }
      case 'db.query.payroll.carryOver':
        return carryOver(this.db, this.cipher, this.profile(p.profileId), month(p.month));
      case 'db.query.payroll.enabled': {
        const profileId = this.profile(p.profileId);
        const set = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(payrollEnabledKey(profileId)) as string | undefined;
        return { enabled: this.payrollEnabled(profileId), source: set === undefined ? 'employees' : 'setting' };
      }
      case 'payroll.setEnabled': {
        const profileId = this.profile(p.profileId);
        const on = bool(p.on, 'bad_on');
        this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(payrollEnabledKey(profileId), JSON.stringify(on));
        return { enabled: on };
      }
      case 'db.query.cash.month':
        return cashMonthView(this.db, this.profile(p.profileId), month(p.month));
      case 'cash.put':
        return cashPut(this.db, this.profile(p.profileId), p.day, p.amount, (this.opts.now?.() ?? new Date()).toISOString());
      case 'cash.remove':
        return cashRemove(this.db, this.profile(p.profileId), p.day);
      case 'db.query.receipt.list':
        return receiptMonthView(this.db, this.profile(p.profileId), month(p.month));
      case 'receipt.confirm':
        return receiptConfirm(this.db, this.profile(p.profileId), p, (this.opts.now?.() ?? new Date()).toISOString());
      case 'bundle.setEntry': {
        const profileId = this.profile(p.profileId);
        return setEntry(this.db, profileId, p, { month: month(p.month), payrollEnabled: this.payrollEnabled(profileId), at: (this.opts.now?.() ?? new Date()).toISOString() });
      }
      case 'payroll.addEmployee': {
        const repo = new EmployeeRepo(this.db, this.cipher);
        return employeeView(repo, repo.create(employeeInput(this.profile(p.profileId), p.employee), (this.opts.now?.() ?? new Date()).toISOString()));
      }
      case 'payroll.updateEmployee': {
        const repo = new EmployeeRepo(this.db, this.cipher);
        const e = ownEmployee(repo, this.profile(p.profileId), p.employeeId);
        return employeeView(repo, repo.update(e.id, employeePatch(p.patch), (this.opts.now?.() ?? new Date()).toISOString()));
      }
      case 'db.query.bundle.status':
        return monthStatus(this.ctx(p));
      case 'db.query.bundle.missing':
        return missingView(missingReport(this.ctx(p)));
      case 'db.query.card.list':
        return cardMonthView(this.db, this.profile(p.profileId), month(p.month), this.opts.now?.() ?? new Date());
      case 'card.setMemo': {
        const profileId = this.profile(p.profileId);
        const repo = new CardRepo(this.db);
        if (!repo.txn(profileId, typeof p.txnId === 'string' ? p.txnId : '')) return fail('not_found');
        if (typeof p.memo !== 'string') return fail('bad_memo');
        return repo.setMemo(p.txnId as string, p.memo);
      }
      case 'card.reattachMemo': {
        const profileId = this.profile(p.profileId);
        return new CardRepo(this.db).reattachMemo(profileId, typeof p.memoId === 'string' ? p.memoId : '', typeof p.txnId === 'string' ? p.txnId : '');
      }
      case 'card.deleteMemo': {
        const profileId = this.profile(p.profileId);
        return { deleted: new CardRepo(this.db).deleteMemo(profileId, typeof p.memoId === 'string' ? p.memoId : '') };
      }
      case 'db.query.rateTables.installed': {
        const installed = new RateTableRepo(this.db).installedPackage(RATE_TABLES_PACKAGE_ID);
        const tables = availableTables(new RateTableRepo(this.db).list(), loadBundledPackage()).map((t) => ({ id: t.id, kind: t.kind, effectiveFrom: t.effectiveFrom, effectiveTo: t.effectiveTo, review: t.review }));
        return { packageId: RATE_TABLES_PACKAGE_ID, installed, tables };
      }

      case 'payroll.compute':
        return this.compute(p);
      case 'payroll.saveDraft': {
        const noticeDocIds = p.noticeDocIds === undefined ? undefined : Array.isArray(p.noticeDocIds) && p.noticeDocIds.length <= 20 ? p.noticeDocIds.map((d) => idOf(d, 'document_not_found')) : fail('bad_notice_doc_ids');
        const c = this.compute(p);
        const docs = new DocumentRepo(this.db);
        for (const d of noticeDocIds ?? []) if (docs.get(d)?.profileId !== c.profileId) fail('document_not_found');
        const pr = new PayrollRepo(this.db);
        return this.db.transaction(() => {
          const draft = pr.openDraft(c.profileId, c.month, c.rateTableIds, c.paidOn);
          pr.updateDraft(c.profileId, c.month, draft.revision, { paidOn: c.paidOn, rateTableIds: c.rateTableIds, ...(noticeDocIds ? { noticeDocIds: [...new Set(noticeDocIds)] } : {}) });
          const keep = new Set(c.lines.map((l) => l.employeeId));
          for (const old of pr.lines(c.profileId, c.month, draft.revision)) if (!keep.has(old.employeeId)) pr.removeLine(c.profileId, c.month, draft.revision, old.employeeId);
          for (const l of c.lines) pr.putLine(c.profileId, c.month, draft.revision, toLine(l.employeeId, l.result));
          return { ...c, draft: pr.get(c.profileId, c.month, draft.revision) };
        })();
      }
      case 'payroll.confirm': {
        const profileId = this.profile(p.profileId);
        return new PayrollRepo(this.db).confirm(profileId, month(p.month), isInt(p.revision, 1) ? p.revision : fail('bad_revision'), (this.opts.now?.() ?? new Date()).toISOString());
      }
      case 'payroll.revise':
        return new PayrollRepo(this.db).revise(this.profile(p.profileId), month(p.month));
      case 'payroll.takeHome': {
        this.profile(p.profileId);
        const m = month(p.month);
        const T = this.tables(p.paidOn === undefined || p.paidOn === null ? `${m}-01` : day(p.paidOn, 'bad_paid_on'), m);
        return takeHome({ month: m, gross: p.gross as number, settings: takeHomeSettings(p.settings) }, T);
      }

      case 'notice.card':
        return noticeConfirmCard(this.db, this.cipher, this.noticeInput(p));
      case 'notice.confirm': {
        const input = this.noticeInput(p);
        const map = confirmNoticeCard(noticeConfirmCard(this.db, this.cipher, input), choices(p.choices));
        return { month: input.month, noticeDocId: input.noticeDocId, notices: Object.fromEntries(map) };
      }

      case 'bundle.ensureItems': {
        const profileId = this.profile(p.profileId);
        const industries = Array.isArray(p.industries) && p.industries.every((i) => INDUSTRIES.includes(i as Industry)) ? (p.industries as Industry[]) : fail('bad_industries');
        return ensureItems(new BundleRepo(this.db), profileId, industries);
      }
      case 'bundle.addItem': {
        const profileId = this.profile(p.profileId);
        const cadence = CADENCES.includes(p.cadence as BundleCadence) ? (p.cadence as BundleCadence) : fail('bad_cadence');
        const source = p.source === undefined || p.source === 'user' ? 'user' : p.source === 'pasted_request' ? 'pasted_request' : fail('bad_item_source');
        return addCustomItem(new BundleRepo(this.db), profileId, text(p.name, 'bad_item_name', 60), cadence, source);
      }
      case 'bundle.requestCandidates': {
        const profileId = this.profile(p.profileId);
        return { candidates: requestCandidates({ text: p.text as string, items: new BundleRepo(this.db).items(profileId) }) };
      }
      case 'bundle.cardSlipEnough': {
        const profileId = this.profile(p.profileId);
        if (bool(p.on, 'bad_on')) return { from: markCardSlipEnough(this.db, profileId, month(p.month)) };
        clearCardSlipEnough(this.db, profileId);
        return { from: null };
      }
      case 'bundle.setIncludeRrn': {
        const profileId = this.profile(p.profileId);
        const on = bool(p.on, 'bad_on');
        new BundleRepo(this.db).setIncludeRrn(profileId, on);
        return { includeRrn: on };
      }
      case 'bundle.export': {
        const ctx = this.ctx(p);
        const password = generatePassword();
        const r = await exportBundle({ ...ctx, outDir: this.outDir(ctx.profileId), password, now: this.opts.now });
        return { ...r, password };
      }
      case 'bundle.markOpened': {
        const profileId = this.profile(p.profileId);
        const rec = this.exportRecord(profileId, p.exportId);
        const via = p.via === 'mail_client' || p.via === 'folder' ? p.via : fail('bad_via');
        new BundleExportRepo(this.db).markOpened(rec.id, via, optText(p.sentTo, 'bad_sent_to', 320));
        return new BundleExportRepo(this.db).get(rec.id);
      }
      case 'bundle.markSent': {
        const profileId = this.profile(p.profileId);
        const rec = this.exportRecord(profileId, p.exportId);
        new BundleExportRepo(this.db).markSent(rec.id, optText(p.note, 'bad_note', 500), (this.opts.now?.() ?? new Date()).toISOString());
        return new BundleExportRepo(this.db).get(rec.id);
      }
      case 'payroll.exportRecord': {
        const profileId = this.profile(p.profileId);
        const password = generatePassword();
        const r = await exportPayrollRecord({ db: this.db, cipher: this.cipher, profileId, outDir: this.outDir(profileId), password, fromMonth: optMonth(p.fromMonth), toMonth: optMonth(p.toMonth), now: this.opts.now });
        return { ...r, password };
      }
      case 'daemon.snapshot':
        return daemonSnapshot(this.db, this.cipher, this.opts.daemon ?? { policy: () => null, status: () => null }, {
          now: this.opts.now?.() ?? new Date(),
          payrollEnabled: (id) => this.payrollEnabled(id),
        });
      default:
        return fail('unknown_method');
    }
  }
}
