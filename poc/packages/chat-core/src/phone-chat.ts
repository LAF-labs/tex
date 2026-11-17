// 폰 대화(ADR-047 결정 5·6): 폰이 게이트웨이의 chat_phone을 직접 부르는 한 사용자 턴의 전부. 대화는 이 폰의 것이다(기기마다 따로, ADR-046 결정 7).
// PC에서는 엔진(토큰 공간)과 main(값 공간)이 나눠 하던 일을 폰에서는 이 클래스 하나가 한다. 규칙은 PC와 같은 코드(rules·reply-check·tables)다.
// - 모델에 가는 것: 가린 글(토큰·슬롯)과 도구 결과의 ref·status·fields·needs뿐이다. 값·행·개수·이름은 가지 않는다(C-10).
// - 컨텍스트: [요약] → [앞 대화] → [사실] → [지금]. 덜 바뀌는 것이 앞이다(공급사 접두 캐시). 상한을 넘으면 사실 → 오래된 턴 순으로 줄인다.
// - 발급·전송은 없다. 카드를 만들고 고치고 취소하고, 사장님이 카드에서 맡기면 PC가 켜진 뒤에 시작한다.
// - 저장은 포트(store)로만 한다. 폰 앱이 기기 키로 봉인한다. 문장·토큰·값을 로그에 남기지 않는다.
import { CHAT_MAP_IDLE_MS, Redactor, TOKEN_RE, detokenize, type RedactedText } from '@sax/redaction';
import { capture, rebind, type ChatMessage, type MaskedText } from './chat-log.ts';
import { cleanItem, fillWithJosa, finalOf, fixJosa, koDate, kstDate, splitVat, validAmount, won } from './fill.ts';
import { PhoneChatError, type PhoneChatErrorCode, type PhoneModel, type PhoneRespondResult, type PhoneToolCall, type ReplayItem } from './phone-gateway.ts';
import { ReplyShapeError, braceTokens, chatSecretShaped, checkAgentReply, unsafeText, type CheckedReply, type ReplyFilter } from './reply-check.ts';
import { chatInput, gluedName, parseKrw, registerChatRecords, type ChatRecord } from './rules.ts';
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
  type PhoneToolStatus,
  type SlotField,
  type ToolNeed,
  type Vat,
} from './tables.ts';
import { estimateTokens } from './tokens.ts';

// ── 상한 ──

/** 한 번 부를 때의 입력 상한(추정 토큰, 머리말·도구 정의 포함). 하루 한도(체험 50원·구독 300원) 안에서 대화 횟수를 지키는 값이다. */
export const PHONE_CONTEXT_MAX_TOKENS = 8000;
/** chat_phone 머리말 + 도구 정의 + 출력 스키마의 추정 토큰(넉넉하게). 시험이 실제 머리말의 추정값이 이보다 작은지 본다. */
export const PHONE_PREFIX_EST_TOKENS = 4000;
/** [앞 대화]에 두는 사용자 턴 수 상한. 넘으면 오래된 절반을 한꺼번에 요약으로 접는다. */
export const PHONE_TURNS_MAX = 20;
/** [사실]에 미리 조회해 넣는 거래처 수 상한 */
export const PHONE_FACT_COUNTERPARTIES_MAX = 5;
/** 사용자 문장 글자 상한(PC intent와 같다) */
export const PHONE_TEXT_MAX = 2000;
/** 게이트웨이 respond 스키마의 replay maxItems */
const REPLAY_MAX = 12;
/** 대화 세션 하나(실행 토큰 하나)로 여는 사용자 턴 수. 게이트웨이 대화 예산(l2PerChat 20)에 닿기 전에 새 세션을 연다. */
export const PHONE_SESSION_TURNS = 16;
/** 사본이 이보다 오래되면 stale */
export const PHONE_COPY_FRESH_MS = 24 * 3600_000;
/** 화면 프레임에 싣는 열린 카드 수 */
const FRAME_MAX = 12;
const CHIP_CP_MAX = 8;
/** 메모리에 두는 조회 결과 수 */
const RESULTS_MAX = 40;
/** 합쳐지지 않은 폰 메시지 보관 상한(넘으면 오래된 것부터 버린다) */
const PHONE_LOG_MAX = 600;
const NAME_MAX = 40;

// ── 고정 문구 ──

export const PHONE_FALLBACK_TEXT = '세금계산서 카드 만들기와 발급 기록·받을 돈 확인을 도와드려요. 어떤 일을 할까요?';
export const PHONE_NUMBER_TEXT = '결과를 화면에 보여 드렸어요. 금액과 날짜는 표와 카드에서 확인해 주세요.';
/**
 * 폰이 직접 되묻는 고정 문장(되묻기 칸별). 모델이 되묻는 문장에 숫자를 섞었거나 틀린 슬롯을 썼을 때 쓴다(PC의 CHAT_AGENT_ASK_TEXT와 같은 쓰임).
 * 화면은 이 문장 아래 그 칸의 선택지를 붙인다.
 */
export const PHONE_ASK_TEXT: Record<AgentAsk, string> = {
  amount: '금액을 알려 주세요. 부가세 포함인지 별도인지도 같이 말씀해 주시면 바로 카드를 만들게요.',
  item: '품목을 알려 주세요. 예를 들어 디자인 용역처럼 적어 주시면 돼요.',
  counterparty: '어느 거래처인가요? 거래처 목록에서 골라 주세요.',
  vat: '부가세 별도인가요, 포함인가요?',
  which_card: '어느 카드를 말씀하시는지 골라 주세요.',
  date: '작성일자를 정하는 카드는 PC에서 만들 수 있어요. PC가 켜지면 PC 대화에서 말씀해 주세요.',
};
export const PHONE_SLOT_MISSING_TEXT = '같이 보이는 표에서 값을 확인해 주세요.';
export const PHONE_UNAVAILABLE_TEXT = '지금 답을 받지 못했어요. 잠시 뒤 다시 시도해 주세요.';
export const PHONE_ENTRUST_TEXT = (name: string): string => `${name} 세금계산서를 맡겼어요. PC가 켜지면 시작하고, 발급 전에 한 번 더 확인을 받아요.`;

/** 오류 코드 → 대화 문장과 [다시 시도]. 화면이 다른 문구를 쓰려면 code로 바꾼다. */
export const PHONE_ERROR_TEXT: Record<PhoneChatErrorCode, { text: string; retry: boolean }> = {
  'chat.unavailable': { text: PHONE_UNAVAILABLE_TEXT, retry: true },
  'chat.bad_response': { text: PHONE_UNAVAILABLE_TEXT, retry: true },
  'chat.budget_exceeded': { text: '대화가 많이 이어졌어요. 잠시 뒤에 다시 말해 주세요.', retry: true },
  'chat.quota_exceeded': { text: '이번 달 대화 한도를 다 썼어요.', retry: false },
  'chat.daily_limit': { text: '오늘 쓸 수 있는 AI 사용량을 다 썼어요. 새벽 4시에 다시 채워져요.', retry: false },
  'chat.subscription_required': { text: '무료 체험이 끝났어요. 구독하면 AI 대화를 다시 쓸 수 있어요.', retry: false },
  'chat.rate_limited': { text: '요청이 잠깐 몰렸어요. 조금 뒤에 다시 보내 주세요.', retry: true },
  'chat.device_suspended': { text: '이 폰의 연결이 정지되어 있어요. PC의 설정에서 폰 연결을 확인해 주세요.', retry: false },
  'chat.input_too_large': { text: '문장이 너무 길어요. 짧게 나눠서 다시 말해 주세요.', retry: false },
  'chat.secret_rejected': { text: '비밀번호 같은 비밀 값은 대화창에 입력하지 마세요. 이 문장은 보내지 않았어요.', retry: false },
  'chat.turn_limit': { text: '한 번에 하기 어려워요. 나눠서 말씀해 주세요.', retry: false },
  bad_text: { text: '문장이 너무 길어요. 짧게 나눠서 다시 말해 주세요.', retry: false },
};

// ── 폰 사본(PC가 마지막으로 넘긴 것) ──

export interface CopyCounterparty {
  id: string;
  name: string;
  repName?: string | null;
  email?: string | null;
  bizNo?: string | null;
  /** 거래처 저장 품목(없으면 최근 발급 품목). 품목 없는 카드를 만들지 않는 데 쓴다. */
  item?: string | null;
}

/** 발급·받을 돈 한 줄. total은 세금 포함 합계다(데스크톱 IssuedRow와 같다). */
export interface CopyRow {
  counterpartyId: string | null;
  counterparty: string;
  /** KST YYYY-MM-DD */
  date: string;
  total: number | null;
  approvalNo?: string | null;
}

export interface PhoneCopy {
  /** PC가 이 사본을 만든 시각(ms) */
  asOf: number;
  /** 내 사업장(가림 사전에 올린다) */
  profile: { id: string; name: string; repName?: string | null; bizNo?: string | null } | null;
  counterparties: CopyCounterparty[];
  /** 최근 발급(거래처마다 최근 몇 건). null이면 사본에 없다(not_on_phone). */
  issued: CopyRow[] | null;
  /** 입금 확인 전. null이면 사본에 없다(계좌 연결 전 포함). */
  receivables: CopyRow[] | null;
}

// ── 카드(폰에서 만든 초안) ──

export interface PhoneDraft {
  /** ULID */
  id: string;
  /** 대화에서 가리키는 이름(d#). 세션이 바뀌어도 그대로다. */
  ref: string;
  counterpartyId: string;
  /** 말한 금액(원). vat가 included면 합계, 아니면 공급가다. */
  amount: number;
  /** 정하지 않았으면 null(PC가 준비할 때 별도로 본다) */
  vat: Vat | null;
  item: string | null;
  /** open: 고치고 취소할 수 있다. entrusted: 사장님이 맡겼다(PC가 켜지면 시작). discarded: 취소. */
  state: 'open' | 'entrusted' | 'discarded';
  at: number;
}

// ── 포트 ──

export interface PhoneChatPorts {
  model: PhoneModel;
  /** 봉인 저장(폰 앱이 기기 키로 암호화한다). 값은 JSON 문자열 하나다. */
  store: { load(): Promise<string | null>; save(data: string): Promise<void> };
  /** 폰 사본. 아직 받은 적 없으면 null */
  copy(): PhoneCopy | null;
  now(): number;
  /** 메시지·카드 id(ULID) */
  newId(): string;
  /** 대화 세션 id에 넣을 난수(16진 32자 이상) */
  randomHex(): string;
}

// ── 화면에 주는 결과 ──

export interface PhoneTableRow {
  date: string;
  counterparty: string;
  total: number | null;
  approvalNo: string | null;
}
export type PhoneShow = { type: 'card'; draft: PhoneDraft; counterparty: string } | { type: 'table'; table: 'history' | 'receivables'; title: string; rows: PhoneTableRow[]; copy: PhoneCopyState };

export type PhoneTurnResult =
  | {
      kind: 'reply';
      /** 이 답 메시지의 id */
      id: string;
      text: string;
      show: PhoneShow[];
      ask: null | { kind: AgentAsk; chips: Array<{ label: string; text: string }> };
      reply: PhoneReplyKind;
      filtered: ReplyFilter;
      /** 사장님이 쓴 거래처 이름이 폰 사본에 없다 */
      unknown?: { name: string; text: string };
    }
  | { kind: 'unavailable'; code: PhoneChatErrorCode; text: string; retry: boolean };

// ── 내부 ──

interface State {
  v: 1;
  /** ref 번호(r#·d#). 세션이 바뀌어도 이어 간다: 옛 ref가 새 결과를 가리키지 않게. */
  seq: number;
  /** 이 폰에서 나눈 대화(오래된 것부터, PHONE_LOG_MAX개까지) */
  phone: ChatMessage[];
  /** 접은 구간의 요약과 접힌 마지막 메시지 id */
  fold: { summary: MaskedText | null; upto: string } | null;
  drafts: PhoneDraft[];
}

interface Result {
  kind: 'history' | 'receivables';
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
  /** [사실] 재사용: `${tool}:${cpId}:${asOf}` → ref. 같은 조회는 같은 ref라 접두가 바뀌지 않는다. */
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
  | { tool: 'invoice_history' | 'receivables'; counterpartyId: string | null }
  | { tool: 'invoice_draft'; counterpartyId: string; amount: DraftAmount; vat: Vat | null; item: string | null }
  | { tool: 'draft_edit'; draft: string; amount: DraftAmount; vat: Vat | null; item: string | null }
  | { tool: 'draft_discard'; draft: string };

interface Turn {
  user: RedactedText;
  replay: ReplayItem[];
  /** 이번 턴에 끝난 도구 호출(도구 이름 + 인자) → 결과. 같은 호출을 또 하면 실행하지 않고 이 결과로 답한다. */
  done: Map<string, ToolOutput>;
  /** 이번 턴 도구 결과로 나온 ref(나온 순서) */
  made: string[];
  /** 이번 턴에 만든 카드 ref */
  created: string[];
  frameRefs: Set<string>;
  unknownName?: string;
}

const KINDS: ReadonlySet<PhoneReplyKind> = new Set(PHONE_REPLY_KINDS);
const ASKS: ReadonlySet<AgentAsk> = new Set(AGENT_ASKS);
const VAT_LABEL = { separate: '별도', included: '포함' } as const;
const out = (status: PhoneToolStatus, ref: string | null = null, needs: ToolNeed[] | null = null): ToolOutput => ({ ref, status, fields: null, needs });
const supplyOf = (total: number) => splitVat(total, 'included').supply;
const sumOf = (rows: ReadonlyArray<{ total: number | null }>, field: 'supply' | 'total'): number | null =>
  rows.some((r) => r.total === null) ? null : rows.reduce((a, r) => a + (field === 'total' ? r.total! : supplyOf(r.total!)), 0);
function tally(rows: ReadonlyArray<{ total: number | null }>): string {
  const known = rows.filter((x) => x.total !== null);
  const gap = rows.length - known.length;
  return `${rows.length}건 · 공급가 ${won(sumOf(known, 'supply')!)} · 합계 ${won(sumOf(known, 'total')!)}${gap ? `(금액 모르는 ${gap}건 빼고)` : ''}`;
}
const newestFirst = <T extends { date: string }>(rows: readonly T[]) => [...rows].sort((a, b) => b.date.localeCompare(a.date));
/** 저장해 둔 메시지 하나(이 기기가 쓴 것). 아는 칸만 옮긴다: 옛 판이 넣던 칸(origin·base·synced)은 버린다. */
function messageOf(v: unknown): ChatMessage | null {
  const m = v as Partial<ChatMessage> | null;
  if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.at !== 'number' || (m.from !== 'user' && m.from !== 'app') || typeof m.text !== 'string') return null;
  return { id: m.id, at: m.at, from: m.from, text: m.text, ...(m.ctx ? { ctx: m.ctx } : {}), ...(m.kind ? { kind: m.kind } : {}) };
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

  // ── 바깥 접점 ──

  /** 한 문장을 보낸다. 던지지 않는다. 호출은 차례로 처리된다. */
  send(text: string): Promise<PhoneTurnResult> {
    return this.queue(async () => {
      const r = await this.turn(text).catch(async (e: unknown) => {
        // 답 없이 끝났어도 이번 턴에 만든 카드·바꾼 카드는 남는다(카드가 사실이다). 저장해 두면 다음 문장의 화면 줄에 실린다.
        if (this.state) await this.save(this.state).catch(() => undefined);
        return this.unavailable(e instanceof PhoneChatError ? e.code : 'chat.unavailable');
      });
      // 답을 돌려준 뒤 오래된 턴을 접는다. 다음 send는 이것이 끝난 뒤에 돈다(queue).
      if (r.kind === 'reply') void this.queue(() => this.foldIfNeeded()).catch(() => undefined);
      return r;
    });
  }

  /** 이 폰의 대화 목록(오래된 것부터) */
  messages(): Promise<ChatMessage[]> {
    return this.queue(async () => (await this.load()).phone.map((m) => ({ ...m })));
  }

  /** 목록·카드가 바뀌면 부른다 */
  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => void this.listeners.delete(f);
  }

  drafts(): Promise<PhoneDraft[]> {
    return this.queue(async () => (await this.load()).drafts.filter((d) => d.state !== 'discarded').map((d) => ({ ...d })));
  }

  /** 사장님이 카드의 버튼으로 맡긴다(모델 출력으로는 맡길 수 없다). 열린 카드만. 맡긴 사실은 대화 기록에 한 줄 남는다. */
  entrust(draftId: string): Promise<PhoneDraft | null> {
    return this.queue(async () => {
      const st = await this.load();
      const d = st.drafts.find((x) => x.id === draftId);
      if (!d || d.state !== 'open') return null;
      d.state = 'entrusted';
      const name = this.ports.copy()?.counterparties.find((c) => c.id === d.counterpartyId)?.name ?? '거래처';
      const text = PHONE_ENTRUST_TEXT(name);
      // 컨텍스트에는 이름 대신 토큰으로 남긴다(이름은 값으로만 들고 있다)
      const tok = '[NAME_1]';
      this.push(st, { from: 'app', text, kind: 'did', ctx: { t: PHONE_ENTRUST_TEXT(tok), e: { [tok]: { k: 'NAME', v: name, r: `cp:${d.counterpartyId}` } } } });
      await this.save(st);
      return { ...d };
    });
  }

  /** 사장님이 카드에서 직접 취소한다(열린 카드만) */
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

  // ── 상태 ──

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

  private push(st: State, m: Pick<ChatMessage, 'from' | 'text'> & Partial<Pick<ChatMessage, 'ctx' | 'kind'>>): ChatMessage {
    const msg: ChatMessage = { id: this.ports.newId(), at: this.ports.now(), ...m };
    st.phone.push(msg);
    return msg;
  }

  private unavailable(code: PhoneChatErrorCode): PhoneTurnResult {
    return { kind: 'unavailable', code, ...PHONE_ERROR_TEXT[code] };
  }

  /** 대화 세션: CHAT_MAP_IDLE_MS 쉬었거나 턴을 많이 썼으면 토큰 맵을 버리고 새 세션(새 chatSessionId·실행 토큰)을 연다. 기록은 값으로 들고 있어 이어진다. */
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

  // ── 한 턴 ──

  private async turn(text: string): Promise<PhoneTurnResult> {
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
    const turn: Turn = { user, replay: [], done: new Map(), made: [], created: [], frameRefs: new Set(cards.map((c) => c.ref)) };
    const facts = this.facts(st, s, copy, now, user);
    const message = this.compose(st, s, copy, now, turn, facts, cards);
    s.turns++;
    const reply = await this.advance(st, s, copy, now, turn, message);
    return this.finish(st, s, copy, now, text, turn, reply);
  }

  private openCards(st: State, copy: PhoneCopy | null): Array<PhoneDraft & { name: string }> {
    const names = new Map((copy?.counterparties ?? []).map((c) => [c.id, c.name]));
    return st.drafts
      .filter((d) => d.state === 'open' && names.has(d.counterpartyId))
      .slice(-FRAME_MAX)
      .map((d) => ({ ...d, name: names.get(d.counterpartyId)! }));
  }

  /** 이번 문장에 나온 거래처(없으면 직전 폰 턴의 거래처)를 사본에서 미리 조회한다. 도구 결과와 같은 꼴로 [사실]에 싣는다. */
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
      // "그거 얼마였어?"처럼 거래처 없이 이어 묻는 말: 직전 사용자 턴에 나온 거래처를 쓴다
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

  /** 가린 문장 한 줄(이전 메시지). ctx가 있으면 값으로 새 토큰을 받아 다시 쓰고, 없으면 규칙으로 가린다. */
  private line(s: Session, recs: readonly ChatRecord[], m: ChatMessage): string {
    if (m.ctx) return rebind(s.red, m.ctx);
    const said = chatInput(m.text);
    registerChatRecords(s.red, said, recs);
    return s.red.apply(said, { frame: 'none' }).redacted;
  }

  /** [앞 대화]에 들어갈 메시지(접힌 것 뒤부터) */
  private window(st: State): ChatMessage[] {
    const at = st.fold ? st.phone.findIndex((m) => m.id === st.fold!.upto) : -1;
    return st.phone.slice(at + 1);
  }

  /**
   * 이번 턴 user 메시지 하나: [요약] → [앞 대화] → [사실] → [지금]. 상한을 넘으면 사실 → 오래된 턴 순으로 줄인다(요약과 이번 문장은 줄이지 않는다).
   * 조각마다 따로 가린 뒤 이어 붙이고, 같은 세션 Redactor로 한 번 더 지나 발급한다(PC 엔진 compose와 같다).
   */
  private compose(st: State, s: Session, copy: PhoneCopy | null, now: number, turn: Turn, facts: ReturnType<PhoneChat['facts']>, cards: Array<PhoneDraft & { name: string }>): RedactedText {
    const recs = copyRecords(copy);
    const mask = (v: string) => s.red.apply(v, { frame: 'none' }).redacted;
    try {
      const summary = st.fold?.summary ? rebind(s.red, st.fold.summary) : '';
      const past = this.window(st).map((m) => {
        return { user: m.from === 'user', text: `${m.from === 'user' ? '사용자' : '앱'}: ${this.line(s, recs, m)}` };
      });
      const cpName = new Map((copy?.counterparties ?? []).map((c) => [c.id, c.name]));
      const factBlocks = facts.map((f) => f.lines.map((l) => `${l.tool}(${mask(cpName.get(f.cpId)!)}) = ${JSON.stringify(l.output)}`).join('\n'));
      const frame = cards.length
        ? `화면: ${cards.map((c) => `카드 ${c.ref}(세금계산서, 거래처 ${mask(c.name)}, 금액 있음, 부가세 ${c.vat ? VAT_LABEL[c.vat] : '미정'}, 품목 ${c.item ? '있음' : '없음'})`).join('; ')}`
        : '화면: 열린 카드 없음';
      const nowBlock = `[지금]\n${frame}\n사용자: ${turn.user}`;
      const copyLine = `사본: ${this.copyState(copy, now)}`;
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
          // 한 턴(사용자 줄과 그 뒤 앱 줄)씩 버린다
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
        // 예산을 다 쓴 세션은 닫는다(다음 문장은 새 세션으로 간다)
        if (r.code === 'chat.budget_exceeded') s.turns = PHONE_SESSION_TURNS;
        throw new PhoneChatError(r.code);
      }
      turn.replay.push(...r.replay);
      if (!r.toolCalls.length) return this.checkReply(st, s, turn, r.output);
      // 다음 호출이 툴셋 턴 상한·replay 상한을 넘으면 도구를 실행하지 않는다(결과를 모델에 돌려줄 수 없다).
      const turns = turn.replay.filter((x) => 'item' in x && x.item.type !== 'reasoning').length;
      if (turns >= CHAT_PHONE_MAX_TURNS || turn.replay.length + r.toolCalls.length > REPLAY_MAX) {
        // 이번 턴에 이미 결과(표·카드)를 냈으면 끊지 않고 그 결과를 보인다. 모델이 답 대신 같은 도구를 거듭 부르다 상한에 닿는 일이 있다(PC chat-eval 2026-11-16).
        const show = [...new Set(turn.made)].slice(-AGENT_SHOW_MAX);
        if (show.length) return { kind: 'did', text: PHONE_NUMBER_TEXT, show, ask: null, filtered: 'number' };
        throw new PhoneChatError('chat.turn_limit');
      }
      for (const c of r.toolCalls) {
        const key = `${c.name}:${JSON.stringify(c.arguments)}`;
        // 같은 턴에 같은 도구를 같은 인자로 또 부르면 실행하지 않는다: 카드가 두 장 생기거나 같은 조회를 되풀이하지 않게.
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

  /** 도구 인자 역치환(PC 엔진 parseCall과 같다). 거래처가 레코드 하나로 풀리지 않거나 모르는 카드면 실행하지 않고 결과를 답한다. */
  private parseCall(st: State, s: Session, turn: Turn, c: PhoneToolCall): DomainCall | ToolOutput {
    // 토큰을 중괄호로 쓴 인자("{AMT_1}")는 대괄호 토큰으로 받는다(PC 엔진과 같다, chat-eval 2026-11-16)
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
      // 원 단위 양수로 읽히지 않으면("0원") 금액이 빈 것으로 본다: needs_input(amount)로 답해 모델이 다시 묻는다.
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
      invoice_history: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'invoice_history', counterpartyId: id };
      },
      receivables: () => {
        const id = a.counterparty === null ? null : cp(a.counterparty);
        return a.counterparty !== null && !id ? unknown(a.counterparty) : { tool: 'receivables', counterpartyId: id };
      },
      invoice_draft: () => {
        // 작성일자·수량·단가(ADR-049)는 1단계에서 PC만 계산한다. 폰은 카드를 만들지 않고 not_on_phone으로 답해 모델이 PC로 미룬다(defer).
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
    };
    if (!Object.hasOwn(parse, c.name)) throw bad();
    return parse[c.name]();
  }

  /** 풀리지 않은 거래처 인자가 사장님 이번 문장의 낱말인가(PC 엔진 typedName과 같다). 모델이 지어낸 이름은 싣지 않는다. */
  private typedName(s: Session, turn: Turn, v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (/^\[NAME_\d+\]$/.test(t)) {
      const raw = turn.user.includes(t) && !s.red.map.recordOf(t) ? s.red.map.valueOf(t)?.trim() : undefined;
      return raw && [...raw].length <= NAME_MAX ? raw : null;
    }
    return t && !/[[\]]/.test(t) && [...t].length <= NAME_MAX && turn.user.includes(t) ? t : null;
  }

  /** 사본 조회(발급 기록·받을 돈). 결과는 메모리에만 두고 ref로 가리킨다. */
  private lookup(st: State, copy: PhoneCopy | null, now: number, tool: 'invoice_history' | 'receivables', cpId: string | null): ToolOutput {
    if (!copy) return out('not_on_phone');
    const cp = cpId === null ? null : copy.counterparties.find((c) => c.id === cpId);
    if (cp === undefined) return out('unknown_counterparty');
    const all = tool === 'receivables' ? copy.receivables : copy.issued;
    if (!all) return out('not_on_phone');
    // 이름만 아는 옛 행(counterpartyId null)은 지금 사본 이름으로 맞춘다.
    const rows = newestFirst(cp ? all.filter((x) => x.counterpartyId === cp.id || (x.counterpartyId === null && x.counterparty === cp.name)) : all);
    if (!rows.length) return out('empty');
    const name = cp ? `${cp.name} ` : '';
    const ref = this.ref(st, 'r');
    this.results.set(ref, { kind: tool === 'receivables' ? 'receivables' : 'history', title: tool === 'receivables' ? `${name}입금 확인 전 ${tally(rows)}` : `${name}발급 기록 ${tally(rows)}`, rows, copy: this.copyState(copy, now) });
    if (this.results.size > RESULTS_MAX) this.results.delete(this.results.keys().next().value!);
    return { ref, status: 'ok', fields: [...SLOT_FIELDS], needs: null };
  }

  private exec(st: State, copy: PhoneCopy | null, now: number, call: DomainCall, turn: Turn): ToolOutput {
    switch (call.tool) {
      case 'invoice_history':
      case 'receivables':
        return this.lookup(st, copy, now, call.tool, call.counterpartyId);
      case 'invoice_draft': {
        const cp = copy?.counterparties.find((c) => c.id === call.counterpartyId);
        if (!cp) return out('unknown_counterparty');
        const amount = this.amount(call.amount);
        const item = (call.item === null ? null : cleanItem(call.item)) ?? cleanItem(cp.item ?? '');
        // 품목이 문장에도 거래처 저장 품목에도 없으면 만들지 않는다(PC와 같은 규칙).
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

  /** 금액 인자 → 원 단위 값. 합계 슬롯이면 그 금액은 부가세 포함이다. 채울 수 없으면 null. */
  private amount(a: DraftAmount): { value: number; vat: Vat | null } | null {
    if (a === null) return null;
    if ('value' in a) return validAmount(a.value) ? { value: a.value, vat: null } : null;
    const m = slotPattern.exec(a.slot);
    const field = m?.[2]!.split('.')[1];
    if (!m || (field !== 'supply' && field !== 'total')) return null;
    const v = this.slotValue(m[1]!, m[2]!);
    return typeof v === 'number' && validAmount(v) ? { value: v, vat: field === 'total' ? 'included' : null } : null;
  }

  /** 슬롯 경로의 값. 집계(sum)는 금액 모르는 행이 하나라도 있으면 null이다(일부만 더한 값을 합계라고 말하지 않는다). */
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
        // 아래 셋은 PC 대화에서 실제 모델로 찾은 실패를 고친 것과 같은 규칙이다(chat-eval 2026-11-16, PC 엔진 chat-agent.ts).
        // 사장님이 이번에 쓴 달·날짜는 따라 써도 거르지 않는다.
        userText: turn.user,
        // 되묻는 문장에 숫자가 섞이면 되묻기는 살리고 문장만 고정 문장으로 바꾼다.
        askText: (a) => PHONE_ASK_TEXT[a],
        // 틀린 슬롯("{d2.first.supply}")은 지어낸 값이 아니라 카드·표를 가리킨 것이다. 턴을 버리지 않고 이번 턴 결과를 고정 문장과 같이 보인다.
        // 카드를 만든 턴의 부가세는 묻지 않는다(기본값 별도, 카드에서 고친다).
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

  /** 턴을 닫는다: 토큰·슬롯을 값으로 채워 화면 문장을 만들고, 사용자 말과 답을 폰 구간에 적는다. */
  private async finish(st: State, s: Session, copy: PhoneCopy | null, now: number, said: string, turn: Turn, reply: CheckedReply<PhoneReplyKind, AgentAsk>): Promise<PhoneTurnResult> {
    const today = kstDate(now);
    const cpName = new Map((copy?.counterparties ?? []).map((c) => [c.id, c.name]));
    const valueOf = (tok: string): string | null => {
      const rec = s.red.map.recordOf(tok);
      const name = tok.startsWith('[NAME_') && rec?.startsWith('cp:') ? cpName.get(rec.slice(3)) : undefined;
      return name ?? s.red.map.valueOf(tok) ?? null;
    };
    const fillRe = new RegExp(`${TOKEN_RE.source}|${slotAnywhere().source}`, 'g');
    // TOKEN_RE의 묶음 둘(종류·번호) 뒤에 슬롯 묶음(ref·경로)이 온다
    let missing = false;
    let text = reply.text;
    // 컨텍스트용 문장: 토큰은 그대로, 슬롯은 금액이면 금액 토큰으로, 거래처면 이름 토큰으로, 날짜·건수·승인번호는 자리표시로 바꾼다(값이 모델에 가지 않게).
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
    // 문장 슬롯이 가리키는 결과는 모델이 show에 넣지 않아도 보인다: 답 문장의 값이 늘 같이 보이는 표에 있다.
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
    // 이번 턴에 만든 카드는 모델이 show에 넣지 않아도 보인다(카드가 사실이다).
    for (const ref of turn.created) card(ref);
    const name = reply.filtered ? undefined : turn.unknownName?.trim();
    const unknown = name && !copy?.counterparties.some((c) => c.name === name) ? { name, text: `${name}${finalOf(name) ? fixJosa(name, '은 폰에 받아 둔 거래처 목록에 없어요.') : '은(는) 폰에 받아 둔 거래처 목록에 없어요.'}` } : undefined;
    this.push(st, { from: 'user', text: said, ctx: capture(s.red, turn.user) ?? undefined });
    const app = this.push(st, { from: 'app', text, kind: reply.kind, ctx: capture(s.red, ctxText) ?? { t: PHONE_NUMBER_TEXT, e: {} } });
    await this.save(st);
    return {
      kind: 'reply',
      id: app.id,
      text,
      show,
      // 이번 턴에 카드를 만들었으면 부가세는 묻지 않는다(PC와 같다: 기본값으로 두고 승인 때 다시 본다).
      ask: reply.ask && !(reply.ask === 'vat' && turn.created.length > 0) ? { kind: reply.ask, chips: this.chips(st, copy, reply.ask) } : null,
      reply: reply.kind,
      filtered: reply.filtered,
      ...(unknown ? { unknown } : {}),
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

  // ── 접기 ──

  /**
   * [앞 대화]의 사용자 턴이 PHONE_TURNS_MAX를 넘으면 오래된 절반을 한꺼번에 요약으로 접는다(한 턴씩 밀면 매번 접두가 바뀌어 캐시를 못 쓴다).
   * 요약 호출이 실패하면 요약 없이 접기만 한다(앞 요약은 그대로 둔다).
   */
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
    // 슬롯은 옮기지 않는다(ref는 세션이 끝나면 뜻이 없다). 길면 문장 끝에서 자른다.
    let sum = o.summary.replace(/\{[^{}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
    if ([...sum].length > CHAT_DIGEST_MAX_CHARS) {
      const head = [...sum].slice(0, CHAT_DIGEST_MAX_CHARS).join('');
      const end = head.lastIndexOf('. ');
      // 잘린 토큰 조각("[NAME_")이 끝에 남지 않게 한다
      sum = (end > CHAT_DIGEST_MAX_CHARS / 2 ? head.slice(0, end + 1) : head).replace(/\[[A-Z]*(?:_\d*)?$/, '').trim();
    }
    // 요약은 보이지 않지만 다음 호출마다 다시 나간다. 식별자·링크·비밀 유도 말이 섞인 요약은 쓰지 않는다.
    if (!sum || unsafeText(sum.replace(TOKEN_RE, ' '))) throw new PhoneChatError('chat.bad_response');
    const m = capture(s.red, sum);
    if (!m) throw new PhoneChatError('chat.bad_response');
    return m;
  }
}
