import { insurance, type InsuranceResult } from './insurance.ts';
import { won } from './money.ts';
import { hourlyPay, monthHours, type ShiftLike } from './shifts.ts';
import { TableError, tableIds, type EmployerSizeBand, type NontaxKind, type TableSet } from './tables.ts';
import { withholding } from './withholding.ts';

/** 급여 계산에 필요한 직원 정보(@sax/db Employee의 부분집합) */
export interface PayrollEmployee {
  payType: 'monthly' | 'hourly';
  basePay: number;
  nontax: Partial<Record<NontaxKind, number>>;
  dependents: number;
  children8to20: number;
  withholdingPct: 80 | 100 | 120;
  pensionApplies: boolean;
  healthApplies: boolean;
  employmentApplies: boolean;
  pensionBase: number | null;
  healthBase: number | null;
}

export interface ExtraItem {
  name: string;
  amount: number;
  calc: string;
}

export interface NoticeAmounts {
  pension: number | null;
  health: number | null;
  ltc: number | null;
  employment: number | null;
}

export interface PayrollInput {
  month: string;
  employee: PayrollEmployee;
  extras?: ExtraItem[];
  workDays?: number | null;
  workMinutes?: number | null;
  shifts?: readonly ShiftLike[];
  notices?: Partial<NoticeAmounts>;
  employerSize?: EmployerSizeBand;
  industrialAccidentPpm?: number | null;
}

export interface PayItemOut {
  name: string;
  amount: number;
  taxable: boolean;
  calc: string;
}

export interface PayrollResult {
  workDays: number | null;
  workMinutes: number | null;
  overtimeMinutes: number | null;
  nightMinutes: number | null;
  holidayMinutes: number | null;
  items: PayItemOut[];
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
  employer: {
    pensionEst: number;
    healthEst: number;
    ltcEst: number;
    employmentEst: number;
    industrialAccidentEst: number | null;
    pensionNotice: null;
    healthNotice: null;
    ltcNotice: null;
    employmentNotice: null;
    industrialAccidentNotice: null;
  };
  netPay: number;
  deductionCalc: Record<'incomeTax' | 'localIncomeTax' | 'pension' | 'health' | 'ltc' | 'employment', string>;
  notes: string[];
  rateTableIds: string[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const int = (n: unknown, min = 0): boolean => typeof n === 'number' && Number.isSafeInteger(n) && n >= min;

export function computePayroll(input: PayrollInput, tables: TableSet): PayrollResult {
  const e = input.employee;
  if (!MONTH.test(input.month)) throw new TableError('invalid_month');
  if (!int(e.basePay)) throw new TableError('invalid_base_pay');
  const notes: string[] = [];
  for (const t of [tables.simpleTax, tables.insurance, tables.pensionBounds, tables.nontax]) if (t.review !== 'confirmed') notes.push(`table_needs_review:${t.id}`);

  const items: PayItemOut[] = [];
  let workDays = input.workDays ?? null;
  let workMinutes = input.workMinutes ?? null;
  if (e.payType === 'monthly') {
    items.push({ name: '기본급', amount: e.basePay, taxable: true, calc: '월급' });
  } else {
    if (!input.shifts) throw new TableError('hourly_needs_shifts');
    const h = monthHours(input.month, input.shifts);
    workDays = h.workDays;
    workMinutes = h.workMinutes;
    items.push({ name: '기본급', amount: hourlyPay(e.basePay, h.workMinutes), taxable: true, calc: `시급 ${won(e.basePay)} × ${formatMinutes(h.workMinutes)}` });
  }

  for (const x of input.extras ?? []) {
    if (!x.name.trim() || !Number.isSafeInteger(x.amount)) throw new TableError('invalid_extra');
    items.push({ name: x.name.trim(), amount: x.amount, taxable: true, calc: x.calc });
  }

  for (const [kind, amount] of Object.entries(e.nontax) as Array<[NontaxKind, number]>) {
    if (!int(amount)) throw new TableError('invalid_nontax');
    if (amount === 0) continue;
    const lim = tables.nontax.body.kinds[kind];
    if (!lim) throw new TableError(`nontax_unknown_kind:${kind}`);
    const free = Math.min(amount, lim.monthlyLimit);
    items.push({ name: lim.label, amount: free, taxable: false, calc: `월 ${won(lim.monthlyLimit)} 한도 비과세(${lim.basis})` });
    if (amount > free) {
      items.push({ name: `${lim.label}(한도 초과분)`, amount: amount - free, taxable: true, calc: `한도 ${won(lim.monthlyLimit)}를 넘는 금액은 과세` });
      notes.push(`nontax_over_limit:${kind}`);
    }
  }

  const gross = items.reduce((s, i) => s + i.amount, 0);
  const nontax = items.filter((i) => !i.taxable).reduce((s, i) => s + i.amount, 0);
  const taxable = gross - nontax;
  if (taxable < 0) throw new TableError('negative_taxable_pay');

  const w = withholding(tables.simpleTax, { monthlyTaxablePay: taxable, dependents: e.dependents, children8to20: e.children8to20, pct: e.withholdingPct });
  const ins: InsuranceResult = insurance(tables.insurance, tables.pensionBounds, {
    monthlyTaxablePay: taxable,
    pensionBase: e.pensionBase,
    healthBase: e.healthBase,
    pensionApplies: e.pensionApplies,
    healthApplies: e.healthApplies,
    employmentApplies: e.employmentApplies,
    employerSize: input.employerSize ?? 'under150',
    industrialAccidentPpm: input.industrialAccidentPpm ?? null,
  });

  const n = { pension: null, health: null, ltc: null, employment: null, ...input.notices } as NoticeAmounts;
  for (const v of Object.values(n)) if (v !== null && !int(v)) throw new TableError('invalid_notice');
  const used = {
    pension: n.pension ?? ins.employee.pension,
    health: n.health ?? ins.employee.health,
    ltc: n.ltc ?? ins.employee.ltc,
    employment: n.employment ?? ins.employee.employment,
  };
  for (const k of ['pension', 'health', 'ltc', 'employment'] as const) {
    if (n[k] === null && (k === 'pension' ? e.pensionApplies : k === 'employment' ? e.employmentApplies : e.healthApplies)) notes.push(`insurance_estimate:${k}`);
    else if (n[k] !== null && n[k] !== ins.employee[k]) notes.push(`insurance_notice_differs:${k}`);
  }

  const netPay = gross - w.incomeTax - w.localIncomeTax - used.pension - used.health - used.ltc - used.employment;
  return {
    workDays,
    workMinutes,
    overtimeMinutes: null,
    nightMinutes: null,
    holidayMinutes: null,
    items,
    gross,
    nontax,
    incomeTax: w.incomeTax,
    localIncomeTax: w.localIncomeTax,
    pensionEst: ins.employee.pension,
    healthEst: ins.employee.health,
    ltcEst: ins.employee.ltc,
    employmentEst: ins.employee.employment,
    pensionNotice: n.pension,
    healthNotice: n.health,
    ltcNotice: n.ltc,
    employmentNotice: n.employment,
    employer: {
      pensionEst: ins.employer.pension,
      healthEst: ins.employer.health,
      ltcEst: ins.employer.ltc,
      employmentEst: ins.employer.employment,
      industrialAccidentEst: ins.employer.industrialAccident,
      pensionNotice: null,
      healthNotice: null,
      ltcNotice: null,
      employmentNotice: null,
      industrialAccidentNotice: null,
    },
    netPay,
    deductionCalc: {
      incomeTax: w.calc,
      localIncomeTax: w.localCalc,
      pension: n.pension === null ? ins.calc.pension : '공단 고지액',
      health: n.health === null ? ins.calc.health : '공단 고지액',
      ltc: n.ltc === null ? ins.calc.ltc : '공단 고지액',
      employment: n.employment === null ? ins.calc.employment : '공단 고지액',
    },
    notes,
    rateTableIds: tableIds(tables),
  };
}

/** 9,450분 → "157시간 30분" */
export function formatMinutes(m: number): string {
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}시간 ${r}분` : `${h}시간`;
}

/** 원천세 요약(ADR-031 결정 6): 꾸러미 시트용. 인원·총지급액·소득세·지방소득세만. 신고서가 아니다 */
export interface WithholdingSummary {
  month: string;
  headcount: number;
  totalGross: number;
  totalNontax: number;
  totalIncomeTax: number;
  totalLocalIncomeTax: number;
}

export function withholdingSummary(month: string, lines: ReadonlyArray<Pick<PayrollResult, 'gross' | 'nontax' | 'incomeTax' | 'localIncomeTax'>>): WithholdingSummary {
  return {
    month,
    headcount: lines.length,
    totalGross: lines.reduce((s, l) => s + l.gross, 0),
    totalNontax: lines.reduce((s, l) => s + l.nontax, 0),
    totalIncomeTax: lines.reduce((s, l) => s + l.incomeTax, 0),
    totalLocalIncomeTax: lines.reduce((s, l) => s + l.localIncomeTax, 0),
  };
}
