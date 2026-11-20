import fs from 'node:fs';
import path from 'node:path';
import { reactedLine, registerChatRecords } from '@sax/chat-core';
import { BundleCatalog, CHAT_AGENT, toolsetPrefix, type Question } from '@sax/model';
import { Redactor } from '@sax/redaction';
import { openAIResponsesBody, systemOneAnswers, systemOneDecideBody } from '../../../services/gateway/src/providers.ts';
import { SEED } from '../cases.ts';
import { ROUTE_CASES, type RouteCase } from './cases.ts';
import { scoreReply, scoreRoute, type RouteRow } from './score.ts';

const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const TARGET = (arg('target') ?? 'draft') as 'v1' | 'draft' | 'intent' | 'agent';
const ROUTED = TARGET === 'draft' || TARGET === 'v1';
const FAKE = process.argv.includes('--fake');
const ESTIMATE = process.argv.includes('--estimate');
const KEY = FAKE || ESTIMATE ? '' : (process.env.OPENROUTER_API_KEY ?? '');
const JEV = arg('jev') ?? 'typesafe/jev-1.14';
const AGENT_MODEL = process.env.EVAL_MODEL ?? arg('model') ?? '';
const PROVIDERS = (process.env.EVAL_PROVIDERS ?? process.env.OPENROUTER_PROVIDERS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const JOBS = Number(arg('jobs') ?? 6);
const LIMIT = Number(arg('limit') ?? Infinity);
const COST_CAP = Number(arg('cap') ?? 1);
const OUT = arg('out') ?? path.join(import.meta.dirname, `../../../reports/chat-eval/route-${TARGET}.json`);
const PRICE = { jev: 0.042, agentIn: 0.3, agentCached: 0.006, agentOut: 1.2 };
export const KRW_PER_USD = 1450;

if (!['v1', 'draft', 'intent', 'agent'].includes(TARGET)) throw new Error('--target=v1|draft|intent|agent');
if (!FAKE && !ESTIMATE && (!KEY || (TARGET === 'agent' && !AGENT_MODEL))) {
  console.error('OPENROUTER_API_KEY가 필요합니다(agent는 EVAL_MODEL도). 배선만 볼 때는 --fake, 비용만 볼 때는 --estimate.');
  process.exit(2);
}

const catalog = BundleCatalog.load();
const common = fs.readFileSync(new URL('../../../packages/model/bundles/prefixes/_common.ko.txt', import.meta.url), 'utf8').trim();
const draftDef = JSON.parse(fs.readFileSync(new URL('./chat_route_draft.json', import.meta.url), 'utf8')) as { questions: Question[] };
const draftPrefix = `${common}\n\n${fs.readFileSync(new URL('./chat_route_draft.ko.txt', import.meta.url), 'utf8').trim()}`;
const intent = catalog.get('intent_route_v1')!;
const v1 = catalog.get('chat_route_v1')!;
const BUNDLE = TARGET === 'draft' ? { prefix: draftPrefix, questions: draftDef.questions } : TARGET === 'v1' ? { prefix: v1.prefixText, questions: v1.def.questions } : { prefix: intent.prefixText, questions: intent.def.questions };

const RECS = [
  ...SEED.cps.map((c, i) => ({ recordId: `cp:${i}`, names: [c.name], emails: [] as string[], bizNos: [] as string[] })),
  { recordId: 'pf:0', names: ['바다디자인', '박바다'], emails: [] as string[], bizNos: [] as string[] },
];
const ASKED = { counterparty: '거래처', amount: '금액', item: '품목', vat: '부가세', date: '작성일' } as const;
const VAT = { separate: '별도', included: '포함' } as const;
const TODAY_LINE = '오늘: 2026년 11월 16일';

function masker(c: RouteCase): (t: string) => string {
  const red = new Redactor({ chatSessionId: `route-${c.id}` });
  registerChatRecords(red, [c.say, ...c.ctx.prev.flat(), ...c.ctx.cards.map((x) => x.cp), c.ctx.pending?.cp ?? ''].join('\n'), RECS);
  return (t) => red.apply(t, { frame: 'none' }).redacted as string;
}

function cardsLine(c: RouteCase, m: (t: string) => string): string {
  return c.ctx.cards.length ? `화면: ${c.ctx.cards.map((x, i) => `카드 d${i + 1}(세금계산서, 거래처 ${m(x.cp)}, 금액 ${x.amount ? '있음' : '없음'}, 부가세 ${x.vat ? VAT[x.vat] : '미정'}, 품목 ${x.item ? '있음' : '없음'})`).join('; ')}` : '화면: 열린 카드 없음';
}

export function draftInput(c: RouteCase): string {
  const m = masker(c);
  const p = c.ctx.pending;
  return [
    `기기: ${c.ctx.device === 'phone' ? '폰' : 'PC'}`,
    TODAY_LINE,
    cardsLine(c, m),
    `진행 중인 발급: ${p ? `세금계산서(거래처 ${m(p.cp)}, ${p.stage === 'preparing' ? '홈택스에서 준비 중' : '승인 대기'})` : '없음'}`,
    `직전에 되물은 칸: ${c.ctx.asked ? ASKED[c.ctx.asked] : '없음'}`,
    ...reactedLine(c.ctx.reacted ?? 0),
    ...(c.ctx.prev.length ? ['[앞 대화]', ...c.ctx.prev.flatMap(([u, a]) => [`사용자: ${m(u)}`, `앱: ${m(a)}`])] : []),
    `사용자: ${m(c.say)}`,
  ].join('\n');
}

export function intentInput(c: RouteCase): string {
  return masker(c)(c.say);
}

export function agentInput(c: RouteCase): string {
  const m = masker(c);
  const now = `[지금]\n${TODAY_LINE}\n${cardsLine(c, m)}\n사용자: ${m(c.say)}`;
  return c.ctx.prev.length ? `[앞 대화]\n${c.ctx.prev.map(([u, a]) => `사용자: ${m(u)}\n앱: ${m(a)}`).join('\n')}\n${now}` : now;
}

export const PLAYBOOK_MAP: Record<string, [string, string]> = {
  'hometax.invoice.issue': ['task', 'invoice'],
  'hometax.invoice.amend': ['task', 'invoice'],
  'hometax.invoice.list': ['lookup', 'records'],
  'hometax.summary.view': ['lookup', 'records'],
  'query.documents': ['lookup', 'cert_doc'],
  'hometax.cert.business': ['task', 'cert_doc'],
  'hometax.cert.taxpayment': ['task', 'cert_doc'],
  'gov24.resident.copy': ['task', 'cert_doc'],
  'gov24.localtax.cert': ['task', 'cert_doc'],
  'gov24.nhis.eligibility': ['task', 'cert_doc'],
  'gov24.land.register': ['task', 'cert_doc'],
  'gov24.localtax.itemized': ['task', 'cert_doc'],
  'sminfo.sme.cert': ['task', 'cert_doc'],
  'fourins.paid.cert': ['task', 'cert_doc'],
  'counterparty.bizstatus.check': ['task', 'counterparty'],
  'bundle.monthly': ['task', 'pack'],
  'hometax.card.refresh': ['task', 'capture'],
  'payroll.ledger': ['task', 'none'],
  none_of_these: ['other', 'none'],
};
const TOOL_MAP: Record<string, [string, string, number]> = {
  invoice_draft: ['task', 'invoice', 0],
  draft_edit: ['followup', 'invoice', 1],
  draft_discard: ['followup', 'invoice', 1],
  sales_summary: ['lookup', 'records', 0],
  invoice_history: ['lookup', 'records', 0],
  receivables: ['lookup', 'records', 0],
  payables: ['lookup', 'records', 0],
  cash_flow: ['lookup', 'records', 0],
};
const KIND_MAP: Record<string, [string, string]> = {
  smalltalk: ['smalltalk', 'none'],
  tax_advice: ['tax_advice', 'none'],
  ask: ['task', 'invoice'],
  did: ['task', 'invoice'],
  cannot: ['other', 'none'],
  answer: ['app_help', 'none'],
};

type Decision = { type?: string; name?: string; choice?: unknown; confidence?: unknown; probabilities?: unknown; probability?: unknown };
function pickOf(a: Decision | undefined): { got: string | null; conf: number | null } {
  if (!a || a.type !== 'choice' || typeof a.choice !== 'string') return { got: null, conf: null };
  const list = Array.isArray(a.probabilities) ? (a.probabilities as Array<{ value?: unknown; probability?: unknown }>) : [];
  const p = Number(list.find((x) => x.value === a.choice)?.probability ?? a.confidence);
  return { got: a.choice, conf: Number.isFinite(p) ? p : null };
}
const predOf = (a: Decision | undefined) => (a?.type === 'predicate' && Number.isFinite(Number(a.probability)) ? Number(a.probability) : null);

let spentUsd = 0;
async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).catch(() => null);
    if (res?.status === 200) return (await res.json()) as Record<string, unknown>;
    if (attempt >= 2 || (res && res.status < 500 && res.status !== 429)) throw new Error(`upstream ${res ? res.status : 'network'} ${res ? (await res.text().catch(() => '')).slice(0, 200) : ''}`);
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

async function judge(c: RouteCase): Promise<RouteRow> {
  const input = ROUTED ? draftInput(c) : intentInput(c);
  const t0 = performance.now();
  let d: Record<string, unknown>;
  if (FAKE) {
    const fake = TARGET === 'v1' ? { act: { choice: 'task', confidence: 0.9 }, domain: { choice: 'invoice', confidence: 0.9 }, corrects_previous: { noul: 0.1 }, mentions_tax_advice: { noul: 0.05 }, reply_mode: { choice: 'react_then_work', confidence: 0.9 }, reaction: { choice: 'eyes', confidence: 0.9 } } : TARGET === 'draft' ? { act: { choice: 'task', confidence: 0.9, probabilities: { task: 0.9, other: 0.1 } }, domain: { choice: 'invoice', confidence: 0.9 }, corrects_previous: { noul: 0.1 }, mentions_tax_advice: { noul: 0.05 } } : { playbook: { choice: 'hometax.invoice.issue', confidence: 0.9 }, mentions_tax_advice: { noul: 0.05 } };
    d = { answers: fake, usage: { input_tokens: Math.round(Buffer.byteLength(BUNDLE.prefix + input) / 2) } };
  } else {
    if (spentUsd > COST_CAP) throw new Error('cost_cap');
    const body = { ...systemOneDecideBody({ model: JEV, prefix: BUNDLE.prefix, input, questions: BUNDLE.questions, cacheKey: '', safetyId: 'chat-eval' }), provider: { data_collection: 'deny' } };
    d = await post('https://openrouter.ai/api/alpha/decisions', body);
  }
  const ms = performance.now() - t0;
  const inputTokens = Number((d.usage as { input_tokens?: number } | undefined)?.input_tokens ?? 0);
  spentUsd += (inputTokens * PRICE.jev) / 1e6;
  const a = Object.fromEntries((systemOneAnswers(d.answers, BUNDLE.questions) as Decision[]).map((x) => [x.name, x]));
  if (TARGET === 'v1') return { id: c.id, act: pickOf(a.act), domain: pickOf(a.domain), corrects: predOf(a.corrects_previous), advice: predOf(a.mentions_tax_advice), reply: pickOf(a.reply_mode), reaction: pickOf(a.reaction), ms, inputTokens, model: String(d.model ?? JEV) } as RouteRow;
  if (TARGET === 'draft') return { id: c.id, act: pickOf(a.act), domain: pickOf(a.domain), corrects: predOf(a.corrects_previous), advice: predOf(a.mentions_tax_advice), ms, inputTokens, model: String(d.model ?? JEV) } as RouteRow;
  const pb = pickOf(a.playbook);
  const [act, domain] = pb.got ? (PLAYBOOK_MAP[pb.got] ?? ['other', 'none']) : [null, null];
  return { id: c.id, act: { got: act, conf: pb.conf }, domain: { got: domain, conf: pb.conf }, corrects: null, advice: predOf(a.mentions_tax_advice), ms, inputTokens, model: String(d.model ?? JEV) } as RouteRow;
}

async function agent(c: RouteCase): Promise<RouteRow> {
  const input = [{ role: 'user', content: [{ type: 'input_text', text: agentInput(c) }] }];
  const t0 = performance.now();
  let d: { output?: Array<Record<string, unknown>>; usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } };
  if (FAKE) d = { output: [{ type: 'function_call', name: 'invoice_draft', arguments: '{}' }], usage: { input_tokens: 0 } };
  else {
    if (spentUsd > COST_CAP) throw new Error('cost_cap');
    const body: Record<string, unknown> = openAIResponsesBody({ model: AGENT_MODEL, prefix: toolsetPrefix(CHAT_AGENT), effort: CHAT_AGENT.effort, maxOutputTokens: CHAT_AGENT.maxOutputTokens, tools: CHAT_AGENT.tools, output: CHAT_AGENT.output, input, cacheKey: 'chat-eval-route', safetyId: 'chat-eval' });
    if (PROVIDERS.length) body.provider = { zdr: true, data_collection: 'deny', only: PROVIDERS, allow_fallbacks: false, require_parameters: true };
    d = (await post('https://openrouter.ai/api/v1/responses', body)) as typeof d;
  }
  const ms = performance.now() - t0;
  const u = d.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? 0;
  spentUsd += (((u.input_tokens ?? 0) - cached) * PRICE.agentIn + cached * PRICE.agentCached + (u.output_tokens ?? 0) * PRICE.agentOut) / 1e6;
  const out = d.output ?? [];
  const call = out.find((x) => x.type === 'function_call');
  let act: string | null = null;
  let domain: string | null = null;
  let corrects: number | null = 0;
  let advice: number | null = 0;
  if (call) [act, domain, corrects] = TOOL_MAP[String(call.name)] ?? ['task', 'invoice', 0];
  else {
    const text = (out.find((x) => x.type === 'message')?.content as Array<{ text?: string }> | undefined)?.[0]?.text;
    let kind: string;
    try {
      kind = String((JSON.parse(String(text)) as { kind?: unknown }).kind ?? '');
    } catch {
      kind = '';
    }
    if (kind) [act, domain] = KIND_MAP[kind] ?? ['other', 'none'];
    else corrects = null;
    advice = kind === 'tax_advice' ? 1 : 0;
  }
  return { id: c.id, act: { got: act, conf: null }, domain: { got: domain, conf: null }, corrects, advice, ms, inputTokens: u.input_tokens ?? 0, ...(act ? {} : { error: 'no_output' }) };
}

function estimate(cases: readonly RouteCase[]): { calls: number; inputTokens: number; usd: number; krw: number } {
  const tok = (s: string) => Math.ceil(Buffer.byteLength(s, 'utf8') / 2);
  let inputTokens = 0;
  let usd = 0;
  for (const c of cases) {
    if (TARGET === 'agent') {
      const t = tok(toolsetPrefix(CHAT_AGENT)) + tok(JSON.stringify(CHAT_AGENT.tools)) + tok(agentInput(c));
      inputTokens += t;
      usd += (t * PRICE.agentIn + 300 * PRICE.agentOut) / 1e6;
    } else {
      const t = tok(BUNDLE.prefix) + tok(JSON.stringify(BUNDLE.questions)) + tok(ROUTED ? draftInput(c) : intentInput(c));
      inputTokens += t;
      usd += (t * PRICE.jev) / 1e6;
    }
  }
  return { calls: cases.length, inputTokens, usd: Number(usd.toFixed(4)), krw: Math.round(usd * KRW_PER_USD) };
}

async function pool<T, R>(items: readonly T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const res: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      res[k] = await f(items[k]!);
    }
  }));
  return res;
}

async function main() {
  const cases = ROUTE_CASES.slice(0, LIMIT);
  if (ESTIMATE) {
    console.log(JSON.stringify({ target: TARGET, ...estimate(cases), krwPerUsd: KRW_PER_USD }, null, 2));
    return;
  }
  const rows = await pool(cases, JOBS, async (c) => {
    const r = await (TARGET === 'agent' ? agent(c) : judge(c)).catch((e: Error): RouteRow => ({ id: c.id, act: { got: null, conf: null }, domain: { got: null, conf: null }, corrects: null, advice: null, ms: 0, inputTokens: 0, error: e.message.slice(0, 120) }));
    const okAct = TARGET !== 'intent' ? r.act.got === c.act : null;
    const okReply = r.reply ? r.reply.got === c.reply : true;
    if (process.env.EVAL_VERBOSE || r.error) console.log(`${r.error ? 'ERR ' : okAct === false || r.domain.got !== c.domain || !okReply ? 'MISS' : 'ok  '} ${c.id} ${c.act}/${c.domain}/${c.reply} → ${r.act.got}/${r.domain.got}/${r.reply?.got ?? '-'} ${r.act.conf?.toFixed(2) ?? ''} ${r.reply?.conf?.toFixed(2) ?? ''} ${r.reaction?.got ?? ''} ${r.error ?? ''}`);
    return r;
  });
  const opts = { fineAct: TARGET !== 'intent', domain: true, corrects: TARGET !== 'intent', advice: true };
  const summary = {
    target: TARGET,
    model: FAKE ? 'fake' : TARGET === 'agent' ? AGENT_MODEL : JEV,
    resolvedModels: FAKE ? [] : [...new Set((rows as Array<RouteRow & { model?: string }>).map((r) => r.model).filter(Boolean))],
    at: new Date().toISOString(),
    costUsd: Number(spentUsd.toFixed(4)),
    costKrw: Math.round(spentUsd * KRW_PER_USD),
    score: scoreRoute(ROUTE_CASES, rows, opts),
    reply: scoreReply(ROUTE_CASES, rows),
  };
  console.log(JSON.stringify(summary, null, 2));
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ summary, rows }, null, 2));
  console.log(`보고서: ${OUT}`);
}

await main();
