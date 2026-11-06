// 공급사 어댑터(ADR-015: 공급사 종속 코드는 이 파일 한 곳). 게이트웨이 본체는 공급사 중립 요청(DecideSpec·RespondSpec)만 만든다.
// 여기서 와이어 필드 이름(prompt_cache_key·safety_identifier 등)으로 옮긴다. 키·주소는 환경 변수로만 받는다(ENV.md).
import type { Question } from '@sax/model';

/** 공급사 중립 판정 요청. 질문·접두는 번들 정의에서 게이트웨이가 넣는다(클라이언트 필드 아님). */
export interface DecideSpec {
  model: string;
  prefix: string;
  input: string;
  questions: Question[];
  /** 계정 격리 캐시 키(acct:<HMAC>:b:<bundleId>) */
  cacheKey: string;
  /** 월 회전 남용 추적 식별자 */
  safetyId: string;
}

export interface RespondSpec {
  model: string;
  prefix: string;
  effort: 'low' | 'medium';
  maxOutputTokens: number;
  tools: Array<{ name: string; parameters: Record<string, unknown> }>;
  output: { name: string; schema: Record<string, unknown> };
  /** 사용자 메시지(input_text만)와 재생 항목(태그 검증을 통과한 이전 출력·function_call_output) */
  input: unknown[];
  cacheKey: string;
  safetyId: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** 계량에만 쓰고 클라이언트에 넘기지 않는다(적중 여부 오라클 차단, D04 §7) */
  cachedTokens: number;
}

export interface DecideResult {
  model: string;
  answers: unknown;
  usage: ProviderUsage;
}

export interface RespondResult {
  model: string;
  status: string;
  output: Array<Record<string, unknown>>;
  usage: ProviderUsage;
}

/** retryable: 5xx·429·연결 오류(지수 백오프 2회), fatal: 그 밖 */
export class ProviderError extends Error {
  readonly retryable: boolean;
  constructor(kind: 'retryable' | 'fatal') {
    super(kind);
    this.retryable = kind === 'retryable';
  }
}

export interface ModelProvider {
  readonly name: string;
  decide(s: DecideSpec): Promise<DecideResult>;
  respond(s: RespondSpec): Promise<RespondResult>;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);

function usageOf(u: unknown): ProviderUsage {
  const o = (u ?? {}) as { input_tokens?: unknown; output_tokens?: unknown; input_tokens_details?: { cached_tokens?: unknown } };
  return { inputTokens: num(o.input_tokens), outputTokens: num(o.output_tokens), cachedTokens: num(o.input_tokens_details?.cached_tokens) };
}

/** OpenAI Decisions·Responses 와이어(packages/model 어댑터와 같은 모양, 캐시 키·safety_identifier만 게이트웨이 정본). */
export function openAIDecisionsBody(s: DecideSpec): Record<string, unknown> {
  return {
    model: s.model,
    prompt_cache_options: { mode: 'explicit', ttl: '30m' },
    prompt_cache_key: s.cacheKey,
    safety_identifier: s.safetyId,
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: s.prefix, prompt_cache_breakpoint: { mode: 'explicit' } }] },
      { role: 'user', content: [{ type: 'input_text', text: s.input }] },
    ],
    questions: s.questions.map((q) =>
      q.type === 'predicate'
        ? { type: 'predicate', name: q.name, instructions: q.instructions }
        : q.type === 'choice'
          ? { type: 'choice', name: q.name, instructions: q.instructions, choices: q.choices.map((c) => ({ value: c.value, description: c.description })) }
          : { type: 'score', name: q.name, instructions: q.instructions, levels: q.levels.map((l) => ({ label: l.label, description: l.description })) },
    ),
  };
}

export function openAIResponsesBody(s: RespondSpec): Record<string, unknown> {
  return {
    model: s.model,
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: s.effort },
    max_output_tokens: s.maxOutputTokens,
    parallel_tool_calls: false,
    prompt_cache_options: { mode: 'explicit' },
    prompt_cache_key: s.cacheKey,
    safety_identifier: s.safetyId,
    input: [{ role: 'developer', content: [{ type: 'input_text', text: s.prefix, prompt_cache_breakpoint: { mode: 'explicit' } }] }, ...s.input],
    ...(s.tools.length ? { tools: s.tools.map((x) => ({ type: 'function', name: x.name, strict: true, parameters: x.parameters })) } : {}),
    text: { format: { type: 'json_schema', name: s.output.name, strict: true, schema: s.output.schema } },
  };
}

/** OpenAI 호환 HTTP(공급사 주소·키는 환경 변수). 리다이렉트 금지, 응답 본문은 메모리에서만 다룬다. */
export class OpenAICompatProvider implements ModelProvider {
  readonly name = 'openai-compat';
  private readonly o: { baseUrl: string; apiKey: string; timeoutMs: number; fetchFn: typeof fetch };
  constructor(o: { baseUrl: string; apiKey: string; timeoutMs?: number; fetchFn?: typeof fetch }) {
    if (!/^https:\/\//.test(o.baseUrl) && !/^http:\/\/127\.0\.0\.1[:/]/.test(o.baseUrl)) throw new Error('config_PROVIDER_BASE_URL');
    this.o = { baseUrl: o.baseUrl.replace(/\/$/, ''), apiKey: o.apiKey, timeoutMs: o.timeoutMs ?? 30_000, fetchFn: o.fetchFn ?? fetch };
  }

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.o.fetchFn(this.o.baseUrl + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch {
      throw new ProviderError('retryable');
    }
    if (res.status === 429 || res.status >= 500) throw new ProviderError('retryable');
    if (res.status !== 200) throw new ProviderError('fatal');
    try {
      return (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderError('fatal');
    }
  }

  async decide(s: DecideSpec): Promise<DecideResult> {
    const d = await this.post('/v1/decisions', openAIDecisionsBody(s));
    return { model: String(d.model ?? s.model), answers: d.answers, usage: usageOf(d.usage) };
  }

  async respond(s: RespondSpec): Promise<RespondResult> {
    const d = await this.post('/v1/responses', openAIResponsesBody(s));
    return { model: String(d.model ?? s.model), status: String(d.status ?? ''), output: Array.isArray(d.output) ? (d.output as Array<Record<string, unknown>>) : [], usage: usageOf(d.usage) };
  }
}

/**
 * OpenRouter 라우팅 설정(법적 검토 R14 ①). 코드 상수가 아니라 운영 환경 설정에서만 온다(ENV.md):
 * ZDR 엔드포인트만, 데이터 수집 거부, 공급자 고정(only + allow_fallbacks:false), 요청 매개변수를 다 지원하는 공급자만.
 * 하나라도 빠지거나 다른 값이면 생성·호출을 거부한다(fail-closed).
 */
export interface OpenRouterRouting {
  zdr: true;
  dataCollection: 'deny';
  /** 고정 공급자 슬러그(1개 이상) */
  only: string[];
}

const SLUG = /^[a-z0-9][a-z0-9._/-]{0,63}$/;

/** 환경 값에서 라우팅 설정을 읽는다. 값이 정확히 맞지 않으면 null(호출 거부). */
export function parseOpenRouterRouting(env: { OPENROUTER_ZDR?: string; OPENROUTER_DATA_COLLECTION?: string; OPENROUTER_PROVIDERS?: string }): OpenRouterRouting | null {
  if (env.OPENROUTER_ZDR !== 'true' || env.OPENROUTER_DATA_COLLECTION !== 'deny') return null;
  const only = (env.OPENROUTER_PROVIDERS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!only.length || only.length > 8 || !only.every((x) => SLUG.test(x)) || new Set(only).size !== only.length) return null;
  return { zdr: true, dataCollection: 'deny', only };
}

const routingOk = (r: OpenRouterRouting | null | undefined): r is OpenRouterRouting =>
  !!r && r.zdr === true && r.dataCollection === 'deny' && Array.isArray(r.only) && r.only.length > 0 && r.only.every((x) => typeof x === 'string' && SLUG.test(x));

/** OpenRouter 와이어의 provider 객체. 요청마다 새로 만든다(호출 측이 바꾸지 못하게). */
export function openRouterProviderField(r: OpenRouterRouting): Record<string, unknown> {
  return { zdr: true, data_collection: 'deny', only: [...r.only], allow_fallbacks: false, require_parameters: true };
}

/**
 * OpenRouter(OpenAI 호환 Responses, 무상태). 키는 OPENROUTER_API_KEY(서버 환경 변수, 저장소 금지).
 * L2(respond)는 /api/v1/responses로 보낸다. OpenRouter에는 Decisions(L1 보정 확률) 엔드포인트가 없어서 decide는 호출하지 않고
 * 재시도 불가 오류를 낸다(게이트웨이 503 gateway.upstream_error, 엔진 unknown). L1 상류는 팀장 결정 대기.
 * 요청마다 라우팅 설정을 다시 확인하고, 적용 사실만 이벤트로 남긴다(내용·공급자 이름 없음).
 */
export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  private readonly routing: OpenRouterRouting;
  private readonly o: { baseUrl: string; apiKey: string; timeoutMs: number; fetchFn: typeof fetch; onEvent: (e: string) => void };
  constructor(o: { apiKey: string; routing: OpenRouterRouting | null; baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch; onEvent?: (e: string) => void }) {
    if (!o.apiKey) throw new Error('config_OPENROUTER_API_KEY');
    if (!routingOk(o.routing)) throw new Error('config_OPENROUTER_ROUTING');
    const baseUrl = (o.baseUrl ?? 'https://openrouter.ai/api').replace(/\/$/, '');
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1[:/]/.test(baseUrl)) throw new Error('config_OPENROUTER_BASE_URL');
    this.routing = { zdr: true, dataCollection: 'deny', only: [...o.routing.only] };
    this.o = { baseUrl, apiKey: o.apiKey, timeoutMs: o.timeoutMs ?? 30_000, fetchFn: o.fetchFn ?? fetch, onEvent: o.onEvent ?? (() => undefined) };
  }

  decide(): Promise<DecideResult> {
    this.o.onEvent('upstream_decide_unsupported');
    return Promise.reject(new ProviderError('fatal'));
  }

  async respond(s: RespondSpec): Promise<RespondResult> {
    if (!routingOk(this.routing)) {
      this.o.onEvent('upstream_routing_refused');
      throw new ProviderError('fatal');
    }
    const body = { ...openAIResponsesBody(s), provider: openRouterProviderField(this.routing) };
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.o.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch {
      throw new ProviderError('retryable');
    }
    // 적용 사실만 남긴다(설정이 실린 요청을 보냈다). 값·본문·공급자 이름은 로그에 없다
    this.o.onEvent('upstream_zdr_pinned');
    // 고정 공급자를 쓸 수 없으면 OpenRouter가 404를 준다. 대체 공급자로 넘어가지 않으므로 재시도하지 않는다
    if (res.status === 429 || res.status >= 500) throw new ProviderError('retryable');
    if (res.status !== 200) throw new ProviderError('fatal');
    let d: Record<string, unknown>;
    try {
      d = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderError('fatal');
    }
    // 응답이 공급자를 밝히면 고정 목록 안인지 확인한다(아니면 결과를 쓰지 않는다)
    if (typeof d.provider === 'string' && !this.routing.only.some((x) => x.toLowerCase() === String(d.provider).toLowerCase())) {
      this.o.onEvent('upstream_provider_mismatch');
      throw new ProviderError('fatal');
    }
    return { model: String(d.model ?? s.model), status: String(d.status ?? ''), output: Array.isArray(d.output) ? (d.output as Array<Record<string, unknown>>) : [], usage: usageOf(d.usage) };
  }
}

/**
 * Upstage System One 자리(ADR-015 공급사 중립, D04 §8). 와이어 형식·질문 상한(26 선택지)은 S7 실측 뒤 채운다.
 * 지금은 호출하지 않고 재시도 불가 오류를 낸다(게이트웨이는 503 gateway.upstream_error, 엔진은 unknown).
 */
export class UpstageSystemOneStub implements ModelProvider {
  readonly name = 'upstage-systemone';
  decide(): Promise<DecideResult> {
    return Promise.reject(new ProviderError('fatal'));
  }
  respond(): Promise<RespondResult> {
    return Promise.reject(new ProviderError('fatal'));
  }
}

/** 시험·개발용 모의 공급사. 받은 요청(공급사 와이어 형태)을 메모리에 남긴다. 운영 기동에는 쓰지 않는다. */
export class MockProvider implements ModelProvider {
  readonly name = 'mock';
  readonly decides: Array<Record<string, unknown>> = [];
  readonly responds: Array<Record<string, unknown>> = [];
  /** 다음 호출들이 던질 오류(앞에서부터 하나씩) */
  failures: Array<'retryable' | 'fatal'> = [];
  respondOutput: Array<Record<string, unknown>> = [{ type: 'message', content: [{ type: 'output_text', text: '{}' }] }];

  private maybeFail(): void {
    const f = this.failures.shift();
    if (f) throw new ProviderError(f);
  }

  decide(s: DecideSpec): Promise<DecideResult> {
    this.decides.push(openAIDecisionsBody(s));
    try {
      this.maybeFail();
    } catch (e) {
      return Promise.reject(e as Error);
    }
    const answers = s.questions.map((q) =>
      q.type === 'predicate'
        ? { type: 'predicate', name: q.name, probability: 0.9 }
        : q.type === 'choice'
          ? { type: 'choice', name: q.name, choice: q.choices[0]!.value, confidence: 0.9 }
          : { type: 'score', name: q.name, score: q.levels[0]!.label, confidence: 0.9 },
    );
    return Promise.resolve({ model: s.model, answers, usage: { inputTokens: 1000, outputTokens: 20, cachedTokens: 800 } });
  }

  respond(s: RespondSpec): Promise<RespondResult> {
    this.responds.push(openAIResponsesBody(s));
    try {
      this.maybeFail();
    } catch (e) {
      return Promise.reject(e as Error);
    }
    return Promise.resolve({ model: s.model, status: 'completed', output: this.respondOutput, usage: { inputTokens: 2000, outputTokens: 300, cachedTokens: 1500 } });
  }
}
