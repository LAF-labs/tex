// M2-2 실행 조율(D03 §2 상태·전이, §3 게이트·토큰, §5.5 체크포인트 복귀, §8 사람 차례, §11 RunHandle).
// 실제 DB(gate_requests)·GateTokens + 가짜 페이지·Actuator·손으로 돌리는 타이머. 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { GateRepo, openDatabase, RunRepo, type LedgerState } from '@sax/db';
import { READBACK_KEYS, RunController, type GateRequest, type RunControllerInput, type RunStateEvent, type Timers } from '@sax/engine';
import {
  BASIC_HANDLERS, GateTokens, NEXT, newScope, stepEnv,
  type Handlers, type PlaybookIR, type SelectorDict, type SelectorEntry, type Step, type TokenDiscardTrigger, type VerifyResult,
} from '@sax/engine/core';
import { FakeAct, FakeClock, FakePage, type FEl } from './core-page-fakes.ts';

const entry = (o: Partial<SelectorEntry> & Pick<SelectorEntry, 'role' | 'namePattern' | 'landmark' | 'candidates'>): SelectorEntry => ({ frame: 'main', commits: false, lastVerified: '2026-11-01', ...o });
const DICT: SelectorDict = {
  portal: 'hometax',
  commitEndpoints: [],
  knownEndpoints: [],
  entries: {
    'p.root': entry({ role: 'main', namePattern: '^$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'main', name: '' }] }),
    'f.root': entry({ role: 'form', namePattern: '^발급 양식$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'form', name: '발급 양식' }] }),
    'f.otp': entry({ role: 'textbox', namePattern: '^인증번호$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'textbox', name: '인증번호' }] }),
    'f.lookup': entry({ role: 'button', namePattern: '^조회$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '조회' }] }),
    'f.issue': entry({ role: 'button', namePattern: '^발급하기$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '발급하기' }], commits: true, commitEffect: 'issue_document' }),
  },
};
const els = (): FEl[] => [
  { id: 'root', role: 'main', name: '' },
  { id: 'form', role: 'form', name: '발급 양식', parent: 'root' },
  { id: 'otp', role: 'textbox', name: '인증번호', parent: 'form' },
  { id: 'lookup', role: 'button', name: '조회', parent: 'form' },
  { id: 'issue', role: 'button', name: '발급하기', parent: 'form' },
];

const POL = { retries: { stepMax: 2, backoff: 'equal_jitter' as const, baseMs: 1000, capMs: 8000 }, retryFloorMs: 800, random: () => 0.5 };
const ir = (steps: Step[]): PlaybookIR => ({ ir: 2, id: 'test.pb', version: '1.0.0', portal: 'hometax', profileKinds: ['business'], effects: [], inputs: {}, steps, postconditions: [] }) as unknown as PlaybookIR;
const RB = Object.fromEntries(READBACK_KEYS.map((k) => [k, `값-${k}`])) as RunControllerInput['card'] extends (g: never) => infer R ? NonNullable<R>['readback'] : never;

const FORM_URL = 'https://hometax.go.kr/form';
const CP: Step = { id: 's1', type: 'checkpoint', name: 'form', expect: { exists: 'f.root' }, url: FORM_URL };
const GATE: Step = { id: 's20', type: 'gate', card: 'card.issue', authorizes: ['s21'], waitMs: 1000 };
const SUBMIT: Step = { id: 's21', type: 'submit', target: 'f.issue', intent: '$intent.id', verify: 's22' };
const END: Step = { id: 's22', type: 'end', status: 'success' };
const GATE_FLOW = [CP, GATE, SUBMIT, END];
const OTP: Step = { id: 's5', type: 'human', kind: 'otp', prompt: 'p.otp', target: 'f.otp', inputSpec: { pattern: '^\\d{6}$', maxLength: 6 }, ttlMs: 60_000 };
const HANDOFF_MS = 30 * 60_000;

class ManualTimers implements Timers {
  list: Array<{ ms: number; fn: () => void; live: boolean }> = [];
  after(ms: number, fn: () => void) {
    const t = { ms, fn, live: true };
    this.list.push(t);
    return () => {
      t.live = false;
    };
  }
  fire(ms: number): number {
    const due = this.list.filter((t) => t.live && t.ms === ms);
    for (const t of due) {
      t.live = false;
      t.fn();
    }
    return due.length;
  }
  live(): number[] {
    return this.list.filter((t) => t.live).map((t) => t.ms);
  }
}

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await tick();
  }
  assert.fail(`기다림 시간 초과: ${what}`);
}

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-run-ctl-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
let dbn = 0;

interface Opts {
  els?: FEl[];
  submit?: Handlers['submit'];
  verify?: (x: string) => Promise<VerifyResult>;
  recover?: RunControllerInput['recover'];
  beforeStep?: (s: Step, c: RunController) => void;
}

function mk(steps: Step[], o: Opts = {}) {
  const db = openDatabase(path.join(dir, `${dbn++}.sqlite`), new Uint8Array(randomBytes(32)));
  new RunRepo(db).create({ id: 'run-1', playbookId: 'test.pb', playbookVersion: '1.0.0', packageDigest: 'd'.repeat(64), profileId: 'p1', trigger: 'local', inputsHash: 'i'.repeat(64) });
  const gates = new GateRepo(db);
  const tokens = new GateTokens('run-1');
  const triggers: TokenDiscardTrigger[] = [];
  const discardAll = tokens.discardAll.bind(tokens);
  tokens.discardAll = (t) => {
    triggers.push(t);
    return discardAll(t);
  };
  const clock = new FakeClock();
  const page = new FakePage(clock, o.els ?? els());
  const act = new FakeAct(page);
  const env = stepEnv({ page, act, clock, dict: DICT, strings: {}, scope: newScope({ inputs: {}, intentId: 'intent-1' }), domains: ['hometax.go.kr'], irreversible: new Set(['s21']), defaultTimeoutMs: 100, pollMs: 50 });
  const timers = new ManualTimers();
  const st = { ledger: [] as LedgerState[], inDoubt: null as string | null, allowed: true, secret: 'done' as 'done' | 'ttl', lockOk: true, observed: false, loggedIn: [true] as boolean[] };
  const rec = {
    published: [] as GateRequest[], closed: [] as Array<[string, string]>, human: [] as Array<Record<string, unknown>>, humanClosed: [] as Array<[string, string]>,
    secret: [] as Array<Record<string, unknown>>, states: [] as RunStateEvent[], journal: [] as Array<[string, Record<string, unknown>]>, effects: [] as string[],
    guard: [] as string[], locks: [] as boolean[], navs: [] as string[], submits: [] as string[], verifies: [] as string[],
  };
  const submit: Handlers['submit'] = o.submit ?? (async () => {
    rec.submits.push(c.tokenFor('s20') ? 'token' : 'none');
    return NEXT;
  });
  const c: RunController = new RunController({
    runId: 'run-1', intentId: 'intent-1', packageDigest: 'd'.repeat(64), ir: ir(steps), handlers: { ...BASIC_HANDLERS, submit }, env, interp: POL, clock, timers, gates, tokens,
    beforeStep: o.beforeStep ? (s) => o.beforeStep!(s, c) : undefined,
    ledgerStates: () => st.ledger, inDoubtStep: () => st.inDoubt, allowed: () => st.allowed,
    card: () => ({ readback: RB, reserved: [] }), wmaxMs: () => 90_000, commitWindowMs: 600_000,
    gate: { publish: (r) => rec.published.push(r), closed: (id, why) => rec.closed.push([id, why]) },
    human: {
      request: (r) => rec.human.push(r),
      secret: async (r) => {
        rec.secret.push(r);
        return st.secret;
      },
      closed: (id, why) => rec.humanClosed.push([id, why]),
    },
    inputLock: async (on) => {
      rec.locks.push(on);
      return st.lockOk;
    },
    guardMode: (m) => rec.guard.push(m),
    observedManual: () => st.observed,
    reentry: { navigate: async (u) => void rec.navs.push(u), loggedIn: async () => st.loggedIn.shift() ?? true },
    recover: o.recover,
    verify: o.verify ? async (x) => (rec.verifies.push(x), o.verify!(x)) : undefined,
    journal: (t, p) => rec.journal.push([t, p ?? {}]),
    onState: (e) => rec.states.push(e),
    onEffect: (e) => rec.effects.push(e),
  });
  const names = () => rec.states.map((e) => e.state);
  const gate = () => rec.published.at(-1)!;
  const approve = (by: 'local' | 'remote' = 'local') => c.answerGate({ reqId: gate().reqId, decision: 'approved', by, actionHash: gate().actionHash });
  const deny = () => c.answerGate({ reqId: gate().reqId, decision: 'denied', by: 'remote', actionHash: gate().actionHash });
  const atGate = (n = 1) => until(() => rec.published.length === n && c.state.name === 'WaitingGate', `게이트 ${n}`);
  const atHuman = (n = 1) => until(() => rec.human.length === n && c.state.name === 'WaitingHuman', `사람 차례 ${n}`);
  return { c, rec, st, gates, tokens, triggers, timers, page, act, names, gate, approve, deny, atGate, atHuman };
}

describe('게이트(D03 §2 WaitingGate, §3 R-G6·R-G8)', () => {
  it('승인: 입력 잠금 → 요청 발행 → 승인 → 토큰 발급 → Running → 끝. 토큰은 주 비가역 스텝에서 쓸 수 있다', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    assert.deepEqual(h.rec.locks, [true], 'R-G6: 게이트를 열기 전에 입력 잠금');
    assert.equal(h.gates.state(h.gate().reqId), 'open');
    assert.equal(h.gate().waitMs, 1000);
    assert.deepEqual(h.approve(), { ok: true });
    const r = await p;
    assert.equal(r.state, 'Completed');
    assert.deepEqual(h.names(), ['Loaded', 'Preparing', 'Running', 'WaitingGate', 'Running', 'Completed']);
    assert.deepEqual(h.rec.submits, ['token']);
    assert.equal(h.gates.state(h.gate().reqId), 'approved');
    assert.deepEqual(h.rec.closed, [[h.gate().reqId, 'approved']]);
    assert.deepEqual(h.rec.locks, [true], '승인 뒤에도 잠금 유지(커밋 구간에서 푼다)');
    assert.deepEqual(h.timers.live(), [], '대기 타이머 해제');
    assert.ok(h.rec.journal.some(([t, p]) => t === 'gate.approved' && p.actionHash === h.gate().actionHash));
  });
  it('R-G8: 먼저 도착한 결정만 받는다. reqId·actionHash가 다르면 받지 않는다', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    assert.deepEqual(h.c.answerGate({ reqId: h.gate().reqId, decision: 'approved', by: 'remote', actionHash: 'f'.repeat(64) }), { ok: false, code: 'gate.action_mismatch' });
    assert.deepEqual(h.c.answerGate({ reqId: 'other', decision: 'approved', by: 'remote', actionHash: h.gate().actionHash }), { ok: false, code: 'gate.no_request' });
    assert.deepEqual(h.approve('remote'), { ok: true });
    assert.deepEqual(h.deny(), { ok: false, code: 'gate.no_request' }, '두 번째 결정');
    assert.equal((await p).state, 'Completed');
    assert.equal(h.gates.state(h.gate().reqId), 'approved');
  });
  it('거부 → Aborted, 입력 잠금 해제, 토큰 없음', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    h.deny();
    const r = await p;
    assert.deepEqual([r.state, r.code], ['Aborted', 'gate.denied']);
    assert.equal(h.gates.state(h.gate().reqId), 'denied');
    assert.deepEqual(h.rec.locks, [true, false]);
    assert.deepEqual(h.rec.submits, []);
    assert.equal(h.tokens.hasLive(), false);
  });
  it('수정하기: 게이트 닫음(expired) → 토큰 폐기(gate_edit) → 게이트 앞 체크포인트 복귀 절차 → 새 요청(새 reqId)', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    const first = h.gate();
    assert.equal(h.c.cancelGateForEdit(), true);
    await h.atGate(2);
    assert.equal(h.gates.state(first.reqId), 'expired');
    assert.notEqual(h.gate().reqId, first.reqId);
    assert.ok(h.triggers.includes('gate_edit') && h.triggers.includes('checkpoint_return'), String(h.triggers));
    assert.ok(h.rec.journal.some(([t, p]) => t === 'checkpoint.reentry' && p.stepId === 's1' && p.outcome === 'resumed'));
    assert.deepEqual(h.rec.closed[0], [first.reqId, 'edit']);
    h.approve();
    assert.equal((await p).state, 'Completed');
  });
  it('waitMs 초과 → Paused(재개 지점 = 게이트 앞 체크포인트). 재개하면 다시 게이트', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    assert.equal(h.timers.fire(1000), 1);
    const r = await p;
    assert.deepEqual([r.state, r.code, r.resumeAt], ['Paused', 'gate.expired', 's1']);
    assert.equal(h.gates.state(h.gate().reqId), 'expired');
    assert.deepEqual(h.rec.locks, [true, false]);
    const p2 = h.c.resume();
    await h.atGate(2);
    h.approve();
    assert.equal((await p2).state, 'Completed');
  });
  it('승인 때 Running 진입 확인에 걸리면 토큰을 만들지 않고 게이트를 닫아 정지 분기(원장 committed면 CompletedWithIssues)', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    h.st.allowed = false;
    h.approve();
    const r = await p;
    assert.equal(r.state, 'Paused');
    assert.equal(h.tokens.hasLive(), false);
    assert.equal(h.gates.state(h.gate().reqId), 'expired');
    assert.deepEqual(h.rec.submits, []);

    const k = mk(GATE_FLOW);
    const q = k.c.start();
    await k.atGate();
    k.st.allowed = false;
    k.st.ledger = ['committed'];
    k.approve();
    assert.equal((await q).state, 'CompletedWithIssues');
  });
  it('게이트 대기 중 정지 하향은 곧바로 정지 분기(원장 미종결이면 InDoubt), 게이트는 만료', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    h.st.ledger = ['in_doubt'];
    h.c.downgrade();
    assert.equal((await p).state, 'InDoubt');
    assert.equal(h.gates.state(h.gate().reqId), 'expired');
    assert.deepEqual(h.rec.closed.at(-1), [h.gate().reqId, 'stopped']);
  });
  it('게이트 대기 중 중지 → Aborted, 게이트 행 닫음(뒤늦은 승인이 토큰을 만들지 못한다)', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    h.c.abort();
    const r = await p;
    assert.deepEqual([r.state, r.code], ['Aborted', 'run.aborted']);
    assert.equal(h.gates.state(h.gate().reqId), 'expired');
    assert.deepEqual(h.approve(), { ok: false, code: 'gate.no_request' });
    assert.ok(h.rec.effects.includes('ui.notify:reject_portal_push'));
  });
  it('입력 잠금이 안 걸리면 게이트를 열지 않고 핸드오프(gate.unavailable)', async () => {
    const h = mk(GATE_FLOW);
    h.st.lockOk = false;
    const r = await h.c.start();
    assert.deepEqual([r.state, r.code], ['HandedOff', 'gate.unavailable']);
    assert.deepEqual(h.rec.published, []);
  });
});

describe('사람 차례(D03 §2 WaitingHuman, §8)', () => {
  it('otp: 값 검사(inputSpec) 뒤 Running으로 돌아와 키 입력으로 채운다. 저널에는 길이만(⑦). 진입 때 토큰 폐기', async () => {
    const h = mk([CP, OTP, END]);
    const p = h.c.start();
    await h.atHuman();
    const req = h.rec.human[0]!;
    assert.deepEqual([req.kind, req.prompt, req.ttlMs, req.stepId], ['otp', 'p.otp', 60_000, 's5']);
    const reqId = String(req.reqId);
    assert.deepEqual(h.c.answerHuman('s5', { reqId, value: '12a456' }), { ok: false, code: 'human.bad_input' });
    assert.deepEqual(h.c.answerHuman('s5', { reqId, value: '1234567' }), { ok: false, code: 'human.bad_input' });
    assert.deepEqual(h.c.answerHuman('s5', { reqId: 'x', value: '123456' }), { ok: false, code: 'human.no_request' });
    assert.deepEqual(h.c.answerHuman('s5', { reqId, value: '482913' }), { ok: true });
    assert.equal((await p).state, 'Completed');
    assert.deepEqual(h.act.log, ['fill f.otp keys']);
    assert.equal(h.page.els.get('otp')!.value, '482913');
    assert.ok(!JSON.stringify(h.rec.journal).includes('482913'), '저널에 입력 값 없음');
    assert.ok(h.rec.journal.some(([t, p]) => t === 'human.answered' && p.length === 6));
    assert.ok(h.triggers.includes('WaitingHuman'));
    assert.deepEqual(h.names(), ['Loaded', 'Preparing', 'Running', 'WaitingHuman', 'Running', 'Completed']);
    assert.deepEqual(h.rec.humanClosed, [[reqId, 'answered']]);
  });
  it('TTL → Paused(재개 지점 = 마지막 체크포인트)', async () => {
    const h = mk([CP, OTP, END]);
    const p = h.c.start();
    await h.atHuman();
    assert.equal(h.timers.fire(60_000), 1);
    const r = await p;
    assert.deepEqual([r.state, r.code, r.resumeAt], ['Paused', 'human.ttl_expired', 's1']);
    assert.deepEqual(h.act.log, []);
  });
  it('manual: 차례 동안 커밋 가드는 관측만(R-C2), 끝나면 다시 막기. 값 없이 끝낸다', async () => {
    const h = mk([CP, { id: 's5', type: 'human', kind: 'manual', prompt: 'p.manual', ttlMs: 60_000 }, END]);
    const p = h.c.start();
    await h.atHuman();
    assert.deepEqual(h.rec.guard, ['observing']);
    assert.deepEqual(h.c.answerHuman('s5', { reqId: String(h.rec.human[0]!.reqId) }), { ok: true });
    assert.equal((await p).state, 'Completed');
    assert.deepEqual(h.rec.guard, ['observing', 'running']);
  });
  it('kind=secret: 금고 비밀 창만 연다(값은 엔진에 오지 않는다). TTL이면 Paused', async () => {
    const S: Step = { id: 's5', type: 'human', kind: 'secret', prompt: 'p.secret', target: 'f.otp', ttlMs: 60_000 };
    const h = mk([CP, S, END]);
    assert.equal((await h.c.start()).state, 'Completed');
    assert.deepEqual(h.rec.secret, [{ runId: 'run-1', stepId: 's5', target: 'f.otp', prompt: 'p.secret', ttlMs: 60_000 }]);
    assert.deepEqual(h.rec.human, [], '값 입력 요청 없음');
    assert.deepEqual(h.act.log, [], '엔진은 칸을 채우지 않는다');

    const k = mk([CP, S, END]);
    k.st.secret = 'ttl';
    const r = await k.c.start();
    assert.deepEqual([r.state, r.resumeAt], ['Paused', 's1']);
  });
  it('사람 차례 중 정지 하향은 차례가 끝난 뒤 정지 분기. 칸은 채우지 않는다', async () => {
    const h = mk([CP, OTP, END]);
    const p = h.c.start();
    await h.atHuman();
    h.c.downgrade();
    assert.equal(h.c.state.name, 'WaitingHuman');
    assert.equal(h.c.state.pendingDowngrade, true);
    h.c.answerHuman('s5', { reqId: String(h.rec.human[0]!.reqId), value: '123456' });
    const r = await p;
    assert.deepEqual([r.state, r.resumeAt], ['Paused', 's1']);
    assert.deepEqual(h.act.log, []);
  });
  it('사람 차례 중 중지 → Aborted', async () => {
    const h = mk([CP, OTP, END]);
    const p = h.c.start();
    await h.atHuman();
    h.c.abort();
    assert.equal((await p).state, 'Aborted');
    assert.deepEqual(h.rec.humanClosed.map(([, w]) => w), ['aborted']);
  });
  it('onFail human:secret 멈춤: 비밀 창을 닫으면 다음 스텝부터', async () => {
    const h = mk([CP, { id: 's2', type: 'click', target: 'f.lookup', timeoutMs: 10, onFail: { then: 'human:secret' } }, END], { els: els().filter((e) => e.id !== 'lookup') });
    assert.equal((await h.c.start()).state, 'Completed');
    assert.equal(h.rec.secret.length, 1);
    assert.equal(h.rec.secret[0]!.stepId, 's2');
  });
});

describe('핸드오프·재개(D03 §2 HandedOff, R-C2)', () => {
  const MISS: Step = { id: 's2', type: 'click', target: 'f.lookup', timeoutMs: 10, onFail: { then: 'handoff' } };
  it('스텝 실패 → Recovering → HandedOff(가드 관측, 토큰 폐기). 재개하면 resumeAt부터, 가드 다시 막기', async () => {
    const h = mk([CP, MISS, END], { els: els().filter((e) => e.id !== 'lookup') });
    const r = await h.c.start();
    assert.deepEqual([r.state, r.code, r.resumeAt], ['HandedOff', 'step.selector_miss', 's2']);
    assert.deepEqual(h.names().slice(-2), ['Recovering', 'HandedOff']);
    assert.deepEqual(h.rec.guard, ['observing']);
    assert.ok(h.triggers.includes('Recovering'));
    assert.ok(h.rec.effects.includes('ui.banner:handoff_manual_commit'));
    assert.deepEqual(h.timers.live(), [HANDOFF_MS]);
    h.page.els.set('lookup', { id: 'lookup', role: 'button', name: '조회', parent: 'form' });
    assert.equal((await h.c.resume()).state, 'Completed');
    assert.deepEqual(h.rec.guard, ['observing', 'running']);
    assert.deepEqual(h.act.log, ['click f.lookup']);
    assert.deepEqual(h.timers.live(), []);
  });
  it('핸드오프 상한 → Paused, 가드 다시 막기', async () => {
    const h = mk([CP, MISS, END], { els: els().filter((e) => e.id !== 'lookup') });
    await h.c.start();
    h.timers.fire(HANDOFF_MS);
    assert.equal(h.c.state.name, 'Paused');
    assert.deepEqual(h.rec.guard, ['observing', 'running']);
    assert.ok(h.rec.effects.includes('slot.release'));
  });
  const failingSubmit: Handlers['submit'] = async () => ({ t: 'fail', code: 'step.port_error' });
  const handedOffAtX = async (verify?: (x: string) => Promise<VerifyResult>) => {
    const h = mk([CP, GATE, { ...SUBMIT, onFail: { then: 'handoff' } } as Step, END], { submit: failingSubmit, verify });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.deepEqual([r.state, r.resumeAt], ['HandedOff', 's22'], '비가역 실패의 resumeAt은 그 verify');
    return h;
  };
  it('재개 때 원장이 in_doubt면 resumeAt 대신 그 X의 verify부터: committed → 사후 스텝', async () => {
    const h = await handedOffAtX(async () => 'committed');
    h.st.ledger = ['in_doubt'];
    h.st.inDoubt = 's21';
    const r = await h.c.resume();
    assert.equal(r.state, 'Completed');
    assert.deepEqual(h.rec.verifies, ['s21']);
    assert.ok(h.rec.effects.includes('ledger.committed{verify_ref}') && h.rec.effects.includes('goto.post_steps'));
  });
  it('verify not_committed → 게이트 앞 체크포인트(재게이트), unknown·verify 없음 → InDoubt', async () => {
    const h = await handedOffAtX(async () => 'not_committed');
    h.st.ledger = ['in_doubt'];
    h.st.inDoubt = 's21';
    const p = h.c.resume();
    await h.atGate(2);
    assert.ok(h.rec.effects.includes('ledger.not_committed{verify}'));
    h.c.abort();
    assert.equal((await p).state, 'Aborted');

    const u = await handedOffAtX(async () => 'unknown');
    u.st.ledger = ['in_doubt'];
    u.st.inDoubt = 's21';
    assert.equal((await u.c.resume()).state, 'InDoubt');

    const n = await handedOffAtX();
    n.st.ledger = ['in_doubt'];
    n.st.inDoubt = 's21';
    assert.equal((await n.c.resume()).state, 'InDoubt', 'verify가 없으면 결론 없음');
  });
  it('R-C2 관측(가드가 핸드오프 중 커밋 요청을 봤다)도 verify 먼저', async () => {
    const h = await handedOffAtX(async () => 'committed');
    h.c.observedCommit();
    assert.ok(h.rec.effects.includes('ledger.observed_manual'));
    h.st.observed = true;
    h.st.inDoubt = 's21';
    assert.equal((await h.c.resume()).state, 'Completed');
    assert.deepEqual(h.rec.verifies, ['s21']);
  });
  it('"직접 발급함"(attestManualCommit) → 원장 observed_manual → verify', async () => {
    const h = await handedOffAtX(async () => 'committed');
    h.st.inDoubt = 's21';
    const r = await h.c.attestManualCommit();
    assert.equal(r.state, 'Completed');
    assert.ok(h.rec.effects.includes('ledger.observed_manual'));
    assert.deepEqual(h.rec.verifies, ['s21']);
  });
  it('recover 멈춤: 복구(M2-5)가 성공하면 실패한 스텝부터 다시, 실패하면 HandedOff', async () => {
    const REC: Step = { id: 's2', type: 'click', target: 'f.lookup', timeoutMs: 10, onFail: { then: 'recover' } };
    let calls = 0;
    const h = mk([CP, REC, END], {
      els: els().filter((e) => e.id !== 'lookup'),
      recover: async () => {
        calls++;
        h.page.els.set('lookup', { id: 'lookup', role: 'button', name: '조회', parent: 'form' });
        return true;
      },
    });
    assert.equal((await h.c.start()).state, 'Completed');
    assert.equal(calls, 1);
    assert.deepEqual(h.names(), ['Loaded', 'Preparing', 'Running', 'Recovering', 'Running', 'Completed']);

    const k = mk([CP, REC, END], { els: els().filter((e) => e.id !== 'lookup'), recover: async () => false });
    const r = await k.c.start();
    assert.deepEqual([r.state, r.resumeAt], ['HandedOff', 's2']);
  });
});

describe('체크포인트 복귀(D03 §5.5)', () => {
  it('sessionRequired인데 로그인이 풀렸으면 session 체크포인트로 올라간다', async () => {
    const S0: Step = { id: 's0', type: 'checkpoint', name: 'session', expect: { exists: 'p.root' } };
    const S1: Step = { ...CP, sessionRequired: true } as Step;
    const h = mk([S0, S1, GATE, SUBMIT, END]);
    const p = h.c.start();
    await h.atGate();
    h.st.loggedIn = [false];
    h.c.cancelGateForEdit();
    await h.atGate(2);
    const re = h.rec.journal.filter(([t]) => t === 'checkpoint.reentry').map(([, p]) => `${p.stepId}:${p.outcome}`);
    assert.deepEqual(re, ['s1:escalate_session', 's0:resumed', 's1:resumed']);
    h.approve();
    assert.equal((await p).state, 'Completed');
  });
  it('복귀해 expect가 맞지 않으면 url로 다시 가 보고, 그래도 아니면 핸드오프', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    h.page.els.delete('form');
    h.c.cancelGateForEdit();
    const r = await p;
    assert.deepEqual([r.state, r.code], ['HandedOff', 'portal.unexpected_page']);
    assert.deepEqual(h.rec.navs, [FORM_URL]);
  });
});

describe('정지·중지·진입 확인(D03 §2 규칙, ADR-023 결정 5·6)', () => {
  const STEPS: Step[] = [
    { id: 's1', type: 'goto', url: 'https://hometax.go.kr/a' },
    { id: 's2', type: 'goto', url: 'https://hometax.go.kr/b' },
    END,
  ];
  it('실행 중 정지 하향은 다음 스텝 경계에서 정지 분기(그 스텝은 실행하지 않는다)', async () => {
    const h = mk(STEPS, { beforeStep: (s, c) => void (s.id === 's2' && c.downgrade()) });
    const r = await h.c.start();
    assert.deepEqual([r.state, r.resumeAt], ['Paused', 's2']);
    assert.deepEqual(h.act.log, ['goto hometax.go.kr']);
  });
  it('실행 중 중지는 다음 스텝 경계에서 Aborted', async () => {
    const h = mk(STEPS, { beforeStep: (s, c) => void (s.id === 's2' && c.abort()) });
    const r = await h.c.start();
    assert.deepEqual([r.state, r.code], ['Aborted', 'run.aborted']);
    assert.deepEqual(h.act.log, ['goto hometax.go.kr']);
  });
  it('Paused 재개도 Running 진입 확인: 허용하지 않으면 정지 분기에 머문다. 다른 package_digest면 다시 시작만', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    h.timers.fire(1000);
    await p;
    h.st.allowed = false;
    assert.equal((await h.c.resume()).state, 'Paused');
    assert.deepEqual(h.rec.published.length, 1);
    h.st.allowed = true;
    assert.deepEqual(await h.c.resume({ samePackageDigest: false }), { state: 'Paused', at: null, code: 'engine.restart_only', resumeAt: 's1' });
  });
  it('의도 재사용이면 시작하지 않고 Failed(보안 이벤트)', async () => {
    const h = mk(GATE_FLOW);
    const r = await h.c.start({ intentReuse: true });
    assert.deepEqual([r.state, r.code], ['Failed', 'ledger.intent_reuse']);
    assert.ok(h.rec.journal.some(([t, p]) => t === 'ledger.intent_reuse' && p.security === true));
  });
  it('끝난 실행은 재개할 수 없고, end failed·핸들러 없는 스텝은 Failed', async () => {
    const h = mk([END]);
    assert.equal((await h.c.start()).state, 'Completed');
    assert.equal((await h.c.resume()).code, 'engine.illegal_transition');
    const f = mk([{ id: 's1', type: 'end', status: 'failed' }]);
    assert.equal((await f.c.start()).state, 'Failed');
    const u = mk([{ id: 's1', type: 'save_pdf' } as unknown as Step]);
    const r = await u.c.start();
    assert.deepEqual([r.state], ['Failed']);
    assert.ok(u.rec.journal.some(([t, p]) => t === 'run.state' && p.code === 'engine.unhandled_step'));
  });
  it('상태 이벤트: 상태가 바뀔 때마다 한 번, 코드·스텝 id만(⑦)', async () => {
    const h = mk(GATE_FLOW);
    const p = h.c.start();
    await h.atGate();
    h.deny();
    await p;
    const last = h.rec.states.at(-1)!;
    assert.deepEqual({ ...last, ui: [] }, { runId: 'run-1', state: 'Aborted', prev: 'WaitingGate', at: 's20', code: 'gate.denied', ui: [] });
    assert.ok(!JSON.stringify(h.rec.states).includes('값-'), '카드 값 없음');
  });
});
