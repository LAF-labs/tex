import { chromium, type Browser, type Page } from 'playwright-core';
import type { CdpSessionLike } from './commitguard/cdp.ts';
import { CdpTap } from './driver/cdp-tap.ts';
import { RunEnd } from './run-end.ts';
import type { VaultClient } from './vault-client.ts';

export interface RunBrowser {
  browser: Browser;
  page: Page;
  targetId: string;
  /** 실행 탭의 페이지 세션(Playwright와 같은 세션, 커밋 가드 Fetch용, M2-4 D). */
  cdp: CdpSessionLike;
}

/** 실행 끝 코드: 이 PC에 Chrome이 없다(금고 browser.launch 오류 문자열과 같다). */
export const CHROME_NOT_INSTALLED_CODE = 'chrome.not_installed';

/** 금고가 띄운 Chrome에 금고 중계(MessagePort)로 Playwright를 붙인다(S6b). */
export async function connectRunBrowser(vault: VaultClient): Promise<RunBrowser> {
  const { targetId } = await vault.rpc<{ targetId: string; webdriver: boolean }>('browser.launch').catch((e: unknown) => {
    // 금고가 Chrome을 못 찾았다(vault chrome/find.ts CHROME_NOT_INSTALLED). 실행은 engine.error가 아니라 이 코드로 끝난다(데스크톱 사람 말 표의 키).
    if ((e as Error)?.message === `vault: ${CHROME_NOT_INSTALLED_CODE}`) throw new RunEnd('failed', CHROME_NOT_INSTALLED_CODE);
    throw e;
  });
  // 공개 타입에는 없지만 1.64 클라이언트가 ConnectionTransport 오버로드를 받는다(S6b 보고서 참조).
  const connect = chromium.connectOverCDP as unknown as (t: unknown, o: Record<string, unknown>) => Promise<Browser>;
  const tap = new CdpTap(vault.cdpTransport());
  const browser = await connect.call(chromium, tap.transport, { noDefaults: true, isLocal: true, timeout: 30_000 });
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) throw new Error('no default context');
    let page = ctx.pages()[0];
    for (let i = 0; !page && i < 50; i++) {
      await new Promise((r) => setTimeout(r, 100));
      page = ctx.pages()[0];
    }
    if (!page) throw new Error('run page not exposed');
    const cdp = await tap.session(targetId);
    return { browser, page, targetId, cdp };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

/**
 * 실행 브라우저 하나를 열고 닫는다. 열기·닫기를 한 줄로 세운다.
 * 동시에 두 번 열면 금고에 launch가 두 번 가고(두 번째는 거부), 띄우는 중에 닫으면 닫은 뒤에 브라우저가 남는다.
 */
export class RunBrowserSlot {
  private run: RunBrowser | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private opening = 0;
  /** 닫기마다 늘린다. 닫기 전에 줄 선 열기는 Chrome을 새로 띄우지 않는다(띄웠다가 바로 닫히는 창이 생긴다). */
  private closes = 0;
  private readonly connect: () => Promise<RunBrowser>;
  private readonly shutdown: () => Promise<unknown>;

  constructor(connect: () => Promise<RunBrowser>, shutdown: () => Promise<unknown>) {
    this.connect = connect;
    this.shutdown = shutdown;
  }

  get current(): RunBrowser | null {
    return this.run;
  }

  /**
   * 열려 있으면 그것을 준다. 실행 페이지가 닫혔거나(사용자가 탭·창을 닫음) 금고가 Chrome을 내렸으면 금고 쪽까지 내리고 새로 띄운다.
   * 붙이다 실패하면 금고 쪽 Chrome도 내려 다음 열기가 already launched로 막히지 않게 한다.
   * prepare(첫 이동 등)도 같은 줄에서 돈다. 두 번 눌러도 이동이 서로를 끊지 않는다.
   */
  open(prepare?: (run: RunBrowser) => Promise<void>): Promise<RunBrowser> {
    const closes = this.closes;
    this.opening++;
    return this.serial(async () => {
      if (closes !== this.closes) throw new Error('browser closed');
      if (this.run && (!this.run.browser.isConnected() || this.run.page.isClosed())) await this.teardown();
      if (!this.run) {
        try {
          this.run = await this.connect();
        } catch (e) {
          await this.shutdown().catch(() => {});
          throw e;
        }
      }
      await prepare?.(this.run);
      return this.run;
    }).finally(() => this.opening--);
  }

  close(): Promise<void> {
    this.closes++;
    // 띄우는 중이면 금고에 내리기를 먼저 보낸다. 응답 없는 Chrome에 붙는 중이면 열기가 끝나지 않아 줄 뒤의 닫기도 끝나지 않는다.
    if (this.opening) void this.shutdown().catch(() => {});
    return this.serial(() => this.teardown());
  }

  private async teardown(): Promise<void> {
    const r = this.run;
    this.run = null;
    await r?.browser.close().catch(() => {});
    await this.shutdown().catch(() => {});
  }

  private serial<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op);
    this.queue = next.catch(() => {});
    return next;
  }
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
