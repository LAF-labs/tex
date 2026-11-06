// R-C1 커밋 본문 대조(D05 §3.3, D03 §5.4, ADR-005 v3 결정 10): 금고가 커밋 요청 본문을 기대 해시와 비교하고,
// 다르면 막고(Fetch.failRequest), 엔진에는 결과만 알린다. 본문·값은 엔진·로그에 가지 않는다.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  checkArmParams, COMMIT_ARM_TTL_MS, commitExpectedHash, CommitGuard, extractCommitValues, jsonAt, parseXml, urlPatternToRegExp, xmlAt,
  type CommitBodyComparedEvent,
} from '@sax/vault';
import { fakeRelay, tick, type FakeRelay } from './fake-relay.ts';
import { startFixture, type Fixture } from './fixtures/server.ts';
import { startHarness, type Harness } from './harness.ts';
import { RawEngine } from './raw-engine.ts';

const ORIGIN = 'http://127.0.0.1:1';
const MAP = { supplierBizNo: 'bizNo', amount: 'amt', item: 'item' };
const VALUES = { supplierBizNo: '1234567890', amount: '1000000', item: '컨설팅 용역' };
const FORM = 'bizNo=1234567890&amt=1000000&item=%EC%BB%A8%EC%84%A4%ED%8C%85+%EC%9A%A9%EC%97%AD&other=x';
const arm = (over: Record<string, unknown> = {}) => ({
  runId: 'r1', intentId: 'i1', stepId: 's1', targetId: 'RUN', endpoint: `${ORIGIN}/submit*`,
  bodyFieldMap: MAP, expectedHash: commitExpectedHash(VALUES, MAP), ...over,
});
const formHeaders = { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' };
const paused = (over: Record<string, unknown> = {}, req: Record<string, unknown> = {}) => ({
  requestId: 'interception-job-1.0', networkId: 'N1', frameId: 'RUN', resourceType: 'Document',
  request: { url: `${ORIGIN}/submit`, method: 'POST', headers: formHeaders, postData: FORM, hasPostData: true, ...req }, ...over,
});

async function guarded(ttlMs?: number): Promise<FakeRelay & { results: CommitBodyComparedEvent[]; guard: CommitGuard }> {
  const f = await fakeRelay();
  const results: CommitBodyComparedEvent[] = [];
  const guard = new CommitGuard({
    log: f.log, allowedHosts: ['127.0.0.1'], emit: (d) => results.push(d),
    send: (m, p, sid) => f.conn.send(m, p, sid), exposed: (id) => !!f.relay.exposedTarget(id), ttlMs,
  });
  f.relay.commitGuard = guard;
  return Object.assign(f, { results, guard });
}

async function emitPaused(f: FakeRelay, params: Record<string, unknown>, sid = f.sid) {
  f.conn.emitEvent('Fetch.requestPaused', params, sid);
  await tick(5);
  await f.relay.drained();
}
const engineGot = (f: FakeRelay, method: string) => f.toEngine.filter((m) => m.method === method);

describe('R-C1 본문 해석(form·json·xml)', () => {
  it('form: 이름으로 꺼내고(+·%인코딩 풀기), 같은 해시가 나온다', () => {
    const r = extractCommitValues('application/x-www-form-urlencoded', FORM, MAP);
    assert.deepEqual(r, { kind: 'values', values: VALUES });
    assert.equal(commitExpectedHash((r as { values: Record<string, string> }).values, MAP), commitExpectedHash(VALUES, MAP));
  });

  it('form: 필드가 없거나 같은 이름이 둘이면 mismatch(막는다)', () => {
    assert.deepEqual(extractCommitValues('application/x-www-form-urlencoded', 'bizNo=1&amt=2', MAP), { kind: 'mismatch', why: 'missing' });
    assert.deepEqual(extractCommitValues('application/x-www-form-urlencoded', FORM + '&amt=9', MAP), { kind: 'mismatch', why: 'missing' });
  });

  it('json: a.b[0].c 경로, 숫자·불리언은 문자열로, 객체·없는 경로는 mismatch', () => {
    const body = JSON.stringify({ inv: { lines: [{ amt: 1000000, item: '컨설팅 용역' }], biz: { no: '1234567890' } }, ok: true });
    const map = { amount: 'inv.lines[0].amt', item: 'inv.lines[0].item', supplierBizNo: 'inv.biz.no' };
    assert.deepEqual(extractCommitValues('application/json;charset=utf-8', body, map), { kind: 'values', values: VALUES });
    assert.equal(jsonAt(JSON.parse(body), 'ok'), 'true');
    for (const bad of ['inv', 'inv.lines', 'inv.lines[1].amt', 'inv..biz', '.inv', 'inv.', '[0]', 'inv.lines[x]', 'toString', 'inv.biz.no.length']) {
      assert.equal(jsonAt(JSON.parse(body), bad), undefined, bad);
    }
    assert.deepEqual(extractCommitValues('application/json', '{bad', map), { kind: 'mismatch', why: 'parse' });
    assert.deepEqual(extractCommitValues('application/vnd.api+json', body, { amount: 'inv.nope' }), { kind: 'mismatch', why: 'missing' });
  });

  it('xml: xml:/root/a/b 잎 요소 텍스트(엔티티·CDATA·접두사), DOCTYPE·형식 오류·중복 경로는 거부', () => {
    const xml = `<?xml version="1.0"?><!-- c --><map id="x"><w:biz>1234567890</w:biz><amt>1000000</amt><item><![CDATA[컨설팅]]>&#32;&#xC6A9;역</item><n a="1>2"/></map>`;
    const map = { supplierBizNo: 'xml:/map/biz', amount: 'xml:/map/amt', item: 'xml:/map/item' };
    assert.deepEqual(extractCommitValues('text/xml; charset=UTF-8', xml, map), { kind: 'values', values: VALUES });
    const doc = parseXml('<a><b>1</b><b>2</b><c><d>x</d></c><e>&lt;&amp;&gt;&quot;&apos;</e></a>')!;
    assert.equal(xmlAt(doc, ['a', 'b']), undefined, '같은 경로 둘');
    assert.equal(xmlAt(doc, ['a', 'c']), undefined, '자식이 있는 요소');
    assert.equal(xmlAt(doc, ['a', 'c', 'd']), 'x');
    assert.equal(xmlAt(doc, ['a', 'e']), `<&>"'`);
    for (const bad of ['<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', '<a><b></a></b>', '<a>&x;</a>', '<a>a & b</a>', '<a></a><b></b>', 'x<a/>', '<a>', '<a><![CDATA[x</a>']) {
      assert.equal(parseXml(bad), null, bad);
    }
    assert.deepEqual(extractCommitValues('application/xml', '<a>', { k: 'xml:/a' }), { kind: 'mismatch', why: 'parse' });
    assert.deepEqual(extractCommitValues('application/xml', '<a>1</a>', { k: '/a' }), { kind: 'mismatch', why: 'missing' }, 'xml 경로는 xml:/로');
  });

  it('평문 형식이 아니거나 본문이 없으면 opaque', () => {
    for (const ct of [undefined, '', 'multipart/form-data; boundary=x', 'application/octet-stream', 'text/plain']) {
      assert.deepEqual(extractCommitValues(ct, 'bizNo=1', MAP), { kind: 'opaque' }, String(ct));
    }
    assert.deepEqual(extractCommitValues('application/json', null, MAP), { kind: 'opaque' });
    assert.deepEqual(extractCommitValues('application/json', '', MAP), { kind: 'opaque' });
  });

  it('urlPattern: * 임의, ? 한 글자, \\ 다음 글자 그대로, 나머지는 문자 그대로', () => {
    const re = urlPatternToRegExp('https://hometax.go.kr/wqAction.do?actionId=ATTABZAA001R0*');
    assert.ok(re.test('https://hometax.go.kr/wqAction.do?actionId=ATTABZAA001R01&x=1'));
    assert.ok(re.test('https://hometax.go.kr/wqAction.doXactionId=ATTABZAA001R0'), '?는 한 글자');
    assert.ok(!re.test('https://evil.example/wqAction.do?actionId=ATTABZAA001R0'));
    assert.ok(urlPatternToRegExp('https://a.kr/x\\?y').test('https://a.kr/x?y'));
    assert.ok(!urlPatternToRegExp('https://a.kr/x\\?y').test('https://a.kr/xZy'));
    assert.ok(!urlPatternToRegExp('https://a.kr/a.b').test('https://a.kr/aXb'), '.은 문자 그대로');
  });
});

describe('commitGuard.arm 인자 검사', () => {
  it('맞는 인자는 통과, 틀린 인자는 bad_params, 허용 밖 호스트·와일드카드 호스트는 endpoint_not_allowed', () => {
    const hosts = ['127.0.0.1', 'hometax.go.kr'];
    assert.equal(checkArmParams(arm(), hosts), null);
    assert.equal(checkArmParams(arm({ endpoint: 'https://www.hometax.go.kr/wqAction.do*', method: 'PUT' }), hosts), null);
    for (const bad of [
      null, 'x', arm({ runId: 'bad id' }), arm({ intentId: '' }), arm({ stepId: 'x'.repeat(129) }), arm({ targetId: 1 }),
      arm({ method: 'post' }), arm({ expectedHash: 'abc' }), arm({ expectedHash: 'A'.repeat(64) }), arm({ bodyFieldMap: {} }),
      arm({ bodyFieldMap: [] }), arm({ bodyFieldMap: { 'a b': 'x' } }), arm({ bodyFieldMap: { a: '' } }), arm({ bodyFieldMap: { a: 1 } }),
      arm({ bodyFieldMap: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, 'x'])) }), arm({ endpoint: '' }),
    ]) assert.equal(checkArmParams(bad, hosts), 'bad_params', JSON.stringify(bad));
    for (const ep of ['https://evil.example/submit', 'https://*.go.kr/x', 'https://hometax.go.kr.evil.example/x', '*', 'file:///x', 'https://hometax.go.kr']) {
      assert.equal(checkArmParams(arm({ endpoint: ep }), hosts), 'endpoint_not_allowed', ep);
    }
  });

  it('노출 안 된 타깃·같은 타깃 이중 무장은 거부', async () => {
    const f = await guarded();
    assert.deepEqual(f.guard.arm(arm({ targetId: 'NOPE' })), { armed: false, reason: 'target_not_exposed' });
    assert.deepEqual(f.guard.arm(arm()), { armed: true });
    assert.deepEqual(f.guard.arm(arm()), { armed: false, reason: 'already_armed' });
    assert.deepEqual(f.guard.arm(arm({ intentId: 'i2' })), { armed: false, reason: 'already_armed' }, '타깃당 하나');
    f.guard.shutdown();
  });
});

describe('R-C1 대조(가짜 Chrome)', () => {
  it('일치: 엔진에 본문 없는 requestPaused가 가고 match:true, 본문 조회는 거부', async () => {
    const f = await guarded();
    f.guard.arm(arm());
    await emitPaused(f, paused());
    assert.deepEqual(f.results, [{ intentId: 'i1', stepId: 's1', match: true }]);
    const ev = engineGot(f, 'Fetch.requestPaused');
    assert.equal(ev.length, 1);
    const out = JSON.stringify(ev);
    assert.doesNotMatch(out, /postData|hasPostData|bizNo|1234567890/);
    assert.ok(!f.conn.sent.some((m) => m.method === 'Fetch.failRequest'));
    assert.ok((await f.call('Network.getRequestPostData', { requestId: 'N1' })).error, '엔진은 그 본문을 읽지 못한다');
    assert.equal(f.guard.armedCount, 0, '한 무장에 한 요청');
    assert.ok(!f.log.lines.some((l) => /1234567890|컨설팅|bizNo/.test(l)), '로그에 값·필드 경로 없음');
  });

  it('불일치: 금고가 Fetch.failRequest로 막고 이벤트는 엔진에 안 간다, 엔진의 continue·fulfill도 거부', async () => {
    const f = await guarded();
    f.guard.arm(arm());
    await emitPaused(f, paused({}, { postData: FORM.replace('amt=1000000', 'amt=9000000') }));
    assert.deepEqual(f.results, [{ intentId: 'i1', stepId: 's1', match: false }]);
    const fail = f.conn.sent.find((m) => m.method === 'Fetch.failRequest');
    assert.deepEqual(fail, { method: 'Fetch.failRequest', params: { requestId: 'interception-job-1.0', errorReason: 'BlockedByClient' }, sessionId: f.sid });
    assert.equal(engineGot(f, 'Fetch.requestPaused').length, 0);
    for (const m of ['Fetch.continueRequest', 'Fetch.failRequest']) {
      const r = await f.call(m, { requestId: 'interception-job-1.0' });
      assert.match(String((r.error as { message?: string })?.message), /commit_blocked/, m);
    }
    assert.ok(f.log.lines.some((l) => l.includes('"vault.commit_compared"') && l.includes('"match":false')));
    assert.ok(!f.log.lines.some((l) => /9000000|1000000/.test(l)));
  });

  it('필드 없음·해석 실패도 막는다(fail-closed)', async () => {
    for (const req of [{ postData: 'bizNo=1234567890' }, { headers: { 'content-type': 'application/json' }, postData: '{bad' }]) {
      const f = await guarded();
      f.guard.arm(arm());
      await emitPaused(f, paused({}, req));
      assert.deepEqual(f.results.map((r) => r.match), [false]);
      assert.ok(f.conn.sent.some((m) => m.method === 'Fetch.failRequest'));
    }
  });

  it('opaque(평문 형식 아님·본문 없음): 막지 않고 본문만 지워 넘긴다', async () => {
    const f = await guarded();
    f.guard.arm(arm());
    await emitPaused(f, paused({}, { headers: { 'Content-Type': 'application/octet-stream' }, postData: 'ENC:abcd' }));
    assert.deepEqual(f.results.map((r) => r.match), ['opaque']);
    assert.equal(engineGot(f, 'Fetch.requestPaused').length, 1);
    assert.doesNotMatch(JSON.stringify(f.toEngine), /ENC:abcd/);
    assert.ok(!f.conn.sent.some((m) => m.method === 'Fetch.failRequest'));
  });

  it('postDataEntries(base64)를 쓰고, 본문이 빠졌으면 Network.getRequestPostData로 읽는다(이진이면 opaque)', async () => {
    const a = await guarded();
    a.guard.arm(arm());
    await emitPaused(a, paused({}, { postData: undefined, postDataEntries: [{ bytes: Buffer.from(FORM.slice(0, 10)).toString('base64') }, { bytes: Buffer.from(FORM.slice(10)).toString('base64') }] }));
    assert.deepEqual(a.results.map((r) => r.match), [true]);
    const b = await guarded();
    b.conn.handlers.set('Network.getRequestPostData', (p) => (p.requestId === 'N1' ? { postData: Buffer.from(FORM).toString('base64'), base64Encoded: true } : {}));
    b.guard.arm(arm());
    await emitPaused(b, paused({}, { postData: undefined }));
    assert.deepEqual(b.results.map((r) => r.match), [true]);
    assert.ok(b.conn.sent.some((m) => m.method === 'Network.getRequestPostData' && m.sessionId === b.sid));
    const c = await guarded();
    c.conn.handlers.set('Network.getRequestPostData', () => ({ postData: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), base64Encoded: true }));
    c.guard.arm(arm());
    await emitPaused(c, paused({}, { postData: undefined }));
    assert.deepEqual(c.results.map((r) => r.match), ['opaque']);
  });

  it('무장 대상이 아닌 요청(다른 경로·메서드·타깃, 응답 단계)은 그대로 넘기고 대조하지 않는다', async () => {
    const f = await guarded();
    f.guard.arm(arm());
    await emitPaused(f, paused({ requestId: 'j2' }, { url: `${ORIGIN}/other` }));
    await emitPaused(f, paused({ requestId: 'j3' }, { method: 'GET' }));
    await emitPaused(f, paused({ requestId: 'j4', responseStatusCode: 200 }));
    assert.deepEqual(f.results, []);
    assert.equal(engineGot(f, 'Fetch.requestPaused').length, 3);
    assert.equal(f.guard.armedCount, 1);
    // 무장 대상의 Network.requestWillBeSent도 본문을 지운다
    f.conn.emitEvent('Network.requestWillBeSent', { requestId: 'N7', request: { url: `${ORIGIN}/submit`, method: 'POST', postData: FORM, hasPostData: true } }, f.sid);
    await tick(5);
    await f.relay.drained();
    assert.doesNotMatch(JSON.stringify(engineGot(f, 'Network.requestWillBeSent')), /bizNo/);
    f.guard.shutdown();
  });

  it('두 번째 일치 요청은 대조하지 않는다(한 무장 한 요청), disarm·run.end는 알림 없이 푼다', async () => {
    const f = await guarded();
    f.guard.arm(arm());
    await emitPaused(f, paused());
    await emitPaused(f, paused({ requestId: 'j2' }, { postData: 'bizNo=evil' }));
    assert.equal(f.results.length, 1);
    f.guard.arm(arm({ intentId: 'i2' }));
    f.guard.disarm({ intentId: 'i2', stepId: 's1' });
    f.guard.arm(arm({ intentId: 'i3' }));
    f.guard.clearRun('r1');
    assert.equal(f.guard.armedCount, 0);
    await emitPaused(f, paused({ requestId: 'j3' }, { postData: 'bizNo=evil' }));
    assert.equal(f.results.length, 1);
  });

  it(`무장 뒤 TTL(기본 ${COMMIT_ARM_TTL_MS}ms) 안에 요청이 없으면 expired`, async () => {
    const f = await guarded(30);
    f.guard.arm(arm());
    await tick(60);
    assert.deepEqual(f.results, [{ intentId: 'i1', stepId: 's1', match: 'expired' }]);
    assert.equal(f.guard.armedCount, 0);
    await emitPaused(f, paused({}, { postData: 'bizNo=evil' }));
    assert.equal(f.results.length, 1, '만료 뒤 요청은 대조하지 않는다');
  });
});

describe('R-C1 대조(실제 Chrome, 금고 서비스)', () => {
  let fx: Fixture;
  let h: Harness;
  let eng: RawEngine;
  let sid: string;
  let targetId: string;

  before(async () => {
    fx = await startFixture();
    h = await startHarness();
    eng = new RawEngine(h.client);
    await h.client.rpc('browser.launch');
    ({ sessionId: sid, targetId } = await eng.attachRunPage());
    await eng.send('Network.enable', {}, sid);
    await eng.send('Fetch.enable', { patterns: [{ urlPattern: `${fx.origin}/submit*`, requestStage: 'Request' }] }, sid);
  });

  after(async () => {
    await h.close();
    await fx.close();
  });

  const map = { user: 'user', note: 'note' };
  const submit = async (user: string, note: string) => {
    await eng.navigate(sid, `${fx.origin}/login`);
    await eng.evaluate(sid, `document.getElementById('user').value=${JSON.stringify(user)};document.getElementById('note').value=${JSON.stringify(note)};document.getElementById('f').submit()`);
  };
  const armFor = (intentId: string, values: Record<string, string>) =>
    h.client.rpc('commitGuard.arm', { runId: 'rc1', intentId, stepId: 'issue', targetId, endpoint: `${fx.origin}/submit*`, bodyFieldMap: map, expectedHash: commitExpectedHash(values, map) });

  it('엔진 포트에서 무장하고, 일치하면 엔진이 이어 보내 서버가 받는다(본문은 엔진에 없다)', async () => {
    assert.deepEqual(await armFor('ok', { user: 'alice', note: '공급가액 1,000,000' }), { armed: true });
    const result = h.client.once('commit.body_compared', (d) => d.intentId === 'ok');
    const mark = eng.events.length;
    await submit('alice', '공급가액  1,000,000');
    assert.deepEqual(await result, { intentId: 'ok', stepId: 'issue', match: true });
    const ev = await eng.waitEvent((e) => e.method === 'Fetch.requestPaused' && e.sessionId === sid, mark);
    assert.doesNotMatch(JSON.stringify(ev), /alice|postData/);
    // 이어 보낸 뒤의 /submit 응답 페이지 로드를 기다린다. 서버는 본문을 다 받고 나서 응답한다(fixtures/server.ts).
    // 예전에는 mark(로그인 화면 이동 전)부터 찾아 /login의 loadEventFired에 바로 걸리고 2.5초 폴링만 남았다(windows-latest에서 흔들림).
    const sent = eng.events.length;
    await eng.send('Fetch.continueRequest', { requestId: ev.params!.requestId }, sid);
    await eng.waitEvent((e) => e.method === 'Page.loadEventFired' && e.sessionId === sid, sent);
    assert.ok(fx.bodies.some((b) => b.includes('user=alice')), '서버가 받았다');
    assert.ok(!JSON.stringify(eng.events.slice(mark)).includes('alice'), '엔진 이벤트에 본문 값이 없다');
  });

  it('화면 값이 바뀌어 다르면 금고가 막는다: 서버가 받지 않고 엔진은 requestPaused를 못 본다', async () => {
    assert.deepEqual(await armFor('bad', { user: 'alice', note: '공급가액 1,000,000' }), { armed: true });
    const result = h.client.once('commit.body_compared', (d) => d.intentId === 'bad');
    const mark = eng.events.length;
    const before = fx.bodies.length;
    await submit('alice', '공급가액 9,000,000');
    assert.deepEqual(await result, { intentId: 'bad', stepId: 'issue', match: false });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(!fx.bodies.slice(before).some((b) => b.includes('9%2C000%2C000') || b.includes('9,000,000')), '서버가 받지 않았다');
    assert.ok(!eng.events.slice(mark).some((e) => e.method === 'Fetch.requestPaused'));
    assert.ok(h.log.lines.some((l) => l.includes('"vault.commit_compared"') && l.includes('"match":false')));
    assert.ok(!h.log.lines.some((l) => l.includes('9,000,000') || l.includes('alice')));
  });

  it('control 포트는 commitGuard를 부를 수 없다', async () => {
    await assert.rejects(h.control.rpc('commitGuard.arm', {}), /denied/);
  });
});
