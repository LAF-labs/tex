// 근무표 계산(D14 M6-15, ADR-034 결정 8): 근무 시작·끝·휴게 → 분 단위 근무 시간 → 달 합계 → 시급제 기본급.
// 연장·야간·휴일 가산과 주휴는 계산하지 않는다(yulmu 확답 2026-11-05: 사장님이 세전 금액에 반영). 근무 합계는 세전 제안값(suggestGross)까지만.
import { roundRational } from './money.ts';

export interface ShiftLike {
  /** 'YYYY-MM-DD'. 자정을 넘긴 근무는 시작한 날에 센다 */
  workDay: string;
  /** 'HH:MM' */
  startsAt: string;
  /** 'HH:MM'. 시작보다 이르면 다음 날 끝난 것으로 본다 */
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
  /** 그달 근무일 수(근무가 있는 서로 다른 날) */
  workDays: number;
  workMinutes: number;
  /** 날짜별 분 */
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
