// 받을 돈 main 쪽(bank-host.ts): 대화 로컬 규칙(bankQuestion)·판 카드(bankBoardCards)·렌더러 요청 표.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bankBoardCards, bankQuestion, isPayableQuestion } from '../apps/desktop/src/bank-host.ts';
import { SHELL_METHODS, USER_ACTION_METHODS } from '../apps/desktop/src/ipc.ts';

describe('받을 돈 대화 로컬 규칙', () => {
  const T = '2026-11-12';
  it('못 받은 돈·이번 달·○○ 입금', () => {
    assert.deepEqual(bankQuestion('못 받은 돈 있어?', T), { kind: 'unpaid' });
    assert.deepEqual(bankQuestion('이번 달 못 받은 돈 있어?', T), { kind: 'unpaid' });
    assert.deepEqual(bankQuestion('미수금 알려줘', T), { kind: 'unpaid' });
    assert.deepEqual(bankQuestion('이번 달 받을 돈', T), { kind: 'month', month: null });
    assert.deepEqual(bankQuestion('10월 받을 돈 얼마야', T), { kind: 'month', month: '2026-10' });
    assert.deepEqual(bankQuestion('에이상사 입금됐어?', T), { kind: 'counterparty', name: '에이상사' });
    assert.deepEqual(bankQuestion('A상사 돈 들어왔어?', T), { kind: 'counterparty', name: 'A상사' });
  });
  it('세금계산서 요청·세무 판단·관계없는 말은 잡지 않는다', () => {
    for (const t of ['에이상사에 330만원 세금계산서 끊어줘', '못 받은 돈 대손 처리해도 돼?', '사업자등록증명 떼줘', '안녕']) assert.equal(bankQuestion(t, T), null, t);
    assert.ok(isPayableQuestion('안 낸 돈 있어?'));
  });
});

describe('판 카드', () => {
  const base = { today: '2026-11-12', latestDay: '2026-11-11', stale: false, hasAccounts: true, unpaidCount: 3, overdueCount: 2, overdueTotal: 4_400_000, oldestOverdue: { cpName: 'A상사', writtenOn: '2026-10-05', daysOver: 8 }, reviewCount: 1 };
  it('못 받은 돈(기한 지남·가장 오래된 것·기준일) + 확인할 입금', () => {
    const c = bankBoardCards(base);
    assert.deepEqual(c.map((x) => x.kind), ['unpaid', 'deposits']);
    assert.match(c[0]!.items[0]!.label, /기한 지난 받을 돈 2건 · 4,400,000원/);
    assert.match(c[0]!.items[0]!.detail, /A상사 10월 5일\(8일 지남\).*11월 11일까지 반영/);
    assert.deepEqual(c[0]!.items[0]!.target, { to: 'view', view: 'bank' });
  });
  it('거래내역이 오래되면 금액 대신 "오래됐어요", 없으면 카드 없음', () => {
    assert.equal(bankBoardCards({ ...base, stale: true }).at(0)!.items[0]!.label, '거래내역이 오래됐어요');
    assert.deepEqual(bankBoardCards({ ...base, unpaidCount: 0, reviewCount: 0 }), []);
  });
});

describe('렌더러 요청 표', () => {
  it('은행 메서드가 표에 있고, 파일 고르기 둘은 실제 입력 뒤에만', () => {
    for (const m of ['bank.overview', 'bank.addAccount', 'bank.accept', 'bank.undo', 'bank.pickStatement', 'bank.pickInvoices']) assert.ok(Object.hasOwn(SHELL_METHODS, m), m);
    assert.equal(USER_ACTION_METHODS['bank.pickStatement'], 3_000);
    assert.equal(USER_ACTION_METHODS['bank.pickInvoices'], 3_000);
  });
});
