import { applyPpm, applyRatio, roundWon, ppmPct, won } from './money.ts';
import type { EmployerSizeBand, RateTable } from './tables.ts';

export interface InsuranceInput {
  monthlyTaxablePay: number;
  pensionBase: number | null;
  healthBase: number | null;
  pensionApplies: boolean;
  healthApplies: boolean;
  employmentApplies: boolean;
  employerSize: EmployerSizeBand;
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

  if (i.industrialAccidentPpm !== null) employer.industrialAccident = applyPpm(i.monthlyTaxablePay, i.industrialAccidentPpm, r.employment.rounding);

  return { employee, employer, pensionBaseUsed, healthBaseUsed, calc };
}
