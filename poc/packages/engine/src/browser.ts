import { chromium, type Browser, type Page } from 'playwright-core';
import type { VaultClient } from './vault-client.ts';

export interface RunBrowser {
  browser: Browser;
  page: Page;
  targetId: string;
}

/** 금고가 띄운 Chrome에 금고 중계(MessagePort)로 Playwright를 붙인다(S6b). */
export async function connectRunBrowser(vault: VaultClient): Promise<RunBrowser> {
  const { targetId } = await vault.rpc<{ targetId: string; webdriver: boolean }>('browser.launch');
  // 공개 타입에는 없지만 1.64 클라이언트가 ConnectionTransport 오버로드를 받는다(S6b 보고서 참조).
  const connect = chromium.connectOverCDP as unknown as (t: unknown, o: Record<string, unknown>) => Promise<Browser>;
  const browser = await connect.call(chromium, vault.cdpTransport(), { noDefaults: true, isLocal: true, timeout: 30_000 });
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('no default context');
  let page = ctx.pages()[0];
  for (let i = 0; !page && i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    page = ctx.pages()[0];
  }
  if (!page) throw new Error('run page not exposed');
  return { browser, page, targetId };
}

/**
 * 비밀 창을 열기 전에 Playwright 주입 스크립트(메인·유틸리티 world)를 모든 프레임에 미리 만든다.
 * 오염 상태에서는 금고가 값 접근 패턴을 담은 Runtime.evaluate를 거부하는데, Playwright 주입 스크립트
 * 기동 소스에도 그 패턴이 있어 오염 중 첫 기동이 막힌다(S6b). 커밋 이후 새 문서는 오염이 풀려 상관없다.
 */
export async function warmForSecretWindow(page: Page): Promise<void> {
  for (const f of page.frames()) {
    await f.evaluate(() => 0);
    await f.locator('html').count(); // 유틸리티 world 주입 스크립트
    await (await f.$('html'))?.dispose(); // 메인 world 주입 스크립트
  }
}
