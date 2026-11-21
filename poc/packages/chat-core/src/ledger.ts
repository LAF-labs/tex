import { splitVat, won } from './fill.ts';

type Totaled = { total: number | null };

export const supplyOf = (total: number): number => splitVat(total, 'included').supply;

export function sumOf(rows: ReadonlyArray<Totaled>, field: 'supply' | 'total'): number | null {
  return rows.some((r) => r.total === null) ? null : rows.reduce((a, r) => a + (field === 'total' ? r.total! : supplyOf(r.total!)), 0);
}

export function tally(rows: ReadonlyArray<Totaled>): string {
  const known = rows.filter((x) => x.total !== null);
  const gap = rows.length - known.length;
  return `${rows.length}건, 공급가 ${won(sumOf(known, 'supply')!)}, 합계 ${won(sumOf(known, 'total')!)}${gap ? `(금액 모르는 ${gap}건 빼고)` : ''}`;
}

export const newestFirst = <T extends { date: string }>(rows: readonly T[]): T[] => [...rows].sort((a, b) => b.date.localeCompare(a.date));

export function monthOf(today: string, offset: number): string {
  const n = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - 1 + offset;
  return `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}`;
}

export function salesOf<T extends Totaled & { date: string }>(issued: readonly T[], today: string, monthOffset: number): { title: string; rows: T[] } {
  const month = monthOf(today, monthOffset);
  const rows = newestFirst(issued.filter((x) => x.date.startsWith(`${month}-`)));
  return { title: `${Number(month.slice(5))}월 발급 ${tally(rows)}`, rows };
}
