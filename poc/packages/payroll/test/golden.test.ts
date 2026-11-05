// 공식 표 대조(D14 M6-8): 앱에 싣는 data/rate-tables.json 이 원문과 같은지 본다.
// 간이세액표 값은 소득세법 시행령 [별표 2](개정 2026.2.27.) 원문 PDF의 행을 그대로 옮겨 적었다(괄호 안은 천원 단위 행).
// 10,000천원 초과는 별표 2 제6호 끝 식으로 손계산. 4대보험은 2026년 고시 요율로 손계산(끝처리는 "검수 필요").
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { childDeductionFor, computePayroll, insurance, loadBundledPackage, pickTables, suggestGross, tableTaxFor, takeHome, validatePackage, withholding } from '@sax/payroll';

const pkg = loadBundledPackage();
const at = (taxDate: string, insuranceDate = taxDate) => pickTables(pkg.tables, { taxDate, insuranceDate });
const T = at('2026-11-10', '2026-11-01');
const tax = (pay: number, family: number) => tableTaxFor(T.simpleTax, pay, family);

describe('기본 패키지(data/rate-tables.json)', () => {
  it('스키마·의미 규칙을 통과하고 표 id가 고정돼 있다', () => {
    assert.deepEqual(validatePackage(pkg), []);
    assert.deepEqual([T.simpleTax.id, T.insurance.id, T.pensionBounds.id, T.nontax.id], ['simple-tax-2026-03', 'insurance-2026', 'pension-bounds-2026-07', 'nontax-2026']);
    // 0원 행 + 원문 646행 + 10,000천원 한 점
    assert.equal(T.simpleTax.body.rows.length, 648);
    assert.equal(T.simpleTax.review, 'confirmed');
    assert.equal(T.insurance.review, 'needs_review', '보험료 끝처리 미대조');
    assert.equal(T.nontax.review, 'needs_review', '보육수당 자녀 1명당 한도 미반영');
    for (const t of pkg.tables) assert.ok(t.sources.length > 0 && t.sources.every((s) => s.url.startsWith('https://')));
  });

  it('시행일: 간이세액표는 2026.3.1. 지급분부터, 연금 상·하한은 7월에 바뀐다', () => {
    assert.throws(() => at('2026-02-28', '2026-02-01'), /rate_table_missing:simple_tax_table/);
    assert.equal(at('2026-03-01').simpleTax.id, 'simple-tax-2026-03');
    assert.equal(at('2026-06-10', '2026-06-01').pensionBounds.id, 'pension-bounds-2025-07');
    assert.equal(at('2026-07-10', '2026-07-01').pensionBounds.id, 'pension-bounds-2026-07');
  });
});

describe('근로소득 간이세액표(별표 2) 원문 값', () => {
  it('770천원 미만·첫 행·첫 세액', () => {
    assert.equal(tax(0, 1), 0);
    assert.equal(tax(769_999, 1), 0);
    assert.equal(tax(770_000, 1), 0, '(770~775) -');
    assert.equal(tax(1_059_999, 1), 0, '(1,055~1,060) -');
    assert.equal(tax(1_060_000, 1), 1_040, '(1,060~1,065)');
    assert.equal(tax(1_064_999, 1), 1_040);
    assert.equal(tax(1_065_000, 1), 1_110, '(1,065~1,070)');
    assert.equal(tax(1_060_000, 2), 0);
  });

  it('(2,500~2,510) 가족 1·2·3 = 35,600·28,600·16,530', () => {
    assert.deepEqual([1, 2, 3].map((f) => tax(2_500_000, f)), [35_600, 28_600, 16_530]);
    assert.deepEqual([1, 2, 3].map((f) => tax(2_509_999, f)), [35_600, 28_600, 16_530]);
    assert.equal(tax(2_499_999, 1), 35_270, '(2,490~2,500)');
  });

  it('(3,000~3,020)·(5,000~5,020)·(7,000~7,020) 가족 칸', () => {
    assert.deepEqual([1, 2, 3, 10, 11].map((f) => tax(3_000_000, f)), [74_350, 56_850, 31_940, 3_600, 0]);
    assert.deepEqual([1, 2, 4, 11].map((f) => tax(5_000_000, f)), [335_470, 306_710, 219_100, 87_850]);
    assert.deepEqual([1, 6, 11].map((f) => tax(7_019_999, f)), [732_700, 471_470, 377_720]);
    // 4,600천원부터 행 폭이 20천원
    assert.equal(tax(4_619_999, 1), 279_370, '(4,600~4,620)');
  });

  it('표 끝: (9,980~10,000)과 10,000천원 한 점', () => {
    assert.deepEqual([1, 2, 11].map((f) => tax(9_999_999, f)), [1_503_990, 1_428_170, 958_650]);
    assert.deepEqual([1, 2, 3, 11].map((f) => tax(10_000_000, f)), [1_507_400, 1_431_570, 1_200_840, 960_840]);
  });

  it('10,000천원 초과 식(구간 경계에서 이어진다)', () => {
    // 1,507,400 + 25,000 + 1 × 98% × 35%(원 미만 버림)
    assert.equal(tax(10_000_001, 1), 1_532_400);
    // 1,507,400 + 25,000 + 2,000,000 × 0.343 = 2,218,400
    assert.equal(tax(12_000_000, 1), 2_218_400);
    // 14,000천원: 첫 구간 식(1,507,400 + 25,000 + 4,000,000 × 0.343)과 둘째 구간 시작값(1,507,400 + 1,397,000)이 같다
    assert.equal(tax(14_000_000, 1), 2_904_400);
    assert.equal(tax(15_000_000, 1), 1_507_400 + 1_397_000 + 372_400);
    // 28,000천원·30,000천원·45,000천원·87,000천원 경계도 이어진다
    assert.equal(tax(28_000_000, 1), 1_507_400 + 1_397_000 + 5_213_600, "14,000,000 × 0.3724");
    assert.equal(tax(28_000_001, 1), 1_507_400 + 6_610_600);
    assert.equal(tax(30_000_000, 1), 1_507_400 + 6_610_600 + 784_000);
    assert.equal(tax(45_000_000, 1), 1_507_400 + 7_394_600 + 6_000_000);
    assert.equal(tax(87_000_000, 1), 1_507_400 + 13_394_600 + 17_640_000);
    assert.equal(tax(100_000_000, 1), 1_507_400 + 31_034_600 + 5_850_000);
    // 가족 칸은 10,000천원인 경우의 그 가족 수 세액에서 시작
    assert.equal(tax(12_000_000, 2), 1_431_570 + 25_000 + 686_000);
  });

  it('8세 이상 20세 이하 자녀 공제: 20,830 / 45,830 / 45,830 + 2명 초과 1명당 33,330', () => {
    assert.deepEqual([0, 1, 2, 3, 4].map((n) => childDeductionFor(T.simpleTax, n)), [0, 20_830, 45_830, 79_160, 112_490]);
    const w = (pay: number, dependents: number, children8to20: number, pct: 80 | 100 | 120 = 100) => withholding(T.simpleTax, { monthlyTaxablePay: pay, dependents, children8to20, pct });
    // 5,000천원 가족 4명 219,100 − 자녀 2명 45,830 = 173,270
    assert.equal(w(5_000_000, 4, 2).incomeTax, 173_270);
    assert.equal(w(5_000_000, 4, 2).localIncomeTax, 17_320, '17,327 → 10원 미만 절사');
    // 공제한 금액이 음수면 0원(별표 2 제3호 단서): 2,500천원 가족 3명 16,530 − 20,830
    assert.equal(w(2_500_000, 3, 1).incomeTax, 0);
    assert.equal(w(2_500_000, 3, 1).localIncomeTax, 0);
  });

  it('80%·120% 선택, 지방소득세 10%, 10원 미만 절사', () => {
    const w = (pct: 80 | 100 | 120) => withholding(T.simpleTax, { monthlyTaxablePay: 2_500_000, dependents: 3, children8to20: 0, pct });
    // 16,530 × 80% = 13,224 → 13,220 / 120% = 19,836 → 19,830
    assert.deepEqual([w(80).incomeTax, w(100).incomeTax, w(120).incomeTax], [13_220, 16_530, 19_830]);
    assert.deepEqual([w(80).localIncomeTax, w(100).localIncomeTax, w(120).localIncomeTax], [1_320, 1_650, 1_980]);
  });

  it('공제대상가족 11명 초과: 11명 세액 − (10명 − 11명) × 초과 인원', () => {
    // 5,000천원: 10명 106,600, 11명 87,850 → 12명 69,100, 13명 50,350
    assert.equal(tax(5_000_000, 12), 69_100);
    assert.equal(tax(5_000_000, 13), 50_350);
  });
});

describe('4대보험 예상치(2026년 요율, 끝처리 검수 필요)', () => {
  const base = { monthlyTaxablePay: 2_500_000, pensionBase: null, healthBase: null, pensionApplies: true, healthApplies: true, employmentApplies: true, employerSize: 'under150' as const, industrialAccidentPpm: null };
  it('연금 4.75%·건강 3.595%·장기요양(건강 × 0.9448/7.19)·고용 0.9%', () => {
    const r = insurance(T.insurance, T.pensionBounds, base);
    // 118,750 / 89,875 → 89,870 / 89,870 × 9448 ÷ 71900 = 11,809.3 → 11,800 / 22,500
    assert.deepEqual([r.employee.pension, r.employee.health, r.employee.ltc, r.employee.employment], [118_750, 89_870, 11_800, 22_500]);
    // 사업주 고용: 실업급여 0.9% + 150인 미만 고용안정 0.25% = 1.15% → 28,750
    assert.equal(r.employer.employment, 28_750);
  });
  it('연금 기준소득월액 상·하한(2025.7 고시 / 2026.7 고시)', () => {
    const before = at('2026-06-10', '2026-06-01');
    assert.equal(insurance(before.insurance, before.pensionBounds, { ...base, monthlyTaxablePay: 7_000_000 }).employee.pension, 302_570, '6,370,000 × 4.75% = 302,575');
    assert.equal(insurance(before.insurance, before.pensionBounds, { ...base, monthlyTaxablePay: 300_000 }).employee.pension, 19_000, '400,000 × 4.75%');
    assert.equal(insurance(T.insurance, T.pensionBounds, { ...base, monthlyTaxablePay: 7_000_000 }).employee.pension, 313_020, '6,590,000 × 4.75% = 313,025');
    assert.equal(insurance(T.insurance, T.pensionBounds, { ...base, monthlyTaxablePay: 300_000 }).employee.pension, 19_470, '410,000 × 4.75% = 19,475');
    // 천원 미만 절사 뒤 요율: 2,345,678 → 2,345,000 × 4.75% = 111,387.5 → 111,380
    assert.equal(insurance(T.insurance, T.pensionBounds, { ...base, monthlyTaxablePay: 2_345_678 }).employee.pension, 111_380);
  });
});

describe('급여 한 줄(공식 표)', () => {
  it('식대 20만원 비과세 → 과세 2,500천원 가족 1명 35,600 / 3,560', () => {
    const r = computePayroll({
      month: '2026-11',
      employee: { payType: 'monthly', basePay: 2_500_000, nontax: { meal: 200_000 }, dependents: 1, children8to20: 0, withholdingPct: 100, pensionApplies: true, healthApplies: true, employmentApplies: true, pensionBase: null, healthBase: null },
    }, T);
    assert.equal(r.gross, 2_700_000);
    assert.equal(r.nontax, 200_000);
    assert.deepEqual([r.incomeTax, r.localIncomeTax], [35_600, 3_560]);
    assert.deepEqual([r.pensionEst, r.healthEst, r.ltcEst, r.employmentEst], [118_750, 89_870, 11_800, 22_500]);
    assert.ok(r.notes.includes('table_needs_review:insurance-2026'));
    assert.ok(!r.notes.includes('table_needs_review:simple-tax-2026-03'));
  });
});

describe('세전 → 세후(takeHome, 핵심 API)', () => {
  const st = { nontax: { meal: 200_000 }, dependents: 1, children8to20: 0, withholdingPct: 100 as const, pensionApplies: true, healthApplies: true, employmentApplies: true };
  it('세전 2,700,000(식대 20만 비과세 포함) 가족 1명 → 세후 2,417,920', () => {
    const r = takeHome({ month: '2026-11', gross: 2_700_000, settings: st }, T);
    assert.deepEqual([r.gross, r.nontax, r.taxable], [2_700_000, 200_000, 2_500_000]);
    assert.deepEqual([r.incomeTax, r.localIncomeTax, r.pension, r.health, r.ltc, r.employment], [35_600, 3_560, 118_750, 89_870, 11_800, 22_500]);
    assert.equal(r.totalDeduction, 282_080);
    assert.equal(r.net, 2_417_920);
  });
  it('가족·자녀·비율·보험 적용은 설정값으로: 5,000천원 가족 4명 자녀 2명 120%, 고용보험 미적용', () => {
    const r = takeHome({ month: '2026-11', gross: 5_000_000, settings: { ...st, nontax: {}, dependents: 4, children8to20: 2, withholdingPct: 120, employmentApplies: false } }, T);
    // (219,100 − 45,830) × 120% = 207,924 → 207,920, 지방 20,792 → 20,790
    assert.deepEqual([r.incomeTax, r.localIncomeTax, r.employment], [207_920, 20_790, 0]);
    // 연금 5,000,000 × 4.75% = 237,500, 건강 179,750, 장기요양 179,750 × 9448 ÷ 71900 = 23,620.0 → 23,620
    assert.deepEqual([r.pension, r.health, r.ltc], [237_500, 179_750, 23_620]);
    assert.equal(r.net, 5_000_000 - r.totalDeduction);
  });
  it('비과세가 세전보다 크면 거부, 한도 넘는 비과세는 과세로', () => {
    assert.throws(() => takeHome({ month: '2026-11', gross: 100_000, settings: st }, T), /nontax_exceeds_gross/);
    const r = takeHome({ month: '2026-11', gross: 2_750_000, settings: { ...st, nontax: { meal: 250_000 } } }, T);
    assert.deepEqual([r.nontax, r.taxable], [200_000, 2_550_000]);
    assert.ok(r.notes.includes('nontax_over_limit:meal'));
  });
  it('근무표 보조: 시급 × 그달 근무 합계 = 세전 제안값(가산·주휴 없음)', () => {
    const shifts = [
      { workDay: '2026-11-02', startsAt: '09:00', endsAt: '18:00', breakMinutes: 60 },
      { workDay: '2026-11-03', startsAt: '22:00', endsAt: '06:00', breakMinutes: 30 },
    ];
    // 480 + 450 = 930분 × 10,320원 ÷ 60 = 159,960
    assert.deepEqual(suggestGross('2026-11', 10_320, shifts), { workDays: 2, workMinutes: 930, suggestedGross: 159_960 });
  });
});
