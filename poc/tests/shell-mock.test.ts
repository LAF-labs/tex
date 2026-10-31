// PoC-9 셸 목업: 금액 해석, 부가세 분해, 입력 보완(되물은 값에 답하기), 실행은 한 번에 하나, 정부24 후보 시각.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { g24Candidates, interpret, MockRuns, parseAmount, split } from '../apps/desktop/src/shell-mock.ts';

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
    const runs = new MockRuns(0);
    assert.equal(interpret('세금계산서 ', null, 'business', runs).kind, 'say');
    const a = interpret('A상사', null, 'business', runs);
    assert.ok(a.kind === 'say' && a.text.includes('얼마'));
    const d = interpret('330만원', 'included', 'business', runs);
    assert.ok(d.kind === 'draft' && d.run.counterparty.name === 'A상사' && d.run.total === 3_300_000);
    assert.equal(interpret('330만원', null, 'business', runs).kind, 'say', '되묻지 않았으면 금액만으로 발급하지 않는다');
    assert.equal(interpret('C테크에 세금계산서', null, 'personal', runs).kind, 'say', '개인 프로필은 세금계산서 안 됨');
    const g = interpret('주민등록초본 떼 줘', null, 'personal', runs);
    assert.ok(g.kind === 'g24' && g.doc === '주민등록표 초본');
  });

  it('실행은 한 번에 하나: 다른 작업이 진행 중이면 준비를 거부한다', () => {
    const runs = new MockRuns(1000);
    const a = interpret('A상사에 10만원 세금계산서', null, 'business', runs);
    const b = interpret('B상사에 20만원 세금계산서', null, 'business', runs);
    assert.ok(a.kind === 'draft' && b.kind === 'draft');
    runs.prepare(a.run.id);
    assert.throws(() => runs.prepare(b.run.id), /busy/);
    runs.stop(a.run.id);
    assert.doesNotThrow(() => runs.prepare(b.run.id));
    runs.stop(b.run.id);
  });

  it('정부24 후보는 작업 시작 뒤에 생긴 파일만', () => {
    const start = Date.now() - 5 * 60_000;
    const hm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
    for (const c of g24Candidates('주민등록표 등본', start)) assert.ok(c.at >= hm(start) && c.at <= hm(Date.now()), `${c.at} < ${hm(start)}`);
  });
});
