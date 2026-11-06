// 동의 모델(D10 §2·§2.1, D07 schedules). Phase 1 데몬은 notify 모드뿐이다: 동의 레코드를 읽기만 하고 실행을 요청하지 않는다.
// semi_auto·auto 행이 있어도 notify로 강등하고 원인 코드(D16 daemon.demoted_to_notify)를 남긴다.
// notify는 기본 동작이라 동의가 필요 없다. consent_json은 형식만 확인해(B-27 결속 필드) 깨졌으면 daemon.consent_missing으로 알린다.
import { DEFAULT_WINDOW, parseWindow, type RunWindow } from './window.ts';

/** D07 schedules 한 행(엔진 읽기 전용 질의 db.query.schedules가 준다. main은 DB 키가 없다, D10 §3) */
export interface ScheduleRow {
  id: string;
  profileId: string;
  docType: string;
  playbookId: string;
  mode: 'notify' | 'semi_auto' | 'auto';
  windowJson: string | null;
  consentJson: string | null;
  nextDueAt: string | null;
  enabled: boolean;
}

/** B-27 동의 객체 {playbookId, major, effects[], docType, profileId, consentedAt, deviceSig}. 데몬은 읽기만 한다 */
export interface ScheduleConsent {
  playbookId: string;
  major: number;
  effects: string[];
  docType: string;
  profileId: string;
  consentedAt: string;
  deviceSig: string;
}

/** D16 daemon 원인 코드 중 스케줄러가 남기는 것 + window_invalid(D16 추가 후보) */
export type DaemonReason =
  | 'daemon.phase1_notify_only'
  | 'daemon.demoted_to_notify'
  | 'daemon.consent_missing'
  | 'daemon.window_invalid'
  | 'daemon.policy_stale'
  | 'daemon.status_stale';

export interface ScheduleDecision {
  scheduleId: string;
  docType: string;
  /** 이 서류 종류의 알림을 띄우는가(사용자가 끈 일정이면 false) */
  notify: boolean;
  /** 항상 'notify'(Phase 1) */
  mode: 'notify';
  window: RunWindow;
  reasons: DaemonReason[];
}

export function parseConsent(json: string | null): ScheduleConsent | null {
  if (!json) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const str = (k: string) => typeof o[k] === 'string' && (o[k] as string).length > 0;
  if (!str('playbookId') || !str('docType') || !str('profileId') || !str('consentedAt') || !str('deviceSig')) return null;
  if (!Number.isInteger(o.major) || !Array.isArray(o.effects) || !o.effects.every((e) => typeof e === 'string')) return null;
  return { playbookId: o.playbookId as string, major: o.major as number, effects: [...(o.effects as string[])], docType: o.docType as string, profileId: o.profileId as string, consentedAt: o.consentedAt as string, deviceSig: o.deviceSig as string };
}

/** 일정 행 하나 → notify 결정. 실행 모드는 고려하지 않는다(Phase 1에는 실행 경로가 없다) */
export function decideSchedule(row: ScheduleRow): ScheduleDecision {
  const reasons: DaemonReason[] = [];
  if (row.mode !== 'notify') {
    reasons.push('daemon.demoted_to_notify');
    // 동의 결속은 semi_auto 이상에서만 의미가 있다. 깨졌으면 재동의가 필요하다는 것만 알린다.
    const c = parseConsent(row.consentJson);
    if (!c || c.docType !== row.docType || c.profileId !== row.profileId || c.playbookId !== row.playbookId) reasons.push('daemon.consent_missing');
  }
  const parsed = parseWindow(row.windowJson);
  if (row.windowJson && !parsed) reasons.push('daemon.window_invalid');
  return { scheduleId: row.id, docType: row.docType, notify: row.enabled, mode: 'notify', window: parsed ?? { ...DEFAULT_WINDOW, days: [...DEFAULT_WINDOW.days] }, reasons };
}

/** 서류 종류별 결정. 같은 종류의 일정이 여럿이면 하나라도 켜져 있으면 알린다(창은 켜진 첫 일정) */
export function decideSchedules(rows: readonly ScheduleRow[]): Map<string, ScheduleDecision> {
  const out = new Map<string, ScheduleDecision>();
  for (const row of [...rows].sort((a, b) => a.id.localeCompare(b.id))) {
    const d = decideSchedule(row);
    const cur = out.get(d.docType);
    if (!cur || (!cur.notify && d.notify)) out.set(d.docType, { ...d, reasons: [...new Set([...(cur?.reasons ?? []), ...d.reasons])] });
    else cur.reasons = [...new Set([...cur.reasons, ...d.reasons])];
  }
  return out;
}
