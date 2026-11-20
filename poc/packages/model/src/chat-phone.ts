import { AGENT_ASKS, AGENT_SHOW_MAX, CHAT_PHONE_MAX_TURNS, CHAT_PHONE_TOOLS, PHONE_REPLY_KINDS } from '@sax/chat-core';
import type { ToolDef, ToolsetDef } from './toolsets.ts';

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
