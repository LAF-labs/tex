// 대화 에이전트 main 쪽(결정안 agent-chat-design-2026-11-12 §2, PR-3): 사용자 턴 하나의 도구 루프와 값 공간.
// 카드(초안)·조회 결과와 그 ref, 슬롯 채우기, 진행 표시를 맡는다. 마스킹은 엔진 chat.step이 하고, 토큰의 화면 값은 엔진이 답과 같이 준다(values).
// - 모델에 돌려주는 도구 결과는 ref·status·fields·needs뿐이다(C-10). 값·행·개수·이름은 화면 쪽 결과(AgentTurnResult)에만 실린다.
// - 초안 포트에는 준비·발급 메서드가 없다. 어떤 모델 출력으로도 run.prepare가 시작되지 않는다(발급은 카드 버튼 IPC 하나뿐).
// - 문장·토큰·값을 로그에 남기지 않는다.
import { draftDate, issueDateRule, lineSupply, parseQuantity } from '@sax/engine';
import { TurnRecorder } from '@sax/engine';
import type { AgentReply, DomainCall, DraftExtra, ReactionId, RouteStep, ScreenFrame, ShownReply, StepParams, StepResult, ToolOutput, TurnEvent, Vat } from '@sax/engine';
import { CHAT_ERROR_TEXT } from './chat-reply.ts';

/** 대화가 열 수 있는 앱 안 화면(@sax/chat-core OPEN_SCREENS) */
export type OpenScreen = Extract<DomainCall, { tool: 'open_screen' }>['screen'];
import { fillWithJosa, finalOf, fixJosa } from './josa.ts';
import { cleanItem, split } from './shell-model.ts';

type SlotField = NonNullable<ToolOutput['fields']>[number];
type ToolNeed = NonNullable<ToolOutput['needs']>[number];
export type AgentAsk = NonNullable<AgentReply['ask']>;
export type AgentPhase = 'thinking' | 'reading' | 'drafting';

// 데스크톱은 @sax/model·@sax/redaction에 의존하지 않아 값을 옮겨 둔다. 시험(agent-chat-main)이 원본과 대조한다.
export const SLOT_FIELDS = ['date', 'supply', 'total', 'counterparty', 'approvalNo'] as const satisfies readonly SlotField[];
export const SLOT_POSITIONS = ['first', 'last'] as const;
export const SLOT_SUM_FIELDS = ['supply', 'total'] as const;
/** 돈 흐름 결과의 칸({r#.cash.*}). @sax/model CASH_FIELDS와 같다(시험이 대조). */
export const CASH_FIELDS = ['in', 'out', 'net', 'balance', 'next_in', 'next_out'] as const;
export type CashField = (typeof CASH_FIELDS)[number];
/** 슬롯 경로: 행 값(first·last × 칸), 집계(sum.supply·sum.total·count), 돈 흐름(cash.*). @sax/model SLOT_PATHS와 같다(시험이 대조). */
export const SLOT_PATHS: readonly string[] = [
  ...SLOT_POSITIONS.flatMap((p) => SLOT_FIELDS.map((f) => `${p}.${f}`)),
  ...SLOT_SUM_FIELDS.map((f) => `sum.${f}`),
  'count',
  ...CASH_FIELDS.map((f) => `cash.${f}`),
];
export const CHAT_MAP_IDLE_MS = 15 * 60 * 1000;
/** 엔진 토큰([NAME_1] 등). @sax/redaction TOKEN_RE와 같은 꼴이다. */
const TOKEN_RE = /\[[A-Z]+_\d+\]/;
const SLOT_RE = new RegExp(`\\{(r[1-9]\\d{0,5})\\.(${SLOT_PATHS.map((x) => x.replace('.', '\\.')).join('|')})\\}`, 'g');
/** 엔진 화면 프레임 상한(cards maxItems) */
const FRAME_MAX = 12;
/** 한 사용자 턴의 chat.step 호출 상한. 엔진 턴 상한(4)과 따로 둔 이중 방어다. */
export const AGENT_STEP_MAX = 6;
const AMOUNT_MAX = 1e12;
const CHIP_CP_MAX = 8;

export const AGENT_SETUP_TEXT = '대화로 일을 맡기려면 내 사업장 정보가 먼저 있어야 해요. 설정 > 내 사업장에서 등록해 주세요.';
/** 돈 흐름 칸 중 확인 못 한 값(잔액을 모르는 계좌 등)을 물었을 때. 모르는 것을 0으로 말하지 않는다(11 §3.4). */
export const AGENT_CASH_MISSING_TEXT = '거래내역이 모자라서 그 값은 아직 몰라요. 계좌 거래내역을 더 가져오면 알려 드릴게요.';
/** 채울 값이 없는 슬롯이 있으면 문장 전체를 이것으로 바꾼다(값을 지어내지 않는다). */
export const AGENT_SLOT_MISSING_TEXT = '정확한 값은 아래 표에 있어요.';

/** 모델 답을 받지 못했다(U8-5). 원인(인터넷·서버·모델)을 단정하지 않는다. */
export const AGENT_UNAVAILABLE_TEXT = '답을 받지 못했어요. 잠시 뒤 [다시 시도]를 눌러 주세요.';

/** chat.* 오류 → 대화 문장과 [다시 시도]. 표에 없는 코드는 chat.unavailable로 접는다. */
export const AGENT_ERROR_TEXT: Record<string, { text: string; retry: boolean }> = {
  ...CHAT_ERROR_TEXT,
  'chat.unavailable': { text: AGENT_UNAVAILABLE_TEXT, retry: true },
  'chat.bad_response': { text: AGENT_UNAVAILABLE_TEXT, retry: true },
  'chat.turn_limit': { text: '한 번에 하기엔 일이 많아요. 하나씩 나눠서 말씀해 주세요.', retry: false },
  'chat.bad_tool_output': { text: AGENT_UNAVAILABLE_TEXT, retry: true },
  bad_text: CHAT_ERROR_TEXT['chat.input_too_large'],
};

export interface DraftCard {
  runId: string;
  counterpartyId: string;
  amount: number | null;
  /** 정하지 않았으면(추정) null */
  vat: Vat | null;
  item: string | null;
  /** RunView.status. 'draft'만 고치고 취소할 수 있다. */
  status: string;
}

/** 카드의 작성일자(KST YYYY-MM-DD, 오늘이면 없음)와 수량·단가(ADR-049). 공급가액은 amount에 곱한 값이 이미 들어 있다. */
export interface DraftExtraValues {
  writeDate?: string;
  quantity?: number;
  unitPrice?: number;
}
export type DraftPatch = { amount?: number; vat?: Vat; item?: string } & DraftExtraValues;

/** shell-runs 위의 좁은 포트. 준비·발급 메서드는 일부러 없다. */
export interface AgentDrafts {
  list(): DraftCard[];
  /** 내 사업장·발급 인증이 빠졌는가. 금액·품목을 묻기 전에 본다(물어 놓고 끝에 등록이 빠졌다고 하지 않게). */
  setupMissing(): boolean;
  /** 내 사업장 등록이 빠졌으면 { setup: true }(초안을 만들지 않는다) */
  create(counterpartyId: string, amount: number, vat: Vat | null, item: string | null, extra?: DraftExtraValues): { runId: string } | { setup: true };
  update(runId: string, patch: DraftPatch): void;
  discard(runId: string): void;
}

/** 메일: sent(받는 사람 발송 확인), unconfirmed(확인 못 함), null(기록 없음·받을 돈 행). */
export type MailState = 'sent' | 'unconfirmed' | null;

export interface IssuedRow {
  counterpartyId: string | null;
  counterparty: string;
  /** KST YYYY-MM-DD */
  date: string;
  total: number | null;
  /** 원장(irreversible_log committed)의 승인번호. 화면에만 보이고 모델에는 가지 않는다. */
  approvalNo?: string | null;
  /** 문서함 PDF 문서 id([PDF 열기]). */
  documentId?: string | null;
  mail?: MailState;
}
/**
 * 받을 돈 행. 지금은 발급 행과 같은 꼴이다.
 * #284(BankHost.receivables())가 들어오면 행에 status 'unpaid'|'unknown'을 붙이고 receivables 포트를 그 포트에 잇는다(입금 대조가 안 된 행을 미수라고 단정하지 않게).
 */
export type ReceivableRow = IssuedRow;

/**
 * 돈 흐름 한 달의 값(BankHost.cashFlowBrief를 줄인 것, 11 §3). 화면·슬롯에만 쓰고 모델에는 ref·status만 간다.
 * complete false: 그달을 다 덮지 못한 계좌가 있다(값은 확인된 것만). null: 모르는 값(0으로 세지 않는다).
 */
export interface CashFlowValues {
  complete: boolean;
  /** 그달 값이 덮는 마지막 날(KST YYYY-MM-DD) */
  through: string;
  in: number;
  out: number;
  net: number;
  balance: number | null;
  nextIn: number;
  nextOut: number;
}
export interface AgentCounterparty {
  id: string;
  name: string;
  /** 거래처 저장 품목(없으면 null). 품목 없는 초안을 만들지 않는 데 쓴다. */
  item: string | null;
}

export interface AgentChatPorts {
  /** 엔진 rpc 'chat.step'. 오류는 message(또는 code)가 chat.* 코드다. */
  step(p: StepParams): Promise<StepResult>;
  /** 사업자 프로필 id. null이면 엔진을 부르지 않고 고정 안내를 답한다. */
  profileId(): string | null;
  drafts: AgentDrafts;
  issued(): IssuedRow[] | Promise<IssuedRow[]>;
  /** null이면 계좌 연결 전(not_set_up) */
  receivables(): Promise<ReceivableRow[] | null>;
  /** 낼 돈(받은 매입 세금계산서 중 아직 내지 않은 것, 11 §2). null이면 계좌 연결 전. 없으면 not_set_up. */
  payables?(): Promise<ReceivableRow[] | null>;
  /** 돈 흐름(month YYYY-MM). null이면 계좌 연결 전. 없으면 not_set_up. */
  cashFlow?(month: string): Promise<CashFlowValues | null>;
  counterparties(): AgentCounterparty[];
  /** KST YYYY-MM-DD */
  today(): string;
  onProgress(phase: AgentPhase): void;
  /**
   * 엔진 rpc 'chat.route'(ADR-056): chat.step 앞의 판정. 없거나 던지면 판정 없이 늘 하던 대로 돈다.
   * reaction_only면 반응 하나로 턴을 닫고(chat.step을 부르지 않는다), react_then_work면 반응을 먼저 달고 도구 루프를 돈다.
   */
  route?(p: { text: string; frame: ScreenFrame; profileId: string }): Promise<RouteStep>;
  /** 사용자 말풍선에 반응을 단다(턴 이벤트 reaction). 이 턴의 사용자 말에 붙는다. */
  onReaction?(reaction: ReactionId): void;
  /** 턴 이벤트(ADR-054). 화면·평가·운영 신호가 듣는다. 기기 밖으로 내보내지 않는다. */
  onEvent?(e: TurnEvent): void;
  /** 턴·메시지 id(ULID). 없으면 시각과 순번으로 만든다. */
  newId?(): string;
  /** 대화가 고른 앱 안 화면을 연다(open_screen). 렌더러가 답을 그린 뒤 그 화면으로 간다. */
  openScreen?(screen: OpenScreen): void;
  now?: () => number;
}

export type ResultKind = 'sales' | 'history' | 'receivables' | 'payables' | 'cash_flow';
export interface TableRow {
  date: string;
  counterparty: string;
  total: number | null;
  approvalNo: string | null;
  documentId: string | null;
  mail: MailState;
}
export type AgentShow = { type: 'card'; runId: string } | { type: 'table'; table: ResultKind; title: string; rows: TableRow[] };
export type AgentTurnResult =
  /** setup: 이 턴에 내 사업장·발급 인증이 빠져 카드를 못 만들었다(화면이 등록 버튼을 둔다). */
  /** unknown: 사장님이 쓴 거래처 이름이 장부에 없다(U8-1). 화면은 text와 그 이름으로 [거래처 추가]를 둔다. */
  | { kind: 'agent'; text: string; show: AgentShow[]; ask: null | { kind: AgentAsk; chips: Array<{ label: string; text: string }> }; filtered: AgentReply['filtered']; setup?: true; unknown?: { name: string; text: string } }
  | { kind: 'unavailable'; code: string; text: string; retry: boolean }
  /** 판정이 반응만 하라고 했다(ADR-056). 답 문장이 없다. 화면은 사용자 말풍선에 반응을 달고 점 셋을 거둔다. */
  | { kind: 'reaction'; reaction: ReactionId };

interface Result {
  kind: ResultKind;
  title: string;
  rows: IssuedRow[];
  /** 돈 흐름 결과(kind 'cash_flow')만 */
  cash?: CashFlowValues;
}
const CASH_KEY: Record<CashField, Exclude<keyof CashFlowValues, 'complete'>> = { in: 'in', out: 'out', net: 'net', balance: 'balance', next_in: 'nextIn', next_out: 'nextOut' };

/** 대화 세션(엔진 세션과 같은 기준으로 끝난다). ref 번호는 세션이 바뀌어도 이어 간다: 엔진 대화록에 남은 옛 ref가 새 결과를 가리키지 않게. */
interface Session {
  profileId: string;
  lastAt: number;
  results: Map<string, Result>;
  refOfRun: Map<string, string>;
  runOfRef: Map<string, string>;
  /** 이번 차례에 사장님이 쓴 문장(미래 날짜 말 확인용, ADR-049) */
  said?: string;
}

/**
 * 사장님이 미래 작성일자를 말했다("다음 달 1일자로", "내일 날짜로"). 모델이 날짜를 비우거나 이번 달로 바꿔 넣어도(parasail date-future)
 * 기기가 받지 않고 날짜를 되묻는다. 작성일자는 오늘이나 지난 날만 된다.
 */
const FUTURE_DATE_SAID = /(?:다음\s?달|담달|내달|다음\s?주|내년|다음\s?해)\s*(?:\d{1,2}\s*일|말일?|초|중순|말경)|(?:^|[^가-힣])(?:내일|모레)\s*(?:날짜|자|일자)/u;

const TOOL_PHASE: Record<DomainCall['tool'], Exclude<AgentPhase, 'thinking'>> = {
  sales_summary: 'reading',
  invoice_history: 'reading',
  receivables: 'reading',
  payables: 'reading',
  cash_flow: 'reading',
  invoice_draft: 'drafting',
  draft_edit: 'drafting',
  draft_discard: 'drafting',
  open_screen: 'reading',
};

const out = (status: ToolOutput['status'], ref: string | null = null, needs: ToolNeed[] | null = null): ToolOutput => ({ ref, status, fields: null, needs });
const won = (n: number) => `${n.toLocaleString('en-US')}원`;
const validAmount = (n: number) => Number.isInteger(n) && n > 0 && n <= AMOUNT_MAX;
const supplyOf = (total: number) => split(total, 'included').supply;
/** 행 금액의 합(공급가는 행마다 나눈 값을 더한다: 표의 행과 같은 값). 금액 모르는 행이 있으면 null. */
const sumOf = (rows: ReadonlyArray<{ total: number | null }>, field: 'supply' | 'total'): number | null =>
  rows.some((r) => r.total === null) ? null : rows.reduce((a, r) => a + (field === 'total' ? r.total! : supplyOf(r.total!)), 0);
/**
 * 표 제목의 건수·합계. 슬롯({r#.count}·{r#.sum.*})과 같은 sumOf로 낸다: 답 문장의 값이 표 제목에 그대로 있다.
 * 금액 모르는 행이 있으면 아는 행만 더하고 그렇다고 적는다(슬롯 합계는 그때 비어 문장이 표를 보라는 말로 바뀐다).
 */
function tally(rows: ReadonlyArray<{ total: number | null }>): string {
  const known = rows.filter((x) => x.total !== null);
  const gap = rows.length - known.length;
  return `${rows.length}건 · 공급가 ${won(sumOf(known, 'supply')!)} · 합계 ${won(sumOf(known, 'total')!)}${gap ? `(금액 모르는 ${gap}건 빼고)` : ''}`;
}

/** today(KST YYYY-MM-DD)에서 offset달 옮긴 달의 YYYY-MM */
export function monthOf(today: string, offset: number): string {
  const n = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + offset;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}

/** 날짜는 "10월 15일", 올해가 아니면 "2025년 12월 3일" */
export function koDate(date: string, today: string): string {
  const md = `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
  return date.slice(0, 4) === today.slice(0, 4) ? md : `${Number(date.slice(0, 4))}년 ${md}`;
}

/** 화면 표 한 줄. 승인번호·PDF·메일은 원장·문서함 값이고 화면에만 간다(엔진·모델에는 ref와 슬롯 집계만 간다). */
const tableRow = (x: IssuedRow): TableRow => ({ date: x.date, counterparty: x.counterparty, total: x.total, approvalNo: x.approvalNo ?? null, documentId: x.documentId ?? null, mail: x.mail ?? null });
const newestFirst = <T extends { date: string }>(rows: T[]) => [...rows].sort((a, b) => b.date.localeCompare(a.date));

export class AgentChat {
  private readonly ports: AgentChatPorts;
  private session: Session | null = null;
  private seq = 0;
  private turns = 0;

  constructor(ports: AgentChatPorts) {
    this.ports = ports;
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  async turn(text: string): Promise<AgentTurnResult> {
    const profileId = this.ports.profileId();
    if (!profileId) return { kind: 'agent', text: AGENT_SETUP_TEXT, show: [], ask: null, filtered: null, setup: true };
    const s = this.open(profileId);
    s.said = text;
    const created: string[] = [];
    this.ports.onProgress('thinking');
    const n = ++this.turns;
    const id = () => this.ports.newId?.() ?? `t${this.now().toString(36)}${n}`;
    const rec = new TurnRecorder(id(), () => this.now(), this.ports.onEvent);
    const msgId = id();
    rec.emit({ type: 'turn.start', device: 'pc', msgId });
    const end = (r: AgentTurnResult): AgentTurnResult => {
      rec.emit(r.kind === 'unavailable' ? { type: 'turn.end', status: 'failed', code: r.code } : { type: 'turn.end', status: 'completed' });
      return r;
    };
    // 판정(ADR-056): 받는 방식만 정한다. 실패하면 판정 없이 늘 하던 대로(막는 문이 아니다).
    if (this.ports.route) {
      let route: RouteStep | null = null;
      try {
        s.lastAt = this.now();
        route = await this.ports.route({ text, frame: this.frame(s), profileId });
        s.lastAt = this.now();
      } catch (e) {
        const err = e as { code?: unknown; message?: unknown } | null;
        const code = [err?.code, err?.message].find((c): c is string => typeof c === 'string' && Object.hasOwn(AGENT_ERROR_TEXT, c));
        // 나쁜 입력(비밀 모양·너무 긴 문장)은 chat.step도 똑같이 막으니 여기서 바로 답한다
        if (code === 'chat.secret_rejected' || code === 'bad_text' || code === 'chat.input_too_large') return end({ kind: 'unavailable', code, ...AGENT_ERROR_TEXT[code]! });
      }
      if (route) {
        rec.emit({ type: 'route', act: route.act, domain: route.domain, mode: route.mode, band: route.band, unsure: route.unsure, failed: route.failed });
        if (route.reaction && route.mode !== 'answer') {
          rec.emit({ type: 'reaction', msgId, reaction: route.reaction });
          this.ports.onReaction?.(route.reaction);
        }
        if (route.mode === 'reaction_only' && route.reaction) {
          rec.emit({ type: 'path', path: 'reaction', tools: [] });
          return end({ kind: 'reaction', reaction: route.reaction });
        }
      }
    }
    rec.emit({ type: 'path', path: 'tools', tools: [] });
    return end(await this.loop(s, text, profileId, created, rec));
  }

  private async loop(s: Session, text: string, profileId: string, created: string[], rec: TurnRecorder): Promise<AgentTurnResult> {
    let phase: AgentPhase = 'thinking';
    let setup = false;
    try {
      let steps = 0;
      const step = async (p: StepParams) => {
        if (++steps > AGENT_STEP_MAX) throw new Error('chat.turn_limit');
        s.lastAt = this.now();
        const r = await this.ports.step(p);
        s.lastAt = this.now();
        return r;
      };
      let r = await step({ start: { text, frame: this.frame(s), profileId } });
      while (r.kind === 'tools') {
        const outputs: Array<{ callId: string; output: ToolOutput }> = [];
        for (const { callId, ...call } of r.calls) {
          if (TOOL_PHASE[call.tool] !== phase) this.ports.onProgress((phase = TOOL_PHASE[call.tool]));
          rec.emit({ type: 'tool.start', tool: call.tool, args: {} });
          const output = await this.exec(s, call, created);
          rec.emit({ type: 'tool.end', tool: call.tool, status: output.status, ref: output.ref, runId: null });
          if (output.status === 'setup_missing') setup = true;
          outputs.push({ callId, output });
        }
        r = await step({ continue: { outputs } });
      }
      const shown = this.shown(s, r.reply, created);
      return setup && shown.kind === 'agent' ? { ...shown, setup: true } : shown;
    } catch (e) {
      const err = e as { code?: unknown; message?: unknown } | null;
      const code = [err?.code, err?.message].find((c): c is string => typeof c === 'string' && Object.hasOwn(AGENT_ERROR_TEXT, c)) ?? 'chat.unavailable';
      return { kind: 'unavailable', code, ...AGENT_ERROR_TEXT[code]! };
    }
  }

  /** 엔진 세션과 같이 끝낸다: 프로필이 바뀌거나 CHAT_MAP_IDLE_MS 쉬었으면 결과·카드 ref를 버린다. */
  private open(profileId: string): Session {
    const t = this.now();
    const s = this.session;
    if (s && s.profileId === profileId && t - s.lastAt <= CHAT_MAP_IDLE_MS) return s;
    this.session = { profileId, lastAt: t, results: new Map(), refOfRun: new Map(), runOfRef: new Map() };
    return this.session;
  }

  private ref(kind: 'r' | 'd'): string {
    return `${kind}${++this.seq}`;
  }

  private cardRef(s: Session, runId: string): string {
    let ref = s.refOfRun.get(runId);
    if (!ref) {
      ref = this.ref('d');
      s.refOfRun.set(runId, ref);
      s.runOfRef.set(ref, runId);
    }
    return ref;
  }

  /** 열린 초안 카드(최근 FRAME_MAX장). 장부에 없는 거래처의 카드는 엔진이 프레임 전체를 거부하므로 뺀다. */
  private openCards(book: AgentCounterparty[]): Array<DraftCard & { name: string }> {
    const names = new Map(book.map((c) => [c.id, c.name]));
    return this.ports.drafts
      .list()
      .filter((d) => d.status === 'draft' && names.has(d.counterpartyId))
      .slice(-FRAME_MAX)
      .map((d) => ({ ...d, name: names.get(d.counterpartyId)! }));
  }

  private frame(s: Session): ScreenFrame {
    return { cards: this.openCards(this.ports.counterparties()).map((d) => ({ ref: this.cardRef(s, d.runId), counterpartyId: d.counterpartyId, amount: d.amount !== null, vat: d.vat, item: !!d.item })) };
  }

  private remember(s: Session, r: Result): ToolOutput {
    if (!r.rows.length) return out('empty');
    const ref = this.ref('r');
    s.results.set(ref, r);
    return { ref, status: 'ok', fields: [...SLOT_FIELDS], needs: null };
  }

  private async exec(s: Session, call: DomainCall, created: string[]): Promise<ToolOutput> {
    const book = this.ports.counterparties();
    const cpOf = (id: string | null) => (id === null ? null : book.find((c) => c.id === id));
    switch (call.tool) {
      case 'sales_summary': {
        const month = monthOf(this.ports.today(), call.monthOffset);
        const rows = newestFirst((await this.ports.issued()).filter((x) => x.date.startsWith(`${month}-`)));
        return this.remember(s, { kind: 'sales', title: `${Number(month.slice(5))}월 발급 ${tally(rows)}`, rows });
      }
      case 'invoice_history':
      case 'receivables':
      case 'payables': {
        const cp = cpOf(call.counterpartyId);
        if (cp === undefined) return out('unknown_counterparty');
        const all = call.tool === 'receivables' ? await this.ports.receivables() : call.tool === 'payables' ? await (this.ports.payables?.() ?? null) : await this.ports.issued();
        if (!all) return out('not_set_up');
        // 이름만 아는 옛 행(counterpartyId null)은 지금 장부 이름으로 맞춘다.
        const rows = newestFirst(cp ? all.filter((x) => x.counterpartyId === cp.id || (x.counterpartyId === null && x.counterparty === cp.name)) : all);
        const name = cp ? `${cp.name} ` : '';
        const title = call.tool === 'receivables' ? `${name}입금 확인 전 ${tally(rows)}` : call.tool === 'payables' ? `${name}안 낸 돈 ${tally(rows)}` : `${name}발급 기록 ${tally(rows)}`;
        return this.remember(s, { kind: call.tool === 'invoice_history' ? 'history' : call.tool, title, rows });
      }
      case 'cash_flow': {
        const month = monthOf(this.ports.today(), call.monthOffset);
        const cash = await (this.ports.cashFlow?.(month) ?? null);
        if (!cash) return out('not_set_up');
        const ref = this.ref('r');
        // 화면 표는 칸 하나가 한 줄이다(답 문장의 값이 늘 같이 보이는 표에 있게). 행 슬롯은 쓰지 않는다(slotValue).
        const today = this.ports.today();
        const line = (counterparty: string, total: number | null, date: string): IssuedRow => ({ counterpartyId: null, counterparty, date, total });
        const rows = [
          line('들어온 돈', cash.in, cash.through),
          line('나간 돈', cash.out, cash.through),
          line('차이', cash.net, cash.through),
          line('지금 잔액', cash.balance, today),
          line('앞으로 한 달 받을 돈', cash.nextIn, today),
          line('앞으로 한 달 낼 돈', cash.nextOut, today),
        ];
        s.results.set(ref, { kind: 'cash_flow', title: `${Number(month.slice(5))}월 돈 흐름${cash.complete ? '' : '(일부 계좌 거래내역이 모자라 확인된 것만)'}`, rows, cash });
        // 그달을 다 덮지 못한 계좌가 있으면 partial: 모델은 "일부 계좌 거래내역이 모자라 확인 못 함"을 같이 말한다(11 §3.4)
        return { ref, status: cash.complete ? 'ok' : 'partial', fields: null, needs: null };
      }
      case 'invoice_draft': {
        const cp = cpOf(call.counterpartyId);
        if (!cp) return out('unknown_counterparty');
        if (this.ports.drafts.setupMissing()) return out('setup_missing');
        const ex = this.extra(s, call);
        const amount = ex.line ? (ex.line === 'bad' ? null : { value: ex.line.supply, vat: ex.line.vat }) : this.amount(s, call.amount);
        const item = call.item === null ? null : cleanItem(call.item);
        // 품목이 문장에도 거래처 저장 품목에도 없으면 만들지 않는다. 빈 품목 초안은 준비에서야 item_missing으로 멈춘다(interpret와 같은 규칙).
        const needs: ToolNeed[] = [...(amount ? [] : ['amount' as const]), ...(item || cleanItem(cp.item ?? '') ? [] : ['item' as const]), ...(ex.date === 'bad' ? ['date' as const] : [])];
        if (needs.length) return out('needs_input', null, needs);
        const r = this.ports.drafts.create(cp.id, amount!.value, call.vat ?? amount!.vat, item, {
          ...(ex.date && ex.date !== this.ports.today() ? { writeDate: ex.date as string } : {}),
          ...(ex.line && ex.line !== 'bad' ? { quantity: ex.line.quantity, unitPrice: ex.line.unitPrice } : {}),
        });
        if ('setup' in r) return out('setup_missing');
        created.push(r.runId);
        return out('card_shown', this.cardRef(s, r.runId));
      }
      case 'open_screen': {
        // 앱 안 화면을 연다(발급 인증·계좌 연결·기기 연결 등). 값은 사장님이 그 화면에 넣는다. 열 곳이 없으면(시험 대역) 그래도 opened로 닫는다.
        this.ports.openScreen?.(call.screen);
        return out('opened');
      }
      case 'draft_edit':
      case 'draft_discard': {
        const runId = s.runOfRef.get(call.draft);
        const card = runId === undefined ? undefined : this.ports.drafts.list().find((d) => d.runId === runId);
        if (!card) return out('no_such_draft');
        const ref = call.draft;
        if (card.status !== 'draft') return out('not_editable', ref);
        if (call.tool === 'draft_discard') {
          try {
            this.ports.drafts.discard(card.runId);
          } catch {
            return out('not_editable', ref);
          }
          return out('discarded', ref);
        }
        const patch: DraftPatch = {};
        const needs: ToolNeed[] = [];
        const ex = this.extra(s, call);
        if (ex.date === 'bad') needs.push('date');
        else if (ex.date) patch.writeDate = ex.date;
        if (ex.line === 'bad') needs.push('amount');
        else if (ex.line) {
          patch.amount = ex.line.supply;
          patch.quantity = ex.line.quantity;
          patch.unitPrice = ex.line.unitPrice;
          if (ex.line.vat) patch.vat = ex.line.vat;
        } else if (call.amount !== null) {
          const a = this.amount(s, call.amount);
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
        if (needs.length || !Object.keys(patch).length) return out('needs_input', ref, needs.length ? needs : null);
        try {
          this.ports.drafts.update(card.runId, patch);
        } catch {
          // 목록을 읽은 뒤 준비가 시작됐으면 shell-runs가 not_draft로 거부한다
          return out('not_editable', ref);
        }
        return out('card_updated', ref);
      }
    }
  }

  /** 금액 인자 → 원 단위 값. 합계 슬롯이면 그 금액은 부가세 포함이다. 채울 수 없으면 null. */
  /**
   * 작성일자·수량×단가(ADR-049). 날짜는 KST 오늘에서 계산하고 규칙(미래·지난 과세기간)에 걸리면 'bad'(되묻기 date).
   * 수량과 단가가 둘 다 있으면 공급가액 = 수량 × 단가. 하나만 있거나 정수가 아니거나 amount와 곱이 다르면 'bad'(되묻기 amount).
   */
  private extra(s: Session, call: Extract<DomainCall, { tool: 'invoice_draft' | 'draft_edit' }>): { date: string | null | 'bad'; line: { supply: number; quantity: number; unitPrice: number; vat: Vat | null } | null | 'bad' } {
    const today = this.ports.today();
    const d = call.date ? draftDate(today, call.date.monthOffset, call.date.day) : null;
    const rule = d === null || d === 'bad' ? null : issueDateRule(d, today);
    const futureSaid = FUTURE_DATE_SAID.test(s.said ?? '') && (call.tool === 'invoice_draft' || call.date);
    const date = rule === 'future' || rule === 'past_period' || futureSaid ? 'bad' : d;
    const q = (call as DraftExtra).quantity ?? null;
    const u = (call as DraftExtra).unitPrice ?? null;
    if (q === null && u === null) return { date, line: null };
    const quantity = parseQuantity(q);
    const unit = this.amount(s, u);
    const supply = quantity !== null && unit ? lineSupply(quantity, unit.value) : null;
    const given = call.amount === null ? null : this.amount(s, call.amount);
    if (supply === null || !unit || quantity === null || (given && given.value !== supply)) return { date, line: 'bad' };
    return { date, line: { supply, quantity, unitPrice: unit.value, vat: unit.vat } };
  }

  private amount(s: Session, a: Extract<DomainCall, { tool: 'invoice_draft' }>['amount']): { value: number; vat: Vat | null } | null {
    if (a === null) return null;
    if ('value' in a) return validAmount(a.value) ? { value: a.value, vat: null } : null;
    const m = new RegExp(`^${SLOT_RE.source}$`).exec(a.slot);
    const field = m?.[2]!.split('.')[1];
    if (!m || (field !== 'supply' && field !== 'total')) return null;
    const v = this.slotValue(s, m[1]!, m[2]!);
    return typeof v === 'number' && validAmount(v) ? { value: v, vat: field === 'total' ? 'included' : null } : null;
  }

  /** 슬롯 경로의 값. 집계(sum)는 금액 모르는 행이 하나라도 있으면 null이다(일부만 더한 값을 합계라고 말하지 않는다). */
  private slotValue(s: Session, ref: string, path: string): number | string | null {
    const res = s.results.get(ref);
    if (path.startsWith('cash.')) return res?.cash ? res.cash[CASH_KEY[path.slice(5) as CashField]] : null;
    // 돈 흐름 결과에는 행이 없다(행 슬롯은 채우지 않는다)
    const rows = res && !res.cash ? res.rows : undefined;
    if (!rows) return null;
    if (path === 'count') return rows.length;
    const [pos, field] = path.split('.') as [string, string];
    if (pos === 'sum') return sumOf(rows, field as 'supply' | 'total');
    const row = pos === 'first' ? rows[0] : rows.at(-1);
    if (!row) return null;
    if (field === 'date') return row.date;
    if (field === 'counterparty') return row.counterparty;
    // 승인번호는 원장 committed 값만(없으면 채우지 않는다: 지어내지 않는다)
    if (field === 'approvalNo') return row.approvalNo ?? null;
    if (row.total === null) return null;
    return field === 'total' ? row.total : supplyOf(row.total);
  }

  /** 토큰은 엔진이 준 화면 값으로, 슬롯은 결과 값으로 바꾸고 바꾼 값 바로 뒤 조사를 받침에 맞춘다. */
  private fill(s: Session, reply: ShownReply): string {
    const today = this.ports.today();
    let missing = false;
    let cashMissing = false;
    const filled = fillWithJosa(reply.text, new RegExp(`${TOKEN_RE.source}|${SLOT_RE.source}`, 'g'), (m) => {
      if (m[1] === undefined) return reply.values[m[0]] ?? null;
      const v = this.slotValue(s, m[1], m[2]!);
      if (v === null) {
        if (m[2]!.startsWith('cash.') && s.results.get(m[1])?.cash) cashMissing = true;
        else missing = true;
        return '';
      }
      return m[2] === 'count' ? String(v) : typeof v === 'number' ? won(v) : m[2]!.endsWith('.date') ? koDate(v, today) : v;
    });
    return missing ? AGENT_SLOT_MISSING_TEXT : cashMissing ? AGENT_CASH_MISSING_TEXT : filled;
  }

  private shown(s: Session, reply: ShownReply, created: string[]): AgentTurnResult {
    const show: AgentShow[] = [];
    const cards = new Set<string>();
    // 문장 슬롯이 가리키는 결과는 모델이 show에 넣지 않아도 보인다: 답 문장의 값이 늘 같이 보이는 표에 있다.
    // 'repeat'·'closed'는 엔진이 쓴 문장이라 토큰·슬롯이 맞다(조회 되풀이의 건수·합계, 카드의 거래처·금액). 다른 걸러진 답은 쓰지 않는다.
    const slotted = !reply.filtered || reply.filtered === 'repeat' || reply.filtered === 'closed';
    const slotRefs = slotted ? [...reply.text.matchAll(SLOT_RE)].map((m) => m[1]!) : [];
    for (const ref of [...new Set([...reply.show, ...slotRefs])]) {
      const res = s.results.get(ref);
      const runId = s.runOfRef.get(ref);
      if (res) show.push({ type: 'table', table: res.kind, title: res.title, rows: res.rows.map(tableRow) });
      else if (runId && !cards.has(runId)) {
        cards.add(runId);
        show.push({ type: 'card', runId });
      }
    }
    // 이번 턴에 만든 카드는 모델이 show에 넣지 않아도 보인다(카드가 사실이다).
    for (const runId of created) if (!cards.has(runId)) show.push({ type: 'card', runId });
    const name = reply.unknownName?.trim();
    // 장부에 이미 있는 이름이면(모델이 다른 토큰을 썼다) 안내하지 않는다
    const unknown = name && !this.ports.counterparties().some((c) => c.name === name) ? { name, text: `${name}${finalOf(name) ? fixJosa(name, '은 거래처 목록에 없어요.') : '은(는) 거래처 목록에 없어요.'}` } : null;
    return {
      kind: 'agent',
      text: slotted ? this.fill(s, reply) : reply.text,
      show,
      // 이번 턴에 초안을 만들었으면 부가세는 묻지 않는다: 기본값(별도)으로 바로 준비하고 승인 카드에서 다시 본다(대표 실사용 2026-11-14).
      // 진짜 빠진 값(금액·거래처)만 묻는다.
      ask: reply.ask && !(reply.ask === 'vat' && created.length > 0) ? { kind: reply.ask, chips: this.chips(reply.ask) } : null,
      filtered: reply.filtered,
      ...(unknown ? { unknown } : {}),
    };
  }

  private chips(ask: AgentAsk): Array<{ label: string; text: string }> {
    const book = this.ports.counterparties();
    if (ask === 'counterparty') return book.slice(0, CHIP_CP_MAX).map((c) => ({ label: c.name, text: c.name }));
    if (ask === 'vat') return [{ label: '별도', text: '부가세 별도로' }, { label: '포함', text: '부가세 포함으로' }];
    if (ask === 'which_card') {
      // 화면 프레임과 같은 순서라 모델은 "N번째 카드"를 프레임의 N번째 ref로 읽는다.
      return this.openCards(book).map((d, i) => {
        const label = `${d.name}${d.amount !== null ? ` ${won(d.amount)}` : ''}`;
        return { label, text: `${i + 1}번째 카드(${label})` };
      });
    }
    return [];
  }
}
