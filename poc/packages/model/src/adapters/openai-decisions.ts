// OpenAI Decisions 어댑터(BYOK 직결, D04 §1·§2·§8). 게이트웨이 경로도 같은 요청 조립을 쓰고 baseURL·인증만 다르다(Phase 1).
// - SDK 재시도 끔(maxRetries: 0), 재시도는 retry.ts가 소유
// - prompt_cache_options.mode = "explicit", 브레이크포인트는 고정 접두(developer 블록) 끝에만(D04 §2.1)
// - Decisions에는 store 필드가 없다(R1 §A.2, SDK DecisionCreateParams). store:false는 Responses 어댑터에 고정한다.
// - 모든 송신은 @sax/net egress.toModel()의 검사 4종을 거치고 SDK의 fetch는 egress.providerFetch다.
import OpenAI from 'openai';
import type { DecisionCreateParams } from 'openai/resources/decisions';
import { EgressError, ModelGuardError, type Egress } from '@sax/net';
import type { RedactedText, RunToken } from '../contract.ts';
import type { LoadedBundle, Question } from '../bundle/types.ts';
import { joinByName, type NormalizeResult, type RawAnswer } from '../normalize.ts';
import { DEFAULT_RETRY, withRetry, type ErrorView, type RetryPolicy } from './retry.ts';
import { AdapterError, type AdapterLimits, type DecideAdapter, type ProviderDecision } from './types.ts';

export const LUNA = 'gpt-6-luna';

export interface OpenAIDecisionsOptions {
  apiKey: string;
  egress: Egress;
  model?: string;
  retry?: RetryPolicy;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

function toQuestion(q: Question): DecisionCreateParams['questions'][number] {
  if (q.type === 'predicate') return { type: 'predicate', name: q.name, instructions: q.instructions };
  if (q.type === 'choice') return { type: 'choice', name: q.name, instructions: q.instructions, choices: q.choices.map((c) => ({ value: c.value, description: c.description })) };
  return { type: 'score', name: q.name, instructions: q.instructions, levels: q.levels.map((l) => ({ label: l.label, description: l.description })) };
}

export function errorView(e: unknown): ErrorView | AdapterError {
  if (e instanceof ModelGuardError) return new AdapterError(`guard_${e.code}`);
  if (e instanceof EgressError) return new AdapterError('egress');
  if (e instanceof OpenAI.APIConnectionTimeoutError) return { kind: 'timeout' };
  if (e instanceof OpenAI.APIConnectionError) return (e as { cause?: unknown }).cause instanceof EgressError ? new AdapterError('egress') : { kind: 'connection' };
  if (e instanceof OpenAI.APIError) return { kind: 'api', status: e.status, code: e.code ?? (e.error as { code?: string } | undefined)?.code, headers: e.headers ?? null };
  return { kind: 'other' };
}

export function rateLimitHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    if (k.startsWith('x-ratelimit-') || k === 'retry-after' || k === 'retry-after-ms' || k === 'openai-processing-ms' || k === 'x-request-id') out[k] = v;
  });
  return out;
}

export class OpenAIDecisionsAdapter implements DecideAdapter {
  readonly provider = 'openai' as const;
  readonly model: string;
  readonly limits: AdapterLimits = { maxChoices: 255, maxQuestions: 400, refusals: true, maxRequestBytes: 900_000 };
  private readonly client: OpenAI;
  private readonly egress: Egress;
  private readonly opts: OpenAIDecisionsOptions;

  constructor(opts: OpenAIDecisionsOptions) {
    this.opts = opts;
    this.egress = opts.egress;
    this.model = opts.model ?? LUNA;
    this.client = new OpenAI({ apiKey: opts.apiKey, organization: null, project: null, fetch: opts.egress.providerFetch, maxRetries: 0, timeout: opts.timeoutMs ?? 15_000 });
  }

  buildRequest(b: LoadedBundle, input: RedactedText): DecisionCreateParams {
    return {
      model: this.model,
      prompt_cache_options: { mode: 'explicit', ttl: '30m' },
      // BYOK는 사용자 자기 조직이라 계정 격리 HMAC(게이트웨이 정본 acct:<HMAC>:b:<id>)가 필요 없다. 형식 제한은 S9에서 본다.
      prompt_cache_key: `sax:b:${b.wireId}`,
      input: [
        { role: 'developer', content: [{ type: 'input_text', text: b.prefixText, prompt_cache_breakpoint: { mode: 'explicit' } }] },
        { role: 'user', content: [{ type: 'input_text', text: input }] },
      ],
      questions: b.def.questions.map(toQuestion),
    };
  }

  requestBytes(b: LoadedBundle, input: RedactedText): number {
    return Buffer.byteLength(JSON.stringify(this.buildRequest(b, input)), 'utf8');
  }

  async call(b: LoadedBundle, input: RedactedText, runToken: RunToken): Promise<ProviderDecision> {
    const body = this.buildRequest(b, input);
    const started = performance.now();
    try {
      const { value, attempts } = await this.egress.toModel(
        { surface: 'decide', dest: 'openai', path: '/v1/decisions', gateway: { bundleId: b.wireId, bundleDigest: b.digest, input, runToken }, providerBody: body },
        (headers) => withRetry(() => this.client.decisions.create(body, { headers }).withResponse(), errorView, { policy: this.opts.retry ?? DEFAULT_RETRY, sleep: this.opts.sleep, random: this.opts.random }),
      );
      const u = value.data.usage;
      return {
        model: value.data.model,
        body: value.data,
        usage: { inputTokens: u?.input_tokens ?? 0, cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0, cacheWriteTokens: u?.input_tokens_details?.cache_write_tokens ?? 0, outputTokens: u?.output_tokens ?? 0 },
        latencyMs: performance.now() - started,
        rateLimit: rateLimitHeaders(value.response.headers),
        attempts,
      };
    } catch (e) {
      if (e instanceof AdapterError) throw e;
      const v = errorView(e);
      throw v instanceof AdapterError ? v : new AdapterError('unavailable');
    }
  }

  normalize(b: LoadedBundle, raw: ProviderDecision): NormalizeResult {
    const entries = decisionsEntries((raw.body as { answers?: unknown }).answers);
    return entries ? joinByName(b.def, entries) : { ok: false, reason: 'answer_type_mismatch' };
  }
}

/** Decisions 와이어 answers[] → 이름·중간 표현 쌍. L0 규칙 어댑터의 가짜 Decisions 응답도 이 함수를 지난다. */
export function decisionsEntries(answers: unknown): Array<[unknown, RawAnswer]> | null {
  if (!Array.isArray(answers)) return null;
  const entries: Array<[unknown, RawAnswer]> = [];
  for (const a of answers as Array<Record<string, unknown>>) {
    const t = a?.type;
    if (t === 'refusal') entries.push([a.name, { type: 'refusal' }]);
    else if (t === 'predicate') entries.push([a.name, { type: 'predicate', probability: a.probability }]);
    else if (t === 'choice') entries.push([a.name, { type: 'choice', choice: a.choice, confidence: a.confidence, probabilities: a.probabilities }]);
    else if (t === 'score') entries.push([a.name, { type: 'score', score: a.score, confidence: a.confidence }]);
    else return null;
  }
  return entries;
}
