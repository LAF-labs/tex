// 세무사 꾸러미 엑셀 내보내기(D14 M6-6, ADR-032 결정 8, ADR-034 결정 7, 08 D-05·D-07).
// - 우리 표준 서식: 첫 시트 '표지'(범위 표지, R15) + 시트 9종(매출, 매입, 사업용 카드, 종이 증빙, 정산·현금매출(켜진 업종만), 급여대장, 원천세 요약, 추가 항목, 빠진 것).
//   다음 단계의 세무 프로그램 서식 맞춤을 생각해 사업자번호·거래일·공급가액·세액을 따로 둔 열로 둔다(02 §17).
// - 엑셀 파일 자체에 ECMA-376 Agile 암호(AES-256, SHA-512)를 건다(officecrypto-tool). 시트 보호가 아니라 "열기 암호"다.
// - 사진·PDF는 엑셀에 넣을 수 없어(순수 JS 라이브러리로 OLE 개체를 못 넣는다) 같은 암호의 AES-256 ZIP(WinZip AE-2) 하나로 따로 낸다
//   (팀장 결정 2026-11-05: 파일 둘. 엑셀은 엑셀에서 바로 열린다). 암호 밖에 남는 첨부는 없다. ZIP 안 파일 이름은 D07 §4 규칙
//   ({docType}_{yyyyMMdd}_{shortId})이라 개인정보가 없다. ZIP은 운영체제 기본 압축 해제로 못 열 수 있어 ZIP_OPEN_GUIDE를 함께 보여 준다.
// - 급여 시트의 주민번호는 기본 가림(뒷자리 마스킹, R13 D-L3). 사장님이 설정 bundle.includeRrn을 켜면 넣는다. 포함 여부는 내보내기 기록에 남긴다.
//   급여 기록 내보내기(사장님 보관용)에는 늘 넣지 않는다(D07 §2 끝).
// - 범위 표지·중복 제거·합계 차이 메모(R15 P1-2, 팀장 승인)는 내보내기 안에서 자동으로 한다. 사장님에게 묻지 않고 막지 않는다(yulmu 2026-11-05).
// - 내보내기 기록(bundle_exports) 한 행에 엑셀·ZIP의 sha256·경로·시각을 남긴다. 암호는 어디에도 저장하지 않는다.
// - 모델을 부르지 않는다. 네트워크를 쓰지 않는다(파일만 쓴다). 보내기(메일 프로그램 열기)는 main이 한다(M6-13).
import { createHash, randomInt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from '@zip.js/zip.js';
import officeCrypto from 'officecrypto-tool';
import writeXlsxFile from 'write-excel-file/node';
import type { Row, Sheet } from 'write-excel-file/node';
import {
  BundleExportRepo, BundleRepo, CardRepo, CashSalesRepo, DocumentRepo, EmployeeRepo, PayrollRepo, ProfileRepo, ReceiptRepo,
  type BundleExport, type ColumnCipher, type Db, type DocumentRow, type PayrollLine,
} from '@sax/db';
import { withholdingSummary } from '@sax/payroll';
import { BundleError, monthRange } from './items.ts';
import { missingReport, monthStatus, tidyInvoices, type InvoiceLine, type MonthContext } from './month.ts';

configure({ useWebWorkers: false });

/** 받는 쪽(세무사) 안내: 첨부 ZIP을 여는 방법 */
export const ZIP_OPEN_GUIDE = 'ZIP은 반디집·7-Zip 등으로 열어 주세요(Windows 탐색기·macOS 기본 압축 해제는 AES ZIP을 못 엽니다)';
/** 주민번호를 가렸을 때 급여 시트 끝과 안내에 쓰는 문구 */
export const RRN_HIDDEN_NOTE = '주민번호는 설정에서 켜면 포함됩니다';

/** full = 전체, masked = 뒷자리 가림(꾸러미 기본), omit = 열 없음(급여 기록 기본) */
type RrnMode = 'full' | 'masked' | 'omit';

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

/**
 * 수식처럼 보이는 글자 칸 이스케이프(docparse formula_like_text, 팀장 전달 2026-11-05). 가게 이름·메모·거래처 상호처럼 밖에서 들어온 글자가
 * '=', '+', '-', '@', 탭, 줄바꿈(전각 ＝＋－＠ 포함)으로 시작하면 앞에 작은따옴표를 붙여 글자로만 보이게 한다(OWASP CSV injection 권고).
 * write-excel-file은 문자열을 수식으로 쓰지 않지만, 세무사가 엑셀에서 칸을 고치거나 CSV로 다시 저장하면 수식이 될 수 있어서다.
 */
export const escapeFormulaText = (s: string): string => (/^[=+\-@\t\r\n＝＋－＠]/u.test(s) ? `'${s}` : s);

/** 모든 시트의 글자 칸을 이스케이프한다(숫자 칸·서식은 그대로) */
function escapeSheets<T>(sheets: Sheet<T>[]): Sheet<T>[] {
  const cell = (c: unknown): unknown => {
    if (typeof c === 'string') return escapeFormulaText(c);
    if (c && typeof c === 'object' && 'value' in c && typeof (c as { value: unknown }).value === 'string' && !('type' in c && (c as { type: unknown }).type !== String))
      return { ...(c as object), value: escapeFormulaText((c as { value: string }).value) };
    return c;
  };
  return sheets.map((s) => ({ ...s, data: (s.data as unknown[][]).map((r) => r.map(cell)) as Row[] }) as Sheet<T>);
}
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
  /** 급여대장 시트에 주민번호 전체를 넣는가. 빼면 설정 bundle.includeRrn(기본 false = 뒷자리 가림)을 따른다 */
  includeRrn?: boolean;
  now?: () => Date;
}

export interface BundleExportResult {
  record: BundleExport;
  /** 암호 엑셀 */
  file: string;
  /** 사진·PDF를 담은 같은 암호의 AES-256 ZIP. 첨부가 없으면 null */
  zipFile: string | null;
  /** 사장님·세무사에게 같이 보여 줄 안내(ZIP_OPEN_GUIDE, RRN_HIDDEN_NOTE) */
  guide: string[];
  rrnIncluded: boolean;
  sheets: string[];
  attachments: number;
  /** 보관함 파일이 DB의 sha256과 달라 넣지 않은 문서 수(빠진 것 시트에도 적는다) */
  skippedChanged: number;
  /** 매출·매입에서 같은 승인번호라 뺀 행 수 */
  duplicateInvoicesDropped: number;
}

const gapMemo = (l: InvoiceLine): string =>
  [
    ...(l.sumGap !== 0 ? [`확인 필요: 공급가액+세액이 합계와 ${Math.abs(l.sumGap).toLocaleString('ko-KR')}원 다름`] : []),
    ...(l.differingDuplicates ? [`같은 승인번호의 금액이 다른 행 ${l.differingDuplicates}건은 뺌`] : []),
  ].join(' / ');

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

function payrollRows(db: Db, cipher: ColumnCipher, profileId: string, month: string, rrn: RrnMode): { rows: Row[]; lines: PayrollLine[]; revision: number | null } {
  const pr = new PayrollRepo(db);
  const m = pr.latestConfirmed(profileId, month);
  const emps = new EmployeeRepo(db, cipher);
  const rows: Row[] = [
    header(['성명', '생년월일', ...(rrn === 'omit' ? [] : ['주민등록번호']), '입사일', '근로일수', '근로시간', '지급 항목', '지급총액', '비과세', '소득세', '지방소득세', '국민연금', '건강보험', '장기요양', '고용보험', '보험 기준', '공제계', '실지급액']),
  ];
  if (!m) return { rows, lines: [], revision: null };
  const lines = pr.lines(profileId, month, m.revision);
  for (const l of lines) {
    const e = emps.get(l.employeeId);
    const pick = (notice: number | null, est: number) => notice ?? est;
    const ded = [pick(l.pensionNotice, l.pensionEst), pick(l.healthNotice, l.healthEst), pick(l.ltcNotice, l.ltcEst), pick(l.employmentNotice, l.employmentEst)];
    const basis = [l.pensionNotice, l.healthNotice, l.ltcNotice, l.employmentNotice].every((x) => x !== null) ? '고지액' : '예상치 포함';
    rows.push([
      text(e?.name), text(e?.birthDate), ...(rrn === 'omit' ? [] : [e ? rrnCell(emps, e.id, rrn) : '']), text(e?.hiredOn),
      num(l.workDays), hours(l.workMinutes), l.items.map((i) => `${i.name} ${i.amount.toLocaleString('ko-KR')}`).join(', '),
      num(l.gross), num(l.nontax), num(l.incomeTax), num(l.localIncomeTax), ...ded.map(num), basis,
      num(l.incomeTax + l.localIncomeTax + ded.reduce((a, b) => a + b, 0)), num(l.netPay),
    ]);
  }
  return { rows, lines, revision: m.revision };
}

function rrnCell(emps: EmployeeRepo, id: string, mode: 'full' | 'masked'): string {
  return mode === 'full' ? text(emps.revealRrn(id)?.replace(/^(\d{6})/, '$1-')) : text(emps.maskedRrn(id));
}

/** 이달 세무사 꾸러미 파일을 만든다 */
export async function exportBundle(input: BundleExportInput): Promise<BundleExportResult> {
  checkPassword(input.password);
  const { db, cipher, profileId, month } = input;
  const { from, to } = monthRange(month);
  const now = input.now ?? (() => new Date());
  const status = monthStatus(input);
  const missing = missingReport(input);
  const tidy = tidyInvoices(input.taxInvoices ?? []);
  const docIds: string[] = status.flatMap((s) => s.docIds);
  const sheets: Sheet<Buffer>[] = [];
  /** 표지에 적을 시트별 행 수·합계(R15 P1-2 ①) */
  const tally: Array<{ sheet: string; rows: number; supply?: number; vat?: number; total?: number }> = [];
  const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  for (const [dir, name] of [['sales', '매출'], ['purchase', '매입']] as const) {
    const lines = tidy.lines.filter((l) => l.row.direction === dir);
    sheets.push({
      sheet: name,
      data: [
        header(['작성일자', '승인번호', '거래처 사업자번호', '거래처 상호', '공급가액', '세액', '합계', '메모']),
        ...lines.map((l) => [l.row.issueDate, l.row.approvalNo, fmtBizNo(l.row.counterpartyBizNo), l.row.counterpartyName, num(l.row.supplyAmount), num(l.row.vatAmount), num(l.row.total), gapMemo(l)]),
      ],
    });
    tally.push({ sheet: name, rows: lines.length, supply: sumOf(lines.map((l) => l.row.supplyAmount)), vat: sumOf(lines.map((l) => l.row.vatAmount)), total: sumOf(lines.map((l) => l.row.total)) });
  }

  const cards = new CardRepo(db);
  const memoByTxn = new Map(cards.memos(profileId).filter((m) => m.txnId).map((m) => [m.txnId!, m.memo]));
  const unmatched = new Set(missing.cardWithoutEvidence.map((c) => c.txnId));
  const txns = cards.txns(profileId, from, to);
  tally.push({ sheet: '사업용 카드', rows: txns.length, supply: sumOf(txns.map((t) => t.supplyAmount ?? 0)), vat: sumOf(txns.map((t) => t.vatAmount ?? 0)), total: sumOf(txns.map((t) => t.amount)) });
  sheets.push({
    sheet: '사업용 카드',
    data: [
      header(['사용일', '가맹점', '가맹점 사업자번호', '카드 끝 4자리', '승인번호', '금액', '공급가액', '부가세', '취소', '메모', '증빙 대조']),
      ...txns.map((t) => [
        t.usedOn, text(t.merchant), fmtBizNo(t.merchantBizNo), text(t.cardLast4), text(t.approvalNo), num(t.amount), num(t.supplyAmount), num(t.vatAmount),
        t.canceled ? '취소' : '', text(memoByTxn.get(t.id)), t.canceled ? '' : unmatched.has(t.id) ? '대조 없음' : '대조됨',
      ]),
    ],
  });

  const receipts = new ReceiptRepo(db).list(profileId, from, to);
  docIds.push(...receipts.map((r) => r.docId));
  const att = collectAttachments(db, docIds);
  const nameOf = new Map(att.list.map((a) => [a.doc.id, a.name]));
  tally.push({ sheet: '종이 증빙', rows: receipts.length, total: sumOf(receipts.map((r) => r.amount ?? 0)) });
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
    tally.push({ sheet: '정산·현금매출', rows: rows.length - 1 });
  }

  const rrnIncluded = input.includeRrn ?? new BundleRepo(db).includeRrn(profileId);
  const pay = input.payrollEnabled ? payrollRows(db, cipher, profileId, month, rrnIncluded ? 'full' : 'masked') : { rows: [header(['급여대장 파일'])], lines: [], revision: null };
  if (input.payrollEnabled && !rrnIncluded) pay.rows.push([], [`※ 주민번호 뒷자리는 가렸습니다. ${RRN_HIDDEN_NOTE}`]);
  if (!input.payrollEnabled) {
    const p = status.find((s) => s.item.kind === 'payroll');
    for (const d of p?.docIds ?? []) pay.rows.push([text(nameOf.get(d))]);
  }
  sheets.push({ sheet: '급여대장', data: pay.rows });
  tally.push({ sheet: '급여대장', rows: input.payrollEnabled ? pay.lines.length : pay.rows.length - 1, ...(input.payrollEnabled ? { total: sumOf(pay.lines.map((l) => l.gross)) } : {}) });

  const sum = withholdingSummary(month, pay.lines);
  sheets.push({
    sheet: '원천세 요약',
    data: [
      header(['귀속 월', '인원', '총지급액', '비과세', '소득세', '지방소득세', '급여대장 개정']),
      [month, num(sum.headcount), num(sum.totalGross), num(sum.totalNontax), num(sum.totalIncomeTax), num(sum.totalLocalIncomeTax), pay.revision === null ? '확인한 급여대장 없음' : `${pay.revision}`],
    ],
  });

  const extra = status.filter((s) => s.item.tier === 3);
  tally.push({ sheet: '추가 항목', rows: extra.length });
  sheets.push({
    sheet: '추가 항목',
    data: [
      header(['항목', '주기', '기간', '상태', '메모', '파일']),
      ...extra.map((s) => [s.item.name, CADENCE_KO[s.item.cadence], s.period, STATUS_KO[s.status], text(s.note), s.docIds.map((d) => nameOf.get(d) ?? '').filter(Boolean).join(', ')]),
    ],
  });

  const miss: Row[] = [header(['구분', '내용'])];
  for (const e of missing.emptyItems) miss.push(['비어 있는 항목', `${e.name}(${STATUS_KO[e.status]})`]);
  if (missing.payroll) {
    miss.push(['확인 안 한 급여', missing.payroll.state === 'none' ? '이달 급여대장 없음' : missing.payroll.state === 'draft' ? '급여대장 초안(확인 전)' : '확인함']);
    for (const e of missing.payroll.employeesWithoutLine) miss.push(['확인 안 한 급여', `${e.name}: 이달 급여 줄 없음`]);
  }
  if (missing.cardSlipEnough) miss.push(['증빙 대조 없는 카드 사용', '사장님이 "카드 전표로 충분"으로 표시해 이 달부터 빼고 보여 줍니다']);
  for (const c of missing.cardWithoutEvidence) miss.push(['증빙 대조 없는 카드 사용', `${c.usedOn} ${text(c.merchant)} ${c.amount.toLocaleString('ko-KR')}원${c.hasMemo ? ' (메모 있음)' : ''}`]);
  if (missing.memosNeedCheck) miss.push(['카드 메모', `메모 대상 확인 필요 ${missing.memosNeedCheck}건`]);
  for (const d of att.changed) miss.push(['첨부 확인 필요', `${attachmentName(d).slice('attachments/'.length)}: 보관함 파일이 바뀌었거나 없어 넣지 않음`]);
  sheets.push({ sheet: '빠진 것', data: miss });
  tally.push({ sheet: '빠진 것', rows: miss.length - 1 });

  // 첫 시트: 범위 표지(R15 P1-2 ①). 세무사가 받은 파일만 보고 어느 사업자의 어느 기간인지, 시트마다 몇 행·얼마인지 대조한다
  const prof = new ProfileRepo(db).get(profileId);
  sheets.unshift({
    sheet: '표지',
    data: [
      [{ value: '세무사 꾸러미 범위 표지', fontWeight: 'bold' as const }],
      ['사업자번호', fmtBizNo(prof?.bizNo)],
      ['상호', text(prof?.displayName)],
      ['대상 기간', `${from} ~ ${to}`],
      ['만든 시각(UTC)', now().toISOString().slice(0, 19).replace('T', ' ')],
      ...(tidy.dropped ? [['같은 승인번호로 뺀 세금계산서', `${tidy.dropped}건`]] : []),
      [],
      header(['시트', '행 수', '공급가액 합계', '세액 합계', '합계']),
      ...tally.map((t) => [t.sheet, num(t.rows), num(t.supply), num(t.vat), num(t.total)]),
    ],
  });

  const plain = await writeXlsxFile(escapeSheets(sheets), { fontFamily: 'Malgun Gothic', fontSize: 10 }).toBuffer();
  const xlsx = officeCrypto.encrypt(plain, { password: input.password });
  plain.fill(0);

  const stem = freeStem(input.outDir, `세무사꾸러미_${month}`, ['.xlsx', '_첨부.zip']);
  const file = writeNew(`${stem}.xlsx`, xlsx);
  let zipFile: string | null = null;
  let zipRec: { path: string; sha256: string } | null = null;
  if (att.list.length) {
    const zip = new ZipWriter(new Uint8ArrayWriter(), { password: input.password, encryptionStrength: 3, zipCrypto: false, lastModDate: now() });
    for (const a of att.list) await zip.add(a.name, new Uint8ArrayReader(new Uint8Array(fs.readFileSync(a.doc.path))));
    const zbuf = Buffer.from(await zip.close());
    zipFile = writeNew(`${stem}_첨부.zip`, zbuf);
    zipRec = { path: zipFile, sha256: createHash('sha256').update(zbuf).digest('hex') };
  }
  const record = new BundleExportRepo(db).record(
    { profileId, period: month, sha256: createHash('sha256').update(xlsx).digest('hex'), path: file, zip: zipRec, rrnIncluded },
    now().toISOString(),
  );
  const guide = [...(zipFile ? [ZIP_OPEN_GUIDE] : []), ...(input.payrollEnabled && !rrnIncluded ? [RRN_HIDDEN_NOTE] : [])];
  return {
    record, file, zipFile, guide, rrnIncluded, sheets: sheets.map((s) => s.sheet!), attachments: att.list.length, skippedChanged: att.changed.length, duplicateInvoicesDropped: tidy.dropped,
  };
}

/** 이름 줄기 하나를 고른다: 붙일 끝말(.xlsx, _첨부.zip) 중 어느 것도 없는 첫 줄기(없으면 _2, _3…). 엑셀과 ZIP이 같은 번호를 쓴다 */
function freeStem(dir: string, base: string, suffixes: readonly string[]): string {
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 1; ; i++) {
    const stem = path.join(dir, i === 1 ? base : `${base}_${i}`);
    if (suffixes.every((x) => !fs.existsSync(stem + x) && !fs.existsSync(`${stem}${x}.part`))) return stem;
  }
}

/** 새 파일로만 쓴다(덮어쓰지 않음). 임시 파일에 쓴 뒤 옮기고 소유자 전용 권한 */
function writeNew(file: string, data: Buffer): string {
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, data, { mode: 0o600, flag: 'wx' });
  fs.linkSync(tmp, file);
  fs.rmSync(tmp);
  return file;
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
  now?: () => Date;
}

/**
 * 급여 기록 내보내기(08 D-06). 주민번호는 늘 넣지 않는다(D07 §2 끝, 설정과 무관): 임금대장 3년 보관을 위해 확인한 급여대장 전부를 같은 방식의 암호 엑셀로.
 * 시트: 직원, 급여대장(달별 확인한 마지막 개정), 원천세 요약(달별). 기록은 bundle_exports에 period "payroll:<시작>..<끝>"으로 남긴다.
 */
export async function exportPayrollRecord(input: PayrollRecordExportInput): Promise<{ record: BundleExport; file: string; months: string[] }> {
  checkPassword(input.password);
  const { db, cipher, profileId } = input;
  const now = input.now ?? (() => new Date());
  const pr = new PayrollRepo(db);
  const months = pr.months(profileId).filter((m) => (!input.fromMonth || m >= input.fromMonth) && (!input.toMonth || m <= input.toMonth) && pr.latestConfirmed(profileId, m));
  if (!months.length) throw new BundleError('no_confirmed_payroll');
  const emps = new EmployeeRepo(db, cipher);
  const empRows: Row[] = [header(['성명', '생년월일', '입사일', '퇴사일', '업무', '급여 형태'])];
  for (const e of emps.list(profileId)) empRows.push([e.name, e.birthDate, e.hiredOn, text(e.leftOn), text(e.job), e.payType === 'monthly' ? '월급' : '시급']);
  const lineRows: Row[] = [];
  const sumRows: Row[] = [header(['귀속 월', '개정', '인원', '총지급액', '비과세', '소득세', '지방소득세'])];
  for (const m of months) {
    const p = payrollRows(db, cipher, profileId, m, 'omit');
    if (!lineRows.length) lineRows.push([{ value: '귀속 월', fontWeight: 'bold' as const }, ...p.rows[0]!]);
    for (const r of p.rows.slice(1)) lineRows.push([m, ...r]);
    const s = withholdingSummary(m, p.lines);
    sumRows.push([m, `${p.revision}`, num(s.headcount), num(s.totalGross), num(s.totalNontax), num(s.totalIncomeTax), num(s.totalLocalIncomeTax)]);
  }
  const plain = await writeXlsxFile(
    escapeSheets<Buffer>([
      { sheet: '직원', data: empRows },
      { sheet: '급여대장', data: lineRows },
      { sheet: '원천세 요약', data: sumRows },
    ]),
    { fontFamily: 'Malgun Gothic', fontSize: 10 },
  ).toBuffer();
  const out = officeCrypto.encrypt(plain, { password: input.password });
  plain.fill(0);
  const range = `${months[0]}..${months[months.length - 1]}`;
  const file = writeExclusive(path.join(input.outDir, `급여기록_${months[0]}_${months[months.length - 1]}.xlsx`), out);
  const record = new BundleExportRepo(db).record({ profileId, period: `payroll:${range}`, sha256: createHash('sha256').update(out).digest('hex'), path: file, rrnIncluded: false }, now().toISOString());
  return { record, file, months };
}

