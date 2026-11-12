// 돈 맞추기 1단계(09): 은행 거래내역·홈택스 발급 목록 읽기(docparse), 저장(v9, 계좌번호 봉인·HMAC), 맞추기 규칙(§6), 수동 체크·되돌리기(§7), 대화 답(로컬).
// 모든 값은 가짜다(합성 사업자번호, 가짜 계좌번호·이름).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ColumnCipher, CounterpartyRepo, normalizePayerName, openDatabase, ProfileRepo, RunRepo, syntheticBizNo, type Db } from '@sax/db';
import { parseBankStatement, parseHometaxIssueList, type Cell } from '@sax/docparse';
import { readCsv, type SheetOutput } from '@sax/docparse/sandbox';
import { BankService, dueDate, rowKeys, runMatch, sourceRowsToInput, SourceError, type ReceivableView, type RefreshJob, type SourceRow, type TxnSource, type TxnView } from '@sax/engine';
import { BANK_COMMANDS, BANK_READ_QUERIES, COMMANDS, MAIN_ONLY, READ_QUERIES } from '@sax/engine/protocol';
import { BankHost } from '../apps/desktop/src/bank-host.ts';

const sheet = (rows: Cell[][], name = 'Sheet1'): SheetOutput => ({
  format: 'xlsx', encoding: null, sheets: [{ name, hidden: false, rows, hiddenRows: 0 }],
  flags: { formulas: 0, externalLinks: false, macros: false, connections: false, embedded: false, hiddenSheets: 0, truncated: false, formulaLikeText: 0 },
});
const approval = (i: number) => `20261001410000${String(10000000 + i).slice(-8)}00`.slice(0, 24);

describe('은행 거래내역 파일 읽기(docparse bank-v1)', () => {
  it('국민 모양: 거래일시·적요·기재내용·찾으신금액·맡기신금액·잔액, 앞쪽 계좌번호는 끝 4자리만', () => {
    const out = sheet([
      ['국민은행 거래내역조회'],
      ['계좌번호 : 123456-01-987654', null, '조회기간 : 2026.10.01 ~ 2026.11.11'],
      ['거래일시', '적요', '기재내용', '찾으신금액', '맡기신금액', '잔액', '거래점'],
      ['2026.11.03 14:22:05', '타행이체', '에이상사', '0', '3,300,000', '5,300,000', '강남'],
      ['2026.11.04 09:10:00', '체크카드', '편의점', '12,000', '0', '5,288,000', '본점'],
      ['합계', null, null, '12,000', '3,300,000'],
    ]);
    const r = parseBankStatement(out);
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[0], { occurredAt: '2026-11-03 14:22:05', day: '2026-11-03', direction: 'in', amount: 3_300_000, balance: 5_300_000, payer: '에이상사', memo: '타행이체', counterAccount: null });
    assert.equal(r.rows[1]!.direction, 'out');
    assert.equal(r.accountLast4, '7654');
    assert.equal(r.bankHint, '국민');
    assert.deepEqual(r.period, { from: '2026-11-03', to: '2026-11-04' });
    assert.ok(r.signature?.includes('맡기신금액'));
    assert.ok(!JSON.stringify(r).includes('123456'), '계좌번호 전체가 결과에 없다');
  });

  it('신한 모양: 거래일자 + 시간 칸, 내용 = 입금자. 입금자명은 입금 금액 칸이 되지 않는다', () => {
    const r = parseBankStatement(sheet([
      ['거래일자', '시간', '적요', '출금액', '입금액', '내용', '잔액', '거래점'],
      ['2026-11-05', '10:01', '인터넷', '', '1,100,000', '김철수', '9,000,000', '신한'],
    ]));
    assert.equal(r.rows[0]!.occurredAt, '2026-11-05 10:01');
    assert.equal(r.rows[0]!.payer, '김철수');
    assert.equal(r.rows[0]!.amount, 1_100_000);
    const r2 = parseBankStatement(sheet([['거래일', '입금자명', '입금액', '출금액'], ['20261106', '나상회', '50000', '']]));
    assert.equal(r2.rows[0]!.payer, '나상회');
    assert.equal(r2.rows[0]!.day, '2026-11-06');
  });

  it('금액 한 칸 + 구분 칸, 모르는 서식은 사람이 고른 열(mapping)로 읽는다', () => {
    const r = parseBankStatement(sheet([['일자', '구분', '거래금액', '상대'], ['2026.11.07', '입금', '700,000', '다상사'], ['2026.11.07', '출금', '20,000', '가게']]));
    assert.deepEqual(r.rows.map((x) => [x.direction, x.amount]), [['in', 700_000], ['out', 20_000]]);
    const odd = sheet([['A', 'B', 'C', 'D'], ['2026/11/08', 'x', '45,000', '라상회']]);
    assert.ok(parseBankStatement(odd).warnings.includes('header_not_found'));
    const m = parseBankStatement(odd, { sheet: 'Sheet1', headerRow: 0, columns: { date: 0, in: 2, payer: 3 } });
    assert.equal(m.rows[0]!.amount, 45_000);
    assert.equal(m.rows[0]!.payer, '라상회');
  });

  it('CSV(UTF-8, 쉼표)도 같은 길로 읽는다', () => {
    const csv = new TextEncoder().encode('거래일시,적요,보낸분/받는분,입금,출금,잔액\n2026-11-09 08:00,이체,"마상사",220000,,1000000\n');
    const r = parseBankStatement(readCsv(csv));
    assert.equal(r.rows[0]!.payer, '마상사');
    assert.equal(r.rows[0]!.amount, 220_000);
  });
});

describe('홈택스 발급 목록 엑셀(docparse hometax-issue-list-v1)', () => {
  it('한 줄 머리글(공급자·공급받는자 같은 이름 두 번): 두 번째가 공급받는자, 같은 승인번호는 한 번', () => {
    const buyer = syntheticBizNo(31);
    const me = syntheticBizNo(30);
    const r = parseHometaxIssueList(sheet([
      ['작성일자', '승인번호', '발급일자', '전송일자', '등록번호', '상호', '대표자명', '등록번호', '상호', '대표자명', '합계금액', '공급가액', '세액', '품목명'],
      ['2026-10-05', '20261005-41000000-12345678', '2026-10-05', '2026-10-06', me, '하늘상회', '김하늘', `${buyer.slice(0, 3)}-${buyer.slice(3, 5)}-${buyer.slice(5)}`, '(주)에이상사', '이에이', '3,300,000', '3,000,000', '300,000', '컨설팅'],
      ['2026-10-05', '20261005-41000000-12345678', '2026-10-05', '2026-10-06', me, '하늘상회', '김하늘', buyer, '(주)에이상사', '이에이', '3,300,000', '3,000,000', '300,000', '컨설팅'],
    ]));
    assert.equal(r.rows.length, 1);
    assert.equal(r.duplicates, 1);
    assert.deepEqual(r.rows[0], { approvalNo: '202610054100000012345678', writtenOn: '2026-10-05', issuedOn: '2026-10-05', supplierBizNo: me, buyerBizNo: buyer, buyerName: '(주)에이상사', buyerRep: '이에이', item: '컨설팅', total: 3_300_000, supply: 3_000_000, tax: 300_000 });
  });

  it('두 줄 머리글(위: 공급자 / 공급받는자)', () => {
    const buyer = syntheticBizNo(32);
    const r = parseHometaxIssueList(sheet([
      ['작성일자', '승인번호', '공급자', null, '공급받는자', null, null, '합계금액', '공급가액', '세액'],
      [null, null, '등록번호', '상호', '등록번호', '상호', '대표자명', null, null, null],
      ['20261010', '202610104100000099990000', syntheticBizNo(30), '하늘상회', buyer, '비상사', '박비', 1_100_000, 1_000_000, 100_000],
    ]));
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0]!.buyerBizNo, buyer);
    assert.equal(r.rows[0]!.buyerName, '비상사');
    assert.equal(r.rows[0]!.total, 1_100_000);
  });
});

describe('맞추기 규칙(09 §6, 순수 함수)', () => {
  const cp = (key: string, o: Partial<Parameters<typeof runMatch>[0]['counterparties'][number]> = {}) => ({ key, name: null, rep: null, aliases: [], holders: [], accountHmacs: [], humanConfirmed: false, ...o });
  const tx = (id: string, day: string, amount: number, payer: string | null) => ({ id, day, amount, unallocated: amount, payer, counterAccountHmac: null, assignedCpKey: null });

  it('첫 맞춤은 사람: 별칭이 맞아도 사람이 확정한 적이 없으면 후보', () => {
    const r = runMatch({ counterparties: [cp('A', { name: 'A상사', aliases: [normalizePayerName('김철수')] })], receivables: [{ id: 'r1', cpKey: 'A', writtenOn: '2026-10-05', dueOn: '2026-11-04', remaining: 3_300_000 }], txns: [tx('t1', '2026-11-03', 3_300_000, '김철수')], rejects: new Set() });
    assert.equal(r.auto.length, 0);
    assert.equal(r.candidates.get('t1')![0]!.receivableIds[0], 'r1');
  });

  it('자동 확정: 강한 이름 + 같은 금액 + 창 안 + 후보 하나 + 사람이 확정한 적 있음. 같은 금액 건이 둘이면 자동이 아니다', () => {
    const base = { counterparties: [cp('A', { name: 'A상사', aliases: ['김철수'], humanConfirmed: true })], rejects: new Set<string>() };
    const one = runMatch({ ...base, receivables: [{ id: 'r1', cpKey: 'A', writtenOn: '2026-10-05', dueOn: '2026-11-04', remaining: 500_000 }], txns: [tx('t1', '2026-11-03', 500_000, '김철수')] });
    assert.deepEqual(one.auto, [{ txnId: 't1', receivableId: 'r1', amount: 500_000, signal: 'alias' }]);
    const two = runMatch({ ...base, receivables: [{ id: 'r1', cpKey: 'A', writtenOn: '2026-10-05', dueOn: '2026-11-04', remaining: 500_000 }, { id: 'r2', cpKey: 'A', writtenOn: '2026-10-20', dueOn: '2026-11-19', remaining: 500_000 }], txns: [tx('t1', '2026-11-03', 500_000, '김철수')] });
    assert.equal(two.auto.length, 0);
    assert.equal(two.candidates.get('t1')![0]!.receivableIds[0], 'r1', '작성일이 이른 건이 첫 후보');
  });

  it('상호 일치만으로는 자동이 아니다. 수수료·합산·부분·창 밖·뗀 짝', () => {
    const cps = [cp('A', { name: '(주)에이상사', humanConfirmed: true })];
    const recv = [{ id: 'r1', cpKey: 'A', writtenOn: '2026-10-05', dueOn: '2026-11-04', remaining: 1_000_000 }, { id: 'r2', cpKey: 'A', writtenOn: '2026-10-20', dueOn: '2026-11-19', remaining: 2_000_000 }];
    const r = runMatch({ counterparties: cps, receivables: recv, rejects: new Set(['r1|t5']), txns: [tx('t1', '2026-11-03', 1_000_000, '에이상사'), tx('t2', '2026-11-03', 999_500, '에이상사'), tx('t3', '2026-11-05', 3_000_000, '에이상사'), tx('t4', '2027-06-01', 1_000_000, '에이상사'), tx('t5', '2026-11-03', 1_000_000, '모르는분')] });
    assert.equal(r.auto.length, 0);
    assert.equal(r.candidates.get('t1')![0]!.signal, 'name');
    assert.equal(r.candidates.get('t2')![0]!.fit, 'fee');
    assert.equal(r.candidates.get('t2')![0]!.feeGap, 500);
    assert.ok(r.candidates.get('t3')!.some((c) => c.fit === 'sum' && c.receivableIds.join() === 'r1,r2'));
    assert.deepEqual(r.candidates.get('t4'), [], '창 밖은 미지정');
    assert.deepEqual(r.candidates.get('t5'), [], '뗀 짝은 다시 내지 않는다');
  });

  it('결제 조건 → 받기로 한 날', () => {
    assert.equal(dueDate('2026-10-05', { kind: 'days', n: 30 }), '2026-11-04');
    assert.equal(dueDate('2026-01-31', { kind: 'next_month_day', d: 31 }), '2026-02-28');
    assert.equal(dueDate('2026-12-10', { kind: 'month_end' }), '2027-01-31');
    assert.equal(dueDate('2026-12-10', { kind: 'none' }), null);
  });

  it('줄 열쇠: 같은 줄은 같은 열쇠, 같은 값이 둘이면 순번으로 가른다', () => {
    const row = { occurredAt: '2026-11-03', direction: 'in' as const, amount: 1000, balance: null, payer: 'x' };
    const k = rowKeys([row, row]);
    assert.notEqual(k[0], k[1]);
    assert.deepEqual(rowKeys([row, row]), k);
  });
});

describe('BankService(엔진, 실제 DB)', () => {
  let dir: string;
  let db: Db;
  let pid: string;
  let svc: BankService;
  let now = new Date('2026-11-12T01:00:00Z');
  const cipher = new ColumnCipher(new Uint8Array(randomBytes(32)));
  const call = <T>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, { profileId: pid, ...p }) as Promise<T>;
  const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);
  type Overview = { summary: Record<string, unknown>; unpaid: ReceivableView[]; received: ReceivableView[]; review: TxnView[] };
  const me = syntheticBizNo(40);
  const aBiz = syntheticBizNo(41);
  const bBiz = syntheticBizNo(42);
  let acct: string;
  let aId: string;

  before(() => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-bank-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    pid = new ProfileRepo(db).upsert({ kind: 'business', displayName: '하늘상회', bizNo: me, corpNo: null, repName: '김하늘', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
    svc = new BankService(db, cipher, new Uint8Array(randomBytes(32)), { vaultDir: path.join(dir, 'vault'), now: () => now });
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('프로토콜: 은행 메서드는 모두 main 전용 목록(READ_QUERIES·COMMANDS 밖)에 따로 있다', () => {
    for (const m of [...BANK_READ_QUERIES, ...BANK_COMMANDS]) {
      assert.ok(!(READ_QUERIES as readonly string[]).includes(m) && !(COMMANDS as readonly string[]).includes(m) && !(MAIN_ONLY as readonly string[]).includes(m), m);
    }
  });

  it('내 계좌: 번호는 봉인 칸 + 끝 4자리, 같은 번호 두 번 금지, [보기]로만 전체', async () => {
    await code(call('bank.addAccount', { bank: '국민', number: '123456-01-987654' }), 'consent_required');
    await call('bank.consent', { version: '09-v1' });
    const a = await call<{ id: string; last4: string }>('bank.addAccount', { bank: '국민', number: '123456-01-987654', alias: '주거래' });
    acct = a.id;
    assert.equal(a.last4, '7654');
    assert.ok(!JSON.stringify(a).includes('123456'));
    const raw = db.prepare('SELECT * FROM bank_accounts').get() as Record<string, unknown>;
    assert.ok(!Buffer.from(raw.number_enc as Uint8Array).toString('latin1').includes('987654'), '봉인 칸에 평문 없음');
    await code(call('bank.addAccount', { bank: '국민', number: '12345601987654' }), 'duplicate_account');
    await code(call('bank.addAccount', { bank: '국민', number: '12' }), 'bad_account_number');
    assert.deepEqual(await call('bank.revealAccount', { id: acct }), { number: '12345601987654' });
  });

  it('홈택스 목록 → 받을 돈 건(거래처 없으면 만듦), 내가 공급받는자인 줄(매입)은 받지 않는다', async () => {
    const rows = [
      { approvalNo: approval(1), writtenOn: '2026-10-05', supplierBizNo: me, buyerBizNo: aBiz, buyerName: '(주)에이상사', buyerRep: '이에이', item: '컨설팅', total: 3_300_000, supply: 3_000_000, tax: 300_000 },
      { approvalNo: approval(2), writtenOn: '2026-10-10', supplierBizNo: me, buyerBizNo: bBiz, buyerName: '비상사', buyerRep: '박비', item: '납품', total: 1_100_000, supply: 1_000_000, tax: 100_000 },
      { approvalNo: approval(3), writtenOn: '2026-10-11', supplierBizNo: bBiz, buyerBizNo: me, buyerName: '하늘상회', buyerRep: '김하늘', item: '매입', total: 55_000, supply: 50_000, tax: 5_000 },
    ];
    const r = await call<{ created: number; purchase: number; newCounterparties: number; documentId: string }>('bank.importInvoices', { rows, file: { bytes: new TextEncoder().encode('fake list'), ext: 'xlsx', displayName: '/x/목록.xlsx' } });
    assert.equal(r.created, 2);
    assert.equal(r.purchase, 1);
    assert.equal(r.newCounterparties, 2);
    const again = await call<{ created: number; merged: number }>('bank.importInvoices', { rows: rows.slice(0, 2) });
    assert.deepEqual([again.created, again.merged], [0, 2], '같은 승인번호는 합친다');
    aId = new CounterpartyRepo(db).byBizNo(aBiz)!.id;
    const o = await call<Overview>('db.query.bank.overview');
    assert.equal(o.unpaid.length, 2);
    assert.equal(o.unpaid.find((v) => v.cpName === '(주)에이상사')!.dueOn, '2026-11-04');
    assert.equal(o.summary.stale, true);
    assert.deepEqual(o.unpaid.map((v) => v.status), ['unknown', 'unknown'], '거래내역이 없으면 못 받음이 아니라 확인 못 함');
    assert.equal(o.summary.overdueCount, 0, '모르는 상태에서 기한 지남이라고 하지 않는다');
  });

  it('거래내역 넣기 → 첫 맞춤은 후보 → [맞아요] → 별칭 제안 → 다음 달은 자동, 다시 올려도 같은 결과', async () => {
    const rows = [
      { occurredAt: '2026-11-03 14:22', day: '2026-11-03', direction: 'in', amount: 3_300_000, balance: 5_300_000, payer: '김철수', memo: '타행' },
      { occurredAt: '2026-11-04 09:00', day: '2026-11-04', direction: 'out', amount: 12_000, balance: 5_288_000, payer: '편의점', memo: '카드' },
      { occurredAt: '2026-11-05 10:00', day: '2026-11-05', direction: 'in', amount: 777, balance: 5_288_777, payer: '이자', memo: '결산' },
    ];
    const r = await call<{ newCount: number; match: { auto: number; review: number; unknown: number } }>('bank.importTxns', { accountId: acct, rows, file: { bytes: new TextEncoder().encode('fake bank'), ext: 'csv' } });
    assert.equal(r.newCount, 3);
    assert.deepEqual(r.match, { auto: 0, review: 1, unknown: 1 });
    const again = await call<{ newCount: number; duplicateCount: number }>('bank.importTxns', { accountId: acct, rows });
    assert.deepEqual([again.newCount, again.duplicateCount], [0, 3]);
    let o = await call<Overview>('db.query.bank.overview');
    const t = o.review.find((x) => x.amount === 3_300_000)!;
    assert.equal(t.candidates[0]!.cpName, '(주)에이상사');
    assert.match(t.candidates[0]!.reason, /처음 보는 이름/);
    const acc = await call<{ aliasOffer: { name: string; counterpartyId: string; conflict: boolean } }>('bank.accept', { txnId: t.id, receivableIds: t.candidates[0]!.receivableIds });
    assert.deepEqual(acc.aliasOffer, { name: '김철수', counterpartyId: aId, conflict: false });
    await call('bank.addAlias', { counterpartyId: aId, name: acc.aliasOffer.name, source: 'learned' });
    o = await call<Overview>('db.query.bank.overview');
    assert.equal(o.received.length, 1);
    assert.equal(o.received[0]!.via, 'manual');
    assert.equal(o.summary.latestDay, '2026-11-05');
    assert.equal(o.summary.stale, false);
    // 다음 달 건과 입금: 별칭 + 사람이 확정한 적 있음 → 자동
    await call('bank.importInvoices', { rows: [{ approvalNo: approval(4), writtenOn: '2026-11-06', supplierBizNo: me, buyerBizNo: aBiz, buyerName: '(주)에이상사', total: 2_200_000 }] });
    const r2 = await call<{ match: { auto: number } }>('bank.importTxns', { accountId: acct, rows: [{ occurredAt: '2026-11-10', day: '2026-11-10', direction: 'in', amount: 2_200_000, balance: null, payer: '김 철수', memo: null }] });
    assert.equal(r2.match.auto, 1);
    o = await call<Overview>('db.query.bank.overview');
    const auto = o.received.find((v) => v.total === 2_200_000)!;
    assert.equal(auto.via, 'auto');
  });

  it('떼기 → 다시 후보로 내지 않음 → 되돌리기, 받았음 표시(현금) → 되돌리기, 기록이 남는다', async () => {
    let o = await call<Overview>('db.query.bank.overview');
    const auto = o.received.find((v) => v.total === 2_200_000)!;
    const d = await call<{ allocs: Array<{ id: string; removedAt: string | null; decidedBy: string }>; events: Array<{ seq: number; action: string; actor: string }> }>('db.query.bank.receivable', { id: auto.id });
    const live = d.allocs.find((a) => !a.removedAt)!;
    assert.equal(live.decidedBy, 'auto');
    const det = await call<{ seq: number }>('bank.detach', { allocId: live.id });
    o = await call<Overview>('db.query.bank.overview');
    assert.ok(o.unpaid.some((v) => v.id === auto.id), '뗀 건은 다시 못 받은 돈');
    const free = o.review.find((x) => x.amount === 2_200_000)!;
    assert.ok(!free.candidates.some((c) => c.receivableIds.includes(auto.id)), '뗀 짝은 후보가 아니다');
    await call('bank.undo', { seq: det.seq });
    await code(call('bank.undo', { seq: det.seq }), 'already_undone');
    o = await call<Overview>('db.query.bank.overview');
    assert.ok(o.received.some((v) => v.id === auto.id), '되돌리면 다시 받음');
    const b = o.unpaid.find((v) => v.cpName === '비상사')!;
    const mk = await call<{ seq: number }>('bank.markReceived', { receivableId: b.id, method: 'cash', memo: '현장' });
    o = await call<Overview>('db.query.bank.overview');
    const bv = o.received.find((v) => v.id === b.id)!;
    assert.equal(bv.offAccount, 'cash');
    await call('bank.undo', { seq: mk.seq });
    o = await call<Overview>('db.query.bank.overview');
    assert.ok(o.unpaid.some((v) => v.id === b.id));
    const ev = await call<{ events: Array<{ action: string }> }>('db.query.bank.receivable', { id: auto.id });
    assert.deepEqual(ev.events.map((e) => e.action), ['attach', 'detach', 'undo']);
  });

  it('[이 거래처 입금으로] + 기억하기 → 별칭, 다른 거래처 별칭과 겹치면 기억하지 않는다. 상관없는 입금', async () => {
    const o0 = await call<Overview>('db.query.bank.overview');
    const b = o0.unpaid.find((v) => v.cpName === '비상사')!;
    await call('bank.importTxns', { accountId: acct, rows: [{ occurredAt: '2026-11-11', day: '2026-11-11', direction: 'in', amount: 1_100_000, balance: null, payer: '박비대표', memo: null }] });
    let o = await call<Overview>('db.query.bank.overview');
    const t = o.review.find((x) => x.payer === '박비대표')!;
    const r = await call<{ conflict: boolean; aliasId: string | null; txn: TxnView }>('bank.assignTxn', { txnId: t.id, counterpartyId: b.counterpartyId, remember: true });
    assert.equal(r.conflict, false);
    assert.ok(r.aliasId);
    assert.equal(r.txn.candidates[0]!.receivableIds[0], b.id);
    const clash = await call<{ conflict: boolean }>('bank.assignTxn', { txnId: t.id, counterpartyId: aId, remember: true });
    assert.equal(clash.conflict, true);
    const interest = o.review.find((x) => x.amount === 777)!;
    await call('bank.ignoreTxn', { txnId: interest.id, reason: 'interest' });
    o = await call<Overview>('db.query.bank.overview');
    assert.ok(!o.review.some((x) => x.id === interest.id));
  });

  it('대화 도구 receivables: 아직 받지 않은 건만, 금액은 남은 돈, 계좌가 없으면 null(not_set_up)', async () => {
    const host = (rpc: (m: string, p?: Record<string, unknown>) => Promise<unknown>) =>
      new BankHost({ rpc, profileId: async () => pid, pick: async () => null, readSheet: async () => { throw new Error('unused'); }, log: () => {} });
    const rows = await host((m, p) => svc.handle(m, p ?? {})).receivables();
    const o = await call<Overview>('db.query.bank.overview');
    assert.deepEqual(rows, o.unpaid.map((v) => ({ counterpartyId: v.counterpartyId, counterparty: v.cpName, date: v.writtenOn, total: v.remaining })));
    assert.ok(rows!.length >= 1 && rows!.every((r) => r.counterparty !== '(주)에이상사'), '다 받은 건은 없다');
    assert.equal(await host(async () => ({ accounts: [], unpaid: [] })).receivables(), null);
  });

  it('원장(H-01 committed) 건을 받을 돈으로 들이고, 같은 승인번호의 홈택스 건과 하나로 합친다', async () => {
    const runId = 'run-ledger-1';
    new RunRepo(db).create({ id: runId, playbookId: 'hometax.invoice.issue', playbookVersion: '1', packageDigest: 'd', profileId: pid, trigger: 'local', inputsHash: 'i' });
    db.prepare('UPDATE runs SET inputs_json_enc = ? WHERE id = ?').run(cipher.seal(JSON.stringify({ v: 1, counterpartyId: aId, supply: 500_000, tax: 50_000 }), `runs.inputs_json_enc|${runId}`), runId);
    const ap = approval(9);
    db.prepare(`INSERT INTO irreversible_log (intent_id, step_id, attempt, run_id, business_key, playbook_id, inputs_hash, package_digest, action_hash, state, armed_at, device_id, verify_ref)
      VALUES ('i1', 's1', 1, ?, 'bk', 'hometax.invoice.issue', 'ih', 'pd', 'ah', 'committed', '2026-11-11T09:00:00Z', 'dev', ?)`).run(runId, `${ap.slice(0, 8)}-${ap.slice(8, 16)}-${ap.slice(16)}`);
    let o = await call<Overview>('db.query.bank.overview');
    const led = o.unpaid.find((v) => v.total === 550_000)!;
    assert.deepEqual(led.sources, ['ledger']);
    assert.equal(led.writtenOn, '2026-11-11');
    await call('bank.importInvoices', { rows: [{ approvalNo: ap, writtenOn: '2026-11-11', supplierBizNo: me, buyerBizNo: aBiz, buyerName: '(주)에이상사', item: '자문', total: 550_000 }] });
    o = await call<Overview>('db.query.bank.overview');
    const merged = o.unpaid.filter((v) => v.total === 550_000);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0]!.sources, ['ledger', 'hometax']);
    assert.equal(merged[0]!.item, '자문');
  });

  it('계좌를 지우면 그 입출금과 맞춤이 함께 지워지고 건은 못 받음으로 돌아간다', async () => {
    now = new Date('2026-11-30T01:00:00Z');
    const s = await call<{ stale: boolean }>('db.query.bank.summary');
    assert.equal(s.stale, true, '기준일이 7일 넘게 지나면 확인 못 함');
    const r = await call<{ removedAllocs: number }>('bank.deleteAccount', { id: acct });
    assert.ok(r.removedAllocs >= 2);
    const o = await call<Overview>('db.query.bank.overview');
    assert.equal(o.received.length, 0);
  });
});

describe('거래내역 원천: 파일 | 자동 연결(가짜 원천)', () => {
  let dir: string;
  let db: Db;
  let pid: string;
  let svc: BankService;
  let acct: string;
  const cipher = new ColumnCipher(new Uint8Array(randomBytes(32)));
  const call = <T>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, { profileId: pid, ...p }) as Promise<T>;
  const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);
  const txnCount = () => Number(db.prepare('SELECT count(*) FROM bank_txns WHERE account_id = ?').pluck().get(acct));
  /** 가짜 원천: 다음 fetch가 돌려줄 행·실패·멈춤을 고른다 */
  const fake = { rows: [] as SourceRow[], fail: null as string | null, gate: null as Promise<void> | null, calls: [] as Array<{ number: string; from: string; to: string }> };
  const source: TxnSource = {
    kind: 'auto',
    provider: 'fakesrc',
    async fetch(account, range, { onProgress }) {
      fake.calls.push({ number: account.number, ...range });
      onProgress?.({ state: 'requested', jobs: 2 });
      onProgress?.({ state: 'running', done: 1, jobs: 2 });
      if (fake.gate) await fake.gate;
      if (fake.fail) throw new SourceError(fake.fail);
      return { rows: fake.rows, range };
    },
  };
  const settle = async (): Promise<RefreshJob> => {
    for (let i = 0; i < 200; i++) {
      const j = await call<RefreshJob | null>('db.query.bank.refreshStatus', { accountId: acct });
      if (j && (j.state === 'done' || j.state === 'failed')) return j;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('refresh did not settle');
  };
  type Acct = { id: string; linkState: string; linkProvider: string | null; linkError: string | null; canRefresh: boolean };
  const account = async () => (await call<Acct[]>('db.query.bank.accounts')).find((a) => a.id === acct)!;

  before(async () => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-bank-src-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    pid = new ProfileRepo(db).upsert({ kind: 'business', displayName: '하늘상회', bizNo: syntheticBizNo(50), corpNo: null, repName: '김하늘', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
    svc = new BankService(db, cipher, new Uint8Array(randomBytes(32)), { vaultDir: path.join(dir, 'vault'), now: () => new Date('2026-11-12T01:00:00Z') });
    await call('bank.consent', { version: '09-v1' });
    acct = (await call<{ id: string }>('bank.addAccount', { bank: '우리', number: '1002-000-111222' })).id;
  });
  after(() => {
    svc.dispose();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('원천 행 → 넣기 줄: 입금자는 원천이 아는 칸, 없으면 적요 첫 칸, 입출금이 같이 있으면 두 줄', () => {
    const out = sourceRowsToInput('fakesrc', [
      { sourceId: 't1', occurredAt: '2026-11-10 09:30:00', deposit: 5000, withdrawal: 0, balance: 10_000, remarks: [null, ' 김철수 ', '타행'], memo: null },
      { sourceId: null, occurredAt: '2026-11-10', deposit: 100, withdrawal: 200, balance: null, remarks: ['적요'], memo: '메모', payer: '박영희' },
      { sourceId: 'bad', occurredAt: '11/10', deposit: 1, withdrawal: 0, balance: null, remarks: [], memo: null },
    ]);
    assert.equal(out.length, 3);
    assert.deepEqual([out[0]!.payer, out[0]!.memo, out[0]!.occurredAt, out[0]!.direction], ['김철수', '타행', '2026-11-10 09:30:00', 'in']);
    assert.match(String(out[0]!.sourceKey), /^[0-9a-f]{32}:in$/);
    assert.deepEqual([out[1]!.payer, out[1]!.memo, out[2]!.direction, out[2]!.sourceKey], ['박영희', '적요 메모', 'out', null]);
  });

  it('연결 상태: 처음은 파일만, 파일만 계좌는 최신화할 수 없고 원천이 꽂히지 않으면 못 쓴다', async () => {
    let a = await account();
    assert.deepEqual([a.linkState, a.linkProvider, a.canRefresh], ['file_only', null, false]);
    await code(call('bank.refresh', { accountId: acct }), 'source.not_linked');
    await code(call('bank.setLink', { accountId: acct, state: 'auto_connected' }), 'bad_provider');
    await call('bank.setLink', { accountId: acct, state: 'auto_connected', provider: 'fakesrc' });
    a = await account();
    assert.deepEqual([a.linkState, a.canRefresh], ['auto_connected', false]);
    await code(call('bank.refresh', { accountId: acct }), 'source.not_available');
    svc.registerSource(source);
    assert.equal((await account()).canRefresh, true);
  });

  it('파일로 넣은 줄과 같은 거래는 자동 원천이 다시 넣지 않고, 원천 id가 같은 줄은 두 번 들어가지 않는다', async () => {
    await call('bank.importTxns', { accountId: acct, rows: [
      { occurredAt: '2026-11-03', day: '2026-11-03', direction: 'in', amount: 3_300_000, balance: 5_300_000, payer: '김철수', memo: null },
      { occurredAt: '2026-11-04', day: '2026-11-04', direction: 'out', amount: 12_000, balance: 5_288_000, payer: '편의점', memo: null },
    ] });
    fake.rows = [
      { sourceId: 'x1', occurredAt: '2026-11-03 14:22:10', deposit: 3_300_000, withdrawal: 0, balance: 5_300_000, remarks: ['김철수'], memo: null },
      { sourceId: 'x2', occurredAt: '2026-11-04 09:00:00', deposit: 0, withdrawal: 12_000, balance: 5_288_000, remarks: ['편의점'], memo: null },
      { sourceId: 'x3', occurredAt: '2026-11-11 10:00:00', deposit: 770_000, withdrawal: 0, balance: 6_058_000, remarks: ['이에이'], memo: null },
    ];
    const started = await call<RefreshJob>('bank.refresh', { accountId: acct });
    assert.equal(started.state, 'requested');
    assert.deepEqual(started.range, { from: '2026-11-03', to: '2026-11-12' }, '마지막 거래일 하루 전부터 오늘까지');
    const j = await settle();
    assert.equal(j.state, 'done');
    assert.deepEqual([j.result!.rows, j.result!.newCount, j.result!.duplicateCount], [3, 1, 2]);
    assert.equal(txnCount(), 3);
    assert.equal(fake.calls[0]!.number, '1002000111222', '원천은 계좌번호 전체를 받는다');
    assert.ok(!JSON.stringify(j).includes('1002000111222'), '진행 상태에 계좌번호 없음');
    // 같은 원천 id를 다시 받아도(시각이 달라도) 한 줄
    fake.rows = [{ ...fake.rows[2]!, occurredAt: '2026-11-11 10:00:01' }];
    await call('bank.refresh', { accountId: acct });
    assert.equal((await settle()).result!.newCount, 0);
    assert.equal(txnCount(), 3);
    const imp = db.prepare("SELECT source, provider FROM bank_imports WHERE source = 'auto' LIMIT 1").get() as { source: string; provider: string };
    assert.deepEqual({ ...imp }, { source: 'auto', provider: 'fakesrc' });
    // 반대로, 자동으로 받은 줄을 파일로 다시 올려도 두 번 들어가지 않는다
    const back = await call<{ newCount: number }>('bank.importTxns', { accountId: acct, rows: [{ occurredAt: '2026-11-11', day: '2026-11-11', direction: 'in', amount: 770_000, balance: 6_058_000, payer: '이에이', memo: null }] });
    assert.equal(back.newCount, 0);
  });

  it('진행 상태를 낸다, 이미 도는 중이면 같은 진행을 돌려준다', async () => {
    let open!: () => void;
    fake.gate = new Promise((r) => (open = r));
    fake.rows = [];
    const a = await call<RefreshJob>('bank.refresh', { accountId: acct });
    await new Promise((r) => setTimeout(r, 5));
    const mid = await call<RefreshJob>('db.query.bank.refreshStatus', { accountId: acct });
    assert.deepEqual([mid.state, mid.done, mid.jobs], ['running', 1, 2]);
    assert.equal((await call<RefreshJob>('bank.refresh', { accountId: acct })).id, a.id);
    assert.equal(typeof (await call('db.query.bank.overview')), 'object', '수집 중에도 다른 명령은 막히지 않는다');
    open();
    fake.gate = null;
    assert.equal((await settle()).state, 'done');
  });

  it('원천이 실패해도 이미 들인 줄은 그대로, 계좌는 자동 오류(코드)로 남고 다음 성공에 돌아온다', async () => {
    const before = txnCount();
    fake.fail = 'source.cert_expired';
    await call('bank.refresh', { accountId: acct });
    const j = await settle();
    assert.deepEqual([j.state, j.code], ['failed', 'source.cert_expired']);
    assert.equal(txnCount(), before);
    let a = await account();
    assert.deepEqual([a.linkState, a.linkError, a.canRefresh], ['auto_error', 'source.cert_expired', true]);
    fake.fail = null;
    fake.rows = [];
    await call('bank.refresh', { accountId: acct });
    assert.equal((await settle()).state, 'done');
    a = await account();
    assert.deepEqual([a.linkState, a.linkError], ['auto_connected', null]);
    await call('bank.setLink', { accountId: acct, state: 'file_only' });
    a = await account();
    assert.deepEqual([a.linkState, a.linkProvider, a.canRefresh], ['file_only', null, false]);
    await code(call('bank.refresh', { accountId: acct }), 'source.not_linked');
  });
});
