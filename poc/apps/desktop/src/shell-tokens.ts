import { BUNDLE_CSS, TOKENS } from './tokens.gen.ts';


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

export function tokensCss(): string {
  const t = loadTokens();
  return `:root{${vars(t.common)}${vars(t.light)}color-scheme:light dark}\n@media (prefers-color-scheme: dark){:root{${vars(t.dark)}}}\n`;
}

export function bundleCss(): string {
  return BUNDLE_CSS;
}
