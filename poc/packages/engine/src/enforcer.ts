import type { ActResult, ActionKind, ActionPolicy, Clock, Policy, Portal } from './core/index.ts';
import { re2Problem } from './core/re2.ts';
import { HTTP_RULES, matchSignal, type SignalDict, type SignalEntry, type SignalHit, type SignalKind } from './signals.ts';
import { RunEnd } from './run-end.ts';
import { EXTRA_AUTH_FOR_SIGNAL, HANDOFF, RateGuard, UNKNOWN_SCREEN_POSITIVE, type RatePolicy } from './policy.ts';

export type PaceProfile = 'interactive' | 'daemon';

/**
 * 스텝 지연을 두는 스텝 타입(포털에 요청이 나가거나 화면을 바꾸는 것). wait·assert·readback·branch·repeat·extract·end·save_pdf처럼
 * 화면을 읽기만 하는 스텝은 사람 속도를 흉내 낼 요청이 없으니 지연을 두지 않는다(대표 실기기 피드백 2026-11-18 "단계 전환이 느림").
 * 요청 간격은 그대로다: 동작 스텝의 지연·분당 네비게이션·네비게이션 뒤 안정 대기는 바뀌지 않는다.
 */
export const PACED_STEP_TYPES: ReadonlySet<string> = new Set(['goto', 'checkpoint', 'click', 'fill', 'select', 'press', 'pick', 'gate', 'submit', 'verify']);

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
  atStart: Policy['cooldown']['blockSignalsAdd'];
  current: () => Policy['cooldown']['blockSignalsAdd'];
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

const OK: ActResult = { ok: true };
const no = (code: string): ActResult => ({ ok: false, code });
const SLICE_MS = 100;

export interface RunEnforcerInput {
  guard: RateGuard;
  clock: Clock;
  mono: () => number;
  dict: SignalDict;
  profileId: string;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  stopRequested?: () => boolean;
  onLatch?: (code: string) => void;
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
  private pausedAt: number | null = null;
  private readonly forbidden: number[] = [];
  private actuations = 0;
  private committed = false;
  private arrived = false;
  private section: 'login' | null = null;
  private latch: { code: string; kind: SignalKind } | null = null;
  private until: string | null = null;
  private finished = false;

  constructor(i: RunEnforcerInput) {
    this.g = i.guard;
    this.i = i;
    this.startedAt = i.mono();
  }

  get halted(): string | null {
    return this.latch?.code ?? null;
  }

  get maintenanceUntil(): string | null {
    return this.latch?.kind === 'maintenance' ? this.until : null;
  }

  get actuationCount(): number {
    return this.actuations;
  }

  async beforeStep(type?: string): Promise<ActResult> {
    if (type !== undefined && !PACED_STEP_TYPES.has(type)) return this.sleep(0);
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

  haltFor(code: string): void {
    if (this.latch?.kind === 'block') return;
    this.latch = { code, kind: 'block' };
    this.i.onLatch?.(code);
  }

  noteDialog(): void {
    this.actuations++;
  }

  async settled(): Promise<ActResult> {
    return this.sleep(this.delay(this.g.policy.pace.afterNavSettleMs));
  }

  observe(where: { url?: string; text?: string }): void {
    let h: SignalHit | null;
    try {
      h = matchSignal(this.i.dict, where);
    } catch {
      h = null;
    }
    if (h) this.onHit(h);
  }

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

  enterLogin(): void {
    this.section = 'login';
  }

  leaveLogin(): void {
    this.section = null;
  }

  pauseClock(): void {
    this.pausedAt ??= this.i.mono();
  }

  resumeClock(): void {
    if (this.pausedAt === null) return;
    this.startedAt += this.i.mono() - this.pausedAt;
    this.pausedAt = null;
  }

  reached(): void {
    this.arrived = true;
  }

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

  private onHit(h: SignalHit): void {
    const cur = this.latch;
    if (cur?.kind === 'maintenance' && h.kind === 'maintenance' && h.until && !this.until) {
      this.until = h.until;
      this.i.journal('portal.maintenance', { id: h.id, until: h.until });
    }
    if (this.finished || (cur && (cur.kind === 'block' || h.kind !== 'block'))) return;
    let kind = h.kind;
    let code: string;
    try {
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
        if (kind === 'maintenance') {
          if (h.until) this.until = h.until;
          this.i.journal('portal.maintenance', { id: h.id, ...(h.until ? { until: h.until } : {}) });
        }
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
