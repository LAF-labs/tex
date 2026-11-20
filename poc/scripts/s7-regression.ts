import fs from 'node:fs';
import { BundleCatalog, DefaultModelLayer, OpenAICompatDecideAdapter, OpenAIDecisionsAdapter, OpenRouterDecisionsAdapter, ThresholdProfiles, evaluateMapping, localRunToken, statesOf, type BundleAnswers, type DecideAdapter, type Usage } from '@sax/model';
import { Egress } from '@sax/net';
import { DemoEgress } from '@sax/net/demo';
import { Redactor, apply, type A11yNode } from '@sax/redaction';
import type { ScreenObservation } from '@sax/engine';
import { intentCorpus, screenCorpus, type Sample } from '../tests/fixtures/l0-corpus.ts';
import { startOpenAIMock } from '../tests/fixtures/openai-mock.ts';
import { fileURLToPath } from 'node:url';

const BUNDLE = 'screen_state_v2';
const forceMock = process.argv.includes('--mock');
const gate = process.argv.includes('--gate');
const n = Number(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 100);
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const withAnswers = process.argv.includes('--answers');
const intentN = Number(process.argv.find((a) => a.startsWith('--intent='))?.slice(9) ?? Infinity);
const orKey = forceMock ? undefined : process.env.OPENROUTER_API_KEY || undefined;
const apiKey = forceMock || orKey ? undefined : process.env.OPENAI_API_KEY || undefined;
const mode: 'openrouter' | 'live' | 'mock' = orKey ? 'openrouter' : apiKey ? 'live' : 'mock';
const compatModel = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ?? 'openai/gpt-6-luna';
const decisionsModel = process.argv.find((a) => a.startsWith('--decisions='))?.slice(12);
const COST_CAP = 2;
const PASS = 0.98;
const RECALL = 0.99;

const PRICES: Record<string, [number, number, number, number]> = {
  'gpt-6-luna': [0.1, 0.01, 0.125, 0.5],
  'openai/gpt-6-luna': [0.1, 0.1, 0.1, 0.5],
  'upstage/solar-pro4': [0.15, 0.15, 0.15, 0.6],
  'upstage/solar-mini4': [0.05, 0.05, 0.05, 0.2],
  'cloudflare/clef-flash': [0.038, 0.038, 0.038, 0],
  'cloudflare/clef': [0.24, 0.24, 0.24, 0],
  'cloudflare/clef-omni': [0.15, 0.15, 0.15, 0],
  'typesafe/jev-1.14': [0.042, 0.042, 0.042, 0],
  '~typesafe/jev-latest': [0.042, 0.042, 0.042, 0],
};
const priceOf = (m: string) => PRICES[m] ?? PRICES[m.replace(/-\d{4}-\d{2}-\d{2}$/, '')] ?? PRICES[m.replace(/-\d{8}$/, '')] ?? [10, 10, 10, 50];
const costOf = (m: string, u: Usage) => {
  const [i, c, w, o] = priceOf(m);
  return ((u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * i + u.cachedTokens * c + u.cacheWriteTokens * w + u.outputTokens * o) / 1e6;
};

export function obsToTree(o: ScreenObservation): A11yNode {
  const root: A11yNode = { role: 'RootWebArea', name: o.title, children: [] };
  let dialog: A11yNode | null = null;
  for (const x of o.nodes) {
    const node: A11yNode = { role: x.role, name: x.name, states: x.states };
    if (x.role === 'dialog' || x.role === 'alertdialog') {
      dialog = { ...node, children: [] };
      root.children!.push(dialog);
    } else if (x.inDialog && dialog) dialog.children!.push(node);
    else root.children!.push(node);
  }
  return root;
}

function expectedOutcome(layer: DefaultModelLayer, s: Sample): string {
  const b = layer.bundle(BUNDLE)!;
  const answers: BundleAnswers = {};
  for (const q of b.def.questions) {
    const l = s.labels[q.name];
    if (q.type === 'predicate') answers[q.name] = { type: 'predicate', probability: l === true ? 1 : 0, source: 'model' };
    else if (q.type === 'choice') answers[q.name] = { type: 'choice', value: String(l ?? 'unknown'), confidence: 1, probabilities: { [String(l ?? 'unknown')]: 1 }, fullDistribution: false, source: 'model' };
  }
  return evaluateMapping(b.def, statesOf(b.def, answers)).outcome;
}

function interleaveBy<T>(xs: T[], key: (x: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const x of xs) (groups.get(key(x)) ?? groups.set(key(x), []).get(key(x))!).push(x);
  const out: T[] = [];
  for (let i = 0; out.length < xs.length; i++) for (const g of groups.values()) if (i < g.length) out.push(g[i]!);
  return out;
}

const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!);
};

async function main() {
  const catalog = BundleCatalog.load();
  const base = ThresholdProfiles.load();
  const mock = mode === 'mock' ? await startOpenAIMock() : null;
  const guard = { modelGuard: { bundles: catalog.allowEntries() }, timeoutMs: 60_000 };
  let egress: Egress;
  let decider: DecideAdapter;
  let profiles = base;
  if (mode === 'openrouter') {
    const demo = new DemoEgress(guard);
    egress = demo;
    decider = decisionsModel
      ? new OpenRouterDecisionsAdapter({ apiKey: orKey!, model: decisionsModel, provider: { data_collection: 'deny' }, fetchFn: fetch })
      : new OpenAICompatDecideAdapter({ transport: demo, apiKey: orKey!, model: compatModel, extraBody: { provider: { data_collection: 'deny' } } });
    const m = decisionsModel ?? compatModel;
    profiles = new ThresholdProfiles([...base.items, ...catalog.list().map((x) => ({ bundle: x.wireId, bundleDigest: x.digest, provider: 'openai_compat' as const, model: m, status: 'initial' as const, overrides: [] }))]);
  } else {
    egress = new Egress({ ...guard, ...(mock ? { testOrigins: { openai: mock.origin } } : {}) });
    decider = new OpenAIDecisionsAdapter({ apiKey: apiKey ?? 'sk-mock', egress });
  }
  const layer = new DefaultModelLayer({ catalog, profiles, decider });
  const b = layer.bundle(BUNDLE)!;

  const all = screenCorpus(20, 7).filter((s) => s.bundle === BUNDLE);
  const byOutcome = new Map<string, Sample[]>();
  for (const s of all) {
    const o = expectedOutcome(layer, s);
    (byOutcome.get(o) ?? byOutcome.set(o, []).get(o)!).push(s);
  }
  for (const [o, xs] of byOutcome) byOutcome.set(o, interleaveBy(xs, (s) => s.id.split('.')[1]!));
  const picked: Array<{ s: Sample; expect: string }> = [];
  for (let i = 0; picked.length < Math.min(n, all.length); i++) {
    for (const [o, xs] of byOutcome) if (xs[i] && picked.length < n) picked.push({ s: xs[i]!, expect: o });
    if ([...byOutcome.values()].every((xs) => i >= xs.length)) break;
  }

  const rows: Array<{ id: string; expect: string; got: string; reason?: string; ms: number; inputTokens: number; answers?: Record<string, unknown>; labels?: Record<string, unknown> }> = [];
  const perQ = new Map<string, { n: number; ok: number }>();
  let cost = 0;
  let stopped = false;
  const resolved = new Set<string>();
  for (const [i, { s, expect }] of picked.entries()) {
    if (cost >= COST_CAP) {
      stopped = true;
      break;
    }
    const input = new Redactor({ runId: `s7-${i}` }).applyTree(obsToTree(s.obs as ScreenObservation), { maxBytes: b.def.maxInputBytes }).redacted;
    const t0 = performance.now();
    const r = await layer.decide({ bundleId: BUNDLE, bundleDigest: b.digest, input, runToken: localRunToken(egress, { runId: `s7-${i}` }) });
    const ms = performance.now() - t0;
    cost += costOf(r.model, r.usage);
    if (r.model) resolved.add(r.model);
    const nums = () => Object.fromEntries(Object.entries(r.raw).map(([k, a]) => [k, a.type === 'predicate' ? { p: a.probability } : a.type === 'choice' ? { value: a.value, confidence: a.confidence, probabilities: a.probabilities } : { type: a.type }]));
    rows.push({ id: s.id, expect, got: r.outcome, ...(r.reason ? { reason: r.reason } : {}), ms, inputTokens: r.usage.inputTokens, ...(withAnswers ? { answers: nums(), labels: s.labels } : {}) });
    for (const q of b.def.questions) {
      const a = r.raw[q.name];
      const l = s.labels[q.name];
      if (!a || l === undefined) continue;
      const ok = a.type === 'predicate' ? (a.probability >= 0.5) === (l === true) : a.type === 'choice' ? a.value === l : false;
      const t = perQ.get(q.name) ?? perQ.set(q.name, { n: 0, ok: 0 }).get(q.name)!;
      t.n++;
      if (ok) t.ok++;
    }
  }
  let intent: Record<string, unknown> | null = null;
  if (mode !== 'mock' && !stopped) {
    const ib = layer.bundle('intent_route_v1')!;
    const xs = intentCorpus().slice(0, intentN);
    let ok = 0;
    let fp = 0;
    let fn = 0;
    let advice = 0;
    let n2 = 0;
    const wrong: Array<{ id: string; expect: string; got: string }> = [];
    for (const [i, s] of xs.entries()) {
      if (cost >= COST_CAP) {
        stopped = true;
        break;
      }
      const input = apply((s.obs as { text: string }).text, { chatSessionId: `s7-intent-${i}` }, { frame: 'none' }).redacted;
      const r = await layer.decide({ bundleId: 'intent_route_v1', bundleDigest: ib.digest, input, runToken: localRunToken(egress, { chatSessionId: `s7-intent-${i}` }) });
      cost += costOf(r.model, r.usage);
      n2++;
      const pa = r.raw.playbook;
      const got = pa?.type === 'choice' ? pa.value : 'unknown';
      if (got === s.labels.playbook) ok++;
      else if (wrong.length < 30) wrong.push({ id: s.id, expect: String(s.labels.playbook), got });
      const ta = r.raw.mentions_tax_advice;
      const said = ta?.type === 'predicate' ? ta.probability >= 0.75 : ta?.type === 'refusal';
      if (s.labels.mentions_tax_advice) {
        advice++;
        if (!said) fn++;
      } else if (said) fp++;
    }
    intent = {
      n: n2,
      playbookAccuracy: +(ok / Math.max(1, n2)).toFixed(4),
      taxAdviceFalsePositiveRate: +(fp / Math.max(1, n2 - advice)).toFixed(4),
      taxAdviceMissRate: advice ? +(fn / advice).toFixed(4) : null,
      wrong,
    };
  }
  await mock?.close();

  const acc = rows.filter((r) => r.got === r.expect).length / Math.max(1, rows.length);
  const recall = (o: string) => {
    const xs = rows.filter((r) => r.expect === o);
    return xs.length ? xs.filter((r) => r.got === o).length / xs.length : null;
  };
  const confusion: Record<string, Record<string, number>> = {};
  for (const r of rows) ((confusion[r.expect] ??= {})[r.got] = (confusion[r.expect]![r.got] ?? 0) + 1);
  const result = {
    mode,
    model: decider.model,
    resolvedModels: [...resolved],
    bundle: BUNDLE,
    bundleDigest: b.digest,
    corpus: 'l0-corpus screenCorpus(20, 7) — 합성',
    generatedAt: new Date().toISOString(),
    n: rows.length,
    templates: { sampled: new Set(picked.slice(0, rows.length).map((p) => p.s.id.split('.')[1])).size, total: new Set(all.map((s) => s.id.split('.')[1])).size },
    stoppedByCostCap: stopped,
    accuracy: +acc.toFixed(4),
    recall: { blocked: recall('blocked'), captcha: recall('captcha') },
    pass: acc >= PASS && (recall('blocked') ?? 1) >= RECALL && (recall('captcha') ?? 1) >= RECALL,
    latencyMs: { p50: pct(rows.map((r) => r.ms), 50), p95: pct(rows.map((r) => r.ms), 95) },
    inputTokensAvg: Math.round(rows.reduce((a, r) => a + r.inputTokens, 0) / Math.max(1, rows.length)),
    costUsd: +cost.toFixed(5),
    perQuestion: Object.fromEntries([...perQ].map(([k, v]) => [k, +(v.ok / v.n).toFixed(4)])),
    confusion,
    misses: rows.filter((r) => r.got !== r.expect).slice(0, 30).map(({ answers: _a, labels: _l, ...x }) => x),
    ...(withAnswers ? { rows } : {}),
    intent,
  };
  const out = outArg ?? fileURLToPath(new URL(`../reports/raw/s7-${mode}.json`, import.meta.url));
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`S7 ${mode}: n=${result.n} accuracy=${result.accuracy} blocked=${result.recall.blocked} captcha=${result.recall.captcha} p50=${result.latencyMs.p50}ms p95=${result.latencyMs.p95}ms tokens=${result.inputTokensAvg} cost=$${result.costUsd} pass=${result.pass} models=${result.resolvedModels.join(",")}`);
  if (intent) console.log(`intent_route_v1: n=${intent.n} playbook=${intent.playbookAccuracy} taxAdviceFP=${intent.taxAdviceFalsePositiveRate} taxAdviceMiss=${intent.taxAdviceMissRate}`);
  console.log(`→ ${out}`);
  if (gate && !result.pass) process.exit(1);
}

await main();
