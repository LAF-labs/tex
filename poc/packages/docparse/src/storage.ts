// 원본 보관 경로 규칙(D07 §4): 보관함 평면 레이아웃 {docType}_{yyyyMMdd}_{shortId}.{ext}. 파일명에 PII를 넣지 않는다.
// 실제로 옮기고 documents 행을 만드는 일은 엔진(documents.ts)이 한다. 여기는 이름 규칙과 형식별 확장자만 정한다.
// 폰 사진(M7-4, JPEG, EXIF 제거됨)도 같은 규칙으로 보관한다(receipts.source='phone_capture').
import type { InputFormat } from './sandbox/index.ts';
import type { DocKind } from './types.ts';

/** D07 §3 표의 doc_type(사용자 첨부 종류). 증명서는 docmeta가 정한 종류를 쓴다 */
export const STORED_DOC_TYPE: Record<Exclude<DocKind, 'certificate'>, 'paper_receipt' | 'settlement_file' | 'insurance_notice'> = {
  receipt: 'paper_receipt',
  settlement: 'settlement_file',
  insurance_notice: 'insurance_notice',
};

const EXT: Record<InputFormat, string> = { pdf: 'pdf', jpeg: 'jpg', png: 'png', xlsx: 'xlsx', csv: 'csv' };

/** Crockford base32(헷갈리는 I·L·O·U 없음) */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 4자리 짧은 id. random은 0 이상 1 미만(엔진은 crypto 난수를 넘긴다) */
export function shortId(random: () => number): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += B32[Math.floor(random() * 32) % 32];
  return s;
}

const DOC_TYPE_RE = /^[a-z][a-z0-9_]{1,39}$/;

/**
 * 보관 파일 이름. date는 서류 날짜(영수증 거래일·고지 년월의 1일), 모르면 받은 날. 사장님이 확인 카드에서 고친 날짜가 오면 그 값.
 * 이름에는 docType·날짜·shortId만 들어간다(상호·금액·성명은 documents.display_name·receipts 칸에).
 */
export function storedFileName(o: { docType: string; date: string; shortId: string; format: InputFormat }): string {
  if (!DOC_TYPE_RE.test(o.docType)) throw new Error('doc_type');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(o.date)) throw new Error('date');
  if (!/^[0-9A-HJKMNP-TV-Z]{4}$/.test(o.shortId)) throw new Error('short_id');
  return `${o.docType}_${o.date.replaceAll('-', '')}_${o.shortId}.${EXT[o.format]}`;
}
