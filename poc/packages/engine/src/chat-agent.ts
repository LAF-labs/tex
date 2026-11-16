// 대화 에이전트 모델 경계 chat.step(D04 §4 chat_agent, 결정안 agent-chat-design-2026-11-12 §2~§10).
// 루프와 도구 실행은 main이 한다(값 공간: 카드·조회 결과와 ref). 엔진은 토큰 공간만 맡는다:
// 마스킹(대화 세션 토큰 맵), 마스킹 대화록, 그 턴의 replay, 도구 호출 역치환(토큰 → 레코드 ID·값), 도구 결과 구조 검사(C-10), 답 검사.
// - main → { start: {text, frame, profileId} } → 모델 → 도구 호출이면 { kind: 'tools', calls }(역치환한 DomainCall),
//   main이 실행 → { continue: {outputs} } → … → { kind: 'reply', reply }.
// - 도구 결과는 열거형 스키마(TOOL_OUTPUT_SCHEMA)를 통과해야만 보낸다. 값·개수·자유 문자열이 섞이면 보내지 않고 chat.bad_tool_output.
// - 대화록에는 채우기 전 답(모델이 쓴 토큰·슬롯 그대로)만 들어간다(AgentTurnRecord). 화면에 보이는 채운 문장은 대화록 타입과 따로다.
// - 로그·저널을 남기지 않는다(문장·토큰·값 없음).
import { randomUUID } from 'node:crypto';
import ajv2020 from 'ajv/dist/2020.js';
import type { ValidateFunction } from 'ajv';
import { CounterpartyRepo, ProfileRepo, type Db } from '@sax/db';
import {
  AGENT_ASKS,
  AGENT_REPLY_KINDS,
  CHAT_AGENT,
  OpenAIResponsesAdapter,
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
import { AGENT_SHOW_MAX, ReplyShapeError, TOOL_NEEDS, braceTokens, checkAgentReply, chatInput, gluedName, parseKrw, registerChatRecords, type ToolNeed } from '@sax/chat-core';
import { CHAT_MAP_IDLE_MS, ChatTokenMaps, TOKEN_RE, detokenize, type Redactor } from '@sax/redaction';
import { ChatError, chatSecretShaped, errorOf, type ChatErrorCode } from './chat.ts';
import { INTENT_TEXT_MAX } from './intent.ts';

/** 한 사용자 턴의 마스킹 입력 상한(바이트). 대화록이 붙어 chat_reply(2048)보다 크다. 넘으면 오래된 턴부터 버린다. */
export const CHAT_AGENT_INPUT_MAX_BYTES = 8192;
/** 대화록에 붙이는 최근 턴 수 */
export const CHAT_AGENT_TRANSCRIPT_TURNS = 12;
/** 답 문장을 쓸 수 없을 때(식별자·링크·비밀 유도 말, 모델 거절)의 고정 안내 */
export const CHAT_AGENT_FALLBACK_TEXT = '세금계산서 카드 만들기와 발급 기록·매출·받을 돈 확인을 도와드려요. 어떤 일을 할까요?';
/**
 * 답 문장에 슬롯·토큰 밖의 숫자가 있을 때(모델이 셈하거나 지어낸 값일 수 있다). 문장은 버리고 같이 보일 표·카드는 그대로 둔다.
 * 다시 묻지 않는 이유: 한 번 더 부르면 3~4초가 늘고 또 틀릴 수 있다. 표·카드의 값은 PC가 낸 것이라 언제나 맞다.
 */
export const CHAT_AGENT_NUMBER_TEXT = '결과를 화면에 보여 드렸어요. 금액과 날짜는 표와 카드에서 확인해 주세요.';
/**
 * 엔진이 직접 되묻는 고정 문장(되묻기 칸별). 모델이 같은 호출을 되풀이하거나 되묻는 문장에 숫자를 섞었을 때 쓴다.
 * 화면은 이 문장 아래 그 칸의 선택지를 붙인다.
 */
export const CHAT_AGENT_ASK_TEXT: Record<AgentAsk, string> = {
  amount: '금액을 알려 주세요. 부가세 포함인지 별도인지도 같이 말씀해 주시면 바로 카드를 만들게요.',
  item: '품목을 알려 주세요. 예를 들어 디자인 용역처럼 적어 주시면 돼요.',
  counterparty: '어느 거래처인가요? 장부에 있는 거래처 중에서 골라 주세요.',
  vat: '부가세 별도인가요, 포함인가요?',
  which_card: '어느 카드를 말씀하시는지 골라 주세요.',
};
/** 엔진이 도구 결과로 턴을 닫을 때의 고정 문장(마지막 결과 status별). 없으면 CHAT_AGENT_NUMBER_TEXT. */
export const CHAT_AGENT_DONE_TEXT: Partial<Record<ToolStatus, string>> = {
  card_shown: '세금계산서 확인 카드를 만들었어요. 내용을 확인하시고 [홈택스에서 준비]를 눌러 주세요.',
  card_updated: '카드를 고쳤어요. 카드에서 바뀐 값을 확인해 주세요.',
  discarded: '카드를 취소했어요. 아무것도 발급되지 않았어요.',
  ok: '찾은 기록을 표로 보여 드렸어요.',
  empty: '찾는 기록이 없어요.',
};
/** 엔진이 조회 되풀이로 턴을 닫을 때의 문장. 슬롯은 main이 결과 값으로 채운다. */
export const CHAT_AGENT_LOOKUP_TEXT = (ref: string): string => `{${ref}.count}건이고 합계는 {${ref}.sum.total}이에요. 가장 최근은 {${ref}.first.date} {${ref}.first.counterparty} 건이에요.`;
/** 승인번호를 물은 조회 되풀이(chat-eval look-approval: 건수·합계만 말하고 물은 승인번호가 빠짐) */
export const CHAT_AGENT_APPROVAL_TEXT = (ref: string): string => `가장 최근 건({${ref}.first.date})의 승인번호는 {${ref}.first.approvalNo}예요.`;
/** 이번 턴 같은 카드 판정 키: 거래처와 금액 */
const cardKey = (c: { counterpartyId: string; amount: DraftAmount }): string => `${c.counterpartyId}:${JSON.stringify(c.amount)}`;
/** closeOnCards가 닫는 결과 */
const CARD_CLOSE: ReadonlySet<ToolStatus> = new Set(['card_shown', 'card_updated', 'discarded', 'needs_input']);
/** 다시 보낼 턴이라 대화록에 남기지 않는 오류 */
const RETRY_CODES: readonly ChatErrorCode[] = ['chat.unavailable', 'chat.budget_exceeded', 'chat.quota_exceeded'];
/** 게이트웨이 respond 스키마의 replay maxItems */
const REPLAY_MAX = 12;

export const TOOL_STATUSES = ['ok', 'empty', 'unknown_counterparty', 'not_set_up', 'card_shown', 'needs_input', 'setup_missing', 'card_updated', 'no_such_draft', 'not_editable', 'discarded'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];
// 대화 경로 가림 규칙·금액 읽기는 @sax/chat-core로 옮겼다(폰과 같은 코드, ADR-047 결정 4). 이름은 여기서 그대로 다시 내보낸다.
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

/** 역치환한 도구 호출. counterpartyId는 'cp:' 없는 거래처 레코드 ID다. */
export type DomainCall =
  | { tool: 'sales_summary'; monthOffset: number }
  | { tool: 'invoice_history'; counterpartyId: string | null }
  | { tool: 'receivables'; counterpartyId: string | null }
  | { tool: 'invoice_draft'; counterpartyId: string; amount: DraftAmount; vat: Vat | null; item: string | null }
  | { tool: 'draft_edit'; draft: string; amount: DraftAmount; vat: Vat | null; item: string | null }
  | { tool: 'draft_discard'; draft: string };

/** 검사를 마친 답. filtered가 있으면 text는 엔진 고정 문구다. */
export interface AgentReply {
  kind: AgentReplyKind;
  text: string;
  show: string[];
  ask: AgentAsk | null;
  /** repeat: 모델이 같은 호출을 되풀이해 엔진이 그 결과로 턴을 닫았다(문장은 엔진 고정 문장) */
  filtered: null | 'advice' | 'unsafe' | 'refusal' | 'number' | 'repeat' | 'slot' | 'closed';
}

/**
 * main에 돌려주는 답. text는 채우기 전 문장(토큰·슬롯 그대로)이고, values는 이 답에 나온 토큰의 화면 값이다
 * (거래처 토큰은 지금 장부 이름, 다른 토큰은 사장님이 쓴 원값). 토큰·슬롯을 값으로 바꾸고 조사를 맞추는 일은 main 한 곳에서 한다.
 */
export type ShownReply = AgentReply & {
  values: Record<string, string>;
  /**
   * 이번 턴에 장부의 거래처로 풀리지 않은 이름(U8-1). 사장님이 이번 문장에 쓴 낱말(그 토큰의 원값이나 문장에 글자 그대로 있던 말)일 때만이다.
   * 모델이 지어낸 이름은 싣지 않는다. 화면은 "장부에 없는 거래처" 안내와 그 이름으로 [거래처 추가]를 둔다. PC 밖으로 나가지 않는다.
   */
  unknownName: string | null;
};
export type StepResult = { kind: 'tools'; calls: Array<{ callId: string } & DomainCall> } | { kind: 'reply'; reply: ShownReply };

/** 대화록 한 턴. agent.text는 채우기 전(토큰·슬롯 그대로) 문장이다. 채운 문장은 이 타입에 들어오지 않는다. agent null은 답 없이 끝난 턴. */
export interface AgentTurnRecord {
  user: RedactedText;
  agent: { text: string; show: string[] } | null;
}

export interface ChatAgentModel {
  /** 게이트웨이 /v1/respond(chat_agent). 어댑터가 출력 스키마·도구 인자·툴셋 해시를 검증한다. */
  respond: (req: RespondRequest) => Promise<RespondResult>;
  /** 대화 세션 범위 실행 토큰(게이트웨이 POST /v1/run-tokens) */
  runToken: (chatSessionId: string) => Promise<RunToken>;
}

export interface ChatAgentOptions {
  /** null이면 모든 턴이 chat.unavailable(오프라인 대체 없음) */
  model: ChatAgentModel | null;
  now?: () => number;
  /**
   * 카드 도구(만들기·고치기·취소) 결과만 나온 차례면 모델을 다시 부르지 않고 엔진 고정 문장으로 턴을 닫는다.
   * 사장님 한 문장에 모델 호출이 2번 → 1번이 된다(지연·비용 절반). 카드가 사실이라 답 문장은 카드를 가리키기만 한다.
   */
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

/** 도구마다 결과 ref의 종류(조회 결과 r#, 카드 d#) */
const REF_KIND: Record<ChatAgentToolName, 'r' | 'd'> = { sales_summary: 'r', invoice_history: 'r', receivables: 'r', invoice_draft: 'd', draft_edit: 'd', draft_discard: 'd' };
const engineAnswer = (status: 'unknown_counterparty' | 'no_such_draft'): ToolOutput => ({ ref: null, status, fields: null, needs: null });
/**
 * 풀리지 않은 거래처 인자가 사장님 이번 문장의 낱말인가: 이번 문장에 있는 토큰이면 그 원값, 토큰 없는 말이면 문장에 글자 그대로 있을 때만.
 * 다른 레코드에 묶인 토큰(내 사업장 등)은 "장부에 없는 거래처"가 아니라 싣지 않는다.
 */
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
  /** 이 대화 세션에서 도구 결과로 나온 ref(r#·d#) */
  refs: Set<string>;
  token: RunToken | null;
  lastAt: number;
  turn: Turn | null;
}

interface Turn {
  user: RedactedText;
  message: RedactedText;
  /** 이번 턴 화면 프레임의 카드 ref */
  frameRefs: Set<string>;
  replay: RedactedReplayItem[];
  /** main이 실행 중인 도구 호출. answer가 있으면 엔진이 직접 답한 것이다. */
  pending: Array<{ callId: string; tool: ChatAgentToolName; key: string; call: DomainCall | null; args: Record<string, unknown>; answer: ToolOutput | null }> | null;
  /** 이번 턴에 끝난 도구 호출(도구 이름 + 인자) → 결과. 같은 호출을 또 하면 main에 보내지 않고 이 결과로 답한다. */
  done: Map<string, ToolOutput>;
  /** 이번 턴 도구 결과로 나온 ref(나온 순서) */
  made: string[];
  /** 이번 턴에 만든 카드: 거래처·금액 → 카드 ref. 같은 거래처·금액으로 또 만들면 그 카드를 고친다. */
  cards: Map<string, string>;
  /** 이번 턴에 풀리지 않은 거래처 이름(사장님 문장에 있던 것만). 첫 하나만 둔다. */
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

  async handle(method: string, p: Record<string, unknown>): Promise<StepResult> {
    if (method !== 'chat.step') throw new ChatError('bad_text');
    return this.step(p as unknown as StepParams);
  }

  async step(p: StepParams): Promise<StepResult> {
    const keys = p && typeof p === 'object' ? Object.keys(p) : [];
    if (keys.length !== 1) throw new ChatError('bad_text');
    if ('start' in p) return this.start(p.start);
    if ('continue' in p) return this.cont(p.continue);
    throw new ChatError('bad_text');
  }

  private async start(p: { text: string; frame: ScreenFrame; profileId: string }): Promise<StepResult> {
    const text = p?.text;
    if (typeof text !== 'string' || !text.trim() || [...text].length > INTENT_TEXT_MAX) throw new ChatError('bad_text');
    if (typeof p?.profileId !== 'string' || !p.profileId || p.profileId.length > 128) throw new ChatError('bad_text');
    if (!validFrame(p.frame)) throw new ChatError('chat.bad_tool_output');
    const cps = new CounterpartyRepo(this.db);
    const cards = p.frame.cards.map((c) => ({ ...c, cp: cps.get(c.counterpartyId) }));
    if (cards.some((c) => !c.cp) || new Set(cards.map((c) => c.ref)).size !== cards.length) throw new ChatError('chat.bad_tool_output');
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
      frameLine = cards.length
        ? `화면: ${cards.map((c) => `카드 ${c.ref}(세금계산서, 거래처 ${s.red.apply(c.cp!.name, { frame: 'none' }).redacted}, 금액 ${c.amount ? '있음' : '없음'}, 부가세 ${c.vat ? VAT_LABEL[c.vat] : '미정'}, 품목 ${c.item ? '있음' : '없음'})`).join('; ')}`
        : '화면: 열린 카드 없음';
      // 달 이름("9월 매출")을 month_offset으로 옮기려면 이번 달을 알아야 한다(chat-eval look-sept: 9월에 0을 넣음). 날짜는 식별자가 아니다.
      const kst = new Date(this.now() + 9 * 3600_000);
      frameLine = `오늘: ${kst.getUTCFullYear()}년 ${kst.getUTCMonth() + 1}월 ${kst.getUTCDate()}일\n${frameLine}`;
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
      const waiting = turn.pending!.filter((c) => !c.answer);
      const given = new Map(outputs.map((o) => [o.callId, o.output]));
      if (given.size !== outputs.length || given.size !== waiting.length || waiting.some((c) => !given.has(c.callId))) throw new ChatError('chat.bad_tool_output');
      for (const c of waiting) {
        const o = given.get(c.callId)!;
        if (o.ref !== null && o.ref[0] !== REF_KIND[c.tool]) throw new ChatError('chat.bad_tool_output');
        c.answer = o;
      }
      const round = turn.pending!.map((c) => ({ o: c.answer!, call: c.call, args: c.args }));
      this.answer(s, turn);
      const closed = this.opts.closeOnCards ? this.closeOnCards(s, turn, round) : null;
      return closed ? this.finish(s, closed) : this.advance(s);
    });
  }

  /** 턴 오류 처리: 답 없이 끝난 턴은 대화록에 agent null로 남긴다. 경로 실패·예산·한도는 다시 보낼 턴이라 남기지 않는다. */
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
      // 다음 호출이 툴셋 턴 상한·replay 상한을 넘으면 도구를 실행하지 않는다(결과를 모델에 돌려줄 수 없다).
      const turns = turn.replay.filter((x) => x.kind === 'model_output' && (x.item.item as { type?: string }).type !== 'reasoning').length;
      const key = (c: ToolCall) => `${c.name}:${JSON.stringify(c.arguments)}`;
      // 같은 턴에 같은 도구를 같은 인자로 또 부르면 모델이 결과를 답으로 옮기지 못하는 것이다(chat-eval 2026-11-16: 공급사에 따라
      // "이번 달 매출"에 sales_summary를 네 번 부름, 같은 카드를 두 장 만듦). 다시 실행하지 않고 엔진이 그 결과로 턴을 닫는다.
      const repeat = tc.find((c) => turn.done.has(key(c)));
      if (repeat) return this.finish(s, this.settle(turn, turn.done.get(key(repeat))!, false));
      if (turns >= CHAT_AGENT.maxTurns || turn.replay.length + tc.length > REPLAY_MAX) {
        const last = [...turn.done.values()].at(-1);
        if (last) return this.finish(s, this.settle(turn, last, true));
        throw new ChatError('chat.turn_limit');
      }
      const parsed = tc.map((c) => ({ c, p: this.parseCall(s, turn, c) }));
      turn.pending = parsed.map(({ c, p }) => ({ callId: c.callId, tool: c.name as ChatAgentToolName, key: key(c), call: 'status' in p ? null : p, args: c.arguments as Record<string, unknown>, answer: 'status' in p ? p : null }));
      const calls = parsed.flatMap(({ c, p }) => ('status' in p ? [] : [{ callId: c.callId, ...p }]));
      if (calls.length) return { kind: 'tools', calls };
      this.answer(s, turn);
    }
  }

  /**
   * 모델 답 없이 턴을 닫는다(같은 호출 되풀이·턴 상한). 마지막 도구 결과가 빈 칸을 말하면 그 칸을 고정 문장으로 되묻고,
   * 이번 턴에 낸 표·카드가 있으면 그것을 보인다. 둘 다 아니면 chat.turn_limit.
   * 조회 되풀이면 건수·합계를 슬롯 문장으로 말한다(값은 main이 채운다, chat-eval look-last-month: "표로 보여 드렸어요"만으로는 답이 아니다).
   * 턴 상한이면 마지막 결과가 이번 턴 전체를 말하지 않으므로(취소 뒤 새 카드가 열려 있을 수 있다) 일반 문장을 쓴다.
   */
  private settle(turn: Turn, last: ToolOutput, limit: boolean): AgentReply {
    const askOf = (o: ToolOutput): AgentAsk | null =>
      o.status === 'needs_input' && o.needs?.length ? o.needs[0]! : o.status === 'unknown_counterparty' ? 'counterparty' : o.status === 'no_such_draft' ? 'which_card' : null;
    // 마지막 결과가 아니어도, 이번 턴에 카드가 안 생겼고 앞에서 빈 칸이 나왔으면 그것을 묻는다
    // (chat-eval issue-ambiguous-cp: "한빛에 30만원" → unknown_counterparty 뒤 모델이 기록 조회만 되풀이)
    const outs = [...turn.done.values()];
    const carded = outs.some((o) => o.status === 'card_shown' || o.status === 'card_updated' || o.status === 'discarded');
    const ask = askOf(last) ?? (carded ? null : (outs.map(askOf).find((x) => x) ?? null));
    const show = [...new Set(turn.made)].slice(-AGENT_SHOW_MAX);
    if (ask) return { kind: 'ask', text: CHAT_AGENT_ASK_TEXT[ask], show, ask, filtered: 'repeat' };
    // 이번 턴에 카드를 만들었으면 조회 요약이 아니라 카드를 말한다(chat-eval issue-two: 두 장을 만들고 기록 조회를 되풀이 → 조회 요약 문장)
    if (!limit && outs.some((o) => o.status === 'card_shown')) return { kind: 'did', text: CHAT_AGENT_DONE_TEXT.card_shown!, show, ask: null, filtered: 'repeat' };
    if (!limit && last.status === 'ok' && last.ref?.startsWith('r') && show.includes(last.ref))
      return { kind: 'answer', text: /승인\s*번호/.test(turn.user) ? CHAT_AGENT_APPROVAL_TEXT(last.ref) : CHAT_AGENT_LOOKUP_TEXT(last.ref), show, ask: null, filtered: 'repeat' };
    if (show.length) return { kind: 'did', text: (limit ? null : CHAT_AGENT_DONE_TEXT[last.status]) ?? CHAT_AGENT_NUMBER_TEXT, show, ask: null, filtered: 'repeat' };
    // 빈 조회를 되풀이했으면 없다고 말한다(chat-eval look-empty: "한빛식품 발급 기록 있어?"에 invoice_history 두 번 → turn_limit)
    if (!limit && last.status === 'empty') return { kind: 'answer', text: CHAT_AGENT_DONE_TEXT.empty!, show, ask: null, filtered: 'repeat' };
    throw new ChatError('chat.turn_limit');
  }

  /**
   * 이번 차례 결과가 모두 카드 결과(card_shown·card_updated·discarded·needs_input)면 엔진이 닫는다. 빈 칸이 있으면 그 칸을 묻고,
   * 아니면 마지막 결과의 고정 문장으로 카드를 보인다(부가세는 묻지 않는다: 기본값 별도, 승인 카드에서 다시 본다).
   * 조회 결과가 섞이면 모델이 그 결과로 다음 걸음(같은 금액으로 만들기 등)을 할 수 있어 닫지 않는다.
   */
  private closeOnCards(s: Session, turn: Turn, round: Array<{ o: ToolOutput; call: DomainCall | null; args: Record<string, unknown> }>): AgentReply | null {
    if (!round.length || !round.every((r) => CARD_CLOSE.has(r.o.status))) return null;
    const show = [...new Set(turn.made)].filter((r) => r.startsWith('d')).slice(-AGENT_SHOW_MAX);
    const ask = round.flatMap((r) => (r.o.status === 'needs_input' ? (r.o.needs ?? []) : []))[0] ?? null;
    if (ask) return { kind: 'ask', text: CHAT_AGENT_ASK_TEXT[ask], show, ask, filtered: 'closed' };
    if (round.some((r) => r.o.status === 'needs_input')) return null;
    // 무엇을 했는지 말한다(chat-eval 2026-11-16: 고정 문장 하나면 거래처·금액·장 수·고친 칸이 빠진다). 값은 토큰·슬롯으로만 쓰고 화면이 채운다.
    const tok = (v: unknown, re: RegExp) => (typeof v === 'string' && re.test(v.trim()) && (s.red.map.has(v.trim()) || slotPattern.test(v.trim())) ? v.trim() : null);
    const nameOf = (a: Record<string, unknown>) => tok(a.counterparty, /^\[NAME_\d+\]$/);
    const amtOf = (a: Record<string, unknown>) => tok(a.amount, /^(?:\[AMT_\d+\]|\{r[1-9]\d{0,5}\.[a-z.]+\})$/);
    const vatWord = (v: unknown) => (v === 'included' ? '부가세 포함' : v === 'separate' ? '부가세 별도' : null);
    const line = (r: (typeof round)[number]): string | null => {
      const a = r.args;
      if (r.o.status === 'card_shown') {
        const who = nameOf(a);
        const amt = amtOf(a);
        // 부가세를 말하지 않았으면(null) 앱이 별도로 둔다: 문장 끝에 한 번 알린다(vatNote)
        const vat = vatWord(a.vat);
        return `${who ? `${who} 앞으로 ` : ''}${amt ? `${amt}${vat ? ', ' : ' '}` : ''}${vat ? `${vat}로 ` : ''}확인 카드를 만들었어요.`;
      }
      if (r.o.status === 'card_updated') {
        const parts = [amtOf(a) ? `금액 ${amtOf(a)}` : null, vatWord(a.vat), r.call?.tool === 'draft_edit' && r.call.item ? '품목' : null].filter((x) => x);
        return parts.length === 1 ? `카드를 ${parts[0] === '품목' ? '품목을 바꿔' : `${parts[0]}으로`} 고쳤어요.` : parts.length ? `카드의 ${parts.join(', ')}을 고쳤어요.` : null;
      }
      return null;
    };
    const lines = round.map(line);
    const vatNote = round.some((r) => r.o.status === 'card_shown' && !vatWord(r.args.vat)) ? ' 부가세는 별도로 두었어요. 포함이면 말씀해 주세요.' : '';
    const cards = round.filter((r) => r.o.status === 'card_shown').length;
    const tail = round.at(-1)!.o.status === 'card_shown' ? ' 내용을 확인하시고 [홈택스에서 준비]를 눌러 주세요.' : round.at(-1)!.o.status === 'card_updated' ? ' 카드에서 바뀐 값을 확인해 주세요.' : '';
    const text =
      round.every((r) => r.o.status === 'discarded') ? CHAT_AGENT_DONE_TEXT.discarded!
      : lines.every((l) => l) && lines.length <= 2 ? `${lines.join(' ')}${vatNote || tail}`
      : cards > 1 ? `확인 카드 ${cards}장을 만들었어요.${vatNote || tail}`
      : (CHAT_AGENT_DONE_TEXT[round.at(-1)!.o.status] ?? CHAT_AGENT_NUMBER_TEXT);
    return { kind: 'did', text, show, ask: null, filtered: 'closed' };
  }

  /** 모든 도구 호출에 답이 있으면 function_call_output을 replay에 붙인다. 결과 ref는 이 세션의 ref로 기억한다. */
  private answer(s: Session, turn: Turn): void {
    for (const c of turn.pending!) {
      const o = c.answer!;
      if (o.ref) {
        s.refs.add(o.ref);
        turn.made.push(o.ref);
      }
      // 같은 인자로 다시 부르면 같은 결과다. 고치기·취소는 두 번째가 다른 뜻일 수 있어(이미 취소한 카드) 첫 결과를 그대로 준다.
      turn.done.set(c.key, o);
      if (o.status === 'card_shown' && o.ref && c.call?.tool === 'invoice_draft') turn.cards.set(cardKey(c.call), o.ref);
      turn.replay.push({ kind: 'function_call_output', callId: c.callId, output: s.red.apply(JSON.stringify(o), { frame: 'none' }).redacted });
    }
    turn.pending = null;
  }

  /** 도구 인자 역치환. 거래처가 레코드 하나로 풀리지 않거나 모르는 카드면 main에 가지 않고 엔진이 결과를 답한다. */
  private parseCall(s: Session, turn: Turn, c: ToolCall): Parsed {
    const a = c.arguments as Record<string, unknown>;
    const cp = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      // 거래처 토큰은 이번 턴에 모델이 본 글(앞 대화·화면·이번 문장)에 있는 것만 쓴다. 장부의 다른 거래처 토큰을 지어 넣으면
      // 엉뚱한 거래처 카드가 생긴다(chat-eval: "바다물산에 100만원"·"50만원짜리 하나"에 장부 첫 거래처 토큰을 넣음).
      if (/^\[NAME_\d+\]$/.test(v.trim()) && !turn.message.includes(v.trim())) return null;
      if (gluedName(turn.user, v.trim(), /\s/.test(s.red.map.valueOf(v.trim()) ?? ''))) return null;
      const r = detokenize({ counterparty: v.trim() }, s.red.map, { recordFields: ['counterparty'] });
      const id = r.ok ? (r.value as { counterparty: { recordId: string } }).counterparty.recordId : '';
      return id.startsWith('cp:') ? id.slice(3) : null;
    };
    // 거래처가 풀리지 않으면 엔진이 답한다. 그 인자가 사장님 이번 문장의 낱말이면 화면용 이름으로 남긴다(U8-1).
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
      // 사장님이 쓴 금액이 원 단위 양수로 읽히지 않으면("0원") 금액이 빈 것으로 넘긴다: main이 needs_input(amount)로 답해 모델이 다시 묻는다.
      // 오류로 끊으면 사장님에게는 "지금 답을 받지 못했어요"만 보인다(chat-eval issue-zero).
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
      invoice_draft: () => {
        const id = cp(a.counterparty);
        return id ? { tool: 'invoice_draft', counterpartyId: id, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item) } : unknown(a.counterparty);
      },
      draft_edit: () => {
        const d = draft(a.draft);
        return d ? { tool: 'draft_edit', draft: d, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item) } : engineAnswer('no_such_draft');
      },
      draft_discard: () => {
        const d = draft(a.draft);
        return d ? { tool: 'draft_discard', draft: d } : engineAnswer('no_such_draft');
      },
    };
    if (!Object.hasOwn(parse, tool)) throw new ChatError('chat.bad_response');
    const p = parse[tool]();
    // 이번 턴에 같은 거래처·금액으로 만든 카드가 있으면 새 카드를 또 만들지 않고 그 카드를 고친다
    // (chat-eval issue-korean-amount: 부가세만 바꿔 카드를 다시 만들고 앞 카드를 취소하다 턴 상한에 걸림)
    const same = !('status' in p) && p.tool === 'invoice_draft' ? turn.cards.get(cardKey(p)) : undefined;
    if (same && !('status' in p) && p.tool === 'invoice_draft') return { tool: 'draft_edit', draft: same, amount: p.amount, vat: p.vat, item: p.item };
    return p;
  }

  /**
   * 답 검사(@sax/chat-core checkAgentReply, 폰과 같은 규칙). 채우기 전 문장에 돈다: 토큰·슬롯은 허용하되 맵에 있는 토큰, 이 세션 결과를 가리키는 슬롯만.
   * 세무 판단은 고정 문구, 식별자·이메일·링크·비밀 유도 말은 고정 안내, 모양이 틀리면 chat.bad_response.
   */
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
        // 카드 ref에 슬롯을 붙인 것("{d2.first.supply}")은 지어낸 값이 아니라 카드 금액을 가리킨 것이다. 이번 턴 결과의 고정 문장으로 말하고
        // 되묻기는 살린다. 카드를 만든 턴의 부가세는 화면이 묻지 않는다(기본값 별도, 카드에서 다시 본다). (chat-eval multi-lookup-then-issue)
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

  /** 턴을 닫는다: 채우기 전 문장을 대화록에 넣고, 이 답에 나온 토큰의 화면 값을 같이 돌려준다. */
  private finish(s: Session, r: AgentReply): StepResult {
    const unknownName = r.filtered ? null : (s.turn!.unknownName ?? null);
    this.record(s, { user: s.turn!.user, agent: { text: r.text, show: r.show } });
    s.turn = null;
    // 엔진이 닫은 문장(closed)도 이번 턴 토큰을 쓰므로 화면 값을 같이 준다
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

  /** 이번 턴 user 메시지 하나: 대화록(오래된 턴부터 버려 상한 안으로) + 화면 프레임 + 이번 문장. 같은 세션 Redactor로 다시 마스킹해 발급한다. */
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

  /** 대화 세션: 프로필이 바뀌거나 CHAT_MAP_IDLE_MS 쉬면 토큰 맵과 대화록을 같이 버리고 새 세션(새 chatSessionId·실행 토큰)을 연다. */
  private session(profileId: string): Session {
    const t = this.now();
    let s = this.current;
    if (s && (s.profileId !== profileId || t - s.lastAt > CHAT_MAP_IDLE_MS)) {
      this.maps.end(s.id);
      s = null;
    }
    if (!s) {
      const id = `chat_${randomUUID()}`;
      s = { id, profileId, red: this.maps.get(id, profileId), transcript: [], refs: new Set(), token: null, lastAt: t, turn: null };
      this.current = s;
    }
    s.lastAt = t;
    this.maps.get(s.id, profileId);
    return s;
  }

  /** 가림 사전: 장부(거래처·내 프로필)를 레코드 목록으로 넘긴다. 규칙은 @sax/chat-core(registerChatRecords)에 있고 폰과 같다. */
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
  return { respond: (req) => responder.respond(CHAT_AGENT, req), runToken: (chatSessionId) => gatewayRunToken(egress, { chatSessionId }) };
}
