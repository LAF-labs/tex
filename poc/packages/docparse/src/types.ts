// @sax/docparse 공개 타입. 모양의 정본은 schema/*.json이고, 여기 타입은 그것을 그대로 옮긴 것이다(docparse-schema.test.ts가 맞춰 본다).
// 원칙: 결과에는 "판정"이 없다. 추출값, 신뢰도(0~1), 경고 코드뿐이다. 사장님 확인 카드가 정본이다(ADR-031·032).
import type { DocMetaExtract } from '@sax/engine/docmeta';
import type { InputFormat, RejectedFormat, SheetOutput } from './sandbox/index.ts';

export type { DocMetaExtract, InputFormat, RejectedFormat, SheetOutput };

/** parse(bytes, kind)의 kind. 사장님이 어느 칸에 넣었는지(꾸러미 항목·보관함)로 정해진다. 내용으로 추측하지 않는다. */
export type DocKind = 'certificate' | 'receipt' | 'settlement' | 'insurance_notice';

export type FieldReason = 'not_found' | 'ambiguous' | 'checksum_failed' | 'unparseable';

/** 칸 하나. 값이 있으면 reason은 null. 값이 없으면 reason이 있고 후보가 있을 수 있다. */
export interface Extracted<T> {
  value: T | null;
  /** 0~1. 규칙 강도 × OCR 줄 신뢰도. 화면은 0.8 미만을 "확인해 주세요"로 표시한다(제안) */
  confidence: number;
  reason: FieldReason | null;
  /** 값을 정하지 못했을 때(또는 정했어도 다른 값이 보였을 때)의 후보. 최대 6개 */
  candidates?: T[];
}

// ── 종이 증빙(M6-4) ──────────────────────────────────────────────

export type ReceiptDocKind = 'card_slip' | 'cash_receipt' | 'simple_receipt' | 'receipt' | 'tax_invoice' | 'invoice' | 'unknown';

export interface ReceiptResult {
  extractor: 'receipt-v1';
  /** 제목 글자로 본 서류 이름(판정이 아니다. 화면에 "카드 전표로 보여요" 정도로만) */
  docKind: ReceiptDocKind;
  issuedOn: Extracted<string>;
  merchant: Extracted<string>;
  merchantBizNo: Extracted<string>;
  /** 합계(받을 금액·결제 금액) */
  amount: Extracted<number>;
  supplyAmount: Extracted<number>;
  vat: Extracted<number>;
  /** 카드 승인번호(카드 내역 대조용, M6-14) */
  approvalNo: Extracted<string>;
  /** 카드번호 끝 4자리. 전체 번호는 내지 않는다 */
  cardTail: Extracted<string>;
}

// ── 정산내역(M6-5, J-01·J-02) ─────────────────────────────────────

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
  /** 수수료 칸들의 합(절댓값). 어떤 칸을 더했는지는 columns의 fee들이다 */
  fees: number | null;
  payout: number | null;
  vat: number | null;
  orderCount: number | null;
}

export interface SettlementResult {
  extractor: 'settlement-v1';
  channel: Extracted<SettlementChannel>;
  platform: Extracted<SettlementPlatform>;
  /** 적용한 형식 규칙 id. 실물 확인 전 규칙이면 estimated=true */
  profile: string;
  estimated: boolean;
  sheet: string;
  headerRow: number;
  columns: SettlementColumn[];
  period: { from: string | null; to: string | null };
  rows: SettlementRow[];
  totals: { gross: number | null; fees: number | null; payout: number | null; vat: number | null; rows: number };
  /** 파일 안의 "합계" 줄(있으면). 우리가 더한 값과 다르면 total_mismatch 경고 */
  fileTotals: { gross: number | null; fees: number | null; payout: number | null } | null;
}

// ── 4대보험 고지내역(M6-5, S-06) ──────────────────────────────────

export type InsuranceKind = 'pension' | 'health' | 'ltc' | 'employment' | 'industrial';

export interface InsuranceNoticeRow {
  /** 파일 안 위치로 만든 안정 id('<시트>!<행>:<보험>'). 매칭 결과를 이 id로 돌려준다 */
  rowId: string;
  name: string;
  /** 생년월일(주민번호 앞 7자리에서). 주민번호 뒷자리는 내지 않는다 */
  birthDate: string | null;
  /** 주민번호 앞 6자리 + 성별 자리('9001011'). 파일에 전체 번호가 있어도 이것만 남긴다 */
  rrnFront7: string | null;
  insurance: InsuranceKind;
  /** 기준소득월액·보수월액 */
  base: number | null;
  /** 이 보험의 고지(산정) 보험료 합계 */
  total: number | null;
  /** 근로자(가입자) 부담분 */
  employee: number | null;
  /** 사업주(사용자) 부담분 */
  employer: number | null;
  confidence: number;
}

export interface InsuranceNoticeResult {
  extractor: 'insurance-notice-v1';
  /** 형식 규칙이 공개 안내·화면 설명 기준 추정이다(실물 파일 확인 전) */
  estimated: boolean;
  profile: string;
  /** 고지(귀속) 년월 'YYYY-MM' */
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
  /** 고지 년월. 사장님이 확인 카드에서 고친 값 */
  month: string;
  /** 고지내역 원본 documents.id(payroll_months.notice_doc_ids_json에 들어갈 값) */
  noticeDocId: string;
  rows: Array<Pick<InsuranceNoticeRow, 'rowId' | 'name' | 'birthDate' | 'insurance' | 'base' | 'total' | 'employee' | 'employer'>>;
}

export interface InsuranceNoticeMatch {
  rowId: string;
  employeeId: string | null;
  /** name_birth: 이름·생년월일 일치, name_only: 이름만(생년월일 없음), ambiguous: 후보 여럿, none: 없음 */
  basis: 'name_birth' | 'name_only' | 'ambiguous' | 'none';
  candidates?: string[];
}

// ── 결과 봉투 ──────────────────────────────────────────────────

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
  /** PDF 텍스트 층을 썼는가(PDF만) */
  textLayer: boolean | null;
  ocr: boolean;
  /** tesseract 평균 신뢰도 0~100 */
  ocrConfidence: number | null;
  pages: number | null;
  /** 그림 크기(그림만) */
  image: { width: number; height: number } | null;
}

export type ParseResult = DocMetaExtract | ReceiptResult | SettlementResult | InsuranceNoticeResult;

export interface ParseOutcome<R extends ParseResult = ParseResult> {
  schema: 'sax.docparse/v1';
  kind: DocKind;
  result: R;
  /** 0~1. 핵심 칸 신뢰도의 평균(빠진 칸은 0) */
  confidence: number;
  warnings: WarningCode[];
  /** 핵심 칸을 못 읽어 수동 입력 폼(ManualInput)을 바로 띄우는 것이 좋다(화면 힌트) */
  needsManual: boolean;
  source: ParseSource;
  /** 추출 원문(로컬 전용: receipts.ocr_json·documents.meta_json에만). 최대 64KB */
  text: string;
}

// ── 샌드박스 출력(main이 schema/sandbox-output.schema.json으로 검증) ──────────────

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
  /** 기준일(미래 날짜 거르기). 기본은 KST 오늘 */
  today?: string;
  password?: string;
  /** 꾸러미 항목이 정한 정산 경로(settlement_delivery·settlement_market) */
  expectedChannel?: SettlementChannel;
  forceOcr?: boolean;
}
