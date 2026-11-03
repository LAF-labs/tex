import { createHash } from 'node:crypto';
import type { Db } from './open.ts';

// 아이덴포턴시 원장(D03 §4, D07 irreversible_log)·게이트 요청(gate_requests)·실행(runs)·감사 저널(run_events).
// 값(사업자번호·금액·이메일)은 평문으로 두지 않는다. 처음 거래 판정용 HMAC과 해시만 받는다.

export type LedgerState = 'armed' | 'dispatched' | 'committed' | 'not_committed' | 'in_doubt' | 'observed_manual';
/** signal: 무장 뒤 클릭 직전에 차단 신호가 걸려 누르지 않았다(D03 §7). */
export type NotCommittedReason = 'pre_dispatch_mismatch' | 'identity_mismatch' | 'payload_mismatch' | 'signal' | 'verify';

export interface ArmRow {
  intentId: string;
  stepId: string;
  runId: string;
  businessKey: string;
  playbookId: string;
  inputsHash: string;
  packageDigest: string;
  actionHash: string;
  deviceId: string;
  cpBizNoHmac: string;
  recipientEmailHmac: string | null;
}

export interface LedgerRow extends ArmRow {
  state: LedgerState;
  reason: string | null;
  armedAt: string;
  dispatchedAt: string | null;
  resolvedAt: string | null;
  verifyRef: string | null;
}

export type IntentCheck =
  | { kind: 'new' }
  /** 같은 intent_id인데 입력·플레이북이 다르다(ledger.intent_reuse, 보안 이벤트). */
  | { kind: 'reuse_mismatch' }
  /** 종결되지 않은 행이 있다. 재실행 금지. */
  | { kind: 'unresolved'; state: LedgerState }
  | { kind: 'committed'; runId: string }
  /** not_committed로 끝났다. PoC는 같은 의도로 다시 게이트를 지나지 않는다(다시 준비하면 새 의도). */
  | { kind: 'not_committed' };

export interface History {
  /** 이 PC에서 committed로 확정된 적이 없는 공급받는자(ADR-021 "처음 거래"). */
  firstBizNo: boolean;
  /** 이 PC에서 committed로 확정된 적이 없는 받는 이메일("처음 보내는 주소"). 이메일이 없으면 false. */
  firstEmail: boolean;
  /** 같은 업무 키 행의 상태들(D02 §7, 차단 아님). */
  businessKeyStates: LedgerState[];
  /** 같은 업무 키의 직전 시도가 not_committed로 판정됐다. */
  priorNotCommitted: boolean;
}

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

const toLedger = (r: Row): LedgerRow => ({
  intentId: String(r.intent_id),
  stepId: String(r.step_id),
  runId: String(r.run_id),
  businessKey: String(r.business_key),
  playbookId: String(r.playbook_id),
  inputsHash: String(r.inputs_hash),
  packageDigest: String(r.package_digest),
  actionHash: String(r.action_hash),
  deviceId: String(r.device_id),
  cpBizNoHmac: String(r.cp_biz_no_hmac),
  recipientEmailHmac: (r.recipient_email_hmac as string) ?? null,
  state: r.state as LedgerState,
  reason: (r.reason as string) ?? null,
  armedAt: String(r.armed_at),
  dispatchedAt: (r.dispatched_at as string) ?? null,
  resolvedAt: (r.resolved_at as string) ?? null,
  verifyRef: (r.verify_ref as string) ?? null,
});

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export class RunRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  create(r: { id: string; playbookId: string; playbookVersion: string; packageDigest: string; profileId: string; trigger: 'local' | 'remote' | 'daemon'; inputsHash: string }): void {
    this.db
      .prepare(`INSERT INTO runs (id, playbook_id, playbook_version, package_digest, profile_id, trigger, status, inputs_hash, started_at) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`)
      .run(r.id, r.playbookId, r.playbookVersion, r.packageDigest, r.profileId, r.trigger, r.inputsHash, now());
  }

  finish(id: string, status: string): void {
    this.db.prepare('UPDATE runs SET status = ?, finished_at = ? WHERE id = ?').run(status, now(), id);
  }

  /** 기동 시: 끝나지 않은 실행은 중단으로 닫는다(D03 §2 재시작 → Interrupted). */
  interruptRunning(): number {
    return this.db.prepare(`UPDATE runs SET status = 'interrupted', finished_at = ? WHERE status = 'running'`).run(now()).changes;
  }

  status(id: string): string | null {
    const r = this.db.prepare('SELECT status FROM runs WHERE id = ?').get(id) as Row | undefined;
    return r ? String(r.status) : null;
  }
}

/** 게이트 요청은 원자적이다(R-G8, B-33). open에서만 결정되고 req_id당 토큰은 최대 1개다. */
export class GateRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  open(reqId: string, runId: string): void {
    this.db.prepare(`INSERT INTO gate_requests (req_id, run_id, state) VALUES (?, ?, 'open')`).run(reqId, runId);
  }

  /** open → approved | denied | expired. 이미 open이 아니면 false(두 번째 결정은 무시). */
  decide(reqId: string, to: 'approved' | 'denied' | 'expired', by: string): boolean {
    return this.db.prepare(`UPDATE gate_requests SET state = ?, decided_by = ?, decided_at = ? WHERE req_id = ? AND state = 'open'`).run(to, by, now(), reqId).changes === 1;
  }

  state(reqId: string): string | null {
    const r = this.db.prepare('SELECT state FROM gate_requests WHERE req_id = ?').get(reqId) as Row | undefined;
    return r ? String(r.state) : null;
  }

  /** 승인 뒤 커밋 전에 거부가 왔다(거부 우선 창, D03 §2). approved → denied. */
  withdraw(reqId: string, by: string): boolean {
    return this.db.prepare(`UPDATE gate_requests SET state = 'denied', decided_by = ?, decided_at = ? WHERE req_id = ? AND state = 'approved'`).run(by, now(), reqId).changes === 1;
  }

  /** 기동 시: 앞 실행에서 열린 채·승인만 된 채 남은 게이트는 만료로 닫는다(토큰은 메모리에만 있었다). */
  expireOpen(): number {
    return this.db.prepare(`UPDATE gate_requests SET state = 'expired', decided_by = 'restart', decided_at = ? WHERE state IN ('open','approved')`).run(now()).changes;
  }
}

export class Ledger {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  get(intentId: string, stepId: string): LedgerRow | null {
    const r = this.db.prepare('SELECT * FROM irreversible_log WHERE intent_id = ? AND step_id = ?').get(intentId, stepId) as Row | undefined;
    return r ? toLedger(r) : null;
  }

  /** 같은 의도로 들어온 새 실행의 판정(D03 §4). */
  checkIntent(intentId: string, stepId: string, playbookId: string, inputsHash: string): IntentCheck {
    const rows = this.db.prepare('SELECT * FROM irreversible_log WHERE intent_id = ?').all(intentId).map((r) => toLedger(r as Row));
    if (rows.some((r) => r.playbookId !== playbookId || r.inputsHash !== inputsHash)) return { kind: 'reuse_mismatch' };
    const row = rows.find((r) => r.stepId === stepId);
    if (!row) return { kind: 'new' };
    if (row.state === 'committed') return { kind: 'committed', runId: row.runId };
    if (row.state === 'not_committed') return { kind: 'not_committed' };
    return { kind: 'unresolved', state: row.state };
  }

  /** 처음 거래·처음 보내는 주소는 committed 행만, 업무 중복은 모든 상태를 본다(ADR-021, D02 §7). */
  history(q: { cpBizNoHmac: string; recipientEmailHmac: string | null; businessKey: string }): History {
    const committedBiz = this.db.prepare(`SELECT 1 FROM irreversible_log WHERE cp_biz_no_hmac = ? AND state = 'committed' LIMIT 1`).get(q.cpBizNoHmac);
    const committedEmail = q.recipientEmailHmac
      ? this.db.prepare(`SELECT 1 FROM irreversible_log WHERE recipient_email_hmac = ? AND state = 'committed' LIMIT 1`).get(q.recipientEmailHmac)
      : 1;
    const states = (this.db.prepare('SELECT state FROM irreversible_log WHERE business_key = ? ORDER BY armed_at, rowid').all(q.businessKey) as Row[]).map((r) => r.state as LedgerState);
    // "직전 시도 발급 안 됨"은 가장 최근 시도가 not_committed일 때만이다. 그 앞에 발급된(또는 모르는) 건이 있으면
    // 그 경고가 먼저다(바·카드가 businessKeyStates로 판단한다).
    return { firstBizNo: !committedBiz, firstEmail: !committedEmail, businessKeyStates: states, priorNotCommitted: states.at(-1) === 'not_committed' };
  }

  /**
   * 토큰 소비 + armed 기록(D03 §3 "소비는 원장 armed 기록과 한 트랜잭션"). 게이트가 approved가 아니거나
   * 같은 (intent_id, step_id) 행이 이미 있으면 아무것도 쓰지 않고 던진다. not_committed 행도 덮어쓰지 않는다
   * (업무 키의 "직전 시도 발급 안 됨" 경고가 그 행에서 나온다).
   */
  consumeAndArm(reqId: string, a: ArmRow): void {
    this.db.transaction(() => {
      const consumed = this.db.prepare(`UPDATE gate_requests SET state = 'consumed' WHERE req_id = ? AND state = 'approved'`).run(reqId).changes;
      if (consumed !== 1) throw new LedgerError('gate_not_approved');
      const prev = this.get(a.intentId, a.stepId);
      if (prev) throw new LedgerError(`ledger_${prev.state}`);
      this.db
        .prepare(`INSERT INTO irreversible_log (intent_id, step_id, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, cp_biz_no_hmac, recipient_email_hmac)
          VALUES (@intentId, @stepId, @runId, @businessKey, @playbookId, @inputsHash, @packageDigest, @actionHash, 'armed', @armedAt, @deviceId, @cpBizNoHmac, @recipientEmailHmac)`)
        .run({ ...a, armedAt: now() });
    })();
  }

  dispatched(intentId: string, stepId: string): void {
    const n = this.db.prepare(`UPDATE irreversible_log SET state = 'dispatched', dispatched_at = ? WHERE intent_id = ? AND step_id = ? AND state = 'armed'`).run(now(), intentId, stepId).changes;
    if (n !== 1) throw new LedgerError('ledger_not_armed');
  }

  /** 종결(또는 in_doubt). armed·dispatched·in_doubt에서만 바뀐다. committed·not_committed는 다시 바뀌지 않는다. */
  resolve(intentId: string, stepId: string, state: 'committed' | 'not_committed' | 'in_doubt', reason: NotCommittedReason | null = null, verifyRef: string | null = null): void {
    const n = this.db
      .prepare(`UPDATE irreversible_log SET state = ?, reason = ?, verify_ref = ?, resolved_at = ? WHERE intent_id = ? AND step_id = ? AND state IN ('armed','dispatched','in_doubt')`)
      .run(state, reason, verifyRef, state === 'in_doubt' ? null : now(), intentId, stepId).changes;
    if (n !== 1) throw new LedgerError('ledger_not_open');
  }

  /** 이 상태들인 원장 행 수(PoC 전체 실발급 상한, ADR-022 결정 1). 날짜·재시작과 무관하다. */
  countIrreversible(states: readonly LedgerState[]): number {
    if (!states.length) return 0;
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM irreversible_log WHERE state IN (${states.map(() => '?').join(',')})`).get(...states) as Row;
    return Number(r.n);
  }

  /** 재시작 시 armed·dispatched·observed_manual은 모두 in_doubt로 올린다(D03 §4). */
  promoteInDoubt(): number {
    return this.db.prepare(`UPDATE irreversible_log SET state = 'in_doubt' WHERE state IN ('armed','dispatched','observed_manual')`).run().changes;
  }
}

/** 감사 저널(D03 §9): 실행별 해시 체인. 코드와 ID만 담는다(값 없음). */
export class RunJournal {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  append(runId: string, type: string, payload: Record<string, string | number | boolean> = {}): void {
    const prev = this.db.prepare('SELECT hash FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(runId) as Row | undefined;
    const prevHash = prev ? String(prev.hash) : '0'.repeat(64);
    const at = now();
    const body = JSON.stringify(payload);
    const hash = createHash('sha256').update(`${prevHash}\n${at}\n${type}\n${body}`).digest('hex');
    this.db.prepare('INSERT INTO run_events (run_id, at, type, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)').run(runId, at, type, body, prevHash, hash);
  }

  types(runId: string): string[] {
    return (this.db.prepare('SELECT type FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as Row[]).map((r) => String(r.type));
  }
}
