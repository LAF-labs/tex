import { INTENT_UNAVAILABLE_TEXT } from './intent-route.ts';

export const CHAT_SUGGEST_CHIPS = {
  'hometax.invoice.issue': { label: '세금계산서 발급', text: '세금계산서 ' },
} as const;
export type ChatSuggestion = keyof typeof CHAT_SUGGEST_CHIPS;

export const CHAT_REPLY_KINDS = ['help', 'clarify', 'smalltalk', 'tax_advice', 'out_of_scope'] as const;
const CHAT_FILTERED = ['advice', 'unsafe', 'refusal'] as const;
const CHAT_REPLY_MAX = 200;

export interface ChatReply {
  reply: string;
  kind: (typeof CHAT_REPLY_KINDS)[number];
  suggest: ChatSuggestion[];
  filtered: (typeof CHAT_FILTERED)[number] | null;
}

export const CHAT_ERROR_TEXT = {
  'chat.unavailable': { text: INTENT_UNAVAILABLE_TEXT, retry: true },
  'chat.bad_response': { text: INTENT_UNAVAILABLE_TEXT, retry: true },
  'chat.budget_exceeded': { text: '대화가 길어졌어요. 잠시 뒤에 다시 말해 주세요.', retry: true },
  'chat.quota_exceeded': { text: '이번 달 대화를 다 썼어요. 세금계산서는 입력창 위 빠른 실행으로 발급할 수 있어요.', retry: false },
  'chat.daily_limit': { text: '오늘 쓸 수 있는 대화를 다 썼어요. 새벽 4시에 다시 채워져요. 세금계산서는 빠른 실행으로 발급할 수 있어요.', retry: false },
  'chat.subscription_required': { text: '무료 체험이 끝났어요. 설정 > 구독에서 구독하면 대화를 다시 쓸 수 있어요.', retry: false },
  'chat.input_too_large': { text: '문장이 길어요. 두세 번에 나눠서 말해 주세요.', retry: false },
  'chat.secret_rejected': { text: '비밀번호 같은 값은 대화창에 쓰지 말아 주세요. 이 문장은 보내지 않았어요.', retry: false },
} as const;
export type ChatErrorCode = keyof typeof CHAT_ERROR_TEXT;

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
  respond(text: string): Promise<{ reply: ChatReply } | { error: ChatErrorCode }>;
}

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

export const suggestChips = (s: readonly ChatSuggestion[]) => s.map((id) => ({ playbook: id, ...CHAT_SUGGEST_CHIPS[id] }));
