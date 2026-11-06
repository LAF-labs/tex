// M2-2 실행 조율(D03 §2 상태·전이, §3 게이트·토큰, §5.5 체크포인트 복귀, §8 사람 차례, §11 RunHandle).
// 실제 DB(gate_requests)·GateTokens + 가짜 페이지·Actuator·손으로 돌리는 타이머. 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { GateRepo, openDatabase, RunRepo, type Db, type LedgerState } from '@sax/db';
import { READBACK_KEYS, RunController, type CommitPort, type GateRequest, type RunControllerInput, type RunStateEvent, type Timers } from '@sax/engine';
import {
  BASIC_HANDLERS, GateTokens, newScope, stepEnv,
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
    'f.amount': entry({ role: 'textbox', namePattern: '^공급가액$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'textbox', name: '공급가액' }], fieldKey: 'supplyAmount' }),
    'f.signOk': entry({ role: 'button', namePattern: '^서명 확인$', landmark: 'p.root', candidates: [{ kind: 'role', role: 'button', name: '서명 확인' }], commits: true, commitEffect: 'issue_document' }),
  },
};
const els = (): FEl[] => [
  { id: 'root', role: 'main', name: '' },
  { id: 'form', role: 'form', name: '발급 양식', parent: 'root' },
  { id: 'otp', role: 'textbox', name: '인증번호', parent: 'form' },
  { id: 'lookup', role: 'button', name: '조회', parent: 'form' },
  { id: 'issue', role: 'button', name: '발급하기', parent: 'form' },
  { id: 'amount', role: 'textbox', name: '공급가액', parent: 'form', value: '1,000', a11y: '1000' },
];

const POL = { retries: { stepMax: 2, backoff: 'equal_jitter' as const, baseMs: 1000, capMs: 8000 }, retryFloorMs: 800, random: () => 0.5 };
const ir = (steps: Step[]): PlaybookIR => ({ ir: 2, id: 'test.pb', version: '1.0.0', portal: 'hometax', profileKinds: ['business'], effects: [], inputs: {}, steps, postconditions: [] }) as unknown as PlaybookIR;
const RB = Object.fromEntries(READBACK_KEYS.map((k) => [k, `값-${k}`])) as RunControllerInput['card'] extends (g: never) => infer R ? NonNullable<R>['readback'] : never;

const FORM_URL = 'https://hometax.go.kr/form';
const CP: Step = { id: 's1', type: 'checkpoint', name: 'form', expect: { exists: 'f.root' }, url: FORM_URL };
const GATE: Step = { id: 's20', type: 'gate', card: 'card.issue', authorizes: ['s21'], waitMs: 1000 };
const SUBMIT: Step = { id: 's21', type: 'submit', target: 'f.issue', intent: '$intent.id', verify: 'sv', timeoutMs: 100 };
/** 주 비가역 s21의 verify. 판정은 mk의 verifyStep(기본 committed). not_committed는 게이트 앞으로(V-03f). */
const SV: Step = { id: 'sv', type: 'verify', lookup: { playbook: 'hometax.invoice.lookup', match: { supplyAmount: '$readback.supplyAmount' }, window: 'issueDate', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60_000, lookups: 2 }, bind: { approvalNo: 'approvalNo' } }, on: { committed: 's22', not_committed: 's1', unknown: 'handoff' } };
const END: Step = { id: 's22', type: 'end', status: 'success' };
const GATE_FLOW = [CP, GATE, SUBMIT, SV, END];
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
const opened: Db[] = [];
// Windows는 열린 DB 파일을 지우지 못한다(EPERM). 닫고 지운다.
after(() => {
  for (const d of opened) d.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
let dbn = 0;

interface Opts {
  els?: FEl[];
  verify?: (x: string) => Promise<VerifyResult>;
  /** null이면 verify 스텝 판정 없음(unhandled). 없으면 committed. */
  verifyStep?: RunControllerInput['verifyStep'] | null;
  /** 가짜 커밋 포트 덮기. null이면 포트 없음. */
  commit?: Partial<CommitPort> | null;
  readback?: Record<string, string>;
  preGate?: RunControllerInput['preGate'];
  recover?: RunControllerInput['recover'];
  beforeStep?: (s: Step, c: RunController) => void;
  handlers?: Partial<Handlers>;
}

function mk(steps: Step[], o: Opts = {}) {
  const db = openDatabase(path.join(dir, `${dbn++}.sqlite`), new Uint8Array(randomBytes(32)));
  opened.push(db);
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
  const scope = newScope({ inputs: {}, intentId: 'intent-1', profile: { signMethod: 'cert' } });
  for (const [k, v] of Object.entries(o.readback ?? {})) scope.readback.set(k, v);
  const env = stepEnv({ page, act, clock, dict: DICT, strings: { 'confirm.issue': '^발급하시겠습니까\\?$' }, scope, domains: ['hometax.go.kr'], irreversible: new Set(['s21']), defaultTimeoutMs: 100, pollMs: 50 });
  const timers = new ManualTimers();
  const st = { ledger: [] as LedgerState[], inDoubt: null as string | null, allowed: true, secret: 'done' as 'done' | 'ttl', lockOk: true, observed: false, loggedIn: [true] as boolean[] };
  const rec = {
    published: [] as GateRequest[], closed: [] as Array<[string, string]>, human: [] as Array<Record<string, unknown>>, humanClosed: [] as Array<[string, string]>,
    secret: [] as Array<Record<string, unknown>>, states: [] as RunStateEvent[], journal: [] as Array<[string, Record<string, unknown>]>, effects: [] as string[],
    guard: [] as string[], locks: [] as boolean[], navs: [] as string[], commit: [] as string[], verifies: [] as string[], judged: [] as string[],
    /** 클릭마다 그 순간 commitArmed였는가. */
    armedAtClick: [] as Array<[string, boolean]>,
  };
  const commit: CommitPort | undefined = o.commit === null ? undefined : {
    arm: (a) => (rec.commit.push(`arm ${a.stepId}`), { ok: true }),
    armGuard: async (a) => (rec.commit.push(`guard ${a.stepId}`), { ok: true }),
    disarmGuard: async () => void rec.commit.push('disarm'),
    ...o.commit,
  };
  const click = act.click.bind(act);
  act.click = async (t) => {
    rec.armedAtClick.push([t.key, c.commitArmed(t.key)]);
    return click(t);
  };
  const judge: RunControllerInput['verifyStep'] = o.verifyStep === null ? undefined : (o.verifyStep ?? (async () => ({ result: 'committed' as const })));
  const c: RunController = new RunController({
    runId: 'run-1', intentId: 'intent-1', packageDigest: 'd'.repeat(64), ir: ir(steps), handlers: { ...BASIC_HANDLERS, ...o.handlers } as Handlers, env, interp: POL, clock, timers, gates, tokens,
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
    verifyStep: judge ? async (v) => (rec.judged.push(v.id), judge(v)) : undefined,
    commit,
    preGate: o.preGate,
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
  return { c, rec, st, gates, tokens, triggers, timers, page, act, env, clock, names, gate, approve, deny, atGate, atHuman };
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
    assert.deepEqual(h.rec.commit, ['arm s21', 'guard s21', 'disarm'], 'R-G7: 원장 armed → 가드 무장 → (클릭) → verify가 구간을 나갈 때 해제');
    assert.deepEqual(h.rec.armedAtClick, [['f.issue', true]]);
    assert.equal(h.gates.state(h.gate().reqId), 'approved');
    assert.deepEqual(h.rec.closed, [[h.gate().reqId, 'approved']]);
    assert.deepEqual(h.rec.locks, [true, false], '승인 뒤에도 잠금 유지, verify가 커밋 구간을 나갈 때 푼다');
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
    assert.deepEqual(h.rec.commit, []);
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
    assert.deepEqual(h.rec.commit, []);

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
  // X에서 HandedOff: 원장 armed 뒤 커밋 가드 무장이 거부돼 누르지 않았다(not_committed identity_mismatch, 재개는 게이트 앞).
  const handedOffAtX = async (verify?: (x: string) => Promise<VerifyResult>) => {
    const h = mk(GATE_FLOW, { verify, commit: { armGuard: async () => ({ ok: false, code: 'commit_guard.arm_refused' }) } });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.deepEqual([r.state, r.resumeAt], ['HandedOff', 's1'], '누르지 않은 비가역의 재개는 게이트 앞 체크포인트');
    assert.deepEqual(h.rec.armedAtClick, [], '누르지 않았다');
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
    const h = mk([S0, S1, GATE, SUBMIT, SV, END]);
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

describe('verify 스텝(M2-3, D02 §4.4, D03 §5.3·§5.6)', () => {
  // 게이트 → submit(가짜, 토큰 소비 자리) → verify. not_committed는 게이트 앞 체크포인트로 돌아간다(V-03f).
  const V: Step = { id: 's22', type: 'verify', lookup: { playbook: 'hometax.invoice.lookup', match: { supplyAmount: '$readback.supplyAmount' }, window: 'issueDate', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60_000, lookups: 2 }, bind: { approvalNo: 'approvalNo' } }, on: { committed: 's23', not_committed: 's1', unknown: 'handoff' } };
  const MAIL: Step = { id: 's23', type: 'verify', lookup: { playbook: 'hometax.invoice.email_status', match: { approvalNo: '$vars.approvalNo' }, window: 'today', baseline: 'none', notCommittedPolicy: { minElapsedMs: 60_000, lookups: 2 } }, on: { committed: 's24', not_committed: 's25', unknown: 's25' } };
  const OK: Step = { id: 's24', type: 'end', status: 'success' };
  const ISSUES: Step = { id: 's25', type: 'end', status: 'completed_with_issues' };
  const FLOW = [CP, GATE, { ...SUBMIT, verify: 's22' } as Step, V, MAIL, OK, ISSUES];
  const judge = (...rs: VerifyResult[]) => async () => ({ result: rs.length > 1 ? rs.shift()! : rs[0]! });
  const mkv = (o: Opts) => mk(FLOW, o);

  it('커밋 구간의 committed → 원장 committed{verify_ref}·후속 토큰·입력 잠금 해제 → 사후 스텝(구간 밖 verify는 on[결과]만)', async () => {
    const h = mkv({ verifyStep: judge('committed', 'committed') });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.equal(r.state, 'Completed');
    assert.deepEqual(h.rec.judged, ['s22', 's23']);
    const led = h.rec.effects.filter((e) => e.startsWith('ledger.'));
    assert.deepEqual(led, ['ledger.dispatched', 'ledger.committed{verify_ref}'], '원장 결과 기록은 커밋 구간 verify 한 번만(s23은 구간 밖)');
    assert.ok(h.rec.effects.includes('token.issue_followup'));
    assert.deepEqual(h.rec.locks, [true, false], 'verify가 구간을 나갈 때 입력 잠금 해제');
    assert.deepEqual(h.rec.journal.filter(([t]) => t === 'verify.result').map(([, p]) => [p.stepId, p.result]), [['s22', 'committed'], ['s23', 'committed']]);
  });

  it('구간 밖 verify(s23 메일 확인)의 unknown은 그 on으로만 간다: 완료(문제 있음), InDoubt 아님', async () => {
    const h = mkv({ verifyStep: judge('committed', 'unknown') });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    assert.equal((await p).state, 'CompletedWithIssues');
    assert.deepEqual(h.rec.effects.filter((e) => e.startsWith('ledger.')), ['ledger.dispatched', 'ledger.committed{verify_ref}']);
  });

  it('커밋 구간의 not_committed → 원장 not_committed{verify}·잠금 해제 → 게이트 앞 체크포인트(재게이트, 새 요청)', async () => {
    const h = mkv({ verifyStep: judge('not_committed') });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    await h.atGate(2);
    assert.ok(h.rec.effects.includes('ledger.not_committed{verify}'));
    assert.notEqual(h.rec.published[0]!.reqId, h.rec.published[1]!.reqId);
    h.c.abort();
    assert.equal((await p).state, 'Aborted');
  });

  it('커밋 구간의 unknown → InDoubt(원장 in_doubt, 토큰 폐기). on.unknown(handoff)으로 가지 않는다', async () => {
    const h = mkv({ verifyStep: judge('unknown') });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.deepEqual([r.state, r.code], ['InDoubt', 'verify.unknown']);
    assert.ok(h.rec.effects.includes('ledger.in_doubt'));
    assert.ok(!h.names().includes('HandedOff'));
    assert.deepEqual(h.rec.judged, ['s22']);
  });

  it('판정이 예외면 unknown(InDoubt)', async () => {
    const h = mkv({ verifyStep: async () => Promise.reject(new Error('lookup tab crashed')) });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    assert.equal((await p).state, 'InDoubt');
  });

  it('커밋 구간 중 중지는 verify 결과를 원장에 쓴 뒤 적용한다(committed → Aborted, 사후 스텝 없음)', async () => {
    const h = mkv({
      verifyStep: async () => {
        h.c.abort();
        return { result: 'committed' };
      },
    });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    assert.equal((await p).state, 'Aborted');
    assert.ok(h.rec.effects.includes('ledger.committed{verify_ref}'));
    assert.deepEqual(h.rec.judged, ['s22'], '사후 verify(s23)는 돌지 않는다');
  });

  it('기준선 조회 실패(preGate verify.baseline_missing) → 게이트를 열지 않고 핸드오프(재시도 없음)', async () => {
    let calls = 0;
    const h = mkv({ verifyStep: judge('committed'), preGate: async () => (calls++, { ok: false, code: 'verify.baseline_missing' }) });
    const r = await h.c.start();
    assert.deepEqual([r.state, r.code, r.resumeAt], ['HandedOff', 'verify.baseline_missing', 's20']);
    assert.equal(calls, 1);
    assert.equal(h.rec.published.length, 0, '게이트 요청 없음');
    assert.deepEqual(h.rec.judged, []);
  });

  it('verifyStep이 없으면 verify 스텝은 실행하지 않는다(engine.unhandled_step)', async () => {
    const h = mk([V, OK], { verifyStep: null });
    const r = await h.c.start();
    assert.deepEqual([r.state, r.code], ['Failed', 'engine.unhandled_step']);
  });
});

describe('submit(M2-3, D03 §3 R-G7·§5.3, D02 §4·§4.5): 게이트 토큰·원장·커밋 가드를 지나야만 누른다', () => {
  const clicks = (h: ReturnType<typeof mk>) => h.act.log.filter((l) => l.startsWith('click'));
  const RB1 = { supplyAmount: '1000' };

  it('R-G7 순서: 토큰 소비 → 원장 armed → 커밋 구간 → readback 재계산 → 가드 무장 → 그 항목만 무장된 채 클릭 → dispatched → verify', async () => {
    const h = mk(GATE_FLOW, { readback: RB1 });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    assert.equal((await p).state, 'Completed');
    assert.deepEqual(h.rec.commit, ['arm s21', 'guard s21', 'disarm']);
    assert.deepEqual(h.rec.armedAtClick, [['f.issue', true]], '클릭 순간 그 항목만 무장');
    assert.equal(h.c.commitArmed('f.issue'), false, '구간을 나가면 무장 해제');
    assert.equal(h.c.tokenFor('s20'), null, '토큰은 한 번 쓰고 없다');
    const order = h.rec.journal.map(([t]) => t).filter((t) => ['gate.approved', 'ledger.armed', 'verify.result'].includes(t));
    assert.deepEqual(order, ['gate.approved', 'ledger.armed', 'verify.result']);
    const eff = h.rec.effects.filter((e) => e.startsWith('ledger.'));
    assert.deepEqual(eff, ['ledger.dispatched', 'ledger.committed{verify_ref}']);
    assert.ok(!h.rec.effects.some((e) => ['ledger.arm+token.consume', 'commit_guard.arm', 'click'].includes(e)), '진입 효과는 조율기가 직접 한다(포트로 두 번 하지 않는다)');
    assert.ok(!JSON.stringify(h.rec.journal).includes('1000'), '값 없음(⑦)');
  });

  it('음성: 커밋 포트가 없으면 누르지 않는다(step.irreversible_unguarded, 재시도·핸드오프 없이 Failed)', async () => {
    const h = mk(GATE_FLOW, { commit: null });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.deepEqual([r.state, r.code], ['Failed', 'step.irreversible_unguarded']);
    assert.deepEqual(clicks(h), []);
  });

  it('음성: 승인 게이트를 지나지 않은 submit(토큰 없음)은 누르지 않는다. 원장도 쓰지 않는다', async () => {
    const h = mk([CP, SUBMIT, SV, END]);
    const r = await h.c.start();
    assert.deepEqual([r.state, r.code], ['Failed', 'step.irreversible_unguarded']);
    assert.deepEqual(h.rec.commit, []);
    assert.deepEqual(clicks(h), []);
  });

  it('음성: 토큰이 만료됐으면(commitWindow·Wmax 초과) 누르지 않는다(gate.token_invalid). 원장 armed 없음', async () => {
    const h: ReturnType<typeof mk> = mk(GATE_FLOW, { beforeStep: (s) => void (s.id === 's21' && (h.clock.t += 100_000)) });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.deepEqual([r.state, r.code], ['Failed', 'gate.token_invalid']);
    assert.deepEqual(h.rec.commit, []);
    assert.deepEqual(clicks(h), []);
    assert.ok(h.rec.journal.some(([t, p]) => t === 'gate.token_rejected' && p.reason === 'expired'));
  });

  it('음성: 토큰을 폐기하는 전이(사람 차례)를 지나면 그 토큰으로 누를 수 없다', async () => {
    const OTP_AFTER: Step = { ...OTP, id: 's20b' } as Step;
    const h = mk([CP, GATE, OTP_AFTER, SUBMIT, SV, END]);
    const p = h.c.start();
    await h.atGate();
    h.approve();
    await h.atHuman();
    h.c.answerHuman('s20b', { reqId: h.rec.human[0]!.reqId as string, value: '123456' });
    const r = await p;
    assert.deepEqual([r.state, r.code], ['Failed', 'step.irreversible_unguarded']);
    assert.ok(h.triggers.includes('WaitingHuman'));
    assert.deepEqual(h.rec.commit, []);
    assert.deepEqual(clicks(h).filter((c) => c.includes('f.issue')), []);
  });

  it('음성: 원장 armed를 쓰지 못하면(이미 행 있음) 누르지 않는다(ledger.arm_failed). 가드도 무장하지 않는다', async () => {
    const h = mk(GATE_FLOW, { commit: { arm: () => ({ ok: false, code: 'ledger_armed' }) } });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.deepEqual([r.state, r.code], ['Failed', 'ledger.arm_failed']);
    assert.ok(!h.rec.commit.some((x) => x.startsWith('guard')));
    assert.deepEqual(clicks(h), []);
  });

  it('음성: 승인 뒤 화면 값이 바뀌면(readback 재계산 불일치) 누르지 않는다: not_committed(pre_dispatch_mismatch), 게이트 앞으로', async () => {
    const h: ReturnType<typeof mk> = mk(GATE_FLOW, {
      readback: RB1,
      beforeStep: (s) => {
        if (s.id === 's21') h.page.els.get('amount')!.value = h.page.els.get('amount')!.a11y = '2000';
      },
    });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    await h.atGate(2);
    assert.ok(h.rec.effects.includes('ledger.not_committed{pre_dispatch_mismatch}'));
    assert.deepEqual(clicks(h), []);
    assert.deepEqual(h.rec.commit, ['arm s21'], '가드 무장 전');
    h.c.abort();
    assert.equal((await p).state, 'Aborted');
  });

  it('음성: 가드 무장 거부·버튼 동일성 실패·누를 수 없는 버튼이면 누르지 않는다: not_committed(identity_mismatch), HandedOff(재개는 게이트 앞)', async () => {
    const guard = mk(GATE_FLOW, { commit: { armGuard: async () => ({ ok: false, code: 'commit_guard.arm_refused' }) } });
    const noBtn = mk(GATE_FLOW, { els: els().filter((e) => e.id !== 'issue') });
    const blocked = mk(GATE_FLOW);
    blocked.act.failWith = 'step.not_clickable';
    for (const h of [guard, noBtn, blocked]) {
      const p = h.c.start();
      await h.atGate();
      h.approve();
      const r = await p;
      assert.deepEqual([r.state, r.resumeAt], ['HandedOff', 's1']);
      assert.ok(h.rec.effects.includes('ledger.not_committed{identity_mismatch}'));
      assert.ok(!h.rec.effects.includes('ledger.dispatched'));
      assert.deepEqual(h.rec.guard, ['observing'], '핸드오프 중 가드는 관측(R-C2)');
    }
    assert.deepEqual(clicks(noBtn), []);
    assert.deepEqual(noBtn.rec.commit, ['arm s21', 'guard s21', 'disarm'], '무장했던 가드는 푼다');
  });

  it('누른 뒤의 실패(요청이 나갔을 수 있음)는 dispatched로 보고 곧바로 verify(§5.3)', async () => {
    const h = mk(GATE_FLOW, { verifyStep: async () => ({ result: 'unknown' }) });
    h.act.failWith = 'step.port_error';
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.equal(r.state, 'InDoubt');
    assert.ok(h.rec.effects.includes('ledger.dispatched'));
    assert.deepEqual(h.rec.judged, ['sv']);
  });

  it('음성: commits:true 항목은 submit 밖 click으로 누를 수 없다(게이트 앞 click 스텝)', async () => {
    const PRESS: Step = { id: 's2', type: 'click', target: 'f.issue' };
    const h = mk([CP, PRESS, END]);
    const r = await h.c.start();
    assert.deepEqual([r.state, r.code], ['Failed', 'step.irreversible_unguarded']);
    assert.deepEqual(clicks(h), []);
  });

  it('음성: human_commit·send_email은 아직 실행하지 않는다(step.irreversible_unguarded, 클릭·원장 없음)', async () => {
    const HC: Step = { id: 's21', type: 'human_commit', prompt: 'p.manual', intent: '$intent.id', verify: 'sv' };
    const SE: Step = { id: 's21', type: 'send_email', via: 'portal', to: '$inputs.email', followUpOf: 's19', verify: 'sv' };
    for (const x of [HC, SE]) {
      const h = mk([CP, GATE, x, SV, END]);
      const p = h.c.start();
      await h.atGate();
      h.approve();
      const r = await p;
      assert.deepEqual([r.state, r.code], ['Failed', 'step.irreversible_unguarded'], x.type);
      assert.deepEqual(h.rec.commit, []);
      assert.deepEqual(clicks(h), []);
    }
  });

  it('커밋 구간 중 중지는 클릭을 막지 않고 verify 뒤에 적용한다(D03 §5.3 abort는 verify 뒤)', async () => {
    const h: ReturnType<typeof mk> = mk(GATE_FLOW, { commit: { armGuard: async () => (h.c.abort(), { ok: true }) } });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    assert.equal((await p).state, 'Aborted');
    assert.deepEqual(h.rec.armedAtClick, [['f.issue', true]]);
    assert.ok(h.rec.effects.includes('ledger.committed{verify_ref}'));
  });

  it('expectConfirm: 무장된 클릭 동안만 그 패턴을 돌려준다(V-24 대화상자 수락)', async () => {
    const seen: Array<string | null> = [];
    const h = mk([CP, GATE, { ...SUBMIT, expectConfirm: 'confirm.issue' } as Step, SV, END]);
    const click = h.act.click.bind(h.act);
    h.act.click = async (t) => (seen.push(h.c.armedConfirm()?.source ?? null), click(t));
    assert.equal(h.c.armedConfirm(), null);
    const p = h.c.start();
    await h.atGate();
    h.approve();
    await p;
    assert.deepEqual(seen, ['^발급하시겠습니까\\?$']);
    assert.equal(h.c.armedConfirm(), null);
  });

  describe('signFlow(D02 §4.5): 클릭 뒤 무장된 구간 안에서만, 실패·maxWaitMs 초과는 곧바로 verify', () => {
    const SF = (method: string, o: Record<string, unknown> = {}): Step => ({ ...SUBMIT, signFlow: { method, steps: { cert: ['human:secret'], simple_auth: ['wait:push'], security_card: ['secret_fill:security_card'] }, confirmTarget: 'f.signOk', maxWaitMs: 120_000, ...o } }) as Step;
    const SIGN_OK: FEl = { id: 'signOk', role: 'button', name: '서명 확인', parent: 'root' };

    it('cert($profile.signMethod): 금고 비밀 창(상태 머신 사람 차례 아님) → 확인 버튼을 무장한 채 클릭 → verify', async () => {
      const h = mk([CP, GATE, SF('$profile.signMethod'), SV, END], { els: [...els(), SIGN_OK] });
      const p = h.c.start();
      await h.atGate();
      h.approve();
      assert.equal((await p).state, 'Completed');
      assert.equal(h.rec.secret.length, 1);
      assert.equal(h.rec.secret[0]!.stepId, 's21');
      assert.ok(!h.names().includes('WaitingHuman'), '구간 안 서명은 사람 차례 전이가 아니다');
      assert.deepEqual(h.rec.armedAtClick, [['f.issue', true], ['f.signOk', true]]);
    });

    it('비밀 창 TTL·확인 버튼 없음은 서명하지 않고 verify로(판정은 verify): 클릭은 발급 버튼 하나', async () => {
      const h = mk([CP, GATE, SF('cert'), SV, END], { verifyStep: async () => ({ result: 'unknown' }) });
      h.st.secret = 'ttl';
      const p = h.c.start();
      await h.atGate();
      h.approve();
      assert.equal((await p).state, 'InDoubt');
      assert.deepEqual(h.rec.armedAtClick, [['f.issue', true]]);
      assert.ok(h.rec.journal.some(([t, p]) => t === 'signflow.timeout' && p.action === 'human:secret'));

      const n = mk([CP, GATE, SF('cert'), SV, END]);
      const q = n.c.start();
      await n.atGate();
      n.approve();
      assert.equal((await q).state, 'Completed');
      assert.ok(n.rec.journal.some(([t]) => t === 'signflow.confirm_missing'));
    });

    it('simple_auth wait:push: 확인 버튼이 뜰 때까지(maxWaitMs 안) 기다렸다 누른다. 안 뜨면 verify로', async () => {
      const late = { ...SIGN_OK, appearAt: 5_000 };
      const h = mk([CP, GATE, SF('simple_auth'), SV, END], { els: [...els(), late] });
      const p = h.c.start();
      await h.atGate();
      h.approve();
      assert.equal((await p).state, 'Completed');
      assert.deepEqual(h.rec.armedAtClick, [['f.issue', true], ['f.signOk', true]]);
      assert.equal(h.rec.secret.length, 0);

      const never = mk([CP, GATE, SF('simple_auth', { maxWaitMs: 1_000 }), SV, END]);
      const q = never.c.start();
      await never.atGate();
      never.approve();
      await q;
      assert.ok(never.rec.journal.some(([t, p]) => t === 'signflow.timeout' && p.action === 'wait:push'));
      assert.deepEqual(never.rec.armedAtClick, [['f.issue', true]]);
    });

    it('security_card(secret_fill)는 아직 없다: 하지 않고 verify로. 모르는 방식도 verify로', async () => {
      const h = mk([CP, GATE, SF('security_card'), SV, END], { els: [...els(), SIGN_OK] });
      const p = h.c.start();
      await h.atGate();
      h.approve();
      await p;
      assert.ok(h.rec.journal.some(([t, p]) => t === 'signflow.unsupported' && p.action === 'secret_fill:security_card'));
      assert.deepEqual(h.rec.armedAtClick, [['f.issue', true]]);
      const u = mk([CP, GATE, SF('mystery'), SV, END], { els: [...els(), SIGN_OK] });
      const q = u.c.start();
      await u.atGate();
      u.approve();
      await q;
      assert.ok(u.rec.journal.some(([t]) => t === 'signflow.method_unknown'));
      assert.deepEqual(u.rec.armedAtClick, [['f.issue', true]], '모르는 방식이면 확인 버튼을 누르지 않는다');
    });
  });
});

describe('sign(M2-3, D02 §4): 로그인 등 커밋 구간 밖 포털 서명 흐름. 방식마다 then[]의 그 동작만', () => {
  const SIGN = (o: Record<string, unknown> = {}): Step => ({ id: 's4', type: 'sign', method: '$profile.signMethod', then: ['human:secret'], ...o }) as Step;
  const profile = (h: ReturnType<typeof mk>, m: string) => ((h.env.scope.profile as { signMethod?: string }).signMethod = m);

  it('cert($profile.signMethod): 금고 비밀 창 사람 차례(값은 엔진에 오지 않는다) → Running → 다음 스텝. TTL이면 Paused', async () => {
    const h = mk([CP, SIGN(), END]);
    assert.equal((await h.c.start()).state, 'Completed');
    assert.deepEqual(h.rec.secret, [{ runId: 'run-1', stepId: 's4', ttlMs: 120_000 }]);
    assert.ok(h.names().includes('WaitingHuman'), '커밋 구간 밖 서명은 사람 차례다');
    assert.deepEqual(h.act.log, [], '엔진은 칸을 채우지도 누르지도 않는다');
    assert.ok(h.rec.journal.some(([t, p]) => t === 'sign.started' && p.method === 'cert'));

    const k = mk([CP, SIGN(), END]);
    k.st.secret = 'ttl';
    const r = await k.c.start();
    assert.deepEqual([r.state, r.resumeAt], ['Paused', 's1']);
  });

  it('simple_auth: 엔진 입력 없음(then의 human:secret도 하지 않음). PUSH 승인 대기는 뒤따르는 wait 스텝', async () => {
    const h = mk([CP, SIGN(), END]);
    profile(h, 'simple_auth');
    assert.equal((await h.c.start()).state, 'Completed');
    assert.deepEqual(h.rec.secret, []);
    assert.ok(!h.names().includes('WaitingHuman'));
  });

  it('그 방식의 동작이 then[]에 없음(sign.no_path)·보안카드(아직 없음, sign.unsupported)·모르는 방식(sign.method_unknown) → 재시도 없이 핸드오프, 비밀 창 없음', async () => {
    for (const [m, then, code] of [['cert', [], 'sign.no_path'], ['security_card', ['secret_fill:security_card'], 'sign.unsupported'], ['security_card', ['human:secret'], 'sign.no_path'], ['otp_app', ['human:secret'], 'sign.method_unknown']] as const) {
      const h = mk([CP, SIGN({ then }), END]);
      profile(h, m);
      const r = await h.c.start();
      assert.deepEqual([r.state, r.code], ['HandedOff', code], `${m} ${then.join()}`);
      assert.deepEqual(h.rec.secret, []);
      assert.equal(h.rec.journal.filter(([t]) => t === 'step.retry').length, 0, '재시도 없음');
    }
  });

  it('비밀 창 동안 중지 → Aborted', async () => {
    const h = mk([CP, SIGN(), END]);
    h.st.secret = 'done';
    const orig = h.rec.secret.push.bind(h.rec.secret);
    h.rec.secret.push = (...a) => (h.c.abort(), orig(...a));
    assert.equal((await h.c.start()).state, 'Aborted');
  });

  it('음성: 커밋 구간 안에서는 거부한다. 승인한 토큰을 든 채(X 전)면 아무것도 하지 않고 중단, 입력 잠금 해제', async () => {
    const h = mk([CP, GATE, SIGN(), SUBMIT, SV, END], { readback: { supplyAmount: '1000' } });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.deepEqual([r.state, r.code], ['Failed', 'sign.refused_in_commit']);
    assert.deepEqual(h.rec.secret, [], '비밀 창 없음');
    assert.deepEqual(h.act.log, [], '클릭 없음');
    assert.deepEqual(h.rec.commit, [], '원장·가드 없음');
    assert.equal(h.rec.locks.at(-1), false, '입력 잠금 해제');
    assert.ok(h.rec.journal.some(([t, p]) => t === 'sign.refused_in_commit' && p.consumed === false));
  });

  it('음성: 커밋 구간 안에서는 거부한다. 토큰을 쓴 뒤(누른 뒤)면 아무것도 하지 않고 InDoubt(원장 in_doubt, 사람 확인), 가드 해제', async () => {
    // 정적 검증(V-03c)을 지나친 IR: X의 verify 자리에 sign
    const h = mk([CP, GATE, { ...SUBMIT, verify: 's4' } as Step, SIGN(), SV, END], { readback: { supplyAmount: '1000' } });
    const p = h.c.start();
    await h.atGate();
    h.approve();
    const r = await p;
    assert.equal(r.state, 'InDoubt');
    assert.deepEqual(h.rec.secret, [], '비밀 창 없음');
    assert.deepEqual(h.rec.armedAtClick, [['f.issue', true]], '클릭은 발급 버튼 하나');
    assert.deepEqual(h.rec.commit, ['arm s21', 'guard s21', 'disarm']);
    assert.ok(h.rec.effects.includes('ledger.in_doubt'));
    assert.ok(h.rec.journal.some(([t, p]) => t === 'sign.refused_in_commit' && p.consumed === true));
  });

  it('넘겨받은 handlers.sign으로 덮을 수 없다(커밋 구간을 아는 조율기 것)', async () => {
    let called = 0;
    const h = mk([CP, SIGN(), END], { handlers: { sign: async () => (called++, { t: 'next' }) } });
    assert.equal((await h.c.start()).state, 'Completed');
    assert.equal(called, 0);
    assert.equal(h.rec.secret.length, 1);
  });
});
