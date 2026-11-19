// 시험 h01-real-agentpath*.test.ts가 함께 쓰는 가짜 게이트웨이(판정·에이전트 대역). 발급 사다리 0원 칸 예행 2(가짜 홈택스 + 제품 H-01 패키지): 위치 찾기로도 못 고친 어긋남을 판정 → 브라우저 에이전트(jev 대역)가 넘기면
// 그 걸음을 PC에 남기고, 2회차는 같은 막힘을 판정·에이전트·위치 찾기 없이(모델 0번) 기억한 길로 다시 걸어 끝까지 간다.
import type { LocateResponder } from '@sax/engine';
import type { PackageFiles } from '@sax/engine/core';
import { loadPkg } from './core-fixtures.ts';
import type { Outcome } from './h01-real-dryrun.ts';

export const KEY = 'hometax.invoice.form.item1.name';
export const REAL_ID = 'mf_txppWframe_genEtxivLsatTop_0_edtLsatNmTop';
export const show = (o: Outcome) => `${o.end?.status}/${o.end?.code} steps=${o.steps.join(',')} journal=${o.journal.join(',')}`;
export const drift = (files: PackageFiles) => {
  files.selectors.entries[KEY]!.candidates = [{ kind: 'css', value: '#mf_txppWframe_genEtxivLsatTop_0_edtLsatNmTopOld' }];
};

/** 패키지 항목 키 → 화면 DOM id(패키지 css #id, 어긋난 항목은 화면의 실제 id). */
function idOf(): (key: string) => string | null {
  const sel = loadPkg('hometax.invoice.issue').selectors.entries as Record<string, { candidates: Array<{ kind: string; value?: string }> }>;
  return (key) => (key === KEY ? REAL_ID : (sel[key]?.candidates.find((c) => c.kind === 'css' && c.value?.startsWith('#'))?.value?.slice(1) ?? null));
}

type Call = { toolset: string };
export function fakeGateway(judge: 'agent_mode' | 'fix_field' = 'agent_mode'): LocateResponder & { calls: Call[] } {
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

