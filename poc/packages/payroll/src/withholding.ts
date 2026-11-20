import { roundRational, type Rounding } from './money.ts';
import { TableError, type RateTable } from './tables.ts';

export interface WithholdingInput {
  monthlyTaxablePay: number;
  dependents: number;
  children8to20: number;
  pct: 80 | 100 | 120;
}

export interface WithholdingResult {
  tableTax: number;
  childDeduction: number;
  incomeTax: number;
  localIncomeTax: number;
  calc: string;
  localCalc: string;
}

/** 지방소득세(특별징수) = 소득세의 10%. 끝처리는 표의 규칙을 따른다 */
export const LOCAL_INCOME_TAX_NUM = 1;
export const LOCAL_INCOME_TAX_DEN = 10;

function familyTax(row: readonly number[], family: number): number {
  if (family <= 11) return row[1 + family]!;
  const t10 = row[11]!;
  const t11 = row[12]!;
  return Math.max(0, t11 - (t10 - t11) * (family - 11));
}

/** 표 세액(가족 수 반영, 자녀 공제 전). 표 끝을 넘으면 over 구간 식 */
export function tableTaxFor(table: RateTable<'simple_tax_table'>, pay: number, family: number): number {
  const { rows, over } = table.body;
  if (!Number.isSafeInteger(pay) || pay < 0) throw new TableError('invalid_pay');
  if (!Number.isSafeInteger(family) || family < 1) throw new TableError('invalid_dependents');
  if (pay <= over.top) {
    const row = pay === over.top ? rows[rows.length - 1]! : rows.find((r) => r[0] <= pay && pay < r[1]);
    if (!row) throw new TableError('simple_tax_row_missing');
    return familyTax(row, family);
  }
  const base = familyTax(rows[rows.length - 1]!, family);
  const b = [...over.brackets].reverse().find((x) => pay > x.above);
  if (!b) throw new TableError('simple_tax_over_missing');
  return base + b.addWon + roundRational(BigInt(pay - b.above) * BigInt(b.num), BigInt(b.den), 'floor_1');
}

export function childDeductionFor(table: RateTable<'simple_tax_table'>, children: number): number {
  const { amounts, extraPerChild } = table.body.children;
  if (!Number.isSafeInteger(children) || children < 0) throw new TableError('invalid_children');
  if (children < amounts.length) return amounts[children]!;
  return amounts[amounts.length - 1]! + extraPerChild * (children - (amounts.length - 1));
}

export function withholding(table: RateTable<'simple_tax_table'>, input: WithholdingInput): WithholdingResult {
  if (input.children8to20 > input.dependents - 1) throw new TableError('invalid_children');
  if (![80, 100, 120].includes(input.pct)) throw new TableError('invalid_pct');
  const tableTax = tableTaxFor(table, input.monthlyTaxablePay, input.dependents);
  const childDeduction = childDeductionFor(table, input.children8to20);
  const afterChild = Math.max(0, tableTax - childDeduction);
  const r: Rounding = table.rounding;
  const incomeTax = roundRational(BigInt(afterChild) * BigInt(input.pct), 100n, r);
  const localIncomeTax = roundRational(BigInt(incomeTax) * BigInt(LOCAL_INCOME_TAX_NUM), BigInt(LOCAL_INCOME_TAX_DEN), r);
  const parts = [`간이세액표(${table.id}) 월급여 ${input.monthlyTaxablePay.toLocaleString('ko-KR')}원·공제대상가족 ${input.dependents}명`];
  if (input.children8to20) parts.push(`8~20세 자녀 ${input.children8to20}명 공제 ${childDeduction.toLocaleString('ko-KR')}원`);
  if (input.pct !== 100) parts.push(`${input.pct}% 선택`);
  return {
    tableTax,
    childDeduction,
    incomeTax,
    localIncomeTax,
    calc: parts.join(', '),
    localCalc: '소득세의 10%',
  };
}
