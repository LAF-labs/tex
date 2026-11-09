// 감사 D(AUDIT-D) 패키지 E: 엔진·DB·net·모델 쪽 변경을 브라우저 없이 시험한다(가짜 페이지·임시 DB).
// 실 Chrome이 필요한 것(대화상자 문구 종료 이벤트·반영 지연 verify·작성일자 대조·누출 의심)은 h01-engine·h01-policy에 있다.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  BizVerifier, DataService, envProblems, failureMatches, FIXTURE_POLICY, fixturePortal, HOMETAX_POLICY, jcs, mailStatusVerdict, pathExpected, pocTotalRefusal, POC_IRREVERSIBLE_TOTAL, POC_OVERRIDES,
  policyFor, portalProblems, RateGuard, RunEnd, RunPolicy, RunService, sha256hex, SIGNAL_INSPECT_EXPR, type Clock, type PortalConfig, type RatePolicy, type RunEvent,
} from '@sax/engine';
import { GateRepo, Ledger, openDatabase, RateRepo, RunJournal, RunRepo, type Db } from '@sax/db';
import { Egress, EgressError } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import type { Page } from 'playwright-core';

const ORIGIN = 'http://127.0.0.1:9';
const PORTAL = fixturePortal(ORIGIN);

type Frame = { url: () => string; evaluate: (...a: unknown[]) => Promise<unknown> };
/** RunPolicy·SignalWatch가 쓰는 만큼만 흉내 낸 페이지. framenavigated·dialog를 직접 쏜다. */
function fakePage(frames: Frame[] = [], url = `${ORIGIN}/invoice/issue`) {
  return Object.assign(new EventEmitter(), { context: () => new EventEmitter(), isClosed: () => false, frames: () => frames, url: () => url });
}

describe('감사 D 패키지 E(브라우저 없음)', () => {
  let dir: string;
  const dbs: Db[] = [];
  before(async () => {
    dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-audit-e-'));
  });
  after(async () => {
    for (const d of dbs) d.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const freshDb = () => {
    const db = openDatabase(path.join(dir, `${dbs.length}.sqlite`), new Uint8Array(randomBytes(32)));
    dbs.push(db);
    return db;
  };
  /** 한 포털의 가드와 그 위의 실행 정책(가짜 페이지). 실행마다 policy()로 새로 만든다. */
  const setup = (kind: 'fixture' | 'hometax' = 'fixture', rate: RatePolicy = FIXTURE_POLICY) => {
    const db = freshDb();
    const g = new RateGuard(db, kind, rate);
    const repo = new RateRepo(db);
    const journal: Array<[string, Record<string, unknown> | undefined]> = [];
    const policy = (page = fakePage()) =>
      new RunPolicy(page as unknown as Page, g, PORTAL, { profileId: 'p1', checkStop: () => {}, journal: (t, p) => void journal.push([t, p]), onLatch: () => {} });
    return { db, g, repo, journal, policy, kind };
  };
  const streak = (s: ReturnType<typeof setup>, k: string) => s.repo.count(s.kind, '', k, '-');

  // ---- E1 · N-01 ----
  it('audit-e: policyFor(hometax) is tightened by POC_OVERRIDES and never loosened', () => {
    const p = policyFor('hometax');
    assert.deepEqual(p.limits, { ...HOMETAX_POLICY.limits, runsPerDayPerProfile: 20, irreversiblePerDayPerProfile: 1, loginsPerDay: 3 });
    assert.deepEqual(p.cooldown, { ...HOMETAX_POLICY.cooldown, positiveDetectionsForCooldown: 1 });
    assert.deepEqual([p.pace, p.run], [HOMETAX_POLICY.pace, HOMETAX_POLICY.run]);
    const all = { ...p.limits, ...p.cooldown } as Record<string, number>;
    const base = { ...HOMETAX_POLICY.limits, ...HOMETAX_POLICY.cooldown } as Record<string, number>;
    for (const [k, v] of Object.entries(POC_OVERRIDES)) assert.equal(all[k], Math.min(base[k]!, v), k);
    for (const k of Object.keys(base)) assert.ok(all[k]! <= base[k]!, `${k}: 느슨해지지 않는다`);
    assert.ok(Object.isFrozen(p.limits) && Object.isFrozen(p.cooldown));
    assert.equal(policyFor('fixture'), FIXTURE_POLICY, '가짜 페이지 정책은 그대로');
  });

  it('audit-e: fourth irreversible start is refused with policy.poc_irreversible_total', () => {
    const db = freshDb();
    const l = new Ledger(db);
    const g = new GateRepo(db);
    new RunRepo(db).create({ id: 'r', playbookId: 'p', playbookVersion: '1', packageDigest: 'd', profileId: 'x', trigger: 'local', inputsHash: 'i' });
    const arm = (n: number) => {
      g.open(`q${n}`, 'r');
      g.decide(`q${n}`, 'approved', 'local');
      l.consumeAndArm(`q${n}`, { intentId: `I${n}`, stepId: 's21', runId: 'r', businessKey: `bk${n}`, playbookId: 'p', inputsHash: 'i', packageDigest: 'd', actionHash: 'a', deviceId: 'dv', cpBizNoHmac: 'h', recipientEmailHmac: null });
    };
    arm(1);
    l.resolve('I1', 's21', 'not_committed', 'pre_dispatch_mismatch', null); // 발급 안 됨은 세지 않는다
    arm(2);
    l.resolve('I2', 's21', 'committed', null, 'APP-2');
    arm(3);
    l.resolve('I3', 's21', 'in_doubt');
    assert.equal(pocTotalRefusal(l, 'hometax'), null, '2건까지는 시작한다');
    arm(4); // armed 그대로(재시작 전 진행 중)
    assert.equal(l.countIrreversible(['committed', 'in_doubt', 'armed', 'dispatched']), POC_IRREVERSIBLE_TOTAL);
    const r = pocTotalRefusal(l, 'hometax');
    assert.ok(r instanceof RunEnd);
    assert.deepEqual([r.status, r.code], ['failed', 'policy.poc_irreversible_total']);
    assert.equal(pocTotalRefusal(l, 'fixture'), null, '가짜 페이지는 PoC 전체 상한 밖');
  });

  // ---- E2 · N-02 ----
  it('audit-e: failure signal without an anchored text pattern is rejected by portalProblems', () => {
    const css = '#issue-error';
    assert.ok(portalProblems({ ...PORTAL, failureSignal: [{ css, text: '발급할 수 없습니다' }] }).includes('unanchored:failureSignal'));
    assert.ok(portalProblems({ ...PORTAL, failureSignal: [{ css, text: '^발급할 수 없습니다' }] }).includes('unanchored:failureSignal'));
    assert.ok(portalProblems({ ...PORTAL, failureSignal: [{ css: 'TODO(PoC-3)', text: '^x$' }] }).includes('placeholder:failureSignal'));
    assert.deepEqual(portalProblems({ ...PORTAL, failureSignal: [] }), [], '빈 목록은 허용(not_committed가 성립하지 않을 뿐)');
    assert.deepEqual(portalProblems(PORTAL), []);
  });

  it('audit-e: same css with a success text is not a failure', () => {
    const [entry] = PORTAL.failureSignal;
    assert.ok(entry);
    assert.equal(failureMatches(entry, '발급되었습니다.'), false);
    assert.equal(failureMatches(entry, '발급할 수 없습니다. 입력 값을 확인하세요. 잠시 뒤 발급 결과를 확인하세요.'), false, '앵커: 더 긴 안내는 아니다');
    assert.equal(failureMatches(entry, '  발급할 수 없습니다.\n입력 값을 확인하세요.  '), true, 'NFKC·공백 접기 뒤 비교');
  });

  // ---- E3 · N-03 ----
  it('audit-e: two runs ending before the checkpoint switch to conservative', async () => {
    const s = setup();
    await s.policy().finish();
    assert.equal(s.g.clock().conservative, false, '1회는 아직 아니다');
    await s.policy().finish();
    assert.equal(s.g.clock().conservative, true);
    assert.equal(s.g.status('p1').conservative, true);
    assert.equal(s.g.cap(FIXTURE_POLICY.run.maxActuationsPerRun, s.g.clock().conservative), 75, '상한 절반');
    assert.deepEqual(s.journal.filter(([t]) => t === 'portal.unknown_screen').map(([, p]) => p), [{ streak: 1 }, { streak: 2 }]);
    await s.policy().finish({ userStopped: true });
    assert.equal(streak(s, 'unknown_screen_streak'), 2, '사용자가 멈춘 실행은 세지 않는다');
  });

  it('audit-e: third consecutive unknown screen counts as a positive detection', async () => {
    const s = setup('hometax', policyFor('hometax'));
    for (let i = 0; i < 2; i++) await s.policy().finish();
    assert.equal(s.g.status('p1').cooldownUntil, null);
    await s.policy().finish();
    assert.equal(streak(s, 'block_streak'), 1);
    assert.ok(s.g.status('p1').cooldownUntil, 'PoC 빌드는 양성 1회에 24시간 쿨다운');
    assert.ok(s.journal.some(([t]) => t === 'cooldown.started'));
    assert.throws(() => s.g.admit('p1', { irreversible: true }), /policy\.cooldown/);
  });

  it('audit-e: reaching the checkpoint resets unknown_screen_streak', async () => {
    const s = setup();
    for (let i = 0; i < 2; i++) await s.policy().finish();
    const p = s.policy();
    p.reached();
    await p.finish();
    assert.equal(s.g.status('p1').unknownScreenStreak, 0);
    assert.equal(s.g.clock().conservative, false);
  });

  it('audit-e: pathExpected rejects a path outside the playbook set', async () => {
    assert.equal(pathExpected(`${ORIGIN}/notice/maintenance`, PORTAL), false);
    assert.equal(pathExpected(`${ORIGIN}/invoice/issue`, PORTAL), true);
    assert.equal(pathExpected(`${ORIGIN}/invoice/list?bizNo=1`, PORTAL), true);
    assert.equal(pathExpected(`${ORIGIN}/mail/list`, PORTAL), true);
    assert.equal(pathExpected('https://other.example/x', PORTAL), true, '포털 밖 주소는 여기서 보지 않는다(금고가 막는다)');
    // 네비게이션 뒤 경로 밖 화면이면 커밋 전 핸드오프
    const s = setup();
    const p = s.policy(fakePage([], `${ORIGIN}/notice/maintenance`));
    await assert.rejects(p.settled(fakePage([], `${ORIGIN}/notice/maintenance`) as unknown as Page), (e: unknown) => e instanceof RunEnd && e.status === 'handoff' && e.code === 'portal.unexpected_page');
    assert.ok(s.journal.some(([t]) => t === 'portal.unexpected_page'));
  });

  it('audit-e: empty hometax dictionary is journaled at start', async () => {
    const db = freshDb();
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다', bizNo: '1234567891', corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    const cp = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: null }).id;
    // 홈택스 kind이지만 실행 전 점검을 지나는 설정(셀렉터는 가짜 페이지 값). 페이지는 열리지 않는다.
    const portal: PortalConfig = { ...PORTAL, kind: 'hometax', verify: { minElapsedMs: 60_000, lookups: 2, intervalMs: 10_000, maxMs: 300_000 } };
    const log = new FileEventLog(null, 'engine');
    const runs = new RunService({ engine: 'h01', db, data, ledgerKey: new Uint8Array(32), portal, policy: FIXTURE_POLICY, log, page: () => Promise.reject(new Error('no page')), postGate: () => {} });
    const ended = new Promise<RunEvent>((r) => runs.on('event', (e: RunEvent) => e.type === 'end' && r(e)));
    runs.start({ runId: 'ht-dict', counterpartyId: cp, supply: 1000, tax: 100, itemName: 'x' });
    await ended;
    const row = db.prepare(`SELECT payload_json FROM run_events WHERE run_id = 'ht-dict' AND type = 'run.signal_dict_empty'`).get() as { payload_json: string } | undefined;
    assert.ok(row, '시작 때 저널에 남는다');
    assert.deepEqual(JSON.parse(row.payload_json), { kinds: 'block,extra_auth,captcha' });
    assert.ok(log.lines.some((l) => l.includes('run.signal_dict_empty')));
  });

  // ---- E4 · N-14 ----
  it('audit-e: extra_auth inside the login section never escalates', () => {
    const s = setup();
    for (let i = 0; i < 3; i++) {
      const page = fakePage();
      const p = s.policy(page);
      p.enterLogin();
      page.emit('framenavigated', { url: () => `${ORIGIN}/auth/extra` });
      assert.deepEqual([p.latched?.status, p.latched?.code], ['handoff', 'portal.mfa_pending'], `${i + 1}회째`);
    }
    assert.equal(streak(s, 'extra_auth_streak'), 0, '로그인 구간의 추가 인증은 연속에 넣지 않는다');
    assert.equal(streak(s, 'block_streak'), 0);
  });

  it('audit-e: loginSucceeded resets extra_auth_streak', () => {
    const s = setup();
    s.g.extraAuth();
    assert.equal(streak(s, 'extra_auth_streak'), 1);
    s.g.loginSucceeded('p1');
    assert.equal(streak(s, 'extra_auth_streak'), 0);
  });

  it('audit-e: repeated extra_auth outside login ends portal.extra_auth_repeat', () => {
    const s = setup();
    const hit = () => {
      const page = fakePage();
      const p = s.policy(page);
      page.emit('framenavigated', { url: () => `${ORIGIN}/auth/extra` });
      return p.latched;
    };
    assert.equal(hit()?.code, 'portal.mfa_pending');
    const second = hit();
    assert.deepEqual([second?.status, second?.code], ['failed', 'portal.extra_auth_repeat']);
    assert.deepEqual(s.journal.filter(([t]) => t === 'block.signal').map(([, p]) => p), [{ id: 'extra_auth.repeat' }]);
    // 양성 탐지 1회면 쿨다운인 정책에서는 쿨다운이 사유다
    const h = setup('hometax', policyFor('hometax'));
    for (let i = 0; i < 2; i++) {
      const page = fakePage();
      const p = h.policy(page);
      page.emit('framenavigated', { url: () => `${ORIGIN}/auth/extra` });
      if (i === 1) assert.equal(p.latched?.code, 'policy.cooldown');
    }
  });

  // ---- E5 · N-16 ----
  it('audit-e: dismissed dialog text is kept in run memory only (NFKC, 200 chars)', async () => {
    const s = setup();
    const page = fakePage();
    const p = s.policy(page);
    let dismissed = 0;
    const text = `  점검\n안내：${'가'.repeat(300)}`;
    page.emit('dialog', { message: () => text, dismiss: async () => void dismissed++ });
    assert.equal(dismissed, 1);
    assert.equal(p.notice, `점검 안내:${'가'.repeat(300)}`.slice(0, 200));
    await p.finish();
    assert.ok(!JSON.stringify(s.journal).includes('점검'), '저널에는 문구가 없다');
  });

  // ---- E7 · N-20 ----
  it('audit-e: SIGNAL_INSPECT_EXPR hashes to 712e7330…598944', () => {
    assert.equal(createHash('sha256').update(SIGNAL_INSPECT_EXPR).digest('hex'), '712e733067b2ccebb89ea8e1da5089577095c3954da089592bbb9ee3ec598944');
  });

  it('audit-e: inspect denial before the gate fails closed with portal.unobservable', async () => {
    const denied = { url: () => `${ORIGIN}/invoice/issue`, evaluate: (expr: unknown) => (assert.equal(expr, SIGNAL_INSPECT_EXPR), Promise.reject(new Error('Protocol error: vault relay denied Runtime.callFunctionOn (secret_window_tainted)'))) };
    const s = setup();
    const p = s.policy(fakePage([denied]));
    await assert.rejects(p.beforeGate(), (e: unknown) => e instanceof RunEnd && e.status === 'handoff' && e.code === 'portal.unobservable');
    assert.deepEqual(s.journal.filter(([t]) => t === 'signal.inspect_unavailable').map(([, x]) => x), [{ reason: 'secret_window_tainted' }]);
    await assert.rejects(p.beforeCommit(), /portal\.unobservable/);
    // 타임아웃·문서 교체 같은 다른 실패는 확인 불가가 아니다(빈 화면으로 넘긴다)
    const gone = { url: () => `${ORIGIN}/invoice/issue`, evaluate: () => Promise.reject(new Error('Execution context was destroyed')) };
    await s.policy(fakePage([gone])).beforeGate();
  });

  // ---- E9 · N-26 ----
  it('audit-e: issueDate is the KST day at 00:30 KST (15:30Z) on a UTC machine', async () => {
    const db = freshDb();
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다', bizNo: '1234567891', corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    const cp = data.counterparties.create({ bizNo: '2148651233', name: 'A상사', email: 'tax@a.example' });
    const wall = Date.parse('2026-12-31T15:30:00Z'); // KST 2027-01-01 00:30, UTC·로컬로는 12-31
    const clock: Clock = { wall: () => wall, mono: () => performance.now() };
    const runs = new RunService({ engine: 'h01', db, data, ledgerKey: new Uint8Array(32), portal: PORTAL, clock, log: new FileEventLog(null, 'engine'), page: () => Promise.reject(new Error('no page')), postGate: () => {} });
    const ended = new Promise<RunEvent>((r) => runs.on('event', (e: RunEvent) => e.type === 'end' && r(e)));
    runs.start({ runId: 'kst', counterpartyId: cp.id, supply: 1000, tax: 100, itemName: '경영 컨설팅' });
    await ended;
    const inputs = { counterpart: { id: cp.id, bizNo: cp.bizNo, name: cp.name }, amounts: { supply: '1000', tax: '100', total: '1100' }, items: [{ name: '경영 컨설팅' }], issueDate: '2027-01-01', email: 'tax@a.example' };
    const row = db.prepare(`SELECT inputs_hash FROM runs WHERE id = 'kst'`).get() as { inputs_hash: string };
    assert.equal(row.inputs_hash, sha256hex(jcs(inputs)), '의도의 작성일자는 KST 날짜(2027-01-01)');
    assert.ok(new RunJournal(db).types('kst').includes('run.started'));
  });

  // ---- E11 · N-23 ----
  it('audit-e: envProblems lists DEBUG_FILE and NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
    assert.deepEqual(envProblems({ DEBUG_FILE: '/tmp/x', NODE_TLS_REJECT_UNAUTHORIZED: '0', PATH: '/bin' }), ['DEBUG_FILE', 'NODE_TLS_REJECT_UNAUTHORIZED']);
    assert.deepEqual(envProblems({ NODE_TLS_REJECT_UNAUTHORIZED: '1', HOME: '/h' }), []);
    assert.deepEqual(envProblems({ DEBUG: 'pw:protocol', PWDEBUG: '1', NODE_OPTIONS: '--require x', NODE_EXTRA_CA_CERTS: 'ca.pem', SSLKEYLOGFILE: 'k' }), ['DEBUG', 'PWDEBUG', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'SSLKEYLOGFILE']);
  });

  it('audit-e: Egress refuses model calls when NODE_EXTRA_CA_CERTS is set', async () => {
    const e = new Egress({ env: { NODE_EXTRA_CA_CERTS: '/tmp/evil-ca.pem' }, modelGuard: { bundles: [] } });
    assert.deepEqual(e.envTampered, ['NODE_EXTRA_CA_CERTS']);
    let sent = false;
    const req = { surface: 'decide', dest: 'openai', path: '/v1/decisions', gateway: {} as never, providerBody: {} } as const;
    await assert.rejects(e.toModel(req, async () => void (sent = true)), (err: unknown) => err instanceof EgressError && err.code === 'egress_env_tampered');
    await assert.rejects(e.postJson('odcloud', '/api/nts-businessman/v1/status', {}), (err: unknown) => err instanceof EgressError && err.code === 'egress_env_tampered');
    assert.equal(sent, false);
    assert.deepEqual(new Egress({ env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } }).envTampered, ['NODE_TLS_REJECT_UNAUTHORIZED']);
    assert.deepEqual(new Egress({ env: {} }).envTampered, []);
  });

  // ---- E14 · N-58 ----
  it('audit-e: mailStatusVerdict classifies 전송실패·미전송·전송대기·전송중 as not_sent, 전송완료 as sent, 접수 as unknown', () => {
    for (const s of ['전송실패', '미전송', '전송대기', '전송중', '전송 오류', '발송 실패']) assert.equal(mailStatusVerdict(s), 'not_sent', s);
    for (const s of ['전송완료', ' 발송 완료 ', '전송 완료']) assert.equal(mailStatusVerdict(s), 'sent', s);
    for (const s of ['접수', '', '전송', '완료']) assert.equal(mailStatusVerdict(s), 'unknown', s);
  });
});
