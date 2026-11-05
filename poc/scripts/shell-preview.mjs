// 셸 화면 미리보기: 실제 렌더러(static/shell) + 실제 preload + 실제 승인 바 HTML을 목업 데이터로 띄우고 상태별로 찍는다.
// 엔진·금고·Chrome 없이 화면만 본다(디자인 캔버스 "소버린 AX 화면 디자인"과 대조용). 흐름·판정 시험은 shell-e2e가 한다.
// 실행: pnpm demo:preview  (= pnpm build && electron scripts/shell-preview.mjs [출력 폴더] [폭 높이])
//   리눅스 CI·컨테이너: xvfb-run -a ./node_modules/.bin/electron --no-sandbox scripts/shell-preview.mjs
//   DARK=1 이면 다크 테마, ONLY=flow,docs 처럼 장면을 고를 수 있다. 출력 기본값: reports/raw/design-sync/<폭>x<높이>[-dark]/
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, protocol, WebContentsView } from 'electron';

const DESK = path.resolve(import.meta.dirname, '../apps/desktop');
const { tokensCss, bundleCss, loadTokens } = await import(`${DESK}/dist/shell-tokens.js`);
const { MockStore, seedTimeline, QUICK, PROFILES, dayOffset, mockBundle, MOCK_SETTINGS } = await import(`${DESK}/dist/shell-mock.js`);
const { buildBoard } = await import(`${DESK}/dist/board.js`);
const { buildBarHtml, barCss, barPalette, summarize, BAR_CSP } = await import(`${DESK}/dist/approval-gate.js`);
const { barBounds, SHELL } = await import(`${DESK}/dist/shell-layout.js`);
// 셸과 같은 응답 헤더(CSP·Trusted Types)로 띄운다. 미리보기가 통과하면 셸에서도 같은 정책에서 그려진다(M4-1).
const { appHeaders } = await import(`${DESK}/dist/harden.js`);

const ARGS = process.argv.slice(process.argv.findIndex((a) => a.endsWith('shell-preview.mjs')) + 1);
const W = Number(ARGS[1] ?? 1440);
const H = Number(ARGS[2] ?? 900);
const OUT = ARGS[0] || path.resolve(import.meta.dirname, `../reports/raw/design-sync/${W}x${H}${process.env.DARK ? '-dark' : ''}`);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
await fs.mkdir(OUT, { recursive: true });

protocol.registerSchemesAsPrivileged([{ scheme: 'pv', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 장면이 바꾸는 하네스 상태(보관함 서류를 목록에 넣을지, 승인 바 페이지 HTML). */
const S = { withVault: false, barHtml: '' };
const store = new MockStore();
const vaultDoc = {
  id: 'v1', name: '납세증명서(국세)', kind: '직접 추가', docName: '납세증명서(국세)', profile: 'business', issuedOn: dayOffset(-2), expiresOn: dayOffset(28), source: '직접 추가',
  vault: { expirySource: 'rule', needsUser: true, reasons: ['issued_on_uncertain', 'valid_until_not_found'], suggested: { issuedOn: dayOffset(-3) }, docType: 'national_tax_cert', textSource: 'ocr', docNo: '0123-457-5258-910', issuer: '가나세무서', subjectMismatch: false },
};
const cps = [
  { id: 'c1', name: 'A상사', bizNo: '2148651233', rep: '이가나', email: 'tax@asangsa.example', item: '경영 컨설팅', status: '계속사업자', checkedOn: dayOffset(-1), lastIssuedOn: dayOffset(-32) },
  { id: 'c2', name: 'B상사', bizNo: '1078145678', rep: '박다라', email: 'account@bsangsa.example', item: '유지보수', status: '계속사업자', checkedOn: dayOffset(-3), lastIssuedOn: dayOffset(-1) },
  { id: 'c3', name: 'C테크', bizNo: '1208712345', rep: '최마바', email: 'bill@ctech.example', item: '개발 용역', status: '계속사업자', checkedOn: dayOffset(-15), lastIssuedOn: null },
];
const LABELS = ['홈택스 로그인', '건별발급 화면', '입력', '되읽기', '승인', '전자서명', '발급목록 확인', '메일 전송 확인'];
const mkRun = (status, o = {}) => {
  const done = o.done ?? 0;
  const steps = LABELS.map((label, i) => ({ label, state: i < done ? 'done' : i === done && o.now ? 'now' : 'todo', note: i === done ? o.note : i === 0 ? '가짜 페이지라 로그인을 건너뛰었어요' : undefined }));
  if (o.attentionAt != null) steps[o.attentionAt] = { label: LABELS[o.attentionAt], state: 'attention', note: o.note };
  return {
    id: 'run-1', doc: 'H-01', status, createdAt: '10:41', counterparty: { id: 'c1', name: 'A상사', bizNo: '2148651233', first: !!o.confirmed },
    email: { value: 'tax@asangsa.example', first: !!o.confirmed }, amount: 3300000, vat: 'separate', vatGuessed: !o.confirmed, supply: 3300000, tax: 330000, total: 3630000,
    item: '경영 컨설팅', writeDate: dayOffset(0), auth: '사업자 간편인증(카카오뱅크)', steps, turn: o.turn ?? null, confirmed: !!o.confirmed,
    result: o.result ?? null, stoppedNote: o.stoppedNote, warnings: [], readbackDiffers: false,
  };
};

// 이번 달 판(M-02): 셸과 같은 buildBoard에 목업 문서함·꾸러미를 넣는다(shell-app boardNow와 같은 입력 모양).
const boardNow = () =>
  buildBoard({
    today: dayOffset(0),
    reminderDay: MOCK_SETTINGS.reminderDay,
    issued: [
      ...store.docs.filter((d) => d.kind === '세금계산서').map((d) => ({ who: d.name.replace(/^세금계산서 · /, ''), date: d.issuedOn, total: d.name.endsWith('A상사') ? 3630000 : 605000 })),
      { who: 'C테크', date: dayOffset(-27), total: 1650000 },
    ],
    runs: [],
    docs: (S.withVault ? [vaultDoc, ...store.docs] : store.docs).map((d) => ({ id: d.id, name: d.name, expiresOn: d.expiresOn, needsUser: !!d.vault?.needsUser })),
    bundle: mockBundle(dayOffset(0)),
    cardFetchedOn: MOCK_SETTINGS.cardFetchedOn,
  });

const handlers = {
  'shell.bootstrap': () => ({ board: boardNow(), layout: SHELL, profiles: PROFILES, profile: 'business', counterparties: cps, docs: [...store.docs], timeline: seedTimeline(), quick: QUICK, platform: 'win32' }),
  'profile.set': (p) => ({ profile: p.kind }),
  'request.send': (p) => (/등본/.test(p.text) ? { kind: 'g24', doc: '주민등록표 등본' } : { kind: 'draft', run: mkRun('draft') }),
  'counterparties.list': () => cps,
  'docs.list': () => (S.withVault ? [vaultDoc, ...store.docs] : [...store.docs]),
  'g24.candidates': () => [
    { id: 'f1', name: `주민등록표등본_${dayOffset(0).replaceAll('-', '')}.pdf`, size: '182KB', at: '10:26' },
    { id: 'f2', name: 'print_0001.pdf', size: '96KB', at: '10:23' },
  ],
};
ipcMain.handle('sax', async (_e, { method, params }) => {
  const f = handlers[method];
  if (!f) throw new Error(`unknown_method ${method}`);
  return f(params);
});

// ESM 진입점에서 최상위 await app.whenReady()는 ready를 막으므로 then으로 잇는다.
app.whenReady().then(async () => {

protocol.handle('pv', async (req) => {
  const p = new URL(req.url).pathname;
  if (p === '/tokens.css') return new Response(tokensCss(), { headers: appHeaders('text/css') });
  if (p === '/bundle.css') return new Response(bundleCss(), { headers: appHeaders('text/css') });
  if (p === '/bar.css') return new Response(barCss(barPalette(loadTokens()).palette), { headers: appHeaders('text/css', BAR_CSP) });
  if (p === '/bar.html') return new Response(S.barHtml, { headers: appHeaders('text/html; charset=utf-8', BAR_CSP) });
  const type = p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8';
  return new Response(await fs.readFile(path.join(DESK, 'static/shell', p.slice(1))), { headers: appHeaders(type) });
});

async function open(theme = 'light') {
  nativeTheme.themeSource = theme;
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: true, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(DESK, 'static/preload-shell.cjs') } });
  await win.loadURL('pv://shell/shell.html');
  for (let i = 0; i < 100 && !(await win.webContents.executeJavaScript('document.body.dataset.ready === "1"')); i++) await sleep(50);
  return win;
}
const js = (win, code) => win.webContents.executeJavaScript(code);
const ev = (win, e) => win.webContents.send('sax:event', e);

async function shot(win, name, bar) {
  await sleep(250);
  const [cw, ch] = win.getContentSize();
  const main = (await win.webContents.capturePage()).resize({ width: cw, height: ch, quality: 'best' });
  const buf = Buffer.from(main.toBitmap());
  if (bar) {
    const b = barBounds(cw, ch);
    S.barHtml = buildBarHtml(summarize({ fields: bar }), 'armed').replace('href="bar.css"', 'href="pv://shell/bar.css"');
    const view = new WebContentsView({ webPreferences: { sandbox: true } });
    win.contentView.addChildView(view);
    view.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
    await view.webContents.loadURL('pv://shell/bar.html');
    await sleep(200);
    const img = (await view.webContents.capturePage()).resize({ width: b.width, height: b.height, quality: 'best' });
    const bb = img.toBitmap();
    for (let y = 0; y < b.height; y++) bb.copy(buf, ((b.y + y) * cw + b.x) * 4, y * b.width * 4, (y + 1) * b.width * 4);
    win.contentView.removeChildView(view);
  }
  await fs.writeFile(path.join(OUT, `${name}.png`), nativeImage.createFromBitmap(buf, { width: cw, height: ch }).toPNG());
  console.log('shot', name);
}

const barFields = [
  ['counterpartName', 'A상사'], ['counterpartBizNo', '2148651233'], ['totalAmount', '3630000'], ['taxAmount', '330000'], ['counterpartEmail', 'tax@asangsa.example'], ['$first.bizNo', 'true'], ['$first.email', 'true'],
].map(([fieldKey, value]) => ({ fieldKey, value }));

const scenes = {
  async home(win) { await shot(win, '01-home'); },
  async menu(win) { await js(win, `document.querySelector('.tb-co').click()`); await shot(win, '02-profile-menu'); },
  async typing(win) { await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사에 330만원 세금계산서 끊고 메일 보내 줘'; i.dispatchEvent(new Event('input')); })()`); await shot(win, '03-typing-vat'); },
  async flow(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사에 330만원 세금계산서 끊고 메일 보내 줘'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    await shot(win, '04-draft');
    ev(win, { type: 'run', run: mkRun('preparing', { done: 2, now: true, note: '품목 칸을 넣는 중' }) });
    await shot(win, '05-preparing');
    ev(win, { type: 'run', run: mkRun('turn', { done: 0, now: true, note: '카카오뱅크 앱 승인 대기', turn: { text: '카카오뱅크 앱에서 간편인증을 승인해 주세요.', note: '승인하면 홈택스 입력을 이어서 해요.' } }) });
    await shot(win, '06-turn');
    ev(win, { type: 'run', run: mkRun('waiting', { done: 4, now: true, note: '아래 [승인하고 발급]을 기다려요', confirmed: true }) });
    ev(win, { type: 'bar', active: true, band: false });
    await shot(win, '07-waiting-bar', barFields);
    ev(win, { type: 'bar', active: false });
    ev(win, { type: 'run', run: mkRun('done', { done: 8, confirmed: true, result: { approvalNo: '20261102-41000012-00000123', mailTo: 'tax@asangsa.example', docId: 'd9', doneAt: '10:44', mailConfirmed: true } }) });
    await shot(win, '08-done');
    await js(win, `[...document.querySelectorAll('[data-run] button')].find((b) => b.textContent === '어디로 무엇이 갔나요').click()`);
    await shot(win, '09-done-where');
    await js(win, `document.querySelector('#rail [data-view=activity]').click()`);
    await sleep(100);
    await js(win, `document.querySelector('[data-act-row]').click()`);
    await shot(win, '14-activity');
  },
  async attention(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사에 330만원 세금계산서'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    ev(win, { type: 'run', run: mkRun('attention', { done: 2, attentionAt: 3, note: '품목 칸 값을 확실히 읽지 못했어요', stoppedNote: '홈택스 화면 값을 확실히 읽지 못해 멈췄어요. 아무것도 발급하지 않았어요.' }) });
    await shot(win, '10-attention');
  },
  async docs(win) {
    await js(win, `document.querySelector('#rail [data-view=docs]').click()`);
    await sleep(200);
    await js(win, `document.querySelector('[data-doc-row=d2]').click()`);
    await shot(win, '11-docs');
  },
  async docsReview(win) {
    S.withVault = true;
    await js(win, `document.querySelector('#rail [data-view=docs]').click()`);
    await sleep(300);
    await js(win, `document.querySelector('[data-doc-row=v1]').click()`);
    await shot(win, '12-docs-review');
    S.withVault = false;
  },
  async cps(win) {
    await js(win, `document.querySelector('#rail [data-view=cps]').click()`);
    await sleep(200);
    await js(win, `document.querySelector('[data-cp-row=c2]').click()`);
    await shot(win, '13-cps');
  },
  async board(win) {
    await js(win, `document.querySelector('[data-board-item^="cp:"]').click()`);
    await shot(win, '19-board-compose');
    await js(win, `document.querySelector('[data-act=board-toggle]').click()`);
    await shot(win, '20-board-closed');
  },
  async biz(win) { await js(win, `document.querySelector('#rail [data-view=biz]').click()`); await shot(win, '15-biz'); },
  async settings(win) { await js(win, `document.querySelector('#rail [data-view=settings]').click()`); await shot(win, '16-settings'); },
  async g24(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = '주민등록등본 떼 줘'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    await shot(win, '17-g24-guide');
    await js(win, `document.querySelector('[data-act=g24-saved]').click()`);
    await sleep(200);
    await js(win, `document.querySelector('[data-candidate=f1]').click()`);
    await shot(win, '18-g24-pick');
  },
};

const order = ['home', 'board', 'menu', 'typing', 'flow', 'attention', 'docs', 'docsReview', 'cps', 'biz', 'settings', 'g24'];
for (const theme of process.env.DARK ? ['dark'] : ['light']) {
  for (const k of order) {
    if (ONLY && !ONLY.includes(k)) continue;
    const win = await open(theme);
    try {
      await scenes[k](win);
    } catch (e) {
      console.log('scene failed', k, e.message);
    }
    win.destroy();
  }
}
app.exit(0);

});
