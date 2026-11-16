// 현금흐름 분석(11 §3, ADR-045): 순수 함수(갈래·지표·알림)와 엔진 조회(db.query.bank.cashflow·cashflowSeries, bank.categorize).
// 모든 값은 가짜다(합성 사업자번호, 가짜 계좌번호·이름).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ColumnCipher, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import { analyzeCashFlow, BankService, categorizeTxn, rangesCover, type CashFlowMonth, type CashFlowResult, type CfInput, type CfInvoice, type CfTxn } from '@sax/engine';
import { BANK_COMMANDS, BANK_READ_QUERIES } from '@sax/engine/protocol';

const tx = (id: string, day: string, direction: 'in' | 'out', amount: number, label: string, o: Partial<CfTxn> = {}): CfTxn => ({ id, accountId: 'a1', day, direction, amount, label, counterOwn: false, settled: 0, human: null, ...o });
const inv = (id: string, o: Partial<CfInvoice>): CfInvoice => ({ id, kind: 'sale', counterpartyKey: 'A', cpName: 'A상사', writtenOn: '2026-10-01', total: 1_000_000, remaining: 1_000_000, dueOn: '2026-10-31', state: 'open', settledOn: null, ...o });
const acct = (o: Partial<CfInput['accounts'][number]> = {}) => ({ id: 'a1', last4: '1111', bank: '국민', ranges: [{ from: '2026-01-01', to: '2026-11-15' }], coverTo: '2026-11-15', balance: 5_000_000, balanceDay: '2026-11-15', ...o });
const base = (o: Partial<CfInput> = {}): CfInput => ({
  today: '2026-11-16', month: '2026-11', accounts: [acct()], txns: [], invoices: [], cashSales: [], cardTxns: [], receipts: [], payroll: [], payees: [], rules: [], cardRanges: [], ...o,
});

describe('현금흐름 갈래(11 §3.3, 순수 함수)', () => {
  const none = new Map();
  it('사전: 세금·4대보험, 카드대금(출금)·카드매출 정산(입금), 이자. 나머지는 기타', () => {
    assert.equal(categorizeTxn(tx('1', '2026-11-10', 'out', 300_000, '국민건강보험 지역'), false, none, []), 'tax');
    assert.equal(categorizeTxn(tx('2', '2026-11-10', 'out', 800_000, '삼성카드 결제'), false, none, []), 'card_payment');
    assert.equal(categorizeTxn(tx('3', '2026-11-10', 'in', 420_000, '신한카드 가맹점'), false, none, []), 'card_sales');
    assert.equal(categorizeTxn(tx('4', '2026-11-10', 'in', 77, '결산이자'), false, none, []), 'interest');
    assert.equal(categorizeTxn(tx('5', '2026-11-10', 'out', 50_000, '김밥천국'), false, none, []), 'other');
  });
  it('사람이 정한 것이 먼저, 기억한 규칙, 내 계좌 사이, 급여(직원 이름 + 실지급액, 그달·전달)', () => {
    assert.equal(categorizeTxn(tx('1', '2026-11-10', 'out', 300_000, '국세', { human: 'unrelated' }), false, none, []), 'unrelated');
    assert.equal(categorizeTxn(tx('2', '2026-11-10', 'out', 90_000, '쿠팡'), false, new Map([['out|쿠팡', 'other' as const]]), []), 'other');
    assert.equal(categorizeTxn(tx('3', '2026-11-10', 'out', 90_000, '대표 개인'), false, new Map([['out|대표개인', 'unrelated' as const]]), []), 'unrelated');
    assert.equal(categorizeTxn(tx('4', '2026-11-10', 'out', 1_000_000, '아무개', { counterOwn: true }), false, none, []), 'own_transfer');
    const payees = [{ nameNorm: '이직원', month: '2026-10', net: 2_345_670 }];
    assert.equal(categorizeTxn(tx('5', '2026-11-05', 'out', 2_345_670, '이직원'), false, none, payees), 'payroll');
    assert.equal(categorizeTxn(tx('6', '2026-11-05', 'out', 2_345_000, '이직원'), false, none, payees), 'other', '금액이 다르면 급여로 보지 않는다');
  });
  it('구간 합이 빈틈없이 덮는가', () => {
    assert.equal(rangesCover([{ from: '2026-10-01', to: '2026-10-15' }, { from: '2026-10-16', to: '2026-10-31' }], '2026-10-01', '2026-10-31'), true);
    assert.equal(rangesCover([{ from: '2026-10-01', to: '2026-10-14' }, { from: '2026-10-16', to: '2026-10-31' }], '2026-10-01', '2026-10-31'), false);
    assert.equal(rangesCover([], '2026-10-01', '2026-10-31'), false);
  });
});

describe('현금흐름 지표(11 §3.4, 순수 함수)', () => {
  it('현금 기준: 받을 돈·낼 돈에 붙은 금액 + 나머지 갈래, 내 계좌 사이·사업과 무관은 뺀다', () => {
    const r = analyzeCashFlow(base({
      accounts: [acct(), acct({ id: 'a2', last4: '2222', bank: '신한' })],
      txns: [
        tx('i1', '2026-11-03', 'in', 3_300_000, '김철수', { settled: 3_300_000 }),
        tx('i2', '2026-11-04', 'in', 500_000, '모르는분'),
        tx('o1', '2026-11-05', 'out', 1_100_000, '에스자재', { settled: 1_000_000 }),
        tx('o2', '2026-11-06', 'out', 2_000_000, '내 신한', {}),
        tx('i3', '2026-11-06', 'in', 2_000_000, '내 국민', { accountId: 'a2' }),
        tx('o3', '2026-11-07', 'out', 40_000, '개인 용돈', { human: 'unrelated' }),
        tx('o4', '2026-10-31', 'out', 99_999, '지난달'),
      ],
    }));
    const m = r.month;
    assert.equal(m.complete, true);
    assert.deepEqual(m.cash.in, { total: 3_800_000, by: { receivable: 3_300_000, other: 500_000 } });
    assert.deepEqual(m.cash.out, { total: 1_100_000, by: { payable: 1_000_000, other: 100_000 } });
    assert.equal(m.cash.net, 2_700_000);
    assert.equal(m.cash.excluded, 4_040_000, '내 계좌 사이 2,000,000 × 2 + 무관 40,000');
    assert.deepEqual([m.unknown.inTotal, m.unknown.outTotal, m.unknown.topIds[0]], [500_000, 100_000, 'i2']);
  });

  it('모르는 것은 0으로 세지 않는다: 그달을 덮지 못한 계좌, 현금매출 입력 안 함, 카드 조회 안 함, 회수율', () => {
    const r = analyzeCashFlow(base({
      month: '2026-10',
      accounts: [acct(), acct({ id: 'a2', last4: '2222', bank: '신한', ranges: [{ from: '2026-10-10', to: '2026-11-15' }] })],
      invoices: [inv('s1', { writtenOn: '2026-10-05', remaining: 0, state: 'settled', settledOn: '2026-10-25' })],
    }));
    assert.equal(r.month.complete, false);
    assert.deepEqual(r.month.missing.map((x) => x.last4), ['2222']);
    assert.equal(r.month.accrual.cashSales, null);
    assert.equal(r.month.accrual.card, null);
    assert.equal(r.month.accrual.payroll, null);
    assert.equal(r.month.collectionRate, null, '거래내역이 그달부터 덮지 못하면 회수율을 내지 않는다');
    const ok = analyzeCashFlow(base({ month: '2026-10', invoices: [inv('s1', { writtenOn: '2026-10-05', remaining: 0, state: 'settled', settledOn: '2026-10-25' }), inv('s2', { writtenOn: '2026-10-20' })] }));
    assert.equal(ok.month.collectionRate, 0.5);
    const none = analyzeCashFlow(base({ accounts: [] }));
    assert.deepEqual([none.month.hasAccounts, none.month.complete], [false, false]);
  });

  it('발생 기준: 세금계산서·현금매출·카드·영수증(카드와 짝이면 한 번만)·급여, 빼기로 한 건은 넣지 않는다', () => {
    const r = analyzeCashFlow(base({
      month: '2026-10',
      invoices: [inv('s1', { writtenOn: '2026-10-05', total: 2_200_000 }), inv('s2', { writtenOn: '2026-10-06', total: 9_999, state: 'excluded' }), inv('p1', { kind: 'purchase', writtenOn: '2026-10-07', total: 550_000 })],
      cashSales: [{ day: '2026-10-02', amount: 120_000 }, { day: '2026-10-03', amount: 80_000 }],
      cardRanges: [{ from: '2026-10-01', to: '2026-10-20' }, { from: '2026-10-21', to: '2026-11-10' }],
      cardTxns: [{ day: '2026-10-10', amount: 33_000, merchantBizNo: '1234567890', canceled: false }, { day: '2026-10-12', amount: 10_000, merchantBizNo: null, canceled: false }, { day: '2026-10-13', amount: 10_000, merchantBizNo: null, canceled: true }],
      receipts: [{ day: '2026-10-11', amount: 33_000, merchantBizNo: '1234567890' }, { day: '2026-10-15', amount: 7_000, merchantBizNo: null }],
      payroll: [{ month: '2026-10', gross: 3_000_000, net: 2_700_000 }],
    }));
    assert.deepEqual(r.month.accrual, { salesInvoices: 2_200_000, cashSales: 200_000, purchaseInvoices: 550_000, card: 33_000, receipts: 7_000, payroll: 3_000_000 });
  });

  it('지금 모습: 잔액, 앞으로 30일(기한 정해진 것만, 기한 지난 받을 돈은 넣지 않음), 묵은 받을 돈', () => {
    const r = analyzeCashFlow(base({
      invoices: [
        inv('s1', { dueOn: '2026-11-30', remaining: 400_000 }),
        inv('s2', { dueOn: '2026-10-01', remaining: 300_000 }),
        inv('s3', { dueOn: '2026-07-01', remaining: 200_000 }),
        inv('s4', { dueOn: null, remaining: 100_000 }),
        inv('s5', { state: 'unknown', remaining: 50_000 }),
        inv('p1', { kind: 'purchase', dueOn: '2026-12-01', remaining: 600_000 }),
        inv('p2', { kind: 'purchase', dueOn: '2026-11-01', remaining: 70_000 }),
        inv('p3', { kind: 'purchase', dueOn: '2027-02-01', remaining: 999 }),
        inv('p4', { kind: 'purchase', dueOn: null, remaining: 1 }),
      ],
    }));
    assert.deepEqual(r.snapshot.balance.total, 5_000_000);
    assert.deepEqual(r.snapshot.next30, { payOut: 600_000, payOverdue: 70_000, payIn: 400_000, noDuePay: 1, noDueRecv: 1 });
    assert.deepEqual(r.snapshot.aging, { notDue: 500_000, d0_30: 0, d31_60: 300_000, d61_90: 0, d90p: 200_000, unknown: 50_000 });
  });

  it('회수일: 금액 가중 평균, 거래처별(3건 이상), 최근 3건이 15일 넘게 늦어지면 알림', () => {
    const done = (id: string, w: string, s: string, total = 1_000_000) => inv(id, { writtenOn: w, settledOn: s, state: 'settled', remaining: 0, total });
    const r = analyzeCashFlow(base({
      invoices: [
        done('1', '2026-04-01', '2026-05-01'), done('2', '2026-05-01', '2026-05-31'), done('3', '2026-06-01', '2026-07-01'),
        done('4', '2026-07-01', '2026-08-20'), done('5', '2026-08-01', '2026-09-20'), done('6', '2026-09-01', '2026-10-21'),
        done('b1', '2026-09-01', '2026-09-11', 3_000_000), inv('b2', { counterpartyKey: 'B', cpName: '비상사', writtenOn: '2026-10-01', settledOn: '2026-10-11', state: 'settled', remaining: 0 }),
      ].map((v) => (v.id.startsWith('b') ? { ...v, counterpartyKey: 'B', cpName: '비상사' } : v)),
    }));
    const a = r.snapshot.collectDays.byCounterparty.find((c) => c.key === 'A')!;
    assert.deepEqual([a.count, a.priorDays, a.recentDays], [6, 30, 50]);
    assert.ok(!r.snapshot.collectDays.byCounterparty.some((c) => c.key === 'B'), '2건뿐인 거래처는 보이지 않는다');
    assert.equal(r.snapshot.collectDays.overall, Math.round((30 * 1e6 * 3 + 50 * 1e6 * 3 + 10 * 3e6 + 10 * 1e6) / 10e6));
    assert.ok(r.alerts.some((x) => x.kind === 'slowdown' && x.counterpartyKey === 'A' && x.recentDays === 50));
  });

  it('쏠림: 지난 3개월 매출 5건 이상일 때만, 1곳이 50%를 넘으면 분기 알림', () => {
    const few = analyzeCashFlow(base({ invoices: [inv('1', { writtenOn: '2026-11-01' })] }));
    assert.equal(few.snapshot.concentration.top1, null);
    const many = analyzeCashFlow(base({
      invoices: [
        inv('1', { writtenOn: '2026-09-05', total: 3_000_000 }), inv('2', { writtenOn: '2026-10-05', total: 3_000_000 }), inv('3', { writtenOn: '2026-11-05', total: 1_000_000 }),
        inv('4', { writtenOn: '2026-10-07', counterpartyKey: 'B', cpName: '비', total: 2_000_000 }), inv('5', { writtenOn: '2026-10-08', counterpartyKey: 'C', cpName: '씨', total: 1_000_000 }),
        inv('old', { writtenOn: '2026-08-31', counterpartyKey: 'D', total: 9_000_000 }),
      ],
    }));
    assert.deepEqual(many.snapshot.concentration.top1, { key: 'A', cpName: 'A상사', share: 0.7 });
    assert.equal(many.snapshot.concentration.top3Share, 1);
    assert.ok(many.alerts.some((x) => x.kind === 'concentration' && x.id === 'concentration:2026Q4'));
  });

  it('잔액 부족 알림: 잔액 + 들어올 돈 < 나갈 돈. 거래내역이 오래됐거나 잔액을 모르는 계좌가 있으면 내지 않는다', () => {
    const invoices = [inv('p1', { kind: 'purchase', dueOn: '2026-11-25', remaining: 6_000_000 }), inv('s1', { dueOn: '2026-11-20', remaining: 500_000 })];
    const r = analyzeCashFlow(base({ invoices }));
    assert.deepEqual(r.alerts.filter((x) => x.kind === 'shortfall'), [{ id: 'shortfall:2026-11-16', kind: 'shortfall', gap: 500_000 }]);
    const stale = analyzeCashFlow(base({ invoices, accounts: [acct({ ranges: [{ from: '2026-01-01', to: '2026-11-01' }], coverTo: '2026-11-01' })] }));
    assert.ok(!stale.alerts.some((x) => x.kind === 'shortfall'));
    const noBal = analyzeCashFlow(base({ invoices, accounts: [acct(), acct({ id: 'a2', balance: null, balanceDay: null })] }));
    assert.ok(!noBal.alerts.some((x) => x.kind === 'shortfall'));
  });

  it('모르는 입금이 그달 입금의 20%를 넘으면 알림(그달을 다 덮었을 때만)', () => {
    const txns = [tx('i1', '2026-11-03', 'in', 1_000_000, 'a', { settled: 1_000_000 }), tx('i2', '2026-11-04', 'in', 400_000, '모름')];
    assert.ok(analyzeCashFlow(base({ txns })).alerts.some((x) => x.kind === 'unknown_in' && x.share === 0.286));
    const part = analyzeCashFlow(base({ txns, accounts: [acct({ ranges: [{ from: '2026-11-03', to: '2026-11-15' }] })] }));
    assert.ok(!part.alerts.some((x) => x.kind === 'unknown_in'));
  });
});

describe('현금흐름 조회(엔진, 실제 DB)', () => {
  let dir: string;
  let db: Db;
  let pid: string;
  let svc: BankService;
  let acctId: string;
  const now = new Date('2026-11-16T01:00:00Z');
  const call = <T>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, { profileId: pid, ...p }) as Promise<T>;
  const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);
  const me = syntheticBizNo(60);
  const approval = (i: number) => `20261001410000${String(10000000 + i).slice(-8)}00`.slice(0, 24);

  before(async () => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-cf-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    pid = new ProfileRepo(db).upsert({ kind: 'business', displayName: '하늘상회', bizNo: me, corpNo: null, repName: '김하늘', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
    svc = new BankService(db, new ColumnCipher(new Uint8Array(randomBytes(32))), new Uint8Array(randomBytes(32)), { vaultDir: path.join(dir, 'vault'), now: () => now });
    await call('bank.consent', { version: '09-v1' });
    acctId = (await call<{ id: string }>('bank.addAccount', { bank: '국민', number: '123-45-678901' })).id;
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('프로토콜: 새 조회·명령도 main 전용 은행 목록에 있다', () => {
    assert.ok((BANK_READ_QUERIES as readonly string[]).includes('db.query.bank.cashflow'));
    assert.ok((BANK_READ_QUERIES as readonly string[]).includes('db.query.bank.cashflowSeries'));
    assert.ok((BANK_COMMANDS as readonly string[]).includes('bank.categorize'));
  });

  it('거래내역·세금계산서·현금매출 → 그달 요약과 지금 모습. 통장 표시 원문은 결과에 없다', async () => {
    await call('bank.importInvoices', { rows: [
      { approvalNo: approval(1), writtenOn: '2026-11-02', supplierBizNo: me, buyerBizNo: syntheticBizNo(61), buyerName: '에이상사', total: 2_200_000 },
      { approvalNo: approval(2), writtenOn: '2026-11-03', supplierBizNo: syntheticBizNo(62), supplierName: '에스자재', buyerBizNo: me, total: 330_000 },
    ] });
    await call('bank.importTxns', { accountId: acctId, period: { from: '2026-11-01', to: '2026-11-15' }, rows: [
      { occurredAt: '2026-11-01 09:00', day: '2026-11-01', direction: 'in', amount: 1_000_000, balance: 1_000_000, payer: '김비밀', memo: null },
      { occurredAt: '2026-11-10 09:00', day: '2026-11-10', direction: 'out', amount: 180_000, balance: 820_000, payer: '국민연금공단', memo: '연금' },
      { occurredAt: '2026-11-11 09:00', day: '2026-11-11', direction: 'out', amount: 55_000, balance: 765_000, payer: '쿠팡', memo: null },
      { occurredAt: '2026-11-12 09:00', day: '2026-11-12', direction: 'out', amount: 66_000, balance: 699_000, payer: '쿠팡', memo: null },
    ] });
    db.prepare(`INSERT INTO cash_sales (profile_id, day, amount, entered_at) VALUES (?, '2026-11-05', 90000, '2026-11-05T10:00:00Z')`).run(pid);
    const r = await call<CashFlowResult>('db.query.bank.cashflow');
    assert.equal(r.month.month, '2026-11');
    assert.deepEqual(r.month.cash.out.by, { tax: 180_000, other: 121_000 });
    assert.equal(r.month.cash.in.total, 1_000_000);
    assert.deepEqual([r.month.accrual.salesInvoices, r.month.accrual.purchaseInvoices, r.month.accrual.cashSales], [2_200_000, 330_000, 90_000]);
    assert.equal(r.snapshot.balance.total, 699_000);
    assert.equal(r.snapshot.next30.payOut, 330_000);
    assert.ok(!JSON.stringify(r).includes('김비밀') && !JSON.stringify(r).includes('쿠팡'), '통장 표시 원문을 내지 않는다');
  });

  it('[갈래 정하기] + 기억: 같은 통장 표시는 다음부터 그 갈래, 되돌리기, 잘못된 값', async () => {
    const coupang = db.prepare(`SELECT id FROM bank_txns WHERE payer = '쿠팡' ORDER BY day`).pluck().all() as string[];
    const r = await call<{ seq: number; remembered: boolean }>('bank.categorize', { txnId: coupang[0], category: 'unrelated', remember: true });
    assert.equal(r.remembered, true);
    let cf = await call<CashFlowResult>('db.query.bank.cashflow');
    assert.deepEqual(cf.month.cash.out.by, { tax: 180_000 }, '두 줄 모두 분석에서 빠진다(한 줄은 규칙으로)');
    assert.equal(cf.month.cash.excluded, 121_000);
    await call('bank.undo', { seq: r.seq });
    cf = await call<CashFlowResult>('db.query.bank.cashflow');
    assert.equal(cf.month.cash.excluded, 121_000, '되돌려도 기억한 규칙은 남는다(규칙은 [갈래 정하기]로 다시 바꾼다)');
    await code(call('bank.categorize', { txnId: coupang[0], category: 'loan' }), 'bad_category');
    await code(call('db.query.bank.cashflow', { month: '2026-13' }), 'bad_month');
    await code(call('db.query.bank.cashflow', { month: '2026-12' }), 'bad_month');
  });

  it('달마다 요약(기본 6개월, 오래된 달이 앞). 거래내역이 없는 달은 complete=false', async () => {
    const s = await call<{ months: CashFlowMonth[] }>('db.query.bank.cashflowSeries');
    assert.deepEqual(s.months.map((m) => m.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    assert.deepEqual(s.months.map((m) => m.complete), [false, false, false, false, false, true]);
    await code(call('db.query.bank.cashflowSeries', { months: 13 }), 'bad_months');
  });
});
