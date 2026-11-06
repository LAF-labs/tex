// M2-3 readback·입력 대조(D02 §2.1 B-06·§4.1·§8 s19a~s19f, D03 §3, D16 assert.*): 세 값 일치로 되읽어 고정하고,
// 고정한 값으로만 합계 산술(s19d)·입력 대조(s19f)·사업자 대조(s19c)·작성일 대조(s19e)·게이트 카드를 만든다.
// 리플레이: 골든 H-01 픽스처(tests/fixtures/core/h01)의 s19a → s20(게이트)을 가짜 페이지로 돌린다. 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readbackCard } from '@sax/engine';
import {
  BASIC_HANDLERS, Interpreter, isValid, newScope, normalizeFieldValue, stepEnv, validatePackage,
  type Handler, type PackageFiles, type SelectorDict, type SelectorEntry, type Step, type StepEnv,
} from '@sax/engine/core';
import { FakeAct, FakeClock, FakePage, type FEl } from './core-page-fakes.ts';
import { bundleOutcomes, h01, lookups } from './core-fixtures.ts';

// ---- 골든 H-01 픽스처로 만든 가짜 화면 ----

/** 사전 항목마다 요소 하나: id = 사전 키, 역할·이름 = 첫 role 후보, 부모 = landmark. */
function screenOf(dict: SelectorDict): FEl[] {
  return Object.entries(dict.entries).map(([k, e]) => {
    const role = e.candidates.find((c) => c.kind === 'role') as { role: string; name: string } | undefined;
    return { id: k, role: e.role, name: role?.name ?? '', ...(e.landmark !== k ? { parent: e.landmark } : {}), css: e.candidates.filter((c) => c.kind === 'css').map((c) => (c as { value: string }).value) };
  });
}

/** 사용자가 정한 실행 입력(H-01 inputs 모양)과 내 사업자 프로필. */
const INPUTS = {
  counterpart: { bizNo: '2208162517', name: '주식회사 받는곳', email: 'tax@Example.COM' },
  amounts: { supply: 1000000, tax: 100000 },
  items: [{ name: '컨설팅' }],
  issueDate: '2026-11-06',
};
const PROFILE = { bizNo: '1068114550' };

/** 포털 양식에 보이는 값(fieldKey → 화면 문자열). 정상 상태는 입력과 같다(쉼표·하이픈은 포털 표시 형식). */
const SCREEN: Record<string, string> = {
  supplierBizNo: '106-81-14550',
  supplierName: '주식회사 보내는곳',
  counterpartBizNo: '220-81-62517',
  counterpartName: '주식회사 받는곳',
  counterpartEmail: 'tax@example.com',
  itemName: '컨설팅',
  itemCount: '1',
  supplyAmount: '1,000,000',
  taxAmount: '100,000',
  totalAmount: '1,100,000',
  issueDate: '2026.11.06',
  remark: '',
  receiptType: '청구',
};

function h01Run(o: { screen?: Partial<Record<string, string>>; a11y?: Partial<Record<string, string>>; dict?: (d: SelectorDict) => void; extra?: FEl[]; inputs?: Record<string, unknown> } = {}) {
  const pkg = h01();
  o.dict?.(pkg.selectors);
  const clock = new FakeClock();
  const els = [...screenOf(pkg.selectors), ...(o.extra ?? [])];
  const page = new FakePage(clock, els);
  const screen = { ...SCREEN, ...o.screen };
  for (const [k, e] of Object.entries(pkg.selectors.entries)) {
    if (!e.fieldKey) continue;
    const el = page.els.get(k)!;
    el.value = screen[e.fieldKey] ?? '';
    el.text = el.value; // 입력 역할이 아닌 칸(receiptType 라디오)은 보이는 텍스트를 읽는다
    el.a11y = o.a11y?.[e.fieldKey] ?? el.value;
  }
  const scope = newScope({ inputs: o.inputs ?? INPUTS, profile: PROFILE, intentId: 'intent-1' });
  const env = stepEnv({ page, act: new FakeAct(page), clock, dict: pkg.selectors, strings: pkg.strings, scope, domains: pkg.manifest.domains, irreversible: new Set(['s21']), defaultTimeoutMs: 1000, pollMs: 100 });
  let card: ReturnType<typeof readbackCard> | 'none' = 'none';
  const gate: Handler<'gate'> = async (_s, e) => {
    card = readbackCard(e.scope);
    return { t: 'jump', to: 'abort' };
  };
  const events: string[] = [];
  const it = new Interpreter(pkg.playbook, { ...BASIC_HANDLERS, gate }, env, { retries: { stepMax: 2, backoff: 'equal_jitter', baseMs: 1000, capMs: 8000 }, retryFloorMs: 800, random: () => 0.5 }, {
    event: (n, d) => n === 'step.finished' && events.push(`${d.stepId}${d.code ? `:${d.code}` : ''}`),
  });
  return { page, scope, env, it, events, card: () => card };
}

const entryOf = (k: string): SelectorEntry => h01().selectors.entries[k]!;

describe('값 정규화(readback·대조·fill 되읽기 공통)', () => {
  const n = (fieldKey: string, raw: string, inputType?: SelectorEntry['inputType']) => normalizeFieldValue({ fieldKey, ...(inputType ? { inputType } : {}) }, raw);
  it('금액: 쉼표·원·공백·앞의 0을 빼고 음수 부호는 둔다(수정발급 음(-) 금액)', () => {
    assert.equal(n('supplyAmount', '1,000,000 원'), '1000000');
    assert.equal(n('taxAmount', '0100000'), '100000');
    assert.equal(n('totalAmount', '-1,100,000'), '-1100000');
    assert.equal(n('supplyAmount', '0'), '0');
    assert.equal(n('supplyAmount', '1.5'), '1.5', '숫자가 아니면 그대로(산술이 거부)');
  });
  it('사업자번호는 하이픈을 빼고, 날짜는 YYYY-MM-DD, 이메일은 도메인만 소문자', () => {
    assert.equal(n('counterpartBizNo', '220-81-62517'), '2208162517');
    for (const d of ['2026-11-06', '2026.11.06', '20261106', '2026년 11월 6일', '2026/11/6']) assert.equal(n('issueDate', d), '2026-11-06', d);
    assert.equal(n('counterpartEmail', 'Tax@Example.COM', 'email'), 'Tax@example.com');
    assert.equal(n('counterpartName', '주식회사​  받는곳 '), '주식회사 받는곳');
  });
});

describe('readback 스텝: 세 값 일치(D02 §2.1 B-06)', () => {
  const rb = (fields: string[]): Step => ({ id: 's19b', type: 'readback', fields });
  const run1 = (s: Step, env: StepEnv) => (BASIC_HANDLERS[s.type] as (s: Step, e: StepEnv) => Promise<unknown>)(s, env);
  it('DOM 값과 접근성 값이 정규화 뒤 같으면 $readback에 정규화한 값을 고정한다', async () => {
    const r = h01Run({ a11y: { supplyAmount: '1000000' } });
    assert.deepEqual(await run1(rb(['supplyAmount', 'counterpartBizNo', 'issueDate']), r.env), { t: 'next' });
    assert.deepEqual(Object.fromEntries(r.scope.readback), { supplyAmount: '1000000', counterpartBizNo: '2208162517', issueDate: '2026-11-06' });
  });
  it('DOM 값 ≠ 접근성 값이면 step.readback_mismatch이고 이 스텝의 값은 하나도 남기지 않는다', async () => {
    const r = h01Run({ a11y: { taxAmount: '10,000' } });
    r.scope.readback.set('taxAmount', '100000');
    assert.deepEqual(await run1(rb(['supplyAmount', 'taxAmount']), r.env), { t: 'fail', code: 'step.readback_mismatch' });
    assert.equal(r.scope.readback.size, 0, '앞서 고정한 값도 지운다(반쯤 읽은 값으로 카드를 만들지 않게)');
  });
  it('readbackOf 표시 요소가 있으면 세 값이 모두 같아야 한다', async () => {
    const withDisplay = (d: SelectorDict) => {
      d.entries['hometax.invoice.form.totalDisplay'] = { candidates: [{ kind: 'role', role: 'status', name: '합계금액 표시' }], role: 'status', namePattern: '^합계금액 표시$', frame: 'main', landmark: 'hometax.invoice.form.root', commits: false, lastVerified: '2026-11-01', readbackOf: 'totalAmount' };
    };
    const ok = h01Run({ dict: withDisplay, extra: [] });
    ok.page.els.get('hometax.invoice.form.totalDisplay')!.text = '1,100,000원';
    assert.deepEqual(await run1(rb(['totalAmount']), ok.env), { t: 'next' });
    const bad = h01Run({ dict: withDisplay });
    bad.page.els.get('hometax.invoice.form.totalDisplay')!.text = '1,000,000원';
    assert.deepEqual(await run1(rb(['totalAmount']), bad.env), { t: 'fail', code: 'step.readback_mismatch' }, '표시 요소만 다르다');
    const gone = h01Run({ dict: withDisplay });
    gone.page.els.delete('hometax.invoice.form.totalDisplay');
    assert.deepEqual(await run1(rb(['totalAmount']), gone.env), { t: 'fail', code: 'step.selector_miss' }, '표시 요소를 못 찾으면 일치로 보지 않는다');
  });
  it('fieldKey 입력 칸이 없거나 둘 이상이면 실패, 비밀 칸은 읽지 않는다(V-20 런타임 가드)', async () => {
    const dup = h01Run({ dict: (d) => (d.entries['hometax.invoice.form.remark2'] = { ...d.entries['hometax.invoice.form.remark']!, namePattern: '^비고2$' }) });
    assert.deepEqual(await run1(rb(['remark']), dup.env), { t: 'fail', code: 'step.selector_miss' });
    const secret = h01Run({ dict: (d) => Object.assign(d.entries['hometax.invoice.form.remark']!, { inputType: 'password' }) });
    assert.deepEqual(await run1(rb(['remark']), secret.env), { t: 'fail', code: 'step.secret_field' });
  });
});

describe('readback 조건식(D02 §4.1): 고정한 값만 쓰고 화면을 다시 읽지 않는다', () => {
  const assert1 = (cond: unknown): Step => ({ id: 's19x', type: 'assert', cond } as Step);
  const run1 = (s: Step, env: StepEnv) => (BASIC_HANDLERS[s.type] as (s: Step, e: StepEnv) => Promise<unknown>)(s, env);
  async function readAll() {
    const r = h01Run();
    assert.deepEqual(await run1(h01().playbook.steps.find((s) => s.id === 's19b')!, r.env), { t: 'next' });
    return r;
  }
  it('readbackEquals: 정규화 뒤 입력·프로필과 비교(B-05)', async () => {
    const r = await readAll();
    for (const [fieldKey, ref] of [['supplierBizNo', '$profile.bizNo'], ['counterpartBizNo', '$inputs.counterpart.bizNo'], ['supplyAmount', '$inputs.amounts.supply'], ['issueDate', '$inputs.issueDate']])
      assert.deepEqual(await run1(assert1({ readbackEquals: { fieldKey, ref } }), r.env), { t: 'next' }, fieldKey);
    assert.deepEqual(await run1(assert1({ readbackEquals: { fieldKey: 'taxAmount', ref: '$inputs.amounts.supply' } }), r.env), { t: 'fail', code: 'step.assert_failed' });
  });
  it('readbackEquals: 되읽은 값이나 참조가 없으면 거짓이 아니라 오류(not으로 뒤집히지 않는다)', async () => {
    const r = h01Run();
    assert.deepEqual(await run1(assert1({ not: { readbackEquals: { fieldKey: 'supplyAmount', ref: '$inputs.amounts.supply' } } }), r.env), { t: 'fail', code: 'step.ref_unresolved' }, 'readback 전');
    const r2 = await readAll();
    assert.deepEqual(await run1(assert1({ readbackEquals: { fieldKey: 'counterpartEmail', ref: '$inputs.nope' } }), r2.env), { t: 'fail', code: 'step.ref_unresolved' });
  });
  it('readbackEquals는 화면을 다시 읽지 않는다: readback 뒤 화면이 바뀌어도 고정 값으로 본다', async () => {
    const r = await readAll();
    r.page.els.get('hometax.invoice.form.item1.supply')!.value = '9,999';
    assert.deepEqual(await run1(assert1({ readbackEquals: { fieldKey: 'supplyAmount', ref: '$inputs.amounts.supply' } }), r.env), { t: 'next' });
  });
  it('sumEquals{parts,total}: Σ parts = total(정수, 음수 허용), 숫자가 아니면 오류', async () => {
    const r = await readAll();
    const sum = (parts: string[], total: string) => run1(assert1({ sumEquals: { parts, total } }), r.env);
    assert.deepEqual(await sum(['supplyAmount', 'taxAmount'], 'totalAmount'), { t: 'next' });
    assert.deepEqual(await sum(['supplyAmount', 'itemCount'], 'totalAmount'), { t: 'fail', code: 'step.assert_failed' });
    r.scope.readback.set('supplyAmount', '-1000000');
    r.scope.readback.set('taxAmount', '-100000');
    r.scope.readback.set('totalAmount', '-1100000');
    assert.deepEqual(await sum(['supplyAmount', 'taxAmount'], 'totalAmount'), { t: 'next' }, '수정발급 음(-) 금액');
    r.scope.readback.set('totalAmount', '1.1e6');
    assert.deepEqual(await run1(assert1({ not: { sumEquals: { parts: ['supplyAmount', 'taxAmount'], total: 'totalAmount' } } }), r.env), { t: 'fail', code: 'step.assert_failed' }, '숫자가 아니면 not도 참이 되지 않는다');
    r.scope.readback.delete('totalAmount');
    assert.deepEqual(await sum(['supplyAmount', 'taxAmount'], 'totalAmount'), { t: 'fail', code: 'step.ref_unresolved' });
  });
  it('fieldsFilled: 입력 칸 DOM 값이 비었는지만 본다(B-34)', async () => {
    const r = h01Run({ screen: { itemName: '  ' } });
    assert.deepEqual(await run1(assert1({ fieldsFilled: { fields: ['counterpartBizNo', 'supplyAmount'] } }), r.env), { t: 'next' });
    assert.deepEqual(await run1(assert1({ fieldsFilled: { fields: ['counterpartBizNo', 'itemName'] } }), r.env), { t: 'fail', code: 'step.assert_failed' });
    assert.deepEqual(await run1(assert1({ fieldsFilled: { fields: ['nope'] } }), r.env), { t: 'fail', code: 'step.selector_miss' });
  });
});

describe('IR 스키마 rev v1.3.2·정적 검증: sumEquals는 readback 키 {parts, total}', () => {
  const withCond = (cond: unknown): PackageFiles => {
    const p = h01();
    (p.playbook.steps.find((s) => s.id === 's19d') as { cond: unknown }).cond = cond;
    return p;
  };
  it('옛 모양 {names, target}(셀렉터 재읽기)은 스키마가 거부한다', () => {
    assert.equal(isValid('playbook-ir', h01().playbook), true);
    assert.equal(isValid('playbook-ir', withCond({ sumEquals: { names: ['supplyAmount', 'taxAmount'], target: 'hometax.invoice.form.totalAmount' } }).playbook), false);
    assert.equal(isValid('playbook-ir', withCond({ sumEquals: { parts: ['supplyAmount'], total: 'totalAmount' } }).playbook), false, 'parts는 둘 이상');
  });
  it('V-15: sumEquals의 parts·total은 그 앞 readback이 지배해야 한다', () => {
    const p = withCond({ sumEquals: { parts: ['supplyAmount', 'taxAmount'], total: 'totalAmount' } });
    const s19a = p.playbook.steps.find((s) => s.id === 's19a') as { cond: unknown };
    s19a.cond = { sumEquals: { parts: ['supplyAmount', 'taxAmount'], total: 'totalAmount' } };
    assert.ok(validatePackage(p, { bundles: bundleOutcomes(), lookups: lookups() }).some((v) => v.rule === 'V-15'));
  });
});

describe('골든 H-01 픽스처(D02 §8): s19d·s19f가 readback과 게이트 사이에 있다', () => {
  it('s19b → s19c → s19d → s19f → s19e → s20 순서, 코드는 D16 assert.*', () => {
    const steps = h01().playbook.steps;
    const ids = steps.map((s) => s.id);
    assert.deepEqual(ids.slice(ids.indexOf('s19b'), ids.indexOf('s20') + 1), ['s19b', 's19c', 's19d', 's19f', 's19e', 's20']);
    const by = (id: string) => steps.find((s) => s.id === id) as Step & { code?: string; cond: unknown; onFail?: unknown };
    assert.deepEqual(by('s19d').cond, { sumEquals: { parts: ['supplyAmount', 'taxAmount'], total: 'totalAmount' } });
    assert.equal(by('s19d').code, 'assert.total_mismatch');
    assert.deepEqual(by('s19f').cond, { all: [
      { readbackEquals: { fieldKey: 'counterpartBizNo', ref: '$inputs.counterpart.bizNo' } },
      { readbackEquals: { fieldKey: 'supplyAmount', ref: '$inputs.amounts.supply' } },
      { readbackEquals: { fieldKey: 'taxAmount', ref: '$inputs.amounts.tax' } },
    ] });
    assert.equal(by('s19f').code, 'assert.input_mismatch');
    for (const id of ['s19c', 's19d', 's19f', 's19e']) assert.deepEqual(by(id).onFail, { retry: 0, then: 'abort' }, id);
  });
  it('골든 패키지는 정적 검증 위반이 없다(V-03h: R→G 사이 assert만)', () => assert.deepEqual(validatePackage(h01(), { bundles: bundleOutcomes(), lookups: lookups() }), []));
});

describe('리플레이: 골든 H-01 s19a → s20(게이트)', () => {
  it('세 값이 맞고 입력과 같으면 게이트에 닿고, 카드는 고정한 readback 13칸이다', async () => {
    const r = h01Run();
    assert.deepEqual(await r.it.run('s19a'), { t: 'abort', at: 's20', code: null });
    assert.deepEqual(r.events, ['s19a', 's19b', 's19c', 's19d', 's19f', 's19e', 's20']);
    assert.deepEqual(r.card(), {
      supplierBizNo: '1068114550', supplierName: '주식회사 보내는곳', counterpartBizNo: '2208162517', counterpartName: '주식회사 받는곳', counterpartEmail: 'tax@example.com',
      itemName: '컨설팅', itemCount: '1', supplyAmount: '1000000', taxAmount: '100000', totalAmount: '1100000', issueDate: '2026-11-06', remark: '', receiptType: '청구',
    });
  });
  it('합계 ≠ 공급가액 + 세액이면 s19d에서 assert.total_mismatch로 중단, 게이트에 닿지 않는다', async () => {
    const r = h01Run({ screen: { totalAmount: '1,000,000' } });
    assert.deepEqual(await r.it.run('s19a'), { t: 'abort', at: 's19d', code: 'assert.total_mismatch' });
    assert.equal(r.card(), 'none');
  });
  it('화면 공급가액·세액이 함께 바뀌어 합계는 맞아도 입력과 다르면 s19f에서 assert.input_mismatch', async () => {
    const r = h01Run({ screen: { supplyAmount: '2,000,000', taxAmount: '200,000', totalAmount: '2,200,000' } });
    assert.deepEqual(await r.it.run('s19a'), { t: 'abort', at: 's19f', code: 'assert.input_mismatch' });
    assert.equal(r.card(), 'none');
  });
  it('공급받는자 사업자번호가 입력과 다르면 s19f에서 중단', async () => {
    const r = h01Run({ screen: { counterpartBizNo: '220-81-62518' } });
    assert.deepEqual(await r.it.run('s19a'), { t: 'abort', at: 's19f', code: 'assert.input_mismatch' });
  });
  it('공급자(내 사업자)가 다르면 s19c에서, 작성일이 다르면 s19e에서 중단', async () => {
    assert.deepEqual(await h01Run({ screen: { supplierBizNo: '999-99-99999' } }).it.run('s19a'), { t: 'abort', at: 's19c', code: 'step.assert_failed' });
    assert.deepEqual(await h01Run({ screen: { issueDate: '2026.11.05' } }).it.run('s19a'), { t: 'abort', at: 's19e', code: 'assert.issue_date_mismatch' });
  });
  it('DOM 값과 접근성 값이 다르면 s19b readback에서 멈추고 게이트에 닿지 않는다', async () => {
    const r = h01Run({ a11y: { supplyAmount: '100,000' } });
    const stop = await r.it.run('s19a');
    assert.equal(stop.at, 's19b');
    assert.ok(stop.t === 'handoff' || stop.t === 'abort' || stop.t === 'recover', stop.t);
    assert.ok(r.events.some((e) => e.startsWith('s19b:step.readback_mismatch')));
    assert.equal(r.card(), 'none');
    assert.equal(r.scope.readback.size, 0);
  });
  it('필수 칸이 비면 s19a에서 멈춘다', async () => {
    const r = h01Run({ screen: { itemName: '' } });
    const stop = await r.it.run('s19a');
    assert.equal(stop.at, 's19a');
    assert.equal(r.card(), 'none');
  });
});

describe('게이트 카드(readbackCard)', () => {
  it('13칸 중 하나라도 고정되지 않았으면 null', () => {
    const s = newScope();
    assert.equal(readbackCard(s), null);
    for (const [k, v] of Object.entries(SCREEN)) s.readback.set(k, v);
    assert.ok(readbackCard(s));
    s.readback.delete('remark');
    assert.equal(readbackCard(s), null);
  });
  it('입력 칸 역할 확인(시험 전제): 금액 칸은 textbox, 수량 칸은 spinbutton', () => {
    assert.equal(entryOf('hometax.invoice.form.item1.supply').role, 'textbox');
    assert.equal(entryOf('hometax.invoice.form.itemCount').role, 'spinbutton');
  });
});
