// OpenAI 호환 Chat Completions 판정 어댑터(측정 전용, ADR-035 W-5·yulmu 2026-11-05 결정). base URL·모델 ID는 설정이고
// 송신은 @sax/net/demo의 DemoEgress.toCompatModel()만 한다(제품 송신 경로는 게이트웨이·BYOK Decisions뿐, D04 §1).
// Decisions API와 다른 점: 질문을 고정 접두 뒤 system 텍스트로 풀어 쓰고, 답은 json_schema(strict) 구조화 출력으로 받는다.
// 확률은 모델이 스스로 적은 값이라 Decisions의 확률과 같지 않다(임계값 프로필을 따로 잡아야 한다). choice 분포는 선택값 하나뿐이다.
// 응답 전체 거절(message.refusal)은 모든 질문의 refusal로 바꿔 각 질문의 onRefusal을 따른다(매핑이 쓰는 choice가 거절이면 번들 전체 unknown).
import { EgressError, ModelGuardError } from '@sax/net';
import type { RedactedText, RunToken } from '../contract.ts';
import type { LoadedBundle } from '../bundle/types.ts';
import { joinByName, type NormalizeResult, type RawAnswer } from '../normalize.ts';
import { AdapterError, type AdapterLimits, type DecideAdapter, type ProviderDecision } from './types.ts';

/** DemoEgress.toCompatModel 모양(구조 타입: 어댑터는 @sax/net/demo를 import하지 않는다). */
export interface CompatTransport {
  toCompatModel(
    req: { surface: 'decide'; gateway: { bundleId: string; bundleDigest: string; input: string; runToken: string }; providerBody: object },
    headers: Record<string, string>,
  ): Promise<{ status: number; json: unknown }>;
}

export interface OpenAICompatOptions {
  transport: CompatTransport;
  /** 키는 메모리에만. 로그·보고서·감사에 남기지 않는다. */
  apiKey: string;
  /** 공급사 모델 ID(예: OpenRouter `openai/gpt-…`) */
  model: string;
  /** 공급사별 추가 본문 필드(예: OpenRouter provider 라우팅·데이터 수집 거부) */
  extraBody?: Record<string, unknown>;
}

type Q = LoadedBundle['def']['questions'][number];

function answerSchema(q: Q): object {
  if (q.type === 'predicate') return { type: 'object', additionalProperties: false, required: ['probability'], properties: { probability: { type: 'number' } } };
  if (q.type === 'choice') return { type: 'object', additionalProperties: false, required: ['choice', 'confidence'], properties: { choice: { type: 'string', enum: q.choices.map((c) => c.value) }, confidence: { type: 'number' } } };
  return { type: 'object', additionalProperties: false, required: ['score', 'confidence'], properties: { score: { type: 'integer' }, confidence: { type: 'number' } } };
}

/** 질문 목록을 사람이 읽는 텍스트로(Decisions questions의 instructions·choices와 같은 내용). */
export function compatQuestionsText(b: LoadedBundle): string {
  const lines = ['# 질문', '각 질문에 답하고 JSON 객체 하나만 낸다. 키는 질문 이름이다. 확률·confidence는 0~1 사이 수다.'];
  for (const q of b.def.questions) {
    if (q.type === 'predicate') lines.push(`- ${q.name}: ${q.instructions} → {"probability": 참일 확률}`);
    else if (q.type === 'choice') lines.push(`- ${q.name}: ${q.instructions} 선택지: ${q.choices.map((c) => `${c.value}(${c.description})`).join(', ')} → {"choice": 값, "confidence": 확신}`);
    else lines.push(`- ${q.name}: ${q.instructions} 등급: ${q.levels.map((l, i) => `${i}=${l.label}(${l.description})`).join(', ')} → {"score": 등급 번호, "confidence": 확신}`);
  }
  return lines.join('\n');
}

export class OpenAICompatDecideAdapter implements DecideAdapter {
  readonly provider = 'openai_compat' as const;
  readonly model: string;
  readonly limits: AdapterLimits = { maxChoices: 255, maxQuestions: 64, refusals: true, maxRequestBytes: 200_000 };
  private readonly o: OpenAICompatOptions;

  constructor(o: OpenAICompatOptions) {
    this.o = o;
    this.model = o.model;
  }

  buildRequest(b: LoadedBundle, input: RedactedText): Record<string, unknown> {
    const properties: Record<string, object> = {};
    for (const q of b.def.questions) properties[q.name] = answerSchema(q);
    return {
      ...this.o.extraBody,
      model: this.o.model,
      temperature: 0,
      messages: [
        { role: 'system', content: `${b.prefixText}\n\n${compatQuestionsText(b)}` },
        { role: 'user', content: input },
      ],
      response_format: { type: 'json_schema', json_schema: { name: b.wireId, strict: true, schema: { type: 'object', additionalProperties: false, required: Object.keys(properties), properties } } },
    };
  }

  requestBytes(b: LoadedBundle, input: RedactedText): number {
    return Buffer.byteLength(JSON.stringify(this.buildRequest(b, input)), 'utf8');
  }

  async call(b: LoadedBundle, input: RedactedText, runToken: RunToken): Promise<ProviderDecision> {
    const body = this.buildRequest(b, input);
    const started = performance.now();
    let r: { status: number; json: unknown };
    try {
      r = await this.o.transport.toCompatModel({ surface: 'decide', gateway: { bundleId: b.wireId, bundleDigest: b.digest, input, runToken }, providerBody: body }, { authorization: `Bearer ${this.o.apiKey}` });
    } catch (e) {
      if (e instanceof ModelGuardError) throw new AdapterError(`guard_${e.code}`);
      throw new AdapterError(e instanceof EgressError && e.code === 'timeout' ? 'timeout' : 'egress');
    }
    if (r.status === 429) throw new AdapterError('rate_limited', r.status);
    if (r.status === 401 || r.status === 403) throw new AdapterError('auth', r.status);
    if (r.status === 402) throw new AdapterError('quota', r.status);
    if (r.status >= 400 && r.status < 500) throw new AdapterError('bad_request', r.status);
    if (r.status >= 500) throw new AdapterError('unavailable', r.status);
    const j = (r.json ?? {}) as { model?: unknown; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } };
    const u = j.usage ?? {};
    return {
      model: typeof j.model === 'string' ? j.model : this.o.model,
      body: r.json,
      usage: { inputTokens: u.prompt_tokens ?? 0, cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0, cacheWriteTokens: 0, outputTokens: u.completion_tokens ?? 0 },
      latencyMs: performance.now() - started,
      rateLimit: {},
      attempts: 1,
    };
  }

  normalize(b: LoadedBundle, raw: ProviderDecision): NormalizeResult {
    const msg = (raw.body as { choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }> })?.choices?.[0]?.message;
    if (!msg) return { ok: false, reason: 'answer_type_mismatch' };
    if (typeof msg.refusal === 'string' && msg.refusal) return joinByName(b.def, b.def.questions.map((q) => [q.name, { type: 'refusal' as const }]));
    let obj: unknown;
    try {
      obj = JSON.parse(String(msg.content).replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
    } catch {
      return { ok: false, reason: 'answer_type_mismatch' };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'answer_type_mismatch' };
    const types = new Map(b.def.questions.map((q) => [q.name, q.type]));
    const entries: Array<[unknown, RawAnswer]> = [];
    for (const [name, v] of Object.entries(obj as Record<string, Record<string, unknown> | null>)) {
      const t = types.get(name);
      const a = v ?? {};
      if (t === 'predicate') entries.push([name, { type: 'predicate', probability: a.probability }]);
      else if (t === 'choice') entries.push([name, { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: [{ value: a.choice, probability: a.confidence }] }]);
      else if (t === 'score') entries.push([name, { type: 'score', score: a.score, confidence: a.confidence }]);
      else entries.push([name, { type: 'refusal' }]); // 모르는 이름: joinByName이 answer_names_mismatch로 거른다
    }
    return joinByName(b.def, entries);
  }
}
