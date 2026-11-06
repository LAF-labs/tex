// 원장·커밋 가드 포트 구현(M2-3, D03 §3 R-G7·§4·§5.4). RunService가 RunController에 넘긴다.
// - arm: 게이트 요청 approved → consumed + 원장 armed + 하루 비가역 수 증가를 한 트랜잭션으로(synchronous=FULL, 증가 커밋 → 클릭, D03 §7).
//   H01 RunService.arm과 같은 순서다. 하나라도 거부면 아무것도 쓰지 않는다.
// - armGuard·disarmGuard: CommitGuard.arm(효과 = X 타깃의 commitEffect, armedUntil = 토큰 exp)·disarm.
// - ledgerEffect: 상태 머신 효과 ledger.*를 원장 쓰기로 옮긴다. at이 verify 스텝이면 그 verify를 가리키는 X의 행이다.
//   committed의 verify_ref는 VerifyBook.ref(그 verify)다. 값은 저널에 남기지 않는다(⑦).
import { LedgerError, type ArmRow, type Db, type Ledger, type NotCommittedReason } from '@sax/db';
import type { ArmInput } from '../commitguard/guard.ts';
import { flatten } from '../core/cfg.ts';
import type { ActResult } from '../core/page.ts';
import type { Effect, PlaybookIR, SelectorDict } from '../core/types.ts';
import type { CommitPort } from './controller.ts';

export interface LedgerPortInput {
  db: Db;
  ledger: Ledger;
  /** 이 실행의 의도 id(원장 행 키). 재시작 뒤 reverify에서도 같은 값이다. */
  intentId: string;
  ir: PlaybookIR;
  dict: SelectorDict;
  /** X의 armed 행 재료(게이트 요청 actionHash·업무 키·HMAC 등). 없으면 arm 거부. */
  row(x: { stepId: string; reqId: string; actionHash: string }): ArmRow | null;
  /** armed와 같은 트랜잭션 안에서(RunEnforcer.markCommitted: 하루 비가역 수). 거부면 그 코드로 롤백. */
  inTx?: () => ActResult;
  guard?: { arm(a: ArmInput): Promise<ActResult>; disarm(): Promise<void> };
  /** 지금 실행 탭 URL(가드가 무장할 endpoint 호스트). */
  pageUrl(): string;
  /** verify 스텝 → 그 판정의 verify_ref(VerifyBook.ref). */
  verifyRef(verifyStepId: string): string | null;
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
  /** verify 스텝 → 그것을 verify로 가리키는 X. 둘 이상의 X가 같은 verify를 가리키면 null(모호, 이 포트가 마지막으로 무장한 X로 정한다). */
  private readonly xOfVerify = new Map<string, string | null>();
  private lastArmed: string | null = null;

  constructor(i: LedgerPortInput) {
    this.i = i;
    for (const [id, { step }] of flatten(i.ir.steps).info) {
      if (step.type === 'submit') this.targetOf.set(id, step.target);
      if (step.type === 'submit' || step.type === 'send_email') this.xOfVerify.set(step.verify, this.xOfVerify.has(step.verify) ? null : id);
    }
  }

  arm(a: { stepId: string; reqId: string; actionHash: string }): ActResult {
    const row = this.i.row(a);
    if (!row || row.intentId !== this.i.intentId || row.stepId !== a.stepId || row.actionHash !== a.actionHash) return { ok: false, code: 'ledger.row_missing' };
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
    this.lastArmed = a.stepId;
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

  /**
   * 상태 머신 효과 ledger.*를 원장에 쓴다(RunController onEffect). 원장 효과가 아니면 false.
   * ledger.dispatched는 X에서, committed·not_committed{verify}·in_doubt는 verify(또는 X)에서 온다.
   */
  ledgerEffect(effect: string, at: string | null): boolean {
    const m = /^ledger\.(dispatched|committed|not_committed|in_doubt)(?:\{([a-z_]+)\})?$/.exec(effect);
    if (!m) return false;
    const x = at ? this.xOf(at) : null;
    if (!x) {
      this.i.journal('ledger.effect_unbound', { effect: m[1]! });
      return true;
    }
    const [, kind, arg] = m;
    try {
      if (kind === 'dispatched') this.i.ledger.dispatched(this.i.intentId, x);
      else if (kind === 'committed') this.i.ledger.resolve(this.i.intentId, x, 'committed', null, at && at !== x ? this.i.verifyRef(at) : null);
      else if (kind === 'not_committed') this.i.ledger.resolve(this.i.intentId, x, 'not_committed', (arg ?? 'verify') as NotCommittedReason, null);
      else this.i.ledger.resolve(this.i.intentId, x, 'in_doubt');
      this.i.journal(`ledger.${kind}`, { stepId: x, ...(arg && kind === 'not_committed' ? { reason: arg } : {}) });
    } catch (e) {
      this.i.journal('ledger.write_failed', { effect: kind!, code: e instanceof LedgerError ? e.code : 'ledger.error' });
    }
    return true;
  }

  /** 효과 자리 → 원장 행의 X. verify 자리면 그 verify의 X, 모호하면 마지막으로 무장한 X(그 X의 verify일 때만). */
  private xOf(at: string): string | null {
    if (!this.xOfVerify.has(at)) return at;
    const x = this.xOfVerify.get(at);
    if (x) return x;
    const last = this.lastArmed;
    const s = last ? flatten(this.i.ir.steps).info.get(last)?.step : undefined;
    return s && (s.type === 'submit' || s.type === 'send_email') && s.verify === at ? last : null;
  }

  private effectOf(x: string): Effect | null {
    const t = this.targetOf.get(x);
    const e = t ? this.i.dict.entries[t] : undefined;
    return e?.commits && e.commitEffect ? e.commitEffect : null;
  }
}
