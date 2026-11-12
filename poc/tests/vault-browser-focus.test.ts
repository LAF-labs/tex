// [홈택스 창 보기](U3): main 제어 포트 browser.focus → 금고가 실행 탭에 Page.bringToFront. 엔진 포트에는 열지 않는다.
// SAX_FOCUS_HEADFUL=1(맥, 수동): 화면에 Chrome을 띄우고 Finder를 앞으로 둔 뒤 browser.focus로 Chrome 앱이 맨 앞에 오는지 lsappinfo로 본다.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { connectRunBrowser } from '@sax/engine';
import { startHarness } from './harness.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const headful = process.env.SAX_FOCUS_HEADFUL === '1' && process.platform === 'darwin';
const frontApp = () => execFileSync('lsappinfo', ['info', '-only', 'name', execFileSync('lsappinfo', ['front']).toString().trim()]).toString();

describe('금고 browser.focus', () => {
  it('Chrome 전에는 focused:false, 실행 탭이 있으면 그 탭을 앞으로. 엔진 포트로는 부를 수 없다', { timeout: 60_000 }, async () => {
    const h = await startHarness({ headful });
    try {
      assert.deepEqual(await h.control.rpc('browser.focus'), { focused: false });
      await assert.rejects(h.client.rpc('browser.focus'), /denied|not allowed|rpc_denied/i);
      const rb = await connectRunBrowser(h.client);
      await rb.page.goto('about:blank');
      if (headful) {
        // 막 뜬 Chrome이 잠시 앞으로 다시 올 수 있어, Finder가 맨 앞에 머물 때까지 몇 번 둔다.
        for (let i = 0; i < 5 && !/Finder/.test(frontApp()); i++) {
          execFileSync('open', ['-a', 'Finder']);
          await sleep(1500);
        }
        assert.match(frontApp(), /Finder/);
      }
      assert.deepEqual(await h.control.rpc('browser.focus'), { focused: true });
      if (headful) {
        await sleep(1200);
        assert.match(frontApp(), /Google Chrome/, '맥: Chrome 앱이 맨 앞');
      }
      await rb.browser.close().catch(() => {});
    } finally {
      await h.close();
    }
  });
});
