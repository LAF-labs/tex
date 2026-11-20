import type { Db, GateRepo, Ledger, LedgerState } from '@sax/db';
import type { RunToken } from '@sax/model';
import { Redactor } from '@sax/redaction';
import type { Page } from 'playwright-core';
import { oacxComplete, oacxRequest, type SimpleAuthIdentity } from './simple-auth.ts';
import { isFixtureGrant, type FixtureOriginGrant, type LoadedPackage } from '../core/loader.ts';
import { systemClock, type ActResult, type Clock } from '../core/page.ts';
import type { PdfPort } from '../core/savepdf.ts';
import { compileRe2 } from '../core/re2.ts';
import { newScope } from '../core/scope.ts';
import { resolveTarget } from '../core/resolve.ts';
import { BASIC_HANDLERS, stepEnv, type Handlers, type Outcome } from '../core/steps.ts';
import { targetDiagnosis } from '../core/diagnose.ts';
import { FallbackChain } from '../core/fallback.ts';
import { runLocalDict } from '../core/locate.ts';
import { HealMemory, healableKeys } from '../core/heal-memory.ts';
import { DbHealStore, DbJsonStore, agentPathKey } from './heal-store.ts';
import { AgentPathMemory, type AgentPathFile } from './agent-path.ts';
import { DecisionFirstLocateModel, GatewayLocateModel, type LocateResponder } from './locate-port.ts';
import { GatewayAgentModel, GatewayJudgeModel, GatewayVisionModel } from './agent-port.ts';
import { BrowserAgent } from './browser-agent.ts';
import { PageJudge } from './judge.ts';
import { GateTokens, wmaxMs } from '../core/token.ts';
import type { RunStateName } from '../core/machine.ts';
import type { PlaybookIR, Step, StepOf } from '../core/types.ts';
import { semanticViolations } from '../core/validate.ts';
import { flatten } from '../core/cfg.ts';
import { judgeVerify, takeBaseline, VerifyBook, type VerifyDeps } from '../core/verify.ts';
import { GuardedActuator } from '../core/actuator.ts';
import { PlaywrightActuator } from '../driver/actuator.ts';
import { IrLookupPort } from '../driver/lookup-ir.ts';
import { CERT_ALERT_OK_CSS, CERT_FRAME_CSS, CertSecretPort, type SecretTurnEvent } from '../driver/cert-secret.ts';
import type { SecretVault } from '../driver/secret.ts';
import { PopupLookupPort } from '../driver/lookup.ts';
import { PlaywrightPageReader } from '../driver/reader.ts';
import { PlaywrightScreenSource } from '../driver/screen.ts';
import { wireRun, type RunWiring } from '../driver/wire.ts';
import { RunEnforcer } from '../enforcer.ts';
import type { GateField, GatePortMessage, GateRequest } from '../gate.ts';
import type { Judge } from '../l0/judge.ts';
import type { RateGuard } from '../policy.ts';
import type { LookupDef, PortalConfig } from '../portal.ts';
import type { RunStatus } from '../run-end.ts';
import { SIGNAL_DICT, type SignalDict } from '../signals.ts';
import { ISSUE_LOCK_LOST, ISSUE_LOCK_RETRY_MS, ISSUE_LOCK_WAIT_MS, ISSUE_LOCKED_ELSEWHERE, type IssueLockPort } from '../issue-lock.ts';
import { readbackCard } from './card.ts';
import { RunController, type HumanPort, type RunOutcome } from './controller.ts';
import { bundleInfoFrom, DecideRunner } from './decide.ts';
import { LedgerCommitPort } from './ledger-port.ts';
import { BundleCatalog } from '@sax/model';
import type { ArmRow } from '@sax/db';
import type { RunPermit } from '../core/permit.ts';

const DEFAULT_SIGN_METHOD = 'cert';

/** RunService가 IR 경로에 주는 패키지와 포트. 제품은 레지스트리 로더가, 시험은 fixture 빌더가 만든다. */
export interface IrPackage {
  pkg: LoadedPackage;
  local?: { digest: string };
  lookupPackages?: ReadonlyMap<string, LoadedPackage>;
  lookupDefs?: ReadonlyMap<string, LookupDef>;
  fixtureGrant?: FixtureOriginGrant | null;
  judge?: Pick<Judge, 'decide'>;
  runToken?: RunToken;
  runTokenFor?: (runId: string) => Promise<RunToken>;
  verifyTiming?: { minElapsedMs: number; lookups: number; maxMs: number };
  pdf?: PdfPort;
  secret?: { vault: SecretVault; targetId(): string };
  locate?: LocateResponder;
}

/** 실행 시작 패키지 공급 결과(RunServiceDeps.irSource). */
export type IrSourceResult = { ok: true; ir: IrPackage } | { ok: false; code: string };

/** 게이트 예약 키와 원장 행 재료(RunService가 H01과 같은 함수로 만든다). */
export interface GateHistory {
  reserved: GateField[];
  row: (x: { stepId: string; reqId: string; actionHash: string }) => ArmRow;
}

export interface IrRunInput {
  runId: string;
  intentId: string;
  packageDigest: string;
  page: Page;
  ir: IrPackage;
  portal: PortalConfig;
  rate: RateGuard;
  profile: { id: string; bizNo: string; signMethod: string | null; certName?: string | null };
  profileWrite?: (field: 'certName', value: string) => Promise<boolean>;
  kind?: 'invoice' | 'cert';
  inputs: Record<string, unknown>;
  db: Db;
  heal?: boolean;
  vision?: boolean;
  decision?: boolean;
  ledger: Ledger;
  gates: GateRepo;
  history: (rb: Readonly<Record<string, string>>, card: string) => GateHistory | null;
  readbackFixed?: (values: ReadonlyMap<string, string>, card: string) => void;
  manualRow: (stepId: string) => ArmRow | null;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  diag?: (code: string, fields: Record<string, string | number | boolean>, data: unknown) => void;
  phase: (phase: string, state: 'now' | 'done' | 'attention', code?: string) => void;
  postGate: (m: GatePortMessage) => void;
  waiting: (reqId: string) => void;
  gateWaitMs?: number;
  clock?: Clock;
  signals?: SignalDict;
  permit?: () => RunPermit;
  trace?: (e: { name: string; stepId: string; type: string; code?: string }) => void;
  handoff?: (h: { phase: string; code?: string; stepId: string | null }) => void;
  human?: HumanPort;
  issueLock?: IssueLockPort;
  issueLockWaitMs?: number;
  issueLockRetryMs?: number;
  handoffCapMs?: number;
  lifetimeMs?: number;
  secretEvent?: (e: SecretTurnEvent) => void;
  portalNotice?: (n: { stepId: string; key: string; text: string; ok: boolean }) => void;
  secretTtlMs?: number;
  lookupSnap?: (popup: Page, at: { stepId: string; code: string }) => Promise<void>;
}

/** 사람 대기 한 번의 상한(부장 결정 2026-11-11). */
export const HANDOFF_CAP_MS = 30 * 60_000;
/** 실행 전체 수명 상한(대기 포함). 넘으면 사람 대기 중이면 run.handoff_timeout, 서명 차례면 verify(부장 결정 2026-11-11). */
export const RUN_LIFETIME_MS = 2 * 60 * 60_000;
type HandoffCommand = 'resume' | 'manual' | 'stop' | 'cap';

export interface IrRunResult {
  status: RunStatus;
  code?: string;
  maintenanceUntil?: string;
  approvalNo?: string;
  mailConfirmed?: boolean;
  state: RunStateName;
  stoppedAt?: StoppedAt;
}

export interface StoppedAt {
  stepId: string;
  type: string;
  target?: string;
}

/** 스텝 id → 종류·대상(target·value가 셀렉터 키인 wait). */
export function stoppedAtOf(ir: PlaybookIR, stepId: string | null): StoppedAt | undefined {
  if (!stepId) return undefined;
  const s = flatten(ir.steps).info.get(stepId)?.step as (Step & { target?: unknown; for?: unknown; value?: unknown }) | undefined;
  if (!s) return { stepId, type: 'unknown' };
  const on = s.type === 'branch' ? (s as StepOf<'branch'>).on : undefined;
  const condTarget = on && 'textMatches' in on ? on.textMatches.target : on && 'exists' in on ? on.exists : undefined;
  const target = typeof s.target === 'string' ? s.target : s.type === 'wait' && s.for === 'selector' && typeof s.value === 'string' ? s.value : condTarget;
  return { stepId, type: s.type, ...(target ? { target } : {}) };
}

/** H-01 IR 스텝 → 진행 표시 단계(H01 TS 플레이북과 같은 단계 이름, 승인 바·진행 줄이 쓴다). */
export const PHASE_OF: Readonly<Record<string, string>> = {
  s0: 'login', s1: 'login', s2: 'login', s3: 'login', s4: 'login', s5: 'login', s6: 'login', s90: 'login', s91: 'login', s92: 'login', s93: 'login',
  s4a: 'login', s4b: 'login', s4c: 'login', s4d: 'login', s4e: 'login', s4f: 'login', s4g: 'login', s4h: 'login',
  s8: 'login', s8a: 'login', s8b: 'login',
  s7: 'login', s7a: 'login', s7b: 'login', s7c: 'login', s7d: 'login', s7e: 'login', s7f: 'login', s7g: 'login',
  s10: 'form', s11: 'form',
  s12: 'input', s13: 'input', s14: 'input', s15: 'input', s16: 'input', s17: 'input', s18: 'input',
  s19: 'readback', s19a: 'readback', s19b: 'readback', s19c: 'readback', s19d: 'readback', s19f: 'readback', s19e: 'readback',
  s20: 'gate', s21: 'sign', s30: 'verify', s32: 'verify', s32b: 'verify', s33: 'mail', s34: 'mail', s35: 'mail',
};

/**
 * 민원증명 IR 스텝 → 진행 표시 단계(H-01과 같은 단계 이름). 스텝 id가 서류마다 달라(H-04 s10 goto·s11 checkpoint, H-09 메뉴 클릭) 종류와 순서로 정한다.
 * 양식 진입(s10)부터 첫 end까지: 입력 칸 전 = form, select·fill = input, 그 뒤 게이트 전 = readback, gate, submit = sign, 그 뒤(verify·출력·PDF) = verify.
 * 로그인 구간(s0~s6)과 캡차(s90~)는 단계를 내지 않는다(H-01 IR과 같음).
 */
export function certPhases(ir: PlaybookIR): Record<string, string> {
  const out: Record<string, string> = {};
  let started = false;
  let input = false;
  let committed = false;
  for (const s of ir.steps) {
    if (s.id === 's10') started = true;
    if (!started) continue;
    if (s.type === 'end') break;
    let p: string;
    if (s.type === 'gate') p = 'gate';
    else if (s.type === 'submit') {
      p = 'sign';
      committed = true;
    } else if (committed) p = 'verify';
    else if (s.type === 'select' || s.type === 'fill') {
      p = 'input';
      input = true;
    } else p = input ? 'readback' : 'form';
    out[s.id] = p;
  }
  return out;
}

const STATUS_OF: Partial<Record<RunStateName, RunStatus>> = {
  Completed: 'success', CompletedWithIssues: 'completed_with_issues', Failed: 'failed', HandedOff: 'handoff', InDoubt: 'in_doubt', Paused: 'handoff', Interrupted: 'failed',
};

function abortedStatus(code: string | null): RunStatus {
  if (code === 'gate.expired') return 'expired';
  if (code === 'run.aborted' || code === 'gate.denied' || code === 'run.stopped') return 'stopped';
  return 'failed';
}

function runCopy(ir: PlaybookIR, gateWaitMs: number | undefined, timing: IrPackage['verifyTiming']): PlaybookIR {
  if (gateWaitMs === undefined && !timing) return ir;
  return {
    ...ir,
    steps: ir.steps.map((s): Step => {
      if (s.type === 'gate' && gateWaitMs !== undefined) return { ...s, waitMs: gateWaitMs };
      if (s.type === 'verify' && timing) {
        const lookup = { ...s.lookup, notCommittedPolicy: { minElapsedMs: timing.minElapsedMs, lookups: timing.lookups } };
        if (lookup.maxMs !== undefined) lookup.maxMs = timing.maxMs;
        return { ...s, lookup };
      }
      return s;
    }),
  };
}

export class IrRun {
  private readonly i: IrRunInput;
  private controller: RunController | null = null;
  private enforcer: RunEnforcer | null = null;
  private actuator: GuardedActuator | null = null;
  private wiring: RunWiring | null = null;
  private history: GateHistory | null = null;
  private stopRequested = false;
  private formStarted = false;
  private mail: boolean | undefined;
  private verified = false;
  private closeAs: 'stopped' | 'signal' | null = null;
  private answered: string | null = null;
  gateReq: GateRequest | null = null;
  gateDeadline = 0;
  armed = false;
  private denied: Extract<RunPermit, { ok: false }> | null = null;
  private downgradeSent = false;
  private cmdWake: ((c: HandoffCommand) => void) | null = null;
  private waitingState: RunStateName | null = null;
  private waitingCode: string | null = null;
  private lockAsked = false;
  private readonly secretAbort = new AbortController();
  private readonly stopAbort = new AbortController();

  constructor(i: IrRunInput) {
    this.i = i;
  }

  get notice(): string | null {
    return this.actuator?.notice ?? null;
  }

  get halted(): string | null {
    return this.enforcer?.halted ?? null;
  }

  get downgraded(): Extract<RunPermit, { ok: false }> | null {
    return this.denied;
  }

  private denial(): Extract<RunPermit, { ok: false }> | null {
    if (!this.denied) {
      const p = this.i.permit?.();
      if (p && !p.ok) {
        this.denied = p;
        this.i.journal('run.downgraded', { code: p.code });
      }
    }
    return this.denied;
  }

  recheck(): boolean {
    if (this.downgradeSent || !this.controller || !this.denial()) return false;
    this.downgradeSent = true;
    this.controller.downgrade();
    return true;
  }

  approve(reqId: string, actionHash: string, by: 'local' | 'remote' = 'local'): { ok: boolean; code?: string } {
    if (!this.controller) return { ok: false, code: 'no_open_gate' };
    const r = this.controller.answerGate({ reqId, decision: 'approved', by, actionHash });
    if (r.ok) this.answered = reqId;
    return r;
  }

  stop(): void {
    this.stopRequested = true;
    this.secretAbort.abort();
    if (this.cmdWake) return this.cmdWake('stop');
    if (!this.denyOpenGate('stopped')) this.controller?.abort();
    this.stopAbort.abort();
  }

  private orStop<T>(p: Promise<T>, v: T): Promise<T> {
    const sig = this.stopAbort.signal;
    if (sig.aborted) return (void p.catch(() => {}), Promise.resolve(v));
    return new Promise<T>((resolve, reject) => {
      const on = () => (void p.catch(() => {}), resolve(v));
      sig.addEventListener('abort', on, { once: true });
      p.then(
        (x) => (sig.removeEventListener('abort', on), resolve(x)),
        (e: unknown) => (sig.removeEventListener('abort', on), reject(e)),
      );
    });
  }

  private localGuard(h: HumanPort): HumanPort {
    if (!this.i.ir.local) return h;
    return {
      request: (r) => h.request(r),
      secret: (r) => {
        if (!this.formStarted) return h.secret(r);
        this.i.journal('rehearsal.secret_refused', { stepId: r.stepId });
        return Promise.resolve({ code: 'rehearsal.secret_after_form' });
      },
      closed: (reqId, why) => h.closed(reqId, why),
    };
  }

  get waiting(): boolean {
    return this.cmdWake !== null || (this.controller?.signTurnOpen ?? false);
  }

  command(c: 'resume' | 'manual'): { ok: boolean; code?: string } {
    if (this.controller?.signTurnOpen) {
      if (c !== 'resume') return { ok: false, code: 'sign.turn_resume_only' };
      return this.controller.finishSignTurn() ? { ok: true } : { ok: false, code: 'not_handed_off' };
    }
    if (!this.cmdWake) return { ok: false, code: 'not_handed_off' };
    if (c === 'manual' && this.waitingState !== 'HandedOff') return { ok: false, code: 'not_handed_off' };
    this.cmdWake(c);
    return { ok: true };
  }

  async simpleAuth(op: 'request' | 'complete', d?: SimpleAuthIdentity): Promise<{ ok: boolean; code?: string }> {
    if (this.waitingState !== 'HandedOff' || this.waitingCode !== 'login.simple_auth' || !this.cmdWake) return { ok: false, code: 'not_simple_turn' };
    if (op === 'request') {
      if (!d) return { ok: false, code: 'simple.input' };
      const r = await oacxRequest(this.i.page, d);
      this.i.journal('run.simple_auth', { op, ok: r.ok, ...(r.ok ? {} : { code: r.code }) });
      return r;
    }
    const r = await oacxComplete(this.i.page);
    this.i.journal('run.simple_auth', { op, ok: r.ok, ...(r.ok ? {} : { code: r.code }) });
    if (!r.ok) return r;
    return this.command('resume');
  }

  private waitCommand(ms: number): Promise<HandoffCommand> {
    return new Promise((resolve) => {
      const t = setTimeout(() => wake('cap'), ms);
      const wake = (c: HandoffCommand) => {
        clearTimeout(t);
        this.cmdWake = null;
        resolve(c);
      };
      this.cmdWake = wake;
      if (this.stopRequested) wake('stop');
    });
  }

  private async takeIssueLock(clock: Clock): Promise<ActResult> {
    const lock = this.i.kind === 'cert' ? undefined : this.i.issueLock;
    if (!lock) return { ok: true };
    const until = clock.now() + (this.i.issueLockWaitMs ?? ISSUE_LOCK_WAIT_MS);
    let waited = false;
    for (;;) {
      this.lockAsked = true;
      const r = await this.orStop(lock.acquire().catch((): ActResult => ({ ok: false, code: 'issue.lock_unavailable' })), { ok: false, code: 'run.aborted' } as ActResult);
      if (this.stopRequested) {
        this.dropIssueLock();
        return { ok: false, code: 'run.aborted' };
      }
      if (r.ok) {
        if (waited) {
          this.i.journal('issue.lock_wait_done', {});
          this.i.phase('gate', 'now');
        }
        return r;
      }
      if (r.code !== ISSUE_LOCKED_ELSEWHERE || clock.now() >= until) {
        this.i.journal('issue.lock_refused', { code: r.code });
        this.dropIssueLock();
        return r;
      }
      if (!waited) {
        this.i.journal('issue.lock_wait', {});
        this.i.phase('gate', 'now', ISSUE_LOCKED_ELSEWHERE);
      }
      waited = true;
      await this.orStop(clock.sleep(Math.min(this.i.issueLockRetryMs ?? ISSUE_LOCK_RETRY_MS, Math.max(0, until - clock.now()))), undefined);
    }
  }

  private dropIssueLock(): void {
    if (!this.lockAsked) return;
    this.lockAsked = false;
    this.i.issueLock?.release();
  }

  private resumable(out: RunOutcome): boolean {
    if (out.state !== 'HandedOff' && out.state !== 'Paused') return false;
    return out.code !== 'gate.expired' && !this.denied && !this.halted && !this.stopRequested;
  }

  halt(code: string): void {
    if (this.armed) return;
    this.secretAbort.abort();
    this.denyOpenGate('signal');
    this.enforcer?.haltFor(code);
  }

  private denyOpenGate(as: 'stopped' | 'signal'): boolean {
    const r = this.gateReq;
    if (!r || !this.controller) return false;
    this.closeAs ??= as;
    return this.controller.answerGate({ reqId: r.reqId, decision: 'denied', by: 'local', actionHash: r.actionHash }).ok;
  }

  async run(): Promise<IrRunResult> {
    const i = this.i;
    const { pkg } = i.ir;
    const files = pkg.files;
    const dict = runLocalDict(pkg.selectors);
    const domains = files.manifest.domains;
    const clock = i.clock ?? systemClock;
    const ir = runCopy(files.playbook, i.gateWaitMs, isFixtureGrant(i.ir.fixtureGrant) ? i.ir.verifyTiming : undefined);
    const analysis = semanticViolations(files).analysis;
    const heal = i.heal === false ? null : new HealMemory({ store: new DbHealStore(i.db, files.manifest.id), pkg: pkg.selectors, healable: healableKeys(ir, pkg.selectors, analysis.irreversible), now: () => clock.now(), journal: i.journal });
    const seeded = heal?.seed(dict) ?? new Map<string, string>();
    const paths = i.heal === false ? null : new AgentPathMemory(new DbJsonStore<AgentPathFile>(i.db, agentPathKey(files.manifest.id)), { now: () => clock.now(), journal: i.journal });
    const page = i.page;
    const reader = new PlaywrightPageReader(page);

    const enforcer = new RunEnforcer({
      guard: i.rate, clock, mono: () => performance.now(), dict: i.signals ?? SIGNAL_DICT[i.portal.kind], profileId: i.profile.id,
      journal: i.journal, stopRequested: () => this.stopRequested,
      onLatch: () => {
        this.denyOpenGate('signal');
        this.controller?.abort();
      },
    });
    this.enforcer = enforcer;
    const raw = new PlaywrightActuator({ page, reader, afterNavigation: () => enforcer.settled(), onError: (op, why) => i.journal('actuator.why', { stepId: curStep ?? '', op, ...why }), onBoxClick: (r) => i.journal('actuator.box_click', { stepId: curStep ?? '', ...r }) });
    let pageJudge: PageJudge | null = null;
    let agent: BrowserAgent | null = null;
    let curStep: string | null = null;
    const act = new GuardedActuator({
      driver: raw, reader, dict, domains, policy: enforcer,
      events: { security: (code, key) => i.journal('security.event', { code, key }), journal: i.journal },
      commitArmed: (k) => this.controller?.commitArmed(k) ?? false, armedConfirm: () => this.controller?.armedConfirm() ?? null, fixtureGrant: i.ir.fixtureGrant ?? null,
      dialogJudge: (kind, notice) => pageJudge?.onDialog(kind, notice) ?? Promise.resolve(null),
    });
    this.actuator = act;
    const closeWindows = (ir.closeWindows ?? []).flatMap((k) => {
      try {
        return [compileRe2(files.strings[k]!)];
      } catch {
        return [];
      }
    });
    this.wiring = await wireRun({ page, reader, enforcer, actuator: act, domains, ...(closeWindows.length ? { closeWindows, journal: i.journal } : {}) });

    const p = i.profile;
    const scope = newScope({ inputs: i.inputs, profile: { bizNo: p.bizNo, signMethod: p.signMethod ?? DEFAULT_SIGN_METHOD, ...(p.certName ? { certName: p.certName } : {}) }, intentId: i.intentId });
    let tokenP: Promise<RunToken> | null = null;
    const runToken = (): Promise<RunToken> => {
      tokenP ??= (i.ir.runTokenFor ? i.ir.runTokenFor(i.runId) : Promise.resolve(i.ir.runToken ?? (i.runId as RunToken))).catch((e: unknown) => {
        tokenP = null;
        throw e;
      });
      return tokenP;
    };
    const redactor = new Redactor({ runId: i.runId });
    const day = { spent: false };
    const locateBudget = { spent: false, day };
    const pageAiBudget = { spent: false, day };
    const locatePort = i.ir.locate ? { responder: i.ir.locate, redactor, runToken, journal: i.journal, budget: locateBudget } : null;
    const locate = locatePort ? { model: i.decision === false ? new GatewayLocateModel(locatePort) : new DecisionFirstLocateModel(locatePort, new GatewayLocateModel(locatePort)), journal: i.journal } : undefined;
    const layers = ir.closeLayers?.targets ?? [];
    let layersDone = layers.length === 0;
    const closeLayers = async (): Promise<void> => {
      for (const k of layers) {
        const r = await resolveTarget(reader, dict, k).catch(() => null);
        if (!r?.ok) continue;
        const c = await act.click(r.t).catch(() => ({ ok: false as const, code: 'step.port_error' }));
        i.journal('layer.closed', { target: k, ok: c.ok });
      }
    };
    const env = stepEnv({ page: reader, act, clock, dict, strings: files.strings, scope, domains, fixtureGrant: i.ir.fixtureGrant ?? null, irreversible: analysis.irreversible });
    if (i.profileWrite) env.profileWrite = i.profileWrite;
    env.journal = i.journal;
    if (i.portalNotice) env.dialogShown = i.portalNotice;
    if (i.ir.locate) {
      const port = { responder: i.ir.locate, redactor, runToken, journal: i.journal, budget: pageAiBudget };
      const screen = { page: reader, dict, act, frame: 'main', journal: i.journal };
      agent = new BrowserAgent({ ...screen, ir, scope, irreversible: analysis.irreversible, model: new GatewayAgentModel(port), ...(paths ? { paths, pkg: pkg.selectors } : {}), ...(i.vision === false ? {} : { vision: new GatewayVisionModel(port) }) });
      pageJudge = new PageJudge({
        ...screen, ir, irreversible: analysis.irreversible, model: new GatewayJudgeModel(port), agent, ...(locate ? { locate } : {}),
        lastNotice: () => act.notice, currentStep: () => curStep,
      });
    }
    const fallback = new FallbackChain({ ir, dict, page: reader, irreversible: analysis.irreversible, ...(locate ? { locate } : {}), ...(pageJudge ? { judge: pageJudge } : {}), ...(heal ? { memory: heal, seeded } : {}), ...(agent && paths ? { replay: agent } : {}), ...(agent && i.vision !== false ? { vision: agent } : {}), journal: i.journal });
    const book = new VerifyBook();
    const vpol = i.portal.verify;
    const verifyDeps: VerifyDeps = {
      lookup: i.ir.lookupPackages
        ? new IrLookupPort({
          page, packages: i.ir.lookupPackages, policy: enforcer, clock, fixtureGrant: i.ir.fixtureGrant ?? null,
          events: { security: (code, key) => i.journal('security.event', { code, key }), journal: i.journal },
          ...(i.lookupSnap ? { onFail: i.lookupSnap } : {}),
        })
        : new PopupLookupPort({ page, origin: i.portal.origin, defs: i.ir.lookupDefs ?? new Map(), policy: enforcer, domains }),
      book, page: reader, clock, dict, strings: files.strings, scope,
      policy: () => ({ minElapsedMs: vpol.minElapsedMs, lookups: vpol.lookups, maxMs: vpol.maxMs }),
      intervals: { firstMs: vpol.intervalMs, capMs: vpol.intervalMs },
    };
    const decide = i.ir.judge
      ? new DecideRunner({
        screen: new PlaywrightScreenSource({ page, reader, dict }), redactor, judge: i.ir.judge,
        runToken, bundle: bundleInfoFrom(BundleCatalog.load()), journal: i.journal,
      })
      : null;
    const commit = new LedgerCommitPort({
      db: i.db, ledger: i.ledger, intentId: i.intentId, ir, dict,
      row: (x) => this.history?.row(x) ?? null,
      manualRow: i.manualRow,
      inTx: () => enforcer.markCommitted(),
      pageUrl: () => page.url(),
      verifyRef: (v) => book.ref(v) ?? null,
      baseline: (v) => book.baseline(v),
      journal: i.journal,
    });
    const sv = i.ir.secret;
    const ps = files.strings;
    if (sv && (ps['popup.hide'] || ps['popup.window.close'])) {
      void sv.vault
        .rpc('popups.configure', { hide: ps['popup.hide'] ?? '', idPrefix: ps['popup.hide.idPrefix'] ?? '', cookie: ps['popup.hide.cookie'] ?? '', closeUrl: ps['popup.window.close'] ?? '' })
        .then((r) => i.journal('popups.configured', { ok: (r as { ok?: unknown } | null)?.ok === true }), () => i.journal('popups.configured', { ok: false }));
    }
    const secretPort = sv
      ? new CertSecretPort({
        vault: sv.vault, targetId: sv.targetId, dict, strings: files.strings, journal: i.journal, signal: this.secretAbort.signal,
        page: {
          text: async () => {
            const main = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
            const cert = await page.frameLocator(CERT_FRAME_CSS).first().locator('body').innerText({ timeout: 1_000 }).catch(() => '');
            return cert ? `${main}\n${cert}` : main;
          },
          certFrame: () => page.locator(CERT_FRAME_CSS).first().isVisible(),
          dismissAlert: async () => {
            const ok = page.frameLocator(CERT_FRAME_CSS).first().locator(CERT_ALERT_OK_CSS).first();
            if (await ok.isVisible().catch(() => false)) await ok.click({ timeout: 2_000 }).catch(() => {});
          },
        },
        ...(i.secretEvent ? { event: i.secretEvent } : {}),
      })
      : null;
    const handlers: Handlers = { ...BASIC_HANDLERS, decide: decide ? decide.handler : async (): Promise<Outcome> => ({ t: 'fail', code: 'decide.unavailable' }) };
    let phase: string | null = null;
    const kind = i.kind ?? 'invoice';
    const lock = kind === 'invoice' ? i.issueLock : undefined;
    const phaseOf: Readonly<Record<string, string>> = kind === 'cert' ? certPhases(ir) : PHASE_OF;
    const ledgerStates = (): LedgerState[] => {
      const r = i.ledger.get(i.intentId, 's21');
      return r ? [r.state] : [];
    };

    const lifetimeEnd = clock.now() + (i.lifetimeMs ?? RUN_LIFETIME_MS);
    const lifeLeft = () => Math.max(0, lifetimeEnd - clock.now());
    const capMs = i.handoffCapMs ?? HANDOFF_CAP_MS;
    const c = new RunController({
      runId: i.runId, intentId: i.intentId, packageDigest: i.packageDigest, ir, handlers, env,
      handoffTimeoutMs: capMs + 60_000,
      signTurnMs: () => Math.min(capMs, lifeLeft()),
      signTurn: {
        opened: (r) => i.handoff?.({ phase: 'sign', code: 'sign.waiting', stepId: r.stepId }),
        closed: () => {},
      },
      interp: { retries: { stepMax: 3, backoff: 'equal_jitter', baseMs: 800, capMs: 10_000 }, retryFloorMs: 0, escalate: (s, cause) => fallback.eligible(s, cause), fastEscalate: (s, cause, attempt) => fallback.fastEscalate(s, cause, attempt), stop: this.stopAbort.signal },
      recover: (stop) => {
        paths?.failed(stop.at, stop.cause ?? stop.code ?? 'step.failed');
        return this.orStop(fallback.recover(stop.at, stop.cause ?? stop.code), false);
      },
      allowed: () => !this.denial(),
      hardStop: () => this.denial()?.hardStop ?? false,
      beforeStep: async (s) => {
        curStep = s.id;
        if (s.type === 'gate' || s.id === ir.closeLayers?.until) layersDone = true;
        if (!layersDone) await closeLayers();
        if (this.recheck()) return { ok: true };
        const p = phaseOf[s.id];
        if (p && p !== phase) {
          if (phase) i.phase(phase, 'done');
          phase = p;
          i.phase(p, 'now');
        }
        if (s.id === ir.steps[0]?.id) return { ok: true };
        return enforcer.beforeStep(s.type);
      },
      stepEvent: (name, d) => {
        if (name === 'step.started' && d.type === 'fill') this.formStarted = true;
        i.trace?.({ name, stepId: d.stepId, type: d.type, ...(d.code ? { code: d.code } : {}) });
        if (name === 'step.finished' && d.type === 'checkpoint' && !d.code) enforcer.reached();
        if (name === 'step.finished' && !d.code) {
          fallback.confirmed(d.stepId);
          paths?.confirmed(d.stepId);
        }
        if (name === 'step.finished' && secretPort) void secretPort.stepFinished(d.type, !!d.code, d.stepId);
      },
      clock, gates: i.gates, tokens: new GateTokens(i.runId), ledgerStates,
      card: (g) => {
        const rb = readbackCard(scope, g.card);
        if (!rb) return null;
        const h = i.history(rb, g.card);
        if (!h) return null;
        this.history = h;
        i.readbackFixed?.(scope.readback, g.card);
        return { readback: rb, reserved: h.reserved };
      },
      preGate: async (g): Promise<ActResult> => {
        const safe = decide?.safeForGate() ?? { ok: true as const };
        if (!safe.ok) return safe;
        if (this.stopRequested) return { ok: false, code: 'run.aborted' };
        const locked = await this.takeIssueLock(clock);
        if (!locked.ok) return locked;
        return takeBaseline(verifyDeps, ir, g);
      },
      ...(lock ? { beforeCommit: async (): Promise<ActResult> => (this.lockAsked ? lock.renew().catch((): ActResult => ({ ok: false, code: ISSUE_LOCK_LOST })) : { ok: false, code: ISSUE_LOCK_LOST }) } : {}),
      wmaxMs: (x) => wmaxMs(analysis, x, 30_000),
      commitWindowMs: 600_000,
      gate: {
        publish: (req) => {
          const r = req;
          this.gateReq = r;
          this.gateDeadline = Date.now() + r.waitMs;
          i.postGate({ t: 'gate.request', req: r });
          i.waiting(r.reqId);
        },
        closed: (reqId, why) => {
          this.gateReq = null;
          if (why === 'approved' || reqId === this.answered) return;
          const reason = this.closeAs && (why === 'denied' || why === 'aborted') ? this.closeAs : why;
          i.postGate({ t: 'gate.closed', runId: i.runId, reqId, reason });
        },
      },
      human: this.localGuard(i.human ?? {
        request: () => {},
        secret: secretPort ? (r) => secretPort.secret(r) : async () => 'ttl',
        ...(secretPort ? { afterSignConfirm: (r: { runId: string; stepId: string }) => secretPort.afterSignConfirm(r) } : {}),
        closed: () => {},
      }),
      ...(i.secretTtlMs !== undefined ? { secretTtlMs: i.secretTtlMs } : {}),
      reentry: { navigate: async (u) => void (await act.goto(u)), loggedIn: async () => true },
      verifyStep: async (v) => {
        const j = await judgeVerify(verifyDeps, v);
        this.verified = true;
        if (kind === 'invoice' && v.id === 's33') this.mail = j.result === 'committed';
        return j;
      },
      commit,
      ...(i.ir.pdf ? { pdf: i.ir.pdf } : {}),
      verifyBook: book,
      journal: (type, payload) => {
        if (type !== 'run.started') i.journal(type, payload);
      },
      onEffect: (effect, at) => {
        if (effect.startsWith('ledger.')) commit.ledgerEffect(effect, at);
        if (effect.startsWith('ledger.committed') || effect.startsWith('ledger.not_committed')) this.dropIssueLock();
        if (effect.startsWith('ledger.not_committed')) this.armed = false;
      },
    });
    this.controller = c;
    const arm = commit.arm.bind(commit);
    commit.arm = (a) => {
      const r = arm(a);
      if (r.ok) this.armed = true;
      return r;
    };

    let out: RunOutcome;
    try {
      out = await c.start();
      while (this.resumable(out)) {
        this.dropIssueLock();
        const left = Math.min(capMs, lifeLeft());
        const phase = PHASE_OF[out.at ?? ''] ?? 'login';
        this.waitingState = out.state;
        this.waitingCode = out.code ?? null;
        const at = stoppedAtOf(ir, out.at ?? null);
        i.journal('run.handoff', { stepId: out.at ?? '', state: out.state, code: out.code ?? '', ...(at?.target ? { target: at.target } : {}), ...(out.at ? { fallback: fallback.tried(out.at) } : {}) });
        if (i.diag && at?.target && (out.code === 'step.identity_mismatch' || out.code === 'step.selector_miss' || out.code === 'step.timeout')) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const d = await Promise.race([targetDiagnosis(reader, dict, at.target).catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), 10_000)))]).finally(() => clearTimeout(timer));
          i.diag('run.handoff_target', { stepId: out.at ?? '', code: out.code, target: at.target, read: !!d }, d);
        }
        const rbStep = out.at ? flatten(ir.steps).info.get(out.at)?.step : undefined;
        if (i.diag && rbStep?.type === 'readback' && (out.code === 'step.identity_mismatch' || out.code === 'step.selector_miss' || out.code === 'step.timeout')) {
          for (const f of rbStep.fields) {
            for (const key of Object.keys(dict.entries).filter((k) => dict.entries[k]!.fieldKey === f || dict.entries[k]!.readbackOf === f)) {
              const r = await resolveTarget(reader, dict, key).catch(() => null);
              if (r?.ok) continue;
              let timer: ReturnType<typeof setTimeout> | undefined;
              const d = await Promise.race([targetDiagnosis(reader, dict, key).catch(() => null), new Promise<null>((res) => (timer = setTimeout(() => res(null), 10_000)))]).finally(() => clearTimeout(timer));
              i.diag('run.handoff_target', { stepId: out.at ?? '', code: r?.code ?? 'step.port_error', target: key, field: f, read: !!d }, d);
            }
          }
        }
        i.handoff?.({ phase, ...(out.code ? { code: out.code } : {}), stepId: out.at });
        enforcer.pauseClock();
        const cmd = left > 0 ? await this.waitCommand(left) : 'cap';
        enforcer.resumeClock();
        this.waitingState = null;
        this.waitingCode = null;
        if (cmd === 'stop') {
          c.abort();
          out = { state: c.state.name, at: out.at, code: 'run.aborted' };
          break;
        }
        if (cmd === 'cap') {
          i.journal('run.handoff_timeout', { stepId: out.at ?? '' });
          out = { ...out, code: 'run.handoff_timeout' };
          break;
        }
        i.journal('run.resumed', { stepId: out.at ?? '', how: cmd });
        out = cmd === 'manual' ? await c.attestManualCommit() : await c.resume();
      }
    } finally {
      c.dispose();
      this.dropIssueLock();
      if (phase) i.phase(phase, 'done');
      enforcer.finish({ userStopped: this.stopRequested });
      await this.wiring?.dispose().catch(() => {});
      await reader.release().catch(() => {});
    }
    return this.result(out, kind === 'cert' ? scope.vars.get('issueNo') : scope.vars.get('approvalNo'), ir, kind);
  }

  private result(out: RunOutcome, approvalNo: string | undefined, ir: PlaybookIR, kind: 'invoice' | 'cert'): IrRunResult {
    const halted = this.halted;
    let status = out.state === 'Aborted' ? abortedStatus(out.code) : (STATUS_OF[out.state] ?? 'failed');
    let code = out.code ?? undefined;
    if (code === 'gate.expired') status = 'expired';
    if (this.closeAs === 'stopped' && (code === 'gate.denied' || code === 'run.aborted')) code = 'gate.stopped';
    else if (this.stopRequested && code === 'run.aborted') code = 'run.stopped';
    if (halted && status !== 'success' && status !== 'completed_with_issues' && status !== 'in_doubt') {
      code = halted;
      status = halted === 'portal.maintenance' ? 'failed' : halted.startsWith('portal.') && halted !== 'portal.blocked' ? 'handoff' : 'failed';
    }
    const until = halted === 'portal.maintenance' ? this.enforcer?.maintenanceUntil : null;
    if (this.denied && (status === 'handoff' || status === 'completed_with_issues') && (!code || code === 'run.state_stop')) code = this.denied.code;
    if (status === 'completed_with_issues' && this.mail === false && !code) code = 'mail.not_confirmed';
    const stoppedAt = status === 'success' ? undefined : stoppedAtOf(ir, out.at);
    return {
      status, state: out.state,
      ...(code ? { code } : {}),
      ...(stoppedAt ? { stoppedAt } : {}),
      ...(approvalNo ? { approvalNo } : {}),
      ...(this.verified && kind === 'invoice' ? { mailConfirmed: this.mail ?? false } : {}),
      ...(until ? { maintenanceUntil: until } : {}),
    };
  }
}
