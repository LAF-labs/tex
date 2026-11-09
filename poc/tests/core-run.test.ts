// M1-4 실행 코어: 게이트 토큰(D03 §3, R-G2·R-G7·R-G8, B-10·B-12), 원장·gate_requests 연결(PK (intent_id, step_id)), 재시작 승격(D-45),
// 체크포인트 복귀(§5.5), 상태 전이표·정지 분기·Running 진입 확인(§2, ADR-023 결정 5·6).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { GateRepo, Ledger, openDatabase, RunRepo, type ArmRow, type Db, type LedgerState } from '@sax/db';
import {
  armForCommit, buildCfg, decideGate, GateTokens, initialState, recoverAfterRestart, reenterCheckpoint, semanticViolations, state, stopBranch, transition, wmaxMs,
  type MachineCtx, type RunEvent, type RunState, type StepOf,
} from '@sax/engine/core';
import { bundleOutcomes, h01, lookups } from './core-fixtures.ts';

const NOW = Date.parse('2026-11-05T12:00:00+09:00');
const AH = 'a'.repeat(64);
const want = { gateStepId: 's20', actionHash: AH, stepId: 's21' };

describe('GateTokens (D03 §3)', () => {
  const issue = (t: GateTokens, o: Partial<Parameters<GateTokens['issue']>[0]> = {}) =>
    t.issue({ gateStepId: 's20', actionHash: AH, stepId: 's21', approvedAt: NOW, commitWindowMs: 600_000, wmaxMs: 90_000, ...o });
  it('exp = 승인시각 + min(commitWindowMs, Wmax)', () => {
    const t = new GateTokens('run-1');
    assert.equal(issue(t).exp, NOW + 90_000);
    assert.equal(issue(t, { commitWindowMs: 30_000 }).exp, NOW + 30_000);
  });
  it('단일 사용: 두 번째 소비는 consumed(보안 이벤트)', () => {
    const t = new GateTokens('run-1');
    const k = issue(t);
    assert.equal(t.consume(k, want, NOW + 1), null);
    assert.equal(t.consume(k, want, NOW + 2), 'consumed');
  });
  it('다른 실행의 토큰은 other_run, 값을 바꾼 토큰은 forged', () => {
    const a = new GateTokens('run-1');
    const b = new GateTokens('run-2');
    const k = issue(a);
    assert.equal(b.check(k, want, NOW), 'other_run');
    assert.equal(b.check({ ...k, runId: 'run-2' }, want, NOW), 'forged', '다른 runKey');
    assert.equal(a.check({ ...k, exp: k.exp + 60_000 }, want, NOW), 'forged', 'exp 연장');
    assert.equal(a.check({ ...k, actionHash: 'b'.repeat(64) }, { ...want, actionHash: 'b'.repeat(64) }, NOW), 'forged', 'actionHash 바꿔치기');
    assert.equal(a.check({ ...k, mac: 'zz' }, want, NOW), 'forged');
  });
  it('만료·다른 스텝·다른 승인 내용은 보안 이벤트가 아닌 거절', () => {
    const t = new GateTokens('run-1');
    const k = issue(t);
    assert.equal(t.check(k, want, k.exp), 'expired');
    assert.equal(t.check(k, { ...want, stepId: 's36' }, NOW), 'wrong_step');
    assert.equal(t.check(k, { ...want, actionHash: 'c'.repeat(64) }, NOW), 'action_mismatch');
  });
  it('R-G2: 폐기하면 미소비 토큰을 쓸 수 없다(discarded, 보안 이벤트 아님)', () => {
    const t = new GateTokens('run-1');
    const k = issue(t);
    assert.equal(t.discardAll('HandedOff'), 1);
    assert.equal(t.check(k, want, NOW), 'discarded');
    assert.equal(t.hasLive(), false);
  });
  it('후속 토큰은 주 토큰이 소비된 뒤에만, 별도 1회(B-10)', () => {
    const t = new GateTokens('run-1');
    const k = issue(t);
    assert.equal(t.issueFollowUp(k, 's36', NOW, 60_000), null, '주 토큰 미소비');
    t.consume(k, want, NOW);
    const f = t.issueFollowUp(k, 's36', NOW + 5, 60_000)!;
    assert.equal(t.check(f, { ...want, stepId: 's21' }, NOW + 6), 'wrong_step', '후속 토큰으로 주 비가역을 열 수 없다');
    assert.equal(t.consume(f, { ...want, stepId: 's36' }, NOW + 6), null);
    assert.equal(t.consume(f, { ...want, stepId: 's36' }, NOW + 7), 'consumed');
  });
});

describe('Wmax(X) (D03 §3)', () => {
  const analyse = (f: (p: ReturnType<typeof h01>) => void = () => {}) => {
    const p = h01();
    f(p);
    return semanticViolations(p, { bundles: bundleOutcomes(), lookups: lookups() }).analysis;
  };
  it('W(X) = {G, X}이면 60초 + signFlow.maxWaitMs', () => {
    const a = analyse();
    const x = a.cfg.info.get('s21')!.step as StepOf<'submit'>;
    assert.equal(wmaxMs(a, 's21', 10_000), 60_000 + (x.signFlow?.maxWaitMs ?? 0));
  });
  it('W 안의 wait·assert·extract timeoutMs를 더한다', () => {
    const a = analyse((p) => {
      const i = p.playbook.steps.findIndex((s) => s.id === 's20');
      p.playbook.steps.splice(i + 1, 0, { id: 's20a', type: 'wait', for: 'selector', value: 'hometax.invoice.form.issueButton', timeoutMs: 7000, onFail: { retry: 0, then: 'handoff' } } as never);
    });
    const x = a.cfg.info.get('s21')!.step as StepOf<'submit'>;
    assert.deepEqual([...a.windows.get('s21')!].filter((n) => !n.includes(':')).sort(), ['s20', 's20a', 's21'], '합성 노드(H:s20a)는 시간에 넣지 않는다');
    assert.equal(wmaxMs(a, 's21', 10_000), 60_000 + (x.signFlow?.maxWaitMs ?? 0) + 7000);
  });
  it('구간을 모르는 스텝이면 던진다', () => assert.throws(() => wmaxMs(analyse(), 's1', 1)));
});

describe('원장·gate_requests 연결 (R-G7·R-G8, B-33)', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-core-run-'));
  // 연 DB를 닫은 뒤 지운다(Windows는 열린 파일을 지우지 못해 EPERM).
  const opened: Db[] = [];
  after(() => {
    for (const d of opened) d.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let n = 0;
  const fresh = (): { db: Db; gates: GateRepo; ledger: Ledger; runs: RunRepo } => {
    const db = openDatabase(path.join(dir, `${n++}.sqlite`), new Uint8Array(randomBytes(32)));
    opened.push(db);
    const runs = new RunRepo(db);
    runs.create({ id: 'run-1', playbookId: 'hometax.invoice.issue', playbookVersion: '2.1.0', packageDigest: 'd'.repeat(64), profileId: 'p1', trigger: 'local', inputsHash: 'i'.repeat(64) });
    return { db, gates: new GateRepo(db), ledger: new Ledger(db), runs };
  };
  const row = (o: Partial<ArmRow> = {}): ArmRow => ({
    intentId: 'intent-1', stepId: 's21', runId: 'run-1', businessKey: 'bk', playbookId: 'hometax.invoice.issue', inputsHash: 'i'.repeat(64),
    packageDigest: 'd'.repeat(64), actionHash: AH, deviceId: 'dev', cpBizNoHmac: 'h', recipientEmailHmac: null, ...o,
  });
  const dec = (decision: 'approved' | 'denied', by = 'local') => ({ reqId: 'req-1', decision, by, gateStepId: 's20', actionHash: AH, stepId: 's21', approvedAt: NOW, commitWindowMs: 600_000, wmaxMs: 90_000 });

  it('먼저 도착한 결정만 이긴다: 승인 뒤 거부는 무시(토큰 1개)', () => {
    const { gates } = fresh();
    gates.open('req-1', 'run-1');
    const t = new GateTokens('run-1');
    const a = decideGate(gates, t, dec('approved'));
    assert.ok(a.won && a.decision === 'approved');
    assert.deepEqual(decideGate(gates, t, dec('denied', 'remote')), { won: false });
    assert.deepEqual(decideGate(gates, t, dec('approved', 'remote')), { won: false }, 'req_id당 토큰 최대 1개');
    assert.equal(gates.state('req-1'), 'approved');
  });
  it('거부가 먼저면 토큰이 없다', () => {
    const { gates } = fresh();
    gates.open('req-1', 'run-1');
    const t = new GateTokens('run-1');
    assert.deepEqual(decideGate(gates, t, dec('denied')), { won: true, decision: 'denied' });
    assert.equal(t.hasLive(), false);
  });
  it('R-G7: 토큰 검증 → armed + consumed 한 트랜잭션 → 토큰 소비', () => {
    const { gates, ledger } = fresh();
    gates.open('req-1', 'run-1');
    const t = new GateTokens('run-1');
    const d = decideGate(gates, t, dec('approved'));
    assert.ok(d.won && d.decision === 'approved');
    assert.deepEqual(armForCommit(ledger, t, { reqId: 'req-1', token: d.token, row: row(), gateStepId: 's20', now: NOW + 1 }), { ok: true });
    assert.equal(ledger.get('intent-1', 's21')?.state, 'armed');
    assert.equal(gates.state('req-1'), 'consumed');
    assert.deepEqual(armForCommit(ledger, t, { reqId: 'req-1', token: d.token, row: row(), gateStepId: 's20', now: NOW + 2 }), { ok: false, code: 'token.consumed', security: true });
  });
  it('토큰이 거절되면 원장에 아무것도 쓰지 않는다', () => {
    const { gates, ledger } = fresh();
    gates.open('req-1', 'run-1');
    const t = new GateTokens('run-1');
    const d = decideGate(gates, t, dec('approved'));
    assert.ok(d.won && d.decision === 'approved');
    assert.deepEqual(armForCommit(ledger, t, { reqId: 'req-1', token: d.token, row: row(), gateStepId: 's20', now: d.token.exp }), { ok: false, code: 'token.expired', security: false });
    assert.equal(ledger.get('intent-1', 's21'), null);
    assert.equal(gates.state('req-1'), 'approved');
    assert.equal(armForCommit(ledger, t, { reqId: 'req-1', token: d.token, row: row({ actionHash: 'c'.repeat(64) }), gateStepId: 's20', now: NOW }).ok, false);
  });
  it('같은 (intent_id, step_id) 행이 있으면 무장하지 않고 토큰도 소비하지 않는다(보안 이벤트 아님)', () => {
    const { gates, ledger, db } = fresh();
    db.prepare(`INSERT INTO irreversible_log (intent_id, step_id, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id) VALUES ('intent-1','s21','run-0','bk','hometax.invoice.issue','${'i'.repeat(64)}','${'d'.repeat(64)}','${AH}','not_committed','2026-11-01T00:00:00Z','dev')`).run();
    gates.open('req-1', 'run-1');
    const t = new GateTokens('run-1');
    const d = decideGate(gates, t, dec('approved'));
    assert.ok(d.won && d.decision === 'approved');
    assert.deepEqual(armForCommit(ledger, t, { reqId: 'req-1', token: d.token, row: row(), gateStepId: 's20', now: NOW }), { ok: false, code: 'ledger_not_committed', security: false });
    assert.equal(gates.state('req-1'), 'approved', '트랜잭션 롤백');
    assert.equal(t.check(d.token, want, NOW), null, '토큰은 그대로');
  });
  it('재시작 승격: armed·dispatched·observed_manual → in_doubt, open·approved 게이트 → expired, running → interrupted', () => {
    const { gates, ledger, runs, db } = fresh();
    gates.open('req-1', 'run-1');
    const t = new GateTokens('run-1');
    const d = decideGate(gates, t, dec('approved'));
    assert.ok(d.won && d.decision === 'approved');
    armForCommit(ledger, t, { reqId: 'req-1', token: d.token, row: row(), gateStepId: 's20', now: NOW });
    gates.open('req-2', 'run-1');
    db.prepare(`INSERT INTO irreversible_log (intent_id, step_id, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id) VALUES ('intent-2','s21','run-1','bk2','p','i','d','a','observed_manual','2026-11-01T00:00:00Z','dev')`).run();
    assert.deepEqual(recoverAfterRestart({ ledger, gates, runs }), { promotedInDoubt: 2, expiredGates: 1, interruptedRuns: 1 });
    assert.equal(ledger.get('intent-1', 's21')?.state, 'in_doubt');
    assert.equal(ledger.get('intent-2', 's21')?.state, 'in_doubt');
    assert.equal(gates.state('req-2'), 'expired');
    assert.equal(gates.state('req-1'), 'consumed', '소비된 게이트는 그대로');
    assert.equal(runs.status('run-1'), 'interrupted');
  });
});

describe('체크포인트 복귀 (D03 §5.5, R-G2)', () => {
  const cp = (o: Partial<StepOf<'checkpoint'>> = {}): StepOf<'checkpoint'> => ({ id: 's11', type: 'checkpoint', name: 'form', expect: { exists: 'x' }, url: 'https://hometax.go.kr/invoice/issue', sessionRequired: true, reentry: 'reload', ...o }) as StepOf<'checkpoint'>;
  const probe = (o: { expect?: boolean[]; loggedIn?: boolean } = {}) => {
    const log: string[] = [];
    const ex = [...(o.expect ?? [true])];
    return {
      log,
      p: {
        expect: async () => (log.push('expect'), ex.shift() ?? false),
        navigate: async (u: string) => void log.push(`navigate:${u}`),
        loggedIn: async () => (log.push('loggedIn'), o.loggedIn ?? true),
      },
    };
  };
  const tokens = () => {
    const t = new GateTokens('run-1');
    t.issue({ gateStepId: 's20', actionHash: AH, stepId: 's21', approvedAt: NOW, commitWindowMs: 1, wmaxMs: 1 });
    return t;
  };
  it('reload: 항상 url로 새로 로드한 뒤 expect, 복귀는 토큰을 폐기', async () => {
    const { log, p } = probe();
    const t = tokens();
    assert.equal(await reenterCheckpoint(cp(), p, t), 'resumed');
    assert.deepEqual(log, ['loggedIn', 'navigate:https://hometax.go.kr/invoice/issue', 'expect']);
    assert.equal(t.hasLive(), false);
  });
  it('reuse(기본): 현재 탭 expect가 참이면 이동하지 않고, 거짓이면 url로 이동 후 재평가', async () => {
    const a = probe({ expect: [true] });
    assert.equal(await reenterCheckpoint(cp({ reentry: undefined, sessionRequired: false }), a.p, tokens()), 'resumed');
    assert.deepEqual(a.log, ['expect']);
    const b = probe({ expect: [false, true] });
    assert.equal(await reenterCheckpoint(cp({ reentry: 'reuse', sessionRequired: false }), b.p, tokens()), 'resumed');
    assert.deepEqual(b.log, ['expect', 'navigate:https://hometax.go.kr/invoice/issue', 'expect']);
    const c = probe({ expect: [false, false] });
    assert.equal(await reenterCheckpoint(cp({ reentry: 'reuse', sessionRequired: false }), c.p, tokens()), 'handoff');
  });
  it('sessionRequired인데 로그아웃: session 체크포인트로 상향, session 자신이면 핸드오프', async () => {
    assert.equal(await reenterCheckpoint(cp(), probe({ loggedIn: false }).p, tokens()), 'escalate_session');
    assert.equal(await reenterCheckpoint(cp({ name: 'session' }), probe({ loggedIn: false }).p, tokens()), 'handoff');
  });
  it('reload인데 expect가 거짓이면 핸드오프', async () => assert.equal(await reenterCheckpoint(cp(), probe({ expect: [false] }).p, tokens()), 'handoff'));
});

// ---- 상태 전이표 ----

const OK: MachineCtx = { allowed: true, ledger: [] };
const run = (st: RunState, ...evs: Array<[RunEvent, MachineCtx?]>) => {
  let s = st;
  const effects: string[] = [];
  for (const [ev, ctx] of evs) {
    const r = transition(s, ev, ctx ?? OK);
    assert.ok(r.ok, `${s.name} --${ev.t}--> 불법 전이`);
    s = r.state;
    effects.push(...r.effects);
  }
  return { s, effects };
};
const running = () => state('Running');
const commit = () => state('Running', { commit: true });
const name = (r: ReturnType<typeof transition>) => (r.ok ? r.state.name : r.code);

describe('전이표 (D03 §2)', () => {
  it('Unloaded → Loaded → Preparing → Running(run.started)', () => {
    const r = run(initialState(), [{ t: 'load' }], [{ t: 'start', intentReuse: false }], [{ t: 'prepared' }]);
    assert.equal(r.s.name, 'Running');
    assert.ok(r.effects.includes('journal:run.started'));
  });
  it('의도 재사용(inputs_hash·playbook_id 다름)은 거부 + ledger.intent_reuse', () => {
    const r = transition(state('Loaded'), { t: 'start', intentReuse: true }, OK);
    assert.ok(r.ok && r.state.name === 'Failed' && r.effects.includes('security:ledger.intent_reuse'));
  });
  it('전제조건 실패 → Failed', () => assert.equal(name(transition(state('Preparing'), { t: 'precondition_failed' }, OK)), 'Failed'));
  it('게이트: 도달 시 입력 잠금·기준선, 승인 → 토큰 발급, 거부 → Aborted, 수정하기 → 게이트 앞, waitMs 초과 → Paused', () => {
    const g = run(running(), [{ t: 'gate_reached' }]);
    assert.equal(g.s.name, 'WaitingGate');
    for (const e of ['pre_safety_check', 'verify.baseline', 'dup.portal_existing', 'input.lock']) assert.ok(g.effects.includes(e), e);
    const a = transition(g.s, { t: 'gate_approved' }, OK);
    assert.ok(a.ok && a.state.name === 'Running' && a.effects.includes('token.issue'));
    assert.equal(name(transition(g.s, { t: 'gate_denied' }, OK)), 'Aborted');
    const e = transition(g.s, { t: 'gate_edit' }, OK);
    assert.ok(e.ok && e.state.name === 'Running' && e.effects.includes('rewind.pre_gate') && e.effects.includes('input.unlock') && e.effects.includes('tokens.discard'));
    const to = transition(g.s, { t: 'gate_timeout' }, OK);
    assert.ok(to.ok && to.state.name === 'Paused' && to.effects.includes('rewind.pre_gate'));
  });
  it('WaitingGate → Running은 승인(·수정하기)으로만: 다른 이벤트는 불법', () => {
    for (const ev of [{ t: 'prepared' }, { t: 'human_input' }, { t: 'recovered' }, { t: 'enter_commit' }, { t: 'verify', result: 'committed' }, { t: 'resume', samePackageDigest: true }] as RunEvent[])
      assert.equal(name(transition(state('WaitingGate'), ev, OK)), 'engine.illegal_transition', ev.t);
  });
  it('human 도달 → 토큰 폐기, 입력 → Running, TTL → Paused(체크포인트 되감기)', () => {
    const h = transition(running(), { t: 'human_reached' }, OK);
    assert.ok(h.ok && h.state.name === 'WaitingHuman' && h.effects.includes('tokens.discard'));
    assert.equal(name(transition(state('WaitingHuman'), { t: 'human_input' }, OK)), 'Running');
    const t = transition(state('WaitingHuman'), { t: 'human_ttl' }, OK);
    assert.ok(t.ok && t.state.name === 'Paused' && t.effects.includes('rewind.checkpoint'));
  });
  it('스텝 실패 → Recovering(토큰 폐기) → 성공이면 실패한 스텝 재실행, 실패면 onFail대로', () => {
    const r = transition(running(), { t: 'step_failed' }, OK);
    assert.ok(r.ok && r.state.name === 'Recovering' && r.effects.includes('tokens.discard'));
    const ok = transition(state('Recovering'), { t: 'recovered' }, OK);
    assert.ok(ok.ok && ok.state.name === 'Running' && ok.effects.includes('step.rerun_failed'));
    assert.equal(name(transition(state('Recovering'), { t: 'recovery_failed', then: 'handoff' }, OK)), 'HandedOff');
    assert.equal(name(transition(state('Recovering'), { t: 'recovery_failed', then: 'fail' }, OK)), 'Failed');
  });
  it('HandedOff: 관측(R-C2) → 원장 observed_manual, "직접 발급함" → verify, 재개 시 in_doubt면 verify 먼저, 30분 → Paused', () => {
    const o = transition(state('HandedOff'), { t: 'observed_commit' }, OK);
    assert.ok(o.ok && o.state.name === 'HandedOff' && o.effects.includes('ledger.observed_manual'));
    const a = transition(state('HandedOff'), { t: 'attest_manual_commit' }, OK);
    assert.ok(a.ok && a.state.reverify && a.effects.includes('verify.run'));
    const r1 = transition(state('HandedOff'), { t: 'handoff_resume', ledgerInDoubt: true }, OK);
    assert.ok(r1.ok && r1.state.reverify && r1.effects.includes('verify.run'));
    const r2 = transition(state('HandedOff'), { t: 'handoff_resume', ledgerInDoubt: false }, OK);
    assert.ok(r2.ok && !r2.state.reverify && r2.effects.includes('resume_at'));
    const p = transition(state('HandedOff'), { t: 'handoff_timeout' }, OK);
    assert.ok(p.ok && p.state.name === 'Paused' && p.effects.includes('slot.release'));
  });
  it('verify 먼저(재개): committed → 사후 스텝, not_committed → 게이트 앞, unknown → InDoubt', () => {
    const rv = state('Running', { reverify: true });
    const c = transition(rv, { t: 'verify', result: 'committed' }, { allowed: true, ledger: ['committed'] });
    assert.ok(c.ok && c.state.name === 'Running' && c.effects.includes('goto.post_steps'));
    const nc = transition(rv, { t: 'verify', result: 'not_committed' }, OK);
    assert.ok(nc.ok && nc.effects.includes('rewind.pre_gate'));
    assert.equal(name(transition(rv, { t: 'verify', result: 'unknown' }, OK)), 'InDoubt');
    assert.equal(name(transition(rv, { t: 'gate_reached' }, OK)), 'engine.illegal_transition');
  });
  it('R-G7 커밋 진입 순서', () => {
    const r = transition(running(), { t: 'enter_commit' }, OK);
    assert.ok(r.ok && r.state.commit);
    assert.deepEqual(r.effects, ['token.verify', 'ledger.arm+token.consume', 'readback.recompute', 'commit_guard.arm', 'click']);
  });
  it('커밋 구간: readback 불일치 → 게이트 앞(not_committed pre_dispatch_mismatch), 동일성 불일치 → HandedOff(identity_mismatch)', () => {
    const a = transition(commit(), { t: 'pre_dispatch_mismatch' }, OK);
    assert.ok(a.ok && a.state.name === 'Running' && !a.state.commit && a.effects.includes('ledger.not_committed{pre_dispatch_mismatch}') && a.effects.includes('rewind.pre_gate'));
    const b = transition(commit(), { t: 'identity_mismatch' }, OK);
    assert.ok(b.ok && b.state.name === 'HandedOff' && b.effects.includes('ledger.not_committed{identity_mismatch}'));
  });
  it('커밋 구간: 클릭 반환 → dispatched, verify committed → 후속 토큰, not_committed → 게이트 앞, unknown·상한 → InDoubt', () => {
    const d = transition(commit(), { t: 'click_returned' }, OK);
    assert.ok(d.ok && d.state.commit && d.effects.includes('ledger.dispatched'));
    const c = transition(commit(), { t: 'verify', result: 'committed' }, { allowed: true, ledger: ['committed'] });
    assert.ok(c.ok && c.state.name === 'Running' && !c.state.commit && c.effects.includes('token.issue_followup'));
    const nc = transition(commit(), { t: 'verify', result: 'not_committed' }, { allowed: true, ledger: ['not_committed'] });
    assert.ok(nc.ok && nc.effects.includes('rewind.pre_gate'));
    assert.equal(name(transition(commit(), { t: 'verify', result: 'unknown' }, OK)), 'InDoubt');
    assert.equal(name(transition(commit(), { t: 'verify_timeout' }, OK)), 'InDoubt');
  });
  it('커밋 구간 안에서는 사람·복구·게이트로 가지 않는다(실패는 곧바로 verify)', () => {
    const f = transition(commit(), { t: 'step_failed' }, OK);
    assert.ok(f.ok && f.state.commit && f.effects.includes('verify.run'));
    for (const ev of [{ t: 'human_reached' }, { t: 'gate_reached' }, { t: 'all_done' }, { t: 'enter_commit' }] as RunEvent[])
      assert.equal(name(transition(commit(), ev, OK)), 'engine.illegal_transition', ev.t);
  });
  it('완료: 모든 스텝 → Completed, 사후 실패·end completed_with_issues → CompletedWithIssues(재실행 금지 문구)', () => {
    assert.equal(name(transition(running(), { t: 'all_done' }, OK)), 'Completed');
    const r = transition(running(), { t: 'post_commit_failed' }, OK);
    assert.ok(r.ok && r.state.name === 'CompletedWithIssues' && r.effects.includes('ui.fixed:issued_do_not_rerun'));
    assert.equal(name(transition(running(), { t: 'end_with_issues' }, OK)), 'CompletedWithIssues');
  });
  it('사후 스텝 실패 일반화(D03 §2): committed가 있으면 복구 실패(핸드오프·실패 모두)는 CompletedWithIssues, 없으면 그대로', () => {
    const done: MachineCtx = { allowed: true, ledger: ['not_committed', 'committed'] };
    for (const then of ['handoff', 'fail'] as const) {
      const r = transition(state('Recovering'), { t: 'recovery_failed', then }, done);
      assert.ok(r.ok && r.state.name === 'CompletedWithIssues' && r.effects.includes('ui.fixed:issued_do_not_rerun') && r.effects.includes('input.unlock'), then);
      assert.equal(name(transition(state('Recovering'), { t: 'recovery_failed', then }, { allowed: true, ledger: ['not_committed'] })), then === 'handoff' ? 'HandedOff' : 'Failed');
    }
  });
  it('Paused·Interrupted 재개는 같은 package_digest일 때만(아니면 다시 시작만)', () => {
    assert.equal(name(transition(state('Paused'), { t: 'resume', samePackageDigest: true }, OK)), 'Running');
    assert.equal(name(transition(state('Paused'), { t: 'resume', samePackageDigest: false }, OK)), 'engine.restart_only');
    assert.equal(name(transition(state('Interrupted'), { t: 'resume', samePackageDigest: true }, OK)), 'Running');
  });
  it('종료 상태에서는 어떤 전이도 없다', () => {
    for (const n of ['Completed', 'CompletedWithIssues', 'Failed', 'Aborted'] as const) for (const ev of [{ t: 'resume', samePackageDigest: true }, { t: 'restart' }, { t: 'abort' }] as RunEvent[]) assert.equal(name(transition(state(n), ev, OK)), 'engine.illegal_transition');
  });
  it('abort: 커밋 구간 밖이면 Aborted, 안이면 verify 뒤 Aborted, 120초 초과면 InDoubt', () => {
    assert.equal(name(transition(state('WaitingGate'), { t: 'abort' }, OK)), 'Aborted');
    const r = run(commit(), [{ t: 'abort' }]);
    assert.ok(r.s.commit && r.s.pendingAbort);
    assert.equal(name(transition(r.s, { t: 'verify', result: 'committed' }, { allowed: true, ledger: ['committed'] })), 'Aborted');
    assert.equal(name(transition(r.s, { t: 'abort_timeout' }, OK)), 'InDoubt');
  });
  it('재시작: 미종결 원장 행이 있으면 InDoubt, 없으면 Interrupted, Paused는 그대로', () => {
    const a = transition(commit(), { t: 'restart' }, { allowed: true, ledger: ['dispatched'] });
    assert.ok(a.ok && a.state.name === 'InDoubt' && a.effects.includes('ledger.promote_in_doubt') && a.effects.includes('gates.expire_open'));
    assert.equal(name(transition(state('WaitingGate'), { t: 'restart' }, OK)), 'Interrupted');
    assert.equal(name(transition(state('Paused'), { t: 'restart' }, OK)), 'Paused');
  });
});

describe('정지 분기·Running 진입 확인 (ADR-023 결정 5·6)', () => {
  const DENY = (ledger: LedgerState[] = [], hardStop = false): MachineCtx => ({ allowed: false, ledger, hardStop });
  it('stopBranch: 미종결 → InDoubt, committed → CompletedWithIssues, 그 밖 → Paused(policy_downgrade)', () => {
    for (const s of ['armed', 'dispatched', 'observed_manual', 'in_doubt'] as const) assert.equal(stopBranch(['committed', s]).name, 'InDoubt', s);
    assert.equal(stopBranch(['not_committed', 'committed']).name, 'CompletedWithIssues');
    assert.equal(stopBranch(['not_committed']).name, 'Paused');
    assert.deepEqual(stopBranch([]).effects, ['journal:run.paused{policy_downgrade}']);
  });
  it('Running 진입 확인은 모든 Running 진입에 적용된다', () => {
    const cases: Array<[RunState, RunEvent]> = [
      [state('Preparing'), { t: 'prepared' }],
      [state('WaitingGate'), { t: 'gate_approved' }],
      [state('WaitingHuman'), { t: 'human_input' }],
      [state('Recovering'), { t: 'recovered' }],
      [state('HandedOff'), { t: 'handoff_resume', ledgerInDoubt: false }],
      [state('Paused'), { t: 'resume', samePackageDigest: true }],
      [state('InDoubt'), { t: 'indoubt_resolved', result: 'not_committed' }],
    ];
    for (const [s, ev] of cases) assert.equal(name(transition(s, ev, DENY(['not_committed']))), 'Paused', `${s.name} ${ev.t}`);
  });
  it('승인이 왔는데 진입 확인에 걸리면 토큰을 만들지 않고 게이트를 닫는다', () => {
    const r = transition(state('WaitingGate'), { t: 'gate_approved' }, DENY());
    assert.ok(r.ok && r.state.name === 'Paused');
    assert.ok(!r.effects.includes('token.issue') && r.effects.includes('gate.cancel') && r.effects.includes('input.unlock'));
  });
  it('InDoubt 해소: 결과를 먼저 기록하고, 앞선 committed가 있으면 not_committed여도 CompletedWithIssues', () => {
    const r = transition(state('InDoubt'), { t: 'indoubt_resolved', result: 'not_committed' }, DENY(['committed', 'not_committed']));
    assert.ok(r.ok && r.state.name === 'CompletedWithIssues');
    assert.equal(r.effects[0], 'ledger.not_committed');
    const ok = transition(state('InDoubt'), { t: 'indoubt_resolved', result: 'committed' }, { allowed: true, ledger: ['committed'] });
    assert.ok(ok.ok && ok.state.name === 'Running' && ok.effects.includes('goto.post_steps'));
  });
  it('Running·Recovering 하향: 토큰 폐기·체크포인트 저장 뒤 정지 분기, hardStop이면 Chrome을 닫는다', () => {
    const r = transition(running(), { t: 'downgrade' }, DENY([], true));
    assert.ok(r.ok && r.state.name === 'Paused');
    for (const e of ['tokens.discard', 'checkpoint.save', 'chrome.close']) assert.ok(r.effects.includes(e), e);
    assert.equal(name(transition(running(), { t: 'downgrade' }, DENY(['committed']))), 'CompletedWithIssues', '사후 스텝 중');
    assert.equal(name(transition(state('Recovering'), { t: 'downgrade' }, DENY())), 'Paused');
  });
  it('WaitingGate 하향: 게이트 만료·토큰 폐기·잠금 해제·게이트 앞으로 되감은 뒤 정지 분기', () => {
    const r = transition(state('WaitingGate'), { t: 'downgrade' }, DENY());
    assert.ok(r.ok && r.state.name === 'Paused');
    for (const e of ['gate.expire', 'tokens.discard', 'input.unlock', 'rewind.pre_gate']) assert.ok(r.effects.includes(e), e);
  });
  it('WaitingHuman·HandedOff 하향: 사람 차례가 끝날 때까지 그대로, 끝나면 정지 분기', () => {
    const h = run(state('WaitingHuman'), [{ t: 'downgrade' }, DENY()]);
    assert.equal(h.s.name, 'WaitingHuman');
    assert.equal(name(transition(h.s, { t: 'human_input' }, DENY())), 'Paused');
    const o = run(state('HandedOff'), [{ t: 'downgrade' }, DENY()]);
    assert.equal(o.s.name, 'HandedOff');
    assert.equal(name(transition(o.s, { t: 'handoff_timeout' }, DENY(['in_doubt']))), 'InDoubt');
    assert.equal(name(transition(o.s, { t: 'attest_manual_commit' }, DENY(['observed_manual']))), 'InDoubt');
  });
  it('커밋 구간 하향: 구간과 verify를 마치고 원장 기록 뒤 정지 분기(committed → CWI, unknown → InDoubt, not_committed → Paused)', () => {
    const r = run(commit(), [{ t: 'downgrade' }, DENY()]);
    assert.ok(r.s.commit && r.s.pendingDowngrade);
    assert.equal(name(transition(r.s, { t: 'verify', result: 'committed' }, DENY(['committed']))), 'CompletedWithIssues');
    assert.equal(name(transition(r.s, { t: 'verify', result: 'unknown' }, DENY(['in_doubt']))), 'InDoubt');
    assert.equal(name(transition(r.s, { t: 'verify', result: 'not_committed' }, DENY(['not_committed']))), 'Paused');
    assert.equal(name(transition(r.s, { t: 'verify', result: 'not_committed' }, DENY(['committed', 'not_committed']))), 'CompletedWithIssues', '앞선 커밋');
  });
  it('쉬는 상태(Paused·InDoubt·Interrupted)의 하향은 상태를 바꾸지 않는다', () => {
    for (const n of ['Paused', 'InDoubt', 'Interrupted', 'Loaded'] as const) assert.equal(name(transition(state(n), { t: 'downgrade' }, DENY())), n);
  });
});

describe('골든 H-01 경로를 전이표로 끝까지', () => {
  it('준비 → 게이트 → 승인 → 커밋 → verify committed → 완료', () => {
    const cfg = buildCfg(h01().playbook);
    assert.ok(cfg.info.has('s20') && cfg.info.has('s21'));
    const r = run(
      initialState(),
      [{ t: 'load' }], [{ t: 'start', intentReuse: false }], [{ t: 'prepared' }], [{ t: 'gate_reached' }], [{ t: 'gate_approved' }],
      [{ t: 'enter_commit' }], [{ t: 'click_returned' }], [{ t: 'verify', result: 'committed' }, { allowed: true, ledger: ['committed'] }], [{ t: 'all_done' }],
    );
    assert.equal(r.s.name, 'Completed');
    assert.ok(r.effects.indexOf('token.issue') < r.effects.indexOf('ledger.arm+token.consume'));
    assert.ok(r.effects.indexOf('ledger.dispatched') < r.effects.indexOf('ledger.committed{verify_ref}'));
  });
});

describe('Bugbot #59 회귀', () => {
  const DENY: MachineCtx = { allowed: false, ledger: ['not_committed'] };
  it('진입 확인에 걸리면 성공 효과(run.started·step.rerun_failed·resume_at)를 내지 않는다', () => {
    const cases: Array<[RunState, RunEvent, string]> = [
      [state('Preparing'), { t: 'prepared' }, 'journal:run.started'],
      [state('Recovering'), { t: 'recovered' }, 'step.rerun_failed'],
      [state('HandedOff'), { t: 'handoff_resume', ledgerInDoubt: false }, 'resume_at'],
    ];
    for (const [s, ev, bad] of cases) {
      const r = transition(s, ev, DENY);
      assert.ok(r.ok && r.state.name === 'Paused', ev.t);
      assert.ok(!r.effects.includes(bad), `${ev.t}: ${bad}`);
    }
    const e = transition(state('WaitingGate'), { t: 'gate_edit' }, DENY);
    assert.ok(e.ok && e.effects.includes('gate.cancel') && e.effects.includes('input.unlock'), '수정하기 거부여도 게이트는 닫는다');
  });
  it('WaitingGate에서 중지하면 gate_requests도 닫는다(gate.cancel)', () => {
    const r = transition(state('WaitingGate'), { t: 'abort' }, OK);
    assert.ok(r.ok && r.state.name === 'Aborted' && r.effects.includes('gate.cancel'));
    const h = transition(state('WaitingHuman'), { t: 'abort' }, OK);
    assert.ok(h.ok && !h.effects.includes('gate.cancel'));
  });
  it('커밋 구간에서 미룬 중지·하향이 있으면 verify committed 뒤 후속 토큰을 만들지 않는다', () => {
    const ab = run(commit(), [{ t: 'abort' }], [{ t: 'verify', result: 'committed' }]);
    assert.equal(ab.s.name, 'Aborted');
    assert.ok(!ab.effects.includes('token.issue_followup') && ab.effects.includes('ledger.committed{verify_ref}') && ab.effects.includes('tokens.discard'));
    const dg = run(commit(), [{ t: 'downgrade' }], [{ t: 'verify', result: 'committed' }, { allowed: false, ledger: ['committed'] }]);
    assert.equal(dg.s.name, 'CompletedWithIssues');
    assert.ok(!dg.effects.includes('token.issue_followup'));
  });
  it('미룬 정지 하향(hardStop) 뒤 verify unknown·시간 초과로 InDoubt가 돼도 Chrome을 닫는다', () => {
    const hard: MachineCtx = { allowed: false, ledger: ['in_doubt'], hardStop: true };
    for (const ev of [{ t: 'verify', result: 'unknown' }, { t: 'verify_timeout' }] as RunEvent[]) {
      const r = run(commit(), [{ t: 'downgrade' }, hard], [ev, hard]);
      assert.equal(r.s.name, 'InDoubt', ev.t);
      assert.ok(r.effects.includes('chrome.close') && r.effects.includes('ui.notify:downgrade'), ev.t);
    }
    const rv = run(state('Running', { reverify: true }), [{ t: 'downgrade' }, hard], [{ t: 'verify', result: 'unknown' }, hard]);
    assert.ok(rv.s.name === 'InDoubt' && rv.effects.includes('chrome.close'));
    const soft = run(commit(), [{ t: 'verify', result: 'unknown' }]);
    assert.ok(soft.s.name === 'InDoubt' && !soft.effects.includes('chrome.close'), '하향이 없으면 닫지 않는다');
  });
});

describe('Bugbot #59 회귀 2', () => {
  it('커밋 구간에서 미룬 하향으로 Paused가 되면 체크포인트를 저장한다', () => {
    for (const ev of [{ t: 'verify', result: 'not_committed' }, { t: 'pre_dispatch_mismatch' }] as RunEvent[]) {
      const r = run(commit(), [{ t: 'downgrade' }], [ev, { allowed: false, ledger: ['not_committed'] }]);
      assert.equal(r.s.name, 'Paused', ev.t);
      assert.ok(r.effects.includes('checkpoint.save'), ev.t);
    }
  });
  it('Running·Recovering 하향은 입력 잠금을 푼다(R-G6)', () => {
    for (const s of [state('Running'), state('Recovering')]) {
      const r = transition(s, { t: 'downgrade' }, { allowed: false, ledger: [] });
      assert.ok(r.ok && r.effects.includes('input.unlock'), s.name);
    }
  });
  it('HandedOff에서 정지·중지로 나가면 포털 슬롯을 놓는다', () => {
    const pend = state('HandedOff', { pendingDowngrade: true });
    const deny: MachineCtx = { allowed: false, ledger: ['not_committed'] };
    const exits: Array<[RunState, RunEvent, MachineCtx]> = [
      [pend, { t: 'handoff_resume', ledgerInDoubt: false }, deny],
      [pend, { t: 'attest_manual_commit' }, { allowed: false, ledger: ['in_doubt'] }],
      [state('HandedOff'), { t: 'handoff_resume', ledgerInDoubt: false }, deny],
      [state('HandedOff'), { t: 'handoff_resume', ledgerInDoubt: true }, { allowed: false, ledger: ['in_doubt'] }],
      [state('HandedOff'), { t: 'attest_manual_commit' }, { allowed: false, ledger: ['in_doubt'] }],
      [state('HandedOff'), { t: 'abort' }, OK],
    ];
    for (const [s, ev, c] of exits) {
      const r = transition(s, ev, c);
      assert.ok(r.ok && r.state.name !== 'Running' && r.effects.includes('slot.release'), `${ev.t} ${s.pendingDowngrade}`);
    }
    const resume = transition(state('HandedOff'), { t: 'handoff_resume', ledgerInDoubt: false }, OK);
    assert.ok(resume.ok && resume.state.name === 'Running' && !resume.effects.includes('slot.release'), '이어서 실행하면 슬롯 유지');
  });
});

describe('Bugbot #59 회귀 3', () => {
  it('Recovering에서 복구 실패로 HandedOff·Failed가 되면 입력 잠금을 푼다(R-G6)', () => {
    for (const then of ['handoff', 'fail'] as const) {
      const r = transition(state('Recovering'), { t: 'recovery_failed', then }, OK);
      assert.ok(r.ok && r.effects.includes('input.unlock'), then);
      assert.equal(r.ok && r.state.name, then === 'handoff' ? 'HandedOff' : 'Failed');
    }
  });
});
