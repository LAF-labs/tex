import fs from 'node:fs';
import path from 'node:path';

// 디자인 시스템 tokens.json을 CSS 변수로 옮긴다(PoC: 저장소의 원본을 기동 때 읽는다. 앱 번들에 넣는 것은 Phase 1).

export const DESIGN_SYSTEM = path.resolve(import.meta.dirname, '../../../../sovereign-ax/design-system');

interface TokenFile {
  color: { tokens: Array<{ name: string; value: { light: string; dark: string } }> };
  type: { families: Record<string, string> };
  spacing: { tokens: Array<{ name: string; value: string }> };
  radius: { tokens: Array<{ name: string; value: string }> };
  shadow: { tokens: Array<{ name: string; value: { light: string; dark: string } }> };
  layout: { tokens: Array<{ name: string; value: string }> };
}

export interface Tokens {
  light: Record<string, string>;
  dark: Record<string, string>;
  common: Record<string, string>;
}

let cached: Tokens | null = null;

export function loadTokens(): Tokens {
  if (cached) return cached;
  const t = JSON.parse(fs.readFileSync(path.join(DESIGN_SYSTEM, 'tokens.json'), 'utf8')) as TokenFile;
  const light: Record<string, string> = {};
  const dark: Record<string, string> = {};
  for (const c of [...t.color.tokens, ...t.shadow.tokens]) {
    light[c.name] = c.value.light;
    dark[c.name] = c.value.dark;
  }
  // "{accent}" 같은 참조를 푼다.
  for (const m of [light, dark]) for (const [k, v] of Object.entries(m)) m[k] = v.replace(/^\{(.+)\}$/, (_s, ref: string) => m[ref] ?? v);
  const common: Record<string, string> = {};
  for (const [k, v] of Object.entries(t.type.families)) common[`font-${k}`] = v;
  for (const g of [t.spacing.tokens, t.radius.tokens, t.layout.tokens]) for (const x of g) common[x.name] = x.value;
  cached = { light, dark, common };
  return cached;
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

/** 디자인 시스템 컴포넌트 스타일. 렌더러는 네트워크가 없으므로 Google Fonts @import를 뺀다(서체는 대체 서체로). */
export function bundleCss(): string {
  return fs.readFileSync(path.join(DESIGN_SYSTEM, 'components/bundle.css'), 'utf8').replace(/^@import[^;]+;\s*/m, '');
}
