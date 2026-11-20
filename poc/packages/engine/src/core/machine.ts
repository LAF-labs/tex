import type { LedgerState } from '@sax/db';

export const RUN_STATES = [
  'Unloaded', 'Loaded', 'Preparing', 'Running', 'WaitingGate', 'WaitingHuman', 'Recovering', 'HandedOff', 'Paused', 'Interrupted', 'InDoubt',
  'Completed', 'CompletedWithIssues', 'Failed', 'Aborted',
] as const;
export type RunStateName = (typeof RUN_STATES)[number];
export const TERMINAL_STATES: ReadonlySet<RunStateName> = new Set(['Completed', 'CompletedWithIssues', 'Failed', 'Aborted']);

export interface RunState {
  name: RunStateName;
  commit: boolean;
  reverify: boolean;
  pendingDowngrade: boolean;
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
  allowed: boolean;
  ledger: readonly LedgerState[];
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

function enterRunning(ctx: MachineCtx, effects: string[], o: Partial<Omit<RunState, 'name'>> = {}, onDeny: string[] = []): Transition {
  if (!ctx.allowed) return stopTo(ctx, [...onDeny, 'tokens.discard', 'checkpoint.save']);
  return to(state('Running', o), effects);
}

export function transition(st: RunState, ev: RunEvent, ctx: MachineCtx): Transition {
  const n = st.name;
  if (TERMINAL_STATES.has(n)) return illegal;

  if (ev.t === 'restart') {
    const effects = ['ledger.promote_in_doubt', 'gates.expire_open', 'tokens.discard'];
    if (ctx.ledger.some((s) => UNRESOLVED.has(s))) return to(state('InDoubt'), effects);
    return to(state(n === 'Paused' ? 'Paused' : 'Interrupted'), effects);
  }
  if (ev.t === 'abort') {
    if (st.commit) return to({ ...st, pendingAbort: true }, ['abort.after_verify', 'ui.notify:reject_portal_push']);
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
          return to(state('WaitingGate'), ['pre_safety_check', 'verify.baseline', 'dup.portal_existing', 'card.from_readback', 'input.lock', 'gate.request_publish']);
        case 'human_reached':
          return to(state('WaitingHuman'), ['tokens.discard']);
        case 'step_failed':
          return to(state('Recovering'), ['tokens.discard']);
        case 'enter_commit':
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
          if (ctx.ledger.includes('committed')) return to(state('CompletedWithIssues'), ['input.unlock', 'ui.fixed:issued_do_not_rerun']);
          return ev.then === 'handoff' ? to(state('HandedOff'), ['input.unlock', 'ui.banner:handoff_manual_commit']) : to(state('Failed'), ['input.unlock']);
        case 'downgrade':
          return stopTo(ctx, ['tokens.discard', 'input.unlock', 'checkpoint.save']);
        default:
          return illegal;
      }

    case 'HandedOff':
      switch (ev.t) {
        case 'observed_commit':
          return to(st, ['ledger.observed_manual', 'journal:ledger.observed_manual']);
        case 'attest_manual_commit':
          if (st.pendingDowngrade) return stopTo(ctx, ['ledger.observed_manual', 'slot.release']);
          return enterRunning(ctx, ['ledger.observed_manual', 'verify.run'], { reverify: true }, ['ledger.observed_manual', 'slot.release']);
        case 'handoff_resume':
          if (st.pendingDowngrade) return stopTo(ctx, ['slot.release', 'checkpoint.save']);
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
      if (!ev.samePackageDigest) return { ok: false, code: 'engine.restart_only' };
      return enterRunning(ctx, ['checkpoint.restore', 'ui.check:issue_date_changed'], {}, []);

    case 'InDoubt':
      if (ev.t !== 'indoubt_resolved') return idle(st, ev);
      {
        const rec = `ledger.${ev.result}`;
        if (!ctx.allowed) return stopTo(ctx, [rec]);
        return to(state('Running'), [rec, ev.result === 'committed' ? 'goto.post_steps' : 'rewind.pre_gate']);
      }
  }
  return illegal;
}

function idle(st: RunState, ev: RunEvent): Transition {
  return ev.t === 'downgrade' ? to(st) : illegal;
}

function inDoubt(st: RunState, ctx: MachineCtx, effects: string[]): Transition {
  const hard = st.pendingDowngrade && ctx.hardStop ? ['ui.notify:downgrade', 'chrome.close'] : [];
  return to(state('InDoubt'), [...effects, 'tokens.discard', ...hard]);
}

function commitSection(st: RunState, ev: RunEvent, ctx: MachineCtx): Transition {
  const leave = (t: Transition & { ok: true }): Transition => {
    const stopped = () => [...t.effects.filter((e) => e !== 'token.issue_followup'), 'tokens.discard'];
    if (st.pendingAbort && t.state.name !== 'InDoubt') return to(state('Aborted'), stopped());
    if (st.pendingDowngrade && t.state.name === 'Running') return stopTo(ctx, [...stopped(), 'checkpoint.save']);
    if (st.pendingDowngrade && t.state.name === 'HandedOff') return to({ ...t.state, pendingDowngrade: true }, t.effects);
    return t;
  };
  switch (ev.t) {
    case 'pre_dispatch_mismatch':
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
      return to({ ...st, pendingDowngrade: true });
    default:
      return illegal;
  }
}
