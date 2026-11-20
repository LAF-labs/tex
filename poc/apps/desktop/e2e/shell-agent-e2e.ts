import './os-guard.js';
import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { StepParams, StepResult, ToolOutput, DomainCall } from '@sax/engine';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-agent-${process.pid}`);
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

type Step = (p: StepParams) => StepResult | Error;
let plan: Step[] = [];
const sent: StepParams[] = [];
const step = async (p: StepParams): Promise<StepResult> => {
  sent.push(structuredClone(p));
  await sleep(250);
  const f = plan.shift();
  if (!f) throw new Error('chat.unavailable');
  const r = f(p);
  if (r instanceof Error) throw r;
  return r;
};
const tools = (...calls: DomainCall[]): StepResult => ({ kind: 'tools', calls: calls.map((c, i) => ({ callId: `call-${i}`, ...c })) });
const reply = (r: Partial<Extract<StepResult, { kind: 'reply' }>['reply']>): StepResult => ({ kind: 'reply', reply: { kind: 'answer', text: '확인했어요.', show: [], ask: null, filtered: null, values: {}, unknownName: null, ...r } });
const outputs = (p: StepParams): ToolOutput[] => ('continue' in p ? p.continue.outputs.map((o) => o.output) : []);
const frameCards = (p: StepParams) => ('start' in p ? p.start.frame.cards : []);

const cards = () => js<Array<{ id: string; status: string; text: string }>>(`[...document.querySelectorAll('[data-run]')].map((e) => ({ id: e.dataset.run, status: e.dataset.status, text: e.textContent }))`);
const lastAgent = () => js<{ text: string; tables: Array<{ kind: string; title: string; rows: number }>; chips: string[]; disabled: boolean[] } | null>(`(() => { const b = [...document.querySelectorAll('[data-agent-reply]')].pop(); if (!b) return null; return { text: b.querySelector('p').textContent, tables: [...b.querySelectorAll('[data-agent-table]')].map((t) => ({ kind: t.dataset.agentTable, title: t.querySelector('.sx-agent-table-title').textContent, rows: t.querySelectorAll('tr').length })), chips: [...b.querySelectorAll('[data-agent-chip], [data-act="ask-cp-add"]')].map((c) => c.textContent), disabled: [...b.querySelectorAll('[data-agent-chip]')].map((c) => c.disabled) }; })()`);
const agentReplies = () => js<number>(`document.querySelectorAll('[data-agent-reply]').length`);
async function send(text: string) {
  await js(`(() => { const t = document.querySelector('#composer'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
}
async function turn(text: string, ...steps: Step[]) {
  plan = steps;
  const n = await agentReplies();
  const u = await js<number>(`document.querySelectorAll('[data-intent-unavailable]').length`);
  await send(text);
  await until(text, async () => (await agentReplies()) > n || (await js<number>(`document.querySelectorAll('[data-intent-unavailable]').length`)) > u);
  await until(`${text} 끝`, async () => !(await js<boolean>(`!!document.querySelector('[data-agent-progress]')`)));
  check(`${text}: 각본을 다 썼다`, plan.length === 0, plan.length);
}

async function flow() {
  await S!.ready;
  await until('ready', async () => (await js('document.body.dataset.ready')) === '1');
  const cp = await js<{ id: string; name: string } | null>(`(async () => { const c = (await window.sax.call('counterparties.list', {}))[0]; return c ? { id: c.id, name: c.name } : null; })()`).catch(() => null);
  check('시연 거래처가 있다', !!cp, cp);
  if (!cp) return;
  check('입력창 자리표시에 증명서 약속이 없다', !(await js<string>(`document.querySelector('#composer').placeholder`)).includes('증명서'));
  await js(`(() => { window.__phases = []; new MutationObserver(() => { const e = document.querySelector('[data-agent-progress]'); if (e && window.__phases.at(-1) !== e.dataset.agentProgress) window.__phases.push(e.dataset.agentProgress); }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-agent-progress'] }); })()`);

  const quick0 = await js<string[]>(`[...document.querySelectorAll('#quick [data-prompt]')].map((b) => b.dataset.prompt)`);
  check('첫 화면: 빠른 실행 칩이 있고 등본 칩도 있다', quick0.length > 0 && quick0.includes('주민등록등본 떼 줘'), quick0);
  await turn('세금계산서 끊어줘', () => reply({ kind: 'ask', text: '어느 거래처에 보낼까요?', ask: 'counterparty' }));
  check('카드 없이 되묻는 동안 빠른 실행 칩이 숨는다(M1)', (await cards()).length === 0 && (await js<number>(`document.querySelector('#quick').children.length`)) === 0, await js<number>(`document.querySelector('#quick').children.length`));

  let ref = '';
  await turn(
    '지난달 매출 얼마야',
    () => tools({ tool: 'sales_summary', monthOffset: -1 }),
    (p) => {
      ref = outputs(p)[0]!.ref!;
      return reply({ text: `지난달 매출은 {${ref}.count}건, 공급가 합계 {${ref}.sum.supply}예요.` });
    },
  );
  let a = await lastAgent();
  check('매출: 문장 슬롯을 채우고 "원이에요"로 조사를 맞춘다', !!a && /^지난달 매출은 \d+건, 공급가 합계 [\d,]+원이에요\.$/.test(a.text), a?.text);
  check('매출: 슬롯이 가리키는 표가 같이 보이고 제목에 건수·공급가·합계', !!a && a.tables.length === 1 && a.tables[0]!.kind === 'sales' && /발급 \d+건 · 공급가 [\d,]+원 · 합계 [\d,]+원/.test(a.tables[0]!.title), a?.tables);
  if (process.env.SAX_E2E_SHOT) writeFileSync(process.env.SAX_E2E_SHOT, (await S!.win.webContents.capturePage()).toPNG());
  check('진행 단계: 생각 중 → 장부 보는 중', JSON.stringify(await js('window.__phases')).includes('"thinking","reading"'), await js('window.__phases'));

  const c0 = (await cards()).length;
  await js('window.__phases = []');
  await turn(
    `${cp.name}에 세금계산서 끊어줘 110만원`,
    () => tools({ tool: 'invoice_draft', counterpartyId: cp.id, amount: { value: 1_100_000 }, vat: null, item: '컨설팅' }),
    (p) => reply({ kind: 'did', text: '[NAME_1]으로 보낼 카드를 만들었어요.', values: { '[NAME_1]': cp.name }, show: [outputs(p)[0]!.ref!] }),
  );
  a = await lastAgent();
  const after = await cards();
  check('카드: 하나 생기고 초안이다', after.length === c0 + 1 && after.at(-1)!.status === 'draft', after);
  check('카드: 거래처 이름과 조사(로)', a?.text === `${cp.name}${/[가-힣]$/.test(cp.name) && (cp.name.charCodeAt(cp.name.length - 1) - 0xac00) % 28 !== 0 && (cp.name.charCodeAt(cp.name.length - 1) - 0xac00) % 28 !== 8 ? '으로' : '로'} 보낼 카드를 만들었어요.`, a?.text);
  check('진행 단계: 카드 만드는 중', JSON.stringify(await js('window.__phases')).includes('drafting'), await js('window.__phases'));
  const runId = after.at(-1)!.id;

  let frameSeen: unknown = null;
  await turn(
    '아 부가세 별도로',
    (p) => {
      frameSeen = frameCards(p);
      return tools({ tool: 'draft_edit', draft: frameCards(p).at(-1)!.ref, amount: null, vat: 'separate', item: null });
    },
    () => reply({ kind: 'did', text: '부가세 별도로 확정했어요.' }),
  );
  const edited = (await cards()).find((c) => c.id === runId)!;
  check('고치기: 프레임에 카드 ref와 열거 값만', JSON.stringify(frameSeen).includes('"amount":true') && !JSON.stringify(frameSeen).includes(cp.name) && !/1100000|1,100,000/.test(JSON.stringify(frameSeen)), frameSeen);
  check('고치기: 카드가 부가세 별도(추정 아님)', edited.text.includes('부가세 별도') && !edited.text.includes('계산했어요'), edited.text);

  await turn('세금계산서 하나 더', () => reply({ kind: 'ask', text: '어느 거래처에 보낼까요?', ask: 'counterparty' }));
  a = await lastAgent();
  check('되묻기: 장부 거래처 칩 + [거래처 추가]', !!a && a.chips.includes(cp.name) && a.chips.includes('거래처 추가'), a?.chips);
  check('되묻기: 빠른 실행 칩이 숨는다', (await js<number>(`document.querySelector('#quick').children.length`)) === 0);
  plan = [() => reply({ kind: 'cannot', text: '알겠어요.' })];
  const r0 = await agentReplies();
  await js(`[...[...document.querySelectorAll('[data-agent-reply]')].pop().querySelectorAll('[data-agent-chip]')].find((c) => c.textContent === ${JSON.stringify(cp.name)}).click()`);
  check('칩을 누르면 그 이름을 바로 보낸다', (await until('chip send', async () => (await agentReplies()) > r0)) && (await js<string>(`[...document.querySelectorAll('.sx-me')].pop().textContent`)) === cp.name);
  check('보낸 뒤 앞 되묻기 칩은 꺼진다', (await js<boolean[]>(`[...document.querySelectorAll('[data-agent-chip]')].map((c) => c.disabled)`)).every(Boolean));

  await turn(
    '아까 그거 취소해',
    (p) => tools({ tool: 'draft_discard', draft: frameCards(p).at(-1)!.ref }),
    () => reply({ kind: 'did', text: '방금 카드를 취소했어요.' }),
  );
  check('취소: 카드가 "취소함"이 된다', await until('discarded', async () => (await cards()).find((c) => c.id === runId)?.status === 'discarded'), await cards());
  await turn('카드 남은 거 있어?', (p) => (frameSeen = frameCards(p), reply({ text: '열린 카드가 없어요.' })));
  check('취소: 다음 턴 프레임에 그 카드가 없다', Array.isArray(frameSeen) && (frameSeen as unknown[]).length === 0, frameSeen);

  await turn('지난주 발급 보여줘', () => new Error('chat.unavailable'));
  check('연결 안 됨 → [다시 시도]', (await js<number>(`document.querySelectorAll('[data-act="intent-retry"]:not([disabled])').length`)) === 1);
  const failText = await js<string>(`[...document.querySelectorAll('[data-intent-unavailable] p')].pop().textContent`);
  check('실패 문구는 원인을 단정하지 않는다(U8-5)', failText === '답을 받지 못했어요. 잠시 뒤 [다시 시도]를 눌러 주세요.' && !/인터넷|연결/.test(failText), failText);
  await turn('고마워', () => reply({ kind: 'answer', text: '천만에요.' }));
  check('새 문장 뒤 앞 [다시 시도]는 꺼진다', (await js<number>(`document.querySelectorAll('[data-act="intent-retry"]:not([disabled])').length`)) === 0);

  const recv: string[] = [];
  const recvTurn = (text: string) =>
    turn(
      text,
      () => tools({ tool: 'receivables', counterpartyId: null }),
      (p) => {
        recv.push(outputs(p)[0]!.status);
        return reply({ text: '확인했어요.' });
      },
    );
  await recvTurn('받을 돈 있어?');
  await js(`(async () => { await window.sax.call('bank.consent', {}); await window.sax.call('bank.addAccount', { bank: '견본은행', number: '110-000-000001', alias: '시험 계좌' }); })()`);
  await recvTurn('받을 돈 다시 봐줘');
  check('받을 돈: 계좌 전 not_set_up, 계좌 뒤에는 조회 결과(ok·empty)', recv[0] === 'not_set_up' && (recv[1] === 'ok' || recv[1] === 'empty'), recv);

  const n24 = sent.length;
  await send('주민등록등본 떼 줘');
  check('등본 요청 → 정부24 안내 패널, chat.step 부르지 않음', (await until('g24 panel', async () => (await js<number>(`document.querySelectorAll('[data-g24-panel]').length`)) > 0)) && sent.length === n24, sent.length - n24);

  await turn('라온상사에 세금계산서 끊어줘', () => reply({ kind: 'ask', text: '어느 거래처에 보낼까요?', ask: 'counterparty', unknownName: '라온상사' }));
  const unk = await js<{ text: string; adds: number } | null>(`(() => { const b = [...document.querySelectorAll('[data-agent-reply]')].pop(); const u = b.querySelector('[data-unknown-name]'); return u ? { text: u.textContent, adds: b.querySelectorAll('[data-act="ask-cp-add"]').length } : null; })()`);
  check('장부에 없는 이름: 안내 문장(조사 맞춤)과 [거래처 추가] 하나', unk?.text === '라온상사는 거래처 목록에 없어요.' && unk.adds === 1, unk);
  await js(`[...document.querySelectorAll('[data-agent-reply]')].pop().querySelector('[data-act="ask-cp-add"]').click()`);
  check('[거래처 추가] → 그 이름이 채워진 추가 폼', await until('cp form', async () => (await js<string>(`document.querySelector('[data-panel-cp-edit="new"] [name="name"]')?.value ?? ''`)) === '라온상사'));

  const conts = sent.filter((p) => 'continue' in p).map((p) => JSON.stringify(p).replace(/"(?:ref|callId)":"[^"]*"/g, ''));
  check('도구 결과에 숫자·거래처 이름이 없다', conts.length > 0 && conts.every((j) => !/\d/.test(j) && !j.includes(cp.name)), conts);
  check('대화로는 어떤 카드도 준비·발급되지 않았다', (await cards()).every((c) => c.status === 'draft' || c.status === 'discarded'), await cards());
}

app.whenReady().then(async () => {
  try {
    S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, demoSeed: true, agent: { step } });
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
