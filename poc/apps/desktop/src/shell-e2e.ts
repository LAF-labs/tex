// PoC-9 셸 e2e: 발급 흐름(초안 → 실행 → 승인 대기 + 승인 바 → 결과), 승인 바 판정, 습관 클릭, 정부24 목업, 스크린샷.
// 입력은 main의 sendInputEvent라 판정 로직만 본다(실제 포인터 좌표·OS 입력은 PoC-6·Windows에서). 앱 폴더·키체인을 쓰지 않는다.
// 실행: pnpm demo:e2e  (스크린샷·결과: reports/raw/poc-9/)
import fs from 'node:fs/promises';
import path from 'node:path';
import { app, nativeImage, nativeTheme } from 'electron';
import { summarize, type SummaryLine } from './approval-gate.ts';
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
const waitArmed = () => until('bar armed', () => S.bar.snapshot().armed && S.bar.snapshot().mode === 'armed');

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
  await sleep(60);
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
  check('습관 클릭: 간격(12 DIP)·입력창 클릭은 승인이 아니다', runStatus(id) === 'waiting');
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

  // 중지: 승인 대기에서 [중지] → 바가 내려가고 발급 없음
  const id2 = await toWaiting('B상사에 55만원 세금계산서');
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
  await click('[data-candidate=f1]');
  await sleep(80);
  check('정부24 목업 2: 새 PDF 후보 → 고른 뒤에만 값 표시', (await js<number>(`document.querySelectorAll('[data-act=g24-save]').length`)) === 1);
  await shot('18-g24-pick');
  await click('[data-act=g24-save]');
  await sleep(100);
  check('정부24 목업: 문서함에 들어간다(직접 발급)', (await js<string>(`document.querySelector('.sx-thread').textContent`)).includes('주민등록표 등본'));
  await shot('19-g24-saved');

  // 다크 테마
  nativeTheme.themeSource = 'dark';
  await sleep(300);
  await shot('20-dark-thread');
  const id4 = await toWaiting('A상사에 88만원 세금계산서');
  await waitArmed();
  await shot('21-dark-waiting');
  await click(`[data-run="${id4}"] [data-act=stop]`);
  await click('[data-view=docs]');
  await shot('22-dark-docs');
  nativeTheme.themeSource = 'system';
}

app.whenReady().then(async () => {
  await fs.mkdir(OUT, { recursive: true });
  try {
    S = startShell({ speed: 0.15, width: 1280, height: 820 });
    await flow();
  } catch (e) {
    check('e2e 예외 없음', false, (e as Error).stack);
  }
  await fs.writeFile(path.join(OUT, 'shell-e2e.json'), JSON.stringify({ results, observations, platform: process.platform, electron: process.versions.electron }, null, 2));
  console.log(`${results.filter((r) => r.ok).length}/${results.length} ok`, JSON.stringify(observations));
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
