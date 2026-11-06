// M2 엔진 시험용 가짜 페이지 포트(PageReader·Actuator·Clock). 결정적이고 실제 포털에 닿지 않는다.
import type { ActResult, Actuator, Candidate, Clock, ElementInfo, ElementRef, PageReader, Resolved } from '@sax/engine/core';

// ---- 가짜 DOM ----

export interface FEl {
  id: string;
  role: string;
  name: string;
  parent?: string;
  frame?: string;
  css?: string[];
  label?: string;
  text?: string;
  value?: string;
  a11y?: string;
  visible?: boolean;
  enabled?: boolean;
  /** 이 시각(가짜 시계) 뒤에야 나타난다. */
  appearAt?: number;
}

export class FakeClock implements Clock {
  t = 0;
  sleeps: number[] = [];
  now() {
    return this.t;
  }
  async sleep(ms: number) {
    this.sleeps.push(ms);
    this.t += ms;
  }
}

export class FakePage implements PageReader {
  els = new Map<string, FEl>();
  body = '';
  nav = true;
  idle = true;
  queries = 0;
  private clock: FakeClock;
  constructor(clock: FakeClock, els: FEl[]) {
    this.clock = clock;
    for (const e of els) this.els.set(e.id, e);
  }
  url() {
    return 'https://hometax.go.kr/';
  }
  private under(e: FEl, root: string): boolean {
    for (let p = e.parent; p; p = this.els.get(p)?.parent) if (p === root) return true;
    return false;
  }
  async query(c: Candidate, frame: string, within: ElementRef | null): Promise<ElementRef[]> {
    this.queries++;
    return [...this.els.values()]
      .filter((e) => (e.appearAt ?? 0) <= this.clock.t && (e.frame ?? 'main') === frame && (!within || this.under(e, within.ref)))
      .filter((e) => (c.kind === 'role' ? e.role === c.role && e.name === c.name : c.kind === 'css' ? (e.css ?? []).includes(c.value) : e.label === c.value))
      .map((e) => ({ ref: e.id }));
  }
  private el(r: ElementRef) {
    const e = this.els.get(r.ref);
    if (!e) throw new Error('detached');
    return e;
  }
  async info(r: ElementRef): Promise<ElementInfo> {
    const e = this.el(r);
    return { role: e.role, name: e.name, visible: e.visible ?? true, enabled: e.enabled ?? true };
  }
  async same(a: ElementRef, b: ElementRef) {
    return a.ref === b.ref;
  }
  async text(r: ElementRef) {
    return this.el(r).text ?? '';
  }
  async value(r: ElementRef) {
    return this.el(r).value ?? '';
  }
  async a11yValue(r: ElementRef) {
    return this.el(r).a11y ?? '';
  }
  async bodyText() {
    return this.body;
  }
  async waitNavigation() {
    return this.nav;
  }
  async waitIdle() {
    return this.idle;
  }
}

export class FakeAct implements Actuator {
  log: string[] = [];
  /** 포털이 입력 값을 바꿔 보여 주는 흉내(예: 금액 쉼표). */
  reformat: (v: string) => string = (v) => v;
  failWith: string | null = null;
  private page: FakePage;
  constructor(page: FakePage) {
    this.page = page;
  }
  private r(s: string): ActResult {
    this.log.push(s);
    return this.failWith ? { ok: false, code: this.failWith } : { ok: true };
  }
  async goto(url: string) {
    return this.r(`goto ${new URL(url).hostname}`);
  }
  async click(t: Resolved) {
    return this.r(`click ${t.key}`);
  }
  async fill(t: Resolved, value: string, o: { keyEvents: boolean }) {
    const e = this.page.els.get(t.el.ref)!;
    e.value = this.reformat(value);
    return this.r(`fill ${t.key}${o.keyEvents ? ' keys' : ''}`);
  }
  async clear(t: Resolved) {
    this.page.els.get(t.el.ref)!.value = '';
    return this.r(`clear ${t.key}`);
  }
  async select(t: Resolved, option: string) {
    this.page.els.get(t.el.ref)!.value = option;
    return this.r(`select ${t.key}`);
  }
  async press(key: string, t: Resolved | null) {
    return this.r(`press ${key}${t ? ` ${t.key}` : ''}`);
  }
}
