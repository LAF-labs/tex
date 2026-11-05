// 임금명세서·임금대장 법정 항목 누락 검사(R14 D-L12, §3 대조표). 새 로직이다(팀장 지시 2026-11-05).
// 근로기준법 제48조, 시행령 제27조(임금대장)·제27조의2(임금명세서). 결과는 빠진 항목 코드 목록뿐이다:
// - 경고용이고 막지 않는다(D-L12 (a)). 빈 목록이어도 "법정 양식 충족"이라고 쓰지 않는다(화면 문구는 데스크톱 2차).
// - 노무 판단(가산 계산·주휴 판단)을 하지 않는다. 적힌 칸이 비었는지, 합계가 맞는지만 본다.
import type { PayrollResult } from './payroll.ts';

/** 임금명세서 항목(시행령 §27의2 1~6호) */
export const STATEMENT_ITEMS = {
  'P-1': '근로자를 특정할 수 있는 정보(성명, 생년월일·사원번호 등)',
  'P-2': '임금지급일',
  'P-3': '임금 총액',
  'P-4': '기본급·각종 수당·상여금·성과금 등 구성항목별 금액',
  'P-5': '출근일수·시간 등에 따라 달라지는 항목의 계산방법(연장·야간·휴일 근로 시간 수 포함)',
  'P-6': '공제 항목별 금액과 총액',
} as const;
export type StatementItemCode = keyof typeof STATEMENT_ITEMS;

/** 임금대장 항목(시행령 §27① 1~10호를 R14 표처럼 묶음) */
export const LEDGER_ITEMS = {
  'L-1': '성명, 생년월일·사원번호 등, 고용 연월일, 종사 업무',
  'L-2': '임금·가족수당 계산기초 사항, 근로일수',
  'L-3': '근로시간 수, 연장·야간·휴일 근로 시간 수',
  'L-4': '기본급·수당 등 임금 내역별 금액, 공제 금액',
} as const;
export type LedgerItemCode = keyof typeof LEDGER_ITEMS;

export interface StatementPayItem {
  name: string;
  amount: number;
  /** 계산방법 문장 */
  calc?: string | null;
  /** 출근일수·시간에 따라 달라지는 항목(시급 × 시간, 연장수당 등). 그러면 계산방법이 있어야 한다 */
  variesWithTime?: boolean;
}

export interface StatementDeduction {
  name: string;
  amount: number;
}

export interface StatementHours {
  workMinutes?: number | null;
  overtimeMinutes?: number | null;
  nightMinutes?: number | null;
  holidayMinutes?: number | null;
}

/** 한 사람의 그달 임금명세서(PDF에 들어갈 값) */
export interface WageStatement {
  employee: { name: string | null; birthDate?: string | null; employeeNo?: string | null };
  /** 임금지급일 'YYYY-MM-DD' */
  payDate: string | null;
  gross: number | null;
  items: readonly StatementPayItem[];
  hours?: StatementHours;
  deductions: readonly StatementDeduction[];
  totalDeduction: number | null;
  net: number | null;
}

const filled = (s: string | null | undefined): boolean => typeof s === 'string' && s.trim().length > 0;
const isNum = (n: number | null | undefined): n is number => typeof n === 'number' && Number.isSafeInteger(n);
const sum = (xs: readonly { amount: number }[]): number => xs.reduce((a, b) => a + b.amount, 0);
const extraHours = (h: StatementHours | undefined): boolean => [h?.overtimeMinutes, h?.nightMinutes, h?.holidayMinutes].some((m) => isNum(m) && m > 0);

const itemsOk = (items: readonly StatementPayItem[]): boolean => items.length > 0 && items.every((i) => filled(i.name) && isNum(i.amount));
const deductionsOk = (s: Pick<WageStatement, 'deductions' | 'totalDeduction' | 'gross' | 'net'>): boolean =>
  s.deductions.every((d) => filled(d.name) && isNum(d.amount)) &&
  isNum(s.totalDeduction) &&
  s.totalDeduction === sum(s.deductions) &&
  isNum(s.gross) &&
  isNum(s.net) &&
  s.net === s.gross - s.totalDeduction;

/**
 * 임금명세서 누락 검사(R14 §3 P-1~P-6). 빠졌거나 맞지 않는 항목 코드를 표 순서로 돌려준다.
 * - P-3: 총액이 비었거나 구성항목 합계와 다르다
 * - P-4: 구성항목이 없거나, 한 줄뿐인데 연장·야간·휴일 시간이 있다(수당을 세전 금액에 합쳐 넣은 경우, D-L12)
 * - P-5: 시간에 따라 달라지는 항목의 계산방법이 비었거나, 연장·야간·휴일 시간이 있는데 시간 수 칸이 없다
 * - P-6: 공제 항목·총액이 비었거나, 공제 합계 ≠ 항목 합계, 실지급액 ≠ 총액 − 공제 합계
 */
export function checkStatementCompleteness(s: WageStatement): { missing: StatementItemCode[] } {
  const missing: StatementItemCode[] = [];
  if (!filled(s.employee.name) || !(filled(s.employee.birthDate) || filled(s.employee.employeeNo))) missing.push('P-1');
  if (!filled(s.payDate) || !/^\d{4}-\d{2}-\d{2}$/.test(s.payDate!)) missing.push('P-2');
  if (!isNum(s.gross) || !itemsOk(s.items) || s.gross !== sum(s.items)) missing.push('P-3');
  if (!itemsOk(s.items) || (s.items.length === 1 && extraHours(s.hours))) missing.push('P-4');
  const calcMissing = s.items.some((i) => i.variesWithTime && !filled(i.calc));
  if (calcMissing || (extraHours(s.hours) && !s.items.some((i) => i.variesWithTime))) missing.push('P-5');
  if (!deductionsOk(s)) missing.push('P-6');
  return { missing };
}

/** 한 사람의 그달 임금대장 줄 */
export interface WageLedgerRow {
  employee: {
    name: string | null;
    birthDate?: string | null;
    employeeNo?: string | null;
    hiredOn: string | null;
    job: string | null;
    /** 30일 미만 일용근로자: 생년월일·사원번호(2호)와 계산기초(5호) 생략 가능(§27②) */
    dailyUnder30Days?: boolean;
    /** 근로기준법 §63 적용 제외 근로자: 시간 수(7·8호) 생략 가능(§27③) */
    section63?: boolean;
  };
  /** 임금·가족수당 계산기초(예: '월급 2,500,000원', '시급 10,320원') */
  wageBasis: string | null;
  workDays: number | null;
  hours: StatementHours;
  items: readonly StatementPayItem[];
  deductions: readonly StatementDeduction[];
}

/**
 * 임금대장 누락 검사(R14 §3 L-1~L-4). smallWorkplace = 상시 4명 이하 사업장(시간 수 생략 가능, §27③).
 * 시간 칸은 null이면 적지 않은 것, 0이면 적은 것으로 본다.
 */
export function checkWageLedgerCompleteness(r: WageLedgerRow, opts: { smallWorkplace: boolean }): { missing: LedgerItemCode[] } {
  const missing: LedgerItemCode[] = [];
  const e = r.employee;
  const idOk = e.dailyUnder30Days || filled(e.birthDate) || filled(e.employeeNo);
  if (!filled(e.name) || !idOk || !filled(e.hiredOn) || !filled(e.job)) missing.push('L-1');
  if ((!e.dailyUnder30Days && !filled(r.wageBasis)) || !isNum(r.workDays)) missing.push('L-2');
  const hoursRequired = !opts.smallWorkplace && !e.section63;
  if (hoursRequired && [r.hours.workMinutes, r.hours.overtimeMinutes, r.hours.nightMinutes, r.hours.holidayMinutes].some((m) => !isNum(m))) missing.push('L-3');
  if (!itemsOk(r.items) || !r.deductions.every((d) => filled(d.name) && isNum(d.amount))) missing.push('L-4');
  return { missing };
}

/** 급여대장 계산 결과의 공제 칸(근로자 부담, 고지액이 있으면 고지액) */
export function payrollDeductions(r: PayrollResult): StatementDeduction[] {
  return [
    { name: '소득세', amount: r.incomeTax },
    { name: '지방소득세', amount: r.localIncomeTax },
    { name: '국민연금', amount: r.pensionNotice ?? r.pensionEst },
    { name: '건강보험', amount: r.healthNotice ?? r.healthEst },
    { name: '장기요양보험', amount: r.ltcNotice ?? r.ltcEst },
    { name: '고용보험', amount: r.employmentNotice ?? r.employmentEst },
  ];
}

/**
 * 계산 결과로 임금명세서 값을 만든다(PDF와 검사에 같은 값을 쓴다). 시급제 기본급(계산방법이 '시급 …')은 시간에 따라 달라지는 항목으로 표시한다.
 * 연장·야간·휴일 시간은 계산하지 않으므로(가산 없음) 사장님이 근무표·입력으로 적은 값만 hours로 넘긴다.
 */
export function statementFromPayroll(
  r: PayrollResult,
  meta: { name: string; birthDate?: string | null; employeeNo?: string | null; payDate: string | null; hours?: StatementHours; timeVaryingItems?: readonly string[] },
): WageStatement {
  const timeVarying = new Set(meta.timeVaryingItems ?? []);
  const deductions = payrollDeductions(r);
  const totalDeduction = sum(deductions);
  return {
    employee: { name: meta.name, birthDate: meta.birthDate ?? null, employeeNo: meta.employeeNo ?? null },
    payDate: meta.payDate,
    gross: r.gross,
    items: r.items.map((i) => ({ name: i.name, amount: i.amount, calc: i.calc, variesWithTime: i.calc.startsWith('시급 ') || timeVarying.has(i.name) })),
    hours: { workMinutes: r.workMinutes, overtimeMinutes: r.overtimeMinutes, nightMinutes: r.nightMinutes, holidayMinutes: r.holidayMinutes, ...meta.hours },
    deductions,
    totalDeduction,
    net: r.netPay,
  };
}
