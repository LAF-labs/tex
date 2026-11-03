// 엔진 실행 브라우저 열기·닫기 순서(PoC-1 §5.1 후속): 동시 호출에도 금고 launch는 한 번, 띄우는 중의 닫기는 띄운 뒤 닫는다.
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { connectRunBrowser, dispatchClick, RunBrowserSlot, type RunBrowser } from '@sax/engine';
import { startHarness } from './harness.ts';

function fakeRun(targetId: string): { run: RunBrowser; closed: () => number; closePage: () => void; disconnect: () => void } {
  let closed = 0;
  let pageClosed = false;
  let connected = true;
  const run = { targetId, page: { isClosed: () => pageClosed }, browser: { close: async () => void closed++, isConnected: () => connected } } as unknown as RunBrowser;
  return { run, closed: () => closed, closePage: () => void (pageClosed = true), disconnect: () => void (connected = false) };
}

function gate(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}

describe('RunBrowserSlot', () => {
  it('동시에 두 번 열어도 한 번만 붙이고 같은 브라우저를 준다', async () => {
    const g = gate();
    const f = fakeRun('t1');
    let connects = 0;
    const slot = new RunBrowserSlot(async () => (connects++, await g.wait, f.run), async () => {});
    const a = slot.open();
    const b = slot.open();
    g.open();
    assert.deepEqual([(await a).targetId, (await b).targetId, connects], ['t1', 't1', 1]);
    assert.equal(slot.current, f.run);
  });

  it('띄우는 중에 닫으면 다 띄운 뒤 닫고, 다음 열기는 새로 붙인다', async () => {
    const g = gate();
    const runs = [fakeRun('t1'), fakeRun('t2')];
    let i = 0;
    let shutdowns = 0;
    let connects = 0;
    const slot = new RunBrowserSlot(async () => (connects++, await g.wait, runs[i++]!.run), async () => void shutdowns++);
    const opened = slot.open();
    while (connects === 0) await new Promise((r) => setImmediate(r)); // 붙기 시작한 뒤에 닫는다
    const closed = slot.close();
    g.open();
    await opened;
    await closed;
    // 닫기는 띄우는 중이라 내리기를 먼저 한 번, 다 띄운 뒤 정리하며 한 번 더 보낸다.
    assert.deepEqual([runs[0]!.closed(), shutdowns, slot.current], [1, 2, null], '닫은 뒤에 브라우저가 남지 않는다');
    assert.equal((await slot.open()).targetId, 't2');
  });

  it('닫기 전에 줄만 서 있던 열기는 Chrome을 새로 띄우지 않는다', async () => {
    const g = gate();
    const f = fakeRun('t1');
    let connects = 0;
    const slot = new RunBrowserSlot(async () => (connects++, f.run), async () => {});
    const navigating = slot.open(() => g.wait); // 이동 중인 열기
    while (connects === 0) await new Promise((r) => setImmediate(r));
    const queued = slot.open(); // 그 뒤에 줄 선 열기
    const closed = slot.close();
    g.open();
    await navigating;
    await assert.rejects(queued, /browser closed/);
    await closed;
    assert.deepEqual([connects, slot.current], [1, null], '닫기 직전에 창을 하나 더 띄우지 않는다');
  });

  it('붙이다 실패하면 금고 쪽을 내리고, 다음 열기는 다시 시도한다', async () => {
    const f = fakeRun('t1');
    let attempts = 0;
    let shutdowns = 0;
    const slot = new RunBrowserSlot(
      async () => {
        if (attempts++ === 0) throw new Error('connect timeout');
        return f.run;
      },
      async () => void shutdowns++,
    );
    await assert.rejects(slot.open(), /connect timeout/);
    assert.deepEqual([shutdowns, slot.current], [1, null], '남은 Chrome을 내려 다음 launch가 already launched로 막히지 않게');
    assert.equal((await slot.open()).targetId, 't1');
  });

  it('응답 없는 Chrome에 붙는 중에 닫으면 내리기를 먼저 보내 기동을 끊는다', { timeout: 5000 }, async () => {
    let failConnect: ((e: Error) => void) | null = null;
    let shutdowns = 0;
    const slot = new RunBrowserSlot(
      () => new Promise<RunBrowser>((_, reject) => (failConnect = reject)),
      async () => {
        shutdowns++;
        failConnect?.(new Error('cdp pipe closed')); // 금고가 Chrome을 내리면 파이프가 닫혀 붙기가 거부된다
      },
    );
    const opened = slot.open();
    await new Promise((r) => setImmediate(r));
    await slot.close();
    await assert.rejects(opened, /cdp pipe closed/);
    assert.ok(shutdowns >= 1);
    assert.equal(slot.current, null);
  });

  it('첫 이동(prepare)도 줄을 서서, 두 번 눌러도 겹치지 않는다', async () => {
    const f = fakeRun('t1');
    const slot = new RunBrowserSlot(async () => f.run, async () => {});
    let active = 0;
    let maxActive = 0;
    const navigate = async () => {
      maxActive = Math.max(maxActive, ++active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
    };
    await Promise.all([slot.open(navigate), slot.open(navigate)]);
    assert.equal(maxActive, 1);
  });

  it('실행 페이지가 닫혔으면 금고 쪽까지 내리고 새로 띄운다', async () => {
    const runs = [fakeRun('t1'), fakeRun('t2')];
    let i = 0;
    let shutdowns = 0;
    const slot = new RunBrowserSlot(async () => runs[i++]!.run, async () => void shutdowns++);
    assert.equal((await slot.open()).targetId, 't1');
    runs[0]!.closePage();
    assert.equal((await slot.open()).targetId, 't2');
    assert.deepEqual([runs[0]!.closed(), shutdowns], [1, 1], '앞 Chrome을 내려야 금고가 다시 띄운다');
  });

  it('금고가 Chrome을 내려 연결이 끊겼으면 새로 띄운다', async () => {
    const runs = [fakeRun('t1'), fakeRun('t2')];
    let i = 0;
    const slot = new RunBrowserSlot(async () => runs[i++]!.run, async () => {});
    assert.equal((await slot.open()).targetId, 't1');
    runs[0]!.disconnect();
    assert.equal((await slot.open()).targetId, 't2');
  });

  it('금고 정리가 실패해도 열기 실패 원인을 그대로 준다', async () => {
    const slot = new RunBrowserSlot(
      async () => {
        throw new Error('chrome profile not private: not_owner');
      },
      async () => {
        throw new Error('vault gone');
      },
    );
    await assert.rejects(slot.open(), /chrome profile not private/);
  });
});

describe('커밋 클릭(N-21, 금고 중계 위 실 Chrome)', () => {
  it('dispatchClick reports blocked for a covered button', async () => {
    // 투명 덮개가 덮은 버튼과 덮지 않은 버튼. 누르면 각자 횟수를 올린다.
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0">
<button id="covered" style="position:absolute;left:10px;top:10px;width:120px;height:40px" onclick="window.nCovered=(window.nCovered||0)+1">발급하기</button>
<div style="position:absolute;left:0;top:0;width:300px;height:100px;background:transparent"></div>
<button id="open" style="position:absolute;left:10px;top:200px;width:120px;height:40px" onclick="window.nOpen=(window.nOpen||0)+1">발급하기</button></body>`;
    const server = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const h = await startHarness();
    try {
      const { page, browser } = await connectRunBrowser(h.client);
      await page.goto(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
      const covered = (await page.$('#covered'))!;
      const started = Date.now();
      assert.equal(await dispatchClick(covered), 'blocked');
      assert.ok(Date.now() - started < 10_000, 'Playwright 기본 30초를 기다리지 않는다');
      const open = (await page.$('#open'))!;
      assert.equal(await dispatchClick(open), 'sent');
      assert.deepEqual(await page.evaluate(() => [(window as unknown as { nCovered?: number }).nCovered ?? 0, (window as unknown as { nOpen?: number }).nOpen ?? 0]), [0, 1], '가린 버튼은 눌리지 않았다');
      await browser.close().catch(() => {});
    } finally {
      await h.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
