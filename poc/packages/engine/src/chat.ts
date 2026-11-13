// 대화 짧은 응대 chat.respond(팀장 지시 2026-11-10, D04 §4.1). 작업으로 분류되지 않은 입력(intent.resolve unknown)에 모델이 짧게 답한다.
// main → 엔진 chat.respond({text}) → 마스킹(Redactor, 대화 세션 범위) → 게이트웨이 /v1/respond(chat_reply) → 출력 검증.
// - 답은 "이 앱이 할 수 있는 일 안내·되묻기·짧은 응대"까지다. 세무 판단은 하지 않는다(D04 §3): 모델이 tax_advice라 하거나
//   답 문장에 세무 판단 말이 보이면 문장을 버리고 고정 문구로 바꾼다.
// - 응답은 신뢰하지 않는다: 출력 스키마(어댑터가 Ajv로 검증)·툴셋 해시가 다르거나 답이 길이 상한을 넘으면 chat.bad_response.
// - 오프라인 대체 없음: 게이트웨이 설정이 없거나 경로가 실패하면 chat.unavailable(예산·월 한도는 따로 코드).
// - 모델에는 이번 문장 하나만 보낸다(이전 대화 턴 없음). 로그·저널에 문장·답을 남기지 않는다.
import { CHAT_CAPABILITIES, CHAT_REPLY, CHAT_REPLY_KINDS, CHAT_REPLY_MAX_CHARS, CHAT_SUGGEST_MAX, type RedactedText, type RespondRequest, type RespondResult, type RunToken } from '@sax/model';
import { EMAIL_RE, TOKEN_RE, normalizeForRedaction, numericSpans } from '@sax/redaction';

/** D04 §3 고정 문구(세무 판단 거절). 데스크톱 화면 문구와 같다. */
export const CHAT_ADVICE_TEXT = '세무 판단은 하지 않아요. 세무 대리인과 상담해 주세요.';
/** 답 문장을 쓸 수 없을 때(식별자·링크·토큰이 섞임, 모델 거절)의 고정 안내 */
export const CHAT_FALLBACK_TEXT = '이 앱은 홈택스 전자세금계산서 발급을 도와드려요. 어떤 일을 할까요?';
/** 마스킹 뒤 입력 상한(바이트). intent_route_v1 maxInputBytes와 같다. 넘으면 잘라 보내지 않고 거부한다. */
export const CHAT_INPUT_MAX_BYTES = 2048;

export type ChatReplyKind = (typeof CHAT_REPLY_KINDS)[number];
export type ChatSuggestion = (typeof CHAT_CAPABILITIES)[number]['id'];

/** chat.respond 결과. filtered가 null이 아니면 reply는 엔진 고정 문구다. */
export interface ChatReply {
  reply: string;
  kind: ChatReplyKind;
  suggest: ChatSuggestion[];
  filtered: null | 'advice' | 'unsafe' | 'refusal';
}

/**
 * chat.turn_limit·chat.bad_tool_output·bad_text는 대화 에이전트(chat.step, chat-agent.ts)만 쓴다.
 * turn_limit: 한 사용자 턴에서 툴셋 턴 상한까지 도구를 부름. bad_tool_output: main이 준 도구 결과·화면 프레임이 열거형 계약 밖(C-10 구조 검사).
 */
export type ChatErrorCode =
  | 'chat.unavailable'
  | 'chat.bad_response'
  | 'chat.budget_exceeded'
  | 'chat.quota_exceeded'
  | 'chat.input_too_large'
  | 'chat.secret_rejected'
  | 'chat.turn_limit'
  | 'chat.bad_tool_output'
  | 'bad_text';

/**
 * 대화창 비밀 DLP(D04 §4 B-15, 최소판): "비밀번호는 abcd1234"처럼 비밀 값을 적은 문장은 모델로 보내지 않는다(chat.secret_rejected,
 * 화면은 "비밀번호는 대화창에 입력하지 마세요"). "비밀번호 잊어버렸어" 같은 말은 값이 없어 걸리지 않는다.
 */
export function chatSecretShaped(text: string): boolean {
  return /(비밀\s?번호|비번|패스워드|암호|password|passwd|pw)\s*(는|은|이|가|:|=)\s*[A-Za-z0-9!@#$%^&*()_+\-=.]{4,}/i.test(text);
}

export interface ChatModel {
  /** 게이트웨이 /v1/respond(chat_reply). OpenAIResponsesAdapter(transport gateway)가 출력 스키마·툴셋 해시를 검증한다. */
  respond: (req: RespondRequest) => Promise<RespondResult>;
}

/**
 * 답 문장의 세무 판단 말(띄어쓰기 없앤 문장에 맞춘다). 입력 쪽 판정은 모델(intent_route_v1 mentions_tax_advice)이 하고,
 * 이것은 모델이 만든 문장을 보여 주기 전 마지막 차단이라 넓게 잡는다(오탐은 고정 문구가 나갈 뿐이다).
 * "세금계산서 발급"·"납세증명서"·"부가세 별도" 같은 발급 안내는 걸리지 않아야 한다(tests/chat-respond.test.ts).
 */
export const CHAT_ADVICE_PATTERNS: readonly RegExp[] = [
  /절세/,
  /공제/,
  /필요경비/,
  /(경비|비용)(으로|로)?(처리|인정|산입|넣)/,
  /(환급|감면|가산세|세율|세액)/,
  /(신고|납부)(방법|기한|하시면|하면|하세요|해야|하셔야|안하)/,
  /(세금|부가세|부가가치세|종소세|종합소득세|법인세|소득세|원천세)(을|를|은|는|이|가)?(얼마|약|대략|\d|줄|아끼|덜)/,
];

export function chatAdviceMentioned(text: string): boolean {
  const t = text.replace(/\s+/g, '');
  return CHAT_ADVICE_PATTERNS.some((p) => p.test(t));
}

/**
 * 보여 주면 안 되는 답: 마스킹 토큰·숫자 식별자(전화·사업자번호 등)·이메일·링크, 그리고 D04 §4 표시 규칙(B-15)의
 * 비밀 입력 유도 말(비밀번호·인증서·보안카드·입력하세요). 우리 앱의 말로 보이게 사용자를 사회공학하는 경로를 막는다.
 */
function unsafeReply(text: string): boolean {
  return new RegExp(TOKEN_RE.source).test(normalizeForRedaction(text)) || unsafeText(text);
}

/** unsafeReply에서 토큰 검사만 뺀 것. 대화 에이전트는 토큰을 이름으로 바꿔 보이므로 채우기 전 문장(토큰·슬롯을 지운 것)에 이것을 돌린다. */
export function unsafeText(text: string): boolean {
  const n = normalizeForRedaction(text);
  if (/비밀번호|비번|패스워드|암호|인증서|보안카드|입력하세요|OTP/i.test(n.replace(/\s+/g, ''))) return true;
  if (numericSpans(n).length) return true;
  if (new RegExp(EMAIL_RE.source, 'u').test(n)) return true;
  return /https?:|www\.|\.(com|kr|net|org|io)\b/i.test(n);
}

const CAPABILITY_IDS: ReadonlySet<string> = new Set(CHAT_CAPABILITIES.map((c) => c.id));
const KINDS: ReadonlySet<string> = new Set(CHAT_REPLY_KINDS);

export class ChatError extends Error {
  readonly code: ChatErrorCode;
  constructor(code: ChatErrorCode) {
    super(code);
    this.code = code;
  }
}

/** 어댑터 실패 이유 → 오류 코드. 응답 모양 문제는 bad_response, 예산·월 한도는 따로, 나머지는 경로 실패다. */
export function errorOf(reason: string | undefined): ChatErrorCode {
  if (reason === 'gateway:run_budget_exceeded' || reason === 'turn_limit') return 'chat.budget_exceeded';
  if (reason === 'gateway:quota_exceeded') return 'chat.quota_exceeded';
  if (reason && ['output_schema_mismatch', 'toolset_digest_mismatch', 'unexpected_item', 'tool_call_rejected', 'gateway:bad_response', 'toolset_mismatch'].includes(reason)) return 'chat.bad_response';
  return 'chat.unavailable';
}

/**
 * 마스킹된 문장 하나로 chat_reply를 부르고 결과를 검증한다. runToken은 대화 세션 범위(intent.resolve와 같은 토큰·예산).
 * 던지는 ChatError의 code가 main에 가는 오류 코드다.
 */
export async function chatRespond(model: ChatModel, input: RedactedText, runToken: RunToken, chatSessionId: string): Promise<ChatReply> {
  if (Buffer.byteLength(input, 'utf8') > CHAT_INPUT_MAX_BYTES) throw new ChatError('chat.input_too_large');
  let r: RespondResult;
  try {
    r = await model.respond({
      toolset: CHAT_REPLY.id,
      messages: [{ role: 'user', content: [{ type: 'input_text', text: input }] }],
      replay: [],
      runToken,
      chatSessionId: chatSessionId as RespondRequest['chatSessionId'],
    });
  } catch {
    throw new ChatError('chat.unavailable');
  }
  if (r.status === 'refusal') return { reply: CHAT_FALLBACK_TEXT, kind: 'out_of_scope', suggest: [], filtered: 'refusal' };
  if (r.status !== 'completed') throw new ChatError(errorOf(r.reason));
  if (r.toolCalls.length) throw new ChatError('chat.bad_response');
  return checkOutput(r.output);
}

/** 출력 검증(어댑터의 스키마 검증 뒤에 한 번 더: 이 함수만으로도 안전해야 한다). */
export function checkOutput(out: unknown): ChatReply {
  const o = out as { kind?: unknown; reply?: unknown; suggest?: unknown } | null;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new ChatError('chat.bad_response');
  const keys = Object.keys(o).sort();
  if (keys.join(',') !== 'kind,reply,suggest') throw new ChatError('chat.bad_response');
  if (typeof o.kind !== 'string' || !KINDS.has(o.kind) || typeof o.reply !== 'string' || !Array.isArray(o.suggest)) throw new ChatError('chat.bad_response');
  if (o.suggest.length > CHAT_SUGGEST_MAX || !o.suggest.every((s) => typeof s === 'string' && CAPABILITY_IDS.has(s))) throw new ChatError('chat.bad_response');
  const kind = o.kind as ChatReplyKind;
  const suggest = [...new Set(o.suggest as ChatSuggestion[])];
  // 화면 표시 정리: 줄바꿈·연속 공백은 공백 하나로(뜻은 바뀌지 않는다). 길이는 정리 뒤 글자 수로 본다.
  const reply = o.reply.replace(/\s+/g, ' ').trim();
  if (kind === 'tax_advice') return { reply: CHAT_ADVICE_TEXT, kind, suggest, filtered: 'advice' };
  if (!reply || [...reply].length > CHAT_REPLY_MAX_CHARS) throw new ChatError('chat.bad_response');
  if (chatAdviceMentioned(reply)) return { reply: CHAT_ADVICE_TEXT, kind, suggest, filtered: 'advice' };
  if (unsafeReply(reply)) return { reply: CHAT_FALLBACK_TEXT, kind, suggest, filtered: 'unsafe' };
  return { reply, kind, suggest, filtered: null };
}
