// 세전 → 세후 계산기(yulmu 확답 2026-11-05, D14 M6-8·M6-15 범위). 급여대장의 핵심 API다.
// 세전 금액(비과세 포함)과 직원 설정값(비과세 항목·공제대상가족·8~20세 자녀·원천징수 비율·보험 적용)을 받아
// 간이세액표 원천징수·지방소득세·4대보험 근로자 부담분을 빼고 세후 금액을 낸다. 신고세액 계산이 아니다.
// 연장·야간·휴일 가산과 주휴는 계산하지 않는다(사장님이 세전 금액에 반영). 근무표는 세전 제안값(suggestGross)까지만.
import { computePayroll, type PayItemOut, type PayrollResult } from './payroll.ts';
import { hourlyPay, monthHours, type ShiftLike } from './shifts.ts';
import { TableError, type NontaxKind, type TableSet } from './tables.ts';

/** 직원 설정값(@sax/db Employee에서 온다) */
export interface TakeHomeSettings {
  /** 비과세 종류 코드 → 그달 금액(세전 금액 안에 들어 있는 몫) */
  nontax: Partial<Record<NontaxKind, number>>;
  dependents: number;
  children8to20: number;
  withholdingPct: 80 | 100 | 120;
  pensionApplies: boolean;
  healthApplies: boolean;
  employmentApplies: boolean;
  /** 고지내역의 기준소득월액·보수월액. 없으면 과세 급여로 예상 */
  pensionBase?: number | null;
  healthBase?: number | null;
}

export interface TakeHomeInput {
  /** 귀속 월 'YYYY-MM' */
  month: string;
  /** 세전 금액(그달 지급 총액, 비과세 포함, 원) */
  gross: number;
  settings: TakeHomeSettings;
}

export interface TakeHomeResult {
  gross: number;
  /** 한도 안의 비과세 */
  nontax: number;
  /** 원천징수 기준 월급여액(세전 − 비과세) */
  taxable: number;
  incomeTax: number;
  localIncomeTax: number;
  pension: number;
  health: number;
  ltc: number;
  employment: number;
  totalDeduction: number;
  /** 세후 금액 */
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
