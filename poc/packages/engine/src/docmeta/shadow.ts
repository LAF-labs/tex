import { RULES } from '../l0/rules.ts';
import type { DocMetaExtract } from './extract.ts';

/** L0 규칙이 고른 후보 날짜. 답하지 못했거나(모델 몫) none이면 null. */
export function l0ShadowPick(meta: DocMetaExtract, question: 'issued_on' | 'valid_until'): string | null {
  if (!meta.docType) return null;
  const a = RULES.doc_meta_check_v1![question]!({ kind: 'doc_meta', docType: meta.docType, candidates: meta.candidates });
  if (!a || a.type !== 'choice' || !a.choice.startsWith('candidate_')) return null;
  return meta.candidates[Number(a.choice.slice('candidate_'.length)) - 1]?.date ?? null;
}
