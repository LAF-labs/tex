import type { GateRepo, LedgerState } from '@sax/db';
import { flatten, type StepInfo } from '../core/cfg.ts';
import { evalCond } from '../core/conds.ts';
import { Interpreter, type InterpHooks, type InterpOptions, type RunStop } from '../core/interp.ts';
import { initialState, transition, type MachineCtx, type RunEvent, type RunState, type RunStateName, type VerifyResult } from '../core/machine.ts';
import type { ActResult, Clock, Resolved } from '../core/page.ts';
import { pickRow } from '../core/pick.ts';
import { compileRe2 } from '../core/re2.ts';
import { decideGate, reenterCheckpoint } from '../core/runtime.ts';
import { waitTarget, type Handler, type Handlers, type Outcome, type StepEnv } from '../core/steps.ts';
import type { GateToken, GateTokens, TokenDiscardTrigger } from '../core/token.ts';
import type { PlaybookIR, SignMethod, Step, StepOf } from '../core/types.ts';
import { failSignalKeys, verifyOfIrreversible, type VerifyBook, type VerifyJudgement } from '../core/verify.ts';
import { readField } from '../core/readback.ts';
import { savePdf, type PdfPort } from '../core/savepdf.ts';
import { SECURITY_REJECTIONS } from '../core/token.ts';
import { buildGateRequest, GATE_CARDS, type GateField, type GateRequest } from '../gate.ts';

const CERT_PW_FAILED: ReadonlySet<string> = new Set(['sign.password_wrong', 'sign.password_retry_limit']);

/**
 * 조율기가 상태를 이미 바꾼 뒤 실행기를 멈추게 하는 코드. 재시도·onFail을 거치지 않는다.
 * abort 계열은 조율기가 이미 상태를 정했고, handoff 계열은 조율기가 핸드오프 전이를 한다.
 */
export const CONTROL_STOPS: ReadonlyMap<string, 'handoff' | 'abort'> = new Map([
  ['run.state_stop', 'abort'],
  ['gate.denied', 'abort'],
  ['gate.expired', 'abort'],
  ['human.ttl_expired', 'abort'],
  ['run.aborted', 'abort'],
  ['gate.unavailable', 'handoff'],
  ['verify.not_committed_repeat', 'handoff'],
]);

/**
 * 한 실행에서 같은 verify가 not_committed로 게이트 앞에 되돌아가도 되는 횟수. 넘으면 다시 돌지 않고 사람에게 넘긴다
 * (대표 실기기 피드백 2026-11-18: 사업자등록증명이 신청 화면과 처리결과 확인 사이를 계속 돌았다). 같은 화면에서 같은 클릭이 두 번
 * 신청을 만들지 못했다면 세 번째도 같다고 본다.
 */
export const NOT_COMMITTED_RETRIES = 1;

const SIGN_ACTION: Readonly<Record<string, 'human:secret' | null>> = { cert: 'human:secret', simple_auth: null };

/**
 * 클릭 결과 코드 중 "요청이 나가지 않았음"이 확실한 것(가드·R-A1·동작 가능성 사전 확인·정책 거부, D03 §5.3).
 * 이 밖의 실패는 실제 클릭 도중의 예외일 수 있으므로 dispatched로 보고 verify로 간다.
 */
export const CLICK_NOT_SENT: ReadonlySet<string> = new Set([
  'step.identity_mismatch', 'step.irreversible_unguarded', 'step.commit_shadow', 'step.not_clickable', 'step.secret_field', 'step.selector_miss',
  'portal.blocked', 'policy.cooldown', 'policy.actuations_per_run', 'policy.wall_clock', 'policy.irreversible_per_day', 'run.stopped',
]);

/**
 * 커밋 구간 진입 포트(D03 §3 R-G7, §5.4). 원장 결과(dispatched·committed·not_committed·in_doubt)는 상태 머신 효과로 onEffect에 간다.
 * 이 포트는 R-G7 순서에서 결과를 기다려야 하는 두 단계만 맡는다.
 */
export interface CommitPort {
  arm(a: { stepId: string; reqId: string; actionHash: string }): ActResult | Promise<ActResult>;
  armGuard(a: { stepId: string; armedUntil: number }): Promise<ActResult>;
  disarmGuard(): Promise<void>;
}

export type GateAnswer = { reqId: string; decision: 'approved' | 'denied'; by: 'local' | 'remote'; actionHash: string };
export type HumanAnswer = { reqId: string; value?: string };
type ReadbackValues = Parameters<typeof buildGateRequest>[0]['readback'];
/** 승인 뒤 이 시간 안에 온 [중지]가 이긴다(D03 §2 표, 거부 우선 창 2초). H01 RunService DENY_PRIORITY_MS와 같다. */
export const GATE_DENY_PRIORITY_MS = 2_000;
/** 서명 차례 상한 기본값(B3, 부장 결정 2026-11-11). 실행 수명 상한이 더 짧으면 signTurnMs가 그 값을 준다. */
export const SIGN_TURN_MS = 30 * 60_000;

/** 이동한 뒤 체크포인트 expect가 참이 되기를 기다리는 기본 상한(ms). 홈택스는 로드 뒤 약 5~8초에 화면을 그린다. */
export const CHECKPOINT_SETTLE_MS = 20_000;
/** signFlow 방식 선택 항목·서명 화면 표지를 기다리는 상한(ms). 서명 화면은 보통 1초 안에 뜬다. */
export const SIGN_READY_WAIT_MS = 15_000;
/** 서명 화면 표지가 사라진 뒤 끝 표지를 더 기다리는 시간(ms). 이 안에 끝 표지가 없으면 [취소]로 본다. */
export const SIGN_CANCEL_GRACE_MS = 3_000;
/** 서명 차례가 끝난 까닭. done = 사람이 [다 했어요], clicked = 엔진이 확인 버튼을 (무장 한 번에 한 번) 눌렀다. 어느 쪽이든 그다음은 verify다. */
export type SignTurnEnd = 'done' | 'clicked' | 'done_seen' | 'abort' | 'cap';
/** 서명 동작('done'·PUSH 승인) 뒤 확인 버튼을 찾는 짧은 여유. 실화면에서는 인증서 창의 [확인]이 곧 커밋이라 따로 누를 버튼이 없을 수 있다(2026-11-11 실제 발급). */
export const CONFIRM_GRACE_MS = 2_000;

/**
 * 서명 차례 포트(B3): 발급 클릭 뒤 서명이 제때 끝나지 않았다. 커밋 구간 안의 사람 대기다(상태 기계는 Running·commit 그대로).
 * kind push = 간편인증 폰 승인을 기다림, secret = 금고 비밀 창(human.secret)이 TTL로 끝남. 셸은 phase sign 핸드오프로 보인다.
 */
export interface SignTurnPort {
  opened(r: { runId: string; stepId: string; kind: 'push' | 'secret' }): void;
  closed(r: { runId: string; stepId: string; why: SignTurnEnd }): void;
}

export type GateCloseReason = 'approved' | 'denied' | 'edit' | 'expired' | 'aborted' | 'stopped';

export interface GatePort {
  publish(req: GateRequest): void;
  closed(reqId: string, why: GateCloseReason): void;
}

export interface HumanPort {
  request(r: { runId: string; stepId: string; reqId: string; kind: 'captcha' | 'otp' | 'manual'; prompt: string; region?: string; ttlMs: number; inputSpec?: { pattern?: string; maxLength?: number } }): void;
  secret(r: { runId: string; stepId: string; target?: string; prompt?: string; ttlMs: number }): Promise<'done' | 'ttl' | { code: string }>;
  closed(reqId: string, why: 'answered' | 'ttl' | 'aborted'): void;
  afterSignConfirm?(r: { runId: string; stepId: string }): Promise<'ok' | 'wrong'>;
}

/** 취소할 수 있는 타이머(게이트 waitMs·사람 TTL·핸드오프 상한). 시험은 손으로 돌리는 것을 넣는다. */
export interface Timers {
  after(ms: number, fn: () => void): () => void;
}
export const systemTimers: Timers = {
  after(ms, fn) {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
  },
};

export interface RunControllerInput {
  runId: string;
  intentId: string;
  packageDigest: string;
  ir: PlaybookIR;
  handlers: Handlers;
  env: StepEnv;
  interp: InterpOptions;
  beforeStep?: InterpHooks['beforeStep'];
  stepEvent?: InterpHooks['event'];
  clock: Clock;
  timers?: Timers;
  gates: Pick<GateRepo, 'open' | 'decide' | 'withdraw'>;
  tokens: GateTokens;
  ledgerStates: () => readonly LedgerState[];
  inDoubtStep?: () => string | null;
  allowed?: () => boolean;
  hardStop?: () => boolean;
  card: (g: StepOf<'gate'>) => { readback: ReadbackValues; reserved: GateField[] } | null;
  preGate?: (g: StepOf<'gate'>) => Promise<ActResult>;
  beforeCommit?: (x: string) => Promise<ActResult>;
  wmaxMs: (x: string) => number;
  commitWindowMs: number;
  denyPriorityMs?: number;
  gate: GatePort;
  human: HumanPort;
  inputLock?: (on: boolean) => Promise<boolean>;
  guardMode?: (m: 'running' | 'observing') => void;
  observedManual?: () => boolean;
  reentry: { navigate(url: string): Promise<void>; loggedIn(): Promise<boolean> };
  recover?: (stop: Extract<RunStop, { t: 'recover' }>) => Promise<boolean | { from: string }>;
  verify?: (x: string) => Promise<VerifyResult>;
  verifyStep?: (v: StepOf<'verify'>) => Promise<VerifyJudgement>;
  commit?: CommitPort;
  pdf?: PdfPort;
  verifyBook?: VerifyBook;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  onState?: (e: RunStateEvent) => void;
  onEffect?: (effect: string, at: string | null) => void;
  signTurn?: SignTurnPort;
  signTurnMs?: () => number;
  handoffTimeoutMs?: number;
  secretTtlMs?: number;
}

export interface RunStateEvent {
  runId: string;
  state: RunStateName;
  prev: RunStateName;
  at: string | null;
  code: string | null;
  ui: string[];
}

export interface RunOutcome {
  state: RunStateName;
  at: string | null;
  code: string | null;
  resumeAt?: string;
}

type GateWait = { kind: 'answer'; a: GateAnswer } | { kind: 'edit' } | { kind: 'timeout' } | { kind: 'abort' } | { kind: 'downgrade' };
type HumanWait = { kind: 'answer'; a: HumanAnswer } | { kind: 'ttl' } | { kind: 'abort' };

const NEXT: Outcome = { t: 'next' };
const fail = (code: string): Outcome => ({ t: 'fail', code });

const DISCARD_BY_STATE: Partial<Record<RunStateName, TokenDiscardTrigger>> = { Recovering: 'Recovering', WaitingHuman: 'WaitingHuman', HandedOff: 'HandedOff', Paused: 'Paused', Interrupted: 'Interrupted' };
const UNRESOLVED_LEDGER: ReadonlySet<LedgerState> = new Set(['armed', 'dispatched', 'observed_manual', 'in_doubt']);
const RESTING: ReadonlySet<RunStateName> = new Set(['HandedOff', 'Paused', 'Interrupted', 'InDoubt']);

const CONTROLLER_EFFECTS: ReadonlySet<string> = new Set([
  'input.lock', 'token.issue', 'rewind.pre_gate', 'rewind.checkpoint', 'checkpoint.restore', 'resume_at', 'step.rerun_failed',
  'pre_safety_check', 'verify.baseline', 'dup.portal_existing', 'card.from_readback', 'gate.request_publish', 'verify.run',
  'token.verify', 'ledger.arm+token.consume', 'readback.recompute', 'commit_guard.arm', 'click',
]);

export class RunController {
  private readonly i: RunControllerInput;
  private readonly timers: Timers;
  private st: RunState = initialState();
  private readonly interp: Interpreter;
  private readonly info: Map<string, StepInfo>;
  private readonly primaryOf = new Map<string, string>();
  private readonly gateOf = new Map<string, string>();
  private readonly soleX: string | null;
  private readonly staticPreGate = new Map<string, string>();
  private readonly visitedCp = new Set<string>();
  private lastCp: string | null = null;
  private gateReq: GateRequest | null = null;
  private preGateCp: string | null = null;
  private gateWake: ((w: GateWait) => void) | null = null;
  private humanWait: { reqId: string; step: StepOf<'human'>; wake: (w: HumanWait) => void } | null = null;
  private signWake: ((w: Exclude<SignTurnEnd, 'clicked'>) => void) | null = null;
  private confirmClicked = false;
  private readonly signClicked = new Set<string>();
  private armedExp = 0;
  private dispatchMark: { verifyId: string; failBefore: Set<string> } | null = null;
  private handoffResumeAt: string | null = null;
  private readonly tokensByGate = new Map<string, { token: GateToken; reqId: string }>();
  private readonly approvedReadback = new Map<string, ReadonlyMap<string, string>>();
  private armedKey: string | null = null;
  private armedConfirmRe: RegExp | null = null;
  private readonly notCommitted = new Map<string, number>();
  private guardArmed = false;
  private pending: 'abort' | 'downgrade' | null = null;
  private resumeAt: string | null = null;
  private cancelHandoffTimer: (() => void) | null = null;
  private handoffCode: string | null = null;
  private stateCode: string | null = null;

  constructor(i: RunControllerInput) {
    this.i = i;
    this.timers = i.timers ?? systemTimers;
    this.info = flatten(i.ir.steps).info;
    let cp: string | null = null;
    for (const [id, { step }] of this.info) {
      if (step.type === 'checkpoint') cp = id;
      if (step.type === 'gate') {
        const x = step.authorizes[0];
        if (x) {
          this.primaryOf.set(id, x);
          this.gateOf.set(x, id);
        }
        if (cp) this.staticPreGate.set(id, cp);
      }
    }
    const xs = new Set(this.primaryOf.values());
    this.soleX = xs.size === 1 ? [...xs][0]! : null;
    const bound = {
      ...i.handlers,
      gate: this.gateStep, human: this.humanStep, checkpoint: this.checkpointStep,
      submit: this.submitStep, human_commit: this.refuseIrreversible, send_email: this.refuseIrreversible, sign: this.signStep,
      ...(i.verifyStep ? { verify: this.verifyStep } : {}),
      ...(i.pdf ? { save_pdf: this.savePdfStep } : {}),
    } as Handlers;
    i.env.stopRequested ??= () => this.pending === 'abort';
    const forcedStops = new Map([...(i.interp.forcedStops ?? []), ...CONTROL_STOPS]);
    this.interp = new Interpreter(i.ir, bound, i.env, { ...i.interp, forcedStops }, { beforeStep: this.beforeStep, event: i.stepEvent });
  }

  get state(): RunState {
    return this.st;
  }

  tokenFor(gateStepId: string): { token: GateToken; reqId: string } | null {
    return this.tokensByGate.get(gateStepId) ?? null;
  }

  commitArmed(key: string): boolean {
    return this.st.commit && this.armedKey === key;
  }

  armedConfirm(): RegExp | null {
    return this.st.commit && this.armedKey ? this.armedConfirmRe : null;
  }

  async start(o: { intentReuse?: boolean } = {}): Promise<RunOutcome> {
    if (!this.fire({ t: 'load' }, null, null)) return this.result(null, 'engine.illegal_transition');
    const reuse = !!o.intentReuse;
    this.fire({ t: 'start', intentReuse: reuse }, null, reuse ? 'ledger.intent_reuse' : null);
    if (this.name() !== 'Preparing') return this.result(null, reuse ? 'ledger.intent_reuse' : null);
    this.fire({ t: 'prepared' }, null, null);
    if (this.name() !== 'Running') return this.result(null, null);
    return this.loop(this.interp.entry, null);
  }

  answerGate(a: GateAnswer): { ok: boolean; code?: string } {
    const req = this.gateReq;
    if (!this.gateWake || !req || req.reqId !== a.reqId) return { ok: false, code: 'gate.no_request' };
    if (a.actionHash !== req.actionHash) return { ok: false, code: 'gate.action_mismatch' };
    this.wakeGate({ kind: 'answer', a });
    return { ok: true };
  }

  cancelGateForEdit(): boolean {
    if (!this.gateWake) return false;
    this.wakeGate({ kind: 'edit' });
    return true;
  }

  answerHuman(stepId: string, a: HumanAnswer): { ok: boolean; code?: string } {
    const w = this.humanWait;
    if (!w || w.step.id !== stepId || w.reqId !== a.reqId) return { ok: false, code: 'human.no_request' };
    if (w.step.kind !== 'manual' && !inputOk(w.step.inputSpec, a.value)) return { ok: false, code: 'human.bad_input' };
    w.wake({ kind: 'answer', a });
    return { ok: true };
  }

  abort(): void {
    if (this.gateWake) return this.wakeGate({ kind: 'abort' });
    if (this.signWake) return this.signWake('abort');
    if (this.humanWait) return this.humanWait.wake({ kind: 'abort' });
    if (RESTING.has(this.name())) {
      this.stopHandoffTimer();
      this.fire({ t: 'abort' }, null, 'run.aborted');
      return;
    }
    if (this.st.commit) {
      this.fire({ t: 'abort' }, null, 'run.aborted');
      return;
    }
    this.pending = 'abort';
  }

  dispose(): void {
    this.stopHandoffTimer();
  }

  get signTurnOpen(): boolean {
    return this.signWake !== null;
  }

  finishSignTurn(): boolean {
    if (!this.signWake) return false;
    this.signWake('done');
    return true;
  }

  downgrade(): void {
    if (this.gateWake) return this.wakeGate({ kind: 'downgrade' });
    const n = this.name();
    if ((n === 'Running' && !this.st.commit && !this.st.reverify) || n === 'Recovering') {
      this.pending = 'downgrade';
      return;
    }
    this.fire({ t: 'downgrade' }, null, null);
  }

  observedCommit(): void {
    if (this.name() === 'HandedOff') this.fire({ t: 'observed_commit' }, null, null);
  }

  async resume(o: { samePackageDigest?: boolean } = {}): Promise<RunOutcome> {
    const n = this.name();
    if (n === 'HandedOff') {
      this.leaveHandoff();
      const unresolved = this.i.ledgerStates().some((s) => s === 'in_doubt' || s === 'observed_manual') || !!this.i.observedManual?.();
      this.fire({ t: 'handoff_resume', ledgerInDoubt: unresolved }, null, null);
      if (this.name() !== 'Running') return this.result(null, null);
      if (this.st.reverify) return this.reverify(this.i.inDoubtStep?.() ?? null);
      return this.loop(this.resumeAt, null);
    }
    if (n === 'Paused' || n === 'Interrupted') {
      const ev: RunEvent = { t: 'resume', samePackageDigest: o.samePackageDigest ?? true };
      const t = transition(this.st, ev, this.ctx());
      if (!t.ok) return this.result(null, t.code);
      this.apply(ev, t.state, t.effects, null, null);
      if (this.name() !== 'Running') return this.result(null, null);
      return this.loop(this.resumeAt, null);
    }
    return this.result(null, 'engine.illegal_transition');
  }

  async attestManualCommit(): Promise<RunOutcome> {
    if (this.name() !== 'HandedOff') return this.result(null, 'engine.illegal_transition');
    this.leaveHandoff();
    const x = this.i.inDoubtStep?.() ?? this.soleX;
    this.fire({ t: 'attest_manual_commit' }, x, null);
    if (this.name() !== 'Running' || !this.st.reverify) return this.result(null, null);
    return this.reverify(x);
  }

  private name(): RunStateName {
    return this.st.name;
  }

  private async loop(from: string | null, prev: string | null): Promise<RunOutcome> {
    let cur = from;
    let last = prev;
    for (;;) {
      const s = await this.interp.run(cur, last);
      const next = await this.onStop(s);
      if (!next) return this.settle(s);
      cur = next.from;
      last = next.prev;
    }
  }

  private async onStop(s: RunStop): Promise<{ from: string; prev: string | null } | null> {
    switch (s.t) {
      case 'end':
        if (s.status === 'success') this.fire({ t: 'all_done' }, s.at, null);
        else if (s.status === 'completed_with_issues') this.fire({ t: 'end_with_issues' }, s.at, null);
        else this.fail(s.at, null);
        return null;
      case 'abort':
        if (s.code && CONTROL_STOPS.get(s.code) === 'abort') return null;
        if (s.code === 'run.stopped' && this.pending === 'abort') {
          this.pending = null;
          this.fire({ t: 'abort' }, s.at, 'run.aborted');
          return null;
        }
        this.fail(s.at, s.code ?? 'run.step_abort');
        return null;
      case 'handoff': {
        const code = s.code ?? this.handoffCode;
        const resumeAt = this.handoffResumeAt ?? s.resumeAt;
        this.handoffCode = null;
        this.handoffResumeAt = null;
        this.handoff(s.at, resumeAt, code);
        return null;
      }
      case 'recover': {
        if (!this.fire({ t: 'step_failed' }, s.at, s.code)) return null;
        const ok = this.i.recover ? await this.i.recover(s).catch(() => false) : false;
        if (this.takePending(s.at)) return null;
        if (!ok) {
          this.toHandoff(s.at, s.at, s.code);
          return null;
        }
        this.fire({ t: 'recovered' }, s.at, null);
        return this.name() === 'Running' ? { from: ok === true ? s.at : ok.from, prev: null } : null;
      }
      case 'human_secret': {
        if (!this.fire({ t: 'human_reached' }, s.at, s.code)) return null;
        const r = await this.i.human.secret({ runId: this.i.runId, stepId: s.at, ttlMs: this.i.secretTtlMs ?? 120_000 }).catch(() => 'ttl' as const);
        if (this.pending === 'abort') {
          this.abortInTurn(s.at);
          return null;
        }
        if (r !== 'done') {
          this.ttl(s.at, r === 'ttl' ? undefined : r.code);
          return null;
        }
        this.fire({ t: 'human_input' }, s.at, null);
        return this.name() === 'Running' ? { from: s.next, prev: s.at } : null;
      }
      case 'unhandled':
        this.fail(s.at, 'engine.unhandled_step');
        return null;
      case 'falloff':
        this.fail(s.at, 'engine.falloff');
        return null;
    }
  }

  private handoff(at: string, resumeAt: string, code: string | null): void {
    if (this.name() !== 'Running') return;
    this.fire({ t: 'step_failed' }, at, code);
    this.toHandoff(at, resumeAt, code);
  }

  private toHandoff(at: string, resumeAt: string, code: string | null): void {
    if (this.name() !== 'Recovering') return;
    this.resumeAt = resumeAt;
    this.fire({ t: 'recovery_failed', then: 'handoff' }, at, code);
    this.handedOff(at);
  }

  private handedOff(at: string): void {
    if (this.name() !== 'HandedOff') return;
    this.i.guardMode?.('observing');
    this.cancelHandoffTimer = this.timers.after(this.i.handoffTimeoutMs ?? 30 * 60_000, () => {
      this.cancelHandoffTimer = null;
      if (this.name() !== 'HandedOff') return;
      this.i.guardMode?.('running');
      this.fire({ t: 'handoff_timeout' }, at, 'run.handoff_timeout');
    });
  }

  private leaveHandoff(): void {
    this.stopHandoffTimer();
    this.i.guardMode?.('running');
  }

  private stopHandoffTimer(): void {
    this.cancelHandoffTimer?.();
    this.cancelHandoffTimer = null;
  }

  private fail(at: string, code: string | null): void {
    if (this.name() === 'Running') this.fire({ t: 'step_failed' }, at, code);
    if (this.name() === 'Recovering') this.fire({ t: 'recovery_failed', then: 'fail' }, at, code);
  }

  private takePending(at: string): boolean {
    const p = this.pending;
    if (!p) return false;
    this.pending = null;
    if (p === 'abort') this.fire({ t: 'abort' }, at, 'run.aborted');
    else {
      this.resumeAt = this.lastCp ?? at;
      this.fire({ t: 'downgrade' }, at, null);
    }
    return true;
  }

  private settle(s: RunStop): RunOutcome {
    if (this.pending === 'abort' && RESTING.has(this.name())) {
      this.pending = null;
      this.stopHandoffTimer();
      this.fire({ t: 'abort' }, s.at, 'run.aborted');
    }
    if (this.pending && this.name() !== 'Running') this.pending = null;
    return this.result(s.at, this.stateCode ?? ('code' in s ? s.code : null));
  }

  private async reverify(x: string | null): Promise<RunOutcome> {
    const r: VerifyResult = x && this.i.verify ? await this.i.verify(x).catch(() => 'unknown' as const) : 'unknown';
    this.i.journal('verify.after_handoff', { ...(x ? { stepId: x } : {}), result: r });
    this.fire({ t: 'verify', result: r }, x, r === 'unknown' ? 'verify.unknown' : null);
    if (this.name() !== 'Running' || !x) return this.result(x, null);
    if (r === 'committed') {
      const info = this.info.get(x);
      const next = info?.next ?? info?.repeats.at(-1) ?? null;
      return this.loop(next, x);
    }
    const g = this.gateOf.get(x);
    return this.loop((g && this.staticPreGate.get(g)) ?? g ?? x, null);
  }

  private readonly beforeStep = async (s: Step): Promise<void | ActResult> => {
    const p = await this.i.beforeStep?.(s);
    if (p && !p.ok) return p;
    if (this.pending === 'abort') return { ok: false, code: 'run.stopped' };
    if (this.pending === 'downgrade') {
      this.pending = null;
      this.resumeAt = this.lastCp ?? s.id;
      this.fire({ t: 'downgrade' }, s.id, null);
      if (this.name() !== 'Running') return { ok: false, code: 'run.state_stop' };
    }
    return undefined;
  };

  private readonly checkpointStep: Handler<'checkpoint'> = async (cp) => {
    if (!this.visitedCp.has(cp.id)) {
      let r = await evalCond(cp.expect, this.i.env);
      if (!r.ok) return fail(r.code);
      if (!r.value && cp.url && this.i.ir.steps[0]?.id === cp.id) {
        try {
          await this.i.reentry.navigate(cp.url);
        } catch {
          return fail('step.assert_failed');
        }
        r = await this.expectSettled(cp);
        if (!r.ok) return fail(r.code);
      }
      if (!r.value) return fail('step.assert_failed');
      this.visitedCp.add(cp.id);
      this.lastCp = cp.id;
      return NEXT;
    }
    const expect = async () => this.expectSettled(cp).then((r) => r.ok && r.value, () => false);
    const outcome = await reenterCheckpoint(cp, { expect, navigate: this.i.reentry.navigate, loggedIn: this.i.reentry.loggedIn }, { discardAll: (t) => this.discard(t) });
    this.i.journal('checkpoint.reentry', { stepId: cp.id, outcome });
    if (outcome === 'resumed') {
      this.lastCp = cp.id;
      return NEXT;
    }
    if (outcome === 'escalate_session') {
      const session = [...this.info.values()].find((v) => v.step.type === 'checkpoint' && v.step.name === 'session')?.step.id;
      if (session && session !== cp.id) {
        this.visitedCp.add(session);
        return { t: 'jump', to: session };
      }
    }
    return this.handoffWith('portal.unexpected_page');
  };

  private async expectSettled(cp: StepOf<'checkpoint'>): Promise<{ ok: true; value: boolean } | { ok: false; code: string }> {
    const env = this.i.env;
    const deadline = this.i.clock.now() + (cp.timeoutMs ?? CHECKPOINT_SETTLE_MS);
    for (;;) {
      const r = await evalCond(cp.expect, env);
      if (!r.ok || r.value || this.i.clock.now() >= deadline || this.pending === 'abort') return r;
      await env.clock.sleep(Math.min(env.pollMs, Math.max(0, deadline - this.i.clock.now())));
    }
  }

  private handoffWith(code: string): Outcome {
    this.handoffCode = code;
    return { t: 'jump', to: 'handoff' };
  }

  private readonly gateStep: Handler<'gate'> = async (g) => {
    const x = this.primaryOf.get(g.id);
    const card = x && GATE_CARDS.has(g.card) ? this.i.card(g) : null;
    if (!x || !card) return fail('gate.unavailable');
    const pre = this.i.preGate ? await this.i.preGate(g) : { ok: true as const };
    if (!pre.ok) return fail(pre.code);
    const req = buildGateRequest({ runId: this.i.runId, gateStepId: g.id, card: g.card, readback: card.readback, reserved: card.reserved, packageDigest: this.i.packageDigest, authorizes: g.authorizes, intentId: this.i.intentId, waitMs: g.waitMs ?? 600_000 });
    if (this.i.inputLock && !(await this.i.inputLock(true).catch(() => false))) return fail('gate.unavailable');
    this.preGateCp = this.lastCp ?? this.staticPreGate.get(g.id) ?? null;
    if (!this.fire({ t: 'gate_reached' }, g.id, null)) return fail('run.state_stop');
    this.gateReq = req;
    this.i.gates.open(req.reqId, this.i.runId);
    this.i.gate.publish(req);
    this.i.journal('gate.requested', { stepId: g.id, actionHash: req.actionHash });

    const w = await this.waitGate(req.waitMs);
    const done = (why: GateCloseReason) => {
      this.gateReq = null;
      this.i.gate.closed(req.reqId, why);
    };
    switch (w.kind) {
      case 'answer': {
        const a = w.a;
        if (a.decision === 'approved' && !this.ctx().allowed) {
          this.resumeAt = this.preGateCp ?? g.id;
          this.fire({ t: 'gate_approved' }, g.id, null);
          done('stopped');
          return fail('run.state_stop');
        }
        const d = decideGate(this.i.gates, this.i.tokens, {
          reqId: req.reqId, decision: a.decision, by: a.by, gateStepId: g.id, actionHash: req.actionHash, stepId: x,
          approvedAt: this.i.clock.now(), commitWindowMs: this.i.commitWindowMs, wmaxMs: this.i.wmaxMs(x),
        });
        if (!d.won) {
          this.i.journal('gate.decision_lost', { stepId: g.id, decision: a.decision });
          return this.gateExpired(g, done);
        }
        this.i.journal(`gate.${d.decision}`, { stepId: g.id, actionHash: req.actionHash, by: a.by });
        if (d.decision === 'denied') {
          this.fire({ t: 'gate_denied' }, g.id, 'gate.denied');
          done('denied');
          return fail('gate.denied');
        }
        if (await this.denyWindowLost()) {
          this.closeGateRow('cancel');
          this.i.journal('gate.withdrawn', { stepId: g.id, cause: 'deny_priority' });
          this.pending = null;
          this.fire({ t: 'abort' }, g.id, 'run.aborted');
          done('stopped');
          return fail('run.aborted');
        }
        this.fire({ t: 'gate_approved' }, g.id, null);
        this.tokensByGate.set(g.id, { token: d.token, reqId: req.reqId });
        const optional = new Set(this.i.ir.steps.flatMap((x) => (x.type === 'readback' ? (x.optional ?? []) : [])));
        this.approvedReadback.set(g.id, new Map([...this.i.env.scope.readback].filter(([k]) => !optional.has(k))));
        done('approved');
        return NEXT;
      }
      case 'edit': {
        this.fire({ t: 'gate_edit' }, g.id, 'gate.edit_requested');
        done('edit');
        if (this.name() !== 'Running') return fail('run.state_stop');
        const cp = this.preGateCp;
        return cp ? { t: 'jump', to: cp } : this.handoffWith('portal.unexpected_page');
      }
      case 'timeout':
        return this.gateExpired(g, done);
      case 'downgrade':
        this.resumeAt = this.preGateCp ?? g.id;
        this.fire({ t: 'downgrade' }, g.id, null);
        done('stopped');
        return fail('run.state_stop');
      case 'abort':
        this.fire({ t: 'abort' }, g.id, 'run.aborted');
        done('aborted');
        return fail('run.aborted');
    }
  };

  private readonly verifyStep: Handler<'verify'> = async (v) => {
    const j = await this.i.verifyStep!(v).catch((): VerifyJudgement => ({ result: 'unknown' }));
    this.i.journal('verify.result', { stepId: v.id, result: j.result });
    if (this.st.commit) {
      await this.disarm();
      if (!this.fire({ t: 'verify', result: j.result }, v.id, j.result === 'unknown' ? 'verify.unknown' : null)) return fail('run.state_stop');
      if (this.name() !== 'Running') return fail('run.state_stop');
    }
    if (j.result === 'not_committed') {
      const n = (this.notCommitted.get(v.id) ?? 0) + 1;
      this.notCommitted.set(v.id, n);
      if (n > NOT_COMMITTED_RETRIES) {
        this.i.journal('verify.not_committed_repeat', { stepId: v.id, count: String(n) });
        return fail('verify.not_committed_repeat');
      }
    }
    return { t: 'jump', to: v.on[j.result] };
  };

  private readonly savePdfStep: Handler<'save_pdf'> = async (s) => {
    const r = await savePdf({ pdf: this.i.pdf!, runId: this.i.runId, artifacts: this.i.env.scope.artifacts, journal: (t, p) => this.i.journal(t, p) }, s);
    if (r.ok) return NEXT;
    if (this.i.ledgerStates().includes('committed')) {
      this.fire({ t: 'post_commit_failed' }, s.id, r.code);
      return fail('run.state_stop');
    }
    return fail(r.code);
  };

  private readonly refuseIrreversible: Handler<'human_commit' | 'send_email'> = async (s) => {
    this.i.journal('step.irreversible_unguarded', { stepId: s.id, type: s.type });
    return fail('step.irreversible_unguarded');
  };

  private readonly submitStep: Handler<'submit'> = async (s) => {
    const g = this.gateOf.get(s.id);
    const held = g ? this.tokensByGate.get(g) : undefined;
    const approved = g ? this.approvedReadback.get(g) : undefined;
    if (!this.i.commit || !g || !held || !approved) {
      this.i.journal('step.irreversible_unguarded', { stepId: s.id, type: s.type, ...(this.i.commit ? {} : { cause: 'no_commit_port' }) });
      return fail('step.irreversible_unguarded');
    }
    if (this.i.beforeCommit) {
      const pre = await this.i.beforeCommit(s.id).catch((): ActResult => ({ ok: false, code: 'commit.precheck_failed' }));
      if (!pre.ok) {
        this.tokensByGate.delete(g);
        this.approvedReadback.delete(g);
        this.i.journal('submit.not_entered', { stepId: s.id, cause: pre.code });
        this.handoffResumeAt = this.preGateCp ?? this.staticPreGate.get(g) ?? g;
        return fail(pre.code);
      }
    }
    this.tokensByGate.delete(g);
    const rej = this.i.tokens.consume(held.token, { gateStepId: g, actionHash: held.token.actionHash, stepId: s.id }, this.i.clock.now());
    if (rej) {
      this.i.journal(SECURITY_REJECTIONS.has(rej) ? 'security.gate_token_rejected' : 'gate.token_rejected', { stepId: s.id, reason: rej, ...(SECURITY_REJECTIONS.has(rej) ? { security: true } : {}) });
      return fail('gate.token_invalid');
    }
    const armed = await Promise.resolve()
      .then(() => this.i.commit!.arm({ stepId: s.id, reqId: held.reqId, actionHash: held.token.actionHash }))
      .catch((): ActResult => ({ ok: false, code: 'ledger.error' }));
    if (!armed.ok) {
      this.i.journal('ledger.arm_failed', { stepId: s.id, cause: armed.code });
      return fail('ledger.arm_failed');
    }
    this.i.journal('ledger.armed', { stepId: s.id, reqId: held.reqId });
    if (!this.fire({ t: 'enter_commit' }, s.id, null)) return fail('run.state_stop');
    try {
      return await this.commitSection(s, g, held.token, approved);
    } catch {
      this.armedKey = null;
      this.fire({ t: 'step_failed' }, s.id, 'step.port_error');
      return { t: 'jump', to: s.verify };
    }
  };

  private async commitSection(s: StepOf<'submit'>, g: string, token: GateToken, approved: ReadonlyMap<string, string>): Promise<Outcome> {
    const env = this.i.env;
    this.confirmClicked = false;
    this.signClicked.clear();
    this.armedExp = token.exp;
    for (const [f, v] of approved) {
      const r = await readField(env.page, env.dict, f).catch(() => null);
      if (!r?.ok || r.value !== v) {
        this.i.journal('step.pre_dispatch_mismatch', { stepId: s.id });
        this.fire({ t: 'pre_dispatch_mismatch' }, s.id, 'step.pre_dispatch_mismatch');
        await this.disarm();
        if (this.name() !== 'Running') return fail('run.state_stop');
        const cp = this.preGateCp;
        return cp ? { t: 'jump', to: cp } : this.handoffWith('portal.unexpected_page');
      }
    }
    const ga = await this.i.commit!.armGuard({ stepId: s.id, armedUntil: token.exp }).catch((): ActResult => ({ ok: false, code: 'commit_guard.arm_refused' }));
    if (!ga.ok) return this.notSent(s, g, ga.code);
    this.guardArmed = true;
    const t = await waitTarget(env, s.target, s.timeoutMs ?? env.defaultTimeoutMs, { allowCommit: true });
    if (!t.ok) return this.notSent(s, g, t.code);
    const v = verifyOfIrreversible(this.i.ir, s.id);
    const failBefore = v ? await failSignalKeys(env.page, v.failSignals ?? []).catch(() => new Set<string>()) : new Set<string>();
    this.armedKey = s.target;
    this.armedConfirmRe = s.expectConfirm ? stringRe(env.strings[s.expectConfirm]) : null;
    const c = await env.act.click(t.t);
    if (!c.ok && CLICK_NOT_SENT.has(c.code)) return this.notSent(s, g, c.code);
    this.fire({ t: 'click_returned' }, s.id, null);
    if (v) this.i.verifyBook?.markDispatched(v.id, this.i.clock.now(), failBefore);
    this.dispatchMark = v ? { verifyId: v.id, failBefore } : null;
    if (!c.ok) this.i.journal('step.dispatch_error', { stepId: s.id, cause: c.code });
    else if (s.signFlow) await this.signFlow(s, s.signFlow);
    this.armedKey = null;
    return { t: 'jump', to: s.verify };
  }

  private async signFlow(s: StepOf<'submit'>, f: NonNullable<StepOf<'submit'>['signFlow']>): Promise<void> {
    const env = this.i.env;
    const deadline = this.i.clock.now() + f.maxWaitMs;
    const left = () => Math.max(0, deadline - this.i.clock.now());
    const m: unknown = f.method === '$profile.signMethod' ? env.scope.profile.signMethod : f.method;
    const method = typeof m === 'string' && Object.hasOwn(SIGN_ACTION, m) ? m : null;
    const head = await this.signOpen(s, f, method, left);
    if (head === 'verify') return;
    if (head === 'human') return void (await this.signTurnWait(s, f, 'secret'));
    const actions = method === null ? null : f.steps ? f.steps[method as keyof typeof f.steps] : [];
    if (!actions) return this.i.journal('signflow.method_unknown', { stepId: s.id });
    const readyKey = f.readyTarget;
    const ready = readyKey ? (await waitTarget(env, readyKey, Math.min(left(), SIGN_READY_WAIT_MS))).ok : false;
    if (readyKey && !ready) this.i.journal('signflow.ready_missing', { stepId: s.id });
    if (f.certPick && method === 'cert') {
      const p = await pickRow(env, f.certPick.target, { by: f.certPick.by }, Math.min(left(), SIGN_READY_WAIT_MS));
      if (!p.ok) {
        this.i.journal('signflow.cert_pick_missing', { stepId: s.id, code: p.code });
        return void (await this.signTurnWait(s, f, 'secret'));
      }
    }
    let doneSeen = false;
    for (const a of actions) {
      if (a === 'human:secret') {
        const r = await this.i.human.secret({ runId: this.i.runId, stepId: s.id, ttlMs: left() }).catch(() => 'ttl' as const);
        if (r !== 'done') {
          this.i.journal('signflow.timeout', { stepId: s.id, action: a });
          return void (await this.signTurnWait(s, f, 'secret'));
        }
      } else if (a === 'wait:push') {
        const ok = f.confirmTarget ? (await waitTarget(env, f.confirmTarget, left(), { allowCommit: true })).ok : f.doneTarget ? (doneSeen = (await waitTarget(env, f.doneTarget, left())).ok) : await env.page.waitNavigation(left());
        if (!ok) {
          this.i.journal('signflow.timeout', { stepId: s.id, action: a });
          return void (await this.signTurnWait(s, f, 'push'));
        }
      } else {
        return this.i.journal('signflow.unsupported', { stepId: s.id, action: a });
      }
    }
    if (!f.confirmTarget) {
      if (f.doneTarget && !doneSeen && (await this.signDoneWait(s, f, ready, left)) === 'timeout') await this.signTurnWait(s, f, 'secret');
      return;
    }
    const t = await waitTarget(env, f.confirmTarget, actions.length > 0 ? Math.min(left(), CONFIRM_GRACE_MS) : left(), { allowCommit: true });
    if (!t.ok) return this.i.journal('signflow.confirm_missing', { stepId: s.id, code: t.code });
    await this.clickConfirm(s, f.confirmTarget, t.t);
    if (actions.includes('human:secret')) await this.signWrongRetry(s, f, left);
  }

  private async signWrongRetry(s: StepOf<'submit'>, f: NonNullable<StepOf<'submit'>['signFlow']>, left: () => number): Promise<void> {
    const check = this.i.human.afterSignConfirm?.bind(this.i.human);
    if (!check || !f.confirmTarget) return;
    for (;;) {
      if ((await check({ runId: this.i.runId, stepId: s.id }).catch(() => 'ok' as const)) === 'ok') return;
      this.i.journal('signflow.password_wrong', { stepId: s.id });
      const r = await this.i.human.secret({ runId: this.i.runId, stepId: s.id, ttlMs: left() }).catch(() => 'ttl' as const);
      if (r !== 'done') {
        this.i.journal('signflow.timeout', { stepId: s.id, action: 'human:secret' });
        return void (await this.signTurnWait(s, f, 'secret'));
      }
      const t = await waitTarget(this.i.env, f.confirmTarget, Math.min(left(), CONFIRM_GRACE_MS), { allowCommit: true });
      if (!t.ok) return this.i.journal('signflow.confirm_missing', { stepId: s.id, code: t.code });
      this.confirmClicked = false;
      this.i.journal('signflow.confirm_retry', { stepId: s.id });
      await this.clickConfirm(s, f.confirmTarget, t.t);
    }
  }

  private async signOpen(s: StepOf<'submit'>, f: NonNullable<StepOf<'submit'>['signFlow']>, method: string | null, left: () => number): Promise<'ok' | 'verify' | 'human'> {
    for (const k of f.openTargets ?? []) {
      const r = await this.clickSignOnce(s, k, left());
      if (r !== 'clicked' && r !== 'already') {
        this.i.journal('signflow.open_missing', { stepId: s.id, target: k, code: r });
        return 'verify';
      }
    }
    if (!f.methodTargets) return 'ok';
    const k = method !== null && Object.hasOwn(f.methodTargets, method) ? f.methodTargets[method as SignMethod] : undefined;
    if (!k) {
      this.i.journal('signflow.method_choice_missing', { stepId: s.id });
      return 'human';
    }
    const r = await this.clickSignOnce(s, k, Math.min(left(), SIGN_READY_WAIT_MS));
    if (r === 'clicked' || r === 'already') return 'ok';
    this.i.journal('signflow.method_choice_missing', { stepId: s.id, target: k, code: r });
    return 'human';
  }

  private async clickSignOnce(s: StepOf<'submit'>, key: string, waitMs: number): Promise<string> {
    if (this.signClicked.has(key)) return 'already';
    const t = await waitTarget(this.i.env, key, waitMs, { allowCommit: true });
    if (!t.ok) return t.code;
    this.signClicked.add(key);
    this.armedKey = key;
    const c = await this.i.env.act.click(t.t);
    if (!c.ok) {
      this.i.journal('signflow.open_failed', { stepId: s.id, target: key, code: c.code });
      return c.code;
    }
    return 'clicked';
  }

  private async signDoneWait(s: StepOf<'submit'>, f: NonNullable<StepOf<'submit'>['signFlow']>, readySeen: boolean, left: () => number): Promise<'done' | 'cancelled' | 'stopped' | 'timeout'> {
    const env = this.i.env;
    let goneAt: number | null = null;
    for (;;) {
      if ((await waitTarget(env, f.doneTarget!, 0)).ok) {
        this.i.journal('signflow.done_seen', { stepId: s.id });
        return 'done';
      }
      if (env.stopRequested?.() || this.pending === 'abort') return 'stopped';
      if (readySeen && f.readyTarget) {
        const up = (await waitTarget(env, f.readyTarget, 0)).ok;
        if (up) goneAt = null;
        else {
          goneAt ??= this.i.clock.now();
          if (this.i.clock.now() - goneAt >= SIGN_CANCEL_GRACE_MS) {
            this.i.journal('signflow.window_closed', { stepId: s.id });
            return 'cancelled';
          }
        }
      }
      if (left() <= 0) return 'timeout';
      await env.clock.sleep(Math.min(env.pollMs, left()));
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  private async clickConfirm(s: StepOf<'submit'>, key: string, t: Resolved): Promise<void> {
    if (this.confirmClicked) return this.i.journal('signflow.confirm_once', { stepId: s.id });
    if (this.i.clock.now() > this.armedExp) return this.i.journal('signflow.confirm_expired', { stepId: s.id });
    this.confirmClicked = true;
    this.armedKey = key;
    const c = await this.i.env.act.click(t);
    if (!c.ok) this.i.journal('signflow.confirm_failed', { stepId: s.id, code: c.code });
  }

  private async signTurnWait(s: StepOf<'submit'>, f: NonNullable<StepOf<'submit'>['signFlow']>, kind: 'push' | 'secret'): Promise<SignTurnEnd> {
    const env = this.i.env;
    let woke: Exclude<SignTurnEnd, 'clicked'> | null = null;
    let wakeUp: () => void = () => {};
    const woken = new Promise<void>((r) => (wakeUp = r));
    const wake = (w: Exclude<SignTurnEnd, 'clicked'>) => {
      if (woke) return;
      woke = w;
      this.signWake = null;
      wakeUp();
    };
    const cancel = this.timers.after(Math.max(0, this.i.signTurnMs?.() ?? SIGN_TURN_MS), () => wake('cap'));
    this.signWake = wake;
    this.i.journal('sign.turn_opened', { stepId: s.id, kind });
    this.i.signTurn?.opened({ runId: this.i.runId, stepId: s.id, kind });
    let clicked = false;
    let doneSeen = false;
    const done = f.doneTarget && env.dict.entries[f.doneTarget] ? f.doneTarget : null;
    const confirm = kind === 'push' && f.confirmTarget && !this.confirmClicked ? f.confirmTarget : null;
    try {
      while (!woke) {
        const canClick = confirm !== null && this.i.clock.now() <= this.armedExp;
        if (!canClick && !done) {
          await woken;
          break;
        }
        if (done && (await waitTarget(env, done, 0, { allowCommit: true })).ok) {
          if (woke) break;
          this.signWake = null;
          doneSeen = true;
          break;
        }
        if (canClick) {
          const t = await waitTarget(env, confirm, 0, { allowCommit: true });
          if (woke) break;
          if (t.ok) {
            this.signWake = null;
            clicked = true;
            await this.clickConfirm(s, confirm, t.t);
            break;
          }
        }
        await Promise.race([env.clock.sleep(env.pollMs), woken]);
        await new Promise<void>((r) => setImmediate(r));
      }
    } finally {
      cancel();
      this.signWake = null;
    }
    const why: SignTurnEnd = clicked ? 'clicked' : doneSeen ? 'done_seen' : (woke ?? 'cap');
    if (this.dispatchMark) this.i.verifyBook?.markDispatched(this.dispatchMark.verifyId, this.i.clock.now(), this.dispatchMark.failBefore);
    this.i.journal('sign.turn_closed', { stepId: s.id, why });
    this.i.signTurn?.closed({ runId: this.i.runId, stepId: s.id, why });
    return why;
  }

  private async notSent(s: StepOf<'submit'>, g: string, code: string): Promise<Outcome> {
    this.armedKey = null;
    this.i.journal('submit.not_sent', { stepId: s.id, cause: code });
    await this.disarm();
    this.resumeAt = this.preGateCp ?? this.staticPreGate.get(g) ?? g;
    this.fire({ t: 'identity_mismatch' }, s.id, 'step.identity_mismatch');
    this.handedOff(s.id);
    return fail('run.state_stop');
  }

  private async disarm(): Promise<void> {
    this.armedKey = null;
    this.armedConfirmRe = null;
    if (!this.guardArmed) return;
    this.guardArmed = false;
    await this.i.commit?.disarmGuard().catch(() => {});
  }

  private async denyWindowLost(): Promise<boolean> {
    const ms = this.i.denyPriorityMs ?? GATE_DENY_PRIORITY_MS;
    const until = this.i.clock.now() + ms;
    while (this.pending !== 'abort' && this.i.clock.now() < until) await this.i.clock.sleep(Math.min(50, until - this.i.clock.now()));
    return this.pending === 'abort';
  }

  private gateExpired(g: StepOf<'gate'>, done: (why: GateCloseReason) => void): Outcome {
    this.resumeAt = this.preGateCp ?? g.id;
    this.i.journal('gate.expired', { stepId: g.id });
    this.fire({ t: 'gate_timeout' }, g.id, 'gate.expired');
    done('expired');
    return fail('gate.expired');
  }

  private readonly signStep: Handler<'sign'> = async (s) => {
    if (this.st.commit || this.tokensByGate.size > 0) {
      this.i.journal('sign.refused_in_commit', { stepId: s.id, consumed: this.st.commit });
      if (!this.st.commit) return fail('sign.refused_in_commit');
      await this.disarm();
      this.fire({ t: 'verify_timeout' }, s.id, 'sign.refused_in_commit');
      return fail('run.state_stop');
    }
    const m: unknown = s.method === '$profile.signMethod' ? this.i.env.scope.profile.signMethod : s.method;
    const method = typeof m === 'string' && Object.hasOwn(SIGN_ACTION, m) ? m : null;
    const need = method === null ? undefined : SIGN_ACTION[method];
    if (method === null || need === undefined) {
      this.i.journal('sign.method_unknown', { stepId: s.id });
      return fail('sign.method_unknown');
    }
    this.i.journal('sign.started', { stepId: s.id, method });
    if (need === null) return NEXT;
    if (!(s.then ?? []).includes(need)) {
      this.i.journal('sign.no_path', { stepId: s.id, method });
      return fail('sign.no_path');
    }
    if (!this.fire({ t: 'human_reached' }, s.id, null)) return fail('run.state_stop');
    return this.secretTurn(s.id, { ttlMs: this.i.secretTtlMs ?? 120_000 });
  };

  private async secretTurn(at: string, r: { target?: string; prompt?: string; ttlMs: number }, onFailThen?: string): Promise<Outcome> {
    const out = await this.i.human.secret({ runId: this.i.runId, stepId: at, ...r }).catch(() => 'ttl' as const);
    if (this.pending === 'abort') return this.abortInTurn(at);
    if (out === 'done') return this.afterHuman(at);
    if (out !== 'ttl' && CERT_PW_FAILED.has(out.code) && onFailThen?.startsWith('checkpoint:')) {
      this.i.journal('human.secret_fallback', { stepId: at, code: out.code });
      const n = this.afterHuman(at);
      return n.t === 'fail' ? n : fail(out.code);
    }
    return this.ttl(at, out === 'ttl' ? undefined : out.code);
  }

  private readonly humanStep: Handler<'human'> = async (h) => {
    if (h.kind === 'captcha') {
      this.handoffResumeAt = this.lastCp;
      return this.handoffWith('portal.captcha');
    }
    if (!this.fire({ t: 'human_reached' }, h.id, null)) return fail('run.state_stop');
    if (h.kind === 'secret') return this.secretTurn(h.id, { target: h.target, prompt: h.prompt, ttlMs: h.ttlMs }, h.onFail?.then);
    if (h.kind === 'manual') this.i.guardMode?.('observing');
    const reqId = `${this.i.runId}:${h.id}:${this.i.clock.now()}`;
    this.i.human.request({ runId: this.i.runId, stepId: h.id, reqId, kind: h.kind, prompt: h.prompt, region: h.region, ttlMs: h.ttlMs, inputSpec: h.inputSpec });
    this.i.journal('human.requested', { stepId: h.id, kind: h.kind });
    const w = await this.waitHuman(reqId, h);
    if (h.kind === 'manual') this.i.guardMode?.('running');
    if (w.kind === 'abort') {
      this.i.human.closed(reqId, 'aborted');
      return this.abortInTurn(h.id);
    }
    if (w.kind === 'ttl') {
      this.i.human.closed(reqId, 'ttl');
      return this.ttl(h.id);
    }
    this.i.human.closed(reqId, 'answered');
    const value = w.a.value ?? '';
    this.i.journal('human.answered', { stepId: h.id, kind: h.kind, ...(h.kind === 'manual' ? {} : { length: value.length }) });
    const out = this.afterHuman(h.id);
    if (out.t !== 'next' || h.kind === 'manual' || !h.target) return out;
    const t = await waitTarget(this.i.env, h.target, h.timeoutMs ?? this.i.env.defaultTimeoutMs);
    if (!t.ok) return fail(t.code);
    const f = await this.i.env.act.fill(t.t, value, { keyEvents: true });
    return f.ok ? NEXT : fail(f.code);
  };

  private afterHuman(at: string): Outcome {
    if (this.st.pendingDowngrade) this.resumeAt = this.lastCp ?? at;
    this.fire({ t: 'human_input' }, at, null);
    return this.name() === 'Running' ? NEXT : fail('run.state_stop');
  }

  private abortInTurn(at: string): Outcome {
    this.pending = null;
    this.fire({ t: 'abort' }, at, 'run.aborted');
    return fail('run.aborted');
  }

  private ttl(at: string, code = 'human.ttl_expired'): Outcome {
    this.resumeAt = this.lastCp ?? at;
    this.fire({ t: 'human_ttl' }, at, code);
    return fail('human.ttl_expired');
  }

  private wakeGate(w: GateWait): void {
    const f = this.gateWake;
    this.gateWake = null;
    f?.(w);
  }

  private waitGate(ms: number): Promise<GateWait> {
    return new Promise<GateWait>((resolve) => {
      const cancel = this.timers.after(ms, () => this.wakeGate({ kind: 'timeout' }));
      this.gateWake = (w) => {
        cancel();
        resolve(w);
      };
    });
  }

  private waitHuman(reqId: string, step: StepOf<'human'>): Promise<HumanWait> {
    return new Promise<HumanWait>((resolve) => {
      let cancel = () => {};
      const wake = (w: HumanWait) => {
        if (this.humanWait?.reqId !== reqId) return;
        this.humanWait = null;
        cancel();
        resolve(w);
      };
      this.humanWait = { reqId, step, wake };
      cancel = this.timers.after(step.ttlMs, () => wake({ kind: 'ttl' }));
    });
  }

  private ctx(ev?: RunEvent): MachineCtx {
    let ledger = this.i.ledgerStates();
    if (ev?.t === 'attest_manual_commit') ledger = [...ledger, 'observed_manual'];
    const result = ev?.t === 'verify' || ev?.t === 'indoubt_resolved' ? ev.result : 'unknown';
    if (result !== 'unknown') {
      const x = ledger.findIndex((s) => UNRESOLVED_LEDGER.has(s));
      if (x >= 0) ledger = ledger.map((s, j) => (j === x ? result : s));
    }
    return { allowed: this.i.allowed?.() ?? true, ledger, hardStop: this.i.hardStop?.() ?? false };
  }

  private fire(ev: RunEvent, at: string | null, code: string | null): boolean {
    const t = transition(this.st, ev, this.ctx(ev));
    if (!t.ok) {
      this.i.journal('engine.illegal_transition', { from: this.st.name, event: ev.t });
      return false;
    }
    this.apply(ev, t.state, t.effects, at, code);
    return true;
  }

  private apply(ev: RunEvent, next: RunState, effects: string[], at: string | null, code: string | null): void {
    const prev = this.st.name;
    this.st = next;
    const ui: string[] = [];
    for (const e of effects) {
      if (e === 'tokens.discard') this.discard(ev.t === 'gate_edit' ? 'gate_edit' : (DISCARD_BY_STATE[next.name] ?? 'checkpoint_return'));
      else if (e === 'input.unlock') void this.i.inputLock?.(false).catch(() => false);
      else if (e === 'gate.cancel' || e === 'gate.expire') this.closeGateRow(e === 'gate.cancel' ? 'cancel' : 'expire');
      else if (e === 'checkpoint.save') this.resumeAt ??= this.lastCp ?? at;
      else if (e.startsWith('journal:')) this.i.journal(e.slice('journal:'.length).replace(/\{.*$/, ''), at ? { stepId: at } : {});
      else if (e.startsWith('security:')) this.i.journal(e.slice('security:'.length), { security: true, ...(at ? { stepId: at } : {}) });
      else if (CONTROLLER_EFFECTS.has(e)) continue;
      else {
        if (e.startsWith('ui.')) ui.push(e);
        this.i.onEffect?.(e, at);
      }
    }
    if (prev !== next.name) {
      this.stateCode = code;
      this.i.journal('run.state', { from: prev, to: next.name, ...(at ? { stepId: at } : {}), ...(code ? { code } : {}) });
      this.i.onState?.({ runId: this.i.runId, state: next.name, prev, at, code, ui });
    }
  }

  private closeGateRow(why: 'cancel' | 'expire'): void {
    const req = this.gateReq;
    if (!req) return;
    if (!this.i.gates.decide(req.reqId, 'expired', why)) this.i.gates.withdraw(req.reqId, why);
  }

  private discard(t: TokenDiscardTrigger): number {
    const n = this.i.tokens.discardAll(t);
    if (n > 0) this.i.journal('gate.tokens_discarded', { trigger: t, count: n });
    this.tokensByGate.clear();
    return n;
  }

  private result(at: string | null, code: string | null): RunOutcome {
    const r: RunOutcome = { state: this.st.name, at, code };
    if ((this.st.name === 'HandedOff' || this.st.name === 'Paused') && this.resumeAt) r.resumeAt = this.resumeAt;
    return r;
  }
}

function inputOk(spec: StepOf<'human'>['inputSpec'], v: string | undefined): boolean {
  if (typeof v !== 'string' || v.length === 0) return false;
  if (spec?.maxLength !== undefined && v.length > spec.maxLength) return false;
  if (!spec?.pattern) return true;
  try {
    return compileRe2(spec.pattern).test(v);
  } catch {
    return false;
  }
}

function stringRe(p: string | undefined): RegExp | null {
  if (typeof p !== 'string') return null;
  try {
    return compileRe2(p);
  } catch {
    return null;
  }
}
