// S7 회귀 세트(D04 §9, D14 M3-7): screen_state_v2 결과 라벨 정확도(통과 98%+), blocked·captcha 재현율(99%+),
// 질문별 정확도, 지연 p50/p95, 판정당 입력 토큰. 번들 버전을 올릴 때마다 돌리고 정확도 98% 미만이면 배포 금지.
//   node --conditions=development scripts/s7-regression.ts [--mock] [--n=100] [--gate] [--model=openai/gpt-6-luna] [--intent=N] [--out=/abs/path.json]
// 코퍼스: tests/fixtures/l0-corpus.ts의 화면 라벨 코퍼스(합성, PoC-3 이후 홈택스 실화면 라벨 100장으로 바꾼다).
// 입력 경로는 제품과 같다: 관측 노드 → A11yNode 트리 → Redactor.applyTree(절단·마스킹·구분자) → decide().
// 키 우선순위(2026-11-05 yulmu): OPENROUTER_API_KEY → OpenRouter(OpenAI 호환 Chat Completions, @sax/net/demo DemoEgress,
// 측정 전용 'initial' 프로필), 없으면 OPENAI_API_KEY → BYOK Decisions, 둘 다 없으면 모의 서버. 비용 상한은 회차당 $2.
// 키·응답 원문은 어디에도 남기지 않는다(결과 JSON은 표본 ID·라벨·결과·수치만). 실행: set -a; . ./.env.local; set +a; pnpm s7
// 실측일 때만 intent_route_v1 구어 코퍼스(300문장+)도 돌려 플레이북 정확도와 mentions_tax_advice 오탐·누락률을 잰다(D04 §3, M6-11).
// 모의 서버는 의도 답을 흉내 내지 않으므로 모의 모드에서는 건너뛴다. 배포 게이트는 screen_state_v2만 본다(D04 §9).
import fs from 'node:fs';
import { BundleCatalog, DefaultModelLayer, OpenAICompatDecideAdapter, OpenAIDecisionsAdapter, ThresholdProfiles, evaluateMapping, localRunToken, statesOf, type BundleAnswers, type DecideAdapter, type Usage } from '@sax/model';
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
/** 의도 코퍼스 표본 수 상한(기본 전부). 시험 실행을 싸게 할 때만 줄인다. */
const intentN = Number(process.argv.find((a) => a.startsWith('--intent='))?.slice(9) ?? Infinity);
const orKey = forceMock ? undefined : process.env.OPENROUTER_API_KEY || undefined;
const apiKey = forceMock || orKey ? undefined : process.env.OPENAI_API_KEY || undefined;
const mode: 'openrouter' | 'live' | 'mock' = orKey ? 'openrouter' : apiKey ? 'live' : 'mock';
const compatModel = process.argv.find((a) => a.startsWith('--model='))?.slice(8) ?? 'openai/gpt-6-luna';
const COST_CAP = 2;
const PASS = 0.98;
const RECALL = 0.99;

/** 100만 토큰당 달러(입력, 캐시 입력, 캐시 쓰기, 출력). OpenRouter 가격은 2026-11-05 /api/v1/models 기준. */
const PRICES: Record<string, [number, number, number, number]> = {
  'gpt-6-luna': [0.1, 0.01, 0.125, 0.5],
  'openai/gpt-6-luna': [0.1, 0.1, 0.1, 0.5],
  'upstage/solar-pro4': [0.15, 0.15, 0.15, 0.6],
  'upstage/solar-mini4': [0.05, 0.05, 0.05, 0.2],
};
/** 모르는 모델은 비싸게 잡아 상한이 먼저 걸리게 한다. */
const priceOf = (m: string) => PRICES[m] ?? PRICES[m.replace(/-\d{4}-\d{2}-\d{2}$/, '')] ?? [10, 10, 10, 50];
const costOf = (m: string, u: Usage) => {
  const [i, c, w, o] = priceOf(m);
  return ((u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * i + u.cachedTokens * c + u.cacheWriteTokens * w + u.outputTokens * o) / 1e6;
};

/** 관측 노드(엔진 L0 모양) → 마스킹 계층 입력 트리. dialog 아래 노드는 대화상자 자식으로 묶는다. */
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

/** 라벨 → 이상적 답 → 로컬 매핑 결과(정답 결과 라벨). */
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

/** 키별 목록을 번갈아 하나씩 꺼낸다(키 첫 등장 순서 유지). */
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
    // 학습·보관하지 않는 공급사로만 라우팅(data_collection: deny). 모델이 스스로 적은 확률이라 번들 기본 임계값('initial')으로 본다.
    decider = new OpenAICompatDecideAdapter({ transport: demo, apiKey: orKey!, model: compatModel, extraBody: { provider: { data_collection: 'deny' } } });
    profiles = new ThresholdProfiles([...base.items, ...catalog.list().map((x) => ({ bundle: x.wireId, bundleDigest: x.digest, provider: 'openai_compat' as const, model: compatModel, status: 'initial' as const, overrides: [] }))]);
  } else {
    egress = new Egress({ ...guard, ...(mock ? { testOrigins: { openai: mock.origin } } : {}) });
    decider = new OpenAIDecisionsAdapter({ apiKey: apiKey ?? 'sk-mock', egress });
  }
  const layer = new DefaultModelLayer({ catalog, profiles, decider });
  const b = layer.bundle(BUNDLE)!;

  // 결과 라벨별로 고르게(기본 100장): blocked·captcha가 빠지지 않게 라운드 로빈. 결과 칸 안에서도 템플릿별로
  // 번갈아 놓아(ss.<템플릿>.<i>), 같은 결과를 내는 뒤쪽 템플릿이 앞 템플릿에 밀려 빠지지 않게 한다.
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

  const rows: Array<{ id: string; expect: string; got: string; reason?: string; ms: number; inputTokens: number }> = [];
  const perQ = new Map<string, { n: number; ok: number }>();
  let cost = 0;
  let stopped = false;
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
    rows.push({ id: s.id, expect, got: r.outcome, ...(r.reason ? { reason: r.reason } : {}), ms, inputTokens: r.usage.inputTokens });
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
  // 의도 라우팅(실측만)
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
    bundle: BUNDLE,
    bundleDigest: b.digest,
    corpus: 'l0-corpus screenCorpus(20, 7) — 합성',
    generatedAt: new Date().toISOString(),
    n: rows.length,
    // 표본이 덮은 템플릿 수 / 이 번들 코퍼스의 템플릿 수(뒤쪽 템플릿이 빠지지 않았는지)
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
    misses: rows.filter((r) => r.got !== r.expect).slice(0, 30),
    intent,
  };
  const out = outArg ?? fileURLToPath(new URL(`../reports/raw/s7-${mode}.json`, import.meta.url));
  fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`S7 ${mode}: n=${result.n} accuracy=${result.accuracy} blocked=${result.recall.blocked} captcha=${result.recall.captcha} p50=${result.latencyMs.p50}ms p95=${result.latencyMs.p95}ms tokens=${result.inputTokensAvg} cost=$${result.costUsd} pass=${result.pass}`);
  if (intent) console.log(`intent_route_v1: n=${intent.n} playbook=${intent.playbookAccuracy} taxAdviceFP=${intent.taxAdviceFalsePositiveRate} taxAdviceMiss=${intent.taxAdviceMissRate}`);
  console.log(`→ ${out}`);
  if (gate && !result.pass) process.exit(1);
}

await main();
