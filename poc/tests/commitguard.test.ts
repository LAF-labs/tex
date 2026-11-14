// M2-4 C 네트워크 커밋 가드(D03 §5.4, D02 §2.1, B-03·B-04, 금고 R-C1 #81).
// 원장은 실제 SQLite, 금고·CDP는 가짜. 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { GateRepo, Ledger, openDatabase, RunRepo, type ArmRow, type Db } from '@sax/db';
import {
  CommitGuard, commitExpectedHash, endpointUnion, EndpointClassifier, FetchInterceptor, knownUnion, pathGlob, pathShape, RateGuard, ratePolicyFrom, RunEnforcer,
  type CdpSessionLike, type CommitArmParams, type CommitGuardInput,
} from '@sax/engine';
import { clampPolicy, FORCED_STOPS, type CommitEndpoint, type EndpointMatch, type Policy } from '@sax/engine/core';
import { checkArmParams, commitExpectedHash as vaultHash, urlPatternToRegExp } from '@sax/vault';
import { POLICY_EXAMPLE } from './core-fixtures.ts';
import { FakeClock } from './core-page-fakes.ts';

const DOMAINS = ['www.hometax.go.kr', '*.hometax.go.kr'];
const H = 'https://www.hometax.go.kr';
const MAP = { counterpartBizNo: 'dmnrBsno', totalAmount: 'totaAmt' };
const ISSUE: CommitEndpoint = { match: { method: 'POST', pathPattern: '^/wqAction\\.do$', actionParam: { name: 'actionId', value: 'ATEETBDA001R01' } }, effect: 'issue_document', maxRequests: 1, encoding: 'form', bodyFieldMap: MAP };
const SEND: CommitEndpoint = { match: { method: 'POST', pathPattern: '^/mail/send/[^/]+$' }, effect: 'send', maxRequests: 2 };
const KNOWN: EndpointMatch[] = [{ method: 'GET', pathPattern: '^/static/.*$' }, { method: 'POST', pathPattern: '^/wqAction\\.do$', actionParam: { name: 'actionId', value: 'ATXPPZXA001R01' } }];
const ISSUE_URL = `${H}/wqAction.do?actionId=ATEETBDA001R01&screenId=UTEETBDA01`;
const HASH = commitExpectedHash({ counterpartBizNo: '1234567890', totalAmount: '110,000' }, MAP);

describe('커밋 가드: 합집합·분류·경로 변환', () => {
  it('합집합 = 같은 포털 패키지 commitEndpoints ∪ 핫픽스 commitEndpointsAdd(같은 항목 한 번), knownEndpoints도 합집합', () => {
    const u = endpointUnion([{ commitEndpoints: [ISSUE] }, { commitEndpoints: [structuredClone(ISSUE), SEND] }], [{ ...SEND, maxRequests: 1 }]);
    assert.equal(u.length, 3, '같은 항목은 한 번, maxRequests가 다르면 다른 항목');
    assert.equal(knownUnion([{ knownEndpoints: KNOWN }, { knownEndpoints: [KNOWN[0]!] }]).length, 2);
  });

  it('분류: 메서드+경로+액션 파라미터(쿼리 → form 본문 → 확인 못 하면 커밋으로), 포털 밖은 outside', () => {
    const c = new EndpointClassifier([ISSUE, SEND], KNOWN, DOMAINS);
    const k = (url: string, method = 'POST', o: { postData?: string; contentType?: string } = {}) => c.classify({ url, method, ...o }).kind;
    assert.equal(k(ISSUE_URL), 'commit');
    assert.equal(k(`${H}/wqAction.do?actionId=ATXPPZXA001R01`), 'known');
    assert.equal(k(`${H}/wqAction.do`, 'POST', { postData: 'actionId=ATEETBDA001R01&x=1', contentType: 'application/x-www-form-urlencoded; charset=UTF-8' }), 'commit', '본문의 액션 파라미터');
    assert.equal(k(`${H}/wqAction.do`, 'POST', { postData: 'actionId=ATXPPZXA001R01', contentType: 'application/x-www-form-urlencoded' }), 'known');
    assert.equal(k(`${H}/wqAction.do`, 'POST', { postData: null as unknown as string }), 'commit', '본문이 지워져 확인 못 하면 커밋(보수적)');
    assert.equal(k(`${H}/wqAction.do?actionId=ATEETBDA001R01`, 'GET'), 'unclassified', '메서드가 다르면 커밋 아님');
    assert.equal(k(`https://teht.hometax.go.kr/mail/send/abc`), 'commit', '*. 도메인 하위 호스트');
    assert.equal(k(`${H}/static/a.js`, 'GET'), 'known');
    assert.equal(k('https://example.com/wqAction.do?actionId=ATEETBDA001R01'), 'outside');
    assert.deepEqual(c.classify({ url: `${H}/ui/pp/UTXPP0123.xml?secret=1`, method: 'GET' }), { kind: 'unclassified', pathPattern: '/ui/pp/UTXPP{n}.xml' });
    assert.equal(pathShape('/a/1234/b'), '/a/{n}/b');
  });

  it('경로 RE2 → 금고 Fetch urlPattern: 고정 접두·리터럴·.*·[^/]+만, 액션 파라미터로 좁힘, 금고 검사·매칭과 맞는다', () => {
    const g = pathGlob(ISSUE.match)!;
    assert.equal(g, '/wqAction.do*actionId=ATEETBDA001R01*');
    const endpoint = `${H}${g}`;
    assert.equal(checkArmParams({ runId: 'r1', intentId: 'I1', stepId: 's21', targetId: 'T1', endpoint, method: 'POST', bodyFieldMap: MAP, expectedHash: HASH }, ['hometax.go.kr']), null);
    const re = urlPatternToRegExp(endpoint);
    assert.ok(re.test(ISSUE_URL));
    assert.ok(!re.test(`${H}/wqAction.do?actionId=ATXPPZXA001R01`), '같은 경로의 다른 액션은 금고가 대조하지 않는다');
    assert.equal(pathGlob(SEND.match), '/mail/send/**');
    assert.equal(pathGlob({ method: 'POST', pathPattern: '^/a\\*b$' }), '/a\\*b*', 'glob 특수 문자는 이스케이프');
    for (const bad of ['/no/anchor$', '^/(a|b)$', '^/a[0-9]$', '^/a+$', '^/\\d$']) assert.equal(pathGlob({ method: 'POST', pathPattern: bad }), null, bad);
  });

  it('R-C1 해시는 금고(#81)와 같다(키 순서·정규화)', () => {
    const v = { totalAmount: ' 110,000 ', counterpartBizNo: '1234567890' };
    assert.equal(commitExpectedHash(v, MAP), vaultHash(v, MAP));
    assert.equal(commitExpectedHash(v, { totalAmount: 'b', counterpartBizNo: 'a' }), vaultHash(v, MAP));
  });
});

describe('CommitGuard', () => {
  let root: string;
  let db: Db;
  let ledger: Ledger;
  let n = 0;
  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-cg-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    db = openDatabase(path.join(root, `${randomBytes(4).toString('hex')}.sqlite`), new Uint8Array(randomBytes(32)));
    ledger = new Ledger(db);
    new RunRepo(db).create({ id: 'r1', playbookId: 'p', playbookVersion: '1', packageDigest: 'd', profileId: 'x', trigger: 'local', inputsHash: 'i' });
  });
  afterEach(() => db.close());

  const row = (intentId: string): ArmRow => ({ intentId, stepId: 's21', runId: 'r1', businessKey: `bk-${intentId}`, playbookId: 'p', inputsHash: 'i', packageDigest: 'd', actionHash: 'a', deviceId: 'dv', cpBizNoHmac: 'h', recipientEmailHmac: null });
  /** 게이트 승인 → 토큰 소비 + 원장 armed(R-G7 앞부분). */
  const armLedger = (intentId: string) => {
    const g = new GateRepo(db);
    const req = `q${++n}`;
    g.open(req, 'r1');
    g.decide(req, 'approved', 'local');
    ledger.consumeAndArm(req, row(intentId));
  };

  const make = (o: Partial<CommitGuardInput> & { vaultResult?: { armed: boolean; reason?: 'already_armed' } } = {}) => {
    let t = 1_000;
    const journal: Array<[string, Record<string, unknown> | undefined]> = [];
    const security: string[] = [];
    const stops: string[] = [];
    const arms: CommitArmParams[] = [];
    const disarms: string[] = [];
    let manual: ArmRow | null = null;
    let sleepRelease: (() => void) | null = null;
    const r = CommitGuard.create({
      runId: 'r1', targetId: 'T1', mode: 'assisted', endpoints: [ISSUE, SEND], known: KNOWN, domains: DOMAINS,
      vault: { arm: async (p) => (arms.push(p), o.vaultResult ?? { armed: true }), disarm: async (p) => void disarms.push(p.intentId) },
      ledger, manualRow: () => manual, now: () => t,
      journal: (type, p) => journal.push([type, p]), security: (c) => security.push(c), stop: (c) => stops.push(c),
      sleep: () => new Promise<void>((res) => (sleepRelease = res)),
      ...o,
    });
    assert.ok(r.ok);
    return {
      g: r.guard, journal, security, stops, arms, disarms,
      setNow: (v: number) => (t = v), setManual: (m: ArmRow | null) => (manual = m),
      timeout: () => sleepRelease?.(),
      types: () => journal.map(([x]) => x),
    };
  };
  const post = (url: string) => ({ url, method: 'POST', postData: null, contentType: 'application/x-www-form-urlencoded' });

  it('SV-06 실행 시 확인: 합집합이 비면 auto·assisted로 만들지 않는다(postprocess는 됨)', () => {
    const base = { runId: 'r1', targetId: 'T1', known: [], domains: DOMAINS, vault: { arm: async () => ({ armed: true }), disarm: async () => {} }, ledger, manualRow: () => null, now: () => 0, journal: () => {}, security: () => {}, stop: () => {} };
    for (const mode of ['auto', 'assisted'] as const) {
      const r = CommitGuard.create({ ...base, mode, endpoints: [] });
      assert.ok(!r.ok && r.violations[0]!.rule === 'SV-06', mode);
    }
    assert.ok(CommitGuard.create({ ...base, mode: 'postprocess', endpoints: [] }).ok);
  });

  it('Running에서 무장 없는 커밋 요청은 차단 + commit_guard.blocked_request(보안) + 중단, 그 뒤 무장도 거부', async () => {
    const { g, security, stops } = make();
    assert.equal(await g.onRequest(post(`${H}/mail/send/x1`)), 'fail');
    assert.deepEqual(security, ['commit_guard.blocked_request']);
    assert.deepEqual(stops, ['commit_guard.blocked_request']);
    assert.equal(FORCED_STOPS.get('commit_guard.blocked_request'), 'abort');
    assert.equal(await g.onRequest({ url: `${H}/static/a.js`, method: 'GET' }), 'continue', '커밋이 아닌 요청은 그대로');
    const a = await g.arm({ intentId: 'I1', stepId: 's31', effect: 'send', armedUntil: 99_999, pageUrl: `${H}/x` });
    assert.deepEqual(a, { ok: false, code: 'commit_guard.arm_refused' });
  });

  it('무장(R-G7): 같은 효과·기한 안·엔드포인트별 maxRequests회만 통과, 넘거나 다른 효과·기한 지나면 차단', async () => {
    const m = make();
    assert.deepEqual(await m.g.arm({ intentId: 'I1', stepId: 's31', effect: 'send', armedUntil: 5_000, pageUrl: `${H}/x` }), { ok: true });
    assert.equal(m.arms.length, 0, 'bodyFieldMap 없는 엔드포인트는 금고 무장 없음');
    assert.equal(await m.g.onRequest(post(`${H}/mail/send/a`)), 'continue');
    assert.equal(await m.g.onRequest(post(`${H}/mail/send/b`)), 'continue');
    assert.equal(await m.g.onRequest(post(`${H}/mail/send/c`)), 'fail', 'maxRequests 2');
    assert.deepEqual(m.stops, ['commit_guard.blocked_request']);

    const m2 = make();
    await m2.g.arm({ intentId: 'I2', stepId: 's31', effect: 'send', armedUntil: 5_000, pageUrl: `${H}/x` });
    assert.equal(await m2.g.onRequest(post(ISSUE_URL)), 'fail', '무장한 효과와 다른 커밋');

    const m3 = make();
    await m3.g.arm({ intentId: 'I3', stepId: 's31', effect: 'send', armedUntil: 5_000, pageUrl: `${H}/x` });
    m3.setNow(5_000);
    assert.ok(!m3.g.isArmed);
    assert.equal(await m3.g.onRequest(post(`${H}/mail/send/a`)), 'fail', 'armedUntil 지남');
    const m4 = make();
    assert.equal((await m4.g.arm({ intentId: 'I4', stepId: 's31', effect: 'sign', armedUntil: 5_000, pageUrl: `${H}/x` })).ok, false, '선언된 엔드포인트가 없는 효과');
    assert.equal((await m4.g.arm({ intentId: 'I4', stepId: 's31', effect: 'send', armedUntil: 500, pageUrl: `${H}/x` })).ok, false, '이미 지난 기한');
  });

  it('R-C1 ①: bodyFieldMap 엔드포인트는 클릭 직전 금고 commitGuard.arm(호스트 고정 endpoint, method, expectedHash)', async () => {
    const m = make();
    const plan = m.g.plan('issue_document');
    assert.ok(plan.ok && plan.bodyFieldMap);
    assert.deepEqual(plan.bodyFieldMap, MAP);
    assert.deepEqual(await m.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: `${H}/websquare/x?y=1` }), { ok: true });
    assert.deepEqual(m.arms, [{ runId: 'r1', intentId: 'I1', stepId: 's21', targetId: 'T1', endpoint: `${H}/wqAction.do*actionId=ATEETBDA001R01*`, method: 'POST', bodyFieldMap: MAP, expectedHash: HASH }]);
    assert.equal((await m.g.arm({ intentId: 'I9', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H })).ok, false, '타깃당 한 무장');
    await m.g.disarm();
    assert.deepEqual(m.disarms, ['I1'], '요청 전 해제는 금고 무장도 푼다');

    const bad = make({ vaultResult: { armed: false, reason: 'already_armed' } });
    assert.deepEqual(await bad.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H }), { ok: false, code: 'commit_guard.arm_refused' });
    assert.deepEqual(bad.journal.at(-1), ['commit_guard.arm_refused', { reason: 'vault_already_armed' }]);
    assert.equal((await make().g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, pageUrl: H })).ok, false, 'expectedHash 없음');
    assert.equal((await make().g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: 'http://www.hometax.go.kr/' })).ok, false, 'https만');
  });

  it('R-C1: 같은 효과의 대조 대상이 둘이면(금고는 타깃당 하나) 무장 거부', async () => {
    const other: CommitEndpoint = { ...ISSUE, match: { method: 'POST', pathPattern: '^/issue2$' } };
    const r = CommitGuard.create({ runId: 'r1', targetId: 'T1', mode: 'auto', endpoints: [ISSUE, other], known: [], domains: DOMAINS, vault: { arm: async () => ({ armed: true }), disarm: async () => {} }, ledger, manualRow: () => null, now: () => 0, journal: () => {}, security: () => {}, stop: () => {} });
    assert.ok(r.ok);
    assert.deepEqual(r.guard.plan('issue_document'), { ok: false, code: 'commit_guard.arm_refused' });
  });

  it('R-C1 ③: 무장된 요청이 엔진에 오면 금고 결과(true·opaque)를 본 뒤에만 이어 보내고, 결과가 없으면 막는다', async () => {
    for (const match of [true, 'opaque'] as const) {
      const m = make();
      await m.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H });
      const d = m.g.onRequest(post(ISSUE_URL));
      m.g.onBodyCompared({ intentId: 'I1', stepId: 's21', match });
      assert.equal(await d, 'continue', String(match));
      assert.deepEqual(m.journal.at(-1), ['commit_guard.passed', { effect: 'issue_document', match: String(match) }]);
    }
    const early = make();
    await early.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H });
    early.g.onBodyCompared({ intentId: 'I1', stepId: 's21', match: true });
    assert.equal(await early.g.onRequest(post(ISSUE_URL)), 'continue', '결과가 먼저 와도');
    const none = make();
    await none.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H });
    const d = none.g.onRequest(post(ISSUE_URL));
    none.timeout();
    assert.equal(await d, 'fail');
    assert.ok(none.types().includes('commit_guard.rc1_missing'));
    assert.deepEqual(none.stops, ['commit_guard.blocked_request']);
    const other = make();
    await other.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H });
    other.g.onBodyCompared({ intentId: 'I2', stepId: 's21', match: false });
    assert.equal(other.security.length, 0, '다른 의도의 결과는 무시');
  });

  it('R-C1 ④: match:false → security.commit_payload_mismatch, 원장 not_committed(payload_mismatch), 핸드오프', async () => {
    armLedger('I1');
    ledger.dispatched('I1', 's21');
    const m = make();
    await m.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H });
    m.g.onBodyCompared({ intentId: 'I1', stepId: 's21', match: false });
    assert.deepEqual(m.security, ['security.commit_payload_mismatch']);
    assert.deepEqual([ledger.get('I1', 's21')!.state, ledger.get('I1', 's21')!.reason], ['not_committed', 'payload_mismatch']);
    assert.deepEqual(m.stops, ['security.commit_payload_mismatch']);
    assert.equal(FORCED_STOPS.get('security.commit_payload_mismatch'), 'handoff');
    assert.ok(!m.g.isArmed);
    assert.equal(await m.g.onRequest(post(ISSUE_URL)), 'fail', '금고가 막은 뒤 같은 요청이 다시 와도 막는다');
  });

  it('R-C1 expired: 요청 없이 금고 무장이 끝나면 기록만(원장은 그대로)', async () => {
    const m = make();
    await m.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H });
    m.g.onBodyCompared({ intentId: 'I1', stepId: 's21', match: 'expired' });
    assert.deepEqual(m.journal.at(-1), ['commit_guard.arm_expired', { effect: 'issue_document' }]);
    assert.deepEqual([m.security, m.stops], [[], []]);
  });

  it('R-C2: 핸드오프·manual 중에는 막지 않고 관측 → 원장 observed_manual → in_doubt, ledger.observed_manual', async () => {
    armLedger('I1');
    const m = make();
    m.g.setMode('observing');
    m.setManual(row('I1'));
    assert.equal(await m.g.onRequest(post(ISSUE_URL)), 'continue');
    assert.equal(ledger.get('I1', 's21')!.state, 'in_doubt');
    assert.deepEqual(m.journal.at(-1), ['ledger.observed_manual', { effect: 'issue_document', bound: true, intentId: 'I1', stepId: 's21', state: 'in_doubt' }]);
    assert.ok(m.g.observedManual);
    assert.deepEqual([m.security, m.stops], [[], []]);
    // 원장 행이 아직 없는 의도(게이트 전 핸드오프)도 행을 넣고 in_doubt
    m.setManual(row('I2'));
    await m.g.onRequest(post(`${H}/mail/send/z`));
    assert.equal(ledger.get('I2', 's21')!.state, 'in_doubt');
    // 묶을 의도가 없으면 기록만
    m.setManual(null);
    await m.g.onRequest(post(`${H}/mail/send/z`));
    assert.deepEqual(m.journal.at(-1), ['ledger.observed_manual', { effect: 'send', bound: false }]);
    // Running으로 돌아오면 다시 무장 없이는 막는다
    m.g.setMode('running');
    assert.equal(await m.g.onRequest(post(`${H}/mail/send/z`)), 'fail');
  });

  it('R-C3: 어느 목록에도 없는 포털 요청은 commit_guard.unclassified{pathPattern}(쿼리 없음, 모양마다 한 번)', async () => {
    const m = make();
    for (const u of [`${H}/ui/a/1.xml?q=secret`, `${H}/ui/a/22.xml`, `${H}/ui/b.xml`]) assert.equal(await m.g.onRequest({ url: u, method: 'GET' }), 'continue');
    assert.deepEqual(m.journal, [['commit_guard.unclassified', { pathPattern: '/ui/a/{n}.xml' }], ['commit_guard.unclassified', { pathPattern: '/ui/b.xml' }]]);
    assert.ok(!JSON.stringify(m.journal).includes('secret'));
  });

  it('잡지 못한 커밋 요청(고정 전 호스트): Running이면 중단 + 무장된 의도는 in_doubt', async () => {
    armLedger('I1');
    const m = make();
    await m.g.arm({ intentId: 'I1', stepId: 's31', effect: 'send', armedUntil: 99_999, pageUrl: H });
    m.g.onUnintercepted({ url: 'https://teht.hometax.go.kr/static/a.js', method: 'GET' });
    assert.deepEqual(m.stops, [], '커밋이 아닌 요청은 무시');
    m.g.onUnintercepted(post(`https://teht.hometax.go.kr/mail/send/a`));
    assert.deepEqual(m.stops, ['commit_guard.unintercepted'], '무장돼 있어도 잡지 못했으면 중단');
    assert.equal(ledger.get('I1', 's21')!.state, 'armed', '다른 스텝 행은 그대로');
    const m2 = make();
    await m2.g.arm({ intentId: 'I1', stepId: 's21', effect: 'issue_document', armedUntil: 99_999, readbackHash: HASH, pageUrl: H });
    m2.g.onUnintercepted(post('https://teht.hometax.go.kr/wqAction.do?actionId=ATEETBDA001R01'));
    assert.deepEqual(m2.stops, ['commit_guard.unintercepted']);
    assert.equal(ledger.get('I1', 's21')!.state, 'in_doubt');
    assert.equal(FORCED_STOPS.get('commit_guard.unintercepted'), 'abort');
  });
});

class FakeSession implements CdpSessionLike {
  sent: Array<[string, Record<string, unknown> | undefined]> = [];
  private readonly fns = new Map<string, Set<(p: Record<string, unknown>) => void>>();
  async send(method: string, params?: Record<string, unknown>) {
    this.sent.push([method, params]);
    return {};
  }
  on(e: string, fn: (p: Record<string, unknown>) => void) {
    if (!this.fns.has(e)) this.fns.set(e, new Set());
    this.fns.get(e)!.add(fn);
  }
  off(e: string, fn: (p: Record<string, unknown>) => void) {
    this.fns.get(e)?.delete(fn);
  }
  emit(e: string, p: Record<string, unknown>) {
    for (const fn of this.fns.get(e) ?? []) fn(p);
  }
  patterns() {
    return this.sent.filter(([m]) => m === 'Fetch.enable').map(([, p]) => (p!.patterns as Array<{ urlPattern: string; requestStage: string }>));
  }
}
const flush = () => new Promise((r) => setImmediate(r));

describe('FetchInterceptor(CDP 배선, R-C1 ②③)', () => {
  const guardOf = (stops: string[]) => {
    const r = CommitGuard.create({ runId: 'r1', targetId: 'T1', mode: 'assisted', endpoints: [ISSUE, SEND], known: KNOWN, domains: DOMAINS, vault: { arm: async () => ({ armed: true }), disarm: async () => {} }, ledger: { resolve: () => {}, observedManual: () => {} }, manualRow: () => null, now: () => 0, journal: () => {}, security: () => {}, stop: (c) => stops.push(c) });
    assert.ok(r.ok);
    return r.guard;
  };

  it('Fetch.enable은 호스트 고정 패턴만(요청 단계), *. 도메인은 본 호스트를 더해 다시 건다', async () => {
    const s = new FakeSession();
    const f = new FetchInterceptor({ session: s, guard: guardOf([]), domains: DOMAINS, journal: () => {} });
    await f.start();
    assert.deepEqual(s.sent.slice(0, 2).map(([m]) => m), ['Network.enable', 'Page.enable']);
    assert.deepEqual(s.patterns(), [[{ urlPattern: 'https://www.hometax.go.kr/*', requestStage: 'Request' }]]);
    s.emit('Page.frameNavigated', { frame: { url: 'https://teht.hometax.go.kr/websquare/a' } });
    s.emit('Page.frameNavigated', { frame: { url: 'https://example.com/' } });
    s.emit('Page.frameNavigated', { frame: { url: 'http://tecr.hometax.go.kr/' } });
    await flush();
    assert.deepEqual(s.patterns().at(-1)!.map((p) => p.urlPattern), ['https://teht.hometax.go.kr/*', 'https://www.hometax.go.kr/*']);
    assert.equal(s.patterns().length, 2, '밖·http 호스트는 넣지 않는다');
    for (const p of s.patterns().flat()) assert.ok(!/^https:\/\/\*|^\*/.test(p.urlPattern), '와일드카드 호스트 없음');
    assert.deepEqual(f.hosts, ['teht.hometax.go.kr', 'www.hometax.go.kr']);
    await f.stop();
    assert.equal(s.sent.at(-1)![0], 'Fetch.disable');
  });

  it('requestPaused → 가드 판정대로 continueRequest | failRequest(BlockedByClient)', async () => {
    const s = new FakeSession();
    const stops: string[] = [];
    const f = new FetchInterceptor({ session: s, guard: guardOf(stops), domains: DOMAINS, journal: () => {} });
    await f.start();
    s.emit('Fetch.requestPaused', { requestId: 'a', request: { url: `${H}/static/x.js`, method: 'GET', headers: {} } });
    s.emit('Fetch.requestPaused', { requestId: 'b', request: { url: `${H}/mail/send/q`, method: 'POST', headers: { 'Content-Type': 'application/json' } } });
    await flush();
    const cmds = s.sent.filter(([m]) => m.startsWith('Fetch.') && m !== 'Fetch.enable');
    assert.deepEqual(cmds, [['Fetch.continueRequest', { requestId: 'a' }], ['Fetch.failRequest', { requestId: 'b', errorReason: 'BlockedByClient' }]]);
    assert.deepEqual(stops, ['commit_guard.blocked_request']);
  });

  it('고정 전 호스트로 간 커밋 요청은 Network로만 보인다 → 가드 onUnintercepted, 그 호스트를 고정', async () => {
    const s = new FakeSession();
    const stops: string[] = [];
    const f = new FetchInterceptor({ session: s, guard: guardOf(stops), domains: DOMAINS, journal: () => {} });
    await f.start();
    s.emit('Network.requestWillBeSent', { requestId: '1', type: 'XHR', request: { url: `${H}/mail/send/q`, method: 'POST' } });
    assert.deepEqual(stops, [], '고정된 호스트는 Fetch가 잡는다');
    s.emit('Network.requestWillBeSent', { requestId: '2', type: 'XHR', request: { url: 'https://teht.hometax.go.kr/mail/send/q', method: 'POST' } });
    assert.deepEqual(stops, ['commit_guard.unintercepted']);
    await flush();
    assert.deepEqual(f.hosts, ['teht.hometax.go.kr', 'www.hometax.go.kr']);
  });
});

describe('가드 정지 → 집행기 걸쇠 → 실행기', () => {
  it('RunEnforcer.haltFor: 그 뒤 동작·스텝이 그 코드로 멈추고, 포털 신호에 덮이지 않는다', async () => {
    const dbRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-cg-e-'));
    const d = openDatabase(path.join(dbRoot, 'a.sqlite'), new Uint8Array(randomBytes(32)));
    try {
      const clock = new FakeClock();
      const POLICY = clampPolicy(structuredClone(POLICY_EXAMPLE) as unknown as Policy).policy;
      const rg = new RateGuard(d, 'hometax', ratePolicyFrom(POLICY, 'hometax', 'interactive')!, { wall: () => Date.parse('2026-11-06T01:00:00Z') + clock.t, mono: () => clock.t });
      const latched: string[] = [];
      const e = new RunEnforcer({ guard: rg, clock, mono: () => clock.t, dict: [{ id: 't.block', kind: 'block', text: '이용이 제한되었습니다', source: '시험' }], profileId: 'p1', journal: () => {}, onLatch: (c) => latched.push(c), random: () => 0.5 });
      e.haltFor('security.commit_payload_mismatch');
      e.observe({ text: '이용이 제한되었습니다' });
      assert.equal(e.halted, 'security.commit_payload_mismatch');
      assert.deepEqual(await e.beforeAction('click'), { ok: false, code: 'security.commit_payload_mismatch' });
      assert.deepEqual(await e.beforeStep(), { ok: false, code: 'security.commit_payload_mismatch' });
      assert.deepEqual(latched, ['security.commit_payload_mismatch']);
    } finally {
      d.close();
      await fsp.rm(dbRoot, { recursive: true, force: true });
    }
  });
});
