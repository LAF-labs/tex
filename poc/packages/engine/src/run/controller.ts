// 실행 조율(M2-2, D03 §2·§3·§5.5·§8·§11): 실행기(Interpreter)의 멈춤과 사람 차례를 상태 머신(machine.ts)에 잇는다.
// - 상태의 원천은 이 조율기의 RunState 하나다. 전이는 transition()으로만 하고, 돌려받은 부수효과를 그 순서대로 집행한다.
//   조율기가 직접 집행하지 않는 효과(ui.*·chrome.close·slot.release·ledger.* 등)는 onEffect로 넘긴다.
// - 스텝 핸들러 gate·human·checkpoint는 이 조율기에 묶여 있다(사람 차례를 기다리는 동안 실행기는 그 스텝에서 멈춰 있다).
// - 실행기 멈춤(end·abort·handoff·recover·human_secret·unhandled·falloff)은 전이표의 이벤트로 바꾼다.
// - 정지 하향·중지는 다음 스텝 경계(beforeStep)에서 적용한다. 게이트 대기 중이면 곧바로, 사람 차례 중이면 차례가 끝난 뒤(machine).
// - 저널·상태 이벤트에는 코드·스텝 id·해시만 남긴다(⑦). 사람이 입력한 값은 길이만. kind=secret 값은 엔진에 오지 않는다.
import type { GateRepo, LedgerState } from '@sax/db';
import { flatten, type StepInfo } from '../core/cfg.ts';
import { evalCond } from '../core/conds.ts';
import { Interpreter, type InterpHooks, type InterpOptions, type RunStop } from '../core/interp.ts';
import { initialState, transition, type MachineCtx, type RunEvent, type RunState, type RunStateName, type VerifyResult } from '../core/machine.ts';
import type { ActResult, Clock } from '../core/page.ts';
import { compileRe2 } from '../core/re2.ts';
import { decideGate, reenterCheckpoint } from '../core/runtime.ts';
import { waitTarget, type Handler, type Handlers, type Outcome, type StepEnv } from '../core/steps.ts';
import type { GateToken, GateTokens, TokenDiscardTrigger } from '../core/token.ts';
import type { PlaybookIR, Step, StepOf } from '../core/types.ts';
import type { VerifyJudgement } from '../core/verify.ts';
import { buildGateRequest, type GateField, type GateRequest } from '../gate.ts';

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
]);

export type GateAnswer = { reqId: string; decision: 'approved' | 'denied'; by: 'local' | 'remote'; actionHash: string };
export type HumanAnswer = { reqId: string; value?: string };
type ReadbackValues = Parameters<typeof buildGateRequest>[0]['readback'];
export type GateCloseReason = 'approved' | 'denied' | 'edit' | 'expired' | 'aborted' | 'stopped';

export interface GatePort {
  /** 승인 요청 발행(main 승인 바·폰). */
  publish(req: GateRequest): void;
  /** 게이트가 끝났다(바를 내린다). */
  closed(reqId: string, why: GateCloseReason): void;
}

export interface HumanPort {
  /** 사람 입력 요청(captcha·otp·manual). 값은 answerHuman으로 온다. */
  request(r: { runId: string; stepId: string; reqId: string; kind: 'captcha' | 'otp' | 'manual'; prompt: string; region?: string; ttlMs: number; inputSpec?: { pattern?: string; maxLength?: number } }): void;
  /** kind=secret·onFail human:secret: 금고 비밀 창(D05 §3.5). 값은 엔진에 오지 않는다. 닫히면 'done', TTL이면 'ttl'. */
  secret(r: { runId: string; stepId: string; target?: string; prompt?: string; ttlMs: number }): Promise<'done' | 'ttl'>;
  closed(reqId: string, why: 'answered' | 'ttl' | 'aborted'): void;
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
  /** M2-1 기본 핸들러(+ M2-3 비가역). gate·human·checkpoint는 조율기 것으로 덮는다. */
  handlers: Handlers;
  env: StepEnv;
  interp: InterpOptions;
  /** 정책 집행 지점(RunEnforcer.beforeStep). */
  beforeStep?: InterpHooks['beforeStep'];
  stepEvent?: InterpHooks['event'];
  clock: Clock;
  timers?: Timers;
  gates: Pick<GateRepo, 'open' | 'decide' | 'withdraw'>;
  tokens: GateTokens;
  /** 이 실행의 원장 행 상태(정지 분기). */
  ledgerStates: () => readonly LedgerState[];
  /** 원장이 미종결(in_doubt·observed_manual)인 주 비가역 스텝 id(핸드오프 재개 때 그 verify부터). */
  inDoubtStep?: () => string | null;
  /** 실효 수준·killPlaybooks가 이 플레이북 실행을 허용하는가(Running 진입 확인). */
  allowed?: () => boolean;
  /** 정지 하향이 postprocess·kill인가(자동화 Chrome을 닫는다). */
  hardStop?: () => boolean;
  /** 게이트 카드: readback 값 + 예약 키(M2-3 readback이 채운다). null이면 게이트를 열지 않고 핸드오프. */
  card: (g: StepOf<'gate'>) => { readback: ReadbackValues; reserved: GateField[] } | null;
  /** 게이트 진입 전(W 밖) 사전 안전 판정·verify 기준선·$dup.portalExisting(M2-3). 거부면 그 코드로 실패. */
  preGate?: (g: StepOf<'gate'>) => Promise<ActResult>;
  /** 주 비가역 X의 Wmax(token.wmaxMs). */
  wmaxMs: (x: string) => number;
  /** 정책 commitWindowMs. */
  commitWindowMs: number;
  gate: GatePort;
  human: HumanPort;
  /** 포털 탭 입력 잠금(R-G6, 금고 중계). 잠그지 못하면 게이트를 열지 않는다. */
  inputLock?: (on: boolean) => Promise<boolean>;
  /** 커밋 가드 모드(R-C2: HandedOff·WaitingHuman(manual)은 관측만). */
  guardMode?: (m: 'running' | 'observing') => void;
  /** 커밋 가드가 R-C2 관측을 했는가(재개 때 verify 먼저). */
  observedManual?: () => boolean;
  /** 체크포인트 복귀 탐침(reenterCheckpoint). */
  reentry: { navigate(url: string): Promise<void>; loggedIn(): Promise<boolean> };
  /** L1·L2 복구(M2-5). 없거나 false면 핸드오프. */
  recover?: (stop: Extract<RunStop, { t: 'recover' }>) => Promise<boolean>;
  /** 주 비가역 X의 verify(조회만, M2-3). 없으면 unknown(InDoubt). */
  verify?: (x: string) => Promise<VerifyResult>;
  /**
   * verify 스텝 판정(core/verify.ts judgeVerify, D02 §4.4). 커밋 구간이면 결과를 상태 머신에 넣고(원장 기록·입력 잠금 해제는 그 효과),
   * Running으로 남을 때만 on[결과]로 간다. 없으면 verify 스텝은 실행하지 않는다(unhandled).
   */
  verifyStep?: (v: StepOf<'verify'>) => Promise<VerifyJudgement>;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  /** 상태 이벤트(UI·main). ui는 이 전이의 ui.* 효과. */
  onState?: (e: RunStateEvent) => void;
  /** 조율기가 직접 집행하지 않는 효과. */
  onEffect?: (effect: string, at: string | null) => void;
  /** HandedOff 상한(기본 30분). */
  handoffTimeoutMs?: number;
  /** onFail human:secret 비밀 창 TTL(기본 120초). */
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
  /** Paused·HandedOff 재개 지점. */
  resumeAt?: string;
}

type GateWait = { kind: 'answer'; a: GateAnswer } | { kind: 'edit' } | { kind: 'timeout' } | { kind: 'abort' } | { kind: 'downgrade' };
type HumanWait = { kind: 'answer'; a: HumanAnswer } | { kind: 'ttl' } | { kind: 'abort' };

const NEXT: Outcome = { t: 'next' };
const fail = (code: string): Outcome => ({ t: 'fail', code });

/** 전이로 바뀌는 토큰 폐기 사유(D03 §3 R-G3). */
const DISCARD_BY_STATE: Partial<Record<RunStateName, TokenDiscardTrigger>> = { Recovering: 'Recovering', WaitingHuman: 'WaitingHuman', HandedOff: 'HandedOff', Paused: 'Paused', Interrupted: 'Interrupted' };
const RESTING: ReadonlySet<RunStateName> = new Set(['HandedOff', 'Paused', 'Interrupted', 'InDoubt']);

/**
 * 조율기가 핸들러·루프 안에서 직접 하는 일이라 효과로는 건너뛰는 것.
 * (입력 잠금은 게이트를 열기 전에 건다, 토큰 발급은 decideGate, 되감기·재개 지점은 핸들러가 정한다.)
 */
const CONTROLLER_EFFECTS: ReadonlySet<string> = new Set([
  'input.lock', 'token.issue', 'rewind.pre_gate', 'rewind.checkpoint', 'checkpoint.restore', 'resume_at', 'step.rerun_failed',
  'pre_safety_check', 'verify.baseline', 'dup.portal_existing', 'card.from_readback', 'gate.request_publish', 'verify.run',
]);

export class RunController {
  private readonly i: RunControllerInput;
  private readonly timers: Timers;
  private st: RunState = initialState();
  private readonly interp: Interpreter;
  private readonly info: Map<string, StepInfo>;
  /** 게이트 → 주 비가역 X, X → 게이트. */
  private readonly primaryOf = new Map<string, string>();
  private readonly gateOf = new Map<string, string>();
  /** 문서 순서로 게이트 바로 앞의 체크포인트(정적, 재시작·핸드오프 뒤 되감기). */
  private readonly staticPreGate = new Map<string, string>();
  private readonly visitedCp = new Set<string>();
  /** 가장 최근에 지난 체크포인트. */
  private lastCp: string | null = null;
  /** 지금 열린 게이트와 그 앞 체크포인트. */
  private gateReq: GateRequest | null = null;
  private preGateCp: string | null = null;
  private gateWake: ((w: GateWait) => void) | null = null;
  private humanWait: { reqId: string; step: StepOf<'human'>; wake: (w: HumanWait) => void } | null = null;
  private readonly tokensByGate = new Map<string, { token: GateToken; reqId: string }>();
  private pending: 'abort' | 'downgrade' | null = null;
  private resumeAt: string | null = null;
  private cancelHandoffTimer: (() => void) | null = null;
  /** 조율기가 jump:'handoff'로 넘긴 핸드오프의 사유 코드(실행기 handoff 멈춤에는 코드가 없다). */
  private handoffCode: string | null = null;
  /** 마지막 상태 변화의 코드(결과 보고). */
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
    const bound = { ...i.handlers, gate: this.gateStep, human: this.humanStep, checkpoint: this.checkpointStep, ...(i.verifyStep ? { verify: this.verifyStep } : {}) } as Handlers;
    const forcedStops = new Map([...(i.interp.forcedStops ?? []), ...CONTROL_STOPS]);
    this.interp = new Interpreter(i.ir, bound, i.env, { ...i.interp, forcedStops }, { beforeStep: this.beforeStep, event: i.stepEvent });
  }

  get state(): RunState {
    return this.st;
  }

  /** 게이트가 발급한 토큰(M2-3 submit이 R-G7 순서로 쓴다). 폐기되면 없어진다. */
  tokenFor(gateStepId: string): { token: GateToken; reqId: string } | null {
    return this.tokensByGate.get(gateStepId) ?? null;
  }

  // ---------------- 바깥(RunHandle, D03 §11) ----------------

  /** Loaded → Preparing → Running → 실행. 준비(prepare)는 호출자가 마쳤다. */
  async start(o: { intentReuse?: boolean } = {}): Promise<RunOutcome> {
    if (!this.fire({ t: 'load' }, null, null)) return this.result(null, 'engine.illegal_transition');
    const reuse = !!o.intentReuse;
    this.fire({ t: 'start', intentReuse: reuse }, null, reuse ? 'ledger.intent_reuse' : null);
    if (this.name() !== 'Preparing') return this.result(null, reuse ? 'ledger.intent_reuse' : null);
    this.fire({ t: 'prepared' }, null, null);
    if (this.name() !== 'Running') return this.result(null, null);
    return this.loop(this.interp.entry, null);
  }

  /** 승인·거부. 먼저 도착한 결정이 이긴다(R-G8). 지금 요청의 reqId·actionHash와 다르면 받지 않는다. */
  answerGate(a: GateAnswer): { ok: boolean; code?: string } {
    const req = this.gateReq;
    if (!this.gateWake || !req || req.reqId !== a.reqId) return { ok: false, code: 'gate.no_request' };
    if (a.actionHash !== req.actionHash) return { ok: false, code: 'gate.action_mismatch' };
    this.wakeGate({ kind: 'answer', a });
    return { ok: true };
  }

  /** "수정하기"(R-G6): 게이트를 닫고 게이트 앞 체크포인트로. */
  cancelGateForEdit(): boolean {
    if (!this.gateWake) return false;
    this.wakeGate({ kind: 'edit' });
    return true;
  }

  /** 사람 입력. captcha·otp는 값 검사(inputSpec) 뒤 target에 채운다. manual은 값 없이 "다 했음". */
  answerHuman(stepId: string, a: HumanAnswer): { ok: boolean; code?: string } {
    const w = this.humanWait;
    if (!w || w.step.id !== stepId || w.reqId !== a.reqId) return { ok: false, code: 'human.no_request' };
    if (w.step.kind !== 'manual' && !inputOk(w.step.inputSpec, a.value)) return { ok: false, code: 'human.bad_input' };
    w.wake({ kind: 'answer', a });
    return { ok: true };
  }

  /** 중지. 사람 차례면 곧바로 깨운다. 실행 중이면 다음 스텝 경계, 커밋 구간이면 verify 뒤(machine). */
  abort(): void {
    if (this.gateWake) return this.wakeGate({ kind: 'abort' });
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

  /** 정지 하향(ADR-023 결정 5·6). */
  downgrade(): void {
    if (this.gateWake) return this.wakeGate({ kind: 'downgrade' });
    const n = this.name();
    if ((n === 'Running' && !this.st.commit && !this.st.reverify) || n === 'Recovering') {
      this.pending = 'downgrade';
      return;
    }
    // WaitingHuman·HandedOff·커밋 구간은 machine이 미뤄 둔다. 쉬는 상태는 기록만.
    this.fire({ t: 'downgrade' }, null, null);
  }

  /** R-C2: 핸드오프 중 커밋 가드가 커밋 요청을 관측했다(원장 기록은 가드가 했다). */
  observedCommit(): void {
    if (this.name() === 'HandedOff') this.fire({ t: 'observed_commit' }, null, null);
  }

  /** HandedOff·Paused·Interrupted 재개. HandedOff에서 원장이 미종결(또는 R-C2 관측)이면 resumeAt 대신 그 X의 verify부터. */
  async resume(o: { samePackageDigest?: boolean } = {}): Promise<RunOutcome> {
    const n = this.name();
    if (n === 'HandedOff') {
      this.leaveHandoff();
      const unresolved = this.i.ledgerStates().some((s) => s === 'in_doubt' || s === 'observed_manual') || !!this.i.observedManual?.();
      this.fire({ t: 'handoff_resume', ledgerInDoubt: unresolved }, null, null);
      if (this.name() !== 'Running') return this.result(null, null);
      if (this.st.reverify) return this.reverify();
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

  /** "직접 발급함"(HandedOff): 원장 observed_manual(onEffect가 기록) → 그 X의 verify. */
  async attestManualCommit(): Promise<RunOutcome> {
    if (this.name() !== 'HandedOff') return this.result(null, 'engine.illegal_transition');
    this.leaveHandoff();
    this.fire({ t: 'attest_manual_commit' }, null, null);
    if (this.name() !== 'Running' || !this.st.reverify) return this.result(null, null);
    return this.reverify();
  }

  // ---------------- 실행 루프 ----------------

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

  /** 실행기 멈춤 → 전이. 이어서 돌 곳이 있으면 {from, prev}. */
  private async onStop(s: RunStop): Promise<{ from: string; prev: string | null } | null> {
    switch (s.t) {
      case 'end':
        if (s.status === 'success') this.fire({ t: 'all_done' }, s.at, null);
        else if (s.status === 'completed_with_issues') this.fire({ t: 'end_with_issues' }, s.at, null);
        else this.fail(s.at, null);
        return null;
      case 'abort':
        if (s.code && CONTROL_STOPS.get(s.code) === 'abort') return null; // 상태는 조율기가 이미 바꿨다
        if (s.code === 'run.stopped' && this.pending === 'abort') {
          this.pending = null;
          this.fire({ t: 'abort' }, s.at, 'run.aborted');
          return null;
        }
        this.fail(s.at, s.code ?? 'run.step_abort');
        return null;
      case 'handoff': {
        const code = s.code ?? this.handoffCode;
        this.handoffCode = null;
        this.handoff(s.at, s.resumeAt, code);
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
        return this.name() === 'Running' ? { from: s.at, prev: null } : null;
      }
      case 'human_secret': {
        if (!this.fire({ t: 'human_reached' }, s.at, s.code)) return null;
        const r = await this.i.human.secret({ runId: this.i.runId, stepId: s.at, ttlMs: this.i.secretTtlMs ?? 120_000 }).catch(() => 'ttl' as const);
        if (this.pending === 'abort') {
          this.abortInTurn(s.at);
          return null;
        }
        if (r === 'ttl') {
          this.ttl(s.at);
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

  /** 핸드오프 멈춤: Running → Recovering → HandedOff(전이표의 길). 비가역 실패면 resumeAt은 그 verify(실행기). */
  private handoff(at: string, resumeAt: string, code: string | null): void {
    if (this.name() !== 'Running') return;
    this.fire({ t: 'step_failed' }, at, code);
    this.toHandoff(at, resumeAt, code);
  }

  private toHandoff(at: string, resumeAt: string, code: string | null): void {
    if (this.name() !== 'Recovering') return;
    this.resumeAt = resumeAt;
    this.fire({ t: 'recovery_failed', then: 'handoff' }, at, code);
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

  /** 복구 동안 미뤄 둔 중지·하향을 지금 적용한다. 적용했으면 true(실행 멈춤). */
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

  /** 루프가 끝났다. 쉬는 상태로 들어가는 사이에 온 중지는 여기서 적용한다. */
  private settle(s: RunStop): RunOutcome {
    if (this.pending === 'abort' && RESTING.has(this.name())) {
      this.pending = null;
      this.stopHandoffTimer();
      this.fire({ t: 'abort' }, s.at, 'run.aborted');
    }
    if (this.pending && this.name() !== 'Running') this.pending = null;
    return this.result(s.at, this.stateCode ?? ('code' in s ? s.code : null));
  }

  /** 핸드오프 재개·"직접 발급함" 뒤 그 X의 verify(조회만). committed → X 다음(사후 스텝), not_committed → 게이트 앞. */
  private async reverify(): Promise<RunOutcome> {
    const x = this.i.inDoubtStep?.() ?? null;
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

  // ---------------- 핸들러 ----------------

  /** 스텝 경계: 정책 집행(지연·걸쇠) 뒤 미뤄 둔 중지·하향. */
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

  /** 첫 통과는 expect 확인. 다시 오면 복귀 절차(D03 §5.5): 토큰 폐기, reuse·reload, sessionRequired면 session 체크포인트로. */
  private readonly checkpointStep: Handler<'checkpoint'> = async (cp) => {
    if (!this.visitedCp.has(cp.id)) {
      const r = await evalCond(cp.expect, this.i.env);
      if (!r.ok) return fail(r.code);
      if (!r.value) return fail('step.assert_failed');
      this.visitedCp.add(cp.id);
      this.lastCp = cp.id;
      return NEXT;
    }
    const expect = async () => evalCond(cp.expect, this.i.env).then((r) => r.ok && r.value, () => false);
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

  /** 핸드오프로 멈춘다(재개 지점 = 이 스텝). 사유 코드는 D16 기존 코드라 FORCED_STOPS에 넣지 않고 따로 넘긴다. */
  private handoffWith(code: string): Outcome {
    this.handoffCode = code;
    return { t: 'jump', to: 'handoff' };
  }

  private readonly gateStep: Handler<'gate'> = async (g) => {
    const x = this.primaryOf.get(g.id);
    const card = x ? this.i.card(g) : null;
    if (!x || !card) return fail('gate.unavailable');
    // 진입 전(W 밖): 사전 안전 판정·기준선
    const pre = this.i.preGate ? await this.i.preGate(g) : { ok: true as const };
    if (!pre.ok) return fail(pre.code);
    const req = buildGateRequest({ runId: this.i.runId, gateStepId: g.id, readback: card.readback, reserved: card.reserved, packageDigest: this.i.packageDigest, authorizes: g.authorizes, intentId: this.i.intentId, waitMs: g.waitMs ?? 600_000 });
    // 입력 잠금(R-G6)을 먼저 건다. 걸리지 않으면 게이트를 열지 않는다.
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
          // Running 진입 확인에 걸린다: 토큰을 만들지 않고 게이트를 닫는다(gate.cancel → 정지 분기).
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
          // 게이트 행이 이미 open이 아니다(재시작 만료 등). 결정은 무효이고 만료처럼 쉰다.
          this.i.journal('gate.decision_lost', { stepId: g.id, decision: a.decision });
          return this.gateExpired(g, done);
        }
        this.i.journal(`gate.${d.decision}`, { stepId: g.id, actionHash: req.actionHash, by: a.by });
        if (d.decision === 'denied') {
          this.fire({ t: 'gate_denied' }, g.id, 'gate.denied');
          done('denied');
          return fail('gate.denied');
        }
        this.fire({ t: 'gate_approved' }, g.id, null);
        this.tokensByGate.set(g.id, { token: d.token, reqId: req.reqId });
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

  /**
   * verify(D02 §4.4, D03 §5.3·§5.6): 판정은 조회만이다. 커밋 구간(토큰 소비 ~ verify 완료)이면 결과로 구간을 나간다:
   * committed → 원장 committed{verify_ref}·사후 스텝, not_committed → 원장 not_committed·게이트 앞, unknown → InDoubt(멈춤).
   * 구간 안에서 온 중지·하향은 machine이 이때 적용한다. 구간 밖(사후 부수효과 확인, 예: 메일 발송)은 on[결과]로만 간다.
   */
  private readonly verifyStep: Handler<'verify'> = async (v) => {
    const j = await this.i.verifyStep!(v).catch((): VerifyJudgement => ({ result: 'unknown' }));
    this.i.journal('verify.result', { stepId: v.id, result: j.result });
    if (this.st.commit) {
      if (!this.fire({ t: 'verify', result: j.result }, v.id, j.result === 'unknown' ? 'verify.unknown' : null)) return fail('run.state_stop');
      if (this.name() !== 'Running') return fail('run.state_stop');
    }
    return { t: 'jump', to: v.on[j.result] };
  };

  /** waitMs 초과: Paused, 재개하면 게이트 앞 체크포인트부터(재게이트). */
  private gateExpired(g: StepOf<'gate'>, done: (why: GateCloseReason) => void): Outcome {
    this.resumeAt = this.preGateCp ?? g.id;
    this.fire({ t: 'gate_timeout' }, g.id, 'gate.expired');
    done('expired');
    return fail('gate.expired');
  }

  private readonly humanStep: Handler<'human'> = async (h) => {
    if (!this.fire({ t: 'human_reached' }, h.id, null)) return fail('run.state_stop');
    if (h.kind === 'secret') {
      // 값은 금고 비밀 창이 포털 칸에 직접 넣는다(D05 §3.5). 엔진은 끝났는지만 안다.
      const r = await this.i.human.secret({ runId: this.i.runId, stepId: h.id, target: h.target, prompt: h.prompt, ttlMs: h.ttlMs }).catch(() => 'ttl' as const);
      if (this.pending === 'abort') return this.abortInTurn(h.id);
      return r === 'ttl' ? this.ttl(h.id) : this.afterHuman(h.id);
    }
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
    // Running으로 돌아온 뒤에 채운다(미뤄 둔 하향으로 멈췄으면 채우지 않는다).
    const t = await waitTarget(this.i.env, h.target, h.timeoutMs ?? this.i.env.defaultTimeoutMs);
    if (!t.ok) return fail(t.code);
    const f = await this.i.env.act.fill(t.t, value, { keyEvents: true });
    return f.ok ? NEXT : fail(f.code);
  };

  /** 사람 차례 끝 → Running 진입 확인(미뤄 둔 하향이면 정지 분기, 재개는 마지막 체크포인트부터). */
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

  /** 사람 TTL: Paused, 재개하면 마지막 체크포인트부터. */
  private ttl(at: string): Outcome {
    this.resumeAt = this.lastCp ?? at;
    this.fire({ t: 'human_ttl' }, at, 'human.ttl_expired');
    return fail('human.ttl_expired');
  }

  // ---------------- 대기 ----------------

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

  // ---------------- 전이·효과 ----------------

  private ctx(): MachineCtx {
    return { allowed: this.i.allowed?.() ?? true, ledger: this.i.ledgerStates(), hardStop: this.i.hardStop?.() ?? false };
  }

  /** 전이 하나. 불법이면 기록하고 false(상태는 그대로). */
  private fire(ev: RunEvent, at: string | null, code: string | null): boolean {
    const t = transition(this.st, ev, this.ctx());
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

  /** 열린 게이트 행을 닫는다. 이미 승인됐으면 거부로 돌린다(거부 우선 창, R-G8). */
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
