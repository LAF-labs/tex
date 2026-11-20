import { createHash } from 'node:crypto';
import type { Db } from './open.ts';


export type LedgerState = 'armed' | 'dispatched' | 'committed' | 'not_committed' | 'in_doubt' | 'observed_manual';
/**
 * signal: 무장 뒤 클릭 직전에 차단 신호가 걸려 누르지 않았다(D03 §7).
 * attested: 증언 바에서 사람이 "실행되지 않았다"고 증언했다(ADR-021 결정 5, 저널 gate.attested).
 */
export type NotCommittedReason = 'pre_dispatch_mismatch' | 'identity_mismatch' | 'payload_mismatch' | 'signal' | 'verify' | 'attested';
/** committed의 사유. 실행 중 verify 판정은 사유가 없다(null). reverify: 재시작 뒤 새 프로세스가 발급목록 조회로 in_doubt를 committed로 확정했다(run.reverify). */
export type CommittedReason = 'reverify';

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
  issueKey?: string | null;
  baselineRefs?: readonly string[] | null;
}

export interface LedgerRow extends ArmRow {
  issueKey: string | null;
  baselineRefs: readonly string[] | null;
  reverifyDay: string | null;
  attempt: number;
  state: LedgerState;
  reason: string | null;
  armedAt: string;
  dispatchedAt: string | null;
  resolvedAt: string | null;
  verifyRef: string | null;
}

export type IntentCheck =
  | { kind: 'new' }
  | { kind: 'reuse_mismatch' }
  | { kind: 'unresolved'; state: LedgerState }
  | { kind: 'committed'; runId: string }
  | { kind: 'not_committed' };

export interface History {
  firstBizNo: boolean;
  firstEmail: boolean;
  businessKeyStates: LedgerState[];
  priorNotCommitted: boolean;
}

const now = () => new Date().toISOString();
type Row = Record<string, unknown>;

const refsOf = (v: unknown): string[] | null => {
  if (typeof v !== 'string') return null;
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) && a.every((x) => typeof x === 'string') ? a : null;
  } catch {
    return null;
  }
};

const toLedger = (r: Row): LedgerRow => ({
  intentId: String(r.intent_id),
  stepId: String(r.step_id),
  attempt: Number(r.attempt),
  runId: String(r.run_id),
  businessKey: String(r.business_key),
  playbookId: String(r.playbook_id),
  inputsHash: String(r.inputs_hash),
  packageDigest: String(r.package_digest),
  actionHash: String(r.action_hash),
  deviceId: String(r.device_id),
  cpBizNoHmac: String(r.cp_biz_no_hmac),
  recipientEmailHmac: (r.recipient_email_hmac as string) ?? null,
  issueKey: (r.issue_key as string) ?? null,
  baselineRefs: refsOf(r.baseline_refs),
  reverifyDay: (r.reverify_day as string) ?? null,
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

  decide(reqId: string, to: 'approved' | 'denied' | 'expired', by: string): boolean {
    return this.db.prepare(`UPDATE gate_requests SET state = ?, decided_by = ?, decided_at = ? WHERE req_id = ? AND state = 'open'`).run(to, by, now(), reqId).changes === 1;
  }

  state(reqId: string): string | null {
    const r = this.db.prepare('SELECT state FROM gate_requests WHERE req_id = ?').get(reqId) as Row | undefined;
    return r ? String(r.state) : null;
  }

  withdraw(reqId: string, by: string): boolean {
    return this.db.prepare(`UPDATE gate_requests SET state = 'denied', decided_by = ?, decided_at = ? WHERE req_id = ? AND state = 'approved'`).run(by, now(), reqId).changes === 1;
  }

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
    const r = this.db.prepare('SELECT * FROM irreversible_log WHERE intent_id = ? AND step_id = ? ORDER BY attempt DESC LIMIT 1').get(intentId, stepId) as Row | undefined;
    return r ? toLedger(r) : null;
  }

  attempts(intentId: string, stepId: string): LedgerRow[] {
    return this.db.prepare('SELECT * FROM irreversible_log WHERE intent_id = ? AND step_id = ? ORDER BY attempt').all(intentId, stepId).map((r) => toLedger(r as Row));
  }

  private blockingAttempt(rows: readonly LedgerRow[]): LedgerState | null {
    if (rows.some((r) => r.state === 'committed')) return 'committed';
    return rows.find((r) => r.state !== 'not_committed')?.state ?? null;
  }

  byIssueKey(issueKey: string): LedgerRow[] {
    return this.db.prepare('SELECT * FROM irreversible_log WHERE issue_key = ? ORDER BY armed_at, rowid').all(issueKey).map((r) => toLedger(r as Row));
  }

  private checkIssueKey(a: ArmRow): void {
    if (!a.issueKey) return;
    const others = this.byIssueKey(a.issueKey).filter((r) => r.intentId !== a.intentId || r.stepId !== a.stepId);
    if (others.some((r) => r.state === 'committed')) throw new LedgerError('ledger_issue_committed');
    if (others.some((r) => r.state !== 'not_committed')) throw new LedgerError('ledger_issue_open');
  }

  checkIntent(intentId: string, stepId: string, playbookId: string, inputsHash: string): IntentCheck {
    const rows = this.db.prepare('SELECT * FROM irreversible_log WHERE intent_id = ?').all(intentId).map((r) => toLedger(r as Row));
    if (rows.some((r) => r.playbookId !== playbookId || r.inputsHash !== inputsHash)) return { kind: 'reuse_mismatch' };
    const steps = rows.filter((r) => r.stepId === stepId);
    if (!steps.length) return { kind: 'new' };
    const committed = steps.find((r) => r.state === 'committed');
    if (committed) return { kind: 'committed', runId: committed.runId };
    const open = steps.find((r) => r.state !== 'not_committed');
    if (open) return { kind: 'unresolved', state: open.state };
    return { kind: 'not_committed' };
  }

  history(q: { cpBizNoHmac: string; recipientEmailHmac: string | null; businessKey: string }): History {
    const committedBiz = this.db.prepare(`SELECT 1 FROM irreversible_log WHERE cp_biz_no_hmac = ? AND state = 'committed' LIMIT 1`).get(q.cpBizNoHmac);
    const committedEmail = q.recipientEmailHmac
      ? this.db.prepare(`SELECT 1 FROM irreversible_log WHERE recipient_email_hmac = ? AND state = 'committed' LIMIT 1`).get(q.recipientEmailHmac)
      : 1;
    const states = (this.db.prepare('SELECT state FROM irreversible_log WHERE business_key = ? ORDER BY armed_at, rowid').all(q.businessKey) as Row[]).map((r) => r.state as LedgerState);
    return { firstBizNo: !committedBiz, firstEmail: !committedEmail, businessKeyStates: states, priorNotCommitted: states.at(-1) === 'not_committed' };
  }

  consumeAndArm(reqId: string, a: ArmRow): void {
    this.db.transaction(() => {
      const consumed = this.db.prepare(`UPDATE gate_requests SET state = 'consumed' WHERE req_id = ? AND state = 'approved'`).run(reqId).changes;
      if (consumed !== 1) throw new LedgerError('gate_not_approved');
      const prev = this.attempts(a.intentId, a.stepId);
      const block = this.blockingAttempt(prev);
      if (block) throw new LedgerError(`ledger_${block}`);
      if (prev.some((r) => r.playbookId !== a.playbookId || r.inputsHash !== a.inputsHash)) throw new LedgerError('ledger_intent_mismatch');
      this.checkIssueKey(a);
      this.db
        .prepare(`INSERT INTO irreversible_log (intent_id, step_id, attempt, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, cp_biz_no_hmac, recipient_email_hmac, issue_key, baseline_refs)
          VALUES (@intentId, @stepId, @attempt, @runId, @businessKey, @playbookId, @inputsHash, @packageDigest, @actionHash, 'armed', @armedAt, @deviceId, @cpBizNoHmac, @recipientEmailHmac, @issueKey, @baselineRefs)`)
        .run({ ...a, issueKey: a.issueKey ?? null, baselineRefs: a.baselineRefs ? JSON.stringify([...a.baselineRefs]) : null, attempt: prev.length + 1, armedAt: now() });
    })();
  }

  dispatched(intentId: string, stepId: string): void {
    const n = this.db.prepare(`UPDATE irreversible_log SET state = 'dispatched', dispatched_at = ? WHERE intent_id = ? AND step_id = ? AND state = 'armed'`).run(now(), intentId, stepId).changes;
    if (n !== 1) throw new LedgerError('ledger_not_armed');
  }

  resolve(intentId: string, stepId: string, state: 'committed' | 'not_committed' | 'in_doubt', reason: CommittedReason | NotCommittedReason | null = null, verifyRef: string | null = null): void {
    const n = this.db
      .prepare(`UPDATE irreversible_log SET state = ?, reason = ?, verify_ref = ?, resolved_at = ? WHERE intent_id = ? AND step_id = ? AND state IN ('armed','dispatched','in_doubt','observed_manual')`)
      .run(state, reason, verifyRef, state === 'in_doubt' ? null : now(), intentId, stepId).changes;
    if (n !== 1) throw new LedgerError('ledger_not_open');
  }

  statesByRun(runId: string): LedgerState[] {
    return this.db.prepare('SELECT state FROM irreversible_log WHERE run_id = ? ORDER BY armed_at, attempt, rowid').pluck().all(runId) as LedgerState[];
  }

  observedManual(a: ArmRow): void {
    this.db.transaction(() => {
      const prev = this.get(a.intentId, a.stepId);
      this.checkIssueKey(a);
      if (!prev) {
        this.db
          .prepare(`INSERT INTO irreversible_log (intent_id, step_id, attempt, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, cp_biz_no_hmac, recipient_email_hmac, issue_key)
            VALUES (@intentId, @stepId, 1, @runId, @businessKey, @playbookId, @inputsHash, @packageDigest, @actionHash, 'observed_manual', @armedAt, @deviceId, @cpBizNoHmac, @recipientEmailHmac, @issueKey)`)
          .run({ ...a, issueKey: a.issueKey ?? null, armedAt: now() });
        return;
      }
      if (prev.state === 'committed' || prev.state === 'not_committed') throw new LedgerError(`ledger_${prev.state}`);
      if (prev.state === 'observed_manual') return;
      this.db.prepare(`UPDATE irreversible_log SET state = 'observed_manual' WHERE intent_id = ? AND step_id = ? AND attempt = ?`).run(a.intentId, a.stepId, prev.attempt);
    })();
  }

  attestManual(a: ArmRow): string {
    return this.db.transaction(() => {
      const prev = this.get(a.intentId, a.stepId);
      if (prev?.state === 'committed') return a.stepId;
      if (prev?.state !== 'not_committed') {
        this.observedManual(a);
        return a.stepId;
      }
      const side = { ...a, stepId: `${a.stepId}.manual` };
      if (this.get(side.intentId, side.stepId)?.state === 'committed') return side.stepId;
      this.observedManual(side);
      return side.stepId;
    })();
  }

  armFollowUp(primary: { intentId: string; stepId: string }, a: ArmRow): void {
    this.db.transaction(() => {
      if (this.get(primary.intentId, primary.stepId)?.state !== 'committed') throw new LedgerError('ledger_primary_not_committed');
      const prev = this.get(a.intentId, a.stepId);
      if (prev) throw new LedgerError(`ledger_${prev.state}`);
      this.db
        .prepare(`INSERT INTO irreversible_log (intent_id, step_id, attempt, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, cp_biz_no_hmac, recipient_email_hmac, issue_key)
          VALUES (@intentId, @stepId, 1, @runId, @businessKey, @playbookId, @inputsHash, @packageDigest, @actionHash, 'armed', @armedAt, @deviceId, @cpBizNoHmac, @recipientEmailHmac, @issueKey)`)
        .run({ ...a, issueKey: a.issueKey ?? null, armedAt: now() });
    })();
  }

  inDoubt(playbookId: string, sinceIso: string, day: string): LedgerRow[] {
    return this.db
      .prepare(`SELECT * FROM irreversible_log WHERE state = 'in_doubt' AND playbook_id = ? AND armed_at >= ? AND (reverify_day IS NULL OR reverify_day <> ?) ORDER BY armed_at DESC, rowid DESC`)
      .all(playbookId, sinceIso, day)
      .map((r) => toLedger(r as Row));
  }

  unboundSibling(row: Pick<LedgerRow, 'intentId' | 'stepId' | 'attempt' | 'cpBizNoHmac'>, sinceIso: string): boolean {
    return (
      this.db
        .prepare(`SELECT 1 FROM irreversible_log WHERE cp_biz_no_hmac = ? AND armed_at >= ? AND verify_ref IS NULL AND NOT (intent_id = ? AND step_id = ? AND attempt = ?) LIMIT 1`)
        .get(row.cpBizNoHmac, sinceIso, row.intentId, row.stepId, row.attempt) !== undefined
    );
  }

  markReverified(row: Pick<LedgerRow, 'intentId' | 'stepId' | 'attempt'>, day: string): void {
    this.db.prepare(`UPDATE irreversible_log SET reverify_day = ? WHERE intent_id = ? AND step_id = ? AND attempt = ?`).run(day, row.intentId, row.stepId, row.attempt);
  }

  committedRefs(): Set<string> {
    return new Set(this.db.prepare(`SELECT verify_ref FROM irreversible_log WHERE state = 'committed' AND verify_ref IS NOT NULL`).pluck().all() as string[]);
  }

  promoteInDoubt(): number {
    return this.db.prepare(`UPDATE irreversible_log SET state = 'in_doubt' WHERE state IN ('armed','dispatched','observed_manual')`).run().changes;
  }
}

const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const GENESIS = '0'.repeat(64);

export type JournalPayload = Record<string, string | number | boolean>;

const BAD_TYPE = '#type';

/** 형태 문제 목록: 값이 틀린 필드 이름, 또는 '#type'(이벤트 이름)·'#too_many_fields'·'#field_name' 표지 */
export function journalShapeProblems(type: string, payload: JournalPayload): string[] {
  const bad: string[] = [];
  if (!EVENT_TYPE.test(type)) bad.push(BAD_TYPE);
  const entries = Object.entries(payload);
  if (entries.length > 16) bad.push('#too_many_fields');
  for (const [k, v] of entries) {
    if (!FIELD.test(k)) bad.push('#field_name');
    else if (typeof v === 'string' ? v.length > 128 || /[\r\n\t]/.test(v) : typeof v === 'number' ? !Number.isFinite(v) : typeof v !== 'boolean') bad.push(k);
  }
  return bad;
}

export class JournalShapeError extends Error {
  readonly code = 'journal.payload_shape';
  readonly fields: string[];
  constructor(fields: string[]) {
    super(`journal.payload_shape:${fields.join(',')}`);
    this.fields = fields;
  }
}

export const journalHash = (prevHash: string, at: string, type: string, body: string): string =>
  createHash('sha256').update(`${prevHash}\n${at}\n${type}\n${body}`).digest('hex');

/** count: 검사한 이벤트 수(끊긴 경우 끊긴 행 앞까지) */
export type ChainCheck = { ok: true; count: number; head: string } | { ok: false; count: number; brokenAtSeq: number; reason: 'prev_hash' | 'hash' | 'payload' };

/**
 * 실행 저널(D07 run_events, D03 §9). 실행별 해시 체인: hash = sha256(prev_hash ‖ at ‖ type ‖ payload_json), 첫 이벤트의 prev_hash는 0×64.
 * Phase 1은 체인 자체 검증만 한다(verify). 끝을 잘라 낸 것은 체인만으로 알 수 없고 Phase 2 폰 앵커가 잡는다(D-45(N-71)).
 */
export class RunJournal {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  append(runId: string, type: string, payload: JournalPayload = {}): void {
    const bad = journalShapeProblems(type, payload);
    if (bad.includes(BAD_TYPE)) throw new JournalShapeError(['type']);
    if (bad.length) {
      const keep = Object.entries(payload).filter(([k]) => !bad.includes(k) && FIELD.test(k)).slice(0, 15);
      const badNames = bad.filter((b) => b === '#field_name').length;
      const names = [...bad.filter((b) => !b.startsWith('#')), ...(badNames ? [badNames > 1 ? `field_name*${badNames}` : 'field_name'] : [])];
      payload = { ...Object.fromEntries(keep), dropped: names.join(',').slice(0, 128) || 'too_many_fields' };
    }
    this.db.transaction(() => {
      const prev = this.db.prepare('SELECT hash FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(runId) as Row | undefined;
      const prevHash = prev ? String(prev.hash) : GENESIS;
      const at = now();
      const body = JSON.stringify(payload);
      const hash = journalHash(prevHash, at, type, body);
      this.db.prepare('INSERT INTO run_events (run_id, at, type, payload_json, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)').run(runId, at, type, body, prevHash, hash);
    })();
  }

  types(runId: string): string[] {
    return (this.db.prepare('SELECT type FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as Row[]).map((r) => String(r.type));
  }

  verify(runId: string): ChainCheck {
    const rows = this.db.prepare('SELECT seq, at, type, payload_json, prev_hash, hash FROM run_events WHERE run_id = ? ORDER BY seq').all(runId) as Row[];
    let prev = GENESIS;
    for (const [i, r] of rows.entries()) {
      const seq = Number(r.seq);
      if (String(r.prev_hash) !== prev) return { ok: false, count: i, brokenAtSeq: seq, reason: 'prev_hash' };
      const body = String(r.payload_json);
      if (journalHash(prev, String(r.at), String(r.type), body) !== String(r.hash)) return { ok: false, count: i, brokenAtSeq: seq, reason: 'hash' };
      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return { ok: false, count: i, brokenAtSeq: seq, reason: 'payload' };
      }
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ok: false, count: i, brokenAtSeq: seq, reason: 'payload' };
      prev = String(r.hash);
    }
    return { ok: true, count: rows.length, head: prev };
  }

  verifyRuns(runIds?: readonly string[]): string[] {
    const ids = runIds ?? (this.db.prepare('SELECT DISTINCT run_id FROM run_events ORDER BY run_id').all() as Row[]).map((r) => String(r.run_id));
    return ids.filter((id) => !this.verify(id).ok);
  }
}
