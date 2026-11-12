// 대화 에이전트 main 쪽(결정안 agent-chat-design-2026-11-12 §2, PR-3): 사용자 턴 하나의 도구 루프와 값 공간.
// 카드(초안)·조회 결과와 그 ref, 슬롯 채우기, 진행 표시를 맡는다. 토큰은 모른다(마스킹·역치환은 엔진 chat.step).
// - 모델에 돌려주는 도구 결과는 ref·status·fields·needs뿐이다(C-10). 값·행·개수·이름은 화면 쪽 결과(AgentTurnResult)에만 실린다.
// - 초안 포트에는 준비·발급 메서드가 없다. 어떤 모델 출력으로도 run.prepare가 시작되지 않는다(발급은 카드 버튼 IPC 하나뿐).
// - 문장·토큰·값을 로그에 남기지 않는다.
import type { AgentReply, DomainCall, ScreenFrame, StepParams, StepResult, ToolOutput, Vat } from '@sax/engine';
import { CHAT_ERROR_TEXT } from './chat-reply.ts';
import { cleanItem, split } from './shell-model.ts';

type SlotField = NonNullable<ToolOutput['fields']>[number];
type ToolNeed = NonNullable<ToolOutput['needs']>[number];
export type AgentAsk = NonNullable<AgentReply['ask']>;
export type AgentPhase = 'thinking' | 'reading' | 'drafting';

// 데스크톱은 @sax/model·@sax/redaction에 의존하지 않아 값을 옮겨 둔다. 시험(agent-chat-main)이 원본과 대조한다.
export const SLOT_FIELDS = ['date', 'supply', 'total', 'counterparty'] as const satisfies readonly SlotField[];
export const SLOT_POSITIONS = ['first', 'last'] as const;
export const CHAT_MAP_IDLE_MS = 15 * 60 * 1000;
const SLOT_RE = new RegExp(`\\{(r[1-9]\\d{0,5})\\.(${SLOT_POSITIONS.join('|')})\\.(${SLOT_FIELDS.join('|')})\\}`, 'g');
/** 엔진 화면 프레임 상한(cards maxItems) */
const FRAME_MAX = 12;
/** 한 사용자 턴의 chat.step 호출 상한. 엔진 턴 상한(4)과 따로 둔 이중 방어다. */
export const AGENT_STEP_MAX = 6;
const AMOUNT_MAX = 1e12;
const CHIP_CP_MAX = 8;

export const AGENT_SETUP_TEXT = '대화를 쓰려면 먼저 내 사업장(사업자 정보)을 등록해 주세요.';
/** 채울 값이 없는 슬롯이 있으면 문장 전체를 이것으로 바꾼다(값을 지어내지 않는다). */
export const AGENT_SLOT_MISSING_TEXT = '같이 보이는 표에서 값을 확인해 주세요.';

/** chat.* 오류 → 대화 문장과 [다시 시도]. 표에 없는 코드는 chat.unavailable로 접는다. */
export const AGENT_ERROR_TEXT: Record<string, { text: string; retry: boolean }> = {
  ...CHAT_ERROR_TEXT,
  'chat.turn_limit': { text: '한 번에 하기 어려워요. 나눠서 말씀해 주세요.', retry: false },
  'chat.bad_tool_output': CHAT_ERROR_TEXT['chat.unavailable'],
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

/** shell-runs 위의 좁은 포트. 준비·발급 메서드는 일부러 없다. */
export interface AgentDrafts {
  list(): DraftCard[];
  /** 내 사업장·발급 인증이 빠졌는가. 금액·품목을 묻기 전에 본다(물어 놓고 끝에 등록이 빠졌다고 하지 않게). */
  setupMissing(): boolean;
  /** 내 사업장 등록이 빠졌으면 { setup: true }(초안을 만들지 않는다) */
  create(counterpartyId: string, amount: number, vat: Vat | null, item: string | null): { runId: string } | { setup: true };
  update(runId: string, patch: { amount?: number; vat?: Vat; item?: string }): void;
  discard(runId: string): void;
}

export interface IssuedRow {
  counterpartyId: string | null;
  counterparty: string;
  /** KST YYYY-MM-DD */
  date: string;
  total: number | null;
}
export type ReceivableRow = IssuedRow;

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
  issued(): IssuedRow[];
  /** null이면 계좌 연결 전(not_set_up) */
  receivables(): Promise<ReceivableRow[] | null>;
  counterparties(): AgentCounterparty[];
  /** KST YYYY-MM-DD */
  today(): string;
  onProgress(phase: AgentPhase): void;
  now?: () => number;
}

export type ResultKind = 'sales' | 'history' | 'receivables';
export interface TableRow {
  date: string;
  counterparty: string;
  total: number | null;
}
export type AgentShow = { type: 'card'; runId: string } | { type: 'table'; table: ResultKind; title: string; rows: TableRow[] };
export type AgentTurnResult =
  | { kind: 'agent'; text: string; show: AgentShow[]; ask: null | { kind: AgentAsk; chips: Array<{ label: string; text: string }> }; filtered: AgentReply['filtered'] }
  | { kind: 'unavailable'; code: string; text: string; retry: boolean };

interface Result {
  kind: ResultKind;
  title: string;
  rows: Array<TableRow & { counterpartyId: string | null }>;
}

/** 대화 세션(엔진 세션과 같은 기준으로 끝난다). ref 번호는 세션이 바뀌어도 이어 간다: 엔진 대화록에 남은 옛 ref가 새 결과를 가리키지 않게. */
interface Session {
  profileId: string;
  lastAt: number;
  results: Map<string, Result>;
  refOfRun: Map<string, string>;
  runOfRef: Map<string, string>;
}

const TOOL_PHASE: Record<DomainCall['tool'], Exclude<AgentPhase, 'thinking'>> = {
  sales_summary: 'reading',
  invoice_history: 'reading',
  receivables: 'reading',
  invoice_draft: 'drafting',
  draft_edit: 'drafting',
  draft_discard: 'drafting',
};

const out = (status: ToolOutput['status'], ref: string | null = null, needs: ToolNeed[] | null = null): ToolOutput => ({ ref, status, fields: null, needs });
const won = (n: number) => `${n.toLocaleString('en-US')}원`;
const validAmount = (n: number) => Number.isInteger(n) && n > 0 && n <= AMOUNT_MAX;
const supplyOf = (total: number) => split(total, 'included').supply;

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

const newestFirst = <T extends { date: string }>(rows: T[]) => [...rows].sort((a, b) => b.date.localeCompare(a.date));

export class AgentChat {
  private readonly ports: AgentChatPorts;
  private session: Session | null = null;
  private seq = 0;

  constructor(ports: AgentChatPorts) {
    this.ports = ports;
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  async turn(text: string): Promise<AgentTurnResult> {
    const profileId = this.ports.profileId();
    if (!profileId) return { kind: 'agent', text: AGENT_SETUP_TEXT, show: [], ask: null, filtered: null };
    const s = this.open(profileId);
    const created: string[] = [];
    this.ports.onProgress('thinking');
    let phase: AgentPhase = 'thinking';
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
          outputs.push({ callId, output: await this.exec(s, call, created) });
        }
        r = await step({ continue: { outputs } });
      }
      return this.shown(s, r.reply, created);
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
        const rows = newestFirst(this.ports.issued().filter((x) => x.date.startsWith(`${month}-`)));
        const known = rows.filter((x) => x.total !== null);
        const sum = known.reduce((a, x) => a + x.total!, 0);
        const gap = rows.length - known.length;
        const title = `${Number(month.slice(5))}월 발급 ${rows.length}건 · 합계 ${won(sum)}${gap ? `(금액 모르는 ${gap}건 빼고)` : ''}`;
        return this.remember(s, { kind: 'sales', title, rows });
      }
      case 'invoice_history':
      case 'receivables': {
        const cp = cpOf(call.counterpartyId);
        if (cp === undefined) return out('unknown_counterparty');
        const all = call.tool === 'receivables' ? await this.ports.receivables() : this.ports.issued();
        if (!all) return out('not_set_up');
        // 이름만 아는 옛 행(counterpartyId null)은 지금 장부 이름으로 맞춘다.
        const rows = newestFirst(cp ? all.filter((x) => x.counterpartyId === cp.id || (x.counterpartyId === null && x.counterparty === cp.name)) : all);
        const title = call.tool === 'receivables' ? `${cp ? `${cp.name} ` : ''}입금 확인 전 세금계산서` : `${cp ? `${cp.name} ` : ''}발급 기록`;
        return this.remember(s, { kind: call.tool === 'receivables' ? 'receivables' : 'history', title, rows });
      }
      case 'invoice_draft': {
        const cp = cpOf(call.counterpartyId);
        if (!cp) return out('unknown_counterparty');
        if (this.ports.drafts.setupMissing()) return out('setup_missing');
        const amount = this.amount(s, call.amount);
        const item = call.item === null ? null : cleanItem(call.item);
        // 품목이 문장에도 거래처 저장 품목에도 없으면 만들지 않는다. 빈 품목 초안은 준비에서야 item_missing으로 멈춘다(interpret와 같은 규칙).
        const needs: ToolNeed[] = [...(amount ? [] : ['amount' as const]), ...(item || cleanItem(cp.item ?? '') ? [] : ['item' as const])];
        if (needs.length) return out('needs_input', null, needs);
        const r = this.ports.drafts.create(cp.id, amount!.value, call.vat ?? amount!.vat, item);
        if ('setup' in r) return out('setup_missing');
        created.push(r.runId);
        return out('card_shown', this.cardRef(s, r.runId));
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
        const patch: { amount?: number; vat?: Vat; item?: string } = {};
        const needs: ToolNeed[] = [];
        if (call.amount !== null) {
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
  private amount(s: Session, a: Extract<DomainCall, { tool: 'invoice_draft' }>['amount']): { value: number; vat: Vat | null } | null {
    if (a === null) return null;
    if ('value' in a) return validAmount(a.value) ? { value: a.value, vat: null } : null;
    const m = new RegExp(`^${SLOT_RE.source}$`).exec(a.slot);
    const field = m?.[3];
    if (!m || (field !== 'supply' && field !== 'total')) return null;
    const v = this.slotValue(s, m[1]!, m[2]!, field);
    return typeof v === 'number' && validAmount(v) ? { value: v, vat: field === 'total' ? 'included' : null } : null;
  }

  private slotValue(s: Session, ref: string, pos: string, field: string): number | string | null {
    const rows = s.results.get(ref)?.rows;
    const row = pos === 'first' ? rows?.[0] : rows?.at(-1);
    if (!row) return null;
    if (field === 'date') return row.date;
    if (field === 'counterparty') return row.counterparty;
    if (row.total === null) return null;
    return field === 'total' ? row.total : supplyOf(row.total);
  }

  private fill(s: Session, text: string): string {
    const today = this.ports.today();
    let missing = false;
    const filled = text.replace(SLOT_RE, (_m, ref: string, pos: string, field: string) => {
      const v = this.slotValue(s, ref, pos, field);
      if (v === null) {
        missing = true;
        return '';
      }
      return typeof v === 'number' ? won(v) : field === 'date' ? koDate(v, today) : v;
    });
    return missing ? AGENT_SLOT_MISSING_TEXT : filled;
  }

  private shown(s: Session, reply: AgentReply, created: string[]): AgentTurnResult {
    const show: AgentShow[] = [];
    const cards = new Set<string>();
    for (const ref of reply.show) {
      const res = s.results.get(ref);
      const runId = s.runOfRef.get(ref);
      if (res) show.push({ type: 'table', table: res.kind, title: res.title, rows: res.rows.map(({ date, counterparty, total }) => ({ date, counterparty, total })) });
      else if (runId && !cards.has(runId)) {
        cards.add(runId);
        show.push({ type: 'card', runId });
      }
    }
    // 이번 턴에 만든 카드는 모델이 show에 넣지 않아도 보인다(카드가 사실이다).
    for (const runId of created) if (!cards.has(runId)) show.push({ type: 'card', runId });
    return { kind: 'agent', text: reply.filtered ? reply.text : this.fill(s, reply.text), show, ask: reply.ask ? { kind: reply.ask, chips: this.chips(reply.ask) } : null, filtered: reply.filtered };
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
