// 세무사 꾸러미 이번 달 상태(08 D-05)와 "빠진 것"(D14 M6-14). 판정이 아니라 표시다: 앱은 무엇이 비어 있는지 보여 줄 뿐
// 경비 인정·증빙 적격 여부를 정하지 않는다(ADR-032 결정 3·5).
import { BundleRepo, CardRepo, CashSalesRepo, EmployeeRepo, PayrollRepo, ReceiptRepo, type BundleEntryStatus, type BundleItem, type CardTxn, type ColumnCipher, type Db } from '@sax/db';
import { BundleError, monthRange, periodFor } from './items.ts';

/** 홈택스 세금계산서 조회(H-02) 결과 한 건. 이 패키지는 받아서 쓰기만 한다 */
export interface TaxInvoiceRow {
  direction: 'sales' | 'purchase';
  issueDate: string;
  approvalNo: string;
  counterpartyBizNo: string;
  counterpartyName: string;
  supplyAmount: number;
  vatAmount: number;
  total: number;
}

/** 매출·매입 한 행과 내보내기 메모(산술 사실만, 판정 아님) */
export interface InvoiceLine {
  row: TaxInvoiceRow;
  /** 공급가액 + 세액 − 합계(0이 아니면 "확인 필요") */
  sumGap: number;
  /** 같은 키로 뺀 행 중 금액이 이 행과 다른 것의 수 */
  differingDuplicates: number;
}

const digits = (s: string): string => s.replace(/[^0-9A-Za-z]/g, '');

/**
 * 매출·매입 행 정리(R15 P1-2 ②·③, 팀장 승인 2026-11-05). 사장님에게 묻지 않고 내보내기 안에서 자동으로 한다.
 * - 중복 제거: (방향, 거래처 사업자번호, 승인번호)가 같으면 처음 한 행만 남긴다. H-02를 다시 돌려도 행이 늘지 않는다.
 * - 공급가액 + 세액 ≠ 합계면 sumGap에 차이를 둔다. 막지 않는다.
 */
export function tidyInvoices(rows: readonly TaxInvoiceRow[]): { lines: InvoiceLine[]; dropped: number } {
  const byKey = new Map<string, InvoiceLine>();
  let dropped = 0;
  for (const row of rows) {
    const key = `${row.direction}|${digits(row.counterpartyBizNo)}|${digits(row.approvalNo)}`;
    const seen = byKey.get(key);
    if (!seen) {
      byKey.set(key, { row, sumGap: row.supplyAmount + row.vatAmount - row.total, differingDuplicates: 0 });
      continue;
    }
    dropped++;
    const r = seen.row;
    if (r.supplyAmount !== row.supplyAmount || r.vatAmount !== row.vatAmount || r.total !== row.total || r.issueDate !== row.issueDate) seen.differingDuplicates++;
  }
  return { lines: [...byKey.values()], dropped };
}

export interface MonthContext {
  db: Db;
  /** 직원 이름을 읽을 때만 쓴다(주민번호는 읽지 않는다) */
  cipher: ColumnCipher;
  profileId: string;
  month: string;
  /** 설정 profile.<id>.payroll.enabled. 끄면 급여대장 항목은 파일 첨부 칸이다 */
  payrollEnabled: boolean;
  taxInvoices?: readonly TaxInvoiceRow[];
}

export interface ItemStatus {
  item: BundleItem;
  period: string;
  status: BundleEntryStatus;
  /** entry: 사장님이 표시한 상태, derived: 앱이 기록에서 센 상태 */
  basis: 'entry' | 'derived';
  docIds: string[];
  note: string | null;
  /** 화면 보조 숫자(건수 등). 값은 넣지 않는다 */
  counts: Record<string, number>;
}

/** 켜진 항목마다 이번 달 상태 */
export function monthStatus(ctx: MonthContext): ItemStatus[] {
  const repo = new BundleRepo(ctx.db);
  const { from, to } = monthRange(ctx.month);
  const items = repo.items(ctx.profileId, { enabledOnly: true });
  return items.map((item): ItemStatus => {
    const period = periodFor(ctx.month, item.cadence);
    const e = repo.entry(item.id, period);
    const base = { item, period, docIds: e?.docIds ?? [], note: e?.note ?? null, counts: {} as Record<string, number> };
    if (e?.status === 'not_applicable') return { ...base, status: 'not_applicable', basis: 'entry' };
    switch (item.kind) {
      case 'payroll': {
        if (!ctx.payrollEnabled) break;
        const pr = new PayrollRepo(ctx.db);
        const latest = pr.latest(ctx.profileId, ctx.month);
        const status: BundleEntryStatus = !latest ? 'missing' : latest.status === 'confirmed' ? 'ready' : 'partial';
        return { ...base, status, basis: 'derived', counts: { revision: latest?.revision ?? 0 } };
      }
      case 'card': {
        const fetches = new CardRepo(ctx.db).fetchesOverlapping(ctx.profileId, from, to);
        const covered = fetches.some((f) => f.rangeFrom <= from && f.rangeTo >= to);
        const status: BundleEntryStatus = covered ? 'ready' : fetches.length ? 'partial' : 'missing';
        return { ...base, status, basis: 'derived', counts: { txns: new CardRepo(ctx.db).txns(ctx.profileId, from, to).length } };
      }
      case 'cash_sales': {
        const days = new CashSalesRepo(ctx.db).range(ctx.profileId, from, to).length;
        if (e) return { ...base, status: e.status, basis: 'entry', counts: { days } };
        return { ...base, status: days ? 'partial' : 'missing', basis: 'derived', counts: { days } };
      }
      case 'paper_receipt': {
        const n = new ReceiptRepo(ctx.db).list(ctx.profileId, from, to).length;
        if (e) return { ...base, status: e.status, basis: 'entry', counts: { receipts: n } };
        return { ...base, status: n ? 'partial' : 'missing', basis: 'derived', counts: { receipts: n } };
      }
      case 'tax_invoice': {
        const n = ctx.taxInvoices?.length ?? 0;
        if (e) return { ...base, status: e.status, basis: 'entry', counts: { invoices: n } };
        return { ...base, status: ctx.taxInvoices ? 'ready' : 'missing', basis: 'derived', counts: { invoices: n } };
      }
    }
    return { ...base, status: e?.status ?? 'missing', basis: 'entry' };
  });
}

export interface MissingReport {
  month: string;
  /** 비어 있거나 덜 된 항목 */
  emptyItems: Array<{ itemId: string; name: string; tier: number; period: string; status: 'missing' | 'partial' }>;
  /** 확인 안 한 급여: 이달 급여대장이 없거나 초안이거나, 재직 직원 중 줄이 없는 사람 */
  payroll: { state: 'none' | 'draft' | 'confirmed'; revision: number | null; employeesWithoutLine: Array<{ id: string; name: string }> } | null;
  /** 대조되는 종이 증빙·매입 세금계산서가 없는 카드 사용(취소된 승인은 뺀다). 확인용 표시(화면은 기본 접힘). cardSlipEnough면 비운다 */
  cardWithoutEvidence: Array<{ txnId: string; usedOn: string; merchant: string | null; amount: number; hasMemo: boolean }>;
  /** 구간을 바꾼 뒤 다시 잇지 못한 카드 메모 수("메모 대상 확인 필요") */
  memosNeedCheck: number;
  /** 사장님이 "카드 전표로 충분"으로 표시해 이 달은 카드 대조를 빠진 것에서 뺐다(판정 아님, ADR-032) */
  cardSlipEnough: boolean;
  /**
   * 공급가액 + 세액 ≠ 합계인 세금계산서(R15, 산술 차이 표시). 화면은 접힌 항목으로만 보이고 확인을 강제하거나 보내기를 막지 않는다(yulmu 2026-11-05).
   * 엑셀에는 그 행의 메모 칸에만 적는다('빠진 것' 시트에 올리지 않는다)
   */
  invoiceSumGaps: Array<{ direction: 'sales' | 'purchase'; issueDate: string; approvalNo: string; counterpartyName: string; gap: number }>;
}

const nextMonth = (m: string): string => {
  const [y, mm] = m.split('-').map(Number) as [number, number];
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, '0')}`;
};

/** 사장님이 그 달 화면에서 "카드 전표로 충분"을 체크했다: 다음 달부터 카드 대조 표시를 뺀다. 끄려면 clearCardSlipEnough */
export function markCardSlipEnough(db: MonthContext['db'], profileId: string, checkedInMonth: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(checkedInMonth)) throw new BundleError('invalid_month');
  const from = nextMonth(checkedInMonth);
  new BundleRepo(db).setCardSlipEnough(profileId, from);
  return from;
}

export function clearCardSlipEnough(db: MonthContext['db'], profileId: string): void {
  new BundleRepo(db).setCardSlipEnough(profileId, null);
}

/** 날짜 차이(일) */
const dayDiff = (a: string, b: string): number => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** 카드 승인과 그 취소(같은 승인번호·금액)를 지운 나머지 */
export function netOfCancellations(txns: readonly CardTxn[]): CardTxn[] {
  const cancels = txns.filter((t) => t.canceled);
  const used = new Set<string>();
  const out: CardTxn[] = [];
  for (const t of txns) {
    if (t.canceled) continue;
    const c = cancels.find((x) => !used.has(x.id) && x.amount === t.amount && (t.approvalNo ? x.approvalNo === t.approvalNo : x.usedOn === t.usedOn && x.merchantBizNo === t.merchantBizNo));
    if (c) used.add(c.id);
    else out.push(t);
  }
  return out;
}

export interface Evidence {
  day: string;
  amount: number;
  bizNo: string | null;
}

/** 금액이 같고 날짜가 3일 안이고(사업자번호가 둘 다 있으면 같아야) 아직 쓰지 않은 증빙이 있으면 대조됨. 한 증빙은 한 건에만 */
export function unmatchedCardTxns(txns: readonly CardTxn[], evidence: readonly Evidence[], windowDays = 3): CardTxn[] {
  const free = [...evidence];
  const out: CardTxn[] = [];
  for (const t of netOfCancellations(txns)) {
    const i = free.findIndex((ev) => ev.amount === t.amount && dayDiff(ev.day, t.usedOn) <= windowDays && (!ev.bizNo || !t.merchantBizNo || ev.bizNo === t.merchantBizNo));
    if (i >= 0) free.splice(i, 1);
    else out.push(t);
  }
  return out;
}

export function missingReport(ctx: MonthContext): MissingReport {
  const { from, to } = monthRange(ctx.month);
  const emptyItems = monthStatus(ctx)
    .filter((s) => s.status === 'missing' || s.status === 'partial')
    .map((s) => ({ itemId: s.item.id, name: s.item.name, tier: s.item.tier, period: s.period, status: s.status as 'missing' | 'partial' }));

  let payroll: MissingReport['payroll'] = null;
  if (ctx.payrollEnabled) {
    const pr = new PayrollRepo(ctx.db);
    const latest = pr.latest(ctx.profileId, ctx.month);
    const active = new EmployeeRepo(ctx.db, ctx.cipher).list(ctx.profileId, { activeInMonth: ctx.month });
    const withLine = new Set(latest ? pr.lines(ctx.profileId, ctx.month, latest.revision).map((l) => l.employeeId) : []);
    const state = !latest ? 'none' : latest.status === 'draft' ? 'draft' : 'confirmed';
    const employeesWithoutLine = active.filter((e) => !withLine.has(e.id)).map((e) => ({ id: e.id, name: e.name }));
    if (state !== 'confirmed' || employeesWithoutLine.length) payroll = { state, revision: latest?.revision ?? null, employeesWithoutLine };
  }

  const cards = new CardRepo(ctx.db);
  // 증빙 날짜가 달 경계를 넘을 수 있어 앞뒤 3일을 더 본다
  const pad = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const receipts = new ReceiptRepo(ctx.db)
    .list(ctx.profileId, pad(from, -3), pad(to, 3))
    .filter((r) => r.confirmedAt && r.issuedOn && r.amount !== null)
    .map((r) => ({ day: r.issuedOn!, amount: r.amount!, bizNo: r.merchantBizNo }));
  const tidy = tidyInvoices(ctx.taxInvoices ?? []).lines;
  const invoices = tidy.map((l) => l.row).filter((t) => t.direction === 'purchase').map((t) => ({ day: t.issueDate, amount: t.total, bizNo: t.counterpartyBizNo }));
  const memoTxnIds = new Set(cards.memos(ctx.profileId).map((m) => m.txnId));
  const slipFrom = new BundleRepo(ctx.db).cardSlipEnoughFrom(ctx.profileId);
  const cardSlipEnough = slipFrom !== null && ctx.month >= slipFrom;
  const cardWithoutEvidence = cardSlipEnough ? [] : unmatchedCardTxns(cards.txns(ctx.profileId, from, to), [...receipts, ...invoices]).map((t) => ({
    txnId: t.id,
    usedOn: t.usedOn,
    merchant: t.merchant,
    amount: t.amount,
    hasMemo: memoTxnIds.has(t.id),
  }));
  const memosNeedCheck = cards.memos(ctx.profileId).filter((m) => m.txnId === null).length;
  const invoiceSumGaps = tidy
    .filter((l) => l.sumGap !== 0)
    .map((l) => ({ direction: l.row.direction, issueDate: l.row.issueDate, approvalNo: l.row.approvalNo, counterpartyName: l.row.counterpartyName, gap: l.sumGap }));
  return { month: ctx.month, emptyItems, payroll, cardWithoutEvidence, memosNeedCheck, cardSlipEnough, invoiceSumGaps };
}
