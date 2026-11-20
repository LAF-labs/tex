import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { realDryRun } from './h01-real-dryrun.ts';
import { drift, fakeGateway, show } from './h01-real-agentpath.ts';

describe('발급 사다리 0원 칸: 판정 fix_field도 에이전트로(가짜 홈택스 예행)', () => {
  it('판정이 실모델처럼 fix_field(위치 찾기가 이미 못 찾은 칸)를 내도 에이전트로 넘어가 끝까지 간다. 재시도는 한 번만', async (t) => {
    const g = fakeGateway('fix_field');
    const t0 = Date.now();
    const o = await realDryRun({ loggedIn: true, patchIssue: drift, locate: g, maxMs: 300_000 });
    t.diagnostic(`모델 호출: ${g.calls.map((c) => c.toolset).join(',')} · ${Date.now() - t0}ms`);
    assert.equal(o.end?.status, 'success', show(o));
    assert.ok(g.calls.some((c) => c.toolset === 'browser_agent'), '에이전트를 불렀다');
    assert.ok(!g.calls.some((c) => c.toolset === 'computer_use'), '화면 보기까지 가지 않았다');
    assert.equal(o.steps.filter((x) => x === 's16a!step.selector_miss').length, 4, o.steps.join(' '));
  });
});
