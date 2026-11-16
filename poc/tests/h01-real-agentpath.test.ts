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
function fakeGateway(): LocateResponder & { calls: Call[] } {
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
      if (t.id === 'page_judge') return done({ situation: 'field_moved', prescription: 'agent_mode', button: null, dialog_answer: null, field: null, risk_flags: [] });
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

    const g2 = fakeGateway();
    const o2 = await realDryRun({
      loggedIn: true, patchIssue: drift, locate: g2, maxMs: 300_000,
      beforeRun: (db: Db) => void db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?)').run(ROW, saved!),
    });
    assert.equal(o2.end?.status, 'success', show(o2));
    assert.ok(o2.journal.includes('agentpath.replayed'), show(o2));
    assert.deepEqual(g2.calls, [], '2회차 모델 호출 없음');
    t.diagnostic(`1회차 jev 걸음 ${agentCalls}번 + 판정 1번 → 2회차 0번`);
  });
});
