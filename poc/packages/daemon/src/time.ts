// 한국 시간(UTC+9, 서머타임 없음) 달력 도우미. 데몬의 모든 "오늘"·"하루 1회"·실행 창은 이 시간으로 센다.
// 시계는 주입한다(DaemonClock). 여기 함수는 숫자(ms)만 받고 Date.now()를 부르지 않는다.

const DAY_MS = 86_400_000;
const KST_MS = 9 * 3_600_000;

const pad = (n: number) => String(n).padStart(2, '0');
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const dayNum = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / DAY_MS;

export const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export const isDate = (s: unknown): s is string => typeof s === 'string' && DATE_RE.test(s) && isoDay(Date.parse(`${s}T00:00:00Z`)) === s;

/** 한국 시간 날짜(YYYY-MM-DD) */
export const kstDay = (ms: number): string => isoDay(ms + KST_MS);
/** 한국 시간 그날 0시부터 지난 분(0~1439) */
export const kstMinute = (ms: number): number => Math.floor((((ms + KST_MS) % DAY_MS) + DAY_MS) % DAY_MS / 60_000);
/** 한국 시간 요일(0=일 ~ 6=토) */
export const kstWeekday = (ms: number): number => new Date(ms + KST_MS).getUTCDay();

export const addDays = (iso: string, n: number): string => isoDay(Date.parse(`${iso}T00:00:00Z`) + n * DAY_MS);
/** a에서 b까지 날 수(b - a). 같은 날 0 */
export const daysBetween = (a: string, b: string): number => Math.round(dayNum(b) - dayNum(a));

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
}

/** 그 달의 day일(달의 날 수를 넘으면 마지막 날). 데스크톱 board.ts dayOf와 같은 규칙 */
export function dayOf(month: string, day: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${pad(Math.min(Math.max(1, Math.trunc(day)), last))}`;
}

/** 그 달 말일 */
export const lastDayOf = (month: string): string => dayOf(month, 31);

/** 날짜에 n달을 더한다(말일 넘침은 그 달 말일). "말일 + 3개월" 계산용 */
export function addMonthsToDay(iso: string, n: number): string {
  const d = Number(iso.slice(8, 10));
  const m = addMonths(iso.slice(0, 7), n);
  const wasLast = iso === lastDayOf(iso.slice(0, 7));
  return wasLast ? lastDayOf(m) : dayOf(m, d);
}

/** FNV-1a 32비트. 지터를 키·날짜마다 결정적으로 고르는 데만 쓴다(보안 용도 아님) */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
