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

/**
 * 결과 슬롯: 모델은 값을 모른 채 쓰고 main이 로컬 결과에서 채운다.
 * - 행 값 `{r<N>.<first|last>.<field>}`: 맨 위·맨 아래 한 행의 값.
 * - 집계 `{r<N>.sum.<supply|total>}`·`{r<N>.count}`: PC가 계산한 합계·건수. 모델은 산수를 하지 않는다(실제 모델이
 *   "매출 합계"에 첫 행 합계를 쓴 일이 있다, real-run-2 2026-11-12).
 */
export const SLOT_POSITIONS = ['first', 'last'] as const;
/** approvalNo: 국세청 승인번호(원장 committed). 값은 main이 채우고 모델에는 가지 않는다. */
export const SLOT_FIELDS = ['date', 'supply', 'total', 'counterparty', 'approvalNo'] as const;
export type SlotField = (typeof SLOT_FIELDS)[number];
/** 합계를 낼 수 있는 칸(돈) */
export const SLOT_SUM_FIELDS = ['supply', 'total'] as const satisfies readonly SlotField[];
/** 슬롯 경로 전부(ref 뒤). 슬롯 문법은 이 목록 하나에서 나온다. */
export const SLOT_PATHS: readonly string[] = [
  ...SLOT_POSITIONS.flatMap((p) => SLOT_FIELDS.map((f) => `${p}.${f}`)),
  ...SLOT_SUM_FIELDS.map((f) => `sum.${f}`),
  'count',
];
/** 금액 인자로 쓸 수 있는 경로(돈인 칸만) */
export const SLOT_MONEY_PATHS: readonly string[] = SLOT_PATHS.filter((x) => /\.(supply|total)$/.test(x));
/** 슬롯 하나 전체에 맞는다. 묶음 1 = 결과 ref(r#), 2 = 경로(first.supply·sum.total·count …). */
export const slotPattern = new RegExp(`^\\{(r[1-9]\\d{0,5})\\.(${SLOT_PATHS.map((x) => x.replace('.', '\\.')).join('|')})\\}$`);

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
