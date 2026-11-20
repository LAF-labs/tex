// 받을 돈(09 D-09) main 처리기: 렌더러 요청 → 엔진 bank.* (main 전용). 파일은 main이 고르고 docparse 샌드박스로 읽어 다듬은 줄만 엔진에 보낸다.
// - 은행 거래내역: [거래내역 파일 올리기] → 미리보기(열 자동 인식, 사람이 열을 고침) → [넣기]. 미리보기 동안 파일 바이트·표는 main 메모리에만(5분, 1건).
// - 홈택스 발급 목록: 파일 고르기 → 읽기 → 바로 넣기(결과 카드).
// - 대화: 문장을 여기서 가로채지 않는다. 대화 도구 루프(agent-chat의 receivables 도구)가 receivables()를 부른다. 값은 PC 안에만 있다.
// 파일 내용·계좌번호·입금자명은 로그에 남기지 않는다(건수·코드만).
import { randomBytes } from 'node:crypto';
import { BANK_ROLES, parseBankStatement, parseHometaxIssueList, sniffFormat, type BankMapping, type BankParse } from '@sax/docparse';
import type { SheetOutput } from '@sax/docparse/sandbox';
import { BANK_CONSENT_VERSION, type BANK_SHELL_METHODS } from './bank-ipc.ts';
import type { BoardCard } from './board.ts';
import type { ParamsOf } from './ipc.ts';

export type EngineRpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
export type PickKind = 'statement' | 'invoices';

interface BankHostPorts {
  rpc: EngineRpc;
  /** 사업자 프로필 id(없으면 null: "내 사업장을 먼저 등록해 주세요") */
  profileId: () => Promise<string | null>;
  /** 파일 고르기(취소하면 null). e2e가 바꿔 끼운다 */
  pick: (kind: PickKind) => Promise<Uint8Array | null>;
  /** docparse 샌드박스 표 읽기 */
  readSheet: (bytes: Uint8Array) => Promise<SheetOutput>;
  log: (name: string, data?: Record<string, string | number | boolean>) => void;
  now?: () => number;
}

const PENDING_MS = 5 * 60_000;

/** 미리보기 카드(렌더러로 가는 것). 줄은 앞 8줄 원래 글자 + 읽은 결과 합계만 */
function preview(token: string, r: BankParse, accounts: Array<{ id: string; last4: string }>) {
  return {
    token,
    ok: r.rows.length > 0,
    headers: r.headers,
    mapping: r.mapping?.columns ?? {},
    sample: r.sample,
    rows: r.rows.length,
    skipped: r.skipped,
    period: r.period,
    totals: r.totals,
    bankHint: r.bankHint,
    accountLast4: r.accountLast4,
    suggestedAccountId: (r.accountLast4 && accounts.find((a) => a.last4 === r.accountLast4)?.id) || (accounts.length === 1 ? accounts[0]!.id : null),
    warnings: r.warnings,
  };
}

const extOf = (bytes: Uint8Array): string => {
  const f = sniffFormat(bytes);
  return 'format' in f && (f.format === 'xlsx' || f.format === 'xls' || f.format === 'csv' || f.format === 'html') ? f.format : 'bin';
};

export class BankHost {
  private readonly ports: BankHostPorts;
  private pending: { token: string; at: number; bytes: Uint8Array; out: SheetOutput; signature: string | null; ext: string } | null = null;

  constructor(ports: BankHostPorts) {
    this.ports = ports;
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private async pid(): Promise<string> {
    const id = await this.ports.profileId();
    if (!id) throw new Error('profile_not_found');
    return id;
  }

  /** 엔진 호출(사업자 프로필을 붙인다) */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.ports.rpc(method, { profileId: await this.pid(), ...params })) as T;
  }

  private drop(): void {
    if (this.pending) this.pending.bytes.fill(0);
    this.pending = null;
  }

  private async read(bytes: Uint8Array): Promise<SheetOutput> {
    const f = sniffFormat(bytes);
    if (!('format' in f) || f.format === 'pdf' || f.format === 'jpeg' || f.format === 'png') throw new Error('unsupported_format');
    return this.ports.readSheet(bytes);
  }

  /** [거래내역 파일 올리기]: 고르기 → 읽기 → 기억한 서식이 있으면 그것으로 → 미리보기 */
  async pickStatement(): Promise<unknown> {
    const bytes = await this.ports.pick('statement');
    if (!bytes) return null;
    const out = await this.read(bytes);
    let r = parseBankStatement(out);
    if (r.signature) {
      const remembered = (await this.ports.rpc('db.query.bank.format', { signature: r.signature }).catch(() => null)) as { mapping: BankMapping | null } | null;
      if (remembered?.mapping) {
        const again = parseBankStatement(out, remembered.mapping);
        if (again.rows.length) r = { ...again, signature: r.signature };
      }
    }
    this.drop();
    const token = randomBytes(8).toString('hex');
    this.pending = { token, at: this.now(), bytes, out, signature: r.signature, ext: extOf(bytes) };
    this.ports.log('bank.statement_read', { rows: r.rows.length, skipped: r.skipped, auto: r.mapping ? 'yes' : 'no' });
    return preview(token, r, await this.call<Array<{ id: string; last4: string }>>('db.query.bank.accounts'));
  }

  private held(token: unknown) {
    const p = this.pending;
    if (!p || p.token !== token || this.now() - p.at > PENDING_MS) {
      this.drop();
      throw new Error('preview_expired');
    }
    return p;
  }

  private mappingOf(p: { out: SheetOutput }, cols: Record<string, unknown> | undefined): BankMapping | null {
    if (!cols) return null;
    const auto = parseBankStatement(p.out).mapping;
    const sheet = auto?.sheet ?? p.out.sheets.find((s) => !s.hidden)?.name ?? '';
    const headerRow = typeof cols.headerRow === 'number' && Number.isInteger(cols.headerRow) && cols.headerRow >= 0 && cols.headerRow < 40 ? cols.headerRow : (auto?.headerRow ?? 0);
    const columns: BankMapping['columns'] = {};
    for (const role of BANK_ROLES) {
      const v = cols[role];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 256) columns[role] = v;
    }
    return { sheet, headerRow, columns };
  }

  /** 열을 고친 미리보기 */
  async previewStatement(token: unknown, cols: Record<string, unknown> | undefined): Promise<unknown> {
    const p = this.held(token);
    const r = parseBankStatement(p.out, this.mappingOf(p, cols));
    return preview(p.token, r, await this.call<Array<{ id: string; last4: string }>>('db.query.bank.accounts'));
  }

  /** [넣기]: 다듬은 줄 + 원본 파일을 엔진에. 사람이 열을 고쳤으면 그 서식을 기억한다 */
  async commitStatement(token: unknown, accountId: string, cols: Record<string, unknown> | undefined): Promise<unknown> {
    const p = this.held(token);
    const mapping = this.mappingOf(p, cols);
    const r = parseBankStatement(p.out, mapping);
    if (!r.rows.length) throw new Error('no_rows');
    const res = await this.call('bank.importTxns', {
      accountId, rows: r.rows, source: 'file', signature: p.signature, mapping: mapping ? r.mapping : undefined, file: { bytes: p.bytes, ext: p.ext },
    });
    this.drop();
    this.ports.log('bank.statement_imported', { rows: r.rows.length });
    return res;
  }

  cancelStatement(): void {
    this.drop();
  }

  /** [홈택스 발급목록 파일 올리기]: 고르기 → 읽기 → 넣기 */
  async pickInvoices(): Promise<unknown> {
    const bytes = await this.ports.pick('invoices');
    if (!bytes) return null;
    const out = await this.read(bytes);
    const r = parseHometaxIssueList(out);
    if (!r.rows.length) {
      bytes.fill(0);
      return { ok: false, warnings: r.warnings, skipped: r.skipped };
    }
    const res = (await this.call('bank.importInvoices', { rows: r.rows, file: { bytes, ext: extOf(bytes) } })) as Record<string, unknown>;
    this.ports.log('bank.invoices_imported', { rows: r.rows.length, duplicates: r.duplicates });
    return { ok: true, rows: r.rows.length, duplicates: r.duplicates, period: r.period, ...res };
  }

  /**
   * 대화 도구 receivables의 조회(agent-chat AgentChatPorts.receivables와 같은 모양). 아직 받지 않은 건(못 받음·일부·기다리는 중)만, 금액은 남은 돈.
   * 계좌를 하나도 등록하지 않았으면 null(not_set_up). 값은 main 안에서만 쓴다(모델에는 도구 결과의 칸 이름만 간다).
   */
  async receivables(): Promise<ReceivableRow[] | null> {
    const o = await this.call<{ accounts: unknown[]; unpaid: Array<{ counterpartyId: string | null; cpName: string | null; writtenOn: string; remaining: number }> }>('db.query.bank.overview');
    if (!o.accounts.length) return null;
    return o.unpaid.map((v) => ({ counterpartyId: v.counterpartyId, counterparty: v.cpName ?? '거래처', date: v.writtenOn, total: v.remaining }));
  }

  /**
   * 대화 도구가 쓸 낼 돈 조회(11 §2.5). receivables()와 같은 모양: 아직 내지 않은 건만, 금액은 남은 돈. 계좌가 없으면 null.
   * dueOn은 낼 날(약속일 우선, 기한 없음이면 null).
   */
  async payables(): Promise<Array<ReceivableRow & { dueOn: string | null }> | null> {
    const o = await this.call<{ accounts: unknown[]; payables: { unpaid: Array<{ counterpartyId: string | null; cpName: string | null; writtenOn: string; remaining: number; dueOn: string | null; promisedOn: string | null }> } }>('db.query.bank.overview');
    if (!o.accounts.length) return null;
    return o.payables.unpaid.map((v) => ({ counterpartyId: v.counterpartyId, counterparty: v.cpName ?? '거래처', date: v.writtenOn, total: v.remaining, dueOn: v.promisedOn ?? v.dueOn }));
  }

  /**
   * 대화 도구가 쓸 돈 흐름 요약(11 §3.7·§5). 모델에 가도 되는 칸만 남긴다: 합계·비율·건수·거래처 상호.
   * 계좌번호(끝 4자리 포함)·줄 id·통장 표시는 넣지 않는다. 계좌가 없으면 null.
   */
  async cashFlowBrief(month?: string): Promise<CashFlowBrief | null> {
    const r = await this.call<CashFlowResultLike>('db.query.bank.cashflow', month ? { month } : {});
    if (!r.month.hasAccounts) return null;
    const m = r.month;
    return {
      month: m.month, through: m.to, complete: m.complete, missingAccounts: m.missing.length,
      in: m.cash.in, out: m.cash.out, net: m.cash.net, accrual: m.accrual, collectionRate: m.collectionRate,
      unknown: { inTotal: m.unknown.inTotal, outTotal: m.unknown.outTotal, inCount: m.unknown.inCount, outCount: m.unknown.outCount },
      balance: r.snapshot.balance.total, balancePartial: r.snapshot.balance.partial, next30: r.snapshot.next30, aging: r.snapshot.aging,
      collectDays: r.snapshot.collectDays.overall, payDays: r.snapshot.payDays,
      slowest: r.snapshot.collectDays.byCounterparty.slice(0, 3).map((c) => ({ counterparty: c.cpName ?? '거래처', days: c.days, count: c.count })),
      topCustomer: r.snapshot.concentration.top1 ? { counterparty: r.snapshot.concentration.top1.cpName ?? '거래처', share: r.snapshot.concentration.top1.share } : null,
      // 거래처 열쇠(장부 id)는 모델에 줄 까닭이 없어 뺀다
      alerts: r.alerts.map((a) => {
        const { counterpartyKey, ...rest } = a;
        void counterpartyKey;
        return 'cpName' in rest ? { ...rest, cpName: rest.cpName ?? '거래처' } : rest;
      }),
    };
  }

  /**
   * 대화 도구 cash_flow의 값(agent-chat CashFlowValues). 앞으로 30일 낼 돈은 기한 지난 것까지 더한다(이미 늦은 돈도 곧 나갈 돈이다).
   * 계좌가 없으면 null.
   */
  async cashFlowValues(month: string): Promise<{ complete: boolean; through: string; in: number; out: number; net: number; balance: number | null; nextIn: number; nextOut: number } | null> {
    const b = await this.cashFlowBrief(month);
    if (!b) return null;
    return { complete: b.complete, through: b.through, in: b.in.total, out: b.out.total, net: b.net, balance: b.balance, nextIn: b.next30.payIn ?? 0, nextOut: (b.next30.payOut ?? 0) + (b.next30.payOverdue ?? 0) };
  }

  /** 판 카드 "못 받은 돈"·"확인할 입금"(대표 결정 ⑤). 거래내역이 오래됐으면 금액 대신 "거래내역이 오래됐어요" */
  async boardCards(): Promise<BoardCard[]> {
    let s: BankSummaryLike;
    try {
      s = await this.call<BankSummaryLike>('db.query.bank.summary');
    } catch {
      return [];
    }
    return bankBoardCards(s);
  }
}

/** 대화 도구가 받는 줄(agent-chat ReceivableRow). date는 작성일(KST), total은 남은 돈 */
export interface ReceivableRow {
  counterpartyId: string | null;
  counterparty: string;
  date: string;
  total: number | null;
}

/** 엔진 db.query.bank.cashflow 결과에서 여기서 읽는 칸(engine CashFlowResult와 같은 모양) */
interface CashFlowResultLike {
  month: {
    month: string; to: string; complete: boolean; hasAccounts: boolean; missing: unknown[];
    cash: { in: { total: number; by: Record<string, number> }; out: { total: number; by: Record<string, number> }; net: number };
    accrual: Record<string, number | null>; collectionRate: number | null;
    unknown: { inTotal: number; outTotal: number; inCount: number; outCount: number };
  };
  snapshot: {
    balance: { total: number | null; partial: boolean };
    next30: Record<string, number>; aging: Record<string, number>; payDays: number | null;
    collectDays: { overall: number | null; byCounterparty: Array<{ cpName: string | null; days: number; count: number }> };
    concentration: { top1: { cpName: string | null; share: number } | null };
  };
  alerts: Array<{ id: string; kind: string; cpName?: string | null; counterpartyKey?: string }>;
}

/** 대화 도구 cash_flow가 받는 요약(값은 PC 안에서 만들고, 모델에는 이 칸만 간다) */
interface CashFlowBrief {
  month: string;
  through: string;
  complete: boolean;
  missingAccounts: number;
  in: { total: number; by: Record<string, number> };
  out: { total: number; by: Record<string, number> };
  net: number;
  accrual: Record<string, number | null>;
  collectionRate: number | null;
  unknown: { inTotal: number; outTotal: number; inCount: number; outCount: number };
  balance: number | null;
  balancePartial: boolean;
  next30: Record<string, number>;
  aging: Record<string, number>;
  collectDays: number | null;
  payDays: number | null;
  slowest: Array<{ counterparty: string; days: number; count: number }>;
  topCustomer: { counterparty: string; share: number } | null;
  alerts: Array<Record<string, unknown>>;
}

export interface BankSummaryLike {
  today: string;
  latestDay: string | null;
  stale: boolean;
  hasAccounts: boolean;
  unpaidCount: number;
  overdueCount: number;
  overdueTotal: number;
  oldestOverdue: { cpName: string | null; writtenOn: string; daysOver: number } | null;
  reviewCount: number;
}

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
const md = (iso: string) => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;

export function bankBoardCards(s: BankSummaryLike): BoardCard[] {
  const out: BoardCard[] = [];
  const target = { to: 'view' as const, view: 'bank' as const };
  if (s.unpaidCount > 0) {
    const basis = s.latestDay ? `거래내역 ${md(s.latestDay)}까지 반영` : '거래내역을 아직 올리지 않았어요';
    // 거래내역이 없으면 "오래됐다"가 아니라 아직 맞춰 보지 않은 것이다. 줄 전체가 받을 돈 화면으로 가는 단추라 글자 단추([…])는 두지 않는다.
    const item = !s.latestDay
      ? { id: 'bank-stale', label: `받을 돈 ${s.unpaidCount}건 · 입금 확인 전`, detail: basis, tone: null }
      : s.stale
      ? { id: 'bank-stale', label: '거래내역이 오래됐어요', detail: basis, tone: 'attention' as const }
      : s.overdueCount > 0
        ? { id: 'bank-overdue', label: `기한 지난 받을 돈 ${s.overdueCount}건 · ${won(s.overdueTotal)}`, detail: `${s.oldestOverdue ? `가장 오래된 것: ${s.oldestOverdue.cpName ?? '거래처'} ${md(s.oldestOverdue.writtenOn)}(${s.oldestOverdue.daysOver}일 지남) · ` : ''}${basis}`, tone: 'attention' as const }
        : { id: 'bank-unpaid', label: `기다리는 받을 돈 ${s.unpaidCount}건`, detail: basis, tone: null };
    out.push({ kind: 'unpaid', title: '못 받은 돈', due: null, items: [{ ...item, kind: 'unpaid', due: null, showDue: false, target }] });
  }
  if (s.reviewCount > 0) out.push({ kind: 'deposits', title: '확인할 입금', due: null, items: [{ id: 'bank-review', kind: 'deposits', label: `확인할 입금 ${s.reviewCount}건`, detail: '누가 보낸지 확인해 주세요', due: null, showDue: false, tone: null, target }] });
  return out;
}

// ---- 렌더러 처리기(파일 고르기 둘·최신화는 shell-app이 needGesture와 함께 둔다) ----

type BankMethods = typeof BANK_SHELL_METHODS;
type Handlers = { [M in Exclude<keyof BankMethods, 'bank.pickStatement' | 'bank.pickInvoices' | 'bank.refresh'>]: (p: ParamsOf<BankMethods[M]>) => unknown };

export function bankShellHandlers(b: BankHost, after: () => void): Handlers {
  // 맞춤이 바뀌는 명령 뒤에는 판을 다시 계산한다(못 받은 돈·확인할 입금 카드)
  const changed = async <T>(p: Promise<T>): Promise<T> => {
    const r = await p;
    after();
    return r;
  };
  return {
    'bank.overview': () => b.call('db.query.bank.overview'),
    'bank.receivable': (p) => b.call('db.query.bank.receivable', { id: p.id }),
    'bank.consent': () => b.call('bank.consent', { version: BANK_CONSENT_VERSION }),
    'bank.addAccount': (p) => b.call('bank.addAccount', { bank: p.bank, number: p.number, alias: p.alias }),
    'bank.deleteAccount': (p) => changed(b.call('bank.deleteAccount', { id: p.id })),
    'bank.revealAccount': (p) => b.call('bank.revealAccount', { id: p.id }),
    'bank.refreshStatus': async (p) => {
      const j = (await b.call('db.query.bank.refreshStatus', { accountId: p.accountId })) as { state?: string } | null;
      if (j?.state === 'done') after();
      return j;
    },
    'bank.previewStatement': (p) => b.previewStatement(p.token, p.columns),
    'bank.commitStatement': (p) => changed(b.commitStatement(p.token, p.accountId, p.columns)),
    'bank.cancelStatement': () => b.cancelStatement(),
    'bank.accept': (p) => changed(b.call('bank.accept', { txnId: p.txnId, receivableIds: p.ids.split(',').filter(Boolean).slice(0, 10), closeFee: p.closeFee === true })),
    'bank.attach': (p) => changed(b.call('bank.attach', { txnId: p.txnId, receivableId: p.receivableId })),
    'bank.detach': (p) => changed(b.call('bank.detach', { allocId: p.allocId })),
    'bank.reject': (p) => changed(b.call('bank.reject', { txnId: p.txnId, receivableId: p.receivableId })),
    'bank.markReceived': (p) => changed(b.call('bank.markReceived', { receivableId: p.receivableId, method: p.method, amount: p.amount, on: p.on, memo: p.memo })),
    'bank.closeFee': (p) => changed(b.call('bank.closeFee', { receivableId: p.receivableId })),
    'bank.ignoreTxn': (p) => changed(b.call('bank.ignoreTxn', { txnId: p.txnId, reason: p.reason })),
    'bank.assignTxn': (p) => changed(b.call('bank.assignTxn', { txnId: p.txnId, counterpartyId: p.counterpartyId, remember: p.remember === true })),
    'bank.setPromised': (p) => changed(b.call('bank.setPromised', { receivableId: p.receivableId, on: p.on })),
    'bank.exclude': (p) => changed(b.call('bank.exclude', { receivableId: p.receivableId, reason: p.reason })),
    'bank.undo': (p) => changed(b.call('bank.undo', { seq: p.seq })),
    'bank.cpBanking': (p) => b.call('db.query.bank.counterparty', { counterpartyId: p.counterpartyId }),
    'bank.addCpAccount': (p) => changed(b.call('bank.addCpAccount', { counterpartyId: p.counterpartyId, bank: p.bank, number: p.number, holder: p.holder })),
    'bank.deleteCpAccount': (p) => changed(b.call('bank.deleteCpAccount', { id: p.id })),
    'bank.addAlias': (p) => changed(b.call('bank.addAlias', { counterpartyId: p.counterpartyId, name: p.name, source: p.learned === true ? 'learned' : 'manual' })),
    'bank.deleteAlias': (p) => changed(b.call('bank.deleteAlias', { id: p.id })),
    'bank.setPayTerms': (p) => {
      const n = typeof p.n === 'number' && Number.isInteger(p.n) ? p.n : 30;
      const terms = p.kind === 'default' ? null : p.kind === 'days' ? { kind: 'days', n } : p.kind === 'next_month_day' ? { kind: 'next_month_day', d: n } : { kind: p.kind };
      return changed(b.call('bank.setPayTerms', { counterpartyId: p.counterpartyId, terms }));
    },
  };
}
