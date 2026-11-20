import { CardRepo, type CardFetch, type Db } from '@sax/db';
import { monthRange } from './items.ts';

export interface CardRowView {
  id: string;
  usedOn: string;
  merchant: string | null;
  merchantBizNo: string | null;
  cardLast4: string | null;
  approvalNo: string | null;
  amount: number;
  supplyAmount: number | null;
  vatAmount: number | null;
  canceled: boolean;
  memo: { id: string; text: string; updatedAt: string } | null;
}

/** 다시 잇지 못한 메모. 사장님이 행을 골라 card.reattachMemo로 잇거나 card.deleteMemo로 지운다 */
export interface DetachedMemoView {
  id: string;
  text: string;
  usedOn: string | null;
  amount: number | null;
  updatedAt: string;
}

export interface CardMonthView {
  month: string;
  lastFetch: { completedAt: string; rangeFrom: string; rangeTo: string } | null;
  daysSinceFetch: number | null;
  coverage: 'full' | 'partial' | 'none';
  rows: CardRowView[];
  detachedMemos: DetachedMemoView[];
}

const kstDay = (d: Date): string => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const dayNum = (d: string): number => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const addDays = (d: string, n: number): string => new Date((dayNum(d) + n) * 86_400_000).toISOString().slice(0, 10);

/** 조회 구간들이 [from, to]를 빈틈없이 덮는지 */
export function coverageOf(fetches: readonly Pick<CardFetch, 'rangeFrom' | 'rangeTo'>[], from: string, to: string): CardMonthView['coverage'] {
  if (from > to) return 'full';
  const spans = fetches.filter((f) => f.rangeTo >= from && f.rangeFrom <= to).sort((a, b) => (a.rangeFrom < b.rangeFrom ? -1 : 1));
  if (!spans.length) return 'none';
  let reach = addDays(from, -1);
  for (const s of spans) {
    if (s.rangeFrom > addDays(reach, 1)) return 'partial';
    if (s.rangeTo > reach) reach = s.rangeTo;
    if (reach >= to) return 'full';
  }
  return 'partial';
}

function keyFacts(key: string): { usedOn: string | null; amount: number | null } {
  const parts = key.replace(/#\d+$/, '').split('|');
  const usedOn = /^\d{4}-\d{2}-\d{2}$/.test(parts[1] ?? '') ? parts[1]! : null;
  const raw = parts[0] === 'a' ? parts[4] : parts[0] === 'd' ? parts[3] : undefined;
  const amount = raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : null;
  return { usedOn, amount };
}

export function cardMonthView(db: Db, profileId: string, month: string, now: Date): CardMonthView {
  const repo = new CardRepo(db);
  const { from, to } = monthRange(month);
  const today = kstDay(now);
  const last = repo.lastFetch(profileId);
  const memos = repo.memos(profileId);
  const byTxn = new Map(memos.filter((m) => m.txnId).map((m) => [m.txnId!, m]));
  const rows = repo.txns(profileId, from, to).map((t): CardRowView => {
    const m = byTxn.get(t.id);
    return {
      id: t.id, usedOn: t.usedOn, merchant: t.merchant, merchantBizNo: t.merchantBizNo, cardLast4: t.cardLast4, approvalNo: t.approvalNo,
      amount: t.amount, supplyAmount: t.supplyAmount, vatAmount: t.vatAmount, canceled: t.canceled,
      memo: m ? { id: m.id, text: m.memo, updatedAt: m.updatedAt } : null,
    };
  });
  const detachedMemos = memos
    .filter((m) => m.txnId === null)
    .map((m) => ({ m, f: keyFacts(m.matchKey) }))
    .filter(({ f }) => f.usedOn !== null && f.usedOn >= from && f.usedOn <= to)
    .map(({ m, f }) => ({ id: m.id, text: m.memo, usedOn: f.usedOn, amount: f.amount, updatedAt: m.updatedAt }));
  const coverTo = to < today ? to : today;
  const coverage = from > today ? 'none' : coverageOf(repo.fetchesOverlapping(profileId, from, coverTo), from, coverTo);
  return {
    month,
    lastFetch: last ? { completedAt: last.completedAt, rangeFrom: last.rangeFrom, rangeTo: last.rangeTo } : null,
    daysSinceFetch: last ? Math.max(0, dayNum(today) - dayNum(kstDay(new Date(last.completedAt)))) : null,
    coverage,
    rows,
    detachedMemos,
  };
}
