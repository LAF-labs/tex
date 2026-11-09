// 급여대장 직원 입력·"지난달과 같나요?"·급여 기능 켜기(08 D-06, D14 M6-9): BundleService 명령, main 전용, 주민번호 원문은 결과에 없다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BundleService, extrasFromItems, type CarryOver, type EmployeeView } from '@sax/bundle';
import { ColumnCipher, deriveColumnKey, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import {
  COMMANDS, MAIN_ONLY, PAYROLL_COMMANDS, PAYROLL_EMPLOYEE_COMMANDS, PAYROLL_EMPLOYEE_READ_QUERIES, PAYROLL_MAIN_ONLY, PAYROLL_READ_QUERIES, READ_QUERIES,
} from '@sax/engine/protocol';

const root = path.resolve(import.meta.dirname, '..');
const entry = fs.readFileSync(path.join(root, 'packages/engine/src/entry.ts'), 'utf8');
const src = fs.readFileSync(path.join(root, 'packages/bundle/src/employees.ts'), 'utf8');

let dir: string;
let db: Db;
let svc: BundleService;
let profileId: string;
let otherProfile: string;
const call = <T = unknown>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, p) as Promise<T>;
const code = (m: string, p: Record<string, unknown>, c: string) => assert.rejects(call(m, p), (e: Error & { code?: string }) => e.code === c && !/\d{7}/.test(e.message), `${m} → ${c}`);
const changes = () => db.prepare('SELECT total_changes()').pluck().get() as number;
const add = (employee: Record<string, unknown>, pid = profileId) => call<EmployeeView>('payroll.addEmployee', { profileId: pid, employee });
const RRN = '900101-1234567';

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-payroll-emp-'));
  const key = new Uint8Array(randomBytes(32));
  db = openDatabase(path.join(dir, 'db.sqlite'), key);
  svc = new BundleService(db, new ColumnCipher(deriveColumnKey(key)), { exportDir: path.join(dir, 'exports'), now: () => new Date('2026-11-09T01:00:00.000Z') });
  const profiles = new ProfileRepo(db);
  const base = { corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null };
  profileId = profiles.upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(31), ...base }).id;
  otherProfile = profiles.upsert({ kind: 'personal', displayName: '개인', bizNo: null, ...base }).id;
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('직원 입력(처음 한 번)', () => {
  it('최소 입력은 이름·생년월일·입사일·기본급·공제대상가족 수, 나머지는 기본값. 주민번호는 가림값만 돌려주고 DB에는 암호문만', async () => {
    const before = await call<{ enabled: boolean; source: string }>('db.query.payroll.enabled', { profileId });
    assert.deepEqual(before, { enabled: false, source: 'employees' }, '직원이 없으면 꺼짐');
    const e = await add({ name: ' 김직원 ', birthDate: '1990-01-01', hiredOn: '2025-01-02', basePay: 2_500_000, dependents: 1, rrn: RRN, nontax: { meal: 200_000 } });
    assert.equal(e.name, '김직원');
    assert.deepEqual([e.payType, e.withholdingPct, e.children8to20, e.pensionApplies, e.healthApplies, e.employmentApplies, e.leftOn, e.job], ['monthly', 100, 0, true, true, true, null, null]);
    assert.deepEqual([e.hasRrn, e.maskedRrn], [true, '900101-1******']);
    assert.doesNotMatch(JSON.stringify(e), /1234567/);
    const raw = db.prepare('SELECT rrn_enc FROM employees WHERE id = ?').pluck().get(e.id) as Buffer;
    assert.ok(!raw.toString('latin1').includes('9001011234567'), 'rrn_enc는 암호문');
    const noRrn = await add({ name: '이직원', birthDate: '1995-05-05', hiredOn: '2026-01-05', basePay: 2_200_000, dependents: 2, children8to20: 1, payType: 'monthly', job: '홀' });
    assert.deepEqual([noRrn.hasRrn, noRrn.maskedRrn, noRrn.children8to20, noRrn.job], [false, null, 1, '홀']);
    assert.deepEqual(await call('db.query.payroll.enabled', { profileId }), { enabled: true, source: 'employees' }, '직원이 있으면 켜짐');
  });

  it('입력 오류는 code만(주민번호 값이 오류에 섞이지 않음): 빠진 칸·모르는 칸·비과세 이름·형식·생년월일 불일치·프로필', async () => {
    const ok = { name: '박직원', birthDate: '1990-01-01', hiredOn: '2025-01-02', basePay: 2_000_000, dependents: 1 };
    await code('payroll.addEmployee', { profileId, employee: { ...ok, name: undefined } }, 'name_required');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, name: '  ' } }, 'name_required');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, basePay: undefined } }, 'invalid_base_pay');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, basePay: '200만' } }, 'invalid_base_pay');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, salary: 1 } }, 'bad_employee_field');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, nontax: { bonus: 10_000 } } }, 'invalid_nontax');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, birthDate: '1990-13-01' } }, 'invalid_birth_date');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, leftOn: '2024-12-31' } }, 'invalid_left_on');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, children8to20: 1 } }, 'invalid_children_8_20');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, payType: 'daily' } }, 'invalid_pay_type');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, rrn: '900101-12345' } }, 'invalid_rrn');
    await code('payroll.addEmployee', { profileId, employee: { ...ok, rrn: '850101-1234567' } }, 'rrn_birth_mismatch');
    await code('payroll.addEmployee', { profileId, employee: [] }, 'bad_employee');
    await code('payroll.addEmployee', { profileId: 'nope', employee: ok }, 'profile_not_found');
    const names = (await call<EmployeeView[]>('db.query.payroll.employees', { profileId })).map((e) => e.name);
    assert.ok(!names.includes('박직원'), '실패한 입력은 남지 않는다');
  });

  it('고치기는 바뀐 칸만, 퇴사는 leftOn(지우는 명령 없음). month를 빼면 퇴사자까지 모든 직원, 다른 프로필 직원은 employee_not_found', async () => {
    const list = await call<EmployeeView[]>('db.query.payroll.employees', { profileId });
    const kim = list.find((e) => e.name === '김직원')!;
    const u = await call<EmployeeView>('payroll.updateEmployee', { profileId, employeeId: kim.id, patch: { basePay: 2_600_000 } });
    assert.deepEqual([u.basePay, u.nontax, u.maskedRrn], [2_600_000, { meal: 200_000 }, '900101-1******']);
    await code('payroll.updateEmployee', { profileId, employeeId: kim.id, patch: { birthDate: '1991-01-01' } }, 'rrn_birth_mismatch');
    await code('payroll.updateEmployee', { profileId, employeeId: kim.id, patch: {} }, 'bad_employee');
    await code('payroll.updateEmployee', { profileId, employeeId: kim.id, patch: { profileId: otherProfile } }, 'bad_employee_field');
    const other = await add({ name: '남의직원', birthDate: '1980-02-02', hiredOn: '2025-01-02', basePay: 3_000_000, dependents: 1 }, otherProfile);
    await code('payroll.updateEmployee', { profileId, employeeId: other.id, patch: { basePay: 1 } }, 'employee_not_found');
    await code('payroll.updateEmployee', { profileId, employeeId: 'nope', patch: { basePay: 1 } }, 'employee_not_found');
    await code('payroll.deleteEmployee', { profileId, employeeId: kim.id }, 'unknown_method');

    const quit = await add({ name: '최퇴사', birthDate: '1992-03-03', hiredOn: '2025-06-01', basePay: 2_100_000, dependents: 1 });
    await call('payroll.updateEmployee', { profileId, employeeId: quit.id, patch: { leftOn: '2026-10-31' } });
    const oct = (await call<EmployeeView[]>('db.query.payroll.employees', { profileId, month: '2026-10' })).map((e) => e.name);
    const nov = (await call<EmployeeView[]>('db.query.payroll.employees', { profileId, month: '2026-11' })).map((e) => e.name);
    const all = (await call<EmployeeView[]>('db.query.payroll.employees', { profileId })).map((e) => e.name);
    assert.ok(oct.includes('최퇴사') && !nov.includes('최퇴사') && all.includes('최퇴사'));
    assert.ok(!all.includes('남의직원'));
    // 주민번호 지우기(null)
    const lee = list.find((e) => e.name === '이직원')!;
    await call('payroll.updateEmployee', { profileId, employeeId: lee.id, patch: { rrn: '950505-2234567' } });
    const cleared = await call<EmployeeView>('payroll.updateEmployee', { profileId, employeeId: lee.id, patch: { rrn: null } });
    assert.deepEqual([cleared.hasRrn, cleared.maskedRrn], [false, null]);
  });
});

describe('지난달과 같나요?(carryOver)', () => {
  it('지난달 개정이 없으면 from null, 이달 재직 직원은 모두 새로 들어온 직원', async () => {
    const c = await call<CarryOver>('db.query.payroll.carryOver', { profileId, month: '2026-10' });
    assert.equal(c.from, null);
    assert.deepEqual(c.inputs, {});
    assert.deepEqual(c.newEmployees.map((e) => e.name).sort(), ['김직원', '이직원', '최퇴사'].sort());
  });

  it('지난달 가장 큰 개정의 과세 수당·차감을 이달 inputs로(비과세·근로일수·고지액은 넘기지 않음), 새 직원·퇴사 직원을 따로, 읽기만', async () => {
    const list = await call<EmployeeView[]>('db.query.payroll.employees', { profileId, month: '2026-10' });
    const id = (n: string) => list.find((e) => e.name === n)!.id;
    const extras = [{ name: '직책수당', amount: 100_000, calc: '월 정액' }, { name: '지각 차감', amount: -20_000, calc: '지각 2회 × 10,000원' }];
    await call('payroll.saveDraft', { profileId, month: '2026-10', paidOn: '2026-11-05', inputs: { [id('김직원')]: { extras, workDays: 22, notices: { pension: 112_500 } } } });
    const newbie = await add({ name: '정신입', birthDate: '2000-07-07', hiredOn: '2026-11-03', basePay: 2_100_000, dependents: 1 });

    const before = changes();
    const c = await call<CarryOver>('db.query.payroll.carryOver', { profileId, month: '2026-11' });
    assert.equal(changes(), before, 'DB에 쓰지 않는다');
    assert.deepEqual(c.from, { month: '2026-10', revision: 1, status: 'draft' });
    assert.deepEqual(c.inputs, { [id('김직원')]: { extras }, [id('이직원')]: { extras: [] } });
    assert.deepEqual(c.newEmployees, [{ id: newbie.id, name: '정신입' }]);
    assert.deepEqual(c.leftEmployees, [{ id: id('최퇴사'), name: '최퇴사' }]);

    // 그대로 넣으면 지난달과 같은 과세 수당·차감 항목이 나온다(비과세 식대는 직원 설정에서 다시)
    const nov = await call<{ lines: Array<{ employeeId: string; result: { items: Array<{ name: string; amount: number; taxable: boolean }>; workDays: number | null } }> }>(
      'payroll.compute', { profileId, month: '2026-11', paidOn: '2026-12-05', inputs: c.inputs },
    );
    const kimNov = nov.lines.find((l) => l.employeeId === id('김직원'))!.result;
    assert.deepEqual(kimNov.items.map((i) => [i.name, i.amount, i.taxable]), [['기본급', 2_600_000, true], ['직책수당', 100_000, true], ['지각 차감', -20_000, true], ['식대', 200_000, false]]);
    assert.equal(kimNov.workDays, null);
  });

  it('extrasFromItems: 기본급 다음부터 첫 비과세 앞까지(한도 초과분은 비과세 뒤라 넘기지 않음)', () => {
    const t = (name: string, amount: number, taxable = true) => ({ name, amount, taxable, calc: '' });
    assert.deepEqual(extrasFromItems([t('기본급', 1), t('a', 2), t('식대', 3, false), t('식대(한도 초과분)', 4)]).map((x) => x.name), ['a']);
    assert.deepEqual(extrasFromItems([t('기본급', 1), t('a', 2), t('b', -1)]).map((x) => x.name), ['a', 'b']);
    assert.deepEqual(extrasFromItems([t('기본급', 1)]), []);
  });

  it('인자 오류', async () => {
    await code('db.query.payroll.carryOver', { profileId, month: '2026-13' }, 'bad_month');
    await code('db.query.payroll.carryOver', { profileId: 'nope', month: '2026-11' }, 'profile_not_found');
  });
});

describe('급여 기능 켜기(쓰는 사장님만, ADR-034 결정 8)', () => {
  it('설정이 있으면 그것을 따른다(직원이 있어도 끌 수 있다), 다시 켤 수 있다', async () => {
    assert.deepEqual(await call('payroll.setEnabled', { profileId, on: false }), { enabled: false });
    assert.deepEqual(await call('db.query.payroll.enabled', { profileId }), { enabled: false, source: 'setting' });
    assert.deepEqual(await call('payroll.setEnabled', { profileId, on: true }), { enabled: true });
    assert.deepEqual(await call('db.query.payroll.enabled', { profileId }), { enabled: true, source: 'setting' });
    await code('payroll.setEnabled', { profileId, on: 'yes' }, 'bad_on');
    await code('db.query.payroll.enabled', { profileId: 'nope' }, 'profile_not_found');
  });
});

describe('배선(추가만)', () => {
  it('main 전용(렌더러 목록 밖), entry가 BundleService로 보낸다', () => {
    assert.deepEqual([...PAYROLL_EMPLOYEE_READ_QUERIES], ['db.query.payroll.carryOver', 'db.query.payroll.enabled']);
    assert.deepEqual([...PAYROLL_EMPLOYEE_COMMANDS], ['payroll.addEmployee', 'payroll.updateEmployee', 'payroll.setEnabled']);
    const others = new Set<string>([...READ_QUERIES, ...COMMANDS, ...MAIN_ONLY, ...PAYROLL_MAIN_ONLY, ...PAYROLL_READ_QUERIES, ...PAYROLL_COMMANDS]);
    for (const m of [...PAYROLL_EMPLOYEE_READ_QUERIES, ...PAYROLL_EMPLOYEE_COMMANDS]) assert.ok(!others.has(m), m);
    assert.match(entry, /for \(const m of \[\.\.\.PAYROLL_EMPLOYEE_READ_QUERIES, \.\.\.PAYROLL_EMPLOYEE_COMMANDS\]\) \{\n\s+PAYROLL\.add\(m\);\n\s+ALLOWED\.add\(m\);\n\}/);
  });

  it('모델·네트워크·로그를 쓰지 않고, 주민번호 원문을 꺼내지 않는다', () => {
    assert.doesNotMatch(src, /@sax\/model|@sax\/net|\bfetch\(|console\.|\blog\.|revealRrn\(/);
  });
});
