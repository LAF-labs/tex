import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseRespond } from '../packages/chat-core/src/phone-gateway.ts';
import { CHAT_AGENT, CHAT_PHONE, CHAT_REPLY } from '../packages/model/src/index.ts';
import {
  ANTHROPIC_DEFAULT_MODEL,
  AnthropicProvider,
  GenerationSplitProvider,
  ProviderError,
  anthropicFallbacks,
  anthropicMessages,
  anthropicSchema,
  generationModels,
  providerFromEnv,
  type ModelProvider,
  type RespondSpec,
} from '../services/gateway/src/index.ts';

const ROUTING = { GW_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'k', OPENROUTER_ZDR: 'true', OPENROUTER_DATA_COLLECTION: 'deny', OPENROUTER_PROVIDERS: 'azure' };

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };
function fakeFetch(replies: Array<{ status?: number; body: unknown }>, sent: Sent[]): typeof fetch {
  return (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    sent.push({ url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> });
    const r = replies.shift()!;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
}

const spec = (t: typeof CHAT_AGENT | typeof CHAT_REPLY | typeof CHAT_PHONE, input: unknown[]): RespondSpec => ({
  model: 'claude-haiku-5-5',
  prefix: 'PREFIX',
  effort: t.effort,
  maxOutputTokens: t.maxOutputTokens,
  tools: t.tools,
  output: t.output,
  input,
  cacheKey: 'acct:x:t:y',
  safetyId: 'sid',
});
const user = (text: string) => ({ role: 'user', content: [{ type: 'input_text', text }] });

describe('게이트웨이: 생성만 Anthropic(GW_RESPOND_PROVIDER)', () => {
  it('기본은 지금 그대로, anthropic이면 키가 있어야 기동하고 판정은 기본 공급사에 남는다', () => {
    assert.equal(providerFromEnv(ROUTING).name, 'openrouter');
    assert.equal(providerFromEnv({ ...ROUTING, GW_RESPOND_PROVIDER: 'base' }).name, 'openrouter');
    assert.throws(() => providerFromEnv({ ...ROUTING, GW_RESPOND_PROVIDER: 'anthropic' }), /config_ANTHROPIC_API_KEY/);
    assert.throws(() => providerFromEnv({ ...ROUTING, GW_RESPOND_PROVIDER: 'claude' }), /config_GW_RESPOND_PROVIDER/);
    assert.throws(() => providerFromEnv({ ...ROUTING, GW_RESPOND_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a', ANTHROPIC_BASE_URL: 'http://api.anthropic.com' }), /config_ANTHROPIC_BASE_URL/);
    assert.equal(providerFromEnv({ ...ROUTING, GW_RESPOND_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'a' }).name, 'openrouter+anthropic');
  });

  it('모델 이름: anthropic이면 Claude 기본(claude-haiku-5-5), 바꿀 수 있고, base면 MODEL_*', () => {
    assert.deepEqual(generationModels({ GW_RESPOND_PROVIDER: 'anthropic', MODEL_RESPOND: 'deepseek/x' }), { respond: ANTHROPIC_DEFAULT_MODEL, agent: ANTHROPIC_DEFAULT_MODEL, vision: ANTHROPIC_DEFAULT_MODEL });
    assert.deepEqual(generationModels({ GW_RESPOND_PROVIDER: 'anthropic', ANTHROPIC_MODEL_RESPOND: 'claude-haiku-5-5', ANTHROPIC_MODEL_AGENT: 'claude-sonnet-5-5' }), { respond: 'claude-haiku-5-5', agent: 'claude-sonnet-5-5', vision: 'claude-sonnet-5-5' });
    assert.throws(() => generationModels({ GW_RESPOND_PROVIDER: 'anthropic', ANTHROPIC_MODEL_RESPOND: 'deepseek/x' }), /config_ANTHROPIC_MODEL/);
    assert.deepEqual(generationModels({ MODEL_RESPOND: 'deepseek/x', MODEL_AGENT: 'a' }), { respond: 'deepseek/x', agent: 'a' });
    assert.throws(() => generationModels({}), /config_MODEL_RESPOND/);
  });

  it('decide와 decision_pick은 기본 공급사, 그 밖 생성은 Anthropic', async () => {
    const calls: string[] = [];
    const fake = (n: string): ModelProvider => ({
      name: n,
      decide: () => (calls.push(`${n}.decide`), Promise.resolve({ model: 'm', answers: {}, usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } })),
      respond: () => (calls.push(`${n}.respond`), Promise.resolve({ model: 'm', status: 'completed', output: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } })),
    });
    const p = new GenerationSplitProvider(fake('base'), fake('gen'));
    await p.decide({} as never);
    await p.respond({ ...spec(CHAT_REPLY, []), decision: { state: 's', choices: { a: 'A', b: 'B' } } });
    await p.respond(spec(CHAT_REPLY, [user('x')]));
    assert.deepEqual(calls, ['base.decide', 'base.respond', 'gen.respond']);
  });

  it('요청 본문: x-api-key, 머리말 캐시, effort, 출력 스키마, 도구(strict 없음, 받지 않는 제약은 뺀다)', async () => {
    const sent: Sent[] = [];
    const p = new AnthropicProvider({ apiKey: 'sk-test', fetchFn: fakeFetch([{ body: { model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: { input_tokens: 10, output_tokens: 2 } } }], sent) });
    await p.respond(spec(CHAT_AGENT, [user('안녕')]));
    const s = sent[0]!;
    assert.equal(s.url, 'https://api.anthropic.com/v1/messages');
    assert.equal(s.headers['x-api-key'], 'sk-test');
    assert.equal(s.headers['anthropic-version'], '2026-10-21');
    assert.equal('authorization' in s.headers, false);
    const b = s.body;
    assert.equal(b.model, 'claude-haiku-5-5');
    assert.equal(b.max_tokens, CHAT_AGENT.maxOutputTokens);
    assert.equal('thinking' in b, false, '사고는 모델 기본(적응형)');
    assert.deepEqual(b.system, [{ type: 'text', text: 'PREFIX', cache_control: { type: 'ephemeral' } }]);
    assert.deepEqual(b.messages, [{ role: 'user', content: [{ type: 'text', text: '안녕' }] }]);
    assert.deepEqual((b.output_config as { effort: string }).effort, CHAT_AGENT.effort);
    assert.deepEqual((b.metadata as { user_id: string }).user_id, 'sid');
    const tools = b.tools as Array<{ name: string; strict?: boolean; input_schema: unknown }>;
    assert.equal(tools.length, CHAT_AGENT.tools.length);
    assert.ok(tools.every((t) => t.strict === undefined));
    const json = JSON.stringify([b.tools, b.output_config]);
    for (const k of ['"maxLength"', '"maximum"', '"minimum"', '"maxItems"', '"pattern"']) assert.equal(json.includes(k), false, `${k} 없음`);
    assert.equal('fallbacks' in b, false, 'Haiku에는 서버 쪽 대체가 없다');
    assert.equal('anthropic-beta' in s.headers, false);
    assert.ok(anthropicFallbacks('claude-opus-5-5') && anthropicFallbacks('claude-sonnet-5-5') && !anthropicFallbacks('claude-haiku-5-5'));
    const sent2: Sent[] = [];
    const q = new AnthropicProvider({ apiKey: 'k', fetchFn: fakeFetch([{ body: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }], usage: {} } }], sent2) });
    await q.respond({ ...spec(CHAT_REPLY, [user('x')]), model: 'claude-opus-5-5' });
    assert.equal(sent2[0]!.body.fallbacks, 'default');
    assert.equal(sent2[0]!.headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
    assert.deepEqual(anthropicSchema({ type: 'object', properties: { maxLength: { type: 'string', maxLength: 3 } }, required: ['maxLength'] }), { type: 'object', properties: { maxLength: { type: 'string' } }, required: ['maxLength'] }, '필드 이름은 지우지 않는다');
  });

  it('도구 호출 → reasoning 사본 + function_call, 다음 턴에 사본을 그대로 되돌리고 tool_result를 붙인다', async () => {
    const sent: Sent[] = [];
    const turn1 = [
      { type: 'thinking', thinking: '', signature: 'SIG1' },
      { type: 'text', text: '찾아볼게요' },
      { type: 'tool_use', id: 'toolu_1', name: CHAT_PHONE.tools[0]!.name, input: { counterparty: null } },
    ];
    const p = new AnthropicProvider({
      apiKey: 'k',
      fetchFn: fakeFetch(
        [
          { body: { model: 'claude-haiku-5-5', stop_reason: 'tool_use', content: turn1, usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7, output_tokens: 9 } } },
          { body: { model: 'claude-haiku-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'SIG2' }, { type: 'text', text: '{"reply":"ok"}' }], usage: { input_tokens: 1, output_tokens: 1 } } },
        ],
        sent,
      ),
    });
    const r1 = await p.respond(spec(CHAT_PHONE, [user('미수금 알려줘')]));
    assert.equal(r1.status, 'completed');
    assert.deepEqual(r1.usage, { inputTokens: 112, outputTokens: 9, cachedTokens: 100 });
    assert.deepEqual(
      r1.output.map((i) => i.type),
      ['reasoning', 'function_call'],
      '앞말 글은 출력 JSON이 아니므로 message로 내지 않는다',
    );
    assert.deepEqual(r1.output[1], { type: 'function_call', call_id: 'toolu_1', name: CHAT_PHONE.tools[0]!.name, arguments: '{"counterparty":null}' });
    const parsed = parseRespond({ status: r1.status, output: r1.output.map((item) => ({ item, tag: 'a'.repeat(64) })) });
    assert.equal(parsed.status, 'completed');

    const r2 = await p.respond(spec(CHAT_PHONE, [user('미수금 알려줘'), ...r1.output, { type: 'function_call_output', call_id: 'toolu_1', output: '없음' }]));
    assert.deepEqual(sent[1]!.body.messages, [
      { role: 'user', content: [{ type: 'text', text: '미수금 알려줘' }] },
      { role: 'assistant', content: turn1 },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '없음' }] },
    ]);
    assert.deepEqual(r2.output[1], { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '{"reply":"ok"}' }] });
  });

  it('사본 없는 이전 출력(다른 공급사)도 옮기고, 이미지는 base64 블록, 모르는 항목은 거부', () => {
    assert.deepEqual(
      anthropicMessages([
        { role: 'user', content: [{ type: 'input_text', text: 'a' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' }] },
        { type: 'reasoning', encrypted_content: 'x' },
        { type: 'function_call', call_id: 'c1', name: 'n', arguments: '{"a":1}' },
        { type: 'function_call_output', call_id: 'c1', output: 'o' },
      ]),
      [
        { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'QUJD' } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'n', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'o' }] },
      ],
    );
    assert.equal(anthropicMessages([{ role: 'user', content: [{ type: 'input_image', image_url: 'https://x/y.png' }] }]), null);
    assert.equal(anthropicMessages([{ type: 'weird' }]), null);
    assert.equal(anthropicMessages([]), null);
  });

  it('거절은 refusal, 길이 상한은 incomplete, 429·5xx는 재시도, 400은 재시도 없음', async () => {
    const sent: Sent[] = [];
    const events: string[] = [];
    const p = new AnthropicProvider({
      apiKey: 'k',
      onEvent: (e) => events.push(e),
      fetchFn: fakeFetch(
        [
          { body: { stop_reason: 'refusal', content: [], usage: {} } },
          { body: { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a' }], usage: {} } },
          { status: 429, body: {} },
          { status: 529, body: {} },
          { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'tools.0.input_schema: 사용자 글 not supported' } } },
        ],
        sent,
      ),
    });
    const s = spec(CHAT_REPLY, [user('x')]);
    const refused = await p.respond(s);
    assert.equal((refused.output[0]!.content as Array<{ type: string }>)[0]!.type, 'refusal');
    assert.equal((await p.respond(s)).status, 'incomplete');
    for (const retryable of [true, true, false]) {
      await assert.rejects(p.respond(s), (e: unknown) => e instanceof ProviderError && e.retryable === retryable);
    }
    assert.deepEqual(events.filter((e) => e.startsWith('upstream_anthropic_')), ['upstream_anthropic_429_unknown', 'upstream_anthropic_529_unknown', 'upstream_anthropic_400_invalid_request_error']);
    assert.deepEqual(events.filter((e) => e.startsWith('anthropic_err:')), ['anthropic_err:tools.0.input_schema:_not_supported']);
    assert.ok(!events.join(' ').includes('사용자'));
    await assert.rejects(p.decide(), ProviderError);
    await assert.rejects(p.respond({ ...s, decision: { state: 's', choices: { a: 'A' } } }), ProviderError);
  });
});
