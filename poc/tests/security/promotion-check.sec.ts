// ADR-035 결정 1.3 (라): 제품 진입점(하드닝된 셸·금고·엔진 프로세스)이 `// PoC 폐기 대상` 표지 파일을 import하지 않는다.
// CI의 승격 점검 단계와 같은 함수(scripts/ci-promotion-check.mjs). 보안 스위트에도 두어 릴리스 게이트에서 빠지지 않게 한다.
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
