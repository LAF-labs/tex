// M2-1 스텝 핸들러와 실행기(D02 §4·§4.1·§4.2·§4.3·§5, D03 §5.1·§5.2 R-A1). 가짜 페이지·Actuator로 결정적으로 돌린다. 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASIC_HANDLERS, Interpreter, identityProblem, newScope, resolveTarget, retryDelayMs, stepEnv,
  type InterpHooks, type PlaybookIR, type SelectorDict, type SelectorEntry, type Step, type StepEnv,
} from '@sax/engine/core';
import { FakeAct, FakeClock, FakePage, type FEl } from './core-page-fakes.ts';

// ---- 사전 ----

const entry = (o: Partial<SelectorEntry> & Pick<SelectorEntry, 'role' | 'namePattern' | 'landmark' | 'candidates'>): SelectorEntry => ({ frame: 'main', commits: false, lastVerified: '2026-11-01', ...o });
const DICT: SelectorDict = {
  portal: 'hometax',
  commitEndpoints: [],
  knownEndpoints: [],
  entries: {
    'p.root': entry({ role: 'main', namePattern: '^$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'main', name: '' }] }),
    'f.root': entry({ role: 'form', namePattern: '^발급 양식$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'form', name: '발급 양식' }] }),
    'f.name': entry({ role: 'textbox', namePattern: '^상호$', landmark: 'f.root', candidates: [{ kind: 'css', value: '#nm' }, { kind: 'role', role: 'textbox', name: '상호' }], fieldKey: 'counterpartName' }),
    'f.amount': entry({ role: 'textbox', namePattern: '^공급가액$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'textbox', name: '공급가액' }], fieldKey: 'supplyAmount' }),
    'f.memo': entry({ role: 'textbox', namePattern: '^비고$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'textbox', name: '비고' }], fieldKey: 'remark' }),
    'f.type': entry({ role: 'combobox', namePattern: '^영수/청구$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'combobox', name: '영수/청구' }], fieldKey: 'receiptType', allowedConstants: ['01', '02'] }),
    'f.lookup': entry({ role: 'button', namePattern: '^조회$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '조회' }], expect: { visible: true, enabled: true } }),
    'f.issue': entry({ role: 'button', namePattern: '^발급하기$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '발급하기' }], commits: true, commitEffect: 'issue_document' }),
    'f.pw': entry({ role: 'textbox', namePattern: '^비밀번호$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'textbox', name: '비밀번호' }], inputType: 'password', secretKind: 'portal_password', secretPurpose: 'login' }),
    'f.result': entry({ role: 'status', namePattern: '^결과$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'status', name: '결과' }] }),
    'f.dup': entry({ role: 'button', namePattern: '^중복$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '중복' }, { kind: 'css', value: '#dup2' }] }),
    'other.root': entry({ role: 'dialog', namePattern: '^안내$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'dialog', name: '안내' }] }),
  },
};
const STRINGS = { 'pat.ok': '^처리 결과: (\\d+)건$', 'pat.done': '로그아웃', 'pat.bad': '(a' };

const els = (): FEl[] => [
  { id: 'root', role: 'main', name: '' },
  { id: 'form', role: 'form', name: '발급 양식', parent: 'root' },
  { id: 'nm', role: 'textbox', name: '상호', parent: 'form', css: ['#nm'] },
  { id: 'amt', role: 'textbox', name: '공급가액', parent: 'form' },
  { id: 'memo', role: 'textbox', name: '비고', parent: 'form', value: '자동 채움' },
  { id: 'type', role: 'combobox', name: '영수/청구', parent: 'form' },
  { id: 'lookup', role: 'button', name: '조회', parent: 'form' },
  { id: 'issue', role: 'button', name: '발급하기', parent: 'form' },
  { id: 'pw', role: 'textbox', name: '비밀번호', parent: 'form' },
  { id: 'result', role: 'status', name: '결과', parent: 'form', text: '처리 결과:  3건', a11y: '3건 처리' },
  { id: 'dupA', role: 'button', name: '중복', parent: 'form' },
  { id: 'dupB', role: 'button', name: '중복', parent: 'form', css: ['#dup2'] },
  // 같은 이름이지만 다른 랜드마크(양식 밖)
  { id: 'dlg', role: 'dialog', name: '안내', parent: 'root' },
  { id: 'nm2', role: 'textbox', name: '상호', parent: 'dlg' },
];

function setup(o: { els?: FEl[]; inputs?: Record<string, unknown>; irreversible?: string[] } = {}) {
  const clock = new FakeClock();
  const page = new FakePage(clock, o.els ?? els());
  const act = new FakeAct(page);
  const scope = newScope({ inputs: o.inputs ?? { name: '주식회사 시험', amount: 1000000, memo: '' }, intentId: 'intent-1' });
  const env = stepEnv({ page, act, clock, dict: DICT, strings: STRINGS, scope, domains: ['hometax.go.kr', '*.hometax.go.kr'], irreversible: new Set(o.irreversible ?? []), defaultTimeoutMs: 1000, pollMs: 100 });
  return { clock, page, act, scope, env };
}
const run1 = (s: Step, env: StepEnv) => (BASIC_HANDLERS[s.type] as (s: Step, e: StepEnv) => Promise<unknown>)(s, env);

describe('셀렉터 해석과 R-A1 동일성(D02 §2.1, D03 §5.2)', () => {
  it('랜드마크 하위에서만 찾는다(양식 밖 같은 이름 요소는 후보가 아니다)', async () => {
    const { page } = setup();
    const r = await resolveTarget(page, DICT, 'f.name');
    assert.ok(r.ok && r.t.el.ref === 'nm');
  });
  it('후보를 순서대로 시도한다(첫 후보 실패 → 둘째 후보)', async () => {
    const e = els().map((x) => (x.id === 'nm' ? { ...x, css: [] } : x));
    const r = await resolveTarget(setup({ els: e }).page, DICT, 'f.name');
    assert.ok(r.ok && r.t.el.ref === 'nm');
  });
  it('한 후보가 2개 이상에 맞으면 다음 후보로 넘어가지 않고 실패한다(fail-closed)', async () => {
    const r = await resolveTarget(setup().page, DICT, 'f.dup');
    assert.deepEqual(r, { ok: false, code: 'step.selector_miss', ambiguous: true });
  });
  it('expect(보임·활성)를 만족하지 않는 요소는 후보에서 뺀다', async () => {
    const e = els().map((x) => (x.id === 'lookup' ? { ...x, enabled: false } : x));
    assert.deepEqual(await resolveTarget(setup({ els: e }).page, DICT, 'f.lookup'), { ok: false, code: 'step.selector_miss' });
  });
  it('역할이나 정규화한 이름이 사전과 다르면 step.identity_mismatch', async () => {
    const e = els().map((x) => (x.id === 'nm' ? { ...x, role: 'combobox' } : x));
    assert.deepEqual(await resolveTarget(setup({ els: e }).page, DICT, 'f.name'), { ok: false, code: 'step.identity_mismatch' });
    assert.equal(identityProblem(DICT.entries['f.issue']!, { role: 'button', name: '발급\u200B하기' }), null, '단어 사이 제로폭은 지운다');
    assert.equal(identityProblem(DICT.entries['f.issue']!, { role: 'button', name: '발급 하기' }), 'name', '보이는 공백은 이름의 일부');
    assert.equal(identityProblem(DICT.entries['f.issue']!, { role: 'button', name: '발급하기 취소' }), 'name', '앵커된 패턴');
    assert.equal(identityProblem(DICT.entries['f.issue']!, { role: 'button', name: ' 발급하기\u200B' }), null, 'NFKC·제로폭 제거·공백 접기 뒤 일치');
    assert.equal(identityProblem(DICT.entries['f.issue']!, { role: 'link', name: '발급하기' }), 'role');
  });
  it('사전에 없는 키·랜드마크를 못 찾으면 selector_miss', async () => {
    const { page } = setup();
    assert.equal((await resolveTarget(page, DICT, 'nope')).ok, false);
    const noForm = els().filter((x) => x.id !== 'form');
    assert.deepEqual(await resolveTarget(setup({ els: noForm }).page, DICT, 'f.name'), { ok: false, code: 'step.selector_miss' });
  });
});

describe('goto·click·press(D02 §4, V-06·V-03g 실행 시 방어)', () => {
  it('goto는 manifest.domains 안의 https만 Actuator로 보낸다', async () => {
    const { env, act } = setup();
    assert.deepEqual(await run1({ id: 's1', type: 'goto', url: 'https://www.hometax.go.kr/x' }, env), { t: 'next' });
    assert.deepEqual(await run1({ id: 's1', type: 'goto', url: 'https://evil.example/x' }, env), { t: 'fail', code: 'step.url_not_allowed' });
    assert.deepEqual(await run1({ id: 's1', type: 'goto', url: 'http://hometax.go.kr/' }, env), { t: 'fail', code: 'step.url_not_allowed' });
    assert.deepEqual(act.log, ['goto www.hometax.go.kr']);
  });
  it('click은 요소가 나타날 때까지 timeoutMs 안에서 기다린다', async () => {
    const e = els().map((x) => (x.id === 'lookup' ? { ...x, appearAt: 250 } : x));
    const { env, act, clock } = setup({ els: e });
    assert.deepEqual(await run1({ id: 's2', type: 'click', target: 'f.lookup' }, env), { t: 'next' });
    assert.deepEqual(act.log, ['click f.lookup']);
    assert.ok(clock.t >= 250 && clock.t <= 400);
  });
  it('끝내 없으면 step.selector_miss, 동일성이 틀리면 기다리지 않고 step.identity_mismatch', async () => {
    const { env, act, clock } = setup({ els: els().filter((x) => x.id !== 'lookup') });
    assert.deepEqual(await run1({ id: 's2', type: 'click', target: 'f.lookup', timeoutMs: 300 }, env), { t: 'fail', code: 'step.selector_miss' });
    assert.ok(clock.t >= 300);
    // css 후보로 찾았지만 실제 역할이 다르다
    const w = setup({ els: els().map((x) => (x.id === 'nm' ? { ...x, role: 'link' } : x)) });
    assert.deepEqual(await run1({ id: 's2', type: 'click', target: 'f.name' }, w.env), { t: 'fail', code: 'step.identity_mismatch' });
    assert.equal(w.clock.t, 0);
    assert.deepEqual(act.log, []);
  });
  it('commits:true 항목·비가역 스텝은 click·press·select로 실행하지 않는다(커밋 구간은 submit만)', async () => {
    const { env, act } = setup({ irreversible: ['s9'] });
    assert.deepEqual(await run1({ id: 's2', type: 'click', target: 'f.issue' }, env), { t: 'fail', code: 'step.irreversible_unguarded' });
    assert.deepEqual(await run1({ id: 's9', type: 'press', key: 'Enter', target: 'f.name' }, env), { t: 'fail', code: 'step.irreversible_unguarded' });
    assert.deepEqual(await run1({ id: 's9', type: 'select', target: 'f.type', option: '01' }, env), { t: 'fail', code: 'step.irreversible_unguarded' });
    assert.deepEqual(act.log, []);
  });
  it('비밀 칸은 누르거나 읽을 수 없다(V-20 실행 시 방어)', async () => {
    const { env, act } = setup();
    assert.deepEqual(await run1({ id: 's2', type: 'click', target: 'f.pw' }, env), { t: 'fail', code: 'step.secret_field' });
    assert.deepEqual(await run1({ id: 's2', type: 'fill', target: 'f.pw', value: '$inputs.name' }, env), { t: 'fail', code: 'step.secret_field' });
    assert.deepEqual(await run1({ id: 's2', type: 'extract', name: 'x', from: { selector: 'f.pw' } }, env), { t: 'fail', code: 'step.secret_field' });
    assert.deepEqual(await run1({ id: 's2', type: 'assert', cond: { exists: 'f.pw' } }, env), { t: 'fail', code: 'step.secret_field' });
    assert.deepEqual(act.log, []);
  });
  it('press: Enter는 타깃 필수, 다른 키는 타깃 없이도', async () => {
    const { env, act } = setup();
    assert.deepEqual(await run1({ id: 's3', type: 'press', key: 'Enter' }, env), { t: 'fail', code: 'step.selector_miss' });
    assert.deepEqual(await run1({ id: 's3', type: 'press', key: 'Tab' }, env), { t: 'next' });
    assert.deepEqual(await run1({ id: 's3', type: 'press', key: 'Enter', target: 'f.name' }, env), { t: 'next' });
    assert.deepEqual(act.log, ['press Tab', 'press Enter f.name']);
  });
  it('Actuator가 거부하면(정책·R-A1 재확인·R-A2) 그 코드로 실패한다', async () => {
    const { env, act } = setup();
    act.failWith = 'step.commit_shadow';
    assert.deepEqual(await run1({ id: 's2', type: 'click', target: 'f.lookup' }, env), { t: 'fail', code: 'step.commit_shadow' });
  });
});

describe('fill·select(D02 §4, §4.2 값 참조, V-21 상수)', () => {
  it('참조 값을 넣고 DOM 값을 되읽어 정규화 비교한다(포털 쉼표 서식은 같은 값)', async () => {
    const { env, act, page } = setup();
    act.reformat = (v) => Number(v).toLocaleString('en-US');
    assert.deepEqual(await run1({ id: 's4', type: 'fill', target: 'f.amount', value: '$inputs.amount', keyEvents: true }, env), { t: 'next' });
    assert.equal(page.els.get('amt')!.value, '1,000,000');
    assert.deepEqual(act.log, ['fill f.amount keys']);
  });
  it('되읽은 값이 다르면 step.readback_mismatch', async () => {
    const { env, act } = setup();
    act.reformat = (v) => v.slice(0, 3);
    assert.deepEqual(await run1({ id: 's4', type: 'fill', target: 'f.name', value: '$inputs.name' }, env), { t: 'fail', code: 'step.readback_mismatch' });
  });
  it('상수는 타깃의 allowedConstants 안에서만', async () => {
    const { env } = setup();
    assert.deepEqual(await run1({ id: 's5', type: 'select', target: 'f.type', option: '01' }, env), { t: 'next' });
    assert.deepEqual(await run1({ id: 's5', type: 'select', target: 'f.type', option: '03' }, env), { t: 'fail', code: 'step.constant_not_allowed' });
    assert.deepEqual(await run1({ id: 's4', type: 'fill', target: 'f.name', value: '주식회사 시험' }, env), { t: 'fail', code: 'step.constant_not_allowed' });
  });
  it('선택 입력이 비었을 때: ifAbsent clear면 칸을 비우고, 아니면 step.input_absent', async () => {
    const { env, page, act } = setup();
    assert.deepEqual(await run1({ id: 's6', type: 'fill', target: 'f.memo', value: '$inputs.memo' }, env), { t: 'fail', code: 'step.input_absent' });
    assert.deepEqual(await run1({ id: 's6', type: 'fill', target: 'f.memo', value: '$inputs.memo', ifAbsent: 'clear' }, env), { t: 'next' });
    assert.equal(page.els.get('memo')!.value, '');
    assert.deepEqual(act.log, ['clear f.memo']);
  });
  it('정의되지 않은 변수·객체 값은 step.ref_unresolved', async () => {
    const { env } = setup({ inputs: { obj: { a: 1 } } });
    assert.deepEqual(await run1({ id: 's4', type: 'fill', target: 'f.name', value: '$vars.none' }, env), { t: 'fail', code: 'step.ref_unresolved' });
    assert.deepEqual(await run1({ id: 's4', type: 'fill', target: 'f.name', value: '$inputs.obj' }, env), { t: 'fail', code: 'step.ref_unresolved' });
  });
  it('입력 경로 참조($inputs.a.b)와 $intent.id를 읽는다', async () => {
    const { env, page } = setup({ inputs: { counterparty: { name: '갑' } } });
    assert.deepEqual(await run1({ id: 's4', type: 'fill', target: 'f.name', value: '$inputs.counterparty.name' }, env), { t: 'next' });
    assert.equal(page.els.get('nm')!.value, '갑');
    assert.deepEqual(await run1({ id: 's4', type: 'fill', target: 'f.memo', value: '$intent.id' }, env), { t: 'next' });
  });
});

describe('wait·assert·extract·branch·end(D02 §4·§4.1)', () => {
  it('wait: selector·navigation·idle·text, 시간 초과는 step.timeout', async () => {
    const { env, page } = setup();
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'selector', value: 'f.lookup' }, env), { t: 'next' });
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'selector', value: 'other.none', timeoutMs: 200 }, env), { t: 'fail', code: 'step.selector_miss' });
    page.nav = false;
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'navigation' }, env), { t: 'fail', code: 'step.timeout' });
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'idle' }, env), { t: 'next' });
    page.body = '홈 로그아웃 메뉴';
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'text', value: 'pat.done' }, env), { t: 'next' });
    page.body = '';
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'text', value: 'pat.done', timeoutMs: 300 }, env), { t: 'fail', code: 'step.timeout' });
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'text', value: 'pat.bad' }, env), { t: 'fail', code: 'step.cond_unsupported' }, 'RE2로 컴파일되지 않으면 평가 불가');
  });
  it('wait selector: 늦게 나타나는 요소를 기다리고, 끝내 없으면 step.timeout', async () => {
    const { env } = setup({ els: els().map((x) => (x.id === 'result' ? { ...x, appearAt: 500 } : x)) });
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'selector', value: 'f.result', timeoutMs: 300 }, env), { t: 'fail', code: 'step.timeout' });
    assert.deepEqual(await run1({ id: 's7', type: 'wait', for: 'selector', value: 'f.result', timeoutMs: 300 }, env), { t: 'next' });
  });
  it('assert: 참이면 다음, 거짓이면 step.assert_failed, 평가할 수 없으면 그 코드(fail-closed)', async () => {
    const { env } = setup({ inputs: { name: '갑' } });
    assert.deepEqual(await run1({ id: 's8', type: 'assert', cond: { all: [{ exists: 'f.name' }, { inputPresent: 'name' }, { not: { exists: 'other.missing' } }] } }, env), { t: 'next' });
    assert.deepEqual(await run1({ id: 's8', type: 'assert', cond: { any: [{ inputPresent: 'nope' }, { varSet: 'x' }] } }, env), { t: 'fail', code: 'step.assert_failed' });
    assert.deepEqual(await run1({ id: 's8', type: 'assert', cond: { textMatches: { target: 'f.result', patternRef: 'pat.ok' } } }, env), { t: 'next' }, '공백 접기 뒤 비교');
    assert.deepEqual(await run1({ id: 's8', type: 'assert', cond: { exists: 'f.dup' } }, env), { t: 'fail', code: 'step.selector_miss' }, '모호하면 없음이 아니라 오류');
    // readback 조건(sumEquals·readbackEquals·fieldsFilled)은 tests/core-readback.test.ts(M2-3).
    assert.deepEqual(await run1({ id: 's8', type: 'assert', cond: { profileHas: 'bizNo' } }, env), { t: 'fail', code: 'step.cond_unsupported' });
  });
  it('전제조건 판정(inputVerified·profileHas·artifact)은 넘겨 준 함수로', async () => {
    const { env } = setup();
    env.pre = { profileHas: (k) => k === 'bizNo', inputVerified: () => false, artifact: () => true };
    assert.deepEqual(await run1({ id: 's8', type: 'assert', cond: { all: [{ profileHas: 'bizNo' }, { artifact: 'pdf' }] } }, env), { t: 'next' });
    assert.deepEqual(await run1({ id: 's8', type: 'assert', cond: { inputVerified: 'bizNo' } }, env), { t: 'fail', code: 'step.assert_failed' });
  });
  it('extract: selector는 텍스트, regex는 첫 그룹, a11y는 접근성 값. readback:true는 readback 전용 표시', async () => {
    const { env, scope } = setup();
    await run1({ id: 's10', type: 'extract', name: 't', from: { selector: 'f.result' } }, env);
    await run1({ id: 's10', type: 'extract', name: 'n', from: { regex: { target: 'f.result', patternRef: 'pat.ok' } }, readback: true }, env);
    await run1({ id: 's10', type: 'extract', name: 'a', from: { a11y: { target: 'f.result' } } }, env);
    assert.deepEqual([...scope.vars], [['t', '처리 결과: 3건'], ['n', '3'], ['a', '3건 처리']]);
    assert.deepEqual([...scope.readbackOnly], ['n']);
    assert.deepEqual(await run1({ id: 's10', type: 'extract', name: 'z', from: { regex: { target: 'f.name', patternRef: 'pat.ok' } } }, env), { t: 'fail', code: 'step.extract_miss' });
  });
  it('branch: 조건 값("true"/"false")으로 cases, 없으면 default', async () => {
    const { env, scope } = setup();
    const s: Step = { id: 's11', type: 'branch', on: { varSet: 'x' }, cases: { true: 's20' }, default: 'handoff' };
    assert.deepEqual(await run1(s, env), { t: 'jump', to: 'handoff' });
    scope.vars.set('x', '1');
    assert.deepEqual(await run1(s, env), { t: 'jump', to: 's20' });
    assert.deepEqual(await run1({ id: 's12', type: 'end', status: 'completed_with_issues' }, env), { t: 'end', status: 'completed_with_issues' });
  });
});

// ---- 실행기 ----

const POL = { retries: { stepMax: 2, backoff: 'equal_jitter' as const, baseMs: 1000, capMs: 8000 }, retryFloorMs: 800, random: () => 0.5 };
function ir(steps: Step[], o: Partial<PlaybookIR> = {}): PlaybookIR {
  return { ir: 2, id: 'test.pb', version: '1.0.0', portal: 'hometax', profileKinds: ['business'], effects: [], inputs: {}, steps, postconditions: [], ...o } as PlaybookIR;
}
function interp(steps: Step[], o: { ir?: Partial<PlaybookIR>; env?: ReturnType<typeof setup>; handlers?: typeof BASIC_HANDLERS; maxSteps?: number } = {}) {
  const s = o.env ?? setup();
  const events: Array<[string, Record<string, unknown>]> = [];
  const hooks: InterpHooks = { event: (n, d) => events.push([n, d]) };
  const it = new Interpreter(ir(steps, o.ir), o.handlers ?? BASIC_HANDLERS, s.env, { ...POL, maxStepExecutions: o.maxSteps }, hooks);
  return { ...s, it, events };
}

describe('실행기: 간선 의미론(D02 §4.3)·실패 정책(D02 §5)', () => {
  it('폴스루로 끝까지 가고 end에서 멈춘다. 저널에는 id·타입·코드만(값 없음, ⑦)', async () => {
    const x = interp([
      { id: 's1', type: 'goto', url: 'https://hometax.go.kr/' },
      { id: 's2', type: 'fill', target: 'f.name', value: '$inputs.name' },
      { id: 's3', type: 'end', status: 'success' },
    ]);
    assert.deepEqual(await x.it.run(), { t: 'end', at: 's3', status: 'success' });
    assert.deepEqual(x.act.log, ['goto hometax.go.kr', 'fill f.name']);
    const j = JSON.stringify(x.events);
    assert.ok(!j.includes('주식회사') && !j.includes('시험'), j);
    assert.deepEqual(x.events.map(([n, d]) => `${n}:${d.stepId}`), ['step.started:s1', 'step.finished:s1', 'step.started:s2', 'step.finished:s2', 'step.started:s3', 'step.finished:s3']);
  });
  it('재시도는 min(retry, policy.retries.stepMax)번, 지연은 Equal Jitter(하한 = stepDelayMs 하한)', async () => {
    const x = interp([{ id: 's1', type: 'click', target: 'f.lookup', timeoutMs: 100, onFail: { retry: 5, then: 'abort' } }], { env: setup({ els: els().filter((e) => e.id !== 'lookup') }) });
    assert.deepEqual(await x.it.run(), { t: 'abort', at: 's1', code: 'step.selector_miss' });
    assert.equal(x.events.filter(([n]) => n === 'step.started').length, 3, '첫 시도 + 재시도 2번(stepMax)');
    const retrySleeps = x.clock.sleeps.filter((ms) => ms >= 800);
    assert.deepEqual(retrySleeps, [retryDelayMs(1, POL.retries, 800, 0.5), retryDelayMs(2, POL.retries, 800, 0.5)]);
    assert.deepEqual(retrySleeps, [800, 1500]);
  });
  it('retryDelayMs: 상한 cap, 하한 floor', () => {
    assert.equal(retryDelayMs(10, { baseMs: 1000, capMs: 8000 }, 800, 1), 8000);
    assert.equal(retryDelayMs(1, { baseMs: 1000, capMs: 8000 }, 800, 0), 800);
    assert.equal(retryDelayMs(3, { baseMs: 1000, capMs: 8000 }, 0, 0), 2000);
  });
  it('onFail.then: abort·handoff(resumeAt = 그 스텝)·recover·human:secret(다음 스텝)·checkpoint 점프', async () => {
    const miss = () => setup({ els: els().filter((e) => e.id !== 'lookup') });
    const click = (then: string): Step => ({ id: 's2', type: 'click', target: 'f.lookup', timeoutMs: 10, onFail: { then: then as never } });
    const tail: Step[] = [{ id: 's3', type: 'end', status: 'success' }];
    assert.deepEqual(await interp([click('handoff'), ...tail], { env: miss() }).it.run(), { t: 'handoff', at: 's2', resumeAt: 's2', code: 'step.selector_miss' });
    assert.deepEqual(await interp([click('recover'), ...tail], { env: miss() }).it.run(), { t: 'recover', at: 's2', code: 'step.selector_miss' });
    assert.deepEqual(await interp([click('human:secret'), ...tail], { env: miss() }).it.run(), { t: 'human_secret', at: 's2', next: 's3', code: 'step.selector_miss' });
    const cp: Step = { id: 's1', type: 'checkpoint', name: 'form', expect: { exists: 'f.root' } };
    assert.deepEqual(await interp([cp, click('checkpoint:form'), ...tail], { env: miss() }).it.run('s2'), { t: 'unhandled', at: 's1', type: 'checkpoint' }, 'checkpoint 복귀 핸들러는 M2-2');
  });
  it('IR recovery.default가 스텝 onFail이 없을 때의 기본, 그것도 없으면 handoff·재시도 0', async () => {
    const miss = () => setup({ els: els().filter((e) => e.id !== 'lookup') });
    const s: Step = { id: 's2', type: 'click', target: 'f.lookup', timeoutMs: 10 };
    assert.deepEqual(await interp([s], { env: miss(), ir: { recovery: { default: { then: 'abort' } } } }).it.run(), { t: 'abort', at: 's2', code: 'step.selector_miss' });
    const x = interp([s], { env: miss() });
    assert.deepEqual(await x.it.run(), { t: 'handoff', at: 's2', resumeAt: 's2', code: 'step.selector_miss' });
    assert.equal(x.events.filter(([n]) => n === 'step.retry').length, 0);
  });
  it('스텝의 code가 있으면 그것을 보고하고 원래 코드는 cause로 남긴다', async () => {
    const x = interp([{ id: 's8', type: 'assert', cond: { varSet: 'x' }, code: 'assert.issue_date_mismatch', onFail: { then: 'abort' } }]);
    assert.deepEqual(await x.it.run(), { t: 'abort', at: 's8', code: 'assert.issue_date_mismatch' });
    assert.deepEqual(x.events.find(([n]) => n === 'step.finished')![1], { stepId: 's8', type: 'assert', code: 'assert.issue_date_mismatch', cause: 'step.assert_failed' });
  });
  it('branch 점프·handoff 스텝(resumeAt)·branch default abort', async () => {
    const x = interp([
      { id: 's1', type: 'branch', on: { inputPresent: 'name' }, cases: { true: 's3' }, default: 'abort' },
      { id: 's2', type: 'end', status: 'failed' },
      { id: 's3', type: 'handoff', reason: 'manual', resumeAt: 's2' },
    ]);
    assert.deepEqual(await x.it.run(), { t: 'handoff', at: 's3', resumeAt: 's2', code: null });
    assert.deepEqual(await x.it.run('s2'), { t: 'end', at: 's2', status: 'failed' });
    const y = interp([{ id: 's1', type: 'branch', on: { inputPresent: 'nope' }, cases: { true: 's1' }, default: 'abort' }]);
    assert.deepEqual(await y.it.run(), { t: 'abort', at: 's1', code: null });
  });
  it('repeat: until을 첫 진입부터 평가, 참이면 다음 원소. max번 돌아도 거짓이면 step.repeat_exhausted로 onFail', async () => {
    const body: Step[] = [{ id: 's2a', type: 'click', target: 'f.lookup' }];
    const rep = (max: number): Step => ({ id: 's2', type: 'repeat', max, until: { varSet: 'done' }, steps: body, onFail: { then: 'abort' } });
    const x = interp([rep(3), { id: 's3', type: 'end', status: 'success' }]);
    assert.deepEqual(await x.it.run(), { t: 'abort', at: 's2', code: 'step.repeat_exhausted' });
    assert.equal(x.act.log.length, 3, '본문 3번');
    const y = interp([rep(3), { id: 's3', type: 'end', status: 'success' }]);
    y.scope.vars.set('done', '1');
    assert.deepEqual(await y.it.run(), { t: 'end', at: 's3', status: 'success' });
    assert.equal(y.act.log.length, 0, '이미 참이면 본문을 돌지 않는다');
  });
  it('repeat: 본문에서 until이 참이 되면 빠져나온다', async () => {
    const x = interp([
      { id: 's2', type: 'repeat', max: 5, until: { varSet: 'n' }, steps: [{ id: 's2a', type: 'click', target: 'f.lookup' }, { id: 's2b', type: 'extract', name: 'n', from: { regex: { target: 'f.result', patternRef: 'pat.ok' } } }] },
      { id: 's3', type: 'end', status: 'success' },
    ]);
    assert.deepEqual(await x.it.run(), { t: 'end', at: 's3', status: 'success' });
    assert.equal(x.act.log.length, 1);
  });
  it('repeat: 밖에서 다시 들어오면 횟수를 새로 센다', async () => {
    const x = interp([
      { id: 's1', type: 'repeat', max: 2, until: { varSet: 'stop' }, steps: [{ id: 's1a', type: 'press', key: 'Tab' }], onFail: { then: 'checkpoint:top' } },
      { id: 's9', type: 'checkpoint', name: 'top', expect: { exists: 'p.root' } },
    ], { handlers: { ...BASIC_HANDLERS, checkpoint: async () => ({ t: 'jump', to: 's1' }) }, maxSteps: 40 });
    const r = await x.it.run();
    // 매번 본문 2번 → 소진 → checkpoint → 다시 2번 … 상한에 걸려 멈춘다. 들어갈 때마다 횟수가 0이라 각 진입마다 정확히 2번 돈다.
    assert.equal(r.t, 'abort');
    const runs = x.events.filter(([n, d]) => n === 'step.started' && d.stepId === 's1a').length;
    const entries = x.events.filter(([n, d]) => n === 'step.started' && d.stepId === 's9').length;
    assert.ok(runs >= 2 * entries && runs <= 2 * (entries + 1), `${runs} ${entries}`);
  });
  it('loopGuard.max를 넘는 방문은 사람에게 넘긴다(V-18), 실행당 스텝 상한은 abort(step.loop_guard)', async () => {
    const x = interp([
      { id: 's1', type: 'press', key: 'Tab', loopGuard: { max: 3 } },
      { id: 's2', type: 'branch', on: { varSet: 'x' }, cases: { true: 's3' }, default: 's1' },
      { id: 's3', type: 'end', status: 'success' },
    ]);
    assert.deepEqual(await x.it.run(), { t: 'handoff', at: 's1', resumeAt: 's1', code: 'step.loop_guard' });
    assert.equal(x.act.log.length, 3);
    const y = interp([
      { id: 's1', type: 'press', key: 'Tab' },
      { id: 's2', type: 'branch', on: { varSet: 'x' }, cases: { true: 's3' }, default: 's1' },
      { id: 's3', type: 'end', status: 'success' },
    ], { maxSteps: 10 });
    assert.deepEqual(await y.it.run(), { t: 'abort', at: 's1', code: 'step.loop_guard' });
  });
  it('핸들러가 없는 스텝(M2-2·M2-3)은 실행하지 않고 멈춘다', async () => {
    const x = interp([{ id: 's1', type: 'press', key: 'Tab' }, { id: 's2', type: 'gate', card: 'c', authorizes: ['s3'] }, { id: 's3', type: 'end', status: 'success' }]);
    assert.deepEqual(await x.it.run(), { t: 'unhandled', at: 's2', type: 'gate' });
    assert.ok(!x.events.some(([n, d]) => n === 'step.started' && d.stepId === 's2'));
  });
  it('포트 예외는 값 없이 step.port_error로 onFail', async () => {
    const x = interp([{ id: 's1', type: 'click', target: 'f.lookup', onFail: { then: 'abort' } }]);
    x.page.info = async () => {
      throw new Error('secret text 주식회사');
    };
    assert.deepEqual(await x.it.run(), { t: 'abort', at: 's1', code: 'step.port_error' });
    assert.ok(!JSON.stringify(x.events).includes('주식회사'));
  });
  it('최상위 끝을 end 없이 지나면 falloff', async () => {
    assert.deepEqual(await interp([{ id: 's1', type: 'press', key: 'Tab' }]).it.run(), { t: 'falloff', at: 's1' });
  });
  it('beforeStep(정책 집행 지점)은 시도마다 먼저 불린다', async () => {
    const s = setup();
    const seen: string[] = [];
    const it2 = new Interpreter(ir([{ id: 's1', type: 'press', key: 'Tab' }, { id: 's2', type: 'end', status: 'success' }]), BASIC_HANDLERS, s.env, POL, { beforeStep: (st) => void seen.push(st.id) });
    await it2.run();
    assert.deepEqual(seen, ['s1', 's2']);
  });
});
