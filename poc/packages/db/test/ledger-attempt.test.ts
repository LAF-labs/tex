// 원장 시도 번호(ADR-042, 마이그레이션 v8): PRIMARY KEY(intent_id, step_id, attempt).
// 팀장 조건: ① 앞선 시도가 모두 not_committed일 때만 새 시도(두 번째 승인으로 발급까지) ② committed 뒤 새 시도 영원히 거부
// ③ 종결 안 된 행(in_doubt 등)이 남으면 거부 ④ v7 → v8 이전 전후 동치, 실패하면 이전 판 그대로(fail-closed). 새 시도는 토큰 소비와 한 트랜잭션에서만.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { GateRepo, Ledger, LedgerError, MigrationError, MIGRATIONS, openDatabase, RunRepo, type ArmRow, type Db } from '@sax/db';

const dirs: string[] = [];
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-attempt-'));
  dirs.push(d);
  return path.join(d, 'db.sqlite');
};
after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
const key = () => new Uint8Array(randomBytes(32));
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.code === c;

function setup(db: Db) {
  const runId = randomUUID();
  new RunRepo(db).create({ id: runId, playbookId: 'H-01', playbookVersion: '1.0.0', packageDigest: 'd'.repeat(64), profileId: 'p', trigger: 'local', inputsHash: 'i'.repeat(64) });
  const row: ArmRow = {
    intentId: 'intent-1', stepId: 's21', runId, businessKey: 'bk', playbookId: 'H-01', inputsHash: 'i'.repeat(64), packageDigest: 'd'.repeat(64), actionHash: 'a'.repeat(64),
    deviceId: 'dev', cpBizNoHmac: 'h'.repeat(64), recipientEmailHmac: null,
  };
  const gates = new GateRepo(db);
  const l = new Ledger(db);
  /** 새 게이트를 열고 승인한 뒤 그 토큰으로 무장한다. */
  const gateArm = (over: Partial<ArmRow> = {}): string => {
    const req = randomUUID();
    gates.open(req, runId);
    gates.decide(req, 'approved', 'user');
    l.consumeAndArm(req, { ...row, ...over });
    return req;
  };
  return { l, gates, row, runId, gateArm };
}

describe('원장 시도 번호(ADR-042)', () => {
  it('① 첫 시도 not_committed → 같은 실행의 새 승인으로 2번째 시도 → committed. 첫 시도의 사유·verify_ref는 남는다', () => {
    const db = openDatabase(tmp(), key());
    const { l, gateArm, runId } = setup(db);
    gateArm();
    l.dispatched('intent-1', 's21');
    l.resolve('intent-1', 's21', 'not_committed', 'verify', 'ref-attempt-1');
    gateArm();
    assert.equal(l.get('intent-1', 's21')!.attempt, 2, 'get은 마지막 시도');
    l.dispatched('intent-1', 's21');
    l.resolve('intent-1', 's21', 'committed', null, 'ref-attempt-2');
    assert.deepEqual(l.attempts('intent-1', 's21').map((r) => [r.attempt, r.state, r.reason, r.verifyRef]), [[1, 'not_committed', 'verify', 'ref-attempt-1'], [2, 'committed', null, 'ref-attempt-2']]);
    assert.deepEqual(l.statesByRun(runId), ['not_committed', 'committed']);
    assert.deepEqual(l.checkIntent('intent-1', 's21', 'H-01', 'i'.repeat(64)), { kind: 'committed', runId });
    db.close();
  });

  it('② committed가 있으면 새 시도는 영원히 거부(ledger_committed), 게이트 토큰은 소비하지 않는다', () => {
    const db = openDatabase(tmp(), key());
    const { l, gates, gateArm, row, runId } = setup(db);
    gateArm();
    l.resolve('intent-1', 's21', 'committed');
    const req = randomUUID();
    gates.open(req, runId);
    gates.decide(req, 'approved', 'user');
    assert.throws(() => l.consumeAndArm(req, row), code('ledger_committed'));
    assert.equal(gates.state(req), 'approved', '롤백: 토큰 소비 없음');
    assert.equal(l.attempts('intent-1', 's21').length, 1);
    // not_committed가 사이에 있어도(1 not_committed, 2 committed) 같다
    const db2 = openDatabase(tmp(), key());
    const b = setup(db2);
    b.gateArm();
    b.l.resolve('intent-1', 's21', 'not_committed', 'verify');
    b.gateArm();
    b.l.resolve('intent-1', 's21', 'committed');
    assert.throws(() => b.gateArm(), code('ledger_committed'));
    db.close();
    db2.close();
  });

  it('③ 종결 안 된 행(armed·dispatched·in_doubt·observed_manual)이 있으면 새 시도 거부', () => {
    for (const st of ['armed', 'dispatched', 'in_doubt', 'observed_manual'] as const) {
      const db = openDatabase(tmp(), key());
      const { l, gateArm, row } = setup(db);
      gateArm();
      l.resolve('intent-1', 's21', 'not_committed', 'verify');
      gateArm();
      if (st === 'dispatched' || st === 'in_doubt') l.dispatched('intent-1', 's21');
      if (st === 'in_doubt') l.resolve('intent-1', 's21', 'in_doubt');
      if (st === 'observed_manual') l.observedManual(row);
      assert.equal(l.get('intent-1', 's21')!.state, st);
      assert.throws(() => gateArm(), code(`ledger_${st}`), st);
      assert.equal(l.attempts('intent-1', 's21').length, 2, st);
      assert.deepEqual(l.checkIntent('intent-1', 's21', 'H-01', 'i'.repeat(64)), { kind: 'unresolved', state: st });
      db.close();
    }
  });

  it('새 시도는 토큰 소비로만: 관측(observedManual)은 not_committed 뒤에 새 시도를 만들지 않는다, 다른 입력·플레이북은 거부', () => {
    const db = openDatabase(tmp(), key());
    const { l, gateArm, row, gates, runId } = setup(db);
    gateArm();
    l.resolve('intent-1', 's21', 'not_committed', 'verify');
    assert.throws(() => l.observedManual(row), code('ledger_not_committed'));
    assert.equal(l.attempts('intent-1', 's21').length, 1);
    for (const over of [{ inputsHash: 'x'.repeat(64) }, { playbookId: 'H-02' }]) {
      const req = randomUUID();
      gates.open(req, runId);
      gates.decide(req, 'approved', 'user');
      assert.throws(() => l.consumeAndArm(req, { ...row, ...over }), code('ledger_intent_mismatch'));
      assert.equal(gates.state(req), 'approved');
    }
    // 승인 안 된 게이트로는 시도가 생기지 않는다
    const req = randomUUID();
    gates.open(req, runId);
    assert.throws(() => l.consumeAndArm(req, row), code('gate_not_approved'));
    assert.equal(l.attempts('intent-1', 's21').length, 1);
    db.close();
  });

  it('DB 불변식(ux_irr_live): (intent, step)마다 not_committed가 아닌 행은 하나. 원장 API를 거치지 않은 쓰기도 막는다', () => {
    const db = openDatabase(tmp(), key());
    const { gateArm } = setup(db);
    gateArm();
    const ins = (attempt: number, state: string) =>
      db.prepare(`INSERT INTO irreversible_log (intent_id, step_id, attempt, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id) VALUES ('intent-1','s21',?,'r','bk','H-01','i','d','a',?,'t','dev')`).run(attempt, state);
    assert.throws(() => ins(2, 'committed'), /UNIQUE constraint failed/);
    assert.throws(() => ins(1, 'not_committed'), /UNIQUE constraint failed|PRIMARY KEY/);
    assert.throws(() => ins(0, 'not_committed'), /CHECK constraint failed/);
    ins(2, 'not_committed'); // 종결 행은 여러 개일 수 있다(DB는 순서를 강제하지 않고 원장 API가 한다)
    db.close();
  });

  it('④ v7 → v8: 이전 행은 attempt=1로 모든 열이 같고, 색인이 다시 생긴다. 앱 업데이트로 연 DB에서 자동으로 옮긴다', () => {
    const file = tmp();
    const k = key();
    const v7 = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 7) });
    assert.equal(v7.pragma('user_version', { simple: true }), 7);
    const rows = [
      ['i-a', 's21', 'run-a', 'bk1', 'committed', 'verify', 'ref-a', 'hb1', 'he1'],
      ['i-b', 's21', 'run-b', 'bk2', 'not_committed', 'pre_dispatch_mismatch', null, 'hb2', null],
      ['i-b', 's22', 'run-b', 'bk2', 'in_doubt', null, null, 'hb2', null],
    ];
    for (const [intent, step, run, bk, state, reason, ref, hb, he] of rows)
      v7.prepare(`INSERT INTO irreversible_log (intent_id, step_id, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, reason, armed_at, dispatched_at, resolved_at, verify_ref, device_id, cp_biz_no_hmac, recipient_email_hmac)
        VALUES (?, ?, ?, ?, 'H-01', 'ih', 'pd', 'ah', ?, ?, '2026-11-01T00:00:00Z', '2026-11-01T00:00:01Z', '2026-11-01T00:00:02Z', ?, 'dev', ?, ?)`).run(intent, step, run, bk, state, reason, ref, hb, he);
    const before = v7.prepare('SELECT * FROM irreversible_log ORDER BY intent_id, step_id').all() as Array<Record<string, unknown>>;
    v7.close();

    const db = openDatabase(file, k);
    assert.equal(db.pragma('user_version', { simple: true }), MIGRATIONS.length);
    const after = db.prepare('SELECT * FROM irreversible_log ORDER BY intent_id, step_id').all() as Array<Record<string, unknown>>;
    assert.deepEqual(after.map(({ attempt, ...r }) => (assert.equal(attempt, 1), r)), before);
    const pk = (db.prepare('PRAGMA table_info(irreversible_log)').all() as Array<{ name: string; pk: number }>).filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
    assert.deepEqual(pk, ['intent_id', 'step_id', 'attempt']);
    const idx = (db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='irreversible_log' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as Array<{ name: string }>).map((r) => r.name);
    assert.deepEqual(idx, ['ix_irr_business', 'ix_irr_cp_hmac', 'ix_irr_email_hmac', 'ix_irr_run', 'ux_irr_live']);
    // 옮긴 뒤의 원장 의미도 같다: committed는 영원히, in_doubt는 미종결, not_committed는 다음 시도 가능
    const l = new Ledger(db);
    assert.deepEqual(l.checkIntent('i-a', 's21', 'H-01', 'ih'), { kind: 'committed', runId: 'run-a' });
    assert.deepEqual(l.checkIntent('i-b', 's22', 'H-01', 'ih'), { kind: 'unresolved', state: 'in_doubt' });
    assert.deepEqual(l.checkIntent('i-b', 's21', 'H-01', 'ih'), { kind: 'not_committed' });
    assert.equal(l.history({ cpBizNoHmac: 'hb1', recipientEmailHmac: 'he1', businessKey: 'bk2' }).priorNotCommitted, false, 'bk2 마지막은 in_doubt');
    assert.equal(db.pragma('foreign_key_check').length, 0);
    db.close();
  });

  it('④ 옮기기가 실패하면 fail-closed: 열리지 않고(MigrationError v8), DB는 v7 그대로 행·키가 남는다', () => {
    const file = tmp();
    const k = key();
    const v7 = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 7) });
    v7.prepare(`INSERT INTO irreversible_log (intent_id, step_id, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id) VALUES ('i-a','s21','r','bk','H-01','ih','pd','ah','committed','t','dev')`).run();
    v7.close();
    const v8 = MIGRATIONS[7]!;
    assert.equal(v8.name, 'ledger_attempt');
    const broken = [...MIGRATIONS.slice(0, 7), { ...v8, sql: `${v8.sql}\nINSERT INTO no_such_table VALUES (1);` }];
    assert.throws(() => openDatabase(file, k, { migrations: broken }), (e: unknown) => e instanceof MigrationError && e.version === 8);
    const again = openDatabase(file, k, { migrations: MIGRATIONS.slice(0, 7) });
    assert.equal(again.pragma('user_version', { simple: true }), 7);
    const cols = (again.prepare('PRAGMA table_info(irreversible_log)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!cols.includes('attempt'));
    assert.equal(again.prepare('SELECT COUNT(*) FROM irreversible_log').pluck().get(), 1);
    again.close();
  });
});
