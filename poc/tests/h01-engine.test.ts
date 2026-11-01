// PoC-6(Mac 선행분): H-01 실행기·게이트·원장을 Electron 없이 시험한다. 금고는 프로세스 안(시험 정책 127.0.0.1)·헤드리스 Chrome,
// 페이지는 가짜 H-01 픽스처다. main 승인 바 대신 시험이 게이트 요청을 받아 해시를 다시 계산하고 LocalApproval v2를 넣는다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { DataService, BizVerifier, connectRunBrowser, cbor, jcs, cardHash, recomputeActionHash, gateSelfCheck, fixturePortal, HOMETAX_PORTAL, portalProblems, RunService, ariaValue, normalizeField, canonicalEmail, type GatePortMessage, type GateRequest, type LocalApproval, type RunEvent } from '@sax/engine';
import { GateRepo, Ledger, openDatabase, RunJournal, RunRepo, type Db } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import { startH01Fixture, type H01Fixture } from '../apps/desktop/src/h01-fixture.ts';
import { startHarness, type Harness } from './harness.ts';

const SUPPLIER = { bizNo: '1234567891', name: '가나다컴퍼니' };
const A = { bizNo: '2148651233', name: 'A상사', email: 'tax@asangsa.example' };
const C = { bizNo: '4182577343', name: 'C테크', email: 'billing@ctech.example' };

describe('게이트 해시(D03 §3)', () => {
  it('결정적 CBOR: 맵 키는 인코딩 바이트 순, 가장 짧은 길이', () => {
    assert.equal(cbor({ b: 1, a: 2 }).toString('hex'), 'a2616102616201');
    assert.equal(cbor({ aa: 1, b: 2 }).toString('hex'), 'a261620262616101'); // 짧은 키가 먼저(길이 머리 바이트)
    assert.equal(cbor(23).toString('hex'), '17');
    assert.equal(cbor(24).toString('hex'), '1818');
    assert.equal(cbor(1_000_000).toString('hex'), '1a000f4240');
    assert.equal(cbor([new Uint8Array([1, 2]), 'é', true, null]).toString('hex'), '844201026 2c3a9f5f6'.replace(/\s/g, ''));
    assert.throws(() => cbor(-1), /cbor_bad_length/);
    assert.throws(() => cbor('a\ud800'), /cbor_bad_string/, '고립 서로게이트는 U+FFFD로 바뀌어 다른 값과 같은 해시가 된다');
    assert.throws(() => cbor(1.5), /cbor_bad_length/);
  });

  it('JCS: 키 순서와 무관, undefined 키는 뺀다', () => {
    assert.equal(jcs({ b: '1', a: ['x', 2], c: undefined }), '{"a":["x",2],"b":"1"}');
  });

  it('cardHash는 키·값·순서를 모두 묶는다', () => {
    const f = [{ fieldKey: 'counterpartBizNo', value: '1' }, { fieldKey: 'totalAmount', value: '2' }] as const;
    const h = cardHash([...f]);
    assert.notEqual(h, cardHash([f[1], f[0]]));
    assert.notEqual(h, cardHash([f[0], { fieldKey: 'totalAmount', value: '3' }]));
    assert.match(h, /^[0-9a-f]{64}$/);
  });
});

describe('readback 값', () => {
  it('aria 스냅숏 값 파싱', () => {
    assert.equal(ariaValue('- textbox "공급가액": "3300000"', 'textbox'), '3300000');
    assert.equal(ariaValue('- textbox "상호": A상사', 'textbox'), 'A상사');
    assert.equal(ariaValue('- textbox "비고"', 'textbox'), '');
    assert.equal(ariaValue('- status "합계금액": "3630000"', 'status'), '3630000');
    assert.equal(ariaValue('- combobox "영수/청구":\n  - option "영수" [selected]\n  - option "청구"', 'combobox'), '영수');
  });

  it('정규화와 HMAC용 이메일', () => {
    assert.equal(normalizeField('supplyAmount', '3,300,000원'), '3300000');
    assert.equal(normalizeField('counterpartBizNo', '214-86-51233'), '2148651233');
    assert.equal(normalizeField('issueDate', '20261101'), '2026-11-01');
    assert.equal(normalizeField('supplyAmount', '1٣00'), '1٣00', '숫자 밖 문자는 남겨 바가 거부하게 한다');
    assert.equal(canonicalEmail(' Tax@Bücher.Example '), 'tax@xn--bcher-kva.example');
  });
});

describe('포털 설정', () => {
  it('홈택스는 PoC-3 전까지 자리표시라 실행하지 않는다, 가짜 페이지는 문제 없음', () => {
    const p = portalProblems(HOMETAX_PORTAL);
    assert.ok(p.some((x) => x.startsWith('placeholder:selector:form.issueButton')), p.join(','));
    assert.deepEqual(portalProblems(fixturePortal('http://127.0.0.1:1')), []);
    assert.ok(portalProblems({ ...HOMETAX_PORTAL, verify: { minElapsedMs: 1, lookups: 1, intervalMs: 1 } }).includes('verify_below_floor'));
  });
});

async function tempDb(): Promise<{ db: Db; dir: string }> {
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-h01-'));
  return { db: openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32))), dir };
}

describe('원장(D03 §4, ADR-021)', () => {
  let db: Db;
  let dir: string;
  before(async () => ({ db, dir } = await tempDb()));
  after(async () => {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('기동 시 정리: armed → in_doubt, 열린·승인만 된 게이트 → 만료, 실행 중 → 중단', () => {
    const runs = new RunRepo(db);
    runs.create({ id: 'rr', playbookId: 'p', playbookVersion: '1', packageDigest: 'd', profileId: 'x', trigger: 'local', inputsHash: 'i' });
    const g = new GateRepo(db);
    g.open('qa', 'rr');
    g.decide('qa', 'approved', 'local');
    g.open('qb', 'rr');
    g.open('qc', 'rr');
    g.decide('qc', 'approved', 'local');
    new Ledger(db).consumeAndArm('qc', { intentId: 'IR', stepId: 's21', runId: 'rr', businessKey: 'bk2', playbookId: 'p', inputsHash: 'i', packageDigest: 'd', actionHash: 'a', deviceId: 'dv', cpBizNoHmac: 'h9', recipientEmailHmac: null });
    const data = new DataService(db, new BizVerifier(new Egress()));
    new RunService({ db, data, ledgerKey: new Uint8Array(32), portal: HOMETAX_PORTAL, log: new FileEventLog(null, 't'), page: () => Promise.reject(new Error('no')), postGate: () => {} });
    assert.deepEqual([g.state('qa'), g.state('qb'), g.state('qc')], ['expired', 'expired', 'consumed']);
    assert.equal(new Ledger(db).get('IR', 's21')!.state, 'in_doubt');
    assert.equal(runs.status('rr'), 'interrupted');
  });

  it('마이그레이션 v2: HMAC 열, 원장 쓰기는 synchronous=FULL', () => {
    assert.equal(db.pragma('synchronous', { simple: true }), 2);
    const cols = (db.prepare('PRAGMA table_info(irreversible_log)').all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(cols.includes('cp_biz_no_hmac') && cols.includes('recipient_email_hmac'));
    assert.equal(db.pragma('user_version', { simple: true }), 2);
  });

  it('approved가 아닌 게이트로는 armed를 쓰지 않는다, 결정은 open에서 한 번만', () => {
    new RunRepo(db).create({ id: 'r1', playbookId: 'p', playbookVersion: '1', packageDigest: 'd', profileId: 'x', trigger: 'local', inputsHash: 'i' });
    const g = new GateRepo(db);
    const l = new Ledger(db);
    g.open('q1', 'r1');
    const row = { intentId: 'I1', stepId: 's21', runId: 'r1', businessKey: 'bk', playbookId: 'p', inputsHash: 'i', packageDigest: 'd', actionHash: 'a', deviceId: 'dv', cpBizNoHmac: 'h1', recipientEmailHmac: 'e1' };
    assert.throws(() => l.consumeAndArm('q1', row), /gate_not_approved/);
    assert.equal(l.get('I1', 's21'), null);
    assert.ok(g.decide('q1', 'approved', 'local'));
    assert.ok(!g.decide('q1', 'denied', 'local'), '두 번째 결정은 무시');
    l.consumeAndArm('q1', row);
    assert.equal(g.state('q1'), 'consumed');
    assert.throws(() => l.consumeAndArm('q1', row), /gate_not_approved/, '토큰은 한 번만');
    assert.deepEqual(l.history({ cpBizNoHmac: 'h1', recipientEmailHmac: 'e1', businessKey: 'bk' }), { firstBizNo: true, firstEmail: true, businessKeyStates: ['armed'], priorNotCommitted: false });
    l.dispatched('I1', 's21');
    assert.equal(l.promoteInDoubt(), 1, '재시작 시 dispatched → in_doubt');
    l.resolve('I1', 's21', 'committed', null, 'APP-1');
    const h = l.history({ cpBizNoHmac: 'h1', recipientEmailHmac: 'e1', businessKey: 'bk' });
    assert.equal(h.firstBizNo, false, 'committed 행이 생기면 처음 거래가 아니다');
    assert.throws(() => l.resolve('I1', 's21', 'not_committed'), /ledger_not_open/, '종결된 행은 다시 바뀌지 않는다');
    assert.deepEqual(l.checkIntent('I1', 's21', 'p', 'other'), { kind: 'reuse_mismatch' });
    const j = new RunJournal(db);
    j.append('r1', 'a');
    j.append('r1', 'b');
    const rows = db.prepare('SELECT prev_hash, hash FROM run_events WHERE run_id = ? ORDER BY seq').all('r1') as Array<{ prev_hash: string; hash: string }>;
    assert.equal(rows[1]!.prev_hash, rows[0]!.hash, '저널 해시 체인');
  });
});

describe('H-01 실행(가짜 페이지, 금고 중계 위 Playwright)', () => {
  let fx: H01Fixture;
  let h: Harness;
  let db: Db;
  let dir: string;
  let data: DataService;
  let runs: RunService;
  let page: Page | null = null;
  const gateMsgs: GatePortMessage[] = [];
  const events: RunEvent[] = [];
  const log = new FileEventLog(null, 'engine');
  let cpA: string;
  let cpC: string;
  let n = 0;

  const next = <T>(pred: () => T | undefined, ms = 30_000): Promise<T> =>
    new Promise((resolve, reject) => {
      const until = Date.now() + ms;
      const tick = () => {
        const v = pred();
        if (v !== undefined) return resolve(v);
        if (Date.now() > until) return reject(new Error('timeout'));
        setTimeout(tick, 50);
      };
      tick();
    });
  const gateFor = (runId: string) => next(() => (gateMsgs.find((m) => m.t === 'gate.request' && m.req.runId === runId) as { req: GateRequest } | undefined)?.req);
  const endOf = (runId: string) => next(() => events.find((e) => e.runId === runId && e.type === 'end') as Extract<RunEvent, { type: 'end' }> | undefined, 60_000);
  const approval = (req: GateRequest, over: Partial<LocalApproval> = {}): LocalApproval => ({
    v: 2, runId: req.runId, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1', ...over,
  });
  const start = (cp: string, supply: number, extra: Record<string, unknown> = {}) => {
    const runId = `run-${++n}`;
    runs.start({ runId, counterpartyId: cp, supply, tax: Math.floor(supply / 10), itemName: '경영 컨설팅', ...extra });
    return runId;
  };
  const field = (req: GateRequest, k: string) => req.fields.find((f) => f.fieldKey === k)?.value;
  const phaseNow = (runId: string, phase: string) => next(() => (events.some((e) => e.runId === runId && e.type === 'phase' && e.phase === phase && e.state === 'now') ? true : undefined));

  before(async () => {
    fx = await startH01Fixture({ registry: { [A.bizNo]: A.name, [C.bizNo]: C.name }, supplier: SUPPLIER });
    h = await startHarness();
    ({ db, dir } = await tempDb());
    data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: SUPPLIER.name, bizNo: SUPPLIER.bizNo, corpNo: null, repName: '김가나', bizType: null, bizItem: null, address: null, email: null, signMethod: 'simple_auth' });
    cpA = data.counterparties.create({ ...A }).id;
    cpC = data.counterparties.create({ ...C }).id;
    runs = new RunService({
      db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: fixturePortal(fx.origin), log,
      page: async () => (page && !page.isClosed() ? page : (page = (await connectRunBrowser(h.client)).page)),
      postGate: (m) => gateMsgs.push(m),
    });
    runs.on('event', (e: RunEvent) => events.push(e));
  });

  after(async () => {
    await page?.context().browser()?.close().catch(() => {});
    await h.close();
    await fx.close();
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('초안 → 게이트 → 승인 근거 v2 → 발급 → verify 새 1건 → 메일 확인 → 원장 committed', async () => {
    const runId = start(cpA, 3_300_000);
    const req = await gateFor(runId);
    assert.equal(recomputeActionHash(req), req.actionHash, 'main이 받은 fields로 다시 계산한 해시가 같다');
    assert.equal(gateSelfCheck(req), null);
    assert.equal(gateSelfCheck({ ...req, fields: req.fields.map((f) => (f.fieldKey === 'taxAmount' ? { ...f, value: '1' } : f)) }), 'readback_hash');
    assert.equal(gateSelfCheck({ ...req, fields: [...req.fields, { fieldKey: '$first.bizNo', value: 'false' }] }), 'duplicate');
    assert.equal(gateSelfCheck({ ...req, actionHash: '0'.repeat(64) }), 'action_hash');
    assert.deepEqual(req.fields.slice(0, 13).map((f) => f.fieldKey), ['supplierBizNo', 'supplierName', 'counterpartBizNo', 'counterpartName', 'counterpartEmail', 'itemName', 'itemCount', 'supplyAmount', 'taxAmount', 'totalAmount', 'issueDate', 'remark', 'receiptType']);
    assert.equal(field(req, 'counterpartEmail'), A.email, '포털이 미리 채운 주소를 덮었다');
    assert.equal(field(req, 'totalAmount'), '3630000');
    assert.equal(field(req, '$first.bizNo'), 'true');
    assert.equal(field(req, '$first.email'), 'true');
    assert.equal(field(req, '$dup.businessKey'), undefined);
    assert.equal(fx.posts(), 0, '게이트 전에는 제출하지 않는다');

    // 위조·중계 경로 근거는 거부한다.
    assert.deepEqual(runs.answer(approval(req, { approvalNonce: 'x' })), { ok: false, code: 'wrong_nonce' });
    assert.deepEqual(runs.answer(approval(req, { reqId: 'other' })), { ok: false, code: 'wrong_gate' });
    assert.deepEqual(runs.answer(approval(req, { actionHash: '0'.repeat(64) })), { ok: false, code: 'wrong_action' });
    assert.deepEqual(runs.answer(approval(req, { exp: Date.now() - 1 })), { ok: false, code: 'expired' });
    assert.deepEqual(runs.answer(approval(req, { exp: Date.now() + 3_600_000 })), { ok: false, code: 'expired' });
    assert.deepEqual(runs.answer(approval(req, { presence: 'click+waiver' })), { ok: false, code: 'presence_unsupported' });
    assert.deepEqual(runs.answer({ ...approval(req), v: 1 }), { ok: false, code: 'bad_version' });
    assert.throws(() => runs.answerFromRelay('gate.answer'), /forbidden_channel/);
    assert.ok(log.lines.some((l) => l.includes('security.gate_answer_from_relay')));
    assert.equal(fx.posts(), 0);

    assert.deepEqual(runs.answer(approval(req)), { ok: true });
    assert.deepEqual(runs.answer(approval(req)), { ok: false, code: 'no_open_gate' }, '같은 근거는 한 번만');
    const end = await endOf(runId);
    assert.equal(end.status, 'success', JSON.stringify(end));
    assert.equal(fx.posts(), 1);
    assert.equal(end.approvalNo, fx.issued[0]!.approvalNo);
    assert.equal(end.mailConfirmed, true);
    const ins = runs.inspect(runId);
    assert.equal(ins.ledger, 'committed');
    const row = db.prepare('SELECT * FROM irreversible_log WHERE run_id = ?').get(runId) as Record<string, unknown>;
    const plain = [SUPPLIER.bizNo, A.bizNo, A.email, A.name, '3300000', '330000', '3630000'];
    assert.deepEqual(Object.entries(row).filter(([, v]) => typeof v === 'string' && plain.some((p) => v.includes(p))), [], '원장에 사업자번호·이메일·상호·금액 평문이 없다');
    assert.equal(row.verify_ref, end.approvalNo);
    for (const t of ['run.started', 'gate.requested', 'gate.answer_rejected', 'security.gate_answer_from_relay', 'gate.approved', 'ledger.armed', 'ledger.dispatched', 'ledger.committed', 'run.ended']) assert.ok(ins.journal.includes(t), t);
    assert.ok(ins.journal.indexOf('ledger.armed') < ins.journal.indexOf('ledger.dispatched'));
    const phases = events.filter((e) => e.runId === runId && e.type === 'phase' && e.state === 'now').map((e) => (e as { phase: string }).phase);
    assert.deepEqual(phases, ['login', 'form', 'input', 'readback', 'gate', 'sign', 'verify', 'mail']);
  });

  it('같은 건 두 번째: 처음 표시 없음, 중복 경고($dup.businessKey) → [중지]하면 발급하지 않는다', async () => {
    const runId = start(cpA, 3_300_000);
    const req = await gateFor(runId);
    assert.equal(field(req, '$first.bizNo'), 'false');
    assert.equal(field(req, '$first.email'), 'false');
    assert.equal(field(req, '$dup.businessKey'), 'committed');
    assert.equal(recomputeActionHash(req), req.actionHash);
    assert.deepEqual(runs.stop(runId), { stopped: true });
    const end = await endOf(runId);
    assert.equal(end.status, 'stopped');
    assert.ok(gateMsgs.some((m) => m.t === 'gate.closed' && m.reqId === req.reqId && m.reason === 'stopped'));
    assert.deepEqual(runs.answer(approval(req)), { ok: false, code: 'no_open_gate' }, '중지 뒤 근거는 통하지 않는다');
    assert.equal(fx.posts(), 1);
    assert.equal(runs.inspect(runId).ledger, null);
  });

  it('공급자 사업자번호가 프로필과 다르면(다른 사업자 세션) 게이트를 열지 않는다', async () => {
    fx.knobs.supplier = { bizNo: '3051288767', name: 'B상사' };
    try {
      const runId = start(cpC, 500_000);
      const end = await endOf(runId);
      assert.deepEqual([end.status, end.code], ['failed', 'assert.supplier_mismatch']);
      assert.ok(!gateMsgs.some((m) => m.t === 'gate.request' && m.req.runId === runId));
      assert.equal(runs.inspect(runId).ledger, null);
      assert.equal(fx.posts(), 1);
    } finally {
      fx.knobs.supplier = SUPPLIER;
    }
  });

  it('승인 뒤 화면 값이 바뀌면 클릭하지 않고 not_committed(pre_dispatch_mismatch)', async () => {
    const runId = start(cpC, 700_000);
    const req = await gateFor(runId);
    try {
      assert.deepEqual(runs.answer(approval(req)), { ok: true });
      fx.knobs.mutate = { field: 'splAmt', value: '7000001' }; // 거부 우선 창(2초) 안에 페이지가 바꾼다
      const end = await endOf(runId);
      assert.deepEqual([end.status, end.code], ['failed', 'pre_dispatch_mismatch']);
      assert.equal(fx.posts(), 1, '제출하지 않았다');
      assert.equal(runs.inspect(runId).ledger, 'not_committed');
    } finally {
      fx.knobs.mutate = null;
    }
  });

  it('발급 요청을 보냈는데 목록에 안 보이면 in_doubt(중복 위험을 숨기지 않는다)', async () => {
    fx.knobs.dropIssue = true;
    try {
      const runId = start(cpC, 800_000);
      assert.deepEqual(runs.answer(approval(await gateFor(runId))), { ok: true });
      const end = await endOf(runId);
      assert.deepEqual([end.status, end.code], ['in_doubt', 'verify.unknown']);
      assert.equal(runs.inspect(runId).ledger, 'in_doubt');
      assert.equal(fx.posts(), 2);
    } finally {
      fx.knobs.dropIssue = false;
    }
  });

  it('명시적 실패 신호 + 부재 증거면 not_committed, 같은 건 다음 게이트에 직전 시도 경고', async () => {
    fx.knobs.failIssue = true;
    let runId: string;
    try {
      runId = start(cpC, 900_000);
      assert.deepEqual(runs.answer(approval(await gateFor(runId))), { ok: true });
      const end = await endOf(runId);
      assert.deepEqual([end.status, end.code], ['failed', 'verify.not_committed']);
      assert.equal(runs.inspect(runId).ledger, 'not_committed');
    } finally {
      fx.knobs.failIssue = false;
    }
    const again = start(cpC, 900_000);
    const req = await gateFor(again);
    assert.equal(field(req, '$dup.priorNotCommitted'), 'true');
    assert.equal(field(req, '$dup.businessKey'), 'not_committed');
    assert.equal(field(req, '$first.bizNo'), 'true', 'committed가 없으니 아직 처음 거래');
    runs.stop(again);
    await endOf(again);
  });

  it('기준선 조회 중 [중지]: 게이트를 열지 않는다', async () => {
    fx.knobs.lookupDelayMs = 1500;
    try {
      const runId = start(cpC, 110_000);
      await phaseNow(runId, 'gate');
      assert.deepEqual(runs.stop(runId), { stopped: true });
      const end = await endOf(runId);
      assert.equal(end.status, 'stopped');
      assert.ok(!gateMsgs.some((m) => m.t === 'gate.request' && m.req.runId === runId), '게이트 요청이 나가지 않았다');
    } finally {
      fx.knobs.lookupDelayMs = 0;
    }
  });

  it('승인 직후(거부 우선 창 2초) [중지]가 이긴다, 커밋 구간에 들어간 뒤에는 already_issuing', async () => {
    const posts = fx.posts();
    const r1 = start(cpC, 120_000);
    const q1 = await gateFor(r1);
    assert.deepEqual(runs.answer(approval(q1)), { ok: true });
    assert.deepEqual(runs.stop(r1), { stopped: true });
    assert.equal((await endOf(r1)).status, 'stopped');
    assert.equal(new GateRepo(db).state(q1.reqId), 'denied');
    assert.equal(fx.posts(), posts);
    fx.knobs.reflectDelayMs = 400; // verify 창(600ms·2회) 안에 반영되게
    try {
      const r2 = start(cpC, 130_000);
      assert.deepEqual(runs.answer(approval(await gateFor(r2))), { ok: true });
      await phaseNow(r2, 'verify');
      assert.throws(() => runs.stop(r2), /already_issuing/);
      assert.equal((await endOf(r2)).status, 'success');
    } finally {
      fx.knobs.reflectDelayMs = 0;
    }
  });

  it('승인 대기가 waitMs를 넘으면 만료(발급 없음), 만료 뒤 근거는 통하지 않는다', async () => {
    const short = new RunService({ db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal: fixturePortal(fx.origin), log, gateWaitMs: 400, page: async () => page!, postGate: (m) => gateMsgs.push(m) });
    short.on('event', (e: RunEvent) => events.push(e));
    const runId = `run-${++n}`;
    short.start({ runId, counterpartyId: cpC, supply: 140_000, tax: 14_000, itemName: '경영 컨설팅' });
    const req = await gateFor(runId);
    const end = await endOf(runId);
    assert.deepEqual([end.status, end.code], ['expired', 'gate.expired']);
    assert.deepEqual(short.answer(approval(req)), { ok: false, code: 'no_open_gate' });
    assert.equal(new GateRepo(db).state(req.reqId), 'expired');
  });

  it('실행은 한 번에 하나, 홈택스 포털은 시작 전에 거부', async () => {
    const runId = start(cpC, 100_000);
    assert.throws(() => start(cpC, 100_000), /busy/);
    await gateFor(runId);
    runs.stop(runId);
    await endOf(runId);
    const ht = new RunService({ db, data, ledgerKey: new Uint8Array(32), portal: HOMETAX_PORTAL, log, page: () => Promise.reject(new Error('no')), postGate: () => {} });
    assert.throws(() => ht.start({ runId: 'ht-1', counterpartyId: cpA, supply: 1000, tax: 100, itemName: 'x' }), /selector_placeholder/);
  });
});
