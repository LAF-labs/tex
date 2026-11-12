// 무장 → 누르기 전 동일성 불일치(identity_mismatch) → s21 not_committed → HandedOff → [직접 발급함]의 회귀 시험.
// 고치기 전에는 Ledger.observedManual이 ledger_not_committed로 던져 write_failed만 남았다. 사다리는 "모두 not_committed"로 보고 다음 칸으로 갈 수 있었다.
// 고친 뒤: s21 종결은 그대로, 따로 행 s21.manual(같은 발급 키)이 생기고 verify 판정은 그 행에 붙는다. 같은 키 재요청은 새 시도를 만들지 않는다.
// 처음 모양은 mid-verify 세션의 zz-known-gap 스크래치 시험이다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { GateRepo, Ledger, openDatabase, RunRepo, type ArmRow, type Db } from '@sax/db';
import { IssueLadder, LedgerCommitPort, parseIssueKey, routeSpec, ulid, type IssueKey, type Rung } from '@sax/engine';
import { state, transition, type PlaybookIR, type SelectorDict, type Step } from '@sax/engine/core';
import { FileEventLog } from '@sax/platform';

const DICT: SelectorDict = {
  portal: 'hometax', commitEndpoints: [], knownEndpoints: [],
  entries: {
    'f.issue': { role: 'button', namePattern: '^발급하기$', landmark: 'f.root', candidates: [{ kind: 'role', role: 'button', name: '발급하기' }], frame: 'main', commits: true, commitEffect: 'issue_document', lastVerified: '2026-11-01' },
  },
};
const STEPS: Step[] = [
  { id: 's21', type: 'submit', target: 'f.issue', intent: '$intent.id', verify: 'sv', timeoutMs: 100 },
  { id: 'sv', type: 'verify', lookup: { playbook: 'hometax.invoice.lookup', match: {}, window: 'issueDate', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60_000, lookups: 2 }, bind: {} }, on: { committed: 's22', not_committed: 's22', unknown: 'handoff' } },
  { id: 's22', type: 'end', status: 'success' },
] as unknown as Step[];
const IR = { ir: 2, id: 'test.pb', version: '1.0.0', portal: 'hometax', profileKinds: ['business'], effects: [], inputs: {}, steps: STEPS, postconditions: [] } as unknown as PlaybookIR;

let root = '';
const opened: Db[] = [];
after(async () => {
  for (const d of opened) d.close();
  if (root) await fsp.rm(root, { recursive: true, force: true });
});

describe('무장 → identity_mismatch → [직접 발급함]', () => {
  for (const verifyAfterAttest of ['unknown', 'committed'] as const) {
    it(`[직접 발급함] 뒤 verify ${verifyAfterAttest}: 같은 키 원장에 열린/발급 행이 남고 재요청은 새 시도를 만들지 않는다`, async () => {
      root ||= await fsp.mkdtemp(path.join(os.tmpdir(), 'sax-gap-'));
      const db = openDatabase(path.join(root, `${randomBytes(4).toString('hex')}.sqlite`), new Uint8Array(randomBytes(32)));
      opened.push(db);
      const ledger = new Ledger(db);
      const gates = new GateRepo(db);
      new RunRepo(db).create({ id: 'r1', playbookId: 'test.pb', playbookVersion: '1.0.0', packageDigest: 'd', profileId: 'x', trigger: 'local', inputsHash: 'ih' });
      const K = parseIssueKey(ulid()) as IssueKey;
      const INTENT = ulid();
      const ROW = (o: Partial<ArmRow> = {}): ArmRow => ({ intentId: INTENT, stepId: 's21', runId: 'r1', businessKey: 'bk', playbookId: 'test.pb', inputsHash: 'ih', packageDigest: 'd', actionHash: 'ah', deviceId: 'dv', cpBizNoHmac: 'h', recipientEmailHmac: null, issueKey: K, ...o });
      const journal: Array<[string, Record<string, unknown> | undefined]> = [];
      // RunService가 IR 실행에 주는 것과 같은 모양: s21 행에만 발급 키, manualRow는 초안 재료.
      const port = new LedgerCommitPort({
        db, ledger, intentId: INTENT, ir: IR, dict: DICT,
        row: (x) => ROW({ stepId: x.stepId, actionHash: x.actionHash, issueKey: x.stepId === 's21' ? K : null }),
        manualRow: (x: string) => ROW({ stepId: x, actionHash: 'manual', issueKey: x === 's21' ? K : null }),
        guard: { arm: async () => ({ ok: true }), disarm: async () => {} },
        pageUrl: () => 'https://hometax.go.kr/form', verifyRef: (v) => `ref-${v}`, journal: (t, p) => journal.push([t, p]),
      } as ConstructorParameters<typeof LedgerCommitPort>[0]);

      // 1) 승인 → 무장(s21 armed, 발급 키)
      gates.open('q1', 'r1');
      gates.decide('q1', 'approved', 'local');
      assert.deepEqual(port.arm({ stepId: 's21', reqId: 'q1', actionHash: 'ah' }), { ok: true });
      assert.equal(ledger.get(INTENT, 's21')?.state, 'armed');

      // 2) 상태 머신: 커밋 구간에서 identity_mismatch → HandedOff + ledger.not_committed{identity_mismatch} (실제 전이표의 효과)
      const t1 = transition(state('Running', { commit: true }), { t: 'identity_mismatch' }, { allowed: true, ledger: ['armed'] });
      assert.ok(t1.ok && t1.state.name === 'HandedOff');
      const e1 = t1.effects.filter((e) => e.startsWith('ledger.'));
      assert.deepEqual(e1, ['ledger.not_committed{identity_mismatch}']);
      for (const e of e1) port.ledgerEffect(e, 's21');
      assert.equal(ledger.get(INTENT, 's21')?.state, 'not_committed');

      // 3) 사장님 [직접 발급함]: 전이표의 효과(ledger.observed_manual)를 X(s21)에 적는다(RunController.attestManualCommit과 같은 at).
      const t2 = transition(t1.state, { t: 'attest_manual_commit' }, { allowed: true, ledger: ['not_committed', 'observed_manual'] });
      assert.ok(t2.ok);
      for (const e of t2.effects.filter((x) => x.startsWith('ledger.'))) port.ledgerEffect(e, 's21');
      // 4) verify 결과 효과(verify 스텝 sv에서): committed면 ledger.committed, unknown이면 in_doubt 쪽
      const t3 = transition(t2.state, { t: 'verify', result: verifyAfterAttest }, { allowed: true, ledger: [ledger.get(INTENT, 's21')!.state] });
      if (t3.ok) for (const e of t3.effects.filter((x) => x.startsWith('ledger.'))) port.ledgerEffect(e, 'sv');

      const rows = ledger.byIssueKey(K);
      const states = rows.map((r) => `${r.stepId}:${r.state}`);
      const writeFailed = journal.filter(([t]) => t === 'ledger.write_failed').map(([, p]) => p);
      // 사다리 재요청: 칸 실행 수를 센다.
      let calls = 0;
      const rung: Rung = { route: routeSpec('hometax.auto'), available: () => ({ ok: true }), run: async () => (calls++, { code: 'assert.supplier_mismatch' }) };
      const ladder = new IssueLadder({ rungs: [rung], ledger, log: new FileEventLog(null, 'engine') });
      const st = ladder.request({ issueKey: K, counterpartyId: 'c', supply: 1, tax: 0, itemName: 'x' });
      const diag = `rows=${JSON.stringify(states)} write_failed=${JSON.stringify(writeFailed)} ladder=${st.s} rungCalls=${calls}`;
      assert.deepEqual(writeFailed, [], diag);
      assert.equal(ledger.get(INTENT, 's21')?.state, 'not_committed', `종결은 바꾸지 않는다. ${diag}`);
      assert.equal(ledger.get(INTENT, 's21.manual')?.state, verifyAfterAttest === 'committed' ? 'committed' : 'in_doubt', diag);
      assert.ok(rows.some((r) => r.state !== 'not_committed'), `사람이 발급했다고 했는데 같은 키에 열린/발급 행이 없다. ${diag}`);
      assert.ok(st.s === 'held' || st.s === 'issued', `재요청이 새 시도를 시작한다. ${diag}`);
      assert.equal(calls, 0, diag);
    });
  }
});
