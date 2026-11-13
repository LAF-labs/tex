// 발급 사다리(D03 §4.2): 홈택스 자동 → 홈택스 직접 → API. 칸이 끝나면 같은 발급 키의 원장으로 판정해 다음 길로 갈지 정한다.
// 홈택스는 가짜 H-01 페이지(h01-engine.test.ts와 같은 픽스처·금고 중계·헤드리스 Chrome), API는 FakeIssueApi(네트워크 없음)다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  apiRung, BizVerifier, branchOf, connectRunBrowser, DataService, docKeyOf, FakeIssueApi, fixturePortal, hometaxAutoRung, hometaxManualRung, IssueLadder, parseIssueKey, RunEnd, RunService, ulid,
  API_LOOKUP_POLICY, type ApiClock, type ApiLookupPolicy, type GatePortMessage, type GateRequest, type IrPackage, type IssueKey, type LadderEvent, type LadderState, type LocalApproval, type RunEvent,
} from '@sax/engine';
import { GateRepo, Ledger, LedgerError, openDatabase, RunJournal, RunRepo, type ArmRow, type Db } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import { startH01Fixture, type H01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { startHarness, type Harness } from './harness.ts';
import { fixtureOriginGrant } from '@sax/engine/core';
import { h01FixtureLookupDefs, loadH01Fixture } from './h01-fixture-package.ts';

const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니' };
const C = { bizNo: '4182577343', name: 'C테크', email: 'billing@ctech.example' };

const dirs: string[] = [];
async function tempDb(): Promise<Db> {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-ladder-'));
  dirs.push(dir);
  return openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
}
const key = (): IssueKey => parseIssueKey(ulid())!;
const poll = <T>(pred: () => T | undefined, ms = 60_000): Promise<T> =>
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
const settle = () => new Promise((r) => setTimeout(r, 300));
/** 시험용 조회 하한: 두 번 "없음"이면 발급 안 됨(제품 기본은 API_LOOKUP_POLICY 60초·2번). */
const FAST_LOOKUP: ApiLookupPolicy = { minElapsedMs: 0, lookups: 2, intervalMs: 0 };

describe('발급 키 원장(v10 issue_key, ux_irr_issue_live)', () => {
  let db: Db;
  before(async () => (db = await tempDb()));
  after(() => db.close());

  const row = (intentId: string, issueKey: string | null, stepId = 's21'): ArmRow => ({
    intentId, stepId, runId: 'r', businessKey: 'bk', playbookId: 'H-01', inputsHash: 'i', packageDigest: 'd', actionHash: 'a', deviceId: 'dv', cpBizNoHmac: 'h', recipientEmailHmac: null, issueKey,
  });
  let q = 0;
  const arm = (r: ArmRow) => {
    const reqId = `q${++q}`;
    new GateRepo(db).open(reqId, 'r');
    new GateRepo(db).decide(reqId, 'approved', 'local');
    new Ledger(db).consumeAndArm(reqId, r);
    return reqId;
  };
  const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;

  it('마이그레이션이 issue_key 열과 부분 유일 색인을 만든다', () => {
    const cols = (db.prepare('PRAGMA table_info(irreversible_log)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('issue_key'));
    const idx = db.prepare(`SELECT sql FROM sqlite_master WHERE type='index' AND name='ux_irr_issue_live'`).get() as { sql: string } | undefined;
    assert.match(idx?.sql ?? '', /issue_key IS NOT NULL AND state <> 'not_committed'/);
  });

  it('같은 키의 다른 의도는 무장하지 못한다(미종결 → ledger_issue_open, 발급됨 → ledger_issue_committed). not_committed 뒤에는 된다', () => {
    new RunRepo(db).create({ id: 'r', playbookId: 'p', playbookVersion: '1', packageDigest: 'd', profileId: 'x', trigger: 'local', inputsHash: 'i' });
    const l = new Ledger(db);
    const k = key();
    arm(row('I1', k));
    const gates = new GateRepo(db);
    let reqId = '';
    assert.throws(() => (reqId = `q${q + 1}`, arm(row('I2', k))), code('ledger_issue_open'));
    assert.equal(gates.state(reqId), 'approved', '거부된 무장은 게이트 토큰을 소비하지 않는다');
    assert.throws(() => l.observedManual(row('I3', k, 'manual.issue')), code('ledger_issue_open'));
    l.dispatched('I1', 's21');
    l.resolve('I1', 's21', 'not_committed', 'verify');
    arm(row('I2', k, 'api.issue'));
    l.resolve('I2', 'api.issue', 'committed', null, 'NTS-1');
    assert.throws(() => arm(row('I4', k)), code('ledger_issue_committed'));
    assert.deepEqual(l.byIssueKey(k).map((r) => [r.intentId, r.state, r.issueKey]), [['I1', 'not_committed', k], ['I2', 'committed', k]]);
    arm(row('I5', null, 's33'));
    arm(row('I6', null, 's33'));
  });

  it('색인이 원장 API를 거치지 않은 쓰기도 막는다', () => {
    const k = key();
    const ins = (intent: string, state: string) =>
      db.prepare(`INSERT INTO irreversible_log (intent_id, step_id, attempt, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, issue_key) VALUES (?,'s21',1,'r','bk','p','i','d','a',?,'t','dev',?)`).run(intent, state, k);
    ins('X1', 'in_doubt');
    assert.throws(() => ins('X2', 'armed'), /UNIQUE constraint failed/);
    ins('X3', 'not_committed');
  });
});

describe('끝 코드 갈래(branchOf)', () => {
  it('홈택스 쪽 문제는 다음 길, 내용 오류·사장님 선택·상한은 멈춤, 모르는 코드는 멈춤', () => {
    for (const c of ['portal.captcha', 'portal.blocked', 'chrome.not_installed', 'verify.not_committed', 'pre_dispatch_mismatch', 'step.selector_miss', 'login.whatever']) assert.equal(branchOf(c), 'fallthrough', c);
    for (const c of ['assert.supplier_mismatch', 'bad_amount', 'gate.stopped', 'gate.expired', 'policy.irreversible_per_day', 'policy.playbook_killed', 'issue.consent_declined', 'no.such_code']) assert.equal(branchOf(c), 'stop', c);
  });

  it('사람 대기 시간 초과는 로그인 구간이면 다음 길, 발급 화면 이후면 멈춤', () => {
    assert.equal(branchOf('run.handoff_timeout', 's3'), 'fallthrough');
    assert.equal(branchOf('human.ttl_expired', 's91'), 'fallthrough');
    assert.equal(branchOf('run.handoff_timeout', 's21'), 'stop');
    assert.equal(branchOf('run.handoff_timeout', 's14'), 'stop');
    assert.equal(branchOf('run.handoff_timeout'), 'stop');
  });

  it('문서번호는 영문 대문자·숫자 24자, 발급 키만으로 정해진다(같은 건은 몇 번째 시도든 같은 번호)', () => {
    const k = key();
    assert.match(docKeyOf(k), /^SAX[A-Z2-7]{21}$/);
    assert.equal(docKeyOf(k), docKeyOf(parseIssueKey(String(k))!));
    assert.notEqual(docKeyOf(k), docKeyOf(key()));
  });
});

describe('발급 사다리(가짜 홈택스 + 가짜 API)', () => {
  let fx: H01Fixture;
  let h: Harness;
  let page: Page | null = null;
  const log = new FileEventLog(null, 'engine');
  const gateMsgs: GatePortMessage[] = [];
  const dbs: Db[] = [];
  let supply = 100_000;

  const sharedPage = async () => (page && !page.isClosed() ? page : (page = (await connectRunBrowser(h.client)).page));
  /** 제품 실행기(engine 'ir')로 가짜 H-01 패키지를 돌린다(h01-golden.test.ts와 같은 패키지·조회·판정기). */
  const irPackage = (): IrPackage => {
    const { pkg } = loadH01Fixture(fx.origin);
    const p = fixturePortal(fx.origin);
    return {
      pkg, lookupDefs: h01FixtureLookupDefs(fx.origin), fixtureGrant: fixtureOriginGrant(pkg),
      verifyTiming: { minElapsedMs: p.verify.minElapsedMs, lookups: p.verify.lookups, maxMs: p.verify.maxMs },
      judge: { decide: async () => ({ outcome: 'no_visible_error', confidence: 1, raw: {}, usage: { input_tokens: 0, output_tokens: 0 }, refusals: [], rule: 3, provider: 'openai', model: 'fixture', l0Only: true, injectionHit: false, shadow: [] }) as never },
    };
  };
  const approval = (req: GateRequest): LocalApproval => ({
    v: 2, runId: req.runId, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1',
  });
  const gateCount = () => gateMsgs.filter((m) => m.t === 'gate.request').length;
  const gateAfter = (n: number) => poll(() => (gateMsgs.filter((m) => m.t === 'gate.request')[n] as { req: GateRequest } | undefined)?.req);

  /** DB 하나에 실행 서비스·사다리 하나. 요청률 카운터·쿨다운이 시험끼리 섞이지 않게 시험마다 새로 만든다. */
  async function world(o: { api?: FakeIssueApi | null; page?: () => Promise<Page>; auto?: (runs: RunService, db: Db) => RunService; ir?: boolean; lookup?: ApiLookupPolicy; clock?: ApiClock } = {}) {
    const db = await tempDb();
    dbs.push(db);
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: SUPPLIER.name, bizNo: SUPPLIER.bizNo, corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    const cp = data.counterparties.create({ ...C }).id;
    const runs = new RunService({ ...(o.ir ? { engine: 'ir' as const, ir: irPackage() } : { engine: 'h01' as const }), db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: fixturePortal(fx.origin), log, page: o.page ?? sharedPage, postGate: (m) => gateMsgs.push(m) });
    const runEvents: RunEvent[] = [];
    runs.on('event', (e: RunEvent) => runEvents.push(e));
    const api = o.api === undefined ? new FakeIssueApi('ok') : o.api;
    const ladder = new IssueLadder({ rungs: [hometaxAutoRung(o.auto ? o.auto(runs, db) : runs, db), hometaxManualRung(runs, db), apiRung(api ? { popbill: api } : {}, { runs, db, lookup: o.lookup ?? FAST_LOOKUP, ...(o.clock ? { clock: o.clock } : {}) })], ledger: new Ledger(db), log });
    const events: LadderEvent[] = [];
    ladder.on('state', (e: LadderEvent) => events.push(e));
    const ledger = new Ledger(db);
    return {
      db, runs, ladder, api, events, runEvents, ledger, cp,
      request: (k: IssueKey = key()) => {
        const s = (supply += 10_000);
        return { k, state: ladder.request({ issueKey: k, counterpartyId: cp, supply: s, tax: s / 10, itemName: '경영 컨설팅' }) };
      },
      until: <S extends LadderState['s']>(k: IssueKey, s: S) => poll(() => {
        const st = ladder.state(k);
        return st?.s === s ? (st as Extract<LadderState, { s: S }>) : undefined;
      }),
      seen: (k: IssueKey) => events.filter((e) => e.issueKey === k).map((e) => e.state.s),
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  /** 홈택스 칸이 다음 길로 넘어온 뒤: 직접 칸 [못 해요] → 동의 카드 [동의하고 발급]. */
  async function passManualThenConsent(w: World, k: IssueKey) {
    await w.until(k, 'human');
    assert.ok(w.ladder.human(k, 'cannot'));
    return w.until(k, 'consent');
  }

  before(async () => {
    fx = await startH01Fixture({ registry: { [C.bizNo]: C.name }, supplier: SUPPLIER });
    h = await startHarness();
  });

  after(async () => {
    await page?.context().browser()?.close().catch(() => {});
    await h.close();
    await fx.close();
    for (const db of dbs) db.close();
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('홈택스 자동으로 발급되면 issued, 같은 키 재요청은 새 실행 없이 issued', async () => {
    const w = await world();
    const g = gateCount();
    const posts = fx.posts();
    const { k } = w.request();
    w.runs.answer(approval(await gateAfter(g)));
    const done = await w.until(k, 'issued');
    assert.equal(done.route, 'hometax.auto');
    assert.equal(done.ref, fx.issued.at(-1)!.approvalNo);
    assert.equal(fx.posts(), posts + 1);
    assert.deepEqual(w.ledger.byIssueKey(k).map((r) => [r.stepId, r.state]), [['s21', 'committed']], '발급 단계 행에만 키(메일 후속 단계는 null)');

    const again = w.request(k);
    assert.deepEqual(again.state, { s: 'issued', route: 'hometax.auto', ref: done.ref });
    await settle();
    assert.equal(gateCount(), g + 1, '새 게이트 없음');
    assert.equal(fx.posts(), posts + 1);
    assert.equal(w.api!.calls, 0);
    assert.ok(!w.seen(k).includes('consent'));
  });

  for (const c of [
    { name: '캡차', code: 'portal.captcha', set: () => void (fx.knobs.captcha = 1), reset: () => void (fx.knobs.captcha = 0) },
    { name: '차단 안내 화면', code: 'portal.blocked', set: () => void (fx.knobs.block = 'page'), reset: () => void (fx.knobs.block = null) },
  ]) {
    it(`${c.name}(${c.code})면 다음 길로 간다: 직접 칸 → 동의 카드 → 가짜 API 호출 1`, async () => {
      const w = await world();
      const posts = fx.posts();
      c.set();
      let k: IssueKey;
      try {
        ({ k } = w.request());
        await w.until(k, 'human');
      } finally {
        c.reset();
      }
      const end = w.runEvents.find((e) => e.type === 'end') as Extract<RunEvent, { type: 'end' }>;
      assert.equal(end.code, c.code);
      assert.ok(w.ladder.human(k, 'cannot'));
      const consent = await w.until(k, 'consent');
      assert.equal(consent.card.reasonCode, 'issue.manual_declined');
      assert.ok(w.ladder.consent(k, 'granted'));
      const done = await w.until(k, 'issued');
      assert.deepEqual([done.route, done.ref], ['api', 'FAKE-NTS-1']);
      assert.equal(w.api!.calls, 1);
      assert.equal(fx.posts(), posts, '홈택스에는 제출하지 않았다');
    });
  }

  it('공급자 불일치(assert.supplier_mismatch)면 멈춘다: 동의 카드 없음, API 0', async () => {
    const w = await world();
    const posts = fx.posts();
    fx.knobs.supplier = { bizNo: '3051288767', name: 'B상사' };
    try {
      const { k } = w.request();
      const st = await w.until(k, 'stopped');
      assert.deepEqual([st.route, st.code], ['hometax.auto', 'assert.supplier_mismatch']);
      assert.ok(!w.seen(k).includes('consent') && !w.seen(k).includes('human'));
    } finally {
      fx.knobs.supplier = SUPPLIER;
    }
    assert.equal(w.api!.calls, 0);
    assert.equal(fx.posts(), posts);
  });

  it('홈택스 발급 실패(verify not_committed)면 다음 길로 가고, 원장에는 발급 안 됨 + API 발급이 같은 키로 남는다', async () => {
    const w = await world();
    const g = gateCount();
    const posts = fx.posts();
    fx.knobs.failIssue = true;
    let k: IssueKey;
    try {
      ({ k } = w.request());
      w.runs.answer(approval(await gateAfter(g)));
      await w.until(k, 'human');
    } finally {
      fx.knobs.failIssue = false;
    }
    assert.equal(fx.posts(), posts + 1);
    await passManualThenConsent(w, k);
    w.ladder.consent(k, 'granted');
    await w.until(k, 'issued');
    assert.equal(w.api!.calls, 1);
    assert.deepEqual(w.ledger.byIssueKey(k).map((r) => [r.stepId, r.state, r.reason]), [['s21', 'not_committed', 'verify'], ['api.issue', 'committed', null]]);
  });

  it('홈택스 결과 모름(in_doubt)이면 멈춘다: held, 동의 카드 없음, API 0. 같은 키 재요청도 held이고 새 실행이 없다', async () => {
    const w = await world();
    const g = gateCount();
    fx.knobs.dropIssue = true;
    let k: IssueKey;
    try {
      ({ k } = w.request());
      w.runs.answer(approval(await gateAfter(g)));
      const held = await w.until(k, 'held');
      assert.equal(held.state, 'in_doubt');
    } finally {
      fx.knobs.dropIssue = false;
    }
    const posts = fx.posts();
    assert.deepEqual(w.request(k).state, { s: 'held', state: 'in_doubt' });
    await settle();
    assert.equal(gateCount(), g + 1, '새 게이트 없음');
    assert.equal(fx.posts(), posts);
    assert.equal(w.api!.calls, 0);
    assert.ok(!w.seen(k).includes('consent'));
    assert.equal(w.runEvents.filter((e) => e.type === 'end').length, 1, '홈택스 실행은 한 번뿐');
  });

  it('승인 대기 중 사장님 [중지]면 멈춘다(gate.stopped), API 0', async () => {
    const w = await world();
    const g = gateCount();
    const { k } = w.request();
    const req = await gateAfter(g);
    assert.deepEqual(w.runs.stop(req.runId), { stopped: true });
    const st = await w.until(k, 'stopped');
    assert.equal(st.code, 'gate.stopped');
    assert.equal(w.api!.calls, 0);
  });

  it('Chrome이 없으면(chrome.not_installed) 다음 길로 간다: 동의 카드 값 확인 → API 호출 1', async () => {
    const w = await world({ page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    const consent = await passManualThenConsent(w, k);
    assert.deepEqual(consent.card, { issueKey: k, route: 'api', provider: 'popbill', costKrw: 200, costBasis: consent.card.costBasis, reasonCode: 'issue.manual_declined', nothingIssued: true });
    assert.equal(w.ladder.state(k)?.s, 'consent');
    assert.equal(w.api!.calls, 0, '동의 전에는 부르지 않는다');
    w.ladder.consent(k, 'granted');
    await w.until(k, 'issued');
    assert.equal(w.api!.calls, 1);
    const apiRow = w.ledger.byIssueKey(k).at(-1)!;
    assert.equal(new GateRepo(w.db).state(w.db.prepare('SELECT req_id FROM gate_requests WHERE run_id = ?').pluck().get(apiRow.runId) as string), 'consumed', '동의가 게이트 표에 남고 무장이 소비했다');
  });

  it('홈택스 상한·쿨다운은 API 칸을 막지 않고 세지도 않는다(그 상한은 홈택스 계정 보호, 두 번 발급은 원장이 막는다)', async () => {
    const w = await world();
    const kind = fixturePortal(fx.origin).kind;
    w.db.prepare('INSERT INTO cooldowns (portal, until, reason) VALUES (?, ?, ?)').run(kind, new Date(Date.now() + 3_600_000).toISOString(), 'test');
    const before = w.runs.inspect('none').policy;
    const { k } = w.request();
    const consent = await passManualThenConsent(w, k);
    assert.equal(consent.card.reasonCode, 'issue.manual_declined');
    assert.deepEqual(w.runEvents, [], '홈택스 칸은 쿨다운(policy.cooldown)으로 시작하지 못했다');
    w.ladder.consent(k, 'granted');
    await w.until(k, 'issued');
    assert.equal(w.api!.calls, 1);
    assert.equal(w.runs.inspect('none').policy.irreversibleToday, before.irreversibleToday, 'API 발급은 홈택스 하루 발급 수에 들어가지 않는다');
  });

  it('동의 카드 [그만]이면 stopped(issue.consent_declined), API 0', async () => {
    const w = await world({ page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    await passManualThenConsent(w, k);
    w.ladder.consent(k, 'declined');
    const st = await w.until(k, 'stopped');
    assert.deepEqual([st.route, st.code], ['api', 'issue.consent_declined']);
    assert.equal(w.api!.calls, 0);
    assert.equal(w.ledger.byIssueKey(k).length, 0);
  });

  it('API 응답이 끊기고 조회도 모름이면 held(in_doubt), 재요청해도 API를 다시 부르지 않는다', async () => {
    const w = await world({ api: new FakeIssueApi('drop_unknown'), page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    await passManualThenConsent(w, k);
    w.ladder.consent(k, 'granted');
    assert.equal((await w.until(k, 'held')).state, 'in_doubt');
    assert.deepEqual([w.api!.calls, w.api!.lookups], [1, 1]);
    assert.deepEqual(w.request(k).state, { s: 'held', state: 'in_doubt' });
    await settle();
    assert.equal(w.api!.calls, 1);
  });

  it('API 응답이 끊겨도 조회로 결론이 난다: 있으면 issued, 없으면 발급 안 됨 → 다음 길 없음(exhausted)', async () => {
    const issued = await world({ api: new FakeIssueApi('drop_then_issued'), page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const a = issued.request();
    await passManualThenConsent(issued, a.k);
    issued.ladder.consent(a.k, 'granted');
    assert.equal((await issued.until(a.k, 'issued')).ref, 'FAKE-NTS-1');
    assert.deepEqual([issued.api!.calls, issued.api!.lookups], [1, 1]);

    const absent = await world({ api: new FakeIssueApi('drop_then_absent'), page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const b = absent.request();
    await passManualThenConsent(absent, b.k);
    absent.ladder.consent(b.k, 'granted');
    const ex = await absent.until(b.k, 'exhausted');
    assert.deepEqual(ex.tried.map((t) => [t.route, t.code]), [['hometax.auto', 'chrome.not_installed'], ['hometax.manual', 'issue.manual_declined'], ['api', 'api.not_committed']]);
    assert.deepEqual([absent.api!.calls, absent.api!.lookups], [1, 2], '"없음"은 하한(2번)을 채워야 발급 안 됨');
  });

  /** 가짜 시계: sleep은 시간을 그만큼 바로 넘긴다. at(ms, fn)은 그 시각을 지날 때 한 번 부른다(원천이 늦게 처리하는 순간). */
  const fakeClock = () => {
    const c = { t: 0, sleeps: [] as number[], hooks: [] as Array<{ at: number; fn: () => void }> };
    const clock: ApiClock = {
      now: () => c.t,
      sleep: async (ms) => {
        c.sleeps.push(ms);
        c.t += ms;
        for (const h of c.hooks.splice(0)) if (c.t >= h.at) h.fn(); else c.hooks.push(h);
      },
    };
    return { c, clock, at: (ms: number, fn: () => void) => c.hooks.push({ at: ms, fn }) };
  };

  it('기본 하한(가짜 시계): 끊긴 뒤 "없음"은 60초가 지나고 조회가 2번 넘어야 not_committed. 0초·1번이나 시간 무시로 바꾸면 실패한다', async () => {
    assert.deepEqual(API_LOOKUP_POLICY, { minElapsedMs: 60_000, lookups: 2, intervalMs: 30_000 });
    const f = fakeClock();
    const w = await world({ api: new FakeIssueApi('drop_then_absent'), lookup: API_LOOKUP_POLICY, clock: f.clock, page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    await passManualThenConsent(w, k);
    w.ladder.consent(k, 'granted');
    const ex = await w.until(k, 'exhausted');
    assert.equal(ex.tried.at(-1)?.code, 'api.not_committed');
    // 0초: 없음(1) → 30초: 없음(2), 아직 60초 전 → 60초: 없음(3) → 닫음.
    assert.deepEqual([w.api!.calls, w.api!.lookups, f.c.t, f.c.sleeps], [1, 3, 60_000, [30_000, 30_000]]);
  });

  it('기본 하한(가짜 시계): 끊긴 뒤 45초에 원천에 보이면 60초 하한 안의 조회가 찾아 issued, 문서 1건', async () => {
    const f = fakeClock();
    const api = new FakeIssueApi('drop_then_absent');
    const w = await world({ api, lookup: API_LOOKUP_POLICY, clock: f.clock, page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    f.at(45_000, () => api.preload(docKeyOf(k), 'FAKE-NTS-LATE'));
    await passManualThenConsent(w, k);
    w.ladder.consent(k, 'granted');
    const st = await w.until(k, 'issued');
    assert.equal(st.ref, 'FAKE-NTS-LATE');
    assert.deepEqual([api.calls, api.lookups, api.documents, f.c.t], [1, 3, 1, 60_000]);
  });

  it('끊긴 뒤 원천이 늦게 처리하면(첫 조회에는 없음) 하한 안의 다음 조회가 찾아 issued. 원천 문서 1건, 같은 키 재요청도 issued', async () => {
    const api = new FakeIssueApi('drop_then_late');
    api.lateMs = 50;
    const w = await world({ api, lookup: { minElapsedMs: 200, lookups: 2, intervalMs: 100 }, page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    await passManualThenConsent(w, k);
    w.ladder.consent(k, 'granted');
    await w.until(k, 'issued');
    assert.equal(api.documents, 1);
    assert.deepEqual(w.request(k).state.s, 'issued');
    await settle();
    assert.deepEqual([api.calls, api.documents], [1, 1]);
  });

  it('하한을 넘겨 늦게 처리된 앞 문서가 있으면(발급 안 됨으로 닫힌 뒤) 다시 요청해도 같은 문서번호라 원천이 거절하고, 조회로 그 문서를 찾아 issued(문서 1건)', async () => {
    const api = new FakeIssueApi('ok');
    const w = await world({ api, page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const k = key();
    api.preload(docKeyOf(k), 'FAKE-NTS-EARLIER');
    w.request(k);
    await passManualThenConsent(w, k);
    w.ladder.consent(k, 'granted');
    const st = await w.until(k, 'issued');
    assert.equal(st.ref, 'FAKE-NTS-EARLIER', '거절 뒤에도 조회로 확인한다(거절을 곧바로 발급 안 됨으로 보지 않는다)');
    assert.deepEqual([api.calls, api.documents], [1, 1]);
  });

  it('원천이 거절하고 조회도 하한까지 "없음"이면 발급 안 됨(api.refused), 원천 문서 0', async () => {
    const api = new FakeIssueApi('refuse');
    const w = await world({ api, page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    await passManualThenConsent(w, k);
    w.ladder.consent(k, 'granted');
    const ex = await w.until(k, 'exhausted');
    assert.deepEqual(ex.tried.at(-1), { route: 'api', code: 'api.refused' });
    assert.deepEqual([api.calls, api.lookups, api.documents], [1, 2, 0]);
    assert.deepEqual(w.ledger.byIssueKey(k).map((r) => r.state), ['not_committed']);
  });

  it('API가 연결되지 않았으면 건너뛰고 exhausted, 마지막에 api.not_connected', async () => {
    const w = await world({ api: null, page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    await w.until(k, 'human');
    w.ladder.human(k, 'cannot');
    const ex = await w.until(k, 'exhausted');
    assert.deepEqual(ex.tried.at(-1), { route: 'api', code: 'api.not_connected' });
    assert.ok(!w.seen(k).includes('consent'));
  });

  it('홈택스 직접 칸 [발급했어요]면 held(observed_manual), API 0. 재요청도 held', async () => {
    const w = await world({ page: () => Promise.reject(new RunEnd('failed', 'chrome.not_installed')) });
    const { k } = w.request();
    await w.until(k, 'human');
    w.ladder.human(k, 'issued');
    assert.equal((await w.until(k, 'held')).state, 'observed_manual');
    assert.deepEqual(w.ledger.byIssueKey(k).map((r) => [r.stepId, r.state]), [['manual.issue', 'observed_manual']]);
    assert.deepEqual(w.request(k).state, { s: 'held', state: 'observed_manual' });
    assert.equal(w.api!.calls, 0);
  });

  it('홈택스 사람 대기에서 [직접 발급함]을 눌렀는데 원장 행이 없으면(IR 무장 전) 직접 발급 행을 남기고 held, API 0', async () => {
    // IR 조율기는 무장 전 [직접 발급함]의 ledger.observed_manual 효과를 원장 행으로 남기지 못한다. 그 실행 끝을 흉내 낸다.
    const fakeStart = (runs: RunService, db: Db): RunService => {
      const j = new RunJournal(db);
      return Object.assign(Object.create(runs) as RunService, {
        start: (p: { runId: string }) => {
          new RunRepo(db).create({ id: p.runId, playbookId: 'H-01', playbookVersion: '1', packageDigest: 'd', profileId: 'p', trigger: 'local', inputsHash: 'i' });
          j.append(p.runId, 'run.manual_done_requested', {});
          setTimeout(() => runs.emit('event', { runId: p.runId, type: 'end', status: 'failed', code: 'ledger.write_failed' } satisfies RunEvent), 20);
          return { runId: p.runId, intentId: 'I' };
        },
      });
    };
    const w = await world({ auto: fakeStart });
    const { k } = w.request();
    assert.equal((await w.until(k, 'held')).state, 'observed_manual');
    assert.deepEqual(w.ledger.byIssueKey(k).map((r) => [r.stepId, r.state]), [['manual.issue', 'observed_manual']]);
    assert.ok(!w.seen(k).includes('human') && !w.seen(k).includes('consent'), '직접 칸·동의 카드로 넘어가지 않는다');
    assert.equal(w.api!.calls, 0);
  });

  it('제품 실행기(IR): 발급되면 s21 원장 행에 발급 키가 붙고 issued, 메일 등 후속 행에는 붙지 않는다', async () => {
    const w = await world({ ir: true });
    const n = gateCount();
    const { k } = w.request();
    const req = await gateAfter(n);
    assert.deepEqual(w.runs.answer(approval(req)), { ok: true });
    const st = await w.until(k, 'issued');
    assert.equal(st.route, 'hometax.auto');
    assert.deepEqual(w.ledger.byIssueKey(k).map((r) => [r.stepId, r.state]), [['s21', 'committed']]);
    const others = w.db.prepare("SELECT step_id, issue_key FROM irreversible_log WHERE step_id <> 's21'").all() as Array<{ step_id: string; issue_key: string | null }>;
    assert.ok(others.every((r) => r.issue_key === null), JSON.stringify(others));
    assert.equal(w.api!.calls, 0);
  });

  it('제품 실행기(IR): 발급 결과 모름(in_doubt)이면 held, 동의 카드 없음, API 0', async () => {
    fx.knobs.dropIssue = true;
    try {
      const w = await world({ ir: true });
      const n = gateCount();
      const { k } = w.request();
      assert.deepEqual(w.runs.answer(approval(await gateAfter(n))), { ok: true });
      assert.equal((await w.until(k, 'held')).state, 'in_doubt');
      assert.ok(!w.seen(k).includes('consent'));
      assert.equal(w.api!.calls, 0);
    } finally {
      fx.knobs.dropIssue = false;
    }
  });

  it('RunService.start: 틀린 발급 키는 issue.bad_key, 같은 키에 미종결·발급됨 행이 있으면 브라우저를 열기 전에 ledger.issue_open·ledger.issue_committed', async () => {
    let opened = 0;
    const w = await world({ page: async () => (opened++, sharedPage()) });
    const p = { counterpartyId: w.cp, supply: 10_000, tax: 1_000, itemName: '경영 컨설팅' };
    const failsWith = (c: string) => (e: unknown) => e instanceof RunEnd && e.code === c;
    assert.throws(() => w.runs.start({ runId: 'x1', ...p, issueKey: 'not-a-ulid' }), failsWith('issue.bad_key'));
    const k = key();
    w.ledger.observedManual({ intentId: 'M1', stepId: 'manual.issue', runId: 'm', businessKey: 'bk', playbookId: 'hometax.taxinvoice.manual@1', inputsHash: 'i', packageDigest: 'd', actionHash: 'a', deviceId: 'dv', cpBizNoHmac: 'h', recipientEmailHmac: null, issueKey: k });
    assert.throws(() => w.runs.start({ runId: 'x2', ...p, issueKey: k }), failsWith('ledger.issue_open'));
    w.ledger.resolve('M1', 'manual.issue', 'committed', null, 'NTS-9');
    assert.throws(() => w.runs.start({ runId: 'x3', ...p, issueKey: k }), failsWith('ledger.issue_committed'));
    assert.equal(opened, 0);
    assert.equal(w.runs.activeRunId, null);
  });
});
