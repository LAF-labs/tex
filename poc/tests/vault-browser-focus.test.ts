import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { connectRunBrowser } from '@sax/engine';
import { startHarness } from './harness.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headful = process.env.SAX_FOCUS_HEADFUL === '1' && process.platform === 'darwin';
const frontApp = () => execFileSync('lsappinfo', ['info', '-only', 'name', execFileSync('lsappinfo', ['front']).toString().trim()]).toString();

describe('금고 browser.focus', () => {
  it('Chrome 전·후 모두 focused:false(앞으로 올리지 않는다), 엔진 포트로는 부를 수 없고 엔진의 Page.bringToFront·Target.activateTarget도 거부', { timeout: 60_000 }, async () => {
    const h = await startHarness({ headful });
    try {
      assert.deepEqual(await h.control.rpc('browser.focus'), { focused: false });
      await assert.rejects(h.client.rpc('browser.focus'), /denied|not allowed|rpc_denied/i);
      const rb = await connectRunBrowser(h.client);
      await rb.page.goto('about:blank');
      if (headful) {
        for (let i = 0; i < 5 && !/Finder/.test(frontApp()); i++) {
          execFileSync('osascript', ['-e', 'tell application "Finder" to activate']);
          await sleep(1500);
        }
        assert.match(frontApp(), /Finder/);
      }
      assert.deepEqual(await h.control.rpc('browser.focus'), { focused: false });
      await assert.rejects(rb.page.bringToFront());
      if (headful) {
        await sleep(1200);
        assert.match(frontApp(), /Finder/, '맥: Chrome이 앞으로 오지 않는다');
      }
      await rb.browser.close().catch(() => {});
    } finally {
      await h.close();
    }
  });
});
