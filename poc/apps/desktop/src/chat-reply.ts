// 대화 짧은 응대(엔진 chat.respond, LAF-labs/tex#261 "데스크톱이 붙일 계약"): intent.resolve가 unknown일 때만 main이 부른다(렌더러에는 열지 않는다).
// - 답(reply)은 렌더러가 텍스트 노드로만 보인다. filtered가 null이 아니면 reply는 엔진 고정 문구다(그대로 보인다).
// - suggest(플레이북 id 0~3개)는 칩이다. 누르면 그 작업의 기존 시작 문장을 입력창에 채울 뿐이고, 작업은 사용자가 보내고 확인 카드를 거쳐야 시작한다.
// - 응답은 신뢰하지 않는다: 모양이 다르면 chat.bad_response. 오류는 코드만 옮기고(메시지 값은 옮기지 않는다) 화면 문구는 CHAT_ERROR_TEXT가 정한다.
// - 정규식 대체는 없다(사용자 결정 2026-11-10 "오프라인 해석은 없다").
import { INTENT_UNAVAILABLE_TEXT } from './intent-route.ts';

/** 엔진 계약의 제안 작업 3종(CHAT_CAPABILITIES)과 칩. text는 빠른 실행(QUICK)과 같은 시작 문장이다. */
export const CHAT_SUGGEST_CHIPS = {
  'hometax.invoice.issue': { label: '세금계산서 발급', text: '세금계산서 ' },
  'hometax.cert.business': { label: '사업자등록증명', text: '사업자등록증명 떼 줘' },
  'hometax.cert.taxpayment': { label: '납세증명서', text: '납세증명서 떼 줘' },
} as const;
export type ChatSuggestion = keyof typeof CHAT_SUGGEST_CHIPS;

export const CHAT_REPLY_KINDS = ['help', 'clarify', 'smalltalk', 'tax_advice', 'out_of_scope'] as const;
export const CHAT_FILTERED = ['advice', 'unsafe', 'refusal'] as const;
/** 엔진이 검사하는 답 상한(계약 ≤ 200자). 넘으면 믿지 않는다. */
export const CHAT_REPLY_MAX = 200;

export interface ChatReply {
  reply: string;
  kind: (typeof CHAT_REPLY_KINDS)[number];
  suggest: ChatSuggestion[];
  filtered: (typeof CHAT_FILTERED)[number] | null;
}

/** 오류 코드 → 대화 문장과 [다시 시도]를 둘지. 표에 없는 코드는 chat.unavailable로 접는다. */
export const CHAT_ERROR_TEXT = {
  'chat.unavailable': { text: INTENT_UNAVAILABLE_TEXT, retry: true },
  'chat.bad_response': { text: INTENT_UNAVAILABLE_TEXT, retry: true },
  'chat.budget_exceeded': { text: '대화가 많이 이어졌어요. 잠시 뒤에 다시 말해 주세요.', retry: true },
  'chat.quota_exceeded': { text: '이번 달 대화 한도를 다 썼어요. 세금계산서·증명서 발급은 빠른 실행으로 할 수 있어요.', retry: false },
  'chat.input_too_large': { text: '문장이 너무 길어요. 짧게 나눠서 다시 말해 주세요.', retry: false },
  'chat.secret_rejected': { text: '비밀번호 같은 비밀 값은 대화창에 입력하지 마세요. 이 문장은 보내지 않았어요.', retry: false },
} as const;
export type ChatErrorCode = keyof typeof CHAT_ERROR_TEXT;

/** 엔진 응답 → ChatReply. 모양이 다르면 null. */
export function parseChatReply(v: unknown): ChatReply | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (typeof r.reply !== 'string' || !r.reply.trim() || [...r.reply].length > CHAT_REPLY_MAX) return null;
  if (typeof r.kind !== 'string' || !(CHAT_REPLY_KINDS as readonly string[]).includes(r.kind)) return null;
  if (r.filtered !== null && !(typeof r.filtered === 'string' && (CHAT_FILTERED as readonly string[]).includes(r.filtered))) return null;
  if (!Array.isArray(r.suggest) || r.suggest.length > 3 || new Set(r.suggest).size !== r.suggest.length) return null;
  if (!r.suggest.every((s) => typeof s === 'string' && Object.hasOwn(CHAT_SUGGEST_CHIPS, s))) return null;
  return { reply: r.reply, kind: r.kind as ChatReply['kind'], suggest: r.suggest as ChatSuggestion[], filtered: r.filtered as ChatReply['filtered'] };
}

export interface ChatResponder {
  /** 답 또는 오류 코드(CHAT_ERROR_TEXT의 키). 던지지 않는다. */
  respond(text: string): Promise<{ reply: ChatReply } | { error: ChatErrorCode }>;
}

/** 엔진 rpc 위의 응대기. 상한 시간 안에 답이 없으면 chat.unavailable(L2라 intent.resolve보다 길게 기다린다). */
export function engineChatResponder(rpc: (m: string, p: Record<string, unknown>) => Promise<unknown>, timeoutMs = 12_000): ChatResponder {
  return {
    async respond(text) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>((r) => (timer = setTimeout(() => r('timeout'), timeoutMs)));
      try {
        const v = await Promise.race([rpc('chat.respond', { text }), timeout]);
        if (v === 'timeout') return { error: 'chat.unavailable' };
        const reply = parseChatReply(v);
        return reply ? { reply } : { error: 'chat.bad_response' };
      } catch (e) {
        const m = (e as Error | null)?.message ?? '';
        return { error: Object.hasOwn(CHAT_ERROR_TEXT, m) ? (m as ChatErrorCode) : 'chat.unavailable' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** 칩(렌더러): 라벨·채울 문장·플레이북 id. */
export const suggestChips = (s: readonly ChatSuggestion[]) => s.map((id) => ({ playbook: id, ...CHAT_SUGGEST_CHIPS[id] }));
