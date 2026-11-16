// 폰 대화 툴셋(ADR-047, ADR-046 결정 7): PC가 꺼져 있을 때 폰이 게이트웨이로 직접 부르는 두 툴셋.
// - chat_phone: 폰 사본(PC가 마지막으로 넘긴 거래처·최근 발급·받을 돈)으로 답하는 대화. 도구 실행과 루프는 폰에 있다.
//   도구·결과 슬롯·되묻기 칸은 chat_agent 표에서 나온다(PC와 폰이 같은 문법을 쓴다). 장부 전체가 필요한 sales_summary만 뺐다.
//   발급·전송 도구는 없다. 폰 대화는 카드를 만들고 고치고 취소만 하고, 맡기기는 사장님이 카드에서 한다(실행은 PC가 켜진 뒤 시작 게이트·승인).
// - chat_digest: 가린 대화를 줄여 적는 요약(도구 없음, 1턴). 폰은 오래된 폰 구간을 접을 때, PC는 폰에 넘길 긴 요약을 만들 때 쓴다.
// 게이트웨이는 폰 토큰(chat 범위)에 PHONE_TOOLSETS만 연다.
import { AGENT_ASKS, AGENT_SHOW_MAX, CHAT_PHONE_MAX_TURNS, CHAT_PHONE_TOOLS, PHONE_REPLY_KINDS } from '@sax/chat-core';
import type { ToolDef, ToolsetDef } from './toolsets.ts';

// 표(도구·답 종류·status·사본 상태·툴셋 목록)는 @sax/chat-core(tables.ts)에 있다. 폰 대화 코어가 같은 표를 쓴다. 이름은 여기서 그대로 다시 내보낸다.
export {
  CHAT_DIGEST_MAX_CHARS,
  CHAT_PHONE_MAX_TURNS,
  CHAT_PHONE_TOOLS,
  PHONE_COPY_STATES,
  PHONE_OMITTED_TOOLS,
  PHONE_ONLY_TOOLSETS,
  PHONE_REPLY_KINDS,
  PHONE_TOOLSETS,
  PHONE_TOOL_STATUSES,
  type ChatPhoneToolName,
  type PhoneCopyState,
  type PhoneReplyKind,
  type PhoneToolStatus,
} from '@sax/chat-core';

const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const TOOLS: readonly ToolDef[] = CHAT_PHONE_TOOLS;

export const CHAT_PHONE: ToolsetDef = {
  id: 'chat_phone',
  effort: 'low',
  maxOutputTokens: 4_000,
  maxTurns: CHAT_PHONE_MAX_TURNS,
  prefixKey: 'chat_phone',
  commonPrefix: false,
  tools: TOOLS.map((t) => ({ name: t.name, parameters: t.parameters })),
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
