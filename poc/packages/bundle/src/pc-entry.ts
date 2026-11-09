// 세무사 꾸러미 PC 입력(08 D-05, D14 M6-2·M6-4): 현금매출 하루 숫자, 종이 증빙 확인(읽어 낸 값을 사장님이 고침), 항목 상태 표시(해당 없음·파일 칸).
// 엔진 BundleService가 부른다. 모델을 부르지 않는다. 영수증 사진·파일은 여기서 열지 않는다(OCR·파싱은 docparse 샌드박스 몫, 결과 후보만 기록에 있다).
// 로그를 남기지 않는다(금액·가게 이름이 섞이지 않게).
import { BundleRepo, CashSalesRepo, DocumentRepo, ReceiptRepo, type BundleEntry, type BundleEntryStatus, type CashSale, type Db, type Receipt } from '@sax/db';
import { monthRange, periodFor } from './items.ts';

export class PcEntryError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const fail = (code: string): never => {
  throw new PcEntryError(code);
};

const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const day = (v: unknown, code: string): string => (typeof v === 'string' && DAY.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v ? v : fail(code));
const STATUSES: readonly BundleEntryStatus[] = ['missing', 'partial', 'ready', 'not_applicable'];
/** 하루 현금매출 상한(원). 잘못 친 자릿수를 막는다(1조 원 미만) */
export const CASH_DAY_MAX = 999_999_999_999;
export const RECEIPT_MERCHANT_MAX = 100;
export const ENTRY_NOTE_MAX = 500;
export const ENTRY_DOCS_MAX = 50;

// ── 현금매출 ──

export interface CashMonthView {
  month: string;
  days: Array<Pick<CashSale, 'day' | 'amount' | 'source' | 'enteredAt'>>;
  total: number;
}

export function cashMonthView(db: Db, profileId: string, month: string): CashMonthView {
  const { from, to } = monthRange(month);
  const days = new CashSalesRepo(db).range(profileId, from, to).map((c) => ({ day: c.day, amount: c.amount, source: c.source, enteredAt: c.enteredAt }));
  return { month, days, total: days.reduce((s, d) => s + d.amount, 0) };
}

/** PC에서 하루 숫자를 넣는다. 같은 날을 다시 넣으면 바꾸고 이전 값을 알린다(폰에서 넣은 값이어도) */
export function cashPut(db: Db, profileId: string, dayValue: unknown, amount: unknown, at: string): { day: string; amount: number; replaced: { amount: number; source: CashSale['source'] } | null } {
  const d = day(dayValue, 'bad_day');
  const a = Number.isSafeInteger(amount) && (amount as number) >= 0 && (amount as number) <= CASH_DAY_MAX ? (amount as number) : fail('bad_amount');
  const { replaced } = new CashSalesRepo(db).put({ profileId, day: d, amount: a, source: 'pc' }, at);
  return { day: d, amount: a, replaced: replaced ? { amount: replaced.amount, source: replaced.source } : null };
}

export function cashRemove(db: Db, profileId: string, dayValue: unknown): { removed: boolean } {
  return { removed: new CashSalesRepo(db).remove(profileId, day(dayValue, 'bad_day')) };
}

// ── 종이 증빙 ──

/** 화면에 주는 증빙. 폰 메시지 id는 빼고, 읽어 낸 후보(phoneOcr·ocr)는 화면이 입력 칸의 기본값으로만 쓴다(글자로만 그린다) */
export type ReceiptView = Omit<Receipt, 'phoneMsgId'>;

const receiptView = ({ phoneMsgId: _, ...r }: Receipt): ReceiptView => r;

/** 그달 증빙: 확인한 것은 발행일로, 확인 전 것은 받은 날로 거른다(ReceiptRepo.list). 확인 전 것이 먼저 */
export function receiptMonthView(db: Db, profileId: string, month: string): { month: string; receipts: ReceiptView[]; unconfirmed: number } {
  const { from, to } = monthRange(month);
  const list = new ReceiptRepo(db).list(profileId, from, to);
  const receipts = [...list.filter((r) => !r.confirmedAt), ...list.filter((r) => r.confirmedAt)].map(receiptView);
  return { month, receipts, unconfirmed: receipts.filter((r) => !r.confirmedAt).length };
}

/** 그 프로필의 증빙(다른 프로필 문서면 receipt_not_found) */
function ownReceipt(db: Db, profileId: string, docId: unknown): Receipt {
  const id = typeof docId === 'string' && docId.length <= 64 ? docId : '';
  const r = id ? new ReceiptRepo(db).get(id) : null;
  return r && new DocumentRepo(db).get(id)?.profileId === profileId ? r : fail('receipt_not_found');
}

/**
 * 사장님이 확인한 값으로 증빙을 확정한다(다시 불러 고칠 수 있다). 읽어 낸 후보를 그대로 믿지 않는다: 이 값만 대조(빠진 것)·내보내기에 쓴다.
 * 사업자번호는 '-'·공백을 빼고 숫자 10자리, 빈 값이면 null.
 */
export function receiptConfirm(db: Db, profileId: string, p: Record<string, unknown>, at: string): ReceiptView {
  const r = ownReceipt(db, profileId, p.docId);
  const issuedOn = day(p.issuedOn, 'bad_issued_on');
  const amount = Number.isSafeInteger(p.amount) && (p.amount as number) >= 0 ? (p.amount as number) : fail('bad_amount');
  const merchant = p.merchant === undefined || p.merchant === null ? null : typeof p.merchant === 'string' && p.merchant.length <= RECEIPT_MERCHANT_MAX ? p.merchant.trim() || null : fail('bad_merchant');
  let bizNo: string | null = null;
  if (p.merchantBizNo !== undefined && p.merchantBizNo !== null && p.merchantBizNo !== '') {
    const d = typeof p.merchantBizNo === 'string' && p.merchantBizNo.length <= 20 ? p.merchantBizNo.replace(/[\s-]/g, '') : '';
    bizNo = /^\d{10}$/.test(d) ? d : fail('bad_merchant_biz_no');
  }
  return receiptView(new ReceiptRepo(db).confirm(r.docId, { issuedOn, merchant, merchantBizNo: bizNo, amount }, at));
}

// ── 항목 상태 표시(해당 없음·파일 칸) ──

/**
 * 사장님이 그달 항목에 상태를 표시하고 파일(문서 id)을 붙인다. 기간은 엔진이 항목 주기로 정한다(main이 기간을 짓지 않는다).
 * - status null: 표시를 지운다(앱이 센 상태로 돌아간다). 붙인 파일 목록도 함께 지운다(파일 자체는 보관함에 남는다).
 * - 카드(사업용 카드)와 급여를 쓰는 업체의 급여대장은 앱이 기록에서 센다: 해당 없음만 표시할 수 있다(entry_derived).
 * - 붙이는 문서는 그 프로필 것만(doc_not_found).
 */
export function setEntry(
  db: Db,
  profileId: string,
  p: Record<string, unknown>,
  opts: { month: string; payrollEnabled: boolean; at: string },
): { period: string; entry: BundleEntry | null } {
  const repo = new BundleRepo(db);
  const item = typeof p.itemId === 'string' && p.itemId.length <= 64 ? repo.item(p.itemId) : null;
  if (!item || item.profileId !== profileId) return fail('item_not_found');
  const period = periodFor(opts.month, item.cadence);
  if (p.status === null) {
    repo.clearEntry(item.id, period);
    return { period, entry: null };
  }
  const status = STATUSES.includes(p.status as BundleEntryStatus) ? (p.status as BundleEntryStatus) : fail('bad_status');
  const derived = item.kind === 'card' || (item.kind === 'payroll' && opts.payrollEnabled);
  if (derived && status !== 'not_applicable') fail('entry_derived');
  let docIds: string[] | undefined;
  if (p.docIds !== undefined) {
    if (!Array.isArray(p.docIds) || p.docIds.length > ENTRY_DOCS_MAX) return fail('bad_doc_ids');
    const docs = new DocumentRepo(db);
    docIds = p.docIds.map((d) => (typeof d === 'string' && d.length <= 64 && docs.get(d)?.profileId === profileId ? d : fail('doc_not_found')));
  }
  const note = p.note === undefined ? undefined : p.note === null ? null : typeof p.note === 'string' && p.note.length <= ENTRY_NOTE_MAX ? p.note.trim() || null : fail('bad_note');
  return { period, entry: repo.setEntry({ itemId: item.id, period, status, ...(docIds ? { docIds } : {}), ...(note !== undefined ? { note } : {}) }, opts.at) };
}
