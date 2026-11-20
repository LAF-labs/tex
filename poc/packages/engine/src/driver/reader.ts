import type { ElementHandle, Frame, Locator, Page, Request } from 'playwright-core';
import { INTERACTIVE_ROLES, type ElementInfo, type ElementRef, type ElementShape, type InteractiveElement, type PageReader } from '../core/page.ts';
import type { Candidate } from '../core/types.ts';
import { ariaValue } from './aria-tree.ts';
import type { MaskedShot } from '@sax/model';

const SHOT_MASK_CSS = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';
const SHOT_MASK_TEXT = [/[0-9０-９]{2,}/, /[@＠]/];
const SHOT_QUALITY = [55, 35] as const;
const SHOT_MAX_BYTES = 900_000;

const REGION_SEL = 'input,select,textarea,button,a[href],label,[role=button],[role=textbox],[role=combobox],[role=checkbox],[role=radio],[role=link],[role=dialog]';

function SHAPE_OF(n: Element): ElementShape {
  const e = n as HTMLInputElement;
  const tag = n.tagName.toLowerCase();
  const type = n.getAttribute('type');
  const style = getComputedStyle(n) as CSSStyleDeclaration & { webkitTextSecurity?: string };
  const secret = (tag === 'input' && (type ?? '').toLowerCase() === 'password') || (!!style.webkitTextSecurity && style.webkitTextSecurity !== 'none');
  const labels = 'labels' in e && e.labels ? [...e.labels].map((l) => (l.textContent ?? '').trim()).join(' ') : '';
  const isButton = tag === 'button' || (tag === 'input' && /^(button|submit|reset)$/i.test(type ?? '')) || n.getAttribute('role') === 'button' || tag === 'a' || tag === 'label';
  const caption = isButton ? (tag === 'input' ? e.value : (n.textContent ?? '')).trim() : '';
  const rect = n.getBoundingClientRect();
  const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  const sp = (x: string) => x.replace(/\s+/g, ' ').slice(0, 80);
  return {
    tag, id: n.id || null, role: n.getAttribute('role'),
    name: secret ? '' : sp(n.getAttribute('aria-label') ?? (labels || caption)),
    label: secret ? '' : sp(labels), title: sp(n.getAttribute('title') ?? ''), type,
    readonly: !!e.readOnly || n.getAttribute('aria-readonly') === 'true', disabled: !!e.disabled || n.getAttribute('aria-disabled') === 'true', visible, secret,
  };
}

const INTERACTIVE_MAX = 150;

/** waitIdle: 요청이 없어야 하는 시간(ms). */
export const IDLE_QUIET_MS = 500;

interface Held {
  handle: ElementHandle;
  loc: Locator;
}

/** aria 스냅숏 첫 줄 → 역할·이름. `- button "발급"`, `- textbox "금액": 1000`, `- heading "x" [level=1]`. */
export function ariaHead(snapshot: string): { role: string; name: string } {
  const m = /^- ([a-z]+)(?: "((?:[^"\\]|\\.)*)")?/.exec(snapshot.split('\n')[0] ?? '');
  if (!m) return { role: '', name: '' };
  return { role: m[1]!, name: m[2] === undefined ? '' : (JSON.parse(`"${m[2]}"`) as string) };
}

export class PlaywrightPageReader implements PageReader {
  private readonly page: Page;
  private readonly held = new Map<string, Held>();
  private next = 1;
  private readonly timeoutMs: number;

  private readonly inflight = new Set<Request>();

  constructor(page: Page, o: { timeoutMs?: number } = {}) {
    this.page = page;
    this.timeoutMs = o.timeoutMs ?? 5_000;
    const done = (r: Request) => void this.inflight.delete(r);
    page.on('request', (r) => void this.inflight.add(r));
    page.on('requestfinished', done);
    page.on('requestfailed', done);
  }

  url(): string {
    return this.page.url();
  }

  async release(): Promise<void> {
    const hs = [...this.held.values()];
    this.held.clear();
    await Promise.all(hs.map((h) => h.handle.dispose().catch(() => {})));
  }

  handle(el: ElementRef): ElementHandle | null {
    return this.held.get(el.ref)?.handle ?? null;
  }

  async query(c: Candidate, frame: string, within: ElementRef | null): Promise<ElementRef[]> {
    const f = this.frame(frame);
    if (!f) return [];
    const loc = c.kind === 'role' ? f.getByRole(c.role as Parameters<Frame['getByRole']>[0], { name: c.name, exact: true }) : c.kind === 'css' ? f.locator(c.value) : f.getByLabel(c.value, { exact: true });
    const scope = within ? this.handle(within) : null;
    if (within && !scope) return [];
    const out: ElementRef[] = [];
    let n: number;
    try {
      n = await loc.count();
    } catch {
      return [];
    }
    for (let i = 0; i < n; i++) {
      const nth = loc.nth(i);
      const h = await nth.elementHandle({ timeout: this.timeoutMs }).catch(() => null);
      if (!h) continue;
      if (scope) {
        const inside = await scope.evaluate((w, e) => w !== e && w.contains(e), h).catch(() => false);
        if (!inside) {
          await h.dispose().catch(() => {});
          continue;
        }
      }
      const ref = `e${this.next++}`;
      this.held.set(ref, { handle: h, loc: nth });
      out.push({ ref });
    }
    return out;
  }

  async info(el: ElementRef): Promise<ElementInfo> {
    const h = this.held.get(el.ref);
    if (!h) return { role: '', name: '', visible: false, enabled: false, editable: false };
    const [visible, enabled, editable] = await Promise.all([h.handle.isVisible().catch(() => false), h.handle.isEnabled().catch(() => false), h.handle.isEditable().catch(() => false)]);
    const same = await h.loc.evaluate((a, b) => a === b, h.handle).catch(() => false);
    if (!same) return { role: '', name: '', visible, enabled, editable, stale: true };
    if (await h.handle.evaluate((n) => { const e = n as Element; return (e.tagName === 'DIV' || e.tagName === 'SPAN') && !e.hasAttribute('role'); }).catch(() => false)) return { role: 'generic', name: '', visible, enabled, editable };
    const snap = await h.loc.ariaSnapshot({ timeout: this.timeoutMs }).catch(() => '');
    const head = ariaHead(snap);
    if (!visible && !head.role) return { ...(await h.handle.evaluate(hiddenIdentity).catch(() => ({ role: '', name: '' }))), visible, enabled, editable };
    return { ...head, visible, enabled, editable };
  }

  async same(a: ElementRef, b: ElementRef): Promise<boolean> {
    const x = this.handle(a);
    const y = this.handle(b);
    if (!x || !y) return false;
    return x.evaluate((p, q) => p === q, y).catch(() => false);
  }

  async text(el: ElementRef): Promise<string> {
    const h = this.handle(el);
    if (!h) return '';
    return h.evaluate((n) => {
      const e = n as HTMLElement;
      const shown = e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
      return shown ? e.innerText : (e.textContent ?? '').replace(/\s+/g, ' ').trim();
    }).catch(() => '');
  }

  async value(el: ElementRef): Promise<string> {
    const h = this.handle(el);
    if (!h) return '';
    return h.evaluate((e) => {
      if (e instanceof HTMLSelectElement) return e.selectedOptions[0]?.label ?? '';
      if (!('value' in e) && e instanceof Element && (e.getAttribute('role') === 'radiogroup' || !!e.querySelector('input[type="radio"]'))) {
        const r = e.querySelector<HTMLInputElement>('input[type="radio"]:checked');
        if (!r) return '';
        return r.getAttribute('title') ?? r.getAttribute('aria-label') ?? (r.labels?.[0] as HTMLElement | undefined)?.innerText ?? '';
      }
      return 'value' in e && typeof (e as { value: unknown }).value === 'string' ? (e as { value: string }).value : '';
    }).catch(() => '');
  }

  async a11yValue(el: ElementRef): Promise<string> {
    const h = this.held.get(el.ref);
    if (!h) return '';
    const snap = await h.loc.ariaSnapshot({ timeout: this.timeoutMs }).catch(() => '');
    const plain = await h.handle.evaluate((n) => {
      const e = n as Element;
      if ((e.tagName !== 'DIV' && e.tagName !== 'SPAN') || e.hasAttribute('role')) return null;
      return e.querySelector('input[type="radio"]') ? { kind: 'radios' as const, head: e.getAttribute('title') ?? '' } : { kind: 'text' as const, head: '' };
    }).catch(() => null);
    if (plain?.kind === 'radios') {
      const v = snap ? ariaValue(snap, 'radiogroup') : '';
      return plain.head && v.startsWith(`${plain.head} `) ? v.slice(plain.head.length + 1) : v;
    }
    if (plain?.kind === 'text') return snap ? ariaValue(snap, 'text') : '';
    return ariaValue(snap, ariaHead(snap).role);
  }

  async ariaSnapshot(el: ElementRef | null): Promise<string | null> {
    if (!el) return this.page.mainFrame().locator('body').ariaSnapshot({ timeout: this.timeoutMs }).catch(() => null);
    const h = this.held.get(el.ref);
    if (!h) return null;
    const same = await h.loc.evaluate((a, b) => a === b, h.handle).catch(() => false);
    if (!same) return null;
    return h.loc.ariaSnapshot({ timeout: this.timeoutMs }).catch(() => null);
  }

  async listRole(frame: string, role: string): Promise<Array<{ el: ElementRef; name: string; id: string | null; visible: boolean; enabled: boolean }>> {
    const f = this.frame(frame);
    if (!f) return [];
    const loc = f.getByRole(role as Parameters<Frame['getByRole']>[0]);
    const n = await loc.count().catch(() => 0);
    const out: Array<{ el: ElementRef; name: string; id: string | null; visible: boolean; enabled: boolean }> = [];
    for (let i = 0; i < Math.min(n, 200); i++) {
      const nth = loc.nth(i);
      const h = await nth.elementHandle({ timeout: this.timeoutMs }).catch(() => null);
      if (!h) continue;
      const meta = await h.evaluate((e) => ({ id: (e as Element).id || null, password: (e as HTMLInputElement).type === 'password' })).catch(() => null);
      if (!meta || meta.password) {
        await h.dispose().catch(() => {});
        continue;
      }
      const ref = `e${this.next++}`;
      this.held.set(ref, { handle: h, loc: nth });
      const el = { ref };
      const info = await this.info(el);
      out.push({ el, name: info.name, id: meta.id, visible: info.visible, enabled: info.enabled });
    }
    return out;
  }

  async listInteractive(frame: string): Promise<InteractiveElement[]> {
    const out: InteractiveElement[] = [];
    for (const role of INTERACTIVE_ROLES) {
      for (const x of await this.listRole(frame, role)) {
        if (!x.visible || out.length >= INTERACTIVE_MAX) continue;
        const h = this.handle(x.el);
        const filled = role === 'textbox' || role === 'combobox' ? await h?.evaluate((e) => String((e as HTMLInputElement).value ?? '').trim().length > 0).catch(() => false) : false;
        out.push({ el: x.el, role, name: x.name, id: x.id, enabled: x.enabled, filled: filled === true });
      }
    }
    return out;
  }

  async describe(el: ElementRef): Promise<ElementShape | null> {
    const h = this.held.get(el.ref);
    if (!h) return null;
    return h.handle.evaluate(SHAPE_OF).catch(() => null);
  }

  async describeRegion(frame: string, within: ElementRef | null, max: number): Promise<ElementShape[]> {
    const f = this.frame(frame);
    const scope = within ? this.handle(within) : null;
    if (!f || (within && !scope)) return [];
    const hs = await (scope ? scope.$$(REGION_SEL) : f.$$(REGION_SEL)).catch(() => []);
    const out: ElementShape[] = [];
    for (const [i, h] of hs.entries()) {
      if (i < max) {
        const x = await h.evaluate(SHAPE_OF).catch(() => null);
        if (x) out.push(x);
      }
      await h.dispose().catch(() => {});
    }
    return out;
  }

  async maskedShot(): Promise<{ url: MaskedShot; width: number; height: number } | null> {
    const vp = this.page.viewportSize() ?? (await this.page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight })).catch(() => null));
    if (!vp) return null;
    const mask: Locator[] = [];
    for (const f of this.page.frames()) {
      mask.push(f.locator(SHOT_MASK_CSS));
      for (const re of SHOT_MASK_TEXT) mask.push(f.getByText(re));
    }
    for (const quality of SHOT_QUALITY) {
      const buf = await this.page
        .screenshot({ type: 'jpeg', quality, mask, maskColor: '#000000', animations: 'disabled', caret: 'hide', scale: 'css', timeout: this.timeoutMs * 3 })
        .catch(() => null);
      if (!buf) return null;
      const url = `data:image/jpeg;base64,${buf.toString('base64')}`;
      if (url.length <= SHOT_MAX_BYTES) return { url: url as MaskedShot, width: vp.width, height: vp.height };
    }
    return null;
  }

  async box(el: ElementRef): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const h = this.handle(el);
    return h ? h.boundingBox().catch(() => null) : null;
  }

  frameNames(): string[] {
    return this.page.frames().map((x) => x.name());
  }

  async bodyText(): Promise<string> {
    return this.page.mainFrame().locator('body').innerText({ timeout: this.timeoutMs }).catch(() => '');
  }

  async waitNavigation(timeoutMs: number): Promise<boolean> {
    const main = this.page.mainFrame();
    return this.page
      .waitForEvent('framenavigated', { predicate: (f) => f === main, timeout: timeoutMs })
      .then(() => this.page.waitForLoadState('load', { timeout: timeoutMs }))
      .then(() => true, () => false);
  }

  async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    const loaded = await this.page.waitForLoadState('load', { timeout: timeoutMs }).then(() => true, () => false);
    if (!loaded) return false;
    let quietSince = this.inflight.size ? 0 : Date.now();
    for (;;) {
      const now = Date.now();
      if (this.inflight.size) quietSince = 0;
      else if (!quietSince) quietSince = now;
      if (quietSince && now - quietSince >= IDLE_QUIET_MS) return true;
      if (now >= deadline || this.page.isClosed()) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private frame(name: string): Frame | null {
    if (name === 'main') return this.page.mainFrame();
    return this.page.frame({ name }) ?? null;
  }
}

function hiddenIdentity(n: Node): { role: string; name: string } {
  const e = n as Element;
  const tag = e.tagName;
  const type = (e.getAttribute('type') ?? '').toLowerCase();
  const explicit = e.getAttribute('role');
  const isButtonInput = tag === 'INPUT' && ['button', 'submit', 'reset'].includes(type);
  const role =
    explicit ??
    (tag === 'A' && e.hasAttribute('href')
      ? 'link'
      : tag === 'BUTTON' || isButtonInput
        ? 'button'
        : tag === 'TEXTAREA' || (tag === 'INPUT' && ['', 'text', 'email', 'tel', 'number', 'search'].includes(type))
          ? 'textbox'
          : '');
  const text = isButtonInput ? (e as HTMLInputElement).value : tag === 'INPUT' || tag === 'TEXTAREA' ? '' : (e.textContent ?? '');
  const name = (e.getAttribute('aria-label') || text || e.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  return { role, name };
}
