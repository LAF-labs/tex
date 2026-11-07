// M4-6 모델 게이트웨이(D09 §3·§4.1, D04 §7, gateway-request.schema.json 규칙 (1)~(7)). 공급사·국세청은 모의.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BundleCatalog, OpenAIDecisionsAdapter, canonicalJson, type Egress } from '../packages/model/src/index.ts';
import { FORBIDDEN_COLUMN, LIMITS_MIGRATIONS_DIR, Logger, createServer, listen, looksSensitive, migrate, openSqlite, schemaColumns, sha256hex, sqlLimits, type Sql } from '../services/shared/src/index.ts';
import { GATEWAY, GATEWAY_VISIBILITY, GatewayService, MIGRATIONS_DIR, MockNtsSource, MockProvider, gatewayRouter, httpSuspender, ntsFromEnv, OdcloudNtsSource, openAIDecisionsBody, positiveInt, OpenRouterProvider, ProviderError, parseOpenRouterRouting, providerFromEnv, SplitProvider, type ModelProvider, type RespondSpec } from '../services/gateway/src/index.ts';
import { D, H, client, edKey } from './services-kit.ts';
import { ACCOUNT_ORIGIN, accountStack, deviceToken, signedDesktop, signedPhone, type Signed, type Stack } from './services-stack.ts';

const GW = 'https://gw.test.invalid';
const catalog = BundleCatalog.load();
const SCREEN = catalog.get('screen_state_v2')!;
const FORM = catalog.get('form_ready_v2')!;

interface Env {
  s: Stack;
  db: Sql;
  provider: MockProvider;
  nts: MockNtsSource;
  svc: GatewayService;
  server: Server;
  req: ReturnType<typeof client>;
  logs: string[];
  events: string[];
  pc: Signed;
  call(path: string, body: unknown, who?: Signed): ReturnType<Env['req']>;
  runToken(who?: Signed, scope?: object): Promise<string>;
  /** 같은 DB·키를 쓰는 두 번째 인스턴스(한도 카운터는 DB로 공유, 메모리 캐시는 따로) */
  twin(): Promise<{ server: Server; req: Env['req']; call: Env['call'] }>;
}

async function start(o: { monthlyTokens?: number; sqlLimits?: boolean } = {}): Promise<Env> {
  const s = await accountStack();
  const db = openSqlite();
  await migrate(db, 'gateway', MIGRATIONS_DIR);
  if (o.sqlLimits) await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
  const idKey = randomBytes(32);
  const provider = new MockProvider();
  const nts = new MockNtsSource();
  const events: string[] = [];
  const deps = {
    db,
    provider,
    catalog,
    runKey: edKey().priv,
    cacheSecret: randomBytes(32),
    sidKey: randomBytes(32),
    tagKey: randomBytes(32),
    scopeKey: randomBytes(32),
    models: { decide: 'model-decide', respond: 'model-respond' },
    monthlyTokens: o.monthlyTokens,
    nts,
    suspender: { suspend: async (id) => void (await s.svc.autoSuspend(id)) },
    onEvent: (e) => events.push(e),
    now: s.clock.now,
    sleep: async () => undefined,
  };
  const instance = async () => {
    const svc = new GatewayService({ ...deps, limits: o.sqlLimits ? sqlLimits(db, s.clock.now, idKey) : undefined });
    const server = createServer(gatewayRouter({ svc, verifier: s.verifier, directory: s.directory, publicOrigin: GW }), { logger: new Logger('gateway', (l) => logs.push(l), s.clock.now) });
    return { svc, server, req: client(await listen(server)) };
  };
  const logs: string[] = [];
  const { svc, server, req } = await instance();
  const pc = await signedDesktop(s, 'gw@example.com');
  const call = async (path: string, body: unknown, who: Signed = pc) => req('POST', path, { headers: who.headers('POST', GW, path, await who.token()), body });
  const runToken = async (who: Signed = pc, scope: object = { runId: `run-${randomBytes(6).toString('hex')}` }) => {
    const r = await call('/v1/run-tokens', scope, who);
    assert.equal(r.status, 200, r.text);
    return r.json.runToken as string;
  };
  const twin = async () => {
    const t = await instance();
    return { server: t.server, req: t.req, call: async (path: string, body: unknown, who: Signed = pc) => t.req('POST', path, { headers: who.headers('POST', GW, path, await who.token()), body }) };
  };
  return { s, db, provider, nts, svc, server, req, logs, events, pc, call, runToken, twin };
}

const decideBody = (rt: string, b = SCREEN, input = '홈택스 > 조회/발급 화면입니다.') => ({ bundleId: b.wireId, bundleDigest: b.digest, input, runToken: rt });
const respondBody = (rt: string, extra: object = {}, toolset = 'query_parse') => ({ toolset, messages: [{ role: 'user', content: [{ type: 'input_text', text: '이번 달 만료 서류' }] }], runToken: rt, ...extra });

describe('M4-6 게이트웨이: 인증(기기 범위 토큰 + DPoP, 데스크톱만)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => (e.server.close(), e.s.close()));

  it('토큰 없음·계정 세션·다른 주소의 DPoP·폰 토큰은 거부', async () => {
    assert.equal((await e.req('POST', '/v1/run-tokens', { body: { runId: 'run-12345678' } })).json.error, 'gateway.unauthorized');
    assert.equal((await e.req('POST', '/v1/run-tokens', { headers: { authorization: `Bearer ${e.pc.session}` }, body: { runId: 'run-12345678' } })).json.error, 'gateway.unauthorized');
    const t = await e.pc.token();
    const wrongHtu = await e.req('POST', '/v1/run-tokens', { headers: e.pc.headers('POST', 'https://other.invalid', '/v1/run-tokens', t), body: { runId: 'run-12345678' } });
    assert.equal(wrongHtu.json.error, 'gateway.unauthorized');
    const phone = await signedPhone(e.s, e.pc);
    const pt = await phone.token();
    const r = await e.req('POST', '/v1/run-tokens', { headers: phone.headers('POST', GW, '/v1/run-tokens', pt), body: { runId: 'run-12345678' } });
    assert.equal(r.json.error, 'account.scope_denied');
  });

  it('gateway 전용 기기 토큰(ADR-040 결정 1): 게이트웨이는 통과, 같은 토큰으로 계정의 기기 범위 경로는 scope_denied', async () => {
    const gt = await deviceToken(e.s, e.pc.aik, e.pc.d, ['gateway']);
    const ok = await e.req('POST', '/v1/run-tokens', { headers: e.pc.headers('POST', GW, '/v1/run-tokens', gt), body: { runId: 'run-12345678' } });
    assert.equal(ok.status, 200, ok.text);
    for (const [m, p] of [['POST', '/v1/slots'], ['GET', '/v1/device-list']] as const) {
      const r = await e.s.req(m, p, { headers: e.pc.headers(m, ACCOUNT_ORIGIN, p, gt) });
      assert.equal(r.json.error, 'account.scope_denied', `${m} ${p}`);
    }
  });

  it('긴급 정지된 데스크톱은 즉시 gateway.device_suspended', async () => {
    const rt = await e.runToken();
    await e.s.req('POST', `/v1/devices/${e.pc.d.id}/suspend`, { headers: { authorization: `Bearer ${e.pc.session}` } });
    assert.equal(e.provider.decides.length, 0);
    const r = await e.req('POST', '/v1/decide', { headers: e.pc.headers('POST', GW, '/v1/decide', await tokenBefore(e)), body: decideBody(rt) });
    assert.equal(r.json.error, 'gateway.device_suspended');
  });
});

/** 정지 전에 받아 둔 토큰을 흉내 내려 정지를 잠시 풀고 받은 뒤 다시 정지한다(토큰 자체는 15분 유효). */
async function tokenBefore(e: Env): Promise<string> {
  await e.s.db.run("UPDATE devices SET state = 'active' WHERE device_id = $1", [e.pc.d.id]);
  const t = await e.pc.token();
  await e.s.db.run("UPDATE devices SET state = 'suspended' WHERE device_id = $1", [e.pc.d.id]);
  return t;
}

describe('M4-6 게이트웨이: /v1/decide 번들 주입·스키마·트립와이어', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => (e.server.close(), e.s.close()));

  it('질문·접두·모델·캐시 키·safety_identifier는 게이트웨이가 넣고, 공급사 본문은 BYOK 어댑터와 같은 모양이다', async () => {
    const rt = await e.runToken();
    const r = await e.call('/v1/decide', decideBody(rt));
    assert.equal(r.status, 200, r.text);
    const sent = e.provider.decides[0]!;
    assert.equal(sent.model, 'model-decide');
    assert.match(String(sent.prompt_cache_key), /^acct:[0-9a-f]{32}:b:screen_state_v2$/);
    assert.match(String(sent.safety_identifier), /^[0-9a-f]{32}$/);
    assert.equal((sent.questions as unknown[]).length, SCREEN.def.questions.length);
    const byok = new OpenAIDecisionsAdapter({ apiKey: 'unused', egress: { providerFetch: fetch } as unknown as Egress, model: 'model-decide' }).buildRequest(SCREEN, '홈택스 > 조회/발급 화면입니다.' as never) as unknown as Record<string, unknown>;
    const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'prompt_cache_key' && k !== 'safety_identifier'));
    assert.deepEqual(strip(sent), strip(byok));
    // 응답: cached_tokens 없음, questionsDigest = sha256(정규 JSON(질문))
    assert.deepEqual(r.json.usage, { input_tokens: 1000, output_tokens: 20 });
    assert.ok(!r.text.includes('cached'));
    assert.equal(r.json.questionsDigest, sha256hex(canonicalJson(SCREEN.def.questions)));
    assert.equal((r.json.answers as unknown[]).length, SCREEN.def.questions.length);
  });

  it('캐시 키는 계정별로 격리되고, safety_identifier는 KST 월이 바뀌면 바뀐다', async () => {
    const other = await signedDesktop(e.s, 'other@example.com');
    await e.call('/v1/decide', decideBody(await e.runToken()));
    await e.call('/v1/decide', decideBody(await e.runToken(other)), other);
    const [a, b] = e.provider.decides;
    assert.notEqual(a!.prompt_cache_key, b!.prompt_cache_key);
    assert.notEqual(a!.safety_identifier, b!.safety_identifier);
    const before = e.svc.safetyId(e.pc.accountId);
    e.s.clock.t = Date.UTC(2026, 10, 30, 15, 0, 0); // KST 12월 1일 00:00
    assert.notEqual(e.svc.safetyId(e.pc.accountId), before);
    assert.equal(e.svc.cacheKey(e.pc.accountId, 'b', 'x'), e.svc.cacheKey(e.pc.accountId, 'b', 'x'));
  });

  it('스키마 밖 필드·클라이언트가 정하려는 공급사 필드·잘못된 형식은 400, 응답은 입력을 되풀이하지 않는다', async () => {
    const rt = await e.runToken();
    for (const extra of [{ model: 'x' }, { prompt_cache_key: 'x' }, { safety_identifier: 'x' }, { questions: [] }, { image: 'data:image/png;base64,AAAA' }]) {
      const r = await e.call('/v1/decide', { ...decideBody(rt), ...extra });
      assert.deepEqual([r.status, r.json], [400, { error: 'gateway.param_rejected' }]);
    }
    assert.equal((await e.call('/v1/decide', { ...decideBody(rt), bundleDigest: 'abc' })).json.error, 'gateway.param_rejected');
    assert.equal(e.provider.decides.length, 0);
  });

  it('번들·다이제스트 불일치는 409, 입력이 번들 maxInputBytes를 넘으면 400', async () => {
    const rt = await e.runToken();
    assert.equal((await e.call('/v1/decide', { ...decideBody(rt), bundleId: 'nope_v1' })).json.error, 'gateway.digest_mismatch');
    assert.equal((await e.call('/v1/decide', { ...decideBody(rt), bundleDigest: '0'.repeat(64) })).json.error, 'gateway.digest_mismatch');
    assert.equal((await e.call('/v1/decide', { ...decideBody(rt), bundleDigest: FORM.digest })).json.error, 'gateway.digest_mismatch');
    const big = '가'.repeat(Math.floor(SCREEN.def.maxInputBytes / 3) + 1);
    assert.equal((await e.call('/v1/decide', decideBody(rt, SCREEN, big))).json.error, 'gateway.param_rejected');
    assert.equal(e.provider.decides.length, 0);
  });

  it('2차 PII 트립와이어: 주민번호·사업자번호·카드·계좌 패턴은 공급사로 보내지 않고 400, 카운트만 남긴다', async () => {
    const rt = await e.runToken();
    for (const leak of ['주민 900101-1234567', '사업자 123-45-67890', '카드 4111 1111 1111 1111', '계좌 110-123-456789']) {
      const r = await e.call('/v1/decide', decideBody(rt, SCREEN, leak));
      assert.equal(r.json.error, 'gateway.pii_tripwire', leak);
    }
    assert.equal(e.provider.decides.length, 0);
    assert.equal(e.events.filter((x) => x === 'pii_tripwire').length, 4);
    assert.ok(!e.logs.some((l) => l.includes('900101') || l.includes('4111')));
  });
});

describe('M4-6 게이트웨이: runToken·실행당 예산·한도', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => (e.server.close(), e.s.close()));

  it('L1 ≤ 12: 13번째 decide는 429, 같은 runId로 토큰을 다시 받아도 예산은 그대로', async () => {
    const scope = { runId: 'run-budget-01' };
    const rt = await e.runToken(e.pc, scope);
    for (let i = 0; i < GATEWAY.l1PerRun; i++) assert.equal((await e.call('/v1/decide', decideBody(rt))).status, 200);
    assert.equal((await e.call('/v1/decide', decideBody(rt))).json.error, 'gateway.run_budget_exceeded');
    const again = await e.runToken(e.pc, scope);
    assert.equal((await e.call('/v1/decide', decideBody(again))).json.error, 'gateway.run_budget_exceeded');
    assert.equal(e.provider.decides.length, GATEWAY.l1PerRun);
  });

  it('runToken은 서명·만료·기기에 묶인다(다른 계정·변조·만료 거부)', async () => {
    const other = await signedDesktop(e.s, 'other2@example.com');
    const rt = await e.runToken();
    assert.equal((await e.call('/v1/decide', decideBody(rt), other)).json.error, 'gateway.run_token_invalid');
    const [p, body, sig] = rt.split('.');
    const claims = JSON.parse(Buffer.from(body!, 'base64url').toString()) as Record<string, unknown>;
    const forged = `${p}.${Buffer.from(JSON.stringify({ ...claims, exp: (claims.exp as number) + 10 * D })).toString('base64url')}.${sig}`;
    assert.equal((await e.call('/v1/decide', decideBody(forged))).json.error, 'gateway.run_token_invalid');
    assert.equal((await e.call('/v1/decide', decideBody('sxr1.' + 'A'.repeat(40) + '.' + 'B'.repeat(40)))).json.error, 'gateway.run_token_invalid');
    e.s.clock.advance(2 * H + 1);
    assert.equal((await e.call('/v1/decide', decideBody(rt))).json.error, 'gateway.run_token_invalid');
    assert.equal((await e.call('/v1/run-tokens', { runId: 'run-12345678', extra: 1 })).json.error, 'gateway.param_rejected');
    assert.equal((await e.call('/v1/run-tokens', { runId: 'x' })).json.error, 'gateway.param_rejected');
  });

  it('월 한도 100%에서 L2 중단, 200%(하드 상한)부터는 안전 판정 번들만', async () => {
    e.server.close();
    e.s.close();
    e = await start({ monthlyTokens: 1000 });
    const rt = await e.runToken();
    assert.equal((await e.call('/v1/decide', decideBody(rt, FORM, '신고서 작성 화면'))).status, 200); // 1,020 토큰
    assert.equal((await e.call('/v1/respond', respondBody(await e.runToken()))).json.error, 'gateway.quota_exceeded');
    assert.equal((await e.call('/v1/decide', decideBody(rt, FORM, '신고서 작성 화면'))).status, 200); // 2,040 ≥ 2,000
    assert.equal((await e.call('/v1/decide', decideBody(rt, FORM, '신고서 작성 화면'))).json.error, 'gateway.quota_exceeded');
    assert.equal((await e.call('/v1/decide', decideBody(rt, SCREEN))).status, 200);
    // 하드 상한 이후 안전 판정은 낮은 속도로만(계정당 분당 6회)
    const rt2 = await e.runToken();
    for (let i = 1; i < GATEWAY.safetyAfterCapPerMinute; i++) assert.equal((await e.call('/v1/decide', decideBody(i < 11 ? rt : rt2, SCREEN))).status, 200);
    assert.equal((await e.call('/v1/decide', decideBody(rt2, SCREEN))).json.error, 'gateway.quota_exceeded');
    e.s.clock.advance(60_000);
    assert.equal((await e.call('/v1/decide', decideBody(rt2, SCREEN))).status, 200);
  });

  it('공급사 5xx·429는 지수 백오프 2회 뒤 503, 재시도 불가 오류는 바로 503', async () => {
    const rt = await e.runToken();
    e.provider.failures = ['retryable', 'retryable'];
    assert.equal((await e.call('/v1/decide', decideBody(rt))).status, 200);
    assert.equal(e.provider.decides.length, 3);
    e.provider.failures = ['retryable', 'retryable', 'retryable'];
    assert.equal((await e.call('/v1/decide', decideBody(rt))).json.error, 'gateway.upstream_error');
    assert.equal(e.provider.decides.length, 6);
    e.provider.failures = ['fatal'];
    assert.equal((await e.call('/v1/decide', decideBody(rt))).json.error, 'gateway.upstream_error');
    assert.equal(e.provider.decides.length, 7);
  });
});

describe('M4-6 게이트웨이: /v1/respond 툴셋·replay 태그·이미지 거부', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => (e.server.close(), e.s.close()));

  it('query_parse: store:false·툴셋 필드는 게이트웨이가 넣고, 출력에는 계정·기기·runToken에 묶인 태그가 붙는다', async () => {
    const rt = await e.runToken(e.pc, { chatSessionId: 'chat-0001-abcd' });
    e.provider.respondOutput = [{ type: 'message', content: [{ type: 'output_text', text: '{"query_kind":"other","doc_type":null,"from":null,"to":null}' }] }];
    const r = await e.call('/v1/respond', respondBody(rt));
    assert.equal(r.status, 200, r.text);
    const sent = e.provider.responds[0]!;
    assert.equal(sent.store, false);
    assert.equal(sent.model, 'model-respond');
    assert.match(String(sent.prompt_cache_key), /^acct:[0-9a-f]{32}:t:query_parse$/);
    assert.equal((sent.text as { format: { name: string } }).format.name, 'query');
    const out = r.json.output as Array<{ item: unknown; tag: string }>;
    assert.equal(out[0]!.tag, e.svc.tag({ acc: e.pc.accountId, dev: e.pc.d.id }, rt, out[0]!.item));
    assert.deepEqual(r.json.usage, { input_tokens: 2000, output_tokens: 300 });
    assert.match(String(r.json.toolsetDigest), /^[0-9a-f]{64}$/);
  });

  it('클라이언트의 developer 역할·이미지·input_file·툴 정의·알 수 없는 툴셋은 400', async () => {
    const rt = await e.runToken();
    const bad = [
      { ...respondBody(rt), messages: [{ role: 'developer', content: [{ type: 'input_text', text: 'x' }] }] },
      { ...respondBody(rt), messages: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }] }] },
      { ...respondBody(rt), messages: [{ role: 'user', content: [{ type: 'input_file', file_data: 'AAAA' }] }] },
      { ...respondBody(rt), tools: [] },
      { ...respondBody(rt), store: true },
      respondBody(rt, {}, 'summarize'),
      respondBody(rt, {}, 'intent_fill'),
    ];
    for (const b of bad) assert.deepEqual((await e.call('/v1/respond', b)).json, { error: 'gateway.param_rejected' });
    // replay 항목(스키마가 열어 둔 객체) 안의 이미지도 거부
    const img = { item: { type: 'message', content: [{ type: 'input_image', image_url: 'https://x' }] }, tag: '0'.repeat(64) };
    assert.equal((await e.call('/v1/respond', respondBody(rt, { replay: [img] }))).json.error, 'gateway.param_rejected');
    assert.equal(e.provider.responds.length, 0);
  });

  it('selector_repair: 태그 없는·틀린 replay와 근거 없는 function_call_output은 400, L2는 실행당 2회', async () => {
    const rt = await e.runToken();
    e.provider.respondOutput = [{ type: 'function_call', call_id: 'call_1', name: 'find_candidates', arguments: '{"role":"button","nameContains":"조회","maxResults":3}' }];
    const first = await e.call('/v1/respond', respondBody(rt, {}, 'selector_repair'));
    assert.equal(first.status, 200, first.text);
    // 게이트웨이 툴셋의 scopeId는 형식 제한(엔진이 로컬 열거로 다시 검증)
    const tools = e.provider.responds[0]!.tools as Array<{ name: string; parameters: { properties: Record<string, { enum?: unknown; pattern?: string }> } }>;
    assert.equal(tools.find((t) => t.name === 'get_a11y_subtree')!.parameters.properties.scopeId!.pattern, '^[A-Za-z0-9_.-]{1,64}$');
    const tagged = (first.json.output as Array<{ item: Record<string, unknown>; tag: string }>)[0]!;
    const answer = { type: 'function_call_output', call_id: 'call_1', output: '[{"role":"button","name":"조회"}]' };
    assert.equal((await e.call('/v1/respond', respondBody(rt, { replay: [{ ...tagged, tag: '0'.repeat(64) }, answer] }, 'selector_repair'))).json.error, 'gateway.param_rejected');
    assert.equal((await e.call('/v1/respond', respondBody(rt, { replay: [{ item: { ...tagged.item, name: 'propose_selectors' }, tag: tagged.tag }, answer] }, 'selector_repair'))).json.error, 'gateway.param_rejected');
    assert.equal((await e.call('/v1/respond', respondBody(rt, { replay: [{ ...answer, call_id: 'call_x' }] }, 'selector_repair'))).json.error, 'gateway.param_rejected');
    // 다른 runToken으로는 같은 태그가 통하지 않는다
    const rt2 = await e.runToken();
    assert.equal((await e.call('/v1/respond', respondBody(rt2, { replay: [tagged, answer] }, 'selector_repair'))).json.error, 'gateway.param_rejected');
    const turn = await e.call('/v1/respond', respondBody(rt, { replay: [tagged, answer] }, 'selector_repair'));
    assert.equal(turn.status, 200, turn.text);
    assert.equal((e.provider.responds[1]!.input as unknown[]).length, 4); // developer + user + function_call + output
    assert.equal((await e.call('/v1/respond', respondBody(rt, {}, 'selector_repair'))).status, 200);
    assert.equal((await e.call('/v1/respond', respondBody(rt, {}, 'selector_repair'))).json.error, 'gateway.run_budget_exceeded');
    // 트립와이어는 function_call_output에도
    const rt3 = await e.runToken();
    const f3 = await e.call('/v1/respond', respondBody(rt3, {}, 'selector_repair'));
    const t3 = (f3.json.output as Array<{ item: Record<string, unknown>; tag: string }>)[0]!;
    assert.equal((await e.call('/v1/respond', respondBody(rt3, { replay: [t3, { ...answer, output: '주민 900101-1234567' }] }, 'selector_repair'))).json.error, 'gateway.pii_tripwire');
  });

  it('query_parse 턴 상한 1: 이전 출력을 재생하면 예산 초과', async () => {
    const rt = await e.runToken(e.pc, { chatSessionId: 'chat-0002-abcd' });
    const r = await e.call('/v1/respond', respondBody(rt));
    const tagged = (r.json.output as Array<{ item: Record<string, unknown>; tag: string }>)[0]!;
    assert.equal((await e.call('/v1/respond', respondBody(rt, { replay: [tagged] }))).json.error, 'gateway.run_budget_exceeded');
  });
});

describe('M4-6 게이트웨이: 기기 자동 정지·계량 분리·진위확인 프록시·로그', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => (e.server.close(), e.s.close()));

  it('트립와이어가 1시간에 20회면 그 기기를 자동 정지(정지 훅·알림 메일), 이후 요청은 device_suspended', async () => {
    const rt = await e.runToken();
    for (let i = 0; i < GATEWAY.abuseThreshold; i++) await e.call('/v1/decide', decideBody(rt, SCREEN, '900101-1234567'));
    assert.deepEqual(e.s.stopped, [e.pc.d.id]);
    assert.ok(e.s.mail.outbox.some((m) => m.kind === 'device_auto_suspended'));
    assert.ok(e.events.includes('auto_suspend'));
    assert.equal((await e.req('POST', '/v1/decide', { headers: e.pc.headers('POST', GW, '/v1/decide', await tokenBefore(e)), body: decideBody(rt) })).json.error, 'gateway.device_suspended');
    // AIK 재활성화(여기서는 계정 DB로 대신) 뒤 다시 폭주하면 다시 정지한다(한 번 정지로 끝나지 않는다)
    await e.s.db.run("UPDATE devices SET state = 'active' WHERE device_id = $1", [e.pc.d.id]);
    const rt2 = await e.runToken();
    for (let i = 0; i < GATEWAY.abuseThreshold - 1; i++) await e.call('/v1/decide', decideBody(rt2, SCREEN, '900101-1234567'));
    assert.deepEqual(e.s.stopped, [e.pc.d.id], '창은 정지 때 비워져 처음부터 센다');
    await e.call('/v1/decide', decideBody(rt2, SCREEN, '900101-1234567'));
    assert.deepEqual(e.s.stopped, [e.pc.d.id, e.pc.d.id]);
  });

  it('DB 한도(인스턴스 둘): 트립와이어는 두 인스턴스 합산 20회에서 한 번 정지, 분당 L1 한도도 합산(팀장 결정 (가))', async () => {
    const g = await start({ sqlLimits: true });
    const other = await g.twin();
    try {
      const rt = await g.runToken();
      for (let i = 0; i < GATEWAY.abuseThreshold - 1; i++) await (i % 2 ? g.call : other.call)('/v1/decide', decideBody(rt, SCREEN, '900101-1234567'));
      assert.deepEqual(g.s.stopped, []);
      await other.call('/v1/decide', decideBody(rt, SCREEN, '900101-1234567'));
      assert.deepEqual(g.s.stopped, [g.pc.d.id]);
      // 저장된 한도 키에 평문 기기·계정 ID가 없다
      const ks = (await g.db.all<{ k: string }>('SELECT k FROM lim_windows')).map((r) => r.k);
      assert.ok(ks.length > 0 && ks.every((k) => !k.includes(g.pc.d.id)));

      await g.s.db.run("UPDATE devices SET state = 'active' WHERE device_id = $1", [g.pc.d.id]);
      g.s.clock.advance(H);
      const codes: string[] = [];
      const tok = await g.pc.token(); // 기기 토큰은 한 번만 받는다(계정 서비스의 발급 한도와 섞지 않게)
      let rt2 = '';
      for (let i = 0; i < GATEWAY.l1PerMinute + 1; i++) {
        if (i % 10 === 0) rt2 = await g.runToken(); // 실행 예산(L1 ≤ 12)보다 먼저 분당 한도를 본다
        const r = await (i % 2 ? g.req : other.req)('POST', '/v1/decide', { headers: g.pc.headers('POST', GW, '/v1/decide', tok), body: decideBody(rt2) });
        codes.push(r.status === 200 ? 'ok' : (r.json.error as string));
      }
      assert.deepEqual(codes.slice(0, -1), Array(GATEWAY.l1PerMinute).fill('ok'));
      assert.equal(codes.at(-1), 'policy.rate_limited');
    } finally {
      other.server.close();
      g.server.close();
      g.s.close();
    }
  });

  it('GW_MONTHLY_TOKENS가 양의 정수가 아니면 기동 거부(조용히 한도 없음이 되지 않게)', () => {
    for (const v of ['abc', '0', '-5', '1.5', '', '1e6']) assert.throws(() => positiveInt(v, 'GW_MONTHLY_TOKENS'), /config_GW_MONTHLY_TOKENS/);
    assert.equal(positiveInt('3000000', 'GW_MONTHLY_TOKENS'), 3_000_000);
  });

  it('계량: 결제 레코드(계정·월·토큰), 계정 없는 운영 통계, 호출 기록은 35일 뒤 삭제', async () => {
    const rt = await e.runToken();
    await e.call('/v1/decide', decideBody(rt));
    await e.call('/v1/respond', respondBody(await e.runToken()));
    const m = await e.db.one<Record<string, number>>('SELECT input_tokens, output_tokens FROM usage_monthly WHERE account_id = $1', [e.pc.accountId]);
    assert.deepEqual({ ...m }, { input_tokens: 3000, output_tokens: 320 });
    const stats = await e.db.all<{ surface: string; outcome: string; n: number }>('SELECT surface, outcome, n FROM ops_stats ORDER BY surface');
    assert.deepEqual(
      stats.map((x) => [x.surface, x.outcome, Number(x.n)]),
      [
        ['query_parse', 'ok', 1],
        ['screen_state_v2', 'ok', 1],
      ],
    );
    assert.equal((await e.db.all('SELECT * FROM call_records')).length, 2);
    e.s.clock.advance(35 * D);
    await e.svc.sweep();
    assert.equal((await e.db.all('SELECT * FROM call_records')).length, 0);
    assert.equal((await e.db.all('SELECT * FROM usage_monthly')).length, 1);
  });

  it('진위확인: 요청당 10건·10자리 숫자만, 계정당 분당 30회, 접근 로그에 계정 식별자도 번호도 없다', async () => {
    const r = await e.call('/v1/biz/status', { b_no: ['1234567891', '1234567890', '1234567899'] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(
      (r.json.data as Array<{ b_stt_cd: string }>).map((x) => x.b_stt_cd),
      ['01', '03', ''],
    );
    assert.equal((await e.call('/v1/biz/status', { b_no: Array.from({ length: 11 }, () => '1234567891') })).json.error, 'gateway.param_rejected');
    assert.equal((await e.call('/v1/biz/status', { b_no: ['123-45-67891'] })).json.error, 'gateway.param_rejected');
    for (let i = 0; i < GATEWAY.bizPerMinute - 1; i++) await e.call('/v1/biz/status', { b_no: ['1234567891'] });
    assert.equal((await e.call('/v1/biz/status', { b_no: ['1234567891'] })).json.error, 'policy.rate_limited');
    const bizLogs = e.logs.filter((l) => l.includes('/v1/biz/status'));
    assert.ok(bizLogs.length > 0);
    for (const l of bizLogs) {
      assert.ok(!l.includes('"aid"'), l);
      assert.ok(!l.includes('1234567'), l);
    }
    assert.equal((await e.db.all('SELECT * FROM call_records')).length, 0);
    // 서비스 계층도 같은 한도를 지킨다(앱 검증을 거치지 않는 호출 경로 대비)
    for (const bad of [[], Array.from({ length: 11 }, () => '1234567891'), ['123-45-67891']]) {
      await assert.rejects(e.svc.bizStatus(bad), (x: Error & { code?: string }) => x.code === 'gateway.param_rejected');
    }
  });

  it('자동 정지 호출은 시간 제한이 있다: 계정 서비스가 응답하지 않으면 끊고 실패로 본다', async () => {
    let signal: AbortSignal | undefined;
    const hang = ((_u: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    }) as unknown as typeof fetch;
    await assert.rejects(httpSuspender('http://acct.invalid', randomBytes(32), hang, 20).suspend('d1'));
    assert.ok(signal?.aborted);
  });

  it('접근 로그는 고정 필드·라우트 패턴뿐, 본문·토큰·식별자 패턴 없음', async () => {
    const rt = await e.runToken();
    await e.call('/v1/decide', decideBody(rt, SCREEN, '이메일 a@b.com 이 보이는 화면'));
    await e.call('/v1/decide', decideBody(rt, SCREEN, '900101-1234567'));
    for (const line of e.logs) {
      const o = JSON.parse(line) as Record<string, unknown>;
      assert.deepEqual(Object.keys(o).filter((k) => !['t', 'svc', 'm', 'route', 'status', 'code', 'bytesIn', 'bytesOut', 'ms', 'aid'].includes(k)), []);
      assert.ok(!looksSensitive(line), line);
      assert.ok(!line.includes('화면'), line);
    }
  });

  it('마이그레이션의 저장 컬럼 = 가시성 표, 금지 컬럼 없음', () => {
    const cols = schemaColumns(MIGRATIONS_DIR);
    assert.deepEqual(Object.keys(cols).sort(), Object.keys(GATEWAY_VISIBILITY).sort());
    for (const [t, cs] of Object.entries(cols)) {
      assert.deepEqual([...cs].sort(), Object.keys(GATEWAY_VISIBILITY[t]!).sort(), t);
      for (const c of cs) assert.ok(!FORBIDDEN_COLUMN.test(c), `${t}.${c}`);
    }
  });
});

describe('M4-6 게이트웨이: 공급사 와이어', () => {
  it('Decisions 본문은 캐시 브레이크포인트를 고정 접두 끝에만 둔다', () => {
    const b = openAIDecisionsBody({ model: 'm', prefix: 'P', input: 'I', questions: FORM.def.questions, cacheKey: 'acct:x:b:y', safetyId: 's' });
    const input = b.input as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.equal(input[0]!.role, 'developer');
    assert.ok(input[0]!.content[0]!.prompt_cache_breakpoint);
    assert.ok(!input[1]!.content[0]!.prompt_cache_breakpoint);
  });

  const SPEC: RespondSpec = { model: 'openai/gpt-x', prefix: 'P', effort: 'low', maxOutputTokens: 100, tools: [], output: { name: 'o', schema: { type: 'object' } }, input: [], cacheKey: 'acct:x:b:y', safetyId: 's' };
  const ROUTING_ENV = { OPENROUTER_ZDR: 'true', OPENROUTER_DATA_COLLECTION: 'deny', OPENROUTER_PROVIDERS: 'openai, azure' };

  it('OpenRouter 라우팅은 ZDR·수집 거부·공급자 고정이 환경에 정확히 있을 때만(없거나 다르면 기동 거부, R14 ①)', () => {
    assert.deepEqual(parseOpenRouterRouting(ROUTING_ENV), { zdr: true, dataCollection: 'deny', only: ['openai', 'azure'] });
    for (const bad of [{}, { ...ROUTING_ENV, OPENROUTER_ZDR: '1' }, { ...ROUTING_ENV, OPENROUTER_DATA_COLLECTION: 'allow' }, { ...ROUTING_ENV, OPENROUTER_PROVIDERS: '' }, { ...ROUTING_ENV, OPENROUTER_PROVIDERS: 'openai,openai' }, { ...ROUTING_ENV, OPENROUTER_PROVIDERS: 'Open AI' }])
      assert.equal(parseOpenRouterRouting(bad), null);
    assert.throws(() => providerFromEnv({ GW_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k' }), /config_OPENROUTER_ROUTING/);
    assert.throws(() => providerFromEnv({ GW_PROVIDER: 'openrouter', ...ROUTING_ENV }), /config_OPENROUTER_API_KEY/);
    assert.throws(() => new OpenRouterProvider({ apiKey: 'k', routing: null }), /config_OPENROUTER_ROUTING/);
    assert.throws(() => new OpenRouterProvider({ apiKey: 'k', routing: { zdr: true, dataCollection: 'deny', only: [] } }), /config_OPENROUTER_ROUTING/);
    assert.equal(providerFromEnv({ GW_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', ...ROUTING_ENV }).name, 'openrouter');
  });

  it('L1 판정은 OpenAI 직결, 응답은 OpenRouter(openai+openrouter): 키·라우팅 중 하나라도 없으면 기동 거부', async () => {
    const both = { GW_PROVIDER: 'openai+openrouter', OPENAI_API_KEY: 'ok', OPENROUTER_API_KEY: 'k', ...ROUTING_ENV };
    assert.equal(providerFromEnv(both).name, 'openai-compat+openrouter');
    assert.throws(() => providerFromEnv({ ...both, OPENAI_API_KEY: undefined }), /config_OPENAI_API_KEY/);
    assert.throws(() => providerFromEnv({ ...both, OPENROUTER_ZDR: undefined }), /config_OPENROUTER_ROUTING/);
    assert.throws(() => providerFromEnv({ ...both, OPENAI_BASE_URL: 'http://api.openai.com' }), /config_PROVIDER_BASE_URL/);
    const calls: string[] = [];
    const fake = (n: string): ModelProvider => ({
      name: n,
      decide: () => (calls.push(`${n}.decide`), Promise.resolve({ model: 'm', answers: {}, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } })),
      respond: () => (calls.push(`${n}.respond`), Promise.resolve({ model: 'm', status: 'completed', output: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } })),
    });
    const sp = new SplitProvider(fake('a'), fake('b'));
    await sp.decide({} as never);
    await sp.respond(SPEC);
    assert.deepEqual(calls, ['a.decide', 'b.respond']);
  });

  it('진위확인 원천: 키는 NTS_BIZ_API_KEY로만, 주소는 {NTS_BIZ_API_BASE}/nts-businessman/v1/status, 상태코드는 해석 없이 그대로', async () => {
    assert.throws(() => ntsFromEnv({ NTS_PROVIDER: 'odcloud' }), /config_NTS_BIZ_API_KEY/);
    assert.throws(() => ntsFromEnv({ NTS_PROVIDER: 'odcloud', NTS_BIZ_API_KEY: '' }), /config_NTS_BIZ_API_KEY/);
    assert.throws(() => ntsFromEnv({ NTS_PROVIDER: 'odcloud', NTS_BIZ_API_KEY: 'k', NTS_BIZ_API_BASE: 'http://api.odcloud.kr/api' }), /config_NTS_BIZ_API_BASE/);
    assert.throws(() => ntsFromEnv({}), /config_NTS_PROVIDER/);
    assert.ok(ntsFromEnv({ NTS_PROVIDER: 'odcloud', NTS_BIZ_API_KEY: 'k' }) instanceof OdcloudNtsSource);
    let url = '';
    const fetchFn = ((u: string) => {
      url = u;
      return Promise.resolve(new Response(JSON.stringify({ status_code: 'OK', data: [{ b_no: '1234567891', b_stt: '휴업자', b_stt_cd: '02', tax_type: '부가가치세 간이과세자', tax_type_cd: '02', end_dt: '', utcc_yn: 'N' }] }), { status: 200 }));
    }) as unknown as typeof fetch;
    const src = new OdcloudNtsSource({ serviceKey: 'k+/=', baseUrl: 'https://api.odcloud.kr/api/nts-businessman/v1', fetchFn });
    assert.deepEqual(await src.status(['1234567891']), [{ b_no: '1234567891', b_stt_cd: '02', tax_type_cd: '02', end_dt: '' }]);
    assert.equal(url, 'https://api.odcloud.kr/api/nts-businessman/v1/status?serviceKey=k%2B%2F%3D');
  });

  // 로컬 실호출(기본 건너뜀): set -a; . ./.env.local; set +a; SAX_NTS_LIVE=1 NTS_PROVIDER=odcloud node --conditions=development --test tests/services-gateway.test.ts
  // 등록되지 않은 번호(0000000000) 하나만 보낸다. 키·응답 원문은 출력하지 않는다.
  it('진위확인 실호출(SAX_NTS_LIVE=1일 때만)', { skip: process.env.SAX_NTS_LIVE !== '1' }, async () => {
    const r = await ntsFromEnv({ ...process.env, NTS_PROVIDER: 'odcloud' }).status(['0000000000']);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.b_no, '0000000000');
    assert.equal(r[0]!.b_stt_cd, '');
  });

  it('OpenRouter 요청마다 provider{zdr, data_collection:deny, only, allow_fallbacks:false}를 싣고 적용 사실만 이벤트로, 고정 밖 공급자 응답은 버린다', async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    let reply: Record<string, unknown> = { model: 'openai/gpt-x', status: 'completed', output: [], usage: { input_tokens: 5, output_tokens: 1 } };
    let status = 200;
    const fetchFn = (async (url: string, init: { body: string }) => {
      sent.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return new Response(JSON.stringify(reply), { status });
    }) as unknown as typeof fetch;
    const events: string[] = [];
    const p = new OpenRouterProvider({ apiKey: 'k', routing: parseOpenRouterRouting(ROUTING_ENV), fetchFn, onEvent: (e) => events.push(e) });
    const r = await p.respond(SPEC);
    assert.equal(r.status, 'completed');
    assert.equal(sent[0]!.url, 'https://openrouter.ai/api/v1/responses');
    assert.deepEqual(sent[0]!.body.provider, { zdr: true, data_collection: 'deny', only: ['openai', 'azure'], allow_fallbacks: false, require_parameters: true });
    assert.equal(sent[0]!.body.store, false);
    assert.deepEqual(events, ['upstream_zdr_pinned']);
    // 고정 목록 밖 공급자가 답하면 결과를 쓰지 않는다
    reply = { ...reply, provider: 'SomeOther' };
    await assert.rejects(p.respond(SPEC), (e: ProviderError) => !e.retryable);
    assert.ok(events.includes('upstream_provider_mismatch'));
    reply = { ...reply, provider: 'OpenAI' };
    assert.equal((await p.respond(SPEC)).status, 'completed');
    // 고정 공급자를 쓸 수 없으면(404) 재시도하지 않는다
    status = 404;
    await assert.rejects(p.respond(SPEC), (e: ProviderError) => !e.retryable);
    // L1(Decisions)은 OpenRouter에 없다: 호출하지 않고 재시도 불가
    const before = sent.length;
    await assert.rejects(p.decide(), (e: ProviderError) => !e.retryable);
    assert.equal(sent.length, before);
    assert.ok(events.every((e) => /^upstream_[a-z_]+$/.test(e)));
  });
});
