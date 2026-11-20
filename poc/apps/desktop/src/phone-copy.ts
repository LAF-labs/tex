import type { CopyCashflow, CopyCounterparty, MoneySide, PhoneCopyBody } from '@sax/remote';
import type { Counterparty, RunView } from './shell-model.ts';

const CP_REF = /^[A-Za-z0-9_-]{1,40}$/;
const BIZNO = /^\d{3}-\d{2}-\d{5}$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_WON = 100_000_000_000;

const won = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_WON ? (v as number) : null);
const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? Math.min(v as number, 1_000_000) : 0);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function bizNoOf(v: string): string | undefined {
  const d = v.replace(/\D/g, '');
  if (d.length !== 10) return BIZNO.test(v) ? v : undefined;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

export function maskEmail(v: string): string | undefined {
  const at = v.lastIndexOf('@');
  if (at < 1 || at === v.length - 1) return undefined;
  const local = v.slice(0, at);
  const out = `${local.slice(0, Math.min(2, local.length))}***@${v.slice(at + 1)}`;
  return out.length <= 80 ? out : undefined;
}

export function lastIssues(runs: readonly RunView[]): Map<string, CopyCounterparty['last']> {
  const out = new Map<string, NonNullable<CopyCounterparty['last']> & { at: string }>();
  for (const r of runs) {
    if (r.status !== 'done' || r.doc !== 'H-01' || !r.counterparty.id || !DAY.test(r.writeDate)) continue;
    const supply = won(r.supply);
    if (supply === null) continue;
    const prev = out.get(r.counterparty.id);
    if (prev && prev.at >= r.writeDate) continue;
    out.set(r.counterparty.id, { supply, vatMode: r.vat === 'included' ? 'incl' : 'excl', item: clip(r.item, 60), day: r.writeDate, at: r.writeDate });
  }
  return new Map([...out].map(([k, { at, ...v }]) => (void at, [k, v])));
}

export function issueCounts(runs: readonly RunView[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of runs) if (r.status === 'done' && r.doc === 'H-01' && r.counterparty.id) out.set(r.counterparty.id, (out.get(r.counterparty.id) ?? 0) + 1);
  return out;
}

export function copyCounterparties(cps: readonly Counterparty[], last: Map<string, CopyCounterparty['last']>, approver = false, counts: ReadonlyMap<string, number> = new Map()): CopyCounterparty[] {
  const recent = (c: Counterparty) => last.get(c.id)?.day ?? c.lastIssuedOn ?? '';
  const many = (c: Counterparty) => counts.get(c.id) ?? 0;
  return [...cps]
    .filter((c) => CP_REF.test(c.id) && c.name.trim().length > 0)
    .sort((a, b) => (recent(a) !== recent(b) ? (recent(a) < recent(b) ? 1 : -1) : many(b) - many(a) || a.name.localeCompare(b.name, 'ko')))
    .slice(0, 100)
    .map((c) => {
      const row: CopyCounterparty = { ref: c.id, name: clip(c.name.trim(), 60), phoneApprovable: approver && (!!c.lastIssuedOn || last.has(c.id)) };
      const b = bizNoOf(c.bizNo);
      if (b) row.bizNo = b;
      const e = maskEmail(c.email);
      if (e) row.emailHint = e;
      const l = last.get(c.id);
      if (l) row.last = l;
      return row;
    });
}

export interface BankSummaryLike {
  hasAccounts: boolean;
  unpaidCount: number;
  unpaidTotal: number;
  overdueCount: number;
  overdueTotal: number;
  reviewCount: number;
  payable: { unpaidCount: number; unpaidTotal: number; overdueCount: number; overdueTotal: number; dueSoonCount: number; dueSoonTotal: number; reviewCount: number };
}

export interface CashFlowLike {
  month: { month: string; complete: boolean; hasAccounts: boolean; missing: Array<{ bank: string }>; cash: { in: { total: number }; out: { total: number }; net: number } };
  snapshot: { next30: { payOut: number; payOverdue: number; payIn: number; noDuePay: number } };
  alerts: Array<{ id: string; kind: string; gap?: number; cpName?: string | null; priorDays?: number; recentDays?: number; share?: number; total?: number }>;
}

interface ReceivableLike {
  remaining: number;
  dueIn: number | null;
  overdue: boolean;
}

const fmtWon = (n: number) => `${n.toLocaleString('ko-KR')}원`;

export function alertOf(a: CashFlowLike['alerts'][number]): NonNullable<CopyCashflow['alerts']>[number] | null {
  const who = a.cpName ?? '한 거래처';
  switch (a.kind) {
    case 'shortfall':
      return won(a.gap) === null ? null : { id: clip(a.id, 64), kind: 'low_balance', text: `다음 30일에 낼 돈이 통장 잔액과 들어올 돈보다 ${fmtWon(a.gap!)} 많아요` };
    case 'slowdown':
      return { id: clip(a.id, 64), kind: 'slow_collection', text: clip(`${who} 입금이 평소보다 늦어지고 있어요(평균 ${count(a.priorDays)}일 → ${count(a.recentDays)}일)`, 200) };
    case 'concentration':
      return { id: clip(a.id, 64), kind: 'concentration', text: clip(`지난 3개월 매출의 ${Math.round((a.share ?? 0) * 100)}%가 ${who}예요`, 200) };
    case 'unknown_in':
      return won(a.total) === null ? null : { id: clip(a.id, 64), kind: 'unknown_inflow', text: `어디서 온 돈인지 모르는 입금이 ${fmtWon(a.total!)} 있어요. 확인해 둘까요?` };
    default:
      return null;
  }
}

export function copyMoney(s: BankSummaryLike, cf: CashFlowLike | null, recv: readonly ReceivableLike[] | null, accounts: number, now: number): PhoneCopyBody['money'] {
  const soon = (recv ?? []).filter((r) => !r.overdue && r.dueIn !== null && r.dueIn >= 0 && r.dueIn <= 7);
  const side = (x: Omit<MoneySide, 'dueSoonCount' | 'dueSoonTotal'> & Partial<MoneySide>): MoneySide => ({
    unpaidCount: count(x.unpaidCount),
    unpaidTotal: won(x.unpaidTotal) ?? 0,
    overdueCount: count(x.overdueCount),
    overdueTotal: won(x.overdueTotal) ?? 0,
    dueSoonCount: count(x.dueSoonCount),
    dueSoonTotal: won(x.dueSoonTotal) ?? 0,
    reviewCount: count(x.reviewCount),
  });
  const money: NonNullable<PhoneCopyBody['money']> = {
    asOf: now,
    accounts: Math.min(count(accounts), 20),
    receivable: side({ ...s, dueSoonCount: soon.length, dueSoonTotal: soon.reduce((t, r) => t + (won(r.remaining) ?? 0), 0) }),
    payable: side(s.payable),
  };
  if (cf && cf.month.hasAccounts && /^\d{4}-(0[1-9]|1[0-2])$/.test(cf.month.month)) {
    const sure = cf.month.complete;
    const n30 = cf.snapshot.next30;
    money.cashflow = {
      month: cf.month.month,
      complete: sure,
      ...(cf.month.missing.length ? { missing: cf.month.missing.slice(0, 8).map((m) => clip(m.bank || '계좌', 40)) } : {}),
      inTotal: sure ? won(cf.month.cash.in.total) : null,
      outTotal: sure ? won(cf.month.cash.out.total) : null,
      net: sure && Number.isSafeInteger(cf.month.cash.net) && Math.abs(cf.month.cash.net) <= MAX_WON ? cf.month.cash.net : null,
      in30: won(n30.payIn),
      out30: won(n30.payOut + n30.payOverdue),
      noDueOutCount: count(n30.noDuePay),
      alerts: cf.alerts.map(alertOf).filter((a): a is NonNullable<typeof a> => a !== null).slice(0, 4),
    };
  }
  return money;
}

interface PhoneCopySource {
  counterparties: () => readonly Counterparty[];
  runs: () => readonly RunView[];
  bank: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  approval?: () => Promise<{ approver: boolean; left: number }>;
  now?: () => number;
}

interface OverviewLike {
  summary: BankSummaryLike;
  unpaid: ReceivableLike[];
  accounts: unknown[];
}

export async function buildPhoneCopy(src: PhoneCopySource): Promise<PhoneCopyBody> {
  const now = (src.now ?? Date.now)();
  const ap = (await src.approval?.().catch(() => null)) ?? null;
  const body: PhoneCopyBody = { asOf: now, counterparties: copyCounterparties(src.counterparties(), lastIssues(src.runs()), !!ap?.approver, issueCounts(src.runs())) };
  if (ap?.approver) body.todayApprovalsLeft = ap.left;
  try {
    const o = (await src.bank('db.query.bank.overview')) as OverviewLike;
    if (o?.summary?.payable && Array.isArray(o.unpaid) && Array.isArray(o.accounts)) {
      const cf = o.accounts.length ? ((await src.bank('db.query.bank.cashflow').catch(() => null)) as CashFlowLike | null) : null;
      body.money = copyMoney(o.summary, cf, o.unpaid, o.accounts.length, now);
    }
  } catch {
    // 돈 칸 없이(폰은 마지막에 받은 돈 요약을 그대로 둔다)
  }
  return body;
}
