// D06 §8: RedactedText는 이 패키지 밖에서 만들 수 없는 브랜드 타입이다.
// 브랜드 심볼은 내보내지 않고, 다른 패키지의 `as RedactedText` 단언은 린트(eslint.config.mjs)가 막는다.

declare const REDACTED: unique symbol;

export type RedactedText = string & { readonly [REDACTED]: 'Redacted' };

/** 패키지 내부 전용. index.ts에서 다시 내보내지 않는다. */
export function mint(text: string): RedactedText {
  return text as RedactedText;
}
