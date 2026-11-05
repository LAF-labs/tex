// 게이트웨이 경로(D04 §7, 기본 경로): 요청 본문 4필드·DPoP 헤더·questionsDigest 대조·오류 코드 매핑,
// 로컬 트립와이어·발급 영수증(as never 우회) 차단과 보안 이벤트, 판정 캐시, Responses 게이트웨이 태그.
// 게이트웨이는 tests/fixtures/gateway-mock.ts의 합성이고 와이어는 services/gateway/API.md(M4-6)를 따른다.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  BundleCatalog,
  DecisionCache,
  DefaultModelLayer,
  GatewayDecideAdapter,
  OpenAIDecisionsAdapter,
  OpenAIResponsesAdapter,
  QUERY_PARSE,
  ThresholdProfiles,
  canonicalJson,
  gatewayRunToken,
  localRunToken,
  questionsDigest,
  toolsetDigest,
} from '@sax/model';
import { Egress, EgressError, type EgressSecurityEvent } from '@sax/net';
import { apply } from '@sax/redaction';
import { startGatewayMock, type GatewayMock } from './fixtures/gateway-mock.ts';
import { startOpenAIMock } from './fixtures/openai-mock.ts';

const catalog = BundleCatalog.load();
const profiles = ThresholdProfiles.load();
const b = (id: string) => catalog.get(id)!;
const screen = (text: string) => apply(text, { runId: 'r1' }).redacted;
const RUN = `gw.${'r'.repeat(40)}` as never;
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setup(mock: GatewayMock, opts: { now?: () => number; cache?: boolean; env?: Record<string, string> } = {}) {
  const events: EgressSecurityEvent[] = [];
  const egress = new Egress({
    env: opts.env ?? {},
    testOrigins: { gateway: mock.origin },
    gateway: { auth: { headers: async (r) => ({ authorization: 'DPoP device-token', dpop: `proof-${r.method}-${r.bodySha256}` }) }, bundles: catalog.allowEntries() },
    onSecurityEvent: (e) => events.push(e),
  });
  const decider = new GatewayDecideAdapter({ egress });
  const cache = opts.cache === false ? undefined : new DecisionCache({ now: opts.now });
  const layer = new DefaultModelLayer({ catalog, profiles, decider, cache });
  return { egress, decider, layer, cache, events };
}

const decideReq = (bundleId: string, input: unknown, runToken: unknown = RUN) => ({ bundleId, bundleDigest: b(bundleId).digest, input: input as never, runToken: runToken as never });

describe('게이트웨이 decide: 요청·응답', () => {
  let mock: GatewayMock;
  before(async () => (mock = await startGatewayMock()));
  after(() => mock.close());
  beforeEach(() => (mock.opts = {}));

  it('본문은 {bundleId, bundleDigest, input, runToken} 4필드뿐, DPoP 헤더는 본문 sha256에 묶인다, 결과는 로컬 매핑', async () => {
    mock.opts = { answers: { screen: 'logged_in_home' } };
    const { layer, egress } = setup(mock);
    const input = screen('link "로그아웃"\nheading "My홈택스"');
    const r = await layer.decide(decideReq('screen_state_v2', input));
    assert.equal(r.outcome, 'logged_in');
    const c = mock.calls.at(-1)!;
    assert.equal(c.path, '/v1/decide');
    assert.deepEqual(Object.keys(c.body!).sort(), ['bundleDigest', 'bundleId', 'input', 'runToken']);
    assert.equal(c.body!.input, input);
    assert.equal(c.headers.authorization, 'DPoP device-token');
    assert.equal(c.headers.dpop, `proof-POST-${sha(JSON.stringify(c.body))}`);
    assert.equal(egress.modelAudit.at(-1)!.dest, 'gateway');
    assert.equal(r.usage.cachedTokens, 0);
  });

  it('questionsDigest = sha256(정규 JSON(번들 정의 questions)), toolsetDigest = sha256(정규 JSON({prefix, tools, output, effort, maxOutputTokens}))', () => {
    const bb = b('screen_state_v2');
    assert.equal(questionsDigest(bb), sha(canonicalJson(bb.def.questions)));
    assert.notEqual(questionsDigest(bb), questionsDigest(b('popup_class_v1')));
    // 공급사 와이어(onRefusal 없음)가 아니라 정의를 해시한다(게이트웨이 service.ts와 같은 정의).
    assert.ok(bb.def.questions.every((q) => q.onRefusal !== undefined));
    const wire = bb.def.questions.map(({ onRefusal: _r, ...q }) => q);
    assert.notEqual(questionsDigest(bb), sha(canonicalJson(wire)));
    assert.match(toolsetDigest(QUERY_PARSE), /^[0-9a-f]{64}$/);
  });

  it('게이트웨이가 다른 질문을 보냈다고 답하면(questionsDigest 불일치) unknown', async () => {
    mock.opts = { tamperDigest: true };
    const { layer } = setup(mock);
    const r = await layer.decide(decideReq('screen_state_v2', screen('heading "홈택스"')));
    assert.deepEqual([r.outcome, r.reason], ['unknown', 'questions_digest_mismatch']);
  });

  it('게이트웨이 오류 코드 → gateway:<code>', async () => {
    const { layer } = setup(mock);
    const cases: Array<[number, string | undefined, string]> = [
      [400, 'gateway.pii_tripwire', 'gateway:pii_tripwire'],
      [409, undefined, 'gateway:digest_mismatch'],
      [429, 'policy.rate_limited', 'gateway:rate_limited'],
      [429, 'gateway.run_budget_exceeded', 'gateway:run_budget_exceeded'],
      [401, 'gateway.run_token_invalid', 'gateway:run_token_invalid'],
      [403, 'account.scope_denied', 'gateway:scope_denied'],
      [403, 'gateway.device_suspended', 'gateway:device_suspended'],
      [503, 'gateway.upstream_error', 'gateway:upstream_error'],
      [400, 'gateway.not_a_real_code', 'gateway:param_rejected'],
    ];
    for (const [status, code, want] of cases) {
      mock.opts = { fail: { '/v1/decide': { status, code } } };
      const r = await layer.decide(decideReq('screen_state_v2', screen(`heading "홈택스 ${status}"`)));
      assert.deepEqual([r.outcome, r.reason], ['unknown', want], `${status} ${code}`);
    }
  });

  it('응답 모양이 틀리면 gateway:bad_response', async () => {
    const { egress } = setup(mock);
    mock.opts = { fail: { '/v1/decide': { status: 200 } } };
    const layer = new DefaultModelLayer({ catalog, profiles, decider: new GatewayDecideAdapter({ egress }) });
    const r = await layer.decide(decideReq('screen_state_v2', screen('heading "x"')));
    assert.deepEqual([r.outcome, r.reason], ['unknown', 'gateway:bad_response']);
  });
});

describe('게이트웨이 경로 로컬 차단(D04 §7 앞단, D06 §4)', () => {
  let mock: GatewayMock;
  before(async () => (mock = await startGatewayMock()));
  after(() => mock.close());

  it('주민번호 평문은 송신 전에 막히고 보안 이벤트(경로 gateway)가 남는다', async () => {
    const { layer, events } = setup(mock);
    const n = mock.calls.length;
    const r = await layer.decide(decideReq('screen_state_v2', 'text "주민번호 900101-1234568"'));
    assert.deepEqual([r.outcome, r.reason], ['unknown', 'guard:pii_tripwire']);
    assert.equal(mock.calls.length, n);
    assert.deepEqual(events, [{ code: 'egress.pii_tripwire', surface: 'decide', path: 'gateway' }]);
  });

  it('마스킹 계층을 지나지 않은 문자열(as never 우회)은 unminted_text로 막힌다', async () => {
    const { layer, events } = setup(mock);
    const n = mock.calls.length;
    const r = await layer.decide(decideReq('screen_state_v2', 'heading "홈택스"'));
    assert.deepEqual([r.outcome, r.reason], ['unknown', 'guard:unminted_text']);
    assert.equal(mock.calls.length, n);
    assert.deepEqual(events, [{ code: 'egress.unminted_text', surface: 'decide', path: 'gateway' }]);
  });

  it('BYOK 경로도 같은 영수증 검사를 하고 보안 이벤트 경로는 byok', async () => {
    const om = await startOpenAIMock();
    try {
      const events: EgressSecurityEvent[] = [];
      const egress = new Egress({ env: {}, testOrigins: { openai: om.origin }, modelGuard: { bundles: catalog.allowEntries() }, onSecurityEvent: (e) => events.push(e) });
      const layer = new DefaultModelLayer({ catalog, profiles, decider: new OpenAIDecisionsAdapter({ apiKey: 'sk-test-not-a-real-key', egress, sleep: async () => {} }) });
      const r = await layer.decide(decideReq('screen_state_v2', 'heading "홈택스"', localRunToken(egress, { runId: randomUUID() })));
      assert.equal(r.outcome, 'unknown');
      assert.match(String(r.reason), /unminted_text/);
      assert.equal(om.calls.length, 0);
      assert.deepEqual(events, [{ code: 'egress.unminted_text', surface: 'decide', path: 'byok' }]);
    } finally {
      await om.close();
    }
  });

  it('허용 목록에 없는 번들 다이제스트는 송신 전 거부', async () => {
    const { egress } = setup(mock);
    await assert.rejects(egress.toGateway({ surface: 'decide', body: { bundleId: 'screen_state_v2', bundleDigest: 'f'.repeat(64), input: screen('x'), runToken: RUN } }), { code: 'bundle_not_allowlisted' });
  });

  it('게이트웨이 설정이 없으면 destination_not_allowed, TLS 변조 환경이면 전부 거부', async () => {
    const scope = { body: { runId: 'run-0001' } };
    await assert.rejects(new Egress({ env: {} }).toGateway({ surface: 'runTokens', ...scope }), (e: unknown) => e instanceof EgressError && e.code === 'destination_not_allowed');
    const { egress } = setup(mock, { env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    await assert.rejects(egress.toGateway({ surface: 'runTokens', ...scope }), (e: unknown) => e instanceof EgressError && e.code === 'egress_env_tampered');
  });

  it('run-tokens: 범위 하나({runId} 또는 {chatSessionId})만 보내고 DPoP는 본문 해시에 묶인다, 형식 밖 ID는 송신 전 거부', async () => {
    const { egress } = setup(mock);
    const t = await gatewayRunToken(egress, { runId: 'run-2026-11-05-a' });
    assert.match(t, /^sxr1\./);
    const c = mock.calls.at(-1)!;
    assert.equal(c.path, '/v1/run-tokens');
    assert.deepEqual(c.body, { runId: 'run-2026-11-05-a' });
    assert.equal(c.headers.dpop, `proof-POST-${sha(JSON.stringify(c.body))}`);
    const n = mock.calls.length;
    await assert.rejects(egress.toGateway({ surface: 'runTokens', body: { runId: 'x' } }), { code: 'path_not_allowed' });
    await assert.rejects(egress.toGateway({ surface: 'runTokens', body: { runId: 'run-00001', chatSessionId: 'chat-0001' } as never }), { code: 'path_not_allowed' });
    assert.equal(mock.calls.length, n);
  });
});

describe('판정 캐시(입력 해시)', () => {
  let mock: GatewayMock;
  before(async () => (mock = await startGatewayMock({ answers: { screen: 'logged_in_home' } })));
  after(() => mock.close());

  it('같은 실행·같은 입력은 재호출 없이 cached, 다른 runToken·TTL 만료는 다시 묻는다', async () => {
    let t = 0;
    const { layer, cache } = setup(mock, { now: () => t });
    const input = screen('link "로그아웃"');
    const n = mock.calls.length;
    const r1 = await layer.decide(decideReq('screen_state_v2', input));
    const r2 = await layer.decide(decideReq('screen_state_v2', input));
    assert.equal(mock.calls.length, n + 1);
    assert.equal(r1.cached, undefined);
    assert.equal(r2.cached, true);
    assert.equal(r2.outcome, r1.outcome);
    assert.equal(r2.usage.inputTokens, 0);
    await layer.decide(decideReq('screen_state_v2', input, `gw.${'s'.repeat(40)}`));
    assert.equal(mock.calls.length, n + 2);
    t = 30_001;
    await layer.decide(decideReq('screen_state_v2', input));
    assert.equal(mock.calls.length, n + 3);
    assert.deepEqual(cache!.stats, { hits: 1, misses: 3, stores: 3, evictions: 0 });
  });

  it('실패(정규화 실패·게이트웨이 오류)는 저장하지 않는다', async () => {
    const { layer, cache } = setup(mock);
    mock.opts = { tamperDigest: true };
    const input = screen('heading "캐시 실패"');
    await layer.decide(decideReq('screen_state_v2', input));
    mock.opts = { answers: { screen: 'nope_not_a_choice' } };
    const r = await layer.decide(decideReq('screen_state_v2', input));
    assert.equal(r.outcome, 'unknown');
    assert.equal(cache!.size, 0);
    mock.opts = { answers: { screen: 'logged_in_home' } };
  });

  it('캐시 항목은 복사본이라 호출자가 바꿔도 다음 적중에 영향 없다', async () => {
    const c = new DecisionCache();
    c.set('k', { answers: { a: { type: 'predicate', probability: 0.1 } }, refusals: [], model: 'm' });
    const got = c.get('k')!;
    (got.answers.a as { probability: number }).probability = 0.9;
    assert.equal((c.get('k')!.answers.a as { probability: number }).probability, 0.1);
  });
});

describe('게이트웨이 respond(Responses, 태그는 게이트웨이가 붙인다)', () => {
  let mock: GatewayMock;
  before(async () => (mock = await startGatewayMock()));
  after(() => mock.close());

  const responder = (egress: Egress) => new OpenAIResponsesAdapter({ egress, transport: 'gateway' });
  const msg = () => ({ role: 'user' as const, content: [{ type: 'input_text' as const, text: apply('다음 달 만료되는 서류 보여줘', { chatSessionId: 'c1' }, { frame: 'none' }).redacted }] });

  it('구조화 출력, 재생 항목의 태그는 게이트웨이 tags, 캐시 토큰은 0', async () => {
    const { egress } = setup(mock);
    const r = await responder(egress).respond(QUERY_PARSE, { toolset: 'query_parse', messages: [msg()], replay: [], runToken: RUN });
    assert.equal(r.status, 'completed');
    assert.equal((r.output as { query_kind: string }).query_kind, 'documents_expiring');
    assert.deepEqual(r.replay.map((x) => x.kind === 'model_output' && x.item.tag), ['gwtag0', 'gwtag1']);
    assert.deepEqual([r.usage.inputTokens, r.usage.cachedTokens, r.usage.cacheWriteTokens], [300, 0, 0], '게이트웨이가 넘긴 cached_tokens는 쓰지 않는다');
    const c = mock.calls.at(-1)!;
    assert.equal(c.path, '/v1/respond');
    assert.deepEqual(Object.keys(c.body!).sort(), ['messages', 'replay', 'runToken', 'toolset']);
  });

  it('게이트웨이 toolsetDigest가 로컬 툴셋과 다르면 결과를 쓰지 않는다', async () => {
    mock.opts = { tamperToolset: true };
    const { egress } = setup(mock);
    const r = await responder(egress).respond(QUERY_PARSE, { toolset: 'query_parse', messages: [msg()], replay: [], runToken: RUN });
    assert.deepEqual([r.status, r.reason], ['incomplete', 'toolset_digest_mismatch']);
    mock.opts = {};
  });

  it('게이트웨이를 거쳐도 도구 이름·인자 검증은 로컬에서 한다', async () => {
    mock.opts = { respondOutput: [{ type: 'function_call', name: 'delete_everything', call_id: 'c1', arguments: '{}' }] };
    const { egress } = setup(mock);
    const r = await responder(egress).respond(QUERY_PARSE, { toolset: 'query_parse', messages: [msg()], replay: [], runToken: RUN });
    assert.deepEqual([r.status, r.reason], ['incomplete', 'tool_call_rejected']);
    mock.opts = {};
  });

  it('게이트웨이 오류·로컬 차단은 gateway:/guard: 사유', async () => {
    const { egress, events } = setup(mock);
    mock.opts = { fail: { '/v1/respond': { status: 400, code: 'gateway.param_rejected' } } };
    const r1 = await responder(egress).respond(QUERY_PARSE, { toolset: 'query_parse', messages: [msg()], replay: [], runToken: RUN });
    assert.equal(r1.reason, 'gateway:param_rejected');
    mock.opts = {};
    const raw = { role: 'user' as const, content: [{ type: 'input_text' as const, text: '사업자번호 220-81-62517 서류' as never }] };
    const r2 = await responder(egress).respond(QUERY_PARSE, { toolset: 'query_parse', messages: [raw], replay: [], runToken: RUN });
    assert.equal(r2.reason, 'guard:pii_tripwire');
    assert.deepEqual(events, [{ code: 'egress.pii_tripwire', surface: 'respond', path: 'gateway' }]);
  });
});
