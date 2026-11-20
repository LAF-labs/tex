import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

declare const REDACTED: unique symbol;

export type RedactedText = string & { readonly [REDACTED]: 'Redacted' };

/** 영수증 상한. 넘으면 가장 오래 쓰이지 않은 것부터 지운다(실행 하나의 판정 입력은 수십 개 수준). */
export const RECEIPT_CAP = 8192;
const receipts = new Set<string>();

const digest = (s: string) => bytesToHex(sha256(utf8ToBytes(s)));

/** 패키지 내부 전용. index.ts에서 다시 내보내지 않는다. */
export function mint(text: string): RedactedText {
  const h = digest(text);
  receipts.delete(h);
  receipts.add(h);
  if (receipts.size > RECEIPT_CAP) receipts.delete(receipts.values().next().value!);
  return text as RedactedText;
}

/** 이 프로세스의 마스킹 계층이 만든 텍스트인가(최근 RECEIPT_CAP개). 본문은 저장하지 않고 해시만 본다. */
export function wasMinted(text: string): boolean {
  return typeof text === 'string' && receipts.has(digest(text));
}
