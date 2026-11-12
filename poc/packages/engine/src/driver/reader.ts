// PageReader의 Playwright 구현(D03 §5.1, M2-4 D). 읽기 전용: 페이지를 바꾸지 않는다.
// - ElementRef는 ElementHandle(고정 DOM 요소)과 그것을 찾은 locator.nth(i)를 같이 든다. 역할·이름은 그 locator의
//   aria 스냅숏 첫 줄에서 읽고, 그 사이 DOM이 바뀌어 locator가 다른 요소를 가리키면 빈 역할을 돌려 R-A1이 거부하게 한다.
// - frame은 'main'이면 주 프레임, 아니면 그 이름의 프레임(없으면 빈 결과).
// - 후보: role → getByRole(name 정확히), css → locator, label → getByLabel(정확히). within이 있으면 그 요소의 하위만.
import type { ElementHandle, Frame, Locator, Page, Request } from 'playwright-core';
import type { ElementInfo, ElementRef, PageReader } from '../core/page.ts';
import type { Candidate } from '../core/types.ts';
import { ariaValue } from './aria-tree.ts';

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

  /** 이 탭에서 아직 끝나지 않은 요청(waitIdle). XHR도 센다: WebSquare 조회 표는 로드 뒤 XHR 응답으로 그려진다. */
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

  /** 잡고 있는 요소를 놓는다(스텝 사이·네비게이션 뒤). */
  async release(): Promise<void> {
    const hs = [...this.held.values()];
    this.held.clear();
    await Promise.all(hs.map((h) => h.handle.dispose().catch(() => {})));
  }

  /** 내부: 참조 → 핸들(GuardedActuator 아래 원시 드라이버가 쓴다). */
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
    if (!h) return { role: '', name: '', visible: false, enabled: false };
    const [visible, enabled] = await Promise.all([h.handle.isVisible().catch(() => false), h.handle.isEnabled().catch(() => false)]);
    // locator.nth(i)가 아직 같은 요소일 때만 그 aria 스냅숏을 믿는다.
    const same = await h.loc.evaluate((a, b) => a === b, h.handle).catch(() => false);
    if (!same) return { role: '', name: '', visible, enabled };
    // 역할 없는 div·span(WebSquare 창·표시 글)은 aria 스냅숏이 자기 줄 없이 자식으로 펼쳐지거나(div) 비어 있다(빈 span).
    // 그 첫 줄을 자기 역할로 읽으면 R-A1이 엉뚱한 역할로 맞거나 틀린다. 그래서 그런 요소는 ARIA 명세대로 'generic'(이름 없음)으로 본다.
    if (await h.handle.evaluate((n) => { const e = n as Element; return (e.tagName === 'DIV' || e.tagName === 'SPAN') && !e.hasAttribute('role'); }).catch(() => false)) return { role: 'generic', name: '', visible, enabled };
    const snap = await h.loc.ariaSnapshot({ timeout: this.timeoutMs }).catch(() => '');
    return { ...ariaHead(snap), visible, enabled };
  }

  async same(a: ElementRef, b: ElementRef): Promise<boolean> {
    const x = this.handle(a);
    const y = this.handle(b);
    if (!x || !y) return false;
    return x.evaluate((p, q) => p === q, y).catch(() => false);
  }

  async text(el: ElementRef): Promise<string> {
    const h = this.handle(el);
    return h ? h.innerText().catch(() => '') : '';
  }

  async value(el: ElementRef): Promise<string> {
    const h = this.handle(el);
    if (!h) return '';
    return h.evaluate((e) => ('value' in e && typeof (e as { value: unknown }).value === 'string' ? (e as { value: string }).value : '')).catch(() => '');
  }

  async a11yValue(el: ElementRef): Promise<string> {
    const h = this.held.get(el.ref);
    if (!h) return '';
    const snap = await h.loc.ariaSnapshot({ timeout: this.timeoutMs }).catch(() => '');
    // 역할 없는 div·span(generic)은 접근성 트리에서 글 노드(`- text: 1,000`)로 펼쳐진다: 그 글을 값으로 본다(표시 글 readback, 미리보기 창). 빈 span은 ''.
    if (await h.handle.evaluate((n) => { const e = n as Element; return (e.tagName === 'DIV' || e.tagName === 'SPAN') && !e.hasAttribute('role'); }).catch(() => false)) return snap ? ariaValue(snap, 'text') : '';
    return ariaValue(snap, ariaHead(snap).role);
  }

  /** aria 스냅숏(읽기 전용, decide 화면 관측). el이 없으면 문서 전체. 잡은 요소가 locator와 달라졌으면 null. */
  async ariaSnapshot(el: ElementRef | null): Promise<string | null> {
    if (!el) return this.page.mainFrame().locator('body').ariaSnapshot({ timeout: this.timeoutMs }).catch(() => null);
    const h = this.held.get(el.ref);
    if (!h) return null;
    const same = await h.loc.evaluate((a, b) => a === b, h.handle).catch(() => false);
    if (!same) return null;
    return h.loc.ariaSnapshot({ timeout: this.timeoutMs }).catch(() => null);
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

  /**
   * 로드가 끝났고 이 탭의 요청(XHR 포함)이 IDLE_QUIET_MS 동안 0개면 true. Playwright networkidle은 로드 뒤 한 번 닿으면 다시 보지 않아
   * [조회] 클릭 뒤 XHR로 그려지는 표(홈택스 발급 목록)의 끝을 알 수 없다. 그래서 진행 중 요청을 직접 센다.
   */
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
