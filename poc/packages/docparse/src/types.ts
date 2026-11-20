import type { DocMetaExtract } from '@sax/engine/docmeta';
import type { InputFormat, RejectedFormat, SheetOutput } from './sandbox/index.ts';

export type { DocMetaExtract, InputFormat, RejectedFormat, SheetOutput };

/** parse(bytes, kind)의 kind. 사장님이 어느 칸에 넣었는지(꾸러미 항목·보관함)로 정해진다. 내용으로 추측하지 않는다. */
export type DocKind = 'certificate' | 'receipt' | 'settlement' | 'insurance_notice';

export type FieldReason = 'not_found' | 'ambiguous' | 'checksum_failed' | 'unparseable';

/** 칸 하나. 값이 있으면 reason은 null. 값이 없으면 reason이 있고 후보가 있을 수 있다. */
export interface Extracted<T> {
  value: T | null;
  confidence: number;
  reason: FieldReason | null;
  candidates?: T[];
}

export type ReceiptDocKind = 'card_slip' | 'cash_receipt' | 'simple_receipt' | 'receipt' | 'tax_invoice' | 'invoice' | 'unknown';

export interface ReceiptResult {
  extractor: 'receipt-v1';
  docKind: ReceiptDocKind;
  issuedOn: Extracted<string>;
  merchant: Extracted<string>;
  merchantBizNo: Extracted<string>;
  amount: Extracted<number>;
  supplyAmount: Extracted<number>;
  vat: Extracted<number>;
  approvalNo: Extracted<string>;
  cardTail: Extracted<string>;
}

export type SettlementChannel = 'delivery' | 'market';
export type SettlementPlatform = 'baemin' | 'coupang_eats' | 'yogiyo' | 'ddangyo' | 'smartstore' | 'coupang' | '11st' | 'esm' | 'other';
export type SettlementRole = 'date' | 'order_id' | 'order_count' | 'gross' | 'fee' | 'payout' | 'vat' | 'discount';

export interface SettlementColumn {
  role: SettlementRole;
  index: number;
  header: string;
}

export interface SettlementRow {
  date: string | null;
  gross: number | null;
  fees: number | null;
  payout: number | null;
  vat: number | null;
  orderCount: number | null;
}

export interface SettlementResult {
  extractor: 'settlement-v1';
  channel: Extracted<SettlementChannel>;
  platform: Extracted<SettlementPlatform>;
  profile: string;
  estimated: boolean;
  sheet: string;
  headerRow: number;
  columns: SettlementColumn[];
  period: { from: string | null; to: string | null };
  rows: SettlementRow[];
  totals: { gross: number | null; fees: number | null; payout: number | null; vat: number | null; rows: number };
  fileTotals: { gross: number | null; fees: number | null; payout: number | null } | null;
}

export type InsuranceKind = 'pension' | 'health' | 'ltc' | 'employment' | 'industrial';

export interface InsuranceNoticeRow {
  rowId: string;
  name: string;
  birthDate: string | null;
  rrnFront7: string | null;
  insurance: InsuranceKind;
  base: number | null;
  total: number | null;
  employee: number | null;
  employer: number | null;
  confidence: number;
}

export interface InsuranceNoticeResult {
  extractor: 'insurance-notice-v1';
  estimated: boolean;
  profile: string;
  month: Extracted<string>;
  insurances: InsuranceKind[];
  rows: InsuranceNoticeRow[];
}

/**
 * S-06 직원 매칭 입력(데이터 트랙에 제안, 팀장 합의 대기). docparse는 매칭하지 않는다.
 * 데이터 트랙: matchInsuranceNotice(input, employees) → InsuranceNoticeMatch[] 를 @sax/payroll 또는 @sax/db 쪽에 둔다(제안).
 */
export interface InsuranceNoticeMatchInput {
  profileId: string;
  month: string;
  noticeDocId: string;
  rows: Array<Pick<InsuranceNoticeRow, 'rowId' | 'name' | 'birthDate' | 'insurance' | 'base' | 'total' | 'employee' | 'employer'>>;
}

export interface InsuranceNoticeMatch {
  rowId: string;
  employeeId: string | null;
  basis: 'name_birth' | 'name_only' | 'ambiguous' | 'none';
  candidates?: string[];
}

export type WarningCode =
  | 'ocr_used'
  | 'low_ocr_confidence'
  | 'scanned_text_layer'
  | 'pages_truncated'
  | 'formula_cached_values'
  | 'external_links_ignored'
  | 'macros_ignored'
  | 'connections_ignored'
  | 'embedded_ignored'
  | 'hidden_sheets_skipped'
  | 'hidden_rows_skipped'
  | 'sheet_truncated'
  | 'formula_like_text'
  | 'format_estimated'
  | 'channel_mismatch'
  | 'total_mismatch'
  | 'rrn_full_masked'
  | 'exif_present'
  | 'multiple_biz_no'
  | 'amount_cross_check_failed'
  | 'header_not_found'
  | 'no_rows'
  | 'encoding_euc_kr'
  | 'core_fields_missing';

export interface ParseSource {
  format: InputFormat;
  textLayer: boolean | null;
  ocr: boolean;
  ocrConfidence: number | null;
  pages: number | null;
  image: { width: number; height: number } | null;
}

export type ParseResult = DocMetaExtract | ReceiptResult | SettlementResult | InsuranceNoticeResult;

export interface ParseOutcome<R extends ParseResult = ParseResult> {
  schema: 'sax.docparse/v1';
  kind: DocKind;
  result: R;
  confidence: number;
  warnings: WarningCode[];
  needsManual: boolean;
  source: ParseSource;
  text: string;
}

export interface PdfExtract {
  text: string;
  pages: number;
  totalPages: number;
  hasTextLayer: boolean;
  scanned: boolean;
  ocrConfidence: number | null;
  timing: { loadMs: number; textMs: number; ocrMs: number };
}

export interface OcrLine {
  text: string;
  confidence: number;
}

export interface ImageOcr {
  text: string;
  confidence: number;
  lines: OcrLine[];
  width: number;
  height: number;
  exif: boolean;
}

/** 샌드박스를 부르는 쪽(데스크톱 어댑터). 테스트는 가짜 host를 넘긴다. */
export interface DocparseHost {
  pdf(bytes: Uint8Array, opts: { password?: string; ocrPages: number; forceOcr: boolean }): Promise<PdfExtract>;
  image(bytes: Uint8Array, opts: { mode: 'document' | 'photo' }): Promise<ImageOcr>;
  sheet(bytes: Uint8Array): Promise<SheetOutput>;
}

export interface ParseOptions {
  today?: string;
  password?: string;
  expectedChannel?: SettlementChannel;
  forceOcr?: boolean;
}
