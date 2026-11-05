// 급여대장 한 줄 계산(ADR-031, 02 §16). 결과는 사장님이 확인한다. 모델을 부르지 않는 결정적 산술이다.
// 지급 항목 → 비과세 한도 적용(넘는 만큼 과세) → 원천징수(간이세액표) → 4대보험 예상치 → 고지액이 있으면 그것을 공제에 쓴다 → 실지급액.
import { insurance, type InsuranceResult } from './insurance.ts';
import { won } from './money.ts';
import { hourlyPay, monthHours, type ShiftLike } from './shifts.ts';
import { TableError, tableIds, type EmployerSizeBand, type NontaxKind, type TableSet } from './tables.ts';
import { withholding } from './withholding.ts';

/** 급여 계산에 필요한 직원 정보(@sax/db Employee의 부분집합) */
export interface PayrollEmployee {
  payType: 'monthly' | 'hourly';
  /** monthly면 월급, hourly면 시급 */
  basePay: number;
  /** 비과세 종류 코드 → 월 금액 */
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
  /** 수당은 양수, 결근 공제 같은 차감은 음수 */
  amount: number;
  /** 임금명세서의 계산방법 문장. 이 항목은 과세다. 비과세는 직원의 nontax 칸으로 넣는다(한도 검사) */
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
  /** 이달만 바뀐 수당·공제(과세) */
  extras?: ExtraItem[];
  /** 월급제의 근로일수·시간(임금대장 기재). 시급제는 shifts에서 계산한다 */
  workDays?: number | null;
  workMinutes?: number | null;
  /** 시급제: 이달 근무표 */
  shifts?: readonly ShiftLike[];
  /** 공단 고지액(근로자 부담). 있으면 공제에 이 값을 쓴다(정본) */
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
  /** 공제 칸별 계산방법 문장(임금명세서) */
  deductionCalc: Record<'incomeTax' | 'localIncomeTax' | 'pension' | 'health' | 'ltc' | 'employment', string>;
  /** 사장님에게 보일 확인 표시(판정 아님). 예: nontax_over_limit:meal, table_needs_review:<id> */
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

  // 비과세: 한도까지만 비과세, 넘는 만큼은 과세 항목으로 나눈다
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
