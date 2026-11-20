import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
// @ts-expect-error 타입 선언 없는 .mjs 스크립트
import { checkMarkers } from '../../scripts/ci-promotion-check.mjs';

describe('승격 조건 (라) 폐기 표지', () => {
  it('제품 진입점에서 닿는 파일에 PoC 폐기 대상 표지가 없다', () => {
    const r = checkMarkers();
    assert.ok(r.entries.includes('apps/desktop/src/shell.ts'), '셸 진입점을 찾지 못함');
    assert.deepEqual(r.reached.map((x: { chain: string[] }) => x.chain.join(' → ')), []);
  });
});
