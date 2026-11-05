// 임금명세서·임금대장 법정 항목 누락 검사(R14 D-L12, §3 대조표 P-1~P-6·L-1~L-4). 경고용이고 막지 않는다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkStatementCompleteness, checkWageLedgerCompleteness, computePayroll, LEDGER_ITEMS, loadBundledPackage, pickTables, STATEMENT_ITEMS, statementFromPayroll,
  type PayrollEmployee, type WageLedgerRow, type WageStatement,
} from '@sax/payroll';

const T = pickTables(loadBundledPackage().tables, { taxDate: '2026-11-10', insuranceDate: '2026-11-01' });
const emp: PayrollEmployee = {
  payType: 'monthly', basePay: 2_500_000, nontax: { meal: 200_000 }, dependents: 1, children8to20: 0, withholdingPct: 100,
  pensionApplies: true, healthApplies: true, employmentApplies: true, pensionBase: null, healthBase: null,
};
const who = { name: '김직원', birthDate: '1990-01-01', payDate: '2026-11-10' };
const monthly = computePayroll({ month: '2026-11', employee: emp }, T);
const ok = statementFromPayroll(monthly, who);
const check = (s: WageStatement) => checkStatementCompleteness(s).missing;

describe('임금명세서 누락 검사(§27의2, R14 P-1~P-6)', () => {
  it('항목 코드표는 R14 §3과 같은 순서·개수', () => {
    assert.deepEqual(Object.keys(STATEMENT_ITEMS), ['P-1', 'P-2', 'P-3', 'P-4', 'P-5', 'P-6']);
    assert.deepEqual(Object.keys(LEDGER_ITEMS), ['L-1', 'L-2', 'L-3', 'L-4']);
  });

  it('월급 2,500천원 + 식대 20만원: 다 채우면 빈 목록(공제 합계 = 항목 합계, 실지급 = 총액 − 공제)', () => {
    assert.deepEqual(check(ok), []);
    // 35,600 + 3,560 + 118,750 + 89,870 + 11,800 + 22,500 = 282,080 → 2,700,000 − 282,080
    assert.equal(ok.totalDeduction, 282_080);
    assert.equal(ok.net, 2_417_920);
  });

  it('P-1 성명과 생년월일·사원번호, P-2 지급일', () => {
    assert.deepEqual(check({ ...ok, employee: { name: '김직원' } }), ['P-1']);
    assert.deepEqual(check({ ...ok, employee: { name: '김직원', employeeNo: 'E-07' } }), [], '사원번호도 된다');
    assert.deepEqual(check({ ...ok, employee: { name: ' ', birthDate: '1990-01-01' } }), ['P-1']);
    assert.deepEqual(check({ ...ok, payDate: null }), ['P-2']);
    assert.deepEqual(check({ ...ok, payDate: '11월 10일' }), ['P-2']);
  });

  it('P-3 총액 = 구성항목 합계, P-6 공제·실지급 산술', () => {
    assert.deepEqual(check({ ...ok, gross: 2_700_001 }), ['P-3', 'P-6']);
    assert.deepEqual(check({ ...ok, gross: null }), ['P-3', 'P-6']);
    assert.deepEqual(check({ ...ok, net: 2_417_921 }), ['P-6']);
    assert.deepEqual(check({ ...ok, totalDeduction: 282_000 }), ['P-6']);
    assert.deepEqual(check({ ...ok, deductions: [...ok.deductions.slice(1)] }), ['P-6'], '항목을 빼면 합계가 안 맞는다');
  });

  it('P-4·P-5(D-L12): 수당을 세전 금액에 합쳐 한 줄로 넣고 연장 시간이 있으면 경고, 수당 줄과 계산방법을 적으면 사라진다', () => {
    const lump = computePayroll({ month: '2026-11', employee: { ...emp, basePay: 2_800_000, nontax: {} } }, T);
    assert.deepEqual(check(statementFromPayroll(lump, who)), [], '시간 입력이 없으면 한 줄도 경고 아님');
    assert.deepEqual(check(statementFromPayroll(lump, { ...who, hours: { overtimeMinutes: 600 } })), ['P-4', 'P-5']);
    const split = computePayroll({ month: '2026-11', employee: { ...emp, nontax: {} }, extras: [{ name: '연장근로수당', amount: 300_000, calc: '' }] }, T);
    assert.deepEqual(check(statementFromPayroll(split, { ...who, hours: { overtimeMinutes: 600 }, timeVaryingItems: ['연장근로수당'] })), ['P-5'], '계산방법이 비었다');
    const written = computePayroll({ month: '2026-11', employee: { ...emp, nontax: {} }, extras: [{ name: '연장근로수당', amount: 300_000, calc: '통상시급 20,000원 × 10시간 × 1.5' }] }, T);
    assert.deepEqual(check(statementFromPayroll(written, { ...who, hours: { overtimeMinutes: 600 }, timeVaryingItems: ['연장근로수당'] })), []);
    assert.deepEqual(check({ ...ok, items: [] }), ['P-3', 'P-4']);
  });

  it('P-5 시급제 기본급은 계산방법(시급 × 시간)이 있어 통과, 지우면 경고', () => {
    const shifts = [{ workDay: '2026-11-02', startsAt: '09:00', endsAt: '18:00', breakMinutes: 60 }];
    const r = computePayroll({ month: '2026-11', employee: { ...emp, payType: 'hourly', basePay: 10_320, nontax: {} }, shifts }, T);
    const s = statementFromPayroll(r, who);
    assert.equal(s.items[0]!.variesWithTime, true);
    assert.equal(s.hours!.workMinutes, 480);
    assert.deepEqual(check(s), []);
    assert.deepEqual(check({ ...s, items: [{ ...s.items[0]!, calc: '' }] }), ['P-5']);
  });
});

describe('임금대장 누락 검사(§27①②③, R14 L-1~L-4)', () => {
  const row: WageLedgerRow = {
    employee: { name: '김직원', birthDate: '1990-01-01', hiredOn: '2025-03-02', job: '홀 서빙' },
    wageBasis: '월급 2,500,000원',
    workDays: 21,
    hours: { workMinutes: 10_080, overtimeMinutes: 0, nightMinutes: 0, holidayMinutes: 0 },
    items: ok.items,
    deductions: ok.deductions,
  };
  const L = (r: WageLedgerRow, smallWorkplace = false) => checkWageLedgerCompleteness(r, { smallWorkplace }).missing;

  it('다 채우면 빈 목록, 연장 0분은 적은 것', () => {
    assert.deepEqual(L(row), []);
  });

  it('L-1 성명·생년월일(사원번호)·고용일·업무, 30일 미만 일용은 생년월일 생략 가능', () => {
    assert.deepEqual(L({ ...row, employee: { ...row.employee, job: null } }), ['L-1']);
    assert.deepEqual(L({ ...row, employee: { ...row.employee, hiredOn: null } }), ['L-1']);
    assert.deepEqual(L({ ...row, employee: { ...row.employee, birthDate: null } }), ['L-1']);
    assert.deepEqual(L({ ...row, employee: { ...row.employee, birthDate: null, dailyUnder30Days: true } }), []);
  });

  it('L-2 계산기초·근로일수, 30일 미만 일용은 계산기초 생략 가능(근로일수는 아님)', () => {
    assert.deepEqual(L({ ...row, wageBasis: null }), ['L-2']);
    assert.deepEqual(L({ ...row, wageBasis: null, employee: { ...row.employee, dailyUnder30Days: true } }), []);
    assert.deepEqual(L({ ...row, workDays: null, employee: { ...row.employee, dailyUnder30Days: true } }), ['L-2']);
  });

  it('L-3 시간 수: 상시 4명 이하·§63 근로자는 생략 가능, 그 밖에는 비면 기재 필요', () => {
    const noHours = { ...row, hours: { workMinutes: 10_080, overtimeMinutes: null } };
    assert.deepEqual(L(noHours), ['L-3']);
    assert.deepEqual(L(noHours, true), []);
    assert.deepEqual(L({ ...noHours, employee: { ...row.employee, section63: true } }), []);
  });

  it('L-4 임금 내역·공제', () => {
    assert.deepEqual(L({ ...row, items: [] }), ['L-4']);
    assert.deepEqual(L({ ...row, deductions: [{ name: '', amount: 1 }] }), ['L-4']);
  });
});
