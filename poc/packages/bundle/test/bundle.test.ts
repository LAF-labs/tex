// M6-2 꾸러미 모델, M6-14 빠진 것, M6-6 암호 걸린 엑셀 내보내기.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { configure, TextWriter, Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import officeCrypto from 'officecrypto-tool';
import {
  BundleExportRepo, BundleRepo, CardRepo, CashSalesRepo, ColumnCipher, deriveColumnKey, DocumentRepo, EmployeeRepo, openDatabase, PayrollRepo, ProfileRepo,
  ReceiptRepo, RunRepo, syntheticBizNo, type CardTxnInput, type Db,
} from '@sax/db';
import {
  addCustomItem, ensureItems, exportBundle, exportPayrollRecord, generatePassword, missingReport, monthStatus, netOfCancellations, periodFor, unmatchedCardTxns,
  type MonthContext,
} from '@sax/bundle';

configure({ useWebWorkers: false });

let dir: string;
let db: Db;
let profileId: string;
let cipher: ColumnCipher;
const MARKER = '표지가게' + randomBytes(3).toString('hex');

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-bundle-'));
  const key = new Uint8Array(randomBytes(32));
  db = openDatabase(path.join(dir, 'db.sqlite'), key);
  cipher = new ColumnCipher(deriveColumnKey(key));
  profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(5), corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ctx = (over: Partial<MonthContext> = {}): MonthContext => ({ db, cipher, profileId, month: '2026-10', payrollEnabled: true, ...over });

function addDoc(docType: string, ext: string, content: Buffer, issuedAt: string | null = null): string {
  const id = randomUUID();
  const p = path.join(dir, `${id}${ext}`);
  fs.writeFileSync(p, content);
  new DocumentRepo(db).insert({ id, profileId, docType, displayName: null, issuedAt, expiresAt: null, issuer: null, path: p, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex'), meta: null, runId: null });
  return id;
}

describe('꾸러미 항목(1·2·3층)', () => {
  it('1층 4개는 늘 있고, 고른 업종의 2층만 켜진다. 여러 번 불러도 같다', () => {
    const repo = new BundleRepo(db);
    ensureItems(repo, profileId, ['restaurant', 'cash_business']);
    ensureItems(repo, profileId, ['restaurant', 'cash_business']);
    const items = repo.items(profileId, { enabledOnly: true });
    assert.deepEqual(items.filter((i) => i.tier === 1).map((i) => i.kind), ['tax_invoice', 'payroll', 'card', 'paper_receipt']);
    assert.deepEqual(items.filter((i) => i.tier === 2).map((i) => i.kind).sort(), ['cash_sales', 'settlement_delivery']);
    ensureItems(repo, profileId, ['cash_business']);
    assert.deepEqual(repo.items(profileId, { enabledOnly: true }).filter((i) => i.tier === 2).map((i) => i.kind), ['cash_sales']);
    assert.equal(repo.items(profileId).filter((i) => i.tier === 2).length, 2, '끈 업종 항목은 남는다(지난 기록)');
    assert.throws(() => ensureItems(repo, profileId, ['bakery' as never]), /unknown_industry/);
  });

  it('3층: 이름·주기, 같은 이름 중복 거부, 주기별 기간 키', () => {
    const repo = new BundleRepo(db);
    addCustomItem(repo, profileId, '  차량   운행일지 ', 'quarterly');
    assert.throws(() => addCustomItem(repo, profileId, '차량 운행일지', 'monthly'), /duplicate_item/);
    assert.equal(periodFor('2026-10', 'quarterly'), '2026-Q4');
    assert.equal(periodFor('2026-03', 'quarterly'), '2026-Q1');
    assert.equal(periodFor('2026-10', 'once'), 'once');
  });
});

describe('카드 ↔ 증빙 대조(표시만)', () => {
  const t = (id: string, usedOn: string, amount: number, approvalNo: string | null, canceled = false) =>
    ({ id, profileId: 'p', fetchRunId: 'f', seq: 0, usedOn, merchant: 'm', merchantBizNo: '1234567890', cardLast4: '1111', approvalNo, amount, supplyAmount: null, vatAmount: null, canceled });
  it('승인과 그 취소는 둘 다 빠지고, 금액·3일 안·사업자번호로 한 증빙은 한 건에만 대조된다', () => {
    assert.deepEqual(netOfCancellations([t('a', '2026-10-01', 5000, 'A'), t('b', '2026-10-02', 5000, 'A', true), t('c', '2026-10-03', 7000, 'C')]).map((x) => x.id), ['c']);
    const left = unmatchedCardTxns(
      [t('a', '2026-10-01', 5000, 'A'), t('b', '2026-10-01', 5000, 'B'), t('c', '2026-10-10', 9000, 'C')],
      [{ day: '2026-10-03', amount: 5000, bizNo: null }, { day: '2026-10-20', amount: 9000, bizNo: null }],
    );
    assert.deepEqual(left.map((x) => x.id), ['b', 'c']);
    assert.deepEqual(unmatchedCardTxns([t('a', '2026-10-01', 5000, 'A')], [{ day: '2026-10-01', amount: 5000, bizNo: '9999999999' }]).map((x) => x.id), ['a']);
  });
});

describe('이번 달 상태와 빠진 것', () => {
  let empA: string;
  before(() => {
    const emps = new EmployeeRepo(db, cipher);
    empA = emps.create({ profileId, name: '김직원', birthDate: '1990-01-01', hiredOn: '2025-01-02', basePay: 2_500_000, dependents: 1, rrn: '900101-1234567' }).id;
    emps.create({ profileId, name: '이직원', birthDate: '1995-05-05', hiredOn: '2026-10-15', basePay: 2_200_000, dependents: 1 });
    const pr = new PayrollRepo(db);
    pr.openDraft(profileId, '2026-10', ['t1']);
    pr.putLine(profileId, '2026-10', 1, {
      employeeId: empA, workDays: 22, workMinutes: 10_560, overtimeMinutes: null, nightMinutes: null, holidayMinutes: null,
      items: [{ name: '기본급', amount: 2_500_000, taxable: true, calc: '월급' }], gross: 2_500_000, nontax: 0, incomeTax: 41_630, localIncomeTax: 4_160,
      pensionEst: 118_750, healthEst: 89_870, ltcEst: 11_800, employmentEst: 22_500, pensionNotice: null, healthNotice: null, ltcNotice: null, employmentNotice: null,
      employer: { pensionEst: 118_750, healthEst: 89_870, ltcEst: 11_800, employmentEst: 28_750, industrialAccidentEst: null, pensionNotice: null, healthNotice: null, ltcNotice: null, employmentNotice: null, industrialAccidentNotice: null },
      netPay: 2_211_290,
    });
    const runId = randomUUID();
    new RunRepo(db).create({ id: runId, playbookId: 'H-12', playbookVersion: '1', packageDigest: 'd', profileId, trigger: 'local', inputsHash: 'i' });
    const c = (usedOn: string, amount: number, approvalNo: string, merchant: string, canceled = false): CardTxnInput => ({ usedOn, merchant, merchantBizNo: null, cardLast4: '1111', approvalNo, amount, supplyAmount: null, vatAmount: null, canceled });
    new CardRepo(db).replaceRange({ runId, profileId, rangeFrom: '2026-10-01', rangeTo: '2026-10-20', completedAt: '2026-10-21T00:00:00Z' }, [
      c('2026-10-02', 15_000, 'A1', MARKER), c('2026-10-05', 33_000, 'B2', '식당'), c('2026-10-06', 33_000, 'B2', '식당', true), c('2026-10-09', 48_000, 'C3', '문구'),
    ]);
    const rd = addDoc('paper_receipt', '.jpg', Buffer.from('receipt-jpeg-bytes'));
    new ReceiptRepo(db).add({ docId: rd, source: 'pc_file' });
    new ReceiptRepo(db).confirm(rd, { issuedOn: '2026-10-09', merchant: '문구', merchantBizNo: null, amount: 48_000 });
    new CashSalesRepo(db).put({ profileId, day: '2026-10-03', amount: 120_000, source: 'phone' });
  });

  it('상태: 급여 초안은 일부, 카드는 달 일부만 조회해 일부, 현금매출은 들어온 날이 있어 일부, 해당 없음은 사장님 표시', () => {
    const repo = new BundleRepo(db);
    const st = monthStatus(ctx());
    const by = (k: string) => st.find((s) => s.item.kind === k)!;
    assert.equal(by('payroll').status, 'partial');
    assert.equal(by('card').status, 'partial');
    assert.equal(by('card').counts.txns, 4);
    assert.equal(by('cash_sales').status, 'partial');
    assert.equal(by('paper_receipt').status, 'partial');
    assert.equal(by('tax_invoice').status, 'missing');
    const custom = st.find((s) => s.item.tier === 3)!;
    assert.equal(custom.period, '2026-Q4');
    repo.setEntry({ itemId: by('tax_invoice').item.id, period: '2026-10', status: 'not_applicable' });
    assert.equal(monthStatus(ctx()).find((s) => s.item.kind === 'tax_invoice')!.status, 'not_applicable');
  });

  it('빠진 것: 비어 있는 항목, 확인 안 한 급여(초안·줄 없는 재직자), 대조 없는 카드(취소 쌍·영수증 대조 제외)', () => {
    const m = missingReport(ctx());
    assert.ok(m.emptyItems.some((e) => e.name === '사업용 신용카드 사용내역' && e.status === 'partial'));
    assert.ok(!m.emptyItems.some((e) => e.name === '매출·매입 세금계산서'), '해당 없음은 빠진 것이 아니다');
    assert.deepEqual(m.payroll, { state: 'draft', revision: 1, employeesWithoutLine: [{ id: m.payroll!.employeesWithoutLine[0]!.id, name: '이직원' }] });
    assert.deepEqual(m.cardWithoutEvidence.map((c) => c.amount), [15_000]);
    assert.equal(missingReport(ctx({ payrollEnabled: false })).payroll, null);
  });

  it('내보내기: AES-256 ZIP 안에 ECMA-376 암호 엑셀과 첨부, 평문 표지가 파일에 없다, 기록에 해시', async () => {
    const pw = generatePassword();
    assert.equal(pw.length, 12);
    assert.match(pw, /^[A-HJ-NP-Za-km-z2-9]+$/);
    const outDir = path.join(dir, 'exports');
    const r = await exportBundle({ ...ctx(), outDir, password: pw, now: () => new Date('2026-11-05T01:00:00Z') });
    assert.deepEqual(r.sheets, ['매출', '매입', '사업용 카드', '종이 증빙', '정산·현금매출', '급여대장', '원천세 요약', '추가 항목', '빠진 것']);
    assert.equal(r.attachments, 1);
    assert.match(path.basename(r.file), /^세무사꾸러미_2026-10\.zip$/);
    const bytes = fs.readFileSync(r.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), r.record.sha256);
    assert.equal(new BundleExportRepo(db).list(profileId, '2026-10')[0]!.path, r.file);
    for (const needle of [MARKER, '김직원', '1234567', 'receipt-jpeg-bytes']) assert.ok(!bytes.includes(Buffer.from(needle)), `평문 없음: ${needle}`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(r.file).mode & 0o777, 0o600);

    await assert.rejects(async () => {
      const z = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)));
      const [first] = await z.getEntries();
      await first!.getData!(new Uint8ArrayWriter());
    }, '암호 없이는 열리지 않는다');
    const z = new ZipReader(new Uint8ArrayReader(new Uint8Array(bytes)), { password: pw });
    const entries = await z.getEntries();
    const names = entries.map((e) => e.filename);
    assert.equal(names[0], '세무사꾸러미_2026-10.xlsx');
    assert.match(names[1]!, /^attachments\/paper_receipt_\d{8}_[0-9a-f]{8}\.jpg$/);
    assert.equal(Buffer.from(await entries[1]!.getData!(new Uint8ArrayWriter())).toString(), 'receipt-jpeg-bytes');
    const xlsx = Buffer.from(await entries[0]!.getData!(new Uint8ArrayWriter()));
    assert.ok(officeCrypto.isEncrypted(xlsx), '엑셀 자체도 열기 암호');
    await assert.rejects(officeCrypto.decrypt(xlsx, { password: 'wrong-password' }));
    const plain = await officeCrypto.decrypt(xlsx, { password: pw });
    const book = new ZipReader(new Uint8ArrayReader(new Uint8Array(plain)));
    const parts = await book.getEntries();
    const read = async (n: string) => parts.find((p) => p.filename === n)!.getData!(new TextWriter());
    const all = (await Promise.all(parts.filter((p) => p.filename.endsWith('.xml')).map((p) => p.getData!(new TextWriter())))).join('\n');
    assert.match(await read('xl/workbook.xml'), /name="빠진 것"/);
    for (const want of [MARKER, '대조 없음', '이직원: 이달 급여 줄 없음']) assert.ok(all.includes(want), `엑셀 안: ${want}`);
    assert.ok(!/<f>/.test(all), '수식 칸 없음');
  });

  it('보관함 파일이 바뀐 첨부는 넣지 않고 빠진 것에 적는다. 주민번호는 끄면 넣지 않는다. 같은 이름이면 _2', async () => {
    const d = addDoc('settlement_file', '.xlsx', Buffer.from('settle'));
    const item = new BundleRepo(db).items(profileId).find((i) => i.kind === 'cash_sales')!;
    new BundleRepo(db).setEntry({ itemId: item.id, period: '2026-10', status: 'partial', docIds: [d] });
    fs.writeFileSync(new DocumentRepo(db).get(d)!.path, 'tampered');
    const pw = generatePassword();
    const r = await exportBundle({ ...ctx(), outDir: path.join(dir, 'exports'), password: pw, includeRrn: false });
    assert.equal(r.skippedChanged, 1);
    assert.match(path.basename(r.file), /_2\.zip$/);
    const z = new ZipReader(new Uint8ArrayReader(new Uint8Array(fs.readFileSync(r.file))), { password: pw });
    const xlsx = Buffer.from(await (await z.getEntries())[0]!.getData!(new Uint8ArrayWriter()));
    const parts = await new ZipReader(new Uint8ArrayReader(new Uint8Array(await officeCrypto.decrypt(xlsx, { password: pw })))).getEntries();
    const all = (await Promise.all(parts.filter((p) => p.filename.endsWith('.xml')).map((p) => p.getData!(new TextWriter())))).join('\n');
    assert.ok(all.includes('첨부 확인 필요'));
    assert.ok(!all.includes('900101-1234567') && !all.includes('주민등록번호'));
    await assert.rejects(exportBundle({ ...ctx(), outDir: path.join(dir, 'exports'), password: 'short' }), /password_too_short/);
  });

  it('급여 기록 내보내기: 확인한 달만, 암호 엑셀, 기록 period payroll:…', async () => {
    const pw = generatePassword();
    await assert.rejects(exportPayrollRecord({ db, cipher, profileId, outDir: path.join(dir, 'exports'), password: pw }), /no_confirmed_payroll/);
    new PayrollRepo(db).confirm(profileId, '2026-10', 1);
    const r = await exportPayrollRecord({ db, cipher, profileId, outDir: path.join(dir, 'exports'), password: pw });
    assert.deepEqual(r.months, ['2026-10']);
    assert.equal(r.record.period, 'payroll:2026-10..2026-10');
    const buf = fs.readFileSync(r.file);
    assert.ok(officeCrypto.isEncrypted(buf));
    const parts = await new ZipReader(new Uint8ArrayReader(new Uint8Array(await officeCrypto.decrypt(buf, { password: pw })))).getEntries();
    const all = (await Promise.all(parts.filter((p) => p.filename.endsWith('.xml')).map((p) => p.getData!(new TextWriter())))).join('\n');
    assert.ok(all.includes('김직원') && !all.includes('900101-1234567'), '기본은 주민번호 없이');
    // 확인한 급여대장은 꾸러미 급여대장 시트에 들어가고, 넣은 주민번호는 암호 안에만 있다
    const b = await exportBundle({ ...ctx(), outDir: path.join(dir, 'exports'), password: pw });
    const bz = new ZipReader(new Uint8ArrayReader(new Uint8Array(fs.readFileSync(b.file))), { password: pw });
    const bx = Buffer.from(await (await bz.getEntries())[0]!.getData!(new Uint8ArrayWriter()));
    const bp = await new ZipReader(new Uint8ArrayReader(new Uint8Array(await officeCrypto.decrypt(bx, { password: pw })))).getEntries();
    const ball = (await Promise.all(bp.filter((p) => p.filename.endsWith('.xml')).map((p) => p.getData!(new TextWriter())))).join('\n');
    assert.ok(ball.includes('900101-1234567'), '주민번호');
    assert.ok(ball.includes('>41630<'), '소득세는 숫자 칸');
    assert.equal(monthStatus(ctx()).find((s) => s.item.kind === 'payroll')!.status, 'ready');
  });
});
