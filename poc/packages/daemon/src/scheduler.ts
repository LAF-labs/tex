// 데몬 스케줄러(D10 §3, notify 모드). main 프로세스가 1분마다 tick()을 부른다. 모든 바깥 일은 주입한 포트로만 한다.
//   DaemonClock  — 지금 시각(시험은 가짜 시계)
//   DaemonSource — 엔진 읽기 전용 질의로 모은 스냅숏(main은 DB 키가 없다). 데몬은 DB·네트워크·금고를 직접 만지지 않는다
//   DaemonSink   — 알림 출력(데스크톱 main: OS 알림 + 이번 달 판 새로 그리기 + 폰 릴레이 큐). 데몬은 받는 쪽이 무엇인지 모른다
//   DaemonStateStore — 억제 기록·시계 가드 저장(값 없음: 알림 id·날짜·시각만)
// 실행 요청은 없다. Phase 1 데몬 효과는 알림뿐이다(ADR-026, D03 §12 R-D1의 issue_document 실행도 Phase 2 semi_auto).
import { POLICY_POLL_MIN, policyFreshness, statusFreshness, type Policy, type PolicyFreshness, type RegistryStatus, type StatusFreshness } from '@sax/engine/core';
import type { DaemonReason } from './consent.ts';
import type { DaemonNotification } from './notification.ts';
import { planNotifications, type ProfileSnapshot } from './plan.ts';
import { addDays, kstDay } from './time.ts';
import { windowOpenFor } from './window.ts';

/** D10 §3 1분 틱 */
export const DAEMON_TICK_MS = 60_000;
/** 스냅숏을 다시 읽는 간격. 엔진이 정책·status를 조회하는 주기(ADR-023 POLICY_POLL_MIN)와 같게 둔다: 하향이 반영되는 때와 데몬이 그걸 보는 때를 맞춘다 */
export const DAEMON_SNAPSHOT_REFRESH_MIN = POLICY_POLL_MIN;
/**
 * 하루 알림 상한(데몬 자체). D10에는 아직 값이 없어 이 PR에서 제안한다(팀장 확인 → D10 개정). 넘친 알림은 버리지 않고 다음 날로 미룬다.
 */
export const DAEMON_MAX_NOTIFICATIONS_PER_DAY = 5;
/** 시계 역행 허용 폭. 이보다 더 뒤로 가면 그 틱은 아무것도 내지 않는다(하루 1회 억제를 되감아 다시 울리는 경로 차단) */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60_000;
/** 틱 사이가 이보다 길면 절전 복귀·앱 재기동으로 보고 스냅숏을 바로 다시 읽는다(ADR-023 결정 2 (b)) */
export const WAKE_GAP_MS = 3 * DAEMON_TICK_MS;
/** D10 §3 실패: 1회 재시도. 알림 한 건을 내는 시도는 하루 최대 2번 */
export const DELIVERY_MAX_ATTEMPTS = 2;
/** 스냅숏 실패 백오프 상한(분). retryAfterMin × 2^(n−1)을 여기서 자른다 */
export const SNAPSHOT_BACKOFF_CAP_MIN = 240;
/** 억제 기록 보존(일) */
export const DELIVERED_RETENTION_DAYS = 400;

/** 서명 정책 policy.daemon이 없을 때(정책을 한 번도 받지 못함) 쓰는 값. D10 §3 본문 값(±30분, 10분 유예, 30분 재시도) */
export const DAEMON_POLICY_FALLBACK: Readonly<Pick<Policy['daemon'], 'windowJitterMin' | 'startupGraceMin' | 'retryAfterMin'>> = Object.freeze({ windowJitterMin: 30, startupGraceMin: 10, retryAfterMin: 30 });

/**
 * 엔진 main 전용 읽기 질의 `daemon.snapshot`의 응답 계약(D10 §3: main은 DB 키가 없다. 쓰기·실행 없음). 예:
 * `{ policy: { expiresAt: '2026-11-09T00:00:00Z', daemon: policy.daemon }, status: { issuedAt, expiresAt }, profiles: [{ profileId, documents: DocumentRepo.list(), validityRules: [], schedules: [], settings: { reminderDay: 5, halfYearWithholding: false }, bundleSentPeriods: ['2026-09'], missing: missingReport({ month: bundlePeriod(today, 5, false)?.period }) ?? null, cardFetchedOn: '2026-10-20' }] }`
 */
export interface DaemonSnapshot {
  /** 엔진이 가진 마지막 유효 정책(서명·클램프를 거친 것) */
  policy: Pick<Policy, 'expiresAt' | 'daemon'> | null;
  /** 마지막 유효 레지스트리 status */
  status: Pick<RegistryStatus, 'issuedAt' | 'expiresAt'> | null;
  profiles: readonly ProfileSnapshot[];
}

export interface DaemonClock {
  now(): number;
}
export interface DaemonSource {
  snapshot(): Promise<DaemonSnapshot>;
}
export interface DaemonSink {
  deliver(n: DaemonNotification): Promise<void> | void;
}
export interface DaemonState {
  v: 1;
  /** 본 시각 중 가장 늦은 것(시계 가드, D07 clock_guard와 같은 뜻) */
  lastSeenAt: number | null;
  /** 낸 알림 id → 낸 날(한국 시간) */
  delivered: Record<string, string>;
  /** 주제(kind:docId 또는 kind:profileId) → 마지막으로 낸 날. 같은 주제는 하루 1회 */
  subjectDay: Record<string, string>;
  /** 오늘 낸 수 */
  dayCount: { day: string; n: number };
  /** 실패한 알림 id → 시도 수·다음 시도 시각·그날 */
  failures: Record<string, { n: number; retryAt: number; day: string }>;
}
export interface DaemonStateStore {
  load(): DaemonState | null;
  save(s: DaemonState): void;
}

export const emptyDaemonState = (): DaemonState => ({ v: 1, lastSeenAt: null, delivered: {}, subjectDay: {}, dayCount: { day: '', n: 0 }, failures: {} });

export class MemoryStateStore implements DaemonStateStore {
  private s: DaemonState | null = null;
  load(): DaemonState | null {
    return this.s ? structuredClone(this.s) : null;
  }
  save(s: DaemonState): void {
    this.s = structuredClone(s);
  }
}

export interface DaemonGate {
  /** 알림은 낸다(로컬 표시뿐이라 포털 접속이 없다) */
  notify: true;
  /** 실행은 하지 않는다(Phase 1). 정책이 신선하지 않으면 Phase 2에서도 데몬 실행은 멈춘다(D12 §4) */
  run: false;
  policy: PolicyFreshness;
  status: StatusFreshness;
  reasons: DaemonReason[];
}

export type TickStatus = 'ok' | 'busy' | 'clock_rollback' | 'startup_grace' | 'no_snapshot';
export type DeferReason = 'window' | 'daily_cap' | 'subject_today' | 'retry_wait';

export interface TickResult {
  at: number;
  status: TickStatus;
  delivered: DaemonNotification[];
  deferred: Array<{ id: string; reason: DeferReason }>;
  failed: Array<{ id: string; attempts: number }>;
  gate: DaemonGate | null;
  /** 원인 코드(D16 daemon.*). 스냅숏을 연달아 못 읽으면 daemon.snapshot_failed */
  cause: 'daemon.snapshot_failed' | null;
}

export interface SchedulerDeps {
  clock: DaemonClock;
  source: DaemonSource;
  sink: DaemonSink;
  store?: DaemonStateStore;
  /** 하루 알림 상한(기본 DAEMON_MAX_NOTIFICATIONS_PER_DAY) */
  maxPerDay?: number;
}

export interface TimerPort {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

/** 스냅숏의 정책·status로 데몬 상태 판정. notify는 항상 켜고 run은 항상 끈다 */
export function daemonGate(s: DaemonSnapshot, now: number): DaemonGate {
  const policy = policyFreshness(s.policy, now);
  const status = statusFreshness(s.status, now);
  const reasons: DaemonReason[] = ['daemon.phase1_notify_only'];
  if (policy !== 'fresh') reasons.push('daemon.policy_stale');
  if (status !== 'fresh') reasons.push('daemon.status_stale');
  return { notify: true, run: false, policy, status, reasons };
}

export class DaemonScheduler {
  private readonly deps: SchedulerDeps;
  private readonly store: DaemonStateStore;
  private state: DaemonState;
  private snapshot: DaemonSnapshot | null = null;
  private loadedAt: number | null = null;
  private nextLoadAt = 0;
  private loadFailures = 0;
  private reloadRequested = true;
  private readonly startedAt: number;
  private running = false;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.store = deps.store ?? new MemoryStateStore();
    const loaded = this.store.load();
    this.state = loaded?.v === 1 ? loaded : emptyDaemonState();
    this.startedAt = deps.clock.now();
  }

  /** 절전 복귀·네트워크 복구·설정 변경(reminderDay 등) 뒤 main이 부른다: 다음 틱에 스냅숏을 다시 읽는다 */
  requestReload(): void {
    this.reloadRequested = true;
    this.nextLoadAt = 0;
  }

  /** 1분 틱을 건다. 돌려준 함수로 멈춘다 */
  start(timers: TimerPort = { setInterval: (f, ms) => setInterval(f, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) }): () => void {
    const h = timers.setInterval(() => void this.tick(), DAEMON_TICK_MS);
    return () => timers.clearInterval(h);
  }

  /** 지금 상태(시험·진단용 복사본) */
  snapshotState(): DaemonState {
    return structuredClone(this.state);
  }

  async tick(): Promise<TickResult> {
    const at = this.deps.clock.now();
    const base = (status: TickStatus, gate: DaemonGate | null = null, cause: TickResult['cause'] = null): TickResult => ({ at, status, delivered: [], deferred: [], failed: [], gate, cause });
    if (this.running) return base('busy');
    this.running = true;
    try {
      return await this.tickInner(at, base);
    } finally {
      this.running = false;
    }
  }

  private async tickInner(at: number, base: (s: TickStatus, g?: DaemonGate | null, c?: TickResult['cause']) => TickResult): Promise<TickResult> {
    const st = this.state;
    // 시계 가드: 본 시각보다 허용 폭 넘게 뒤면 아무것도 내지 않고 본 시각도 고치지 않는다
    if (st.lastSeenAt !== null && at < st.lastSeenAt - CLOCK_ROLLBACK_TOLERANCE_MS) return base('clock_rollback');
    // 절전 복귀: 다시 읽되 실패 백오프는 지킨다(requestReload와 달리 nextLoadAt을 지우지 않는다)
    if (st.lastSeenAt !== null && at - st.lastSeenAt > WAKE_GAP_MS) this.reloadRequested = true;
    st.lastSeenAt = Math.max(st.lastSeenAt ?? at, at);

    const retryMin = this.snapshot?.policy?.daemon.retryAfterMin ?? DAEMON_POLICY_FALLBACK.retryAfterMin;
    const stale = this.loadedAt === null || at - this.loadedAt >= DAEMON_SNAPSHOT_REFRESH_MIN * 60_000;
    let cause: TickResult['cause'] = null;
    if ((this.reloadRequested || stale) && at >= this.nextLoadAt) {
      try {
        this.snapshot = await this.deps.source.snapshot();
        this.loadedAt = at;
        this.loadFailures = 0;
        this.reloadRequested = false;
        this.nextLoadAt = 0;
      } catch {
        this.loadFailures++;
        this.nextLoadAt = at + Math.min(retryMin * 2 ** (this.loadFailures - 1), SNAPSHOT_BACKOFF_CAP_MIN) * 60_000;
      }
    }
    if (this.loadFailures >= DELIVERY_MAX_ATTEMPTS) cause = 'daemon.snapshot_failed';
    const snap = this.snapshot;
    if (!snap) {
      this.persist();
      return base('no_snapshot', null, cause);
    }
    const gate = daemonGate(snap, at);
    const pol = { ...DAEMON_POLICY_FALLBACK, ...(snap.policy?.daemon ?? {}) };
    // 기동 직후 유예(policy.daemon.startupGraceMin): 막 켠 PC에서 알림이 쏟아지지 않게
    if (at - this.startedAt < pol.startupGraceMin * 60_000) {
      this.persist();
      return base('startup_grace', gate, cause);
    }

    const today = kstDay(at);
    if (st.dayCount.day !== today) st.dayCount = { day: today, n: 0 };
    const max = this.deps.maxPerDay ?? DAEMON_MAX_NOTIFICATIONS_PER_DAY;
    const result = base('ok', gate, cause);
    const planned = snap.profiles.flatMap((p) => planNotifications(p, today).notifications).sort((a, b) => a.priority - b.priority || a.notification.id.localeCompare(b.notification.id));
    for (const { notification: n, window } of planned) {
      if (st.delivered[n.id]) continue;
      const subject = `${n.kind}:${n.docId ?? n.profileId}`;
      if (st.subjectDay[subject] === today) {
        result.deferred.push({ id: n.id, reason: 'subject_today' });
        continue;
      }
      const f = st.failures[n.id];
      if (f && f.day === today && (f.n >= DELIVERY_MAX_ATTEMPTS || at < f.retryAt)) {
        result.deferred.push({ id: n.id, reason: 'retry_wait' });
        continue;
      }
      if (!windowOpenFor(window, n.id, today, pol.windowJitterMin, at)) {
        result.deferred.push({ id: n.id, reason: 'window' });
        continue;
      }
      if (st.dayCount.n >= max) {
        result.deferred.push({ id: n.id, reason: 'daily_cap' });
        continue;
      }
      try {
        await this.deps.sink.deliver(structuredClone(n));
        st.delivered[n.id] = today;
        st.subjectDay[subject] = today;
        st.dayCount.n++;
        delete st.failures[n.id];
        result.delivered.push(n);
      } catch {
        const tries = (f && f.day === today ? f.n : 0) + 1;
        st.failures[n.id] = { n: tries, retryAt: at + pol.retryAfterMin * 60_000, day: today };
        result.failed.push({ id: n.id, attempts: tries });
      }
    }
    this.prune(today);
    this.persist();
    return result;
  }

  private prune(today: string): void {
    const cut = addDays(today, -DELIVERED_RETENTION_DAYS);
    const st = this.state;
    for (const [k, d] of Object.entries(st.delivered)) if (d < cut) delete st.delivered[k];
    for (const [k, d] of Object.entries(st.subjectDay)) if (d < today) delete st.subjectDay[k];
    for (const [k, f] of Object.entries(st.failures)) if (f.day < today) delete st.failures[k];
  }

  private persist(): void {
    this.store.save(this.state);
  }
}
