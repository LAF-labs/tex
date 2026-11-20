import { randomUUID } from 'node:crypto';
import ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { CounterpartyRepo, ProfileRepo, type Db } from '@sax/db';
import {
  AGENT_ASKS,
  AGENT_REPLY_KINDS,
  BundleCatalog,
  CHAT_AGENT,
  DefaultModelLayer,
  GatewayDecideAdapter,
  L1_MODEL,
  OpenAIResponsesAdapter,
  ThresholdProfiles,
  SLOT_FIELDS,
  SLOT_MONEY_PATHS,
  gatewayRunToken,
  slotPattern,
  type AgentAsk,
  type AgentReplyKind,
  type ChatAgentToolName,
  type RedactedReplayItem,
  type RedactedText,
  type RespondRequest,
  type RespondResult,
  type RunToken,
  type SlotField,
  type ToolCall,
} from '@sax/model';
import type { Egress } from '@sax/net';
import { AGENT_SHOW_MAX, OPEN_SCREENS, ACK_REPLY_HINT, CHAT_ROUTE_BUNDLE, REACTIONS, REACTION_GTE, capStreak, reactedLine, ReplyShapeError, TOOL_NEEDS, bandOf, braceTokens, checkAgentReply, chatInput, gluedName, parseKrw, registerChatRecords, routeAck, type OpenScreen, type ProbBand, type ReactionId, type ReplyMode, type RouteAnswer, type ToolNeed } from '@sax/chat-core';
import { CHAT_MAP_IDLE_MS, ChatTokenMaps, TOKEN_RE, detokenize, type Redactor } from '@sax/redaction';
import { ChatError, chatSecretShaped, errorOf, type ChatErrorCode } from './chat.ts';
import { INTENT_TEXT_MAX } from './intent.ts';
import { Judge } from './l0/judge.ts';

/** 한 사용자 턴의 마스킹 입력 상한(바이트). 대화록이 붙어 chat_reply(2048)보다 크다. 넘으면 오래된 턴부터 버린다. */
export const CHAT_AGENT_INPUT_MAX_BYTES = 8192;
/** 대화록에 붙이는 최근 턴 수 */
export const CHAT_AGENT_TRANSCRIPT_TURNS = 12;
export const CHAT_AGENT_FALLBACK_TEXT = '네, 말씀해 주세요. 필요한 일을 편하게 말씀해 주시면 바로 해 드릴게요.';
/**
 * 답 문장에 슬롯·토큰 밖의 숫자가 있을 때(모델이 셈하거나 지어낸 값일 수 있다). 문장은 버리고 같이 보일 표·카드는 그대로 둔다.
 * 다시 묻지 않는 이유: 한 번 더 부르면 3~4초가 늘고 또 틀릴 수 있다. 표·카드의 값은 PC가 낸 것이라 언제나 맞다.
 */
export const CHAT_AGENT_NUMBER_TEXT = '결과를 아래에 보여 드렸어요. 금액과 날짜는 표와 카드에 있어요.';
/**
 * 엔진이 직접 되묻는 고정 문장(되묻기 칸별). 모델이 같은 호출을 되풀이하거나 되묻는 문장에 숫자를 섞었을 때 쓴다.
 * 화면은 이 문장 아래 그 칸의 선택지를 붙인다.
 */
export const CHAT_AGENT_ASK_TEXT: Record<AgentAsk, string> = {
  amount: '금액을 알려 주세요. 부가세 포함이면 같이 말씀해 주세요.',
  item: '품목을 알려 주세요. 디자인 용역처럼 적어 주시면 돼요.',
  counterparty: '어느 거래처예요? 거래처 목록에 있는 이름으로 골라 주세요.',
  vat: '부가세는 별도예요, 포함이에요?',
  which_card: '어느 카드를 말씀하시는지 골라 주세요.',
  date: '작성일자를 다시 알려 주세요. 오늘이나 지난 날로만 정할 수 있어요.',
};
/** 엔진이 도구 결과로 턴을 닫을 때의 고정 문장(마지막 결과 status별). 없으면 CHAT_AGENT_NUMBER_TEXT. */
export const CHAT_AGENT_DONE_TEXT: Partial<Record<ToolStatus, string>> = {
  card_shown: '세금계산서 카드를 만들었어요. 진행은 카드에서 보여 드려요.',
  card_updated: '카드를 고쳤어요. 바뀐 값을 한 번 봐 주세요.',
  discarded: '카드를 취소했어요. 홈택스에는 아무것도 보내지 않았어요.',
  ok: '찾은 기록을 아래 표로 보여 드렸어요.',
  empty: '찾는 기록이 아직 없어요.',
  not_set_up: '아직 계좌를 연결하지 않아서 볼 수 없어요. 설정 > 계좌 연결에서 먼저 이어 주세요.',
  opened: '말씀하신 화면을 열었어요.',
};
/** 엔진이 조회 되풀이로 턴을 닫을 때의 문장. 슬롯은 main이 결과 값으로 채운다. */
export const CHAT_AGENT_LOOKUP_TEXT = (ref: string): string => `{${ref}.count}건, 합계 {${ref}.sum.total}이에요. 가장 최근은 {${ref}.first.date} {${ref}.first.counterparty} 건이에요.`;
/** 돈 흐름 조회 되풀이(값은 main이 채운다). partial이면 확인 못 한 계좌가 있다고 같이 말한다(11 §3.4: 모르는 것을 0으로 세지 않는다). */
export const CHAT_AGENT_CASH_TEXT = (ref: string, partial: boolean): string =>
  `${partial ? '일부 계좌 거래내역이 모자라 확인 못 한 부분이 있어요. 확인된 것만 보면 ' : ''}들어온 돈 {${ref}.cash.in}, 나간 돈 {${ref}.cash.out}이에요.`;
/**
 * 가장 오래된 건을 물은 조회 되풀이("누가 제일 늦게 줘?", chat-eval look-late: 되풀이로 닫으며 "가장 최근"을 말함).
 * 조회 결과는 최신이 맨 위라 가장 오래된 건은 last다.
 */
export const CHAT_AGENT_OLDEST_TEXT = (ref: string): string => `가장 오래된 건은 {${ref}.last.date} {${ref}.last.counterparty} 건이고, 합계는 {${ref}.last.total}이에요.`;
const OLDEST_ASK = /늦게|오래\s*(?:된|못|안)|제일\s*오래|밀린|연체|제일\s*먼저/;
/** 승인번호를 물은 조회 되풀이(chat-eval look-approval: 건수·합계만 말하고 물은 승인번호가 빠짐) */
export const CHAT_AGENT_APPROVAL_TEXT = (ref: string): string => `가장 최근 건({${ref}.first.date})의 승인번호는 {${ref}.first.approvalNo}예요.`;
const cardKey = (c: { counterpartyId: string; amount: DraftAmount; quantity?: string | null; unitPrice?: DraftAmount }): string =>
  `${c.counterpartyId}:${JSON.stringify(c.amount)}${c.quantity || c.unitPrice ? `:${c.quantity ?? ''}x${JSON.stringify(c.unitPrice ?? null)}` : ''}`;
const dateWords = (d: DraftExtra['date'] | undefined): string | null => {
  if (!d) return null;
  const mo = d.monthOffset ?? 0;
  const month = mo === 0 ? '이번 달' : mo === -1 ? '지난달' : `${-mo}달 전`;
  const day = d.day === 'last' ? '말일' : d.day && /^\d{1,2}$/.test(d.day) ? `${Number(d.day)}일` : null;
  return day ? `${month} ${day}` : null;
};
const CARD_CLOSE: ReadonlySet<ToolStatus> = new Set(['card_shown', 'card_updated', 'discarded', 'needs_input']);
const RETRY_CODES: readonly ChatErrorCode[] = ['chat.unavailable', 'chat.budget_exceeded', 'chat.quota_exceeded'];
const REPLAY_MAX = 12;

export const TOOL_STATUSES = ['ok', 'partial', 'empty', 'unknown_counterparty', 'not_set_up', 'card_shown', 'needs_input', 'setup_missing', 'card_updated', 'no_such_draft', 'not_editable', 'discarded', 'opened'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];
export { draftDate, issueDateRule, lineSupply, parseQuantity, shortDate, type IssueDateRule } from '@sax/chat-core';
export { REACTIONS, TurnRecorder, turnSignal, type ReactionId, type ReplyMode, type TurnEvent, type TurnSignal } from '@sax/chat-core';
export { TOOL_NEEDS, chatInput, chatMaskSpans, emailFragmentRes, gluedName, numberShaped, parseKrw, typoAliases, type ToolNeed } from '@sax/chat-core';

/** main이 모델에 돌려주는 도구 결과. 값·행·개수가 없다(C-10). */
export interface ToolOutput {
  ref: string | null;
  status: ToolStatus;
  fields: SlotField[] | null;
  needs: ToolNeed[] | null;
}

export type Vat = 'separate' | 'included';

/** 화면 프레임: 열린 카드의 ref와 열거 값만. 거래처는 레코드 ID로 받아 엔진이 토큰으로 바꾼다. */
export interface ScreenFrame {
  cards: Array<{ ref: string; counterpartyId: string; amount: boolean; vat: Vat | null; item: boolean }>;
}

export type StepParams = { start: { text: string; frame: ScreenFrame; profileId: string } } | { continue: { outputs: Array<{ callId: string; output: ToolOutput }> } };

/** 금액 인자: 금액 토큰을 로컬에서 읽은 값, 또는 main이 채울 결과 슬롯 */
export type DraftAmount = { value: number } | { slot: string } | null;

/**
 * 작성일자·수량·단가(ADR-049). 날짜는 모델이 준 달·날 그대로(계산은 main이 KST 오늘로 한다), 수량은 말한 수 그대로(정수 검사는 main),
 * 단가는 금액 토큰을 읽은 값이나 결과 슬롯. 모두 없으면 지금과 같다.
 */
export interface DraftExtra {
  date?: { monthOffset: number | null; day: string | null } | null;
  quantity?: string | null;
  unitPrice?: DraftAmount;
}

/** 역치환한 도구 호출. counterpartyId는 'cp:' 없는 거래처 레코드 ID다. */
export type DomainCall =
  | { tool: 'sales_summary'; monthOffset: number }
  | { tool: 'invoice_history'; counterpartyId: string | null }
  | { tool: 'receivables'; counterpartyId: string | null }
  | { tool: 'payables'; counterpartyId: string | null }
  | { tool: 'cash_flow'; monthOffset: number }
  | ({ tool: 'invoice_draft'; counterpartyId: string; amount: DraftAmount; vat: Vat | null; item: string | null } & DraftExtra)
  | ({ tool: 'draft_edit'; draft: string; amount: DraftAmount; vat: Vat | null; item: string | null } & DraftExtra)
  | { tool: 'draft_discard'; draft: string }
  | { tool: 'open_screen'; screen: OpenScreen };

/** 검사를 마친 답. filtered가 있으면 text는 엔진 고정 문구다. */
export interface AgentReply {
  kind: AgentReplyKind;
  text: string;
  show: string[];
  ask: AgentAsk | null;
  filtered: null | 'advice' | 'unsafe' | 'refusal' | 'number' | 'repeat' | 'slot' | 'closed';
}

/**
 * main에 돌려주는 답. text는 채우기 전 문장(토큰·슬롯 그대로)이고, values는 이 답에 나온 토큰의 화면 값이다
 * (거래처 토큰은 지금 장부 이름, 다른 토큰은 사장님이 쓴 원값). 토큰·슬롯을 값으로 바꾸고 조사를 맞추는 일은 main 한 곳에서 한다.
 */
export type ShownReply = AgentReply & {
  values: Record<string, string>;
  unknownName: string | null;
};
export type StepResult = { kind: 'tools'; calls: Array<{ callId: string } & DomainCall> } | { kind: 'reply'; reply: ShownReply };

/**
 * chat.route 결과(ADR-057): 판정(jev, chat_route_v1)이 정한 받는 방식. 판정이 실패하거나 확신이 없으면 mode answer, reaction null이다
 * (그때 main은 늘 하던 대로 chat.step을 부른다. 판정은 길을 좁히지 막지 않는다).
 * reaction_only면 엔진이 이 말을 대화록에 반응으로 남겼다. main은 chat.step을 부르지 않는다.
 */
export interface RouteStep {
  kind: 'route';
  mode: ReplyMode;
  reaction: ReactionId | null;
  capped?: boolean;
  act: string | null;
  domain: string | null;
  band: ProbBand;
  unsure: boolean;
  failed: boolean;
}
/** 판정 입력 상한(chat_route_v1 maxInputBytes와 같다, 시험이 대조) */
export const CHAT_ROUTE_INPUT_MAX_BYTES = 4096;
const ROUTE_PREV_TURNS = 2;
const REACTED_PREFIX = '(반응 ';
const ASK_LABEL: Record<AgentAsk, string> = { counterparty: '거래처', amount: '금액', item: '품목', vat: '부가세', which_card: '고칠 카드', date: '작성일' };

/** 대화록 한 턴. agent.text는 채우기 전(토큰·슬롯 그대로) 문장이다. 채운 문장은 이 타입에 들어오지 않는다. agent null은 답 없이 끝난 턴. */
export interface AgentTurnRecord {
  user: RedactedText;
  agent: { text: string; show: string[] } | null;
}

export interface ChatAgentModel {
  respond: (req: RespondRequest) => Promise<RespondResult>;
  runToken: (chatSessionId: string) => Promise<RunToken>;
  route?: (input: RedactedText, token: RunToken) => Promise<Record<string, RouteAnswer> | null>;
}

export interface ChatAgentOptions {
  model: ChatAgentModel | null;
  now?: () => number;
  closeOnCards?: boolean;
}

const Ajv2020 = ajv2020.default as typeof import('ajv').default;
const ajv = new Ajv2020({ strict: false });
const nullable = (s: object) => ({ anyOf: [s, { type: 'null' }] });
const REF = '^[rd][1-9][0-9]{0,5}$';
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ref', 'status', 'fields', 'needs'],
  properties: {
    ref: nullable({ type: 'string', pattern: REF }),
    status: { enum: [...TOOL_STATUSES] },
    fields: nullable({ type: 'array', maxItems: SLOT_FIELDS.length, uniqueItems: true, items: { enum: [...SLOT_FIELDS] } }),
    needs: nullable({ type: 'array', maxItems: TOOL_NEEDS.length, uniqueItems: true, items: { enum: [...TOOL_NEEDS] } }),
  },
};
const validOutputs: ValidateFunction = ajv.compile({
  type: 'array',
  maxItems: CHAT_AGENT.maxTurns,
  items: { type: 'object', additionalProperties: false, required: ['callId', 'output'], properties: { callId: { type: 'string', maxLength: 128 }, output: TOOL_OUTPUT_SCHEMA } },
});
const validFrame: ValidateFunction = ajv.compile({
  type: 'object',
  additionalProperties: false,
  required: ['cards'],
  properties: {
    cards: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['ref', 'counterpartyId', 'amount', 'vat', 'item'],
        properties: {
          ref: { type: 'string', pattern: '^d[1-9][0-9]{0,5}$' },
          counterpartyId: { type: 'string', minLength: 1, maxLength: 64 },
          amount: { type: 'boolean' },
          vat: { enum: ['separate', 'included', null] },
          item: { type: 'boolean' },
        },
      },
    },
  },
});

const REF_KIND: Record<ChatAgentToolName, 'r' | 'd'> = { sales_summary: 'r', invoice_history: 'r', receivables: 'r', payables: 'r', cash_flow: 'r', invoice_draft: 'd', draft_edit: 'd', draft_discard: 'd', open_screen: 'r', reply: 'r' };
const engineAnswer = (status: 'unknown_counterparty' | 'no_such_draft'): ToolOutput => ({ ref: null, status, fields: null, needs: null });
const NAME_MAX = 40;
function typedName(s: { red: { map: { valueOf(tok: string): string | undefined; recordOf(tok: string): string | undefined } } }, turn: { user: string }, v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (/^\[NAME_\d+\]$/.test(t)) {
    const raw = turn.user.includes(t) && !s.red.map.recordOf(t) ? s.red.map.valueOf(t)?.trim() : undefined;
    return raw && [...raw].length <= NAME_MAX ? raw : null;
  }
  return t && !/[[\]]/.test(t) && [...t].length <= NAME_MAX && turn.user.includes(t) ? t : null;
}
const KINDS: ReadonlySet<AgentReplyKind> = new Set(AGENT_REPLY_KINDS);
const ASKS: ReadonlySet<AgentAsk> = new Set(AGENT_ASKS);
const VAT_LABEL = { separate: '별도', included: '포함' } as const;


interface Session {
  id: string;
  profileId: string;
  red: Redactor;
  transcript: AgentTurnRecord[];
  refs: Set<string>;
  cashRefs: Set<string>;
  token: RunToken | null;
  lastAt: number;
  turn: Turn | null;
  asked: AgentAsk | null;
  ackReply: boolean;
}

interface Turn {
  user: RedactedText;
  message: RedactedText;
  frameRefs: Set<string>;
  replay: RedactedReplayItem[];
  pending: Array<{ callId: string; tool: ChatAgentToolName; key: string; call: DomainCall | null; args: Record<string, unknown>; answer: ToolOutput | null; dupOf?: string }> | null;
  done: Map<string, ToolOutput>;
  made: string[];
  cards: Map<string, string>;
  unknownName?: string;
}

type Parsed = DomainCall | ToolOutput;

export class ChatAgent {
  private readonly db: Db;
  private readonly opts: ChatAgentOptions;
  private readonly maps: ChatTokenMaps;
  private current: Session | null = null;

  constructor(db: Db, opts: ChatAgentOptions) {
    this.db = db;
    this.opts = opts;
    this.maps = new ChatTokenMaps(() => this.now());
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  async handle(method: string, p: Record<string, unknown>): Promise<StepResult | RouteStep> {
    if (method === 'chat.route') return this.route(p as unknown as { text: string; frame: ScreenFrame; profileId: string });
    if (method !== 'chat.step') throw new ChatError('bad_text');
    return this.step(p as unknown as StepParams);
  }

  async route(p: { text: string; frame: ScreenFrame; profileId: string }): Promise<RouteStep> {
    const { text, cards } = this.checkStart(p);
    if (chatSecretShaped(text)) throw new ChatError('chat.secret_rejected');
    const fail: RouteStep = { kind: 'route', mode: 'answer', reaction: null, act: null, domain: null, band: 'lt80', unsure: true, failed: true };
    const route = this.opts.model?.route;
    if (!route) return fail;
    const s = this.session(p.profileId);
    let user: RedactedText;
    let input: RedactedText;
    try {
      const said = chatInput(text);
      this.register(s.red, said);
      user = s.red.apply(said, { frame: 'none' }).redacted;
      const line = (r: AgentTurnRecord) => `사용자: ${r.user}\n앱: ${r.agent ? r.agent.text : '(답 없음)'}`;
      const prev = s.transcript.slice(-ROUTE_PREV_TURNS);
      input = s.red.apply(
        ['기기: PC', this.frameLine(s, cards), '진행 중인 발급: 없음', `직전에 되물은 칸: ${s.asked ? ASK_LABEL[s.asked] : '없음'}`, ...reactedLine(this.streak(s)), ...(prev.length ? ['[앞 대화]', ...prev.map(line)] : []), `사용자: ${user}`].join('\n'),
        { frame: 'none' },
      ).redacted;
    } catch {
      return fail;
    }
    if (Buffer.byteLength(input, 'utf8') > CHAT_ROUTE_INPUT_MAX_BYTES) return fail;
    let answers: Record<string, RouteAnswer> | null;
    try {
      s.token ??= await this.opts.model!.runToken(s.id);
      answers = await route(input, s.token);
    } catch {
      s.token = null;
      return fail;
    }
    if (!answers) return fail;
    const ack = capStreak(routeAck(answers), this.streak(s));
    s.ackReply = ack.capped;
    const pick = (n: string) => {
      const a = answers![n];
      return a && a.type === 'choice' ? (a as { value: string; confidence: number }) : null;
    };
    const mode = pick('reply_mode');
    const conf = Math.min(mode?.confidence ?? 0, pick('act')?.confidence ?? 0, pick('domain')?.confidence ?? 0);
    if (ack.mode === 'reaction_only') {
      this.record(s, { user, agent: { text: `${REACTED_PREFIX}${REACTIONS[ack.reaction!]})`, show: [] } });
      s.asked = null;
    }
    return { kind: 'route', mode: ack.mode, reaction: ack.reaction, capped: ack.capped, act: pick('act')?.value ?? null, domain: pick('domain')?.value ?? null, band: bandOf(mode?.confidence ?? 0), unsure: conf < REACTION_GTE, failed: false };
  }

  private streak(s: Session): number {
    let n = 0;
    for (let i = s.transcript.length - 1; i >= 0 && s.transcript[i]!.agent?.text.startsWith(REACTED_PREFIX); i--) n++;
    return n;
  }

  private checkStart(p: { text: string; frame: ScreenFrame; profileId: string }): { text: string; cards: Array<ScreenFrame['cards'][number] & { cp: NonNullable<ReturnType<CounterpartyRepo['get']>> }> } {
    const text = p?.text;
    if (typeof text !== 'string' || !text.trim() || [...text].length > INTENT_TEXT_MAX) throw new ChatError('bad_text');
    if (typeof p?.profileId !== 'string' || !p.profileId || p.profileId.length > 128) throw new ChatError('bad_text');
    if (!validFrame(p.frame)) throw new ChatError('chat.bad_tool_output');
    const cps = new CounterpartyRepo(this.db);
    const cards = p.frame.cards.map((c) => ({ ...c, cp: cps.get(c.counterpartyId) }));
    if (cards.some((c) => !c.cp) || new Set(cards.map((c) => c.ref)).size !== cards.length) throw new ChatError('chat.bad_tool_output');
    return { text, cards: cards as Array<ScreenFrame['cards'][number] & { cp: NonNullable<ReturnType<CounterpartyRepo['get']>> }> };
  }

  private frameLine(s: Session, cards: Array<ScreenFrame['cards'][number] & { cp: { name: string } }>): string {
    const line = cards.length
      ? `화면: ${cards.map((c) => `카드 ${c.ref}(세금계산서, 거래처 ${s.red.apply(c.cp.name, { frame: 'none' }).redacted}, 금액 ${c.amount ? '있음' : '없음'}, 부가세 ${c.vat ? VAT_LABEL[c.vat] : '미정'}, 품목 ${c.item ? '있음' : '없음'})`).join('; ')}`
      : '화면: 열린 카드 없음';
    const kst = new Date(this.now() + 9 * 3600_000);
    return `오늘: ${kst.getUTCFullYear()}년 ${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일\n${line}`;
  }

  async step(p: StepParams): Promise<StepResult> {
    const keys = p && typeof p === 'object' ? Object.keys(p) : [];
    if (keys.length !== 1) throw new ChatError('bad_text');
    if ('start' in p) return this.start(p.start);
    if ('continue' in p) return this.cont(p.continue);
    throw new ChatError('bad_text');
  }

  private async start(p: { text: string; frame: ScreenFrame; profileId: string }): Promise<StepResult> {
    const { text, cards } = this.checkStart(p);
    if (!this.opts.model) throw new ChatError('chat.unavailable');
    if (chatSecretShaped(text)) throw new ChatError('chat.secret_rejected');
    const s = this.session(p.profileId);
    s.turn = null;
    let user: RedactedText;
    let frameLine: string;
    try {
      const said = chatInput(text);
      this.register(s.red, said);
      user = s.red.apply(said, { frame: 'none' }).redacted;
      frameLine = this.frameLine(s, cards);
      if (s.ackReply) frameLine = `${frameLine}\n${ACK_REPLY_HINT}`;
      s.ackReply = false;
    } catch {
      throw new ChatError('chat.unavailable');
    }
    s.turn = { user, message: this.compose(s, user, frameLine), frameRefs: new Set(cards.map((c) => c.ref)), replay: [], pending: null, done: new Map(), made: [], cards: new Map() };
    return this.run(s, () => this.advance(s));
  }

  private async cont(p: { outputs: Array<{ callId: string; output: ToolOutput }> }): Promise<StepResult> {
    const s = this.current;
    const t = this.now();
    const turn = s?.turn;
    if (!s || !turn?.pending || t - s.lastAt > CHAT_MAP_IDLE_MS) throw new ChatError('chat.bad_tool_output');
    s.lastAt = t;
    this.maps.get(s.id, s.profileId);
    return this.run(s, async () => {
      const outputs = p?.outputs;
      if (!validOutputs(outputs)) throw new ChatError('chat.bad_tool_output');
      const waiting = turn.pending!.filter((c) => !c.answer && !c.dupOf);
      const given = new Map(outputs.map((o) => [o.callId, o.output]));
      if (given.size !== outputs.length || given.size !== waiting.length || waiting.some((c) => !given.has(c.callId))) throw new ChatError('chat.bad_tool_output');
      for (const c of waiting) {
        const o = given.get(c.callId)!;
        if (o.ref !== null && o.ref[0] !== REF_KIND[c.tool]) throw new ChatError('chat.bad_tool_output');
        c.answer = o;
      }
      for (const c of turn.pending!) if (c.dupOf) c.answer = given.get(c.dupOf)!;
      const round = turn.pending!.map((c) => ({ o: c.answer!, call: c.call, args: c.args }));
      this.answer(s, turn);
      const closed = this.opts.closeOnCards ? this.closeOnCards(s, turn, round) : null;
      return closed ? this.finish(s, closed) : this.advance(s);
    });
  }

  private async run(s: Session, f: () => Promise<StepResult>): Promise<StepResult> {
    try {
      return await f();
    } catch (e) {
      const code = e instanceof ChatError ? e.code : 'chat.unavailable';
      if (s.turn && !RETRY_CODES.includes(code)) this.record(s, { user: s.turn.user, agent: null });
      s.turn = null;
      throw e instanceof ChatError ? e : new ChatError('chat.unavailable');
    }
  }

  private async advance(s: Session): Promise<StepResult> {
    const model = this.opts.model!;
    const turn = s.turn!;
    for (;;) {
      let r: RespondResult;
      try {
        s.token ??= await model.runToken(s.id);
        r = await model.respond({
          toolset: CHAT_AGENT.id,
          messages: [{ role: 'user', content: [{ type: 'input_text', text: turn.message }] }],
          replay: [...turn.replay],
          runToken: s.token,
          chatSessionId: s.id as RespondRequest['chatSessionId'],
        });
      } catch {
        s.token = null;
        throw new ChatError('chat.unavailable');
      }
      if (r.status === 'refusal') return this.finish(s, { kind: 'cannot', text: CHAT_AGENT_FALLBACK_TEXT, show: [], ask: null, filtered: 'refusal' });
      if (r.status !== 'completed') {
        const code = errorOf(r.reason);
        if (code === 'chat.unavailable') s.token = null;
        throw new ChatError(code);
      }
      turn.replay.push(...r.replay);
      if (!r.toolCalls.length) return this.finish(s, this.checkReply(s, turn, r.output));
      const tc = r.toolCalls.map((c) => ({ ...c, arguments: braceTokens(c.arguments) }));
      const said = tc.find((c) => c.name === 'reply');
      if (said) {
        const a = said.arguments as Record<string, unknown>;
        return this.finish(s, this.checkReply(s, turn, { kind: a.kind, text: a.text, show: [], ask: a.kind === 'ask' ? (a.ask ?? null) : null }));
      }
      const turns = turn.replay.filter((x) => x.kind === 'model_output' && (x.item.item as { type?: string }).type !== 'reasoning').length;
      const key = (c: ToolCall) => `${c.name}:${JSON.stringify(c.arguments)}`;
      const repeat = tc.find((c) => turn.done.has(key(c)));
      if (repeat) return this.finish(s, this.settle(s, turn, turn.done.get(key(repeat))!, false));
      if (turns >= CHAT_AGENT.maxTurns || turn.replay.length + tc.length > REPLAY_MAX) {
        const last = [...turn.done.values()].at(-1);
        if (last) return this.finish(s, this.settle(s, turn, last, true));
        throw new ChatError('chat.turn_limit');
      }
      const parsed = tc.map((c) => ({ c, p: this.parseCall(s, turn, c) }));
      const first = new Map<string, { callId: string; p: Extract<DomainCall, { tool: 'invoice_draft' }> }>();
      const dupOf = new Map<string, string>();
      for (const { c, p } of parsed) {
        if ('status' in p || p.tool !== 'invoice_draft') continue;
        const f = first.get(cardKey(p));
        if (!f) {
          first.set(cardKey(p), { callId: c.callId, p });
          continue;
        }
        f.p.vat = p.vat ?? f.p.vat;
        f.p.item = p.item ?? f.p.item;
        if (p.date) f.p.date = p.date;
        dupOf.set(c.callId, f.callId);
      }
      turn.pending = parsed.map(({ c, p }) => ({ callId: c.callId, tool: c.name as ChatAgentToolName, key: key(c), call: 'status' in p ? null : p, args: c.arguments as Record<string, unknown>, answer: 'status' in p ? p : null, ...(dupOf.has(c.callId) ? { dupOf: dupOf.get(c.callId)! } : {}) }));
      const calls = parsed.flatMap(({ c, p }) => ('status' in p || dupOf.has(c.callId) ? [] : [{ callId: c.callId, ...p }]));
      if (calls.length) return { kind: 'tools', calls };
      this.answer(s, turn);
    }
  }

  private settle(s: Session, turn: Turn, last: ToolOutput, limit: boolean): AgentReply {
    const askOf = (o: ToolOutput): AgentAsk | null =>
      o.status === 'needs_input' && o.needs?.length ? o.needs[0]! : o.status === 'unknown_counterparty' ? 'counterparty' : o.status === 'no_such_draft' ? 'which_card' : null;
    const outs = [...turn.done.values()];
    const carded = outs.some((o) => o.status === 'card_shown' || o.status === 'card_updated' || o.status === 'discarded');
    const ask = askOf(last) ?? (carded ? null : (outs.map(askOf).find((x) => x) ?? null));
    const show = [...new Set(turn.made)].slice(-AGENT_SHOW_MAX);
    if (ask) return { kind: 'ask', text: CHAT_AGENT_ASK_TEXT[ask], show, ask, filtered: 'repeat' };
    if (!limit && outs.some((o) => o.status === 'card_shown')) return { kind: 'did', text: CHAT_AGENT_DONE_TEXT.card_shown!, show, ask: null, filtered: 'repeat' };
    if (!limit && (last.status === 'ok' || last.status === 'partial') && last.ref && s.cashRefs.has(last.ref) && show.includes(last.ref))
      return { kind: 'answer', text: CHAT_AGENT_CASH_TEXT(last.ref, last.status === 'partial'), show, ask: null, filtered: 'repeat' };
    if (!limit && last.status === 'ok' && last.ref?.startsWith('r') && show.includes(last.ref))
      return { kind: 'answer', text: /승인\s*번호/.test(turn.user) ? CHAT_AGENT_APPROVAL_TEXT(last.ref) : OLDEST_ASK.test(turn.user) ? CHAT_AGENT_OLDEST_TEXT(last.ref) : CHAT_AGENT_LOOKUP_TEXT(last.ref), show, ask: null, filtered: 'repeat' };
    if (show.length) return { kind: 'did', text: (limit ? null : CHAT_AGENT_DONE_TEXT[last.status]) ?? CHAT_AGENT_NUMBER_TEXT, show, ask: null, filtered: 'repeat' };
    if (!limit && last.status === 'not_set_up') return { kind: 'answer', text: CHAT_AGENT_DONE_TEXT.not_set_up!, show, ask: null, filtered: 'repeat' };
    if (!limit && last.status === 'empty') return { kind: 'answer', text: CHAT_AGENT_DONE_TEXT.empty!, show, ask: null, filtered: 'repeat' };
    throw new ChatError('chat.turn_limit');
  }

  private closeOnCards(s: Session, turn: Turn, round: Array<{ o: ToolOutput; call: DomainCall | null; args: Record<string, unknown> }>): AgentReply | null {
    if (round.length && round.every((r) => r.o.status === 'opened')) {
      const say = round.map((r) => r.args.say).find((x): x is string => typeof x === 'string' && x.trim().length > 0);
      return this.checkReply(s, turn, { kind: 'did', text: say ?? CHAT_AGENT_DONE_TEXT.opened!, show: [], ask: null });
    }
    if (!round.length || !round.every((r) => CARD_CLOSE.has(r.o.status))) return null;
    const show = [...new Set(turn.made)].filter((r) => r.startsWith('d')).slice(-AGENT_SHOW_MAX);
    const ask = round.flatMap((r) => (r.o.status === 'needs_input' ? (r.o.needs ?? []) : []))[0] ?? null;
    if (ask) return { kind: 'ask', text: CHAT_AGENT_ASK_TEXT[ask], show, ask, filtered: 'closed' };
    if (round.some((r) => r.o.status === 'needs_input')) return null;
    const tok = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v.trim()) && (s.red.map.has(v.trim()) || slotPattern.test(v.trim())) ? v.trim() : null);
    const nameOf = (a: Record<string, unknown>) => tok(a.counterparty, /^\[NAME_\d+\]$/);
    const amtOf = (a: Record<string, unknown>) => tok(a.amount, /^(?:\[AMT_\d+\]|\{r[1-9]\d{0,5}\.[a-z.]+\})$/);
    const vatWord = (v: unknown) => (v === 'included' ? '부가세 포함' : v === 'separate' ? '부가세 별도' : null);
    const line = (r: (typeof round)[number]): string | null => {
      const a = r.args;
      const ex = r.call && (r.call.tool === 'invoice_draft' || r.call.tool === 'draft_edit') ? r.call : null;
      const when = dateWords(ex?.date ?? null);
      const unit = tok(a.unit_price, /^(?:\[AMT_\d+\]|\{r[1-9]\d{0,5}\.[a-z.]+\})$/);
      const qty = ex?.quantity && /^[\d,]{1,12}\s?[가-힣a-zA-Z]{0,3}$/.test(ex.quantity) ? ex.quantity : null;
      const line2 = unit && qty ? `단가 ${unit} × ${qty}` : null;
      if (r.o.status === 'card_shown') {
        const who = nameOf(a);
        const amt = amtOf(a) ?? line2;
        const vat = vatWord(a.vat);
        return `${who ? `${who} 앞으로 ` : ''}${when ? `작성일 ${when}, ` : ''}${amt ? `${amt}${vat ? ', ' : ' '}` : ''}${vat ? `${vat}${vat.endsWith('포함') ? '으로' : '로'} ` : ''}세금계산서 카드를 만들었어요.`;
      }
      if (r.o.status === 'card_updated') {
        const parts = [amtOf(a) ? `금액 ${amtOf(a)}` : line2 ? `금액 ${line2}` : null, vatWord(a.vat), r.call?.tool === 'draft_edit' && r.call.item ? '품목' : null, when ? `작성일 ${when}` : null].filter((x) => x);
        if (parts.length === 1 && when && parts[0] === `작성일 ${when}`) return `카드의 작성일을 ${when}로 고쳤어요.`;
        return parts.length === 1 ? `카드를 ${parts[0] === '품목' ? '품목을 바꿔' : `${parts[0]}으로`} 고쳤어요.` : parts.length ? `카드의 ${parts.join(', ')}을 고쳤어요.` : null;
      }
      return null;
    };
    const lines = round.map(line);
    const vatNote = round.some((r) => r.o.status === 'card_shown' && !vatWord(r.args.vat)) ? ' 부가세는 별도로 계산했어요. 포함이면 말씀해 주세요.' : '';
    const cards = round.filter((r) => r.o.status === 'card_shown').length;
    const tail = round.at(-1)!.o.status === 'card_shown' ? ' 진행은 카드에서 보여 드려요.' : round.at(-1)!.o.status === 'card_updated' ? ' 바뀐 값을 한 번 봐 주세요.' : '';
    const text =
      round.every((r) => r.o.status === 'discarded') ? CHAT_AGENT_DONE_TEXT.discarded!
      : lines.every((l) => l) && lines.length <= 2 ? `${lines.join(' ')}${vatNote || tail}`
      : cards > 1 ? `세금계산서 카드 ${cards}장을 만들었어요.${vatNote || tail}`
      : (CHAT_AGENT_DONE_TEXT[round.at(-1)!.o.status] ?? CHAT_AGENT_NUMBER_TEXT);
    return { kind: 'did', text, show, ask: null, filtered: 'closed' };
  }

  private answer(s: Session, turn: Turn): void {
    for (const c of turn.pending!) {
      const o = c.answer!;
      if (o.ref) {
        s.refs.add(o.ref);
        if (c.tool === 'cash_flow') s.cashRefs.add(o.ref);
        turn.made.push(o.ref);
      }
      turn.done.set(c.key, o);
      if (o.status === 'card_shown' && o.ref && c.call?.tool === 'invoice_draft') turn.cards.set(cardKey(c.call), o.ref);
      turn.replay.push({ kind: 'function_call_output', callId: c.callId, output: s.red.apply(JSON.stringify(o), { frame: 'none' }).redacted });
    }
    turn.pending = null;
  }

  private parseCall(s: Session, turn: Turn, c: ToolCall): Parsed {
    const a = c.arguments as Record<string, unknown>;
    const cp = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      if (/^\[NAME_\d+\]$/.test(v.trim()) && !turn.message.includes(v.trim())) return null;
      if (gluedName(turn.user, v.trim(), /\s/.test(s.red.map.valueOf(v.trim()) ?? ''))) return null;
      const r = detokenize({ counterparty: v.trim() }, s.red.map, { recordFields: ['counterparty'] });
      const id = r.ok ? (r.value as { counterparty: { recordId: string } }).counterparty.recordId : '';
      return id.startsWith('cp:') ? id.slice(3) : null;
    };
    const unknown = (v: unknown): ToolOutput => {
      turn.unknownName ??= typedName(s, turn, v) ?? undefined;
      return engineAnswer('unknown_counterparty');
    };
    const draft = (v: unknown): string | null => (typeof v === 'string' && /^d[1-9]\d{0,5}$/.test(v) && (turn.frameRefs.has(v) || s.refs.has(v)) ? v : null);
    const amount = (v: unknown): DraftAmount => {
      if (v === null) return null;
      const t = String(v).trim();
      const slot = slotPattern.exec(t);
      if (slot) {
        if (!s.refs.has(slot[1]!) || !SLOT_MONEY_PATHS.includes(slot[2]!)) throw new ChatError('chat.bad_response');
        return { slot: t };
      }
      const raw = /^\[AMT_\d+\]$/.test(t) ? s.red.map.valueOf(t) : undefined;
      if (raw === undefined) throw new ChatError('chat.bad_response');
      const n = parseKrw(raw);
      return n === null ? null : { value: n };
    };
    const item = (v: unknown): string | null => {
      if (v === null) return null;
      const r = detokenize(String(v), s.red.map);
      if (!r.ok) throw new ChatError('chat.bad_response');
      return String(r.value).trim() || null;
    };
    const vat = (v: unknown): Vat | null => (v === 'separate' || v === 'included' ? v : null);
    const extra = (): DraftExtra => {
      const mo = a.date_month_offset;
      const day = a.date_day;
      const q = a.quantity;
      const qt = q === null || q === undefined ? null : String(q).trim();
      const date = (mo === null || mo === undefined) && (day === null || day === undefined) ? null : { monthOffset: typeof mo === 'number' ? mo : null, day: day === null || day === undefined ? null : String(day).trim() };
      const quantity = qt === null ? null : /^\[AMT_\d+\]$/.test(qt) ? (s.red.map.valueOf(qt) ?? null) : qt;
      const unitPrice = a.unit_price === undefined || a.unit_price === null ? null : amount(a.unit_price);
      return { ...(date ? { date } : {}), ...(quantity !== null ? { quantity } : {}), ...(unitPrice ? { unitPrice } : {}) };
    };
    const tool = c.name as ChatAgentToolName;
    const parse: { [K in ChatAgentToolName]: () => Extract<DomainCall, { tool: K }> | ToolOutput } = {
      sales_summary: () => ({ tool: 'sales_summary', monthOffset: Number(a.month_offset) }),
      invoice_history: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'invoice_history', counterpartyId: id };
      },
      receivables: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'receivables', counterpartyId: id };
      },
      payables: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'payables', counterpartyId: id };
      },
      cash_flow: () => ({ tool: 'cash_flow', monthOffset: Number(a.month_offset) }),
      invoice_draft: () => {
        const id = cp(a.counterparty);
        return id ? { tool: 'invoice_draft', counterpartyId: id, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item), ...extra() } : unknown(a.counterparty);
      },
      draft_edit: () => {
        const d = draft(a.draft);
        return d ? { tool: 'draft_edit', draft: d, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item), ...extra() } : engineAnswer('no_such_draft');
      },
      draft_discard: () => {
        const d = draft(a.draft);
        return d ? { tool: 'draft_discard', draft: d } : engineAnswer('no_such_draft');
      },
      open_screen: () => {
        if (!(OPEN_SCREENS as readonly unknown[]).includes(a.screen)) throw new ChatError('chat.bad_response');
        return { tool: 'open_screen', screen: a.screen as OpenScreen };
      },
      reply: () => {
        throw new ChatError('chat.bad_response');
      },
    };
    if (!Object.hasOwn(parse, tool)) throw new ChatError('chat.bad_response');
    const p = parse[tool]();
    const same = !('status' in p) && p.tool === 'invoice_draft' ? turn.cards.get(cardKey(p)) : undefined;
    if (same && !('status' in p) && p.tool === 'invoice_draft') {
      return { tool: 'draft_edit', draft: same, amount: p.amount, vat: p.vat, item: p.item, ...(p.date ? { date: p.date } : {}), ...(p.quantity ? { quantity: p.quantity } : {}), ...(p.unitPrice ? { unitPrice: p.unitPrice } : {}) };
    }
    return p;
  }

  private checkReply(s: Session, turn: Turn, out: unknown): AgentReply {
    try {
      return checkAgentReply<AgentReplyKind, AgentAsk>(out, {
        kinds: KINDS,
        asks: ASKS,
        hasToken: (tok) => s.red.map.has(tok),
        hasRef: (ref) => s.refs.has(ref),
        canShow: (ref) => s.refs.has(ref) || turn.frameRefs.has(ref),
        fallbackText: CHAT_AGENT_FALLBACK_TEXT,
        numberText: CHAT_AGENT_NUMBER_TEXT,
        userText: turn.user,
        askText: (a) => CHAT_AGENT_ASK_TEXT[a],
        badSlot: (k, a, refs) => {
          const shown = refs.length ? refs : [...new Set(turn.made)].slice(-AGENT_SHOW_MAX);
          const outs = [...turn.done.values()];
          const carded = outs.some((o) => o.status === 'card_shown');
          if (a && !(a === 'vat' && carded)) return { kind: k, text: CHAT_AGENT_ASK_TEXT[a], show: shown, ask: a, filtered: 'slot' };
          const done = outs.length ? CHAT_AGENT_DONE_TEXT[outs.at(-1)!.status] : undefined;
          return { kind: k, text: done ?? (shown.length ? CHAT_AGENT_NUMBER_TEXT : CHAT_AGENT_FALLBACK_TEXT), show: shown, ask: null, filtered: 'slot' };
        },
      });
    } catch (e) {
      if (e instanceof ReplyShapeError) throw new ChatError('chat.bad_response');
      throw e;
    }
  }

  private finish(s: Session, r: AgentReply): StepResult {
    const unknownName = r.filtered ? null : (s.turn!.unknownName ?? null);
    this.record(s, { user: s.turn!.user, agent: { text: r.text, show: r.show } });
    s.asked = r.ask ?? null;
    s.turn = null;
    return { kind: 'reply', reply: { ...r, values: r.filtered && r.filtered !== 'closed' ? {} : this.values(s, r.text), unknownName } };
  }

  private values(s: Session, text: string): Record<string, string> {
    const cps = new CounterpartyRepo(this.db);
    const out: Record<string, string> = {};
    for (const [tok] of text.matchAll(TOKEN_RE)) {
      const rec = s.red.map.recordOf(tok);
      const name = tok.startsWith('[NAME_') && rec?.startsWith('cp:') ? cps.get(rec.slice(3))?.name : undefined;
      out[tok] = name ?? s.red.map.valueOf(tok)!;
    }
    return out;
  }

  private record(s: Session, r: AgentTurnRecord): void {
    s.transcript.push(r);
    if (s.transcript.length > CHAT_AGENT_TRANSCRIPT_TURNS) s.transcript.splice(0, s.transcript.length - CHAT_AGENT_TRANSCRIPT_TURNS);
  }

  private compose(s: Session, user: RedactedText, frameLine: string): RedactedText {
    const now = `[지금]\n${frameLine}\n사용자: ${user}`;
    const line = (r: AgentTurnRecord) => `사용자: ${r.user}\n앱: ${r.agent ? `${r.agent.text}${r.agent.show.length ? ` (보임: ${r.agent.show.join(', ')})` : ''}` : '(답 없음)'}`;
    for (let from = 0; from <= s.transcript.length; from++) {
      const past = s.transcript.slice(from);
      let out: RedactedText;
      try {
        out = s.red.apply(past.length ? `[앞 대화]\n${past.map(line).join('\n')}\n${now}` : now, { frame: 'none' }).redacted;
      } catch {
        throw new ChatError('chat.unavailable');
      }
      if (Buffer.byteLength(out, 'utf8') <= CHAT_AGENT_INPUT_MAX_BYTES) return out;
    }
    throw new ChatError('chat.input_too_large');
  }

  private session(profileId: string): Session {
    const t = this.now();
    let s = this.current;
    if (s && (s.profileId !== profileId || t - s.lastAt > CHAT_MAP_IDLE_MS)) {
      this.maps.end(s.id);
      s = null;
    }
    if (!s) {
      const id = `chat_${randomUUID()}`;
      s = { id, profileId, red: this.maps.get(id, profileId), transcript: [], refs: new Set(), cashRefs: new Set(), token: null, lastAt: t, turn: null, asked: null, ackReply: false };
      this.current = s;
    }
    s.lastAt = t;
    this.maps.get(s.id, profileId);
    return s;
  }

  private register(red: Redactor, text: string): void {
    registerChatRecords(red, text, [
      ...new CounterpartyRepo(this.db).list().map((c) => ({ recordId: `cp:${c.id}`, names: [c.name, ...(c.repName ? [c.repName] : [])], emails: c.email ? [c.email] : [], bizNos: [c.bizNo] })),
      ...new ProfileRepo(this.db).list().map((p) => ({ recordId: `pf:${p.id}`, names: [p.displayName, ...(p.repName ? [p.repName] : [])], emails: [] as string[], bizNos: p.bizNo ? [p.bizNo] : [] })),
    ]);
  }
}

/** 엔진 기본 경로(게이트웨이)로 ChatAgentModel을 만든다. Egress에 게이트웨이 설정이 없으면 null(chat.step은 chat.unavailable). */
export function gatewayChatAgentModel(egress: Egress): ChatAgentModel | null {
  if (!egress.gatewayGuard) return null;
  const responder = new OpenAIResponsesAdapter({ transport: 'gateway', egress });
  const judge = chatRouteJudge(egress);
  return {
    respond: (req) => responder.respond(CHAT_AGENT, req),
    runToken: (chatSessionId) => gatewayRunToken(egress, { chatSessionId }),
    ...(judge ? { route: judge } : {}),
  };
}

/**
 * 판정 포트(ADR-057): jev + chat_route_v1을 게이트웨이 /v1/decide로 부른다. 결과 매핑(outcome)은 쓰지 않고 질문별 답만 쓴다
 * (받는 방식은 @sax/chat-core routeAck가 정한다: PC와 폰이 같은 함수). 인젝션 사전 필터에 걸리면 null(반응하지 않는다).
 */
export function chatRouteJudge(egress: Egress, opts: { catalog?: BundleCatalog } = {}): ChatAgentModel['route'] | null {
  if (!egress.gatewayGuard) return null;
  const catalog = opts.catalog ?? BundleCatalog.load();
  if (!catalog.get(CHAT_ROUTE_BUNDLE.id)) return null;
  const layer = new DefaultModelLayer({ catalog, profiles: ThresholdProfiles.load(), decider: new GatewayDecideAdapter({ egress, model: L1_MODEL }) });
  const judge = new Judge(layer, new Set());
  return async (input, token) => {
    const r = await judge.decide(CHAT_ROUTE_BUNDLE.id, { kind: 'intent', text: '' }, input, token);
    if (r.injectionHit || r.l0Only) return null;
    if (r.outcome === 'unknown' && r.reason && !['mapping_unknown', 'core_refusal'].includes(r.reason)) throw new Error(r.reason);
    const out: Record<string, RouteAnswer> = {};
    for (const [k, a] of Object.entries(r.raw)) {
      if (a.type === 'choice') out[k] = { type: 'choice', value: a.value, confidence: a.confidence };
      else if (a.type === 'predicate') out[k] = { type: 'predicate', probability: a.probability };
    }
    return out;
  };
}
