// 대화 녹취(agent-chat 설계 근거): 실제 셸(시연 fixture, 씨앗 이력, 격리 프로필)에 시나리오 문장을 차례로 보내고 턴마다 화면에 새로 생긴 것을 적는다.
// 실행: electron apps/desktop/e2e-dist/chat-transcript.js <출력.json> [--agent]
// 기본(전, 옛 길): 해석기는 "정답 판정"(intent_route_v1이 가장 잘 고른 경우)이고, chat.respond 자리는 녹취 대역(CHAT_STUB)이다.
// --agent(뒤, 대화 에이전트): main AgentChat·렌더러는 실제이고 chat.step 자리는 녹취 대역(AGENT_STUB)이다. 대역은 머리말을 잘 따르는 모델이 낼 만한
// 도구 호출과 답(슬롯·토큰)을 내고, 엔진이 하는 역치환(이름 → 거래처 id, 오타 별칭)과 세무 차단을 흉내 낸다. 마스킹은 tests/chat-agent.test.ts가 본다.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { IntentResolver, IntentRoute } from '../dist/intent-route.js';
import type { ChatReply, ChatResponder } from '../dist/chat-reply.js';
import type { DomainCall, StepParams, StepResult } from '@sax/engine';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-chat-transcript-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});
const OUT = process.argv.find((a) => a.endsWith('.json')) ?? path.join(process.cwd(), 'chat-transcript.json');
const AGENT = process.argv.includes('--agent');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let S: Shell | undefined;
const js = <T = unknown>(code: string): Promise<T> => S!.win.webContents.executeJavaScript(code) as Promise<T>;

// 정답 판정: 문장마다 intent_route_v1 선택지 중 맞는 것(모델이 틀리지 않은 가장 좋은 경우)
const ROUTES: Array<[RegExp, IntentRoute]> = [
  [/비용\s*처리|경비/, { outcome: 'refuse_advice', via: 'model' }],
  [/매출|매입/, { outcome: 'route', playbook: 'hometax.summary.view', adviceMentioned: false, via: 'model' }],
  [/언제\s*발급|발급했/, { outcome: 'route', playbook: 'hometax.invoice.list', adviceMentioned: false, via: 'model' }],
  [/계산서|끊어|세계/, { outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'model' }],
];
const seen: string[] = [];
const resolver: IntentResolver = {
  async resolve(text) {
    seen.push(text);
    return { route: ROUTES.find(([re]) => re.test(text))?.[1] ?? { outcome: 'unknown', via: 'model' }, fallback: null };
  },
};
// chat_reply 대역: 모델이 받는 것은 이번 문장 하나뿐이라(chat.ts) 앞 턴을 모르고 답한다. 그 조건에서 나올 만한 답을 적어 둔다.
const CHAT_STUB: Array<[RegExp, ChatReply]> = [
  [/부가세\s*별도/, { reply: '부가세 별도로 어떤 일을 할까요? 세금계산서 발급을 도와드릴 수 있어요.', kind: 'clarify', suggest: ['hometax.invoice.issue'], filtered: null }],
  [/못\s*받은\s*돈/, { reply: '받을 돈 확인은 아직 도와드리지 못해요. 세금계산서 발급을 할 수 있어요.', kind: 'out_of_scope', suggest: ['hometax.invoice.issue'], filtered: null }],
  [/취소/, { reply: '어떤 것을 취소할까요? 조금 더 자세히 말씀해 주세요.', kind: 'clarify', suggest: [], filtered: null }],
  [/얼마였/, { reply: '어떤 금액을 말씀하시는지 알려 주시면 도와드릴게요.', kind: 'clarify', suggest: [], filtered: null }],
];
const chatSeen: string[] = [];
const chatter: ChatResponder = {
  async respond(text) {
    chatSeen.push(text);
    return { reply: CHAT_STUB.find(([re]) => re.test(text))?.[1] ?? { reply: '그 일은 도와드리지 못해요. 세금계산서 발급을 도와드릴 수 있어요.', kind: 'out_of_scope', suggest: ['hometax.invoice.issue'], filtered: null } };
  },
};

// chat.step 대역(--agent): 문장마다 도구 호출 하나와 답. 결과 ref는 도구 결과에서, 카드 ref는 화면 프레임에서 읽는다.
type Cp = { id: string; name: string };
let BOOK: Cp[] = [];
const stepSeen: StepParams[] = [];
let lastResult = '';
let pending: ((out: { ref: string | null; status: string }) => StepResult) | null = null;
const R = (r: Partial<Extract<StepResult, { kind: 'reply' }>['reply']>): StepResult => ({ kind: 'reply', reply: { kind: 'answer', text: '', show: [], ask: null, filtered: null, values: {}, unknownName: null, ...r } });
const call = (c: DomainCall): StepResult => ({ kind: 'tools', calls: [{ callId: 'call-1', ...c }] });
/** 엔진 역치환 흉내: 장부 이름, 한 글자 다른 별칭(정확히 한 거래처일 때만) */
const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const cpIn = (t: string): Cp | null => BOOK.find((c) => t.includes(c.name)) ?? BOOK.find((c) => c.name.length >= 3 && [...Array(c.name.length).keys()].some((i) => new RegExp(`${esc(c.name.slice(0, i))}.${esc(c.name.slice(i + 1))}`).test(t))) ?? null;
const tok = (cp: Cp) => ({ '[NAME_1]': cp.name });
const AGENT_STUB: Array<[RegExp, (t: string, p: Extract<StepParams, { start: unknown }>['start']) => StepResult]> = [
  [/비용\s*처리|경비/, () => R({ kind: 'tax_advice', text: '세무 판단은 하지 않아요. 세무 대리인과 상담해 주세요.', filtered: 'advice' })],
  [/매출/, () => ((pending = (o) => R({ text: o.ref ? `지난달 매출은 {${o.ref}.count}건, 공급가 합계 {${o.ref}.sum.supply}예요.` : '지난달에는 발급한 세금계산서가 없어요.', show: o.ref ? [o.ref] : [] })), call({ tool: 'sales_summary', monthOffset: -1 }))],
  [/부가세\s*별도/, (_t, p) => ((pending = (o) => R({ kind: 'did', text: '네, 부가세 별도로 확정했어요. 공급가에 세액을 더한 금액으로 바뀌었어요.', show: o.ref ? [o.ref] : [] })), call({ tool: 'draft_edit', draft: p.frame.cards.at(-1)!.ref, amount: null, vat: 'separate', item: null }))],
  [/못\s*받은\s*돈/, () => ((pending = (o) => R({ text: o.status === 'not_set_up' ? '계좌 연결이 아직이라 받을 돈은 볼 수 없어요. 발급 기록은 바로 보여 드릴 수 있어요.' : '아직 입금이 확인되지 않은 건이에요.', show: o.ref ? [o.ref] : [] })), call({ tool: 'receivables', counterpartyId: null }))],
  [/취소/, (_t, p) => ((pending = () => R({ kind: 'did', text: '방금 만든 카드를 취소했어요. 다른 카드였으면 말씀해 주세요.' })), call({ tool: 'draft_discard', draft: p.frame.cards.at(-1)!.ref }))],
  [/미팅|일정/, () => R({ kind: 'cannot', text: '일정은 잡아 드리지 못해요. 세금계산서 발급이나 지난 발급·매출 확인은 바로 할 수 있어요.' })],
  [/언제\s*발급|발급했/, (t) => {
    const cp = cpIn(t)!;
    pending = (o) => ((lastResult = o.ref ?? ''), R({ text: o.ref ? `[NAME_1]에는 {${o.ref}.first.date}에 마지막으로 발급했어요.` : '[NAME_1]에 발급한 기록이 없어요.', values: tok(cp), show: o.ref ? [o.ref] : [] }));
    return call({ tool: 'invoice_history', counterpartyId: cp.id });
  }],
  [/얼마였/, () => R({ text: `그때는 공급가 {${lastResult}.first.supply}, 합계 {${lastResult}.first.total}이었어요.` })],
  [/같은\s*금액/, () => {
    const cp = cpIn(stepSeen.flatMap((p) => ('start' in p ? [p.start.text] : [])).reverse().find((x) => !!cpIn(x)) ?? '')!;
    pending = (o) => R({ kind: 'did', text: '지난번과 같은 금액으로 카드를 만들었어요.', show: o.ref ? [o.ref] : [] });
    return call({ tool: 'invoice_draft', counterpartyId: cp.id, amount: { slot: `{${lastResult}.first.supply}` }, vat: 'separate', item: null });
  }],
  [/끊어|세계|계산서/, (t) => {
    const cp = cpIn(t)!;
    const m = /(\d+)\s*만/.exec(t);
    const first = !stepSeen.slice(0, -1).some((p) => 'start' in p && /끊어|세계/.test(p.start.text));
    pending = (o) => R({ kind: 'did', text: first ? '[NAME_1]에 보낼 세금계산서 카드를 만들었어요. 금액은 공급가로 보고 부가세를 따로 붙였는데, 합계로 말씀하신 거면 알려 주세요.' : '[NAME_1]에 한 장 더 만들었어요. 앞 카드와 따로예요.', values: tok(cp), show: o.ref ? [o.ref] : [] });
    return call({ tool: 'invoice_draft', counterpartyId: cp.id, amount: m ? { value: Number(m[1]) * 10_000 } : null, vat: null, item: null });
  }],
];
const agentStep = async (p: StepParams): Promise<StepResult> => {
  stepSeen.push(structuredClone(p));
  if ('continue' in p) {
    const f = pending!;
    pending = null;
    return f(p.continue.outputs[0]!.output as { ref: string | null; status: string });
  }
  const hit = AGENT_STUB.find(([re]) => re.test(p.start.text));
  return hit ? hit[1](p.start.text, p.start) : R({ kind: 'cannot', text: '그 일은 아직 도와드리지 못해요.' });
};

const snapshot = () =>
  js<string[]>(`[...document.querySelector('.sx-thread').children].map((e) => (e.dataset.run ? '[카드] ' : e.matches('[data-chat-reply]') ? '[모델 답] ' : e.matches('[data-agent-reply]') ? '[에이전트 답·대역] ' : '') + e.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean)`);

async function turn(text: string) {
  const before = await snapshot();
  const r0 = seen.length;
  const c0 = chatSeen.length;
  const s0 = stepSeen.length;
  const t0 = Date.now();
  await js(`(() => { const t = document.querySelector('#composer'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
  let after = before;
  for (let i = 0; i < 120; i++) {
    await sleep(25);
    after = await snapshot();
    if (after.length > before.length + 1 && !(await js<boolean>(`!!document.querySelector('[data-agent-progress]')`))) break;
  }
  await sleep(200);
  after = await snapshot();
  const fresh = after.slice(before.length).filter((x) => x.replace(/\s+/g, '') !== text.replace(/\s+/g, ''));
  const changed = before.map((b, i) => (after[i] !== b ? { was: b, now: after[i] } : null)).filter(Boolean);
  return { user: text, app: fresh, changedEarlier: changed, calls: { intent: seen.length - r0, chat: chatSeen.length - c0, chatSaw: chatSeen.slice(c0), step: stepSeen.length - s0 }, ms: Date.now() - t0 };
}

app.whenReady().then(async () => {
  const log: unknown[] = [];
  try {
    S = await startShell({ dev: DEMO_DEV, width: 1280, height: 900, show: false, demoSeed: true, ...(AGENT ? { agent: { step: agentStep } } : { intent: resolver, chat: chatter }) });
    await S.ready;
    for (let i = 0; i < 200 && (await js('document.body.dataset.ready')) !== '1'; i++) await sleep(25);
    BOOK = await js<Cp[]>(`(async () => (await window.sax.call('counterparties.list', {})).map((c) => ({ id: c.id, name: c.name })))()`);
    const cps = BOOK.map((c) => c.name);
    const cp = cps[0]!;
    const typo = cp.slice(0, -1) + (cp.endsWith('통') ? '퉁' : '쓰');
    const script = [
      '지난달 매출 얼마야',
      `${cp}에 세금계산서 끊어줘 110만원`,
      '아 부가세 별도로',
      `${typo}에 50만 세계 ㄱㄱ`,
      '이거 비용처리 돼?',
      '아직 못 받은 돈 있어?',
      '아까 그거 취소해',
      '다음 주 화요일에 거래처 미팅 잡아줘',
      `${cp} 마지막으로 언제 발급했지?`,
      '그때 얼마였어?',
      '같은 금액으로 또 끊어줘',
    ];
    log.push({ mode: AGENT ? 'agent(뒤): main AgentChat·렌더러 실제, chat.step 대역' : 'intent(전): 해석기 정답 판정, chat.respond 대역', counterparties: cps });
    for (const s of script) log.push(await turn(s));
    mkdirSync(path.dirname(OUT), { recursive: true });
    writeFileSync(OUT.replace(/\.json$/, '.png'), (await S.win.webContents.capturePage()).toPNG());
  } catch (e) {
    log.push({ error: (e as Error).stack });
  }
  writeFileSync(OUT, JSON.stringify(log, null, 2));
  console.log(`wrote ${OUT}`);
  await S?.close().catch(() => {});
  app.exit(0);
});
