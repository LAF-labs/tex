// M1-2 11-05 테이블 저장소(ADR-031·032·034)와 M2-6 감사 체인·텔레메트리 형태 검증.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  BundleExportRepo, BundleRepo, bucket5, CardRepo, cardMatchKeys, CashSalesRepo, ColumnCipher, ColumnCipherError, deriveColumnKey, DocumentRepo, EmployeeRepo,
  JournalShapeError, maskRrn, openDatabase, PayrollRepo, ConsentRepo, OnboardingRepo, ProfileRepo, RateTableRepo, ReceiptRepo, RunJournal, RunRepo, shapeTelemetry, ShiftRepo, syntheticBizNo,
  type CardTxnInput, type Db, type PayrollLine,
} from '@sax/db';

let dir: string;
let db: Db;
let profileId: string;
let cipher: ColumnCipher;
const dbKey = new Uint8Array(randomBytes(32));

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-repo-'));
  db = openDatabase(path.join(dir, 'db.sqlite'), dbKey);
  profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(3), corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  cipher = new ColumnCipher(deriveColumnKey(dbKey));
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const emp = (over: Record<string, unknown> = {}) => ({ profileId, name: '김직원', birthDate: '1990-01-01', hiredOn: '2025-03-02', basePay: 2_500_000, dependents: 1, ...over });

describe('DB 키 암호화 컬럼', () => {
  it('행 ID가 AAD라 다른 행으로 옮기면 열리지 않고, 다른 DB 키에서 파생한 키로도 열리지 않는다', () => {
    const blob = cipher.seal('9001011234567', 'employees.rrn_enc:a');
    assert.equal(cipher.open(blob, 'employees.rrn_enc:a'), '9001011234567');
    assert.throws(() => cipher.open(blob, 'employees.rrn_enc:b'), ColumnCipherError);
    assert.throws(() => new ColumnCipher(deriveColumnKey(new Uint8Array(randomBytes(32)))).open(blob, 'employees.rrn_enc:a'), ColumnCipherError);
    assert.ok(!Buffer.from(blob).toString('latin1').includes('900101'));
  });
});

describe('직원(employees)', () => {
  it('최소 입력으로 만들고 기본값(월급제·100%·보험 적용)을 채운다. 주민번호는 선택', () => {
    const e = new EmployeeRepo(db, cipher).create(emp());
    assert.equal(e.payType, 'monthly');
    assert.equal(e.withholdingPct, 100);
    assert.ok(e.pensionApplies && e.healthApplies && e.employmentApplies);
    assert.equal(e.hasRrn, false);
    assert.equal(new EmployeeRepo(db, cipher).revealRrn(e.id), null);
  });

  it('주민번호: 암호화 컬럼에만, 화면은 가린 값, 생년월일과 어긋나면 거부', () => {
    const repo = new EmployeeRepo(db, cipher);
    const e = repo.create(emp({ name: '이직원', birthDate: '2001-02-03', rrn: '010203-3123456' }));
    assert.equal(e.hasRrn, true);
    assert.ok(!JSON.stringify(e).includes('3123456'));
    assert.equal(repo.maskedRrn(e.id), '010203-3******');
    assert.equal(repo.revealRrn(e.id), '0102033123456');
    const raw = db.prepare('SELECT rrn_enc FROM employees WHERE id=?').pluck().get(e.id) as Buffer;
    assert.ok(!raw.toString('latin1').includes('0102033'));
    assert.throws(() => repo.create(emp({ rrn: '900101-2123456', birthDate: '1991-01-01' })), /rrn_birth_mismatch/);
    assert.throws(() => repo.create(emp({ rrn: '12345' })), /invalid_rrn/);
    assert.throws(() => repo.update(e.id, { birthDate: '2001-02-04' }), /rrn_birth_mismatch/);
    assert.equal(repo.get(e.id)!.birthDate, '2001-02-03', '거부하면 아무것도 바뀌지 않는다');
    repo.update(e.id, { rrn: null });
    assert.equal(repo.get(e.id)!.hasRrn, false);
    assert.equal(maskRrn('9001011234567'), '900101-1******');
  });

  it('입력 검증: 공제대상가족은 본인 포함 1 이상, 8~20세 자녀는 가족 수 - 1 이하, 비율 80·100·120, 금액 정수', () => {
    const repo = new EmployeeRepo(db, cipher);
    assert.throws(() => repo.create(emp({ dependents: 0 })), /invalid_dependents/);
    assert.throws(() => repo.create(emp({ dependents: 2, children8to20: 2 })), /invalid_children_8_20/);
    assert.throws(() => repo.create(emp({ withholdingPct: 90 })), /invalid_withholding_pct/);
    assert.throws(() => repo.create(emp({ basePay: 100.5 })), /invalid_base_pay/);
    assert.throws(() => repo.create(emp({ nontax: { 식대: -1 } })), /invalid_nontax/);
    assert.throws(() => repo.create(emp({ birthDate: '1990-02-30' })), /invalid_birth_date/);
    assert.throws(() => repo.create(emp({ leftOn: '2025-01-01' })), /invalid_left_on/);
  });

  it('그달 재직자만 고른다(입사·퇴사 경계)', () => {
    const repo = new EmployeeRepo(db, cipher);
    const p2 = new ProfileRepo(db).upsert({ kind: 'personal', displayName: '본인', bizNo: null, corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
    repo.create(emp({ profileId: p2, name: 'a', hiredOn: '2026-11-30' }));
    repo.create(emp({ profileId: p2, name: 'b', hiredOn: '2026-01-01', leftOn: '2026-10-01' }));
    repo.create(emp({ profileId: p2, name: 'c', hiredOn: '2026-12-01' }));
    assert.deepEqual(repo.list(p2, { activeInMonth: '2026-11' }).map((e) => e.name), ['a']);
    assert.deepEqual(repo.list(p2, { activeInMonth: '2026-10' }).map((e) => e.name), ['b']);
  });
});

const line = (employeeId: string, gross = 2_700_000): PayrollLine => ({
  employeeId, workDays: 21, workMinutes: 9_840, overtimeMinutes: null, nightMinutes: null, holidayMinutes: null,
  items: [{ name: '기본급', amount: gross - 200_000, taxable: true, calc: '월급' }, { name: '식대', amount: 200_000, taxable: false, calc: '월 20만 원 비과세' }],
  gross, nontax: 200_000, incomeTax: 41_630, localIncomeTax: 4_160, pensionEst: 118_750, healthEst: 89_870, ltcEst: 11_800, employmentEst: 22_500,
  pensionNotice: null, healthNotice: null, ltcNotice: null, employmentNotice: null,
  employer: { pensionEst: 118_750, healthEst: 89_870, ltcEst: 11_800, employmentEst: 28_750, industrialAccidentEst: null, pensionNotice: null, healthNotice: null, ltcNotice: null, employmentNotice: null, industrialAccidentNotice: null },
  netPay: gross - 41_630 - 4_160 - 118_750 - 89_870 - 11_800 - 22_500,
});

describe('급여대장 달·개정(payroll_months·payroll_lines)', () => {
  it('초안 → 줄 → 확인. 확인한 개정은 고칠 수 없고 revise로 다음 개정을 만든다(줄 복사)', () => {
    const e = new EmployeeRepo(db, cipher).create(emp({ name: '박직원' }));
    const pr = new PayrollRepo(db);
    const m = pr.openDraft(profileId, '2026-10', ['ins-2026', 'tax-2024']);
    assert.equal(m.revision, 1);
    assert.equal(pr.openDraft(profileId, '2026-10', []).revision, 1, '초안은 하나');
    assert.throws(() => pr.confirm(profileId, '2026-10', 1), /no_lines/);
    pr.putLine(profileId, '2026-10', 1, line(e.id));
    pr.putLine(profileId, '2026-10', 1, line(e.id, 2_800_000));
    assert.equal(pr.lines(profileId, '2026-10', 1)[0]!.gross, 2_800_000, '같은 직원은 덮어쓴다');
    const c = pr.confirm(profileId, '2026-10', 1, '2026-11-05T00:00:00Z');
    assert.equal(c.status, 'confirmed');
    assert.throws(() => pr.putLine(profileId, '2026-10', 1, line(e.id)), /month_confirmed/);
    assert.throws(() => pr.openDraft(profileId, '2026-10', []), /month_confirmed_use_revise/);
    const r2 = pr.revise(profileId, '2026-10');
    assert.equal(r2.revision, 2);
    assert.deepEqual(r2.rateTableIds, ['ins-2026', 'tax-2024']);
    assert.equal(pr.lines(profileId, '2026-10', 2).length, 1);
    assert.equal(pr.latestConfirmed(profileId, '2026-10')!.revision, 1);
    assert.deepEqual(pr.revisions(profileId, '2026-10').map((x) => x.status), ['confirmed', 'draft']);
  });

  it('지급 항목 합이 총액과 어긋나거나 금액이 정수가 아니면 넣지 않는다', () => {
    const e = new EmployeeRepo(db, cipher).create(emp({ name: '최직원' }));
    const pr = new PayrollRepo(db);
    pr.openDraft(profileId, '2026-09', []);
    assert.throws(() => pr.putLine(profileId, '2026-09', 1, { ...line(e.id), gross: 1 }), /items_gross_mismatch/);
    assert.throws(() => pr.putLine(profileId, '2026-09', 1, { ...line(e.id), nontax: 0 }), /items_nontax_mismatch/);
    assert.throws(() => pr.putLine(profileId, '2026-09', 1, { ...line(e.id), incomeTax: 1.5 }), /invalid_incomeTax/);
  });
});

describe('근무표·시행일 표', () => {
  it('근무표: 형식 검사, 근무일 기준 달 조회', () => {
    const e = new EmployeeRepo(db, cipher).create(emp({ name: '알바', payType: 'hourly', basePay: 10_320 }));
    const s = new ShiftRepo(db);
    s.put({ profileId, employeeId: e.id, workDay: '2026-11-30', startsAt: '22:00', endsAt: '02:00', breakMinutes: 30 });
    s.put({ profileId, employeeId: e.id, workDay: '2026-12-01', startsAt: '09:00', endsAt: '13:00', breakMinutes: 0 });
    assert.deepEqual(s.month(profileId, e.id, '2026-11').map((x) => x.workDay), ['2026-11-30']);
    assert.throws(() => s.put({ profileId, employeeId: e.id, workDay: '2026-11-01', startsAt: '9:00', endsAt: '13:00', breakMinutes: 0 }), /invalid_time/);
    assert.throws(() => s.put({ profileId, employeeId: e.id, workDay: '2026-11-01', startsAt: '09:00', endsAt: '09:00', breakMinutes: 0 }), /empty_shift/);
  });

  it('시행일 표: 서명 없는 표·겹치는 기간 거부, 그날 시행 중인 표를 고른다', () => {
    const r = new RateTableRepo(db);
    const t = { kind: 'pension_bounds' as const, rounding: 'floor_10', packageVersion: '2026.1', signatureOk: true };
    r.install({ ...t, id: 'pb-2025-07', effectiveFrom: '2025-07-01', effectiveTo: '2026-06-30', body: { min: 400_000, max: 6_370_000 } });
    r.install({ ...t, id: 'pb-2026-07', effectiveFrom: '2026-07-01', effectiveTo: null, body: { min: 410_000, max: 6_590_000 } });
    r.install({ ...t, id: 'pb-2026-07', effectiveFrom: '2026-07-01', effectiveTo: null, body: { min: 410_000, max: 6_590_000 } });
    assert.throws(() => r.install({ ...t, id: 'pb-x', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', body: {} }), /rate_table_overlap/);
    assert.throws(() => r.install({ ...t, id: 'pb-2026-07', effectiveFrom: '2026-07-01', effectiveTo: null, body: { min: 1 } }), /rate_table_id_reused/);
    assert.throws(() => r.install({ ...t, signatureOk: false, id: 'pb-y', effectiveFrom: '2030-01-01', effectiveTo: null, body: {} }), /rate_table_unsigned/);
    assert.equal(r.effectiveOn('pension_bounds', '2026-06-30')!.id, 'pb-2025-07');
    assert.equal(r.effectiveOn('pension_bounds', '2026-07-01')!.id, 'pb-2026-07');
    assert.equal(r.effectiveOn('pension_bounds', '2025-06-30'), null);
  });

  it('열린 표 뒤에 다음 해 표를 넣을 수 있고(앞 표는 그 전날까지), 같은 시작일은 거부, 열린 끝을 닫는 재설치는 고친다', () => {
    const r = new RateTableRepo(db);
    const t = { kind: 'insurance_rate' as const, rounding: 'floor_10', packageVersion: '2026.1', signatureOk: true };
    r.install({ ...t, id: 'ins-2026', effectiveFrom: '2026-01-01', effectiveTo: null, body: { y: 2026 } });
    r.install({ ...t, id: 'ins-2027', effectiveFrom: '2027-01-01', effectiveTo: null, body: { y: 2027 } });
    assert.equal(r.effectiveOn('insurance_rate', '2026-12-31')!.id, 'ins-2026');
    assert.equal(r.effectiveOn('insurance_rate', '2027-01-01')!.id, 'ins-2027');
    assert.throws(() => r.install({ ...t, id: 'ins-2027b', effectiveFrom: '2027-01-01', effectiveTo: null, body: {} }), /rate_table_overlap/);
    assert.throws(() => r.install({ ...t, id: 'ins-mid', effectiveFrom: '2026-06-01', effectiveTo: '2027-02-01', body: {} }), /rate_table_overlap/, '닫힌 기간이 다음 표를 넘으면 거부');
    // 열린 끝을 날짜로 닫는 재설치는 받는다. 다시 열거나 다른 날짜로 바꾸는 것은 거부
    r.install({ ...t, id: 'ins-2026', effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', body: { y: 2026 } });
    assert.equal(r.get('ins-2026')!.effectiveTo, '2026-12-31');
    assert.throws(() => r.install({ ...t, id: 'ins-2026', effectiveFrom: '2026-01-01', effectiveTo: null, body: { y: 2026 } }), /rate_table_id_reused/);
    // 중간에 닫힌 표가 끼면 그 뒤는 빈 기간(앞의 열린 표가 되살아나지 않는다)
    const u = { ...t, kind: 'nontax_limits' as const };
    r.install({ ...u, id: 'nt-a', effectiveFrom: '2026-01-01', effectiveTo: null, body: {} });
    r.install({ ...u, id: 'nt-b', effectiveFrom: '2026-03-01', effectiveTo: '2026-04-30', body: {} });
    assert.equal(r.effectiveOn('nontax_limits', '2026-02-28')!.id, 'nt-a');
    assert.equal(r.effectiveOn('nontax_limits', '2026-04-30')!.id, 'nt-b');
    assert.equal(r.effectiveOn('nontax_limits', '2026-05-01'), null);
  });

  it('서명 배포 패키지 설치(M6-10): 한 트랜잭션, 하나라도 거부되면 기존 표·설치 기록 그대로, 같은 표는 처음 실린 판 유지', () => {
    const r = new RateTableRepo(db);
    const t = { kind: 'simple_tax_table' as const, rounding: 'floor_10', signatureOk: true };
    const D1 = '1'.repeat(64), D2 = '2'.repeat(64);
    assert.equal(r.installedPackage('payroll.rate-tables'), null);
    const v1 = [{ ...t, id: 'st-2026', effectiveFrom: '2026-03-01', effectiveTo: null, body: { y: 2026 }, packageVersion: '2026.11.1' }];
    assert.deepEqual(r.installPackage({ id: 'payroll.rate-tables', version: '2026.11.1', digest: D1 }, v1, '2026-11-06T00:00:00Z'), { added: ['st-2026'], closed: [], unchanged: [] });
    assert.deepEqual(r.installedPackage('payroll.rate-tables'), { version: '2026.11.1', digest: D1, installedAt: '2026-11-06T00:00:00Z' });
    // 다음 판: 같은 표를 다시 싣고 열린 끝을 닫고, 다음 표를 더한다
    const v2 = [
      { ...v1[0]!, effectiveTo: '2027-02-28', packageVersion: '2027.1.0' },
      { ...t, id: 'st-2027', effectiveFrom: '2027-03-01', effectiveTo: null, body: { y: 2027 }, packageVersion: '2027.1.0' },
    ];
    assert.deepEqual(r.installPackage({ id: 'payroll.rate-tables', version: '2027.1.0', digest: D2 }, v2), { added: ['st-2027'], closed: ['st-2026'], unchanged: [] });
    assert.equal(r.get('st-2026')!.packageVersion, '2026.11.1', '처음 실린 판');
    assert.equal(r.get('st-2027')!.packageVersion, '2027.1.0');
    assert.deepEqual(r.installPackage({ id: 'payroll.rate-tables', version: '2027.1.0', digest: D2 }, v2), { added: [], closed: [], unchanged: ['st-2026', 'st-2027'] }, '재설치');
    // 앞 행은 새 표(받을 수 있음), 뒤 행이 같은 id 다른 내용 → 전부 되돌림
    const bad = [
      { ...t, id: 'st-2028', effectiveFrom: '2028-03-01', effectiveTo: null, body: { y: 2028 }, packageVersion: '2028.1.0' },
      { ...v2[1]!, body: { y: 9999 }, packageVersion: '2028.1.0' },
    ];
    assert.throws(() => r.installPackage({ id: 'payroll.rate-tables', version: '2028.1.0', digest: '3'.repeat(64) }, bad), /rate_table_id_reused/);
    assert.equal(r.get('st-2028'), null, '앞 행도 들어가지 않음');
    assert.equal(r.installedPackage('payroll.rate-tables')!.version, '2027.1.0', '설치 기록 그대로');
    assert.equal(r.effectiveOn('simple_tax_table', '2028-06-01')!.id, 'st-2027', '기존 표로 계속');
    assert.throws(() => r.installPackage({ id: 'payroll.rate-tables', version: '2028.1', digest: D2 }, v2), /invalid_package_version/);
    assert.throws(() => r.installPackage({ id: 'x', version: '2028.1.0', digest: D2 }, v2), /invalid_package_id/);
    assert.throws(() => r.installPackage({ id: 'payroll.rate-tables', version: '2028.1.0', digest: 'zz' }, v2), /invalid_package_digest/);
    assert.throws(() => r.installPackage({ id: 'payroll.rate-tables', version: '2028.1.0', digest: D2 }, []), /empty_package/);
  });
});

describe('세무사 꾸러미 항목·달별 상태·내보내기 기록', () => {
  it('항목·상태(해당 없음 포함)·첨부 문서, 3층만 지울 수 있고 기록이 있으면 끈다', () => {
    const b = new BundleRepo(db);
    const fixed = b.addItem({ profileId, tier: 1, kind: 'payroll', name: '급여대장', cadence: 'monthly', source: 'builtin' });
    const extra = b.addItem({ profileId, tier: 3, kind: 'custom', name: '차량 운행일지', cadence: 'quarterly', source: 'user' });
    assert.throws(() => b.removeItem(fixed.id), /builtin_item_fixed/);
    const docId = randomUUID();
    new DocumentRepo(db).insert({ id: docId, profileId, docType: 'paper_receipt', displayName: null, issuedAt: null, expiresAt: null, issuer: null, path: '/v/x.jpg', bytes: 1, sha256: 'a'.repeat(64), meta: null, runId: null });
    b.setEntry({ itemId: extra.id, period: '2026-Q4', status: 'ready', docIds: [docId, docId] });
    assert.deepEqual(b.entry(extra.id, '2026-Q4')!.docIds, [docId]);
    b.setEntry({ itemId: fixed.id, period: '2026-10', status: 'not_applicable', note: '이번 달 급여 없음' });
    assert.equal(b.entries(profileId, ['2026-10'])[0]!.status, 'not_applicable');
    assert.throws(() => b.setEntry({ itemId: fixed.id, period: '2026-13', status: 'ready' }), /invalid_period/);
    assert.throws(() => b.setEntry({ itemId: fixed.id, period: '2026-10', status: 'ready', docIds: ['nope'] }), /doc_not_found/);
    assert.equal(b.removeItem(extra.id), 'disabled');
    const tmpItem = b.addItem({ profileId, tier: 3, kind: 'custom', name: '임대차계약서', cadence: 'once', source: 'pasted_request' });
    assert.equal(b.removeItem(tmpItem.id), 'deleted');
  });

  it('내보내기 기록: 해시·경로·시각, 연 방법·주소, 보냈어요 표시', () => {
    const x = new BundleExportRepo(db);
    const e = x.record({ profileId, period: '2026-10', sha256: 'b'.repeat(64), path: '/exports/2026-10.xlsx' }, '2026-11-05T01:00:00Z');
    x.markOpened(e.id, 'mail_client', 'tax@example.com');
    x.markSent(e.id, '문자로 암호 보냄', '2026-11-05T02:00:00Z');
    const got = x.list(profileId, '2026-10')[0]!;
    assert.equal(got.sendVia, 'mail_client');
    assert.equal(got.sentMarkedAt, '2026-11-05T02:00:00Z');
    assert.throws(() => x.record({ profileId, period: '2026-10', sha256: 'zz', path: '/a' }), /invalid_sha256/);
    assert.deepEqual([got.zipPath, got.zipSha256], [null, null]);
    assert.equal(got.rrnIncluded, false, '주민번호는 기본 가림');
    // 엑셀과 첨부 ZIP은 한 기록(메일 한 통)
    const two = x.record({ profileId, period: '2026-11', sha256: 'c'.repeat(64), path: '/exports/a.xlsx', zip: { path: '/exports/a.zip', sha256: 'd'.repeat(64) }, rrnIncluded: true });
    assert.deepEqual([two.zipPath, two.zipSha256, two.rrnIncluded], ['/exports/a.zip', 'd'.repeat(64), true]);
    assert.throws(() => x.record({ profileId, period: '2026-11', sha256: 'c'.repeat(64), path: '/a', zip: { path: '/a.zip', sha256: 'x' } }), /invalid_zip/);
    assert.throws(() => db.prepare("INSERT INTO bundle_exports (id, profile_id, period, sha256, path, created_at, zip_path) VALUES ('z', ?, '2026-11', 'a', '/a', 'now', '/a.zip')").run(profileId), /CHECK/, 'ZIP 경로와 해시는 같이');
  });

  it('"카드 전표로 충분": 시작 달을 프로필별로 두고 끌 수 있다', () => {
    const b = new BundleRepo(db);
    assert.equal(b.cardSlipEnoughFrom(profileId), null);
    b.setCardSlipEnough(profileId, '2026-12');
    assert.equal(b.cardSlipEnoughFrom(profileId), '2026-12');
    b.setCardSlipEnough(profileId, '2027-01');
    assert.equal(b.cardSlipEnoughFrom(profileId), '2027-01');
    b.setCardSlipEnough(profileId, null);
    assert.equal(b.cardSlipEnoughFrom(profileId), null);
    assert.throws(() => b.setCardSlipEnough(profileId, '2026-13'), /invalid_month/);
    b.setCardSlipEnough(profileId, '2026-12');
    assert.ok(db.prepare('SELECT 1 FROM settings WHERE key = ?').get(`profile.${profileId}.bundle.cardSlipEnoughFrom`), 'D07 프로필별 설정 키');
  });

  it('설정 bundle.includeRrn: 기본 false(가림), 켜고 끌 수 있다', () => {
    const b = new BundleRepo(db);
    assert.equal(b.includeRrn(profileId), false);
    b.setIncludeRrn(profileId, true);
    assert.equal(b.includeRrn(profileId), true);
    assert.ok(db.prepare('SELECT 1 FROM settings WHERE key = ?').get(`profile.${profileId}.bundle.includeRrn`));
    b.setIncludeRrn(profileId, false);
    assert.equal(b.includeRrn(profileId), false);
  });

  it('현금매출: 하루 한 숫자, 다시 넣으면 나중 값으로 바꾸고 이전 값을 알려 준다', () => {
    const c = new CashSalesRepo(db);
    assert.equal(c.put({ profileId, day: '2026-11-01', amount: 120_000, source: 'phone' }).replaced, null);
    assert.equal(c.put({ profileId, day: '2026-11-01', amount: 130_000, source: 'pc' }).replaced!.amount, 120_000);
    assert.equal(c.range(profileId, '2026-11-01', '2026-11-30')[0]!.amount, 130_000);
    assert.throws(() => c.put({ profileId, day: '2026-11-02', amount: -1, source: 'pc' }), /invalid_amount/);
  });

  it('종이 증빙: paper_receipt 문서만, 폰 메시지 ID 중복은 한 번만', () => {
    const r = new ReceiptRepo(db);
    const docId = randomUUID();
    new DocumentRepo(db).insert({ id: docId, profileId, docType: 'paper_receipt', displayName: null, issuedAt: null, expiresAt: null, issuer: null, path: '/v/r.jpg', bytes: 1, sha256: 'c'.repeat(64), meta: null, runId: null });
    assert.equal(r.add({ docId, source: 'phone_capture', phoneMsgId: 'm1' }), true);
    assert.equal(r.add({ docId, source: 'phone_capture', phoneMsgId: 'm1' }), false);
    r.confirm(docId, { issuedOn: '2026-11-03', merchant: '문구점', merchantBizNo: null, amount: 15_000 });
    assert.equal(r.list(profileId, '2026-11-01', '2026-11-30').length, 1);
  });
});

describe('사업용 카드 [최신화] 구간 교체와 메모 다시 잇기', () => {
  const t = (usedOn: string, amount: number, approvalNo: string | null, canceled = false): CardTxnInput => ({
    usedOn, merchant: '가게', merchantBizNo: '1234567890', cardLast4: '1234', approvalNo, amount, supplyAmount: null, vatAmount: null, canceled,
  });
  const runRow = () => {
    const id = randomUUID();
    new RunRepo(db).create({ id, playbookId: 'H-12', playbookVersion: '1.0.0', packageDigest: 'd'.repeat(64), profileId, trigger: 'local', inputsHash: 'i'.repeat(64) });
    return id;
  };

  it('match_key: 날짜·승인번호 기준, 없으면 날짜·가게·금액·카드, 승인과 취소는 갈리고 같은 값은 #n', () => {
    assert.deepEqual(cardMatchKeys([t('2026-11-01', 5000, 'A1'), t('2026-11-01', 5000, 'A1', true), t('2026-11-02', 3000, null), t('2026-11-02', 3000, null)]), [
      'a|2026-11-01|A1|0|5000#1', 'a|2026-11-01|A1|1|5000#1', 'd|2026-11-02|1234567890|3000|1234|0#1', 'd|2026-11-02|1234567890|3000|1234|0#2',
    ]);
  });

  it('같은 구간을 다시 받으면 통째 교체되고, 메모는 새 행에 다시 이어진다. 못 이으면 수로 알린다', () => {
    const cr = new CardRepo(db);
    const r1 = runRow();
    cr.replaceRange({ runId: r1, profileId, rangeFrom: '2026-11-01', rangeTo: '2026-11-30', completedAt: '2026-11-05T01:00:00Z' }, [t('2026-11-01', 5000, 'A1'), t('2026-11-02', 3000, null)]);
    const [a] = cr.txns(profileId, '2026-11-01', '2026-11-30');
    cr.setMemo(a!.id, '거래처 점심');
    const r2 = runRow();
    const res = cr.replaceRange({ runId: r2, profileId, rangeFrom: '2026-11-01', rangeTo: '2026-11-30', completedAt: '2026-11-05T02:00:00Z' }, [t('2026-11-02', 3000, null), t('2026-11-01', 5000, 'A1'), t('2026-11-03', 7000, 'B2')]);
    assert.deepEqual(res, { inserted: 3, unmatchedMemos: 0 });
    const rows = cr.txns(profileId, '2026-11-01', '2026-11-30');
    assert.equal(rows.length, 3, '이전 조회의 행은 남지 않는다');
    assert.equal(cr.memos(profileId)[0]!.txnId, rows.find((x) => x.approvalNo === 'A1')!.id);
    const r3 = runRow();
    const gone = cr.replaceRange({ runId: r3, profileId, rangeFrom: '2026-11-01', rangeTo: '2026-11-30', completedAt: '2026-11-05T03:00:00Z' }, []);
    assert.deepEqual(gone, { inserted: 0, unmatchedMemos: 1 }, '빈 결과도 최신화, 메모는 확인 필요');
    assert.equal(cr.lastFetch(profileId)!.completedAt, '2026-11-05T03:00:00Z');
    assert.throws(() => cr.replaceRange({ runId: runRow(), profileId, rangeFrom: '2026-11-01', rangeTo: '2026-11-30', completedAt: 'x' }, [t('2026-12-01', 1, 'Z')]), /txn_outside_range/);
  });

  it('다른 달의 같은 승인번호·금액은 메모를 빼앗지 않고, 확인 필요 수는 이번 교체에서 잃은 메모만 센다', () => {
    const cr = new CardRepo(db);
    const day = (m: string) => ({ runId: runRow(), profileId, rangeFrom: `2026-${m}-01`, rangeTo: `2026-${m}-28`, completedAt: `2026-${m}-28T00:00:00Z` });
    cr.replaceRange(day('09'), [t('2026-09-10', 9900, 'R1')]);
    const sep = cr.txns(profileId, '2026-09-01', '2026-09-28')[0]!;
    cr.setMemo(sep.id, '9월 메모');
    cr.replaceRange(day('08'), [t('2026-08-03', 1000, 'Q1')]);
    cr.setMemo(cr.txns(profileId, '2026-08-01', '2026-08-28')[0]!.id, '8월 메모');
    // 8월을 비워서 8월 메모 하나가 뜬다
    assert.equal(cr.replaceRange(day('08'), []).unmatchedMemos, 1);
    // 10월에 같은 승인번호·금액: 9월 메모는 9월 행에 그대로, 10월 행에 메모 없음. 8월에 떠 있던 메모는 10월 결과로 세지 않는다
    assert.deepEqual(cr.replaceRange(day('10'), [t('2026-10-10', 9900, 'R1')]), { inserted: 1, unmatchedMemos: 0 });
    const oct = cr.txns(profileId, '2026-10-01', '2026-10-28')[0]!;
    const memos = cr.memos(profileId);
    assert.equal(memos.find((m) => m.memo === '9월 메모')!.txnId, sep.id);
    assert.ok(!memos.some((m) => m.txnId === oct.id));
    // 10월 행에 메모를 달아도 9월 메모를 덮어쓰지 않는다
    cr.setMemo(oct.id, '10월 메모');
    assert.equal(cr.memos(profileId).find((m) => m.txnId === sep.id)!.memo, '9월 메모');
  });
});

describe('감사 저널 해시 체인(M2-6)', () => {
  const newRun = () => {
    const id = randomUUID();
    new RunRepo(db).create({ id, playbookId: 'H-01', playbookVersion: '1.0.0', packageDigest: 'd'.repeat(64), profileId, trigger: 'local', inputsHash: 'i'.repeat(64) });
    return id;
  };

  it('정상 체인은 통과하고, 중간 행을 고치거나 지우면 그 seq에서 끊긴다', () => {
    const j = new RunJournal(db);
    const run = newRun();
    j.append(run, 'run.started', { mode: 'local' });
    j.append(run, 'gate.requested', { reqId: 'r1' });
    j.append(run, 'run.ended', { status: 'ok' });
    const ok = j.verify(run);
    assert.ok(ok.ok && ok.count === 3);
    const seqs = db.prepare('SELECT seq FROM run_events WHERE run_id=? ORDER BY seq').pluck().all(run) as number[];
    db.prepare(`UPDATE run_events SET payload_json='{"reqId":"r2"}' WHERE seq=?`).run(seqs[1]);
    assert.deepEqual(j.verify(run), { ok: false, count: 1, brokenAtSeq: seqs[1], reason: 'hash' });
    assert.deepEqual(j.verifyRuns([run]), [run]);
    const run2 = newRun();
    j.append(run2, 'run.started', {});
    j.append(run2, 'run.ended', {});
    const s2 = db.prepare('SELECT seq FROM run_events WHERE run_id=? ORDER BY seq').pluck().all(run2) as number[];
    db.prepare('DELETE FROM run_events WHERE seq=?').run(s2[0]);
    assert.equal((j.verify(run2) as { reason: string }).reason, 'prev_hash');
  });

  it('값 없음 원칙 형태 검사: 이벤트 이름이 틀리면 던지고, 긴 문자열·줄바꿈 값은 빼고 필드 이름만 남긴다', () => {
    const j = new RunJournal(db);
    const run = newRun();
    assert.throws(() => j.append(run, 'Bad Type', {}), JournalShapeError);
    // payload의 type 필드가 형태 검사에 걸려도 이벤트 이름 오류가 아니다: 그 필드만 빼고 기록한다
    const run3 = newRun();
    j.append(run3, 'step.note', { type: 'x'.repeat(200), ok: true });
    const last = JSON.parse(db.prepare('SELECT payload_json FROM run_events WHERE run_id=?').pluck().get(run3) as string) as Record<string, unknown>;
    assert.deepEqual(last, { ok: true, dropped: 'type' });
    j.append(run, 'step.extract', { stepId: 's1', text: '가'.repeat(200), multi: 'a\nb' });
    const p = JSON.parse(db.prepare('SELECT payload_json FROM run_events WHERE run_id=?').pluck().get(run) as string) as Record<string, string>;
    assert.deepEqual(p, { stepId: 's1', dropped: 'text,multi' });
    // 틀린 필드 이름은 원래 이름을 남기지 않고(값일 수 있다) 'field_name'과 개수만, 한 번
    const run4 = newRun();
    j.append(run4, 'step.note', { '김직원': 1, 'a b': 2, '9x': 3, ok: true, long: 'y'.repeat(200) });
    const q = JSON.parse(db.prepare('SELECT payload_json FROM run_events WHERE run_id=?').pluck().get(run4) as string) as Record<string, unknown>;
    assert.deepEqual(q, { ok: true, dropped: 'long,field_name*3' });
    j.append(run4, 'step.note', { '이름': 1 });
    assert.equal((JSON.parse(db.prepare('SELECT payload_json FROM run_events WHERE run_id=? ORDER BY seq DESC LIMIT 1').pluck().get(run4) as string) as Record<string, unknown>).dropped, 'field_name');
    assert.ok(!(db.prepare('SELECT group_concat(payload_json) FROM run_events WHERE run_id=?').pluck().get(run4) as string).includes('김직원'), '틀린 키 이름도 저널에 없다');
    assert.ok(j.verify(run).ok);
  });
});

describe('텔레메트리 형태 검증(D12 §1)', () => {
  it('허용 필드만 남기고 나머지는 드롭, 건수는 5건 버킷, 시각은 일·시간 단위만', () => {
    const r = shapeTelemetry({ event: 'ledger.daily', playbook: 'H-01@1.2.0', date: '2026-11-05', counts: { committed: 5, in_doubt: 0 }, bizNo: '1234567890', email: 'a@b.c' });
    assert.ok(r.ok);
    assert.deepEqual(r.ok && r.event, { event: 'ledger.daily', playbook: 'H-01@1.2.0', date: '2026-11-05', counts: { committed: 5, in_doubt: 0 } });
    assert.deepEqual(r.ok && r.dropped, ['bizNo', 'email']);
    assert.deepEqual(shapeTelemetry({ event: 'ledger.daily', playbook: 'H-01', date: '2026-11-05', counts: { committed: 3 } }), { ok: false, reason: 'bad_shape', field: 'counts' });
    assert.deepEqual(shapeTelemetry({ event: 'step.fail', playbook: 'H-01', stepId: 's', stableId: 'x', code: 'E1', hour: '2026-11-05T10:31', count: 5 }), { ok: false, reason: 'bad_shape', field: 'hour' });
    assert.deepEqual(shapeTelemetry({ event: 'policy.clamped', policyVer: '3', field: '사업자 화면 텍스트' }), { ok: false, reason: 'bad_shape', field: 'field' });
    assert.deepEqual(shapeTelemetry({ event: 'run.summary' }), { ok: false, reason: 'unknown_event' }, '폐지한 실행당 이벤트');
    assert.deepEqual(shapeTelemetry({ event: 'security.daily' }), { ok: false, reason: 'missing_field', field: 'counts' });
    assert.ok(shapeTelemetry({ event: 'decide.stats.daily', bundle: 'b@1', outcome: 'ok', confidenceBucket: 0.85, counts: 10 }).ok);
    assert.ok(!shapeTelemetry({ event: 'decide.stats.daily', bundle: 'b@1', outcome: 'ok', confidenceBucket: 0.87, counts: 10 }).ok);
    assert.deepEqual([0, 1, 5, 6].map(bucket5), [0, 5, 5, 10]);
  });
});

describe('포털 아이디·동의·온보딩 이어 하기(데스크톱 #69)', () => {
  it('profiles.portal_login_id: 홈택스 아이디는 프로필 정보, 검사는 저장소에서(bad_login_id), upsert가 빼면 그대로 둔다', () => {
    const p = new ProfileRepo(db);
    assert.equal(p.get(profileId)!.portalLoginId, null);
    assert.equal(p.setPortalLoginId(profileId, '  boss01 ').portalLoginId, 'boss01');
    const cur = p.get(profileId)!;
    const input = { kind: cur.kind, displayName: cur.displayName, bizNo: cur.bizNo, corpNo: cur.corpNo, repName: cur.repName, bizType: cur.bizType, bizItem: cur.bizItem, address: cur.address, email: cur.email, signMethod: cur.signMethod };
    assert.equal(p.upsert(input).portalLoginId, 'boss01', '빼면 그대로');
    assert.equal(p.upsert({ ...input, portalLoginId: 'boss02' }).portalLoginId, 'boss02');
    for (const bad of ['a b', '', 'x'.repeat(65), 'a\u0007b']) assert.throws(() => p.setPortalLoginId(profileId, bad), /bad_login_id/);
    assert.throws(() => p.upsert({ ...input, portalLoginId: 'a b' }), /bad_login_id/);
    assert.throws(() => p.setPortalLoginId('nope', 'x'), /profile_not_found/);
    assert.equal(p.setPortalLoginId(profileId, null).portalLoginId, null);
    const cols = (db.prepare('PRAGMA table_info(profiles)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('portal_login_id') && !cols.some((c) => /password|secret|card/i.test(c)), '비밀번호·보안카드 칸 없음');
  });

  it('동의 레코드: 쌓기만 하고 마지막 행이 현재 결정, 프로필 전 약관은 나중에 잇는다', () => {
    const c = new ConsentRepo(db);
    const terms = c.record({ profileId: null, kind: 'terms', noticeVersion: 'terms-2026.11', choice: 'agreed', at: '2026-11-05T00:00:00Z', via: 'onboarding' });
    assert.equal(terms.noticeKey, 'consent.terms');
    c.record({ profileId, kind: 'model', noticeKey: 'consent.model', noticeVersion: 'model-1', processorsVersion: 'proc-3', choice: 'agreed', at: '2026-11-05T00:01:00Z', via: 'onboarding' });
    c.record({ profileId, kind: 'model', noticeVersion: 'model-1', choice: 'declined', at: '2026-11-06T00:00:00Z', via: 'settings' });
    c.record({ profileId, kind: 'delegation', noticeVersion: 'deleg-1', choice: 'agreed', at: '2026-11-05T00:02:00.123Z', via: 'T-06' });
    assert.equal(c.latest(profileId, 'model')!.choice, 'declined');
    assert.equal(c.latest(profileId, 'telemetry'), null);
    assert.equal(c.latest(null, 'terms')!.seq, terms.seq);
    assert.equal(c.attachToProfile(profileId), 1);
    assert.equal(c.latest(profileId, 'terms')!.noticeVersion, 'terms-2026.11');
    assert.deepEqual(c.history(profileId).map((x) => x.kind), ['terms', 'model', 'model', 'delegation']);
    assert.equal(c.history(profileId)[1]!.processorsVersion, 'proc-3');
    const ok = { profileId, kind: 'telemetry' as const, noticeVersion: 't-1', choice: 'agreed' as const, at: '2026-11-05T00:00:00Z', via: 'onboarding' as const };
    assert.throws(() => c.record({ ...ok, kind: 'marketing' as never }), /bad_consent_kind/);
    assert.throws(() => c.record({ ...ok, choice: 'maybe' as never }), /bad_choice/);
    assert.throws(() => c.record({ ...ok, via: 'web' as never }), /bad_via/);
    assert.throws(() => c.record({ ...ok, noticeVersion: 'a b' }), /bad_notice_version/);
    assert.throws(() => c.record({ ...ok, at: '2026-11-05' }), /bad_at/);
    assert.throws(() => c.record({ ...ok, profileId: 'nope' }), /profile_not_found/);
  });

  it('온보딩 이어 하기: 프로필 종류마다 한 행, 멈춘 단계와 상태를 그대로 돌려준다', () => {
    const o = new OnboardingRepo(db);
    assert.equal(o.load(), null);
    o.save({ step: 'biz-number', state: { step: 'biz-number', consents: { terms: { version: 'terms-2026.11', choice: 'agreed' } } } }, '2026-11-05T00:00:00Z');
    const got = o.save({ step: 'biz-confirm', profileId, state: { step: 'biz-confirm' } }, '2026-11-05T00:05:00Z');
    assert.deepEqual([got.step, got.profileId, got.updatedAt], ['biz-confirm', profileId, '2026-11-05T00:05:00Z']);
    assert.equal(o.save({ step: 'auth', state: { step: 'auth' } }).profileId, profileId, '프로필은 한 번 이으면 유지');
    assert.deepEqual(o.load()!.state, { step: 'auth' });
    assert.throws(() => o.save({ step: 'O 01', state: {} }), /bad_step/);
    assert.throws(() => o.save({ step: 'auth', state: [] }), /bad_state/);
    assert.throws(() => o.save({ step: 'auth', state: { big: 'x'.repeat(70_000) } }), /state_too_large/);
    assert.equal(o.load('personal'), null);
    assert.equal(o.clear(), true);
    assert.equal(o.load(), null);
  });
});
