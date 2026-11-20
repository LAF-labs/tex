import type { ElementHandle, Page } from 'playwright-core';
import type { ActResult, Actuator, Resolved } from '../core/page.ts';
import type { PressStep } from '../core/types.ts';
import type { PlaywrightPageReader } from './reader.ts';

const OK: ActResult = { ok: true };
/** select 상수: 자리표시를 뺀 선택지가 하나뿐이면 그것을 고른다(타깃 allowedConstants에 있어야 한다, V-21). */
export const SELECT_ONLY = '*only';
/** 키 입력 간격(ms). 고정값: 사람 흉내(무작위 지연)가 아니라 포털 이벤트 처리 여유다(탐지 회피 아님). */
export const KEY_INTERVAL_MS = 30;


export interface PlaywrightActuatorInput {
  page: Page;
  reader: PlaywrightPageReader;
  timeoutMs?: number;
  afterNavigation?: () => Promise<ActResult>;
  onError?: (op: string, why: ActuatorWhy) => void;
  onBoxClick?: (r: ActuatorWhy) => void;
}

const BOX_CLICK_MS = 8_000;
const BOX_VERIFY_MS = 2_000;
function boxEligible(why: string): boolean {
  if (why === 'not_stable') return true;
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
      const group = await h.evaluate((el) => el instanceof Element && !(el instanceof HTMLSelectElement) && (el.getAttribute('role') === 'radiogroup' || !!el.querySelector('input[type="radio"]')));
      if (group) {
        const ix = await h.evaluate((el, label) => {
          const name = (r: HTMLInputElement) => (r.getAttribute('title') ?? r.getAttribute('aria-label') ?? (r.labels?.[0] as HTMLElement | undefined)?.innerText ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
          const hit = [...(el as Element).querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((r, i) => (name(r) === label ? i : -1)).filter((i) => i >= 0);
          return hit.length === 1 ? hit[0]! : -1;
        }, option.normalize('NFKC').replace(/\s+/g, ' ').trim());
        const radio = ix < 0 ? undefined : (await h.$$('input[type="radio"]'))[ix];
        if (!radio) return { ok: false, code: 'step.selector_miss' };
        await radio.check({ timeout: this.timeoutMs });
        return OK;
      }
      if (option === SELECT_ONLY) {
        const ix = await h.evaluate((el) => {
          if (!(el instanceof HTMLSelectElement)) return -1;
          const real = [...el.options].map((o, i) => ({ o, i })).filter(({ o }) => o.value !== '' && !/^\s*-?\s*선택\s*-?\s*$/.test(o.label));
          return real.length === 1 ? real[0]!.i : -1;
        });
        if (ix < 0) return { ok: false, code: 'step.selector_miss' };
        const got = await h.selectOption({ index: ix }, { timeout: this.timeoutMs });
        return got.length === 1 ? OK : { ok: false, code: 'step.selector_miss' };
      }
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
    const k: string = key;
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

  private async settle(navigated: boolean): Promise<ActResult> {
    if (!navigated) {
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
  if (/Timeout/i.test(m)) return `timeout_other:${stageOf(m)}`;
  return 'other';
}

export type ActuatorWhy = Record<string, string | number | boolean>;

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
