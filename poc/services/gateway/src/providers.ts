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
  /**
   * 공급자 고정을 하지 않는다(OpenRouter provider 필드 없음). 예상 밖 화면 판정·브라우저 에이전트(page_judge·browser_agent)만 쓴다:
   * 기본 모델이 요청마다 뒤쪽 공급사가 바뀌는 라우터라 고정·ZDR이 걸리면 막힌다(대표 2026-11-13). 대화·선택자 수리 등 다른 툴셋은 그대로 고정한다.
   */
  unpinned?: true;
  /** 상류 대기(ms). 없으면 공급사 기본(30초). 판정·에이전트는 함수 상한 안에서 한 번만 길게 기다린다. */
  timeoutMs?: number;
  /**
   * 결정 모델 고르기(decision_pick): 생성 대신 OpenRouter decisions로 선택지 하나를 고른다. 지시문은 prefix(게이트웨이 정본),
   * 상태·선택지는 PC가 보낸 가린 글. 결과는 respond와 같은 꼴(message 한 개, output_text = {choice, confidence, p}).
   */
  decision?: { state: string; choices: Record<string, string> };
}

/** decisions 답을 respond 결과 꼴로(출력 항목 하나). 모르는 답(거절 등)은 incomplete. */
export function decisionResult(model: string, d: Record<string, unknown>): RespondResult {
  const a = ((d.answers ?? {}) as Record<string, { type?: string; choice?: unknown; confidence?: unknown; probabilities?: Record<string, unknown> }>).pick;
  const usage = usageOf(d.usage);
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') return { model, status: 'incomplete', output: [], usage };
  const p = Number(a.probabilities?.[a.choice] ?? 0);
  const conf = Number(a.confidence ?? 0);
  const clamp = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
  const text = JSON.stringify({ choice: a.choice.slice(0, 64), confidence: clamp(conf), p: clamp(p) });
  return { model: String(d.model ?? model), status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage };
}

/**
 * L1 판정을 OpenRouter decisions(System One 계약)로: 고정 접두와 화면 글을 state 하나로, 질문은 이름 키 객체(predicate → noul,
 * choice → criteria {값: 설명}). 질문 순서·설명은 번들 정의 그대로라 클라이언트의 questionsDigest 대조가 그대로 맞는다.
 */
export function systemOneDecideBody(s: DecideSpec): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  for (const q of s.questions) {
    if (q.type === 'predicate') questions[q.name] = { type: 'noul', instructions: q.instructions };
    else if (q.type === 'choice') questions[q.name] = { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.choices.map((c) => [c.value, c.description])) };
    else questions[q.name] = { type: 'score', instructions: q.instructions, criteria: q.levels.map((l) => l.label) };
  }
  return { model: s.model, state: `${s.prefix}\n\n${s.input}`, questions, user: s.safetyId };
}

/**
 * System One 답(이름 키 객체)을 /v1/decide 응답의 OpenAI Decisions 배열 꼴로 바꾼다(클라이언트 GatewayDecideAdapter가 그대로 정규화).
 * 이름·값 검사는 클라이언트 joinByName이 한다(여기서 고치지 않는다). 모르는 꼴은 그대로 두어 클라이언트가 거르게 한다.
 */
export function systemOneAnswers(answers: unknown, questions: Question[]): unknown[] {
  const a = (answers ?? {}) as Record<string, Record<string, unknown>>;
  return questions.map((q) => {
    const x = a[q.name];
    if (!x || typeof x !== 'object') return { type: 'missing', name: q.name };
    if (q.type === 'predicate') return { type: 'predicate', name: q.name, probability: x.noul };
    if (q.type === 'choice') {
      const p = x.probabilities;
      const list = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.entries(p as Record<string, unknown>).map(([value, probability]) => ({ value, probability })) : p;
      return { type: 'choice', name: q.name, choice: x.choice, confidence: x.confidence, probabilities: list };
    }
    return { type: 'score', name: q.name, score: x.score, confidence: x.confidence };
  });
}

/** OpenRouter decisions 본문(문서 2026-11-16: questions는 이름이 키인 객체, choice는 criteria {값: 설명}). */
export function decisionsBody(s: RespondSpec): Record<string, unknown> {
  return { model: s.model, state: s.decision!.state, questions: { pick: { type: 'choice', instructions: s.prefix, criteria: s.decision!.choices } }, user: s.safetyId };
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

/**
 * 도구가 있는 요청에는 parallel_tool_calls를 싣지 않는다. 운영 조합(OpenRouter, ZDR → azure, require_parameters)에서
 * 도구 + parallel_tool_calls:false는 받는 엔드포인트가 없어 404였다(탐침 2026-11-12, 노트 agent-chat/real-probe-404.json).
 * 한 응답에 function_call이 여러 개 오면 PC 루프가 순서대로 실행한다.
 */
export function openAIResponsesBody(s: RespondSpec): Record<string, unknown> {
  return {
    model: s.model,
    store: false,
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: s.effort },
    max_output_tokens: s.maxOutputTokens,
    ...(s.tools.length ? {} : { parallel_tool_calls: false }),
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

  private async post(path: string, body: unknown, timeoutMs = this.o.timeoutMs): Promise<Record<string, unknown>> {
    let res: Response;
    try {
      res = await this.o.fetchFn(this.o.baseUrl + path, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
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
    if (s.decision) throw new ProviderError('fatal'); // 결정 모델 고르기는 OpenRouter decisions만
    const d = await this.post('/v1/responses', openAIResponsesBody(s), s.timeoutMs);
    return { model: String(d.model ?? s.model), status: String(d.status ?? ''), output: Array.isArray(d.output) ? (d.output as Array<Record<string, unknown>>) : [], usage: usageOf(d.usage) };
  }
}

/**
 * 판정과 응답을 서로 다른 공급사로 보낸다(팀장 결정 2026-11-05): L1 판정은 OpenAI Decisions 직결(확률·임계값 계약 D04 유지),
 * 응답(Terra)은 OpenRouter(ZDR·데이터 수집 거부·공급자 고정). 어느 쪽 어댑터든 자기 fail-closed 규칙을 그대로 지킨다.
 */
export class SplitProvider implements ModelProvider {
  readonly name: string;
  private readonly d: ModelProvider;
  private readonly r: ModelProvider;
  constructor(decide: ModelProvider, respond: ModelProvider) {
    this.d = decide;
    this.r = respond;
    this.name = `${decide.name}+${respond.name}`;
  }
  decide(s: DecideSpec): Promise<DecideResult> {
    return this.d.decide(s);
  }
  respond(s: RespondSpec): Promise<RespondResult> {
    return this.r.respond(s);
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
 * 공급자를 고정하지 않는 호출(page_judge·browser_agent)의 보관 조건(F-06, 처리방침 6항). 공급자는 고정하지 않고 보관 조건만 건다.
 * off = provider 필드 없음(대표 2026-11-13 결정 그대로, 기본), deny = 데이터 수집 공급자 제외, zdr = 무보관 공급자만 + 수집 제외.
 * 라우터 뒤 공급사가 조건을 못 맞추면 OpenRouter가 거절할 수 있으므로 실키로 확인한 뒤 운영 환경에서 켠다.
 */
export type AgentPrivacy = 'off' | 'deny' | 'zdr';
export function parseAgentPrivacy(v: string | undefined): AgentPrivacy | null {
  return v === undefined || v === '' ? 'off' : v === 'off' || v === 'deny' || v === 'zdr' ? v : null;
}
function agentProviderField(p: AgentPrivacy): Record<string, unknown> | null {
  return p === 'zdr' ? { zdr: true, data_collection: 'deny' } : p === 'deny' ? { data_collection: 'deny' } : null;
}

/**
 * OpenRouter(OpenAI 호환 Responses, 무상태). 키는 OPENROUTER_API_KEY(서버 환경 변수, 저장소 금지).
 * L2(respond)는 /api/v1/responses로 보낸다. L1(decide)과 결정 모델 고르기는 /api/alpha/decisions(System One 계약)로 보낸다
 * (2026-11-16, 대표 지시 "jev·clef 중 하나, deepseek보다 싸게" → typesafe/jev-1.14).
 * 요청마다 라우팅 설정을 다시 확인하고, 적용 사실만 이벤트로 남긴다(내용·공급자 이름 없음).
 */
export class OpenRouterProvider implements ModelProvider {
  readonly name = 'openrouter';
  private readonly routing: OpenRouterRouting;
  private readonly o: { baseUrl: string; apiKey: string; timeoutMs: number; fetchFn: typeof fetch; onEvent: (e: string) => void; agentPrivacy: AgentPrivacy };
  constructor(o: { apiKey: string; routing: OpenRouterRouting | null; baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch; onEvent?: (e: string) => void; agentPrivacy?: AgentPrivacy }) {
    if (!o.apiKey) throw new Error('config_OPENROUTER_API_KEY');
    if (!routingOk(o.routing)) throw new Error('config_OPENROUTER_ROUTING');
    const baseUrl = (o.baseUrl ?? 'https://openrouter.ai/api').replace(/\/$/, '');
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1[:/]/.test(baseUrl)) throw new Error('config_OPENROUTER_BASE_URL');
    this.routing = { zdr: true, dataCollection: 'deny', only: [...o.routing.only] };
    this.o = { baseUrl, apiKey: o.apiKey, timeoutMs: o.timeoutMs ?? 30_000, fetchFn: o.fetchFn ?? fetch, onEvent: o.onEvent ?? (() => undefined), agentPrivacy: o.agentPrivacy ?? 'off' };
  }

  /**
   * L1 판정: OpenRouter decisions(/alpha/decisions, 기본 typesafe/jev-1.14). 확률만 내고 생성하지 않는다(호출당 약 0.15원, 0.4초).
   * 보관 조건은 판정·에이전트와 같은 OPENROUTER_AGENT_PRIVACY(가린 화면 글만 간다). 공급자 고정 목록(Responses용)은 쓰지 않는다.
   */
  async decide(s: DecideSpec): Promise<DecideResult> {
    if (!routingOk(this.routing)) {
      this.o.onEvent('upstream_routing_refused');
      throw new ProviderError('fatal');
    }
    const field = agentProviderField(this.o.agentPrivacy);
    const body = { ...systemOneDecideBody(s), ...(field ? { provider: field } : {}) };
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.o.baseUrl}/alpha/decisions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ProviderError('retryable');
    }
    this.o.onEvent(field ? `upstream_decide_${this.o.agentPrivacy}` : 'upstream_decide');
    if (res.status === 429 || res.status >= 500) throw new ProviderError('retryable');
    if (res.status !== 200) throw new ProviderError('fatal');
    let d: Record<string, unknown>;
    try {
      d = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderError('fatal');
    }
    return { model: String(d.model ?? s.model), answers: systemOneAnswers(d.answers, s.questions), usage: usageOf(d.usage) };
  }

  async respond(s: RespondSpec): Promise<RespondResult> {
    if (!routingOk(this.routing)) {
      this.o.onEvent('upstream_routing_refused');
      throw new ProviderError('fatal');
    }
    const agentField = s.unpinned ? agentProviderField(this.o.agentPrivacy) : null;
    if (s.decision) return this.decisions(s, agentField);
    const body = s.unpinned ? (agentField ? { ...openAIResponsesBody(s), provider: agentField } : openAIResponsesBody(s)) : { ...openAIResponsesBody(s), provider: openRouterProviderField(this.routing) };
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.o.baseUrl}/v1/responses`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(s.timeoutMs ?? this.o.timeoutMs),
      });
    } catch {
      throw new ProviderError('retryable');
    }
    // 적용 사실만 남긴다(설정이 실린 요청을 보냈다). 값·본문·공급자 이름은 로그에 없다
    this.o.onEvent(s.unpinned ? (agentField ? `upstream_unpinned_${this.o.agentPrivacy}` : 'upstream_unpinned') : 'upstream_zdr_pinned');
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
    if (!s.unpinned && typeof d.provider === 'string' && !this.routing.only.some((x) => x.toLowerCase() === String(d.provider).toLowerCase())) {
      this.o.onEvent('upstream_provider_mismatch');
      throw new ProviderError('fatal');
    }
    return { model: String(d.model ?? s.model), status: String(d.status ?? ''), output: Array.isArray(d.output) ? (d.output as Array<Record<string, unknown>>) : [], usage: usageOf(d.usage) };
  }

  async decisions(s: RespondSpec, providerField: Record<string, unknown> | null): Promise<RespondResult> {
    const body = { ...decisionsBody(s), ...(providerField ? { provider: providerField } : {}) };
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.o.baseUrl}/alpha/decisions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(s.timeoutMs ?? this.o.timeoutMs),
      });
    } catch {
      throw new ProviderError('retryable');
    }
    this.o.onEvent(providerField ? `upstream_decisions_${this.o.agentPrivacy}` : 'upstream_decisions');
    if (res.status === 429 || res.status >= 500) throw new ProviderError('retryable');
    if (res.status !== 200) throw new ProviderError('fatal');
    let d: Record<string, unknown>;
    try {
      d = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderError('fatal');
    }
    return decisionResult(s.model, d);
  }
}

/**
 * 생성 호출만 다른 공급사로(대표 2026-11-19: 시험 기간에는 OpenRouter 대신 Anthropic 조직 크레딧). 판정(decide)과
 * 결정 모델 고르기(decision_pick)는 기본 공급사(OpenRouter jev)에 그대로 둔다: ADR-051 판정 단과 평가가 그 계약(확률·임계값)에 묶여 있다.
 */
export class GenerationSplitProvider implements ModelProvider {
  readonly name: string;
  private readonly base: ModelProvider;
  private readonly gen: ModelProvider;
  constructor(base: ModelProvider, gen: ModelProvider) {
    this.base = base;
    this.gen = gen;
    this.name = `${base.name}+${gen.name}`;
  }
  decide(s: DecideSpec): Promise<DecideResult> {
    return this.base.decide(s);
  }
  respond(s: RespondSpec): Promise<RespondResult> {
    return s.decision ? this.base.respond(s) : this.gen.respond(s);
  }
}

/** Anthropic 구조화 출력·strict 도구가 받지 않는 제약(숫자·길이·배열 개수·패턴). 빼고 보낸다: PC·폰이 받은 출력과 도구 인자를 원래 스키마로 다시 검사한다. */
const ANTHROPIC_DROP = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'maxItems', 'uniqueItems', 'pattern', 'minProperties', 'maxProperties']);
export function anthropicSchema(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(anthropicSchema);
  if (!v || typeof v !== 'object') return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (ANTHROPIC_DROP.has(k)) continue;
    if (k === 'minItems' && typeof x === 'number' && x > 1) continue;
    // properties·$defs 아래 키는 필드 이름이라 그대로 두고 값만 고친다
    out[k] = k === 'properties' || k === '$defs' || k === 'definitions' ? Object.fromEntries(Object.entries((x ?? {}) as Record<string, unknown>).map(([n, d]) => [n, anthropicSchema(d)])) : anthropicSchema(x);
  }
  return out;
}

type AnthropicBlock = Record<string, unknown> & { type?: string };
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicBlock[] };

/**
 * Responses 꼴 입력(사용자 메시지·이전 출력·function_call_output)을 Anthropic messages로.
 * 이전 응답의 assistant 내용은 우리가 낸 reasoning 항목(anthropic_content)에 원본 그대로 실려 돌아온다. 그것을 그대로 되돌려
 * 사고 블록·서명을 바꾸지 않는다(이어지는 대화 검사). 같은 턴의 function_call·message 항목은 그 사본에 이미 있으니 건너뛴다.
 */
export function anthropicMessages(input: unknown[]): AnthropicMessage[] | null {
  const msgs: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (!blocks.length) return;
    const last = msgs[msgs.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else msgs.push({ role, content: [...blocks] });
  };
  let carried = false;
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return null;
    const it = raw as Record<string, unknown>;
    if (it.type === 'reasoning') {
      if (Array.isArray(it.anthropic_content)) {
        // 앞 턴의 assistant가 끝났다는 표시가 없어도 새 사본은 새 assistant 메시지로 시작한다
        msgs.push({ role: 'assistant', content: (it.anthropic_content as AnthropicBlock[]).map((b) => ({ ...b })) });
        carried = true;
      }
      continue; // 다른 공급사의 reasoning(암호문)은 읽지 못하므로 버린다
    }
    if (it.type === 'function_call') {
      if (carried) continue;
      let args: unknown;
      try {
        args = JSON.parse(String(it.arguments ?? '{}'));
      } catch {
        return null;
      }
      push('assistant', [{ type: 'tool_use', id: String(it.call_id), name: String(it.name), input: args }]);
      continue;
    }
    if (it.type === 'function_call_output') {
      carried = false;
      push('user', [{ type: 'tool_result', tool_use_id: String(it.call_id), content: String(it.output ?? '') }]);
      continue;
    }
    if (it.type === 'message' && it.role === 'assistant') {
      if (carried) continue;
      const text = (Array.isArray(it.content) ? (it.content as Array<Record<string, unknown>>) : []).flatMap((c) => (c.type === 'output_text' ? [String(c.text)] : [])).join('');
      if (text) push('assistant', [{ type: 'text', text }]);
      continue;
    }
    if (it.role === 'user' && Array.isArray(it.content)) {
      carried = false;
      const blocks: AnthropicBlock[] = [];
      for (const c of it.content as Array<Record<string, unknown>>) {
        if (c.type === 'input_text') blocks.push({ type: 'text', text: String(c.text) });
        else if (c.type === 'input_image') {
          const m = /^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(c.image_url));
          if (!m) return null;
          blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
        } else return null;
      }
      push('user', blocks);
      continue;
    }
    return null;
  }
  return msgs.length && msgs[0]!.role === 'user' ? msgs : null;
}

/** Anthropic Messages 본문. 머리말은 system 한 덩어리로 캐시하고, 툴셋 effort·출력 스키마·도구를 그대로 옮긴다. 사고는 모델 기본(적응형)이다. */
export function anthropicMessagesBody(s: RespondSpec, messages: AnthropicMessage[]): Record<string, unknown> {
  return {
    model: s.model,
    max_tokens: s.maxOutputTokens,
    system: [{ type: 'text', text: s.prefix, cache_control: { type: 'ephemeral' } }],
    messages,
    ...(s.tools.length ? { tools: s.tools.map((x) => ({ name: x.name, input_schema: anthropicSchema(x.parameters), strict: true })), tool_choice: { type: 'auto' } } : {}),
    output_config: { effort: s.effort, format: { type: 'json_schema', schema: anthropicSchema(s.output.schema) } },
    metadata: { user_id: s.safetyId },
    // 안전 분류기가 거절하면 같은 호출 안에서 다른 모델로 다시 돌린다(서버 쪽 대체)
    fallbacks: 'default',
  };
}

/**
 * Anthropic 답을 Responses 꼴 출력으로. 첫 항목은 assistant 내용 원본을 담은 reasoning 항목(PC·폰은 reasoning을 읽지 않고 되돌려 보낸다),
 * 그 뒤에 도구 호출(function_call)이나 최종 JSON 글(message) 하나. 거절은 refusal 내용, 길이 상한은 incomplete.
 */
export function anthropicResult(model: string, d: Record<string, unknown>): RespondResult {
  const content = Array.isArray(d.content) ? (d.content as AnthropicBlock[]) : [];
  const u = (d.usage ?? {}) as Record<string, unknown>;
  const read = num(u.cache_read_input_tokens);
  const usage: ProviderUsage = { inputTokens: num(u.input_tokens) + read + num(u.cache_creation_input_tokens), outputTokens: num(u.output_tokens), cachedTokens: read };
  const m = String(d.model ?? model);
  const stop = String(d.stop_reason ?? '');
  if (stop === 'refusal') return { model: m, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: '' }] }], usage };
  if (stop !== 'end_turn' && stop !== 'tool_use') return { model: m, status: 'incomplete', output: [], usage };
  const output: Array<Record<string, unknown>> = [{ type: 'reasoning', summary: [], anthropic_content: content }];
  const calls = content.filter((b) => b.type === 'tool_use');
  if (calls.length) {
    for (const b of calls) output.push({ type: 'function_call', call_id: String(b.id), name: String(b.name), arguments: JSON.stringify(b.input ?? {}) });
  } else {
    const text = content.flatMap((b) => (b.type === 'text' ? [String(b.text ?? '')] : [])).join('');
    output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }
  return { model: m, status: 'completed', output, usage };
}

/**
 * Anthropic Messages API(대표 2026-11-19, 조직 크레딧). 키는 ANTHROPIC_API_KEY(서버 환경 변수만). 생성 호출만 받는다:
 * 판정·결정 모델 고르기는 GenerationSplitProvider가 기본 공급사로 보낸다. 다른 어댑터처럼 리다이렉트 금지, 본문은 메모리에서만.
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  private readonly o: { baseUrl: string; apiKey: string; timeoutMs: number; fetchFn: typeof fetch; onEvent: (e: string) => void };
  constructor(o: { apiKey: string; baseUrl?: string; timeoutMs?: number; fetchFn?: typeof fetch; onEvent?: (e: string) => void }) {
    if (!o.apiKey) throw new Error('config_ANTHROPIC_API_KEY');
    const baseUrl = (o.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '');
    if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/127\.0\.0\.1[:/]/.test(baseUrl)) throw new Error('config_ANTHROPIC_BASE_URL');
    this.o = { baseUrl, apiKey: o.apiKey, timeoutMs: o.timeoutMs ?? 30_000, fetchFn: o.fetchFn ?? fetch, onEvent: o.onEvent ?? (() => undefined) };
  }

  decide(): Promise<DecideResult> {
    return Promise.reject(new ProviderError('fatal')); // Anthropic에는 확률 판정이 없다
  }

  async respond(s: RespondSpec): Promise<RespondResult> {
    if (s.decision) throw new ProviderError('fatal');
    const messages = anthropicMessages(s.input);
    if (!messages) throw new ProviderError('fatal');
    let res: Response;
    try {
      res = await this.o.fetchFn(`${this.o.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': this.o.apiKey, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01', 'content-type': 'application/json' },
        body: JSON.stringify(anthropicMessagesBody(s, messages)),
        redirect: 'error',
        signal: AbortSignal.timeout(s.timeoutMs ?? this.o.timeoutMs),
      });
    } catch {
      throw new ProviderError('retryable');
    }
    this.o.onEvent('upstream_anthropic');
    if (res.status === 429 || res.status >= 500) throw new ProviderError('retryable');
    if (res.status !== 200) throw new ProviderError('fatal');
    let d: Record<string, unknown>;
    try {
      d = (await res.json()) as Record<string, unknown>;
    } catch {
      throw new ProviderError('fatal');
    }
    return anthropicResult(s.model, d);
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
  /** decision_pick 답(없으면 첫 선택지) */
  decisionChoice: string | null = null;

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
    if (s.decision) {
      this.responds.push(decisionsBody(s));
      const pick = this.decisionChoice ?? Object.keys(s.decision.choices)[0]!;
      return Promise.resolve(decisionResult(s.model, { model: s.model, answers: { pick: { type: 'choice', choice: pick, confidence: 0.9, probabilities: { [pick]: 0.95 } } }, usage: { input_tokens: 300, output_tokens: 0 } }));
    }
    this.responds.push(openAIResponsesBody(s));
    try {
      this.maybeFail();
    } catch (e) {
      return Promise.reject(e as Error);
    }
    return Promise.resolve({ model: s.model, status: 'completed', output: this.respondOutput, usage: { inputTokens: 2000, outputTokens: 300, cachedTokens: 1500 } });
  }
}
