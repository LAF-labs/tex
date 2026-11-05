// M6-8 계산 규칙(합성 표로): 끝처리, 간이세액표 찾기·가족 11명 초과·자녀 공제·80/120%, 표 끝 넘는 식, 보험 상·하한, 비과세 한도, 고지액 우선.
// M6-15 근무표. M6-10 패키지 검증·시행일 선택. 공식 표 대조는 golden.test.ts.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  applyPpm, computePayroll, hourlyPay, insurance, monthHours, pickTables, roundRational, shiftMinutes, tableTaxFor, validatePackage, withholding,
  type RateTable, type RateTablePackage, type TableSet,
} from '@sax/payroll';

const meta = { review: 'confirmed' as const, sources: [{ title: '시험용', url: 'https://example.invalid/' }], effectiveTo: null };

// 합성 간이세액표: 0~1,000,000은 0, 1,000,000~2,000,000, 2,000,000~3,000,000, 그리고 표 끝 3,000,000
const fam = (base: number) => Array.from({ length: 11 }, (_, i) => Math.max(0, base - i * 10_000));
const simple: RateTable<'simple_tax_table'> = {
  ...meta, id: 'tax-test', kind: 'simple_tax_table', effectiveFrom: '2024-03-01', rounding: 'floor_10',
  body: {
    rows: [[0, 1_000_000, ...fam(0)], [1_000_000, 2_000_000, ...fam(30_000)], [2_000_000, 3_000_000, ...fam(80_000)], [3_000_000, 3_000_001, ...fam(120_000)]] as RateTable<'simple_tax_table'>['body']['rows'],
    over: { top: 3_000_000, brackets: [{ above: 3_000_000, addWon: 25_000, num: 98 * 35, den: 10_000 }, { above: 4_000_000, addWon: 400_000, num: 38, den: 100 }] },
    children: { amounts: [0, 12_500, 29_160], extraPerChild: 25_000 },
    familyOver11: 'extrapolate_10_11',
  },
};
const ins: RateTable<'insurance_rate'> = {
  ...meta, id: 'ins-test', kind: 'insurance_rate', effectiveFrom: '2026-01-01', rounding: 'floor_10',
  body: {
    pension: { employeePpm: 47_500, employerPpm: 47_500, rounding: 'floor_10' },
    health: { employeePpm: 35_950, employerPpm: 35_950, rounding: 'floor_10' },
    ltc: { ratePpm: 9_448, healthRatePpm: 71_900, rounding: 'floor_10' },
    employment: { employeePpm: 9_000, employerUnemploymentPpm: 9_000, employerStabilityPpm: { under150: 2_500, priority150plus: 4_500, from150to999: 6_500, over1000: 8_500 }, rounding: 'floor_10' },
  },
};
const bounds: RateTable<'pension_bounds'> = { ...meta, id: 'pb-test', kind: 'pension_bounds', effectiveFrom: '2026-01-01', rounding: 'floor_10', body: { minBase: 400_000, maxBase: 6_370_000, baseRounding: 'floor_1000' } };
const nontax: RateTable<'nontax_limits'> = {
  ...meta, id: 'nt-test', kind: 'nontax_limits', effectiveFrom: '2023-01-01', rounding: 'floor_1',
  body: { kinds: { meal: { label: '식대', monthlyLimit: 200_000, basis: '시험' }, vehicle: { label: '자가운전보조금', monthlyLimit: 200_000, basis: '시험' } } },
};
const T: TableSet = { simpleTax: simple, insurance: ins, pensionBounds: bounds, nontax };
const emp = { payType: 'monthly' as const, basePay: 2_500_000, nontax: {}, dependents: 1, children8to20: 0, withholdingPct: 100 as const, pensionApplies: true, healthApplies: true, employmentApplies: true, pensionBase: null, healthBase: null };

describe('원 단위 끝처리', () => {
  it('절사·반올림, 부동소수 없이', () => {
    assert.equal(roundRational(12_345n, 1n, 'floor_10'), 12_340);
    assert.equal(roundRational(12_345n, 1n, 'round_10'), 12_350);
    assert.equal(roundRational(12_344n, 1n, 'round_10'), 12_340);
    assert.equal(roundRational(1_234_567n, 1n, 'floor_1000'), 1_234_000);
    assert.equal(applyPpm(2_500_000, 47_500, 'floor_10'), 118_750);
    assert.equal(applyPpm(2_345_678, 35_950, 'floor_10'), 84_320, '2,345,678 × 3.595% = 84,327.1');
    assert.equal(applyPpm(1, 999_999, 'floor_1'), 0);
    assert.throws(() => applyPpm(-1, 1, 'floor_1'), /invalid_won/);
  });
});

describe('간이세액표 적용', () => {
  it('행 경계: 이상·미만, 표 끝값, 가족 수 칸', () => {
    assert.equal(tableTaxFor(simple, 999_999, 1), 0);
    assert.equal(tableTaxFor(simple, 1_000_000, 1), 30_000);
    assert.equal(tableTaxFor(simple, 1_999_999, 2), 20_000);
    assert.equal(tableTaxFor(simple, 3_000_000, 1), 120_000, '표 끝값은 마지막 행');
  });
  it('공제대상가족 11명 초과: 11명 세액 − (10명 − 11명) × 초과 인원, 0 미만은 0', () => {
    // 2,000,000 행: 10명 = 80,000 − 90,000 → 0, 11명 0 → 0
    assert.equal(tableTaxFor(simple, 2_500_000, 13), 0);
    // 3,000,000 끝값: 10명 30,000, 11명 20,000 → 13명 = 20,000 − 10,000 × 2 = 0, 12명 = 10,000
    assert.equal(tableTaxFor(simple, 3_000_000, 12), 10_000);
  });
  it('표 끝을 넘는 월급여: 끝값 세액 + 가산액 + 초과분 × 비율(위 구간부터)', () => {
    // 3,500,000: 120,000 + 25,000 + 500,000 × 0.343 = 316,500
    assert.equal(tableTaxFor(simple, 3_500_000, 1), 316_500);
    // 5,000,000: 120,000 + 400,000 + 1,000,000 × 0.38 = 900,000
    assert.equal(tableTaxFor(simple, 5_000_000, 1), 900_000);
  });
  it('자녀 공제(1명·2명·3명 이상), 80·120%, 지방소득세 10%, 10원 미만 절사', () => {
    const w = (children: number, pct: 80 | 100 | 120) => withholding(simple, { monthlyTaxablePay: 2_500_000, dependents: 4, children8to20: children, pct });
    // 4명 칸: 80,000 − 30,000 = 50,000
    assert.equal(w(0, 100).incomeTax, 50_000);
    assert.equal(w(1, 100).incomeTax, 37_500);
    assert.equal(w(2, 100).incomeTax, 20_840);
    assert.equal(w(3, 100).incomeTax, 0, '50,000 − 29,160 − 25,000 < 0 → 0');
    assert.equal(w(1, 80).incomeTax, 30_000);
    assert.equal(w(1, 120).incomeTax, 45_000);
    assert.equal(w(2, 120).incomeTax, 25_000, '20,840 × 1.2 = 25,008 → 25,000');
    assert.equal(w(2, 120).localIncomeTax, 2_500);
    assert.equal(withholding(simple, { monthlyTaxablePay: 1_500_000, dependents: 1, children8to20: 0, pct: 100 }).localIncomeTax, 3_000);
    assert.throws(() => withholding(simple, { monthlyTaxablePay: 1, dependents: 1, children8to20: 1, pct: 100 }), /invalid_children/);
  });
});

describe('4대보험 예상치', () => {
  it('연금: 천원 미만 절사 뒤 상·하한, 건강·장기요양·고용, 사업주는 고용안정 구간을 더한다', () => {
    const r = insurance(ins, bounds, { monthlyTaxablePay: 2_345_678, pensionBase: null, healthBase: null, pensionApplies: true, healthApplies: true, employmentApplies: true, employerSize: 'under150', industrialAccidentPpm: null });
    assert.equal(r.pensionBaseUsed, 2_345_000);
    assert.equal(r.employee.pension, 111_380, '2,345,000 × 4.75% = 111,387.5');
    assert.equal(r.employee.health, 84_320);
    assert.equal(r.employee.ltc, 11_080, '84,320 × 0.9448/7.19 = 11,080.0…');
    assert.equal(r.employee.employment, 21_110);
    assert.equal(r.employer.employment, 26_970, '2,345,678 × 1.15% = 26,975.2');
    assert.equal(r.employer.industrialAccident, null);
    const hi = insurance(ins, bounds, { monthlyTaxablePay: 9_000_000, pensionBase: null, healthBase: null, pensionApplies: true, healthApplies: false, employmentApplies: false, employerSize: 'under150', industrialAccidentPpm: 7_000 });
    assert.equal(hi.pensionBaseUsed, 6_370_000);
    assert.equal(hi.employee.health + hi.employee.ltc + hi.employee.employment, 0, '적용 안 함');
    assert.equal(hi.employer.industrialAccident, 63_000);
    assert.equal(insurance(ins, bounds, { monthlyTaxablePay: 100_000, pensionBase: null, healthBase: null, pensionApplies: true, healthApplies: false, employmentApplies: false, employerSize: 'under150', industrialAccidentPpm: null }).pensionBaseUsed, 400_000);
  });
});

describe('급여 한 줄', () => {
  it('비과세 한도까지만 비과세, 넘는 만큼 과세 항목으로, 항목 합 = 지급총액, 공제 뒤 실지급액', () => {
    const r = computePayroll({ month: '2026-10', employee: { ...emp, nontax: { meal: 250_000 } }, extras: [{ name: '직책수당', amount: 100_000, calc: '고정' }] }, T);
    assert.deepEqual(r.items.map((i) => [i.name, i.amount, i.taxable]), [['기본급', 2_500_000, true], ['직책수당', 100_000, true], ['식대', 200_000, false], ['식대(한도 초과분)', 50_000, true]]);
    assert.equal(r.gross, 2_850_000);
    assert.equal(r.nontax, 200_000);
    assert.ok(r.notes.includes('nontax_over_limit:meal'));
    // 과세 2,650,000 → 80,000 / 지방 8,000, 연금 2,650,000×4.75%=125,870(125,875), 건강 95,260(95,267.5), 장기요양 12,510(12,517.3), 고용 23,850
    assert.deepEqual([r.incomeTax, r.localIncomeTax, r.pensionEst, r.healthEst, r.ltcEst, r.employmentEst], [80_000, 8_000, 125_870, 95_260, 12_510, 23_850]);
    assert.equal(r.netPay, 2_850_000 - 80_000 - 8_000 - 125_870 - 95_260 - 12_510 - 23_850);
    assert.deepEqual(r.rateTableIds, ['tax-test', 'ins-test', 'pb-test', 'nt-test']);
    assert.ok(r.notes.includes('insurance_estimate:pension'));
    assert.throws(() => computePayroll({ month: '2026-10', employee: { ...emp, nontax: { research: 1 } } }, T), /nontax_unknown_kind:research/);
  });

  it('고지액이 있으면 공제에 고지액을 쓰고, 예상치와 다르면 표시만 한다', () => {
    const r = computePayroll({ month: '2026-10', employee: emp, notices: { pension: 118_750, health: 90_000, ltc: 11_650, employment: 22_500 } }, T);
    assert.equal(r.healthEst, 89_870);
    assert.equal(r.healthNotice, 90_000);
    assert.ok(r.notes.includes('insurance_notice_differs:health'));
    assert.ok(!r.notes.some((n) => n.startsWith('insurance_estimate')));
    assert.equal(r.netPay, 2_500_000 - r.incomeTax - r.localIncomeTax - 118_750 - 90_000 - 11_650 - 22_500);
    assert.equal(r.deductionCalc.health, '공단 고지액');
  });

  it('검수 필요 표는 표시로 따라온다', () => {
    const r = computePayroll({ month: '2026-10', employee: emp }, { ...T, simpleTax: { ...simple, review: 'needs_review' } });
    assert.ok(r.notes.includes('table_needs_review:tax-test'));
  });

  it('시급제: 근무표 합계(분) × 시급, 원 미만 절사', () => {
    const shifts = [
      { workDay: '2026-10-01', startsAt: '09:00', endsAt: '18:00', breakMinutes: 60 },
      { workDay: '2026-10-02', startsAt: '22:00', endsAt: '02:30', breakMinutes: 30 },
      { workDay: '2026-10-02', startsAt: '10:00', endsAt: '10:45', breakMinutes: 0 },
    ];
    const r = computePayroll({ month: '2026-10', employee: { ...emp, payType: 'hourly', basePay: 10_320 }, shifts }, T);
    assert.equal(r.workMinutes, 480 + 240 + 45);
    assert.equal(r.workDays, 2);
    assert.equal(r.items[0]!.amount, Math.floor((10_320 * 765) / 60));
    assert.match(r.items[0]!.calc, /12시간 45분/);
    assert.throws(() => computePayroll({ month: '2026-10', employee: { ...emp, payType: 'hourly' } }, T), /hourly_needs_shifts/);
  });
});

describe('근무표(M6-15)', () => {
  it('자정 넘김·휴게 차감·잘못된 입력', () => {
    assert.equal(shiftMinutes({ workDay: '2026-10-01', startsAt: '23:00', endsAt: '07:00', breakMinutes: 60 }), 420);
    assert.throws(() => shiftMinutes({ workDay: '2026-10-01', startsAt: '09:00', endsAt: '10:00', breakMinutes: 60 }), /invalid_break/);
    assert.throws(() => shiftMinutes({ workDay: '2026-10-01', startsAt: '9:00', endsAt: '10:00', breakMinutes: 0 }), /invalid_time/);
    assert.throws(() => monthHours('2026-10', [{ workDay: '2026-11-01', startsAt: '09:00', endsAt: '10:00', breakMinutes: 0 }]), /shift_outside_month/);
    assert.equal(hourlyPay(10_030, 9_450), 1_579_725, '157.5시간');
  });
});

describe('시행일 표 패키지(M6-10)', () => {
  it('열린 표 뒤에 다음 표: 앞 표는 그 전날까지, 같은 시작일은 겹침, 닫힌 표 뒤 빈 기간은 없음', () => {
    const next = { ...ins, id: 'ins-2027', effectiveFrom: '2027-01-01' };
    const pkg2: RateTablePackage = { schema: 'sax.rate-tables/v1', packageVersion: '2026.11.2', tables: [simple, ins, next, bounds, nontax] };
    assert.deepEqual(validatePackage(pkg2), []);
    assert.equal(pickTables(pkg2.tables, { taxDate: '2026-12-31', insuranceDate: '2026-12-01' }).insurance.id, 'ins-test');
    assert.equal(pickTables(pkg2.tables, { taxDate: '2027-01-10', insuranceDate: '2027-01-01' }).insurance.id, 'ins-2027');
    assert.ok(validatePackage({ ...pkg2, tables: [...pkg2.tables, { ...next, id: 'ins-2027b' }] }).some((b) => b.startsWith('overlap:')));
    assert.ok(validatePackage({ ...pkg2, tables: [...pkg2.tables, { ...ins, id: 'ins-mid', effectiveFrom: '2026-06-01', effectiveTo: '2027-02-01' }] }).some((b) => b.startsWith('overlap:')));
    const gap = [simple, ins, { ...ins, id: 'ins-short', effectiveFrom: '2026-03-01', effectiveTo: '2026-04-30' }, bounds, nontax];
    assert.equal(pickTables(gap, { taxDate: '2026-04-10', insuranceDate: '2026-04-01' }).insurance.id, 'ins-short');
    assert.throws(() => pickTables(gap, { taxDate: '2026-05-10', insuranceDate: '2026-05-01' }), /rate_table_missing:insurance_rate/);
  });

  const pkg: RateTablePackage = { schema: 'sax.rate-tables/v1', packageVersion: '2026.11.1', tables: [simple, ins, bounds, nontax] };
  it('스키마·의미 규칙 통과, 시행일로 고른다', () => {
    assert.deepEqual(validatePackage(pkg), []);
    const later = { ...bounds, id: 'pb-later', effectiveFrom: '2026-07-01' };
    const t = pickTables([simple, ins, { ...bounds, effectiveTo: '2026-06-30' }, later, nontax], { taxDate: '2026-10-10', insuranceDate: '2026-10-01' });
    assert.equal(t.pensionBounds.id, 'pb-later');
    assert.throws(() => pickTables([simple], { taxDate: '2026-10-10', insuranceDate: '2026-10-01' }), /rate_table_missing:insurance_rate/);
  });
  it('거부: 스키마 밖 필드, 기간 겹침, 표 빈틈, 가족이 늘었는데 세액이 늘어난 칸', () => {
    assert.ok(validatePackage({ ...pkg, extra: 1 })[0]!.startsWith('schema:'));
    assert.ok(validatePackage({ ...pkg, tables: [...pkg.tables, { ...bounds, id: 'pb-dup' }] }).some((b) => b.startsWith('overlap:')));
    const gap = { ...simple, body: { ...simple.body, rows: [simple.body.rows[0]!, simple.body.rows[2]!, simple.body.rows[3]!] } };
    assert.ok(validatePackage({ ...pkg, tables: [gap, ins, bounds, nontax] }).some((b) => b.startsWith('simple_tax_gap')));
    const r1 = [...simple.body.rows[1]!] as RateTable<'simple_tax_table'>['body']['rows'][number];
    r1[4] = 99_999;
    const bad = { ...simple, body: { ...simple.body, rows: [simple.body.rows[0]!, r1, simple.body.rows[2]!, simple.body.rows[3]!] } };
    assert.ok(validatePackage({ ...pkg, tables: [bad, ins, bounds, nontax] }).some((b) => b.startsWith('simple_tax_family_order')));
    assert.ok(validatePackage({ ...pkg, tables: [{ ...ins, body: { ...ins.body, pension: { ...ins.body.pension, employeePpm: 4.75 } } }, simple, bounds, nontax] }).some((b) => b.startsWith('schema:')), 'ppm은 정수');
  });
});
