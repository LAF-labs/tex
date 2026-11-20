import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { PHONE_SLOT_MISSING_TEXT, PhoneChat, PhoneGateway, type HttpResponse, type PhoneCopy, type PhoneDraft, type PhoneTurnResult } from '@sax/chat-core';
import { CHAT_DIGEST, CHAT_PHONE, toolsetDigest, toolsetPrefix, type ToolsetDef } from '@sax/model';
import { ulid } from '@sax/remote';
import { openAIResponsesBody } from '../../services/gateway/src/providers.ts';
import { SEED, TODAY, type Case, type DraftExpect, type TurnExpect } from './cases.ts';
import { PHONE_CASES } from './phone-cases.ts';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const flag = (k: string) => process.argv.includes(`--${k}`);
const FAKE = flag('fake');
const KEY = FAKE ? '' : (process.env.OPENROUTER_API_KEY ?? '');
const MODEL = process.env.EVAL_MODEL ?? arg('model') ?? '';
const PROVIDERS = (process.env.EVAL_PROVIDERS ?? process.env.OPENROUTER_PROVIDERS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const RUNS = Number(arg('runs') ?? 1);
const ONLY = arg('only')?.split(',').map((x) => x.trim()).filter(Boolean);
const OUT = arg('out') ?? path.join(import.meta.dirname, '../../.tmp/chat-eval/phone-latest.json');
const COST_CAP = Number(arg('cap') ?? 0.3);
const PRICE = { in: 0.3, cached: 0.006, out: 1.2 };

if (flag('list')) {
  for (const c of PHONE_CASES) console.log(`${c.id.padEnd(28)} [${c.cat}] ${c.why}`);
  process.exit(0);
}
if (!ONLY && !flag('all')) {
  console.error('사례를 --only=id,id로 골라 주세요(목록은 --list). 전부 돌리려면 --all을 붙입니다.');
  process.exit(2);
}
const unknownIds = (ONLY ?? []).filter((id) => !PHONE_CASES.some((c) => c.id === id));
if (unknownIds.length) {
  console.error(`없는 사례: ${unknownIds.join(', ')} (목록은 --list)`);
  process.exit(2);
}
if (!FAKE && (!KEY || !MODEL)) {
  console.error('OPENROUTER_API_KEY와 EVAL_MODEL이 필요합니다(배선만 볼 때는 --fake).');
  process.exit(2);
}

const usage = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, errors: 0 };
const costUsd = () => ((usage.input - usage.cached) * PRICE.in + usage.cached * PRICE.cached + usage.output * PRICE.out) / 1e6;

interface Call {
  toolset: string;
  sent: number;
  provider: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  ms: number;
  out: Array<Record<string, unknown>>;
}
interface Sink {
  calls: Call[];
  input: string;
  err: string;
}

async function upstream(def: ToolsetDef, input: unknown[]): Promise<Omit<Call, 'toolset' | 'sent' | 'out'> & { status: string; output: Array<Record<string, unknown>> }> {
  if (FAKE) return { ...fakeUpstream(def, input), provider: 'fake', inputTokens: 0, cachedTokens: 0, outputTokens: 0, ms: 0 };
  if (costUsd() > COST_CAP) throw new Error('cost_cap');
  const body: Record<string, unknown> = openAIResponsesBody({
    model: MODEL,
    prefix: toolsetPrefix(def),
    effort: def.effort,
    maxOutputTokens: def.maxOutputTokens,
    tools: def.tools,
    output: def.output,
    input,
    cacheKey: 'chat-eval-phone',
    safetyId: 'chat-eval-phone',
  });
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
      const u = { inputTokens: d.usage?.input_tokens ?? 0, cachedTokens: d.usage?.input_tokens_details?.cached_tokens ?? 0, outputTokens: d.usage?.output_tokens ?? 0 };
      usage.calls++;
      usage.input += u.inputTokens;
      usage.cached += u.cachedTokens;
      usage.output += u.outputTokens;
      usage.reasoning += d.usage?.output_tokens_details?.reasoning_tokens ?? 0;
      return { status: String(d.status ?? ''), output: d.output ?? [], provider: String(d.provider ?? ''), ...u, ms: Math.round(performance.now() - t0) };
    }
    if (attempt >= 2 || (res && res.status < 500 && res.status !== 429)) {
      usage.errors++;
      throw new Error(`upstream ${res ? `${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}` : 'network'}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

function fakeUpstream(def: ToolsetDef, input: unknown[]): { status: string; output: Array<Record<string, unknown>> } {
  const msg = (o: object) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(o) }] }] });
  if (def.id === CHAT_DIGEST.id) return msg({ summary: '앞 대화를 줄였다.' });
  const last = input.at(-1) as { type?: string; output?: string } | undefined;
  if (last?.type === 'function_call_output') {
    const o = JSON.parse(String(last.output)) as { ref: string | null };
    return msg({ kind: 'did', text: '카드를 만들었어요.', show: o.ref ? [o.ref] : [], ask: null });
  }
  const text = (input[0] as { content: Array<{ text: string }> }).content[0]!.text.split('[지금]').at(-1)!;
  const said = text.split('사용자:').at(-1)!;
  const name = /\[NAME_\d+\]/.exec(said)?.[0];
  const amt = /\[AMT_\d+\]/.exec(said)?.[0];
  if (!name || !amt) return msg({ kind: 'smalltalk', text: '안녕하세요.', show: [], ask: null });
  return { status: 'completed', output: [{ type: 'function_call', call_id: `call_${randomBytes(3).toString('hex')}`, name: 'invoice_draft', arguments: JSON.stringify({ counterparty: name, amount: amt, vat: null, item: null, date_month_offset: null, date_day: null, quantity: null, unit_price: null }) }] };
}

function brief(i: Record<string, unknown>): Record<string, unknown> {
  if (i.type === 'function_call') return { type: i.type, name: i.name, args: String(i.arguments ?? '').slice(0, 400) };
  if (i.type === 'message') return { type: i.type, content: (i.content as Array<{ type?: string; text?: string }> | undefined)?.map((c) => ({ type: c.type, text: String(c.text ?? '').slice(0, 400) })) };
  return { type: i.type };
}

function gatewayFetch(sink: Sink) {
  const json = (status: number, v: unknown): HttpResponse => ({ status, text: async () => JSON.stringify(v) });
  return async (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<HttpResponse> => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith('/v1/run-tokens')) return json(200, { runToken: `sxr1.${randomBytes(16).toString('hex')}.eval`, expiresAt: '2099-01-01T00:00:00Z' });
    if (!url.endsWith('/v1/respond')) return json(404, {});
    const def = body.toolset === CHAT_PHONE.id ? CHAT_PHONE : body.toolset === CHAT_DIGEST.id ? CHAT_DIGEST : null;
    if (!def) return json(403, { error: 'account.scope_denied' });
    const messages = body.messages as Array<{ content: Array<{ text: string }> }>;
    const replay = (body.replay as Array<{ item?: unknown; call_id?: string; output?: string }> | undefined) ?? [];
    if (def === CHAT_PHONE && !replay.length) sink.input = messages[0]!.content[0]!.text;
    const input = [...messages, ...replay.map((r) => ('item' in r && r.item ? r.item : { type: 'function_call_output', call_id: r.call_id, output: r.output }))];
    try {
      const r = await upstream(def, input);
      sink.calls.push({ toolset: def.id, sent: replay.length, provider: r.provider, inputTokens: r.inputTokens, cachedTokens: r.cachedTokens, outputTokens: r.outputTokens, ms: r.ms, out: r.output.map(brief) });
      const tag = (item: unknown) => createHash('sha256').update(JSON.stringify(item)).digest('hex');
      return json(200, { model: MODEL || 'fake', status: r.status, output: r.output.map((item) => ({ item, tag: tag(item) })), usage: { input_tokens: r.inputTokens, output_tokens: r.outputTokens }, toolsetDigest: toolsetDigest(def) });
    } catch (e) {
      sink.err = (e as Error).message;
      return json(503, { error: 'gateway.upstream_error' });
    }
  };
}

const T0 = Date.parse(`${TODAY}T03:00:00Z`);
const CP_ID = new Map(SEED.cps.map((c, i) => [c.name, `c${i + 1}`]));
const CP_NAME = new Map([...CP_ID].map(([name, id]) => [id, name]));
const row = (r: (typeof SEED.issued)[number]) => ({ counterpartyId: CP_ID.get(r.cp)!, counterparty: r.cp, date: r.date, total: r.total, approvalNo: r.approvalNo ?? null });
const COPY: PhoneCopy = {
  asOf: T0 - 3600_000,
  profile: { id: 'p1', name: '바다디자인', repName: '박바다', bizNo: null },
  counterparties: SEED.cps.map((c) => ({ id: CP_ID.get(c.name)!, name: c.name, item: c.item })),
  issued: SEED.issued.map(row),
  receivables: SEED.receivables.map(row),
};

type CardView = { ref: string; name: string; amount: number; vat: string | null; itemShown: string | null; state: PhoneDraft['state'] };
const view = (d: PhoneDraft): CardView => ({ ref: d.ref, name: CP_NAME.get(d.counterpartyId) ?? '?', amount: d.amount, vat: d.vat, itemShown: d.item ?? SEED.cps.find((c) => CP_ID.get(c.name) === d.counterpartyId)?.item ?? null, state: d.state });

interface TurnLog {
  say: string;
  input: string;
  calls: Call[];
  tools: string[];
  ms: number;
  result: PhoneTurnResult;
  created: CardView[];
  open: CardView[];
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
}

async function runCase(c: Case): Promise<TurnLog[]> {
  const sink: Sink = { calls: [], input: '', err: '' };
  let now = T0;
  let saved: string | null = null;
  const chat = new PhoneChat({
    model: new PhoneGateway({ origin: 'http://127.0.0.1', fetch: gatewayFetch(sink), authHeaders: async () => ({}) }),
    store: { load: async () => saved, save: async (d) => void (saved = d) },
    copy: () => COPY,
    now: () => now,
    newId: () => ulid(now),
    randomHex: () => randomBytes(16).toString('hex'),
  });
  const logs: TurnLog[] = [];
  for (const t of c.turns) {
    sink.calls = [];
    sink.input = '';
    sink.err = '';
    const before = new Set((await chat.drafts()).map((d) => d.id));
    const t0 = performance.now();
    const result = await chat.send(t.say);
    await chat.messages();
    const ms = Math.round(performance.now() - t0);
    const drafts = await chat.drafts();
    const log: TurnLog = {
      say: t.say,
      input: sink.input,
      calls: sink.calls,
      tools: sink.calls.flatMap((x) => x.out.filter((o) => o.type === 'function_call').map((o) => String(o.name))),
      ms,
      result,
      created: drafts.filter((d) => !before.has(d.id)).map(view),
      open: drafts.filter((d) => d.state === 'open').map(view),
      checks: [],
    };
    log.checks = score(t.expect, log, sink.err);
    logs.push(log);
    now += 20_000;
  }
  return logs;
}

function matchDraft(e: DraftExpect, d: CardView): string | null {
  if (e.cp !== undefined && d.name !== e.cp) return `거래처 ${d.name}≠${e.cp}`;
  if (e.amount !== undefined && d.amount !== e.amount) return `금액 ${d.amount}≠${e.amount}`;
  if (e.total !== undefined) {
    const total = d.vat === 'included' ? d.amount : d.amount + Math.floor(d.amount / 10);
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
  const raw = l.calls.flatMap((x) => x.out.filter((o) => o.type === 'message').flatMap((o) => (o.content as Array<{ text?: string }> | undefined)?.map((c) => c.text ?? '') ?? [])).at(-1);
  if (r.kind === 'unavailable') {
    add('답을 받음', !!e.mayFail, `${r.code}${upstreamError ? ` (${upstreamError})` : ''}${raw ? ` 모델 답: ${raw}` : ''}`);
    if (!e.mayFail) return out;
  }
  for (const t of e.tools ?? []) add(`도구 ${t}`, l.tools.includes(t), l.tools.join(',') || '없음');
  for (const t of e.noTools ?? []) add(`도구 ${t} 안 부름`, !l.tools.includes(t));
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
  if (r.kind === 'reply') {
    if (e.kind !== undefined) {
      const ks = Array.isArray(e.kind) ? e.kind : [e.kind];
      add(`답 종류 ${ks.join('|')}`, ks.includes(r.reply), r.reply);
    }
    if (e.ask !== undefined) add(`되묻기 ${e.ask}`, (r.ask?.kind ?? null) === e.ask, r.ask?.kind ?? 'null');
    if (e.table) add(`표 ${e.table}`, r.show.some((s) => s.type === 'table' && s.table === e.table), r.show.map((s) => (s.type === 'table' ? s.table : 'card')).join(',') || '없음');
    if (e.filtered !== undefined) add(`걸러짐 ${e.filtered}`, r.filtered === e.filtered, String(r.filtered));
    if ((r.filtered === 'number' || r.filtered === 'slot') && e.filtered !== r.filtered) add(`${r.filtered === 'number' ? '숫자' : '슬롯'} 걸러짐 없음`, false, raw);
    if (text === PHONE_SLOT_MISSING_TEXT) add('슬롯 채움', false, raw);
  }
  for (const s of e.says ?? []) add(`문장에 "${s}"`, text.includes(s), text);
  if (e.saysAny?.length) add(`문장에 ${e.saysAny.join('|')}`, e.saysAny.some((s) => text.includes(s)), text);
  const claims = (w: string) => [...text.matchAll(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].some((m) => !/^\S*?다고/u.test(text.slice(m.index! + w.length)));
  for (const s of e.notSays ?? []) add(`문장에 "${s}" 없음`, !claims(s), text);
  return out;
}

const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
function printTurn(id: string, i: number, l: TurnLog) {
  console.log(`\n── ${id} · ${i + 1}번째 말 ──`);
  console.log(`사장님: ${l.say}`);
  if (flag('show-input') && l.input) console.log(`[모델에 보낸 글 · ${[...l.input].length}자]\n${l.input}\n[보낸 글 끝]`);
  for (const [k, c] of l.calls.entries()) {
    const what = c.out.map((o) => (o.type === 'function_call' ? `도구 ${String(o.name)} ${String(o.args)}` : o.type === 'message' ? `답 ${(o.content as Array<{ text?: string }> | undefined)?.map((x) => x.text).join(' ') ?? ''}` : String(o.type))).join(' / ');
    console.log(`  호출 ${k + 1}(${c.toolset}): 입력 ${c.inputTokens}토큰(캐시 ${c.cachedTokens}) 출력 ${c.outputTokens} · ${c.ms}ms${c.provider ? ` · ${c.provider}` : ''}\n    ${what}`);
  }
  const r = l.result;
  if (r.kind === 'reply') {
    const shown = r.show.map((s) => (s.type === 'table' ? `표 ${s.table} ${s.rows.length}줄` : `카드 ${s.counterparty} ${won(s.draft.amount)} 부가세 ${s.draft.vat ?? '미정'} 품목 ${s.draft.item ?? '(저장 품목)'}`));
    console.log(`화면(${r.reply}${r.filtered ? `, 걸러짐 ${r.filtered}` : ''}${r.ask ? `, 되묻기 ${r.ask.kind}` : ''}): ${r.text}${shown.length ? `\n  보임: ${shown.join(' | ')}` : ''}`);
  } else console.log(`화면(답 없음 ${r.code}): ${r.text}`);
  console.log(`  ${l.ms}ms · ${l.checks.map((x) => `${x.ok ? '✔' : '✖'} ${x.name}${x.ok || !x.detail ? '' : ` → ${x.detail}`}`).join('\n  ') || '(채점 항목 없음)'}`);
}

async function main() {
  const cases = PHONE_CASES.filter((c) => !ONLY || ONLY.includes(c.id));
  const runs: Array<{ run: number; id: string; cat: string; why: string; pass: boolean; turns: TurnLog[] }> = [];
  for (let run = 1; run <= RUNS; run++) {
    for (const c of cases) {
      const turns = await runCase(c).catch((e) => [{ say: '(사례 오류)', input: '', calls: [], tools: [], ms: 0, result: { kind: 'unavailable', code: 'chat.unavailable', text: String(e), retry: false }, created: [], open: [], checks: [{ name: '실행', ok: false, detail: String(e) }] } as TurnLog]);
      const pass = turns.every((t) => t.checks.every((x) => x.ok));
      turns.forEach((t, i) => printTurn(c.id, i, t));
      console.log(`${pass ? 'PASS' : 'FAIL'} [${run}] ${c.id} — ${c.why}`);
      runs.push({ run, id: c.id, cat: c.cat, why: c.why, pass, turns });
    }
  }
  const summary = {
    model: FAKE ? 'fake' : MODEL,
    at: new Date().toISOString(),
    runs: RUNS,
    pass: runs.filter((r) => r.pass).length,
    all: runs.length,
    failed: runs.filter((r) => !r.pass).map((r) => r.id),
    usage: { calls: usage.calls, errors: usage.errors, inputTokens: usage.input, cachedTokens: usage.cached, outputTokens: usage.output, reasoningTokens: usage.reasoning, costUsd: Number(costUsd().toFixed(4)) },
  };
  console.log(`\n${JSON.stringify(summary, null, 2)}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ summary, cases: runs }, null, 2));
  console.log(`보고서: ${OUT}`);
}

await main();
