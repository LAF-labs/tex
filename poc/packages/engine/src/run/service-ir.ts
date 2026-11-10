// RunService의 IR 실행 경로(M2-3 RunService IR 전환 PR-C, D03 §2~§5): 로드한 패키지를 RunController + 코어 핸들러 + 드라이버로 돌린다.
// - H01Runner 경로와 같은 바깥 모양(RunEvent·게이트 포트 메시지·저널·원장)을 낸다. 골든 대조(tests/h01-golden.test.ts)가 둘을 비교한다.
// - 게이트 예약 키($first·$dup)·원장 행 재료(업무 키·HMAC)는 RunService가 주는 함수로 만든다(H01과 같은 값).
// - 패키지가 portal fixture면 GuardedActuator·goto 핸들러에 로더 허가(fixtureOriginGrant)만 주입한다(ADR-039 결정 2 ②′).
// - 저널에는 코드·스텝 id·해시만(⑦). 화면 값은 RunScope 메모리에만 있다.
import type { Db, GateRepo, Ledger, LedgerState } from '@sax/db';
import type { RunToken } from '@sax/model';
import { Redactor } from '@sax/redaction';
import type { Page } from 'playwright-core';
import { isFixtureGrant, type FixtureOriginGrant, type LoadedPackage } from '../core/loader.ts';
import { systemClock, type ActResult, type Clock } from '../core/page.ts';
import type { PdfPort } from '../core/savepdf.ts';
import { newScope } from '../core/scope.ts';
import { BASIC_HANDLERS, stepEnv, type Handlers, type Outcome } from '../core/steps.ts';
import { GateTokens, wmaxMs } from '../core/token.ts';
import type { RunStateName } from '../core/machine.ts';
import type { PlaybookIR, Step } from '../core/types.ts';
import { semanticViolations } from '../core/validate.ts';
import { flatten } from '../core/cfg.ts';
import { judgeVerify, takeBaseline, VerifyBook, type VerifyDeps } from '../core/verify.ts';
import { GuardedActuator } from '../core/actuator.ts';
import { PlaywrightActuator } from '../driver/actuator.ts';
import { IrLookupPort } from '../driver/lookup-ir.ts';
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
import { readbackCard } from './card.ts';
import { RunController, type RunOutcome } from './controller.ts';
import { bundleInfoFrom, DecideRunner } from './decide.ts';
import { LedgerCommitPort } from './ledger-port.ts';
import { BundleCatalog } from '@sax/model';
import type { ArmRow } from '@sax/db';
import type { RunPermit } from '../core/permit.ts';

/** RunService가 IR 경로에 주는 패키지와 포트. 제품은 레지스트리 로더가, 시험은 fixture 빌더가 만든다. */
export interface IrPackage {
  pkg: LoadedPackage;
  /**
   * verify.lookup.playbook → 서명 조회 패키지(IrLookupPort, 제품). 있으면 조회는 그 패키지 IR을 팝업에서 돌린다(팀장 결정 2026-11-09 (가)).
   * 조회 셀렉터·열 이름이 서명 패키지에 있으니 실기기에서 틀리면 다시 게시해 고친다.
   */
  lookupPackages?: ReadonlyMap<string, LoadedPackage>;
  /** verify.lookup.playbook → 조회 화면 정의(PopupLookupPort, 가짜 페이지 시험). lookupPackages가 있으면 쓰지 않는다. */
  lookupDefs?: ReadonlyMap<string, LookupDef>;
  /** portal fixture 패키지일 때만(loader.fixtureOriginGrant). */
  fixtureGrant?: FixtureOriginGrant | null;
  /** decide 판정기(L0 → 모델). 없으면 decide 스텝은 decide.unavailable(핸드오프). */
  judge?: Pick<Judge, 'decide'>;
  runToken?: RunToken;
  /** 실행마다 받는 모델 실행 토큰(제품: 게이트웨이 run 토큰). runToken보다 먼저 쓴다. */
  runTokenFor?: (runId: string) => Promise<RunToken>;
  /**
   * fixture 패키지의 부재 판정 시간(가짜 페이지는 반영이 바로 된다, H01Runner의 fixturePortal.verify와 같은 값).
   * IR 스키마 하한(30초) 아래라 패키지에 넣지 않고, fixtureGrant가 유효할 때만(개발 조건 소스) 실행 사본에 넣는다. 제품 dist에서는 무시한다.
   */
  verifyTiming?: { minElapsedMs: number; lookups: number; maxMs: number };
  /** save_pdf 포트(금고 pdf.print·보관함). 없으면 save_pdf 스텝은 실행하지 않는다(unhandled). */
  pdf?: PdfPort;
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
  profile: { id: string; bizNo: string; signMethod: string | null };
  /** $inputs(H01 RunInputs와 같은 모양). */
  inputs: Record<string, unknown>;
  db: Db;
  ledger: Ledger;
  gates: GateRepo;
  /** 게이트 카드의 readback이 정해진 뒤 예약 키·원장 행 재료를 만든다. card = 승인 카드 id(GATE_CARDS). 그 카드의 재료를 못 만들면 null(게이트를 열지 않는다). */
  history: (rb: Readonly<Record<string, string>>, card: string) => GateHistory | null;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  phase: (phase: string, state: 'now' | 'done' | 'attention', code?: string) => void;
  postGate: (m: GatePortMessage) => void;
  waiting: (reqId: string) => void;
  /** 시험용: gate.waitMs 대신 쓸 값. */
  gateWaitMs?: number;
  clock?: Clock;
  /** 신호 사전(없으면 포털 내장 사전). RunService가 받은 정책의 blockSignalsAdd를 더한 사전을 준다. */
  signals?: SignalDict;
  /** 실행 허가(status kill·실효 수준). Running 진입 확인·스텝 경계·recheck에서 부른다. 없으면 늘 허가. */
  permit?: () => RunPermit;
  /** 스텝 궤적(골든 대조). 값 없이 스텝 id·타입·코드만. */
  trace?: (e: { name: string; stepId: string; type: string; code?: string }) => void;
}

export interface IrRunResult {
  status: RunStatus;
  code?: string;
  approvalNo?: string;
  mailConfirmed?: boolean;
  /** 조율기 마지막 상태(골든 대조). */
  state: RunStateName;
  /**
   * 멈춘 스텝(성공 끝이 아닐 때): 스텝 id·종류·대상 셀렉터 키·하위 패키지 안이면 그 id. 실기기 디버깅용이다.
   * 셀렉터 키와 스텝 id만 담는다(화면 문구·입력 값 없음, ⑦).
   */
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
  const target = typeof s.target === 'string' ? s.target : s.type === 'wait' && s.for === 'selector' && typeof s.value === 'string' ? s.value : undefined;
  return { stepId, type: s.type, ...(target ? { target } : {}) };
}

/** H-01 IR 스텝 → 진행 표시 단계(H01 TS 플레이북과 같은 단계 이름, 승인 바·진행 줄이 쓴다). */
const PHASE_OF: Readonly<Record<string, string>> = {
  s10: 'form', s11: 'form',
  s12: 'input', s13: 'input', s14: 'input', s15: 'input', s16: 'input', s17: 'input', s18: 'input',
  s19: 'readback', s19a: 'readback', s19b: 'readback', s19c: 'readback', s19d: 'readback', s19f: 'readback', s19e: 'readback',
  s20: 'gate', s21: 'sign', s30: 'verify', s32: 'verify', s32b: 'verify', s33: 'mail', s34: 'mail', s35: 'mail',
};

const STATUS_OF: Partial<Record<RunStateName, RunStatus>> = {
  Completed: 'success', CompletedWithIssues: 'completed_with_issues', Failed: 'failed', HandedOff: 'handoff', InDoubt: 'in_doubt', Paused: 'handoff', Interrupted: 'failed',
};

/** 사용자 [중지]·거부·만료 코드 → RunStatus(H01 RunService와 같은 바깥 모양). */
function abortedStatus(code: string | null): RunStatus {
  if (code === 'gate.expired') return 'expired';
  if (code === 'run.aborted' || code === 'gate.denied' || code === 'run.stopped') return 'stopped';
  return 'failed';
}

/**
 * 실행 사본. 패키지(공유 객체)는 바꾸지 않는다.
 * - 시험용 gateWaitMs: gate.waitMs만 바꾼다.
 * - fixture 부재 판정 시간(허가가 유효할 때만 넘어온다): verify의 notCommittedPolicy와, 있으면 lookup.maxMs.
 */
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
  private mail: boolean | undefined;
  /** verify를 한 번이라도 판정했다(H01처럼 그 뒤 종료에는 mailConfirmed를 붙인다). */
  private verified = false;
  /** 사용자 [중지]·신호로 열린 게이트를 거부했을 때 게이트 포트에 알리는 사유(H01과 같은 stopped·signal). */
  private closeAs: 'stopped' | 'signal' | null = null;
  /** main이 승인으로 답한 게이트. 그 바는 main이 이미 닫았으니 뒤의 닫힘(거부 우선 창의 [중지] 등)은 알리지 않는다(H01과 같음). */
  private answered: string | null = null;
  /** 열린 게이트 요청(RunService.answer가 승인 근거를 대조한다). */
  gateReq: GateRequest | null = null;
  gateDeadline = 0;
  /** 원장 armed 뒤(커밋 구간). 이 뒤로는 중지를 받지 않는다. */
  armed = false;
  /** 정지 하향 사유(허가가 처음 없어진 때의 값, 이 실행 동안 그대로). */
  private denied: Extract<RunPermit, { ok: false }> | null = null;
  /** 조율기에 downgrade를 건넸다(한 번만, 커밋 구간 배너가 되풀이되지 않게). */
  private downgradeSent = false;

  constructor(i: IrRunInput) {
    this.i = i;
  }

  get notice(): string | null {
    return this.actuator?.notice ?? null;
  }

  /** 걸쇠에 걸린 종료 코드(차단 신호 등). */
  get halted(): string | null {
    return this.enforcer?.halted ?? null;
  }

  /** 정지 하향 사유(없으면 null). RunService가 hardStop이면 자동화 Chrome을 닫는다. */
  get downgraded(): Extract<RunPermit, { ok: false }> | null {
    return this.denied;
  }

  /** 지금 허가가 없으면 그 사유. 처음 없어진 때 저널에 남기고, 그 뒤로는 같은 값이다(허가가 돌아와도 이 실행은 멈춘다). */
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

  /**
   * 허가가 없어졌으면 조율기에 정지 하향을 한 번 건넨다(스텝 경계·레지스트리 동기화 뒤). 조율기가 다음 스텝 경계에서 멈추고,
   * 승인 대기면 게이트를 닫고, 커밋 구간·사람 차례면 verify·그 차례 뒤로 미룬다(D03 §2 하향 행, §5.3, ADR-023 결정 5).
   * 건넸으면 true.
   */
  recheck(): boolean {
    if (this.downgradeSent || !this.controller || !this.denial()) return false;
    this.downgradeSent = true;
    this.controller.downgrade();
    return true;
  }

  /** RunService.answer가 승인 근거를 다 대조한 뒤 부른다. */
  approve(reqId: string, actionHash: string): { ok: boolean; code?: string } {
    if (!this.controller) return { ok: false, code: 'no_open_gate' };
    const r = this.controller.answerGate({ reqId, decision: 'approved', by: 'local', actionHash });
    if (r.ok) this.answered = reqId;
    return r;
  }

  /** [중지]. 승인 대기 중이면 게이트를 거부로 닫는다(H01과 같이 gate.denied, 사유 stopped). */
  stop(): void {
    this.stopRequested = true;
    if (!this.denyOpenGate('stopped')) this.controller?.abort();
  }

  /** 엔진 밖 사유의 정지(금고 누출 의심 등). 무장 전에만. 열린 게이트는 거부로 닫는다(사유 signal). */
  halt(code: string): void {
    if (this.armed) return;
    this.denyOpenGate('signal');
    this.enforcer?.haltFor(code);
  }

  /** 열린 게이트를 거부로 결정한다(거부 우선, R-G8). 게이트가 없거나 이미 결정됐으면 false. */
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
    const dict = pkg.selectors;
    const domains = files.manifest.domains;
    const clock = i.clock ?? systemClock;
    const ir = runCopy(files.playbook, i.gateWaitMs, isFixtureGrant(i.ir.fixtureGrant) ? i.ir.verifyTiming : undefined);
    const analysis = semanticViolations(files).analysis;
    const page = i.page;
    const reader = new PlaywrightPageReader(page);

    const enforcer = new RunEnforcer({
      guard: i.rate, clock, mono: () => performance.now(), dict: i.signals ?? SIGNAL_DICT[i.portal.kind], profileId: i.profile.id,
      journal: i.journal, stopRequested: () => this.stopRequested,
      // 승인 대기 중 신호가 걸리면 게이트를 닫는다(바뀐 화면을 승인하지 못하게).
      onLatch: () => {
        this.denyOpenGate('signal');
        this.controller?.abort();
      },
    });
    this.enforcer = enforcer;
    const raw = new PlaywrightActuator({ page, reader, afterNavigation: () => enforcer.settled() });
    const act = new GuardedActuator({
      driver: raw, reader, dict, domains, policy: enforcer,
      events: { security: (code, key) => i.journal('security.event', { code, key }), journal: i.journal },
      commitArmed: (k) => this.controller?.commitArmed(k) ?? false, armedConfirm: () => this.controller?.armedConfirm() ?? null, fixtureGrant: i.ir.fixtureGrant ?? null,
    });
    this.actuator = act;
    this.wiring = await wireRun({ page, reader, enforcer, actuator: act, domains });

    const scope = newScope({ inputs: i.inputs, profile: { bizNo: i.profile.bizNo, ...(i.profile.signMethod ? { signMethod: i.profile.signMethod } : {}) }, intentId: i.intentId });
    const env = stepEnv({ page: reader, act, clock, dict, strings: files.strings, scope, domains, fixtureGrant: i.ir.fixtureGrant ?? null, irreversible: analysis.irreversible });
    const book = new VerifyBook();
    const vpol = i.portal.verify;
    const verifyDeps: VerifyDeps = {
      lookup: i.ir.lookupPackages
        ? new IrLookupPort({
          page, packages: i.ir.lookupPackages, policy: enforcer, clock, fixtureGrant: i.ir.fixtureGrant ?? null,
          events: { security: (code, key) => i.journal('security.event', { code, key }), journal: i.journal },
        })
        : new PopupLookupPort({ page, origin: i.portal.origin, defs: i.ir.lookupDefs ?? new Map(), policy: enforcer, domains }),
      book, page: reader, clock, dict, strings: files.strings, scope,
      policy: () => ({ minElapsedMs: vpol.minElapsedMs, lookups: vpol.lookups, maxMs: vpol.maxMs }),
      intervals: { firstMs: vpol.intervalMs, capMs: vpol.intervalMs },
    };
    const decide = i.ir.judge
      ? new DecideRunner({
        screen: new PlaywrightScreenSource({ page, reader, dict }), redactor: new Redactor({ runId: i.runId }), judge: i.ir.judge,
        runToken: i.ir.runTokenFor ? () => i.ir.runTokenFor!(i.runId) : (i.ir.runToken ?? (i.runId as RunToken)), bundle: bundleInfoFrom(BundleCatalog.load()), journal: i.journal,
      })
      : null;
    const commit = new LedgerCommitPort({
      db: i.db, ledger: i.ledger, intentId: i.intentId, ir, dict,
      row: (x) => this.history?.row(x) ?? null,
      inTx: () => enforcer.markCommitted(),
      pageUrl: () => page.url(),
      verifyRef: (v) => book.ref(v) ?? null,
      journal: i.journal,
    });
    const handlers: Handlers = { ...BASIC_HANDLERS, decide: decide ? decide.handler : async (): Promise<Outcome> => ({ t: 'fail', code: 'decide.unavailable' }) };
    let phase: string | null = null;
    const ledgerStates = (): LedgerState[] => {
      const r = i.ledger.get(i.intentId, 's21');
      return r ? [r.state] : [];
    };

    const c = new RunController({
      runId: i.runId, intentId: i.intentId, packageDigest: i.packageDigest, ir, handlers, env,
      interp: { retries: { stepMax: 3, backoff: 'equal_jitter', baseMs: 800, capMs: 10_000 }, retryFloorMs: 0 },
      // Running 진입 확인(D03 §2)·정지 분기의 Chrome 닫기(hardStop).
      allowed: () => !this.denial(),
      hardStop: () => this.denial()?.hardStop ?? false,
      beforeStep: async (s) => {
        // 스텝 경계: status가 바뀌었으면 조율기가 이 스텝 전에 멈춘다(요청률 지연을 기다리지 않는다).
        if (this.recheck()) return { ok: true };
        const p = PHASE_OF[s.id];
        if (p && p !== phase) {
          if (phase) i.phase(phase, 'done');
          phase = p;
          i.phase(p, 'now');
        }
        if (s.id === ir.steps[0]?.id) return { ok: true };
        return enforcer.beforeStep();
      },
      stepEvent: (name, d) => {
        i.trace?.({ name, stepId: d.stepId, type: d.type, ...(d.code ? { code: d.code } : {}) });
        if (name === 'step.finished' && d.type === 'checkpoint' && !d.code) enforcer.reached();
      },
      clock, gates: i.gates, tokens: new GateTokens(i.runId), ledgerStates,
      card: (g) => {
        const rb = readbackCard(scope, g.card);
        if (!rb) return null;
        const h = i.history(rb, g.card);
        if (!h) return null;
        this.history = h;
        return { readback: rb, reserved: h.reserved };
      },
      preGate: async (g): Promise<ActResult> => {
        const safe = decide?.safeForGate() ?? { ok: true as const };
        if (!safe.ok) return safe;
        if (this.stopRequested) return { ok: false, code: 'run.aborted' };
        return takeBaseline(verifyDeps, ir, g);
      },
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
          // 승인은 main이 답한 것이라 알리지 않는다(H01 게이트 포트와 같음). 거부·중단이 [중지]·신호 때문이면 그 사유로 알린다.
          if (why === 'approved' || reqId === this.answered) return;
          const reason = this.closeAs && (why === 'denied' || why === 'aborted') ? this.closeAs : why;
          i.postGate({ t: 'gate.closed', runId: i.runId, reqId, reason });
        },
      },
      human: {
        // 가짜 H-01 경로에는 사람 입력 스텝이 없다. 제품 배선(PR-D)에서 main 사람 차례 포트로 바꾼다.
        request: () => {},
        secret: async () => 'ttl',
        closed: () => {},
      },
      reentry: { navigate: async (u) => void (await act.goto(u)), loggedIn: async () => true },
      verifyStep: async (v) => {
        const j = await judgeVerify(verifyDeps, v);
        this.verified = true;
        if (v.id === 's33') this.mail = j.result === 'committed';
        return j;
      },
      commit,
      ...(i.ir.pdf ? { pdf: i.ir.pdf } : {}),
      verifyBook: book,
      // run.started는 RunService가 이미 썼다(의도·포털·보수 모드 값과 함께). 상태 기계의 같은 효과는 두 번 쓰지 않는다.
      journal: (type, payload) => {
        if (type !== 'run.started') i.journal(type, payload);
      },
      onEffect: (effect, at) => {
        if (effect.startsWith('ledger.')) commit.ledgerEffect(effect, at);
        // 발급 안 됨으로 정해지면 커밋 구간이 끝난다(D02 §8 not_committed → s11 재게이트). 그 뒤로는 다시 [중지]를 받는다.
        if (effect.startsWith('ledger.not_committed')) this.armed = false;
      },
    });
    this.controller = c;
    // 원장 armed는 LedgerCommitPort.arm이 쓴다. 그 뒤로는 중지를 받지 않는다(H01 a.armed와 같음).
    const arm = commit.arm.bind(commit);
    commit.arm = (a) => {
      const r = arm(a);
      if (r.ok) this.armed = true;
      return r;
    };

    let out: RunOutcome;
    try {
      out = await c.start();
    } finally {
      if (phase) i.phase(phase, 'done');
      enforcer.finish({ userStopped: this.stopRequested });
      await this.wiring?.dispose().catch(() => {});
      await reader.release().catch(() => {});
    }
    return this.result(out, scope.vars.get('approvalNo'), ir);
  }

  private result(out: RunOutcome, approvalNo: string | undefined, ir: PlaybookIR): IrRunResult {
    const halted = this.halted;
    let status = out.state === 'Aborted' ? abortedStatus(out.code) : (STATUS_OF[out.state] ?? 'failed');
    let code = out.code ?? undefined;
    // 만료는 쉼(Paused)이지만 바깥 상태는 H01과 같이 expired다. [중지]로 끝난 것은 H01과 같은 코드로 알린다.
    if (code === 'gate.expired') status = 'expired';
    // 게이트가 열려 있을 때(승인 대기·거부 우선 창)의 [중지]는 gate.stopped, 그 밖의 [중지]는 run.stopped.
    if (this.closeAs === 'stopped' && (code === 'gate.denied' || code === 'run.aborted')) code = 'gate.stopped';
    else if (this.stopRequested && code === 'run.aborted') code = 'run.stopped';
    if (halted && status !== 'success' && status !== 'completed_with_issues' && status !== 'in_doubt') {
      // 걸쇠(차단 신호·누출 의심)가 사유다. 그 뒤에 난 실패(바뀐 화면) 코드보다 앞선다.
      code = halted;
      status = halted.startsWith('portal.') && halted !== 'portal.blocked' ? 'handoff' : 'failed';
    }
    // 정지 하향으로 쉬었거나(Paused → handoff) 확정 뒤 멈췄으면(CompletedWithIssues) 사유는 하향 코드다. InDoubt는 그 코드를 둔다.
    if (this.denied && (status === 'handoff' || status === 'completed_with_issues') && (!code || code === 'run.state_stop')) code = this.denied.code;
    if (status === 'completed_with_issues' && this.mail === false && !code) code = 'mail.not_confirmed';
    const stoppedAt = status === 'success' ? undefined : stoppedAtOf(ir, out.at);
    return {
      status, state: out.state,
      ...(code ? { code } : {}),
      ...(stoppedAt ? { stoppedAt } : {}),
      ...(approvalNo ? { approvalNo } : {}),
      ...(this.verified ? { mailConfirmed: this.mail ?? false } : {}),
    };
  }
}
