// D03 §2 실행 상태와 전이표(순수 함수). 부수효과는 코드 목록으로만 돌려주고 실행기가 그 순서대로 집행한다(M2-x).
// 규칙(§2 '규칙'):
// - WaitingGate → Running은 승인 이벤트(와 "수정하기"의 게이트 앞 되감기)로만.
// - Running으로 들어가는 모든 전이는 실효 수준·killPlaybooks를 확인하고(Running 진입 확인), 허용하지 않으면 정지 분기로 간다.
// - 정지 분기는 그 실행의 원장 행 상태로 정한다: 미종결(armed·dispatched·observed_manual·in_doubt) → InDoubt, committed → CompletedWithIssues,
//   그 밖 → Paused(policy_downgrade)(ADR-023 결정 6).
// - 커밋 구간(토큰 소비 ~ verify 완료) 안에서는 하향·abort를 미뤘다가 verify 결과를 원장에 기록한 뒤 적용한다(§5.3).
import type { LedgerState } from '@sax/db';

export const RUN_STATES = [
  'Unloaded', 'Loaded', 'Preparing', 'Running', 'WaitingGate', 'WaitingHuman', 'Recovering', 'HandedOff', 'Paused', 'Interrupted', 'InDoubt',
  'Completed', 'CompletedWithIssues', 'Failed', 'Aborted',
] as const;
export type RunStateName = (typeof RUN_STATES)[number];
export const TERMINAL_STATES: ReadonlySet<RunStateName> = new Set(['Completed', 'CompletedWithIssues', 'Failed', 'Aborted']);

export interface RunState {
  name: RunStateName;
  /** Running(commit section): 토큰 소비 ~ verify 완료. */
  commit: boolean;
  /** Running이지만 다음 일은 그 X의 verify(핸드오프 재개 시 원장 in_doubt, "직접 발급함"). 토큰 없음. */
  reverify: boolean;
  /** 사람 차례·커밋 구간 중에 온 정지 하향(차례·구간이 끝나면 정지 분기). */
  pendingDowngrade: boolean;
  /** 커밋 구간 중에 온 abort(verify 뒤 Aborted, 상한 120초 초과 시 InDoubt). */
  pendingAbort: boolean;
}

export const state = (name: RunStateName, o: Partial<Omit<RunState, 'name'>> = {}): RunState => ({ name, commit: false, reverify: false, pendingDowngrade: false, pendingAbort: false, ...o });
export const initialState = (): RunState => state('Unloaded');

export type VerifyResult = 'committed' | 'not_committed' | 'unknown';

export type RunEvent =
  | { t: 'load' }
  | { t: 'start'; intentReuse: boolean }
  | { t: 'precondition_failed' }
  | { t: 'prepared' }
  | { t: 'gate_reached' }
  | { t: 'gate_approved' }
  | { t: 'gate_denied' }
  | { t: 'gate_edit' }
  | { t: 'gate_timeout' }
  | { t: 'human_reached' }
  | { t: 'human_input' }
  | { t: 'human_ttl' }
  | { t: 'step_failed' }
  | { t: 'recovered' }
  | { t: 'recovery_failed'; then: 'handoff' | 'fail' }
  | { t: 'observed_commit' }
  | { t: 'attest_manual_commit' }
  | { t: 'handoff_resume'; ledgerInDoubt: boolean }
  | { t: 'handoff_timeout' }
  | { t: 'enter_commit' }
  | { t: 'pre_dispatch_mismatch' }
  | { t: 'identity_mismatch' }
  | { t: 'click_returned' }
  | { t: 'verify'; result: VerifyResult }
  | { t: 'verify_timeout' }
  | { t: 'indoubt_resolved'; result: 'committed' | 'not_committed' }
  | { t: 'all_done' }
  | { t: 'post_commit_failed' }
  | { t: 'end_with_issues' }
  | { t: 'resume'; samePackageDigest: boolean }
  | { t: 'downgrade' }
  | { t: 'abort' }
  | { t: 'abort_timeout' }
  | { t: 'restart' };

export interface MachineCtx {
  /** 지금 실효 수준(§12)이 이 플레이북 실행을 허용하고 killPlaybooks에 없는가. */
  allowed: boolean;
  /** 이 실행의 모든 원장 행 상태(정지 분기). 이 전이가 기록하는 결과는 실행기가 먼저 반영한 값이다. */
  ledger: readonly LedgerState[];
  /** 새 실효 수준이 postprocess이거나 kill이다(자동화 Chrome을 닫는다). */
  hardStop?: boolean;
}

export type Transition = { ok: true; state: RunState; effects: string[] } | { ok: false; code: 'engine.illegal_transition' | 'engine.restart_only' };

const UNRESOLVED: ReadonlySet<LedgerState> = new Set(['armed', 'dispatched', 'observed_manual', 'in_doubt']);

/** 정지 분기(ADR-023 결정 6): 위에서부터 처음 맞는 것. */
export function stopBranch(ledger: readonly LedgerState[]): { name: 'InDoubt' | 'CompletedWithIssues' | 'Paused'; effects: string[] } {
  if (ledger.some((s) => UNRESOLVED.has(s))) return { name: 'InDoubt', effects: [] };
  if (ledger.includes('committed')) return { name: 'CompletedWithIssues', effects: ['ui.fixed:issued_finish_pdf_email_manually'] };
  return { name: 'Paused', effects: ['journal:run.paused{policy_downgrade}'] };
}

const illegal: Transition = { ok: false, code: 'engine.illegal_transition' };
const to = (s: RunState, effects: string[] = []): Transition => ({ ok: true, state: s, effects });

function stopTo(ctx: MachineCtx, effects: string[]): Transition {
  const b = stopBranch(ctx.ledger);
  return to(state(b.name), [...effects, ...(ctx.hardStop ? ['ui.notify:downgrade', 'chrome.close'] : []), ...b.effects]);
}

/**
 * Running 진입 확인(ADR-023 결정 6). 허용하지 않으면 토큰 폐기·체크포인트 저장 뒤 정지 분기.
 * onDeny는 거부돼도 해야 하는 정리 효과만(성공 효과는 내지 않는다).
 */
function enterRunning(ctx: MachineCtx, effects: string[], o: Partial<Omit<RunState, 'name'>> = {}, onDeny: string[] = []): Transition {
  if (!ctx.allowed) return stopTo(ctx, [...onDeny, 'tokens.discard', 'checkpoint.save']);
  return to(state('Running', o), effects);
}

export function transition(st: RunState, ev: RunEvent, ctx: MachineCtx): Transition {
  const n = st.name;
  if (TERMINAL_STATES.has(n)) return illegal;

  // ---- 어느 비종료 상태에서나 ----
  if (ev.t === 'restart') {
    // 재시작 복원은 저널 재생이 아니라 원장·게이트·실행 테이블 승격(D-45). armed·dispatched·observed_manual → in_doubt → InDoubt.
    // Paused는 디스크에 직렬화된 쉬는 상태라 그대로 둔다(policy_downgrade 사유 보존).
    const effects = ['ledger.promote_in_doubt', 'gates.expire_open', 'tokens.discard'];
    if (ctx.ledger.some((s) => UNRESOLVED.has(s))) return to(state('InDoubt'), effects);
    return to(state(n === 'Paused' ? 'Paused' : 'Interrupted'), effects);
  }
  if (ev.t === 'abort') {
    if (st.commit) return to({ ...st, pendingAbort: true }, ['abort.after_verify', 'ui.notify:reject_portal_push']);
    // WaitingGate에서 중지하면 gate_requests 행도 닫는다(뒤늦은 승인이 토큰을 만들지 못하게, R-G8).
    // HandedOff에서 중지하면 포털 동시 실행 슬롯도 놓는다.
    return to(state('Aborted'), [...(n === 'WaitingGate' ? ['gate.cancel'] : []), ...(n === 'HandedOff' ? ['slot.release'] : []), 'tokens.discard', 'input.unlock', 'ui.notify:reject_portal_push']);
  }

  switch (n) {
    case 'Unloaded':
      return ev.t === 'load' ? to(state('Loaded')) : illegal;

    case 'Loaded':
      if (ev.t !== 'start') return idle(st, ev);
      if (ev.intentReuse) return to(state('Failed'), ['security:ledger.intent_reuse']);
      return to(state('Preparing'), ['intent.create_or_receive', 'inputs.defaults', 'inputs_hash']);

    case 'Preparing':
      if (ev.t === 'precondition_failed') return to(state('Failed'));
      if (ev.t === 'prepared') return enterRunning(ctx, ['journal:run.started']);
      return idle(st, ev);

    case 'Running':
      if (st.commit) return commitSection(st, ev, ctx);
      if (st.reverify) return reverify(st, ev, ctx);
      switch (ev.t) {
        case 'gate_reached':
          // 진입 전(W 밖): 사전 안전 판정, verify 기준선 B₀, $dup.portalExisting. 진입 시: 카드 = readback 값, 입력 잠금(R-G6), 승인 요청 발행.
          return to(state('WaitingGate'), ['pre_safety_check', 'verify.baseline', 'dup.portal_existing', 'card.from_readback', 'input.lock', 'gate.request_publish']);
        case 'human_reached':
          return to(state('WaitingHuman'), ['tokens.discard']);
        case 'step_failed':
          return to(state('Recovering'), ['tokens.discard']);
        case 'enter_commit':
          // R-G7: 토큰 검증 → 원장 armed + 토큰 소비(한 트랜잭션) → readback 재계산 → 가드 무장 → 클릭
          return to(state('Running', { commit: true }), ['token.verify', 'ledger.arm+token.consume', 'readback.recompute', 'commit_guard.arm', 'click']);
        case 'all_done':
          return to(state('Completed'));
        case 'post_commit_failed':
        case 'end_with_issues':
          return to(state('CompletedWithIssues'), ['ui.fixed:issued_do_not_rerun']);
        case 'downgrade':
          return stopTo(ctx, ['tokens.discard', 'input.unlock', 'checkpoint.save']);
        default:
          return illegal;
      }

    case 'WaitingGate':
      switch (ev.t) {
        case 'gate_approved':
          // gate_requests open → approved 원자 전이가 성공한 뒤에만 토큰 발급(R-G8). 진입 확인에 걸리면 토큰을 만들지 않고 게이트를 닫는다.
          return enterRunning(ctx, ['token.issue'], {}, ['gate.cancel', 'input.unlock', 'rewind.pre_gate']);
        case 'gate_denied':
          return to(state('Aborted'), ['input.unlock']);
        case 'gate_edit':
          return enterRunning(ctx, ['gate.cancel', 'input.unlock', 'tokens.discard', 'rewind.pre_gate'], {}, ['gate.cancel', 'input.unlock', 'rewind.pre_gate']);
        case 'gate_timeout':
          return to(state('Paused'), ['gate.expire', 'input.unlock', 'tokens.discard', 'rewind.pre_gate', 'checkpoint.save']);
        case 'downgrade':
          return stopTo(ctx, ['gate.expire', 'tokens.discard', 'input.unlock', 'rewind.pre_gate', 'checkpoint.save']);
        default:
          return illegal;
      }

    case 'WaitingHuman':
      switch (ev.t) {
        case 'human_input':
          return st.pendingDowngrade ? stopTo(ctx, ['checkpoint.save']) : enterRunning(ctx, []);
        case 'human_ttl':
          return st.pendingDowngrade ? stopTo(ctx, ['rewind.checkpoint', 'checkpoint.save']) : to(state('Paused'), ['rewind.checkpoint', 'checkpoint.save']);
        case 'downgrade':
          return to({ ...st, pendingDowngrade: true }, ['ui.banner:downgrade_after_turn']);
        default:
          return illegal;
      }

    case 'Recovering':
      switch (ev.t) {
        case 'recovered':
          return enterRunning(ctx, ['step.rerun_failed']);
        case 'recovery_failed':
          return ev.then === 'handoff' ? to(state('HandedOff'), ['ui.banner:handoff_manual_commit']) : to(state('Failed'));
        case 'downgrade':
          return stopTo(ctx, ['tokens.discard', 'input.unlock', 'checkpoint.save']);
        default:
          return illegal;
      }

    case 'HandedOff':
      switch (ev.t) {
        case 'observed_commit':
          // R-C2: 가드가 커밋 요청을 관측 → 원장 observed_manual(→ in_doubt), ledger.observed_manual
          return to(st, ['ledger.observed_manual', 'journal:ledger.observed_manual']);
        case 'attest_manual_commit':
          if (st.pendingDowngrade) return stopTo(ctx, ['ledger.observed_manual', 'slot.release']);
          return enterRunning(ctx, ['ledger.observed_manual', 'verify.run'], { reverify: true }, ['ledger.observed_manual', 'slot.release']);
        case 'handoff_resume':
          if (st.pendingDowngrade) return stopTo(ctx, ['slot.release', 'checkpoint.save']);
          // 원장이 in_doubt이면 resumeAt 대신 verify 먼저. 토큰은 이미 폐기됨. 진입 확인에 걸려 멈추면 포털 슬롯을 놓는다.
          return ev.ledgerInDoubt ? enterRunning(ctx, ['verify.run'], { reverify: true }, ['slot.release']) : enterRunning(ctx, ['resume_at'], {}, ['slot.release']);
        case 'handoff_timeout':
          return st.pendingDowngrade ? stopTo(ctx, ['slot.release', 'checkpoint.save']) : to(state('Paused'), ['slot.release', 'checkpoint.save']);
        case 'downgrade':
          return to({ ...st, pendingDowngrade: true }, ['ui.banner:downgrade_after_turn']);
        default:
          return illegal;
      }

    case 'Paused':
    case 'Interrupted':
      if (ev.t !== 'resume') return idle(st, ev);
      // 같은 package_digest일 때만 재개, 아니면 '다시 시작'만. 토큰·runKey는 직렬화하지 않으므로 재개하면 재게이트된다.
      if (!ev.samePackageDigest) return { ok: false, code: 'engine.restart_only' };
      return enterRunning(ctx, ['checkpoint.restore', 'ui.check:issue_date_changed'], {}, []);

    case 'InDoubt':
      if (ev.t !== 'indoubt_resolved') return idle(st, ev);
      {
        // 해소 결과를 원장에 먼저 기록한 뒤 Running 진입 확인(ctx.ledger는 기록 뒤 값). 정지 하향 뒤의 해소도 같은 순서라
        // Running으로 가지 않고 이 건 때문에 InDoubt로 되돌아가지도 않는다.
        const rec = `ledger.${ev.result}`;
        if (!ctx.allowed) return stopTo(ctx, [rec]);
        return to(state('Running'), [rec, ev.result === 'committed' ? 'goto.post_steps' : 'rewind.pre_gate']);
      }
  }
  return illegal;
}

/** 쉬는 상태(Loaded·Preparing·Paused·Interrupted·InDoubt)의 하향은 기록만 하고 상태를 바꾸지 않는다(재개·해소 때 진입 확인이 막는다). */
function idle(st: RunState, ev: RunEvent): Transition {
  return ev.t === 'downgrade' ? to(st) : illegal;
}

/** verify가 결론을 못 내 InDoubt로 갈 때도 미뤄 둔 정지 하향(postprocess·kill)이면 자동화 Chrome을 닫고 알린다. 토큰은 폐기. */
function inDoubt(st: RunState, ctx: MachineCtx, effects: string[]): Transition {
  const hard = st.pendingDowngrade && ctx.hardStop ? ['ui.notify:downgrade', 'chrome.close'] : [];
  return to(state('InDoubt'), [...effects, 'tokens.discard', ...hard]);
}

/** 커밋 구간: L1·L2·핸드오프·모델 호출 없음, 새 정책 값 없음, 실패는 곧바로 verify(§5.3). */
function commitSection(st: RunState, ev: RunEvent, ctx: MachineCtx): Transition {
  // verify가 끝나 구간을 나갈 때 미뤄 둔 abort·하향을 적용한다. 원장은 이미 기록됐다.
  const leave = (t: Transition & { ok: true }): Transition => {
    // 중지·정지로 빠지면 사후 스텝이 없으므로 후속 토큰을 만들지 않고 남은 토큰은 폐기한다.
    const stopped = () => [...t.effects.filter((e) => e !== 'token.issue_followup'), 'tokens.discard'];
    if (st.pendingAbort && t.state.name !== 'InDoubt') return to(state('Aborted'), stopped());
    if (st.pendingDowngrade && t.state.name === 'Running') return stopTo(ctx, [...stopped(), 'checkpoint.save']);
    if (st.pendingDowngrade && t.state.name === 'HandedOff') return to({ ...t.state, pendingDowngrade: true }, t.effects);
    return t;
  };
  switch (ev.t) {
    case 'pre_dispatch_mismatch':
      // 클릭하지 않음. 보안 이벤트 아님. 게이트 앞으로.
      return leave({ ok: true, state: state('Running'), effects: ['ledger.not_committed{pre_dispatch_mismatch}', 'input.unlock', 'rewind.pre_gate'] });
    case 'identity_mismatch':
      return leave({ ok: true, state: state('HandedOff'), effects: ['ledger.not_committed{identity_mismatch}', 'input.unlock', 'journal:step.identity_mismatch'] });
    case 'click_returned':
      return to(st, ['ledger.dispatched']);
    case 'step_failed':
      return to(st, ['verify.run']);
    case 'verify':
      if (ev.result === 'committed') return leave({ ok: true, state: state('Running'), effects: ['ledger.committed{verify_ref}', 'token.issue_followup', 'input.unlock'] });
      if (ev.result === 'not_committed') return leave({ ok: true, state: state('Running'), effects: ['ledger.not_committed{verify}', 'input.unlock', 'rewind.pre_gate'] });
      return inDoubt(st, ctx, ['ledger.in_doubt', 'input.unlock']);
    case 'verify_timeout':
    case 'abort_timeout':
      return inDoubt(st, ctx, ['ledger.in_doubt', 'input.unlock']);
    case 'downgrade':
      return to({ ...st, pendingDowngrade: true });
    default:
      return illegal;
  }
}

/** 핸드오프 뒤 verify 먼저(§2 HandedOff 재개): committed → 사후 스텝, not_committed → 게이트 앞, unknown → InDoubt. */
function reverify(st: RunState, ev: RunEvent, ctx: MachineCtx): Transition {
  switch (ev.t) {
    case 'verify': {
      if (ev.result === 'unknown') return inDoubt(st, ctx, ['ledger.in_doubt']);
      const rec = ev.result === 'committed' ? 'ledger.committed{verify_ref}' : 'ledger.not_committed{verify}';
      if (st.pendingDowngrade || !ctx.allowed) return stopTo(ctx, [rec]);
      return to(state('Running'), [rec, ev.result === 'committed' ? 'goto.post_steps' : 'rewind.pre_gate']);
    }
    case 'verify_timeout':
      return inDoubt(st, ctx, ['ledger.in_doubt']);
    case 'downgrade':
      // verify는 조회만이라 끝까지 돌리고 결과를 원장에 쓴 뒤 정지 분기(비가역 없음).
      return to({ ...st, pendingDowngrade: true });
    default:
      return illegal;
  }
}
