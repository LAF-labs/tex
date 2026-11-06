// M2-4 B 운영 정책 집행기(D03 §5.2·§7·§7.1): 서명 정책 → RatePolicy, 차단 신호 사전, RunEnforcer(ActionPolicy·beforeStep).
// 카운터·쿨다운은 실제 SQLite(RateGuard), 시간은 가짜 시계. 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { openDatabase, type Db } from '@sax/db';
import { RateGuard, RunEnforcer, SIGNAL_DICT, ratePolicyFrom, signalDict, type RatePolicy, type SignalEntry } from '@sax/engine';
import { BASIC_HANDLERS, Interpreter, clampPolicy, newScope, stepEnv, type PlaybookIR, type Policy } from '@sax/engine/core';
import { POLICY_EXAMPLE } from './core-fixtures.ts';
import { FakeAct, FakeClock, FakePage } from './core-page-fakes.ts';

const POLICY = clampPolicy(structuredClone(POLICY_EXAMPLE) as unknown as Policy).policy;
const BASE = Date.parse('2026-11-06T01:00:00Z');
const DICT: readonly SignalEntry[] = [
  ...SIGNAL_DICT.fixture,
  { id: 't.block', kind: 'block', text: '이용이 제한되었습니다', source: '시험' },
  { id: 't.auth', kind: 'extra_auth', url: '/auth/extra$', source: '시험' },
  { id: 't.captcha', kind: 'captcha', url: '/captcha$', source: '시험' },
  { id: 't.busy', kind: 'busy', text: '접속대기 중입니다', source: '시험' },
];

describe('서명 정책 → RatePolicy·신호 사전', () => {
  it('포털·프로필 값을 그대로 옮기고, PoC 빌드의 홈택스만 PoC 상한으로 더 엄격하게', () => {
    const full = ratePolicyFrom(POLICY, 'hometax', 'interactive', false)!;
    assert.deepEqual(full.pace, { stepDelayMs: [800, 2500], afterNavSettleMs: [600, 1500], slowFactor: 1.5 });
    assert.deepEqual([full.limits.runsPerDayPerProfile, full.limits.irreversiblePerDayPerProfile, full.limits.loginsPerDay, full.cooldown.positiveDetectionsForCooldown], [40, 30, 6, 2]);
    assert.deepEqual(full.run, { maxActuationsPerRun: 150, maxWallClockMs: 1_800_000 });
    const poc = ratePolicyFrom(POLICY, 'hometax', 'interactive', true)!;
    assert.deepEqual([poc.limits.runsPerDayPerProfile, poc.limits.irreversiblePerDayPerProfile, poc.limits.loginsPerDay, poc.cooldown.positiveDetectionsForCooldown], [20, 1, 3, 1]);
    assert.equal(ratePolicyFrom(POLICY, 'gov24', 'interactive', true)!.limits.runsPerDayPerProfile, 20, 'PoC 덮기는 홈택스만');
    assert.deepEqual(ratePolicyFrom(POLICY, 'hometax', 'daemon', false)!.pace.stepDelayMs, [1200, 3500]);
    assert.ok(Object.isFrozen(full));
  });

  it('limits가 없는 포털은 null(자동화하지 않음, fail-closed)', () => {
    assert.equal(ratePolicyFrom(POLICY, 'iros', 'interactive'), null);
  });

  it('신호 사전 = 내장 ∪ blockSignalsAdd(block만 추가), RE2 밖 URL 패턴·빈 문구는 버리고 위치만 알린다', () => {
    const dropped: string[] = [];
    const d = signalDict(SIGNAL_DICT.hometax, { urlPatterns: ['/blocked$', '(a+)+$'], phrases: ['접근이 차단되었습니다', '  '] }, (w) => dropped.push(w));
    assert.equal(d.length, SIGNAL_DICT.hometax.length + 2);
    assert.deepEqual(d.slice(-2).map((e) => [e.id, e.kind]), [['policy.block.url.0', 'block'], ['policy.block.text.0', 'block']]);
    assert.deepEqual(dropped, ['urlPatterns[1]', 'phrases[1]']);
    assert.equal(signalDict(SIGNAL_DICT.hometax, undefined).length, SIGNAL_DICT.hometax.length);
  });
});

describe('RunEnforcer', () => {
  let root: string;
  let db: Db;
  let clock: FakeClock;
  let wallSkew: number;
  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-enf-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    db = openDatabase(path.join(root, `${randomBytes(4).toString('hex')}.sqlite`), new Uint8Array(randomBytes(32)));
    clock = new FakeClock();
    wallSkew = 0;
  });
  afterEach(() => db.close());

  const guardOf = (o: { poc?: boolean; patch?: (r: RatePolicy) => RatePolicy } = {}) => {
    const r = ratePolicyFrom(POLICY, 'hometax', 'interactive', o.poc ?? false)!;
    return new RateGuard(db, 'hometax', o.patch ? o.patch(structuredClone(r) as RatePolicy) : r, { wall: () => BASE + clock.t + wallSkew, mono: () => clock.t });
  };
  const make = (o: { guard?: RateGuard; stop?: () => boolean; poc?: boolean } = {}) => {
    const journal: Array<[string, Record<string, unknown>?]> = [];
    const latched: string[] = [];
    const guard = o.guard ?? guardOf({ poc: o.poc });
    const e = new RunEnforcer({ guard, clock, mono: () => clock.t, dict: DICT, profileId: 'p1', journal: (t, p) => journal.push([t, p]), stopRequested: o.stop, onLatch: (c) => latched.push(c), random: () => 0.5 });
    return { e, guard, journal, latched };
  };
  const code = (r: { ok: boolean; code?: string }) => (r.ok ? 'ok' : r.code);

  it('beforeStep: 스텝 지연은 범위 안(random 0.5 → 가운데), 시계 역행이면 보수 모드 slowFactor배', async () => {
    const { e, guard } = make();
    assert.equal(code(await e.beforeStep()), 'ok');
    assert.equal(clock.t, 1650);
    guard.clock(); // 마지막 본 시각을 남긴다
    wallSkew = -60_000; // 벽시계를 1분 되돌림
    const t0 = clock.t;
    await e.beforeStep();
    assert.equal(clock.t - t0, Math.round(1650 * 1.5));
    assert.ok(clock.sleeps.every((s) => s <= 100), '100ms씩 나눠 자며 걸쇠를 본다');
  });

  it('settled: 네비게이션 뒤 안정 대기', async () => {
    const { e } = make();
    await e.settled();
    assert.equal(clock.t, 1050);
  });

  it('실행당 동작 수 상한: 넘으면 policy.actuations_per_run, 커밋 뒤에는 끊지 않는다. 대화상자도 센다', async () => {
    const { e } = make({ guard: guardOf({ patch: (r) => ({ ...r, run: { ...r.run, maxActuationsPerRun: 3 } }) }) });
    assert.equal(code(await e.beforeAction('click')), 'ok');
    e.noteDialog();
    assert.equal(code(await e.beforeAction('fill')), 'ok');
    assert.equal(code(await e.beforeAction('click')), 'policy.actuations_per_run');
    assert.equal(code(e.markCommitted()), 'ok');
    assert.equal(code(await e.beforeAction('click')), 'ok', '커밋 뒤(verify)는 상한으로 끊지 않는다');
  });

  it('실행당 벽시계 상한: 단조 시각으로 재서 넘으면 policy.wall_clock', async () => {
    const { e } = make({ guard: guardOf({ patch: (r) => ({ ...r, run: { ...r.run, maxWallClockMs: 5_000 } }) }) });
    assert.equal(code(await e.beforeAction('click')), 'ok');
    clock.t += 6_000;
    assert.equal(code(await e.beforeAction('click')), 'policy.wall_clock');
  });

  it('분당 네비게이션: 상한에 닿으면 자리가 날 때까지 자고, 세는 것은 navigate만', async () => {
    const { e, guard } = make({ guard: guardOf({ patch: (r) => ({ ...r, limits: { ...r.limits, navigationsPerMin: 2 } }) }) });
    await e.beforeAction('navigate');
    await e.beforeAction('navigate');
    await e.beforeAction('click');
    assert.equal(clock.t, 0, '아직 자지 않았다');
    assert.equal(code(await e.beforeAction('navigate')), 'ok');
    assert.ok(clock.t >= 59_000, `60초 창이 지날 때까지 기다림: ${clock.t}`);
    assert.equal(guard.navigationWaitMs(), 0);
  });

  it('[중지]: 커밋 전에는 run.stopped(자는 중에도), 커밋 뒤에는 보지 않는다', async () => {
    let stop = false;
    const { e } = make({ stop: () => stop });
    stop = true;
    assert.equal(code(await e.beforeAction('click')), 'run.stopped');
    assert.equal(code(await e.beforeStep()), 'run.stopped');
    e.markCommitted();
    assert.equal(code(await e.beforeAction('click')), 'ok');
  });

  it('차단 신호(문구·URL): 걸쇠 → 그 뒤 모든 동작 거부. 양성 2회면 쿨다운(PoC 홈택스는 1회), 저널에는 id만', async () => {
    const guard = guardOf();
    const a = make({ guard });
    a.e.observe({ text: '비정상 접근으로 이용이 제한되었습니다. 고객센터…' });
    assert.equal(a.e.halted, 'portal.blocked');
    assert.equal(code(await a.e.beforeAction('click')), 'portal.blocked');
    assert.equal(code(await a.e.beforeStep()), 'portal.blocked');
    assert.deepEqual(a.latched, ['portal.blocked']);
    assert.deepEqual(a.journal, [['block.signal', { id: 't.block' }]]);
    const b = make({ guard });
    b.e.observe({ url: 'https://fixture.test/notice/blocked' });
    assert.equal(b.e.halted, 'policy.cooldown', '두 번째 양성 → 쿨다운');
    assert.equal(guard.status('p1').cooldownUntil !== null, true);
    const poc = make({ guard: guardOf({ poc: true }) });
    poc.e.observe({ text: '이용이 제한되었습니다' });
    assert.equal(poc.e.halted, 'policy.cooldown', 'PoC 홈택스: 양성 1회 쿨다운(ADR-025)');
  });

  it('추가 인증: 로그인 구간 밖에서 실행을 넘어 연속 2회면 차단(portal.extra_auth_repeat), 로그인 구간 안은 세지 않음', async () => {
    const guard = guardOf();
    const inLogin = make({ guard });
    inLogin.e.enterLogin();
    inLogin.e.observe({ url: 'https://x/auth/extra' });
    assert.equal(inLogin.e.halted, 'portal.mfa_pending');
    const first = make({ guard });
    first.e.observe({ url: 'https://x/auth/extra' });
    assert.equal(first.e.halted, 'portal.mfa_pending');
    const second = make({ guard });
    second.e.observe({ url: 'https://x/auth/extra' });
    assert.equal(second.e.halted, 'portal.extra_auth_repeat');
  });

  it('캡차·대기열은 핸드오프 코드, 차단은 먼저 걸린 다른 신호를 덮고 반대는 아니다', () => {
    const { e, latched } = make();
    e.observe({ url: 'https://x/captcha' });
    assert.equal(e.halted, 'portal.captcha');
    e.observe({ text: '접속대기 중입니다' });
    assert.equal(e.halted, 'portal.captcha', '덮지 않는다');
    e.observe({ text: '이용이 제한되었습니다' });
    assert.equal(e.halted, 'portal.blocked');
    assert.deepEqual(latched, ['portal.captcha', 'portal.blocked']);
    const b = make();
    b.e.observe({ text: '지금 접속대기 중입니다' });
    assert.equal(b.e.halted, 'portal.busy');
  });

  it('HTTP: 429·문서 403은 1회, 그 밖의 403은 60초 안 3회면 차단', () => {
    const a = make();
    a.e.observeStatus(429, false);
    assert.equal(a.e.halted, 'portal.blocked');
    const b = make();
    b.e.observeStatus(403, true);
    assert.deepEqual(b.journal[0], ['block.signal', { id: 'http.403_document' }]);
    const c = make();
    c.e.observeStatus(403, false);
    clock.t += 61_000;
    c.e.observeStatus(403, false);
    c.e.observeStatus(403, false);
    assert.equal(c.e.halted, null, '창 밖의 403은 빠진다');
    c.e.observeStatus(403, false);
    assert.notEqual(c.e.halted, null);
    assert.deepEqual(c.journal[0], ['block.signal', { id: 'http.403_burst' }], '같은 DB의 세 번째 양성이라 쿨다운까지 갔다');
  });

  it('끝: 기대 화면 도착이면 연속 초기화, 아니면 모르는 화면 연속(3회째 양성), 사용자 정지는 세지 않음', () => {
    const guard = guardOf();
    for (let i = 1; i <= 2; i++) {
      const r = make({ guard });
      r.e.finish();
      assert.deepEqual(r.journal, [['portal.unknown_screen', { streak: i }]]);
    }
    assert.equal(guard.status('p1').unknownScreenStreak, 2);
    assert.equal(guard.clock().conservative, true, '2회 연속이면 보수 모드');
    const stopped = make({ guard });
    stopped.e.finish({ userStopped: true });
    assert.equal(guard.status('p1').unknownScreenStreak, 2);
    const ok = make({ guard });
    ok.e.reached();
    ok.e.finish();
    ok.e.finish();
    assert.equal(guard.status('p1').unknownScreenStreak, 0);
  });

  it('markCommitted: 하루 비가역 상한(PoC 홈택스 1)을 넘으면 거부', () => {
    const guard = guardOf({ poc: true });
    assert.equal(code(make({ guard }).e.markCommitted()), 'ok');
    assert.equal(code(make({ guard }).e.markCommitted()), 'policy.irreversible_per_day');
  });

  it('실행기 연결: beforeStep 걸쇠는 스텝을 실행하지 않고 FORCED_STOPS대로(캡차 → 핸드오프, 차단 → 중단)', async () => {
    const page = new FakePage(clock, []);
    const act = new FakeAct(page);
    const env = stepEnv({ page, act, clock, dict: { portal: 'hometax', commitEndpoints: [], knownEndpoints: [], entries: {} }, strings: {}, scope: newScope(), domains: ['hometax.go.kr'], irreversible: new Set(), defaultTimeoutMs: 1000, pollMs: 100 });
    const ir = { ir: 2, id: 'test.pb', version: '1.0.0', portal: 'hometax', profileKinds: ['business'], effects: [], inputs: {}, postconditions: [], steps: [{ id: 's1', type: 'goto', url: 'https://hometax.go.kr/' }, { id: 's2', type: 'end', status: 'success' }] } as unknown as PlaybookIR;
    const run = (e: RunEnforcer) => new Interpreter(ir, BASIC_HANDLERS, env, { retries: POLICY.retries, retryFloorMs: 800, random: () => 0.5 }, { beforeStep: () => e.beforeStep() }).run();
    const cap = make();
    cap.e.observe({ url: 'https://x/captcha' });
    assert.deepEqual(await run(cap.e), { t: 'handoff', at: 's1', resumeAt: 's1', code: 'portal.captcha' });
    const blk = make();
    blk.e.observe({ text: '이용이 제한되었습니다' });
    assert.deepEqual(await run(blk.e), { t: 'abort', at: 's1', code: 'portal.blocked' });
    assert.deepEqual(act.log, [], '스텝을 실행하지 않았다');
    assert.deepEqual(await run(make().e), { t: 'end', at: 's2', status: 'success' });
  });
});
