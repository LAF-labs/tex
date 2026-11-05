// 측정 전용 OpenAI 호환 Chat Completions 판정(ADR-035 W-5, 2026-11-05 yulmu: 실측은 OpenRouter 키).
// DemoEgress.toCompatModel이 BYOK와 같은 검사를 하는지, 어댑터가 json_schema 답을 이름 조인으로 정규화하는지 본다.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { BundleCatalog, DefaultModelLayer, OpenAICompatDecideAdapter, ThresholdProfiles, compatQuestionsText, localRunToken } from '@sax/model';
import { DemoEgress } from '@sax/net/demo';
import { apply } from '@sax/redaction';

const catalog = BundleCatalog.load();
const base = ThresholdProfiles.load();
const MODEL = 'test/compat-model';
const profiles = new ThresholdProfiles([...base.items, ...catalog.list().map((b) => ({ bundle: b.wireId, bundleDigest: b.digest, provider: 'openai_compat' as const, model: MODEL, status: 'initial' as const, overrides: [] }))]);
const screen = (t: string) => apply(t, { runId: 'r1' }).redacted;

interface Seen {
  body: Record<string, unknown>;
  auth: string | undefined;
}

describe('OpenAI 호환 판정 어댑터 + DemoEgress.toCompatModel', () => {
  let server: http.Server;
  let origin = '';
  const seen: Seen[] = [];
  let reply: (body: Record<string, unknown>) => { status: number; json: unknown } = () => ({ status: 500, json: {} });
  before(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        seen.push({ body, auth: req.headers.authorization });
        const r = reply(body);
        res.writeHead(r.status, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const setup = () => {
    const egress = new DemoEgress({ env: {}, testOrigins: { openrouter: origin }, modelGuard: { bundles: catalog.allowEntries() }, timeoutMs: 2_000 });
    const decider = new OpenAICompatDecideAdapter({ transport: egress, apiKey: 'sk-or-test', model: MODEL, extraBody: { provider: { data_collection: 'deny' } } });
    const layer = new DefaultModelLayer({ catalog, profiles, decider });
    return { egress, decider, layer, tok: () => localRunToken(egress, { runId: `compat-${seen.length}-${Math.random()}` }) };
  };
  const answer = (obj: unknown) => ({ status: 200, json: { model: MODEL, choices: [{ message: { role: 'assistant', content: JSON.stringify(obj) } }], usage: { prompt_tokens: 1500, completion_tokens: 60 } } });
  const ssAnswers = (screenVal: string, over: Record<string, number> = {}) => {
    const b = catalog.get('screen_state_v2')!;
    const o: Record<string, unknown> = {};
    for (const q of b.def.questions) o[q.name] = q.type === 'choice' ? { choice: screenVal, confidence: 0.95 } : { probability: over[q.name] ?? 0.02 };
    return o;
  };

  it('요청: system = 고정 접두 + 질문 설명, user = 마스킹 입력, json_schema strict, 추가 필드, Bearer 키', async () => {
    reply = () => answer(ssAnswers('logged_in_home'));
    const { layer, tok } = setup();
    const b = catalog.get('screen_state_v2')!;
    const input = screen('link "로그아웃"\nheading "My홈택스"');
    const r = await layer.decide({ bundleId: 'screen_state_v2', bundleDigest: b.digest, input, runToken: tok() });
    assert.equal(r.outcome, 'logged_in');
    assert.equal(r.provider, 'openai_compat');
    assert.equal(r.usage.inputTokens, 1500);
    const s = seen.at(-1)!;
    assert.equal(s.auth, 'Bearer sk-or-test');
    const msgs = s.body.messages as Array<{ role: string; content: string }>;
    assert.deepEqual(msgs.map((m) => m.role), ['system', 'user']);
    assert.ok(msgs[0]!.content.startsWith(b.prefixText));
    assert.ok(msgs[0]!.content.endsWith(compatQuestionsText(b)));
    assert.equal(msgs[1]!.content, input);
    const rf = s.body.response_format as { json_schema: { strict: boolean; schema: { required: string[] } } };
    assert.equal(rf.json_schema.strict, true);
    assert.deepEqual(rf.json_schema.schema.required, b.def.questions.map((q) => q.name));
    assert.deepEqual(s.body.provider, { data_collection: 'deny' });
    assert.equal(s.body.model, MODEL);
  });

  it('보안 경고가 높으면 blocked, 응답 전체 거절은 질문별 refusal → 진행 결과로 가지 않는다(unknown)', async () => {
    const { layer, tok } = setup();
    const b = catalog.get('screen_state_v2')!;
    reply = () => answer(ssAnswers('logged_in_home', { security_warning: 0.9 }));
    assert.equal((await layer.decide({ bundleId: 'screen_state_v2', bundleDigest: b.digest, input: screen('link "로그아웃"'), runToken: tok() })).outcome, 'blocked');
    reply = () => ({ status: 200, json: { choices: [{ message: { content: null, refusal: '도울 수 없습니다' } }] } });
    const r = await layer.decide({ bundleId: 'screen_state_v2', bundleDigest: b.digest, input: screen('heading "x"'), runToken: tok() });
    assert.equal(r.outcome, 'unknown');
    assert.deepEqual([...r.refusals].sort(), b.def.questions.map((q) => q.name).sort());
  });

  it('없는 선택지·빠진 질문·JSON 아님은 unknown, HTTP 오류 코드는 provider:*', async () => {
    const { layer, tok } = setup();
    const b = catalog.get('screen_state_v2')!;
    const req = () => ({ bundleId: 'screen_state_v2', bundleDigest: b.digest, input: screen('heading "y"'), runToken: tok() });
    reply = () => answer({ ...ssAnswers('admin_console') });
    assert.equal((await layer.decide(req())).reason, 'answer_value_invalid');
    const missing = ssAnswers('logged_in_home');
    delete missing.captcha_visible;
    reply = () => answer(missing);
    assert.equal((await layer.decide(req())).reason, 'answer_names_mismatch');
    reply = () => ({ status: 200, json: { choices: [{ message: { content: '알겠습니다' } }] } });
    assert.equal((await layer.decide(req())).reason, 'answer_type_mismatch');
    for (const [status, want] of [[429, 'provider:rate_limited'], [401, 'provider:auth'], [402, 'provider:quota'], [503, 'provider:unavailable']] as const) {
      reply = () => ({ status, json: {} });
      assert.equal((await layer.decide(req())).reason, want);
    }
  });

  it('송신 전 검사: 주민번호 평문·발급 영수증 없는 문자열은 나가지 않는다', async () => {
    const { layer, egress, tok } = setup();
    const b = catalog.get('screen_state_v2')!;
    const n = seen.length;
    const r1 = await layer.decide({ bundleId: 'screen_state_v2', bundleDigest: b.digest, input: 'text "900101-1234568"' as never, runToken: tok() });
    const r2 = await layer.decide({ bundleId: 'screen_state_v2', bundleDigest: b.digest, input: 'heading "홈택스"' as never, runToken: tok() });
    assert.deepEqual([r1.reason, r2.reason], ['guard:pii_tripwire', 'guard:unminted_text']);
    assert.equal(seen.length, n);
    assert.deepEqual(egress.securityEvents.map((e) => e.code), ['egress.pii_tripwire', 'egress.unminted_text']);
  });

  it('modelGuard 없는 DemoEgress는 판정을 보내지 않는다', async () => {
    const egress = new DemoEgress({ env: {}, testOrigins: { openrouter: origin } });
    await assert.rejects(egress.toCompatModel({ surface: 'decide', gateway: { bundleId: 'x', bundleDigest: 'y', input: 'z', runToken: 't' }, providerBody: {} }, {}), { code: 'destination_not_allowed' });
  });
});
