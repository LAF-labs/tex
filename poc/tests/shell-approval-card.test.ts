// ADR-021 결정 7: main 승인 카드 하나(값 전체·비가역 한 줄·[중지]·[승인하고 발급], 기본 포커스 [중지]).
// 음성 시험 둘: ① main이 관찰한 [승인하고 발급] 클릭 없이는 승인 근거가 없어 발급(submit)이 일어나지 않는다.
// ② 렌더러는 카드를 흉내 내거나 겹쳐 승인을 만들 수 없다. Electron을 import하는 모듈은 불러오지 않는다(판정 모듈 + 소스 확인).
// 실제 창에서의 확인(가짜 버튼·메인 창 입력·카드 키·발급 POST 0회)은 apps/desktop/e2e/shell-e2e.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { GateField } from '@sax/engine/gate';
import {
  ACTION_TEXT_DUP,
  BarGate,
  buildCardHtml,
  CARD_ROWS,
  cardHeight,
  cardTargets,
  gateText,
  inBox,
  KEYBOARD_APPROVAL,
  STOP_KEYS,
  summarize,
  type SummaryLine,
} from '../apps/desktop/src/approval-gate.ts';
import { SHELL_METHODS, USER_ACTION_METHODS } from '../apps/desktop/src/ipc.ts';
import { barBounds, browserPanelWidth, SHELL } from '../apps/desktop/src/shell-layout.ts';

const root = path.join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
const count = (s: string, sub: string) => s.split(sub).length - 1;
const between = (s: string, start: string, end: string) => {
  const i = s.indexOf(start);
  const j = s.indexOf(end, i + start.length);
  assert.ok(i >= 0 && j > i, `${start} … ${end}`);
  return s.slice(i, j);
};

const W = 600;
const H = cardHeight(CARD_ROWS['H-01']);
const T = cardTargets(W, H);
const mid = (r: { x: number; y: number; width: number; height: number }) => ({ x: Math.floor(r.x + r.width / 2), y: Math.floor(r.y + r.height / 2) });

/** 막 뜬 카드 판정기(기다림·머무름 없음, ADR-021 개정 2026-11-09). 이 상태에서 down→up 하나면 승인된다. */
function armedGate(): BarGate {
  const g = new BarGate();
  g.setTargets(T);
  g.reset();
  return g;
}

describe('음성 ①: main이 관찰한 [승인하고 발급] 클릭 없이는 승인 근거도 발급도 없다', () => {
  it('키는 무엇이든 승인이 아니다(카드에서 Enter·Space·Esc는 [중지]). 키보드 승인 경로는 꺼져 있다', () => {
    const g = armedGate();
    assert.equal(KEYBOARD_APPROVAL, false);
    const keys = ['Enter', ' ', 'Escape', 'Tab', 'y', 'Y', 'ㅛ', 'a', 'ArrowRight', 'Return'];
    for (const key of keys) for (const mods of [{}, { alt: true }, { control: true }, { meta: true }]) assert.equal(g.key({ type: 'keyDown', key, ...mods }), null, `${key} ${JSON.stringify(mods)}`);
    assert.deepEqual([...STOP_KEYS], ['Enter', ' ', 'Escape']);
  });

  it('[승인하고 발급] 영역 밖(값 줄·비가역 줄·[중지]·두 버튼 사이·카드 밖) down→up은 무장됨이어도 승인이 아니다', () => {
    const gapX = T.stop.x + T.stop.width + Math.floor((T.approve.x - T.stop.x - T.stop.width) / 2);
    const points = [
      { x: 40, y: 20 }, // 합계 줄
      { x: 300, y: 100 }, // 품목 줄
      { x: 300, y: T.approve.y - 30 }, // 비가역 한 줄
      mid(T.stop),
      { x: gapX, y: mid(T.approve).y },
      { x: T.approve.x - 1, y: mid(T.approve).y },
      { x: T.approve.x + T.approve.width, y: mid(T.approve).y }, // 오른쪽 경계는 밖
      { x: mid(T.approve).x, y: T.approve.y + T.approve.height },
      { x: -1, y: 10 },
      { x: W + 5, y: H - 10 },
    ];
    for (const p of points) {
      const g = armedGate();
      g.mouse({ type: 'mouseDown', ...p, button: 'left' });
      assert.equal(g.mouse({ type: 'mouseUp', ...p, button: 'left' }), null, JSON.stringify(p));
    }
    // 안에서 누르고 밖에서 떼거나, 밖에서 누르고 안에서 떼면 승인이 아니다.
    const g = armedGate();
    g.mouse({ type: 'mouseDown', ...mid(T.stop), button: 'left' });
    assert.equal(g.mouse({ type: 'mouseUp', ...mid(T.approve), button: 'left' }), null);
    assert.equal(g.mouse({ type: 'mouseDown', ...mid(T.approve), button: 'left' }), null, '눌림');
    assert.equal(g.mouse({ type: 'mouseUp', ...mid(T.stop), button: 'left' }), null);
    // 대조: 같은 판정기에서 영역 안 down→up은 승인이다(위 거부가 판정기 고장이 아님).
    g.mouse({ type: 'mouseDown', ...mid(T.approve), button: 'left' });
    assert.deepEqual(g.mouse({ type: 'mouseUp', ...mid(T.approve), button: 'left' }), { kind: 'approve' });
  });

  it('[중지]는 승인 근거를 만들지 않는다: 카드는 closed(stopped)로 끝나고 shell-app은 실행 중지로만 잇는다', () => {
    const bar = read('apps/desktop/src/approval-bar.ts');
    const stop = between(bar, '  private stopByUser(', '  private approve(): void {');
    assert.ok(stop.includes("this.finish({ decision: 'closed', reason: req.kind === 'gate' ? 'stopped' : 'dismissed' })") && !stop.includes('issueLocal'));
    const app = read('apps/desktop/src/shell-app.ts');
    const onGate = between(app, "runs.on('gate',", 'const showAttest =');
    const stopped = between(onGate, "o.reason === 'stopped'", "o.reason === 'load_failed'");
    assert.ok(stopped.includes('runs.stop(runId)') && !stopped.includes('answerGate'));
    assert.ok(onGate.indexOf("if (o.decision === 'approve')") < onGate.indexOf('host.answerGate(o.approval)'), '게이트 답은 승인 결과일 때만');
  });

  it('승인 근거(LocalApproval)는 카드가 관찰한 승인 판정에서만 발급된다', () => {
    const bar = read('apps/desktop/src/approval-bar.ts');
    assert.equal(count(bar, 'issueLocalApproval('), 1);
    assert.ok(between(bar, '  private approve(): void {', '  /** 창 크기와').includes('issueLocalApproval(this.key, req.gate'));
    // approve()를 부르는 곳은 둘: 마우스 판정 결과 approve, 그리고 꺼진 키보드 경로(KEYBOARD_APPROVAL=false라 gate.key가 늘 null).
    assert.equal(count(bar, 'this.approve()'), 2);
    assert.ok(between(bar, '  private onMouse(', '  private paintBackground(').includes("if (r.kind === 'approve') return this.approve();"));
    assert.match(bar, /this\.gate\.key\(\{[^}]*\}\)\?\.kind === 'approve'\) this\.approve\(\);/);
    // 무장 거부 중에는 [중지]만 받고 승인 판정에 넣지 않는다.
    const onMouse = between(bar, '  private onMouse(', '  private paintBackground(');
    assert.ok(onMouse.indexOf('if (this.gate.stop(ev)) return this.stopByUser') < onMouse.indexOf('if (this.refusal) return this.gate.track(ev)'));
    assert.ok(onMouse.indexOf('if (this.refusal) return this.gate.track(ev)') > 0 && onMouse.indexOf('if (this.refusal) return this.gate.track(ev)') < onMouse.indexOf('this.gate.mouse(ev)'));
  });
});

describe('음성 ②: 렌더러는 승인 카드를 흉내 내거나 겹쳐 승인을 만들 수 없다', () => {
  it('렌더러 IPC 표에는 승인·게이트·카드 명령이 없다', () => {
    const names = [...Object.keys(SHELL_METHODS), ...Object.keys(USER_ACTION_METHODS)];
    for (const m of names) assert.doesNotMatch(m, /approv|gate|^bar\.|card\.|answer|attest\.(?!open|close)/i, m);
  });

  it('렌더러로 가는 카드 이벤트는 띠 여부·높이·사유뿐(값·판정 영역·좌표·근거 없음)', () => {
    const ipc = read('apps/desktop/src/ipc.ts');
    const ev = between(ipc, 'export type ShellEvent =', "| { type: 'run'");
    assert.deepEqual([...ev.matchAll(/\{ ([^}]*) \}/g)].map((m) => m[1]), ["type: 'bar'; active: true; band: boolean; height: number", "type: 'bar'; active: false; reason: string", "type: 'bar-layout'; band: boolean; height: number"]);
    const app = read('apps/desktop/src/shell-app.ts');
    for (const line of app.split('\n').filter((l) => l.includes("send({ type: 'bar"))) assert.doesNotMatch(line, /targets|lines|fields|approval|snapshot|bounds/, line);
  });

  it('카드 높이·위치·판정 영역은 main 상수와 창 크기만으로 정한다(렌더러가 보고한 값을 받지 않는다)', () => {
    const bar = read('apps/desktop/src/approval-bar.ts');
    for (const m of bar.matchAll(/this\.height = ([^;]+);/g)) assert.match(m[1]!, /^cardHeight\(/, m[0]);
    for (const m of bar.matchAll(/this\.targets = ([^;]+);/g)) assert.match(m[1]!, /^cardTargets\(/, m[0]);
    assert.ok(!/ipcMain|webContents\.on\('ipc-message/.test(bar), '카드 쪽에 렌더러 메시지 수신이 없다');
    const layout = read('apps/desktop/src/shell-layout.ts');
    assert.match(layout, /export function barBounds\(contentWidth: number, contentHeight: number, wide = false, height: number = SHELL\.barHeight, panel: number = SHELL\.panel\)/);
    // 앱 안 브라우저 패널 폭(panel)은 승인 대기 중 창 폭과 상수만으로 정한다: 렌더러가 고른 폭(끌기)·크게는 카드 자리에 닿지 않는다
    for (const w of [900, 1280, 1440, 1920]) {
      const fixed = browserPanelWidth(w, null, false, true);
      assert.equal(browserPanelWidth(w, 5000, true, true), fixed, `${w}`);
      assert.equal(browserPanelWidth(w, 10, false, true), fixed, `${w}`);
      assert.equal(barBounds(w, 900, false, SHELL.barHeight, fixed).band, w - SHELL.rail - fixed < SHELL.chatMax + SHELL.gutter * 2 && w - SHELL.rail - fixed - SHELL.gutter * 2 < SHELL.barMinWidth, `${w}`);
    }
    assert.match(read('apps/desktop/src/shell-app.ts'), /new ApprovalBar\(win, key, \(w, h, wide, height\) => barBounds\(w, h, wide, height, panelNow\(\)\)/);
    assert.match(read('apps/desktop/src/shell-app.ts'), /browserPanelWidth\(win\.getContentSize\(\)\[0\]!, browserWant, browserShown, bar\.active\)/);
  });

  it('카드는 뜰 때 메인 창 contentView의 맨 위 자식이 된 뒤에 보인다(렌더러가 그 위에 그릴 수 없다). 스크립트 없는 정적 페이지', () => {
    const bar = read('apps/desktop/src/approval-bar.ts');
    const show = between(bar, '  private async show(', '  private committedFor(');
    assert.ok(show.indexOf('this.win.contentView.addChildView(this.view)') >= 0 && show.indexOf('this.win.contentView.addChildView(this.view)') < show.indexOf('this.view.setVisible(true)'));
    assert.match(bar, /javascript: false, devTools: false/);
    const lines = summarize({ fields: Object.entries({ counterpartName: '<img src=x onerror=alert(1)>', counterpartBizNo: '2148651233', totalAmount: '110', supplyAmount: '100', taxAmount: '10', itemName: '"><script>x()</script>', issueDate: '2026-11-06' }).map(([fieldKey, value]) => ({ fieldKey, value })) as GateField[] }, '2026-11-06') as SummaryLine[];
    const html = buildCardHtml(lines, 'armed', undefined, gateText(ACTION_TEXT_DUP, '<img src=x onerror=alert(1)>'));
    assert.ok(!/<script|<img|<[^>]*\son\w+=|style=|<button|<a |<input|<form/i.test(html), html);
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;') && html.includes('&quot;&gt;&lt;script&gt;x()&lt;/script&gt;'), '값은 이스케이프한 글자로만');
    assert.match(html, /default-src 'none'; style-src 'self'/);
  });

  it('렌더러의 대화 카드는 승인 대기 중 "작성 완료" 한 줄(서류·거래처·합계): 되읽은 값 전체·승인 버튼을 그리지 않는다', () => {
    const views = read('apps/desktop/static/shell/shell-views.js');
    // 주석은 빼고 본다(화면에 나가는 코드만).
    const waiting = between(views, "} else if (st === 'waiting') {", "} else if (st === 'done') {").replace(/^\s*\/\/.*$/gm, '');
    assert.ok(waiting.includes('card.replaceChildren()') && waiting.includes('작성 완료') && waiting.includes('`세금계산서 · ${run.counterparty.name} · ${won(run.total)}`'));
    for (const bad of ['run.supply', 'run.tax', 'run.counterparty.bizNo', 'run.email', 'run.item', 'run.writeDate', 'run.warnings', 'amount(', 'kv(', '승인하고 발급', '승인 카드', '승인 바', 'act.approve']) assert.ok(!waiting.includes(bad), bad);
    // 렌더러는 main이 알린 높이만큼 자리를 비울 뿐이고, 범위 밖 값은 기본 높이로 둔다.
    const js = read('apps/desktop/static/shell/shell.js');
    const set = between(js, 'function setBarHeight(px) {', '\n}');
    assert.ok(set.includes('Number.isInteger(px) && px > 0 && px <= 600') && set.includes("'--l-bar-h'"));
  });

  it('카드 판정 영역은 카드 폭·높이만의 함수다(렌더러가 무엇을 그려도 그대로)', () => {
    for (const w of [520, 600, 1220]) {
      const t = cardTargets(w, H);
      assert.ok(inBox(t.approve, w - 21, H - 17) && !inBox(t.approve, w - 20, H - 17), `${w}: 오른쪽 여백 20 안쪽이 끝`);
      assert.equal(t.approve.y, H - 16 - 44);
      assert.deepEqual(cardTargets(w, H), t);
    }
  });
});
