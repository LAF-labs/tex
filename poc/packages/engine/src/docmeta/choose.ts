// 텍스트 층과 OCR 중 어느 읽기를 쓸지. 보관함 가져오기(documents.ts)와 실물 측정 스크립트가 같은 규칙을 쓴다.
import type { DocMetaExtract } from './extract.ts';

/** 텍스트 층으로 핵심 칸을 못 뽑았으면 OCR로 다시 읽을 만하다(알아본 지원 밖 서류는 다시 읽지 않는다). */
export const worthOcr = (m: DocMetaExtract): boolean => m.kind === 'unknown' || (m.docType !== null && m.issuedOn.reason === 'not_found');

/** 두 읽기 중 고를 때의 점수: 종류 > 발급일 > 유효기간 */
export const readScore = (m: DocMetaExtract): number => (m.docType ? 4 + (m.issuedOn.value ? 2 : 0) + (m.docType === 'biz_registration_cert' || m.validUntil.value ? 1 : 0) : 0);
