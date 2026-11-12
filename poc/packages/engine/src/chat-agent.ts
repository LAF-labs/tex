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
  AGENT_SHOW_MAX,
  CHAT_AGENT,
  CHAT_REPLY_MAX_CHARS,
  OpenAIResponsesAdapter,
  SLOT_FIELDS,
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
import { CHAT_MAP_IDLE_MS, ChatTokenMaps, TOKEN_RE, detokenize, normalizeForRedaction, type Redactor } from '@sax/redaction';
import { CHAT_ADVICE_TEXT, ChatError, chatAdviceMentioned, chatSecretShaped, errorOf, unsafeText, type ChatErrorCode } from './chat.ts';
import { INTENT_TEXT_MAX } from './intent.ts';

/** 한 사용자 턴의 마스킹 입력 상한(바이트). 대화록이 붙어 chat_reply(2048)보다 크다. 넘으면 오래된 턴부터 버린다. */
export const CHAT_AGENT_INPUT_MAX_BYTES = 8192;
/** 대화록에 붙이는 최근 턴 수 */
export const CHAT_AGENT_TRANSCRIPT_TURNS = 12;
/** 답 문장을 쓸 수 없을 때(식별자·링크·비밀 유도 말, 모델 거절)의 고정 안내 */
export const CHAT_AGENT_FALLBACK_TEXT = '세금계산서 카드 만들기와 발급 기록·매출·받을 돈 확인을 도와드려요. 어떤 일을 할까요?';
/** 다시 보낼 턴이라 대화록에 남기지 않는 오류 */
const RETRY_CODES: readonly ChatErrorCode[] = ['chat.unavailable', 'chat.budget_exceeded', 'chat.quota_exceeded'];
/** 게이트웨이 respond 스키마의 replay maxItems */
const REPLAY_MAX = 12;

export const TOOL_STATUSES = ['ok', 'empty', 'unknown_counterparty', 'not_set_up', 'card_shown', 'needs_input', 'setup_missing', 'card_updated', 'no_such_draft', 'not_editable', 'discarded'] as const;
export type ToolStatus = (typeof TOOL_STATUSES)[number];
export const TOOL_NEEDS = ['amount', 'item', 'counterparty'] as const;
export type ToolNeed = (typeof TOOL_NEEDS)[number];

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

/** 화면에 보일 답. text는 거래처 토큰을 지금 장부 이름으로, 다른 토큰을 원값으로 바꾼 것이고 슬롯은 main이 채운다. */
export interface AgentReply {
  kind: AgentReplyKind;
  text: string;
  show: string[];
  ask: AgentAsk | null;
  filtered: null | 'advice' | 'unsafe' | 'refusal';
}

export type StepResult = { kind: 'tools'; calls: Array<{ callId: string } & DomainCall> } | { kind: 'reply'; reply: AgentReply };

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
const KINDS: ReadonlySet<string> = new Set(AGENT_REPLY_KINDS);
const ASKS: ReadonlySet<string> = new Set(AGENT_ASKS);
const SLOT_ANY = new RegExp(slotPattern.source.slice(1, -1), 'g');
const VAT_LABEL = { separate: '별도', included: '포함' } as const;

const KO_NUM: Record<string, string> = { 영: '0', 공: '0', 일: '1', 이: '2', 삼: '3', 사: '4', 오: '5', 육: '6', 륙: '6', 칠: '7', 팔: '8', 구: '9' };
const SMALL: Record<string, number> = { 십: 10, 백: 100, 천: 1000 };
const BIG: Record<string, number> = { 만: 1e4, 억: 1e8 };

/**
 * 금액 토큰의 원값("110만원", "1,100,000원", "3백만", "1억 2천", "삼백삼십만원")을 원 단위 정수로 읽는다. 읽을 수 없으면 null.
 * 억 뒤에 만 없이 남은 수는 만 단위로 읽는다("1억 2천" = 1억 2천만, 말로 쓰는 금액).
 */
export function parseKrw(raw: string): number | null {
  const s = normalizeForRedaction(raw)
    .replace(/[\s,원]/g, '')
    .replace(/[영공일이삼사오육륙칠팔구]/g, (c) => KO_NUM[c]!);
  if (!s) return null;
  let total = 0;
  let section = 0;
  let num: number | null = null;
  let lastBig = Infinity;
  let used = 0;
  for (const m of s.matchAll(/\d+(?:\.\d+)?|[십백천]|[만억]/g)) {
    const x = m[0];
    used += x.length;
    if (/\d/.test(x[0]!)) {
      if (num !== null) return null;
      num = Number(x);
    } else if (x in SMALL) {
      section += (num ?? 1) * SMALL[x]!;
      num = null;
    } else {
      const big = BIG[x]!;
      if (big >= lastBig) return null;
      total += (section + (num ?? 0) || 1) * big;
      section = 0;
      num = null;
      lastBig = big;
    }
  }
  if (used !== s.length) return null;
  let tail = section + (num ?? 0);
  if (lastBig === BIG['억'] && tail) tail *= BIG['만']!;
  total += tail;
  const n = Math.round(total);
  if (!(n > 0) || n > Number.MAX_SAFE_INTEGER || Math.abs(n - total) > 1e-6 * total) return null;
  return n;
}

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
  pending: Array<{ callId: string; tool: ChatAgentToolName; answer: ToolOutput | null }> | null;
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
      this.register(s.red, text);
      user = s.red.apply(text, { frame: 'none' }).redacted;
      frameLine = cards.length
        ? `화면: ${cards.map((c) => `카드 ${c.ref}(세금계산서, 거래처 ${s.red.apply(c.cp!.name, { frame: 'none' }).redacted}, 금액 ${c.amount ? '있음' : '없음'}, 부가세 ${c.vat ? VAT_LABEL[c.vat] : '미정'}, 품목 ${c.item ? '있음' : '없음'})`).join('; ')}`
        : '화면: 열린 카드 없음';
    } catch {
      throw new ChatError('chat.unavailable');
    }
    s.turn = { user, message: this.compose(s, user, frameLine), frameRefs: new Set(cards.map((c) => c.ref)), replay: [], pending: null };
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
      this.answer(s, turn);
      return this.advance(s);
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
      // 다음 호출이 툴셋 턴 상한·replay 상한을 넘으면 도구를 실행하지 않는다(결과를 모델에 돌려줄 수 없다).
      const turns = turn.replay.filter((x) => x.kind === 'model_output' && (x.item.item as { type?: string }).type !== 'reasoning').length;
      if (turns >= CHAT_AGENT.maxTurns || turn.replay.length + r.toolCalls.length > REPLAY_MAX) throw new ChatError('chat.turn_limit');
      const parsed = r.toolCalls.map((c) => ({ c, p: this.parseCall(s, turn, c) }));
      turn.pending = parsed.map(({ c, p }) => ({ callId: c.callId, tool: c.name as ChatAgentToolName, answer: 'status' in p ? p : null }));
      const calls = parsed.flatMap(({ c, p }) => ('status' in p ? [] : [{ callId: c.callId, ...p }]));
      if (calls.length) return { kind: 'tools', calls };
      this.answer(s, turn);
    }
  }

  /** 모든 도구 호출에 답이 있으면 function_call_output을 replay에 붙인다. 결과 ref는 이 세션의 ref로 기억한다. */
  private answer(s: Session, turn: Turn): void {
    for (const c of turn.pending!) {
      const o = c.answer!;
      if (o.ref) s.refs.add(o.ref);
      turn.replay.push({ kind: 'function_call_output', callId: c.callId, output: s.red.apply(JSON.stringify(o), { frame: 'none' }).redacted });
    }
    turn.pending = null;
  }

  /** 도구 인자 역치환. 거래처가 레코드 하나로 풀리지 않거나 모르는 카드면 main에 가지 않고 엔진이 결과를 답한다. */
  private parseCall(s: Session, turn: Turn, c: ToolCall): Parsed {
    const a = c.arguments as Record<string, unknown>;
    const cp = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      const r = detokenize({ counterparty: v.trim() }, s.red.map, { recordFields: ['counterparty'] });
      const id = r.ok ? (r.value as { counterparty: { recordId: string } }).counterparty.recordId : '';
      return id.startsWith('cp:') ? id.slice(3) : null;
    };
    const draft = (v: unknown): string | null => (typeof v === 'string' && /^d[1-9]\d{0,5}$/.test(v) && (turn.frameRefs.has(v) || s.refs.has(v)) ? v : null);
    const amount = (v: unknown): DraftAmount => {
      if (v === null) return null;
      const t = String(v).trim();
      const slot = slotPattern.exec(t);
      if (slot) {
        if (!s.refs.has(slot[1]!)) throw new ChatError('chat.bad_response');
        return { slot: t };
      }
      const n = /^\[AMT_\d+\]$/.test(t) ? parseKrw(s.red.map.valueOf(t) ?? '') : null;
      if (n === null) throw new ChatError('chat.bad_response');
      return { value: n };
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
        return a.counterparty !== null && !id ? engineAnswer('unknown_counterparty') : { tool: 'invoice_history', counterpartyId: id };
      },
      receivables: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? engineAnswer('unknown_counterparty') : { tool: 'receivables', counterpartyId: id };
      },
      invoice_draft: () => {
        const id = cp(a.counterparty);
        return id ? { tool: 'invoice_draft', counterpartyId: id, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item) } : engineAnswer('unknown_counterparty');
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
    return parse[tool]();
  }

  /**
   * 답 검사(chat.ts checkOutput을 옮김). 채우기 전 문장에 돈다: 토큰·슬롯은 허용하되 맵에 있는 토큰, 이 세션 결과를 가리키는 슬롯만.
   * 세무 판단은 고정 문구, 식별자·이메일·링크·비밀 유도 말은 고정 안내, 모양이 틀리면 chat.bad_response.
   */
  private checkReply(s: Session, turn: Turn, out: unknown): AgentReply {
    const bad = () => new ChatError('chat.bad_response');
    const o = out as Record<string, unknown> | null | undefined;
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad();
    if (Object.keys(o).sort().join(',') !== 'ask,kind,show,text') throw bad();
    const { kind, show, ask } = o;
    if (typeof kind !== 'string' || !KINDS.has(kind) || typeof o.text !== 'string' || !Array.isArray(show) || show.length > AGENT_SHOW_MAX) throw bad();
    if (!show.every((r) => typeof r === 'string') || !(ask === null || (typeof ask === 'string' && ASKS.has(ask)))) throw bad();
    const k = kind as AgentReplyKind;
    const a = ask as AgentAsk | null;
    if (k === 'tax_advice') return { kind: k, text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' };
    const text = o.text.replace(/\s+/g, ' ').trim();
    if (!text || [...text].length > CHAT_REPLY_MAX_CHARS) throw bad();
    for (const m of text.matchAll(TOKEN_RE)) if (!s.red.map.has(m[0])) throw bad();
    for (const m of text.matchAll(SLOT_ANY)) if (!s.refs.has(m[1]!)) throw bad();
    if (/[{}]/.test(text.replace(SLOT_ANY, ''))) throw bad();
    const refs = [...new Set(show as string[])];
    if (!refs.every((r) => new RegExp(REF).test(r) && (s.refs.has(r) || turn.frameRefs.has(r)))) throw bad();
    if (chatAdviceMentioned(text)) return { kind: k, text: CHAT_ADVICE_TEXT, show: [], ask: null, filtered: 'advice' };
    if (unsafeText(text.replace(TOKEN_RE, ' ').replace(SLOT_ANY, ' '))) return { kind: k, text: CHAT_AGENT_FALLBACK_TEXT, show: [], ask: null, filtered: 'unsafe' };
    return { kind: k, text, show: refs, ask: a, filtered: null };
  }

  /** 턴을 닫는다: 채우기 전 문장을 대화록에 넣고, 화면용 문장은 토큰을 이름·값으로 바꿔 돌려준다. */
  private finish(s: Session, r: AgentReply): StepResult {
    this.record(s, { user: s.turn!.user, agent: { text: r.text, show: r.show } });
    s.turn = null;
    return { kind: 'reply', reply: { ...r, text: r.filtered ? r.text : this.display(s, r.text) } };
  }

  private display(s: Session, text: string): string {
    const cps = new CounterpartyRepo(this.db);
    return text.replace(TOKEN_RE, (tok) => {
      const rec = s.red.map.recordOf(tok);
      const name = tok.startsWith('[NAME_') && rec?.startsWith('cp:') ? cps.get(rec.slice(3))?.name : undefined;
      return name ?? s.red.map.valueOf(tok)!;
    });
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

  /**
   * 마스킹 사전(intent.ts addNames와 같은 범위): 거래처 상호·대표자·이메일·사업자번호, 내 프로필 상호·대표자·사업자번호.
   * 두 레코드가 같은 값을 쓰면 그 값은 가리기만 하고 레코드에 묶지 않는다(역치환이 엉뚱한 거래처로 가지 않게).
   * 오타 거래처는 typoAliases로 그 거래처 별칭을 더한다.
   */
  private register(red: Redactor, text: string): void {
    const recs = [
      ...new CounterpartyRepo(this.db).list().map((c) => ({ recordId: `cp:${c.id}`, names: [c.name, ...(c.repName ? [c.repName] : [])], emails: c.email ? [c.email] : [], bizNos: [c.bizNo] })),
      ...new ProfileRepo(this.db).list().map((p) => ({ recordId: `pf:${p.id}`, names: [p.displayName, ...(p.repName ? [p.repName] : [])], emails: [] as string[], bizNos: p.bizNo ? [p.bizNo] : [] })),
    ];
    const key = (k: string, v: string) => `${k}\u0000${k === 'b' ? v.replace(/\D/g, '') : normalizeForRedaction(v).replace(/\s+/g, ' ').trim().toLowerCase()}`;
    const owners = new Map<string, Set<string>>();
    for (const r of recs) for (const [k, vs] of [['n', r.names], ['e', r.emails], ['b', r.bizNos]] as const) for (const v of vs) (owners.get(key(k, v)) ?? owners.set(key(k, v), new Set()).get(key(k, v))!).add(r.recordId);
    const sole = (k: string, v: string) => owners.get(key(k, v))!.size === 1;
    for (const r of recs) {
      for (const n of r.names) if (!sole('n', n)) red.addName(n);
      red.addRecord({ recordId: r.recordId, names: r.names.filter((n) => sole('n', n)), emails: r.emails.filter((e) => sole('e', e)), bizNos: r.bizNos.filter((b) => sole('b', b)) });
    }
    const known = new Set(recs.flatMap((r) => r.names.map((n) => normalizeForRedaction(n).replace(/\s+/g, ' ').trim())));
    for (const a of typoAliases(text, recs.filter((r) => r.recordId.startsWith('cp:')).map((r) => ({ recordId: r.recordId, name: r.names[0]! })), known)) {
      try {
        red.addRecord({ recordId: a.recordId, names: [a.alias] });
      } catch {
        // 앞 턴에서 다른 거래처 별칭으로 묶인 낱말이면 그대로 둔다
      }
    }
  }
}

/**
 * 오타 거래처 별칭: 문장 속 낱말 중 거래처 상호(3자 이상)와 길이가 같고 한 글자만 다르며, 이미 있는 이름이 아니고,
 * 그렇게 가까운 거래처가 정확히 하나인 것. 둘 이상에 가까우면(A상사·B상사 사이의 C상사) 고르지 않는다.
 */
export function typoAliases(text: string, cps: Array<{ recordId: string; name: string }>, known: ReadonlySet<string>): Array<{ recordId: string; alias: string }> {
  const t = [...normalizeForRedaction(text)];
  const hits = new Map<string, Set<string>>();
  for (const c of cps) {
    const n = [...normalizeForRedaction(c.name).trim()];
    if (n.length < 3) continue;
    for (let i = 0; i + n.length <= t.length; i++) {
      const w = t.slice(i, i + n.length);
      if (!w.every((ch) => /[\p{L}\p{N}]/u.test(ch))) continue;
      const word = w.join('');
      if (known.has(word) || w.filter((ch, k) => ch !== n[k]).length !== 1) continue;
      (hits.get(word) ?? hits.set(word, new Set()).get(word)!).add(c.recordId);
    }
  }
  return [...hits].filter(([, ids]) => ids.size === 1).map(([alias, ids]) => ({ recordId: [...ids][0]!, alias }));
}

/** 엔진 기본 경로(게이트웨이)로 ChatAgentModel을 만든다. Egress에 게이트웨이 설정이 없으면 null(chat.step은 chat.unavailable). */
export function gatewayChatAgentModel(egress: Egress): ChatAgentModel | null {
  if (!egress.gatewayGuard) return null;
  const responder = new OpenAIResponsesAdapter({ transport: 'gateway', egress });
  return { respond: (req) => responder.respond(CHAT_AGENT, req), runToken: (chatSessionId) => gatewayRunToken(egress, { chatSessionId }) };
}
