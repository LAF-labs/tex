import { performance } from 'node:perf_hooks';
import { RateRepo, type Db } from '@sax/db';
import type { Dialog, Page } from 'playwright-core';
import { RunEnd, type RunnerPolicy } from './h01/runner.ts';
import { SIGNAL_DICT, SignalWatch, type SignalHit, type SignalKind } from './h01/signals.ts';

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

/** D03 §7 정책 예시의 interactive 프로필·limits.hometax·run·cooldown 값. */
export const HOMETAX_POLICY: RatePolicy = freeze({
  pace: { stepDelayMs: [800, 2500], afterNavSettleMs: [600, 1500], slowFactor: 1.5 },
  limits: { runsPerDayPerProfile: 40, irreversiblePerDayPerProfile: 30, runsPerLoginSession: 15, navigationsPerMin: 12, loginsPerDay: 6, concurrent: 1 },
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

/** 추가 인증이 이만큼 연속이면 차단 신호(D03 §7 (c)). */
export const EXTRA_AUTH_FOR_SIGNAL = 2;
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
}

/**
 * 포털 하나의 카운터·쿨다운·시계(D07 rate_counters·clock_guard·cooldowns). kind:
 * runs_day·irreversible_day(프로필, KST 날짜), logins_day(포털, KST 날짜), login_session(프로필, 현재 세션의 실행 수),
 * navigations_min(포털, 초 버킷, 최근 60초 합), captcha_10m(포털, 10분), block_streak·extra_auth_streak(포털, 연속 횟수).
 */
export class RateGuard {
  readonly portal: string;
  readonly policy: RatePolicy;
  private readonly db: Db;
  private readonly repo: RateRepo;
  private readonly c: Clock;
  private base: { t: number; m: number };

  constructor(db: Db, portal: string, policy: RatePolicy, clock: Clock = SYSTEM_CLOCK) {
    this.db = db;
    this.portal = portal;
    this.policy = policy;
    this.repo = new RateRepo(db);
    this.c = clock;
    this.base = { t: this.repo.lastSeen() ?? clock.wall(), m: clock.mono() };
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
    return { now, conservative: now - wall > CLOCK_ROLLBACK_TOLERANCE_MS };
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

  /** 로그인 성공 판정: 하루 로그인 수를 올리고 새 세션을 연다. 로그인은 실행 안에서만 하므로 이 실행이 세션의 첫 실행이다. */
  loginSucceeded(profileId: string): void {
    const { now } = this.clock();
    this.db.transaction(() => {
      this.repo.bump(this.portal, '', 'logins_day', kstDay(now));
      this.repo.set(this.portal, profileId, 'login_session', 'current', 1);
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

  /** 신호 없이 포털 화면을 본 실행이 끝났다: 연속 횟수를 0으로. 쿨다운은 시간이 지나야 풀린다. */
  clean(): void {
    this.db.transaction(() => {
      this.repo.set(this.portal, '', 'block_streak', '-', 0);
      this.repo.set(this.portal, '', 'extra_auth_streak', '-', 0);
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
    };
  }
}

export interface RunPolicyOptions {
  profileId: string;
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

  constructor(page: Page, guard: RateGuard, portal: { kind: 'fixture' | 'hometax'; origin: string }, o: RunPolicyOptions) {
    this.g = guard;
    this.o = o;
    this.page = page;
    const base = new URL(portal.origin).hostname;
    this.watch = new SignalWatch(page, {
      dict: SIGNAL_DICT[portal.kind],
      portalHost: (h) => h === base || h.endsWith(`.${base}`),
      onHit: (h) => this.onHit(h),
      onDialog: (d) => this.dialog(d),
      mono: () => performance.now(),
    });
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
      if (kind === 'extra_auth' && this.g.extraAuth() >= EXTRA_AUTH_FOR_SIGNAL) kind = 'block';
      if (kind === 'block') {
        const id = h.kind === 'block' ? h.id : 'extra_auth.repeat';
        const cooled = this.g.positive(id);
        this.o.journal('block.signal', { id });
        if (cooled) this.o.journal('cooldown.started', { hours: this.g.policy.cooldown.onBlockSignalHours });
        end = new RunEnd('failed', cooled ? 'policy.cooldown' : 'portal.blocked');
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

  async settled(page: Page): Promise<void> {
    await this.sleep(this.g.delay(this.g.policy.pace.afterNavSettleMs, this.g.clock().conservative));
    await this.look(page);
  }

  async beforeGate(): Promise<void> {
    await this.look(this.page);
  }

  async beforeCommit(): Promise<void> {
    await this.navigationSlot();
    await this.look(this.page);
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
   * 실행이면 연속 횟수를 0으로. 화면을 못 찾고 끝난 실행은 사전에 없는 차단 화면이었을 수 있어 연속을 끊지 않는다.
   */
  finish(): Promise<void> {
    this.finishing ??= (async () => {
      this.watch.detach(); // 새 확인을 더 만들지 않는다(새로고침이 이어지는 화면에서도 끝나게)
      await this.watch.idle();
      this.closed = true;
      if (!this.latch && this.arrived) this.g.clean();
    })();
    return this.finishing;
  }
}
