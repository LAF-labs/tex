import { performance } from 'node:perf_hooks';
import { RateRepo, type Db } from '@sax/db';
import type { Dialog, Page } from 'playwright-core';
import type { Policy } from './core/index.ts';
import { pathExpected, type PortalConfig } from './portal.ts';
import { RunEnd, type RunnerPolicy } from './run-end.ts';
import { SIGNAL_DICT, SignalWatch, type InspectUnavailable, type SignalDict, type SignalHit, type SignalKind } from './signals.ts';

// 요청률 정책(D03 §7)의 PoC 최소판. 앱 내장 정책은 홈택스 하나다. 서명·신선도·긴급 키·데몬·리모트·큐·캡차 중계·
// POLICY_FLOOR 클램프는 외부 정책 파일이 없어 두지 않는다. 카운터는 SQLite에 영속하고(KST) 증가를 커밋한 뒤 행동한다.
// 스텝 간 지연 범위는 요청률 상한이지 행동 모사가 아니다. UA·지문·webdriver·타이핑 모사는 하지 않는다(정책에 필드도 없다).

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

// KST(일광절약시간 없음). 'YYYY-MM-DDTHH:mm:ss'. 같은 길이 버킷은 사전순이 시간순이다.
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
  /** 앱 내장 값(포털 kind의 policyFor, 시험은 주입값). */
  readonly builtIn: RatePolicy;
  private readonly received: (() => RatePolicy | null) | null;
  /** 이 실행이 시작할 때 받아 둔 정책 값(pinRun). 실행 중 완화는 다음 실행부터 적용한다(D03 §7.1 조회와 적용). */
  private pinned: RatePolicy | null = null;
  private readonly db: Db;
  private readonly repo: RateRepo;
  private readonly c: Clock;
  private base: { t: number; m: number };

  /** received: 마지막 유효 서명 정책의 요청률 값(레지스트리 동기화). 홈택스에만 적용한다(fixture는 내장 값만). */
  constructor(db: Db, portal: string, policy: RatePolicy, clock: Clock = SYSTEM_CLOCK, received?: () => RatePolicy | null) {
    this.db = db;
    this.portal = portal;
    this.builtIn = policy;
    this.received = portal === 'hometax' && received ? received : null;
    this.repo = new RateRepo(db);
    this.c = clock;
    this.base = { t: this.repo.lastSeen() ?? clock.wall(), m: clock.mono() };
  }

  /**
   * 지금 쓰는 값: 내장 값 ∧ 지금 받은 정책 ∧ 실행 시작 때 받은 정책(필드마다 더 엄격한 쪽). 검사 지점마다 다시 계산하므로
   * 보수 쪽으로 움직인 필드는 다음 검사 지점부터, 완화는 다음 실행부터 적용된다(D03 §7.1). 정책이 없으면 내장 값이다.
   */
  get policy(): RatePolicy {
    if (!this.received) return this.builtIn;
    return stricterRate(stricterRate(this.builtIn, this.received()), this.pinned);
  }

  /** 실행 시작: 그때 받은 정책을 이 실행의 하한으로 둔다(실행 중 완화를 막는다). */
  pinRun(): void {
    this.pinned = this.received?.() ?? null;
  }

  /** 실행 끝. */
  unpinRun(): void {
    this.pinned = null;
  }

  /**
   * 유효 시각 = max(벽시계, 마지막으로 본 시각 + 그 뒤 흐른 단조 시간의 절반). 뒤로 가지 않으므로 시계를 되돌려도 날짜 버킷·
   * 쿨다운이 풀리지 않는다. 벽시계가 그보다 뒤면 보수 모드(지연 × slowFactor, 상한 절반)다. 역행 중에는 유효 시각이 절반 속도로
   * 가므로 벽시계가 역행한 만큼의 두 배 뒤에 따라잡아 보수 모드가 끝난다(재시작해도 같다). 볼 때마다 마지막 본 시각을 남긴다.
   */
  clock(): { now: number; conservative: boolean } {
    const wall = this.c.wall();
    const m = this.c.mono();
    const now = Math.max(wall, this.base.t + (m - this.base.m) / 2);
    this.base = { t: now, m };
    this.repo.seen(now);
    // 모르는 화면이 연달아 끝난 포털도 보수 모드다(사전에 없는 차단 화면일 수 있다).
    const unknown = this.repo.count(this.portal, '', 'unknown_screen_streak', '-') >= UNKNOWN_SCREEN_CONSERVATIVE;
    return { now, conservative: now - wall > CLOCK_ROLLBACK_TOLERANCE_MS || unknown };
  }

  /** 보수 모드면 절반(내림, 최소 1). */
  cap(n: number, conservative: boolean): number {
    return conservative ? Math.max(1, Math.floor(n / 2)) : n;
  }

  /** 범위 안에서 고른 지연(ms). 보수 모드면 slowFactor배. */
  delay(range: readonly [number, number], conservative: boolean): number {
    const ms = range[0] + Math.random() * (range[1] - range[0]);
    return Math.round(conservative ? ms * this.policy.pace.slowFactor : ms);
  }

  private coolingDown(now: number): boolean {
    const cd = this.repo.cooldown(this.portal);
    return !!cd && now < cd.until;
  }

  /**
   * 실행 시작(runs/day는 start 시점): 쿨다운·하루 실행 수·(비가역이면) 하루 비가역 여유를 보고 증가를 커밋한다.
   * 넘으면 RunEnd(실행을 만들기 전). 동시 실행 1개(limits.concurrent)는 RunService가 지킨다.
   */
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

  /** 로그인 시도 전(PoC-3 로그인 s0~s6이 부른다): 쿨다운·하루 로그인 수. */
  beforeLogin(): void {
    const { now, conservative } = this.clock();
    if (this.coolingDown(now)) throw new RunEnd('failed', 'policy.cooldown');
    if (this.repo.count(this.portal, '', 'logins_day', kstDay(now)) >= this.cap(this.policy.limits.loginsPerDay, conservative)) throw new RunEnd('failed', 'policy.logins_per_day');
  }

  /**
   * 로그인 성공 판정: 하루 로그인 수를 올리고 새 세션을 연다. 로그인은 실행 안에서만 하므로 이 실행이 세션의 첫 실행이다.
   * 로그인을 마쳤으면 그 전의 추가 인증 연속은 끝났다(같은 트랜잭션에서 0으로).
   */
  loginSucceeded(profileId: string): void {
    const { now } = this.clock();
    this.db.transaction(() => {
      this.repo.bump(this.portal, '', 'logins_day', kstDay(now));
      this.repo.set(this.portal, profileId, 'login_session', 'current', 1);
      this.repo.set(this.portal, '', 'extra_auth_streak', '-', 0);
    })();
  }

  /** 이미 로그인된 세션을 이어 쓰는 실행(PoC-3): 세션당 실행 수를 보고 올린다. 넘으면 다시 로그인해야 한다. */
  continueSession(profileId: string): void {
    const { conservative } = this.clock();
    if (this.repo.count(this.portal, profileId, 'login_session', 'current') >= this.cap(this.policy.limits.runsPerLoginSession, conservative)) throw new RunEnd('failed', 'policy.runs_per_session');
    this.repo.bump(this.portal, profileId, 'login_session', 'current');
  }

  /** 최근 60초 네비게이션 수가 상한에 닿았으면 기다릴 ms(1초 뒤 다시 본다), 아니면 0. */
  navigationWaitMs(): number {
    const { now, conservative } = this.clock();
    const n = this.repo.sum(this.portal, '', 'navigations_min', kst(now - 59_000), kst(now));
    return n >= this.cap(this.policy.limits.navigationsPerMin, conservative) ? 1_000 : 0;
  }

  countNavigation(): void {
    this.repo.bump(this.portal, '', 'navigations_min', kst(this.clock().now));
  }

  /** 비가역 스텝 진입: 원장 armed와 같은 트랜잭션 안에서 부른다(증가 커밋 → 클릭). 발급 버튼 클릭은 네비게이션이라 분당 수에도 넣는다. */
  countCommit(profileId: string): void {
    const { now, conservative } = this.clock();
    const day = kstDay(now);
    if (this.repo.count(this.portal, profileId, 'irreversible_day', day) >= this.cap(this.policy.limits.irreversiblePerDayPerProfile, conservative)) throw new RunEnd('failed', 'policy.irreversible_per_day');
    this.repo.bump(this.portal, profileId, 'irreversible_day', day);
    this.repo.bump(this.portal, '', 'navigations_min', kst(now));
  }

  /** 양성 탐지(차단 신호). 연속 횟수를 올리고 positiveDetectionsForCooldown에 닿으면 쿨다운을 건다. 걸었으면 true. */
  positive(id: string): boolean {
    const { now } = this.clock();
    return this.db.transaction(() => {
      const n = this.repo.bump(this.portal, '', 'block_streak', '-');
      if (n < this.policy.cooldown.positiveDetectionsForCooldown) return false;
      this.repo.startCooldown(this.portal, now + this.policy.cooldown.onBlockSignalHours * 3_600_000, id);
      return true;
    })();
  }

  /** 추가 인증을 봤다. 올린 뒤의 연속 횟수. */
  extraAuth(): number {
    return this.repo.bump(this.portal, '', 'extra_auth_streak', '-');
  }

  captcha(): void {
    this.repo.bump(this.portal, '', 'captcha_10m', kst10m(this.clock().now));
  }

  /** 기대 화면에 닿지 못하고 끝난 실행. 올린 뒤의 연속 횟수. */
  unknownScreen(): number {
    return this.repo.bump(this.portal, '', 'unknown_screen_streak', '-');
  }

  /** 신호 없이 포털 화면을 본 실행이 끝났다: 연속 횟수를 0으로. 쿨다운은 시간이 지나야 풀린다. */
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
  /** 신호 사전(없으면 포털 내장 사전). 제품 홈택스는 RunService가 받은 정책의 blockSignalsAdd를 더한 사전을 준다. */
  signals?: SignalDict;
  /** 정지 요청이 있으면 RunEnd를 던진다(커밋 전만 부른다). */
  checkStop: () => void;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  /** 신호가 걸쇠에 걸렸다(승인 대기 중이면 게이트를 닫는다). */
  onLatch: (end: RunEnd) => void;
}

/** 차단이 아닌 신호의 종료 코드(D16 portal.*). 추가 인증은 D16 mfa_pending, 대기열 busy는 D16에 없어 더했다. */
const HANDOFF: Record<Exclude<SignalKind, 'block'>, string> = { extra_auth: 'portal.mfa_pending', captcha: 'portal.captcha', busy: 'portal.busy' };

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
  /** 실행 시작(단조 시각). 실행당 벽시계 상한은 영속할 필요가 없어 단조 시계로 잰다. */
  private readonly startedAt = performance.now();
  private actuations = 0;
  private committed = false;
  /** 이 실행이 첫 네비게이션을 했다. 그 전의 화면은 앞 실행이 남긴 것이라 동작 전 확인에서 보지 않는다. */
  private navigated = false;
  /** 기대한 화면(체크포인트)에 도착했다. 차단 신호 연속을 끊는 '깨끗한 실행'의 조건이다. */
  private arrived = false;
  /** 감시를 떼고 남은 확인까지 마쳤다. 그 뒤의 신호는 이 실행의 것이 아니다. */
  private closed = false;
  private finishing: Promise<void> | null = null;
  private latch: { end: RunEnd; kind: SignalKind } | null = null;
  private readonly portal: PortalConfig;
  /** 로그인 구간(enterLogin~leaveLogin). 여기서 뜬 추가 인증은 예상된 2차 인증이라 연속에 넣지 않는다. */
  private section: 'login' | null = null;
  /** 실행이 닫은 마지막 대화상자 문구(NFKC, 200자). 실행 메모리에만 둔다(저널·로그·모델에 넣지 않는다). */
  private lastNotice: string | null = null;
  /** 이번 화면 확인에서 금고가 확인 식을 거부했다(비밀 창 활성·오염). */
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

  /** 로그인 구간 시작·끝(PoC-3 로그인 s0~s6이 부른다). */
  enterLogin(): void {
    this.section = 'login';
  }

  leaveLogin(): void {
    this.section = null;
  }

  /** 포털이 마지막으로 한 말(대화상자 문구). 실패·핸드오프 종료 이벤트에만 싣는다. */
  get notice(): string | null {
    return this.lastNotice;
  }

  /** 걸쇠에 걸린 신호의 종료(없으면 null). */
  get latched(): RunEnd | null {
    return this.latch?.end ?? null;
  }

  halted(): RunEnd | null {
    return this.latched;
  }

  /** 첫 신호만 센다. 차단은 먼저 걸린 다른 신호(추가 인증·캡차·대기열)를 덮는다. */
  private onHit(h: SignalHit): void {
    const cur = this.latch;
    if (this.closed || (cur && (cur.kind === 'block' || h.kind !== 'block'))) return;
    let kind = h.kind;
    let end: RunEnd;
    try {
      // 로그인 구간의 추가 인증은 예상된 2차 인증이다: 연속에 넣지 않고 핸드오프로만 끝낸다(ADR-025 결정 4).
      if (kind === 'extra_auth' && this.section !== 'login' && this.g.extraAuth() >= EXTRA_AUTH_FOR_SIGNAL) kind = 'block';
      if (kind === 'block') {
        const repeat = h.kind !== 'block';
        const id = repeat ? 'extra_auth.repeat' : h.id;
        const cooled = this.g.positive(id);
        this.o.journal('block.signal', { id });
        if (cooled) this.o.journal('cooldown.started', { hours: this.g.policy.cooldown.onBlockSignalHours });
        // 반복 추가 인증은 차단 신호(portal.blocked)와 구분한다(공문 보고 기준에서 뺀다, D18 §3).
        end = new RunEnd('failed', cooled ? 'policy.cooldown' : repeat ? 'portal.extra_auth_repeat' : 'portal.blocked');
      } else {
        if (kind === 'captcha') this.g.captcha();
        this.o.journal('portal.signal', { kind, id: h.id });
        end = new RunEnd('handoff', HANDOFF[kind]);
      }
    } catch {
      // 카운터를 못 남겨도 멈추는 것이 먼저다
      end = kind === 'block' ? new RunEnd('failed', 'portal.blocked') : new RunEnd('handoff', HANDOFF[kind]);
    }
    this.latch = { end, kind };
    try {
      this.o.onLatch(end);
    } catch {
      // 게이트 닫기에 실패해도 걸쇠는 걸렸다(다음 동작·arm에서 멈춘다)
    }
  }

  /** 대화상자 응답(D03 §6 대화상자 정책의 PoC 부분): 무장 구간 expectConfirm이 없으므로 모두 닫는다(alert는 확인과 같다). */
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

  /** 걸쇠·[중지](커밋 전)를 100ms마다 보며 잔다. */
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

  /** 지금 화면을 본다(네비게이션 없이 XHR로 뜬 안내까지). 진행 중이던 확인도 끝낸 뒤 걸쇠를 본다. */
  private async look(page: Page): Promise<void> {
    await this.watch.idle();
    await this.watch.inspect(page);
    this.stopIfLatched();
  }

  async beforeStep(): Promise<void> {
    await this.sleep(this.g.delay(this.g.policy.pace.stepDelayMs, this.g.clock().conservative));
  }

  /** 분당 네비게이션 자리를 기다린 뒤에 화면을 본다(기다리는 동안 뜬 안내를 놓치지 않게). */
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

  /**
   * 네비게이션 뒤: 안정 대기 + 화면 확인. 포털 화면인데 기대 경로(플레이북 화면·조회·로그인) 밖이면 모르는 화면이다:
   * 커밋 전이면 핸드오프로 멈추고, 커밋 뒤면 기록만 한다(끊으면 발급됐는지 모름만 생긴다).
   */
  async settled(page: Page): Promise<void> {
    await this.sleep(this.g.delay(this.g.policy.pace.afterNavSettleMs, this.g.clock().conservative));
    await this.look(page);
    if (page.isClosed() || pathExpected(page.url(), this.portal)) return;
    this.o.journal('portal.unexpected_page');
    if (this.committed) return;
    this.arrived = false; // 깨끗한 실행이 아니다(연속을 끊지 않는다)
    throw new RunEnd('handoff', 'portal.unexpected_page');
  }

  /** 게이트·커밋 직전 확인. 금고가 화면 확인을 거부했으면(비밀 창) 확인할 수 없으므로 승인·클릭하지 않는다(fail-closed). */
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

  /** 원장 armed 트랜잭션 안(RunService.arm): 하루 비가역 수·네비게이션 수 증가. beforeCommit 바로 뒤라 그 사이에 걸쇠가 걸릴 수 없다. */
  commit(): void {
    this.g.countCommit(this.o.profileId);
    this.committed = true;
    this.actuations++;
  }

  /**
   * 실행 끝: 진행 중인 화면 확인을 마치고 감시를 뗀다(그 뒤 사유는 latched로 정한다). 신호 없이 기대한 화면(체크포인트)까지 간
   * 실행이면 연속 횟수를 0으로. 화면을 못 찾고 끝난 실행은 사전에 없는 차단 화면이었을 수 있어 연속을 끊지 않고 모르는 화면
   * 연속을 올린다(2회 보수 모드, 3회부터 양성 탐지). 사용자가 [중지]한 실행은 화면 탓이 아니라 세지 않는다.
   */
  finish(o: { userStopped?: boolean } = {}): Promise<void> {
    this.finishing ??= (async () => {
      this.watch.detach(); // 새 확인을 더 만들지 않는다(새로고침이 이어지는 화면에서도 끝나게)
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
