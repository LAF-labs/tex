import { performance } from 'node:perf_hooks';
import { RateRepo, type Db } from '@sax/db';
import type { Dialog, Page } from 'playwright-core';
import type { Policy } from './core/index.ts';
import { pathExpected, type PortalConfig } from './portal.ts';
import { RunEnd, type RunnerPolicy } from './run-end.ts';
import { SIGNAL_DICT, SignalWatch, type InspectUnavailable, type SignalDict, type SignalHit, type SignalKind } from './signals.ts';


export interface RatePolicy {
  pace: { stepDelayMs: readonly [number, number]; afterNavSettleMs: readonly [number, number]; slowFactor: number };
  limits: { runsPerDayPerProfile: number; irreversiblePerDayPerProfile: number; runsPerLoginSession: number; navigationsPerMin: number; loginsPerDay: number; concurrent: number };
  run: { maxActuationsPerRun: number; maxWallClockMs: number };
  cooldown: { onBlockSignalHours: number; positiveDetectionsForCooldown: number };
}

const freeze = <T>(o: T): T => {
  for (const v of Object.values(o as object)) if (v && typeof v === 'object') freeze(v);
  return Object.freeze(o);
};

/**
 * D03 §7 정책 예시의 interactive 프로필·run·cooldown 값. 사용량 상한 4개는 사장님이 월말에 하루 몰아 발급해도 닿지 않게 정책 스키마
 * 최대값까지 올렸다(대표 결정 2026-11-12). 받은 서명 정책과 엄격한 쪽으로 합치므로 이보다 높이면 효과가 없다.
 * - irreversiblePerDayPerProfile 50: 발급 1건이 실행 1번이고 실행은 하나씩 몇 분 걸린다. 50건이면 한나절이다.
 * - runsPerDayPerProfile 100: 발급 50건마다 실패·중지 뒤 다시 준비하는 실행 1번씩을 더한 값이다.
 * - runsPerLoginSession 30: 발급 50건을 로그인 2번에 나눠 끝낸다.
 * - loginsPerDay 12: 세션이 끊길 때마다 다시 로그인해도 근무 시간 동안 40분에 1번꼴이다.
 */
export const HOMETAX_POLICY: RatePolicy = freeze({
  pace: { stepDelayMs: [800, 2500], afterNavSettleMs: [600, 1500], slowFactor: 1.5 },
  limits: { runsPerDayPerProfile: 100, irreversiblePerDayPerProfile: 50, runsPerLoginSession: 30, navigationsPerMin: 12, loginsPerDay: 12, concurrent: 1 },
  run: { maxActuationsPerRun: 150, maxWallClockMs: 1_800_000 },
  cooldown: { onBlockSignalHours: 24, positiveDetectionsForCooldown: 2 },
});

/** 가짜 H-01 페이지 전용(시험이 빨리 끝나게): 지연과 분당 네비게이션만 다르고 나머지는 홈택스와 같다. kind로 나눠 섞이지 않게 한다. */
export const FIXTURE_POLICY: RatePolicy = freeze({
  ...HOMETAX_POLICY,
  pace: { stepDelayMs: [10, 40], afterNavSettleMs: [10, 40], slowFactor: 1.5 },
  limits: { ...HOMETAX_POLICY.limits, navigationsPerMin: 600 },
});

/**
 * 포털 kind의 내장 정책. 정책이 없는 포털(정부24·위택스 등)은 자동화하지 않는다(fail-closed, D03 §7.1
 * "포털 키가 없으면 그 포털은 postprocess").
 */
export function policyFor(kind: string): RatePolicy {
  if (kind === 'hometax') return HOMETAX_POLICY;
  if (kind === 'fixture') return FIXTURE_POLICY;
  throw new RunEnd('failed', 'policy.portal_mode_denied');
}

/**
 * 두 요청률 값 가운데 필드마다 더 엄격한 쪽(D03 §7 "정책은 강화만", 팀장 결정 2026-11-09 ③). 방향은 D03 §7.1 보수 방향 표와 같다:
 * 지연·쿨다운 시간·slowFactor는 큰 쪽, 횟수·상한은 작은 쪽. b가 없으면 a.
 */
export function stricterRate(a: RatePolicy, b: RatePolicy | null): RatePolicy {
  if (!b) return a;
  const hi = Math.max;
  const lo = Math.min;
  const range = (x: readonly [number, number], y: readonly [number, number]) => [hi(x[0], y[0]), hi(x[1], y[1])] as const;
  return {
    pace: { stepDelayMs: range(a.pace.stepDelayMs, b.pace.stepDelayMs), afterNavSettleMs: range(a.pace.afterNavSettleMs, b.pace.afterNavSettleMs), slowFactor: hi(a.pace.slowFactor, b.pace.slowFactor) },
    limits: {
      runsPerDayPerProfile: lo(a.limits.runsPerDayPerProfile, b.limits.runsPerDayPerProfile),
      irreversiblePerDayPerProfile: lo(a.limits.irreversiblePerDayPerProfile, b.limits.irreversiblePerDayPerProfile),
      runsPerLoginSession: lo(a.limits.runsPerLoginSession, b.limits.runsPerLoginSession),
      navigationsPerMin: lo(a.limits.navigationsPerMin, b.limits.navigationsPerMin),
      loginsPerDay: lo(a.limits.loginsPerDay, b.limits.loginsPerDay),
      concurrent: lo(a.limits.concurrent, b.limits.concurrent),
    },
    run: { maxActuationsPerRun: lo(a.run.maxActuationsPerRun, b.run.maxActuationsPerRun), maxWallClockMs: lo(a.run.maxWallClockMs, b.run.maxWallClockMs) },
    cooldown: { onBlockSignalHours: hi(a.cooldown.onBlockSignalHours, b.cooldown.onBlockSignalHours), positiveDetectionsForCooldown: lo(a.cooldown.positiveDetectionsForCooldown, b.cooldown.positiveDetectionsForCooldown) },
  };
}

/**
 * 받은 서명 정책의 verify 타이밍과 내장(포털) 값 가운데 필드마다 더 엄격한 쪽(팀장 결정 2026-11-09, D03 §5.6·§7.1 verify 행).
 * 엄격 = 부재 증거를 더 오래·더 많이 모은다: minElapsedMs·lookups·maxMs 모두 큰 쪽. maxMs는 minElapsedMs보다 짧게 두지 않는다
 * (그러면 not_committed가 성립할 수 없다). 조회 간격(intervalMs)은 정책에 필드가 없어 내장 값 그대로다. b가 없으면 a.
 */
export function stricterVerify(a: PortalConfig['verify'], b: Policy['verify'] | null | undefined): PortalConfig['verify'] {
  if (!b) return a;
  const minElapsedMs = Math.max(a.minElapsedMs, b.minElapsedMs);
  return { minElapsedMs, lookups: Math.max(a.lookups, b.lookups), intervalMs: a.intervalMs, maxMs: Math.max(a.maxMs, b.maxMs ?? 0, minElapsedMs) };
}

/** 실행 하나의 포털 설정: 홈택스면 verify 타이밍만 받은 정책과 엄격한 쪽으로 합친 사본(fixture·정책 없음은 그대로). */
export function runPortalConfig(portal: PortalConfig, policy: Policy | null): PortalConfig {
  if (portal.kind !== 'hometax' || !policy) return portal;
  return { ...portal, verify: stricterVerify(portal.verify, policy.verify) };
}

/** 추가 인증이 이만큼 연속이면 차단 신호(D03 §7 (c)). 로그인 구간의 추가 인증은 세지 않는다. */
export const EXTRA_AUTH_FOR_SIGNAL = 2;
/** 기대 화면(체크포인트)에 닿지 못하고 끝난 실행이 이만큼 연속이면 보수 모드, 그 다음 단계는 양성 탐지 1회(ADR-025 결정 3). */
export const UNKNOWN_SCREEN_CONSERVATIVE = 2;
export const UNKNOWN_SCREEN_POSITIVE = 3;
/** 벽시계가 유효 시각보다 이만큼 넘게 뒤면 시계 역행(보수 모드). NTP 미세 조정은 넘긴다. */
export const CLOCK_ROLLBACK_TOLERANCE_MS = 2_000;

const kst = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString().slice(0, 19);
export const kstDay = (ms: number) => kst(ms).slice(0, 10);
const kst10m = (ms: number) => kst(ms).slice(0, 15);

export interface Clock {
  wall(): number;
  mono(): number;
}
const SYSTEM_CLOCK: Clock = { wall: () => Date.now(), mono: () => performance.now() };

export interface PolicyStatus {
  conservative: boolean;
  cooldownUntil: string | null;
  runsToday: number;
  irreversibleToday: number;
  captchaToday: number;
  blockStreak: number;
  unknownScreenStreak: number;
}

/**
 * 포털 하나의 카운터·쿨다운·시계(D07 rate_counters·clock_guard·cooldowns). kind:
 * runs_day·irreversible_day(프로필, KST 날짜), logins_day(포털, KST 날짜), login_session(프로필, 현재 세션의 실행 수),
 * navigations_min(포털, 초 버킷, 최근 60초 합), captcha_10m(포털, 10분), block_streak·extra_auth_streak(포털, 연속 횟수).
 */
export class RateGuard {
  readonly portal: string;
  readonly builtIn: RatePolicy;
  private readonly received: (() => RatePolicy | null) | null;
  private pinned: RatePolicy | null = null;
  private readonly db: Db;
  private readonly repo: RateRepo;
  private readonly c: Clock;
  private base: { t: number; m: number };

  constructor(db: Db, portal: string, policy: RatePolicy, clock: Clock = SYSTEM_CLOCK, received?: () => RatePolicy | null) {
    this.db = db;
    this.portal = portal;
    this.builtIn = policy;
    this.received = portal === 'hometax' && received ? received : null;
    this.repo = new RateRepo(db);
    this.c = clock;
    this.base = { t: this.repo.lastSeen() ?? clock.wall(), m: clock.mono() };
  }

  get policy(): RatePolicy {
    if (!this.received) return this.builtIn;
    return stricterRate(stricterRate(this.builtIn, this.received()), this.pinned);
  }

  pinRun(): void {
    this.pinned = this.received?.() ?? null;
  }

  unpinRun(): void {
    this.pinned = null;
  }

  clock(): { now: number; conservative: boolean } {
    const wall = this.c.wall();
    const m = this.c.mono();
    const now = Math.max(wall, this.base.t + (m - this.base.m) / 2);
    this.base = { t: now, m };
    this.repo.seen(now);
    const unknown = this.repo.count(this.portal, '', 'unknown_screen_streak', '-') >= UNKNOWN_SCREEN_CONSERVATIVE;
    return { now, conservative: now - wall > CLOCK_ROLLBACK_TOLERANCE_MS || unknown };
  }

  cap(n: number, conservative: boolean): number {
    return conservative ? Math.max(1, Math.floor(n / 2)) : n;
  }

  delay(range: readonly [number, number], conservative: boolean): number {
    const ms = range[0] + Math.random() * (range[1] - range[0]);
    return Math.round(conservative ? ms * this.policy.pace.slowFactor : ms);
  }

  private coolingDown(now: number): boolean {
    const cd = this.repo.cooldown(this.portal);
    return !!cd && now < cd.until;
  }

  admit(profileId: string, o: { irreversible: boolean }): void {
    const { now, conservative } = this.clock();
    const L = this.policy.limits;
    if (this.coolingDown(now)) throw new RunEnd('failed', 'policy.cooldown');
    const day = kstDay(now);
    if (this.repo.count(this.portal, profileId, 'runs_day', day) >= this.cap(L.runsPerDayPerProfile, conservative)) throw new RunEnd('failed', 'policy.runs_per_day');
    if (o.irreversible && this.repo.count(this.portal, profileId, 'irreversible_day', day) >= this.cap(L.irreversiblePerDayPerProfile, conservative)) throw new RunEnd('failed', 'policy.irreversible_per_day');
    this.db.transaction(() => {
      this.repo.bump(this.portal, profileId, 'runs_day', day);
      this.repo.prune(this.portal, 'navigations_min', kst(now - 86_400_000));
    })();
  }

  beforeLogin(): void {
    const { now, conservative } = this.clock();
    if (this.coolingDown(now)) throw new RunEnd('failed', 'policy.cooldown');
    if (this.repo.count(this.portal, '', 'logins_day', kstDay(now)) >= this.cap(this.policy.limits.loginsPerDay, conservative)) throw new RunEnd('failed', 'policy.logins_per_day');
  }

  loginSucceeded(profileId: string): void {
    const { now } = this.clock();
    this.db.transaction(() => {
      this.repo.bump(this.portal, '', 'logins_day', kstDay(now));
      this.repo.set(this.portal, profileId, 'login_session', 'current', 1);
      this.repo.set(this.portal, '', 'extra_auth_streak', '-', 0);
    })();
  }

  continueSession(profileId: string): void {
    const { conservative } = this.clock();
    if (this.repo.count(this.portal, profileId, 'login_session', 'current') >= this.cap(this.policy.limits.runsPerLoginSession, conservative)) throw new RunEnd('failed', 'policy.runs_per_session');
    this.repo.bump(this.portal, profileId, 'login_session', 'current');
  }

  navigationWaitMs(): number {
    const { now, conservative } = this.clock();
    const n = this.repo.sum(this.portal, '', 'navigations_min', kst(now - 59_000), kst(now));
    return n >= this.cap(this.policy.limits.navigationsPerMin, conservative) ? 1_000 : 0;
  }

  countNavigation(): void {
    this.repo.bump(this.portal, '', 'navigations_min', kst(this.clock().now));
  }

  countCommit(profileId: string): void {
    const { now, conservative } = this.clock();
    const day = kstDay(now);
    if (this.repo.count(this.portal, profileId, 'irreversible_day', day) >= this.cap(this.policy.limits.irreversiblePerDayPerProfile, conservative)) throw new RunEnd('failed', 'policy.irreversible_per_day');
    this.repo.bump(this.portal, profileId, 'irreversible_day', day);
    this.repo.bump(this.portal, '', 'navigations_min', kst(now));
  }

  positive(id: string): boolean {
    const { now } = this.clock();
    return this.db.transaction(() => {
      const n = this.repo.bump(this.portal, '', 'block_streak', '-');
      if (n < this.policy.cooldown.positiveDetectionsForCooldown) return false;
      this.repo.startCooldown(this.portal, now + this.policy.cooldown.onBlockSignalHours * 3_600_000, id);
      return true;
    })();
  }

  extraAuth(): number {
    return this.repo.bump(this.portal, '', 'extra_auth_streak', '-');
  }

  captcha(): void {
    this.repo.bump(this.portal, '', 'captcha_10m', kst10m(this.clock().now));
  }

  unknownScreen(): number {
    return this.repo.bump(this.portal, '', 'unknown_screen_streak', '-');
  }

  clean(): void {
    this.db.transaction(() => {
      this.repo.set(this.portal, '', 'block_streak', '-', 0);
      this.repo.set(this.portal, '', 'extra_auth_streak', '-', 0);
      this.repo.set(this.portal, '', 'unknown_screen_streak', '-', 0);
    })();
  }

  status(profileId: string): PolicyStatus {
    const { now, conservative } = this.clock();
    const day = kstDay(now);
    const cd = this.repo.cooldown(this.portal);
    return {
      conservative,
      cooldownUntil: cd && now < cd.until ? new Date(cd.until).toISOString() : null,
      runsToday: this.repo.count(this.portal, profileId, 'runs_day', day),
      irreversibleToday: this.repo.count(this.portal, profileId, 'irreversible_day', day),
      captchaToday: this.repo.sum(this.portal, '', 'captcha_10m', `${day}T00:0`, `${day}T23:5`),
      blockStreak: this.repo.count(this.portal, '', 'block_streak', '-'),
      unknownScreenStreak: this.repo.count(this.portal, '', 'unknown_screen_streak', '-'),
    };
  }
}

export interface RunPolicyOptions {
  profileId: string;
  signals?: SignalDict;
  checkStop: () => void;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  onLatch: (end: RunEnd) => void;
}

/** 차단이 아닌 신호의 종료 코드(D16 portal.*). 추가 인증은 D16 mfa_pending, 대기열 busy는 D16에 없어 더했다. */
export const HANDOFF: Record<Exclude<SignalKind, 'block'>, string> = { maintenance: 'portal.maintenance', extra_auth: 'portal.mfa_pending', captcha: 'portal.captcha', busy: 'portal.busy' };

/**
 * 실행 하나의 집행(D03 §5.2 Actuator의 policy): 스텝 지연·안정 대기, 실행당 동작 수·벽시계, 분당 네비게이션,
 * 차단 신호 걸쇠, 대화상자 응답. 걸쇠가 걸리면 그 뒤로는 어떤 동작도 하지 않는다(무장 뒤면 클릭하지 않는다, runner).
 * 커밋 구간과 verify에서는 실행당 상한으로 끊지 않는다(끊으면 발급됐는지 모름만 생긴다). 차단 신호는 verify도 멈춘다.
 */
export class RunPolicy implements RunnerPolicy {
  private readonly g: RateGuard;
  private readonly o: RunPolicyOptions;
  private readonly page: Page;
  private readonly watch: SignalWatch;
  private readonly startedAt = performance.now();
  private actuations = 0;
  private committed = false;
  private navigated = false;
  private arrived = false;
  private closed = false;
  private finishing: Promise<void> | null = null;
  private latch: { end: RunEnd; kind: SignalKind } | null = null;
  private readonly portal: PortalConfig;
  private section: 'login' | null = null;
  private lastNotice: string | null = null;
  private unobservable: InspectUnavailable | null = null;

  constructor(page: Page, guard: RateGuard, portal: PortalConfig, o: RunPolicyOptions) {
    this.g = guard;
    this.o = o;
    this.page = page;
    this.portal = portal;
    const base = new URL(portal.origin).hostname;
    this.watch = new SignalWatch(page, {
      dict: o.signals ?? SIGNAL_DICT[portal.kind],
      portalHost: (h) => h === base || h.endsWith(`.${base}`),
      onHit: (h) => this.onHit(h),
      onDialog: (d) => this.dialog(d),
      onUnavailable: (reason) => {
        if (!this.unobservable) this.o.journal('signal.inspect_unavailable', { reason });
        this.unobservable = reason;
      },
      mono: () => performance.now(),
    });
  }

  enterLogin(): void {
    this.section = 'login';
  }

  leaveLogin(): void {
    this.section = null;
  }

  get notice(): string | null {
    return this.lastNotice;
  }

  get latched(): RunEnd | null {
    return this.latch?.end ?? null;
  }

  halted(): RunEnd | null {
    return this.latched;
  }

  private onHit(h: SignalHit): void {
    const cur = this.latch;
    if (this.closed || (cur && (cur.kind === 'block' || h.kind !== 'block'))) return;
    let kind = h.kind;
    let end: RunEnd;
    try {
      if (kind === 'extra_auth' && this.section !== 'login' && this.g.extraAuth() >= EXTRA_AUTH_FOR_SIGNAL) kind = 'block';
      if (kind === 'block') {
        const repeat = h.kind !== 'block';
        const id = repeat ? 'extra_auth.repeat' : h.id;
        const cooled = this.g.positive(id);
        this.o.journal('block.signal', { id });
        if (cooled) this.o.journal('cooldown.started', { hours: this.g.policy.cooldown.onBlockSignalHours });
        end = new RunEnd('failed', cooled ? 'policy.cooldown' : repeat ? 'portal.extra_auth_repeat' : 'portal.blocked');
      } else {
        if (kind === 'captcha') this.g.captcha();
        this.o.journal('portal.signal', { kind, id: h.id });
        end = new RunEnd('handoff', HANDOFF[kind]);
      }
    } catch {
      end = kind === 'block' ? new RunEnd('failed', 'portal.blocked') : new RunEnd('handoff', HANDOFF[kind]);
    }
    this.latch = { end, kind };
    try {
      this.o.onLatch(end);
    } catch {
      // 게이트 닫기에 실패해도 걸쇠는 걸렸다(다음 동작·arm에서 멈춘다)
    }
  }

  private dialog(d: Dialog): void {
    this.actuations++;
    try {
      const text = d.message().normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (text) this.lastNotice = text;
    } catch {
      // 문구를 못 읽어도 닫는 것이 먼저다
    }
    void d.dismiss().catch(() => {});
  }

  private stopIfLatched(): void {
    if (this.latch) throw this.latch.end;
  }

  private async sleep(ms: number): Promise<void> {
    const until = performance.now() + ms;
    for (;;) {
      this.stopIfLatched();
      if (!this.committed) this.o.checkStop();
      const left = until - performance.now();
      if (left <= 0) return;
      await new Promise((r) => setTimeout(r, Math.min(left, 100)));
    }
  }

  private checkRunLimits(extra: number): void {
    const { conservative } = this.g.clock();
    const R = this.g.policy.run;
    if (this.actuations + extra > this.g.cap(R.maxActuationsPerRun, conservative)) throw new RunEnd('failed', 'policy.actuations_per_run');
    if (performance.now() - this.startedAt > this.g.cap(R.maxWallClockMs, conservative)) throw new RunEnd('failed', 'policy.wall_clock');
  }

  private async navigationSlot(): Promise<void> {
    for (let wait = this.g.navigationWaitMs(); wait > 0; wait = this.g.navigationWaitMs()) await this.sleep(wait);
  }

  private async look(page: Page): Promise<void> {
    await this.watch.idle();
    await this.watch.inspect(page);
    this.stopIfLatched();
  }

  async beforeStep(): Promise<void> {
    await this.sleep(this.g.delay(this.g.policy.pace.stepDelayMs, this.g.clock().conservative));
  }

  async act(kind: 'navigate' | 'click' | 'fill'): Promise<void> {
    if (kind === 'navigate') await this.navigationSlot();
    if (this.navigated) await this.look(this.page);
    else {
      await this.watch.idle();
      this.stopIfLatched();
    }
    if (!this.committed) this.checkRunLimits(1);
    if (kind === 'navigate') {
      this.g.countNavigation();
      this.navigated = true;
    }
    this.actuations++;
  }

  async settled(page: Page): Promise<void> {
    await this.sleep(this.g.delay(this.g.policy.pace.afterNavSettleMs, this.g.clock().conservative));
    await this.look(page);
    if (page.isClosed() || pathExpected(page.url(), this.portal)) return;
    this.o.journal('portal.unexpected_page');
    if (this.committed) return;
    this.arrived = false;
    throw new RunEnd('handoff', 'portal.unexpected_page');
  }

  private async lookObservable(): Promise<void> {
    this.unobservable = null;
    await this.look(this.page);
    if (this.unobservable) throw new RunEnd('handoff', 'portal.unobservable');
  }

  async beforeGate(): Promise<void> {
    await this.lookObservable();
  }

  async beforeCommit(): Promise<void> {
    await this.navigationSlot();
    await this.lookObservable();
    this.checkRunLimits(1);
  }

  reached(): void {
    this.arrived = true;
  }

  commit(): void {
    this.g.countCommit(this.o.profileId);
    this.committed = true;
    this.actuations++;
  }

  finish(o: { userStopped?: boolean } = {}): Promise<void> {
    this.finishing ??= (async () => {
      this.watch.detach();
      await this.watch.idle();
      this.closed = true;
      if (this.latch) return;
      if (this.arrived) return this.g.clean();
      if (o.userStopped) return;
      const streak = this.g.unknownScreen();
      this.o.journal('portal.unknown_screen', { streak });
      if (streak < UNKNOWN_SCREEN_POSITIVE) return;
      const cooled = this.g.positive('portal.unknown_screen');
      if (cooled) this.o.journal('cooldown.started', { hours: this.g.policy.cooldown.onBlockSignalHours });
    })();
    return this.finishing;
  }
}
