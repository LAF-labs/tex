// 대화 에이전트 툴셋 chat_agent(D04 §4, 결정안 agent-chat-design-2026-11-12). 루프는 PC(main)에 있고 엔진 chat.step이 모델 경계다.
// 도구·결과 슬롯 문법·답 종류·되묻기 칸은 @sax/chat-core의 표 하나에서 나온다. 머리말(toolsets/chat_agent.ko.txt)은 손으로 맞추고 시험이 대조한다.
// 발급·전송 도구는 없다. 대화는 카드(초안)를 만들고 고치고 발급 전 취소만 한다.
import { AGENT_ASKS, AGENT_REPLY_KINDS, AGENT_SHOW_MAX, CHAT_AGENT_TOOLS } from '@sax/chat-core';
import type { ToolDef, ToolsetDef } from './toolsets.ts';

// 표는 @sax/chat-core(tables.ts)에 있다: 폰 대화 코어가 같은 표로 모델 출력을 검사한다(ADR-047 결정 4). 이름은 여기서 그대로 다시 내보낸다.
export {
  AGENT_ASKS,
  AGENT_REPLY_KINDS,
  AGENT_SHOW_MAX,
  CASH_FIELDS,
  CHAT_AGENT_TOOLS,
  SLOT_FIELDS,
  SLOT_MONEY_PATHS,
  SLOT_PATHS,
  SLOT_POSITIONS,
  SLOT_SUM_FIELDS,
  slotPattern,
  type AgentAsk,
  type AgentReplyKind,
  type CashField,
  type ChatAgentToolName,
  type SlotField,
} from '@sax/chat-core';

const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
// 표의 모양이 ToolDef인지 여기서 확인한다(chat-core는 @sax/model 타입을 모른다).
const TOOLS: readonly ToolDef[] = CHAT_AGENT_TOOLS;

export const CHAT_AGENT: ToolsetDef = {
  id: 'chat_agent',
  effort: 'low',
  maxOutputTokens: 4_000,
  maxTurns: 4,
  prefixKey: 'chat_agent',
  commonPrefix: false,
  tools: TOOLS.map((t) => ({ name: t.name, parameters: t.parameters })),
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
