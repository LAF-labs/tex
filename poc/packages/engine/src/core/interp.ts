// 스텝 실행기(D03 §5.1): plan()은 D02 §4.3 간선 의미론 그대로다. 동적 스텝 생성은 없다.
//   for step: hooks.beforeStep → step.started → handler → step.finished{code} → resolveNext
// 실행기가 스스로 처리하는 것: 폴스루, branch 점프, repeat(헤더·본문·max 소진), onFail 재시도(정책 retries, Equal Jitter),
// checkpoint:<name> 점프, loopGuard, end. 사람·복구가 필요한 것(handoff·recover·human:secret·abort)과 아직 핸들러가 없는 스텝은
// 멈춤(RunStop)으로 돌려주고, 상태 머신(machine.ts)과 실행 조율(M2-2)이 이어 받는다.
import { effectiveOnFail, flatten, IRREVERSIBLE_TYPES, type StepInfo } from './cfg.ts';
import { evalCond } from './conds.ts';
import type { ActResult } from './page.ts';
import type { Handler, Handlers, Outcome, StepEnv } from './steps.ts';
import type { EndStep, OnFailThen, PlaybookIR, Policy, Step } from './types.ts';

export type RunStop =
  | { t: 'end'; at: string; status: EndStep['status'] }
  | { t: 'abort'; at: string; code: string | null }
  /** resumeAt: 사용자가 재개하면 이어서 돌 스텝(비가역 스텝의 실패면 그 verify, D03 §2). */
  | { t: 'handoff'; at: string; resumeAt: string; code: string | null }
  /** 복구 계층(L1·L2, M2-5)이 받는다. 성공하면 실패한 그 스텝부터 다시. */
  | { t: 'recover'; at: string; code: string }
  /** 금고 비밀 창(D05 §3.5). 닫힌 뒤 next부터. */
  | { t: 'human_secret'; at: string; next: string; code: string }
  /** 이 실행기에 핸들러가 없는 스텝(M2-2·M2-3이 붙인다). 그 스텝은 실행하지 않았다. */
  | { t: 'unhandled'; at: string; type: Step['type'] }
  /** 최상위 마지막 스텝을 지나 end 없이 떨어짐(정적 검증이 막는다). */
  | { t: 'falloff'; at: string };

export interface InterpHooks {
  /**
   * 정책 집행 지점(Actuator.policy.beforeStep, M2-4: 스텝 지연·걸쇠·정지). {ok:false, code}를 돌려주면 스텝을 실행하지 않고 멈춘다:
   * FORCED_STOPS에 있는 코드는 그 처리(핸드오프·중단), 없는 코드는 중단.
   */
  beforeStep?(s: Step): Promise<void | ActResult> | void | ActResult;
  /** 저널. 값 없이 스텝 id·타입·코드·시도 횟수만. */
  event?(name: 'step.started' | 'step.finished' | 'step.retry' | 'step.loop_guard', data: { stepId: string; type: string; code?: string; cause?: string; attempt?: number }): void;
}

export interface InterpOptions {
  retries: Policy['retries'];
  /** 재시도 지연 하한(= 정책 stepDelayMs 하한, D02 §5). */
  retryFloorMs: number;
  /** [0, 1) 난수(시험에서 고정). */
  random?: () => number;
  /** 실행당 스텝 실행 상한(순환 방어. loopGuard와 별개의 엔진 안전망). */
  maxStepExecutions?: number;
  /** FORCED_STOPS에 더할 코드(실행 조율기가 스스로 상태를 바꾼 멈춤: 게이트 거부·TTL 등). */
  forcedStops?: ReadonlyMap<string, 'handoff' | 'abort'>;
}

export const MAX_STEP_EXECUTIONS = 2_000;

/** Equal Jitter(D03 §7): d = min(cap, base·2^(n−1)), 지연 = d/2 + U·d/2, 하한 floor. n은 1부터. */
/**
 * 재시도·onFail 없이 곧바로 멈추는 실패 코드(D16 처리 열). 보고 코드는 스텝 code로 바꾸지 않고 원래 코드다.
 * - step.commit_shadow: 클릭 안 함, 핸드오프(보안 이벤트).
 * - step.irreversible_unguarded·step.secret_field: 플레이북 결함(정적 검증 V-03g·V-04·V-20을 지나친 것). 재시도해도 같으므로 중단(PROPOSED_D16).
 * - 정책 집행기(M2-4 B) 거부: 차단 신호·쿨다운·실행당 상한·정지는 중단(D16 portal.blocked "중단+쿨다운"),
 *   추가 인증·캡차·대기열은 핸드오프(사람이 풀고 이어 간다).
 */
export const FORCED_STOPS: ReadonlyMap<string, 'handoff' | 'abort'> = new Map([
  ['step.commit_shadow', 'handoff'],
  ['step.irreversible_unguarded', 'abort'],
  ['step.secret_field', 'abort'],
  ['portal.blocked', 'abort'],
  ['portal.extra_auth_repeat', 'abort'],
  ['policy.cooldown', 'abort'],
  ['policy.actuations_per_run', 'abort'],
  ['policy.wall_clock', 'abort'],
  ['policy.irreversible_per_day', 'abort'],
  ['run.stopped', 'abort'],
  ['portal.mfa_pending', 'handoff'],
  ['portal.captcha', 'handoff'],
  ['portal.busy', 'handoff'],
  // 커밋 가드(D03 §5.4, D16): 무장 없는 커밋 요청·잡지 못한 커밋 요청·무장 거부는 중단, 본문 불일치는 핸드오프
  ['commit_guard.blocked_request', 'abort'],
  ['commit_guard.unintercepted', 'abort'],
  ['commit_guard.arm_refused', 'abort'],
  ['security.commit_payload_mismatch', 'handoff'],
]);

export function retryDelayMs(attempt: number, r: Pick<Policy['retries'], 'baseMs' | 'capMs'>, floorMs: number, u: number): number {
  const d = Math.min(r.capMs, r.baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.max(floorMs, Math.round(d / 2 + u * (d / 2)));
}

export class Interpreter {
  private readonly info: Map<string, StepInfo>;
  private readonly checkpoints = new Map<string, string>();
  private readonly visits = new Map<string, number>();
  private readonly repeatIter = new Map<string, number>();
  private executed = 0;
  private readonly ir: PlaybookIR;
  private readonly handlers: Handlers;
  private readonly env: StepEnv;
  private readonly opts: InterpOptions;
  private readonly hooks: InterpHooks;

  constructor(ir: PlaybookIR, handlers: Handlers, env: StepEnv, opts: InterpOptions, hooks: InterpHooks = {}) {
    this.ir = ir;
    this.handlers = handlers;
    this.env = env;
    this.opts = opts;
    this.hooks = hooks;
    this.info = flatten(ir.steps).info;
    for (const [id, { step }] of this.info) if (step.type === 'checkpoint') this.checkpoints.set(step.name, id);
  }

  get entry(): string | null {
    return this.ir.steps[0]?.id ?? null;
  }

  /** 폴스루 목적지: 다음 원소, 없으면 감싼 repeat 헤더, 최상위 끝이면 null. */
  private fallTarget(id: string): string | null {
    const i = this.info.get(id)!;
    return i.next ?? i.repeats.at(-1) ?? null;
  }

  /** from부터 멈출 때까지 실행한다. */
  async run(from: string | null = this.entry, prev: string | null = null): Promise<RunStop> {
    let cur = from;
    let last = prev;
    while (cur) {
      const info = this.info.get(cur);
      if (!info) return { t: 'abort', at: last ?? cur, code: 'step.unknown_target' };
      const s = info.step;
      if (++this.executed > (this.opts.maxStepExecutions ?? MAX_STEP_EXECUTIONS)) {
        this.hooks.event?.('step.loop_guard', { stepId: s.id, type: s.type });
        return { t: 'abort', at: s.id, code: 'step.loop_guard' };
      }
      // loopGuard: 순환에 참여하는 스텝의 방문 상한(V-18). 넘으면 다시 돌지 않고 사람에게 넘긴다.
      const n = (this.visits.get(s.id) ?? 0) + 1;
      this.visits.set(s.id, n);
      if (s.loopGuard && n > s.loopGuard.max) {
        this.hooks.event?.('step.loop_guard', { stepId: s.id, type: s.type });
        return { t: 'handoff', at: s.id, resumeAt: s.id, code: 'step.loop_guard' };
      }

      const next = await this.exec(s, last);
      last = s.id;
      if (typeof next !== 'string') return next;
      cur = next;
    }
    return { t: 'falloff', at: last ?? '' };
  }

  /** 스텝 하나(재시도 포함)를 실행하고 다음 스텝 id 또는 멈춤을 돌려준다. */
  private async exec(s: Step, prev: string | null): Promise<string | RunStop> {
    if (s.type === 'handoff') return { t: 'handoff', at: s.id, resumeAt: s.resumeAt, code: null };
    if (s.type === 'repeat') return this.repeat(s, prev);
    const h = this.handlers[s.type] as Handler<typeof s.type> | undefined;
    if (!h) return { t: 'unhandled', at: s.id, type: s.type };

    const of = effectiveOnFail(this.ir, s);
    // 비가역 스텝은 재시도하지 않는다(V-03f). 정책 stepMax가 상한.
    const retries = IRREVERSIBLE_TYPES.has(s.type) || this.env.irreversible.has(s.id) ? 0 : Math.max(0, Math.min(of.retry, this.opts.retries.stepMax));
    for (let attempt = 0; ; attempt++) {
      const pre = await this.hooks.beforeStep?.(s);
      if (pre && !pre.ok) return this.forced(pre.code) === 'handoff' ? { t: 'handoff', at: s.id, resumeAt: s.id, code: pre.code } : { t: 'abort', at: s.id, code: pre.code };
      this.hooks.event?.('step.started', { stepId: s.id, type: s.type, ...(attempt ? { attempt } : {}) });
      let out: Outcome;
      try {
        out = await h(s as never, this.env);
      } catch {
        // 포트 예외는 값 없이 코드로만 남긴다.
        out = { t: 'fail', code: 'step.port_error' };
      }
      this.hooks.event?.('step.finished', { stepId: s.id, type: s.type, ...(out.t === 'fail' ? this.codes(s, out.code) : {}) });
      if (out.t !== 'fail') return this.after(s, out);
      // 재시도·onFail을 거치지 않는 코드(D16 처리 열): 같은 동작을 다시 해도 같은 거부라 바로 멈춘다.
      const forced = this.forced(out.code);
      if (forced === 'handoff') return { t: 'handoff', at: s.id, resumeAt: s.id, code: out.code };
      if (forced === 'abort') return { t: 'abort', at: s.id, code: out.code };
      if (attempt < retries) {
        const delay = retryDelayMs(attempt + 1, this.opts.retries, this.opts.retryFloorMs, (this.opts.random ?? Math.random)());
        this.hooks.event?.('step.retry', { stepId: s.id, type: s.type, attempt: attempt + 1, ...this.codes(s, out.code) });
        await this.env.clock.sleep(delay);
        continue;
      }
      return this.onFail(s, of.then, this.codes(s, out.code).code);
    }
  }

  private forced(code: string): 'handoff' | 'abort' | undefined {
    return this.opts.forcedStops?.get(code) ?? FORCED_STOPS.get(code);
  }

  /** 보고 코드: 스텝의 code(D02 §4 공통 필드)가 있으면 그것, 원래 코드는 cause. */
  private codes(s: Step, code: string): { code: string; cause?: string } {
    return s.code && s.code !== code ? { code: s.code, cause: code } : { code };
  }

  private after(s: Step, out: Exclude<Outcome, { t: 'fail' }>): string | RunStop {
    if (out.t === 'end') return { t: 'end', at: s.id, status: out.status };
    if (out.t === 'jump') {
      if (out.to === 'abort') return { t: 'abort', at: s.id, code: null };
      if (out.to === 'handoff') return { t: 'handoff', at: s.id, resumeAt: s.id, code: null };
      return out.to;
    }
    const n = this.fallTarget(s.id);
    return n ?? { t: 'falloff', at: s.id };
  }

  private onFail(s: Step, then: OnFailThen, code: string): string | RunStop {
    const irr = IRREVERSIBLE_TYPES.has(s.type) ? (s as { verify: string }).verify : null;
    if (then === 'abort') return { t: 'abort', at: s.id, code };
    if (then === 'handoff') return { t: 'handoff', at: s.id, resumeAt: irr ?? s.id, code };
    if (then === 'recover') return { t: 'recover', at: s.id, code };
    if (then === 'human:secret') {
      const next = irr ?? this.fallTarget(s.id);
      return next ? { t: 'human_secret', at: s.id, next, code } : { t: 'falloff', at: s.id };
    }
    const cp = this.checkpoints.get(then.slice('checkpoint:'.length));
    return cp ?? { t: 'abort', at: s.id, code: 'step.unknown_target' };
  }

  /**
   * repeat(D02 §4.3-1): 헤더에서 until을 매번(첫 진입 포함) 평가한다. 참이면 다음 원소, 본문을 max번 돈 뒤에도 거짓이면 실패(onFail).
   * 본문 밖에서 헤더로 들어오면 횟수를 0으로 되돌린다.
   */
  private async repeat(s: Extract<Step, { type: 'repeat' }>, prev: string | null): Promise<string | RunStop> {
    const fromBody = prev !== null && (this.info.get(prev)?.repeats.includes(s.id) ?? false);
    if (!fromBody) this.repeatIter.set(s.id, 0);
    this.hooks.event?.('step.started', { stepId: s.id, type: s.type });
    const r = await evalCond(s.until, this.env);
    const iter = this.repeatIter.get(s.id) ?? 0;
    let code: string | null = null;
    if (!r.ok) code = r.code;
    else if (r.value) {
      this.hooks.event?.('step.finished', { stepId: s.id, type: s.type });
      return this.fallTarget(s.id) ?? { t: 'falloff', at: s.id };
    } else if (iter >= s.max) code = 'step.repeat_exhausted';
    if (code) {
      const c = this.codes(s, code);
      this.hooks.event?.('step.finished', { stepId: s.id, type: s.type, ...c });
      return this.onFail(s, effectiveOnFail(this.ir, s).then, c.code);
    }
    this.repeatIter.set(s.id, iter + 1);
    this.hooks.event?.('step.finished', { stepId: s.id, type: s.type });
    return s.steps[0]?.id ?? this.fallTarget(s.id) ?? { t: 'falloff', at: s.id };
  }
}
