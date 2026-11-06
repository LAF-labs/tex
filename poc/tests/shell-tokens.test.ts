// ADR-028 결정 7·#76 인계 ④: 셸 토큰은 빌드에 들어가는 생성 파일(tokens.gen.ts)에서만 읽는다. 설치본은 저장소 밖 디자인 시스템을 읽지 못한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { bundleCss, loadTokens, tokensCss } from '../apps/desktop/src/shell-tokens.ts';

const DESK = path.join(import.meta.dirname, '../apps/desktop');
const gen = (await import(path.join(DESK, 'scripts/gen-tokens.mjs'))) as { render(): string; OUT: string; resolveTokens(t: unknown): unknown; DESIGN_SYSTEM: string };

describe('셸 토큰(생성 파일)', () => {
  it('tokens.gen.ts가 디자인 시스템 원본과 같다(다르면 node apps/desktop/scripts/gen-tokens.mjs)', () => {
    assert.equal(readFileSync(gen.OUT, 'utf8'), gen.render());
  });

  it('런타임 코드는 저장소 밖(디자인 시스템)을 읽지 않는다', () => {
    const src = readFileSync(path.join(DESK, 'src/shell-tokens.ts'), 'utf8');
    assert.ok(!/node:fs|readFileSync|design-system['/]/.test(src.replace(/^\/\/.*$/gm, '')), 'fs·경로 없음');
    assert.ok(!readFileSync(path.join(DESK, 'src/tokens.gen.ts'), 'utf8').includes('readFileSync'));
  });

  it('값은 원본과 같고 참조가 풀려 있으며, bundle.css의 외부 @import는 빠졌다', () => {
    const t = loadTokens();
    assert.deepEqual(t, gen.resolveTokens(JSON.parse(readFileSync(path.join(gen.DESIGN_SYSTEM, 'tokens.json'), 'utf8'))));
    for (const m of [t.light, t.dark]) for (const v of Object.values(m)) assert.ok(!/^\{.+\}$/.test(v), v);
    assert.ok(tokensCss().startsWith(':root{') && tokensCss().includes('@media (prefers-color-scheme: dark)'));
    assert.ok(!/@import/.test(bundleCss()) && !/fonts\.googleapis/.test(bundleCss()));
  });
});
