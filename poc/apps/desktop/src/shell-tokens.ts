import { BUNDLE_CSS, TOKENS } from './tokens.gen.ts';

// 디자인 시스템 토큰을 CSS 변수로 옮긴다. 값은 빌드에 들어가는 생성 파일(tokens.gen.ts)에서만 읽는다(ADR-028 결정 7).
// 설치본은 저장소의 디자인 시스템 폴더를 읽을 수 없다. 원본이 바뀌면 node apps/desktop/scripts/gen-tokens.mjs로 다시 만든다
// (tests/shell-tokens.test.ts가 생성 파일이 원본과 같은지 본다).

export interface Tokens {
  light: Record<string, string>;
  dark: Record<string, string>;
  common: Record<string, string>;
}

export function loadTokens(): Tokens {
  return TOKENS;
}

const vars = (m: Record<string, string>) =>
  Object.entries(m)
    .map(([k, v]) => `--${k}:${v};`)
    .join('');

/** 렌더러용 :root 변수. 테마는 시스템 설정을 따른다(prefers-color-scheme). */
export function tokensCss(): string {
  const t = loadTokens();
  return `:root{${vars(t.common)}${vars(t.light)}color-scheme:light dark}\n@media (prefers-color-scheme: dark){:root{${vars(t.dark)}}}\n`;
}

/** 디자인 시스템 컴포넌트 스타일(Google Fonts @import는 생성 때 뺐다). */
export function bundleCss(): string {
  return BUNDLE_CSS;
}
