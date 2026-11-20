import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { PortLike } from '@sax/platform';
import { VaultClient } from '@sax/engine';

function fakePort(): { port: PortLike; deliver: (m: unknown) => void; sent: unknown[] } {
  let handler: ((m: unknown) => void) | null = null;
  const sent: unknown[] = [];
  const port = { postMessage: (m: unknown) => void sent.push(m), onMessage: (fn: (m: unknown) => void) => void (handler = fn) } as unknown as PortLike;
  return { port, deliver: (m) => handler?.(m), sent };
}

describe('VaultClient CDP transport', () => {
  it('cdp_closed를 받으면 transport를 닫고, onclose를 달기 전에 닫혔어도 다음 요청에서 다시 알린다', { timeout: 2000 }, async () => {
    const f = fakePort();
    const client = new VaultClient(f.port);
    const t = client.cdpTransport();
    f.deliver({ t: 'cdp_closed' });
    const closed = new Promise<string | undefined>((r) => (t.onclose = r));
    t.send({ id: 1, method: 'Browser.getVersion' });
    assert.equal(await closed, 'chrome closed');
    assert.equal(f.sent.length, 0, '닫힌 뒤의 요청은 금고로 보내지 않는다');
  });

  it('옛 transport를 늦게 닫아도 새 transport는 계속 메시지를 받는다', () => {
    const f = fakePort();
    const client = new VaultClient(f.port);
    const old = client.cdpTransport();
    const fresh = client.cdpTransport();
    const got: unknown[] = [];
    fresh.onmessage = (m) => void got.push(m);
    old.close();
    f.deliver({ t: 'cdp', m: JSON.stringify({ id: 7, result: {} }) });
    assert.deepEqual(got, [{ id: 7, result: {} }]);
  });
});
