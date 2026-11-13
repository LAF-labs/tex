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
import { compileRe2 } from '../core/re2.ts';
import { newScope } from '../core/scope.ts';
import { resolveTarget } from '../core/resolve.ts';
import { BASIC_HANDLERS, stepEnv, type Handlers, type Outcome } from '../core/steps.ts';
import { targetDiagnosis } from '../core/diagnose.ts';
import { FallbackChain } from '../core/fallback.ts';
import { runLocalDict } from '../core/locate.ts';
import { GatewayLocateModel, type LocateResponder } from './locate-port.ts';
import { GatewayAgentModel, GatewayJudgeModel } from './agent-port.ts';
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
import { readbackCard } from './card.ts';
import { RunController, type HumanPort, type RunOutcome } from './controller.ts';
import { bundleInfoFrom, DecideRunner } from './decide.ts';
import { LedgerCommitPort } from './ledger-port.ts';
import { BundleCatalog } from '@sax/model';
import type { ArmRow } from '@sax/db';
import type { RunPermit } from '../core/permit.ts';

/** RunService가 IR 경로에 주는 패키지와 포트. 제품은 레지스트리 로더가, 시험은 fixture 빌더가 만든다. */
export interface IrPackage {
  pkg: LoadedPackage;
  /** 서명 없는 예행 로컬 패키지(rehearsalIrSource). 있으면 금고 인증서 비밀번호는 첫 입력(fill) 스텝 전에만 쓴다(로그인만, 서명 창에는 넣지 않는다). */
  local?: { digest: string };
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
  /**
   * 공동인증서 비밀번호 차례(sign cert·signFlow cert·human kind=secret)의 금고(B1·B2). 있으면 CertSecretPort(금고 비밀 창 또는 사람 직접 입력 대기),
   * 없으면 사람 비밀 차례는 곧바로 TTL이다(가짜 H-01 경로·시험).
   */
  secret?: { vault: SecretVault; targetId(): string };
  /**
   * AI 위치 찾기(core/locate.ts) 모델 길(제품: 게이트웨이 selector_repair). 폴백 사슬(core/fallback.ts) 3단계다. 없으면 그 단계만 건너뛴다.
   * 실행 토큰은 decide와 같은 것(runTokenFor)을 쓴다.
   * 같은 길로 예상 밖 화면 판정(page_judge)과 브라우저 에이전트(browser_agent)도 부른다(run/judge.ts, run/browser-agent.ts). 폴백 사슬 5단계다.
   */
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
  /** pick.remember(IR rev v1.3.6): 고른 인증서 이름을 프로필에 저장한다. 없으면 이번 실행 범위에만 둔다. */
  profileWrite?: (field: 'certName', value: string) => Promise<boolean>;
  /** $inputs(H01 RunInputs와 같은 모양). */
  inputs: Record<string, unknown>;
  db: Db;
  ledger: Ledger;
  gates: GateRepo;
  /** 게이트 카드의 readback이 정해진 뒤 예약 키·원장 행 재료를 만든다. card = 승인 카드 id(GATE_CARDS). 그 카드의 재료를 못 만들면 null(게이트를 열지 않는다). */
  history: (rb: Readonly<Record<string, string>>, card: string) => GateHistory | null;
  /** 사람 대기 [직접 발급함]의 X 원장 행 재료(무장 전이라 게이트 actionHash가 없다, RunService가 실행 초안으로 만든다). */
  manualRow: (stepId: string) => ArmRow | null;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  /** 진단 한 줄(engine.log diag, 값 없음·화면 글 가림): 핸드오프 대상의 실제 화면 모양(core/diagnose.ts). 없으면 남기지 않는다. */
  diag?: (code: string, fields: Record<string, string | number | boolean>, data: unknown) => void;
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
  /**
   * 사람 대기 알림(B3): 실행이 끝나지 않고 사람을 기다린다. phase는 진행 표시 단계(login·form·…·sign), code는 까닭.
   * 서명 차례면 phase 'sign', code 'sign.waiting'. RunService가 RunEvent handoff로 낸다. 재개는 command('resume'|'manual').
   */
  handoff?: (h: { phase: string; code?: string; stepId: string | null }) => void;
  /**
   * 사람 입력 포트(금고 비밀 창 등). 없으면 지금처럼 대역(secret은 바로 ttl → 사람 대기로 넘어간다).
   * engine-cert가 금고 비밀 창(D05 §3.5)을 여기 붙인다(B1 로그인 s4, B2 발급 서명 s21 signFlow human:secret).
   */
  human?: HumanPort;
  /** 사람 대기 한 번의 상한(ms, 기본 30분). 시험용. */
  handoffCapMs?: number;
  /** 실행 전체 수명 상한(ms, 대기 포함, 기본 2시간). 시험용. */
  lifetimeMs?: number;
  /** 공동인증서 비밀번호 차례 알림(값 없음, main 안내: mode window = 전용 Chrome 칸에 직접, manual = 홈택스 인증서 창에서 직접 → B3 사람 대기 [다 했어요]). */
  secretEvent?: (e: SecretTurnEvent) => void;
  /** 비밀 차례 TTL(기본 120초, 시험용). */
  secretTtlMs?: number;
}

/** 사람 대기 한 번의 상한(부장 결정 2026-11-11). */
export const HANDOFF_CAP_MS = 30 * 60_000;
/** 실행 전체 수명 상한(대기 포함). 넘으면 사람 대기 중이면 run.handoff_timeout, 서명 차례면 verify(부장 결정 2026-11-11). */
export const RUN_LIFETIME_MS = 2 * 60 * 60_000;
type HandoffCommand = 'resume' | 'manual' | 'stop' | 'cap';

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
  // branch는 조건이 보는 요소를 대상으로 친다(IR rev v1.3.7: s2 머리말 불일치 진단 줄이 남게).
  const on = s.type === 'branch' ? (s as StepOf<'branch'>).on : undefined;
  const condTarget = on && 'textMatches' in on ? on.textMatches.target : on && 'exists' in on ? on.exists : undefined;
  const target = typeof s.target === 'string' ? s.target : s.type === 'wait' && s.for === 'selector' && typeof s.value === 'string' ? s.value : condTarget;
  return { stepId, type: s.type, ...(target ? { target } : {}) };
}

/** H-01 IR 스텝 → 진행 표시 단계(H01 TS 플레이북과 같은 단계 이름, 승인 바·진행 줄이 쓴다). */
export const PHASE_OF: Readonly<Record<string, string>> = {
  s0: 'login', s1: 'login', s2: 'login', s3: 'login', s4: 'login', s5: 'login', s6: 'login', s90: 'login', s91: 'login', s92: 'login', s93: 'login',
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
  /** 입력(fill) 스텝을 시작했다. 로컬 예행 패키지는 이 뒤로 비밀번호를 쓰지 못한다. */
  private formStarted = false;
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
  /** 사람 대기(HandedOff·Paused)에서 명령을 기다리는 중이면 깨우는 함수. */
  private cmdWake: ((c: HandoffCommand) => void) | null = null;
  /** 사람 대기 중인 조율기 상태(manualDone은 HandedOff에서만). */
  private waitingState: RunStateName | null = null;
  /** 비밀 차례 [중지](금고 창 닫기 요청). */
  private readonly secretAbort = new AbortController();
  /** [중지] 전용 신호: 실행기가 진행 중인 화면 대기·재시도 지연을 버리고 멈춘다(core/interp.ts stop). halt(걸쇠)는 쓰지 않는다(걸쇠 코드로 멈춰야 한다). */
  private readonly stopAbort = new AbortController();

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

  /** [중지]. 승인 대기 중이면 게이트를 거부로 닫는다(H01과 같이 gate.denied, 사유 stopped). 사람 대기면 멈춘다. 서명 차례면 verify로 간다(조율기). 금고 비밀 창이 열려 있으면 닫기를 요청한다. */
  stop(): void {
    this.stopRequested = true;
    this.secretAbort.abort();
    if (this.cmdWake) return this.cmdWake('stop');
    if (!this.denyOpenGate('stopped')) this.controller?.abort();
    // 조율기가 중지를 미뤄 둔(pending) 뒤에 끊는다: 실행기가 run.stopped로 멈추면 조율기가 그 중지로 받는다.
    this.stopAbort.abort();
  }

  /** p 또는 [중지] 중 먼저 오는 것. [중지]면 v(버린 p의 뒤늦은 동작은 정책 집행기가 run.stopped로 거부한다). */
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

  /**
   * 서명 없는 로컬 예행 패키지: 입력 스텝을 시작한 뒤의 비밀번호 차례는 금고에 넘기지 않는다(패키지가 비가역 표시를 틀려도 서명 창에 비밀번호가 들어가지 않게).
   * 로그인(s4)은 입력 전이라 그대로 된다. 서명 패키지는 그대로 둔다.
   */
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

  /** 사람을 기다리는 중인가(핸드오프·Paused 대기 또는 서명 차례). RunService가 무장 뒤에도 [중지]를 넘길지 본다. */
  get waiting(): boolean {
    return this.cmdWake !== null || (this.controller?.signTurnOpen ?? false);
  }

  /**
   * 사람 대기 재개 명령(B3). resume = [다 했어요](같은 체크포인트부터, 원장 미종결이면 verify부터; 서명 차례면 버튼을 누르지 않고 verify),
   * manual = [직접 발급함](HandedOff에서만: 원장 observed_manual → 그 X의 verify).
   */
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

  /** 명령·[중지]·상한 중 먼저 오는 것. */
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

  /** 재개할 수 있는 멈춤인가. 게이트 만료·정지 하향·걸쇠(차단 신호 등)는 끝낸다(부장 결정 2026-11-11 ①). */
  private resumable(out: RunOutcome): boolean {
    if (out.state !== 'HandedOff' && out.state !== 'Paused') return false;
    return out.code !== 'gate.expired' && !this.denied && !this.halted && !this.stopRequested;
  }

  /** 엔진 밖 사유의 정지(금고 누출 의심 등). 무장 전에만. 열린 게이트는 거부로 닫는다(사유 signal). */
  halt(code: string): void {
    if (this.armed) return;
    this.secretAbort.abort();
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
    // 실행 사본 사전: AI 위치 찾기로 찾은 선택자를 이 실행 동안만 그 항목 첫 후보로 둔다(서명 패키지 원본은 그대로).
    const dict = runLocalDict(pkg.selectors);
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
    const raw = new PlaywrightActuator({ page, reader, afterNavigation: () => enforcer.settled(), onError: (op, why) => i.journal('actuator.why', { stepId: curStep ?? '', op, ...why }), onBoxClick: (r) => i.journal('actuator.box_click', { stepId: curStep ?? '', ...r }) });
    // 예상 밖 화면 판정(아래에서 만든다). 대화상자 훅과 스텝 경계가 먼저 생겨 이 자리에 둔다.
    let pageJudge: PageJudge | null = null;
    let curStep: string | null = null;
    const act = new GuardedActuator({
      driver: raw, reader, dict, domains, policy: enforcer,
      events: { security: (code, key) => i.journal('security.event', { code, key }), journal: i.journal },
      commitArmed: (k) => this.controller?.commitArmed(k) ?? false, armedConfirm: () => this.controller?.armedConfirm() ?? null, fixtureGrant: i.ir.fixtureGrant ?? null,
      dialogJudge: (kind, notice) => pageJudge?.onDialog(kind, notice) ?? Promise.resolve(null),
    });
    this.actuator = act;
    // IR rev v1.3.6: 패키지가 닫으라고 적은 안내 창(제목 패턴)만 닫는다. 로더(V-01)가 패턴을 이미 확인했다.
    const closeWindows = (ir.closeWindows ?? []).flatMap((k) => {
      try {
        return [compileRe2(files.strings[k]!)];
      } catch {
        return [];
      }
    });
    this.wiring = await wireRun({ page, reader, enforcer, actuator: act, domains, ...(closeWindows.length ? { closeWindows, journal: i.journal } : {}) });

    const p = i.profile;
    const scope = newScope({ inputs: i.inputs, profile: { bizNo: p.bizNo, ...(p.signMethod ? { signMethod: p.signMethod } : {}), ...(p.certName ? { certName: p.certName } : {}) }, intentId: i.intentId });
    // 모델 실행 토큰은 실행마다 한 번 받아 decide와 AI 위치 찾기가 같이 쓴다(L1·L2 예산이 한 토큰에 묶인다).
    let tokenP: Promise<RunToken> | null = null;
    const runToken = (): Promise<RunToken> => {
      tokenP ??= (i.ir.runTokenFor ? i.ir.runTokenFor(i.runId) : Promise.resolve(i.ir.runToken ?? (i.runId as RunToken))).catch((e: unknown) => {
        tokenP = null;
        throw e;
      });
      return tokenP;
    };
    const redactor = new Redactor({ runId: i.runId });
    // 실행당 예산: 게이트웨이가 다 썼다고(run_budget_exceeded) 하면 그 뒤로는 부르지 않는다(헛된 429 호출을 줄인다).
    // 위치 찾기(L2, 실행당 2번)와 판정·에이전트(agentPerRun)는 게이트웨이가 따로 세므로 표시도 따로 둔다.
    const locateBudget = { spent: false };
    const pageAiBudget = { spent: false };
    const locate = i.ir.locate ? { model: new GatewayLocateModel({ responder: i.ir.locate, redactor, runToken, journal: i.journal, budget: locateBudget }), journal: i.journal } : undefined;
    // IR rev v1.3.7 closeLayers: 공지 레이어(X)를 until 스텝(또는 첫 게이트) 전 스텝마다 본다. 해석되면 GuardedActuator로 누른다. 없거나 틀리면 건너뛴다.
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
    // 폴백 사슬: 재시도 뒤 → role·이름 다시 찾기 → AI 위치 찾기 → 체크포인트 재진입 → 사람. 되돌릴 수 있는 스텝만(core/fallback.ts).
    if (i.ir.locate) {
      const port = { responder: i.ir.locate, redactor, runToken, journal: i.journal, budget: pageAiBudget };
      const screen = { page: reader, dict, act, frame: 'main', journal: i.journal };
      const agent = new BrowserAgent({ ...screen, ir, scope, irreversible: analysis.irreversible, model: new GatewayAgentModel(port) });
      pageJudge = new PageJudge({
        ...screen, ir, irreversible: analysis.irreversible, model: new GatewayJudgeModel(port), agent, ...(locate ? { locate } : {}),
        lastNotice: () => act.notice, currentStep: () => curStep,
      });
    }
    const fallback = new FallbackChain({ ir, dict, page: reader, irreversible: analysis.irreversible, ...(locate ? { locate } : {}), ...(pageJudge ? { judge: pageJudge } : {}), journal: i.journal });
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
      journal: i.journal,
    });
    const sv = i.ir.secret;
    // 포털 기본 팝업 숨김(H-01 2.3.2 strings popup.*): 금고에 그대로 넘긴다. 금고가 실행 탭 문서마다 숨기고 새 창은 열리자마자 닫는다.
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
          // 틀린 비밀번호 안내는 홈택스 인증서 창(iframe#dscert, ML4Web) 안에 뜬다: 본 프레임과 그 창의 글자를 함께 본다
          text: async () => {
            const main = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
            const cert = await page.frameLocator(CERT_FRAME_CSS).first().locator('body').innerText({ timeout: 1_000 }).catch(() => '');
            return cert ? `${main}\n${cert}` : main;
          },
          // 인증서 선택창 iframe 요소만 본다(안은 다른 출처라 읽지 않는다).
          certFrame: () => page.locator(CERT_FRAME_CSS).first().isVisible(),
          // 틀린 비밀번호 안내 닫기(인증서 창 경고 [확인], 커밋 아님). 보일 때만 누른다.
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
    const ledgerStates = (): LedgerState[] => {
      const r = i.ledger.get(i.intentId, 's21');
      return r ? [r.state] : [];
    };

    const lifetimeEnd = clock.now() + (i.lifetimeMs ?? RUN_LIFETIME_MS);
    const lifeLeft = () => Math.max(0, lifetimeEnd - clock.now());
    const capMs = i.handoffCapMs ?? HANDOFF_CAP_MS;
    const c = new RunController({
      runId: i.runId, intentId: i.intentId, packageDigest: i.packageDigest, ir, handlers, env,
      // 사람 대기 상한은 IrRun이 센다(Paused도 같은 상한). 조율기 자체 HandedOff 타이머는 그 뒤로 미룬다(이기지 않게).
      handoffTimeoutMs: capMs + 60_000,
      signTurnMs: () => Math.min(capMs, lifeLeft()),
      signTurn: {
        opened: (r) => i.handoff?.({ phase: 'sign', code: 'sign.waiting', stepId: r.stepId }),
        closed: () => {},
      },
      interp: { retries: { stepMax: 3, backoff: 'equal_jitter', baseMs: 800, capMs: 10_000 }, retryFloorMs: 0, escalate: (s, cause) => fallback.eligible(s, cause), stop: this.stopAbort.signal },
      // [중지]면 폴백(AI 위치 찾기·판정·에이전트 모델 호출)을 기다리지 않는다: false를 돌려주면 조율기가 미뤄 둔 중지를 바로 적용한다.
      recover: (stop) => this.orStop(fallback.recover(stop.at, stop.cause ?? stop.code), false),
      // Running 진입 확인(D03 §2)·정지 분기의 Chrome 닫기(hardStop).
      allowed: () => !this.denial(),
      hardStop: () => this.denial()?.hardStop ?? false,
      beforeStep: async (s) => {
        curStep = s.id;
        if (s.type === 'gate' || s.id === ir.closeLayers?.until) layersDone = true;
        if (!layersDone) await closeLayers();
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
        if (name === 'step.started' && d.type === 'fill') this.formStarted = true;
        i.trace?.({ name, stepId: d.stepId, type: d.type, ...(d.code ? { code: d.code } : {}) });
        if (name === 'step.finished' && d.type === 'checkpoint' && !d.code) enforcer.reached();
        // 인증서 비밀번호를 넣은 뒤 로그인 확인(첫 기다림 스텝 결과)을 금고에 알린다: 통과면 그때 기억, 실패면 버리고 지움
        if (name === 'step.finished' && secretPort) void secretPort.stepFinished(d.type, !!d.code, d.stepId);
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
      // 사람 입력 포트: 주입(시험) → 금고가 있으면 CertSecretPort(공동인증서 비밀번호 B1·B2) → 대역(secret은 바로 ttl → 로그인이면 Paused 사람 대기, 발급 서명이면 서명 차례).
      human: this.localGuard(i.human ?? {
        request: () => {},
        // 공동인증서 비밀번호(B1 로그인·B2 발급 서명): 금고 비밀 창 또는 사람 직접 입력 대기(CertSecretPort). 금고가 없으면(시험·가짜 H-01) 곧바로 TTL.
        secret: secretPort ? (r) => secretPort.secret(r) : async () => 'ttl',
        ...(secretPort ? { afterSignConfirm: (r: { runId: string; stepId: string }) => secretPort.afterSignConfirm(r) } : {}),
        closed: () => {},
      }),
      ...(i.secretTtlMs !== undefined ? { secretTtlMs: i.secretTtlMs } : {}),
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
      // 사람 대기(B3): 핸드오프·Paused에서 끝내지 않고 명령을 기다린다. 재개는 조율기 규칙(같은 체크포인트, 토큰 폐기, 원장 미종결이면 verify).
      while (this.resumable(out)) {
        const left = Math.min(capMs, lifeLeft());
        const phase = PHASE_OF[out.at ?? ''] ?? 'login';
        this.waitingState = out.state;
        // 사람에게 넘긴 이유를 엔진 로그에도 남긴다(runs.ts가 run.handoff를 engine.log로 옮긴다): 코드·대상 셀렉터 키·거친 폴백 단계. 값·화면 글 없음.
        const at = stoppedAtOf(ir, out.at ?? null);
        i.journal('run.handoff', { stepId: out.at ?? '', state: out.state, code: out.code ?? '', ...(at?.target ? { target: at.target } : {}), ...(out.at ? { fallback: fallback.tried(out.at) } : {}) });
        // 대상을 못 찾았거나(시간 초과 포함) 이름·역할이 달라 넘겼으면 그 대상의 실제 화면 모양을 남긴다(값 없음, 10초 안에 못 읽으면 건너뜀).
        if (i.diag && at?.target && (out.code === 'step.identity_mismatch' || out.code === 'step.selector_miss' || out.code === 'step.timeout')) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const d = await Promise.race([targetDiagnosis(reader, dict, at.target).catch(() => null), new Promise<null>((r) => (timer = setTimeout(() => r(null), 10_000)))]).finally(() => clearTimeout(timer));
          i.diag('run.handoff_target', { stepId: out.at ?? '', code: out.code, target: at.target, read: !!d }, d);
        }
        // readback은 대상이 칸 여럿이라 위 한 줄이 없다: 해석이 안 되는 칸마다 같은 진단 줄을 남긴다(field = fieldKey, 값 없음).
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
        if (cmd === 'stop') {
          c.abort();
          out = { state: c.state.name, at: out.at, code: 'run.aborted' };
          break;
        }
        if (cmd === 'cap') {
          // 상한: 멈춘 그대로 끝낸다(status handoff). 원장이 열려 있으면 RunService가 in_doubt로 닫는다.
          i.journal('run.handoff_timeout', { stepId: out.at ?? '' });
          out = { ...out, code: 'run.handoff_timeout' };
          break;
        }
        i.journal('run.resumed', { stepId: out.at ?? '', how: cmd });
        out = cmd === 'manual' ? await c.attestManualCommit() : await c.resume();
      }
    } finally {
      // E2: 끝난 실행에 조율기 타이머(HandedOff 상한)가 남지 않게.
      c.dispose();
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
