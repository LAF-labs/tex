// 사업용 카드 내역 화면(08 D-04, D14 M6-3)의 데이터: 그달 행과 건별 메모, "마지막 최신화: n일 전", 그달이 조회로 다 덮였는지,
// 행이 바뀌어 다시 잇지 못한 메모("확인 필요"). 읽기만 한다. [최신화] 실행은 플레이북(H-12, M6-1) 몫이다.
// 모델을 부르지 않는다(ADR-032 결정 11). 용도 분류·경비 인정 판단은 하지 않는다(결정 3).
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
  /** 이 행에 이어진 메모 */
  memo: { id: string; text: string; updatedAt: string } | null;
}

/** 다시 잇지 못한 메모. 사장님이 행을 골라 card.reattachMemo로 잇거나 card.deleteMemo로 지운다 */
export interface DetachedMemoView {
  id: string;
  text: string;
  /** 메모가 붙어 있던 거래의 사용일·금액(매칭 키에서 읽음, 화면에서 어느 건이었는지 알리려고) */
  usedOn: string | null;
  amount: number | null;
  updatedAt: string;
}

export interface CardMonthView {
  month: string;
  /** 마지막 최신화(어느 달이든). 한 번도 안 했으면 null */
  lastFetch: { completedAt: string; rangeFrom: string; rangeTo: string } | null;
  /** 마지막 최신화가 며칠 전인가(한국 날짜 기준, 오늘이면 0) */
  daysSinceFetch: number | null;
  /** 그달(이번 달이면 오늘까지)이 조회 구간으로 다 덮였는가 */
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

/** 매칭 키(a|사용일|승인번호|취소|금액#n, d|사용일|사업자번호|금액|카드|취소#n)에서 사용일·금액 */
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
  // 이번 달이면 오늘까지만 본다(앞날은 조회할 수 없다). 다음 달 이후는 덮을 날이 없다
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
