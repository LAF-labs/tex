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
  /** 동작 실패 때 Playwright가 멈춘 까닭의 갈래(값·글 없음). 실행 저널 actuator.why로 남긴다(예행 진단). */
  onError?: (op: string, why: string) => void;
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
    const h = this.i.reader.handle(t.el);
    if (!h) return { ok: false, code: 'step.selector_miss' };
    const before = this.navCount();
    try {
      await h.click({ timeout: this.timeoutMs });
    } catch (e) {
      return this.fail('click', e);
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
  private fail(op: string, e: unknown): ActResult {
    this.i.onError?.(op, whyOf(e));
    return fail(e);
  }

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
  if (/Timeout/i.test(m)) return 'timeout_other';
  return 'other';
}

function fail(e: unknown): ActResult {
  const name = (e as { name?: string } | null)?.name;
  return { ok: false, code: name === 'TimeoutError' ? 'step.timeout' : 'step.selector_miss' };
}
