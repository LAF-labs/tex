// D04 §1 계약(공급사 무관). 입력은 RedactedText 브랜드만 받는다(D06 §8).
import { isRunTokenResponse, type Egress, type RunScope } from '@sax/net';
import type { RedactedText } from '@sax/redaction';

export type { RedactedText };

export type RunToken = string & { readonly __brand: 'RunToken' };
export type ChatSessionId = string & { readonly __brand: 'ChatSessionId' };

/**
 * BYOK 경로에는 게이트웨이가 없으므로 egress의 ModelGuard가 실행 범위(runId·chatSessionId)당 토큰 하나를 발급한다.
 * 예산은 범위에 묶여 토큰을 새로 만들어도 우회되지 않는다(D04 §8 (3)). 게이트웨이 경로에서는 게이트웨이가 서명해 발급한 값을 쓴다.
 */
export function localRunToken(egress: Egress, scope: RunScope): RunToken {
  if (!egress.guard) throw new Error('egress without modelGuard');
  return egress.guard.issueRunToken(scope) as RunToken;
}

/**
 * 게이트웨이 경로의 실행 토큰(POST /v1/run-tokens). 범위(runId·chatSessionId)당 예산은 서버가 쌓으므로 다시 받아도 초기화되지 않는다.
 * 토큰은 서버가 서명·검증하고 클라이언트는 그대로 싣기만 한다.
 */
export async function gatewayRunToken(egress: Egress, scope: RunScope): Promise<RunToken> {
  const r = await egress.toGateway({ surface: 'runTokens', body: scope });
  if (!isRunTokenResponse(r)) throw new Error('gateway.bad_response');
  return r.runToken as RunToken;
}

/** openai_compat: 측정 전용 OpenAI 호환 Chat Completions(adapters/openai-compat.ts). 제품 경로에는 없다. */
export type Provider = 'openai' | 'upstage' | 'rules' | 'openai_compat';

/** 이름 기반 조인 후의 답(OpenAI 배열·System One 객체 모두 이 모양으로 정규화). */
export type Answer =
  | { type: 'predicate'; probability: number }
  | { type: 'choice'; value: string; confidence: number; probabilities: Record<string, number>; fullDistribution: boolean }
  | { type: 'score'; score: number; confidence: number }
  | { type: 'refusal' };

export type SourcedAnswer = Answer & { source: 'model' | 'l0' };
export type BundleAnswers = Record<string, SourcedAnswer>;

export interface Usage {
  inputTokens: number;
  /** 게이트웨이 경로에서는 클라이언트에 오지 않는다(D04 §7). BYOK·S9만 채운다. */
  cachedTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: Usage = { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

export interface DecideRequest {
  /** 와이어 ID(`screen_state_v2`) */
  bundleId: string;
  bundleDigest: string;
  input: RedactedText;
  runToken: RunToken;
}

/** unknown이 된 이유. 공급사 오류·예산·스키마 불일치·입력 한도 초과는 모두 unknown이다(D04 §2). */
export type UnknownReason =
  | 'mapping_unknown'
  | 'core_refusal'
  | 'bundle_not_found'
  | 'bundle_digest_mismatch'
  | 'input_too_large'
  | 'provider_context_exceeded'
  | 'adapter_incompatible'
  | 'no_threshold_profile'
  | 'profile_uncalibrated'
  | 'model_snapshot_mismatch'
  | 'answer_names_mismatch'
  | 'answer_type_mismatch'
  | 'answer_value_invalid'
  | 'injection_prefilter'
  /** 게이트웨이가 공급사로 보낸 질문 목록 해시가 로컬 번들과 다름(C-24) */
  | 'questions_digest_mismatch'
  /** 규칙 전용 결정 경로에서 매핑이 참조하는 질문에 규칙 답이 없고 모델 호출도 허용되지 않음 */
  | 'rules_incomplete'
  | `provider:${string}`
  | `guard:${string}`
  | `gateway:${string}`;

export interface DecideResult {
  outcome: string;
  confidence: number;
  raw: BundleAnswers;
  usage: Usage;
  /** 공급사가 거절한 질문 이름. System One 구현체는 항상 빈 배열이다. */
  refusals: string[];
  /** 매핑에서 이긴 행 번호(0부터). 모델 미호출·오류면 -1. */
  rule: number;
  reason?: UnknownReason;
  provider: Provider;
  model: string;
  /** 모델을 부르지 않고 L0 규칙만으로 결정했는가 */
  l0Only: boolean;
  /** 같은 실행·같은 입력의 판정 캐시에서 답을 재사용했는가(모델 미호출, usage 0) */
  cached?: boolean;
}

/** /v1/respond 툴셋 id 표. gateway-request 스키마 두 벌의 toolset 열거와 같아야 한다(tests/chat-agent-toolset.test.ts가 대조). */
export const TOOLSET_IDS = ['selector_repair', 'summarize', 'intent_fill', 'query_parse', 'chat_reply', 'chat_agent', 'page_judge', 'browser_agent'] as const;
export type Toolset = (typeof TOOLSET_IDS)[number];

export interface RedactedMessage {
  role: 'user';
  content: Array<{ type: 'input_text'; text: RedactedText }>;
}

/** 어댑터가 태그를 붙여 돌려준 모델 출력 항목. 직접 만들 수 없다(replay 브랜드). */
export type GatewayTaggedItem = { readonly item: object; readonly tag: string } & { readonly __brand: 'GatewayTagged' };

export type RedactedReplayItem =
  | { kind: 'model_output'; item: GatewayTaggedItem }
  | { kind: 'function_call_output'; callId: string; output: RedactedText };

export interface RespondRequest {
  toolset: Toolset;
  messages: RedactedMessage[];
  replay: RedactedReplayItem[];
  runToken: RunToken;
  chatSessionId?: ChatSessionId;
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: unknown;
}

export interface RespondResult {
  status: 'completed' | 'incomplete' | 'refusal';
  output?: unknown;
  /** 로컬 툴셋 정의와 스키마를 통과한 도구 호출만(C-24). */
  toolCalls: ToolCall[];
  /** 다음 턴 replay에 그대로 넣을 항목(어댑터 태그 포함). */
  replay: RedactedReplayItem[];
  usage: Usage;
  reason?: string;
}

export interface ModelLayer {
  decide(req: DecideRequest): Promise<DecideResult>;
  respond(req: RespondRequest): Promise<RespondResult>;
}
