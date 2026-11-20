import type { ArmRow, GateRepo, Ledger, RunRepo } from '@sax/db';
import { SECURITY_REJECTIONS, type GateToken, type GateTokens, type TokenRejection } from './token.ts';
import type { StepOf } from './types.ts';

export interface GateDecisionInput {
  reqId: string;
  decision: 'approved' | 'denied';
  by: string;
  gateStepId: string;
  actionHash: string;
  stepId: string;
  approvedAt: number;
  commitWindowMs: number;
  wmaxMs: number;
}

export type GateDecision = { won: true; decision: 'approved'; token: GateToken } | { won: true; decision: 'denied' } | { won: false };

/** R-G8: 먼저 도착한 결정만 효과가 있다. 진 결정은 won:false(실행기는 거부만 기록한다). */
export function decideGate(gates: Pick<GateRepo, 'decide'>, tokens: GateTokens, d: GateDecisionInput): GateDecision {
  if (!gates.decide(d.reqId, d.decision, d.by)) return { won: false };
  if (d.decision === 'denied') return { won: true, decision: 'denied' };
  const token = tokens.issue({ gateStepId: d.gateStepId, actionHash: d.actionHash, stepId: d.stepId, approvedAt: d.approvedAt, commitWindowMs: d.commitWindowMs, wmaxMs: d.wmaxMs });
  return { won: true, decision: 'approved', token };
}

const LEDGER_CODE = /^(?:gate_not_approved|ledger_[a-z_]+)$/;
export function ledgerRejection(e: unknown): string | null {
  if (!(e instanceof Error)) return null;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string' && LEDGER_CODE.test(code) && e.message === code ? code : null;
}

export type ArmResult = { ok: true } | { ok: false; code: string; security: boolean };

/**
 * R-G7 앞 두 단계. 실패하면 클릭하지 않는다. 보안 이벤트(security:true)는 위조·다른 실행·이미 소비된 토큰과
 * 토큰과 원장 행이 서로 다른 의도를 가리킬 때뿐이다. 원장 쪽 거절(이미 행이 있음·게이트가 approved 아님)은 보안 이벤트가 아니다.
 */
export function armForCommit(ledger: Pick<Ledger, 'consumeAndArm'>, tokens: GateTokens, p: { reqId: string; token: GateToken; row: ArmRow; gateStepId: string; now: number }): ArmResult {
  const want = { gateStepId: p.gateStepId, actionHash: p.row.actionHash, stepId: p.row.stepId };
  const bad: TokenRejection | null = tokens.check(p.token, want, p.now);
  if (bad) return { ok: false, code: `token.${bad}`, security: SECURITY_REJECTIONS.has(bad) };
  if (p.row.runId !== tokens.runId) return { ok: false, code: 'token.other_run', security: true };
  try {
    ledger.consumeAndArm(p.reqId, p.row);
  } catch (e) {
    const code = ledgerRejection(e);
    if (code) return { ok: false, code, security: false };
    throw e;
  }
  const c = tokens.consume(p.token, want, p.now);
  if (c) throw new Error(`token_consume_after_arm:${c}`);
  return { ok: true };
}

export interface RestartReport {
  promotedInDoubt: number;
  expiredGates: number;
  interruptedRuns: number;
}

/**
 * 기동 시 복원(D03 §2 '프로세스 재시작', D-45): 저널 재생이 아니라 테이블 상태 승격이다. 원장을 먼저 올려
 * 미종결 비가역이 재개 가능한 상태로 남지 않게 한 뒤 게이트·실행을 닫는다. 그 in_doubt를 발급목록 조회로 확정하는 것은 run.reverify(run/reverify.ts)다. 데스크톱이 기동 뒤·실행 끝 뒤에 부른다.
 */
export function recoverAfterRestart(db: { ledger: Pick<Ledger, 'promoteInDoubt'>; gates: Pick<GateRepo, 'expireOpen'>; runs: Pick<RunRepo, 'interruptRunning'> }): RestartReport {
  const promotedInDoubt = db.ledger.promoteInDoubt();
  const expiredGates = db.gates.expireOpen();
  const interruptedRuns = db.runs.interruptRunning();
  return { promotedInDoubt, expiredGates, interruptedRuns };
}

export interface ReentryProbe {
  expect(): Promise<boolean>;
  navigate(url: string): Promise<void>;
  loggedIn(): Promise<boolean>;
}

export type ReentryOutcome = 'resumed' | 'escalate_session' | 'handoff';

/**
 * D03 §5.5 체크포인트 복귀. 복귀는 토큰을 폐기한다(R-G2). reload면 항상 url로 새로 로드한 뒤 expect, reuse(기본)면 현재 탭에서
 * expect → 거짓이면 url로 이동 후 재평가. sessionRequired인데 로그아웃이면 session 체크포인트로 상향. session 체크포인트는 로그아웃이어도
 * 이어 간다(v1.3.7: 뒤 스텝이 자동 로그인). expect가 거짓이면 호출자가 핸드오프.
 */
export async function reenterCheckpoint(cp: StepOf<'checkpoint'>, probe: ReentryProbe, tokens: Pick<GateTokens, 'discardAll'>): Promise<ReentryOutcome> {
  tokens.discardAll('checkpoint_return');
  if (cp.sessionRequired && cp.name !== 'session' && !(await probe.loggedIn())) return 'escalate_session';
  const mode = cp.reentry ?? 'reuse';
  if (mode === 'reload') {
    if (!cp.url) return 'handoff';
    await probe.navigate(cp.url);
    return (await probe.expect()) ? 'resumed' : 'handoff';
  }
  if (await probe.expect()) return 'resumed';
  if (!cp.url) return 'handoff';
  await probe.navigate(cp.url);
  return (await probe.expect()) ? 'resumed' : 'handoff';
}
