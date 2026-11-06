// 실행 창(D10 §3: 요일·시간대)과 시각 지터(서명 정책 policy.daemon.windowJitterMin, ±30분).
// notify 모드에서는 창이 "알림을 띄워도 되는 때"다. 지터는 같은 시각에 알림이 몰리지 않게 키·날짜마다 결정적으로 고른다.
import { fnv1a, kstMinute, kstWeekday } from './time.ts';

export interface RunWindow {
  /** 한국 시간 요일(0=일 ~ 6=토) */
  days: number[];
  /** 시작 분(0~1439, 포함) */
  fromMin: number;
  /** 끝 분(1~1440, 제외). fromMin보다 커야 한다(자정을 넘는 창은 받지 않는다) */
  toMin: number;
}

/**
 * schedules.window_json이 없거나 읽지 못할 때 쓰는 창: 매일 09:00~18:00(한국 시간).
 * D10은 창의 기본값을 정하지 않았다(업무 시간). 주말을 빼면 토·일에 걸린 D-1 알림이 사라지므로 매일로 둔다.
 */
export const DEFAULT_WINDOW: Readonly<RunWindow> = Object.freeze({ days: [0, 1, 2, 3, 4, 5, 6], fromMin: 9 * 60, toMin: 18 * 60 });

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const toMin = (s: string) => {
  const m = HHMM.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** window_json {"days":[1,2,3,4,5],"from":"09:00","to":"18:00"} → RunWindow. 형식이 틀리면 null(호출 쪽이 기본 창 + 원인 코드) */
export function parseWindow(json: string | null | undefined): RunWindow | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as { days?: unknown; from?: unknown; to?: unknown };
  if (!Array.isArray(o.days) || o.days.length === 0 || !o.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return null;
  if (typeof o.from !== 'string' || typeof o.to !== 'string') return null;
  const from = toMin(o.from);
  const to = o.to === '24:00' ? 1440 : toMin(o.to);
  if (from === null || to === null || to <= from) return null;
  return { days: [...new Set(o.days as number[])].sort(), fromMin: from, toMin: to };
}

export const inWindow = (w: RunWindow, ms: number): boolean => {
  const m = kstMinute(ms);
  return w.days.includes(kstWeekday(ms)) && m >= w.fromMin && m < w.toMin;
};

/**
 * 그날 이 키의 알림을 띄우기 시작할 분. 창 시작 + [0, 2×지터] 중 결정적 한 값(창 시작을 기준으로 ±지터를 앞으로 민 것).
 * 창 끝 1분 전을 넘지 않는다. 지터가 0이면 창 시작.
 */
export function fireMinute(w: RunWindow, key: string, day: string, jitterMin: number): number {
  const j = Math.max(0, Math.trunc(jitterMin));
  const offset = j === 0 ? 0 : fnv1a(`${key}|${day}`) % (2 * j + 1);
  return Math.min(w.fromMin + offset, w.toMin - 1);
}

/** 지금 이 키의 알림을 띄워도 되는가(창 안이고 지터 시각이 지났다) */
export const windowOpenFor = (w: RunWindow, key: string, day: string, jitterMin: number, ms: number): boolean =>
  inWindow(w, ms) && kstMinute(ms) >= fireMinute(w, key, day, jitterMin);
