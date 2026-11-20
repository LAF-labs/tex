import { roundRational } from './money.ts';

export interface ShiftLike {
  workDay: string;
  startsAt: string;
  endsAt: string;
  breakMinutes: number;
}

export class ShiftError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (t: string): number => {
  const m = HHMM.exec(t);
  if (!m) throw new ShiftError('invalid_time');
  return Number(m[1]) * 60 + Number(m[2]);
};

/** 한 근무의 일한 분(휴게 뺌). 24시간 이상 근무는 받지 않는다 */
export function shiftMinutes(s: ShiftLike): number {
  const start = toMin(s.startsAt);
  let end = toMin(s.endsAt);
  if (end === start) throw new ShiftError('empty_shift');
  if (end < start) end += 24 * 60;
  const span = end - start;
  if (!Number.isSafeInteger(s.breakMinutes) || s.breakMinutes < 0 || s.breakMinutes >= span) throw new ShiftError('invalid_break');
  return span - s.breakMinutes;
}

export interface MonthHours {
  workDays: number;
  workMinutes: number;
  byDay: Record<string, number>;
}

/** 그달(근무일 기준) 근무 합계. 다른 달 근무가 섞여 있으면 거부한다 */
export function monthHours(month: string, shifts: readonly ShiftLike[]): MonthHours {
  const byDay: Record<string, number> = {};
  for (const s of shifts) {
    if (!s.workDay.startsWith(`${month}-`)) throw new ShiftError('shift_outside_month');
    byDay[s.workDay] = (byDay[s.workDay] ?? 0) + shiftMinutes(s);
  }
  const workMinutes = Object.values(byDay).reduce((a, b) => a + b, 0);
  return { workDays: Object.keys(byDay).length, workMinutes, byDay };
}

/** 시급 × 분 / 60, 원 미만 절사 */
export function hourlyPay(hourlyWage: number, minutes: number): number {
  if (!Number.isSafeInteger(hourlyWage) || hourlyWage < 0 || !Number.isSafeInteger(minutes) || minutes < 0) throw new ShiftError('invalid_hourly');
  return roundRational(BigInt(hourlyWage) * BigInt(minutes), 60n, 'floor_1');
}
