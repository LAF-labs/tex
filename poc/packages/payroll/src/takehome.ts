import { computePayroll, type PayItemOut, type PayrollResult } from './payroll.ts';
import { hourlyPay, monthHours, type ShiftLike } from './shifts.ts';
import { TableError, type NontaxKind, type TableSet } from './tables.ts';

/** 직원 설정값(@sax/db Employee에서 온다) */
export interface TakeHomeSettings {
  nontax: Partial<Record<NontaxKind, number>>;
  dependents: number;
  children8to20: number;
  withholdingPct: 80 | 100 | 120;
  pensionApplies: boolean;
  healthApplies: boolean;
  employmentApplies: boolean;
  pensionBase?: number | null;
  healthBase?: number | null;
}

export interface TakeHomeInput {
  month: string;
  gross: number;
  settings: TakeHomeSettings;
}

export interface TakeHomeResult {
  gross: number;
  nontax: number;
  taxable: number;
  incomeTax: number;
  localIncomeTax: number;
  pension: number;
  health: number;
  ltc: number;
  employment: number;
  totalDeduction: number;
  net: number;
  items: PayItemOut[];
  deductionCalc: PayrollResult['deductionCalc'];
  notes: string[];
  rateTableIds: string[];
}

/** 세전 금액 → 세후 금액 */
export function takeHome(input: TakeHomeInput, tables: TableSet): TakeHomeResult {
  const { gross, settings: st } = input;
  if (!Number.isSafeInteger(gross) || gross < 0) throw new TableError('invalid_gross');
  const nontaxTotal = Object.values(st.nontax).reduce<number>((a, b) => a + (b ?? 0), 0);
  if (nontaxTotal > gross) throw new TableError('nontax_exceeds_gross');
  const r = computePayroll(
    {
      month: input.month,
      employee: {
        payType: 'monthly',
        basePay: gross - nontaxTotal,
        nontax: st.nontax,
        dependents: st.dependents,
        children8to20: st.children8to20,
        withholdingPct: st.withholdingPct,
        pensionApplies: st.pensionApplies,
        healthApplies: st.healthApplies,
        employmentApplies: st.employmentApplies,
        pensionBase: st.pensionBase ?? null,
        healthBase: st.healthBase ?? null,
      },
    },
    tables,
  );
  const totalDeduction = r.incomeTax + r.localIncomeTax + r.pensionEst + r.healthEst + r.ltcEst + r.employmentEst;
  return {
    gross: r.gross,
    nontax: r.nontax,
    taxable: r.gross - r.nontax,
    incomeTax: r.incomeTax,
    localIncomeTax: r.localIncomeTax,
    pension: r.pensionEst,
    health: r.healthEst,
    ltc: r.ltcEst,
    employment: r.employmentEst,
    totalDeduction,
    net: r.gross - totalDeduction,
    items: r.items,
    deductionCalc: r.deductionCalc,
    notes: r.notes,
    rateTableIds: r.rateTableIds,
  };
}

/** 근무표 보조 입력: 그달 근무 합계 × 시급 = 세전 제안값(사장님이 고쳐 쓴다). 가산·주휴는 넣지 않는다 */
export function suggestGross(month: string, hourlyWage: number, shifts: readonly ShiftLike[]): { workDays: number; workMinutes: number; suggestedGross: number } {
  const h = monthHours(month, shifts);
  return { workDays: h.workDays, workMinutes: h.workMinutes, suggestedGross: hourlyPay(hourlyWage, h.workMinutes) };
}
