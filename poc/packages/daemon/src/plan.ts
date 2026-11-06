// 알림 후보 계산(D10 §2 notify, 02 §5·§17, ADR-032·033). 같은 입력이면 같은 후보(순서 포함). 억제·창·하루 상한은 scheduler가 한다.
// - 서류 만료: remind_days(D07 기본 '7,1')의 각 단계에서 한 번. PC가 꺼져 단계를 놓쳤으면 지금 들어간 단계 하나만 낸다.
// - 세무사 꾸러미 준비됨: 매달 bundle.reminderDay(반기납부 payroll.halfYearWithholding이면 1·7월만)부터 그 달 말까지, 안 보냈으면.
// - 확인 안 한 급여·사업용 카드 최신화: 같은 날에 @sax/bundle missingReport 결과와 마지막 최신화 날짜로. 자동 조회는 없다.
import type { MissingReport } from '@sax/bundle';
import { decideSchedules, type ScheduleDecision, type ScheduleRow } from './consent.ts';
import { computeExpiries, type Expiry, type ExpiryDocInput, type ExpiryOptions, type ValidityRuleRow } from './expiry.ts';
import { assertSafePayload, TITLE_KEY, type DaemonNotification } from './notification.ts';
import { addMonths, daysBetween, dayOf, isDate, lastDayOf, MONTH_RE } from './time.ts';
import { DEFAULT_WINDOW, type RunWindow } from './window.ts';

/** 프로필 하나의 데몬 입력. 엔진 읽기 전용 질의로 모은다(main은 DB 키가 없다, D10 §3) */
export interface ProfileSnapshot {
  profileId: string;
  documents: readonly ExpiryDocInput[];
  validityRules: readonly ValidityRuleRow[];
  schedules: readonly ScheduleRow[];
  settings: {
    /** profile.<id>.bundle.reminderDay(1~28) */
    reminderDay: number;
    /** profile.<id>.payroll.halfYearWithholding */
    halfYearWithholding: boolean;
    /** 사업연도 끝 달(기본 12) */
    fiscalYearEndMonth?: number;
    /** D10 §4 lead_days(기본 7) */
    leadDays?: number;
  };
  /** 보낸 표시가 있는 꾸러미 달(bundle_exports.sent_marked_at이 있는 period) */
  bundleSentPeriods: readonly string[];
  /** bundlePeriod()가 준 달의 @sax/bundle missingReport. 아직 계산 못 했으면 null */
  missing: MissingReport | null;
  /** 사업용 카드 내역 마지막 최신화 날짜(card_fetches). 없으면 null */
  cardFetchedOn: string | null;
  submitOn?: ExpiryOptions['submitOn'];
}

export interface PlannedNotification {
  notification: DaemonNotification;
  /** 이 알림을 띄워도 되는 창 */
  window: RunWindow;
  /** 같은 날 상한에 걸렸을 때 먼저 낼 순서(작을수록 먼저) */
  priority: number;
}

export interface Plan {
  expiries: Expiry[];
  schedules: Map<string, ScheduleDecision>;
  notifications: PlannedNotification[];
}

/**
 * 오늘 기준 꾸러미 알림 정보. 알림 달이 아니면 null.
 * 반기납부면 1월(지난해 7~12월)·7월(1~6월)에만 알린다. period는 꾸러미 달(알림 달의 전달)이다.
 */
export function bundlePeriod(today: string, reminderDay: number, halfYear: boolean): { period: string; remindOn: string; until: string } | null {
  const month = today.slice(0, 7);
  if (halfYear && !['01', '07'].includes(month.slice(5, 7))) return null;
  const remindOn = dayOf(month, Number.isFinite(reminderDay) ? reminderDay : 1);
  const until = lastDayOf(month);
  if (today < remindOn || today > until) return null;
  return { period: addMonths(month, -1), remindOn, until };
}

/** remind_days 중 지금 들어간 단계(남은 날 ≤ 단계인 것 중 가장 작은 것). 없으면 null. 지난 서류는 null(판이 보여 준다) */
export function expiryStage(daysLeft: number, remindDays: readonly number[]): number | null {
  if (daysLeft < 0) return null;
  const hit = remindDays.filter((o) => daysLeft <= o);
  return hit.length ? Math.min(...hit) : null;
}

function push(out: PlannedNotification[], n: DaemonNotification, window: RunWindow, priority: number) {
  assertSafePayload(n.payload as unknown as Record<string, unknown>);
  out.push({ notification: n, window, priority });
}

/** 프로필 하나의 오늘 알림 후보 */
export function planNotifications(s: ProfileSnapshot, today: string): Plan {
  if (!isDate(today)) throw new Error('daemon.invalid_today');
  const schedules = decideSchedules(s.schedules.filter((r) => r.profileId === s.profileId));
  const expiries = computeExpiries(s.documents, s.validityRules, { today, leadDays: s.settings.leadDays, fiscalYearEndMonth: s.settings.fiscalYearEndMonth, submitOn: s.submitOn });
  const out: PlannedNotification[] = [];
  const defaultWindow = (): RunWindow => ({ ...DEFAULT_WINDOW, days: [...DEFAULT_WINDOW.days] });

  for (const e of expiries) {
    if (e.superseded || !e.expiresOn || e.daysLeft === null) continue;
    const sched = schedules.get(e.docType);
    if (sched && !sched.notify) continue;
    const stage = expiryStage(e.daysLeft, e.remindDays);
    if (stage === null) continue;
    push(
      out,
      {
        id: `doc.expiring:${e.docId}:${e.expiresOn}:${stage}`,
        kind: 'doc.expiring',
        profileId: s.profileId,
        docId: e.docId,
        dueOn: e.expiresOn,
        title: TITLE_KEY['doc.expiring'],
        payload: { docType: e.docType, daysLeft: e.daysLeft, stage, estimated: e.estimated },
        target: { to: 'doc', id: e.docId },
      },
      sched?.window ?? defaultWindow(),
      e.daysLeft,
    );
  }

  const bp = bundlePeriod(today, s.settings.reminderDay, s.settings.halfYearWithholding);
  if (bp && MONTH_RE.test(bp.period)) {
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    const key = `${s.profileId}:${bp.period}`;
    const missing = s.missing && s.missing.month === bp.period ? s.missing : null;
    if (!s.bundleSentPeriods.includes(bp.period)) {
      push(
        out,
        {
          id: `bundle.ready:${key}`,
          kind: 'bundle.ready',
          profileId: s.profileId,
          dueOn: bp.remindOn,
          title: TITLE_KEY['bundle.ready'],
          payload: { month: bp.period, halfYear: s.settings.halfYearWithholding, missingCount: Math.min(missing?.emptyItems.length ?? 0, 999) },
          target: { to: 'view', view: 'bundle' },
        },
        defaultWindow(),
        100,
      );
    }
    const pr = missing?.payroll;
    if (pr) {
      push(
        out,
        {
          id: `payroll.unconfirmed:${key}`,
          kind: 'payroll.unconfirmed',
          profileId: s.profileId,
          dueOn: bp.remindOn,
          title: TITLE_KEY['payroll.unconfirmed'],
          payload: { month: bp.period, state: pr.state, employeesWithoutLine: Math.min(pr.employeesWithoutLine.length, 999) },
          target: { to: 'view', view: 'payroll' },
        },
        defaultWindow(),
        101,
      );
    }
    // 지난달 내역을 다 담으려면 이번 달 1일 이후에 최신화했어야 한다. 알림만 한다(ADR-032 결정 3, ADR-026: 데몬은 조회하지 않는다)
    const fetched = isDate(s.cardFetchedOn) ? s.cardFetchedOn : null;
    if (!fetched || fetched < firstOfMonth) {
      push(
        out,
        {
          id: `card.stale:${key}`,
          kind: 'card.stale',
          profileId: s.profileId,
          dueOn: bp.remindOn,
          title: TITLE_KEY['card.stale'],
          payload: { daysSinceFetch: fetched ? Math.min(daysBetween(fetched, today), 999) : null },
          target: { to: 'view', view: 'card' },
        },
        defaultWindow(),
        102,
      );
    }
  }

  out.sort((a, b) => a.priority - b.priority || a.notification.id.localeCompare(b.notification.id));
  return { expiries, schedules, notifications: out };
}
