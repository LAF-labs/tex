// 세무사 꾸러미 PC 입력(08 D-05, D14 M6-2·M6-4): 현금매출 하루 숫자, 종이 증빙 확인, 항목 상태 표시(해당 없음·파일 칸). main 전용, 모델 없음.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BundleService, type CashMonthView, type ItemStatus, type ReceiptView } from '@sax/bundle';
import { BundleRepo, CardRepo, ColumnCipher, deriveColumnKey, DocumentRepo, openDatabase, ProfileRepo, ReceiptRepo, RunRepo, syntheticBizNo, type BundleEntry, type Db } from '@sax/db';
import { BUNDLE_PC_COMMANDS, BUNDLE_PC_READ_QUERIES, COMMANDS, MAIN_ONLY, PAYROLL_MAIN_ONLY, PHONE_COMMANDS, READ_QUERIES } from '@sax/engine/protocol';

const root = path.resolve(import.meta.dirname, '..');
const entry = fs.readFileSync(path.join(root, 'packages/engine/src/entry.ts'), 'utf8');
const src = fs.readFileSync(path.join(root, 'packages/bundle/src/pc-entry.ts'), 'utf8');

let dir: string;
let db: Db;
let svc: BundleService;
let profileId: string;
let otherProfile: string;
const call = <T = unknown>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, p) as Promise<T>;
const code = (m: string, p: Record<string, unknown>, c: string) => assert.rejects(call(m, p), (e: Error & { code?: string }) => e.code === c, `${m} → ${c}`);
const changes = () => db.prepare('SELECT total_changes()').pluck().get() as number;

function doc(pid: string, docType: string, createdAt: string): string {
  const id = randomUUID();
  const content = randomBytes(16);
  const p = path.join(dir, `${id}.bin`);
  fs.writeFileSync(p, content);
  new DocumentRepo(db).insert(
    { id, profileId: pid, docType, displayName: null, issuedAt: null, expiresAt: null, issuer: null, path: p, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), meta: null, runId: null },
    createdAt,
  );
  return id;
}
function receipt(pid: string, createdAt: string, extra: { phone?: boolean; ocr?: unknown } = {}): string {
  const id = doc(pid, 'paper_receipt', createdAt);
  new ReceiptRepo(db).add(extra.phone
    ? { docId: id, source: 'phone_capture', phoneMsgId: `01J${randomBytes(12).toString('hex').toUpperCase().replace(/[ILOU]/g, 'A').slice(0, 23)}`, phoneOcr: { candidates: { amount: 15_000 } } }
    : { docId: id, source: 'pc_file', ocr: extra.ocr });
  return id;
}

before(async () => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-pc-entry-'));
  const key = new Uint8Array(randomBytes(32));
  db = openDatabase(path.join(dir, 'db.sqlite'), key);
  svc = new BundleService(db, new ColumnCipher(deriveColumnKey(key)), { exportDir: path.join(dir, 'exports'), now: () => new Date('2026-11-09T01:00:00.000Z') });
  const profiles = new ProfileRepo(db);
  const base = { corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null };
  profileId = profiles.upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(41), ...base }).id;
  otherProfile = profiles.upsert({ kind: 'personal', displayName: '개인', bizNo: null, ...base }).id;
  await call('bundle.ensureItems', { profileId, industries: ['cash_business'] });
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('현금매출 PC 입력', () => {
  it('하루 한 숫자: 넣기·바꾸기(이전 값 알림, 폰 값이어도)·지우기, 달 보기는 합계까지', async () => {
    assert.deepEqual(await call('cash.put', { profileId, day: '2026-10-03', amount: 120_000 }), { day: '2026-10-03', amount: 120_000, replaced: null });
    assert.deepEqual(await call('cash.put', { profileId, day: '2026-10-03', amount: 130_000 }), { day: '2026-10-03', amount: 130_000, replaced: { amount: 120_000, source: 'pc' } });
    await call('cash.put', { profileId, day: '2026-10-31', amount: 0 });
    await call('cash.put', { profileId, day: '2026-11-01', amount: 50_000 });
    const oct = await call<CashMonthView>('db.query.cash.month', { profileId, month: '2026-10' });
    assert.deepEqual(oct.days.map((d) => [d.day, d.amount, d.source]), [['2026-10-03', 130_000, 'pc'], ['2026-10-31', 0, 'pc']]);
    assert.equal(oct.total, 130_000);
    assert.deepEqual(await call('cash.remove', { profileId, day: '2026-10-31' }), { removed: true });
    assert.deepEqual(await call('cash.remove', { profileId, day: '2026-10-31' }), { removed: false });
    // 꾸러미 상태는 넣은 날 수를 센다
    const st = await call<ItemStatus[]>('db.query.bundle.status', { profileId, month: '2026-10' });
    const cash = st.find((s) => s.item.kind === 'cash_sales')!;
    assert.deepEqual([cash.status, cash.basis, cash.counts.days], ['partial', 'derived', 1]);
  });

  it('인자 오류와 프로필 경계(다른 프로필 값은 보이지 않음)', async () => {
    await code('cash.put', { profileId, day: '2026-02-30', amount: 1 }, 'bad_day');
    await code('cash.put', { profileId, day: '2026-10-04', amount: -1 }, 'bad_amount');
    await code('cash.put', { profileId, day: '2026-10-04', amount: 1.5 }, 'bad_amount');
    await code('cash.put', { profileId, day: '2026-10-04', amount: 1_000_000_000_000 }, 'bad_amount');
    await code('cash.put', { profileId, day: '2026-10-04', amount: '1000' }, 'bad_amount');
    await code('cash.remove', { profileId, day: 'yesterday' }, 'bad_day');
    await code('db.query.cash.month', { profileId, month: '2026-13' }, 'bad_month');
    await code('cash.put', { profileId: 'nope', day: '2026-10-04', amount: 1 }, 'profile_not_found');
    await call('cash.put', { profileId: otherProfile, day: '2026-10-05', amount: 9 });
    assert.ok(!(await call<CashMonthView>('db.query.cash.month', { profileId, month: '2026-10' })).days.some((d) => d.day === '2026-10-05'));
  });
});

describe('종이 증빙 확인', () => {
  it('그달 목록은 확인 전 것이 먼저, 폰 메시지 id는 빼고 읽어 낸 후보는 그대로. 확인한 값만 빠진 것 대조에 쓴다', async () => {
    const pcDoc = receipt(profileId, '2026-10-10T03:00:00.000Z', { ocr: { amount: { value: 15_000 } } });
    const phoneDoc = receipt(profileId, '2026-10-12T03:00:00.000Z', { phone: true });
    receipt(otherProfile, '2026-10-12T03:00:00.000Z');
    const list = await call<{ receipts: ReceiptView[]; unconfirmed: number }>('db.query.receipt.list', { profileId, month: '2026-10' });
    assert.deepEqual(list.receipts.map((r) => r.docId).sort(), [pcDoc, phoneDoc].sort());
    assert.equal(list.unconfirmed, 2);
    assert.ok(list.receipts.every((r) => !('phoneMsgId' in r)));
    assert.deepEqual(list.receipts.find((r) => r.docId === pcDoc)!.ocr, { amount: { value: 15_000 } });

    // 카드 한 건(15,000원) — 확인 전 증빙은 대조에 쓰지 않는다
    const runId = randomUUID();
    new RunRepo(db).create({ id: runId, playbookId: 'H-12', playbookVersion: '1', packageDigest: 'd', profileId, trigger: 'local', inputsHash: 'i' });
    new CardRepo(db).replaceRange({ runId, profileId, rangeFrom: '2026-10-01', rangeTo: '2026-10-31', completedAt: '2026-11-01T00:00:00.000Z' }, [
      { usedOn: '2026-10-10', merchant: '문구점', merchantBizNo: '1234567890', cardLast4: '1111', approvalNo: 'A1', amount: 15_000, supplyAmount: null, vatAmount: null, canceled: false },
    ]);
    const missing = async () => (await call<{ sections: Array<{ key: string; count: number }> }>('db.query.bundle.missing', { profileId, month: '2026-10' })).sections.find((s) => s.key === 'card_without_evidence')?.count ?? 0;
    assert.equal(await missing(), 1);

    const c = await call<ReceiptView>('receipt.confirm', { profileId, docId: pcDoc, issuedOn: '2026-10-10', amount: 15_000, merchant: ' 문구점 ', merchantBizNo: '123-45-67890' });
    assert.deepEqual([c.issuedOn, c.amount, c.merchant, c.merchantBizNo, c.confirmedAt], ['2026-10-10', 15_000, '문구점', '1234567890', '2026-11-09T01:00:00.000Z']);
    assert.equal(await missing(), 0, '확인한 증빙과 대조된다');
    // 다시 불러 고칠 수 있다(빈 사업자번호·가게 이름은 null)
    const again = await call<ReceiptView>('receipt.confirm', { profileId, docId: pcDoc, issuedOn: '2026-10-10', amount: 15_000, merchant: '', merchantBizNo: '' });
    assert.deepEqual([again.merchant, again.merchantBizNo], [null, null]);
    assert.equal((await call<{ unconfirmed: number }>('db.query.receipt.list', { profileId, month: '2026-10' })).unconfirmed, 1);
  });

  it('인자 오류와 프로필 경계', async () => {
    const mine = receipt(profileId, '2026-10-20T03:00:00.000Z');
    const theirs = receipt(otherProfile, '2026-10-20T03:00:00.000Z');
    const ok = { profileId, docId: mine, issuedOn: '2026-10-20', amount: 1_000 };
    await code('receipt.confirm', { ...ok, docId: theirs }, 'receipt_not_found');
    await code('receipt.confirm', { ...ok, docId: doc(profileId, 'business_registration', '2026-10-20T03:00:00.000Z') }, 'receipt_not_found');
    await code('receipt.confirm', { ...ok, docId: 'nope' }, 'receipt_not_found');
    await code('receipt.confirm', { ...ok, issuedOn: '2026-10-32' }, 'bad_issued_on');
    await code('receipt.confirm', { ...ok, amount: -5 }, 'bad_amount');
    await code('receipt.confirm', { ...ok, merchant: 'x'.repeat(101) }, 'bad_merchant');
    await code('receipt.confirm', { ...ok, merchantBizNo: '12345' }, 'bad_merchant_biz_no');
    await code('db.query.receipt.list', { profileId: 'nope', month: '2026-10' }, 'profile_not_found');
    assert.equal(new ReceiptRepo(db).get(mine)!.confirmedAt, null, '실패한 확인은 남지 않는다');
  });
});

describe('항목 상태 표시(해당 없음·파일 칸)', () => {
  const item = (kind: string) => new BundleRepo(db).items(profileId).find((i) => i.kind === kind)!;
  const status = async (kind: string, m = '2026-10') => (await call<ItemStatus[]>('db.query.bundle.status', { profileId, month: m })).find((s) => s.item.kind === kind)!;

  it('해당 없음 → 상태가 바뀌고, null로 지우면 앱이 센 상태로 돌아간다. 기간은 항목 주기로 엔진이 정한다', async () => {
    const cash = item('cash_sales');
    const r = await call<{ period: string; entry: BundleEntry }>('bundle.setEntry', { profileId, itemId: cash.id, month: '2026-10', status: 'not_applicable', note: ' 이달 휴업 ' });
    assert.deepEqual([r.period, r.entry.status, r.entry.note], ['2026-10', 'not_applicable', '이달 휴업']);
    assert.deepEqual([(await status('cash_sales')).status, (await status('cash_sales')).basis], ['not_applicable', 'entry']);
    assert.deepEqual(await call('bundle.setEntry', { profileId, itemId: cash.id, month: '2026-10', status: null }), { period: '2026-10', entry: null });
    assert.deepEqual([(await status('cash_sales')).status, (await status('cash_sales')).basis], ['partial', 'derived']);
    // 3층 분기 항목은 분기 기간으로
    const q = (await call<{ id: string }>('bundle.addItem', { profileId, name: '차량 운행일지', cadence: 'quarterly' })).id;
    assert.equal((await call<{ period: string }>('bundle.setEntry', { profileId, itemId: q, month: '2026-11', status: 'ready' })).period, '2026-Q4');
  });

  it('파일 칸: 그 프로필 문서만 붙인다. 급여 기능을 끈 업체의 급여대장은 파일 칸이다', async () => {
    const pay = item('payroll');
    const file = doc(profileId, 'other', '2026-10-25T03:00:00.000Z');
    // 직원이 없으면 급여 기능 꺼짐 → 파일 칸
    const r = await call<{ entry: BundleEntry }>('bundle.setEntry', { profileId, itemId: pay.id, month: '2026-10', status: 'ready', docIds: [file, file] });
    assert.deepEqual([r.entry.status, r.entry.docIds], ['ready', [file]]);
    assert.deepEqual([(await status('payroll')).status, (await status('payroll')).docIds], ['ready', [file]]);
    await code('bundle.setEntry', { profileId, itemId: pay.id, month: '2026-10', status: 'ready', docIds: [doc(otherProfile, 'other', '2026-10-25T03:00:00.000Z')] }, 'doc_not_found');
    await code('bundle.setEntry', { profileId, itemId: pay.id, month: '2026-10', status: 'ready', docIds: 'x' }, 'bad_doc_ids');
  });

  it('앱이 세는 항목(카드, 급여를 쓰는 업체의 급여대장)은 해당 없음만. 인자 오류·다른 프로필 항목', async () => {
    const card = item('card');
    await code('bundle.setEntry', { profileId, itemId: card.id, month: '2026-10', status: 'ready' }, 'entry_derived');
    assert.equal((await call<{ entry: BundleEntry }>('bundle.setEntry', { profileId, itemId: card.id, month: '2026-10', status: 'not_applicable' })).entry.status, 'not_applicable');
    await call('payroll.setEnabled', { profileId, on: true });
    await code('bundle.setEntry', { profileId, itemId: item('payroll').id, month: '2026-11', status: 'ready' }, 'entry_derived');
    await code('bundle.setEntry', { profileId, itemId: card.id, month: '2026-10', status: 'done' }, 'bad_status');
    await code('bundle.setEntry', { profileId, itemId: card.id, month: '2026-10', status: 'not_applicable', note: 'x'.repeat(501) }, 'bad_note');
    await code('bundle.setEntry', { profileId, itemId: card.id, month: '10월', status: 'not_applicable' }, 'bad_month');
    await call('bundle.ensureItems', { profileId: otherProfile, industries: [] });
    const theirs = new BundleRepo(db).items(otherProfile)[0]!;
    await code('bundle.setEntry', { profileId, itemId: theirs.id, month: '2026-10', status: 'not_applicable' }, 'item_not_found');
  });

  it('조회는 DB에 쓰지 않는다', async () => {
    const before = changes();
    await call('db.query.cash.month', { profileId, month: '2026-10' });
    await call('db.query.receipt.list', { profileId, month: '2026-10' });
    assert.equal(changes(), before);
  });
});

describe('배선(추가만)', () => {
  it('main 전용(렌더러 목록 밖), 폰 명령과 이름이 겹치지 않고, entry가 BundleService로 보낸다', () => {
    assert.deepEqual([...BUNDLE_PC_READ_QUERIES], ['db.query.cash.month', 'db.query.receipt.list']);
    assert.deepEqual([...BUNDLE_PC_COMMANDS], ['cash.put', 'cash.remove', 'receipt.confirm', 'bundle.setEntry']);
    const others = new Set<string>([...READ_QUERIES, ...COMMANDS, ...MAIN_ONLY, ...PAYROLL_MAIN_ONLY, ...PHONE_COMMANDS]);
    for (const m of [...BUNDLE_PC_READ_QUERIES, ...BUNDLE_PC_COMMANDS]) assert.ok(!others.has(m), m);
    assert.match(entry, /for \(const m of \[\.\.\.BUNDLE_PC_READ_QUERIES, \.\.\.BUNDLE_PC_COMMANDS\]\) \{\n\s+PAYROLL\.add\(m\);\n\s+ALLOWED\.add\(m\);\n\}/);
  });

  it('모델·네트워크·로그를 쓰지 않고, 파일을 열지 않는다', () => {
    assert.doesNotMatch(src, /@sax\/model|@sax\/net|\bfetch\(|console\.|\blog\.|node:fs|readFile/);
  });
});
