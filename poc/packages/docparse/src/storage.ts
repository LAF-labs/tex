import type { InputFormat } from './sandbox/index.ts';
import type { DocKind } from './types.ts';

/** D07 §3 표의 doc_type(사용자 첨부 종류). 증명서는 docmeta가 정한 종류를 쓴다 */
export const STORED_DOC_TYPE: Record<Exclude<DocKind, 'certificate'>, 'paper_receipt' | 'settlement_file' | 'insurance_notice'> = {
  receipt: 'paper_receipt',
  settlement: 'settlement_file',
  insurance_notice: 'insurance_notice',
};

const EXT: Record<InputFormat, string> = { pdf: 'pdf', jpeg: 'jpg', png: 'png', xlsx: 'xlsx', csv: 'csv', xls: 'xls', html: 'xls' };

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
