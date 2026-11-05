// 세무사 꾸러미 엑셀 내보내기(D14 M6-6, ADR-032 결정 8, ADR-034 결정 7, 08 D-05·D-07).
// - 우리 표준 서식: 시트 9종(매출, 매입, 사업용 카드, 종이 증빙, 정산·현금매출(켜진 업종만), 급여대장, 원천세 요약, 추가 항목, 빠진 것).
//   다음 단계의 세무 프로그램 서식 맞춤을 생각해 사업자번호·거래일·공급가액·세액을 따로 둔 열로 둔다(02 §17).
// - 엑셀 파일 자체에 ECMA-376 Agile 암호(AES-256, SHA-512)를 건다(officecrypto-tool). 시트 보호가 아니라 "열기 암호"다.
// - 사진·PDF는 엑셀에 넣을 수 없어(순수 JS 라이브러리로 OLE 개체를 못 넣는다) 같은 암호의 AES-256 ZIP(WinZip AE-2)에
//   암호 걸린 엑셀과 함께 넣는다. 암호 밖에 남는 첨부는 없다. ZIP 안 파일 이름은 D07 §4 규칙({docType}_{yyyyMMdd}_{shortId})이라 개인정보가 없다.
// - 내보내기 기록(bundle_exports)에 결과 파일의 sha256·경로·시각을 남긴다. 암호는 어디에도 저장하지 않는다.
// - 모델을 부르지 않는다. 네트워크를 쓰지 않는다(파일만 쓴다). 보내기(메일 프로그램 열기)는 main이 한다(M6-13).
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import officeCrypto from 'officecrypto-tool';
import writeXlsxFile from 'write-excel-file/node';
import type { Row, Sheet } from 'write-excel-file/node';
import {
  BundleExportRepo, CardRepo, CashSalesRepo, DocumentRepo, EmployeeRepo, PayrollRepo, ReceiptRepo,
  type BundleExport, type ColumnCipher, type Db, type DocumentRow, type PayrollLine,
} from '@sax/db';
import { withholdingSummary } from '@sax/payroll';
import { BundleError, monthRange } from './items.ts';
import { missingReport, monthStatus, type MonthContext, type TaxInvoiceRow } from './month.ts';

configure({ useWebWorkers: false });

const STATUS_KO = { missing: '없음', partial: '일부', ready: '준비됨', not_applicable: '이번 달 해당 없음' } as const;
const CADENCE_KO = { monthly: '매달', quarterly: '분기', once: '한 번' } as const;
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** 사장님에게 보여 주고 문자 등 다른 경로로 전할 암호. 헷갈리는 글자(0·O·1·l·I)는 뺀다 */
export function generatePassword(length = 12): string {
  if (length < 10) throw new BundleError('password_too_short');
  return Array.from({ length }, () => PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)]).join('');
}

function checkPassword(pw: string): void {
  if (typeof pw !== 'string' || [...pw].length < 8) throw new BundleError('password_too_short');
  if ([...pw].length > 255) throw new BundleError('password_too_long');
}

const header = (labels: string[]): Row => labels.map((l) => ({ value: l, fontWeight: 'bold' as const }));
const text = (v: string | null | undefined): string => v ?? '';
/** 정수 금액 칸(천 단위 구분) */
const num = (v: number | null | undefined) => (v === null || v === undefined ? null : { value: v, type: Number, format: '#,##0' });
const fmtBizNo = (b: string | null | undefined) => (b && /^\d{10}$/.test(b) ? `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}` : text(b));
const hours = (m: number | null) => (m === null ? '' : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);

/** ZIP 안 첨부 이름(D07 §4): PII 없이 종류·날짜·짧은 ID */
export function attachmentName(d: Pick<DocumentRow, 'id' | 'docType' | 'issuedAt' | 'createdAt' | 'path'>): string {
  const day = (d.issuedAt ?? d.createdAt).slice(0, 10).replace(/-/g, '');
  const ext = path.extname(d.path).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 6) || '.bin';
  return `attachments/${d.docType}_${day}_${d.id.replace(/-/g, '').slice(0, 8)}${ext}`;
}

export interface BundleExportInput extends MonthContext {
  /** 결과 파일을 둘 폴더(앱이 정한 내보내기 폴더) */
  outDir: string;
  password: string;
  /** 급여대장 시트에 주민번호를 넣는다(원천세 자료로 세무사가 필요할 때). 기본 true, 넣은 직원만 */
  includeRrn?: boolean;
  now?: () => Date;
}

export interface BundleExportResult {
  record: BundleExport;
  /** 결과 파일(첨부가 있으면 .zip, 없으면 .xlsx) */
  file: string;
  sheets: string[];
  attachments: number;
  /** 보관함 파일이 DB의 sha256과 달라 넣지 않은 문서 수(빠진 것 시트에도 적는다) */
  skippedChanged: number;
}

interface Attach {
  doc: DocumentRow;
  name: string;
}

function collectAttachments(db: Db, docIds: Iterable<string>): { list: Attach[]; changed: DocumentRow[] } {
  const docs = new DocumentRepo(db);
  const list: Attach[] = [];
  const changed: DocumentRow[] = [];
  for (const id of new Set(docIds)) {
    const d = docs.get(id);
    if (!d) continue;
    let ok: boolean;
    try {
      ok = createHash('sha256').update(fs.readFileSync(d.path)).digest('hex') === d.sha256;
    } catch {
      ok = false;
    }
    if (ok) list.push({ doc: d, name: attachmentName(d) });
    else changed.push(d);
  }
  return { list, changed };
}

function payrollRows(db: Db, cipher: ColumnCipher, profileId: string, month: string, includeRrn: boolean): { rows: Row[]; lines: PayrollLine[]; revision: number | null } {
  const pr = new PayrollRepo(db);
  const m = pr.latestConfirmed(profileId, month);
  const emps = new EmployeeRepo(db, cipher);
  const rows: Row[] = [
    header(['성명', '생년월일', ...(includeRrn ? ['주민등록번호'] : []), '입사일', '근로일수', '근로시간', '지급 항목', '지급총액', '비과세', '소득세', '지방소득세', '국민연금', '건강보험', '장기요양', '고용보험', '보험 기준', '공제계', '실지급액']),
  ];
  if (!m) return { rows, lines: [], revision: null };
  const lines = pr.lines(profileId, month, m.revision);
  for (const l of lines) {
    const e = emps.get(l.employeeId);
    const pick = (notice: number | null, est: number) => notice ?? est;
    const ded = [pick(l.pensionNotice, l.pensionEst), pick(l.healthNotice, l.healthEst), pick(l.ltcNotice, l.ltcEst), pick(l.employmentNotice, l.employmentEst)];
    const basis = [l.pensionNotice, l.healthNotice, l.ltcNotice, l.employmentNotice].every((x) => x !== null) ? '고지액' : '예상치 포함';
    rows.push([
      text(e?.name), text(e?.birthDate), ...(includeRrn ? [e ? text(emps.revealRrn(e.id)?.replace(/^(\d{6})/, '$1-')) : ''] : []), text(e?.hiredOn),
      num(l.workDays), hours(l.workMinutes), l.items.map((i) => `${i.name} ${i.amount.toLocaleString('ko-KR')}`).join(', '),
      num(l.gross), num(l.nontax), num(l.incomeTax), num(l.localIncomeTax), ...ded.map(num), basis,
      num(l.incomeTax + l.localIncomeTax + ded.reduce((a, b) => a + b, 0)), num(l.netPay),
    ]);
  }
  return { rows, lines, revision: m.revision };
}

/** 이달 세무사 꾸러미 파일을 만든다 */
export async function exportBundle(input: BundleExportInput): Promise<BundleExportResult> {
  checkPassword(input.password);
  const { db, cipher, profileId, month } = input;
  const { from, to } = monthRange(month);
  const now = input.now ?? (() => new Date());
  const status = monthStatus(input);
  const missing = missingReport(input);
  const invoices: readonly TaxInvoiceRow[] = input.taxInvoices ?? [];
  const docIds: string[] = status.flatMap((s) => s.docIds);
  const sheets: Sheet<Buffer>[] = [];

  const invoiceSheet = (dir: 'sales' | 'purchase'): Row[] => [
    header(['작성일자', '승인번호', '거래처 사업자번호', '거래처 상호', '공급가액', '세액', '합계']),
    ...invoices.filter((i) => i.direction === dir).map((i) => [i.issueDate, i.approvalNo, fmtBizNo(i.counterpartyBizNo), i.counterpartyName, num(i.supplyAmount), num(i.vatAmount), num(i.total)]),
  ];
  sheets.push({ sheet: '매출', data: invoiceSheet('sales') });
  sheets.push({ sheet: '매입', data: invoiceSheet('purchase') });

  const cards = new CardRepo(db);
  const memoByTxn = new Map(cards.memos(profileId).filter((m) => m.txnId).map((m) => [m.txnId!, m.memo]));
  const unmatched = new Set(missing.cardWithoutEvidence.map((c) => c.txnId));
  sheets.push({
    sheet: '사업용 카드',
    data: [
      header(['사용일', '가맹점', '가맹점 사업자번호', '카드 끝 4자리', '승인번호', '금액', '공급가액', '부가세', '취소', '메모', '증빙 대조']),
      ...cards.txns(profileId, from, to).map((t) => [
        t.usedOn, text(t.merchant), fmtBizNo(t.merchantBizNo), text(t.cardLast4), text(t.approvalNo), num(t.amount), num(t.supplyAmount), num(t.vatAmount),
        t.canceled ? '취소' : '', text(memoByTxn.get(t.id)), t.canceled ? '' : unmatched.has(t.id) ? '대조 없음' : '대조됨',
      ]),
    ],
  });

  const receipts = new ReceiptRepo(db).list(profileId, from, to);
  docIds.push(...receipts.map((r) => r.docId));
  const att = collectAttachments(db, docIds);
  const nameOf = new Map(att.list.map((a) => [a.doc.id, a.name]));
  sheets.push({
    sheet: '종이 증빙',
    data: [
      header(['발행일', '상호', '사업자번호', '금액', '받은 곳', '사장님 확인', '파일']),
      ...receipts.map((r) => [text(r.issuedOn), text(r.merchant), fmtBizNo(r.merchantBizNo), num(r.amount), r.source === 'phone_capture' ? '폰 촬영' : 'PC 파일', r.confirmedAt ? '확인' : '확인 전', text(nameOf.get(r.docId))]),
    ],
  });

  const tier2 = status.filter((s) => s.item.tier === 2);
  if (tier2.length) {
    const rows: Row[] = [header(['구분', '일자·기간', '금액', '상태', '파일'])];
    for (const s of tier2) {
      if (s.item.kind === 'cash_sales') for (const c of new CashSalesRepo(db).range(profileId, from, to)) rows.push(['현금매출', c.day, num(c.amount), c.source === 'phone' ? '폰 입력' : 'PC 입력', '']);
      else rows.push([s.item.name, s.period, null, STATUS_KO[s.status], s.docIds.map((d) => nameOf.get(d) ?? '').filter(Boolean).join(', ')]);
    }
    sheets.push({ sheet: '정산·현금매출', data: rows });
  }

  const pay = input.payrollEnabled ? payrollRows(db, cipher, profileId, month, input.includeRrn ?? true) : { rows: [header(['급여대장 파일'])], lines: [], revision: null };
  if (!input.payrollEnabled) {
    const p = status.find((s) => s.item.kind === 'payroll');
    for (const d of p?.docIds ?? []) pay.rows.push([text(nameOf.get(d))]);
  }
  sheets.push({ sheet: '급여대장', data: pay.rows });

  const sum = withholdingSummary(month, pay.lines);
  sheets.push({
    sheet: '원천세 요약',
    data: [
      header(['귀속 월', '인원', '총지급액', '비과세', '소득세', '지방소득세', '급여대장 개정']),
      [month, num(sum.headcount), num(sum.totalGross), num(sum.totalNontax), num(sum.totalIncomeTax), num(sum.totalLocalIncomeTax), pay.revision === null ? '확인한 급여대장 없음' : `${pay.revision}`],
    ],
  });

  sheets.push({
    sheet: '추가 항목',
    data: [
      header(['항목', '주기', '기간', '상태', '메모', '파일']),
      ...status.filter((s) => s.item.tier === 3).map((s) => [s.item.name, CADENCE_KO[s.item.cadence], s.period, STATUS_KO[s.status], text(s.note), s.docIds.map((d) => nameOf.get(d) ?? '').filter(Boolean).join(', ')]),
    ],
  });

  const miss: Row[] = [header(['구분', '내용'])];
  for (const e of missing.emptyItems) miss.push(['비어 있는 항목', `${e.name}(${STATUS_KO[e.status]})`]);
  if (missing.payroll) {
    miss.push(['확인 안 한 급여', missing.payroll.state === 'none' ? '이달 급여대장 없음' : missing.payroll.state === 'draft' ? '급여대장 초안(확인 전)' : '확인함']);
    for (const e of missing.payroll.employeesWithoutLine) miss.push(['확인 안 한 급여', `${e.name}: 이달 급여 줄 없음`]);
  }
  for (const c of missing.cardWithoutEvidence) miss.push(['증빙 대조 없는 카드 사용', `${c.usedOn} ${text(c.merchant)} ${c.amount.toLocaleString('ko-KR')}원${c.hasMemo ? ' (메모 있음)' : ''}`]);
  if (missing.memosNeedCheck) miss.push(['카드 메모', `메모 대상 확인 필요 ${missing.memosNeedCheck}건`]);
  for (const d of att.changed) miss.push(['첨부 확인 필요', `${attachmentName(d).slice('attachments/'.length)}: 보관함 파일이 바뀌었거나 없어 넣지 않음`]);
  sheets.push({ sheet: '빠진 것', data: miss });

  const plain = await writeXlsxFile(sheets, { fontFamily: 'Malgun Gothic', fontSize: 10 }).toBuffer();
  const xlsx = officeCrypto.encrypt(plain, { password: input.password });
  plain.fill(0);

  const base = `세무사꾸러미_${month}`;
  let out: Buffer;
  let file: string;
  if (att.list.length) {
    const zip = new ZipWriter(new Uint8ArrayWriter(), { password: input.password, encryptionStrength: 3, zipCrypto: false, lastModDate: now() });
    await zip.add(`${base}.xlsx`, new Uint8ArrayReader(new Uint8Array(xlsx)));
    for (const a of att.list) await zip.add(a.name, new Uint8ArrayReader(new Uint8Array(fs.readFileSync(a.doc.path))));
    out = Buffer.from(await zip.close());
    file = path.join(input.outDir, `${base}.zip`);
  } else {
    out = xlsx;
    file = path.join(input.outDir, `${base}.xlsx`);
  }
  file = writeExclusive(file, out);
  const record = new BundleExportRepo(db).record({ profileId, period: month, sha256: createHash('sha256').update(out).digest('hex'), path: file }, now().toISOString());
  return { record, file, sheets: sheets.map((s) => s.sheet!), attachments: att.list.length, skippedChanged: att.changed.length };
}

/** 같은 이름이 있으면 _2, _3…을 붙인다. 임시 파일에 쓴 뒤 옮기고 소유자 전용 권한 */
function writeExclusive(file: string, data: Buffer): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const ext = path.extname(file);
  const stem = file.slice(0, -ext.length);
  let target = file;
  for (let i = 2; fs.existsSync(target); i++) target = `${stem}_${i}${ext}`;
  const tmp = `${target}.part`;
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, target);
  return target;
}

export interface PayrollRecordExportInput {
  db: Db;
  cipher: ColumnCipher;
  profileId: string;
  outDir: string;
  password: string;
  /** 포함 범위('YYYY-MM'). 없으면 전부 */
  fromMonth?: string;
  toMonth?: string;
  includeRrn?: boolean;
  now?: () => Date;
}

/**
 * 급여 기록 내보내기(08 D-06): 임금대장 3년 보관을 위해 확인한 급여대장 전부를 같은 방식의 암호 엑셀로.
 * 시트: 직원, 급여대장(달별 확인한 마지막 개정), 원천세 요약(달별). 기록은 bundle_exports에 period "payroll:<시작>..<끝>"으로 남긴다.
 */
export async function exportPayrollRecord(input: PayrollRecordExportInput): Promise<{ record: BundleExport; file: string; months: string[] }> {
  checkPassword(input.password);
  const { db, cipher, profileId } = input;
  const now = input.now ?? (() => new Date());
  const pr = new PayrollRepo(db);
  const months = pr.months(profileId).filter((m) => (!input.fromMonth || m >= input.fromMonth) && (!input.toMonth || m <= input.toMonth) && pr.latestConfirmed(profileId, m));
  if (!months.length) throw new BundleError('no_confirmed_payroll');
  const includeRrn = input.includeRrn ?? false;
  const emps = new EmployeeRepo(db, cipher);
  const empRows: Row[] = [header(['성명', '생년월일', ...(includeRrn ? ['주민등록번호'] : []), '입사일', '퇴사일', '업무', '급여 형태'])];
  for (const e of emps.list(profileId))
    empRows.push([e.name, e.birthDate, ...(includeRrn ? [text(emps.revealRrn(e.id)?.replace(/^(\d{6})/, '$1-'))] : []), e.hiredOn, text(e.leftOn), text(e.job), e.payType === 'monthly' ? '월급' : '시급']);
  const lineRows: Row[] = [];
  const sumRows: Row[] = [header(['귀속 월', '개정', '인원', '총지급액', '비과세', '소득세', '지방소득세'])];
  for (const m of months) {
    const p = payrollRows(db, cipher, profileId, m, includeRrn);
    if (!lineRows.length) lineRows.push([{ value: '귀속 월', fontWeight: 'bold' as const }, ...p.rows[0]!]);
    for (const r of p.rows.slice(1)) lineRows.push([m, ...r]);
    const s = withholdingSummary(m, p.lines);
    sumRows.push([m, `${p.revision}`, num(s.headcount), num(s.totalGross), num(s.totalNontax), num(s.totalIncomeTax), num(s.totalLocalIncomeTax)]);
  }
  const plain = await writeXlsxFile(
    [
      { sheet: '직원', data: empRows },
      { sheet: '급여대장', data: lineRows },
      { sheet: '원천세 요약', data: sumRows },
    ],
    { fontFamily: 'Malgun Gothic', fontSize: 10 },
  ).toBuffer();
  const out = officeCrypto.encrypt(plain, { password: input.password });
  plain.fill(0);
  const range = `${months[0]}..${months[months.length - 1]}`;
  const file = writeExclusive(path.join(input.outDir, `급여기록_${months[0]}_${months[months.length - 1]}.xlsx`), out);
  const record = new BundleExportRepo(db).record({ profileId, period: `payroll:${range}`, sha256: createHash('sha256').update(out).digest('hex'), path: file }, now().toISOString());
  return { record, file, months };
}

