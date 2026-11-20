import { CHAT_MAP_IDLE_MS, Redactor, TOKEN_RE, detokenize, type RedactedText } from '@sax/redaction';
import { capture, rebind, type ChatMessage, type MaskedText } from './chat-log.ts';
import { cleanItem, fillWithJosa, finalOf, fixJosa, koDate, kstDate, validAmount, won } from './fill.ts';
import { newestFirst, salesOf, sumOf, supplyOf, tally } from './ledger.ts';
import { PhoneChatError, type PhoneChatErrorCode, type PhoneModel, type PhoneRespondResult, type PhoneToolCall, type ReplayItem } from './phone-gateway.ts';
import { ReplyShapeError, braceTokens, chatSecretShaped, checkAgentReply, unsafeText, type CheckedReply, type ReplyFilter } from './reply-check.ts';
import { chatInput, gluedName, issueIntent, parseKrw, registerChatRecords, type ChatRecord, type IssueIntent } from './rules.ts';
import {
  AGENT_ASKS,
  AGENT_SHOW_MAX,
  CHAT_DIGEST_MAX_CHARS,
  CHAT_PHONE_MAX_TURNS,
  PHONE_REPLY_KINDS,
  SLOT_FIELDS,
  SLOT_MONEY_PATHS,
  slotAnywhere,
  slotPattern,
  type AgentAsk,
  type ChatPhoneToolName,
  type PhoneCopyState,
  type PhoneReplyKind,
  type PhoneScreen,
  type PhoneToolStatus,
  type SlotField,
  type ToolNeed,
  type Vat,
} from './tables.ts';
import { estimateTokens } from './tokens.ts';
import { ACK_REPLY_HINT, REACTIONS, TurnRecorder, capStreak, isReaction, reactedLine, routeAck, type ReactionId, type RouteAck, type TurnEvent } from './turn.ts';

/** 한 번 부를 때의 입력 상한(추정 토큰, 머리말·도구 정의 포함). 하루 한도(체험 50원·구독 300원) 안에서 대화 횟수를 지키는 값이다. */
export const PHONE_CONTEXT_MAX_TOKENS = 8000;
/** chat_phone 머리말 + 도구 정의 + 출력 스키마의 추정 토큰(넉넉하게). 시험이 실제 머리말의 추정값이 이보다 작은지 본다. */
export const PHONE_PREFIX_EST_TOKENS = 5400;
/** [앞 대화]에 두는 사용자 턴 수 상한. 넘으면 오래된 절반을 한꺼번에 요약으로 접는다. */
export const PHONE_TURNS_MAX = 20;
/** [사실]에 미리 조회해 넣는 거래처 수 상한 */
export const PHONE_FACT_COUNTERPARTIES_MAX = 5;
/** 사용자 문장 글자 상한(PC intent와 같다) */
export const PHONE_TEXT_MAX = 2000;
/** 판정 입력 상한(바이트, chat_route_v1 maxInputBytes와 같다). 넘으면 판정 없이 돈다. */
export const PHONE_ROUTE_MAX_BYTES = 4096;
const REPLAY_MAX = 12;
/** 대화 세션 하나(실행 토큰 하나)로 여는 사용자 턴 수. 게이트웨이 대화 예산(l2PerChat 20)에 닿기 전에 새 세션을 연다. */
export const PHONE_SESSION_TURNS = 16;
/** 사본이 이보다 오래되면 stale */
export const PHONE_COPY_FRESH_MS = 24 * 3600_000;
const FRAME_MAX = 12;
const CHIP_CP_MAX = 8;
const RESULTS_MAX = 40;
const PHONE_LOG_MAX = 600;
const NAME_MAX = 40;

export const PHONE_FALLBACK_TEXT = '네, 말씀해 주세요. 필요한 일을 편하게 말씀해 주시면 바로 해 드릴게요.';
export const PHONE_NUMBER_TEXT = '결과를 아래에 보여 드렸어요. 금액과 날짜는 표와 카드에 있어요.';
/**
 * 폰이 직접 되묻는 고정 문장(되묻기 칸별). 모델이 되묻는 문장에 숫자를 섞었거나 틀린 슬롯을 썼을 때 쓴다(PC의 CHAT_AGENT_ASK_TEXT와 같은 쓰임).
 * 화면은 이 문장 아래 그 칸의 선택지를 붙인다.
 */
export const PHONE_ASK_TEXT: Record<AgentAsk, string> = {
  amount: '금액을 알려 주세요. 부가세 포함이면 같이 말씀해 주세요.',
  item: '품목을 알려 주세요. 디자인 용역처럼 적어 주시면 돼요.',
  counterparty: '어느 거래처예요? 거래처 목록에 있는 이름으로 골라 주세요.',
  vat: '부가세는 별도예요, 포함이에요?',
  which_card: '어느 카드를 말씀하시는지 골라 주세요.',
  date: '작성일자를 정하는 카드는 폰에서 만들 수 없어요. PC를 켜면 이어서 할게요.',
};
export const PHONE_SLOT_MISSING_TEXT = '정확한 값은 아래 표에 있어요.';
export const PHONE_UNAVAILABLE_TEXT = '답을 받지 못했어요. 잠시 뒤 [다시 시도]를 눌러 주세요.';
export const PHONE_ENTRUST_TEXT = (name: string): string => `${name} 세금계산서를 맡겼어요. PC가 켜지면 시작하고, 발급 전에 한 번 더 확인을 받아요.`;

/** 오류 코드 → 대화 문장과 [다시 시도]. 화면이 다른 문구를 쓰려면 code로 바꾼다. */
export const PHONE_ERROR_TEXT: Record<PhoneChatErrorCode, { text: string; retry: boolean }> = {
  'chat.unavailable': { text: PHONE_UNAVAILABLE_TEXT, retry: true },
  'chat.bad_response': { text: PHONE_UNAVAILABLE_TEXT, retry: true },
  'chat.budget_exceeded': { text: '대화가 길어졌어요. 잠시 뒤에 다시 말해 주세요.', retry: true },
  'chat.quota_exceeded': { text: '이번 달 대화를 다 썼어요.', retry: false },
  'chat.daily_limit': { text: '오늘 쓸 수 있는 대화를 다 썼어요. 새벽 4시에 다시 채워져요.', retry: false },
  'chat.subscription_required': { text: '무료 체험이 끝났어요. 구독하면 대화를 다시 쓸 수 있어요.', retry: false },
  'chat.rate_limited': { text: '요청이 잠깐 몰렸어요. 조금 뒤에 다시 보내 주세요.', retry: true },
  'chat.device_suspended': { text: '이 폰의 연결이 정지되어 있어요. 설정의 연결된 기기에서 확인해 주세요.', retry: false },
  'chat.input_too_large': { text: '문장이 길어요. 두세 번에 나눠서 말해 주세요.', retry: false },
  'chat.secret_rejected': { text: '비밀번호 같은 값은 대화창에 쓰지 말아 주세요. 이 문장은 보내지 않았어요.', retry: false },
  'chat.turn_limit': { text: '한 번에 하기엔 일이 많아요. 하나씩 나눠서 말씀해 주세요.', retry: false },
  bad_text: { text: '문장이 길어요. 두세 번에 나눠서 말해 주세요.', retry: false },
};

export interface CopyCounterparty {
  id: string;
  name: string;
  repName?: string | null;
  email?: string | null;
  bizNo?: string | null;
  item?: string | null;
}

/** 발급·받을 돈 한 줄. total은 세금 포함 합계다(데스크톱 IssuedRow와 같다). */
export interface CopyRow {
  counterpartyId: string | null;
  counterparty: string;
  date: string;
  total: number | null;
  approvalNo?: string | null;
}

export interface PhoneCopy {
  asOf: number;
  profile: { id: string; name: string; repName?: string | null; bizNo?: string | null } | null;
  counterparties: CopyCounterparty[];
  issued: CopyRow[] | null;
  receivables: CopyRow[] | null;
  sales?: CopyRow[] | null;
}

export interface PhoneDraft {
  id: string;
  ref: string;
  counterpartyId: string;
  amount: number;
  vat: Vat | null;
  item: string | null;
  state: 'open' | 'entrusted' | 'discarded';
  at: number;
}

export interface PhoneChatPorts {
  model: PhoneModel;
  store: { load(): Promise<string | null>; save(data: string): Promise<void> };
  copy(): PhoneCopy | null;
  now(): number;
  newId(): string;
  randomHex(): string;
  pcOnline?(): boolean;
  onReaction?(reaction: ReactionId): void;
  onEvent?(e: TurnEvent): void;
}

export interface PhoneTableRow {
  date: string;
  counterparty: string;
  total: number | null;
  approvalNo: string | null;
}
export type PhoneShow = { type: 'card'; draft: PhoneDraft; counterparty: string } | { type: 'screen'; screen: PhoneScreen } | { type: 'table'; table: 'sales' | 'history' | 'receivables'; title: string; rows: PhoneTableRow[]; copy: PhoneCopyState };

export type PhoneTurnResult =
  | {
      kind: 'reply';
      id: string;
      text: string;
      show: PhoneShow[];
      ask: null | { kind: AgentAsk; chips: Array<{ label: string; text: string }> };
      reply: PhoneReplyKind;
      filtered: ReplyFilter;
      unknown?: { name: string; text: string };
      user: { id: string; reaction: ReactionId | null };
    }
  | { kind: 'reaction'; id: string; reaction: ReactionId }
  | { kind: 'unavailable'; code: PhoneChatErrorCode; text: string; retry: boolean };

interface State {
  v: 1;
  seq: number;
  phone: ChatMessage[];
  fold: { summary: MaskedText | null; upto: string } | null;
  drafts: PhoneDraft[];
}

interface Result {
  kind: 'sales' | 'history' | 'receivables';
  title: string;
  rows: CopyRow[];
  copy: PhoneCopyState;
}

interface Session {
  id: string;
  red: Redactor;
  token: string | null;
  lastAt: number;
  turns: number;
  facts: Map<string, string>;
}

interface ToolOutput {
  ref: string | null;
  status: PhoneToolStatus;
  fields: SlotField[] | null;
  needs: ToolNeed[] | null;
}

type DraftAmount = { value: number } | { slot: string } | null;
type DomainCall =
  | { tool: 'sales_summary'; monthOffset: number }
  | { tool: 'invoice_history' | 'receivables'; counterpartyId: string | null }
  | { tool: 'invoice_draft'; counterpartyId: string; amount: DraftAmount; vat: Vat | null; item: string | null }
  | { tool: 'draft_edit'; draft: string; amount: DraftAmount; vat: Vat | null; item: string | null }
  | { tool: 'draft_discard'; draft: string }
  | { tool: 'open_screen'; screen: PhoneScreen };

interface Turn {
  user: RedactedText;
  replay: ReplayItem[];
  done: Map<string, ToolOutput>;
  made: string[];
  created: string[];
  frameRefs: Set<string>;
  unknownName?: string;
  intent: IssueIntent;
  screens: PhoneScreen[];
  retry?: boolean;
  reaction: ReactionId | null;
  ackReply: boolean;
  replied: ChatMessage | null;
}

const KINDS: ReadonlySet<PhoneReplyKind> = new Set(PHONE_REPLY_KINDS);

/** PC가 켜져 있을 때 맡긴 한 줄: PC가 바로 홈택스에서 준비하고, 발급은 PC 승인으로만 된다. */
export const PHONE_ENTRUST_ONLINE_TEXT = (name: string): string => `${name} 세금계산서를 PC에 맡겼어요. PC가 홈택스에서 준비하고, 발급 전에 한 번 더 확인을 받아요.`;

const INTENT_MISSED: ReadonlySet<PhoneReplyKind> = new Set(['smalltalk', 'answer', 'cannot']);

/**
 * 발급 의도 안전망: "[AMT_1] 끊어줘"처럼 발급을 시켰는데 모델이 도구를 하나도 부르지 않고 잡담·일반 답·못 함으로 넘겼는지.
 * 맞으면 턴이 모델을 한 번 더 부른다(고정 문장으로 바꾸지 않는다). 두 번째 답은 그대로 쓴다.
 */
export function intentMissed(turn: Pick<Turn, 'intent' | 'done' | 'retry'>, reply: CheckedReply<PhoneReplyKind, AgentAsk>): boolean {
  return turn.intent.issue && !turn.retry && turn.done.size === 0 && !reply.filtered && INTENT_MISSED.has(reply.kind);
}
const ASKS: ReadonlySet<AgentAsk> = new Set(AGENT_ASKS);
const VAT_LABEL = { separate: '별도', included: '포함' } as const;
const out = (status: PhoneToolStatus, ref: string | null = null, needs: ToolNeed[] | null = null): ToolOutput => ({ ref, status, fields: null, needs });
function messageOf(v: unknown): ChatMessage | null {
  const m = v as Partial<ChatMessage> | null;
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.at !== 'number' || (m.from !== 'user' && m.from !== 'app') || typeof m.text !== 'string') return null;
  return { id: m.id, at: m.at, from: m.from, text: m.text, ...(m.ctx ? { ctx: m.ctx } : {}), ...(m.kind ? { kind: m.kind } : {}), ...(m.from === 'user' && isReaction(m.reaction) ? { reaction: m.reaction } : {}), ...(m.from === 'user' && typeof m.replyTo === 'string' ? { replyTo: m.replyTo } : {}) };
}

const emptyState = (): State => ({ v: 1, seq: 0, phone: [], fold: null, drafts: [] });

/** 사본 → 가림 사전 레코드(PC 엔진 register와 같은 범위: 거래처 상호·대표자·이메일·사업자번호, 내 사업장 상호·대표자·사업자번호) */
export function copyRecords(copy: PhoneCopy | null): ChatRecord[] {
  if (!copy) return [];
  return [
    ...copy.counterparties.map((c) => ({ recordId: `cp:${c.id}`, names: [c.name, ...(c.repName ? [c.repName] : [])], emails: c.email ? [c.email] : [], bizNos: c.bizNo ? [c.bizNo] : [] })),
    ...(copy.profile ? [{ recordId: `pf:${copy.profile.id}`, names: [copy.profile.name, ...(copy.profile.repName ? [copy.profile.repName] : [])], emails: [] as string[], bizNos: copy.profile.bizNo ? [copy.profile.bizNo] : [] }] : []),
  ];
}

export class PhoneChat {
  private readonly ports: PhoneChatPorts;
  private state: State | null = null;
  private session: Session | null = null;
  private readonly results = new Map<string, Result>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();

  constructor(ports: PhoneChatPorts) {
    this.ports = ports;
  }

  send(text: string, replyTo: string | null = null): Promise<PhoneTurnResult> {
    return this.queue(async () => {
      const r = await this.turn(text, replyTo).catch(async (e: unknown) => {
        if (this.state) await this.save(this.state).catch(() => undefined);
        return this.unavailable(e instanceof PhoneChatError ? e.code : 'chat.unavailable');
      });
      if (r.kind === 'reply') void this.queue(() => this.foldIfNeeded()).catch(() => undefined);
      return r;
    });
  }

  messages(): Promise<ChatMessage[]> {
    return this.queue(async () => (await this.load()).phone.map((m) => ({ ...m })));
  }

  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }

  drafts(): Promise<PhoneDraft[]> {
    return this.queue(async () => (await this.load()).drafts.filter((d) => d.state !== 'discarded').map((d) => ({ ...d })));
  }

  entrust(draftId: string): Promise<PhoneDraft | null> {
    return this.queue(async () => {
      const st = await this.load();
      const d = st.drafts.find((x) => x.id === draftId);
      if (!d || d.state !== 'open') return null;
      d.state = 'entrusted';
      const name = this.ports.copy()?.counterparties.find((c) => c.id === d.counterpartyId)?.name ?? '거래처';
      const line = this.ports.pcOnline?.() ? PHONE_ENTRUST_ONLINE_TEXT : PHONE_ENTRUST_TEXT;
      const text = line(name);
      const tok = '[NAME_1]';
      this.push(st, { from: 'app', text, kind: 'did', ctx: { t: line(tok), e: { [tok]: { k: 'NAME', v: name, r: `cp:${d.counterpartyId}` } } } });
      await this.save(st);
      return { ...d };
    });
  }

  discard(draftId: string): Promise<boolean> {
    return this.queue(async () => {
      const st = await this.load();
      const d = st.drafts.find((x) => x.id === draftId);
      if (!d || d.state !== 'open') return false;
      d.state = 'discarded';
      await this.save(st);
      return true;
    });
  }

  private queue<T>(f: () => Promise<T>): Promise<T> {
    const p = this.tail.then(f, f);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async load(): Promise<State> {
    if (this.state) return this.state;
    let st = emptyState();
    try {
      const raw = await this.ports.store.load();
      const v = raw ? (JSON.parse(raw) as Partial<State>) : null;
      if (v && v.v === 1 && Number.isSafeInteger(v.seq) && Array.isArray(v.phone) && Array.isArray(v.drafts)) st = { v: 1, seq: v.seq!, phone: v.phone.map(messageOf).filter((m): m is ChatMessage => m !== null), fold: v.fold ?? null, drafts: v.drafts };
    } catch {
      // 읽지 못하면 빈 상태로 시작한다(봉인이 풀리지 않는 기기 등)
    }
    this.state = st;
    return st;
  }

  private async save(st: State): Promise<void> {
    if (st.phone.length > PHONE_LOG_MAX) st.phone.splice(0, st.phone.length - PHONE_LOG_MAX);
    if (st.drafts.length > 200) st.drafts = st.drafts.filter((d) => d.state !== 'discarded').slice(-200);
    await this.ports.store.save(JSON.stringify(st));
    for (const f of this.listeners) {
      try {
        f();
      } catch {
        // 구독자 오류는 대화에 영향을 주지 않는다
      }
    }
  }

  private push(st: State, m: Pick<ChatMessage, 'from' | 'text'> & Partial<Pick<ChatMessage, 'ctx' | 'kind' | 'reaction' | 'replyTo'>>): ChatMessage {
    const msg: ChatMessage = { id: this.ports.newId(), at: this.ports.now(), ...m };
    st.phone.push(msg);
    return msg;
  }

  private unavailable(code: PhoneChatErrorCode): PhoneTurnResult {
    return { kind: 'unavailable', code, ...PHONE_ERROR_TEXT[code] };
  }

  private open(now: number): Session {
    let s = this.session;
    if (s && (now - s.lastAt > CHAT_MAP_IDLE_MS || s.turns >= PHONE_SESSION_TURNS)) {
      s.red.map.clear();
      s = null;
    }
    if (!s) {
      const id = `chat_${this.ports.randomHex()}`;
      s = { id, red: new Redactor({ chatSessionId: id }), token: null, lastAt: now, turns: 0, facts: new Map() };
      this.session = s;
    }
    s.lastAt = now;
    return s;
  }

  private ref(st: State, kind: 'r' | 'd'): string {
    return `${kind}${++st.seq}`;
  }

  private copyState(copy: PhoneCopy | null, now: number): PhoneCopyState {
    return !copy ? 'none' : now - copy.asOf <= PHONE_COPY_FRESH_MS ? 'fresh' : 'stale';
  }

  private async turn(text: string, replyTo: string | null): Promise<PhoneTurnResult> {
    const rec = new TurnRecorder(this.ports.newId(), () => this.ports.now(), this.ports.onEvent);
    rec.emit({ type: 'turn.start', device: 'phone', msgId: '' });
    try {
      const r = await this.turnIn(text, rec, replyTo);
      rec.emit(r.kind === 'unavailable' ? { type: 'turn.end', status: 'failed', code: r.code } : { type: 'turn.end', status: 'completed' });
      return r;
    } catch (e) {
      rec.emit({ type: 'turn.end', status: 'failed', code: e instanceof PhoneChatError ? e.code : 'chat.unavailable' });
      throw e;
    }
  }

  private streak(st: State): number {
    let n = 0;
    for (let i = st.phone.length - 1; i >= 0; i--) {
      const m = st.phone[i]!;
      if (m.from !== 'user' || !m.reaction || st.phone[i + 1]?.from === 'app') break;
      n++;
    }
    return n;
  }

  private async route(st: State, s: Session, copy: PhoneCopy | null, now: number, user: RedactedText, cards: Array<PhoneDraft & { name: string }>): Promise<(RouteAck & { capped: boolean }) | null> {
    const model = this.ports.model;
    if (!model.route) return null;
    let input: RedactedText;
    try {
      const recs = copyRecords(copy);
      const mask = (v: string) => s.red.apply(v, { frame: 'none' }).redacted;
      const past = this.window(st).slice(-4).map((m) => `${m.from === 'user' ? '사용자' : '앱'}: ${this.line(s, recs, m)}`);
      const lastApp = [...st.phone].reverse().find((m) => m.from === 'app');
      const k = new Date(now + 9 * 3600_000);
      const frame = cards.length ? `화면: ${cards.map((c) => `카드 ${c.ref}(세금계산서, 거래처 ${mask(c.name)}, 금액 있음, 부가세 ${c.vat ? VAT_LABEL[c.vat] : '미정'}, 품목 ${c.item ? '있음' : '없음'})`).join('; ')}` : '화면: 열린 카드 없음';
      input = mask(['기기: 폰', `오늘: ${k.getUTCFullYear()}년 ${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일`, frame, '진행 중인 발급: 없음', `직전에 되물은 칸: ${lastApp?.kind === 'ask' ? '있음' : '없음'}`, ...reactedLine(this.streak(st)), ...(past.length ? ['[앞 대화]', ...past] : []), `사용자: ${user}`].join('\n'));
    } catch {
      return null;
    }
    if (new TextEncoder().encode(input).length > PHONE_ROUTE_MAX_BYTES) return null;
    try {
      s.token ??= await this.ports.model.runToken(s.id);
      const answers = await model.route!({ text: input, runToken: s.token });
      return answers ? capStreak(routeAck(answers), this.streak(st)) : null;
    } catch {
      s.token = null;
      return null;
    }
  }

  private async turnIn(text: string, rec: TurnRecorder, replyTo: string | null): Promise<PhoneTurnResult> {
    if (typeof text !== 'string' || !text.trim() || [...text].length > PHONE_TEXT_MAX) return this.unavailable('bad_text');
    if (chatSecretShaped(text)) return this.unavailable('chat.secret_rejected');
    const st = await this.load();
    const now = this.ports.now();
    const copy = this.ports.copy();
    const s = this.open(now);
    let user: RedactedText;
    try {
      const said = chatInput(text);
      registerChatRecords(s.red, said, copyRecords(copy));
      user = s.red.apply(said, { frame: 'none' }).redacted;
    } catch {
      return this.unavailable('chat.unavailable');
    }
    const cards = this.openCards(st, copy);
    const replied = replyTo === null ? null : (st.phone.find((m) => m.id === replyTo) ?? null);
    const ack = await this.route(st, s, copy, now, user, cards);
    let reaction: ReactionId | null = null;
    if (ack) {
      rec.emit({ type: 'route', act: null, domain: null, mode: ack.mode, band: ack.reaction ? 'gte80' : 'lt80', unsure: !ack.reaction, failed: false });
      if (ack.reaction && (ack.mode !== 'answer' || ack.capped)) {
        reaction = ack.reaction;
        rec.emit({ type: 'reaction', msgId: '', reaction });
        try {
          this.ports.onReaction?.(reaction);
        } catch {
          // 화면 쪽이 던져도 턴은 이어 간다
        }
      }
      if (ack.mode === 'reaction_only' && reaction) {
        rec.emit({ type: 'path', path: 'reaction', tools: [] });
        const msg = this.push(st, { from: 'user', text, ctx: capture(s.red, user) ?? undefined, reaction, ...(replied ? { replyTo: replied.id } : {}) });
        await this.save(st);
        return { kind: 'reaction', id: msg.id, reaction };
      }
    } else rec.emit({ type: 'route', act: null, domain: null, mode: 'answer', band: 'lt80', unsure: true, failed: true });
    rec.emit({ type: 'path', path: 'tools', tools: [] });
    const turn: Turn = { user, replay: [], done: new Map(), made: [], created: [], frameRefs: new Set(cards.map((c) => c.ref)), intent: issueIntent(user), screens: [], reaction, ackReply: !!ack?.capped, replied };
    const facts = this.facts(st, s, copy, now, user);
    const message = this.compose(st, s, copy, now, turn, facts, cards);
    s.turns++;
    let reply = await this.advance(st, s, copy, now, turn, message);
    if (intentMissed(turn, reply)) {
      turn.retry = true;
      turn.replay.length = 0;
      turn.done.clear();
      reply = await this.advance(st, s, copy, now, turn, this.compose(st, s, copy, now, turn, facts, cards));
    }
    return this.finish(st, s, copy, now, text, turn, reply);
  }

  private openCards(st: State, copy: PhoneCopy | null): Array<PhoneDraft & { name: string }> {
    const names = new Map((copy?.counterparties ?? []).map((c) => [c.id, c.name]));
    return st.drafts
      .filter((d) => d.state === 'open' && names.has(d.counterpartyId))
      .slice(-FRAME_MAX)
      .map((d) => ({ ...d, name: names.get(d.counterpartyId)! }));
  }

  private facts(st: State, s: Session, copy: PhoneCopy | null, now: number, user: RedactedText): Array<{ cpId: string; lines: Array<{ tool: 'invoice_history' | 'receivables'; output: ToolOutput }> }> {
    if (!copy) return [];
    const ids = (masked: string): string[] => {
      const found: string[] = [];
      for (const [tok] of masked.matchAll(TOKEN_RE)) {
        const rec = tok.startsWith('[NAME_') ? s.red.map.recordOf(tok) : undefined;
        if (rec?.startsWith('cp:') && !gluedName(masked, tok, /\s/.test(s.red.map.valueOf(tok) ?? '')) && !found.includes(rec.slice(3))) found.push(rec.slice(3));
      }
      return found;
    };
    let cps = ids(user);
    if (!cps.length) {
      const last = [...st.phone].reverse().find((m) => m.from === 'user' && m.ctx);
      if (last?.ctx) cps = ids(rebind(s.red, last.ctx));
    }
    const known = new Set(copy.counterparties.map((c) => c.id));
    return cps
      .filter((id) => known.has(id))
      .slice(0, PHONE_FACT_COUNTERPARTIES_MAX)
      .map((cpId) => ({
        cpId,
        lines: (['invoice_history', 'receivables'] as const).map((tool) => {
          const key = `${tool}:${cpId}:${copy.asOf}`;
          const cached = s.facts.get(key);
          if (cached && this.results.has(cached)) return { tool, output: { ref: cached, status: 'ok' as const, fields: [...SLOT_FIELDS], needs: null } };
          const output = this.lookup(st, copy, now, tool, cpId);
          if (output.ref) s.facts.set(key, output.ref);
          return { tool, output };
        }),
      }));
  }

  private line(s: Session, recs: readonly ChatRecord[], m: ChatMessage): string {
    if (m.ctx) return rebind(s.red, m.ctx);
    const said = chatInput(m.text);
    registerChatRecords(s.red, said, recs);
    return s.red.apply(said, { frame: 'none' }).redacted;
  }

  private window(st: State): ChatMessage[] {
    const at = st.fold ? st.phone.findIndex((m) => m.id === st.fold!.upto) : -1;
    return st.phone.slice(at + 1);
  }

  private compose(st: State, s: Session, copy: PhoneCopy | null, now: number, turn: Turn, facts: ReturnType<PhoneChat['facts']>, cards: Array<PhoneDraft & { name: string }>): RedactedText {
    const recs = copyRecords(copy);
    const mask = (v: string) => s.red.apply(v, { frame: 'none' }).redacted;
    try {
      const summary = st.fold?.summary ? rebind(s.red, st.fold.summary) : '';
      const win = this.window(st);
      const past = win.flatMap((m, i) => {
        const line = { user: m.from === 'user', text: `${m.from === 'user' ? '사용자' : '앱'}: ${this.line(s, recs, m)}` };
        return m.from === 'user' && m.reaction && win[i + 1]?.from !== 'app' ? [line, { user: false, text: `앱: (반응 ${REACTIONS[m.reaction]})` }] : [line];
      });
      const cpName = new Map((copy?.counterparties ?? []).map((c) => [c.id, c.name]));
      const factBlocks = facts.map((f) => f.lines.map((l) => `${l.tool}(${mask(cpName.get(f.cpId)!)}) = ${JSON.stringify(l.output)}`).join('\n'));
      const frame = cards.length
        ? `화면: ${cards.map((c) => `카드 ${c.ref}(세금계산서, 거래처 ${mask(c.name)}, 금액 있음, 부가세 ${c.vat ? VAT_LABEL[c.vat] : '미정'}, 품목 ${c.item ? '있음' : '없음'})`).join('; ')}`
        : '화면: 열린 카드 없음';
      const hint = !turn.intent.issue ? '' : turn.retry ? '\n앱 판단: 세금계산서 발급 요청(앞 답이 발급으로 잇지 않았다. 카드를 만들거나 빈 칸 하나를 되묻는다)' : '\n앱 판단: 세금계산서 발급 요청';
      const replied = turn.replied ? `\n답장한 말: ${turn.replied.from === 'user' ? '사용자' : '앱'}: ${this.line(s, recs, turn.replied)}` : '';
      const nowBlock = `[지금]\n${frame}${hint}${turn.ackReply ? `\n${ACK_REPLY_HINT}` : ''}${replied}\n사용자: ${turn.user}`;
      const copyLine = `PC: ${this.ports.pcOnline?.() ? '켜짐' : '꺼짐'}\n사본: ${this.copyState(copy, now)}`;
      let nFacts = factBlocks.length;
      let from = 0;
      for (;;) {
        const turns = past.slice(from);
        const parts = [
          summary ? `[요약]\n${summary}` : '',
          turns.length ? `[앞 대화]\n${turns.map((x) => x.text).join('\n')}` : '',
          `[사실]\n${copyLine}${nFacts ? `\n${factBlocks.slice(0, nFacts).join('\n')}` : ''}`,
          nowBlock,
        ].filter(Boolean);
        const text = mask(parts.join('\n'));
        if (PHONE_PREFIX_EST_TOKENS + estimateTokens(text) <= PHONE_CONTEXT_MAX_TOKENS) return text;
        if (nFacts > 0) nFacts--;
        else if (from < past.length) {
          from++;
          while (from < past.length && !past[from]!.user) from++;
        } else throw new PhoneChatError('chat.input_too_large');
      }
    } catch (e) {
      throw e instanceof PhoneChatError ? e : new PhoneChatError('chat.unavailable');
    }
  }

  private async advance(st: State, s: Session, copy: PhoneCopy | null, now: number, turn: Turn, message: RedactedText): Promise<CheckedReply<PhoneReplyKind, AgentAsk>> {
    const model = this.ports.model;
    for (;;) {
      let r: PhoneRespondResult;
      try {
        s.token ??= await model.runToken(s.id);
        r = await model.respond({ toolset: 'chat_phone', text: message, replay: [...turn.replay], runToken: s.token });
      } catch (e) {
        s.token = null;
        throw e instanceof PhoneChatError ? e : new PhoneChatError('chat.unavailable');
      }
      if (r.status === 'refusal') return { kind: 'cannot', text: PHONE_FALLBACK_TEXT, show: [], ask: null, filtered: 'refusal' };
      if (r.status === 'error') {
        if (r.tokenInvalid || r.code === 'chat.unavailable') s.token = null;
        if (r.code === 'chat.budget_exceeded') s.turns = PHONE_SESSION_TURNS;
        throw new PhoneChatError(r.code);
      }
      turn.replay.push(...r.replay);
      if (!r.toolCalls.length) return this.checkReply(st, s, turn, r.output);
      const turns = turn.replay.filter((x) => 'item' in x && x.item.type !== 'reasoning').length;
      if (turns >= CHAT_PHONE_MAX_TURNS || turn.replay.length + r.toolCalls.length > REPLAY_MAX) {
        const show = [...new Set(turn.made)].slice(-AGENT_SHOW_MAX);
        if (show.length) return { kind: 'did', text: PHONE_NUMBER_TEXT, show, ask: null, filtered: 'number' };
        throw new PhoneChatError('chat.turn_limit');
      }
      for (const c of r.toolCalls) {
        const key = `${c.name}:${JSON.stringify(c.arguments)}`;
        let o = turn.done.get(key);
        if (!o) {
          const p = this.parseCall(st, s, turn, c);
          o = 'status' in p ? p : this.exec(st, copy, now, p, turn);
          turn.done.set(key, o);
        }
        if (o.ref) turn.made.push(o.ref);
        try {
          turn.replay.push({ type: 'function_call_output', call_id: c.callId, output: s.red.apply(JSON.stringify(o), { frame: 'none' }).redacted });
        } catch {
          throw new PhoneChatError('chat.unavailable');
        }
      }
    }
  }

  private parseCall(st: State, s: Session, turn: Turn, c: PhoneToolCall): DomainCall | ToolOutput {
    const a = braceTokens(c.arguments);
    const bad = () => new PhoneChatError('chat.bad_response');
    const cp = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      const t = v.trim();
      if (gluedName(turn.user, t, /\s/.test(s.red.map.valueOf(t) ?? ''))) return null;
      const r = detokenize({ counterparty: t }, s.red.map, { recordFields: ['counterparty'] });
      const id = r.ok ? (r.value as { counterparty: { recordId: string } }).counterparty.recordId : '';
      return id.startsWith('cp:') ? id.slice(3) : null;
    };
    const unknown = (v: unknown): ToolOutput => {
      turn.unknownName ??= this.typedName(s, turn, v) ?? undefined;
      return out('unknown_counterparty');
    };
    const draft = (v: unknown): string | null => (typeof v === 'string' && /^d[1-9]\d{0,5}$/.test(v) && st.drafts.some((d) => d.ref === v && d.state !== 'discarded') ? v : null);
    const amount = (v: unknown): DraftAmount => {
      if (v === null) return null;
      const t = String(v).trim();
      const slot = slotPattern.exec(t);
      if (slot) {
        if (!this.results.has(slot[1]!) || !SLOT_MONEY_PATHS.includes(slot[2]!)) throw bad();
        return { slot: t };
      }
      const raw = /^\[AMT_\d+\]$/.test(t) ? s.red.map.valueOf(t) : undefined;
      if (raw === undefined) throw bad();
      const n = parseKrw(raw);
      return n === null ? null : { value: n };
    };
    const item = (v: unknown): string | null => {
      if (v === null) return null;
      const r = detokenize(String(v), s.red.map);
      if (!r.ok) throw bad();
      return String(r.value).trim() || null;
    };
    const vat = (v: unknown): Vat | null => (v === 'separate' || v === 'included' ? v : null);
    const pcOnly = () => ['date_month_offset', 'date_day', 'quantity', 'unit_price'].some((k) => a[k] !== null && a[k] !== undefined);
    const parse: { [K in ChatPhoneToolName]: () => DomainCall | ToolOutput } = {
      sales_summary: () => ({ tool: 'sales_summary', monthOffset: a.month_offset as number }),
      invoice_history: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'invoice_history', counterpartyId: id };
      },
      receivables: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'receivables', counterpartyId: id };
      },
      invoice_draft: () => {
        if (pcOnly()) return out('not_on_phone');
        const id = cp(a.counterparty);
        return id ? { tool: 'invoice_draft', counterpartyId: id, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item) } : unknown(a.counterparty);
      },
      draft_edit: () => {
        if (pcOnly()) return out('not_on_phone');
        const d = draft(a.draft);
        return d ? { tool: 'draft_edit', draft: d, amount: amount(a.amount), vat: vat(a.vat), item: item(a.item) } : out('no_such_draft');
      },
      draft_discard: () => {
        const d = draft(a.draft);
        return d ? { tool: 'draft_discard', draft: d } : out('no_such_draft');
      },
      open_screen: () => ({ tool: 'open_screen', screen: a.screen as PhoneScreen }),
    };
    if (!Object.hasOwn(parse, c.name)) throw bad();
    return parse[c.name]();
  }

  private typedName(s: Session, turn: Turn, v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (/^\[NAME_\d+\]$/.test(t)) {
      const raw = turn.user.includes(t) && !s.red.map.recordOf(t) ? s.red.map.valueOf(t)?.trim() : undefined;
      return raw && [...raw].length <= NAME_MAX ? raw : null;
    }
    return t && !/[[\]]/.test(t) && [...t].length <= NAME_MAX && turn.user.includes(t) ? t : null;
  }

  private sales(st: State, copy: PhoneCopy | null, now: number, monthOffset: number): ToolOutput {
    if (!copy?.sales) return out('not_on_phone');
    const r = salesOf(copy.sales, kstDate(now), monthOffset);
    if (!r.rows.length) return out('empty');
    return this.keep(st, { kind: 'sales', ...r, copy: this.copyState(copy, now) });
  }

  private keep(st: State, r: Result): ToolOutput {
    const ref = this.ref(st, 'r');
    this.results.set(ref, r);
    if (this.results.size > RESULTS_MAX) this.results.delete(this.results.keys().next().value!);
    return { ref, status: 'ok', fields: [...SLOT_FIELDS], needs: null };
  }

  private lookup(st: State, copy: PhoneCopy | null, now: number, tool: 'invoice_history' | 'receivables', cpId: string | null): ToolOutput {
    if (!copy) return out('not_on_phone');
    const cp = cpId === null ? null : copy.counterparties.find((c) => c.id === cpId);
    if (cp === undefined) return out('unknown_counterparty');
    const all = tool === 'receivables' ? copy.receivables : copy.issued;
    if (!all) return out('not_on_phone');
    const rows = newestFirst(cp ? all.filter((x) => x.counterpartyId === cp.id || (x.counterpartyId === null && x.counterparty === cp.name)) : all);
    if (!rows.length) return out('empty');
    const name = cp ? `${cp.name} ` : '';
    return this.keep(st, { kind: tool === 'receivables' ? 'receivables' : 'history', title: tool === 'receivables' ? `${name}입금 확인 전 ${tally(rows)}` : `${name}발급 기록 ${tally(rows)}`, rows, copy: this.copyState(copy, now) });
  }

  private exec(st: State, copy: PhoneCopy | null, now: number, call: DomainCall, turn: Turn): ToolOutput {
    switch (call.tool) {
      case 'open_screen':
        if (!turn.screens.includes(call.screen)) turn.screens.push(call.screen);
        return out('screen_shown');
      case 'sales_summary':
        return this.sales(st, copy, now, call.monthOffset);
      case 'invoice_history':
      case 'receivables':
        return this.lookup(st, copy, now, call.tool, call.counterpartyId);
      case 'invoice_draft': {
        const cp = copy?.counterparties.find((c) => c.id === call.counterpartyId);
        if (!cp) return out('unknown_counterparty');
        const amount = this.amount(call.amount);
        const item = (call.item === null ? null : cleanItem(call.item)) ?? cleanItem(cp.item ?? '');
        const needs: ToolNeed[] = [...(amount ? [] : ['amount' as const]), ...(item ? [] : ['item' as const])];
        if (needs.length) return out('needs_input', null, needs);
        const d: PhoneDraft = { id: this.ports.newId(), ref: this.ref(st, 'd'), counterpartyId: cp.id, amount: amount!.value, vat: call.vat ?? amount!.vat, item, state: 'open', at: now };
        st.drafts.push(d);
        turn.created.push(d.ref);
        return out('card_shown', d.ref);
      }
      case 'draft_edit':
      case 'draft_discard': {
        const d = st.drafts.find((x) => x.ref === call.draft && x.state !== 'discarded');
        if (!d) return out('no_such_draft');
        if (d.state !== 'open') return out('not_editable', d.ref);
        if (call.tool === 'draft_discard') {
          d.state = 'discarded';
          return out('discarded', d.ref);
        }
        const needs: ToolNeed[] = [];
        const patch: Partial<Pick<PhoneDraft, 'amount' | 'vat' | 'item'>> = {};
        if (call.amount !== null) {
          const a = this.amount(call.amount);
          if (a) {
            patch.amount = a.value;
            if (a.vat) patch.vat = a.vat;
          } else needs.push('amount');
        }
        if (call.vat) patch.vat = call.vat;
        if (call.item !== null) {
          const item = cleanItem(call.item);
          if (item) patch.item = item;
          else needs.push('item');
        }
        if (needs.length || !Object.keys(patch).length) return out('needs_input', d.ref, needs.length ? needs : null);
        Object.assign(d, patch);
        return out('card_updated', d.ref);
      }
    }
  }

  private amount(a: DraftAmount): { value: number; vat: Vat | null } | null {
    if (a === null) return null;
    if ('value' in a) return validAmount(a.value) ? { value: a.value, vat: null } : null;
    const m = slotPattern.exec(a.slot);
    const field = m?.[2]!.split('.')[1];
    if (!m || (field !== 'supply' && field !== 'total')) return null;
    const v = this.slotValue(m[1]!, m[2]!);
    return typeof v === 'number' && validAmount(v) ? { value: v, vat: field === 'total' ? 'included' : null } : null;
  }

  private slotValue(ref: string, path: string): number | string | null {
    const rows = this.results.get(ref)?.rows;
    if (!rows) return null;
    if (path === 'count') return rows.length;
    const [pos, field] = path.split('.') as [string, string];
    if (pos === 'sum') return sumOf(rows, field as 'supply' | 'total');
    const row = pos === 'first' ? rows[0] : rows.at(-1);
    if (!row) return null;
    if (field === 'date') return row.date;
    if (field === 'counterparty') return row.counterparty;
    if (field === 'approvalNo') return row.approvalNo ?? null;
    if (row.total === null) return null;
    return field === 'total' ? row.total : supplyOf(row.total);
  }

  private checkReply(st: State, s: Session, turn: Turn, output: unknown): CheckedReply<PhoneReplyKind, AgentAsk> {
    try {
      return checkAgentReply<PhoneReplyKind, AgentAsk>(output, {
        kinds: KINDS,
        asks: ASKS,
        hasToken: (tok) => s.red.map.has(tok),
        hasRef: (ref) => this.results.has(ref),
        canShow: (ref) => this.results.has(ref) || turn.frameRefs.has(ref) || st.drafts.some((d) => d.ref === ref && d.state !== 'discarded'),
        fallbackText: PHONE_FALLBACK_TEXT,
        numberText: PHONE_NUMBER_TEXT,
        userText: turn.user,
        askText: (a) => PHONE_ASK_TEXT[a],
        badSlot: (k, a, refs) => {
          const show = refs.length ? refs : [...new Set(turn.made)].slice(-AGENT_SHOW_MAX);
          if (a && !(a === 'vat' && turn.created.length > 0)) return { kind: k, text: PHONE_ASK_TEXT[a], show, ask: a, filtered: 'slot' };
          return { kind: k, text: show.length ? PHONE_NUMBER_TEXT : PHONE_FALLBACK_TEXT, show, ask: null, filtered: 'slot' };
        },
      });
    } catch (e) {
      throw e instanceof ReplyShapeError ? new PhoneChatError('chat.bad_response') : e;
    }
  }

  private async finish(st: State, s: Session, copy: PhoneCopy | null, now: number, said: string, turn: Turn, reply: CheckedReply<PhoneReplyKind, AgentAsk>): Promise<PhoneTurnResult> {
    const today = kstDate(now);
    const cpName = new Map((copy?.counterparties ?? []).map((c) => [c.id, c.name]));
    const valueOf = (tok: string): string | null => {
      const rec = s.red.map.recordOf(tok);
      const name = tok.startsWith('[NAME_') && rec?.startsWith('cp:') ? cpName.get(rec.slice(3)) : undefined;
      return name ?? s.red.map.valueOf(tok) ?? null;
    };
    const fillRe = new RegExp(`${TOKEN_RE.source}|${slotAnywhere().source}`, 'g');
    let missing = false;
    let text = reply.text;
    let ctxText = reply.text;
    if (!reply.filtered) {
      text = fillWithJosa(reply.text, fillRe, (m) => {
        if (m[3] === undefined) return valueOf(m[0]);
        const v = this.slotValue(m[3], m[4]!);
        if (v === null) {
          missing = true;
          return '';
        }
        return m[4] === 'count' ? String(v) : typeof v === 'number' ? won(v) : m[4]!.endsWith('.date') ? koDate(v, today) : v;
      });
      if (missing) text = PHONE_SLOT_MISSING_TEXT;
      ctxText = missing
        ? PHONE_SLOT_MISSING_TEXT
        : reply.text.replace(slotAnywhere(), (_m, ref: string, path: string) => {
            const v = this.slotValue(ref, path);
            if (path === 'count') return '(건수)';
            if (path.endsWith('.date')) return '(날짜)';
            if (path.endsWith('.approvalNo')) return '(승인번호)';
            if (typeof v === 'number') return s.red.map.token('AMT', won(v));
            return typeof v === 'string' && v ? s.red.map.token('NAME', v) : '(값)';
          });
    }
    const slotRefs = reply.filtered ? [] : [...reply.text.matchAll(slotAnywhere())].map((m) => m[1]!);
    const show: PhoneShow[] = [];
    const shownCards = new Set<string>();
    const card = (ref: string) => {
      const d = st.drafts.find((x) => x.ref === ref && x.state !== 'discarded');
      if (!d || shownCards.has(ref)) return;
      shownCards.add(ref);
      show.push({ type: 'card', draft: { ...d }, counterparty: cpName.get(d.counterpartyId) ?? '' });
    };
    for (const ref of [...new Set([...reply.show, ...slotRefs])]) {
      const res = this.results.get(ref);
      if (res) show.push({ type: 'table', table: res.kind, title: res.title, rows: res.rows.map((x) => ({ date: x.date, counterparty: x.counterparty, total: x.total, approvalNo: x.approvalNo ?? null })), copy: res.copy });
      else card(ref);
    }
    for (const ref of turn.created) card(ref);
    for (const screen of turn.screens) show.push({ type: 'screen', screen });
    const name = reply.filtered ? undefined : turn.unknownName?.trim();
    const unknown = name && !copy?.counterparties.some((c) => c.name === name) ? { name, text: `${name}${finalOf(name) ? fixJosa(name, '은 폰에 받아 둔 거래처 목록에 없어요.') : '은(는) 폰에 받아 둔 거래처 목록에 없어요.'}` } : undefined;
    const userMsg = this.push(st, { from: 'user', text: said, ctx: capture(s.red, turn.user) ?? undefined, ...(turn.reaction ? { reaction: turn.reaction } : {}), ...(turn.replied ? { replyTo: turn.replied.id } : {}) });
    const app = this.push(st, { from: 'app', text, kind: reply.kind, ctx: capture(s.red, ctxText) ?? { t: PHONE_NUMBER_TEXT, e: {} } });
    await this.save(st);
    return {
      kind: 'reply',
      id: app.id,
      text,
      show,
      ask: reply.ask && !(reply.ask === 'vat' && turn.created.length > 0) ? { kind: reply.ask, chips: this.chips(st, copy, reply.ask) } : null,
      reply: reply.kind,
      filtered: reply.filtered,
      ...(unknown ? { unknown } : {}),
      user: { id: userMsg.id, reaction: turn.reaction },
    };
  }

  private chips(st: State, copy: PhoneCopy | null, ask: AgentAsk): Array<{ label: string; text: string }> {
    if (ask === 'counterparty') return (copy?.counterparties ?? []).slice(0, CHIP_CP_MAX).map((c) => ({ label: c.name, text: c.name }));
    if (ask === 'vat') return [{ label: '별도', text: '부가세 별도로' }, { label: '포함', text: '부가세 포함으로' }];
    if (ask === 'which_card') {
      return this.openCards(st, copy).map((d, i) => {
        const label = `${d.name} ${won(d.amount)}`;
        return { label, text: `${i + 1}번째 카드(${label})` };
      });
    }
    return [];
  }

  private async foldIfNeeded(): Promise<void> {
    const st = await this.load();
    const win = this.window(st);
    const users = win.map((m, i) => (m.from === 'user' ? i : -1)).filter((i) => i >= 0);
    if (users.length <= PHONE_TURNS_MAX) return;
    const cut = users[users.length - PHONE_TURNS_MAX / 2]!;
    const old = win.slice(0, cut);
    if (!old.length) return;
    let summary = st.fold?.summary ?? null;
    try {
      summary = await this.digest(st, old);
    } catch {
      // 요약 없이 접는다
    }
    st.fold = { summary, upto: old.at(-1)!.id };
    await this.save(st);
  }

  private async digest(st: State, old: readonly ChatMessage[]): Promise<MaskedText> {
    const now = this.ports.now();
    const s = this.open(now);
    const recs = copyRecords(this.ports.copy());
    const today = kstDate(now);
    const lines = old.map((m) => `(${koDate(kstDate(m.at), today)}) ${m.from === 'user' ? '사용자' : '앱'}: ${this.line(s, recs, m)}`);
    const text = s.red.apply(`${st.fold?.summary ? `[앞 요약]\n${rebind(s.red, st.fold.summary)}\n` : ''}[대화]\n${lines.join('\n')}`, { frame: 'none' }).redacted;
    s.token ??= await this.ports.model.runToken(s.id);
    const r = await this.ports.model.respond({ toolset: 'chat_digest', text, replay: [], runToken: s.token });
    if (r.status !== 'completed' || r.toolCalls.length) {
      if (r.status === 'error' && (r.tokenInvalid || r.code === 'chat.unavailable')) s.token = null;
      throw new PhoneChatError('chat.bad_response');
    }
    const o = r.output as { summary?: unknown } | null;
    if (!o || typeof o !== 'object' || typeof o.summary !== 'string') throw new PhoneChatError('chat.bad_response');
    let sum = o.summary.replace(/\{[^{}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    if ([...sum].length > CHAT_DIGEST_MAX_CHARS) {
      const head = [...sum].slice(0, CHAT_DIGEST_MAX_CHARS).join('');
      const end = head.lastIndexOf('. ');
      sum = (end > CHAT_DIGEST_MAX_CHARS / 2 ? head.slice(0, end + 1) : head).replace(/\[[A-Z]*(?:_\d*)?$/, '').trim();
    }
    if (!sum || unsafeText(sum.replace(TOKEN_RE, ' '))) throw new PhoneChatError('chat.bad_response');
    const m = capture(s.red, sum);
    if (!m) throw new PhoneChatError('chat.bad_response');
    return m;
  }
}
