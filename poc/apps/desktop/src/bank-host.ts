// 받을 돈(09 D-09) main 처리기: 렌더러 요청 → 엔진 bank.* (main 전용). 파일은 main이 고르고 docparse 샌드박스로 읽어 다듬은 줄만 엔진에 보낸다.
// - 은행 거래내역: [거래내역 파일 올리기] → 미리보기(열 자동 인식, 사람이 열을 고침) → [넣기]. 미리보기 동안 파일 바이트·표는 main 메모리에만(5분, 1건).
// - 홈택스 발급 목록: 파일 고르기 → 읽기 → 바로 넣기(결과 카드).
// - 대화: "못 받은 돈 있어?" 같은 질문은 로컬 규칙(bankQuestion)으로 알아보고 엔진 로컬 조회로 답한다. 모델에 보내지 않는다.
// 파일 내용·계좌번호·입금자명은 로그에 남기지 않는다(건수·코드만).
import { randomBytes } from 'node:crypto';
import { parseBankStatement, parseHometaxIssueList, sniffFormat, type BankMapping, type BankParse, type BankRole } from '@sax/docparse';
import type { SheetOutput } from '@sax/docparse/sandbox';
import { BANK_CONSENT_VERSION, type BANK_SHELL_METHODS } from './bank-ipc.ts';
import type { BoardCard } from './board.ts';
import type { ParamsOf } from './ipc.ts';

export type EngineRpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
export type PickKind = 'statement' | 'invoices';

export interface BankHostPorts {
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
const ROLES: readonly BankRole[] = ['date', 'time', 'in', 'out', 'amount', 'kind', 'balance', 'payer', 'memo', 'counter_account'];

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
    for (const role of ROLES) {
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
    const item = s.stale
      ? { id: 'bank-stale', label: '거래내역이 오래됐어요', detail: `${basis} · [거래내역 올리기]`, tone: 'attention' as const }
      : s.overdueCount > 0
        ? { id: 'bank-overdue', label: `기한 지난 받을 돈 ${s.overdueCount}건 · ${won(s.overdueTotal)}`, detail: `${s.oldestOverdue ? `가장 오래된 것: ${s.oldestOverdue.cpName ?? '거래처'} ${md(s.oldestOverdue.writtenOn)}(${s.oldestOverdue.daysOver}일 지남) · ` : ''}${basis}`, tone: 'attention' as const }
        : { id: 'bank-unpaid', label: `기다리는 받을 돈 ${s.unpaidCount}건`, detail: basis, tone: null };
    out.push({ kind: 'unpaid', title: '못 받은 돈', due: null, items: [{ ...item, kind: 'unpaid', due: null, showDue: false, target }] });
  }
  if (s.reviewCount > 0) out.push({ kind: 'deposits', title: '확인할 입금', due: null, items: [{ id: 'bank-review', kind: 'deposits', label: `확인할 입금 ${s.reviewCount}건`, detail: '누가 보낸지 확인해 주세요', due: null, showDue: false, tone: null, target }] });
  return out;
}

// ---- 대화: 로컬 규칙(L0) ----

export type BankQuestion = { kind: 'unpaid' } | { kind: 'month'; month: string | null } | { kind: 'counterparty'; name: string };

/**
 * 받을 돈 질문 알아보기(로컬 규칙). 모르면 null(기존 길: 엔진 의도 판정). 세무 판단 질문(대손 등)은 잡지 않는다.
 * - "못 받은 돈 있어?", "미수금", "안 들어온 돈" → unpaid
 * - "이번 달 받을 돈", "11월 받을 돈" → month
 * - "○○ 입금됐어?", "○○ 돈 들어왔어?" → counterparty
 */
export function bankQuestion(text: string, today: string): BankQuestion | null {
  const t = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 120) return null;
  if (/대손|세무|처리해도|분개|계정과목/.test(t)) return null;
  if (/(세금계산서|계산서).*(발급|끊|보내)/.test(t)) return null;
  const who = t.match(/^(.{2,30}?)\s*(?:에서|한테서|쪽|이|가|은|는)?\s*(?:돈\s*)?(?:입금\s*(?:됐|되었|됬|된|했|해|확인)|(?:돈\s*)?들어왔|보냈|줬|냈)/);
  if (who && !/^(못|안|이번|지난|다음|\d+월)/.test(who[1]!)) return { kind: 'counterparty', name: who[1]!.replace(/(에서|한테서|쪽|이|가|은|는)$/, '').trim() };
  const m = t.match(/(이번\s*달|이달|지난\s*달|(\d{1,2})\s*월)\s*(?:에\s*)?(?:받을|들어올)\s*돈/);
  if (m) {
    const [y, mo] = today.split('-').map(Number) as [number, number];
    if (m[2]) return { kind: 'month', month: `${Number(m[2]) > mo + 1 ? y - 1 : y}-${String(Number(m[2])).padStart(2, '0')}` };
    if (/지난/.test(m[1]!)) return { kind: 'month', month: mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, '0')}` };
    return { kind: 'month', month: null };
  }
  if (/(못\s*받은|안\s*받은|덜\s*받은|안\s*들어온|미수|받을\s*돈|못\s*받았)/.test(t)) return { kind: 'unpaid' };
  return null;
}

/** "안 낸 돈 있어?"(1단계 범위 밖) */
export const isPayableQuestion = (text: string) => /(안\s*낸|못\s*낸|낼\s*돈|미지급)/.test(text);
export const PAYABLE_LATER_TEXT = '아직 받은 세금계산서(매입)는 맞추지 않아요. 지금은 받을 돈(매출)만 볼 수 있어요.';

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
    'bank.addAlias': (p) => changed(b.call('bank.addAlias', { counterpartyId: p.counterpartyId, name: p.name, source: 'manual' })),
    'bank.deleteAlias': (p) => changed(b.call('bank.deleteAlias', { id: p.id })),
    'bank.setPayTerms': (p) => {
      const n = typeof p.n === 'number' && Number.isInteger(p.n) ? p.n : 30;
      const terms = p.kind === 'default' ? null : p.kind === 'days' ? { kind: 'days', n } : p.kind === 'next_month_day' ? { kind: 'next_month_day', d: n } : { kind: p.kind };
      return changed(b.call('bank.setPayTerms', { counterpartyId: p.counterpartyId, terms }));
    },
  };
}
