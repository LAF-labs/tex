// 발급 사다리 실모델 예행(가짜 홈택스 + 제품 H-01 패키지 + 실제 게이트웨이 코드 + OpenRouter 실호출). 실제 홈택스에 접속하지 않는다.
// 한 번에 한 경우·한 번만 돌리고 칸마다 호출 기록(모델·공급사·시간·토큰·출력)을 남긴다: 로그를 보고 고친 뒤 다시 돌린다(대표 2026-11-16 "한두 번 해 보고 로그 확인").
//
// 키: OPENROUTER_API_KEY(환경 변수로만, 출력하지 않는다). 모델: MODEL_RESPOND(위치 찾기), MODEL_AGENT(판정·에이전트), MODEL_VISION(화면 보기).
// OPENROUTER_ZDR=true·OPENROUTER_DATA_COLLECTION=deny·OPENROUTER_PROVIDERS가 있으면 운영처럼 위치 찾기를 공급자 고정한다. 없으면 모두 고정 없이.
//
//   node --conditions=development tests/ladder-live/run.ts --case=drift-judge --out=/tmp/ladder-live.json
//
// 경우(--case):
//   script       어긋남 없음. 모델 호출 0이어야 한다(스크립트 단독).
//   drift        품목명 칸 id가 바뀜. 위치 찾기(MODEL_RESPOND) 칸이 고쳐야 한다.
//   drift-judge  같은 어긋남, 위치 찾기 끔. 판정 → 에이전트(MODEL_AGENT) 칸이 고쳐야 한다.
//   drift-vision 같은 어긋남, 위치 찾기·에이전트 끔. 판정 → 화면 보기(MODEL_VISION) 칸.
// --off=toolset,... 로 칸을 더 끌 수 있다.
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import type { LocateResponder } from '@sax/engine';
import type { PackageFiles } from '@sax/engine/core';
import { BundleCatalog, OpenAIResponsesAdapter, type Egress, type RespondRequest, type ToolsetDef } from '../../packages/model/src/index.ts';
import { migrate, openSqlite } from '../../services/shared/src/index.ts';
import { GatewayService, MIGRATIONS_DIR, MockNtsSource, OpenRouterProvider, parseAgentPrivacy, parseOpenRouterRouting, type ModelProvider } from '../../services/gateway/src/index.ts';
import { defaultHuman, realDryRun } from '../h01-real-dryrun.ts';

const arg = (k: string, d = '') => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const CASE = arg('case', 'drift');
const OUT = arg('out', '');
const env = process.env;
const KEY = 'hometax.invoice.form.item1.name';
const drift = (files: PackageFiles) => {
  files.selectors.entries[KEY]!.candidates = [{ kind: 'css', value: '#mf_txppWframe_genEtxivLsatTop_0_edtLsatNmTopOld' }];
};
const CASES: Record<string, { patch?: (f: PackageFiles) => void; off: string[] }> = {
  script: { off: [] },
  drift: { patch: drift, off: [] },
  'drift-judge': { patch: drift, off: ['selector_repair'] },
  'drift-vision': { patch: drift, off: ['selector_repair', 'browser_agent'] },
};
const c = CASES[CASE];
if (!c) throw new Error(`모르는 경우: ${CASE} (${Object.keys(CASES).join(', ')})`);
const off = new Set([...c.off, ...arg('off').split(',').filter(Boolean)]);
if (!env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY 없음');

interface Upstream { model: string; provider: string | null; status: number; ms: number; usage: unknown; cost: number | null }
const upstream: Upstream[] = [];
const fetchFn: typeof fetch = async (url, init) => {
  const t = Date.now();
  const res = await fetch(url, init);
  const body = await res.clone().text();
  let d: Record<string, unknown> = {};
  try {
    d = JSON.parse(body) as Record<string, unknown>;
  } catch {
    /* 오류 본문 */
  }
  const u = d.usage as { cost?: number } | undefined;
  upstream.push({ model: String(d.model ?? ''), provider: typeof d.provider === 'string' ? d.provider : null, status: res.status, ms: Date.now() - t, usage: d.usage ?? null, cost: typeof u?.cost === 'number' ? u.cost : null });
  if (res.status !== 200) console.log(`  상류 ${res.status}: ${body.slice(0, 300)}`);
  return res;
};

const routing = parseOpenRouterRouting(env);
const inner = new OpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY, routing: routing ?? { zdr: true, dataCollection: 'deny', only: ['unused'] }, fetchFn, ...(env.EVAL_OPENROUTER_BASE_URL ? { baseUrl: env.EVAL_OPENROUTER_BASE_URL } : {}), agentPrivacy: parseAgentPrivacy(env.OPENROUTER_AGENT_PRIVACY) ?? 'off', timeoutMs: 50_000 });
const provider: ModelProvider = { name: 'openrouter-live', decide: (s) => inner.decide(s), respond: (s) => inner.respond(routing ? s : { ...s, unpinned: true }) } as ModelProvider;

const db = openSqlite();
await migrate(db, 'gateway', MIGRATIONS_DIR);
const k32 = () => randomBytes(32);
const models = { decide: 'unused', respond: env.MODEL_RESPOND ?? 'deepseek/deepseek-v4.1-flash-1017', ...(env.MODEL_AGENT ? { agent: env.MODEL_AGENT } : {}), ...(env.MODEL_VISION ? { vision: env.MODEL_VISION } : {}) };
const svc = new GatewayService({ db, provider, catalog: BundleCatalog.load(), runKey: generateKeyPairSync('ed25519').privateKey, cacheSecret: k32(), sidKey: k32(), tagKey: k32(), scopeKey: k32(), models, nts: new MockNtsSource(), daily: { trialKrw: 100_000, paidKrw: 100_000, krwPerUsd: 1400 } });
const who = { acc: 'acc-ladder-live', dev: 'dev-ladder-live', tier: 'paid' as const };
const tokens = new Map<string, string>();
const egress = {
  toGateway: async ({ body }: { body: unknown }) => {
    try {
      return await svc.respond(who, body);
    } catch (e) {
      const code = (e as { code?: string }).code ?? String(e);
      console.log(`  게이트웨이 거부: ${code}`);
      throw e;
    }
  },
} as unknown as Egress;
const adapter = new OpenAIResponsesAdapter({ transport: 'gateway', egress });

interface Call { n: number; toolset: string; ms: number; status: string; reason?: string; output?: unknown; toolCalls?: number; usage: unknown }
const calls: Call[] = [];
const live: LocateResponder = {
  async respond(t: ToolsetDef, req: RespondRequest) {
    const n = calls.length + 1;
    if (off.has(t.id)) {
      calls.push({ n, toolset: t.id, ms: 0, status: 'off', usage: null });
      return { status: 'incomplete', toolCalls: [], replay: [], usage: { inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, reason: 'eval:off' } as never;
    }
    let rt = tokens.get(req.runToken);
    if (!rt) tokens.set(req.runToken, (rt = (await svc.issueRunToken(who, { runId: `run-${randomBytes(6).toString('hex')}` })).runToken));
    const t0 = Date.now();
    const r = await adapter.respond(t, { ...req, runToken: rt as never });
    const call: Call = { n, toolset: t.id, ms: Date.now() - t0, status: r.status, ...(r.reason ? { reason: r.reason } : {}), output: r.output, toolCalls: r.toolCalls.length, usage: r.usage };
    calls.push(call);
    console.log(`  #${n} ${t.id} ${call.ms}ms ${r.status}${r.reason ? `(${r.reason})` : ''} ${JSON.stringify(r.output ?? null).slice(0, 400)}`);
    return r;
  },
};

console.log(`경우 ${CASE} · 끈 칸 [${[...off].join(',')}] · 위치 찾기 ${models.respond} · 판정·에이전트 ${models.agent ?? '(기본 typesafe/jev-router)'} · 화면 보기 ${models.vision ?? '(=에이전트)'} · 공급자 고정 ${routing ? 'on' : 'off'}`);
const t0 = Date.now();
const o = await realDryRun({ loggedIn: true, human: defaultHuman, maxMs: 600_000, handoffCapMs: Number(arg('handoff-cap-ms', '30000')), locate: live, ...(c.patch ? { patchIssue: c.patch } : {}) });
const ms = Date.now() - t0;
const LADDER = /^(locate|fallback|judge|heal|agentpath|agent|computer_use|page_judge|browser_agent|selector_repair|ai)\./;
const report = {
  case: CASE,
  off: [...off],
  models,
  pinned: !!routing,
  ms,
  end: { status: o.end?.status, code: o.end?.code, approvalNo: o.end?.approvalNo ?? null },
  steps: o.steps,
  ladderJournal: o.journal.filter((j) => LADDER.test(j)),
  calls,
  upstream,
  costUsd: upstream.reduce((a, u) => a + (u.cost ?? 0), 0),
};
console.log(`\n결과 ${report.end.status}${report.end.code ? `/${report.end.code}` : ''} · ${Math.round(ms / 1000)}초 · 모델 호출 ${calls.filter((x) => x.status !== 'off').length}번 · 비용 $${report.costUsd.toFixed(4)}`);
console.log(`사다리 저널: ${report.ladderJournal.join(', ')}`);
console.log(`상류: ${upstream.map((u) => `${u.model}@${u.provider ?? '?'} ${u.status} ${u.ms}ms`).join(' | ')}`);
console.log(`스텝: ${o.steps.join(' ')}`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
process.exit(0);
