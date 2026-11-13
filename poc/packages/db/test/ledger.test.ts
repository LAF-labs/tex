// 원장 후속 API(엔진 트랙 요청, PR #59 M2-3 전): statesByRun, observedManual, observed_manual에서 resolve, armFollowUp. D03 §4.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { GateRepo, Ledger, LedgerError, openDatabase, RunRepo, type ArmRow, type Db } from '@sax/db';

let dir: string;
let db: Db;
before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-ledger-'));
  db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const newRun = (): string => {
  const id = randomUUID();
  new RunRepo(db).create({ id, playbookId: 'H-01', playbookVersion: '1.0.0', packageDigest: 'd'.repeat(64), profileId: 'p', trigger: 'local', inputsHash: 'i'.repeat(64) });
  return id;
};
const arm = (runId: string, intentId: string, stepId = 'issue'): ArmRow => ({
  intentId, stepId, runId, businessKey: `bk-${intentId}`, playbookId: 'H-01', inputsHash: 'i'.repeat(64), packageDigest: 'd'.repeat(64), actionHash: 'a'.repeat(64),
  deviceId: 'dev', cpBizNoHmac: 'h'.repeat(64), recipientEmailHmac: null,
});
const gateArm = (a: ArmRow): void => {
  const g = new GateRepo(db);
  const req = randomUUID();
  g.open(req, a.runId);
  g.decide(req, 'approved', 'user');
  new Ledger(db).consumeAndArm(req, a);
};
const code = (c: string) => (e: unknown) => e instanceof LedgerError && e.message === c;

describe('원장 후속 API', () => {
  it('statesByRun: 그 실행의 행 상태만 armed_at 순으로', () => {
    const l = new Ledger(db);
    const run = newRun();
    gateArm(arm(run, 'i1'));
    gateArm(arm(run, 'i2'));
    l.resolve('i1', 'issue', 'committed');
    gateArm(arm(newRun(), 'other'));
    assert.deepEqual(l.statesByRun(run), ['committed', 'armed']);
    assert.deepEqual(l.statesByRun('none'), []);
  });

  it('observedManual: 없으면 넣고, armed·dispatched·in_doubt는 바꾸고, 종결은 던진다. 그 뒤 resolve로 종결한다', () => {
    const l = new Ledger(db);
    const run = newRun();
    l.observedManual(arm(run, 'm-new'));
    assert.equal(l.get('m-new', 'issue')!.state, 'observed_manual');
    l.observedManual(arm(run, 'm-new'));
    assert.equal(l.get('m-new', 'issue')!.state, 'observed_manual', '두 번 불러도 그대로');
    for (const [id, to] of [['m-armed', null], ['m-disp', 'dispatched'], ['m-doubt', 'in_doubt']] as const) {
      gateArm(arm(run, id));
      if (to === 'dispatched') l.dispatched(id, 'issue');
      if (to === 'in_doubt') l.resolve(id, 'issue', 'in_doubt');
      l.observedManual(arm(run, id));
      assert.equal(l.get(id, 'issue')!.state, 'observed_manual', id);
    }
    gateArm(arm(run, 'm-done'));
    l.resolve('m-done', 'issue', 'committed');
    assert.throws(() => l.observedManual(arm(run, 'm-done')), code('ledger_committed'));
    gateArm(arm(run, 'm-not'));
    l.resolve('m-not', 'issue', 'not_committed', 'attested');
    assert.equal((db.prepare("SELECT reason FROM irreversible_log WHERE intent_id = 'm-not'").pluck().get() as string), 'attested', '증언 바 사유(ADR-021 결정 5)');
    assert.throws(() => l.observedManual(arm(run, 'm-not')), code('ledger_not_committed'));
    // observed_manual에서 resolve 가능
    l.resolve('m-new', 'issue', 'committed', null, 'verify-ref');
    assert.equal(l.get('m-new', 'issue')!.state, 'committed');
  });

  it('attestManual: 종결은 바꾸지 않는다. not_committed 뒤면 따로 행 <step>.manual(같은 발급 키)에 남기고 그 키의 새 무장을 막는다', () => {
    const l = new Ledger(db);
    const run = newRun();
    const key = '01KAZZATTEST0000000000000A';
    const a = (id: string): ArmRow => ({ ...arm(run, id), issueKey: key });
    assert.equal(l.attestManual(arm(run, 'am-new')), 'issue', '행 없음: 그 자리에 observed_manual');
    assert.equal(l.get('am-new', 'issue')!.state, 'observed_manual');
    gateArm(arm(run, 'am-done'));
    l.resolve('am-done', 'issue', 'committed');
    assert.equal(l.attestManual(arm(run, 'am-done')), 'issue', 'committed: 쓰지 않는다');
    assert.equal(l.get('am-done', 'issue')!.state, 'committed');
    gateArm(a('am-not'));
    l.resolve('am-not', 'issue', 'not_committed', 'identity_mismatch');
    assert.equal(l.attestManual(a('am-not')), 'issue.manual');
    assert.equal(l.attestManual(a('am-not')), 'issue.manual', '두 번 불러도 같은 행');
    assert.equal(l.get('am-not', 'issue')!.state, 'not_committed', '종결은 그대로(ADR-042)');
    assert.deepEqual(l.byIssueKey(key).map((r) => `${r.stepId}:${r.state}`).sort(), ['issue.manual:observed_manual', 'issue:not_committed']);
    const g = new GateRepo(db);
    g.open('am-q2', run);
    g.decide('am-q2', 'approved', 'user');
    assert.throws(() => l.consumeAndArm('am-q2', a('am-next')), code('ledger_issue_open'), '같은 발급 키의 새 시도는 열린 따로 행이 막는다');
    l.resolve('am-not', 'issue.manual', 'committed', null, 'verify-ref');
    assert.equal(l.attestManual(a('am-not')), 'issue.manual', '따로 행이 committed면 쓰지 않는다');
  });

  it('armFollowUp: 주 단계가 committed일 때만, 게이트 없이 armed. 이미 있으면 던진다', () => {
    const l = new Ledger(db);
    const run = newRun();
    gateArm(arm(run, 'f1'));
    assert.throws(() => l.armFollowUp({ intentId: 'f1', stepId: 'issue' }, arm(run, 'f1', 'mail')), code('ledger_primary_not_committed'));
    assert.throws(() => l.armFollowUp({ intentId: 'nope', stepId: 'issue' }, arm(run, 'nope', 'mail')), code('ledger_primary_not_committed'));
    assert.equal(l.get('f1', 'mail'), null, '실패하면 아무것도 쓰지 않는다');
    l.resolve('f1', 'issue', 'committed');
    l.armFollowUp({ intentId: 'f1', stepId: 'issue' }, arm(run, 'f1', 'mail'));
    assert.equal(l.get('f1', 'mail')!.state, 'armed');
    assert.throws(() => l.armFollowUp({ intentId: 'f1', stepId: 'issue' }, arm(run, 'f1', 'mail')), code('ledger_armed'));
  });
});
