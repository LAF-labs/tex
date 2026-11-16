// 답 검사(D04 §3·§4, B-15). 모델이 쓴 문장을 사장님에게 보이기 전 마지막 차단이다. PC 엔진(chat.ts·chat-agent.ts)과 폰 대화 코어가 같은 코드를 쓴다.
// 순수 함수만 둔다. 문장·토큰·값을 로그에 남기지 않는다.
import { EMAIL_RE, TOKEN_RE, normalizeForRedaction, numericSpans } from '@sax/redaction';
import { numberShaped } from './rules.ts';
import { AGENT_SHOW_MAX, CHAT_REPLY_MAX_CHARS, slotAnywhere } from './tables.ts';

/** D04 §3 고정 문구(세무 판단 거절). 데스크톱·폰 화면 문구와 같다. */
export const CHAT_ADVICE_TEXT = '세무 판단은 하지 않아요. 세무 대리인과 상담해 주세요.';

/**
 * 대화창 비밀 DLP(D04 §4 B-15, 최소판): "비밀번호는 abcd1234"처럼 비밀 값을 적은 문장은 모델로 보내지 않는다(chat.secret_rejected,
 * 화면은 "비밀번호는 대화창에 입력하지 마세요"). "비밀번호 잊어버렸어" 같은 말은 값이 없어 걸리지 않는다.
 */
export function chatSecretShaped(text: string): boolean {
  return /(비밀\s?번호|비번|패스워드|암호|password|passwd|pw)\s*(는|은|이|가|:|=)\s*[A-Za-z0-9!@#$%^&*()_+\-=.]{4,}/i.test(text);
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
 * 보여 주면 안 되는 답에서 토큰 검사만 뺀 것: 숫자 식별자(전화·사업자번호 등)·이메일·링크, 그리고 D04 §4 표시 규칙(B-15)의
 * 비밀 입력 유도 말(비밀번호·인증서·보안카드·입력하세요). 우리 앱의 말로 보이게 사용자를 사회공학하는 경로를 막는다.
 * 대화 에이전트는 토큰을 이름으로 바꿔 보이므로 채우기 전 문장(토큰·슬롯을 지운 것)에 이것을 돌린다.
 */
export function unsafeText(text: string): boolean {
  const n = normalizeForRedaction(text);
  if (/비밀번호|비번|패스워드|암호|인증서|보안카드|입력하세요|OTP/i.test(n.replace(/\s+/g, ''))) return true;
  if (numericSpans(n).length) return true;
  if (new RegExp(EMAIL_RE.source, 'u').test(n)) return true;
  return /https?:|www\.|\.(com|kr|net|org|io)\b/i.test(n);
}

/** 모델 출력의 모양이 계약 밖이다(부르는 쪽이 chat.bad_response로 바꾼다). */
export class ReplyShapeError extends Error {
  constructor() {
    super('chat.bad_response');
  }
}

export type ReplyFilter = null | 'advice' | 'unsafe' | 'refusal' | 'number';

/** 검사를 마친 답. filtered가 있으면 text는 고정 문구다. */
export interface CheckedReply<K extends string = string, A extends string = string> {
  kind: K;
  text: string;
  show: string[];
  ask: A | null;
  filtered: ReplyFilter;
}

export interface ReplyCheckCtx<K extends string, A extends string> {
  kinds: ReadonlySet<K>;
  asks: ReadonlySet<A>;
  /** 이 대화 세션의 토큰 맵에 있는 토큰인가 */
  hasToken(token: string): boolean;
  /** 이 대화 세션의 도구 결과가 낸 ref인가(문장 슬롯이 가리킬 수 있는 것) */
  hasRef(ref: string): boolean;
  /** show에 넣을 수 있는 ref인가(도구 결과 + 지금 화면의 카드) */
  canShow(ref: string): boolean;
  /** 식별자·링크·비밀 유도 말이 섞였을 때의 고정 안내 */
  fallbackText: string;
  /** 슬롯·토큰 밖 숫자가 있고 같이 보일 결과가 있을 때의 고정 안내 */
  numberText: string;
}

const REF = /^[rd][1-9][0-9]{0,5}$/;

/**
 * 대화 에이전트 답 검사. 채우기 전 문장에 돈다: 토큰·슬롯은 허용하되 맵에 있는 토큰, 이 세션 결과를 가리키는 슬롯만.
 * 세무 판단은 고정 문구, 식별자·이메일·링크·비밀 유도 말은 고정 안내, 슬롯·토큰 밖 숫자는 문장만 버린다(표·카드는 그대로).
 * 모양이 틀리면 ReplyShapeError.
 */
export function checkAgentReply<K extends string, A extends string>(out: unknown, ctx: ReplyCheckCtx<K, A>): CheckedReply<K, A> {
  const bad = () => new ReplyShapeError();
  const o = out as Record<string, unknown> | null | undefined;
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad();
  if (Object.keys(o).sort().join(',') !== 'ask,kind,show,text') throw bad();
  const { kind, show, ask } = o;
  if (typeof kind !== 'string' || !ctx.kinds.has(kind as K) || typeof o.text !== 'string' || !Array.isArray(show) || show.length > AGENT_SHOW_MAX) throw bad();
  if (!show.every((r) => typeof r === 'string') || !(ask === null || (typeof ask === 'string' && ctx.asks.has(ask as A)))) throw bad();
  const k = kind as K;
  const a = ask as A | null;
  if (k === 'tax_advice') return { kind: k, text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' };
  // 슬롯 안 공백("{ r1.first.total }")은 뜻이 같으니 붙인다
  const text = o.text.replace(/\s+/g, ' ').trim().replace(/\{([^{}]*)\}/g, (_m, x: string) => `{${x.replace(/\s+/g, '')}}`);
  if (!text || [...text].length > CHAT_REPLY_MAX_CHARS) throw bad();
  for (const m of text.matchAll(TOKEN_RE)) if (!ctx.hasToken(m[0])) throw bad();
  for (const m of text.matchAll(slotAnywhere())) if (!ctx.hasRef(m[1]!)) throw bad();
  if (/[{}]/.test(text.replace(slotAnywhere(), ''))) throw bad();
  const refs = [...new Set(show as string[])];
  if (!refs.every((r) => REF.test(r) && ctx.canShow(r))) throw bad();
  if (chatAdviceMentioned(text)) return { kind: k, text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' };
  const bare = text.replace(TOKEN_RE, ' ').replace(slotAnywhere(), ' ');
  if (unsafeText(bare)) return { kind: k, text: ctx.fallbackText, show: [], ask: null, filtered: 'unsafe' };
  if (numberShaped(bare)) return { kind: k, text: refs.length ? ctx.numberText : ctx.fallbackText, show: refs, ask: null, filtered: 'number' };
  return { kind: k, text, show: refs, ask: a, filtered: null };
}
