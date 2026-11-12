// 대화 에이전트 툴셋 chat_agent(D04 §4, 결정안 agent-chat-design-2026-11-12). 루프는 PC(main)에 있고 엔진 chat.step이 모델 경계다.
// 도구·결과 슬롯 문법·답 종류·되묻기 칸은 이 파일의 표 하나에서 나온다. 머리말(toolsets/chat_agent.ko.txt)은 손으로 맞추고 시험이 대조한다.
// 발급·전송 도구는 없다. 대화는 카드(초안)를 만들고 고치고 발급 전 취소만 한다.
import type { ToolDef, ToolsetDef } from './toolsets.ts';

const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const VAT = { type: ['string', 'null'], enum: ['separate', 'included', null] };
const NULLABLE_STRING = { type: ['string', 'null'] };

/** 도구 표. counterparty는 거래처 토큰, amount는 금액 토큰이나 결과 슬롯, draft는 카드 ref(d#)다. */
export const CHAT_AGENT_TOOLS = [
  { name: 'sales_summary', parameters: obj({ month_offset: { type: 'integer', minimum: -12, maximum: 0 } }) },
  { name: 'invoice_history', parameters: obj({ counterparty: NULLABLE_STRING }) },
  { name: 'receivables', parameters: obj({ counterparty: NULLABLE_STRING }) },
  { name: 'invoice_draft', parameters: obj({ counterparty: { type: 'string' }, amount: NULLABLE_STRING, vat: VAT, item: NULLABLE_STRING }) },
  { name: 'draft_edit', parameters: obj({ draft: { type: 'string' }, amount: NULLABLE_STRING, vat: VAT, item: NULLABLE_STRING }) },
  { name: 'draft_discard', parameters: obj({ draft: { type: 'string' } }) },
] as const satisfies readonly ToolDef[];
export type ChatAgentToolName = (typeof CHAT_AGENT_TOOLS)[number]['name'];

/** 결과 슬롯 `{r<N>.<pos>.<field>}`: 모델은 값을 모른 채 쓰고 main이 로컬 결과에서 채운다. */
export const SLOT_POSITIONS = ['first', 'last'] as const;
export const SLOT_FIELDS = ['date', 'supply', 'total', 'counterparty'] as const;
export type SlotField = (typeof SLOT_FIELDS)[number];
/** 슬롯 하나 전체에 맞는다. 묶음 1 = 결과 ref(r#), 2 = 위치, 3 = 칸. */
export const slotPattern = new RegExp(`^\\{(r[1-9]\\d{0,5})\\.(${SLOT_POSITIONS.join('|')})\\.(${SLOT_FIELDS.join('|')})\\}$`);

export const AGENT_REPLY_KINDS = ['answer', 'did', 'ask', 'cannot', 'tax_advice', 'smalltalk'] as const;
export const AGENT_ASKS = ['counterparty', 'amount', 'item', 'vat', 'which_card'] as const;
export type AgentReplyKind = (typeof AGENT_REPLY_KINDS)[number];
export type AgentAsk = (typeof AGENT_ASKS)[number];
/** 답과 같이 보일 ref 상한 */
export const AGENT_SHOW_MAX = 3;

export const CHAT_AGENT: ToolsetDef = {
  id: 'chat_agent',
  effort: 'low',
  maxOutputTokens: 4_000,
  maxTurns: 4,
  prefixKey: 'chat_agent',
  commonPrefix: false,
  tools: CHAT_AGENT_TOOLS.map((t) => ({ name: t.name, parameters: t.parameters })),
  output: {
    name: 'agent_reply',
    schema: obj({
      kind: { type: 'string', enum: [...AGENT_REPLY_KINDS] },
      text: { type: 'string' },
      show: { type: 'array', maxItems: AGENT_SHOW_MAX, items: { type: 'string' } },
      ask: { type: ['string', 'null'], enum: [...AGENT_ASKS, null] },
    }),
  },
};
