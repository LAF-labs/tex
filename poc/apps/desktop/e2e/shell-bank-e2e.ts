// 받을 돈 e2e(09 1단계): 내 계좌 등록(동의) → 홈택스 발급목록 파일 → 은행 거래내역 파일(HTML 표 .xls) 미리보기·넣기 → 자동/후보 맞춤 →
// [맞아요]·별칭 기억 → [떼기]·[되돌리기] → [받았음 표시](현금) → 판 카드 → 대화 "못 받은 돈 있어?"(로컬 답, 해석기·모델을 부르지 않음).
// 실행: electron apps/desktop/e2e-dist/shell-bank-e2e.js. 시연 fixture(임시 앱 폴더) 위에서 돈다. 파일은 모두 가짜 값으로 만든다(실제 은행·홈택스 접속 없음).
import { rmSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { IntentResolver } from '../dist/intent-route.js';
import type { ChatResponder } from '../dist/chat-reply.js';
import { registerShellSchemes, startShell, type Shell } from '../dist/shell-app.js';
import { DEMO_DEV } from '../dist/demo-dev.js';

registerShellSchemes();
const USER_DATA = path.join(app.getPath('temp'), `sax-e2e-bank-${process.pid}`);
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
    if (await fn().catch(() => false)) return true;
    await sleep(40);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
const gesture = () => S!.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
const click = (sel: string) => js(`(() => { const e = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => !x.disabled); if (!e) throw new Error('no ' + ${JSON.stringify(sel)}); e.click(); })()`);
const text = (sel: string) => js<string>(`[...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.textContent).join(' | ')`);
const count = (sel: string) => js<number>(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const setValue = (sel: string, v: string) => js(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('input')); e.dispatchEvent(new Event('change')); })()`);

// 해석기·대화 대역: 받을 돈 질문이 여기에 오면 안 된다(로컬 규칙으로 답한다)
const seen: string[] = [];
const resolver: IntentResolver = { async resolve(t) { seen.push(t); return { route: { outcome: 'unknown', via: 'model' }, fallback: null }; } };
const chatter: ChatResponder = { async respond(t) { seen.push(t); return { reply: { reply: '무엇을 도와드릴까요?', kind: 'help', suggest: [], filtered: null } }; } };

// 가짜 파일(실제 값 없음). pick 차례마다 다음 파일을 준다.
const queue: Uint8Array[] = [];
const enc = (s: string) => new TextEncoder().encode(s);
const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

async function flow() {
  await S!.ready;
  await until('ready', async () => (await js('document.body.dataset.ready')) === '1');
  const cps = await js<Array<{ id: string; name: string; bizNo: string }>>(`window.sax.call('counterparties.list', {})`);
  const [a, b] = cps;
  check('시연 거래처 둘 이상', !!a && !!b, cps.length);
  if (!a || !b) return;

  // 1) 받을 돈 화면 → 내 계좌 → 동의 → 계좌 추가
  await click('[data-view="bank"]');
  check('레일 "받을 돈" → D-09', await until('bank view', async () => (await count('section[data-view="bank"]')) === 1));
  await click('[data-bank-tab="accounts"]');
  await until('accounts', async () => (await count('[data-act="bank-account-add"]')) === 1);
  await click('[data-act="bank-account-add"]');
  check('처음 계좌 추가 때 동의 카드', await until('consent', async () => (await count('[data-bank-consent]')) === 1));
  await click('[data-act="bank-consent"]');
  await until('account form', async () => (await count('[data-bank-account-form]')) === 1);
  await setValue('[data-bank-account-form] [data-field="number"]', '999-88-7776665');
  await setValue('[data-bank-account-form] [data-field="alias"]', '주거래');
  await click('[data-act="bank-account-save"]');
  check('계좌 목록에 끝 4자리만', await until('account row', async () => (await text('[data-bank-account]')).includes('···6665') && !(await text('[data-bank-account]')).includes('7776665')));
  check('연결 칸: 파일만, 자동 연결 전엔 [최신화] 없음', (await count('[data-bank-account] [data-bank-link="file_only"]')) === 1 && (await count('[data-act="bank-refresh"]')) === 0);

  // 2) 홈택스 발급목록 파일(CSV): 두 건, 기한 지남
  const ap = (i: number) => `20261005-41000000-${String(10000000 + i)}`;
  queue.push(enc(`작성일자,승인번호,발급일자,공급자사업자등록번호,상호,대표자명,공급받는자사업자등록번호,상호,대표자명,합계금액,공급가액,세액,품목명\n${daysAgo(40)},${ap(1)},${daysAgo(40)},1234567890,하늘상회,김하늘,${a.bizNo},${a.name},대표,"3,300,000","3,000,000","300,000",컨설팅\n${daysAgo(35)},${ap(2)},${daysAgo(35)},1234567890,하늘상회,김하늘,${b.bizNo},${b.name},대표,"1,100,000","1,000,000","100,000",납품\n`));
  gesture();
  await sleep(30);
  await click('[data-act="bank-invoices"]');
  await click('[data-bank-tab="unpaid"]').catch(() => {});
  check('발급목록 → 못 받은 돈 2건(기한 지남)', await until('unpaid', async () => (await js<number>(`document.querySelectorAll('[data-bank-row][data-bank-status="unpaid"]').length`)) === 2));

  // 3) 은행 거래내역(HTML 표 .xls): a에 330만(입금자 처음 보는 이름), b에 110만(상호 그대로), 이자
  queue.push(enc(`<html><head><meta charset="utf-8"></head><body><table><tr><td>계좌번호 : 999-88-7776665</td></tr><tr><th>거래일시</th><th>적요</th><th>기재내용</th><th>찾으신금액</th><th>맡기신금액</th><th>잔액</th></tr>
<tr><td>${daysAgo(9).replace(/-/g, '.')} 10:00:00</td><td>타행</td><td>김철수</td><td>0</td><td>3,300,000</td><td>5,300,000</td></tr>
<tr><td>${daysAgo(8).replace(/-/g, '.')} 11:00:00</td><td>이체</td><td>${b.name}</td><td>0</td><td>1,100,000</td><td>6,400,000</td></tr>
<tr><td>${daysAgo(7).replace(/-/g, '.')} 09:00:00</td><td>결산</td><td>이자</td><td>0</td><td>777</td><td>6,400,777</td></tr></table></body></html>`));
  gesture();
  await sleep(30);
  await click('[data-act="bank-statement"]');
  check('거래내역 미리보기(열 자동 인식, 입금 3줄)', await until('preview', async () => (await text('[data-bank-preview] h2')).includes('입금 3줄')));
  await click('[data-act="bank-commit"]');
  check('넣기 → 확인할 입금 탭', await until('review', async () => (await count('[data-bank-txn]')) >= 3));

  // 4) 후보 [맞아요] → 별칭 제안 → [기억하기]
  const candText = await text('[data-bank-txn]');
  check('김철수 입금의 후보는 a 건(처음 보는 이름)', candText.includes(a.name) && candText.includes('처음 보는 이름'), candText.slice(0, 300));
  await js(`[...document.querySelectorAll('[data-bank-txn]')].find((e) => e.textContent.includes('김철수')).querySelector('[data-act="bank-accept"]').click()`);
  check('[맞아요] → 별칭 제안', await until('offer', async () => (await text('[data-bank-offer]')).includes('김철수')));
  check('[맞아요] 뒤 되돌리기 띠', (await count('[data-bank-undo]')) === 1);
  await click('[data-act="bank-alias-remember"]');
  await until('offer gone', async () => (await count('[data-bank-offer]')) === 0);
  await js(`[...document.querySelectorAll('[data-bank-txn]')].find((e) => e.textContent.includes('1,100,000')).querySelector('[data-act="bank-accept"]').click()`);
  await until('b accepted', async () => !(await text('[data-bank-txn]')).includes('1,100,000'));
  await js(`[...document.querySelectorAll('[data-bank-txn]')].find((e) => e.textContent.includes('777')).querySelector('[data-act="bank-ignore"]').click()`);
  check('확인할 입금이 비었다(이자는 상관없는 입금)', await until('review empty', async () => (await count('[data-bank-txn]')) === 0));

  // 5) 받은 돈 → 상세 → [떼기] → [되돌리기]
  await click('[data-bank-tab="received"]');
  check('받은 돈 2건', await until('received', async () => (await count('[data-bank-row]')) === 2));
  await js(`[...document.querySelectorAll('[data-bank-row]')].find((e) => e.textContent.includes(${JSON.stringify(b.name)})).click()`);
  await until('detail', async () => (await count('[data-act="bank-detach"]')) === 1);
  await click('[data-act="bank-detach"]');
  await click('[data-bank-tab="unpaid"]');
  check('[떼기] → b 건이 못 받은 돈으로', await until('detached', async () => (await text('[data-bank-row]')).includes(b.name)));
  await click('[data-act="bank-undo"]');
  check('[되돌리기] → 다시 받은 돈', await until('undone', async () => !(await text('[data-bank-row]')).includes(b.name)));

  // 6) 받을 돈 하나 더(현금) → [받았음 표시]
  queue.push(enc(`작성일자,승인번호,공급받는자사업자등록번호,상호,합계금액\n${daysAgo(40)},${ap(3)},${a.bizNo},${a.name},"550,000"\n`));
  gesture();
  await sleep(30);
  await click('[data-act="bank-invoices"]');
  await until('third', async () => (await text('[data-bank-row]')).includes('550,000'));
  await js(`[...document.querySelectorAll('[data-bank-row]')].find((e) => e.textContent.includes('550,000')).click()`);
  await until('mark btn', async () => (await count('[data-act="bank-mark"]')) === 1);
  await click('[data-act="bank-mark"]');
  await click('[data-act="bank-mark-save"]');
  await click('[data-bank-tab="received"]');
  check('[받았음 표시] → 받음 · 직접(현금)', await until('cash', async () => (await text('[data-bank-row]')).includes('받음 · 직접(현금)')));

  // 7) 거래처 상세에 계좌 칸
  await click('[data-view="cps"]');
  await until('cps', async () => (await count('[data-cp-row]')) > 0);
  await js(`document.querySelector('[data-cp-row="${a.id}"]').click()`);
  check('거래처 상세: 계좌·입금자 이름 칸, 기억한 별칭', await until('cp bank', async () => (await text('[data-bank-cp]')).includes('김철수')));

  // 8) 대화: 로컬 답(해석기·모델 없음)
  await click('[data-view="chat"]');
  await until('chat', async () => (await count('#composer')) === 1);
  const n0 = seen.length;
  await js(`(() => { const t = document.querySelector('#composer'); t.value = '못 받은 돈 있어?'; t.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
  check('대화 "못 받은 돈 있어?" → 로컬 답 카드', await until('answer', async () => (await count('[data-bank-answer]')) === 1), await text('.sx-thread .sx-app'));
  check('받을 돈 질문은 해석기·모델로 가지 않는다', seen.length === n0, seen.slice(n0));
  check('답: 못 받은 돈 없음', (await text('[data-bank-answer]')).includes('없어요'), await text('[data-bank-answer]'));
}

app.whenReady().then(async () => {
  try {
    S = await startShell({ dev: DEMO_DEV, width: 1280, height: 820, show: false, intent: resolver, chat: chatter, bankPick: async () => queue.shift() ?? null });
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
