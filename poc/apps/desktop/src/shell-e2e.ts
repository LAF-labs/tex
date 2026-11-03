// PoC-9·PoC-6 셸 e2e: 발급 흐름(초안 → 엔진 H-01 플레이북 → 게이트 요청 → 승인 바 → 게이트 포트 → 발급 → verify → 결과),
// 승인 바 판정, 습관 클릭, 중복 경고, 위조 경로, 정부24 목업, 스크린샷. fixture 모드(가짜 H-01 페이지, 임시 앱 폴더, 메모리 키)로 돈다.
// 바 입력은 main의 sendInputEvent라 판정 로직만 본다(실제 포인터 좌표·OS 입력은 Windows에서). 실행 Chrome은 headless다.
// 실행: pnpm demo:e2e  (스크린샷·결과: reports/raw/poc-6/shell/)
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, clipboard, nativeImage, nativeTheme } from 'electron';
import { buildGateRequest, gateSelfCheck, type GateRequest } from '@sax/engine/gate';
import { kstToday, summarize, type SummaryLine } from './approval-gate.ts';
import { barBounds, SHELL } from './shell-layout.ts';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';

registerShellSchemes();
app.setPath('userData', path.join(app.getPath('temp'), `sax-shell-e2e-${process.pid}`));
app.on('window-all-closed', () => {});

const OUT = path.resolve(import.meta.dirname, '../../../reports/raw/poc-6/shell');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` ${JSON.stringify(detail)}`}`);
};
const observations: Record<string, unknown> = {};

let S: Shell;
const js = <T = unknown>(code: string): Promise<T> => S.win.webContents.executeJavaScript(code) as Promise<T>;
async function until(what: string, fn: () => boolean | Promise<boolean>, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  console.log(`  (timeout: ${what})`);
  return false;
}
const runStatus = (id: string) => S.runs.get(id)?.status;

/** 페이지를 바꿔 불러오는 중에는 캡처 면이 없을 수 있어 몇 번 다시 시도한다. */
async function capture(wc: Electron.WebContents): Promise<Electron.NativeImage> {
  for (let i = 0; ; i++) {
    try {
      return await wc.capturePage();
    } catch (e) {
      if (i >= 20) throw e;
      if (i === 0) console.log(`  (capture retry: ${(e as Error).message})`);
      await sleep(100);
    }
  }
}

/** 메인 화면과 승인 바 뷰를 합쳐 1배 PNG로 남긴다(BrowserWindow.capturePage는 자식 뷰를 담지 않는다). */
async function shot(name: string): Promise<void> {
  await sleep(120);
  const [cw, ch] = S.win.getContentSize() as [number, number];
  const main = (await capture(S.win.webContents)).resize({ width: cw, height: ch, quality: 'best' });
  const buf = Buffer.from(main.toBitmap());
  const snap = S.bar.snapshot();
  if (snap.visible) {
    // 바 페이지를 바꿔 불러오는 중이면 다 불러온 뒤에 찍는다.
    await until('bar loaded', () => !S.bar.view.webContents.isLoading(), 2000);
    await sleep(60);
    const b = snap.bounds;
    const bar = (await capture(S.bar.view.webContents)).resize({ width: b.width, height: b.height, quality: 'best' });
    const bb = bar.toBitmap();
    for (let y = 0; y < b.height && b.y + y < ch; y++) {
      const src = y * b.width * 4;
      const dst = ((b.y + y) * cw + b.x) * 4;
      bb.copy(buf, dst, src, src + Math.min(b.width, cw - b.x) * 4);
    }
  }
  await fs.writeFile(path.join(OUT, `${name}.png`), nativeImage.createFromBitmap(buf, { width: cw, height: ch }).toPNG());
}

async function type(text: string): Promise<void> {
  await js(`(() => { const t = document.querySelector('#composer'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); })()`);
}
const click = (sel: string) => js<boolean>(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);
async function sendText(text: string): Promise<void> {
  await type(text);
  await click('.sx-send');
}
const lastRunId = () => js<string | null>(`[...document.querySelectorAll('[data-run]')].pop()?.dataset.run ?? null`);

// 바 입력(바 기준 DIP 좌표)
const barWc = () => S.bar.view.webContents;
const mid = () => ({ x: Math.floor(S.bar.snapshot().bounds.width / 2), y: Math.floor(SHELL.barHeight / 2) });
function barEnterMove(): void {
  const p = mid();
  barWc().sendInputEvent({ type: 'mouseEnter', x: p.x, y: p.y });
  barWc().sendInputEvent({ type: 'mouseMove', x: p.x, y: p.y, movementX: 3, movementY: 1 });
}
function barClick(): void {
  const p = mid();
  barWc().sendInputEvent({ type: 'mouseDown', x: p.x, y: p.y, button: 'left', clickCount: 1 });
  barWc().sendInputEvent({ type: 'mouseUp', x: p.x, y: p.y, button: 'left', clickCount: 1 });
}
const barLeave = () => barWc().sendInputEvent({ type: 'mouseLeave', x: -5, y: -5 });
/** 메인 창에 실제 입력 하나(main의 before-mouse-event가 본다). 짝 없는 mouseUp이라 화면의 아무것도 누르지 않는다. */
const gesture = () => S.win.webContents.sendInputEvent({ type: 'mouseUp', x: 1, y: 1, button: 'left', clickCount: 1 });
/**
 * [홈택스에서 준비]: main은 2초 안의 실제 입력 뒤에만 받는다(ADR-027 결정 8). 부하가 크면(전체 시험 직후 등) 입력과
 * 클릭 사이가 2초를 넘어 gesture_required로 거부될 수 있다. 그 거부(토스트 "잠시 뒤 다시 눌러 주세요")일 때만 입력을 새로
 * 주고 다시 누른다(최대 3번). 다른 거부(진행 중 등)는 그대로 둔다: 그 판정을 보는 검사가 있다.
 */
async function prepare(id: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await js(`(() => { const t = document.getElementById('toast'); t.hidden = true; t.textContent = ''; })()`);
    gesture();
    await sleep(30);
    await click(`[data-run="${id}"] [data-act=prepare]`);
    const rejected = async () => runStatus(id) === 'draft' && (await js<string>(`document.getElementById('toast').textContent || ''`)).includes('잠시 뒤 다시 눌러');
    await until('prepare answered', async () => runStatus(id) !== 'draft' || (await rejected()), 3000);
    if (!(await rejected())) return;
    console.log(`  (prepare: gesture_required, retry ${i + 1})`);
  }
}
/** 무장됨 = 판정상 무장 + 무장됨 페이지가 실제로 화면에 올라옴. */
const waitArmed = () => until('bar armed', () => S.bar.snapshot().armed && S.bar.snapshot().committed?.mode === 'armed');
/** OS 커서 위치(바의 "멈춘 커서 아래" 판단용). e2e 기본은 바 밖. */
const cursor = { x: -9999, y: -9999 };


/** 엔진이 보낸 게이트 요청(실행별 마지막). 바는 main이 이 fields로 해시를 다시 계산해 무장한다. */
const gates = new Map<string, GateRequest>();
let barShown = 0;
const fx = () => S.fixture!;
const inspect = (runId: string) => S.host.rpc('run.inspect', { runId }) as Promise<{ ledger: string | null; journal: string[] }>;

async function toDraft(text: string): Promise<string> {
  const before = await lastRunId();
  await sendText(text);
  await until('draft', async () => !!(await lastRunId()) && (await lastRunId()) !== before);
  return (await lastRunId())!;
}

async function toWaiting(text: string): Promise<string> {
  const id = await toDraft(text);
  await prepare(id);
  await until('waiting', () => runStatus(id) === 'waiting', 15_000);
  await until('bar visible', () => S.bar.snapshot().visible);
  return id;
}

/** 바 안에서 움직이고 머문 뒤 클릭(정상 승인). */
async function approveOnBar(): Promise<void> {
  await waitArmed();
  barLeave();
  barEnterMove();
  await sleep(200);
  barClick();
}

async function stopRun(id: string): Promise<void> {
  await click(`[data-run="${id}"] [data-act=stop]`);
  await until('stopped', () => runStatus(id) === 'stopped' && !S.bar.snapshot().visible, 8000);
}

async function flow(): Promise<void> {
  nativeTheme.themeSource = 'light';
  await S.ready;
  S.runs.on('gate', (id: string, req: GateRequest) => gates.set(id, req));
  S.bar.on('shown', () => barShown++);
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1');
  check('셸이 뜨고 승인 바는 숨어 있다', !S.bar.snapshot().visible && !S.bar.view.getVisible());
  check('사업자 프로필·거래처는 DB(엔진 db.query.*)에서 온다', (await js<string>(`document.querySelector('#titlebar').textContent`)).includes('가나다컴퍼니') && S.runs.counterparties.length === 3 && S.runs.counterparties.every((c) => /^[0-9a-f-]{36}$/.test(c.id)), S.runs.counterparties.map((c) => c.id));
  await shot('01-home');

  // T-01 부가세 토글
  await type('A상사에 330만원 세금계산서 끊고 메일 보내 줘');
  check('"계산서" 입력 시 부가세 [별도][포함] 토글', (await js<number>(`document.querySelectorAll('#quick [data-vat]').length`)) === 2);
  await shot('02-vat-toggle');
  await click('.sx-send');
  await until('draft card', async () => !!(await lastRunId()));
  const id = (await lastRunId())!;
  const draftText = await js<string>(`document.querySelector('[data-run="${id}"]').textContent`);
  check('초안 카드: 고르지 않으면 부가세 별도(3,300,000 + 330,000 = 3,630,000원)', draftText.includes('3,630,000') && draftText.includes('부가세 별도로 계산했어요') && !draftText.includes('승인하고 발급'), draftText.slice(0, 120));
  const inputBefore = await js<number>(`document.querySelector('.sx-input').getBoundingClientRect().bottom`);
  check('초안 카드에 승인 버튼이 없다(ADR-021)', !(await js<boolean>(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('승인'))`)));
  await shot('03-draft');
  await click(`[data-run="${id}"] [data-act=vat]`);
  await until('vat included', () => S.runs.get(id)?.total === 3_300_000);
  check('[부가세 포함하기] → 합계 3,300,000원', S.runs.get(id)?.supply === 3_000_000 && S.runs.get(id)?.tax === 300_000);
  await click(`[data-run="${id}"] [data-act=vat]`);
  await until('vat separate', () => S.runs.get(id)?.total === 3_630_000);

  // 실제 입력 없이(렌더러 신호만) 온 실행 시작은 받지 않는다(ADR-027 결정 8). 이 앞에는 실제 입력이 없다.
  await sleep(2100);
  const noGesture = await js<string>(`window.sax.call('run.prepare', { id: ${JSON.stringify(id)} }).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  check('실제 입력 없이 온 run.prepare는 gesture_required(초안 그대로)', noGesture === 'gesture_required' && runStatus(id) === 'draft', noGesture);

  // 실행: 엔진이 가짜 H-01 페이지에서 입력·되읽기·기준선 조회를 하는 동안 바는 뜨지 않는다.
  await prepare(id);
  await until('preparing', () => runStatus(id) === 'preparing');
  check('실행(준비) 중 바는 뜨지 않는다', runStatus(id) === 'preparing' && !S.bar.snapshot().visible);
  await shot('04-preparing');

  // T-03 승인 대기 + 승인 바
  await until('waiting', () => runStatus(id) === 'waiting', 15_000);
  await until('bar visible', () => S.bar.snapshot().visible);
  const req = gates.get(id)!;
  const f = new Map(req?.fields.map((x) => [x.fieldKey, x.value]));
  check('게이트 요청: 엔진이 되읽은 13칸 + 예약 키, main이 다시 계산한 해시가 맞는다(D03 §3)', !!req && req.v === 2 && gateSelfCheck(req) === null && !S.bar.snapshot().refusal && f.get('supplierBizNo') === '1234567891' && f.get('totalAmount') === '3630000' && f.get('counterpartEmail') === 'tax@asangsa.example', req?.fields);
  check('원장이 비어 있으면 처음 거래·처음 보내는 주소(원장 HMAC 열, 확정 건만 셈)', f.get('$first.bizNo') === 'true' && f.get('$first.email') === 'true' && !f.has('$dup.businessKey'));
  const firstTotal = (summarize(req) as SummaryLine[])[1]!.pieces.map((x) => x.text).join('');
  check('작성일자 = KST 오늘이면 바 합계 줄에 작성일 조각이 없다(가짜 H-01도 KST)', f.get('issueDate') === kstToday(Date.now()) && !firstTotal.includes('작성일'), { issueDate: f.get('issueDate'), firstTotal });
  check('카드·패널은 엔진이 되읽은 값으로 바뀐다(홈택스 확정)', S.runs.get(id)!.confirmed && S.runs.get(id)!.counterparty.first && (await js<string>(`document.querySelector('[data-run="${id}"]').textContent`)).includes('초안과 같아요'));
  const snap = S.bar.snapshot();
  const [cw, ch] = S.win.getContentSize() as [number, number];
  const exp = barBounds(cw, ch);
  check('승인 대기에 바가 뜬다(main이 창 크기로 정한 자리)', snap.visible && snap.bounds.x === exp.x && snap.bounds.y === exp.y && snap.bounds.width === exp.width, { snap: snap.bounds, exp });
  check('바는 처음에 무장 전(흐림)이다', snap.mode === 'unarmed' && !snap.armed, snap);
  // 무장 전 클릭: 거부 + "잠시 뒤 다시 눌러 주세요", 600ms 재시작
  barEnterMove();
  barClick();
  await until('arming msg', () => S.bar.snapshot().msg === '잠시 뒤 다시 눌러 주세요', 500);
  check('무장 전 클릭은 거부하고 "잠시 뒤 다시 눌러 주세요"', runStatus(id) === 'waiting' && S.bar.snapshot().msg === '잠시 뒤 다시 눌러 주세요', S.bar.snapshot());
  await shot('06-bar-arming-refused');
  await waitArmed();
  await shot('07-waiting-armed');
  // 렌더러가 비운 자리와 바가 맞는지(렌더러 좌표는 판정에 쓰지 않는다. 배치 규칙 확인용)
  const slot = await js<{ top: number; bottom: number; colLeft: number; colWidth: number; composerTop: number }>(`(() => {
    const s = document.querySelector('.bar-slot').getBoundingClientRect();
    const c = document.querySelector('.composer-zone .col').getBoundingClientRect();
    const z = document.querySelector('.composer-zone').getBoundingClientRect();
    return { top: s.top, bottom: s.bottom, colLeft: c.left, colWidth: c.width, composerTop: z.top };
  })()`);
  const b = S.bar.snapshot().bounds;
  check('렌더러가 바 자리를 비운다(바 = 비운 자리 위쪽, 입력창 예약 영역과 12 DIP 간격)', Math.abs(slot.top - b.y) <= 1 && Math.abs(slot.composerTop - (b.y + b.height + SHELL.gap)) <= 1, { slot, bar: b });
  check('바 폭·위치 = 대화 열(패널 열림)', Math.abs(slot.colLeft - b.x) <= 1 && Math.abs(slot.colWidth - b.width) <= 1, { slot, bar: b });
  const inputAfter = await js<number>(`document.querySelector('.sx-input').getBoundingClientRect().bottom`);
  check('바가 떠도 입력창은 제자리에 있다', Math.abs(inputAfter - inputBefore) <= 1, { inputBefore, inputAfter });
  observations.layout = { content: [cw, ch], bar: b, slot, composerGapAt1Line: (await js<number>(`document.querySelector('.sx-input').getBoundingClientRect().top`)) - (b.y + b.height) };

  // 키보드·렌더러·중계 통로로는 승인되지 않는다
  for (const keyCode of ['Enter', 'Space', 'Return']) {
    barWc().sendInputEvent({ type: 'keyDown', keyCode });
    barWc().sendInputEvent({ type: 'keyUp', keyCode });
  }
  S.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  S.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await sleep(100);
  check('Enter·Space(바·입력창 모두)로는 승인되지 않는다', runStatus(id) === 'waiting' && S.bar.snapshot().visible);
  const forged = await js<string[]>(`Promise.all(['bar.hide', 'run.approve', 'gate.answer', 'answerGate', 'approval.demo'].map((m) => window.sax.call(m, { id: ${JSON.stringify(id)} }).then(() => 'accepted', (e) => String(e.message).includes('unknown_method') ? 'unknown' : e.message)))`);
  check('렌더러에는 승인·바 숨김 명령이 없다', forged.every((x) => x === 'unknown') && runStatus(id) === 'waiting' && S.bar.snapshot().visible, forged);
  // 중계 통로(엔진 parentPort)로 승인 근거를 보내면 엔진이 거부하고 보안 이벤트를 남긴다. 게이트 포트만 받는다.
  const fake = { v: 2, runId: id, gateStepId: req.gateStepId, reqId: req.reqId, approvalNonce: req.approvalNonce, actionHash: req.actionHash, exp: Date.now() + 60_000, presence: 'click', mac: 'x' };
  const relay = await Promise.all(['gate.answer', 'answerGate', 'attestNotCommitted'].map((m) => S.host.rpc(m, { approval: fake }).then(() => 'accepted', (e: Error) => e.message)));
  check('중계 통로로 온 승인·증언은 forbidden_channel(security.gate_answer_from_relay)', relay.every((x) => x === 'forbidden_channel') && runStatus(id) === 'waiting' && (await inspect(id)).journal.includes('security.gate_answer_from_relay'), relay);
  // 렌더러가 부를 수 있는 메서드를 모두 불러도(대기 중인 건의 [중지]만 빼고) 승인되지 않고 바도 그대로다.
  // 상태를 바꾸는 메서드는 거부되는 값으로 부른다(다른 실행 [중지], 없는 정부24 후보). 문서 목록도 그대로인지 본다.
  const clip = await clipboard.readText();
  const docsBefore = S.store.docs.length;
  const sweep: Record<string, string> = {};
  for (const m of S.methods) {
    const params = { id: m === 'run.stop' ? 'run-other' : m === 'g24.save' ? 'no-such-file' : id, kind: 'business', text: '승인하고 발급', vat: 'separate', amount: 1, doc: '주민등록표 등본', startedAt: 0 };
    sweep[m] = await js<string>(`window.sax.call(${JSON.stringify(m)}, ${JSON.stringify(params)}).then(() => 'ok', (e) => String(e.message).replace(/^.*Error: /, ''))`);
  }
  clipboard.writeText(clip);
  check('렌더러 메서드 전부를 불러도 승인되지 않는다(바 그대로, 문서 목록 그대로, 발급 POST 없음)', runStatus(id) === 'waiting' && S.bar.snapshot().visible && S.bar.runId === id && S.store.docs.length === docsBefore && sweep['g24.save'] === 'bad_candidate' && fx().fixture.posts() === 0, sweep);
  const barJs = await Promise.race([barWc().executeJavaScript('1+1').then((v) => `ran:${v}`, (e: Error) => `blocked:${e.message.slice(0, 40)}`), sleep(500).then(() => 'no-result')]);
  check('바 페이지는 스크립트를 실행하지 않는다(javascript:false)', barJs !== 'ran:2', barJs);

  // 습관 클릭: 입력창·간격 클릭은 바에 닿지 않고, 입력창에서 바로 올라와 누른 빠른 클릭은 머무름에 걸린다
  const gapY = Math.round(b.y + b.height + SHELL.gap / 2);
  const inX = Math.round(b.x + b.width / 2);
  for (const y of [gapY, Math.round(b.y + b.height + SHELL.gap + 20)]) {
    S.win.webContents.sendInputEvent({ type: 'mouseDown', x: inX, y, button: 'left', clickCount: 1 });
    S.win.webContents.sendInputEvent({ type: 'mouseUp', x: inX, y, button: 'left', clickCount: 1 });
  }
  await sleep(80);
  check('렌더러 영역(간격·입력창) 클릭은 바 판정에 들어가지 않는다(OS hit-test는 미시험)', runStatus(id) === 'waiting');
  barLeave();
  barEnterMove();
  await sleep(40);
  barClick();
  await sleep(60);
  check('습관 클릭: 바에 들어와 150ms 안에 누르면 거부("마우스를 조금 움직인 뒤")', runStatus(id) === 'waiting' && S.bar.snapshot().msg === '마우스를 조금 움직인 뒤 눌러 주세요', S.bar.snapshot());
  await shot('08-bar-dwell-refused');

  // 레일 화면으로 가도 바는 남는다
  await click('[data-view=docs]');
  await sleep(100);
  check('문서함으로 가도 바는 같은 자리에 남는다', S.bar.snapshot().visible && S.bar.snapshot().bounds.y === b.y);
  await shot('09-docs-with-bar');
  await click('[data-view=chat]');

  // 창 크기 변경 → 재배치·재무장, 좁은 창 → 띠
  S.win.setContentSize(1120, 760);
  await until('relayout', () => S.bar.snapshot().bounds.y === barBounds(1120, 760).y);
  check('창 크기를 바꾸면 다시 배치하고 다시 무장한다', S.bar.snapshot().mode === 'unarmed', S.bar.snapshot());
  S.win.setContentSize(900, 720);
  await until('band', () => S.bar.snapshot().bounds.width === 900 - SHELL.rail);
  await waitArmed();
  check('대화 열이 좁으면 레일 오른쪽부터 창 끝까지 띠', S.bar.snapshot().bounds.x === SHELL.rail);
  await shot('10-narrow-band');
  S.win.setContentSize(1280, 820);
  await until('restore', () => S.bar.snapshot().bounds.width === SHELL.chatMax);
  // 렌더러도 창 크기를 따라 대화 열을 다시 잡을 때까지 기다린다(엔진·Chrome이 같이 돌면 늦을 수 있다).
  const colLeft = () => js<number>(`document.querySelector('.composer-zone .col').getBoundingClientRect().left`);
  if (!(await until('renderer relayout', async () => Math.abs((await colLeft()) - S.bar.snapshot().bounds.x) <= 1, 3000))) {
    observations.relayoutDump = await js(`(() => { const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.width), e.clientWidth]; };
      return { visibility: document.visibilityState, body: document.body.className, app: document.querySelector('#app').className, colW: document.documentElement.style.getPropertyValue('--col-w'), grid: getComputedStyle(document.querySelector('#app')).gridTemplateColumns,
        center: r('#center'), col: r('.composer-zone .col'), thread: r('.sx-thread'), panel: r('#panel'), inner: innerWidth }; })()`);
  }
  // 패널을 접어도 승인 대기 중에는 패널 폭을 비워 둬 대화 열과 바가 어긋나지 않는다(규칙 없이는 170 DIP 어긋났다).
  await js(`document.querySelector('#panel .panel-x')?.click()`);
  const closedAt = Date.now();
  const offsets: number[] = [];
  for (let i = 0; i < 8; i++) {
    await sleep(50);
    offsets.push(Math.round((await colLeft()) - S.bar.snapshot().bounds.x));
  }
  const shifted = await colLeft();
  observations.panelClosedOffset = Math.round(shifted - S.bar.snapshot().bounds.x);
  observations.panelClosedOffsets = { everyMs: 50, from: closedAt, offsets };
  check('승인 대기 중 패널을 접어도 대화 열과 바가 맞는다(접은 뒤 400ms 동안 매 50ms)', offsets.every((x) => Math.abs(x) <= 1), offsets);
  await waitArmed();
  await shot('11-panel-closed-offset');
  await click(`[data-run="${id}"]`);
  await sleep(100);

  // 정상 승인: 바 안에서 움직이고 150ms 뒤 클릭 → main이 LocalApproval v2를 발급해 게이트 포트로 → 엔진이 토큰으로 바꿈
  await approveOnBar();
  await until('approved', () => !!S.runs.get(id)?.approvedPending || runStatus(id) !== 'waiting', 2000);
  check('바 안에서 머문 뒤 클릭 = 승인 → 바가 내려가고 자리가 돌아온다(거부 우선 창 2초 동안 [중지] 가능)', !S.bar.snapshot().visible && !!S.runs.get(id)?.approvedPending && (await until('slot', async () => (await js<number>(`document.querySelector('.bar-slot').offsetHeight`)) === 0)));
  await shot('12-approved-deny-window');
  await until('issuing', () => runStatus(id) === 'issuing', 5000);
  await shot('13-issuing');
  await until('done', () => runStatus(id) === 'done', 20_000);
  const r = S.runs.get(id)!;
  const issued = fx().fixture.issued.at(-1);
  // main 상태가 done이 된 직후에는 렌더러가 아직 그리지 않았을 수 있다. 승인번호가 보일 때까지 기다린다.
  const cardText = () => js<string>(`document.querySelector('[data-run="${id}"]').textContent`);
  await until('result card', async () => !!r.result && (await cardText()).includes(r.result.approvalNo), 3000);
  const doneText = await cardText();
  check('결과 카드: 가짜 페이지가 발급한 승인번호·메일 전송 확인', !!r.result && r.result.approvalNo === issued?.approvalNo && doneText.includes(r.result.approvalNo) && doneText.includes('메일로 보낸 것도 확인했어요'), { doneText: doneText.slice(0, 160), issued });
  const ins = await inspect(id);
  check('원장: (intent, s21) committed, 저널에 게이트 요청·승인·armed·dispatched', ins.ledger === 'committed' && ['gate.requested', 'gate.approved', 'ledger.armed', 'ledger.dispatched', 'ledger.committed', 'run.ended'].every((t) => ins.journal.includes(t)) && fx().fixture.posts() === 1, ins);
  check('가짜 페이지에 들어간 값 = 승인 바에 보인 값', issued?.counterpartBizNo === '2148651233' && issued.supplyAmount === '3300000' && issued.taxAmount === '330000' && issued.counterpartEmail === 'tax@asangsa.example', issued);
  await shot('14-result');
  await click('[data-view=docs]');
  await sleep(100);
  check('문서함에 발급 결과가 들어온다', (await js<string>(`document.querySelector('[data-view=docs] tbody').textContent`)).includes('세금계산서 · A상사'));
  await click(`[data-doc-row="d-${id}"]`);
  await shot('15-docs');
  await click('[data-view=cps]');
  await shot('16-counterparties');
  await click('[data-view=chat]');

  // 입력 보완: 되물은 거래처·금액에 짧게 답해도 이어진다
  await sendText('세금계산서');
  await until('ask cp', async () => (await js<string>(`document.querySelector('.sx-thread').lastElementChild.textContent`)).includes('어느 거래처'));
  await js(`[...document.querySelectorAll('.reply-chips button')].find((b) => b.textContent === 'A상사').click()`);
  await click('.sx-send');
  await until('ask amount', async () => (await js<string>(`document.querySelector('.sx-thread').lastElementChild.textContent`)).includes('얼마를'));
  const before = await lastRunId();
  await sendText('77만원');
  await until('draft from answers', async () => (await lastRunId()) !== before);
  const idQ = (await lastRunId())!;
  check('입력 보완: "세금계산서" → [A상사] → "77만원"이면 초안이 된다', S.runs.get(idQ)?.counterparty.name === 'A상사' && S.runs.get(idQ)?.total === 847_000, S.runs.get(idQ)?.total);
  await click(`[data-run="${idQ}"] [data-act=cancel]`);

  // 같은 건 다시: 업무 중복 키가 원장에 있으면 차단하지 않고 경고. 바 글자가 "같은 건 기록을 확인했고 발급"(D02 §7 명시 확인).
  const idDup = await toWaiting('A상사에 330만원 세금계산서');
  const fd = new Map(gates.get(idDup)!.fields.map((x) => [x.fieldKey, x.value]));
  const dupLines = summarize(gates.get(idDup)!) as SummaryLine[];
  await waitArmed();
  check('같은 건 발급 확정: $dup.businessKey가 fields(cardHash)에 들어가고 바는 주의 색 "이미 발급됨"·"한 번 더 발급"', fd.get('$dup.businessKey') === 'committed' && fd.get('$first.bizNo') === 'false' && dupLines[1]?.flag === '이미 발급됨(승인번호 있음)' && dupLines[1]?.tone === 'attention' && S.bar.snapshot().action === '그래도 한 번 더 발급', { fields: [...fd], action: S.bar.snapshot().action });
  const dupCard = await js<string>(`document.querySelector('[data-run="${idDup}"]').textContent`);
  check('승인 대기 카드에도 고정 경고·같은 동작 글자가 붙는다', dupCard.includes('한 번 더 발급하면 같은 계산서가 2건이 돼요') && dupCard.includes('[그래도 한 번 더 발급]'), dupCard.slice(0, 300));
  await shot('17-dup-warning');
  await stopRun(idDup);

  // 중지: 승인 대기에서 [중지] → 바가 내려가고 발급 없음. 그동안 다른 건은 준비할 수 없다(실행은 한 번에 하나).
  const id2 = await toWaiting('B상사에 55만원 세금계산서');
  // 두 번째 게이트: 앞 게이트를 바 안에서 눌러 승인했고 그 뒤 mouseLeave를 보내지 않았다. OS 커서는 바 밖(입력창)이다.
  await waitArmed();
  barWc().sendInputEvent({ type: 'mouseMove', x: mid().x, y: mid().y, movementX: 0, movementY: -6 });
  await sleep(20);
  barClick();
  await sleep(60);
  check('다음 게이트: 입력창에서 바로 올라온 클릭은 머무름으로 거부(앞 게이트 추적 상태를 안 믿음)', runStatus(id2) === 'waiting' && S.bar.snapshot().msg === '마우스를 조금 움직인 뒤 눌러 주세요', S.bar.snapshot());
  const idBusy = await toDraft('C테크에 10만원 세금계산서');
  await prepare(idBusy);
  await sleep(150);
  check('승인 대기 중에는 다른 건을 준비할 수 없고 바는 그대로다', runStatus(idBusy) === 'draft' && S.bar.runId === id2 && runStatus(id2) === 'waiting');
  await click(`[data-run="${idBusy}"] [data-act=cancel]`);
  // 창이 뒤로 가면 무장 전 페이지, 핸드오프가 아닌 활성화는 무장 지연을 다시 센다(첫 클릭은 앞으로 가져오기, ADR-027 결정 5).
  await waitArmed();
  S.win.emit('blur');
  await until('blur unarmed', () => S.bar.snapshot().committed?.mode === 'unarmed', 2000);
  const blurred = S.bar.snapshot();
  S.win.emit('focus');
  await sleep(30);
  const refocused = S.bar.snapshot();
  check('창 blur → 무장 전 페이지, 핸드오프 아닌 활성화 → 다시 무장 지연', blurred.mode === 'unarmed' && refocused.mode === 'unarmed' && !refocused.armed, { blurred, refocused });
  // 금고가 부르는 비밀 창(ADR-025 결정 10): 활성 실행의 요청만, OS 제목줄 "금고 · …"의 메인 창 모달 하나, 문구는 main 표.
  S.host.emit('vault-event', 'secret.needed', { runId: 'run-nope', targetId: 'T0', kind: 'portal_password', scope: 'business' });
  await sleep(100);
  const noWin = S.secretWindow() === null;
  S.host.emit('vault-event', 'secret.needed', { runId: id2, targetId: 'T1', kind: 'portal_password', scope: 'business' });
  await until('secret window', () => !!S.secretWindow() && !S.secretWindow()!.webContents.isLoading(), 5000);
  const sw = S.secretWindow();
  S.host.emit('vault-event', 'secret.needed', { runId: id2, targetId: 'T2', kind: 'security_card', scope: 'business', row: 7 });
  await sleep(100);
  const swText = sw ? await sw.webContents.executeJavaScript('document.body.innerText').catch(() => '') : '';
  check('비밀 창: 활성 실행의 secret.needed만, 제목줄 "금고 · 홈택스 비밀번호", 메인 창 모달 하나, 첫 줄·고정 문구는 main 표', noWin && !!sw && sw.getTitle() === '금고 · 홈택스 비밀번호' && sw.isModal() && sw.getParentWindow() === S.win && S.secretWindow() === sw && swText.includes('세금계산서 발급 · 홈택스 · 가나다컴퍼니') && swText.includes('앱은 대화창 안에서 비밀번호·카드 번호를 묻지 않아요'), { noWin, title: sw?.getTitle(), swText });
  if (sw) await fs.writeFile(path.join(OUT, '18b-secret-window.png'), (await capture(sw.webContents)).toPNG());
  const pwReveal = sw ? await sw.webContents.executeJavaScript(`!!document.getElementById('reveal')`).catch(() => null) : null;
  sw?.close();
  // 열려 있을 때 온 요청(보안카드 7번 칸)은 버리지 않고 창이 닫히면 이어서 연다.
  await until('queued secret window', () => !!S.secretWindow() && S.secretWindow() !== sw && !S.secretWindow()!.webContents.isLoading(), 5000);
  const sw2 = S.secretWindow();
  check('비밀 창이 열려 있을 때 온 요청은 창이 닫힌 뒤 이어서 연다(제목 "금고 · 보안카드 번호")', !!sw2 && sw2.getTitle() === '금고 · 보안카드 번호' && sw2.isModal(), sw2?.getTitle());
  // SecretField: 보안카드 번호는 기본으로 가리고 보기 버튼 하나로 보인다(30초 뒤 다시 가림은 secret.js 타이머). 비밀번호 창에는 보기 버튼이 없다.
  const reveal = sw2
    ? await sw2.webContents
        .executeJavaScript(
          `(() => { const b = document.getElementById('reveal'), v = document.getElementById('v'); if (!b) return null; const before = [v.type, b.getAttribute('aria-pressed')]; b.click(); const on = [v.type, b.getAttribute('aria-pressed'), document.getElementById('reveal-note').textContent, b.textContent]; b.click(); return { before, on, after: [v.type, b.getAttribute('aria-pressed'), b.textContent] }; })()`,
        )
        .catch(() => null)
    : null;
  check(
    '비밀 창 보안카드 칸: 기본은 가림, [번호 보기]로 보이고 "30초 뒤 다시 가려요", 다시 누르면 가림. 비밀번호 창에는 보기 버튼 없음',
    pwReveal === false &&
      reveal?.before.join() === 'password,false' &&
      reveal.on[0] === 'text' && reveal.on[1] === 'true' && reveal.on[2] === '30초 뒤 다시 가려요' && reveal.on[3] === '번호 가리기' &&
      reveal.after.join() === 'password,false,번호 보기',
    { pwReveal, reveal },
  );
  sw2?.close();
  await until('secret closed', () => S.secretWindow() === null, 3000);
  // 창을 열다 실패해도 '열림'이 남지 않는다: 다음 요청은 정상으로 열린다.
  const realPort = S.host.secretInputPort.bind(S.host);
  S.host.secretInputPort = () => {
    throw new Error('e2e: port failed');
  };
  S.host.emit('vault-event', 'secret.needed', { runId: id2, targetId: 'T5', kind: 'portal_password', scope: 'business' });
  await sleep(200);
  const failedNoWin = S.secretWindow() === null;
  S.host.secretInputPort = realPort;
  S.host.emit('vault-event', 'secret.needed', { runId: id2, targetId: 'T6', kind: 'portal_password', scope: 'business' });
  await until('secret window after failure', () => !!S.secretWindow(), 5000).catch(() => {});
  const reopened = !!S.secretWindow();
  check('비밀 창을 열다 실패해도 다음 요청은 정상으로 연다(조정자에 열림이 남지 않음)', failedNoWin && reopened, { failedNoWin, reopened });
  S.secretWindow()?.close();
  await until('secret closed after failure test', () => S.secretWindow() === null, 3000);
  S.host.emit('vault-event', 'secret_window.refused', { reason: 'google_signin_detected' });
  check('비밀 창 거부(Google 로그인)는 진행 중 카드에 사실 문장으로', (S.runs.get(id2)!.notices ?? []).some((t) => t.includes('Google 계정이 로그인돼 있어')) && S.secretWindow() === null, S.runs.get(id2)!.notices);
  // 실행이 끝나 main이 창을 닫으면 들고 있던 요청은 다시 열지 않는다(종료를 막거나 창 없이 '열림'이 남지 않게).
  S.host.emit('vault-event', 'secret.needed', { runId: id2, targetId: 'T3', kind: 'portal_password', scope: 'business' });
  await until('secret window 3', () => !!S.secretWindow(), 5000);
  S.host.emit('vault-event', 'secret.needed', { runId: id2, targetId: 'T4', kind: 'security_card', scope: 'business', row: 9 });
  await stopRun(id2);
  await until('secret closed by run end', () => S.secretWindow() === null, 3000);
  await sleep(500);
  check('실행이 끝나 main이 비밀 창을 닫으면 대기 요청은 다시 열지 않는다', S.secretWindow() === null);
  check('승인 대기에서 [중지] → 바가 내려가고 발급하지 않는다(원장 행 없음, 발급 POST 없음)', !S.bar.snapshot().visible && !S.runs.get(id2)!.result && (await inspect(id2)).ledger === null && fx().fixture.posts() === 1);

  // 처음 거래·처음 보내는 주소(C테크)
  const id3 = await toWaiting('C테크에 120만원 세금계산서 메일로');
  const lines = summarize(gates.get(id3)!) as SummaryLine[];
  check('처음 거래·처음 보내는 주소 표시는 엔진 원장 판정(fields)에서 나온다', lines[0]?.flag === '처음 거래' && lines[2]?.flag === '처음 보내는 주소');
  await waitArmed();
  await shot('18-first-trade');
  await stopRun(id3);

  // 승인한 뒤 화면 값이 바뀌면 발급 버튼을 누르지 않는다(R-G7: 클릭 직전 readback 재계산).
  const idMut = await toWaiting('B상사에 20만원 세금계산서');
  fx().fixture.knobs.mutate = { field: 'splAmt', value: '9990000' };
  await sleep(400);
  await approveOnBar();
  await until('mutation attention', () => runStatus(idMut) === 'attention', 15_000);
  fx().fixture.knobs.mutate = null;
  check('승인 뒤 화면 값이 바뀌면 누르지 않고 확인 필요(not_committed, 발급 POST 없음)', (S.runs.get(idMut)!.stoppedNote ?? '').includes('승인한 뒤 홈택스 화면 값이 바뀌어') && (await inspect(idMut)).ledger === 'not_committed' && fx().fixture.posts() === 1, { note: S.runs.get(idMut)!.stoppedNote, ins: await inspect(idMut) });
  await shot('19-mutated-after-gate');

  // 로그인한 사업자가 프로필과 다르면 게이트 전에 멈춘다(s19c supplierBizNo == $profile.bizNo).
  const shownBefore = barShown;
  fx().fixture.knobs.supplier = { bizNo: '2208162517', name: '다른사업자' };
  const idSup = await toDraft('C테크에 30만원 세금계산서');
  await prepare(idSup);
  await until('supplier attention', () => runStatus(idSup) === 'attention', 15_000);
  fx().fixture.knobs.supplier = { bizNo: '1234567891', name: '가나다컴퍼니' };
  check('공급자 불일치: 바를 띄우지 않고 멈춘다', (S.runs.get(idSup)!.stoppedNote ?? '').includes('로그인한 사업자가 이 프로필과 달라서') && barShown === shownBefore && !gates.has(idSup) && fx().fixture.posts() === 1, S.runs.get(idSup)!.stoppedNote);
  await shot('20-supplier-mismatch');

  // 정부24 목업 2장
  await sendText('주민등록등본 떼 줘');
  await until('g24', async () => (await js<number>(`document.querySelectorAll('[data-g24-panel=guide]').length`)) === 1);
  check('정부24 목업 1: 직접 발급 안내(단계·복사 값)', (await js<string>(`document.querySelector('[data-g24-panel=guide]').textContent`)).includes('출력·저장했어요'));
  await shot('21-g24-guide');
  await click('[data-act=g24-saved]');
  await until('pick', async () => (await js<number>(`document.querySelectorAll('[data-candidate]').length`)) === 2);
  const g24Times = await js<{ start: string; at: string[] }>(`({ start: document.querySelector('[data-g24-panel=pick] .sx-app-line').textContent.match(/\\d\\d:\\d\\d/)[0], at: [...document.querySelectorAll('[data-candidate] .sx-meta')].map((e) => e.textContent.match(/\\d\\d:\\d\\d/)[0]) })`);
  check('정부24 후보 파일은 작업 시작 뒤에 생긴 것만', g24Times.at.every((t) => t >= g24Times.start), g24Times);
  await click('[data-candidate=f1]');
  await sleep(80);
  check('정부24 목업 2: 새 PDF 후보 → 고른 뒤에만 값 표시', (await js<number>(`document.querySelectorAll('[data-act=g24-save]').length`)) === 1);
  await shot('22-g24-pick');
  await click('[data-act=g24-save]');
  await sleep(100);
  check('정부24 목업: 문서함에 들어간다(직접 발급)', (await js<string>(`document.querySelector('.sx-thread').textContent`)).includes('주민등록표 등본'));
  await shot('23-g24-saved');

  // 값이 대화 열 폭에 안 들어가면(긴 국제화 도메인 + 처음 보내는 주소 + 10억대) 띠로 넓혀 무장한다. 엔진 없이 바만 시험한다.
  const gate = (reqId: string): GateRequest =>
    buildGateRequest({
      runId: 'e2e-wide',
      gateStepId: 's20',
      reqId,
      readback: {
        supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: '1298134566', counterpartName: '긴이름주식회사', counterpartEmail: 'tax@회사이름이긴곳.한국',
        itemName: '시험', itemCount: '1', supplyAmount: '1000000000', taxAmount: '100000000', totalAmount: '1100000000', issueDate: '2026-11-01', remark: '', receiptType: '영수',
      },
      reserved: [{ fieldKey: '$first.bizNo', value: 'false' }, { fieldKey: '$first.email', value: 'true' }],
      packageDigest: '0'.repeat(64),
      authorizes: ['s21'],
      intentId: 'e2e',
      waitMs: 60_000,
    });
  const wide = gate('wide-1');
  const wideDone = S.bar.open(wide);
  await waitArmed();
  check('값이 넘치면 바를 띠로 넓혀 무장한다(무장 거부로 막히지 않음)', S.bar.snapshot().band && !S.bar.snapshot().refusal && S.bar.snapshot().bounds.x === SHELL.rail, S.bar.snapshot());
  check('작성일자가 KST 오늘과 다르면 합계 줄 끝에 줄이지 않는 " · 작성일 2026-11-01"', kstToday(Date.now()) !== '2026-11-01' && (summarize(wide) as SummaryLine[])[1]!.pieces.at(-1)?.text === ' · 작성일 2026-11-01');
  check('열린 게이트가 있으면 새 게이트로 바꾸지 않는다', (await S.bar.open(gate('wide-2'))).decision === 'closed' && S.bar.snapshot().reqId === 'wide-1');
  await shot('24-wide-band');
  S.bar.close('e2e');
  await wideDone;
  // 해시가 맞지 않는 게이트 요청(예약 키를 뺀 fields)은 무장하지 않는다.
  const tampered = gate('wide-5');
  tampered.fields = tampered.fields.filter((x) => x.fieldKey !== '$first.email');
  const tamperedDone = S.bar.open(tampered);
  await until('tampered bar', () => S.bar.snapshot().visible);
  await sleep(700);
  check('fields를 바꾼 게이트 요청은 "값 대조가 맞지 않아" 무장 거부', S.bar.snapshot().refusal === '값 대조가 맞지 않아 승인할 수 없어요' && !S.bar.snapshot().armed, S.bar.snapshot());
  S.bar.close('e2e');
  await tamperedDone;

  // 멈춘 커서 아래에 바가 뜸: OS 커서가 바 안에 그대로면 움직이지 않고 눌러도 600ms 뒤 승인된다.
  // 반대로 커서가 (바를 덮은 알림 위 등에서) 자리를 옮겼다면 들어오자마자 누른 클릭은 머무름으로 거부한다.
  const cb = S.win.getContentBounds();
  const wb = barBounds(cb.width, cb.height, true);
  const inside = (dx: number) => ({ x: cb.x + wb.x + Math.floor(wb.width / 2) + dx, y: cb.y + wb.y + Math.floor(wb.height / 2) });
  Object.assign(cursor, inside(0));
  const still = S.bar.open(gate('wide-3'));
  await waitArmed();
  Object.assign(cursor, inside(40));
  barWc().sendInputEvent({ type: 'mouseEnter', x: mid().x + 40, y: mid().y });
  barWc().sendInputEvent({ type: 'mouseMove', x: mid().x + 40, y: mid().y, movementX: 40, movementY: 0 });
  await sleep(10);
  barClick();
  await sleep(60);
  check('커서가 자리를 옮긴 뒤 바로 누른 클릭은 거부(가린 창이 사라지는 순간)', S.bar.snapshot().visible && S.bar.snapshot().msg === '마우스를 조금 움직인 뒤 눌러 주세요', S.bar.snapshot());
  S.bar.close('e2e');
  await still;
  Object.assign(cursor, inside(0));
  const judged: unknown[] = [];
  const onJudged = (e: unknown) => judged.push(e);
  S.bar.on('judged', onJudged);
  const still2 = S.bar.open(gate('wide-4'));
  await waitArmed();
  barClick();
  const o = await Promise.race([still2, sleep(1000).then(() => null)]);
  S.bar.off('judged', onJudged);
  check('멈춘 커서 아래 뜬 바는 움직이지 않고 눌러도 승인된다(LocalApproval v2: reqId·approvalNonce·presence)', o?.decision === 'approve' && o.approval.v === 2 && o.approval.reqId === 'wide-4' && o.approval.presence === 'click', { o, judged, snap: S.bar.snapshot(), cursor, cb: S.win.getContentBounds(), cbBefore: cb });
  if (!o) S.bar.close('e2e');
  Object.assign(cursor, { x: -9999, y: -9999 });

  // 차단 신호(D03 §7, PoC-10): 발급 화면 대신 차단 안내가 뜨면 바로 멈추고, 그 뒤로 가짜 홈택스에 요청을 보내지 않으며, 카드에 사유가 보인다.
  const idBlock = await toDraft('C테크에 44만원 세금계산서');
  const mark = fx().fixture.requests.length;
  fx().fixture.knobs.block = 'page';
  await prepare(idBlock);
  await until('block attention', () => runStatus(idBlock) === 'attention', 15_000);
  fx().fixture.knobs.block = null;
  await sleep(1500);
  const reqs = fx().fixture.requests.slice(mark);
  const blockedAt = reqs.findIndex((r) => r.path === '/notice/blocked');
  const blockCard = await js<string>(`document.querySelector('[data-run="${idBlock}"]').textContent`);
  const blockIns = await inspect(idBlock);
  check('차단 안내 → 바로 멈추고 그 뒤 요청 0회, 카드에 사유(바·게이트 없음, 원장 행 없음)', blockedAt >= 0 && reqs.length === blockedAt + 1 && blockCard.includes('차단·경고 신호') && !S.bar.snapshot().visible && !gates.has(idBlock) && blockIns.ledger === null && blockIns.journal.includes('block.signal'), { reqs, note: S.runs.get(idBlock)!.stoppedNote, ins: blockIns });
  await shot('24c-block-signal');

  // 다크 테마
  nativeTheme.themeSource = 'dark';
  await sleep(300);
  await shot('25-dark-thread');
  const id4 = await toWaiting('A상사에 88만원 세금계산서');
  await waitArmed();
  await shot('26-dark-waiting');
  await stopRun(id4);
  await click('[data-view=docs]');
  await shot('27-dark-docs');
  nativeTheme.themeSource = 'system';
  await click('[data-view=chat]');

  // 엔진 프로세스가 승인 대기 중에 끝남: 바가 내려가고 카드는 "승인 전에 끝났어요"(발급 없음), 이후 호출은 기다리지 않고 실패.
  const idExit = await toWaiting('B상사에 33만원 세금계산서');
  (S.host as unknown as { engine: { kill(): boolean } }).engine.kill();
  await until('engine exit', () => runStatus(idExit) === 'attention', 5000);
  const after = await Promise.race([S.host.rpc('engine.status').then(() => 'ok', (e: Error) => e.message), sleep(1000).then(() => 'hang')]);
  check('엔진이 승인 대기 중에 끝나면 바가 내려가고 "발급 없음"으로 끝나며, 이후 호출은 바로 실패한다', !S.bar.snapshot().visible && (S.runs.get(idExit)!.stoppedNote ?? '').includes('승인 전에 끝났어요') && after === 'engine_exit' && fx().fixture.posts() === 1, { note: S.runs.get(idExit)!.stoppedNote, after });
  await shot('28-engine-exit');
}

app.whenReady().then(async () => {
  await fs.mkdir(OUT, { recursive: true });
  try {
    // 준비 분당 상한(사람 속도 3회)은 e2e가 짧은 시간에 여러 건을 돌리므로 넉넉히 둔다(audit-d가 상한 자체를 본다).
    S = await startShell({ width: 1280, height: 820, cursorPoint: () => cursor, preparePerMin: 100 });
    // 다른 창에 가려져도 렌더러가 프레임을 계속 그리게 한다(ResizeObserver로 잡는 대화 열 폭이 가려진 동안 멈추지 않게). e2e 창에만.
    S.win.webContents.setBackgroundThrottling(false);
    observations.visibilityAtStart = await S.ready.then(() => js('document.visibilityState'));
    await flow();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await S?.close().catch(() => {});
  await fs.writeFile(path.join(OUT, 'shell-e2e.json'), JSON.stringify({ results, observations, platform: process.platform, electron: process.versions.electron }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`, JSON.stringify(observations));
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
