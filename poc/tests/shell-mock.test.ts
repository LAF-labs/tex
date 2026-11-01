// PoC-9 셸: 금액 해석, 부가세 분해, 입력 보완(되물은 값에 답하기), 정부24 후보 시각.
// PoC-6 셸 실행(ShellRuns): 실행은 한 번에 하나, 엔진 이벤트 → 카드 상태, 게이트 요청 → 되읽은 값·중복 경고, 끝 코드 문구.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { buildGateRequest, type GateField } from '@sax/engine/gate';
import { g24Candidates, interpret, MockStore, parseAmount, split, type Counterparty } from '../apps/desktop/src/shell-mock.ts';
import { ShellRuns } from '../apps/desktop/src/shell-runs.ts';

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
    assert.match(r.warnings[0]!, /같은 거래처·금액·날짜·품목의 기록/);
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

  it('끝 코드: 직전 시도 발급 안 됨 경고, in_doubt는 확인 필요, main이 닫은 게이트는 main 이유로', async () => {
    const { host, runs } = shellRuns();
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft');
    await runs.prepare(a.run.id);
    host.emit('gate', gateFor(a.run.id, {}, [{ fieldKey: '$first.bizNo', value: 'true' }, { fieldKey: '$first.email', value: 'true' }, { fieldKey: '$dup.businessKey', value: 'not_committed' }, { fieldKey: '$dup.priorNotCommitted', value: 'true' }]));
    assert.match(runs.get(a.run.id)!.warnings[0]!, /직전 시도는 '발급 안 됨'/);
    await runs.abortGate(a.run.id, 'answer.rejected');
    assert.ok(host.calls.some(([m]) => m === 'run.stop'));
    host.emit('run', { runId: a.run.id, type: 'end', status: 'stopped', code: 'gate.stopped' });
    assert.match(runs.get(a.run.id)!.stoppedNote!, /승인을 엔진에 전달하지 못해/);
    const b = interpret('B상사에 10만원 세금계산서', null, 'business', runs);
    assert.ok(b.kind === 'draft');
    await runs.prepare(b.run.id);
    host.emit('run', { runId: b.run.id, type: 'phase', phase: 'verify', state: 'now' });
    host.emit('run', { runId: b.run.id, type: 'end', status: 'in_doubt', code: 'verify.unknown' });
    const r = runs.get(b.run.id)!;
    assert.equal(r.status, 'attention');
    assert.match(r.stoppedNote!, /중복 발급될 수 있어요/);
    assert.equal(r.steps[6]!.state, 'attention', '확인하던 단계를 표시한다');
    await assert.rejects(runs.stop('run-none'), /no_run/);
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
    for (const c of g24Candidates('주민등록표 등본', start)) assert.ok(c.at >= hm(start) && c.at <= hm(Date.now()), `${c.at} < ${hm(start)}`);
  });
});
