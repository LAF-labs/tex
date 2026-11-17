// 대화 의도 e2e(M4-3 ③, intent-route.ts): 입력창 → main → 해석기(엔진 intent.resolve 대역) → 확인 카드(초안)·되묻기·고정 문구.
// 엔진 판정 결과마다(작업 고름·세무 질문 섞임·세무 상담 거절·모름·아직 대화에서 열지 않는 작업) 화면을 보고, 엔진에 명령이 없을 때 오프라인 정규식으로 가는지 본다.
// 실행: electron apps/desktop/e2e-dist/shell-intent-e2e.js. 시연 fixture(가짜 홈택스) 위에서 돈다. 실행(발급 준비)은 누르지 않는다.
import './os-guard.js'; // 실제 Finder·브라우저·대화상자를 띄우지 않는다(맨 먼저)
import { rmSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { IntentResolver, IntentRoute } from '../dist/intent-route.js';
import type { ChatReply, ChatResponder } from '../dist/chat-reply.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-intent-${process.pid}`);
app.setPath('userData', USER_DATA);
process.once('exit', () => rmSync(USER_DATA, { recursive: true, force: true, maxRetries: 2 }));
app.on('window-all-closed', () => {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
let S: Shell | undefined;
const js = <T = unknown>(code: string): Promise<T> => S!.win.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => Promise<boolean>, ms = 8_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
const ADVICE = '세무 판단은 하지 않아요. 세무 대리인과 상담해 주세요.';

// 엔진 intent.resolve 대역: 받은 문장을 적고, 문장마다 정한 판정을 돌려준다.
const seen: string[] = [];
let answer: (t: string) => IntentRoute | Error = () => ({ outcome: 'unknown', via: 'model' });
const resolver: IntentResolver = {
  async resolve(text) {
    seen.push(text);
    const a = answer(text);
    if (a instanceof Error) return { route: null, fallback: a.message };
    return { route: a, fallback: null };
  },
};

// 엔진 chat.respond 대역(chat-reply.ts 계약): 받은 문장을 적고, 정한 답이나 오류 코드를 돌려준다.
const chatSeen: string[] = [];
let chatAnswer: () => ChatReply | Error = () => ({ reply: '무엇을 도와드릴까요?', kind: 'help', suggest: [], filtered: null });
const chatter: ChatResponder = {
  async respond(text) {
    chatSeen.push(text);
    const a = chatAnswer();
    return a instanceof Error ? { error: a.message as never } : { reply: a };
  },
};

const runs = () => js<number>(`document.querySelectorAll('[data-run]').length`);
const lastApp = () => js<string>(`[...document.querySelectorAll('.sx-thread .sx-app')].map((e) => e.textContent).filter(Boolean).pop() ?? ''`);
const threadText = () => js<string>(`document.querySelector('.sx-thread')?.textContent ?? ''`);
const unavailable = () => js<number>(`document.querySelectorAll('[data-intent-unavailable]').length`);
async function send(text: string) {
  await js(`(() => { const t = document.querySelector('#composer'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
}

async function flow() {
  await S!.ready;
  await until('ready', async () => (await js('document.body.dataset.ready')) === '1');
  const cpName = await js<string>(`(async () => (await window.sax.call('counterparties.list', {}))[0]?.name ?? '')()`).catch(() => '');
  check('시연 거래처가 있다', !!cpName, cpName);

  // 1) 작업 고름(세금계산서) + 로컬 인자 → 확인 카드(초안). 실행은 하지 않는다.
  answer = () => ({ outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'model' });
  let n0 = await runs();
  await send(`${cpName}에 330만원 끊어줘`);
  check('작업 고름 → 확인 카드 하나', await until('draft', async () => (await runs()) === n0 + 1));
  check('카드에 로컬 파서 인자(거래처·금액)', (await js<string>(`[...document.querySelectorAll('[data-run]')].pop().textContent`)).includes(cpName) && /3,000,000|3,300,000|330만/.test(await js<string>(`[...document.querySelectorAll('[data-run]')].pop().textContent`)));
  check('제목줄에 해석 경로 표시(모델 해석/오프라인 해석)가 없다', !(await js<string>(`document.querySelector('#titlebar').textContent`)).includes('해석'));
  check('해석기에는 입력 문장만 간다', seen.at(-1) === `${cpName}에 330만원 끊어줘`, seen);

  // 2) 세무 질문이 섞임: 작업은 하고 고정 문구만
  n0 = await runs();
  answer = () => ({ outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: true, via: 'model' });
  await send(`${cpName}에 110만원 계산서 끊고 이거 경비 처리 돼?`);
  check('세무 질문 섞임 → 카드 + 고정 문구', (await until('draft2', async () => (await runs()) === n0 + 1)) && (await js<number>(`document.querySelectorAll('[data-advice-note]').length`)) === 1);
  check('고정 문구 그대로(D04 §3)', (await js<string>(`document.querySelector('[data-advice-note]').textContent`)) === ADVICE);

  // 3) 세무 상담 거절: 카드 없음, 고정 문구
  n0 = await runs();
  answer = () => ({ outcome: 'refuse_advice', via: 'model' });
  await send('이번 부가세 얼마 나와요? 공제 되나요');
  check('세무 상담 → 고정 문구, 카드 없음', (await until('refuse', async () => (await lastApp()) === ADVICE)) && (await runs()) === n0);

  // 4) 아직 대화에서 열지 않는 작업(급여대장): 안내만
  answer = () => ({ outcome: 'route', playbook: 'payroll.ledger', adviceMentioned: false, via: 'l0' });
  await send('이번 달 급여대장 정리해줘');
  check('급여대장 → 곧 안내(계산·실행 없음)', await until('soon', async () => (await lastApp()).startsWith('급여대장은(는) 곧')));

  // 5) 모름 → 모델이 짧게 답한다(chat.respond). 답은 글자로만, 제안 작업은 입력창을 채우는 칩
  answer = () => ({ outcome: 'unknown', via: 'model' });
  chatAnswer = () => ({ reply: '<b>날씨</b>는 알려 드리지 못해요. 세금계산서 발급을 도와드릴 수 있어요.', kind: 'out_of_scope', suggest: ['hometax.invoice.issue'], filtered: null });
  n0 = await runs();
  await send('오늘 날씨 어때');
  const lastReply = () => js<{ text: string; html: boolean; chips: string[]; filtered: string | null } | null>(`(() => { const b = [...document.querySelectorAll('[data-chat-reply]')].pop(); return b ? { text: b.querySelector('p').textContent, html: !!b.querySelector('p b'), chips: [...b.querySelectorAll('[data-chat-suggest]')].map((c) => c.dataset.chatSuggest + ':' + c.textContent), filtered: b.dataset.chatReply } : null; })()`);
  check('모름 → chat.respond에 문장 그대로, 답은 텍스트 노드(태그 해석 없음)', (await until('chat reply', async () => !!(await lastReply()))) && chatSeen.at(-1) === '오늘 날씨 어때' && (await lastReply())!.text.startsWith('<b>날씨</b>') && !(await lastReply())!.html);
  // 제안 칩은 대화 모델 도구 목록(packages/model chat_reply)에서 온다. 민원증명은 해석 전에 이 PC 규칙으로 바로 시작하므로 칩에 없다
  check('제안 칩 1개(세금계산서 발급), 카드는 생기지 않는다', JSON.stringify((await lastReply())!.chips) === JSON.stringify(['hometax.invoice.issue:세금계산서 발급']) && (await runs()) === n0);
  check('고정 문구(빈 요청 안내)가 기본 답이 아니다', !(await lastApp()).includes('세금계산서 발급이나 지난 발급·매출을 말해 주세요'));
  await js(`[...document.querySelectorAll('[data-chat-suggest="hometax.invoice.issue"]')].pop().click()`);
  check('칩을 누르면 입력창에 시작 문장만 채운다(보내지 않음, 실행 없음)', (await js<string>(`document.querySelector('#composer').value`)) === '세금계산서 ' && (await runs()) === n0);
  await js(`(() => { const t = document.querySelector('#composer'); t.value = ''; t.dispatchEvent(new Event('input')); })()`);
  chatAnswer = () => ({ reply: '세무 판단은 하지 않아요. 세무 대리인과 상담해 주세요.', kind: 'tax_advice', suggest: [], filtered: 'advice' });
  await send('이거 경비로 넣어도 돼?');
  check('filtered(advice) → 엔진 고정 문구 그대로, 칩 없음', (await until('filtered', async () => (await lastReply())?.filtered === 'advice')) && (await lastReply())!.text === ADVICE && (await lastReply())!.chips.length === 0);

  // 5b) 대화 응대 오류 코드 → 문구. 연결 안 됨·응답 이상·예산은 [다시 시도], 한도·긴 문장·비밀 값은 문장만
  const ERR: Array<[string, string, boolean]> = [
    ['chat.unavailable', '지금 AI 모델에 연결하지 못했어요', true],
    ['chat.bad_response', '지금 AI 모델에 연결하지 못했어요', true],
    ['chat.budget_exceeded', '잠시 뒤에 다시', true],
    ['chat.quota_exceeded', '이번 달 대화 한도', false],
    ['chat.input_too_large', '짧게 나눠서', false],
    ['chat.secret_rejected', '대화창에 입력하지 마세요', false],
  ];
  for (const [code, words, retry] of ERR) {
    const u0 = await unavailable();
    n0 = await runs();
    chatAnswer = () => new Error(code);
    await send(`잡담 ${code}`);
    const got = (await until(`chat ${code}`, async () => (await unavailable()) === u0 + 1)) && (await js<{ t: string; r: boolean }>(`(() => { const b = [...document.querySelectorAll('[data-intent-unavailable]')].pop(); return { t: b.textContent, r: !!b.querySelector('[data-act=intent-retry]') }; })()`));
    check(`${code} → "${words}"${retry ? ' + [다시 시도]' : ', 다시 시도 없음'}, 카드 없음`, !!got && got.t.includes(words) && got.r === retry && (await runs()) === n0, got);
  }
  // 새 문장을 보낸 뒤에는 앞 답의 [다시 시도]가 꺼진다(눌러도 지난 문장을 다시 보내지 않게, 대화 에이전트 PR-B)
  check('새 문장 뒤 앞 [다시 시도]는 모두 꺼진다', (await js<number>(`document.querySelectorAll('[data-act=intent-retry]:not([disabled])').length`)) === 0);
  // [다시 시도]가 대화 응대도 다시 부른다(가장 최근 답의 버튼)
  chatAnswer = () => new Error('chat.budget_exceeded');
  const u9 = await unavailable();
  await send('잡담 chat.budget_exceeded');
  await until('budget again', async () => (await unavailable()) === u9 + 1);
  const c0 = chatSeen.length;
  chatAnswer = () => ({ reply: '네, 다시 말씀해 주세요.', kind: 'clarify', suggest: [], filtered: null });
  await js(`[...document.querySelectorAll('[data-act=intent-retry]')].pop().click()`);
  check('[다시 시도] → 같은 문장으로 해석·응대를 다시', (await until('chat retry', async () => (await lastReply())?.text === '네, 다시 말씀해 주세요.')) && chatSeen.length === c0 + 1 && chatSeen.at(-1) === '잡담 chat.budget_exceeded');
  chatAnswer = () => ({ reply: '무엇을 도와드릴까요?', kind: 'help', suggest: [], filtered: null });

  // 6) 오프라인 해석은 없다(사용자 결정 2026-11-10): 판정 못 함(명령 없음·판정 불가·시간 초과)이면 정규식으로 카드를 만들지 않고
  //    "연결하지 못했어요" + [다시 시도]. 되묻던 것·입력 값은 그대로 두고, [다시 시도]가 같은 문장을 다시 보낸다.
  for (const code of ['unknown_method', 'decide.unavailable', 'timeout']) {
    n0 = await runs();
    const u0 = await unavailable();
    answer = () => new Error(code);
    await send(`${cpName}에 220만원 세금계산서`);
    check(`판정 못 함(${code}) → 카드 없이 연결 안 됨 + [다시 시도]`, (await until(`unavailable ${code}`, async () => (await unavailable()) === u0 + 1)) && (await runs()) === n0 && (await js<boolean>(`!![...document.querySelectorAll('[data-intent-unavailable]')].pop().querySelector('[data-act=intent-retry]')`)));
  }
  check('연결 안 됨 문장(정해진 문구, "데모" 없음)', (await lastApp()).startsWith('지금 AI 모델에 연결하지 못했어요') && !(await lastApp()).includes('데모'), await lastApp());
  // [다시 시도]: 이번에는 모델이 고른다 → 같은 문장으로 카드 하나, 연결 안 됨 말풍선은 걷힌다
  n0 = await runs();
  const u1 = await unavailable();
  const s0 = seen.length;
  answer = () => ({ outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'model' });
  await js(`[...document.querySelectorAll('[data-act=intent-retry]')].pop().click()`);
  check('[다시 시도] → 같은 문장으로 다시 묻고 카드 하나', (await until('retry draft', async () => (await runs()) === n0 + 1)) && seen.length === s0 + 1 && seen.at(-1) === `${cpName}에 220만원 세금계산서` && (await unavailable()) === u1 - 1);

  // 7) 되묻던 중 판정 못 함: 되묻기(거래처)가 남아 다음 답으로 이어 간다
  answer = () => ({ outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'model' });
  await send('세금계산서 끊어줘');
  await until('ask cp', async () => (await lastApp()).includes('어느 거래처에 발급할까요'));
  answer = () => new Error('decide.unavailable');
  const u2 = await unavailable();
  await send(cpName);
  await until('unavailable mid-ask', async () => (await unavailable()) === u2 + 1);
  n0 = await runs();
  answer = () => ({ outcome: 'unknown', via: 'model' });
  await send(cpName);
  const cs = chatSeen.length;
  check('되묻던 것(거래처)은 연결 안 됨 뒤에도 남는다 → 금액을 묻는다(모델이 unknown이어도 대화 응대로 보내지 않음)', (await until('ask amount', async () => (await lastApp()).includes('얼마를 발급할까요'))) && chatSeen.length === cs);
  await send('50만원');
  check('금액 답 → 카드', await until('mid-ask draft', async () => (await runs()) === n0 + 1));
  check('대화 중 실행된 것 없음(모두 초안)', !(await threadText()).includes('발급했어요'));
}

app.whenReady().then(async () => {
  try {
    S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, intent: resolver, chat: chatter });
    S.win.webContents.on('console-message', (e) => {
      if (e.level === 'error') console.log(`  [renderer] ${e.message}`);
    });
    await flow();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await S?.close().catch(() => {});
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`);
  app.exit(results.length && results.every((r) => r.ok) ? 0 : 1);
});
