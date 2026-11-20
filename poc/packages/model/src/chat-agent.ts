import { AGENT_ASKS, AGENT_REPLY_KINDS, AGENT_SHOW_MAX, CHAT_AGENT_TOOLS } from '@sax/chat-core';
import type { ToolDef, ToolsetDef } from './toolsets.ts';

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
