import fs from 'node:fs';
import {
  BundleCatalog,
  DefaultModelLayer,
  OpenAIDecisionsAdapter,
  OpenAIResponsesAdapter,
  ThresholdProfiles,
  computeDigest,
  evaluateMapping,
  localRunToken,
  selectorRepair,
  statesOf,
  validateBundle,
  wireIdOf,
  type BundleDef,
  type LoadedBundle,
  type ProviderDecision,
  type RedactedText,
  type Usage,
} from '@sax/model';
import { Egress } from '@sax/net';
import { Redactor, apply } from '@sax/redaction';
import { startOpenAIMock } from '../tests/fixtures/openai-mock.ts';
import { S9_SCREENS } from '../tests/fixtures/s9-screens.ts';

const forceMock = process.argv.includes('--mock');
const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice(6);
const reps = Number(process.argv.find((a) => a.startsWith('--reps='))?.slice(7) ?? 10);
const apiKey = forceMock ? undefined : process.env.OPENAI_API_KEY || undefined;
const mode: 'live' | 'mock' = apiKey ? 'live' : 'mock';
const COST_CAP = 2;
const COST_ABORT = 1.5;
const MAX_CALLS = 150;

const PRICE = { luna: { in: 0.1, cached: 0.01, write: 0.125 }, terra: { in: 1, cached: 0.05, write: 1.25, out: 5 } };
const lunaCost = (u: Usage) => ((u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * PRICE.luna.in + u.cachedTokens * PRICE.luna.cached + u.cacheWriteTokens * PRICE.luna.write) / 1e6;
const terraCost = (u: Usage) => ((u.inputTokens - u.cachedTokens - u.cacheWriteTokens) * PRICE.terra.in + u.cachedTokens * PRICE.terra.cached + u.cacheWriteTokens * PRICE.terra.write + u.outputTokens * PRICE.terra.out) / 1e6;

const catalog = BundleCatalog.load();
const ss = catalog.get('screen_state_v2')!;

function probe(id: string, count: number): LoadedBundle {
  const names = ['has_logout_link', 'has_heading', 'has_textbox', 'has_button', 'has_table', 'has_dialog', 'has_image', 'mentions_date', 'mentions_amount_token', 'mentions_name_token'];
  const def: BundleDef = {
    id,
    version: 1,
    digest: '',
    riskClass: 'general',
    outcomes: [
      { name: 'seen', kind: 'progress' },
      { name: 'unknown', kind: 'unknown' },
    ],
    maxInputBytes: 6144,
    prefix: { stringsKey: 'screen_state', minTokens: 1024 },
    questions: names.slice(0, count).map((n) => ({ type: 'predicate' as const, name: n, instructions: `화면에 ${n.replace(/_/g, ' ')} 신호가 보인다.`, onRefusal: 'unknown' as const })),
    mapping: [{ outcome: 'seen', when: { all: [{ predicate: names[0]!, gte: 0.85 }] } }, { outcome: 'unknown', when: 'always' }],
    reservedOutcomes: [],
  };
  def.digest = computeDigest(def, ss.prefixText);
  const v = validateBundle(def, ss.prefixText, null);
  if (v.length) throw new Error(`probe ${id}: ${JSON.stringify(v)}`);
  return { def, wireId: wireIdOf(def), digest: def.digest, prefixText: ss.prefixText };
}
const PROBES = [probe('probe_two', 2), probe('probe_five', 5), probe('probe_ten', 10)];

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? +s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!.toFixed(1) : null;
};

async function main() {
  const planned = 3 + S9_SCREENS.length + PROBES.length * reps + 3;
  const estimate = (planned - 3) * 4000 * PRICE.luna.write / 1e6 + 3 * (8000 * PRICE.terra.in + 16000 * PRICE.terra.out) / 1e6;
  if (planned > MAX_CALLS || estimate > COST_CAP) throw new Error(`계획 호출 ${planned}회, 추정 $${estimate.toFixed(3)}: 상한 초과`);
  console.log(`S9 mode=${mode} planned=${planned} estimate≤$${estimate.toFixed(3)}`);

  const mock = mode === 'mock' ? await startOpenAIMock() : null;
  const egress = new Egress({
    ...(mock ? { testOrigins: { openai: mock.origin } } : {}),
    timeoutMs: 30_000,
    modelGuard: { bundles: [...catalog.allowEntries(), ...PROBES.map((p) => ({ id: p.wireId, digest: p.digest, maxInputBytes: p.def.maxInputBytes }))] },
  });
  const key = apiKey ?? 'sk-mock-not-a-key';
  const decider = new OpenAIDecisionsAdapter({ apiKey: key, egress });
  const layer = new DefaultModelLayer({ catalog, profiles: ThresholdProfiles.load(), decider });
  const responder = new OpenAIResponsesAdapter({ apiKey: key, egress });
  let cost = 0;
  let calls = 0;
  const errors: string[] = [];
  const guard = () => {
    if (cost > COST_ABORT) throw new Error(`누적 비용 $${cost.toFixed(4)} > $${COST_ABORT}: 중단`);
    if (++calls > MAX_CALLS) throw new Error('호출 상한 초과');
  };
  const call = async (b: LoadedBundle, input: RedactedText): Promise<ProviderDecision | null> => {
    guard();
    try {
      const r = await decider.call(b, input, localRunToken(egress, { runId: `s9-${calls}` }));
      cost += lunaCost(r.usage);
      return r;
    } catch (e) {
      errors.push(`${b.wireId}: ${(e as Error).message}`);
      return null;
    }
  };
  const redactor = new Redactor({ runId: 's9' });

  const cache = [];
  for (const s of S9_SCREENS.slice(0, 3)) {
    const r = await call(ss, redactor.apply(s.text).redacted);
    cache.push(r ? { screen: s.id, ...r.usage, latencyMs: +r.latencyMs.toFixed(1) } : { screen: s.id, error: true });
  }

  const refusal = [];
  const choiceDist: Array<{ screen: string; question: string; choices: number; probabilities: number; full: boolean }> = [];
  for (const s of S9_SCREENS) {
    const input = redactor.apply(s.text).redacted;
    const r = await call(ss, input);
    if (!r) continue;
    const n = decider.normalize(ss, r);
    const def = layer.effectiveDef(ss);
    const res = n.ok && typeof def !== 'string' ? evaluateMapping(def, statesOf(def, n.answers)) : null;
    if (n.ok) {
      for (const [q, a] of Object.entries(n.answers)) if (a.type === 'choice') choiceDist.push({ screen: s.id, question: q, choices: (ss.def.questions.find((x) => x.name === q) as { choices: unknown[] }).choices.length, probabilities: Object.keys(a.probabilities).length, full: a.fullDistribution });
    }
    refusal.push({ screen: s.id, probe: s.probe, refusals: n.ok ? n.refusals : [`normalize:${n.reason}`], outcome: res?.outcome ?? null, coreRefusal: res?.coreRefusal ?? null });
  }

  const latency = [];
  for (const p of PROBES) {
    const ms: number[] = [];
    for (let i = 0; i < reps; i++) {
      const r = await call(p, redactor.apply(S9_SCREENS[i % S9_SCREENS.length]!.text).redacted);
      if (r) ms.push(r.latencyMs);
    }
    latency.push({ questions: p.def.questions.length, n: ms.length, p50: pct(ms, 50), p95: pct(ms, 95), max: ms.length ? +Math.max(...ms).toFixed(1) : null });
  }

  const ts = selectorRepair(['form.counterpart']);
  const runToken = localRunToken(egress, { runId: 's9-replay' });
  const msg = { role: 'user' as const, content: [{ type: 'input_text' as const, text: apply('스텝 s12(fill, 기대 역할 textbox, 이름 패턴 ^공급받는자 등록번호$)의 셀렉터 후보 3개가 모두 실패했다. 서브트리를 읽고 후보를 제안하라.', { runId: 's9' }, { frame: 'none' }).redacted }] };
  const sub = apply('region "공급받는자"\n  textbox "공급받는자 사업자등록번호"(required)\n  textbox "상호"(required)\n  button "조회"', { runId: 's9' }).redacted;
  const turns: Array<Record<string, unknown>> = [];
  let replayItems: Parameters<typeof responder.respond>[1]['replay'] = [];
  for (let turn = 1; turn <= 3; turn++) {
    guard();
    let t: Awaited<ReturnType<typeof responder.respond>>;
    try {
      t = await responder.respond(ts, { toolset: 'selector_repair', messages: [msg], replay: replayItems, runToken });
    } catch (e) {
      turns.push({ turn, status: 'error', reason: (e as Error).message.slice(0, 200), toolCalls: [], replayItems: [], encryptedReasoning: false, output: null, usage: null });
      errors.push(`selector_repair turn ${turn}: ${(e as Error).message}`);
      break;
    }
    cost += terraCost(t.usage);
    turns.push({
      turn,
      status: t.status,
      reason: t.reason ?? null,
      toolCalls: t.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments })),
      replayItems: t.replay.map((r) => (r.kind === 'model_output' ? (r.item.item as { type?: string }).type : r.kind)),
      encryptedReasoning: t.replay.some((r) => r.kind === 'model_output' && typeof (r.item.item as { encrypted_content?: unknown }).encrypted_content === 'string'),
      output: t.output ?? null,
      usage: t.usage,
    });
    if (t.status !== 'completed' || t.toolCalls.length === 0) break;
    replayItems = [...replayItems, ...t.replay, ...t.toolCalls.map((c) => ({ kind: 'function_call_output' as const, callId: c.callId, output: sub }))];
  }
  const replay = { turns, finalOutput: turns.at(-1)?.output ?? null };

  const audit = egress.modelAudit;
  const rateLimit = { headerNames: [...new Set(audit.flatMap((a) => Object.keys(a.rateLimit)))].sort(), first: audit[0]?.rateLimit ?? null, last: audit.at(-1)?.rateLimit ?? null, statuses: audit.reduce<Record<string, number>>((m, a) => ((m[String(a.status)] = (m[String(a.status)] ?? 0) + 1), m), {}) };

  const refusalByQuestion: Record<string, number> = {};
  for (const r of refusal) for (const q of r.refusals) refusalByQuestion[q] = (refusalByQuestion[q] ?? 0) + 1;
  const out = {
    mode,
    note: mode === 'mock' ? '실호출 미실행(OPENAI_API_KEY 없음). 수치는 모의 서버의 합성 응답이며 측정값이 아니다.' : '실호출',
    runAt: new Date().toISOString(),
    sdk: 'openai@7.45.1',
    models: { decisions: decider.model, responses: responder.model },
    calls: { http: audit.length, decisionsLogical: calls, costUsd: +cost.toFixed(5), costCapUsd: COST_CAP },
    cache,
    promptCacheKeyFormat: { used: 'sax:b:<bundleWireId>', accepted: !errors.some((e) => /prompt_cache_key/.test(e)) },
    refusal: { screens: refusal.length, byQuestion: refusalByQuestion, rows: refusal },
    choiceDistribution: { observations: choiceDist.length, fullCount: choiceDist.filter((c) => c.full).length, rows: choiceDist.slice(0, 40) },
    latency,
    rateLimit,
    replay,
    errors,
  };
  const file = outArg ? new URL(`file://${outArg}`) : new URL(`../reports/raw/s9-${mode}.json`, import.meta.url);
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify({ mode, http: audit.length, costUsd: out.calls.costUsd, cache: cache.map((c) => ('cachedTokens' in c ? [c.cachedTokens, c.cacheWriteTokens] : 'err')), refusalByQuestion, latency, full: `${out.choiceDistribution.fullCount}/${out.choiceDistribution.observations}`, replay: turns.map((t) => `${t.status}${(t.toolCalls as unknown[] | undefined)?.length ? '+tool' : ''}`), errors: errors.length }, null, 1));
  await mock?.close();
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
