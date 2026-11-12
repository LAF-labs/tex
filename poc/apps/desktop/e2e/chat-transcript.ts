// 대화 녹취(agent-chat 설계 근거): 실제 셸(시연 fixture, 격리 프로필)에 시나리오 문장을 차례로 보내고 턴마다 화면에 새로 생긴 것을 적는다.
// 실행: electron apps/desktop/e2e-dist/chat-transcript.js <출력.json>
// 해석기는 "정답 판정"(intent_route_v1이 가장 잘 고른 경우)이고, chat.respond 자리는 녹취 대역(CHAT_STUB)이다. 대역 문장은 녹취에 [대역]으로 적는다.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { IntentResolver, IntentRoute } from '../dist/intent-route.js';
import type { ChatReply, ChatResponder } from '../dist/chat-reply.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-chat-transcript-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});
const OUT = process.argv.find((a) => a.endsWith('.json')) ?? path.join(process.cwd(), 'chat-transcript.json');

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
  [/못\s*받은\s*돈/, { reply: '받을 돈 확인은 아직 도와드리지 못해요. 세금계산서 발급과 증명서 발급을 할 수 있어요.', kind: 'out_of_scope', suggest: ['hometax.invoice.issue'], filtered: null }],
  [/취소/, { reply: '어떤 것을 취소할까요? 조금 더 자세히 말씀해 주세요.', kind: 'clarify', suggest: [], filtered: null }],
  [/얼마였/, { reply: '어떤 금액을 말씀하시는지 알려 주시면 도와드릴게요.', kind: 'clarify', suggest: [], filtered: null }],
];
const chatSeen: string[] = [];
const chatter: ChatResponder = {
  async respond(text) {
    chatSeen.push(text);
    return { reply: CHAT_STUB.find(([re]) => re.test(text))?.[1] ?? { reply: '그 일은 도와드리지 못해요. 세금계산서 발급이나 증명서를 도와드릴 수 있어요.', kind: 'out_of_scope', suggest: ['hometax.invoice.issue'], filtered: null } };
  },
};

const snapshot = () =>
  js<string[]>(`[...document.querySelector('.sx-thread').children].map((e) => (e.dataset.run ? '[카드] ' : e.matches('[data-chat-reply]') ? '[모델 답] ' : '') + e.innerText.replace(/\\s+/g, ' ').trim()).filter(Boolean)`);

async function turn(text: string) {
  const before = await snapshot();
  const r0 = seen.length;
  const c0 = chatSeen.length;
  const t0 = Date.now();
  await js(`(() => { const t = document.querySelector('#composer'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
  let after = before;
  for (let i = 0; i < 120; i++) {
    await sleep(25);
    after = await snapshot();
    if (after.length > before.length + 1) break;
  }
  await sleep(200);
  after = await snapshot();
  const fresh = after.slice(before.length).filter((x) => x.replace(/\s+/g, '') !== text.replace(/\s+/g, ''));
  const changed = before.map((b, i) => (after[i] !== b ? { was: b, now: after[i] } : null)).filter(Boolean);
  return { user: text, app: fresh, changedEarlier: changed, calls: { intent: seen.length - r0, chat: chatSeen.length - c0, chatSaw: chatSeen.slice(c0) }, ms: Date.now() - t0 };
}

app.whenReady().then(async () => {
  const log: unknown[] = [];
  try {
    S = await startShell({ dev: DEMO_DEV, width: 1280, height: 900, show: false, intent: resolver, chat: chatter });
    await S.ready;
    for (let i = 0; i < 200 && (await js('document.body.dataset.ready')) !== '1'; i++) await sleep(25);
    const cps = await js<string[]>(`(async () => (await window.sax.call('counterparties.list', {})).map((c) => c.name))()`);
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
    log.push({ counterparties: cps });
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
