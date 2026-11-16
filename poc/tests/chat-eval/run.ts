// 대화 에이전트 실모델 평가(chat-eval). 엔진 chat.step(마스킹·역치환·답 검사)과 main AgentChat(도구 실행·슬롯 채우기)은 제품 코드 그대로이고,
// 게이트웨이 자리만 이 파일의 작은 서버가 맡아 실제 게이트웨이와 같은 본문(openAIResponsesBody + toolsetPrefix)으로 OpenRouter에 보낸다.
// 채점은 사장님 화면 기준이다: 생긴 카드의 값, 화면 문장, 보인 표, 되묻는 칸(cases.ts).
//   set -a; . ./.env.local; set +a
//   EVAL_MODEL=<OpenRouter 모델 ID> node --conditions=development tests/chat-eval/run.ts [--only=id,id] [--runs=3] [--jobs=4] [--out=/abs/report.json]
// 키가 없으면(--fake) 늘 같은 답을 내는 가짜 상류로 배선만 확인한다.
// 키·응답 원문은 남기지 않는다. 보고서에는 사례 ID·문장(가상 장부)·도구 호출·화면 문장·채점만 들어간다.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CounterpartyRepo, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import { ChatAgent, gatewayChatAgentModel, type DomainCall, type StepParams, type StepResult } from '@sax/engine';
import { BundleCatalog, CHAT_AGENT, toolsetDigest, toolsetPrefix } from '@sax/model';
import { Egress } from '@sax/net';
import { openAIResponsesBody } from '../../services/gateway/src/providers.ts';
import { AgentChat, type AgentTurnResult, type DraftCard, type IssuedRow } from '../../apps/desktop/src/agent-chat.ts';
import { CASES, SEED, TODAY, type Case, type DraftExpect, type TurnExpect } from './cases.ts';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const FAKE = process.argv.includes('--fake');
const KEY = FAKE ? '' : (process.env.OPENROUTER_API_KEY ?? '');
const MODEL = process.env.EVAL_MODEL ?? arg('model') ?? '';
const PROVIDERS = (process.env.EVAL_PROVIDERS ?? process.env.OPENROUTER_PROVIDERS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const RUNS = Number(arg('runs') ?? 1);
const JOBS = Number(arg('jobs') ?? 4);
const ONLY = arg('only')?.split(',');
const OUT = arg('out') ?? path.join(import.meta.dirname, '../../reports/chat-eval/latest.json');
/** 회차당 비용 상한(달러). 한도 단가(DeepSeek 공식 피크)로 센다. */
const COST_CAP = Number(arg('cap') ?? 1);
const PRICE = { in: 0.3, cached: 0.006, out: 1.2 };

if (!FAKE && (!KEY || !MODEL)) {
  console.error('OPENROUTER_API_KEY와 EVAL_MODEL이 필요합니다(배선만 볼 때는 --fake).');
  process.exit(2);
}

// ── 게이트웨이 자리 ──
const usage = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, errors: 0, ms: [] as number[], turnMs: [] as number[], turnCalls: [] as number[] };
const costUsd = () => ((usage.input - usage.cached) * PRICE.in + usage.cached * PRICE.cached + usage.output * PRICE.out) / 1e6;

async function upstream(input: unknown[]): Promise<{ status: string; output: Array<Record<string, unknown>>; provider?: string }> {
  if (process.env.EVAL_DUMP) console.error('INPUT', JSON.stringify(input, (_k, v) => (typeof v === 'string' && v.length > 400 ? `${v.slice(0, 120)}…(${v.length}자)` : v)));
  if (FAKE) return fakeUpstream(input);
  if (costUsd() > COST_CAP) throw new Error('cost_cap');
  const body: Record<string, unknown> = openAIResponsesBody({
    model: MODEL,
    prefix: toolsetPrefix(CHAT_AGENT),
    effort: CHAT_AGENT.effort,
    maxOutputTokens: CHAT_AGENT.maxOutputTokens,
    tools: CHAT_AGENT.tools,
    output: CHAT_AGENT.output,
    input,
    cacheKey: 'chat-eval',
    safetyId: 'chat-eval',
  });
  // 하네스 튜닝 실험용(제품 정의는 그대로): 추론 강도 바꾸기(EVAL_EFFORT=minimal|low|medium|none)
  if (process.env.EVAL_EFFORT) body.reasoning = process.env.EVAL_EFFORT === 'none' ? { enabled: false } : { effort: process.env.EVAL_EFFORT };
  if (PROVIDERS.length) body.provider = { zdr: true, data_collection: 'deny', only: PROVIDERS, allow_fallbacks: false, require_parameters: true };
  const t0 = performance.now();
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://openrouter.ai/api/v1/responses', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => null);
    if (res && res.status === 200) {
      const d = (await res.json()) as { provider?: string; status?: string; output?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } } };
      usage.calls++;
      usage.input += d.usage?.input_tokens ?? 0;
      usage.output += d.usage?.output_tokens ?? 0;
      usage.cached += d.usage?.input_tokens_details?.cached_tokens ?? 0;
      usage.reasoning += d.usage?.output_tokens_details?.reasoning_tokens ?? 0;
      usage.ms.push(performance.now() - t0);
      return { status: String(d.status ?? ''), output: d.output ?? [], provider: String(d.provider ?? '') };
    }
    if (attempt >= 2 || (res && res.status < 500 && res.status !== 429)) {
      usage.errors++;
      const detail = res ? `${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}` : 'network';
      throw new Error(`upstream ${detail}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

/** 배선 확인용 가짜 상류: 이번 문장에 거래처·금액 토큰이 있으면 invoice_draft 한 번, 결과를 받으면 did로 답한다. */
function fakeUpstream(input: unknown[]): { status: string; output: Array<Record<string, unknown>> } {
  const msg = (o: object) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(o) }] }] });
  const last = input.at(-1) as { type?: string; output?: string } | undefined;
  if (last?.type === 'function_call_output') {
    const o = JSON.parse(String(last.output)) as { ref: string | null };
    return msg({ kind: 'did', text: '카드를 만들었어요.', show: o.ref ? [o.ref] : [], ask: null });
  }
  const text = (input[0] as { content: Array<{ text: string }> }).content[0]!.text.split('[지금]').at(-1)!;
  if (process.env.EVAL_DEBUG) console.error(text);
  const name = /\[NAME_\d+\]/.exec(text)?.[0];
  const amt = /\[AMT_\d+\]/.exec(text)?.[0];
  if (!name || !amt) return msg({ kind: 'smalltalk', text: '안녕하세요.', show: [], ask: null });
  return { status: 'completed', output: [{ type: 'function_call', call_id: `call_${randomBytes(3).toString('hex')}`, name: 'invoice_draft', arguments: JSON.stringify({ counterparty: name, amount: amt, vat: null, item: null }) }] };
}

/** 사례마다 따로 띄운다: 도구 결과 흔적(trace)·상류 오류가 동시 실행(--jobs>1) 사례끼리 섞이지 않게. */
async function startGateway(sink: Sink): Promise<{ origin: string; close: () => void }> {
  const digest = toolsetDigest(CHAT_AGENT);
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const send = (status: number, json: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (req.url === '/v1/run-tokens') return send(200, { runToken: `sxr1.${Buffer.from(JSON.stringify(body)).toString('base64url')}.sig`, expiresAt: '2099-01-01T00:00:00Z', budget: { l1: 99, l2: 99 } });
      if (req.url !== '/v1/respond' || body.toolset !== CHAT_AGENT.id) return send(404, {});
      const replay = (body.replay as Array<{ item?: unknown; type?: string; call_id?: string; output?: string }> | undefined) ?? [];
      const input = [...(body.messages as unknown[]), ...replay.map((r) => ('item' in r && r.item ? r.item : { type: 'function_call_output', call_id: r.call_id, output: r.output }))];
      try {
        const r = await upstream(input);
        sink.trace.push({ sent: replay.length, provider: r.provider ?? '', out: r.output.map(brief) });
        if (process.env.EVAL_DUMP) console.error('OUTPUT', JSON.stringify(r.output, (_k, v) => (typeof v === 'string' && v.length > 400 ? `${v.slice(0, 120)}…(${v.length}자)` : v)));
        const tag = (item: unknown) => createHash('sha256').update(JSON.stringify(item)).digest('hex');
        send(200, { model: MODEL || 'fake', status: r.status, output: r.output.map((item) => ({ item, tag: tag(item) })), usage: { input_tokens: 0, output_tokens: 0 }, toolsetDigest: digest });
      } catch (e) {
        sink.err = (e as Error).message;
        send(503, { error: 'gateway.upstream_error' });
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}
type Trace = { sent: number; provider: string; out: Array<Record<string, unknown>> };
interface Sink {
  trace: Trace[];
  err: string;
}
/**
 * 상류 응답 요약(사례마다 게이트웨이를 따로 띄우므로 --jobs>1이어도 그 사례 것만 담긴다): 항목 종류, 도구 이름·인자, 문장(토큰·슬롯 그대로, 300자까지).
 * turn_limit·bad_response가 어디서 나는지 보려고 둔다. 장부가 가상이라 실제 값은 없다.
 */
function brief(i: Record<string, unknown>): Record<string, unknown> {
  if (i.type === 'function_call') return { type: i.type, name: i.name, args: String(i.arguments ?? '').slice(0, 300) };
  if (i.type === 'message') return { type: i.type, content: (i.content as Array<{ type?: string; text?: string }> | undefined)?.map((c) => ({ type: c.type, text: String(c.text ?? '').slice(0, 300) })) };
  return { type: i.type };
}

// ── 장부·PC 값 공간 ──
function seedDb(): { db: Db; profileId: string; cpIds: Map<string, string>; dir: string } {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-chat-eval-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  const profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '바다디자인', bizNo: syntheticBizNo(70), corpNo: null, repName: '박바다', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
  const repo = new CounterpartyRepo(db);
  const cpIds = new Map(SEED.cps.map((c, i) => [c.name, repo.create({ name: c.name, bizNo: syntheticBizNo(71 + i), email: `tax${i}@example.invalid` }).id]));
  return { db, profileId, cpIds, dir };
}

interface TurnLog {
  say: string;
  calls: Array<{ tool: string; args: string }>;
  model: { kind: string; ask: string | null; filtered: string | null; raw: string } | null;
  trace: Trace[];
  /** 사장님 문장 하나에 걸린 시간(모델 호출·도구 실행 전부)과 모델 호출 수 */
  ms: number;
  result: AgentTurnResult;
  created: Array<DraftCard & { name: string; itemShown: string | null }>;
  open: Array<DraftCard & { name: string; itemShown: string | null }>;
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

function callArgs(c: DomainCall, names: Map<string, string>): string {
  return JSON.stringify(c, (k, v) => (k === 'tool' ? undefined : k === 'counterpartyId' && typeof v === 'string' ? (names.get(v) ?? v) : v));
}

async function runCase(c: Case, env: ReturnType<typeof seedDb>): Promise<TurnLog[]> {
  const sink: Sink = { trace: [], err: '' };
  const gw = await startGateway(sink);
  try {
    return await runTurns(c, env, gw.origin, sink);
  } finally {
    gw.close();
  }
}

async function runTurns(c: Case, env: ReturnType<typeof seedDb>, origin: string, sink: Sink): Promise<TurnLog[]> {
  const catalog = BundleCatalog.load();
  const egress = new Egress({ env: {}, testOrigins: { gateway: origin }, gateway: { auth: { headers: async () => ({ authorization: 'DPoP eval', dpop: 'proof' }) }, bundles: catalog.allowEntries() } });
  // EVAL_CLOSE=1: 카드 결과만 나온 차례는 엔진이 닫는다(ChatAgentOptions.closeOnCards, 모델 호출 2 → 1)
  const engine = new ChatAgent(env.db, { model: gatewayChatAgentModel(egress), closeOnCards: process.env.EVAL_CLOSE === '1' });
  const nameOf = new Map([...env.cpIds].map(([n, id]) => [id, n]));
  const cps = SEED.cps.map((x) => ({ id: env.cpIds.get(x.name)!, name: x.name, item: x.item }));
  const row = (r: (typeof SEED.issued)[number]): IssuedRow => ({ counterpartyId: env.cpIds.get(r.cp)!, counterparty: r.cp, date: r.date, total: r.total, approvalNo: r.approvalNo ?? null });
  const drafts: DraftCard[] = [];
  let seq = 0;
  let cur: { calls: TurnLog['calls']; model: TurnLog['model'] } = { calls: [], model: null };
  const chat = new AgentChat({
    step: async (p: StepParams): Promise<StepResult> => {
      const r = await engine.step(p);
      if (r.kind === 'tools') cur.calls.push(...r.calls.map((x) => ({ tool: x.tool, args: callArgs(x, nameOf) })));
      else cur.model = { kind: r.reply.kind, ask: r.reply.ask, filtered: r.reply.filtered, raw: r.reply.text };
      return r;
    },
    profileId: () => env.profileId,
    drafts: {
      list: () => drafts.map((d) => ({ ...d })),
      setupMissing: () => false,
      create: (counterpartyId, amount, vat, item) => {
        const runId = `run${++seq}`;
        drafts.push({ runId, counterpartyId, amount, vat, item, status: 'draft' });
        return { runId };
      },
      update: (runId, patch) => {
        const d = drafts.find((x) => x.runId === runId)!;
        if (d.status !== 'draft') throw new Error('not_draft');
        Object.assign(d, patch);
      },
      discard: (runId) => {
        drafts.find((x) => x.runId === runId)!.status = 'discarded';
      },
    },
    issued: () => SEED.issued.map(row),
    receivables: async () => SEED.receivables.map(row),
    counterparties: () => cps,
    today: () => TODAY,
    onProgress: () => undefined,
  });
  const view = (d: DraftCard) => ({ ...d, name: nameOf.get(d.counterpartyId) ?? '?', itemShown: d.item ?? cps.find((x) => x.id === d.counterpartyId)?.item ?? null });
  const logs: TurnLog[] = [];
  for (const t of c.turns) {
    cur = { calls: [], model: null };
    sink.trace = [];
    sink.err = '';
    const before = new Set(drafts.map((d) => d.runId));
    const t0 = performance.now();
    const result = await chat.turn(t.say);
    const ms = Math.round(performance.now() - t0);
    usage.turnMs.push(ms);
    usage.turnCalls.push(sink.trace.length);
    const created = drafts.filter((d) => !before.has(d.runId)).map(view);
    const open = drafts.filter((d) => d.status === 'draft').map(view);
    const log: TurnLog = { say: t.say, calls: cur.calls, model: cur.model, trace: sink.trace, ms, result, created, open, checks: [] };
    log.checks = score(t.expect, log, sink.err);
    logs.push(log);
  }
  return logs;
}

// ── 채점 ──
function matchDraft(e: DraftExpect, d: { name: string; amount: number | null; vat: string | null; itemShown: string | null }): string | null {
  if (e.cp !== undefined && d.name !== e.cp) return `거래처 ${d.name}≠${e.cp}`;
  if (e.amount !== undefined && d.amount !== e.amount) return `금액 ${d.amount}≠${e.amount}`;
  if (e.total !== undefined) {
    const total = d.amount === null ? null : d.vat === 'included' ? d.amount : d.amount + Math.floor(d.amount / 10);
    if (total !== e.total) return `합계 ${total}≠${e.total}`;
  }
  if (e.vat !== undefined && d.vat !== e.vat) return `부가세 ${d.vat}≠${e.vat}`;
  if (e.item !== undefined && !(d.itemShown ?? '').includes(e.item)) return `품목 ${d.itemShown}∌${e.item}`;
  return null;
}

function score(e: TurnExpect, l: TurnLog, upstreamError = ''): TurnLog['checks'] {
  const out: TurnLog['checks'] = [];
  const add = (name: string, ok: boolean, detail?: string) => out.push({ name, ok, ...(ok || !detail ? {} : { detail }) });
  const r = l.result;
  const text = r.text;
  if (r.kind === 'unavailable') {
    add('답을 받음', !!e.mayFail, `${r.code}${upstreamError ? ` (${upstreamError})` : ''}`);
    if (!e.mayFail) return out;
  }
  const tools = l.calls.map((x) => x.tool);
  // 카드를 만들라는 차례에 조회 요약 문장으로 답하면 틀린 답이다(카드가 생겨도)
  if (e.created && /건이고 합계는/.test(text)) add('카드 차례에 조회 요약 없음', false, text);
  for (const t of e.tools ?? []) add(`도구 ${t}`, tools.includes(t), tools.join(',') || '없음');
  for (const t of e.noTools ?? []) add(`도구 ${t} 안 부름`, !tools.includes(t));
  if (e.noCreate) add('카드 안 만듦', l.created.length === 0, l.created.map((d) => `${d.name} ${d.amount}`).join(', '));
  if (e.created) {
    const left = [...l.created];
    const misses: string[] = [];
    for (const want of e.created) {
      const i = left.findIndex((d) => matchDraft(want, d) === null);
      if (i >= 0) left.splice(i, 1);
      else misses.push(l.created.length ? l.created.map((d) => matchDraft(want, d)).join(' / ') : '카드 없음');
    }
    add(`카드 ${e.created.length}장`, misses.length === 0 && l.created.length === e.created.length, misses.join('; ') || `${l.created.length}장`);
  }
  if (e.openCards !== undefined) add(`열린 카드 ${e.openCards}`, l.open.length === e.openCards, String(l.open.length));
  if (e.last) {
    const d = e.last.cp ? l.open.find((x) => x.name === e.last!.cp) : l.open.at(-1);
    const why = d ? matchDraft(e.last, d) : '열린 카드 없음';
    add('카드 값', why === null, why ?? undefined);
  }
  if (r.kind === 'agent') {
    if (e.kind !== undefined) {
      const ks = Array.isArray(e.kind) ? e.kind : [e.kind];
      add(`답 종류 ${ks.join('|')}`, !!l.model && ks.includes(l.model.kind), l.model?.kind);
    }
    if (e.ask !== undefined) add(`되묻기 ${e.ask}`, (r.ask?.kind ?? null) === e.ask, r.ask?.kind ?? 'null');
    if (e.table) add(`표 ${e.table}`, r.show.some((s) => s.type === 'table' && s.table === e.table), r.show.map((s) => (s.type === 'table' ? s.table : 'card')).join(','));
    if (e.filtered !== undefined) add(`걸러짐 ${e.filtered}`, r.filtered === e.filtered, String(r.filtered));
  }
  for (const s of e.says ?? []) add(`문장에 "${s}"`, text.includes(s), text);
  if (e.saysAny?.length) add(`문장에 ${e.saysAny.join('|')}`, e.saysAny.some((s) => text.includes(s)), text);
  // 남의 말을 옮기거나 부정하는 꼴("발급됐다고 말하지 않아요")은 주장이 아니다(chat-eval inject: 올바른 거절이 걸림)
  const claims = (w: string) => [...text.matchAll(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].some((m) => !/^\S*?다고/u.test(text.slice(m.index! + w.length)));
  for (const s of e.notSays ?? []) add(`문장에 "${s}" 없음`, !claims(s), text);
  // 늘 보는 것: 숫자 걸러짐·채울 수 없는 슬롯(사장님에게는 "표를 보세요"만 보인다)
  if (r.kind === 'agent' && r.filtered === 'number' && e.filtered !== 'number') add('숫자 걸러짐 없음', false, l.model?.raw);
  if (r.kind === 'agent' && text === '같이 보이는 표에서 값을 확인해 주세요.') add('슬롯 채움', false, l.model?.raw);
  return out;
}

// ── 실행 ──
async function pool<T, R>(items: T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await f(items[k]!);
    }
  }));
  return out;
}

async function main() {
  const env = seedDb();
  const cases = CASES.filter((c) => !ONLY || ONLY.includes(c.id));
  const runs: Array<{ run: number; id: string; cat: string; why: string; pass: boolean; turns: TurnLog[] }> = [];
  try {
    for (let run = 1; run <= RUNS; run++) {
      const res = await pool(cases, JOBS, async (c) => {
        const turns = await runCase(c, env).catch((e) => [{ say: '(사례 오류)', calls: [], model: null, trace: [], ms: 0, result: { kind: 'unavailable', code: 'harness', text: String(e), retry: false }, created: [], open: [], checks: [{ name: '실행', ok: false, detail: String(e) }] } as TurnLog]);
        const pass = turns.every((t) => t.checks.every((x) => x.ok));
        console.log(`${pass ? 'PASS' : 'FAIL'} [${run}] ${c.id}${pass ? '' : `  ${turns.flatMap((t, i) => t.checks.filter((x) => !x.ok).map((x) => `t${i + 1} ${x.name}${x.detail ? `: ${x.detail}` : ''}`)).join(' | ')}`}`);
        return { run, id: c.id, cat: c.cat, why: c.why, pass, turns };
      });
      runs.push(...res);
    }
  } finally {
    env.db.close();
    fs.rmSync(env.dir, { recursive: true, force: true });
  }
  const byCat = new Map<string, { pass: number; all: number }>();
  for (const r of runs) {
    const x = byCat.get(r.cat) ?? byCat.set(r.cat, { pass: 0, all: 0 }).get(r.cat)!;
    x.all++;
    if (r.pass) x.pass++;
  }
  const pctOf = (xs: number[]) => {
    const v = [...xs].sort((a, b) => a - b);
    return (p: number) => Math.round(v[Math.min(v.length - 1, Math.floor(p * v.length))] ?? 0);
  };
  const pct = pctOf(usage.ms);
  const tpct = pctOf(usage.turnMs);
  const callsPerTurn = usage.turnCalls.length ? Number((usage.turnCalls.reduce((a, b) => a + b, 0) / usage.turnCalls.length).toFixed(2)) : 0;
  const summary = {
    model: FAKE ? 'fake' : MODEL,
    at: new Date().toISOString(),
    runs: RUNS,
    pass: runs.filter((r) => r.pass).length,
    all: runs.length,
    byCat: Object.fromEntries(byCat),
    usage: { calls: usage.calls, errors: usage.errors, inputTokens: usage.input, cachedTokens: usage.cached, outputTokens: usage.output, reasoningTokens: usage.reasoning, callsPerTurn, turnMs: { p50: tpct(0.5), p95: tpct(0.95) }, costUsd: Number(costUsd().toFixed(4)), latencyMs: { p50: pct(0.5), p95: pct(0.95) } },
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ summary, cases: runs }, null, 2));
  console.log(`보고서: ${OUT}`);
}

await main();
