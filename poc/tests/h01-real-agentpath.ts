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

