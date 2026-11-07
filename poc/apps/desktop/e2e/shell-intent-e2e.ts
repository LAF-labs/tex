// 대화 의도 e2e(M4-3 ③, intent-route.ts): 입력창 → main → 해석기(엔진 intent.resolve 대역) → 확인 카드(초안)·되묻기·고정 문구.
// 엔진 판정 결과마다(작업 고름·세무 질문 섞임·세무 상담 거절·모름·아직 대화에서 열지 않는 작업) 화면을 보고, 엔진에 명령이 없을 때 오프라인 정규식으로 가는지 본다.
// 실행: electron apps/desktop/e2e-dist/shell-intent-e2e.js. 시연 fixture(가짜 홈택스) 위에서 돈다. 실행(발급 준비)은 누르지 않는다.
import { rmSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { IntentResolver, IntentRoute } from '../dist/intent-route.js';
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

const runs = () => js<number>(`document.querySelectorAll('[data-run]').length`);
const lastApp = () => js<string>(`[...document.querySelectorAll('.sx-thread .sx-app')].map((e) => e.textContent).filter(Boolean).pop() ?? ''`);
const threadText = () => js<string>(`document.querySelector('.sx-thread')?.textContent ?? ''`);
const interp = () => js<string>(`document.querySelector('[data-interp]')?.dataset.interp ?? ''`);
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
  check('모델이 고른 해석은 화면 구석에 모델 해석', (await interp()) === 'model');
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
  check('규칙(L0)이 고른 해석은 오프라인 해석', (await interp()) === 'offline');

  // 5) 모름 → 기본 안내
  answer = () => ({ outcome: 'unknown', via: 'model' });
  await send('오늘 날씨 어때');
  check('모름 → 세금계산서·증명서 안내', await until('unknown', async () => (await lastApp()).includes('세금계산서나 증명서를 말해 주세요')));

  // 6) 엔진에 명령이 없다(unknown_method) → 오프라인 정규식으로 같은 카드
  n0 = await runs();
  answer = () => new Error('unknown_method');
  await send(`${cpName}에 220만원 세금계산서`);
  check('엔진 명령 없음 → 오프라인 정규식 카드', (await until('offline draft', async () => (await runs()) === n0 + 1)) && (await interp()) === 'offline');

  // 7) 판정 불가(decide.unavailable: 게이트웨이 미설정·로그인 전, 지금 제품의 기본 길) → 오프라인 정규식 카드, 화면에 '데모' 없음
  answer = () => ({ outcome: 'route', playbook: 'hometax.invoice.issue', adviceMentioned: false, via: 'model' });
  await send(`${cpName}에 10만원 세금계산서`);
  await until('model again', async () => (await interp()) === 'model');
  n0 = await runs();
  answer = () => new Error('decide.unavailable');
  await send(`${cpName}에 110만원 세금계산서`);
  check('판정 불가 → 오프라인 정규식 카드, 구석 표시는 오프라인 해석으로 돌아온다', (await until('unavailable draft', async () => (await runs()) === n0 + 1)) && (await interp()) === 'offline');
  await send('사업자등록증명 떼 줘');
  check('판정 불가 + 증명서 → 고정 안내(제품 화면에 "데모" 없음)', await until('cert offline', async () => (await lastApp()).startsWith('증명서 발급은 곧') && !(await lastApp()).includes('데모')));
  check('대화 중 실행된 것 없음(모두 초안)', !(await threadText()).includes('발급했어요'));

  // 8) 판정 불가 + 상담 낱말(D04 §3 오프라인 보강, 팀장 결정 2026-11-07): 카드는 그대로, 고정 문구만 덧붙는다. 판정 불가가 아니면(명령 없음) 붙이지 않는다.
  const adviceNotes = () => js<number>(`document.querySelectorAll('[data-advice-note]').length`);
  answer = () => new Error('decide.unavailable');
  let a0 = await adviceNotes();
  n0 = await runs();
  await send(`${cpName}에 120만원 세금계산서 끊고 절세 방법도 알려줘`);
  check('판정 불가 + 상담 섞임 → 카드 그대로 + 고정 문구', (await until('offline advice draft', async () => (await runs()) === n0 + 1)) && (await until('offline advice note', async () => (await adviceNotes()) === a0 + 1)) && (await js<string>(`[...document.querySelectorAll('[data-advice-note]')].pop().textContent`)) === ADVICE);
  a0 = await adviceNotes();
  n0 = await runs();
  await send(`${cpName}에 130만원 세금계산서`);
  await until('offline plain draft', async () => (await runs()) === n0 + 1);
  await sleep(200);
  check('판정 불가 + 상담 없음 → 고정 문구 없음', (await adviceNotes()) === a0);
  answer = () => new Error('unknown_method');
  n0 = await runs();
  await send(`${cpName}에 140만원 세금계산서 끊고 절세 방법도 알려줘`);
  await until('no-method draft', async () => (await runs()) === n0 + 1);
  await sleep(200);
  check('명령 없음(판정 불가 아님) + 상담 낱말 → 고정 문구 없음(오프라인 보강은 decide.unavailable만)', (await adviceNotes()) === a0);
}

app.whenReady().then(async () => {
  try {
    S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, intent: resolver });
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
