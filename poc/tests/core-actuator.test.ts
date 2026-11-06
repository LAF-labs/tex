// M2-4 GuardedActuator(D03 §5.2 R-A1·R-A2·커밋 그림자, V-20 런타임판, §5.3 커밋 항목)과 대화상자 정책(D03 §6, V-24). 가짜 포트, 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  BASIC_HANDLERS, GuardedActuator, Interpreter, decideDialog, newScope, noticeText, resolveTarget, stepEnv,
  type ActResult, type ActionKind, type ActionPolicy, type DialogHandle, type DialogKind, type PlaybookIR, type Resolved, type SelectorDict, type SelectorEntry,
} from '@sax/engine/core';
import { FakeAct, FakeClock, FakePage, type FEl } from './core-page-fakes.ts';

const entry = (o: Partial<SelectorEntry> & Pick<SelectorEntry, 'role' | 'namePattern' | 'landmark' | 'candidates'>): SelectorEntry => ({ frame: 'main', commits: false, lastVerified: '2026-11-01', ...o });
const btn = (name: string) => [{ kind: 'role' as const, role: 'button', name }];
const DICT: SelectorDict = {
  portal: 'hometax',
  commitEndpoints: [],
  knownEndpoints: [],
  entries: {
    'p.root': entry({ role: 'main', namePattern: '^$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'main', name: '' }] }),
    'f.root': entry({ role: 'form', namePattern: '^발급 양식$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'form', name: '발급 양식' }] }),
    'f.name': entry({ role: 'textbox', namePattern: '^상호$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'textbox', name: '상호' }], fieldKey: 'counterpartName' }),
    'f.lookup': entry({ role: 'button', namePattern: '^조회$', landmark: 'f.root', candidates: [{ kind: 'css', value: '#lk' }] }),
    'f.issue': entry({ role: 'button', namePattern: '^발급', landmark: 'f.root', candidates: btn('발급하기'), commits: true, commitEffect: 'issue_document' }),
    // 같은 요소를 다른 후보로 가리키는 비커밋 항목(R-A2)
    'f.alias': entry({ role: 'button', namePattern: '^발급하기$', landmark: 'f.root', candidates: [{ kind: 'css', value: '#iss' }], reviewNote: { by: 'qa', reason: '시험' } }),
    // 진행형 이름(DENY_ACTION_NAME): 검토 없음 / 검토됨
    'f.next': entry({ role: 'button', namePattern: '^다음$', landmark: 'f.root', candidates: btn('다음') }),
    'f.nextOk': entry({ role: 'button', namePattern: '^다음 단계$', landmark: 'f.root', candidates: btn('다음 단계'), reviewNote: { by: 'qa', reason: '조회 화면 이동' } }),
    // 검토됐어도 같은 랜드마크 커밋 항목 패턴(^발급)에 맞으면 그림자
    'f.history': entry({ role: 'button', namePattern: '^발급 내역$', landmark: 'f.root', candidates: btn('발급 내역'), reviewNote: { by: 'qa', reason: '내역 보기' } }),
    'f.pw': entry({ role: 'textbox', namePattern: '^비밀번호$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'textbox', name: '비밀번호' }], inputType: 'password', secretKind: 'portal_password', secretPurpose: 'login' }),
    // 다른 랜드마크: 양식의 커밋 패턴과 대조하지 않는다
    'd.root': entry({ role: 'dialog', namePattern: '^안내$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'dialog', name: '안내' }] }),
    'd.history': entry({ role: 'button', namePattern: '^발급 내역$', landmark: 'd.root', candidates: btn('발급 내역'), reviewNote: { by: 'qa', reason: '안내 창' } }),
  },
};

const els = (): FEl[] => [
  { id: 'root', role: 'main', name: '' },
  { id: 'form', role: 'form', name: '발급 양식', parent: 'root' },
  { id: 'nm', role: 'textbox', name: '상호', parent: 'form' },
  { id: 'lookup', role: 'button', name: '조회', parent: 'form', css: ['#lk'] },
  { id: 'issue', role: 'button', name: '발급하기', parent: 'form', css: ['#iss'] },
  { id: 'next', role: 'button', name: '다음', parent: 'form' },
  { id: 'nextOk', role: 'button', name: '다음 단계', parent: 'form' },
  { id: 'hist', role: 'button', name: '발급 내역', parent: 'form' },
  { id: 'pw', role: 'textbox', name: '비밀번호', parent: 'form' },
  { id: 'dlg', role: 'dialog', name: '안내', parent: 'root' },
  { id: 'dhist', role: 'button', name: '발급 내역', parent: 'dlg' },
];

class FakePolicy implements ActionPolicy {
  kinds: ActionKind[] = [];
  dialogs = 0;
  refuse: string | null = null;
  async beforeAction(kind: ActionKind): Promise<ActResult> {
    this.kinds.push(kind);
    return this.refuse ? { ok: false, code: this.refuse } : { ok: true };
  }
  noteDialog() {
    this.dialogs++;
  }
}

function setup(o: { els?: FEl[]; armed?: string[]; confirm?: RegExp } = {}) {
  const clock = new FakeClock();
  const page = new FakePage(clock, o.els ?? els());
  const driver = new FakeAct(page);
  const policy = new FakePolicy();
  const security: string[] = [];
  const journal: Array<{ type: string; payload: Record<string, string> }> = [];
  const act = new GuardedActuator({
    driver, reader: page, dict: DICT, domains: ['hometax.go.kr', '*.hometax.go.kr'], policy,
    events: { security: (code, key) => security.push(`${code} ${key}`), journal: (type, payload) => journal.push({ type, payload }) },
    commitArmed: (k) => (o.armed ?? []).includes(k),
    armedConfirm: () => o.confirm ?? null,
  });
  const res = async (key: string): Promise<Resolved> => {
    const r = await resolveTarget(page, DICT, key);
    assert.ok(r.ok, key);
    return r.t;
  };
  return { clock, page, driver, policy, act, security, journal, res };
}
const code = (r: ActResult) => (r.ok ? 'ok' : r.code);

describe('GuardedActuator', () => {
  it('정책 → 가드 → 드라이버 순서, 정책이 거부하면 드라이버에 닿지 않는다', async () => {
    const s = setup();
    assert.equal(code(await s.act.click(await s.res('f.lookup'))), 'ok');
    assert.equal(code(await s.act.fill(await s.res('f.name'), '가나상사', { keyEvents: false })), 'ok');
    assert.deepEqual(s.driver.log, ['click f.lookup', 'fill f.name']);
    assert.deepEqual(s.policy.kinds, ['click', 'fill']);
    s.policy.refuse = 'policy.actuations_per_run';
    assert.equal(code(await s.act.click(await s.res('f.lookup'))), 'policy.actuations_per_run');
    assert.equal(s.driver.log.length, 2);
  });

  it('goto: 정책을 거친 뒤 https·manifest.domains를 다시 본다(V-06)', async () => {
    const s = setup();
    assert.equal(code(await s.act.goto('https://www.hometax.go.kr/a')), 'ok');
    assert.equal(code(await s.act.goto('https://evil.example/a')), 'step.url_not_allowed');
    assert.equal(code(await s.act.goto('http://hometax.go.kr/a')), 'step.url_not_allowed');
    assert.deepEqual(s.policy.kinds, ['navigate', 'navigate', 'navigate']);
    assert.deepEqual(s.driver.log, ['goto www.hometax.go.kr']);
  });

  it('비밀 칸(V-20 런타임판)은 secretWindow 말고는 받지 않고, secretWindow는 비밀 칸에만', async () => {
    const s = setup();
    const pw = await s.res('f.pw');
    for (const r of [await s.act.fill(pw, 'x', { keyEvents: true }), await s.act.click(pw), await s.act.clear(pw), await s.act.press('Enter', pw)]) assert.equal(code(r), 'step.secret_field');
    assert.equal(code(await s.act.secretWindow(pw)), 'ok');
    assert.equal(code(await s.act.secretWindow(await s.res('f.name'))), 'step.secret_field');
    assert.equal(s.driver.log.length, 0, '드라이버는 비밀 칸에 아무것도 하지 않는다(입력은 금고 안)');
    assert.equal(s.journal.filter((j) => j.type === 'actuator.refused' && j.payload.code === 'step.secret_field' && j.payload.key === 'f.pw').length, 4, '보안 이벤트 목록 밖이라 저널(PROPOSED_D16)');
    assert.deepEqual(s.security, []);
    assert.ok(s.policy.kinds.includes('secret_window'));
  });

  it('커밋 항목: 무장된 그 항목의 click만, 나머지는 step.irreversible_unguarded', async () => {
    const off = setup();
    assert.equal(code(await off.act.click(await off.res('f.issue'))), 'step.irreversible_unguarded');
    assert.deepEqual(off.journal, [{ type: 'actuator.refused', payload: { code: 'step.irreversible_unguarded', key: 'f.issue' } }]);
    const on = setup({ armed: ['f.issue'] });
    const t = await on.res('f.issue');
    assert.equal(code(await on.act.press('Enter', t)), 'step.irreversible_unguarded', '무장돼도 press로는 누르지 않는다');
    assert.equal(code(await on.act.click(t)), 'ok');
    assert.deepEqual(on.driver.log, ['click f.issue']);
  });

  it('R-A1: 동작 직전에 다시 해석해 이름이 바뀌었거나 다른 요소로 바뀌었거나 사라졌으면 동작하지 않는다', async () => {
    const s = setup();
    const t = await s.res('f.lookup');
    s.page.els.get('lookup')!.name = '조회 후 발급';
    assert.equal(code(await s.act.click(t)), 'step.identity_mismatch');
    s.page.els.get('lookup')!.name = '조회';
    // 옛 요소는 남고 같은 이름의 새 요소로 바뀜: 해석은 새 요소를 고른다
    s.page.els.delete('lookup');
    s.page.els.set('lookup2', { id: 'lookup2', role: 'button', name: '조회', parent: 'form', css: ['#lk'] });
    assert.equal(code(await s.act.click(t)), 'step.identity_mismatch');
    s.page.els.delete('lookup2');
    assert.equal(code(await s.act.click(t)), 'step.selector_miss');
    assert.equal(s.driver.log.length, 0);
  });

  it('R-A1: 넘어온 t.entry가 아니라 사전 항목으로 본다', async () => {
    const s = setup({ armed: [] });
    const t = await s.res('f.issue').catch(() => null);
    const forged: Resolved = { ...t!, entry: { ...t!.entry, commits: false } };
    assert.equal(code(await s.act.click(forged)), 'step.irreversible_unguarded');
  });

  it('R-A2: 비커밋 항목이 같은 랜드마크 커밋 항목과 같은 요소면 step.commit_shadow(보안), 입력도 같다', async () => {
    const s = setup();
    const alias = await s.res('f.alias');
    assert.equal(code(await s.act.click(alias)), 'step.commit_shadow');
    assert.equal(code(await s.act.fill(alias, 'x', { keyEvents: false })), 'step.commit_shadow');
    assert.deepEqual(s.security, ['step.commit_shadow f.alias', 'step.commit_shadow f.alias']);
    assert.equal(s.driver.log.length, 0);
  });

  it('R-A2: 해석에 실패한 커밋 항목은 비교에서 빼고 저널에만(키·코드만)', async () => {
    const s = setup({ els: els().filter((e) => e.id !== 'issue') });
    assert.equal(code(await s.act.click(await s.res('f.lookup'))), 'ok');
    assert.deepEqual(s.journal, [{ type: 'actuator.commit_unresolved', payload: { key: 'f.issue', code: 'step.selector_miss' } }]);
  });

  it('커밋 그림자: DENY_ACTION_NAME(검토 없음)·커밋 항목 패턴(검토돼도)에 맞는 이름은 누르지 않는다', async () => {
    const s = setup();
    assert.equal(code(await s.act.click(await s.res('f.next'))), 'step.commit_shadow', "'다음'은 DENY_ACTION_NAME");
    assert.equal(code(await s.act.press('Enter', await s.res('f.next'))), 'step.commit_shadow', 'Enter도 누름이다');
    assert.equal(code(await s.act.click(await s.res('f.nextOk'))), 'ok', 'reviewNote는 DENY 검사만 뺀다');
    assert.equal(code(await s.act.click(await s.res('f.history'))), 'step.commit_shadow', '같은 랜드마크 커밋 항목 ^발급에 맞음');
    assert.equal(code(await s.act.click(await s.res('d.history'))), 'ok', '다른 랜드마크의 커밋 패턴과는 대조하지 않는다');
    assert.deepEqual(s.driver.log, ['click f.nextOk', 'click d.history']);
  });

  it('실행기: commit_shadow는 재시도·onFail 없이 핸드오프(D16 처리 열), 비가역·비밀 칸 결함은 재시도 없이 중단', async () => {
    const s = setup();
    const env = stepEnv({ page: s.page, act: s.act, clock: s.clock, dict: DICT, strings: {}, scope: newScope({ inputs: {}, profile: {}, intentId: 'i1' }), domains: ['hometax.go.kr'], irreversible: new Set(), defaultTimeoutMs: 1000, pollMs: 100 });
    const ir = (target: string) => ({
      ir: 2, id: 'test.pb', version: '1.0.0', portal: 'hometax', profileKinds: ['business'], effects: [], inputs: {}, postconditions: [],
      steps: [{ id: 's1', type: 'click', target, onFail: { retry: 2, then: 'abort' } }, { id: 's2', type: 'end', status: 'success' }],
    }) as unknown as PlaybookIR;
    const run = (target: string) => new Interpreter(ir(target), BASIC_HANDLERS, env, { retries: { stepMax: 3, backoff: 'equal_jitter', baseMs: 800, capMs: 10000 }, retryFloorMs: 800, random: () => 0.5 }, {}).run();
    assert.deepEqual(await run('f.next'), { t: 'handoff', at: 's1', resumeAt: 's1', code: 'step.commit_shadow' });
    assert.equal(s.policy.kinds.length, 1, '재시도하지 않았다');
    assert.deepEqual(await run('f.issue'), { t: 'abort', at: 's1', code: 'step.irreversible_unguarded' }, '커밋 항목: 플레이북 결함이라 재시도 없이 중단');
    assert.deepEqual(await run('f.pw'), { t: 'abort', at: 's1', code: 'step.secret_field' });
    assert.deepEqual(s.clock.sleeps, [], '재시도 대기가 없다');
    assert.deepEqual(s.driver.log, []);
  });

  it('press: 타깃 없는 키는 정책만, 저널·보안 이벤트에 값이 없다(⑦)', async () => {
    const s = setup();
    assert.equal(code(await s.act.press('Tab', null)), 'ok');
    await s.act.fill(await s.res('f.name'), '비밀상호-1234', { keyEvents: false });
    await s.act.click(await s.res('f.next'));
    assert.ok(!JSON.stringify([s.journal, s.security]).includes('비밀상호'));
  });
});

class FakeDialog implements DialogHandle {
  kind: DialogKind;
  message: string;
  answer: 'accept' | 'dismiss' | null = null;
  constructor(kind: DialogKind, message: string) {
    this.kind = kind;
    this.message = message;
  }
  async accept() {
    this.answer = 'accept';
  }
  async dismiss() {
    this.answer = 'dismiss';
  }
}

describe('대화상자 정책', () => {
  const CONFIRM = /^세금계산서를 발급하시겠습니까\?$/;

  it('alert는 수락, prompt는 닫기, 무장 밖 confirm·beforeunload는 닫기', () => {
    assert.equal(decideDialog('alert', '조회 결과가 없습니다', null).action, 'accept');
    assert.equal(decideDialog('prompt', '값을 입력', CONFIRM).action, 'dismiss');
    assert.equal(decideDialog('confirm', '세금계산서를 발급하시겠습니까?', null).action, 'dismiss');
    assert.equal(decideDialog('beforeunload', '', null).action, 'dismiss');
  });

  it('무장 + expectConfirm 일치일 때만 confirm 수락 + commit.confirm_accepted{textHash}(V-24)', () => {
    const d = decideDialog('confirm', '  세금계산서를 발급하시겠습니까?​ ', CONFIRM);
    assert.equal(d.action, 'accept');
    assert.equal(d.event.type, 'commit.confirm_accepted');
    assert.match(d.event.payload.textHash!, /^[0-9a-f]{64}$/);
    assert.equal(decideDialog('confirm', '세금계산서를 발급하시겠습니까? 취소할 수 없습니다', CONFIRM).action, 'dismiss', '앵커: 덧붙인 문구는 불일치');
    assert.equal(decideDialog('confirm', '다른 질문', CONFIRM).event.type, 'dialog.dismissed');
  });

  it('안내 문구: NFKC·제로폭 제거·공백 접기·200자, 저널에는 없다', () => {
    assert.equal(noticeText('ＡＢＣ​  가\n나'), 'ABC 가 나');
    assert.equal(noticeText('가'.repeat(300)).length, 200);
    const d = decideDialog('alert', '세션이 만료되었습니다', null);
    assert.ok(!JSON.stringify(d.event).includes('세션'));
  });

  it('GuardedActuator.dialog: 언제나 응답하고(상한과 무관) 마지막 문구는 실행 메모리에만', async () => {
    const s = setup({ confirm: CONFIRM });
    s.policy.refuse = 'policy.actuations_per_run';
    const a = new FakeDialog('alert', '홈택스 안내 문구');
    await s.act.dialog(a);
    const c = new FakeDialog('confirm', '세금계산서를 발급하시겠습니까?');
    await s.act.dialog(c);
    const p = new FakeDialog('prompt', '입력');
    await s.act.dialog(p);
    assert.deepEqual([a.answer, c.answer, p.answer], ['accept', 'accept', 'dismiss']);
    assert.equal(s.policy.dialogs, 3);
    assert.equal(s.act.notice, '입력');
    assert.deepEqual(s.journal.map((j) => j.type), ['dialog.alert_accepted', 'commit.confirm_accepted', 'dialog.dismissed']);
    assert.ok(!JSON.stringify(s.journal).includes('홈택스 안내'));
  });
});
