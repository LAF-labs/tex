
/** 공급가액 상한(엔진 draft()와 같다) */
export const LINE_SUPPLY_MAX = 1e15;

const pad = (n: number) => String(n).padStart(2, '0');
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** 작성일자 인자 → 날짜. 둘 다 null이면 null(오늘). 없는 날·모양이 틀리면 'bad'. */
export function draftDate(today: string, monthOffset: unknown, day: unknown): string | null | 'bad' {
  if ((monthOffset === null || monthOffset === undefined) && (day === null || day === undefined)) return null;
  const off = monthOffset === null || monthOffset === undefined ? 0 : monthOffset;
  if (typeof off !== 'number' || !Number.isInteger(off) || off > 0 || off < -12) return 'bad';
  const [ty, tm] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const idx = ty * 12 + (tm - 1) + off;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const last = daysIn(y, m);
  const d = day === null || day === undefined ? (off === 0 ? Number(today.slice(8, 10)) : null) : String(day).trim() === 'last' ? last : /^\d{1,2}$/.test(String(day).trim()) ? Number(String(day).trim()) : null;
  if (d === null || d < 1 || d > last) return 'bad';
  return `${y}-${pad(m)}-${pad(d)}`;
}

/**
 * 작성일자 규칙(ADR-049 결정 2). ok: 받는다. late: 받되 기한 경과 한 줄(국세청 안내 기준, 막지 않음, 2026-11-17 결정).
 * future: 받지 않는다. past_period: 그 날이 든 과세기간의 확정신고기한(1기 7월 25일, 2기 다음 해 1월 25일)이 지났다. 실화면 확인 전까지 받지 않는다.
 */
export type IssueDateRule = 'ok' | 'late' | 'future' | 'past_period';
export function issueDateRule(date: string, today: string): IssueDateRule {
  if (date > today) return 'future';
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const filing = m <= 6 ? `${y}-07-25` : `${y + 1}-01-25`;
  if (today > filing) return 'past_period';
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return today > `${ny}-${pad(nm)}-10` ? 'late' : 'ok';
}

/** 수량 인자 → 양의 정수. 소수·0·모양이 틀리면 null(1단계는 정수만, ADR-049 결정 6). */
export function parseQuantity(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/[\s,]/g, '').replace(/(개|건|kg|g|ea|박스|box|병|장|대|회|시간|명|식|세트|set)$/i, '');
  if (!/^\d{1,9}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

/** 수량 × 단가 → 공급가액(정수 곱, 상한 넘으면 null). */
export function lineSupply(quantity: number, unitPrice: number): number | null {
  const v = quantity * unitPrice;
  return Number.isSafeInteger(v) && v > 0 && v <= LINE_SUPPLY_MAX ? v : null;
}

/** 화면 날짜 "10월 31일"(연도가 오늘과 다르면 "2025년 12월 31일") */
export function shortDate(date: string, today: string): string {
  const s = `${Number(date.slice(5, 7))}월 ${Number(date.slice(8, 10))}일`;
  return date.slice(0, 4) === today.slice(0, 4) ? s : `${Number(date.slice(0, 4))}년 ${s}`;
}
