// 원시 Actuator의 Playwright 구현(D03 §5.2·§5.5, M2-4 D). 정책·R-A1·R-A2·그림자 검사는 이것을 감싸는 GuardedActuator가 한다.
// - 대상은 PageReader가 잡은 ElementHandle(R-A1을 통과한 바로 그 요소). 다시 찾지 않는다.
// - goto·클릭 뒤 네비게이션이 있으면 afterNavigation(집행기 settled: 안정 대기 + 걸쇠)을 부른다.
// - keyEvents 입력은 전체 선택 → 삭제 → 고정 간격 키 입력(D03 §5.5). 값은 로그·저널에 남기지 않는다.
// - 실패 코드: 시간 초과 step.timeout, 그 밖(요소가 사라짐·가려짐 등) step.selector_miss.
import type { ElementHandle, Page } from 'playwright-core';
import type { ActResult, Actuator, Resolved } from '../core/page.ts';
import type { PressStep } from '../core/types.ts';
import type { PlaywrightPageReader } from './reader.ts';

const OK: ActResult = { ok: true };
/** 키 입력 간격(ms). 고정값: 사람 흉내(무작위 지연)가 아니라 포털 이벤트 처리 여유다(탐지 회피 아님). */
export const KEY_INTERVAL_MS = 30;


export interface PlaywrightActuatorInput {
  page: Page;
  reader: PlaywrightPageReader;
  timeoutMs?: number;
  /** 네비게이션 뒤(집행기 settled). 거부면 그 코드로 실패. */
  afterNavigation?: () => Promise<ActResult>;
  /** 동작 실패 때 Playwright가 멈춘 까닭의 갈래·단계와 그때 페이지 상태(값·글 없음). 실행 저널 actuator.why로 남긴다(예행 진단). */
  onError?: (op: string, why: ActuatorWhy) => void;
  /** clickByBox 결과(값·글 없음). 실행 저널 actuator.box_click으로 남긴다. */
  onBoxClick?: (r: ActuatorWhy) => void;
}

/** clickByBox 전체 상한(ms). 스크롤·자리 확인·누름·확인까지. */
const BOX_CLICK_MS = 8_000;
/** 누른 뒤 대상이 click을 받고 화면이 바뀌기를 기다리는 시간(ms). */
const BOX_VERIFY_MS = 2_000;
/**
 * 앞 click 실패(whyOf) 가운데 박스 클릭으로 한 번 더 해 볼 것: 입력을 보내기 전 동작 가능 확인에서 멈춘 것만.
 * not_stable, 또는 timeout_other:(actionability·scroll·retrying). dispatch·after_action·navigation_wait면 입력을 이미 보냈을 수 있어(두 번 누름) 하지 않는다.
 * 가려짐(intercepted)·안 보임·비활성도 아니다.
 */
function boxEligible(why: string): boolean {
  if (why === 'not_stable') return true;
  // 구분자(@ 등)가 바뀌어도 같은 뜻으로 읽는다.
  return /^timeout_other\W(actionability|scroll|retrying)$/.test(why);
}

export class PlaywrightActuator implements Actuator {
  private readonly i: PlaywrightActuatorInput;
  private readonly timeoutMs: number;

  constructor(i: PlaywrightActuatorInput) {
    this.i = i;
    this.timeoutMs = i.timeoutMs ?? 10_000;
  }

  async goto(url: string): Promise<ActResult> {
    try {
      await this.i.page.goto(url, { waitUntil: 'load', timeout: this.timeoutMs });
    } catch (e) {
      return this.fail('goto', e);
    }
    return this.settle(true);
  }

  async click(t: Resolved): Promise<ActResult> {
    this.lastClick = null;
    const h = this.i.reader.handle(t.el);
    if (!h) return { ok: false, code: 'step.selector_miss' };
    const before = this.navCount();
    try {
      await h.click({ timeout: this.timeoutMs });
    } catch (e) {
      return this.fail('click', e, t.el);
    }
    return this.settle(this.navCount() !== before);
  }

  /**
   * 되돌릴 수 있는 click 스텝의 두 번째 시도(Actuator.clickByBox). 바로 앞 click이 같은 요소에서 입력을 보내기 전(동작 가능 확인·스크롤)
   * 시간 초과로 끝났을 때만 한다. Playwright 동작 가능 확인(rAF 안정 확인)을 거치지 않고:
   *   ① 화면 밖이면 즉시 스크롤 ② 박스가 0.15초 동안 그대로인지(rAF 없이) ③ 박스 가운데 맨 위 요소가 대상(또는 그 안)이고, 위 프레임마다 그 점이
   *   그 프레임 창인지(가린 것을 뚫고 누르지 않는다) ④ 그 점에 CDP 마우스 click ⑤ 대상이 신뢰된 click을 받았고 화면이 바뀌었는지(네비게이션·DOM 변화).
   * 하나라도 아니면 앞 실패 코드(step.timeout) 그대로다.
   */
  async clickByBox(t: Resolved): Promise<ActResult> {
    const last = this.lastClick;
    this.lastClick = null;
    const report = (r: ActuatorWhy): void => this.i.onBoxClick?.(r);
    const NO: ActResult = { ok: false, code: 'step.timeout' };
    const h = this.i.reader.handle(t.el);
    if (!h || !last || last.el !== t.el || !boxEligible(last.why)) {
      report({ ok: false, reason: 'not_eligible', why: last?.why ?? 'none' });
      return NO;
    }
    const t0 = Date.now();
    const before = this.navCount();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ActuatorWhy>((r) => (timer = setTimeout(() => r({ ok: false, reason: 'timeout' }), BOX_CLICK_MS)));
    const r = await Promise.race([this.boxClick(h as ElementHandle<Element>, before), late])
      .catch((): ActuatorWhy => ({ ok: false, reason: 'error' }))
      .finally(() => clearTimeout(timer));
    report({ ...r, ms: Date.now() - t0 });
    if (r.ok !== true) return NO;
    return this.settle(this.navCount() !== before || r.navigated === true);
  }

  private async boxClick(h: ElementHandle<Element>, before: number): Promise<ActuatorWhy> {
    await h.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight || r.left >= innerWidth) el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    });
    const b1 = await h.boundingBox();
    await new Promise((r) => setTimeout(r, 150));
    const b = await h.boundingBox();
    if (!b1 || !b || b.width < 1 || b.height < 1) return { ok: false, reason: 'no_box' };
    if (Math.abs(b1.x - b.x) > 0.5 || Math.abs(b1.y - b.y) > 0.5 || Math.abs(b1.width - b.width) > 0.5 || Math.abs(b1.height - b.height) > 0.5) return { ok: false, reason: 'moving' };
    const x = b.x + b.width / 2;
    const y = b.y + b.height / 2;
    if (!(await this.onTop(h, x, y))) return { ok: false, reason: 'covered' };
    // 대상 문서에 신뢰된 click 수신·DOM 변화 기록을 건다(페이지 전역 이름 없이, 핸들로만 읽는다).
    const probe = await h.evaluateHandle((el) => {
      const st = { landed: false, muts: 0, stop: () => {} };
      const on = (e: Event) => {
        if (e.isTrusted && e.target instanceof Node && (e.target === el || el.contains(e.target))) st.landed = true;
      };
      addEventListener('click', on, true);
      const mo = new MutationObserver((m) => (st.muts += m.length));
      mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      st.stop = () => {
        removeEventListener('click', on, true);
        mo.disconnect();
      };
      return st;
    });
    try {
      await this.i.page.mouse.click(x, y);
      const end = Date.now() + BOX_VERIFY_MS;
      for (;;) {
        const s = await probe.evaluate((st) => ({ landed: st.landed, muts: st.muts })).catch(() => null);
        // 문서가 바뀌었으면(네비게이션) 기록을 읽을 수 없다. 누른 뒤의 네비게이션이 변화다.
        if (!s || this.navCount() !== before) return { ok: true, landed: s?.landed ?? true, changed: true, navigated: true };
        if (s.landed && s.muts > 0) return { ok: true, landed: true, changed: true };
        if (Date.now() >= end) return { ok: false, reason: s.landed ? 'no_change' : 'not_landed', landed: s.landed, changed: s.muts > 0 };
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      await probe.evaluate((st) => st.stop()).catch(() => {});
      await probe.dispose().catch(() => {});
    }
  }

  /** (x, y)(본 프레임 CSS px)의 맨 위 요소가 대상 또는 그 안이고, 위 프레임마다 그 점의 맨 위가 그 프레임 창인지. */
  private async onTop(h: ElementHandle<Element>, x: number, y: number): Promise<boolean> {
    const own = await h.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const root = el.getRootNode() as Document | ShadowRoot;
      const top = root.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!top && (top === el || el.contains(top));
    });
    if (!own) return false;
    let f = await h.ownerFrame();
    while (f?.parentFrame()) {
      const fe = (await f.frameElement()) as ElementHandle<Element>;
      try {
        const fb = await fe.boundingBox();
        if (!fb) return false;
        const hit = await fe.evaluate((el, [dx, dy]) => {
          const r = el.getBoundingClientRect();
          return (el.getRootNode() as Document | ShadowRoot).elementFromPoint(r.left + dx!, r.top + dy!) === el;
        }, [x - fb.x, y - fb.y]);
        if (!hit) return false;
      } finally {
        await fe.dispose().catch(() => {});
      }
      f = f.parentFrame();
    }
    return true;
  }

  async fill(t: Resolved, value: string, o: { keyEvents: boolean }): Promise<ActResult> {
    const h = this.i.reader.handle(t.el);
    if (!h) return { ok: false, code: 'step.selector_miss' };
    try {
      if (!o.keyEvents) await h.fill(value, { timeout: this.timeoutMs });
      else {
        await h.focus();
        await h.press('ControlOrMeta+a', { timeout: this.timeoutMs });
        await h.press('Backspace', { timeout: this.timeoutMs });
        await h.type(value, { delay: KEY_INTERVAL_MS, timeout: this.timeoutMs + value.length * KEY_INTERVAL_MS });
      }
    } catch (e) {
      return this.fail('fill', e);
    }
    return OK;
  }

  async clear(t: Resolved): Promise<ActResult> {
    const h = this.i.reader.handle(t.el);
    if (!h) return { ok: false, code: 'step.selector_miss' };
    try {
      await h.fill('', { timeout: this.timeoutMs });
    } catch (e) {
      return this.fail('clear', e);
    }
    return OK;
  }

  async select(t: Resolved, option: string): Promise<ActResult> {
    const h = this.i.reader.handle(t.el);
    if (!h) return { ok: false, code: 'step.selector_miss' };
    try {
      // 라디오 묶음(role radiogroup, 홈택스 민원증명 발급유형·주민번호 공개 여부): 이름이 option인 라디오가 정확히 하나일 때 그것을 고른다.
      const group = await h.evaluate((el) => el instanceof Element && !(el instanceof HTMLSelectElement) && el.getAttribute('role') === 'radiogroup');
      if (group) {
        const ix = await h.evaluate((el, label) => {
          const name = (r: HTMLInputElement) => (r.getAttribute('aria-label') ?? (r.labels?.[0] as HTMLElement | undefined)?.innerText ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
          const hit = [...(el as Element).querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r, i) => (name(r) === label ? i : -1)).filter((i) => i >= 0);
          return hit.length === 1 ? hit[0]! : -1;
        }, option.normalize('NFKC').replace(/\s+/g, ' ').trim());
        const radio = ix < 0 ? undefined : (await h.$$('input[type="radio"]'))[ix];
        if (!radio) return { ok: false, code: 'step.selector_miss' };
        await radio.check({ timeout: this.timeoutMs });
        return OK;
      }
      // 없는 선택지는 Playwright가 생길 때까지 기다린다. 먼저 정확히 하나인지 본다(없으면 바로 selector_miss).
      const one = await h.evaluate((el, label) => el instanceof HTMLSelectElement && [...el.options].filter((o) => o.label === label).length === 1, option);
      if (!one) return { ok: false, code: 'step.selector_miss' };
      const got = await h.selectOption({ label: option }, { timeout: this.timeoutMs });
      if (got.length !== 1) return { ok: false, code: 'step.selector_miss' };
    } catch (e) {
      return this.fail('select', e);
    }
    return OK;
  }

  async press(key: PressStep['key'], t: Resolved | null): Promise<ActResult> {
    const k: string = key; // IR 키 이름은 Playwright 키 이름과 같다
    const before = this.navCount();
    try {
      if (t) {
        const h = this.i.reader.handle(t.el);
        if (!h) return { ok: false, code: 'step.selector_miss' };
        await h.press(k, { timeout: this.timeoutMs });
      } else await this.i.page.keyboard.press(k);
    } catch (e) {
      return this.fail('press', e);
    }
    return this.settle(this.navCount() !== before);
  }

  private navs = 0;
  private hooked = false;
  /** 마지막 click 실패(같은 요소일 때만 clickByBox가 쓴다). */
  private lastClick: { el: unknown; why: string } | null = null;

  private navCount(): number {
    if (!this.hooked) {
      this.hooked = true;
      const main = this.i.page.mainFrame();
      this.i.page.on('framenavigated', (f) => {
        if (f === main) this.navs++;
      });
    }
    return this.navs;
  }

  private async fail(op: string, e: unknown, el?: unknown): Promise<ActResult> {
    const why = whyOf(e);
    if (op === 'click') this.lastClick = { el, why };
    if (this.i.onError) this.i.onError(op, { why, ...retryCounts(e), ...(await pageState(this.i.page)) });
    return fail(e);
  }

  /** 네비게이션이 있었으면 load를 기다리고 settled를 부른다. 잡은 요소는 놓는다(옛 문서의 핸들). */
  private async settle(navigated: boolean): Promise<ActResult> {
    if (!navigated) {
      // 클릭 직후 시작하는 네비게이션을 놓치지 않게 잠깐 본다.
      const late = await this.i.page.waitForEvent('framenavigated', { predicate: (f) => f === this.i.page.mainFrame(), timeout: 300 }).then(() => true, () => false);
      if (!late) return OK;
    }
    await this.i.page.waitForLoadState('load', { timeout: this.timeoutMs }).catch(() => {});
    await this.i.reader.release();
    return this.i.afterNavigation ? this.i.afterNavigation() : OK;
  }
}

/** Playwright 실패 글(호출 기록 포함)에서 멈춘 까닭의 갈래만 뽑는다. 값·화면 글은 내보내지 않는다. */
export function whyOf(e: unknown): string {
  const m = String((e as { message?: unknown } | null)?.message ?? '');
  if (/not attached to the DOM|detached/i.test(m)) return 'not_attached';
  if (/intercepts pointer events/i.test(m)) return 'intercepted';
  if (/outside of the viewport/i.test(m)) return 'outside_viewport';
  if (/element is not visible|not visible/i.test(m)) return 'not_visible';
  if (/not enabled|disabled/i.test(m)) return 'not_enabled';
  if (/not stable/i.test(m)) return 'not_stable';
  if (/not editable|readonly/i.test(m)) return 'not_editable';
  if (/dialog/i.test(m)) return 'dialog';
  // 단계 구분은 ':'(engine.log 가림 규칙이 '@' 낀 값을 이메일로 보고 지운다).
  if (/Timeout/i.test(m)) return `timeout_other:${stageOf(m)}`;
  return 'other';
}

export type ActuatorWhy = Record<string, string | number | boolean>;

/** Playwright 호출 기록의 마지막 줄 → 멈춘 단계(고정 낱말, 화면 글 없음). 앱 안 보기에서 클릭이 어디서 멈추는지 가른다. why의 @ 뒤에 붙는다. */
const STAGES: ReadonlyArray<[RegExp, string]> = [
  [/waiting for scheduled navigations|navigations have finished/i, 'navigation_wait'],
  [/performing (click|fill|press|tap|dblclick) action/i, 'dispatch'],
  [/(click|fill|press) action done/i, 'after_action'],
  [/scrolling into view|done scrolling/i, 'scroll'],
  [/waiting for element to be visible|element is visible, enabled and stable|waiting for element to be stable/i, 'actionability'],
  [/retrying (click|fill) action|waiting \d+ms/i, 'retrying'],
  [/waiting for (locator|selector)|locator resolved/i, 'locate'],
];
function stageOf(m: string): string {
  const i = m.indexOf('Call log:');
  const lines = (i >= 0 ? m.slice(i) : m).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let k = lines.length - 1; k >= 0; k--) for (const [re, s] of STAGES) if (re.test(lines[k]!)) return s;
  return 'none';
}

/** 호출 기록의 다시 시도 수·스크롤 수(스크롤 반복). Playwright는 같은 줄을 "N × …"로 접는다. */
export function retryCounts(e: unknown): { retries: number; scrolls: number } {
  const m = String((e as { message?: unknown } | null)?.message ?? '');
  const at = m.indexOf('Call log:');
  let retries = 0;
  let scrolls = 0;
  if (at < 0) return { retries, scrolls };
  for (const raw of m.slice(at + 9).split('\n')) {
    const x = /^(?:(\d+) × )?(.*)$/.exec(raw.trim().replace(/^-\s*/, ''))!;
    const n = Number(x[1] ?? 1);
    const l = x[2]!.trim();
    if (/^retrying \w+ action/.test(l)) retries += n;
    if (/^scrolling into view/.test(l)) scrolls += n;
  }
  return { retries, scrolls };
}

/** 실패한 그때 페이지가 그리는지(0.5초 rAF 수)·보이는지·포커스. 비밀 창 등으로 금고가 막으면 probe만 남긴다. */
async function pageState(page: Page): Promise<ActuatorWhy> {
  const probe = page.evaluate(() => new Promise<ActuatorWhy>((done) => {
    let raf = 0;
    const t0 = performance.now();
    const end = () => done({ raf, vis: document.visibilityState, focus: document.hasFocus() });
    const tick = () => { raf++; if (performance.now() - t0 < 500) requestAnimationFrame(tick); else end(); };
    requestAnimationFrame(tick);
    setTimeout(end, 1000);
  }));
  const late = new Promise<ActuatorWhy>((r) => setTimeout(() => r({ probe: 'timeout' }), 2000));
  return Promise.race([probe, late]).catch(() => ({ probe: 'error' }));
}

function fail(e: unknown): ActResult {
  const name = (e as { name?: string } | null)?.name;
  return { ok: false, code: name === 'TimeoutError' ? 'step.timeout' : 'step.selector_miss' };
}
