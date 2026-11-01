// 텍스트 층과 OCR 중 어느 읽기를 쓸지. 보관함 가져오기(documents.ts)와 실물 측정 스크립트가 같은 규칙을 쓴다.
import type { DocMetaExtract } from './extract.ts';

/**
 * 텍스트 층으로 핵심 칸을 못 뽑았으면 OCR로 다시 읽을 만하다. 알아본 지원 밖 서류는 다시 읽지 않고, 종류를 못 알아본 서류는
 * 글자가 적거나(머리말만 글자인 그림 PDF) 증명서 단서가 있을 때만 다시 읽는다(보통 문서마다 OCR 1초·600MB를 쓰지 않게).
 */
export function worthOcr(m: DocMetaExtract, text: string): boolean {
  if (m.docType !== null) return m.issuedOn.reason === 'not_found';
  if (m.kind !== 'unknown') return false;
  const c = text.replace(/\s/g, '');
  return c.length < 300 || /세무서|증명|납세|사업자등록/.test(c);
}

/** 두 읽기 중 고를 때의 점수: 종류 > 발급일 > 유효기간. 지원 밖이라도 종류를 알아본 쪽이 못 알아본 쪽보다 낫다. */
export const readScore = (m: DocMetaExtract): number =>
  m.docType ? 4 + (m.issuedOn.value ? 2 : 0) + (m.docType === 'biz_registration_cert' || m.validUntil.value ? 1 : 0) : m.kind !== 'unknown' && m.kind !== 'ambiguous' ? 1 : 0;
