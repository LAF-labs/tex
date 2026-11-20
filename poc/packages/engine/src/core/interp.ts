import { effectiveOnFail, flatten, IRREVERSIBLE_TYPES, type StepInfo } from './cfg.ts';
import { evalCond } from './conds.ts';
import type { ActResult } from './page.ts';
import type { Handler, Handlers, Outcome, StepEnv } from './steps.ts';
import type { EndStep, OnFailThen, PlaybookIR, Policy, Step } from './types.ts';

export type RunStop =
  | { t: 'end'; at: string; status: EndStep['status'] }
  | { t: 'abort'; at: string; code: string | null }
  | { t: 'handoff'; at: string; resumeAt: string; code: string | null }
  | { t: 'recover'; at: string; code: string; cause?: string }
  | { t: 'human_secret'; at: string; next: string; code: string }
  | { t: 'unhandled'; at: string; type: Step['type'] }
  | { t: 'falloff'; at: string };

export interface InterpHooks {
  beforeStep?(s: Step): Promise<void | ActResult> | void | ActResult;
  event?(name: 'step.started' | 'step.finished' | 'step.retry' | 'step.loop_guard', data: { stepId: string; type: string; code?: string; cause?: string; attempt?: number }): void;
}

export interface InterpOptions {
  retries: Policy['retries'];
  retryFloorMs: number;
  random?: () => number;
  maxStepExecutions?: number;
  forcedStops?: ReadonlyMap<string, 'handoff' | 'abort'>;
  escalate?: (s: Step, cause: string) => boolean;
  fastEscalate?: (s: Step, cause: string, attempt: number) => boolean;
  stop?: AbortSignal;
}

const STOPPABLE = new Set<Step['type']>(['goto', 'click', 'fill', 'select', 'press', 'wait', 'assert', 'extract', 'readback', 'pick'] as Step['type'][]);

export const MAX_STEP_EXECUTIONS = 2_000;

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
  ['portal.maintenance', 'abort'],
  ['commit_guard.blocked_request', 'abort'],
  ['commit_guard.unintercepted', 'abort'],
  ['commit_guard.arm_refused', 'abort'],
  ['security.commit_payload_mismatch', 'handoff'],
  ['portal.unobservable', 'handoff'],
  ['decide.unavailable', 'handoff'],
  ['decide.unknown', 'handoff'],
  ['sign.refused_in_commit', 'abort'],
  ['sign.method_unknown', 'handoff'],
  ['sign.no_path', 'handoff'],
  ['sign.unsupported', 'handoff'],
  ['save_pdf.unsupported', 'abort'],
  ['portal.logged_out_by_other_session', 'handoff'],
  ['verify.baseline_missing', 'handoff'],
  ['gate.token_invalid', 'abort'],
  ['ledger.arm_failed', 'abort'],
  ['issue.locked_elsewhere', 'handoff'],
  ['issue.lock_unavailable', 'handoff'],
  ['issue.lock_lost', 'handoff'],
  ['commit.precheck_failed', 'handoff'],
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

  private fallTarget(id: string): string | null {
    const i = this.info.get(id)!;
    return i.next ?? i.repeats.at(-1) ?? null;
  }

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

  private async exec(s: Step, prev: string | null): Promise<string | RunStop> {
    if (s.type === 'handoff') return { t: 'handoff', at: s.id, resumeAt: s.resumeAt, code: s.code ?? null };
    if (s.type === 'repeat') return this.repeat(s, prev);
    const h = this.handlers[s.type] as Handler<typeof s.type> | undefined;
    if (!h) return { t: 'unhandled', at: s.id, type: s.type };

    const of = effectiveOnFail(this.ir, s);
    const retries = IRREVERSIBLE_TYPES.has(s.type) || this.env.irreversible.has(s.id) ? 0 : Math.max(0, Math.min(of.retry, this.opts.retries.stepMax));
    for (let attempt = 0; ; attempt++) {
      const pre = await this.hooks.beforeStep?.(s);
      if (pre && !pre.ok) return this.forced(pre.code) === 'handoff' ? { t: 'handoff', at: s.id, resumeAt: s.id, code: pre.code } : { t: 'abort', at: s.id, code: pre.code };
      this.hooks.event?.('step.started', { stepId: s.id, type: s.type, ...(attempt ? { attempt } : {}) });
      let out: Outcome;
      try {
        const run = h(s as never, this.env);
        out = this.opts.stop && STOPPABLE.has(s.type) && !this.env.irreversible.has(s.id) ? await this.untilStop(run, { t: 'fail', code: 'run.stopped' }) : await run;
      } catch {
        out = { t: 'fail', code: 'step.port_error' };
      }
      this.hooks.event?.('step.finished', { stepId: s.id, type: s.type, ...(out.t === 'fail' ? this.codes(s, out.code) : {}) });
      if (out.t !== 'fail') return this.after(s, out);
      const forced = this.forced(out.code);
      if (forced === 'handoff') return { t: 'handoff', at: s.id, resumeAt: s.id, code: out.code };
      if (forced === 'abort') return { t: 'abort', at: s.id, code: out.code };
      if (attempt < retries && !(of.then === 'handoff' && this.opts.fastEscalate?.(s, out.code, attempt) && this.opts.escalate?.(s, out.code))) {
        const delay = retryDelayMs(attempt + 1, this.opts.retries, this.opts.retryFloorMs, (this.opts.random ?? Math.random)());
        this.hooks.event?.('step.retry', { stepId: s.id, type: s.type, attempt: attempt + 1, ...this.codes(s, out.code) });
        await this.untilStop(this.env.clock.sleep(delay), undefined);
        continue;
      }
      const c = this.codes(s, out.code);
      if (of.then === 'handoff' && this.opts.escalate?.(s, out.code)) return { t: 'recover', at: s.id, code: c.code, cause: out.code };
      return this.onFail(s, of.then, c.code);
    }
  }

  private untilStop<T>(p: Promise<T>, stopped: T): Promise<T> {
    const sig = this.opts.stop;
    if (!sig) return p;
    const drop = () => void p.catch(() => {});
    if (sig.aborted) {
      drop();
      return Promise.resolve(stopped);
    }
    return new Promise<T>((resolve, reject) => {
      const on = () => {
        drop();
        resolve(stopped);
      };
      sig.addEventListener('abort', on, { once: true });
      p.then(
        (v) => (sig.removeEventListener('abort', on), resolve(v)),
        (e: unknown) => (sig.removeEventListener('abort', on), reject(e)),
      );
    });
  }

  private forced(code: string): 'handoff' | 'abort' | undefined {
    return this.opts.forcedStops?.get(code) ?? FORCED_STOPS.get(code);
  }

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
