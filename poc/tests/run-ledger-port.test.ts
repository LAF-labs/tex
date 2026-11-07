// 원장·커밋 가드 포트(M2-3, D03 §3 R-G7·§4·§5.4): RunController의 CommitPort를 실제 DB 원장에 잇는다.
// 실제 DB(gate_requests·irreversible_log) + 가짜 가드. 실제 포털 접속 없음.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { GateRepo, Ledger, openDatabase, RunRepo, type ArmRow, type Db } from '@sax/db';
import { LedgerCommitPort, type ArmInput, type LedgerPortInput } from '@sax/engine';
import type { PlaybookIR, SelectorDict, Step } from '@sax/engine/core';

const DICT: SelectorDict = {
  portal: 'hometax',
  commitEndpoints: [],
  knownEndpoints: [],
  entries: {
    'f.issue': { role: 'button', namePattern: '^발급하기$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '발급하기' }], frame: 'main', commits: true, commitEffect: 'issue_document', lastVerified: '2026-11-01' },
    'f.plain': { role: 'button', namePattern: '^확인$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '확인' }], frame: 'main', commits: false, lastVerified: '2026-11-01' },
  },
};
const STEPS: Step[] = [
  { id: 's21', type: 'submit', target: 'f.issue', intent: '$intent.id', verify: 'sv', timeoutMs: 100 },
  { id: 'sv', type: 'verify', lookup: { playbook: 'hometax.invoice.lookup', match: {}, window: 'issueDate', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60_000, lookups: 2 }, bind: {} }, on: { committed: 's22', not_committed: 's22', unknown: 'handoff' } },
  { id: 's25', type: 'submit', target: 'f.plain', intent: '$intent.id', verify: 'sv25', timeoutMs: 100 },
  { id: 's22', type: 'end', status: 'success' },
] as unknown as Step[];
const IR = { ir: 2, id: 'test.pb', version: '1.0.0', portal: 'hometax', profileKinds: ['business'], effects: [], inputs: {}, steps: STEPS, postconditions: [] } as unknown as PlaybookIR;
const INTENT = 'i-1';
const ROW = (o: Partial<ArmRow> = {}): ArmRow => ({ intentId: INTENT, stepId: 's21', runId: 'r1', businessKey: 'bk', playbookId: 'test.pb', inputsHash: 'ih', packageDigest: 'd', actionHash: 'ah', deviceId: 'dv', cpBizNoHmac: 'h', recipientEmailHmac: null, ...o });

describe('LedgerCommitPort(원장·가드 포트, D03 §3 R-G7)', () => {
  let root: string;
  let db: Db;
  let ledger: Ledger;
  let gates: GateRepo;
  let n = 0;
  before(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-lp-'));
  });
  after(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    db?.close();
    db = openDatabase(path.join(root, `${randomBytes(4).toString('hex')}.sqlite`), new Uint8Array(randomBytes(32)));
    ledger = new Ledger(db);
    gates = new GateRepo(db);
    new RunRepo(db).create({ id: 'r1', playbookId: 'test.pb', playbookVersion: '1.0.0', packageDigest: 'd', profileId: 'x', trigger: 'local', inputsHash: 'ih' });
  });

  const approved = () => {
    const req = `q${++n}`;
    gates.open(req, 'r1');
    gates.decide(req, 'approved', 'local');
    return req;
  };
  const mk = (o: Partial<LedgerPortInput> = {}) => {
    const journal: Array<[string, Record<string, unknown> | undefined]> = [];
    const armed: ArmInput[] = [];
    let disarmed = 0;
    const port = new LedgerCommitPort({
      db, ledger, intentId: INTENT, ir: IR, dict: DICT,
      row: (x) => ROW({ stepId: x.stepId, actionHash: x.actionHash }),
      guard: { arm: async (a) => (armed.push(a), { ok: true }), disarm: async () => void disarmed++ },
      pageUrl: () => 'https://hometax.go.kr/form',
      verifyRef: (v) => `ref-${v}`,
      journal: (t, p) => journal.push([t, p]),
      ...o,
    });
    return { port, journal, armed, disarmed: () => disarmed };
  };

  it('arm: 승인된 게이트 요청 → consumed + 원장 armed, 같은 트랜잭션 안에서 inTx가 돈다', () => {
    const req = approved();
    let inTxSawApproved: string | null = null;
    const { port } = mk({ inTx: () => ((inTxSawApproved = gates.state(req)), { ok: true }) });
    assert.deepEqual(port.arm({ stepId: 's21', reqId: req, actionHash: 'ah' }), { ok: true });
    assert.equal(inTxSawApproved, 'approved', 'inTx는 소비 앞(같은 트랜잭션)');
    assert.equal(gates.state(req), 'consumed');
    assert.equal(ledger.get(INTENT, 's21')?.state, 'armed');
  });

  it('arm: inTx 거부면 그 코드로 롤백(토큰 소비·armed 모두 없음)', () => {
    const req = approved();
    const { port } = mk({ inTx: () => ({ ok: false, code: 'policy.irreversible_per_day' }) });
    assert.deepEqual(port.arm({ stepId: 's21', reqId: req, actionHash: 'ah' }), { ok: false, code: 'policy.irreversible_per_day' });
    assert.equal(gates.state(req), 'approved');
    assert.equal(ledger.get(INTENT, 's21'), null);
  });

  it('arm: 원장 거부는 LedgerError 코드(gate_not_approved·ledger_<state>), inTx 쓰기도 롤백', () => {
    const req = approved();
    const { port } = mk();
    assert.deepEqual(port.arm({ stepId: 's21', reqId: req, actionHash: 'ah' }), { ok: true });
    assert.deepEqual(port.arm({ stepId: 's21', reqId: req, actionHash: 'ah' }), { ok: false, code: 'gate_not_approved' }, '같은 요청은 두 번 소비하지 않는다');
    const req2 = approved();
    let wrote = false;
    const p2 = mk({ inTx: () => (db.prepare(`UPDATE gate_requests SET decided_by = 'tx' WHERE req_id = ?`).run(req), (wrote = true), { ok: true }) }).port;
    assert.deepEqual(p2.arm({ stepId: 's21', reqId: req2, actionHash: 'ah' }), { ok: false, code: 'ledger_armed' }, '같은 (intent, step) 행이 있으면 거부');
    assert.ok(wrote);
    assert.equal(gates.state(req2), 'approved', '소비도 롤백');
    assert.equal((db.prepare('SELECT decided_by FROM gate_requests WHERE req_id = ?').get(req) as { decided_by: string }).decided_by, 'local', 'inTx 쓰기도 롤백');
  });

  it('arm: 행 재료가 없거나 이 실행 intent·스텝·actionHash와 다르면 ledger.row_missing(아무것도 쓰지 않음)', () => {
    const req = approved();
    for (const row of [() => null, () => ROW({ intentId: 'other' }), () => ROW({ stepId: 's99' }), () => ROW({ actionHash: 'zz' })]) {
      assert.deepEqual(mk({ row }).port.arm({ stepId: 's21', reqId: req, actionHash: 'ah' }), { ok: false, code: 'ledger.row_missing' });
    }
    assert.equal(gates.state(req), 'approved');
    assert.equal(ledger.get(INTENT, 's21'), null);
  });

  it('armGuard: X 타깃의 commitEffect·토큰 exp·지금 탭 URL로 가드를 무장, disarmGuard는 해제', async () => {
    const { port, armed, disarmed } = mk();
    assert.deepEqual(await port.armGuard({ stepId: 's21', armedUntil: 5_000 }), { ok: true });
    assert.deepEqual(armed, [{ intentId: INTENT, stepId: 's21', effect: 'issue_document', armedUntil: 5_000, pageUrl: 'https://hometax.go.kr/form' }]);
    await port.disarmGuard();
    assert.equal(disarmed(), 1);
  });

  it('armGuard: 타깃이 커밋 버튼이 아니거나 모르는 스텝이면 거부(무장 없음), 가드가 없으면 통과', async () => {
    const { port, armed } = mk();
    assert.deepEqual(await port.armGuard({ stepId: 's25', armedUntil: 1 }), { ok: false, code: 'commit_guard.arm_refused' });
    assert.deepEqual(await port.armGuard({ stepId: 'nope', armedUntil: 1 }), { ok: false, code: 'commit_guard.arm_refused' });
    assert.equal(armed.length, 0);
    assert.deepEqual(await mk({ guard: undefined }).port.armGuard({ stepId: 's21', armedUntil: 1 }), { ok: true });
  });

  const armRow = (port: LedgerCommitPort) => assert.deepEqual(port.arm({ stepId: 's21', reqId: approved(), actionHash: 'ah' }), { ok: true });

  it('ledgerEffect: dispatched(X에서) → committed(verify에서, verify_ref = 그 verify의 ref)', () => {
    const { port, journal } = mk();
    armRow(port);
    assert.equal(port.ledgerEffect('ledger.dispatched', 's21'), true);
    assert.equal(ledger.get(INTENT, 's21')?.state, 'dispatched');
    assert.equal(port.ledgerEffect('ledger.committed{verify_ref}', 'sv'), true);
    const r = ledger.get(INTENT, 's21');
    assert.equal(r?.state, 'committed');
    assert.equal(r?.verifyRef, 'ref-sv');
    assert.deepEqual(journal.map(([t]) => t), ['ledger.dispatched', 'ledger.committed']);
    assert.ok(!JSON.stringify(journal).includes('ref-sv'), 'verify_ref 값은 저널에 없다(⑦)');
  });

  it('ledgerEffect: not_committed{reason}은 그 사유, verify에서 오면 X 행', () => {
    for (const [effect, at, reason] of [['ledger.not_committed{pre_dispatch_mismatch}', 's21', 'pre_dispatch_mismatch'], ['ledger.not_committed{verify}', 'sv', 'verify']] as const) {
      db.prepare('DELETE FROM irreversible_log').run();
      const { port, journal } = mk();
      armRow(port);
      port.ledgerEffect(effect, at);
      const r = ledger.get(INTENT, 's21');
      assert.equal(r?.state, 'not_committed');
      assert.equal(r?.reason, reason);
      assert.deepEqual(journal.at(-1), ['ledger.not_committed', { stepId: 's21', reason }]);
    }
  });

  it('ledgerEffect: in_doubt 뒤 재검증 committed(재시작 뒤 같은 intentId 포트로도)', () => {
    const { port } = mk();
    armRow(port);
    port.ledgerEffect('ledger.dispatched', 's21');
    port.ledgerEffect('ledger.in_doubt', 'sv');
    assert.equal(ledger.get(INTENT, 's21')?.state, 'in_doubt');
    const fresh = mk().port;
    fresh.ledgerEffect('ledger.committed{verify_ref}', 'sv');
    assert.equal(ledger.get(INTENT, 's21')?.state, 'committed');
  });

  it('ledgerEffect: 두 X가 같은 verify를 가리키면(V-04a 위반) 추측하지 않고 열린 행을 in_doubt로 닫는다, committed로 적지 않는다', () => {
    const steps = structuredClone(STEPS) as Array<Step & { verify?: string }>;
    steps.find((s) => s.id === 's25')!.verify = 'sv';
    const ir = { ...IR, steps } as unknown as PlaybookIR;
    const { port, journal } = mk({ ir });
    armRow(port);
    port.ledgerEffect('ledger.dispatched', 's21');
    assert.equal(port.ledgerEffect('ledger.committed{verify_ref}', 'sv'), true);
    const r = ledger.get(INTENT, 's21');
    assert.equal(r?.state, 'in_doubt');
    assert.equal(r?.verifyRef, null);
    assert.equal(ledger.get(INTENT, 's25'), null, '행이 없는 X는 건드리지 않는다');
    assert.deepEqual(journal.slice(-2), [['ledger.verify_ambiguous', { effect: 'committed', candidates: 2 }], ['ledger.in_doubt', { stepId: 's21' }]]);
    port.ledgerEffect('ledger.not_committed{verify}', 'sv');
    assert.equal(ledger.get(INTENT, 's21')?.state, 'in_doubt', 'not_committed로도 적지 않는다');
  });

  it('ledgerEffect: 원장 효과가 아니면 false, 자리 없으면 effect_unbound, 원장 거부는 write_failed(던지지 않음)', () => {
    const { port, journal } = mk();
    assert.equal(port.ledgerEffect('input.unlock', 's21'), false);
    assert.equal(port.ledgerEffect('ledger.observed_manual', 's21'), false);
    assert.equal(port.ledgerEffect('ledger.dispatched', null), true);
    assert.equal(port.ledgerEffect('ledger.dispatched', 's21'), true, '행이 없다');
    assert.deepEqual(journal, [['ledger.effect_unbound', { effect: 'dispatched' }], ['ledger.write_failed', { effect: 'dispatched', code: 'ledger_not_armed' }]]);
  });
});
