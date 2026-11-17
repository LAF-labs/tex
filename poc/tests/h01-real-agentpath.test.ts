// 발급 사다리 0원 칸 예행 2(가짜 홈택스 + 제품 H-01 패키지): 위치 찾기로도 못 고친 어긋남을 판정 → 브라우저 에이전트(jev 대역)가 넘기면
// 그 걸음을 PC에 남기고, 2회차는 같은 막힘을 판정·에이전트·위치 찾기 없이(모델 0번) 기억한 길로 다시 걸어 끝까지 간다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LocateResponder } from '@sax/engine';
import type { PackageFiles } from '@sax/engine/core';
import type { Db } from '@sax/db';
import { loadPkg } from './core-fixtures.ts';
import { realDryRun, type Outcome } from './h01-real-dryrun.ts';

const KEY = 'hometax.invoice.form.item1.name';
const REAL_ID = 'mf_txppWframe_genEtxivLsatTop_0_edtLsatNmTop';
const show = (o: Outcome) => `${o.end?.status}/${o.end?.code} steps=${o.steps.join(',')} journal=${o.journal.join(',')}`;
const drift = (files: PackageFiles) => {
  files.selectors.entries[KEY]!.candidates = [{ kind: 'css', value: '#mf_txppWframe_genEtxivLsatTop_0_edtLsatNmTopOld' }];
};

/** 패키지 항목 키 → 화면 DOM id(패키지 css #id, 어긋난 항목은 화면의 실제 id). */
function idOf(): (key: string) => string | null {
  const sel = loadPkg('hometax.invoice.issue').selectors.entries as Record<string, { candidates: Array<{ kind: string; value?: string }> }>;
  return (key) => (key === KEY ? REAL_ID : (sel[key]?.candidates.find((c) => c.kind === 'css' && c.value?.startsWith('#'))?.value?.slice(1) ?? null));
}

type Call = { toolset: string };
function fakeGateway(judge: 'agent_mode' | 'fix_field' = 'agent_mode'): LocateResponder & { calls: Call[] } {
  const calls: Call[] = [];
  const id = idOf();
  const usage = { inputTokens: 1, outputTokens: 1 };
  const done = (output: unknown) => ({ status: 'completed', output, toolCalls: [], replay: [], usage }) as never;
  return {
    calls,
    async respond(t, req) {
      calls.push({ toolset: t.id });
      const text = req.messages[0]!.content.map((c) => String((c as { text: string }).text)).join('\n');
      if (t.id === 'selector_repair') return done({ outcome: 'not_found', risk_flags: [], candidates: [] });
      // 실모델(jev-router, 2026-11-16 예행)은 이 막힘에 fix_field + 그 칸을 냈다(위치 찾기가 이미 못 찾은 칸).
      if (t.id === 'page_judge') return done({ situation: 'target_missing', prescription: judge, button: null, dialog_answer: null, field: judge === 'fix_field' ? KEY : null, risk_flags: [] });
      if (t.id !== 'browser_agent') return { status: 'incomplete', toolCalls: [], replay: [], usage, reason: 'test:off' } as never;
      const lines = text.split('\n');
      const g0 = lines.indexOf('[지난 동작]');
      const goal = lines.slice(1, g0).map((l) => l.match(/^(\S+) (fill|click|select) (\S+)(?: \(\S+\))?(?: (\{\{.+\}\}))?/)).filter((m) => !!m);
      const sc = lines.findIndex((l) => l.startsWith('[화면]'));
      const hist = lines.slice(g0 + 1, sc).filter((l) => /^\d+\. /.test(l)).length;
      const g = goal[hist];
      if (!g) return done({ action: 'done', index: null, token: null, option: null, step: null });
      const want = id(g[3]!);
      const row = lines.find((l) => want && l.includes(`#${want}`));
      const n = row ? Number(row.match(/^(\d+)\./)?.[1]) : NaN;
      if (!Number.isFinite(n)) return done({ action: 'fail', index: null, token: null, option: null, step: null });
      if (g[2] === 'click') return done({ action: 'click', index: n, token: null, option: null, step: g[1] });
      return done({ action: 'type', index: n, token: g[4] ?? null, option: null, step: g[1] });
    },
  };
}

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

  it('판정이 실모델처럼 fix_field(위치 찾기가 이미 못 찾은 칸)를 내도 에이전트로 넘어가 끝까지 간다. 재시도는 한 번만', async (t) => {
    const g = fakeGateway('fix_field');
    const t0 = Date.now();
    const o = await realDryRun({ loggedIn: true, patchIssue: drift, locate: g, maxMs: 300_000 });
    t.diagnostic(`모델 호출: ${g.calls.map((c) => c.toolset).join(',')} · ${Date.now() - t0}ms`);
    assert.equal(o.end?.status, 'success', show(o));
    assert.ok(g.calls.some((c) => c.toolset === 'browser_agent'), '에이전트를 불렀다');
    assert.ok(!g.calls.some((c) => c.toolset === 'computer_use'), '화면 보기까지 가지 않았다');
    // 첫 실행 + 재시도 1번 = 같은 스텝 실패 2번, 체크포인트 재진입 뒤에도 2번(재시도 3번이면 4번씩 8번)
    assert.equal(o.steps.filter((x) => x === 's16a!step.selector_miss').length, 4, o.steps.join(' '));
  });
});
