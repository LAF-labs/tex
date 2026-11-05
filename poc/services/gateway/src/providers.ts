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
