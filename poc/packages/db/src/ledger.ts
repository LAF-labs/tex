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

  /** 종결(또는 in_doubt). armed·dispatched·in_doubt·observed_manual에서만 바뀐다. committed·not_committed는 다시 바뀌지 않는다. */
  resolve(intentId: string, stepId: string, state: 'committed' | 'not_committed' | 'in_doubt', reason: NotCommittedReason | null = null, verifyRef: string | null = null): void {
    const n = this.db
      .prepare(`UPDATE irreversible_log SET state = ?, reason = ?, verify_ref = ?, resolved_at = ? WHERE intent_id = ? AND step_id = ? AND state IN ('armed','dispatched','in_doubt','observed_manual')`)
      .run(state, reason, verifyRef, state === 'in_doubt' ? null : now(), intentId, stepId).changes;
    if (n !== 1) throw new LedgerError('ledger_not_open');
  }

  /** 이 실행의 원장 행 상태들(armed_at 순) */
  statesByRun(runId: string): LedgerState[] {
    return this.db.prepare('SELECT state FROM irreversible_log WHERE run_id = ? ORDER BY armed_at, rowid').pluck().all(runId) as LedgerState[];
  }

  /**
   * 사람이 직접 눌렀다(전용 브라우저 밖·자동화 밖 실행을 관찰). 한 트랜잭션:
   * 행이 없으면 observed_manual로 넣고(armed_at = 지금), armed·dispatched·in_doubt면 observed_manual로 바꾼다.
   * 이미 observed_manual이면 그대로 둔다. committed·not_committed면 ledger_<state>로 던진다(종결은 바뀌지 않는다).
   */
  observedManual(a: ArmRow): void {
    this.db.transaction(() => {
      const prev = this.get(a.intentId, a.stepId);
      if (!prev) {
        this.db
          .prepare(`INSERT INTO irreversible_log (intent_id, step_id, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, cp_biz_no_hmac, recipient_email_hmac)
            VALUES (@intentId, @stepId, @runId, @businessKey, @playbookId, @inputsHash, @packageDigest, @actionHash, 'observed_manual', @armedAt, @deviceId, @cpBizNoHmac, @recipientEmailHmac)`)
          .run({ ...a, armedAt: now() });
        return;
      }
      if (prev.state === 'committed' || prev.state === 'not_committed') throw new LedgerError(`ledger_${prev.state}`);
      if (prev.state === 'observed_manual') return;
      this.db.prepare(`UPDATE irreversible_log SET state = 'observed_manual' WHERE intent_id = ? AND step_id = ?`).run(a.intentId, a.stepId);
    })();
  }

  /**
   * 확정된 주 단계(committed)에 딸린 후속 단계를 armed로 넣는다(게이트를 소비하지 않는다). 한 트랜잭션:
   * 주 단계가 committed가 아니면(없어도) ledger_primary_not_committed, 후속 행이 이미 있으면 ledger_<state>.
   */
  armFollowUp(primary: { intentId: string; stepId: string }, a: ArmRow): void {
    this.db.transaction(() => {
      if (this.get(primary.intentId, primary.stepId)?.state !== 'committed') throw new LedgerError('ledger_primary_not_committed');
      const prev = this.get(a.intentId, a.stepId);
      if (prev) throw new LedgerError(`ledger_${prev.state}`);
      this.db
        .prepare(`INSERT INTO irreversible_log (intent_id, step_id, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, cp_biz_no_hmac, recipient_email_hmac)
          VALUES (@intentId, @stepId, @runId, @businessKey, @playbookId, @inputsHash, @packageDigest, @actionHash, 'armed', @armedAt, @deviceId, @cpBizNoHmac, @recipientEmailHmac)`)
        .run({ ...a, armedAt: now() });
    })();
  }

  /** 이 상태들인 원장 행 수(PoC 전체 실발급 상한, ADR-025 결정 1). 날짜·재시작과 무관하다. */
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
/** 감사 이벤트 이름: 점으로 나눈 소문자 코드(run.started, gate.approved, ledger.in_doubt …). */
const EVENT_TYPE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)*$/;
const FIELD = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const GENESIS = '0'.repeat(64);

export type JournalPayload = Record<string, string | number | boolean>;

/**
 * 값 없음 원칙(D03 §9, D12)의 형태 검사. 값의 뜻은 보지 않고 모양만 본다.
 * 필드 이름은 식별자, 값은 짧은 한 줄 문자열(코드·해시·ID)·유한 수·불리언, 필드는 16개까지.
 * 위반이면 위반한 필드 이름만 돌려준다(값은 돌려주지 않는다).
 */
const BAD_TYPE = '#type';

/** 형태 문제 목록: 값이 틀린 필드 이름, 또는 '#type'(이벤트 이름)·'#too_many_fields'·'#field_name' 표지 */
export function journalShapeProblems(type: string, payload: JournalPayload): string[] {
  const bad: string[] = [];
  // '#'로 시작하는 표지는 필드 이름(FIELD)과 겹치지 않는다(payload에 type이라는 필드가 있어도 이벤트 이름 오류와 섞이지 않게)
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

  /**
   * 이벤트 이름이 틀리면 던진다(코드의 상수라 프로그래밍 오류). 필드 형태가 틀리면 실행을 멈추지 않고 그 필드를 빼고
   * `dropped`에 필드 이름만 남긴다(값은 저널에 들어가지 않는다).
   */
  append(runId: string, type: string, payload: JournalPayload = {}): void {
    const bad = journalShapeProblems(type, payload);
    if (bad.includes(BAD_TYPE)) throw new JournalShapeError(['type']);
    if (bad.length) {
      const keep = Object.entries(payload).filter(([k]) => !bad.includes(k) && FIELD.test(k)).slice(0, 15);
      const names = bad.filter((b) => b !== '#too_many_fields').map((b) => b.replace(/^#/, ''));
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

  /** 체인을 다시 계산한다. 중간 행을 고치거나 지우거나 끼워 넣으면 그 seq에서 끊긴다 */
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

  /** 지원 번들 내보내기 직전·기동 시 점검(D03 §9). 끊긴 실행 ID만 돌려준다 */
  verifyRuns(runIds?: readonly string[]): string[] {
    const ids = runIds ?? (this.db.prepare('SELECT DISTINCT run_id FROM run_events ORDER BY run_id').all() as Row[]).map((r) => String(r.run_id));
    return ids.filter((id) => !this.verify(id).ok);
  }
}
