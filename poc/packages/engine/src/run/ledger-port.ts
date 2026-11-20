import { LedgerError, type ArmRow, type Db, type Ledger, type NotCommittedReason } from '@sax/db';
import type { ArmInput } from '../commitguard/guard.ts';
import { flatten } from '../core/cfg.ts';
import type { ActResult } from '../core/page.ts';
import type { Effect, PlaybookIR, SelectorDict } from '../core/types.ts';
import type { CommitPort } from './controller.ts';

export interface LedgerPortInput {
  db: Db;
  ledger: Ledger;
  intentId: string;
  ir: PlaybookIR;
  dict: SelectorDict;
  row(x: { stepId: string; reqId: string; actionHash: string }): ArmRow | null;
  manualRow(stepId: string): ArmRow | null;
  inTx?: () => ActResult;
  guard?: { arm(a: ArmInput): Promise<ActResult>; disarm(): Promise<void> };
  pageUrl(): string;
  verifyRef(verifyStepId: string): string | null;
  baseline?(verifyStepId: string): ReadonlySet<string> | undefined;
  journal(type: string, payload?: Record<string, string | number | boolean>): void;
}

class TxRefused extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class LedgerCommitPort implements CommitPort {
  private readonly i: LedgerPortInput;
  private readonly targetOf = new Map<string, string>();
  private readonly xsOfVerify = new Map<string, string[]>();
  private readonly verifyOf = new Map<string, string>();
  private readonly ledgerStepOf = new Map<string, string>();

  constructor(i: LedgerPortInput) {
    this.i = i;
    for (const [id, { step }] of flatten(i.ir.steps).info) {
      if (step.type === 'submit') this.targetOf.set(id, step.target);
      if (step.type === 'submit' || step.type === 'send_email') {
        this.xsOfVerify.set(step.verify, [...(this.xsOfVerify.get(step.verify) ?? []), id]);
        this.verifyOf.set(id, step.verify);
      }
    }
  }

  arm(a: { stepId: string; reqId: string; actionHash: string }): ActResult {
    const draft = this.i.row(a);
    if (!draft || draft.intentId !== this.i.intentId || draft.stepId !== a.stepId || draft.actionHash !== a.actionHash) return { ok: false, code: 'ledger.row_missing' };
    const v = this.verifyOf.get(a.stepId);
    const b0 = v ? this.i.baseline?.(v) : undefined;
    const row: ArmRow = { ...draft, baselineRefs: b0 ? [...b0] : null };
    try {
      this.i.db.transaction(() => {
        const c = this.i.inTx?.() ?? { ok: true };
        if (!c.ok) throw new TxRefused(c.code);
        this.i.ledger.consumeAndArm(a.reqId, row);
      })();
    } catch (e) {
      if (e instanceof TxRefused) return { ok: false, code: e.code };
      return { ok: false, code: e instanceof LedgerError ? e.code : 'ledger.error' };
    }
    this.ledgerStepOf.delete(a.stepId);
    return { ok: true };
  }

  async armGuard(a: { stepId: string; armedUntil: number }): Promise<ActResult> {
    if (!this.i.guard) return { ok: true };
    const effect = this.effectOf(a.stepId);
    if (!effect) return { ok: false, code: 'commit_guard.arm_refused' };
    return this.i.guard.arm({ intentId: this.i.intentId, stepId: a.stepId, effect, armedUntil: a.armedUntil, pageUrl: this.i.pageUrl() });
  }

  async disarmGuard(): Promise<void> {
    await this.i.guard?.disarm();
  }

  ledgerEffect(effect: string, at: string | null): boolean {
    const m = /^ledger\.(dispatched|committed|not_committed|in_doubt|observed_manual)(?:\{([a-z_]+)\})?$/.exec(effect);
    if (!m) return false;
    const [, kind, arg] = m;
    const xs = at ? (this.xsOfVerify.get(at) ?? [at]) : [];
    if (!xs.length) {
      this.i.journal('ledger.effect_unbound', { effect: kind! });
      return true;
    }
    if (xs.length > 1) {
      this.closeAmbiguous(xs, kind!);
      return true;
    }
    const x0 = xs[0]!;
    const x = this.ledgerStepOf.get(x0) ?? x0;
    try {
      let step = x;
      if (kind === 'observed_manual') {
        const row = this.i.manualRow(x0);
        if (!row) throw new LedgerError('ledger.row_missing');
        step = this.i.ledger.attestManual(row);
        if (step !== x0) this.ledgerStepOf.set(x0, step);
      } else if (kind === 'dispatched') this.i.ledger.dispatched(this.i.intentId, x);
      else if (kind === 'committed') this.i.ledger.resolve(this.i.intentId, x, 'committed', null, at && at !== x0 ? this.i.verifyRef(at) : null);
      else if (kind === 'not_committed') this.i.ledger.resolve(this.i.intentId, x, 'not_committed', (arg ?? 'verify') as NotCommittedReason, null);
      else this.i.ledger.resolve(this.i.intentId, x, 'in_doubt');
      this.i.journal(`ledger.${kind}`, { stepId: step, ...(arg && kind === 'not_committed' ? { reason: arg } : {}) });
    } catch (e) {
      this.i.journal('ledger.write_failed', { effect: kind!, code: e instanceof LedgerError ? e.code : 'ledger.error' });
    }
    return true;
  }

  private closeAmbiguous(xs: string[], kind: string): void {
    this.i.journal('ledger.verify_ambiguous', { effect: kind, candidates: xs.length });
    for (const x of xs) {
      const st = this.i.ledger.get(this.i.intentId, x)?.state;
      if (st !== 'armed' && st !== 'dispatched') continue;
      try {
        this.i.ledger.resolve(this.i.intentId, x, 'in_doubt');
        this.i.journal('ledger.in_doubt', { stepId: x });
      } catch (e) {
        this.i.journal('ledger.write_failed', { effect: 'in_doubt', code: e instanceof LedgerError ? e.code : 'ledger.error' });
      }
    }
  }

  private effectOf(x: string): Effect | null {
    const t = this.targetOf.get(x);
    const e = t ? this.i.dict.entries[t] : undefined;
    return e?.commits && e.commitEffect ? e.commitEffect : null;
  }
}
