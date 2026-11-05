// M4-6 모델 게이트웨이(D09 §3·§4.1, D04 §7, gateway-request.schema.json 규칙 (1)~(7)). 공급사·국세청은 모의.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BundleCatalog, OpenAIDecisionsAdapter, canonicalJson, type Egress } from '../packages/model/src/index.ts';
import { FORBIDDEN_COLUMN, Logger, createServer, listen, looksSensitive, migrate, openSqlite, schemaColumns, sha256hex, type Sql } from '../services/shared/src/index.ts';
import { GATEWAY, GATEWAY_VISIBILITY, GatewayService, MIGRATIONS_DIR, MockNtsSource, MockProvider, gatewayRouter, openAIDecisionsBody } from '../services/gateway/src/index.ts';
import { D, H, client, edKey } from './services-kit.ts';
import { accountStack, signedDesktop, signedPhone, type Signed, type Stack } from './services-stack.ts';

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
}

async function start(o: { monthlyTokens?: number } = {}): Promise<Env> {
  const s = await accountStack();
  const db = openSqlite();
  await migrate(db, 'gateway', MIGRATIONS_DIR);
  const provider = new MockProvider();
  const nts = new MockNtsSource();
  const events: string[] = [];
  const svc = new GatewayService({
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
  });
  const logs: string[] = [];
  const server = createServer(gatewayRouter({ svc, verifier: s.verifier, directory: s.directory, publicOrigin: GW }), { logger: new Logger('gateway', (l) => logs.push(l), s.clock.now) });
  const req = client(await listen(server));
  const pc = await signedDesktop(s, 'gw@example.com');
  const call = async (path: string, body: unknown, who: Signed = pc) => req('POST', path, { headers: who.headers('POST', GW, path, await who.token()), body });
  const runToken = async (who: Signed = pc, scope: object = { runId: `run-${randomBytes(6).toString('hex')}` }) => {
    const r = await call('/v1/run-tokens', scope, who);
    assert.equal(r.status, 200, r.text);
    return r.json.runToken as string;
  };
  return { s, db, provider, nts, svc, server, req, logs, events, pc, call, runToken };
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
});
