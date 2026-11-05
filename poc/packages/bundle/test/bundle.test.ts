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
  addCustomItem, clearCardSlipEnough, ensureItems, exportBundle, exportPayrollRecord, generatePassword, markCardSlipEnough, missingReport, monthStatus, netOfCancellations,
  periodFor, RRN_HIDDEN_NOTE, tidyInvoices, unmatchedCardTxns, ZIP_OPEN_GUIDE, type MonthContext, type TaxInvoiceRow,
} from '@sax/bundle';

configure({ useWebWorkers: false });

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
/** 암호 엑셀을 풀어 시트 XML을 읽는다 */
async function readBook(xlsx: Buffer, pw: string): Promise<{ all: string; read: (n: string) => Promise<string> }> {
  const parts = await new ZipReader(new Uint8ArrayReader(new Uint8Array(await officeCrypto.decrypt(xlsx, { password: pw })))).getEntries();
  const all = (await Promise.all(parts.filter((p) => p.filename.endsWith('.xml')).map((p) => p.getData!(new TextWriter())))).join('\n');
  return { all, read: async (n: string) => parts.find((p) => p.filename === n)!.getData!(new TextWriter()) };
}

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

  it('내보내기: ECMA-376 암호 엑셀 + 같은 암호의 AES-256 첨부 ZIP 두 파일, 평문 표지 없음, 한 기록에 두 해시, 안내 문구', async () => {
    const pw = generatePassword();
    assert.equal(pw.length, 12);
    assert.match(pw, /^[A-HJ-NP-Za-km-z2-9]+$/);
    const outDir = path.join(dir, 'exports');
    const r = await exportBundle({ ...ctx(), outDir, password: pw, now: () => new Date('2026-11-05T01:00:00Z') });
    assert.deepEqual(r.sheets, ['표지', '매출', '매입', '사업용 카드', '종이 증빙', '정산·현금매출', '급여대장', '원천세 요약', '추가 항목', '빠진 것']);
    assert.equal(r.attachments, 1);
    assert.equal(path.basename(r.file), '세무사꾸러미_2026-10.xlsx');
    assert.equal(path.basename(r.zipFile!), '세무사꾸러미_2026-10_첨부.zip');
    assert.deepEqual(r.guide, [ZIP_OPEN_GUIDE, RRN_HIDDEN_NOTE]);
    assert.equal(r.rrnIncluded, false);
    const xbytes = fs.readFileSync(r.file);
    const zbytes = fs.readFileSync(r.zipFile!);
    const rec = new BundleExportRepo(db).list(profileId, '2026-10')[0]!;
    assert.deepEqual([rec.path, rec.sha256, rec.zipPath, rec.zipSha256, rec.rrnIncluded], [r.file, sha(xbytes), r.zipFile, sha(zbytes), false]);
    for (const bytes of [xbytes, zbytes]) for (const needle of [MARKER, '김직원', '1234567', 'receipt-jpeg-bytes']) assert.ok(!bytes.includes(Buffer.from(needle)), `평문 없음: ${needle}`);
    if (process.platform !== 'win32') for (const f of [r.file, r.zipFile!]) assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(outDir).filter((n) => n.endsWith('.part')), [], '임시 파일 없음');

    await assert.rejects(async () => {
      const z = new ZipReader(new Uint8ArrayReader(new Uint8Array(zbytes)));
      const [first] = await z.getEntries();
      await first!.getData!(new Uint8ArrayWriter());
    }, '암호 없이는 열리지 않는다');
    const entries = await new ZipReader(new Uint8ArrayReader(new Uint8Array(zbytes)), { password: pw }).getEntries();
    assert.equal(entries.length, 1, 'ZIP에는 첨부만');
    assert.match(entries[0]!.filename, /^attachments\/paper_receipt_\d{8}_[0-9a-f]{8}\.jpg$/);
    assert.equal(Buffer.from(await entries[0]!.getData!(new Uint8ArrayWriter())).toString(), 'receipt-jpeg-bytes');
    assert.ok(officeCrypto.isEncrypted(xbytes), '엑셀은 열기 암호');
    await assert.rejects(officeCrypto.decrypt(xbytes, { password: 'wrong-password' }));
    const { all, read } = await readBook(xbytes, pw);
    assert.match(await read('xl/workbook.xml'), /name="빠진 것"/);
    for (const want of [MARKER, '대조 없음', '이직원: 이달 급여 줄 없음', RRN_HIDDEN_NOTE]) assert.ok(all.includes(want), `엑셀 안: ${want}`);
    assert.ok(!/<f>/.test(all), '수식 칸 없음');
  });

  it('보관함 파일이 바뀐 첨부는 넣지 않고 빠진 것에 적는다. 같은 이름이면 엑셀·ZIP 모두 _2', async () => {
    const d = addDoc('settlement_file', '.xlsx', Buffer.from('settle'));
    const item = new BundleRepo(db).items(profileId).find((i) => i.kind === 'cash_sales')!;
    new BundleRepo(db).setEntry({ itemId: item.id, period: '2026-10', status: 'partial', docIds: [d] });
    fs.writeFileSync(new DocumentRepo(db).get(d)!.path, 'tampered');
    const pw = generatePassword();
    const r = await exportBundle({ ...ctx(), outDir: path.join(dir, 'exports'), password: pw });
    assert.equal(r.skippedChanged, 1);
    assert.equal(path.basename(r.file), '세무사꾸러미_2026-10_2.xlsx');
    assert.equal(path.basename(r.zipFile!), '세무사꾸러미_2026-10_2_첨부.zip');
    const { all } = await readBook(fs.readFileSync(r.file), pw);
    assert.ok(all.includes('첨부 확인 필요'));
    await assert.rejects(exportBundle({ ...ctx(), outDir: path.join(dir, 'exports'), password: 'short' }), /password_too_short/);
  });

  it('"카드 전표로 충분": 체크한 다음 달부터 카드 대조를 빠진 것에서 뺀다(판정 아님), 끄면 돌아온다', () => {
    assert.equal(markCardSlipEnough(db, profileId, '2026-10'), '2026-11');
    assert.equal(missingReport(ctx()).cardSlipEnough, false, '체크한 달은 그대로');
    assert.equal(markCardSlipEnough(db, profileId, '2026-09'), '2026-10');
    const m = missingReport(ctx());
    assert.equal(m.cardSlipEnough, true);
    assert.deepEqual(m.cardWithoutEvidence, []);
    clearCardSlipEnough(db, profileId);
    assert.deepEqual(missingReport(ctx()).cardWithoutEvidence.map((c) => c.amount), [15_000]);
    assert.throws(() => markCardSlipEnough(db, profileId, '2026-13'), /invalid_month/);
  });

  it('주민번호: 꾸러미는 기본 가림(뒷자리)·켜면 전체, 기록에 포함 여부. 급여 기록 내보내기는 기본 열 없음', async () => {
    const pw = generatePassword();
    await assert.rejects(exportPayrollRecord({ db, cipher, profileId, outDir: path.join(dir, 'exports'), password: pw }), /no_confirmed_payroll/);
    new PayrollRepo(db).confirm(profileId, '2026-10', 1);
    const r = await exportPayrollRecord({ db, cipher, profileId, outDir: path.join(dir, 'exports'), password: pw });
    assert.deepEqual(r.months, ['2026-10']);
    assert.equal(r.record.period, 'payroll:2026-10..2026-10');
    assert.equal(r.record.rrnIncluded, false);
    const buf = fs.readFileSync(r.file);
    assert.ok(officeCrypto.isEncrypted(buf));
    const rec = await readBook(buf, pw);
    assert.ok(rec.all.includes('김직원') && !rec.all.includes('900101-1') && !rec.all.includes('주민등록번호'), '급여 기록은 주민번호 열 없이');

    const masked = await exportBundle({ ...ctx(), outDir: path.join(dir, 'exports'), password: pw });
    const mb = await readBook(fs.readFileSync(masked.file), pw);
    assert.ok(mb.all.includes('900101-1******') && !mb.all.includes('900101-1234567'), '기본은 뒷자리 가림');
    assert.ok(mb.all.includes(RRN_HIDDEN_NOTE));
    assert.ok(mb.all.includes('>41630<'), '소득세는 숫자 칸');
    assert.equal(masked.record.rrnIncluded, false);

    // 설정 bundle.includeRrn을 켜면(앱은 includeRrn을 넘기지 않는다) 전체
    new BundleRepo(db).setIncludeRrn(profileId, true);
    const full = await exportBundle({ ...ctx(), outDir: path.join(dir, 'exports'), password: pw });
    new BundleRepo(db).setIncludeRrn(profileId, false);
    const fb = await readBook(fs.readFileSync(full.file), pw);
    assert.ok(fb.all.includes('900101-1234567') && !fb.all.includes(RRN_HIDDEN_NOTE), '켜면 전체, 암호 안에만');
    assert.ok(!fs.readFileSync(full.file).includes(Buffer.from('900101')), '파일 바이트에는 평문 없음');
    assert.equal(full.record.rrnIncluded, true);
    assert.deepEqual(full.guide, [ZIP_OPEN_GUIDE]);
    assert.equal(monthStatus(ctx()).find((s) => s.item.kind === 'payroll')!.status, 'ready');
    // 급여 기록 내보내기는 설정을 켜도 주민번호 없음
    new BundleRepo(db).setIncludeRrn(profileId, true);
    const again = await exportPayrollRecord({ db, cipher, profileId, outDir: path.join(dir, 'exports'), password: pw });
    assert.ok(!(await readBook(fs.readFileSync(again.file), pw)).all.includes('900101-1'));
    assert.equal(again.record.rrnIncluded, false);
    new BundleRepo(db).setIncludeRrn(profileId, false);
  });

  it('R15 범위 표지·중복 제거·합계 차이 메모: 묻지 않고 자동, 막지 않는다', async () => {
    const cp = syntheticBizNo(7);
    const inv = (approvalNo: string, supplyAmount: number, vatAmount: number, total: number, direction: 'sales' | 'purchase' = 'sales'): TaxInvoiceRow => ({
      direction, issueDate: '2026-10-05', approvalNo, counterpartyBizNo: cp, counterpartyName: '거래처갑', supplyAmount, vatAmount, total,
    });
    const taxInvoices = [
      inv('20261005-41000000-00000001', 80_000, 8_000, 88_000),
      inv('20261005-41000000-00000001', 80_000, 8_000, 88_000), // H-02를 다시 돌려 같은 행
      inv('202610054100000000000001', 80_000, 8_000, 88_000), // 하이픈만 다른 같은 번호
      inv('20261005-41000000-00000002', 80_000, 8_000, 88_001), // 합계 1원 차이(R15 예시)
      inv('20261005-41000000-00000001', 50_000, 5_000, 55_000, 'purchase'), // 방향이 다르면 다른 행
    ];
    const t = tidyInvoices(taxInvoices);
    assert.equal(t.dropped, 2);
    assert.deepEqual(t.lines.map((l) => [l.row.direction, l.sumGap]), [['sales', 0], ['sales', -1], ['purchase', 0]]);
    const m = missingReport(ctx({ taxInvoices }));
    assert.deepEqual(m.invoiceSumGaps, [{ direction: 'sales', issueDate: '2026-10-05', approvalNo: '20261005-41000000-00000002', counterpartyName: '거래처갑', gap: -1 }]);

    const pw = generatePassword();
    const r = await exportBundle({ ...ctx({ taxInvoices }), outDir: path.join(dir, 'exports-r15'), password: pw, now: () => new Date('2026-11-05T01:00:00Z') });
    assert.equal(r.sheets[0], '표지');
    assert.equal(r.duplicateInvoicesDropped, 2);
    const { all, read } = await readBook(fs.readFileSync(r.file), pw);
    const cover = await read('xl/worksheets/sheet1.xml');
    const bizNo = new ProfileRepo(db).get(profileId)!.bizNo!;
    for (const want of ['세무사 꾸러미 범위 표지', `${bizNo.slice(0, 3)}-${bizNo.slice(3, 5)}-${bizNo.slice(5)}`, '2026-10-01 ~ 2026-10-31', '2026-11-05 01:00:00', '같은 승인번호로 뺀 세금계산서', '2건'])
      assert.ok(all.includes(want), `표지: ${want}`);
    // 매출 2행: 공급가액 160,000 / 세액 16,000 / 합계 176,001
    assert.ok(/<c [^>]*><v>2<\/v><\/c><c [^>]*><v>160000<\/v><\/c><c [^>]*><v>16000<\/v><\/c><c [^>]*><v>176001<\/v>/.test(cover), '표지 매출 행 수·합계');
    assert.ok(all.includes('확인 필요: 공급가액+세액이 합계와 1원 다름'), '그 행의 메모 칸');
    const missSheet = await read(`xl/worksheets/sheet${r.sheets.indexOf('빠진 것') + 1}.xml`);
    assert.ok(!missSheet.includes('확인 필요: 공급가액'), "'빠진 것' 시트에는 올리지 않는다");
  });
});
