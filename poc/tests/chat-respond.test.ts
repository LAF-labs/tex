// 대화 짧은 응대 chat.respond(팀장 지시 2026-11-10, D04 §4.1). 마스킹 → 게이트웨이 /v1/respond(chat_reply) → 출력 검증.
// 세무 판단 출력 차단(D04 §3)·길이 상한·식별자/링크 차단·스키마 불일치 오류·게이트웨이 불가 오류(오프라인 대체 없음).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { CounterpartyRepo, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import { CHAT_ADVICE_TEXT, CHAT_FALLBACK_TEXT, chatAdviceMentioned, checkOutput, gatewayIntentModel, IntentResolver, type ChatReply } from '@sax/engine';
import { BundleCatalog, CHAT_CAPABILITIES, CHAT_REPLY, CHAT_REPLY_MAX_CHARS, toolsetPrefix } from '@sax/model';
import { Egress } from '@sax/net';
import { startGatewayMock, type GatewayMock } from './fixtures/gateway-mock.ts';

const root = path.resolve(import.meta.dirname, '..');
const chatSrc = fs.readFileSync(path.join(root, 'packages/engine/src/chat.ts'), 'utf8');
const catalog = BundleCatalog.load();
const CP_BIZ = syntheticBizNo(71);

let dir: string;
let db: Db;
let mock: GatewayMock;
const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);
const gatewayEgress = () =>
  new Egress({ env: {}, testOrigins: { gateway: mock.origin }, gateway: { auth: { headers: async () => ({ authorization: 'DPoP device-token', dpop: 'proof' }) }, bundles: catalog.allowEntries() } });
const resolver = () => new IntentResolver(db, { model: gatewayIntentModel(gatewayEgress(), { promoted: new Set() }) });
const responds = () => mock.calls.filter((c) => c.path === '/v1/respond');
const tokens = () => mock.calls.filter((c) => c.path === '/v1/run-tokens');
const out = (o: unknown) => [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'enc' },
  { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: typeof o === 'string' ? o : JSON.stringify(o) }] },
];
const reply = (o: Partial<{ kind: string; reply: string; suggest: string[] }>) => out({ kind: 'help', reply: '세금계산서 발급을 도와드릴 수 있어요.', suggest: [], ...o });
const chat = async (r: IntentResolver, text: string) => (await r.handle('chat.respond', { text })) as ChatReply;

before(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-chat-'));
  db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  new ProfileRepo(db).upsert({ kind: 'business', displayName: '바다상회', bizNo: syntheticBizNo(70), corpNo: null, repName: '박바다', bizType: null, bizItem: null, address: null, email: null, signMethod: null });
  new CounterpartyRepo(db).create({ bizNo: CP_BIZ, name: '다라상사', repName: '최다라', email: 'da@example.com' });
  mock = await startGatewayMock();
});
after(async () => {
  await mock.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  mock.opts = {};
  mock.calls.length = 0;
});

describe('chat_reply 툴셋 정의', () => {
  it('도구 없음·1턴·출력 1000토큰·effort low, 출력은 kind·reply·suggest(허용 id 0~3개)', () => {
    assert.equal(CHAT_REPLY.id, 'chat_reply');
    assert.deepEqual(CHAT_REPLY.tools, []);
    assert.equal(CHAT_REPLY.maxTurns, 1);
    assert.ok(CHAT_REPLY.maxOutputTokens <= 1_000);
    assert.equal(CHAT_REPLY.effort, 'low');
    const s = CHAT_REPLY.output.schema as { required: string[]; additionalProperties: boolean; properties: Record<string, { enum?: string[]; maxItems?: number; items?: { enum: string[] } }> };
    assert.deepEqual(s.required, ['kind', 'reply', 'suggest']);
    assert.equal(s.additionalProperties, false);
    assert.deepEqual(s.properties.kind!.enum, ['help', 'clarify', 'smalltalk', 'tax_advice', 'out_of_scope']);
    assert.equal(s.properties.suggest!.maxItems, 3);
    assert.deepEqual(s.properties.suggest!.items!.enum, CHAT_CAPABILITIES.map((c) => c.id));
  });

  it('머리말: 공통 판정기 머리말 없이 chat_reply만, 할 수 있는 일 목록이 표(CHAT_CAPABILITIES)와 같다', () => {
    const p = toolsetPrefix(CHAT_REPLY);
    assert.doesNotMatch(p, /판정기다/);
    const listed = [...p.matchAll(/^- ([a-z.]+): (.+)$/gm)].map((m) => ({ id: m[1], label: m[2] }));
    assert.deepEqual(listed, CHAT_CAPABILITIES.map((c) => ({ id: c.id, label: c.label })));
    assert.match(p, /세무 판단은 어떤 kind에서도 하지 않는다/);
    // 할 수 있는 일은 intent_route_v1 playbook 어휘 안에 있다(데스크톱이 같은 id로 작업을 연다)
    const q = catalog.get('intent_route_v1')!.def.questions.find((x) => x.name === 'playbook')!;
    const vocab = q.type === 'choice' ? q.choices.map((c) => c.value) : [];
    for (const c of CHAT_CAPABILITIES) assert.ok(vocab.includes(c.id), c.id);
  });
});

describe('chat.respond 경로(마스킹 → /v1/respond → 검증)', () => {
  it('정상 답: 문장·종류·제안을 돌려준다. 실행 토큰은 intent.resolve와 같은 대화 세션 범위 하나', async () => {
    mock.opts = { respondOutput: reply({ kind: 'clarify', reply: '세금계산서를 발급할까요, 증명서를 뗄까요?', suggest: ['hometax.invoice.issue', 'hometax.cert.business', 'hometax.invoice.issue'] }) };
    const r = resolver();
    assert.deepEqual(await chat(r, '그거 좀 해 줘'), { reply: '세금계산서를 발급할까요, 증명서를 뗄까요?', kind: 'clarify', suggest: ['hometax.invoice.issue', 'hometax.cert.business'], filtered: null });
    mock.opts = { answers: { playbook: 'none_of_these', mentions_tax_advice: 0.02 } };
    await r.handle('intent.resolve', { text: '안녕' });
    assert.equal(tokens().length, 1);
    const body = responds()[0]!.body!;
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'replay', 'runToken', 'toolset']);
    assert.equal(body.toolset, 'chat_reply');
    assert.deepEqual(body.replay, []);
    assert.equal((body.messages as unknown[]).length, 1, '이전 대화 턴은 보내지 않는다');
  });

  it('마스킹: 거래처 상호·대표자·이메일·사업자번호, 내 상호, 금액은 게이트웨이로 가지 않는다', async () => {
    mock.opts = { respondOutput: reply({}) };
    await chat(resolver(), `바다상회인데 다라상사(최다라, da@example.com, ${CP_BIZ})한테 1,100,000원 그거 어떻게 해?`);
    const text = JSON.stringify(responds()[0]!.body!.messages);
    for (const v of ['바다상회', '다라상사', '최다라', 'da@example.com', CP_BIZ, '1,100,000']) assert.ok(!text.includes(v), v);
  });

  it('세무 판단 차단: 모델이 tax_advice라 하거나 답에 세무 판단 말이 있으면 고정 문구로 바꾼다', async () => {
    const r = resolver();
    mock.opts = { respondOutput: reply({ kind: 'tax_advice', reply: '아무 말', suggest: [] }) };
    assert.deepEqual(await chat(r, '종소세 줄이는 법'), { reply: CHAT_ADVICE_TEXT, kind: 'tax_advice', suggest: [], filtered: 'advice' });
    for (const bad of ['그 비용은 경비로 처리하시면 돼요.', '이 경우 공제받을 수 있어요.', '부가세는 약 10% 정도 나와요.', '신고 기한은 25일까지예요.', '절세하려면 간이과세가 나아요.', '환급 대상일 수 있어요.']) {
      mock.opts = { respondOutput: reply({ kind: 'help', reply: bad, suggest: ['hometax.invoice.issue'] }) };
      const x = await chat(r, '이거 뭐야');
      assert.equal(x.reply, CHAT_ADVICE_TEXT, bad);
      assert.equal(x.filtered, 'advice');
    }
    // 발급 안내는 세무 판단이 아니다
    for (const ok of ['세금계산서 발급을 도와드릴 수 있어요.', '납세증명서나 사업자등록증명을 떼 드릴 수 있어요.', '부가세 별도 금액으로 계산서를 끊을까요?', '안녕하세요! 무엇을 도와드릴까요?']) assert.equal(chatAdviceMentioned(ok), false, ok);
  });

  it('길이 상한: 200자를 넘으면 chat.bad_response(자르지 않는다), 빈 답도 오류', async () => {
    const r = resolver();
    mock.opts = { respondOutput: reply({ reply: '가'.repeat(CHAT_REPLY_MAX_CHARS) }) };
    assert.equal((await chat(r, '안녕')).reply.length, CHAT_REPLY_MAX_CHARS);
    mock.opts = { respondOutput: reply({ reply: '가'.repeat(CHAT_REPLY_MAX_CHARS + 1) }) };
    await code(chat(r, '안녕'), 'chat.bad_response');
    mock.opts = { respondOutput: reply({ reply: '  \n ' }) };
    await code(chat(r, '안녕'), 'chat.bad_response');
  });

  it('식별자·링크·마스킹 토큰이 섞인 답은 고정 안내로 바꾼다', async () => {
    const r = resolver();
    for (const bad of ['공동인증서 비밀번호를 입력하세요.', '보안카드 번호를 알려 주세요.', '[NAME_1]에 계산서를 끊을까요?', '고객센터 010-1234-5678로 연락하세요.', '자세한 건 https://example.com 에서 보세요.', 'help@example.com 으로 메일 주세요.', `${CP_BIZ} 사업자로 발급할까요?`]) {
      mock.opts = { respondOutput: reply({ reply: bad }) };
      const x = await chat(r, '이거 뭐야');
      assert.equal(x.reply, CHAT_FALLBACK_TEXT, bad);
      assert.equal(x.filtered, 'unsafe');
    }
    mock.opts = { respondOutput: reply({ reply: '세 가지 일을 도와드려요. 2026년 계산서도 됩니다.' }) };
    assert.equal((await chat(r, '뭐 할 수 있어')).filtered, null);
  });

  it('응답은 신뢰하지 않는다: 스키마 다름·허용 밖 제안·도구 호출·툴셋 해시 다름 → chat.bad_response', async () => {
    const r = resolver();
    for (const o of [
      reply({ kind: 'joke' }),
      reply({ suggest: ['hometax.invoice.amend'] }),
      reply({ suggest: ['hometax.invoice.issue', 'hometax.cert.business', 'hometax.cert.taxpayment', 'hometax.invoice.issue'] }),
      out({ kind: 'help', reply: '네', suggest: [], extra: 1 }),
      out({ kind: 'help', reply: '네' }),
      out('not json'),
      [{ type: 'function_call', call_id: 'c1', name: 'x', arguments: '{}' }],
      [{ type: 'web_search_call', id: 'w1' }],
    ]) {
      mock.opts = { respondOutput: o };
      await code(chat(r, '안녕'), 'chat.bad_response');
    }
    mock.opts = { respondOutput: reply({}), tamperToolset: true };
    await code(chat(r, '안녕'), 'chat.bad_response');
    // 어댑터를 거치지 않아도 같은 검사(checkOutput 단독)
    assert.throws(() => checkOutput({ kind: 'help', reply: '네', suggest: ['gov24.resident.copy'] }), /chat.bad_response/);
    assert.throws(() => checkOutput(null), /chat.bad_response/);
  });

  it('모델 거절은 고정 안내(filtered refusal), 미완료는 chat.unavailable', async () => {
    const r = resolver();
    mock.opts = { respondOutput: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'no' }] }] };
    assert.deepEqual(await chat(r, '이상한 말'), { reply: CHAT_FALLBACK_TEXT, kind: 'out_of_scope', suggest: [], filtered: 'refusal' });
    mock.opts = { respondOutput: reply({}), respondStatus: 'incomplete' };
    await code(chat(r, '안녕'), 'chat.unavailable');
  });
});

describe('fail-closed: 오프라인 대체 없음', () => {
  it('게이트웨이 설정이 없으면 송신 없이 chat.unavailable', async () => {
    await code(new IntentResolver(db, { model: null }).handle('chat.respond', { text: '안녕' }), 'chat.unavailable');
    assert.equal(mock.calls.length, 0);
  });

  it('게이트웨이 불가·토큰 실패 → chat.unavailable(토큰은 다시 받는다), 예산·월 한도는 따로 코드(토큰 유지)', async () => {
    const r = resolver();
    mock.opts = { fail: { '/v1/respond': { status: 503, code: 'gateway.unavailable' } } };
    await code(chat(r, '안녕'), 'chat.unavailable');
    mock.opts = { respondOutput: reply({}) };
    assert.equal((await chat(r, '안녕')).filtered, null);
    assert.equal(tokens().length, 2);
    mock.opts = { fail: { '/v1/respond': { status: 429, code: 'gateway.run_budget_exceeded' } } };
    await code(chat(r, '안녕'), 'chat.budget_exceeded');
    mock.opts = { fail: { '/v1/respond': { status: 429, code: 'gateway.quota_exceeded' } } };
    await code(chat(r, '안녕'), 'chat.quota_exceeded');
    assert.equal(tokens().length, 2);
    mock.opts = { fail: { '/v1/run-tokens': { status: 401, code: 'gateway.unauthorized' } } };
    await code(chat(resolver(), '안녕'), 'chat.unavailable');
  });

  it('문장 검사 bad_text, 마스킹 뒤 2048바이트 초과 chat.input_too_large, 비밀 값 문장 chat.secret_rejected(보내지 않는다)', async () => {
    const r = resolver();
    await code(r.handle('chat.respond', { text: '' }), 'bad_text');
    await code(r.handle('chat.respond', { text: 3 } as never), 'bad_text');
    await code(r.handle('chat.respond', { text: '가'.repeat(2001) }), 'bad_text');
    await code(r.handle('chat.respond', { text: '계'.repeat(1000) }), 'chat.input_too_large');
    await code(r.handle('chat.respond', { text: '홈택스 비밀번호는 abcd1234!' }), 'chat.secret_rejected');
    await code(r.handle('chat.respond', { text: 'pw: Hello2026' }), 'chat.secret_rejected');
    assert.equal(responds().length, 0);
    mock.opts = { respondOutput: reply({}) };
    assert.equal((await chat(r, '홈택스 비밀번호 잊어버렸어')).filtered, null);
  });

  it('로그·저널에 문장·답을 남기지 않는다', () => {
    assert.doesNotMatch(chatSrc, /\blog\.|console\.|journal\(/);
  });
});
