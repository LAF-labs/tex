// 폰 대화 실모델 평가(chat-eval 폰 방식, ADR-047). 폰 대화 코어(@sax/chat-core PhoneChat·PhoneGateway: 가림·컨텍스트 조립·도구 실행·답 검사·슬롯 채우기)는
// 제품 코드 그대로이고, 게이트웨이 자리만 이 파일이 맡아 실제 게이트웨이와 같은 본문(openAIResponsesBody + toolsetPrefix)으로 OpenRouter에 보낸다.
// 게이트웨이가 하는 일 가운데 범위·한도·가림 2차 검사·턴 상한은 여기 없다(그쪽은 모의 공급사 시험 services-gateway·phone-chat-gateway가 본다).
//
// 쓰는 법(한두 사례씩 돌리고, 찍힌 로그를 읽고, 고치고, 다시 돌린다):
//   set -a; . ./.env.local; set +a
//   EVAL_MODEL=<OpenRouter 모델 ID> node --conditions=development tests/chat-eval/phone.ts --only=p-issue-basic,p-look-history [--runs=1] [--show-input] [--out=/abs/report.json]
// - --only가 없으면 돌리지 않는다. 전부 돌릴 때만 --all을 붙인다(고친 뒤 되돌아간 것이 없는지 볼 때).
// - --list는 사례 ID와 설명만 찍는다. --fake는 키 없이 늘 같은 답을 내는 가짜 상류로 배선만 확인한다.
// - --show-input은 턴마다 모델에 보낸 글(가린 글)을 찍는다. 컨텍스트가 어떻게 짜였는지 볼 때 쓴다.
// 키·응답 원문은 남기지 않는다. 장부가 가상이라 보고서의 문장·도구 인자·화면 문장에 실제 값은 없다.
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
/** 한 번 실행의 비용 상한(달러). 한도 단가(DeepSeek 공식 피크)로 센다. 한두 사례면 0.01달러 아래다. */
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

// ── 게이트웨이 자리 ──
const usage = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, errors: 0 };
const costUsd = () => ((usage.input - usage.cached) * PRICE.in + usage.cached * PRICE.cached + usage.output * PRICE.out) / 1e6;

interface Call {
  toolset: string;
  /** 이 호출에 같이 보낸 replay 항목 수(0이면 사용자 턴의 첫 호출) */
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
  /** 사용자 턴의 첫 호출에 보낸 글(가린 글) */
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
      // 상류 오류 본문에는 키가 없다(요청 헤더는 찍지 않는다). 앞 300자만 남긴다.
      throw new Error(`upstream ${res ? `${res.status} ${(await res.text().catch(() => '')).slice(0, 300)}` : 'network'}`);
    }
    await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
  }
}

/** 배선 확인용 가짜 상류: [지금]의 문장에 거래처·금액 토큰이 있으면 invoice_draft 한 번, 결과를 받으면 did로 답한다. 요약은 고정 문장. */
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

/** 모델 출력 요약: 항목 종류, 도구 이름·인자, 문장(토큰·슬롯 그대로, 400자까지) */
function brief(i: Record<string, unknown>): Record<string, unknown> {
  if (i.type === 'function_call') return { type: i.type, name: i.name, args: String(i.arguments ?? '').slice(0, 400) };
  if (i.type === 'message') return { type: i.type, content: (i.content as Array<{ type?: string; text?: string }> | undefined)?.map((c) => ({ type: c.type, text: String(c.text ?? '').slice(0, 400) })) };
  return { type: i.type };
}

/** PhoneGateway에 꽂는 fetch. 실제 게이트웨이의 /v1/run-tokens·/v1/respond와 같은 본문을 주고받는다(HTTP 서버 없이). */
function gatewayFetch(sink: Sink) {
  const json = (status: number, v: unknown): HttpResponse => ({ status, text: async () => JSON.stringify(v) });
  return async (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }): Promise<HttpResponse> => {
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    if (url.endsWith('/v1/run-tokens')) return json(200, { runToken: `sxr1.${randomBytes(16).toString('hex')}.eval`, expiresAt: '2099-01-01T00:00:00Z' });
    if (!url.endsWith('/v1/respond')) return json(404, {});
    // 폰 토큰에 열리는 툴셋은 둘뿐이다(게이트웨이 service.ts와 같다)
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

// ── 폰 사본(PC가 넘긴 것으로 치는 가상 장부) ──
/** 오늘(TODAY) 한국 시간 낮 12시 */
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
  /** 모델에 보낸 글(사용자 턴의 첫 호출, 가린 글)과 그 글자 수 */
  input: string;
  calls: Call[];
  /** 모델이 부른 도구 이름(순서대로) */
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
    // 답 뒤에 도는 접기(chat_digest)가 있으면 끝날 때까지 기다린다(다음 턴 로그에 섞이지 않게)
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
    // 사장님이 다음 말을 하기까지 20초(대화 세션은 15분 쉬어야 바뀐다)
    now += 20_000;
  }
  return logs;
}

// ── 채점(사장님 화면 기준, PC 평가 run.ts와 같은 규칙) ──
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
  /** 모델이 낸 답 문장(검사 전, 토큰·슬롯 그대로) */
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
    // 늘 보는 것: 문장이 고정 문장으로 바뀐 턴(사장님에게는 "표를 보세요"만 보인다)
    if ((r.filtered === 'number' || r.filtered === 'slot') && e.filtered !== r.filtered) add(`${r.filtered === 'number' ? '숫자' : '슬롯'} 걸러짐 없음`, false, raw);
    if (text === PHONE_SLOT_MISSING_TEXT) add('슬롯 채움', false, raw);
  }
  for (const s of e.says ?? []) add(`문장에 "${s}"`, text.includes(s), text);
  if (e.saysAny?.length) add(`문장에 ${e.saysAny.join('|')}`, e.saysAny.some((s) => text.includes(s)), text);
  // 남의 말을 옮기거나 부정하는 꼴("발급됐다고 말하지 않아요")은 주장이 아니다
  const claims = (w: string) => [...text.matchAll(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].some((m) => !/^\S*?다고/u.test(text.slice(m.index! + w.length)));
  for (const s of e.notSays ?? []) add(`문장에 "${s}" 없음`, !claims(s), text);
  return out;
}

// ── 로그(사람이 읽는다) ──
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
  // 한 번에 한 사례씩 차례로 돌린다: 로그가 섞이지 않고, 분당 한도에도 걸리지 않는다
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
