// 원장·커밋 가드 포트 구현(M2-3, D03 §3 R-G7·§4·§5.4). RunService가 RunController에 넘긴다.
// - arm: 게이트 요청 approved → consumed + 원장 armed + 하루 비가역 수 증가를 한 트랜잭션으로(synchronous=FULL, 증가 커밋 → 클릭, D03 §7).
//   H01 RunService.arm과 같은 순서다. 하나라도 거부면 아무것도 쓰지 않는다.
// - armGuard·disarmGuard: CommitGuard.arm(효과 = X 타깃의 commitEffect, armedUntil = 토큰 exp)·disarm.
// - ledgerEffect: 상태 머신 효과 ledger.*를 원장 쓰기로 옮긴다. at이 verify 스텝이면 그 verify를 가리키는 X의 행이다.
//   committed의 verify_ref는 VerifyBook.ref(그 verify)다. 값은 저널에 남기지 않는다(⑦).
//   한 verify를 여러 X가 가리키면(V-04a가 로드 때 거부하는 모양) 판정을 붙이지 않고 열린 행을 in_doubt로 닫는다.
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
  /**
   * verify 스텝 → 그것을 verify로 가리키는 X들. V-04a가 둘 이상을 로드 때 거부하므로 보통 하나다.
   * 둘 이상이면(검증기를 거치지 않은 IR) 추측하지 않는다: 판정을 붙이지 않고 그 X들의 열린 행을 in_doubt로 닫는다(팀장 결정 2026-11-06).
   */
  private readonly xsOfVerify = new Map<string, string[]>();

  constructor(i: LedgerPortInput) {
    this.i = i;
    for (const [id, { step }] of flatten(i.ir.steps).info) {
      if (step.type === 'submit') this.targetOf.set(id, step.target);
      if (step.type === 'submit' || step.type === 'send_email') this.xsOfVerify.set(step.verify, [...(this.xsOfVerify.get(step.verify) ?? []), id]);
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
    const x = xs[0]!;
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

  /** 한 verify를 여러 X가 가리킨다(V-04a 위반이 로더를 지나온 경우). 판정을 붙이지 않고 열린 행을 모두 in_doubt로(사람 확인, 재발급 막음). */
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
