// D06 §8: RedactedText는 이 패키지 밖에서 만들 수 없는 브랜드 타입이다.
// 브랜드 심볼은 내보내지 않고, 다른 패키지의 `as RedactedText` 단언은 린트(eslint.config.mjs)가 막는다.
// 브랜드는 컴파일 장치일 뿐이므로(D06 §4) 런타임에도 확인할 수 있게 발급 영수증(sha256)을 남긴다:
// egress는 모델로 나가는 모든 텍스트가 mint()를 지난 값인지 wasMinted()로 다시 본다(`as never` 우회 차단).
import { createHash } from 'node:crypto';

declare const REDACTED: unique symbol;

export type RedactedText = string & { readonly [REDACTED]: 'Redacted' };

/** 영수증 상한. 넘으면 가장 오래 쓰이지 않은 것부터 지운다(실행 하나의 판정 입력은 수십 개 수준). */
export const RECEIPT_CAP = 8192;
/** 삽입 순서 = 최근 발급 순서(LRU). 다시 발급하면 맨 뒤로 옮겨, 자주 쓰는 텍스트가 밀려나지 않게 한다. */
const receipts = new Set<string>();

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

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
