// 4대보험 근로자·사업주 부담 예상치(ADR-031 결정 4·5). 정본은 공단 고지액이고, 이 값은 "예상"이다. 차이는 표시만 한다.
// 국민연금: 기준소득월액(천원 미만 절사, 상·하한) × 요율. 건강: 보수월액 × 요율. 장기요양: 건강보험료 × (장기요양률 ÷ 건강보험료율).
// 고용: 보수 × 요율(사업주는 실업급여 + 고용안정·직업능력개발 규모 구간). 산재는 업종별 사업주 전액이라 사장님이 넣은 요율이 있을 때만.
import { applyPpm, applyRatio, roundWon, ppmPct, won } from './money.ts';
import type { EmployerSizeBand, RateTable } from './tables.ts';

export interface InsuranceInput {
  /** 그달 과세 보수(비과세 제외) */
  monthlyTaxablePay: number;
  /** 국민연금 기준소득월액(고지내역). 없으면 과세 보수로 예상 */
  pensionBase: number | null;
  /** 건강보험 보수월액(고지내역). 없으면 과세 보수로 예상 */
  healthBase: number | null;
  pensionApplies: boolean;
  healthApplies: boolean;
  employmentApplies: boolean;
  employerSize: EmployerSizeBand;
  /** 산재보험 요율(ppm, 사업주 전액). 모르면 null → 산재 예상치 없음 */
  industrialAccidentPpm: number | null;
}

export interface InsuranceShare {
  pension: number;
  health: number;
  ltc: number;
  employment: number;
}

export interface InsuranceResult {
  employee: InsuranceShare;
  employer: InsuranceShare & { industrialAccident: number | null };
  pensionBaseUsed: number | null;
  healthBaseUsed: number | null;
  calc: Record<keyof InsuranceShare, string>;
}

export function insurance(rates: RateTable<'insurance_rate'>, bounds: RateTable<'pension_bounds'>, i: InsuranceInput): InsuranceResult {
  const r = rates.body;
  const calc: Record<keyof InsuranceShare, string> = { pension: '적용 안 함', health: '적용 안 함', ltc: '적용 안 함', employment: '적용 안 함' };
  const employee: InsuranceShare = { pension: 0, health: 0, ltc: 0, employment: 0 };
  const employer: InsuranceShare & { industrialAccident: number | null } = { pension: 0, health: 0, ltc: 0, employment: 0, industrialAccident: null };

  let pensionBaseUsed: number | null = null;
  if (i.pensionApplies) {
    const b = bounds.body;
    const raw = roundWon(i.pensionBase ?? i.monthlyTaxablePay, b.baseRounding);
    pensionBaseUsed = Math.min(b.maxBase, Math.max(b.minBase, raw));
    employee.pension = applyPpm(pensionBaseUsed, r.pension.employeePpm, r.pension.rounding);
    employer.pension = applyPpm(pensionBaseUsed, r.pension.employerPpm, r.pension.rounding);
    calc.pension = `기준소득월액 ${won(pensionBaseUsed)} × ${ppmPct(r.pension.employeePpm)}${i.pensionBase === null ? '(예상)' : ''}`;
  }

  let healthBaseUsed: number | null = null;
  if (i.healthApplies) {
    const h = r.health;
    let base = i.healthBase ?? i.monthlyTaxablePay;
    if (h.minBase !== undefined) base = Math.max(h.minBase, base);
    if (h.maxBase !== undefined) base = Math.min(h.maxBase, base);
    healthBaseUsed = base;
    employee.health = applyPpm(base, h.employeePpm, h.rounding);
    employer.health = applyPpm(base, h.employerPpm, h.rounding);
    employee.ltc = applyRatio(employee.health, r.ltc.ratePpm, r.ltc.healthRatePpm, r.ltc.rounding);
    employer.ltc = applyRatio(employer.health, r.ltc.ratePpm, r.ltc.healthRatePpm, r.ltc.rounding);
    calc.health = `보수월액 ${won(base)} × ${ppmPct(h.employeePpm)}${i.healthBase === null ? '(예상)' : ''}`;
    calc.ltc = `건강보험료 × ${ppmPct(r.ltc.ratePpm)} ÷ ${ppmPct(r.ltc.healthRatePpm)}`;
  }

  if (i.employmentApplies) {
    const e = r.employment;
    employee.employment = applyPpm(i.monthlyTaxablePay, e.employeePpm, e.rounding);
    employer.employment = applyPpm(i.monthlyTaxablePay, e.employerUnemploymentPpm + e.employerStabilityPpm[i.employerSize], e.rounding);
    calc.employment = `보수 ${won(i.monthlyTaxablePay)} × ${ppmPct(e.employeePpm)}`;
  }

  // 산재는 고용 적용과 무관하게 모든 근로자 대상이다. 요율은 사업장마다 달라 사장님이 고지서 값을 넣을 때만 계산한다
  if (i.industrialAccidentPpm !== null) employer.industrialAccident = applyPpm(i.monthlyTaxablePay, i.industrialAccidentPpm, r.employment.rounding);

  return { employee, employer, pensionBaseUsed, healthBaseUsed, calc };
}
