// PoC-9 셸 e2e: 발급 흐름(초안 → 실행 → 승인 대기 + 승인 바 → 결과), 승인 바 판정, 습관 클릭, 정부24 목업, 스크린샷.
// 입력은 main의 sendInputEvent라 판정 로직만 본다(실제 포인터 좌표·OS 입력은 PoC-6·Windows에서). 앱 폴더·키체인을 쓰지 않는다.
// 실행: pnpm demo:e2e  (스크린샷·결과: reports/raw/poc-9/)
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, clipboard, nativeImage, nativeTheme } from 'electron';
import { gateHash, summarize, type GateRequest, type SummaryLine } from './approval-gate.ts';
import { barBounds, SHELL } from './shell-layout.ts';
import { registerShellSchemes, startShell, type Shell } from './shell-app.ts';

registerShellSchemes();
app.setPath('userData', path.join(app.getPath('temp'), `sax-shell-e2e-${process.pid}`));
app.on('window-all-closed', () => {});

const OUT = path.resolve(import.meta.dirname, '../../../reports/raw/poc-9');
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
/** 무장됨 = 판정상 무장 + 무장됨 페이지가 실제로 화면에 올라옴. */
const waitArmed = () => until('bar armed', () => S.bar.snapshot().armed && S.bar.snapshot().committed?.mode === 'armed');
/** OS 커서 위치(바의 "멈춘 커서 아래" 판단용). e2e 기본은 바 밖. */
const cursor = { x: -9999, y: -9999 };


async function toWaiting(text: string): Promise<string> {
  await sendText(text);
  await until('draft', async () => !!(await lastRunId()));
  const id = (await lastRunId())!;
  await click(`[data-run="${id}"] [data-act=prepare]`);
  await until('waiting', () => runStatus(id) === 'waiting');
  await until('bar visible', () => S.bar.snapshot().visible);
  return id;
}

async function flow(): Promise<void> {
  nativeTheme.themeSource = 'light';
  await S.ready;
  await until('renderer ready', async () => (await js('document.body.dataset.ready')) === '1');
  check('셸이 뜨고 승인 바는 숨어 있다', !S.bar.snapshot().visible && !S.bar.view.getVisible());
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

  // T-04·T-05 실행 → 내 차례
  await click(`[data-run="${id}"] [data-act=prepare]`);
  check('실행 중 바는 뜨지 않는다', (await until('turn', () => runStatus(id) === 'turn')) && !S.bar.snapshot().visible);
  await shot('04-turn-simple-auth');
  await until('preparing again', () => runStatus(id) === 'preparing');
  await sleep(150);
  await shot('05-running');

  // T-03 승인 대기 + 승인 바
  await until('waiting', () => runStatus(id) === 'waiting');
  await until('bar visible', () => S.bar.snapshot().visible);
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

  // 키보드·렌더러 경로로는 승인되지 않는다
  for (const keyCode of ['Enter', 'Space', 'Return']) {
    barWc().sendInputEvent({ type: 'keyDown', keyCode });
    barWc().sendInputEvent({ type: 'keyUp', keyCode });
  }
  S.win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  S.win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  await sleep(100);
  check('Enter·Space(바·입력창 모두)로는 승인되지 않는다', runStatus(id) === 'waiting' && S.bar.snapshot().visible);
  const forged = await js<string[]>(`Promise.all(['bar.hide', 'run.approve', 'gate.answer', 'approval.demo'].map((m) => window.sax.call(m, { id: ${JSON.stringify(id)} }).then(() => 'accepted', (e) => String(e.message).includes('unknown_method') ? 'unknown' : e.message)))`);
  check('렌더러에는 승인·바 숨김 명령이 없다', forged.every((x) => x === 'unknown') && runStatus(id) === 'waiting' && S.bar.snapshot().visible, forged);
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
  check('렌더러 메서드 전부를 불러도 승인되지 않는다(바 그대로, 문서 목록 그대로)', runStatus(id) === 'waiting' && S.bar.snapshot().visible && S.bar.runId === id && S.store.docs.length === docsBefore && sweep['g24.save'] === 'bad_candidate', sweep);
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
  // 패널을 접어도 승인 대기 중에는 패널 폭을 비워 둬 대화 열과 바가 어긋나지 않는다(규칙 없이는 170 DIP 어긋났다).
  await js(`document.querySelector('#panel .panel-x')?.click()`);
  await sleep(150);
  const shifted = await js<number>(`document.querySelector('.composer-zone .col').getBoundingClientRect().left`);
  observations.panelClosedOffset = Math.round(shifted - S.bar.snapshot().bounds.x);
  check('승인 대기 중 패널을 접어도 대화 열과 바가 맞는다', Math.abs(shifted - S.bar.snapshot().bounds.x) <= 1, observations.panelClosedOffset);
  await waitArmed();
  await shot('11-panel-closed-offset');
  await click(`[data-run="${id}"]`);
  await sleep(100);

  // 정상 승인: 바 안에서 움직이고 150ms 뒤 클릭
  await waitArmed();
  barLeave();
  barEnterMove();
  await sleep(200);
  barClick();
  await until('approved', () => runStatus(id) !== 'waiting', 2000);
  check('바 안에서 머문 뒤 클릭 = 승인 → 바가 내려가고 자리가 돌아온다', runStatus(id) === 'turn' && !S.bar.snapshot().visible && (await until('slot', async () => (await js<number>(`document.querySelector('.bar-slot').offsetHeight`)) === 0)));
  await shot('12-signing-turn');
  await until('done', () => runStatus(id) === 'done');
  const r = S.runs.get(id)!;
  const doneText = await js<string>(`document.querySelector('[data-run="${id}"]').textContent`);
  check('결과 카드: 승인번호·메일 전송 확인', doneText.includes(r.result!.approvalNo) && doneText.includes('메일로 보낸 것도 확인했어요'), doneText.slice(0, 160));
  await shot('13-result');
  await click('[data-view=docs]');
  await sleep(100);
  check('문서함에 발급 결과가 들어온다', (await js<string>(`document.querySelector('[data-view=docs] tbody').textContent`)).includes('세금계산서 · A상사'));
  await click(`[data-doc-row="d-${id}"]`);
  await shot('14-docs');
  await click('[data-view=cps]');
  await shot('15-counterparties');
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

  // 중지: 승인 대기에서 [중지] → 바가 내려가고 발급 없음. 그동안 다른 건은 준비할 수 없다(실행은 한 번에 하나).
  const id2 = await toWaiting('B상사에 55만원 세금계산서');
  // 두 번째 게이트: 앞 게이트를 바 안에서 눌러 승인했고 그 뒤 mouseLeave를 보내지 않았다. OS 커서는 바 밖(입력창)이다.
  await waitArmed();
  barWc().sendInputEvent({ type: 'mouseMove', x: mid().x, y: mid().y, movementX: 0, movementY: -6 });
  await sleep(20);
  barClick();
  await sleep(60);
  check('두 번째 게이트: 입력창에서 바로 올라온 클릭은 머무름으로 거부(앞 게이트 추적 상태를 안 믿음)', runStatus(id2) === 'waiting' && S.bar.snapshot().msg === '마우스를 조금 움직인 뒤 눌러 주세요', S.bar.snapshot());
  await sendText('C테크에 10만원 세금계산서');
  await until('second draft', async () => (await lastRunId()) !== id2);
  const idBusy = (await lastRunId())!;
  await click(`[data-run="${idBusy}"] [data-act=prepare]`);
  await sleep(150);
  check('승인 대기 중에는 다른 건을 준비할 수 없고 바는 그대로다', runStatus(idBusy) === 'draft' && S.bar.runId === id2 && runStatus(id2) === 'waiting');
  await click(`[data-run="${idBusy}"] [data-act=cancel]`);
  await click(`[data-run="${id2}"] [data-act=stop]`);
  await until('stopped', () => runStatus(id2) === 'stopped');
  check('승인 대기에서 [중지] → 바가 내려가고 발급하지 않는다', !S.bar.snapshot().visible && !S.runs.get(id2)!.result);

  // 처음 거래·처음 보내는 주소(C테크)
  const id3 = await toWaiting('C테크에 120만원 세금계산서 메일로');
  const lines = summarize(S.runs.gateRequest(S.runs.get(id3)!)) as SummaryLine[];
  check('처음 거래·처음 보내는 주소 표시는 main 쪽 값에서 나온다', lines[0]?.flag === '처음 거래' && lines[2]?.flag === '처음 보내는 주소');
  await waitArmed();
  await shot('16-first-trade');
  await click(`[data-run="${id3}"] [data-act=stop]`);
  await until('stopped3', () => !S.bar.snapshot().visible);

  // 정부24 목업 2장
  await sendText('주민등록등본 떼 줘');
  await until('g24', async () => (await js<number>(`document.querySelectorAll('[data-g24-panel=guide]').length`)) === 1);
  check('정부24 목업 1: 직접 발급 안내(단계·복사 값)', (await js<string>(`document.querySelector('[data-g24-panel=guide]').textContent`)).includes('출력·저장했어요'));
  await shot('17-g24-guide');
  await click('[data-act=g24-saved]');
  await until('pick', async () => (await js<number>(`document.querySelectorAll('[data-candidate]').length`)) === 2);
  const g24Times = await js<{ start: string; at: string[] }>(`({ start: document.querySelector('[data-g24-panel=pick] .sx-app-line').textContent.match(/\\d\\d:\\d\\d/)[0], at: [...document.querySelectorAll('[data-candidate] .sx-meta')].map((e) => e.textContent.match(/\\d\\d:\\d\\d/)[0]) })`);
  check('정부24 후보 파일은 작업 시작 뒤에 생긴 것만', g24Times.at.every((t) => t >= g24Times.start), g24Times);
  await click('[data-candidate=f1]');
  await sleep(80);
  check('정부24 목업 2: 새 PDF 후보 → 고른 뒤에만 값 표시', (await js<number>(`document.querySelectorAll('[data-act=g24-save]').length`)) === 1);
  await shot('18-g24-pick');
  await click('[data-act=g24-save]');
  await sleep(100);
  check('정부24 목업: 문서함에 들어간다(직접 발급)', (await js<string>(`document.querySelector('.sx-thread').textContent`)).includes('주민등록표 등본'));
  await shot('19-g24-saved');

  // 값이 대화 열 폭에 안 들어가면(긴 국제화 도메인 + 처음 보내는 주소 + 10억대) 띠로 넓혀 무장한다.
  const base = {
    runId: 'e2e-wide', gateStepId: 'issue', reqId: 'wide-1', docType: 'H-01' as const,
    fields: [
      { fieldKey: 'counterpartName', value: '긴이름주식회사' }, { fieldKey: 'counterpartBizNo', value: '1298134566' },
      { fieldKey: 'counterpartEmail', value: 'tax@회사이름이긴곳.한국' }, { fieldKey: 'totalAmount', value: '1100000000' },
      { fieldKey: 'taxAmount', value: '100000000' }, { fieldKey: '$first.email', value: 'true' },
    ],
  };
  const gate = (reqId: string): GateRequest => ({ ...base, reqId, actionHash: gateHash({ ...base, reqId }) });
  const wide = gate('wide-1');
  const wideDone = S.bar.open(wide);
  await waitArmed();
  check('값이 넘치면 바를 띠로 넓혀 무장한다(무장 거부로 막히지 않음)', S.bar.snapshot().band && !S.bar.snapshot().refusal && S.bar.snapshot().bounds.x === SHELL.rail, S.bar.snapshot());
  check('열린 게이트가 있으면 새 게이트로 바꾸지 않는다', (await S.bar.open(gate('wide-2'))).decision === 'closed' && S.bar.snapshot().reqId === 'wide-1');
  await shot('20-wide-band');
  S.bar.close('e2e');
  await wideDone;

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
  const still2 = S.bar.open(gate('wide-4'));
  await waitArmed();
  barClick();
  check('멈춘 커서 아래 뜬 바는 움직이지 않고 눌러도 승인된다', (await Promise.race([still2, sleep(1000).then(() => null)]))?.decision === 'approve');
  Object.assign(cursor, { x: -9999, y: -9999 });

  // 다크 테마
  nativeTheme.themeSource = 'dark';
  await sleep(300);
  await shot('21-dark-thread');
  const id4 = await toWaiting('A상사에 88만원 세금계산서');
  await waitArmed();
  await shot('22-dark-waiting');
  await click(`[data-run="${id4}"] [data-act=stop]`);
  await click('[data-view=docs]');
  await shot('23-dark-docs');
  nativeTheme.themeSource = 'system';
}

app.whenReady().then(async () => {
  await fs.mkdir(OUT, { recursive: true });
  try {
    S = startShell({ speed: 0.15, width: 1280, height: 820, cursorPoint: () => cursor });
    await flow();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await fs.writeFile(path.join(OUT, 'shell-e2e.json'), JSON.stringify({ results, observations, platform: process.platform, electron: process.versions.electron }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`, JSON.stringify(observations));
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
