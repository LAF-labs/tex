// 원시 Actuator의 Playwright 구현(D03 §5.2·§5.5, M2-4 D). 정책·R-A1·R-A2·그림자 검사는 이것을 감싸는 GuardedActuator가 한다.
// - 대상은 PageReader가 잡은 ElementHandle(R-A1을 통과한 바로 그 요소). 다시 찾지 않는다.
// - goto·클릭 뒤 네비게이션이 있으면 afterNavigation(집행기 settled: 안정 대기 + 걸쇠)을 부른다.
// - keyEvents 입력은 전체 선택 → 삭제 → 고정 간격 키 입력(D03 §5.5). 값은 로그·저널에 남기지 않는다.
// - 실패 코드: 시간 초과 step.timeout, 그 밖(요소가 사라짐·가려짐 등) step.selector_miss.
import type { Page } from 'playwright-core';
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
      return fail(e);
    }
    return this.settle(true);
  }

  async click(t: Resolved): Promise<ActResult> {
    const h = this.i.reader.handle(t.el);
    if (!h) return { ok: false, code: 'step.selector_miss' };
    const before = this.navCount();
    try {
      await h.click({ timeout: this.timeoutMs });
    } catch (e) {
      return fail(e);
    }
    return this.settle(this.navCount() !== before);
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
      return fail(e);
    }
    return OK;
  }

  async clear(t: Resolved): Promise<ActResult> {
    const h = this.i.reader.handle(t.el);
    if (!h) return { ok: false, code: 'step.selector_miss' };
    try {
      await h.fill('', { timeout: this.timeoutMs });
    } catch (e) {
      return fail(e);
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
      return fail(e);
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
      return fail(e);
    }
    return this.settle(this.navCount() !== before);
  }

  private navs = 0;
  private hooked = false;

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

function fail(e: unknown): ActResult {
  const name = (e as { name?: string } | null)?.name;
  return { ok: false, code: name === 'TimeoutError' ? 'step.timeout' : 'step.selector_miss' };
}
