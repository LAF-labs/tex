// PoC-10(Mac 선행분): 요청률 정책(D03 §7)을 H-01 실행에 붙인 시험. 금고는 프로세스 안(시험 정책 127.0.0.1)·헤드리스 Chrome,
// 페이지는 가짜 H-01 픽스처다. 차단 신호가 오면 그 뒤로 엔진이 픽스처에 요청을 보내지 않는지 픽스처 요청 기록으로 본다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BizVerifier, connectRunBrowser, DataService, FIXTURE_POLICY, fixturePortal, RunService, type GatePortMessage, type GateRequest, type LocalApproval, type RatePolicy, type RunEvent } from '@sax/engine';
import { openDatabase, type Db } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import { FIXTURE_BLOCK_TEXT, startH01Fixture, type H01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { startHarness, type Harness } from './harness.ts';

const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니' };
const C = { bizNo: '4182577343', name: 'C테크', email: 'billing@ctech.example' };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('H-01 요청률 정책(가짜 페이지, 금고 중계 위 Playwright)', () => {
  let fx: H01Fixture;
  let h: Harness;
  let dir: string;
  let page: Page | null = null;
  const dbs: Db[] = [];
  const gateMsgs: GatePortMessage[] = [];
  const events: RunEvent[] = [];
  const log = new FileEventLog(null, 'engine');
  let n = 0;

  const next = <T>(pred: () => T | undefined, ms = 30_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const until = Date.now() + ms;
      const tick = () => {
        const v = pred();
        if (v !== undefined) return resolve(v);
        if (Date.now() > until) return reject(new Error('timeout'));
        setTimeout(tick, 50);
      };
      tick();
    });
  const gateFor = (runId: string) => next(() => (gateMsgs.find((m) => m.t === 'gate.request' && m.req.runId === runId) as { req: GateRequest } | undefined)?.req);
  const endOf = (runId: string) => next(() => events.find((e) => e.runId === runId && e.type === 'end') as Extract<RunEvent, { type: 'end' }> | undefined, 60_000);
  const opened = (runId: string) => gateMsgs.some((m) => m.t === 'gate.request' && m.req.runId === runId);
  const approval = (req: GateRequest): LocalApproval => ({
    v: 2, runId: req.runId, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1',
  });

  /** 새 DB(카운터·쿨다운이 비어 있음)에 붙은 실행 서비스. 페이지는 같은 실행 탭을 쓴다. */
  async function service(policy?: RatePolicy) {
    const db = openDatabase(path.join(dir, `${dbs.length}.sqlite`), new Uint8Array(randomBytes(32)));
    dbs.push(db);
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: SUPPLIER.name, bizNo: SUPPLIER.bizNo, corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    const cp = data.counterparties.create({ ...C }).id;
    const runs = new RunService({
      db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: fixturePortal(fx.origin), log, policy,
      page: async () => (page && !page.isClosed() ? page : (page = (await connectRunBrowser(h.client)).page)),
      postGate: (m) => gateMsgs.push(m),
    });
    runs.on('event', (e: RunEvent) => events.push(e));
    const start = (supply = 500_000) => {
      const runId = `pol-${++n}`;
      runs.start({ runId, counterpartyId: cp, supply, tax: supply / 10, itemName: '교육 용역' });
      return runId;
    };
    return { runs, start, db };
  }

  /** mark 뒤 처음 path 요청 이후의 요청(1.5초 더 기다려 본다). */
  async function requestsAfter(mark: number, p: string) {
    const i = fx.requests.findIndex((r, k) => k >= mark && r.path === p);
    await sleep(1_500);
    return { seen: i >= 0, after: i >= 0 ? fx.requests.slice(i + 1) : [] };
  }

  before(async () => {
    fx = await startH01Fixture({ registry: { [C.bizNo]: C.name }, supplier: SUPPLIER });
    h = await startHarness();
    dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-h01pol-'));
  });

  after(async () => {
    await page?.context().browser()?.close().catch(() => {});
    await h.close();
    await fx.close();
    for (const d of dbs) d.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('정상 발급: 실행 수·발급 수가 남고(발급은 armed와 같은 트랜잭션), 차단 신호 없음', async () => {
    const { runs, start } = await service();
    const runId = start();
    assert.deepEqual(runs.answer(approval(await gateFor(runId))), { ok: true });
    const end = await endOf(runId);
    assert.equal(end.status, 'success', JSON.stringify(end));
    const ins = runs.inspect(runId);
    assert.deepEqual([ins.policy.runsToday, ins.policy.irreversibleToday, ins.policy.blockStreak, ins.policy.cooldownUntil], [1, 1, 0, null]);
    assert.ok(!ins.journal.includes('block.signal'));
  });

  it('차단 안내 페이지: 바로 멈추고 그 뒤 엔진 요청 0회, 게이트·원장 없음, 연속 2회째에 24시간 쿨다운 → 시작 거부', async () => {
    const { runs, start } = await service();
    fx.knobs.block = 'page';
    try {
      const mark = fx.requests.length;
      const r1 = start();
      const e1 = await endOf(r1);
      assert.deepEqual([e1.status, e1.code], ['failed', 'portal.blocked']);
      const req = await requestsAfter(mark, '/notice/blocked');
      assert.ok(req.seen, '차단 안내 페이지를 받았다');
      assert.deepEqual(req.after, [], '차단 안내 뒤로 요청이 없다');
      assert.ok(!opened(r1));
      const i1 = runs.inspect(r1);
      assert.equal(i1.ledger, null);
      assert.ok(i1.journal.includes('block.signal') && !i1.journal.includes('cooldown.started'));
      assert.deepEqual([i1.policy.blockStreak, i1.policy.cooldownUntil], [1, null], '1회는 중단·보고만');

      const r2 = start();
      const e2 = await endOf(r2);
      assert.deepEqual([e2.status, e2.code], ['failed', 'policy.cooldown']);
      const i2 = runs.inspect(r2);
      assert.ok(i2.journal.includes('cooldown.started'));
      assert.ok(i2.policy.cooldownUntil && Date.parse(i2.policy.cooldownUntil) - Date.now() > 23.9 * 3_600_000);
      fx.knobs.block = null;
      assert.throws(() => start(), /policy\.cooldown/, '쿨다운 중에는 실행을 만들지 않는다');
    } finally {
      fx.knobs.block = null;
    }
  });

  it('깨끗한 실행(포털 화면을 보고 신호 없음)이 끼면 연속이 끊겨 쿨다운하지 않는다', async () => {
    const { runs, start } = await service();
    fx.knobs.block = 'page';
    const r1 = start();
    assert.equal((await endOf(r1)).code, 'portal.blocked');
    fx.knobs.block = null;
    const r2 = start();
    await gateFor(r2);
    runs.stop(r2);
    assert.equal((await endOf(r2)).status, 'stopped');
    assert.equal(runs.inspect(r2).policy.blockStreak, 0);
    fx.knobs.block = 'page';
    try {
      const r3 = start();
      assert.equal((await endOf(r3)).code, 'portal.blocked');
    } finally {
      fx.knobs.block = null;
    }
  });

  it('승인 대기 중 포털 응답 429: 게이트를 닫아 승인할 수 없고, 발급하지 않는다', async () => {
    const { runs, start } = await service();
    const posts = fx.posts();
    const r = start();
    const req = await gateFor(r);
    const mark = fx.requests.length;
    fx.knobs.status = { path: '/api/knob', code: 429 }; // 폼이 150ms마다 부르는 요청
    try {
      const end = await endOf(r);
      assert.deepEqual([end.status, end.code], ['failed', 'portal.blocked']);
      await sleep(1_000);
      // 페이지 자체 스크립트(폴링)는 계속 돌지만 엔진이 보낸 요청은 없다.
      assert.deepEqual(fx.requests.slice(mark).filter((x) => x.path !== '/api/knob'), []);
      assert.ok(gateMsgs.some((m) => m.t === 'gate.closed' && m.reqId === req.reqId && m.reason === 'signal'));
      assert.deepEqual(runs.answer(approval(req)), { ok: false, code: 'no_open_gate' });
      assert.equal(fx.posts(), posts);
      assert.equal(runs.inspect(r).ledger, null);
    } finally {
      fx.knobs.status = null;
      // 남은 폼 페이지의 폴링 응답(429)이 다음 시험의 실행에 닿지 않게 비운다(그때 닿으면 그 실행의 신호가 맞다).
      await sleep(500);
    }
  });

  it('대화상자 문구·조회 팝업·문서 403도 차단 신호다(게이트를 열지 않는다)', async () => {
    for (const [knob, id] of [
      [{ block: 'dialog' }, 'fixture.block.text'],
      [{ block: 'lookup' }, 'fixture.block.url'],
      [{ status: { path: '/invoice/issue', code: 403 } }, 'http.403_document'],
      [{ status: { path: '/invoice/list', code: 429 } }, 'http.429'], // 조회 팝업 첫 문서(응답 이벤트가 안 보여 문서 상태로 본다)
    ] as const) {
      const { runs, start, db } = await service();
      Object.assign(fx.knobs, knob);
      try {
        const r = start();
        const end = await endOf(r);
        assert.deepEqual([end.status, end.code], ['failed', 'portal.blocked'], JSON.stringify(knob));
        assert.ok(!opened(r));
        const ev = db.prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'block.signal'`).get(r) as { payload_json: string };
        assert.equal(JSON.parse(ev.payload_json).id, id);
        assert.equal(runs.inspect(r).ledger, null);
      } finally {
        Object.assign(fx.knobs, { block: null, status: null });
      }
    }
  });

  it('네비게이션 없이 뜬 안내 레이어도 다음 동작 전에 잡는다', async () => {
    const { runs, start } = await service();
    fx.knobs.notice = FIXTURE_BLOCK_TEXT; // 폼이 읽힌 뒤 150ms 주기 XHR로 그린다
    try {
      const r = start();
      const end = await endOf(r);
      assert.deepEqual([end.status, end.code], ['failed', 'portal.blocked']);
      assert.ok(!opened(r));
      assert.equal(runs.inspect(r).ledger, null);
    } finally {
      fx.knobs.notice = null;
    }
  });

  it('기준선 조회 중에 뜬 안내는 게이트를 열기 전에 잡는다(게이트 진입 직전 판정)', async () => {
    const { start } = await service();
    fx.knobs.lookupDelayMs = 1_000;
    try {
      const r = start();
      await next(() => (events.some((e) => e.runId === r && e.type === 'phase' && e.phase === 'gate' && e.state === 'now') ? true : undefined));
      fx.knobs.notice = FIXTURE_BLOCK_TEXT;
      const end = await endOf(r);
      assert.deepEqual([end.status, end.code], ['failed', 'portal.blocked']);
      assert.ok(!opened(r), '게이트 요청이 나가지 않았다');
    } finally {
      fx.knobs.lookupDelayMs = 0;
      fx.knobs.notice = null;
    }
  });

  it('기대한 화면(발급 폼)을 못 찾고 끝난 실행은 연속을 끊지 않는다(사전에 없는 차단 화면일 수 있다)', async () => {
    const { runs, start } = await service();
    fx.knobs.block = 'page';
    try {
      assert.equal((await endOf(start())).code, 'portal.blocked');
      fx.knobs.block = null;
      fx.knobs.status = { path: '/invoice/issue', code: 500 };
      const r2 = start();
      assert.equal((await endOf(r2)).code, 'checkpoint.expect_failed');
      assert.equal(runs.inspect(r2).policy.blockStreak, 1);
      fx.knobs.status = null;
      fx.knobs.block = 'page';
      assert.equal((await endOf(start())).code, 'policy.cooldown');
    } finally {
      Object.assign(fx.knobs, { block: null, status: null });
    }
  });

  it('추가 인증: 1회는 핸드오프, 연속 2회째는 차단 신호. 캡차는 횟수를 남기고 핸드오프', async () => {
    const { runs, start } = await service();
    fx.knobs.extraAuth = 2;
    const r1 = start();
    const e1 = await endOf(r1);
    assert.deepEqual([e1.status, e1.code], ['handoff', 'portal.mfa_pending']);
    const r2 = start();
    assert.deepEqual([(await endOf(r2)).code, runs.inspect(r2).policy.blockStreak], ['portal.blocked', 1]);
    assert.equal(fx.knobs.extraAuth, 0);
    fx.knobs.captcha = 1;
    const r3 = start();
    assert.deepEqual([(await endOf(r3)).code, runs.inspect(r3).policy.captchaToday], ['portal.captcha', 1]);
    assert.ok(runs.inspect(r3).journal.includes('portal.signal'));
  });

  it('상한: 하루 실행 수를 넘으면 시작하지 않고, 분당 네비게이션이 차면 기다린다(기다리는 동안 [중지]를 받는다)', async () => {
    const one = await service({ ...FIXTURE_POLICY, limits: { ...FIXTURE_POLICY.limits, runsPerDayPerProfile: 1 } });
    const r1 = one.start();
    await gateFor(r1);
    one.runs.stop(r1);
    await endOf(r1);
    assert.throws(() => one.start(), /policy\.runs_per_day/);

    const slow = await service({ ...FIXTURE_POLICY, limits: { ...FIXTURE_POLICY.limits, navigationsPerMin: 1 } });
    const mark = fx.requests.length;
    const r2 = slow.start();
    await sleep(2_500);
    assert.ok(!opened(r2), '발급 화면(1회) 뒤 기준선 조회(2회째)는 60초 창이 빌 때까지 기다린다');
    assert.ok(!fx.requests.slice(mark).some((r) => r.path === '/invoice/list'));
    slow.runs.stop(r2);
    const e2 = await endOf(r2);
    assert.deepEqual([e2.status, e2.code], ['stopped', 'run.stopped']);
  });

  it('verify 조회가 3번 연속 실패하면 더 조회하지 않고 발급됐는지 모름으로 둔다', async () => {
    const { runs, start } = await service();
    const r = start();
    assert.deepEqual(runs.answer(approval(await gateFor(r))), { ok: true });
    await next(() => (events.some((e) => e.runId === r && e.type === 'phase' && e.phase === 'sign' && e.state === 'now') ? true : undefined));
    const mark = fx.requests.length;
    fx.knobs.status = { path: '/invoice/list', code: 500 };
    try {
      const end = await endOf(r);
      assert.deepEqual([end.status, end.code], ['in_doubt', 'verify.unknown']);
      assert.equal(fx.requests.slice(mark).filter((x) => x.path === '/invoice/list').length, 3);
    } finally {
      fx.knobs.status = null;
    }
  });

  it('커밋 구간·verify는 실행당 동작 수 상한으로 끊지 않는다(끊으면 발급됐는지 모름만 생긴다)', async () => {
    // 발급 화면 1 + 입력 6 + 기준선 조회 1 + 발급 클릭 1 = 9. verify·메일 조회는 상한을 넘어도 계속한다.
    const { runs, start } = await service({ ...FIXTURE_POLICY, run: { ...FIXTURE_POLICY.run, maxActuationsPerRun: 9 } });
    const r = start();
    assert.deepEqual(runs.answer(approval(await gateFor(r))), { ok: true });
    const end = await endOf(r);
    assert.equal(end.status, 'success', JSON.stringify(end));
  });

  it('실행당 동작 수 상한을 넘으면 커밋 전에 멈춘다', async () => {
    const { start } = await service({ ...FIXTURE_POLICY, run: { ...FIXTURE_POLICY.run, maxActuationsPerRun: 3 } });
    const r = start();
    const end = await endOf(r);
    assert.deepEqual([end.status, end.code], ['failed', 'policy.actuations_per_run']);
    assert.ok(!opened(r));
  });
});
