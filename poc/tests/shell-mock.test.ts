// PoC-9 셸: 금액 해석, 부가세 분해, 입력 보완(되물은 값에 답하기), 정부24 후보 시각.
// PoC-6 셸 실행(ShellRuns): 실행은 한 번에 하나, 엔진 이벤트 → 카드 상태, 게이트 요청 → 되읽은 값·중복 경고, 끝 코드 문구.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { buildGateRequest, type GateField } from '@sax/engine/gate';
import { g24Candidates, interpret, MockStore, parseAmount, split, type Counterparty } from '../apps/desktop/src/shell-mock.ts';
import { REGATE_NOTE, ShellRuns } from '../apps/desktop/src/shell-runs.ts';

const CPS: Counterparty[] = [
  { id: 'cp-a', name: 'A상사', bizNo: '2148651233', rep: '이에이', email: 'tax@asangsa.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: '', lastIssuedOn: null },
  { id: 'cp-b', name: 'B상사', bizNo: '3051288767', rep: '박비', email: 'account@bsangsa.example', item: '시스템 유지보수', status: '계속사업자', checkedOn: '', lastIssuedOn: null },
  { id: 'cp-c', name: 'C테크', bizNo: '4182577343', rep: '최다라', email: 'billing@ctech.example', item: '교육 용역', status: '계속사업자', checkedOn: '', lastIssuedOn: null },
];

/** 엔진 연결 자리(EngineHost의 on·control·rpc). 부른 것을 기록하고, rpc 실패를 끼울 수 있다. */
class FakeHost extends EventEmitter {
  readonly calls: Array<[string, unknown]> = [];
  fail: Record<string, string> = {};
  async control(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([method, params]);
    return {};
  }
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([method, params]);
    if (this.fail[method]) throw new Error(this.fail[method]);
    return {};
  }
}
const shellRuns = (host = new FakeHost()) => ({ host, runs: new ShellRuns(host, { counterparties: () => CPS, auth: () => '사업자 간편인증' }) });

function gateFor(runId: string, rb: Record<string, string>, reserved: GateField[] = []) {
  const readback = {
    supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: '2148651233', counterpartName: 'A상사', counterpartEmail: 'tax@asangsa.example',
    itemName: '경영 컨설팅', itemCount: '1', supplyAmount: '100000', taxAmount: '10000', totalAmount: '110000', issueDate: '2026-11-01', remark: '', receiptType: '영수', ...rb,
  };
  return buildGateRequest({ runId, gateStepId: 's20', readback, reserved, packageDigest: '0'.repeat(64), authorizes: ['s21'], intentId: 'i', waitMs: 1000 });
}

describe('셸 목업', () => {
  it('금액 해석: 단위 묶음을 더하고, 확신이 없으면 금액으로 보지 않는다', () => {
    assert.equal(parseAmount('A상사에 330만원 세금계산서'), 3_300_000);
    assert.equal(parseAmount('1억 2천만원'), 120_000_000);
    assert.equal(parseAmount('1천2백만원'), 12_000_000);
    assert.equal(parseAmount('3,300,000 세금계산서'), 3_300_000);
    assert.equal(parseAmount('1.5억'), 150_000_000);
    assert.equal(parseAmount('천만원 만들어 줘'), null, '숫자로 시작하지 않는 말은 금액으로 보지 않는다');
    assert.equal(parseAmount('11월분 55만원'), 550_000, '날짜 숫자는 건너뛴다');
    assert.equal(parseAmount('2026년 계산서'), null);
    assert.equal(parseAmount('세금계산서'), null);
    assert.equal(parseAmount('1억 2천'), null, '억 뒤가 만 없이 끝나면 되묻는다');
    assert.equal(parseAmount('1억5천'), null);
    assert.equal(parseAmount('1억 2천만원'), 120_000_000);
  });

  it('부가세: 세액은 공급가의 10%에서 원 미만 버림, 포함 금액은 공급가 + 세액 = 합계', () => {
    assert.deepEqual(split(3_300_000, 'separate'), { supply: 3_300_000, tax: 330_000, total: 3_630_000 });
    assert.deepEqual(split(3_300_000, 'included'), { supply: 3_000_000, tax: 300_000, total: 3_300_000 });
    for (const total of [105, 1_234_567, 999_999, 550_001]) {
      const s = split(total, 'included');
      assert.equal(s.supply + s.tax, total);
      assert.equal(s.tax, Math.floor(s.supply / 10), `합계 ${total}`);
    }
  });

  it('입력 보완: 되물은 거래처·금액에 짧게 답해도 초안으로 이어진다', () => {
    const { runs } = shellRuns();
    assert.equal(interpret('세금계산서 ', null, 'business', runs).kind, 'say');
    const a = interpret('A상사', null, 'business', runs);
    assert.ok(a.kind === 'say' && a.text.includes('얼마'));
    const d = interpret('330만원', 'included', 'business', runs);
    assert.ok(d.kind === 'draft' && d.run.counterparty.name === 'A상사' && d.run.total === 3_300_000);
    assert.equal(interpret('330만원', null, 'business', runs).kind, 'say', '되묻지 않았으면 금액만으로 발급하지 않는다');
    assert.equal(interpret('C테크에 세금계산서', null, 'personal', runs).kind, 'say', '개인 프로필은 세금계산서 안 됨');
    const { runs: other } = shellRuns();
    interpret('A상사에 세금계산서', null, 'business', runs);
    assert.equal(interpret('330만원', null, 'business', other).kind, 'say', '되묻기 상태는 대화마다 따로');
    const two = interpret('A상사 말고 C테크로 세금계산서 50만원', null, 'business', other);
    assert.ok(two.kind === 'say' && two.chips?.length === 2, '거래처 이름이 둘이면 되묻는다');
    const fix = interpret('C테크', null, 'business', other);
    assert.ok(fix.kind === 'draft' && fix.run.counterparty.name === 'C테크' && fix.run.amount === 500_000);
    assert.equal(other.updateDraft(fix.run.id, { amountText: '1억 2천만원' }).amount, 120_000_000, '[금액 수정]도 같은 규칙');
    assert.equal(other.updateDraft(fix.run.id, { amountText: '3300000' }).amount, 3_300_000);
    assert.throws(() => other.updateDraft(fix.run.id, { amountText: '1억 2천' }), /bad_amount/);
    const g = interpret('주민등록초본 떼 줘', null, 'personal', runs);
    assert.ok(g.kind === 'g24' && g.doc === '주민등록표 초본');
  });

  it('실행은 한 번에 하나: 다른 작업이 진행 중이면 준비를 거부한다. 준비는 금고 run.begin → 엔진 run.start', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    const b = interpret('B상사에 20만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft' && b.kind === 'draft');
    await runs.prepare(a.run.id);
    assert.deepEqual(host.calls.map(([m]) => m), ['run.begin', 'run.start']);
    assert.deepEqual(host.calls[1]![1], { runId: a.run.id, counterpartyId: 'cp-a', supply: 100_000, tax: 10_000, itemName: '경영 컨설팅', email: 'tax@asangsa.example' });
    await assert.rejects(runs.prepare(b.run.id), /busy/);
    host.emit('run', { runId: a.run.id, type: 'end', status: 'stopped', code: 'run.stopped' });
    assert.equal(runs.get(a.run.id)!.status, 'stopped');
    assert.ok(host.calls.some(([m, p]) => m === 'run.end' && (p as { runId: string }).runId === a.run.id), '끝나면 금고 run.end');
    await runs.prepare(b.run.id);
    assert.equal(runs.get(b.run.id)!.status, 'preparing');
  });

  it('엔진이 시작 전에 거부하면 확인 필요로 두고 이유를 보인다(값 없음)', async () => {
    const host = new FakeHost();
    host.fail['run.start'] = 'selector_placeholder';
    const { runs } = shellRuns(host);
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    const r = runs.get(a.run.id)!;
    assert.equal(r.status, 'attention');
    assert.match(r.stoppedNote!, /셀렉터/);
  });

  it('게이트 요청: 카드는 엔진이 되읽은 값으로 바뀌고, 처음 거래·중복 경고는 fields에서만 온다', async () => {
    const { host, runs } = shellRuns();
    const gates: unknown[] = [];
    runs.on('gate', (id, req) => gates.push([id, req]));
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    assert.ok(!a.run.counterparty.first, '초안에서는 처음 거래를 모른다');
    // 다른 실행의 게이트는 무시한다.
    host.emit('gate', gateFor('run-other', {}));
    assert.equal(gates.length, 0);
    const req = gateFor(a.run.id, { counterpartEmail: 'new@asangsa.example' }, [
      { fieldKey: '$first.bizNo', value: 'false' },
      { fieldKey: '$first.email', value: 'true' },
      { fieldKey: '$dup.businessKey', value: 'committed' },
    ]);
    host.emit('gate', req);
    const r = runs.get(a.run.id)!;
    assert.equal(r.status, 'waiting');
    assert.equal(r.email.value, 'new@asangsa.example');
    assert.ok(r.email.first && !r.counterparty.first);
    assert.equal(r.readbackDiffers, true, '이메일이 초안과 달라졌다');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0]!, /이미 발급돼 있어요\(승인번호 있음\)/);
    assert.deepEqual(gates, [[a.run.id, req]]);
    runs.approved(a.run.id);
    assert.equal(r.approvedPending, true);
    host.emit('run', { runId: a.run.id, type: 'phase', phase: 'sign', state: 'now' });
    assert.equal(r.status, 'issuing');
    assert.equal(r.approvedPending, false);
    host.emit('run', { runId: a.run.id, type: 'end', status: 'completed_with_issues', code: 'mail.not_confirmed', approvalNo: '20261101-41000012-00000123', mailConfirmed: false });
    assert.equal(r.status, 'done');
    assert.equal(r.result!.approvalNo, '20261101-41000012-00000123');
    assert.equal(r.result!.mailConfirmed, false);
    assert.equal(r.steps[7]!.state, 'attention', '메일 미확인은 메일 단계에 표시');
    // 메일까지 확인된 실행은 마지막 단계도 끝난 것으로 둔다(엔진은 끝 스텝에서 마지막 구간 done을 보내지 않는다).
    const b = interpret('B상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(b.kind === 'draft');
    await runs.prepare(b.run.id);
    host.emit('run', { runId: b.run.id, type: 'phase', phase: 'mail', state: 'now' });
    host.emit('run', { runId: b.run.id, type: 'end', status: 'success', approvalNo: '20261101-41000012-00000124', mailConfirmed: true });
    assert.equal(runs.get(b.run.id)!.steps[7]!.state, 'done');
  });

  it('엔진이 끝나면: 승인 전이면 발급 없음, 승인을 보냈거나 발급 중이면 발급됐는지 모름(중복 위험)', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('gate', gateFor(a.run.id, {}, [{ fieldKey: '$first.bizNo', value: 'true' }, { fieldKey: '$first.email', value: 'true' }]));
    runs.approved(a.run.id);
    host.emit('exit', 'engine', 1);
    const r = runs.get(a.run.id)!;
    assert.equal(r.status, 'attention');
    assert.match(r.stoppedNote!, /발급됐는지 모릅니다/);
    const { host: h2, runs: runs2 } = shellRuns();
    const b = interpret('B상사에 10만원 세금계산서', null, 'business', runs2);
    assert.ok(b.kind === 'draft');
    await runs2.prepare(b.run.id);
    h2.emit('gate', gateFor(b.run.id, {}));
    h2.emit('exit', 'vault', 1);
    assert.equal(runs2.get(b.run.id)!.status, 'waiting', '금고만 끝나면 엔진이 실행을 끝낸다(여기서 끝내지 않음)');
    h2.emit('exit', 'engine', 1);
    assert.match(runs2.get(b.run.id)!.stoppedNote!, /승인 전에 끝났어요/);
  });

  it('승인을 보낸 뒤 판정을 못 받고 금고·엔진이 끝나면 "발급 없음"이 아니라 발급됐는지 모름', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('gate', gateFor(a.run.id, {}));
    runs.approved(a.run.id);
    // 금고가 끝나 호스트가 기다리던 답을 풀었다(엔진 판정 아님). 엔진은 그 뒤에 끝난다.
    await runs.onAnswer(a.run.id, { ok: false, code: 'vault_exit', verdict: 'unknown' });
    assert.equal(runs.get(a.run.id)!.approvedPending, true, '판정을 모르면 승인 표시를 거두지 않는다');
    host.emit('exit', 'engine', 1);
    assert.match(runs.get(a.run.id)!.stoppedNote!, /발급됐는지 모릅니다/);
    // 보내기 전에 막혔으면(엔진이 이미 끝남) 근거는 엔진에 가지 않았다.
    const { host: h2, runs: r2 } = shellRuns();
    const c = interpret('C테크에 10만원 세금계산서', null, 'business', r2);
    assert.ok(c.kind === 'draft');
    await r2.prepare(c.run.id);
    h2.emit('gate', gateFor(c.run.id, {}));
    r2.approved(c.run.id);
    await r2.onAnswer(c.run.id, { ok: false, code: 'engine_exit', verdict: 'not_sent' });
    assert.equal(r2.get(c.run.id)!.approvedPending, false);
    h2.emit('exit', 'engine', 1);
    assert.match(r2.get(c.run.id)!.stoppedNote!, /아무것도 발급(하지 않았어요|되지 않았어요)/, '보내지 않았으니 발급 없음');
  });

  it('시작하는 동안 [중지]: run.begin 뒤 run.start를 보내지 않는다. run.start 중이면 끝난 뒤 run.stop', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    const p = runs.prepare(a.run.id);
    await runs.stop(a.run.id);
    await p;
    assert.equal(runs.get(a.run.id)!.status, 'stopped');
    assert.ok(!host.calls.some(([m]) => m === 'run.start'));
    const b = interpret('B상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(b.kind === 'draft');
    let releaseStart!: () => void;
    const started = new Promise<void>((r) => (releaseStart = r));
    const rpc = host.rpc.bind(host);
    host.rpc = async (m: string, params: Record<string, unknown> = {}) => {
      if (m === 'run.start') await started;
      return rpc(m, params);
    };
    const q = runs.prepare(b.run.id);
    await new Promise((r) => setImmediate(r));
    await runs.stop(b.run.id);
    releaseStart();
    await q;
    const calls = host.calls.map(([m]) => m);
    assert.deepEqual(calls.slice(calls.lastIndexOf('run.start')), ['run.start', 'run.stop']);
  });

  it('끝 코드: 직전 시도 발급 안 됨 경고, in_doubt는 확인 필요, main이 닫은 게이트는 main 이유로', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('gate', gateFor(a.run.id, {}, [{ fieldKey: '$first.bizNo', value: 'true' }, { fieldKey: '$first.email', value: 'true' }, { fieldKey: '$dup.businessKey', value: 'not_committed' }, { fieldKey: '$dup.priorNotCommitted', value: 'true' }]));
    assert.deepEqual(runs.get(a.run.id)!.warnings.length, 1);
    assert.match(runs.get(a.run.id)!.warnings[0]!, /직전 시도는 발급 안 됨으로 판정했어요/);
    await runs.abortGate(a.run.id, 'answer.rejected');
    assert.ok(host.calls.some(([m]) => m === 'run.stop'));
    host.emit('run', { runId: a.run.id, type: 'end', status: 'stopped', code: 'gate.stopped' });
    assert.match(runs.get(a.run.id)!.stoppedNote!, /승인을 엔진에 전달하지 못해/);
    // [중지]·만료가 근거보다 먼저 게이트를 닫으면(경쟁) 안내만 거두고 끝 이유는 엔진 것(중지)을 쓴다.
    const z = interpret('C테크에 20만원 세금계산서', null, 'business', runs);
    assert.ok(z.kind === 'draft');
    await runs.prepare(z.run.id);
    host.emit('gate', gateFor(z.run.id, {}));
    runs.approved(z.run.id);
    await runs.onAnswer(z.run.id, { ok: false, code: 'stopped', verdict: 'engine' });
    assert.equal(runs.get(z.run.id)!.approvedPending, false);
    assert.ok(!host.calls.some(([m, p]) => m === 'run.stop' && (p as { runId: string }).runId === z.run.id), '경쟁이면 main이 따로 멈추지 않는다');
    host.emit('run', { runId: z.run.id, type: 'end', status: 'stopped', code: 'gate.stopped' });
    assert.equal(runs.get(z.run.id)!.stoppedNote, '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.');
    const b = interpret('B상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(b.kind === 'draft');
    await runs.prepare(b.run.id);
    host.emit('run', { runId: b.run.id, type: 'phase', phase: 'verify', state: 'now' });
    host.emit('run', { runId: b.run.id, type: 'end', status: 'in_doubt', code: 'verify.unknown' });
    const r = runs.get(b.run.id)!;
    assert.equal(r.status, 'attention');
    assert.match(r.stoppedNote!, /중복 발급될 수 있어요/);
    assert.equal(r.steps[6]!.state, 'attention', '확인하던 단계를 표시한다');
    // in_doubt는 코드가 무엇이든 중복 위험을 알린다(main이 닫은 이유로 덮지 않음).
    const c = interpret('C테크에 10만원 세금계산서', null, 'business', runs);
    assert.ok(c.kind === 'draft');
    await runs.prepare(c.run.id);
    host.emit('gate', gateFor(c.run.id, {}));
    await runs.abortGate(c.run.id, 'answer.rejected');
    assert.equal(runs.get(c.run.id)!.approvedPending, false);
    assert.match(runs.get(c.run.id)!.steps[4]!.note!, /멈추고 있어요/, '거부된 승인 안내를 바로 거둔다');
    host.emit('run', { runId: c.run.id, type: 'end', status: 'in_doubt', code: 'engine.error' });
    assert.match(runs.get(c.run.id)!.stoppedNote!, /발급됐는지 확인하지 못했어요.*중복 발급될 수 있어요/);
    // 같은 건이 발급된 뒤 다시 발급 안 됨이 있었으면 두 경고를 모두 둔다(발급된 건이 먼저).
    const d = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(d.kind === 'draft');
    await runs.prepare(d.run.id);
    host.emit('gate', gateFor(d.run.id, {}, [{ fieldKey: '$first.bizNo', value: 'false' }, { fieldKey: '$first.email', value: 'false' }, { fieldKey: '$dup.businessKey', value: 'committed,not_committed' }, { fieldKey: '$dup.priorNotCommitted', value: 'true' }]));
    const w = runs.get(d.run.id)!.warnings;
    assert.equal(w.length, 2);
    assert.match(w[0]!, /이미 발급돼 있어요/);
    assert.match(w[1]!, /직전 시도는 발급 안 됨으로 판정했어요/);
    await assert.rejects(runs.stop('run-none'), /no_run/);
  });

  it('InDoubt(M4-2 3부, 08 §11): 조회 n회째를 보이고, in_doubt로 끝나면 inDoubt 표시(다시 발급하는 길은 카드에 없다)', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 11만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('gate', gateFor(a.run.id, {}));
    host.emit('run', { runId: a.run.id, type: 'phase', phase: 'verify', state: 'now', attempt: 2 });
    assert.equal(runs.get(a.run.id)!.verifyAttempt, 2);
    host.emit('run', { runId: a.run.id, type: 'phase', phase: 'verify', state: 'now', attempt: -1 });
    assert.equal(runs.get(a.run.id)!.verifyAttempt, 2, '이상한 attempt는 무시');
    host.emit('run', { runId: a.run.id, type: 'end', status: 'in_doubt', code: 'verify.unknown' });
    const r = runs.get(a.run.id)!;
    assert.equal(r.status, 'attention');
    assert.equal(r.inDoubt, true);
    assert.match(r.stoppedNote ?? '', /중복 발급될 수 있어요/);
    const b = interpret('B상사에 21만원 세금계산서', null, 'business', runs);
    assert.ok(b.kind === 'draft');
    await runs.prepare(b.run.id);
    host.emit('run', { runId: b.run.id, type: 'end', status: 'failed', code: 'assert.fields_missing' });
    assert.equal(runs.get(b.run.id)!.inDoubt, false, '실패는 InDoubt가 아니다');
  });

  it('핸드오프(D03 HandedOff): 게이트 앞이면 [다 했어요] → 준비 중, 엔진이 받은 뒤에만 상태를 바꾼다', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 12만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    await assert.rejects(runs.resume(a.run.id), /not_handed_off/);
    host.emit('run', { runId: a.run.id, type: 'handoff', phase: 'input' });
    let r = runs.get(a.run.id)!;
    assert.equal(r.status, 'turn');
    assert.deepEqual(r.handoff, { phase: 'input', afterGate: false });
    assert.match(r.turn!.text, /^지금 사람이 필요해요 · 이 단계는 직접 해 주세요: 입력$/);
    assert.equal(r.steps[2]!.state, 'attention');
    host.fail['run.resume'] = 'relay_down';
    await assert.rejects(runs.resume(a.run.id), /relay_down/);
    assert.equal(runs.get(a.run.id)!.status, 'turn', '엔진이 받지 않으면 그대로');
    delete host.fail['run.resume'];
    await runs.resume(a.run.id);
    r = runs.get(a.run.id)!;
    assert.deepEqual([r.status, r.handoff, r.turn, r.steps[2]!.state], ['preparing', null, null, 'now']);
    assert.ok(host.calls.some(([m, p]) => m === 'run.resume' && (p as { runId: string }).runId === a.run.id));
    host.emit('run', { runId: 'run-none', type: 'handoff', phase: 'input' });
    host.emit('run', { runId: a.run.id, type: 'handoff', phase: 'nope' as never });
    assert.equal(runs.get(a.run.id)!.status, 'preparing', '모르는 실행·단계는 무시');
  });

  it('핸드오프 게이트 뒤: [직접 발급함] → 원장은 엔진이(observed_manual), 카드는 확인 중. 이때 엔진이 끝나면 발급됐는지 모름', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 13만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('gate', gateFor(a.run.id, {}));
    runs.approved(a.run.id);
    host.emit('run', { runId: a.run.id, type: 'phase', phase: 'sign', state: 'now' });
    host.emit('run', { runId: a.run.id, type: 'handoff', phase: 'sign' });
    assert.deepEqual(runs.get(a.run.id)!.handoff, { phase: 'sign', afterGate: true });
    await runs.manualDone(a.run.id);
    const r = runs.get(a.run.id)!;
    assert.equal(r.status, 'issuing');
    assert.equal(r.steps[6]!.state, 'now', '발급목록 확인(verify)만');
    assert.ok(host.calls.some(([m]) => m === 'run.manualDone'));
    assert.ok(!host.calls.some(([m]) => /approv|answer|attest/i.test(m)), '승인·증언 경로를 부르지 않는다');

    const h2 = new FakeHost();
    const r2 = new ShellRuns(h2, { counterparties: () => CPS, auth: () => '' });
    const b = interpret('B상사에 14만원 세금계산서', null, 'business', r2);
    assert.ok(b.kind === 'draft');
    await r2.prepare(b.run.id);
    h2.emit('gate', gateFor(b.run.id, {}));
    h2.emit('run', { runId: b.run.id, type: 'phase', phase: 'sign', state: 'now' });
    h2.emit('run', { runId: b.run.id, type: 'handoff', phase: 'sign' });
    h2.emit('exit', 'engine', 1);
    assert.deepEqual([r2.get(b.run.id)!.status, r2.get(b.run.id)!.inDoubt], ['attention', true]);
  });

  it('다시 게이트 경고: 고정 문구 3종(상수)만, 모르는 이유는 무시', async () => {
    assert.deepEqual(Object.keys(REGATE_NOTE).sort(), ['date_changed', 'paused', 'value_changed']);
    for (const t of Object.values(REGATE_NOTE)) assert.ok(/새로 승인/.test(t) && !/세액 산정|절세|신고 대리|가산세/.test(t), t);
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 15만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('run', { runId: a.run.id, type: 'regate', reason: 'made_up' as never });
    assert.equal(runs.get(a.run.id)!.regate, undefined);
    host.emit('run', { runId: a.run.id, type: 'regate', reason: 'date_changed' });
    host.emit('gate', gateFor(a.run.id, {}));
    assert.deepEqual(runs.get(a.run.id)!.regate, { reason: 'date_changed', note: REGATE_NOTE.date_changed });
    assert.equal(runs.get(a.run.id)!.status, 'waiting');
  });

  it('목업 저장소는 셸마다 따로: 한 셸의 발급·보관이 다른 셸에 새지 않는다', () => {
    const a = new MockStore();
    const b = new MockStore();
    a.g24Save('f1', '주민등록표 등본');
    assert.equal(a.docs.length, b.docs.length + 1);
    assert.throws(() => a.g24Save('no-such-file', '주민등록표 등본'), /bad_candidate/);
  });

  it('정부24 후보는 작업 시작 뒤에 생긴 파일만', () => {
    const start = Date.now() - 5 * 60_000;
    const hm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
    // HH:MM 글자 비교는 자정을 넘기면 틀리므로, 시작 시각부터 지난 분으로 비교한다
    const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const since = (t: string) => (mins(t) - mins(hm(start)) + 1440) % 1440;
    const elapsed = since(hm(Date.now()));
    for (const c of g24Candidates('주민등록표 등본', start)) assert.ok(since(c.at) <= elapsed, `${c.at}: ${hm(start)}~${hm(Date.now())} 밖`);
  });
});
