// 운영 정책 집행기(M2-4 B, D03 §5.2·§7·§7.1). GuardedActuator의 ActionPolicy 구현이고, 실행기 beforeStep 지점이다.
// - 정책: 서명 정책(clampPolicy로 POLICY_FLOOR 클램프한 뒤)에서 포털 하나·프로필(interactive|daemon) 하나의 RatePolicy를 만든다.
//   포털 limits가 없으면 그 포털은 자동화하지 않는다(fail-closed).
// - 카운터·쿨다운·시계 가드는 기존 RateGuard(SQLite 영속, KST, 증가 커밋 → 행동, 시계 역행 보수 모드)를 그대로 쓴다.
// - 실행 하나: 스텝 지연, 분당 네비게이션 자리, 실행당 동작 수·벽시계 상한(커밋 뒤에는 끊지 않는다), 네비게이션 뒤 안정 대기,
//   결정적 차단 신호 사전(앱 내장 ∪ policy.cooldown.blockSignalsAdd, 정책은 추가만)과 HTTP 403/429 규칙의 걸쇠, 정지 요청.
// 페이지 문구·값은 저장·기록하지 않는다. 걸린 신호는 사전 항목 id만 저널에 남긴다(⑦).
// Playwright 이벤트 배선(네비게이션·응답·대화상자 → observe*)은 드라이버 PR이 한다. 이 파일은 포트에만 의존한다.
import type { ActResult, ActionKind, ActionPolicy, Clock, Policy, Portal } from './core/index.ts';
import { re2Problem } from './core/re2.ts';
import { HTTP_RULES, matchSignal, type SignalDict, type SignalEntry, type SignalHit, type SignalKind } from './signals.ts';
import { RunEnd } from './run-end.ts';
import { EXTRA_AUTH_FOR_SIGNAL, RateGuard, UNKNOWN_SCREEN_POSITIVE, type RatePolicy } from './policy.ts';

export type PaceProfile = 'interactive' | 'daemon';

/**
 * 서명 정책 → 포털 하나의 RatePolicy. 포털 limits가 없으면 null(그 포털은 자동화하지 않는다).
 * policy는 clampPolicy를 거친 값이어야 한다(하한·상한은 거기서 집행된다).
 */
export function ratePolicyFrom(policy: Policy, portal: Portal, profile: PaceProfile): RatePolicy | null {
  const L = policy.limits[portal];
  if (!L) return null;
  const pace = policy.pace[profile];
  const r: RatePolicy = {
    pace: { stepDelayMs: [pace.stepDelayMs[0], pace.stepDelayMs[1]], afterNavSettleMs: [pace.afterNavSettleMs[0], pace.afterNavSettleMs[1]], slowFactor: pace.slowFactor },
    limits: {
      runsPerDayPerProfile: L.runsPerDayPerProfile,
      irreversiblePerDayPerProfile: L.irreversiblePerDayPerProfile,
      runsPerLoginSession: L.runsPerLoginSession,
      navigationsPerMin: L.navigationsPerMin,
      loginsPerDay: L.loginsPerDay,
      concurrent: L.concurrent,
    },
    run: { maxActuationsPerRun: policy.run.maxActuationsPerRun, maxWallClockMs: policy.run.maxWallClockMs },
    cooldown: { onBlockSignalHours: policy.cooldown.onBlockSignalHours, positiveDetectionsForCooldown: policy.cooldown.positiveDetectionsForCooldown },
  };
  return Object.freeze(r);
}

/**
 * 결정적 차단 신호 사전 = 앱 내장 ∪ 정책 blockSignalsAdd(추가만, 모두 kind block). 정책 URL 패턴은 RE2 부분집합(백트래킹 폭주 모양 금지)만
 * 받고 나머지는 버린다(onDropped로 위치만 알린다). 빈 문구도 버린다.
 */
export function signalDict(builtIn: readonly SignalEntry[], add: Policy['cooldown']['blockSignalsAdd'], onDropped?: (where: string) => void): readonly SignalEntry[] {
  const out = [...builtIn];
  const source = 'policy.cooldown.blockSignalsAdd';
  (add?.urlPatterns ?? []).forEach((url, i) => {
    if (re2Problem(url)) onDropped?.(`urlPatterns[${i}]`);
    else out.push({ id: `policy.block.url.${i}`, kind: 'block', url, source });
  });
  (add?.phrases ?? []).forEach((text, i) => {
    if (!text.trim()) onDropped?.(`phrases[${i}]`);
    else out.push({ id: `policy.block.text.${i}`, kind: 'block', text, source });
  });
  return Object.freeze(out);
}

/**
 * 두 blockSignalsAdd의 합집합(앞쪽 순서 유지, 같은 값은 하나). 실행 시작 때 받은 것과 지금 받은 것을 합치면, 실행 중에 정책이 항목을 빼도
 * 그 실행에는 남고(완화는 다음 실행부터) 더한 항목은 다음 검사부터 걸린다(보수 쪽은 바로, D03 §7.1 조회와 적용).
 */
export function unionBlockSignals(a: Policy['cooldown']['blockSignalsAdd'], b: Policy['cooldown']['blockSignalsAdd']): NonNullable<Policy['cooldown']['blockSignalsAdd']> {
  const uniq = (x: readonly string[] | undefined, y: readonly string[] | undefined) => [...new Set([...(x ?? []), ...(y ?? [])])];
  return { urlPatterns: uniq(a?.urlPatterns, b?.urlPatterns), phrases: uniq(a?.phrases, b?.phrases) };
}

export interface RunSignalInput {
  builtIn: readonly SignalEntry[];
  /** 실행 시작 때 받은 정책의 blockSignalsAdd. */
  atStart: Policy['cooldown']['blockSignalsAdd'];
  /** 지금 받은 정책의 blockSignalsAdd(검사할 때마다 부른다). */
  current: () => Policy['cooldown']['blockSignalsAdd'];
  /** 커밋 구간(토큰 소비 ~ verify 완료)인가. 그 안에서는 새 값을 적용하지 않는다(D03 §7.1). */
  inCommit: () => boolean;
  onDropped?: (where: string) => void;
}

/**
 * 실행 하나의 차단 신호 사전(D03 §7 (d)·§7.1, 팀장 결정 2026-11-09): 앱 내장 ∪ 시작 때 받은 추가 ∪ 지금 받은 추가. 빼기는 없다.
 * - 시작 때 받은 항목은 실행 끝까지 남는다(정책이 항목을 빼는 완화는 다음 실행부터).
 * - 실행 중에 더해진 항목은 다음 차단 신호 검사부터 걸린다(보수 쪽은 바로).
 * - 커밋 구간에는 시작 때 사전을 쓴다. 받은 추가가 바뀔 때만 다시 만든다.
 */
export function runSignalDict(i: RunSignalInput): () => readonly SignalEntry[] {
  const startAdd = unionBlockSignals(i.atStart, undefined);
  const atStart = signalDict(i.builtIn, startAdd, i.onDropped);
  let key = JSON.stringify(startAdd);
  let now = atStart;
  return () => {
    if (i.inCommit()) return atStart;
    const add = unionBlockSignals(i.atStart, i.current());
    const k = JSON.stringify(add);
    if (k !== key) {
      key = k;
      now = signalDict(i.builtIn, add, i.onDropped);
    }
    return now;
  };
}

/** 차단이 아닌 신호의 종료 코드(D16 portal.*). 이 코드들은 실행기 FORCED_STOPS에서 핸드오프다. */
const HANDOFF: Record<Exclude<SignalKind, 'block'>, string> = { extra_auth: 'portal.mfa_pending', captcha: 'portal.captcha', busy: 'portal.busy' };

const OK: ActResult = { ok: true };
const no = (code: string): ActResult => ({ ok: false, code });
/** 잠을 나눠 자며 걸쇠·정지를 보는 간격. */
const SLICE_MS = 100;

export interface RunEnforcerInput {
  guard: RateGuard;
  /** 잠·현재 시각(실행 시계). 시험에서는 가짜 시계. */
  clock: Clock;
  /** 단조 시각(ms). 실행당 벽시계 상한·403 창을 잰다. */
  mono: () => number;
  dict: SignalDict;
  profileId: string;
  /** 저널(키·코드·id만). */
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  /** 사용자 [중지]. 커밋 전에만 본다(커밋 뒤에 끊으면 발급됐는지 모름만 생긴다). */
  stopRequested?: () => boolean;
  /** 신호가 걸쇠에 걸렸다(승인 대기 중이면 게이트를 닫는 배선이 쓴다). 던져도 걸쇠는 걸린다. */
  onLatch?: (code: string) => void;
  /** 0 ≤ u < 1. 지연 범위 안에서 고를 때. */
  random?: () => number;
}

/**
 * 실행 하나의 집행. 걸쇠가 걸리면 그 뒤로는 어떤 동작도 허가하지 않는다(대화상자 응답만 예외, GuardedActuator.dialog).
 * 커밋(markCommitted) 뒤에는 실행당 동작 수·벽시계·정지로 끊지 않는다. 차단 신호는 커밋 뒤에도 멈춘다(verify 포함).
 */
export class RunEnforcer implements ActionPolicy {
  private readonly g: RateGuard;
  private readonly i: RunEnforcerInput;
  private startedAt: number;
  /** 사람 대기(핸드오프·Paused) 동안 벽시계를 멈춘다(부장 결정 2026-11-11, D03 §7). 멈춘 시각. */
  private pausedAt: number | null = null;
  private readonly forbidden: number[] = [];
  private actuations = 0;
  private committed = false;
  private arrived = false;
  private section: 'login' | null = null;
  private latch: { code: string; kind: SignalKind } | null = null;
  private finished = false;

  constructor(i: RunEnforcerInput) {
    this.g = i.guard;
    this.i = i;
    this.startedAt = i.mono();
  }

  /** 걸쇠에 걸린 종료 코드(없으면 null). */
  get halted(): string | null {
    return this.latch?.code ?? null;
  }

  get actuationCount(): number {
    return this.actuations;
  }

  // ---- 실행기·Actuator 지점 ----

  /** 스텝마다(실행기 beforeStep): 스텝 지연(보수 모드면 slowFactor배). 자는 동안 걸쇠·정지를 본다. */
  async beforeStep(): Promise<ActResult> {
    return this.sleep(this.delay(this.g.policy.pace.stepDelayMs));
  }

  async beforeAction(kind: ActionKind): Promise<ActResult> {
    const c = this.check();
    if (!c.ok) return c;
    if (kind === 'navigate') {
      for (let w = this.g.navigationWaitMs(); w > 0; w = this.g.navigationWaitMs()) {
        const s = await this.sleep(w);
        if (!s.ok) return s;
      }
    }
    if (!this.committed) {
      const r = this.runLimits(1);
      if (!r.ok) return r;
    }
    if (kind === 'navigate') this.g.countNavigation();
    this.actuations++;
    return OK;
  }

  /**
   * 바깥 장치(커밋 가드)가 실행을 멈춘다. 걸쇠는 차단처럼 다른 신호에 덮이지 않고, 그 뒤 모든 동작·스텝이 이 코드로 멈춘다.
   * 카운터·쿨다운은 건드리지 않는다(포털 신호가 아니다).
   */
  haltFor(code: string): void {
    if (this.latch?.kind === 'block') return;
    this.latch = { code, kind: 'block' };
    this.i.onLatch?.(code);
  }

  noteDialog(): void {
    this.actuations++;
  }

  /** 네비게이션 뒤(드라이버가 부른다): 안정 대기 뒤 걸쇠를 본다. */
  async settled(): Promise<ActResult> {
    return this.sleep(this.delay(this.g.policy.pace.afterNavSettleMs));
  }

  // ---- 관측(드라이버 배선이 부른다) ----

  /** 주소·문구(본문·대화상자). 사전에 맞으면 걸쇠. 문구는 저장하지 않는다. */
  observe(where: { url?: string; text?: string }): void {
    let h: SignalHit | null;
    try {
      h = matchSignal(this.i.dict, where);
    } catch {
      h = null;
    }
    if (h) this.onHit(h);
  }

  /** 포털 호스트의 HTTP 상태(D03 §7 (b), HTTP_RULES): 429·문서 403은 1회, 그 밖의 403은 창 안 count회. */
  observeStatus(status: number, document: boolean): void {
    if (status === 429) return this.onHit({ kind: 'block', id: 'http.429' });
    if (status !== 403) return;
    if (document) return this.onHit({ kind: 'block', id: 'http.403_document' });
    const t = this.i.mono();
    const { count, windowMs } = HTTP_RULES.forbiddenBurst;
    this.forbidden.push(t);
    while (this.forbidden.length && this.forbidden[0]! <= t - windowMs) this.forbidden.shift();
    if (this.forbidden.length >= count) this.onHit({ kind: 'block', id: 'http.403_burst' });
  }

  // ---- 실행 단계 ----

  enterLogin(): void {
    this.section = 'login';
  }

  leaveLogin(): void {
    this.section = null;
  }

  /** 사람 대기에 들어간다: run.maxWallClockMs 벽시계를 멈춘다. 실행 전체 수명 상한(2시간)은 IrRun이 따로 센다. */
  pauseClock(): void {
    this.pausedAt ??= this.i.mono();
  }

  /** 사람 대기에서 돌아왔다: 멈춘 시간만큼 벽시계 시작을 늦춘다. */
  resumeClock(): void {
    if (this.pausedAt === null) return;
    this.startedAt += this.i.mono() - this.pausedAt;
    this.pausedAt = null;
  }

  /** 기대한 화면(체크포인트)에 도착했다. 차단 신호 연속을 끊는 '깨끗한 실행'의 조건. */
  reached(): void {
    this.arrived = true;
  }

  /** 원장 armed와 같은 트랜잭션 안(M2-3 submit): 하루 비가역 수 증가(넘으면 거부). 그 뒤로는 실행당 상한으로 끊지 않는다. */
  markCommitted(): ActResult {
    try {
      this.g.countCommit(this.i.profileId);
    } catch (e) {
      return no(e instanceof RunEnd ? e.code : 'policy.irreversible_per_day');
    }
    this.committed = true;
    this.actuations++;
    return OK;
  }

  /**
   * 실행 끝: 신호 없이 기대 화면까지 간 실행이면 연속 횟수를 0으로. 화면을 못 찾고 끝난 실행은 모르는 화면 연속을 올린다
   * (2회 보수 모드, 3회부터 양성 탐지). 사용자가 멈춘 실행은 세지 않는다. 두 번 불러도 한 번만.
   */
  finish(o: { userStopped?: boolean } = {}): void {
    if (this.finished) return;
    this.finished = true;
    if (this.latch) return;
    if (this.arrived) return this.g.clean();
    if (o.userStopped) return;
    const streak = this.g.unknownScreen();
    this.i.journal('portal.unknown_screen', { streak });
    if (streak < UNKNOWN_SCREEN_POSITIVE) return;
    if (this.g.positive('portal.unknown_screen')) this.i.journal('cooldown.started', { hours: this.g.policy.cooldown.onBlockSignalHours });
  }

  // ---- 안 ----

  private check(): ActResult {
    if (this.latch) return no(this.latch.code);
    if (!this.committed && this.i.stopRequested?.()) return no('run.stopped');
    return OK;
  }

  private runLimits(extra: number): ActResult {
    const { conservative } = this.g.clock();
    const R = this.g.policy.run;
    if (this.actuations + extra > this.g.cap(R.maxActuationsPerRun, conservative)) return no('policy.actuations_per_run');
    if (this.i.mono() - this.startedAt > this.g.cap(R.maxWallClockMs, conservative)) return no('policy.wall_clock');
    return OK;
  }

  private delay(range: readonly [number, number]): number {
    const u = (this.i.random ?? Math.random)();
    const ms = range[0] + u * (range[1] - range[0]);
    return Math.round(this.g.clock().conservative ? ms * this.g.policy.pace.slowFactor : ms);
  }

  private async sleep(ms: number): Promise<ActResult> {
    const until = this.i.clock.now() + ms;
    for (;;) {
      const c = this.check();
      if (!c.ok) return c;
      const left = until - this.i.clock.now();
      if (left <= 0) return OK;
      await this.i.clock.sleep(Math.min(left, SLICE_MS));
    }
  }

  /** 첫 신호만 센다. 차단은 먼저 걸린 다른 신호(추가 인증·캡차·대기열)를 덮는다. 카운터를 못 남겨도 걸쇠가 먼저다. */
  private onHit(h: SignalHit): void {
    const cur = this.latch;
    if (this.finished || (cur && (cur.kind === 'block' || h.kind !== 'block'))) return;
    let kind = h.kind;
    let code: string;
    try {
      // 로그인 구간의 추가 인증은 예상된 2차 인증: 연속에 넣지 않고 핸드오프로만(ADR-025 결정 4)
      if (kind === 'extra_auth' && this.section !== 'login' && this.g.extraAuth() >= EXTRA_AUTH_FOR_SIGNAL) kind = 'block';
      if (kind === 'block') {
        const repeat = h.kind !== 'block';
        const id = repeat ? 'extra_auth.repeat' : h.id;
        const cooled = this.g.positive(id);
        this.i.journal('block.signal', { id });
        if (cooled) this.i.journal('cooldown.started', { hours: this.g.policy.cooldown.onBlockSignalHours });
        code = cooled ? 'policy.cooldown' : repeat ? 'portal.extra_auth_repeat' : 'portal.blocked';
      } else {
        if (kind === 'captcha') this.g.captcha();
        this.i.journal('portal.signal', { kind, id: h.id });
        code = HANDOFF[kind];
      }
    } catch {
      code = kind === 'block' ? 'portal.blocked' : HANDOFF[kind];
    }
    this.latch = { code, kind };
    try {
      this.i.onLatch?.(code);
    } catch {
      // 게이트 닫기에 실패해도 걸쇠는 걸렸다
    }
  }
}
