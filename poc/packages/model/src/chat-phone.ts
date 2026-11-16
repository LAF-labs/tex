// 폰 대화 툴셋(ADR-047, ADR-046 결정 7): PC가 꺼져 있을 때 폰이 게이트웨이로 직접 부르는 두 툴셋.
// - chat_phone: 폰 사본(PC가 마지막으로 넘긴 거래처·최근 발급·받을 돈)으로 답하는 대화. 도구 실행과 루프는 폰에 있다.
//   도구·결과 슬롯·되묻기 칸은 chat_agent 표에서 나온다(PC와 폰이 같은 문법을 쓴다). 장부 전체가 필요한 sales_summary만 뺐다.
//   발급·전송 도구는 없다. 폰 대화는 카드를 만들고 고치고 취소만 하고, 맡기기는 사장님이 카드에서 한다(실행은 PC가 켜진 뒤 시작 게이트·승인).
// - chat_digest: 가린 대화를 줄여 적는 요약(도구 없음, 1턴). 폰은 오래된 폰 구간을 접을 때, PC는 폰에 넘길 긴 요약을 만들 때 쓴다.
// 게이트웨이는 폰 토큰(chat 범위)에 PHONE_TOOLSETS만 연다.
import { AGENT_ASKS, AGENT_REPLY_KINDS, AGENT_SHOW_MAX, CHAT_AGENT_TOOLS } from './chat-agent.ts';
import type { ToolDef, ToolsetDef } from './toolsets.ts';

const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/** 폰에 없는 도구(장부 전체가 있어야 답하는 조회). 이런 요청은 defer로 답하고 PC가 켜지면 PC가 이어받는다. */
export const PHONE_OMITTED_TOOLS = ['sales_summary'] as const;

/** 폰 대화 도구 표: chat_agent 표에서 폰에 없는 것만 뺀다(이름·인자 모양은 PC와 같다). */
export const CHAT_PHONE_TOOLS: readonly ToolDef[] = CHAT_AGENT_TOOLS.filter((t) => !(PHONE_OMITTED_TOOLS as readonly string[]).includes(t.name));
export type ChatPhoneToolName = Exclude<(typeof CHAT_AGENT_TOOLS)[number]['name'], (typeof PHONE_OMITTED_TOOLS)[number]>;

/** 답 종류: PC와 같고 defer(PC가 켜지면 이어서 할 일)만 더 있다. */
export const PHONE_REPLY_KINDS = [...AGENT_REPLY_KINDS, 'defer'] as const;
export type PhoneReplyKind = (typeof PHONE_REPLY_KINDS)[number];

/** 폰 도구 결과의 status(폰 코어가 만들고 머리말이 뜻을 적는다. 시험이 머리말과 대조한다). */
export const PHONE_TOOL_STATUSES = ['ok', 'empty', 'unknown_counterparty', 'not_on_phone', 'card_shown', 'needs_input', 'card_updated', 'no_such_draft', 'not_editable', 'discarded'] as const;
export type PhoneToolStatus = (typeof PHONE_TOOL_STATUSES)[number];

/** 사본 상태([사실]의 "사본:" 줄): fresh(받은 지 하루 안), stale(그보다 오래됨), none(아직 받은 적 없음) */
export const PHONE_COPY_STATES = ['fresh', 'stale', 'none'] as const;
export type PhoneCopyState = (typeof PHONE_COPY_STATES)[number];

export const CHAT_PHONE: ToolsetDef = {
  id: 'chat_phone',
  effort: 'low',
  maxOutputTokens: 4_000,
  maxTurns: 4,
  prefixKey: 'chat_phone',
  commonPrefix: false,
  tools: CHAT_PHONE_TOOLS.map((t) => ({ name: t.name, parameters: t.parameters })),
  output: {
    name: 'phone_reply',
    schema: obj({
      kind: { type: 'string', enum: [...PHONE_REPLY_KINDS] },
      text: { type: 'string' },
      show: { type: 'array', maxItems: AGENT_SHOW_MAX, items: { type: 'string' } },
      ask: { type: ['string', 'null'], enum: [...AGENT_ASKS, null] },
    }),
  },
};

/** 요약 글자 상한(가린 글 기준). 공급사 strict 스키마가 maxLength를 받지 않을 수 있어 스키마에는 넣지 않고 부르는 쪽이 검사한다. */
export const CHAT_DIGEST_MAX_CHARS = 900;

export const CHAT_DIGEST: ToolsetDef = {
  id: 'chat_digest',
  effort: 'low',
  maxOutputTokens: 2_000,
  maxTurns: 1,
  prefixKey: 'chat_digest',
  commonPrefix: false,
  tools: [],
  output: { name: 'chat_digest', schema: obj({ summary: { type: 'string' } }) },
};

/** 폰 토큰(chat 범위)이 부를 수 있는 툴셋 전부. chat_phone은 폰만, chat_digest는 폰과 PC 모두. */
export const PHONE_TOOLSETS = ['chat_phone', 'chat_digest'] as const;
/** 폰만 부르는 툴셋(데스크톱 토큰으로는 부르지 못한다: 표면별 계량이 섞이지 않게). */
export const PHONE_ONLY_TOOLSETS = ['chat_phone'] as const;
