// S6b: Playwright가 금고 MessagePort 중계(기본 거부 허용 목록) 위에서 동작하는가, 최소 CDP 메서드 집합.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Browser, Page } from 'playwright-core';
import { connectRunBrowser, RunBrowserSlot, warmForSecretWindow } from '@sax/engine';
import { scanDir, testSecret } from '@sax/vault';
import { startFixture, type Fixture } from './fixtures/server.ts';
import { startHarness, type Harness } from './harness.ts';

const REPORT_DIR = path.resolve(import.meta.dirname, '../reports/raw');

async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return 'ok';
  } catch (e) {
    return 'error: ' + (e as Error).message.split('\n')[0]!.slice(0, 160);
  }
}

describe('S6b Playwright over vault relay', () => {
  let fx: Fixture;
  let h: Harness;
  let browser: Browser;
  let page: Page;
  let targetId: string;
  const secrets: string[] = [];
  const report: Record<string, unknown> = {};

  before(async () => {
    fx = await startFixture();
    h = await startHarness();
    ({ browser, page, targetId } = await connectRunBrowser(h.client));
    await h.vault.profileChecked();
    await h.control.rpc('run.begin', { runId: 'pw1', trigger: 'local' });
  });

  after(async () => {
    const stats = [...h.vault.relay!.methodStats.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => a.key.localeCompare(b.key));
    report.methods = stats;
    await fs.mkdir(REPORT_DIR, { recursive: true });
    await fs.writeFile(path.join(REPORT_DIR, 's6b-playwright.json'), JSON.stringify(report, null, 2));
    await browser.close().catch(() => {});
    await h.close();
    await fx.close();
  });

  it('기본 조작: goto·fill·click·waitForURL·evaluate·iframe·worker·request 이벤트', async () => {
    await page.goto(`${fx.origin}/login`);
    await page.fill('#user', 'alice');
    assert.equal(await page.inputValue('#user'), 'alice');
    assert.equal(await page.evaluate(() => document.title), 'login');
    assert.equal(await page.frameLocator('#child').locator('#cpw').count(), 1);
    await page.waitForFunction(() => true);
    for (let i = 0; i < 40 && page.workers().length === 0; i++) await page.waitForTimeout(50);
    report.workersVisible = page.workers().length;
    assert.equal(browser.version(), String(h.vault.relay!.browserVersion.product).split('/')[1]);
    const reqs: string[] = [];
    page.on('request', (r) => reqs.push(r.method() + ' ' + new URL(r.url()).pathname));
    await page.click('#go');
    await page.waitForURL('**/submit');
    assert.ok(reqs.includes('POST /submit'));
  });

  it('팝업: 노출 페이지가 연 허용 origin 팝업은 Playwright popup으로 보인다', async () => {
    await page.goto(`${fx.origin}/popup`);
    const [popup] = await Promise.all([page.waitForEvent('popup'), page.click('#open')]);
    await popup.waitForLoadState();
    assert.equal(new URL(popup.url()).pathname, '/login');
    await popup.close();
  });

  it('허용 목록 밖 Playwright API는 실패한다(브라우저 타깃·쿠키·새 컨텍스트·CDP 세션·바인딩)', async () => {
    const ctx = page.context();
    const r: Record<string, string> = {
      'context.newPage()': await outcome(() => ctx.newPage()),
      'browser.newContext()': await outcome(() => browser.newContext()),
      'context.newCDPSession(page)': await outcome(() => ctx.newCDPSession(page)),
      'context.cookies()': await outcome(() => ctx.cookies()),
      'context.addCookies()': await outcome(() => ctx.addCookies([{ name: 'a', value: 'b', url: fx.origin }])),
      'context.clearCookies()': await outcome(() => ctx.clearCookies()),
      'context.storageState()': await outcome(() => ctx.storageState()),
      'page.exposeFunction()': await outcome(() => page.exposeFunction('saxProbe', () => 1)),
      'page.setInputFiles()': await outcome(async () => {
        await page.goto(`${fx.origin}/login`);
        await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<input type=file id=f>'));
        await page.setInputFiles('#f', { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
      }),
      'page.goto(disallowed)': await outcome(() => page.goto('https://example.com/')),
      'context.addInitScript()': await outcome(() => ctx.addInitScript(() => {})),
      'page.screenshot() (not tainted)': await outcome(() => page.screenshot()),
    };
    report.apiOutcomes = r;
    for (const k of ['context.newPage()', 'browser.newContext()', 'context.newCDPSession(page)', 'context.cookies()', 'context.addCookies()', 'page.exposeFunction()', 'page.goto(disallowed)']) {
      assert.match(r[k]!, /^error/, `${k} must fail`);
    }
    assert.equal(r['page.screenshot() (not tainted)'], 'ok');
    // 실패 후에도 같은 페이지로 계속 쓸 수 있다
    await page.goto(`${fx.origin}/login`);
    assert.equal(await page.title(), 'login');
  });

  it('타이피스트 + Playwright: 제출 요청 postData가 엔진에 없고(메인·워커), 오염 중 screenshot 거부', async () => {
    const secret = testSecret('TEST-CERT');
    secrets.push(secret);
    await page.goto(`${fx.origin}/login`);
    await page.fill('#user', 'alice');
    await page.focus('#pw');
    await warmForSecretWindow(page);
    await h.secretInput.rpc('secret.provide', { kind: 'cert_password', scope: 'biz', bytes: new TextEncoder().encode(secret) });
    const r = await h.client.rpc('typist.fill', { runId: 'pw1', targetId, frame: 'main', element: '#pw', secret: { kind: 'cert_password', scope: 'biz' } });
    assert.deepEqual(r, { ok: true });
    report.taintedScreenshot = await outcome(() => page.screenshot());
    assert.match(String(report.taintedScreenshot), /^error/);
    const iv = await page.inputValue('#pw').catch((e: Error) => 'error: ' + e.message.split('\n')[0]);
    report.taintedInputValue = iv === secret ? 'LEAKED' : iv;
    assert.notEqual(iv, secret, '오염 상태 inputValue는 평문을 돌려주지 않는다(패턴 차단 또는 알려진 값 지우기)');
    const posts: Array<{ url: string; body: string | null }> = [];
    page.context().on('request', (req) => {
      if (req.method() === 'POST') posts.push({ url: new URL(req.url()).pathname, body: req.postData() });
    });
    await page.dispatchEvent('#pw', 'change');
    await page.click('#go');
    await page.waitForURL('**/submit');
    await page.waitForTimeout(300);
    report.postsSeenByEngine = posts;
    assert.ok(posts.some((p) => p.url === '/submit'));
    for (const p of posts) assert.equal(p.body, null, `${p.url} body must be stripped`);
    assert.ok(fx.bodies.some((b) => b.includes(encodeURIComponent(secret))));
    assert.ok(fx.bodies.some((b) => b === 'w=' + secret), '워커 요청도 실제로 나갔다');
  });

  it('human:secret 활성 창 동안 Playwright 조작은 실패하고, 종료 후 클릭은 된다', async () => {
    const secret = testSecret('TEST-HUMAN');
    secrets.push(secret);
    await page.goto(`${fx.origin}/spa`);
    await warmForSecretWindow(page);
    assert.deepEqual(await h.client.rpc('secretWindow.openForHuman', { runId: 'pw1', targetId, frame: 'main', element: '#pw' }), { ok: true });
    const t = h.vault.relay!.targets.get(targetId)!;
    report.duringActive = {
      'page.click()': await outcome(() => page.click('#go', { timeout: 2000 })),
      'page.evaluate()': await outcome(() => page.evaluate(() => 1)),
      'page.title()': await outcome(() => page.title()),
    };
    // 사용자 입력 대역(금고 세션) 후 blur
    await h.vault.relay!.send('Runtime.evaluate', { expression: `document.getElementById('pw').focus()` }, t.vaultSession);
    await h.vault.relay!.send('Input.insertText', { text: secret }, t.vaultSession);
    const closed = h.client.once('secret_window.closed', (d) => d.targetId === targetId, 5000);
    await h.vault.relay!.send('Runtime.evaluate', { expression: `document.activeElement.blur()` }, t.vaultSession);
    await closed;
    await page.click('#go');
    await page.waitForSelector('#ok');
    report.afterClose = 'click ok, no deadlock';
    assert.ok(fx.bodies.some((b) => b.includes(secret)));
  });

  it('누출 스캐너 0건(Playwright 경로)', async () => {
    const ipc = h.capture.scan(secrets);
    const logs = await scanDir(h.paths.logs, secrets);
    report.leak = { ipcMessages: h.capture.size, ipcFindings: ipc, logFindings: logs.findings };
    assert.deepEqual(ipc, []);
    assert.deepEqual(logs.findings, []);
  });
});

describe('RunBrowserSlot + 실제 금고: 동시 열기, Chrome이 내려간 뒤 다시 열기(PoC-1 §5.2)', () => {
  it('두 번 동시에 열어도 Chrome 하나, 금고가 내리면 Playwright가 끊김을 알고 다음 열기에서 새로 띄운다', async () => {
    const h = await startHarness();
    const slot = new RunBrowserSlot(() => connectRunBrowser(h.client), () => h.client.rpc('browser.shutdown'));
    try {
      const [a, b] = await Promise.all([slot.open(), slot.open()]);
      assert.equal(a.targetId, b.targetId);
      const pid = h.vault.chromePid;
      assert.ok(pid);
      const disconnected = new Promise<void>((r) => a.browser.once('disconnected', () => r()));
      await h.client.rpc('browser.shutdown'); // 사용자가 Chrome을 닫거나 금고가 내린 경우의 대역
      await Promise.race([disconnected, new Promise((r) => setTimeout(r, 5000))]);
      assert.equal(a.browser.isConnected(), false);
      const c = await slot.open();
      assert.notEqual(c.targetId, a.targetId);
      assert.ok(h.vault.chromePid && h.vault.chromePid !== pid, '새 Chrome');
      assert.equal(await c.page.evaluate(() => 1 + 1), 2);
    } finally {
      await slot.close();
      await h.close();
    }
  });
});
