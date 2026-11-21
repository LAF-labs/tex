import fs from 'node:fs/promises';
import path from 'node:path';
import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, protocol, WebContentsView } from 'electron';

const DESK = path.resolve(import.meta.dirname, '../apps/desktop');
const { tokensCss, bundleCss, loadTokens } = await import(`${DESK}/dist/shell-tokens.js`);
const { MockStore, seedTimeline, QUICK, PROFILES, dayOffset, mockBundle, MOCK_SETTINGS } = await import(`${DESK}/dist/shell-mock.js`);
const { buildBoard } = await import(`${DESK}/dist/board.js`);
const { REGATE_NOTE, NOTE, HANDOFF_LOGIN, REHEARSAL_NEXT, LOGIN_NOW, STEP_LABELS, STEP_NOW, handoffTurn, CERT_FAILED_TWICE, CERT_RETRY_NOTE, REPLACING_NOTE, REPLACED_NOTE, QUEUED_NOTE } = await import(`${DESK}/dist/shell-runs.js`);
const { OnboardingFlow, initialOnbState } = await import(`${DESK}/dist/onboarding.js`);
const { MockOnboardingPorts } = await import(`${DESK}/dist/onboarding-mock.js`);
const { buildCardHtml, barCss, barPalette, summarize, BAR_CSP } = await import(`${DESK}/dist/approval-gate.js`);
const { barBounds, browserPanelWidth, SHELL, WINDOW_MIN } = await import(`${DESK}/dist/shell-layout.js`);
const { appHeaders } = await import(`${DESK}/dist/harden.js`);
const { qrSvgDataUrl } = await import(`${DESK}/dist/remote-qr.js`);

const ARGS = process.argv.slice(process.argv.findIndex((a) => a.endsWith('shell-preview.mjs')) + 1);
// 앱 창처럼 최소 폭 아래로는 줄지 않는다.
const W = Math.max(Number(ARGS[1] ?? 1440), WINDOW_MIN.width);
const H = Number(ARGS[2] ?? 900);
const OUT = ARGS[0] || path.resolve(import.meta.dirname, `../reports/raw/design-sync/${W}x${H}${process.env.DARK ? '-dark' : ''}`);
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const EMPTY = !!process.env.EMPTY;
await fs.mkdir(OUT, { recursive: true });

protocol.registerSchemesAsPrivileged([{ scheme: 'pv', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.on('window-all-closed', () => {});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = { bankAuto: 'sms', withVault: false, barHtml: '', onb: null, onbDelay: 0, g24Empty: false, bank: 'full', mode: {}, emptyBoot: false, security: 'ok' };
const HANG = () => new Promise(() => {});
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
const LABELS = STEP_LABELS['H-01'];
const mkRun = (status, o = {}) => {
  const done = o.done ?? 0;
  const steps = LABELS.map((label, i) => ({ label, state: i < done ? 'done' : i === done && o.now ? 'now' : 'todo', note: i === done ? (o.note ?? (o.now ? STEP_NOW['H-01'][i] ?? undefined : undefined)) : i === 0 ? '가짜 페이지라 로그인을 건너뛰었어요' : undefined }));
  if (o.attentionAt != null) steps[o.attentionAt] = { label: LABELS[o.attentionAt], state: 'attention', note: o.note };
  return {
    id: 'run-1', doc: 'H-01', status, createdAt: '10:41', counterparty: { id: 'c1', name: 'A상사', bizNo: '2148651233', first: !!o.confirmed },
    email: { value: 'tax@asangsa.example', first: !!o.confirmed }, amount: 3300000, vat: 'separate', vatGuessed: !o.confirmed, supply: 3300000, tax: 330000, total: 3630000,
    item: '경영 컨설팅', writeDate: dayOffset(0), auth: '사업자 간편인증(카카오뱅크)', steps, turn: o.turn ?? null, confirmed: !!o.confirmed,
    result: o.result ?? null, stoppedNote: o.stoppedNote, warnings: [], readbackDiffers: false,
  };
};

const boardNow = () =>
  buildBoard({
    today: dayOffset(0),
    reminderDay: MOCK_SETTINGS.reminderDay,
    issued: [
      ...store.docs.filter((d) => d.kind === '세금계산서').map((d) => ({ who: d.name.replace(/^세금계산서 /, ''), date: d.issuedOn, total: d.name.endsWith('A상사') ? 3630000 : 605000 })),
      { who: 'C테크', date: dayOffset(-27), total: 1650000 },
    ],
    runs: [],
    docs: (S.withVault ? [vaultDoc, ...store.docs] : store.docs).map((d) => ({ id: d.id, name: d.name, expiresOn: d.expiresOn, needsUser: !!d.vault?.needsUser })),
    bundle: mockBundle(dayOffset(0)),
    cardFetchedOn: MOCK_SETTINGS.cardFetchedOn,
  });

const recv = (id, cpName, writtenOn, total, received, st, o = {}) => {
  const dueOn = o.dueOn ?? null;
  const dueIn = dueOn ? Math.round((Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${dayOffset(0)}T00:00:00Z`)) / 86_400_000) : null;
  return { id, counterpartyId: o.cp ?? null, cpName, cpBizNo: null, item: o.item ?? '경영 컨설팅', approvalTail: o.tail ?? '00000123', writtenOn, total, received, remaining: total - received, dueOn, promisedOn: o.promisedOn ?? null, dueIn, overdue: (st === 'unpaid' || st === 'partial') && dueIn !== null && dueIn < 0, status: st, via: st === 'received' ? (o.via ?? 'auto') : null, offAccount: o.off ?? null, sources: ['ledger'], excludedReason: null };
};
const bankAccounts = [
  { id: 'a1', bank: '국민', last4: '1234', alias: '주거래', linkState: 'auto_connected', canRefresh: true, refresh: null, lastDay: dayOffset(-1), txnCount: 128 },
  { id: 'a2', bank: '신한', last4: '5678', alias: null, linkState: 'file_only', canRefresh: false, refresh: null, lastDay: dayOffset(-9), txnCount: 41 },
];
const bankUnpaid = [
  recv('r1', 'C테크', dayOffset(-45), 1650000, 0, 'unpaid', { cp: 'c3', dueOn: dayOffset(-15), item: '개발 용역', tail: '00000098' }),
  recv('r2', 'A상사', dayOffset(-20), 3630000, 1815000, 'partial', { cp: 'c1', dueOn: dayOffset(10) }),
  recv('r3', 'B상사', dayOffset(-3), 605000, 0, 'unpaid', { cp: 'c2', dueOn: dayOffset(27), item: '유지보수' }),
];
const bankReceived = [recv('r4', 'A상사', dayOffset(-50), 3630000, 3630000, 'received', { cp: 'c1', dueOn: dayOffset(-20) }), recv('r5', 'B상사', dayOffset(-33), 605000, 605000, 'received', { cp: 'c2', via: 'manual', off: 'cash' })];
const txn = (id, day, amount, payer, cands = []) => ({ id, accountId: 'a1', accountLast4: '1234', bank: '국민', day, occurredAt: `${day}T10:12:00`, direction: 'in', amount, unallocated: amount, payer, memo: null, ignoredReason: null, assignedCounterpartyId: null, candidates: cands });
const bankReview = [
  txn('t1', dayOffset(-2), 1650000, '씨테크', [{ receivableIds: ['r1'], cpName: 'C테크', fit: 'exact', amounts: [1650000], feeGap: 0, reason: '금액이 같고 입금자 이름이 거래처 이름과 비슷해요', writtenOn: dayOffset(-45), total: 1650000 }]),
  txn('t2', dayOffset(-1), 500000, '김철수'),
];
const bankOverview = () => {
  const none = S.bank === 'noacct';
  const unpaid = none ? bankUnpaid.map((v) => ({ ...v, status: v.status === 'unpaid' ? 'unknown' : v.status, overdue: false })) : bankUnpaid;
  const over = unpaid.filter((v) => v.overdue);
  return {
    consent: none ? null : { at: dayOffset(-30) },
    summary: { today: dayOffset(0), latestDay: none ? null : dayOffset(-1), stale: none, hasAccounts: !none, unpaidCount: unpaid.length, unpaidTotal: unpaid.reduce((s, v) => s + v.remaining, 0), overdueCount: over.length, overdueTotal: over.reduce((s, v) => s + v.remaining, 0), oldestOverdue: null, reviewCount: none ? 0 : bankReview.length, autoCount: 3 },
    unpaid, received: none ? [] : bankReceived, excluded: [], review: none ? [] : bankReview, recent: [], accounts: none ? [] : bankAccounts, defaultTerms: { kind: 'days', n: 30 },
  };
};
const bankDetail = (id) => {
  const v = [...bankUnpaid, ...bankReceived].find((x) => x.id === id);
  const allocs = v.received ? [{ id: 'al-1', receivableId: id, txnId: 'tx0', amount: v.received, method: 'account', decidedBy: v.via === 'manual' ? 'user' : 'auto', receivedOn: null, removedAt: null, txn: { day: dayOffset(-12), amount: v.received, payer: v.cpName, accountLast4: '1234' } }] : [];
  const events = v.received ? [{ seq: 7, at: `${dayOffset(-12)}T09:30:00`, actor: 'auto', action: 'attach', undoOf: null, undone: false }] : [];
  return { receivable: v, allocs, events, attachable: v.status === 'received' ? [] : bankReview.filter((t) => t.candidates.some((c) => c.receivableIds.includes(id))) };
};

const DEV_DAY = 86_400_000;
const devRow = (id, role, platform, name, o = {}) => ({ deviceId: `0000000${id}-0000-4000-8000-000000000000`, role, platform, name, state: 'active', registeredAt: Date.now() - (o.ago ?? 10) * DEV_DAY, deleteAfter: null, lastSeenAt: Date.now() - Math.min(o.ago ?? 10, 3) * DEV_DAY, self: false, listed: true, ...o });
const DEV = {
  normal: () => [devRow(1, 'desktop', 'macos', '사무실 Mac', { self: true, ago: 40 }), devRow(2, 'desktop', 'windows', '집 PC', { ago: 9 }), devRow(3, 'mobile', 'ios', 'iPhone', { ago: 12 }), devRow(4, 'mobile', 'android', '', { ago: 3 })],
  full: () => [devRow(1, 'desktop', 'macos', '사무실 Mac', { self: true, ago: 40 }), devRow(2, 'desktop', 'windows', '집 PC', { ago: 9 }), devRow(5, 'desktop', 'windows', '세무 담당 노트북', { ago: 2 }), devRow(3, 'mobile', 'ios', 'iPhone', { ago: 12 }), devRow(4, 'mobile', 'android', '', { ago: 3 }), devRow(6, 'mobile', 'ios', '직원 아이폰', { ago: 1, state: 'pending', listed: false })],
  suspended: () => [devRow(1, 'desktop', 'macos', '사무실 Mac', { self: true, ago: 40 }), devRow(2, 'desktop', 'windows', '집 PC', { ago: 9, state: 'suspended', deleteAfter: Date.now() + 5 * DEV_DAY + 3_600_000 }), devRow(3, 'mobile', 'ios', 'iPhone', { ago: 12 }), devRow(4, 'mobile', 'android', '잃어버린 폰', { ago: 30, state: 'suspended', deleteAfter: Date.now() + 1_800_000 })],
  alone: () => [devRow(1, 'desktop', 'macos', '사무실 Mac', { self: true, ago: 40 }), devRow(3, 'mobile', 'ios', 'iPhone', { ago: 12 })],
  px: () => [devRow(1, 'desktop', 'macos', 'MacBook Pro', { self: true, ago: 40 }), devRow(3, 'mobile', 'ios', 'iPhone 16 Pro', { ago: 12, approval: 'on', lastSeenAt: Date.now() }), devRow(4, 'mobile', 'android', 'Galaxy S25', { ago: 3, approval: 'asked' })],
};
const req = (stage, o = {}) => ({ deviceId: '00000009-0000-4000-8000-000000000000', name: '새 노트북', platform: 'windows', createdAt: Date.now() - 60_000, stage, triesLeft: stage === 'code' ? 3 : null, ...o });
const signedIn = { step: 'signed_in', email: 'owner@ganada.example', codeExpiresAt: null, error: null, phones: 2 };
const devFail = (code) => {
  throw new Error(code);
};
Object.assign(S, { acct: signedIn, devices: DEV.normal(), devErr: null, reqs: [], pcMode: 'ok' });
const PAIR_IDLE = { step: 'idle', qr: null, expiresAt: null, phoneName: null, triesLeft: null, error: null };
const pairQr = () => ({ ...PAIR_IDLE, step: 'waiting_phone', qr: qrSvgDataUrl(`sax1:preview:${'x'.repeat(120)}`), expiresAt: Date.now() + 103_000 });
S.pair = PAIR_IDLE;

const handlers = {
  'account.view': () => S.acct,
  'account.deletion': () => ({ deleteAfter: null }),
  'account.signOut': () => (S.acct = { step: 'signed_out', email: S.acct.email, codeExpiresAt: null, error: null, phones: 0 }),
  'account.linkCancel': () => (S.acct = { step: 'signed_out', email: S.acct.email, codeExpiresAt: null, error: null, phones: 0 }),
  'account.linkAccept': () => (S.acct = signedIn),
  'devices.list': () => (S.devErr ? devFail(S.devErr) : { devices: S.devices }),
  'devices.unlink': (p) => ({ devices: (S.devices = S.devices.filter((d) => d.deviceId !== p.deviceId)) }),
  'devices.leave': () => devFail('account.last_desktop'),
  'devices.px': (p) => ({ devices: (S.devices = S.devices.map((d) => (d.deviceId === p.deviceId ? { ...d, approval: p.on ? 'on' : 'paused' } : d))) }),
  'pair.view': () => S.pair,
  'pair.open': () => (S.pair = pairQr()),
  'pair.retry': () => (S.pair = pairQr()),
  'pair.cancel': () => (S.pair = PAIR_IDLE),
  'pair.submit': (p) => (S.pair = p.code === '482915' ? { ...S.pair, step: 'paired', error: null, triesLeft: null } : { ...S.pair, error: 'pair.sas_wrong', triesLeft: S.pair.triesLeft - 1 }),
  'pclink.list': () => ({ requests: S.reqs }),
  'pclink.begin': () => ({ requests: (S.reqs = [req('wait')]) }),
  'pclink.reject': () => ({ requests: (S.reqs = []) }),
  'pclink.confirm': (p) => {
    if (S.pcMode === 'limit') devFail('account.device_limit');
    const r = S.reqs[0];
    if (S.pcMode === 'expired') return { ok: false, requests: (S.reqs = []) };
    if (p.code === '482915') {
      S.devices = [...S.devices, devRow(9, 'desktop', 'windows', '새 노트북', { ago: 0 })];
      return { ok: true, requests: (S.reqs = [req('done')]) };
    }
    const left = r.triesLeft - 1;
    return { ok: false, requests: (S.reqs = left > 0 ? [{ ...r, triesLeft: left }] : []) };
  },
  'shell.bootstrap': async () => ({ onboarding: S.onb ? await S.onb.view() : null, board: boardNow(), layout: SHELL, profiles: PROFILES, profile: 'business', counterparties: EMPTY || S.emptyBoot ? [] : cps, docs: EMPTY || S.emptyBoot ? [] : [...store.docs], timeline: seedTimeline(), quick: QUICK, platform: 'win32', payrollEnabled: !!process.env.PAYROLL }),
  'profile.set': (p) => ({ profile: p.kind }),
  'onboarding.reply': async (p) => {
    if (S.onbDelay) await sleep(S.onbDelay);
    const r = await S.onb.answer(p);
    return { onboarding: await S.onb.view(), fill: r.fill ?? null, profiles: PROFILES };
  },
  'request.send': async (p) => S.reactOnly ? (await sleep(400), { kind: 'reaction', reaction: S.reactOnly }) : (S.replyDelay && (await sleep(S.replyDelay)), S.agentReply) ? { kind: 'agent', text: S.agentReply, show: [], filtered: null } : (/등본/.test(p.text) ? { kind: 'g24', doc: '주민등록표 등본' } : { kind: 'draft', run: S.sendSeq ? { ...mkRun('draft'), id: `run-${++S.sendSeq}` } : mkRun('draft') }),
  'counterparties.list': () => (EMPTY ? [] : cps),
  'docs.list': () => (EMPTY ? [] : S.withVault ? [vaultDoc, ...store.docs] : [...store.docs]),
  'issued.list': () => [],
  'bank.overview': () => bankOverview(),
  'bank.receivable': (p) => bankDetail(p.id),
  'bank.refreshStatus': () => ({ state: 'done', result: { newCount: 0 } }),
  'bankAuto.status': () => ({ ok: true, connected: false }),
  'bankAuto.consent': () => ({ ok: true }),
  'bankAuto.certs': () => ({ certs: [{ id: '0123456789abcdef', owner: '김하늘', usage: 'yessign 범용', expiresOn: '2027-03-01', usable: true, issuance: true }] }),
  'bankAuto.connect': (p) => (S.bankAuto === 'withdraw' && !p.withdrawAccount ? { ok: false, code: 'withdraw_account_required', cf: 'CF-12401', clientType: 'P', also: { clientType: 'B', code: 'identity_required' } } : S.bankAuto === 'identity' ? { ok: false, code: 'identity_required', cf: 'CF-12831', clientType: 'B' } : { ok: true, sessionId: 'cs1', bankName: '우리은행', step: 'sms', accounts: [] }),
  'bankAuto.sms': (p) =>
    p.code === '000000'
      ? { ok: true, sessionId: 'cs2', bankName: '우리은행', step: 'sms', accounts: [] }
      : { ok: true, sessionId: 'cs3', bankName: '우리은행', accounts: [{ key: 'a0', last4: '6789', name: '우리 사업자통장', balance: 5067000, usable: true }, { key: 'a1', last4: '8777', name: '정기예금', balance: 1000000, usable: false }] },
  'g24.candidates': () =>
    S.g24Empty
      ? []
      : [
          { id: 'f1', name: `주민등록표등본_${dayOffset(0).replaceAll('-', '')}.pdf`, size: '182KB', at: '10:26' },
          { id: 'f2', name: 'print_0001.pdf', size: '96KB', at: '10:23' },
        ],
  'docs.import': () => ({ doc: { id: 'g24-doc', name: '주민등록표 등본', kind: '직접 추가', docName: '주민등록표 등본', profile: 'personal', issuedOn: dayOffset(0), expiresOn: null, source: '직접 추가' }, document: { duplicate: false } }),
  'security.check': () => (S.security === 'ok' ? { state: 'ok' } : { state: S.security, name: 'MagicLine4NX', installUrl: 'https://hometax.go.kr/MagicLine4XML/ML4Web/install_bin/MagicLine4NX.pkg', canStart: true }),
  'security.install': () => ({ state: S.security }),
  'bank.cpBanking': () => ({
    accounts: [{ id: 'ca1', bank: '국민은행', last4: '1234', holder: '김에이' }],
    aliases: [{ id: 'al1', nameRaw: '에이상사(주)', source: 'learned' }, { id: 'al2', nameRaw: '김에이', source: 'manual' }],
    terms: { kind: 'next_month_day', d: 10 },
  }),
};
ipcMain.handle('sax', async (_e, { method, params }) => {
  const f = handlers[method];
  if (S.mode[method] === 'hang') return HANG();
  if (S.mode[method] === 'fail') throw new Error('engine_unavailable');
  if (!f) throw new Error(`unknown_method ${method}`);
  return f(params);
});

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
  const offscreen = !!process.env.OFFSCREEN;
  const win = new BrowserWindow({ width: W, height: H, useContentSize: true, show: !offscreen, webPreferences: { offscreen, sandbox: true, contextIsolation: true, preload: path.join(DESK, 'static/preload-shell.cjs') } });
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
    S.barHtml = buildCardHtml(summarize({ fields: bar }), 'armed').replace('href="bar.css"', 'href="pv://shell/bar.css"');
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


async function record(win, name, act) {
  const dir = path.join(OUT, name, 'frames');
  await fs.rm(path.join(OUT, name), { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const frames = [];
  const grab = (img) => frames.push(img.toPNG());
  const off = !!process.env.OFFSCREEN;
  if (off) win.webContents.on('paint', (_e, _d, img) => grab(img));
  else win.webContents.beginFrameSubscription(false, grab);
  await js(win, `window.__tick = setInterval(() => { let t = document.getElementById('__tick'); if (!t) { t = document.createElement('i'); t.id = '__tick'; t.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;z-index:99999'; document.body.append(t); } t.style.background = t.style.background === 'red' ? 'blue' : 'red'; }, 16)`);
  await sleep(300);
  const event = frames.length;
  const top0 = await js(win, `document.querySelector('.thread-scroll').scrollTop`);
  await act();
  await sleep(1200);
  if (off) win.webContents.removeAllListeners('paint');
  else win.webContents.endFrameSubscription();
  await js(win, 'clearInterval(window.__tick); document.getElementById("__tick")?.remove()');
  for (const [i, b] of frames.entries()) await fs.writeFile(path.join(dir, `${String(i).padStart(4, '0')}.png`), b);
  const r = await js(win, `(() => { const b = document.querySelector('.thread-scroll').getBoundingClientRect(); return [b.x, b.y, b.width, b.height, devicePixelRatio]; })()`);
  const k = r[4];
  const crop = r.slice(0, 4).map((v) => Math.round(v * k)).join(',');
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync(process.env.NODE_BIN ?? 'node', [path.join(import.meta.dirname, 'scroll-shift.mjs'), '--frames', dir, '--fps', '30', '--crop', crop, '--scale', String(k), '--event', `#${Math.max(0, event - 1)}`, '--label', name, '--out', path.join(OUT, name)], { encoding: 'utf8' });
  const top1 = await js(win, `document.querySelector('.thread-scroll').scrollTop`);
  console.log('record', name, res.stdout.trim() || res.stderr.trim(), 'dom scrollTop delta', Math.round(top1 - top0));
}

const barFields = [
  ['counterpartName', 'A상사'], ['counterpartBizNo', '2148651233'], ['totalAmount', '3630000'], ['supplyAmount', '3300000'], ['taxAmount', '330000'], ['itemName', '디자인 용역'], ['issueDate', dayOffset(0)], ['counterpartEmail', 'tax@asangsa.example'], ['$first.bizNo', 'true'], ['$first.email', 'true'],
].map(([fieldKey, value]) => ({ fieldKey, value }));

const scenes = {
  async home(win) { await shot(win, '01-home'); },
  async rail(win) {
    const m = await js(win, `(() => {
      const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
      const rail = document.querySelector('#rail');
      const css = getComputedStyle(document.documentElement);
      return {
        lRail: css.getPropertyValue('--l-rail').trim(), railWidthToken: css.getPropertyValue('--rail-width').trim(), rail: r(rail),
        buttons: [...rail.querySelectorAll('button')].map((b) => {
          const ic = b.querySelector('.rail-ic'), lb = b.querySelector('.rail-label'), svg = b.querySelector('svg'), dot = b.querySelector('b');
          return { view: b.dataset.view, on: b.classList.contains('is-on'), box: r(b), ic: r(ic), icRadius: getComputedStyle(ic).borderRadius, icBg: getComputedStyle(ic).backgroundColor, btnBg: getComputedStyle(b).backgroundColor,
            svg: r(svg), label: r(lb), font: getComputedStyle(lb).fontSize + '/' + getComputedStyle(lb).lineHeight, dot: dot ? r(dot) : null };
        }),
      };
    })()`);
    m.shell = SHELL;
    await fs.writeFile(path.join(OUT, 'rail.json'), JSON.stringify(m, null, 1));
    await shot(win, '00-rail');
  },
  async menu(win) { await js(win, `document.querySelector('.tb-co').click()`); await shot(win, '02-profile-menu'); },
  async typing(win) { await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사에 330만원 세금계산서 끊고 메일 보내 줘'; i.dispatchEvent(new Event('input')); })()`); await shot(win, '03-typing-vat'); },
  async flow(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사에 330만원 세금계산서 끊고 메일 보내 줘'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    await shot(win, '04-draft');
    ev(win, { type: 'run', run: mkRun('preparing', { done: 2, now: true }) });
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
    await js(win, `document.querySelector('#rail [data-view=docs]').click(); setTimeout(() => document.querySelector('[data-act=go-activity]').click(), 50)`);
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
  async incidents(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사에 330만원 세금계산서'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    ev(win, { type: 'run', run: { ...mkRun('turn', { done: 2, attentionAt: 2, note: '직접 해 주세요' }), handoff: { phase: 'input', afterGate: false }, turn: handoffTurn('input') } });
    await shot(win, '30-handoff');
    ev(win, { type: 'run', run: { ...mkRun('preparing', { done: 0, now: true, note: LOGIN_NOW }), notices: [CERT_RETRY_NOTE] } });
    await shot(win, '30b-cert-retry');
    ev(win, { type: 'run', run: { ...mkRun('turn', { done: 0, attentionAt: 0, note: '' }), handoff: { phase: 'login', afterGate: false, kind: 'login', code: 'login.simple_auth' }, turn: CERT_FAILED_TWICE } });
    await shot(win, '30c-cert-failed');
    ev(win, { type: 'run', run: { ...mkRun('turn', { done: 0, attentionAt: 0, note: '' }), handoff: { phase: 'login', afterGate: false, kind: 'login', code: 'login.simple_sent' }, simpleAuth: { provider: 'kakao', deadline: Date.now() + 240_000 }, turn: { text: '카카오톡에서 승인해 주세요', note: '5분 안에 승인하면 바로 이어서 발급해요.' } } });
    await shot(win, '30d-simple-sent');
    ev(win, { type: 'run', run: { ...mkRun('waiting', { done: 4, now: true, confirmed: true, note: '아래 [승인하고 발급]을 기다려요' }), regate: { reason: 'date_changed', note: REGATE_NOTE.date_changed } } });
    await shot(win, '31-regate');
    ev(win, { type: 'run', run: { ...mkRun('issuing', { done: 6, now: true, confirmed: true }), verifyAttempt: 3 } });
    await shot(win, '32-checking');
    ev(win, { type: 'run', run: { ...mkRun('attention', { done: 6, attentionAt: 6, confirmed: true, stoppedNote: NOTE['verify.unknown'] }), inDoubt: true } });
    await sleep(100);
    await js(win, `document.querySelector('[data-act=check-list]').click()`);
    await shot(win, '33-in-doubt');
    ev(win, { type: 'run', run: { ...mkRun('stopped', { done: 4, stoppedNote: NOTE['gate.expired'] }), redo: true } });
    await shot(win, '34-stopped-expired');
    ev(win, { type: 'run', run: { ...mkRun('stopped', { done: 0, attentionAt: 0, note: '직접 해 주세요', stoppedNote: `'홈택스 로그인' 단계에서 사람이 할 일이 생겨 멈췄어요(${HANDOFF_LOGIN.text}). 예행은 기다리지 않아서 발급하지 않았어요. ${REHEARSAL_NEXT}` }), rehearsal: true } });
    await shot(win, '35-rehearsal-handoff');
    ev(win, { type: 'run', run: mkRun('preparing', { done: 0, now: true, note: LOGIN_NOW }) });
    await shot(win, '36-login-now');
  },
  async browser(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사에 330만원 세금계산서'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    ev(win, { type: 'browser', shown: false, available: true, embedded: true, width: browserPanelWidth(W, null, false, false) });
    ev(win, { type: 'run', run: mkRun('preparing', { done: 2, now: true }) });
    ev(win, { type: 'screen', runId: 'run-1', url: 'https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml' });
    await sleep(200);
    await js(win, `document.querySelector('[data-run] .sx-card-hd, [data-run]').click()`);
    await sleep(200);
    await shot(win, '37-browser-live');
    ev(win, { type: 'run', run: { ...mkRun('issuing', { done: 6, now: true, confirmed: true }), verifyAttempt: 3 } });
    await shot(win, '38-browser-checking');
    ev(win, { type: 'run', run: { ...mkRun('turn', { done: 2, attentionAt: 2, note: '직접 해 주세요' }), handoff: { phase: 'input', afterGate: false }, turn: handoffTurn('input') } });
    await shot(win, '39-browser-handoff');
    ev(win, { type: 'browser', shown: false, available: false, embedded: true, width: 0 });
  },
  async replace(win) {
    S.sendSeq = 0;
    const small = (amt, o) => ({ supply: amt, tax: Math.round(amt / 10), total: amt + Math.round(amt / 10), amount: amt, counterparty: { id: 'c9', name: '일호유통', bizNo: '6495800524', first: false }, item: '예행', email: { value: '', first: false }, ...o });
    const say = (t) => js(win, `(() => { const i = document.querySelector('#composer'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await say('일호유통 110원 끊어줘');
    await sleep(300);
    ev(win, { type: 'run', run: { ...mkRun('preparing', { done: 0, now: true, note: LOGIN_NOW }), ...small(110), id: 'run-1' } });
    await shot(win, '40-replace-first');
    await say('아 100원이야');
    await sleep(300);
    ev(win, { type: 'run', run: { ...mkRun('preparing', { done: 1, now: true }), ...small(100), id: 'run-2', notices: [REPLACING_NOTE] } });
    ev(win, { type: 'run', run: { ...mkRun('stopped', { done: 1 }), ...small(110), id: 'run-1', replaced: true, notices: [REPLACED_NOTE], stoppedNote: REPLACED_NOTE } });
    await shot(win, '41-replace-after');
    await say('B상사 55만원도 끊어줘');
    await sleep(300);
    ev(win, { type: 'run', run: { ...mkRun('draft'), id: 'run-3', counterparty: { id: 'c2', name: 'B상사', bizNo: '1078145678', first: false }, amount: 550000, supply: 550000, tax: 55000, total: 605000, notices: [QUEUED_NOTE] } });
    await shot(win, '42-replace-queued');
    S.sendSeq = 0;
  },
  async openBank(win) {
    S.agentReply = '계좌 연결 화면을 열었어요. 거래 중인 은행을 고르고 로그인하면 통장 내역이 여기로 모여요.';
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = '은행 연결해줘'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    await shot(win, '43-open-bank-reply');
    ev(win, { type: 'open-screen', screen: 'bank' });
    await sleep(1200);
    await shot(win, '44-open-bank-screen');
    S.agentReply = null;
  },
  async scroll(win) {
    const say = (t) => js(win, `(() => { const i = document.querySelector('#composer'); i.value = ${JSON.stringify(t)}; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    const Q = ['이번 달 세금계산서 몇 건 끊었어?', 'B상사 미수금 얼마야?', '부가세 신고는 언제까지야?', '지난달 매출 합계 알려 줘', 'C테크 이메일 바뀌었어?', '세무사 꾸러미 만들어 줘', '현금영수증도 모아 줘?', '다음 주 할 일 있어?'];
    const A = ['이번 달 발급은 3건이에요. A상사 363만원, B상사 60만 5천원, C테크 110만원이에요.', 'B상사에서 아직 60만 5천원을 받지 못했어요. 지난 3일이 약속한 날이었어요.', '2기 확정 신고는 1월 25일까지예요. 꾸러미는 1월 초에 만들어 둘게요.', '지난달 매출은 1,280만원이에요. 그중 세금계산서로 끊은 것이 1,100만원이에요.', '네, 지난주에 bill@ctech.example로 바뀌었어요. 다음 발급부터 새 주소로 보내요.', '11월 꾸러미를 만들었어요. 문서함에서 열어 볼 수 있어요.', '현금영수증 7건을 모았어요. 합계 23만 4천원이에요.', '다음 주에는 A상사 정기 발급 하나가 있어요. 금요일에 알려 드릴게요.'];
    for (const [k, q] of Q.entries()) {
      S.agentReply = A[k];
      await say(q);
      await sleep(260);
    }
    S.agentReply = null;
    await js(win, `(() => { const s = document.querySelector('.thread-scroll'); s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 520); s.dispatchEvent(new Event('scroll')); })()`);
    await sleep(300);
    await record(win, 'rec-new-reply', () => ev(win, { type: 'say', text: '참고로 B상사는 지난달에도 입금이 열흘 늦었어요. 이번에도 늦으면 알려 드릴게요.' }));
    await shot(win, '47-scroll-new-reply');
    await js(win, `document.querySelector('[data-act=new-reply]')?.click()`);
    await sleep(600);
    await shot(win, '48-scroll-after-button');
    await js(win, `(() => { const s = document.querySelector('.thread-scroll'); s.scrollTop = Math.max(0, s.scrollHeight - s.clientHeight - 520); s.dispatchEvent(new Event('scroll')); })()`);
    await sleep(300);
    S.agentReply = '네, 알겠어요.';
    await say('고마워');
    await sleep(500);
    await shot(win, '49-scroll-sent');
    S.agentReply = null;
  },
  async steps(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사에 330만원 세금계산서'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    ev(win, { type: 'run', run: mkRun('preparing', { done: 2, now: true }) });
    await shot(win, '50-steps-closed');
    await js(win, `document.querySelector('[data-act=steps-toggle]').click()`);
    await shot(win, '51-steps-open');
    ev(win, { type: 'run', run: mkRun('preparing', { done: 3, now: true }) });
    await sleep(100);
    console.log('steps still open after update:', await js(win, `document.querySelector('[data-act=steps-toggle]').getAttribute('aria-expanded')`));
    await shot(win, '52-steps-kept');
  },
  async muse(win) {
    const say = (t) => js(win, `(() => { const i = document.querySelector('#composer'); i.value = ${JSON.stringify('')} + ${'`'}${'${'}t${'}'}${'`'}; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`.replace('${t}', t));
    S.agentReply = '이번 달 발급은 3건이에요. A상사 363만원, B상사 60만 5천원, C테크 110만원이에요.';
    await say('이번 달 세금계산서 몇 건 끊었어?');
    await sleep(400);
    ev(win, { type: 'say', text: '합계는 533만 5천원이에요.' });
    await sleep(200);
    S.replyDelay = 3000;
    await say('B상사 건 다시 보여 줘');
    await sleep(700);
    console.log('dbg', await js(win, `JSON.stringify({t: !!document.querySelector('.sx-typing'), toast: document.querySelector('.toast, [role=alert]')?.textContent, last: document.querySelector('.sx-thread').lastElementChild.outerHTML.slice(0,200)})`));
    await shot(win, '45-muse-chat');
    await sleep(2600);
    await shot(win, '46-muse-after-typing');
    S.replyDelay = 0;
    S.agentReply = null;
  },
  async react(win) {
    const say = (t) => js(win, `(() => { const i = document.querySelector('#composer'); i.value = ${'`'}${'${'}t${'}'}${'`'}; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`.replace('${t}', t));
    S.agentReply = 'B상사 55만원(부가세 별도) 카드를 만들었어요. 홈택스에서 준비하고 승인 전에 한 번 더 보여 드릴게요.';
    S.replyDelay = 2400;
    await say('B상사 55만원 세금계산서 끊어줘');
    await sleep(500);
    ev(win, { type: 'chat-reaction', reaction: 'eyes' });
    await sleep(600);
    await shot(win, '47-react-working');
    await sleep(1800);
    await shot(win, '48-react-result');
    S.replyDelay = 0;
    S.agentReply = null;
    S.reactOnly = 'pray';
    await say('고마워');
    await sleep(250);
    await shot(win, '49-react-waiting');
    await sleep(500);
    await shot(win, '50-reaction-only');
    S.reactOnly = null;
    S.agentReply = '별말씀을요. 또 필요하면 불러 주세요.';
    S.replyDelay = 1200;
    await say('고마워');
    await sleep(400);
    ev(win, { type: 'chat-reaction', reaction: 'pray' });
    await sleep(1300);
    await shot(win, '51-reaction-repeat-reply');
    S.replyDelay = 0;
    S.agentReply = null;
  },
  async empty(win) {
    for (const v of ['cps', 'docs']) {
      await js(win, `document.querySelector('#rail [data-view=${v}]').click()`);
      await sleep(200);
      await shot(win, `40-empty-${v}`);
    }
    await js(win, `document.querySelector('[data-act=go-activity]').click()`);
    await sleep(200);
    await shot(win, '40-empty-activity');
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
    await js(win, `document.querySelector('[data-bank-cp] button[data-field=terms]').click()`);
    await shot(win, '13b-cps-terms');
  },
  async board(win) {
    await js(win, `document.querySelector('[data-act=board-toggle]').click()`);
    await shot(win, '19-board-panel');
    await js(win, `document.querySelector('[data-board-item^="cp:"]').click()`);
    await shot(win, '20-board-compose');
  },
  async onboarding(win) {
    const press = async (sel) => {
      await js(win, `[...document.querySelectorAll(${JSON.stringify(sel)})].pop().click()`);
      await sleep(150);
    };
    await shot(win, '21-onb-terms');
    await press('[data-onb=agree]');
    await shot(win, '22-onb-welcome');
    await press('[data-onb=upload]');
    await shot(win, '23-onb-biz');
    await press('[data-onb=confirm]');
    await shot(win, '24-onb-auth');
    await press('[data-onb=other]');
    await shot(win, '25-onb-auth-other');
    S.onbDelay = 1200;
    await js(win, `document.querySelector('[data-cert=npki-1]').click()`);
    await shot(win, '26-onb-auth-picked');
    await sleep(1200);
    S.onbDelay = 0;
    await shot(win, '27-onb-first');
    await press('[data-onb=try]');
    await shot(win, '28-onb-done');
  },
  async onbNoCert(win) {
    const press = async (sel) => {
      await js(win, `[...document.querySelectorAll(${JSON.stringify(sel)})].pop().click()`);
      await sleep(150);
    };
    S.security = 'missing';
    await press('[data-onb=agree]');
    await press('[data-onb=upload]');
    await press('[data-onb=confirm]');
    await sleep(200);
    await shot(win, '24b-onb-auth-nocert-missing');
    S.security = 'stopped';
    await js(win, `document.querySelector('[data-act=security-check]')?.click()`);
    await sleep(200);
    await shot(win, '24c-onb-auth-nocert-stopped');
    S.security = 'ok';
    await js(win, `document.querySelector('[data-act=security-check]')?.click()`);
    await sleep(300);
    await shot(win, '24d-onb-auth-nocert');
  },
  async onbOld(win) {
    const press = async (sel) => {
      await js(win, `[...document.querySelectorAll(${JSON.stringify(sel)})].pop().click()`);
      await sleep(150);
    };
    await shot(win, '29-onb-tasks');
    await press('[data-task=H-01]');
    await shot(win, '30-onb-tasks-off');
    await press('[data-task=H-01]');
    await press('[data-onb=submit]');
    await shot(win, '31-onb-cps');
    await press('[data-onb=later]');
    await shot(win, '32-onb-summary');
  },
  async biz(win) { await js(win, `document.querySelector('#rail [data-view=settings]').click()`); await sleep(100); await js(win, `document.querySelector('[data-set-tab=biz]').click()`); await shot(win, '15-biz'); },
  async settings(win) { await js(win, `document.querySelector('#rail [data-view=settings]').click()`); await shot(win, '16-settings'); },
  async g24(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = '주민등록등본 떼 줘'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    await shot(win, '17-g24-guide');
    await js(win, `document.querySelector('[data-g24] .sx-btn-primary')?.click()`);
    await sleep(200);
    await js(win, `document.querySelector('[data-act=g24-saved]').click()`);
    await sleep(200);
    await js(win, `document.querySelector('[data-candidate=f1]').click()`);
    await shot(win, '18-g24-pick');
  },
  async g24Import(win) {
    S.g24Empty = true;
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = '주민등록등본 떼 줘'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    await js(win, `document.querySelector('[data-g24] .sx-btn-primary')?.click()`);
    await sleep(200);
    await js(win, `document.querySelector('[data-act=g24-saved]').click()`);
    await sleep(200);
    await shot(win, '18b-g24-import');
    await js(win, `document.querySelector('[data-act=g24-import]').click()`);
    await sleep(300);
    await shot(win, '18c-g24-imported');
    S.g24Empty = false;
  },

  async bank(win) {
    const tab = async (k) => { await js(win, `document.querySelector('[data-bank-tab=${k}]').click()`); await sleep(150); };
    await js(win, `document.querySelector('#rail [data-view=bank]').click()`);
    await sleep(300);
    await shot(win, '50-bank-unpaid');
    await js(win, `document.querySelector('[data-bank-row=r2]').click()`);
    await sleep(200);
    await shot(win, '51-bank-detail');
    await js(win, `document.querySelector('[data-act=bank-mark]').click()`);
    await sleep(150);
    await shot(win, '52-bank-mark-form');
    await tab('review');
    await shot(win, '53-bank-review');
    await tab('received');
    await shot(win, '54-bank-received');
    await tab('accounts');
    await shot(win, '55-bank-accounts');
  },
  async bankNoAcct(win) {
    S.bank = 'noacct';
    await js(win, `document.querySelector('#rail [data-view=bank]').click()`);
    await sleep(300);
    await shot(win, '56-bank-noacct');
    await js(win, `document.querySelector('[data-act=bank-go-accounts]').click()`);
    await sleep(150);
    await shot(win, '57-bank-noacct-consent');
    S.bank = 'full';
  },
  async loading(win) {
    S.mode = { 'bank.overview': 'hang', 'counterparties.list': 'hang', 'docs.list': 'hang', 'issued.list': 'hang', 'bankAuto.status': 'hang' };
    for (const v of ['bank', 'cps', 'docs']) {
      await js(win, `document.querySelector('#rail [data-view=${v}]').click()`);
      await sleep(300);
      await shot(win, `60-loading-${v}`);
    }
    await js(win, `document.querySelector('#rail [data-view=settings]').click()`);
    await sleep(100);
    await js(win, `document.querySelector('[data-set-tab=bank]').click()`);
    await sleep(200);
    await shot(win, '60-loading-settings-bank');
    S.mode = {};
  },
  async errors(win) {
    S.mode = { 'bank.overview': 'fail', 'counterparties.list': 'fail', 'docs.list': 'fail', 'issued.list': 'fail', 'bankAuto.status': 'fail' };
    for (const v of ['bank', 'cps', 'docs']) {
      await js(win, `document.querySelector('#rail [data-view=${v}]').click()`);
      await sleep(300);
      await shot(win, `61-error-${v}`);
    }
    await js(win, `document.querySelector('#rail [data-view=settings]').click()`);
    await sleep(100);
    await js(win, `document.querySelector('[data-set-tab=bank]').click()`);
    await sleep(200);
    await shot(win, '61-error-settings-bank');
    S.mode = { 'bank.overview': 'fail' };
    await js(win, `document.querySelector('#rail [data-view=bank]').click()`);
    await sleep(300);
    S.mode = {};
    await js(win, `document.querySelector('[data-act=bank-retry]').click()`);
    await sleep(300);
    await shot(win, '62-error-bank-retried');
    S.mode = {};
  },
};

scenes.bankAuto = async (win) => {
  const start = async () => {
    await js(win, `document.querySelector('#rail [data-view=settings]').click()`);
    await sleep(100);
    await js(win, `document.querySelector('[data-set-tab=bank]').click()`);
    await sleep(300);
    await js(win, `document.querySelector('[data-bank-connect]').click()`);
    await sleep(100);
    await js(win, `document.querySelectorAll('[data-bank-check]').forEach((c) => { c.checked = true; c.dispatchEvent(new Event('change')); })`);
    await sleep(100);
    await js(win, `document.querySelector('[data-bank-consent]').click()`);
    await sleep(300);
  };
  S.bankAuto = 'sms';
  await start();
  await shot(win, '70-bankauto-certs');
  await js(win, `document.querySelector('[data-bank-next]').click()`);
  await sleep(300);
  await shot(win, '71-bankauto-sms');
  const type = (v) => js(win, `(() => { const i = document.querySelector('[data-bank-sms]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); document.querySelector('[data-bank-sms-go]').click(); })()`);
  await type('000000');
  await sleep(300);
  await shot(win, '72-bankauto-sms-wrong');
  await type('482913');
  await sleep(300);
  await shot(win, '73-bankauto-accounts');
  S.bankAuto = 'identity';
  await start();
  await js(win, `document.querySelector('[data-bank-next]').click()`);
  await sleep(300);
  await shot(win, '74-bankauto-identity');
  S.bankAuto = 'withdraw';
  await start();
  await js(win, `document.querySelector('[data-bank-next]').click()`);
  await sleep(300);
  await shot(win, '75-bankauto-withdraw');
  await js(win, `(() => { const i = document.querySelector('[data-bank-withdraw]'); i.value = '0200'; i.dispatchEvent(new Event('input')); document.querySelector('[data-bank-withdraw-go]').click(); })()`);
  await sleep(300);
  await shot(win, '76-bankauto-withdraw-short');
  S.bankAuto = 'sms';
};

const devTab = async (win) => {
  await js(win, `document.querySelector('#rail [data-view=settings]').click()`);
  await sleep(100);
  await js(win, `document.querySelector('[data-set-tab=devices]').click()`);
  await sleep(400);
};
const devScroll = (win, sel) => js(win, `document.querySelector(${JSON.stringify(sel)})?.scrollIntoView({ block: 'start' })`);
const typeCode = async (win, v) => {
  await js(win, `(() => { const i = document.querySelector('[data-pclink-code]'); i.value = ${JSON.stringify(v)}; i.dispatchEvent(new Event('input')); })()`);
  await js(win, `document.querySelector('[data-act=pclink-confirm]').click()`);
  await sleep(250);
};
const linkView = (step, o = {}) => ({ step, email: 'owner@ganada.example', codeExpiresAt: null, error: null, phones: 0, ...o });
Object.assign(scenes, {
  async devices(win) {
    const reset = (devices, reqs = [], o = {}) => Object.assign(S, { acct: signedIn, devices, reqs, devErr: null, pcMode: 'ok', ...o });
    reset(DEV.normal());
    await devTab(win);
    await shot(win, '70-devices');
    await devScroll(win, '[data-device-group=desktop]');
    await shot(win, '70b-devices-list');
    await js(win, `document.querySelectorAll('[data-act=device-unlink-open]')[0].click()`);
    await sleep(150);
    await shot(win, '70c-devices-unlink-confirm');
    await js(win, `document.querySelector('[data-act=device-confirm-back]').click()`);
    reset(DEV.full());
    await devTab(win);
    await devScroll(win, '[data-device-group=desktop]');
    await shot(win, '71-devices-full');
    reset(DEV.suspended());
    await devTab(win);
    await devScroll(win, '[data-device-group=desktop]');
    await shot(win, '72-devices-suspended');
    reset(DEV.alone());
    await devTab(win);
    await devScroll(win, '[data-device-group=desktop]');
    await shot(win, '73-devices-last-pc');

    reset(DEV.normal(), [req('new')]);
    await devTab(win);
    await devScroll(win, '[data-pclink-card]');
    await shot(win, '74-pclink-request');
    await js(win, `document.querySelector('[data-act=pclink-begin]').click()`);
    await sleep(250);
    await shot(win, '75-pclink-wait');
    S.reqs = [req('code')];
    await sleep(3_400);
    await shot(win, '76-pclink-code');
    await typeCode(win, '482916');
    await shot(win, '77-pclink-wrong');
    await typeCode(win, '482915');
    await devScroll(win, '[data-pclink-card]');
    await shot(win, '78-pclink-done');
    reset([...DEV.normal(), devRow(9, 'desktop', 'windows', '새 노트북', { ago: 0 })], [req('code')]);
    await devTab(win);
    await devScroll(win, '[data-device-group=desktop]');
    await shot(win, '78b-pclink-listed-linking');
    reset(DEV.normal(), [req('code', { triesLeft: 1 })]);
    await devTab(win);
    await typeCode(win, '111111');
    await devScroll(win, '[data-device-msg]');
    await shot(win, '79-pclink-tries');
    reset(DEV.normal(), [req('code')], { pcMode: 'expired' });
    await devTab(win);
    await typeCode(win, '482915');
    await devScroll(win, '[data-device-msg]');
    await shot(win, '80-pclink-expired');
    reset(DEV.full().filter((d) => d.state !== 'pending'), [req('code')], { pcMode: 'limit' });
    await devTab(win);
    await typeCode(win, '482915');
    await devScroll(win, '[data-pclink-card]');
    await shot(win, '81-pclink-limit');
    reset([], [], { devErr: 'account.device_suspended' });
    await devTab(win);
    await shot(win, '82-device-gone');
  },
  async px(win) {
    Object.assign(S, { acct: signedIn, devices: DEV.px(), reqs: [], devErr: null, pcMode: 'ok' });
    await devTab(win);
    await devScroll(win, '[data-device-group=mobile]');
    await shot(win, '74-px-states');
    await js(win, `document.querySelector('[data-act=px-off-open]').click()`);
    await sleep(150);
    await shot(win, '74b-px-off-confirm');
    await js(win, `document.querySelector('[data-act=px-off]').click()`);
    await sleep(250);
    await devScroll(win, '[data-device-group=mobile]');
    await shot(win, '74c-px-paused');
    await js(win, `document.querySelector('[data-act=px-on]').click()`);
    await sleep(250);
    await devScroll(win, '[data-device-group=mobile]');
    await shot(win, '74d-px-allowed');
    await js(win, `document.querySelectorAll('[data-device-group=mobile] [data-act=device-unlink-open]')[1].click()`);
    await sleep(200);
    await shot(win, '74e-unlink-confirm');
    await js(win, `document.querySelector('[data-act=device-unlink]').click()`);
    await sleep(250);
    await devScroll(win, '[data-device-group=mobile]');
    await shot(win, '74f-unlinked');
    Object.assign(S, { devices: DEV.suspended() });
    await devTab(win);
    await devScroll(win, '[data-device-group=desktop]');
    await shot(win, '74g-suspended-hidden');
  },
  async pair(win) {
    Object.assign(S, { acct: signedIn, devices: DEV.normal(), reqs: [], devErr: null, pair: PAIR_IDLE });
    const push = async (v) => {
      S.pair = v;
      ev(win, { type: 'pair', pair: v });
      await sleep(150);
    };
    await devTab(win);
    await shot(win, '90-pair-rest');
    await js(win, `document.querySelector('[data-act=pair-open]').click()`);
    await sleep(200);
    await shot(win, '91-pair-qr');
    await push({ ...S.pair, step: 'awaiting_sas', qr: null, phoneName: '사장님 폰', triesLeft: 3 });
    await sleep(250);
    await shot(win, '92-pair-sas');
    const typeSas = (d) => `(() => { const b = document.querySelector('.sas-box'); b.focus(); b.value = '${d}'; b.dispatchEvent(new Event('input')); })()`;
    await js(win, typeSas('482'));
    await sleep(150);
    await shot(win, '92b-pair-sas-typing');
    await js(win, `document.querySelectorAll('.sas-box')[3].value = '916'; document.querySelectorAll('.sas-box')[3].dispatchEvent(new Event('input'))`);
    await sleep(120);
    await shot(win, '93-pair-sas-wrong');
    await js(win, typeSas('482915'));
    await sleep(250);
    await shot(win, '94-pair-done');
    await js(win, `document.querySelector('[data-act=pair-close]').click()`);
    await sleep(150);
    await shot(win, '95-pair-closed');
    await push({ ...PAIR_IDLE, step: 'failed', error: 'pair.expired' });
    await shot(win, '96-pair-expired');
    await push({ ...PAIR_IDLE, step: 'failed', error: 'pair.handshake' });
    await shot(win, '97-pair-failed');
    await push({ ...PAIR_IDLE, step: 'opening' });
    await shot(win, '98-pair-opening');
    await push({ ...PAIR_IDLE, step: 'awaiting_sas', phoneName: '사장님 폰', triesLeft: 1, expiresAt: Date.now() + 61_000 });
    await push({ ...PAIR_IDLE, step: 'failed', error: 'pair.sas_locked', phoneName: '사장님 폰' });
    await shot(win, '99-pair-sas-locked');
    await push(PAIR_IDLE);
  },
  async newPc(win) {
    Object.assign(S, { acct: { step: 'signed_out', email: null, codeExpiresAt: null, error: null, phones: 0 }, devErr: null });
    await devTab(win);
    await js(win, `document.querySelector('[data-act=account-login]').click()`);
    await sleep(150);
    for (const [name, v] of [['83-link-wait', linkView('link_wait')], ['84-link-code', linkView('link_code', { linkCode: '482915' })], ['85-link-confirm', linkView('link_confirm', { linkCode: '482915' })]]) {
      S.acct = v;
      ev(win, { type: 'account', account: v });
      await sleep(200);
      await shot(win, name);
    }
    S.acct = linkView('signed_out', { error: 'account.link_rejected' });
    ev(win, { type: 'account', account: S.acct });
    await sleep(200);
    await shot(win, '86-link-rejected');
    S.acct = linkView('signed_out', { error: 'account.device_limit' });
    ev(win, { type: 'account', account: S.acct });
    await sleep(200);
    await shot(win, '87-link-limit');
  },
  async issueDate(win) {
    await js(win, `(() => { const i = document.querySelector('#composer'); i.value = 'A상사 지난달 말일자로 10개 33만원씩 끊어줘'; i.dispatchEvent(new Event('input')); document.querySelector('.sx-send').click(); })()`);
    await sleep(300);
    const t = dayOffset(0);
    const lastMonthEnd = new Date(Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);
    const back = { writeDate: lastMonthEnd, writeDateSet: true, quantity: 10, unitPrice: 330000 };
    ev(win, { type: 'run', run: { ...mkRun('draft'), ...back, issueDateHeld: true } });
    await sleep(100);
    await shot(win, '04d-draft-issue-date-held');
    ev(win, { type: 'run', run: { ...mkRun('draft'), ...back, issueDateHeld: false, issueDateLate: true } });
    await sleep(100);
    await shot(win, '04e-draft-issue-date-late');
  },
});

const order = ['rail', 'home', 'board', 'menu', 'typing', 'flow', 'issueDate', 'attention', 'incidents', 'browser', 'replace', 'openBank', 'muse', 'scroll', 'steps', 'react', 'docs', 'docsReview', 'cps', 'biz', 'settings', 'g24', 'g24Import', 'onboarding', 'onbNoCert', 'onbOld', 'bank', 'bankNoAcct', 'loading', 'errors', 'devices', 'px', 'pair', 'newPc', 'bankAuto', ...(EMPTY ? ['empty'] : [])];
const agreed = { version: 'pv', choice: 'agreed', at: '' };
for (const theme of process.env.DARK ? ['dark'] : ['light']) {
  for (const k of order) {
    if (ONLY && !ONLY.includes(k)) continue;
    const ports = () => new MockOnboardingPorts({ saveProfile: async () => {} });
    const noCert = () => Object.assign(ports(), { findCerts: async () => [] });
    S.onb = k === 'onbNoCert' ? new OnboardingFlow(noCert()) : k === 'onboarding' ? new OnboardingFlow(ports()) : k === 'onbOld' ? new OnboardingFlow(ports(), { ...initialOnbState(), step: 'tasks', consents: { terms: agreed, model: agreed } }) : null;
    S.emptyBoot = k === 'loading' || k === 'errors';
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
