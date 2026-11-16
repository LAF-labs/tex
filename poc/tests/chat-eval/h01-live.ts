// H-01 발급 사다리 0원 칸 실모델 예행(가짜 홈택스 + 제품 H-01 패키지). 제품 패키지 그대로 결정적 스크립트(hometax.auto)를 돌리고,
// 선택자가 어긋난 화면에서 실제 모델이 고치는지 본다. 게이트웨이 자리는 이 파일이 맡아 게이트웨이와 같은 본문(openAIResponsesBody)과
// 같은 공급자 규칙으로 OpenRouter에 보낸다: 위치 찾기(selector_repair)는 응답 모델 + 공급자 고정, 판정·에이전트(page_judge·browser_agent)는
// 에이전트 모델(기본 typesafe/jev-router) + 고정 없음.
//   set -a; . ./.env.local; set +a
//   EVAL_MODEL=deepseek/deepseek-v4.1-flash-1017 EVAL_PROVIDERS=crusoe/fp8 node --conditions=development tests/chat-eval/h01-live.ts [--only=script,repair,agent] [--runs=1]
// 시나리오
//   script: 어긋남 없음. 모델 0번으로 끝까지 가야 한다(결정적 스크립트).
//   repair: 품목명 칸 id가 어긋남. 위치 찾기(실모델)로 고쳐 끝까지.
//   agent:  같은 어긋남 + 위치 찾기는 못 찾음으로 막음. 판정(jev) → 브라우저 에이전트(jev)로 넘겨 끝까지.
// 키·화면 원문은 남기지 않는다. 출력은 시나리오별 결과·걸린 시간·툴셋별 호출 수·마지막 오류 코드뿐이다.
import type { LocateResponder } from '@sax/engine';
import type { PackageFiles } from '@sax/engine/core';
import { toolsetPrefix, type RespondRequest, type RespondResult, type ToolsetDef } from '@sax/model';
import { openAIResponsesBody } from '../../services/gateway/src/providers.ts';
import { realDryRun, type Outcome } from '../h01-real-dryrun.ts';

const KEY = process.env.OPENROUTER_API_KEY ?? '';
const MODEL = process.env.EVAL_MODEL ?? 'deepseek/deepseek-v4.1-flash-1017';
const AGENT_MODEL = process.env.EVAL_AGENT_MODEL ?? 'typesafe/jev-router';
const ONLY_PROVIDERS = (process.env.EVAL_PROVIDERS ?? '').split(',').filter(Boolean);
/** 판정·에이전트 보관 조건(게이트웨이 OPENROUTER_AGENT_PRIVACY와 같은 뜻): off·deny·zdr */
const AGENT_PRIVACY = process.env.EVAL_AGENT_PRIVACY ?? 'off';
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const ONLY = (arg('only') ?? 'script,repair,agent').split(',');
const RUNS = Number(arg('runs') ?? 1);
const AGENTS = new Set(['page_judge', 'browser_agent']);
if (!KEY) {
  console.error('OPENROUTER_API_KEY가 필요합니다.');
  process.exit(2);
}

const ITEM = 'hometax.invoice.form.item1.name';
const drift = (files: PackageFiles) => {
  files.selectors.entries[ITEM]!.candidates = [{ kind: 'css', value: '#mf_txppWframe_genEtxivLsatTop_0_edtLsatNmTopOld' }];
};

type Call = { toolset: string; ms: number; ok: boolean; why?: string };
function live(block: Set<string> = new Set()): LocateResponder & { calls: Call[] } {
  const calls: Call[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
  const fail = (reason: string): RespondResult => ({ status: 'incomplete', toolCalls: [], replay: [], usage, reason }) as RespondResult;
  return {
    calls,
    async respond(t: ToolsetDef, req: RespondRequest): Promise<RespondResult> {
      const started = Date.now();
      const done = (r: RespondResult, why?: string) => (calls.push({ toolset: t.id, ms: Date.now() - started, ok: r.status === 'completed', ...(why ? { why } : {}) }), r);
      if (block.has(t.id)) return done({ status: 'completed', output: { outcome: 'not_found', risk_flags: [], candidates: [] }, toolCalls: [], replay: [], usage } as never, 'blocked');
      const agent = AGENTS.has(t.id);
      const input = [...req.messages, ...req.replay.map((r) => (r.kind === 'model_output' ? r.item.item : { type: 'function_call_output', call_id: r.callId, output: r.output }))];
      const body: Record<string, unknown> = openAIResponsesBody({ model: agent ? AGENT_MODEL : MODEL, prefix: toolsetPrefix(t), effort: t.effort, maxOutputTokens: t.maxOutputTokens, tools: t.tools, output: t.output, input, cacheKey: `h01-live:${t.id}`, safetyId: 'h01-live' });
      if (!agent) body.provider = { zdr: true, data_collection: 'deny', ...(ONLY_PROVIDERS.length ? { only: ONLY_PROVIDERS } : {}), allow_fallbacks: false, require_parameters: true };
      else if (AGENT_PRIVACY === 'zdr') body.provider = { zdr: true, data_collection: 'deny' };
      else if (AGENT_PRIVACY === 'deny') body.provider = { data_collection: 'deny' };
      let d: { status?: string; output?: Array<Record<string, unknown>>; provider?: string };
      try {
        const res = await fetch('https://openrouter.ai/api/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(agent ? 50_000 : 30_000) });
        if (res.status !== 200) return done(fail(`http_${res.status}`), `http_${res.status}`);
        d = (await res.json()) as typeof d;
      } catch (e) {
        return done(fail('fetch'), (e as Error).name);
      }
      const items = d.output ?? [];
      const toolCalls: RespondResult['toolCalls'] = [];
      let output: unknown;
      for (const it of items) {
        if (it.type === 'function_call') {
          try {
            toolCalls.push({ callId: String(it.call_id), name: String(it.name), arguments: JSON.parse(String(it.arguments)) });
          } catch {
            return done(fail('tool_call_rejected'), 'bad_args');
          }
        } else if (it.type === 'message') {
          for (const c of (it.content as Array<Record<string, unknown>>) ?? []) {
            if (c.type !== 'output_text') continue;
            try {
              output = JSON.parse(String(c.text));
            } catch {
              return done(fail('output_schema_mismatch'), 'bad_json');
            }
          }
        }
      }
      if (d.status !== 'completed') return done(fail('provider_incomplete'), `status_${d.status}`);
      const replay = items.map((item) => ({ kind: 'model_output' as const, item: { item, tag: 'live' } })) as unknown as RespondResult['replay'];
      return done({ status: 'completed', output, toolCalls, replay, usage } as RespondResult, d.provider ? `via:${d.provider}` : undefined);
    },
  };
}

const SCENARIOS: Record<string, () => { patchIssue?: (f: PackageFiles) => void; g: ReturnType<typeof live> }> = {
  script: () => ({ g: live() }),
  repair: () => ({ patchIssue: drift, g: live() }),
  agent: () => ({ patchIssue: drift, g: live(new Set(['selector_repair'])) }),
};

const summary = (o: Outcome) => `${o.end?.status ?? 'none'}/${o.end?.code ?? ''}`;
const results: Array<Record<string, unknown>> = [];
for (const name of ONLY) {
  for (let i = 0; i < RUNS; i++) {
    const { patchIssue, g } = SCENARIOS[name]!();
    const t0 = Date.now();
    let o: Outcome | null = null;
    let err: string | null = null;
    try {
      o = await realDryRun({ loggedIn: true, locate: g, maxMs: 300_000, ...(patchIssue ? { patchIssue } : {}) });
    } catch (e) {
      err = (e as Error).message.slice(0, 200);
    }
    const ok = o?.end?.status === 'success' && (name !== 'script' || g.calls.length === 0);
    const r = {
      scenario: name, run: i + 1, ok, end: o ? summary(o) : `error:${err}`, ms: Date.now() - t0,
      calls: g.calls.map((c) => `${c.toolset}:${c.ok ? 'ok' : 'x'}:${c.ms}ms${c.why ? `:${c.why}` : ''}`),
      journal: o?.journal.filter((j) => /locate|heal|judge|agent|fallback|retry|selector/.test(j)) ?? [],
    };
    results.push(r);
    console.log(JSON.stringify(r));
  }
}
const pass = results.filter((r) => r.ok).length;
console.log(`통과 ${pass}/${results.length} (응답 모델 ${MODEL}${ONLY_PROVIDERS.length ? ` @ ${ONLY_PROVIDERS.join(',')}` : ''}, 에이전트 ${AGENT_MODEL}, 보관 ${AGENT_PRIVACY})`);
process.exit(0);
