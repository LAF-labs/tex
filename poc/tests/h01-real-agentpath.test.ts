// 발급 사다리 0원 칸 예행 2(가짜 홈택스 + 제품 H-01 패키지): 위치 찾기로도 못 고친 어긋남을 판정 → 브라우저 에이전트(jev 대역)가 넘기면
// 그 걸음을 PC에 남기고, 2회차는 같은 막힘을 판정·에이전트·위치 찾기 없이(모델 0번) 기억한 길로 다시 걸어 끝까지 간다.
// 판정이 fix_field를 내는 경우는 h01-real-agentpath-fixfield.test.ts(시간이 길어 CI 잡을 나누려고 파일을 갈랐다).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Db } from '@sax/db';
import { realDryRun } from './h01-real-dryrun.ts';
import { drift, fakeGateway, show } from './h01-real-agentpath.ts';

const ROW = 'agentpath.v1.hometax.invoice.issue';

describe('발급 사다리 0원 칸: 에이전트 길 기억(가짜 홈택스 예행)', () => {
  it('1회차 판정 → 에이전트가 넘김 → 길 기억, 2회차 같은 막힘은 모델 0번으로 다시 걸어 끝까지', async (t) => {
    let saved: string | undefined;
    const g1 = fakeGateway();
    const t1 = Date.now();
    const o1 = await realDryRun({
      loggedIn: true, patchIssue: drift, locate: g1, maxMs: 300_000,
      afterRun: (db: Db) => {
        saved = db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(ROW) as string | undefined;
      },
    });
    const agentCalls = g1.calls.filter((c) => c.toolset === 'browser_agent').length;
    t.diagnostic(`1회차 모델 호출: ${g1.calls.map((c) => c.toolset).join(',')}`);
    assert.equal(o1.end?.status, 'success', show(o1));
    assert.ok(o1.journal.includes('agentpath.learned'), show(o1));
    assert.ok(agentCalls >= 2, `에이전트 걸음 ${agentCalls}`);
    const file = JSON.parse(saved!) as { paths: Record<string, { actions: Array<{ token: string | null }> }> };
    assert.ok(file.paths.s16a?.actions.length, saved);
    assert.ok(!saved!.includes('테스트'), '값(품목명)은 남기지 않는다');

    const ms1 = Date.now() - t1;
    const g2 = fakeGateway();
    const t2 = Date.now();
    const o2 = await realDryRun({
      loggedIn: true, patchIssue: drift, locate: g2, maxMs: 300_000,
      beforeRun: (db: Db) => void db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(ROW, saved!),
    });
    assert.equal(o2.end?.status, 'success', show(o2));
    assert.ok(o2.journal.includes('agentpath.replayed'), show(o2));
    assert.deepEqual(g2.calls, [], '2회차 모델 호출 없음');
    const ms2 = Date.now() - t2;
    t.diagnostic(`1회차 ${ms1}ms(재시도·위치 찾기·체크포인트·판정·jev ${agentCalls}걸음), 2회차 ${ms2}ms(기억한 길, 재시도 건너뜀)`);
    assert.ok(ms2 < ms1, `2회차가 더 빠르다: ${ms1} → ${ms2}`);
    assert.ok(!o2.steps.includes('s16a!step.selector_miss!x'), o2.steps.join(','));
  });
});
