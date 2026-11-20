import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DESIGN_SYSTEM = path.resolve(HERE, '../../../../sovereign-ax/design-system');
export const OUT = path.resolve(HERE, '../src/tokens.gen.ts');

export function resolveTokens(t) {
  const light = {};
  const dark = {};
  for (const c of [...t.color.tokens, ...t.shadow.tokens]) {
    light[c.name] = c.value.light;
    dark[c.name] = c.value.dark;
  }
  for (const m of [light, dark]) for (const [k, v] of Object.entries(m)) m[k] = v.replace(/^\{(.+)\}$/, (_s, ref) => m[ref] ?? v);
  const common = {};
  for (const [k, v] of Object.entries(t.type.families)) common[`font-${k}`] = v;
  for (const g of [t.spacing.tokens, t.radius.tokens, t.layout.tokens]) for (const x of g) common[x.name] = x.value;
  return { light, dark, common };
}

export function render() {
  const tokens = resolveTokens(JSON.parse(fs.readFileSync(path.join(DESIGN_SYSTEM, 'tokens.json'), 'utf8')));
  const bundle = fs.readFileSync(path.join(DESIGN_SYSTEM, 'components/bundle.css'), 'utf8').replace(/^@import[^;]+;\s*/m, '');
  return [
    '// 생성 파일: node apps/desktop/scripts/gen-tokens.mjs (원본은 저장소 디자인 시스템 tokens.json·bundle.css). 손으로 고치지 않는다.',
    "import type { Tokens } from './shell-tokens.ts';",
    '',
    `export const TOKENS: Tokens = ${JSON.stringify(tokens, null, 2)};`,
    '',
    `export const BUNDLE_CSS: string = ${JSON.stringify(bundle)};`,
    '',
  ].join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = render();
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (process.argv.includes('--check')) {
    if (cur !== next) {
      console.error('tokens.gen.ts가 디자인 시스템과 다르다. node apps/desktop/scripts/gen-tokens.mjs로 다시 만든다.');
      process.exit(1);
    }
  } else if (cur !== next) fs.writeFileSync(OUT, next);
}
