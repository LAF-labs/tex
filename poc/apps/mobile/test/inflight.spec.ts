// 잠금 때 키 지우기(src/inflight.ts): 진행 중 작업을 기다리고, 지운 키로는 봉인하지 않는다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { drained, inflight, liveKey } from '../src/inflight.ts';

describe('잠금과 진행 중 작업', () => {
  it('진행 중 작업이 끝난 뒤에 풀린다', async () => {
    const key = new Uint8Array(32).fill(7);
    let release!: () => void;
    const order: string[] = [];
    const job = inflight(async () => {
      await new Promise<void>((r) => (release = r));
      liveKey(key);
      order.push('sealed');
    });
    const wait = drained(5000).then(() => {
      key.fill(0);
      order.push('wiped');
    });
    await Promise.resolve();
    release();
    await Promise.all([job, wait]);
    assert.deepEqual(order, ['sealed', 'wiped']);
  });

  it('작업이 없으면 바로, 오래 걸리면 최대 시간 뒤에 풀린다', async () => {
    await drained(10);
    let release!: () => void;
    const job = inflight(() => new Promise<void>((r) => (release = r)));
    const t0 = Date.now();
    await drained(30);
    assert.ok(Date.now() - t0 >= 25);
    release();
    await job;
  });

  it('지운(0) 키로는 봉인하지 않는다', () => {
    assert.throws(() => liveKey(new Uint8Array(32)), /locked/);
    const k = new Uint8Array(32);
    k[31] = 1;
    assert.equal(liveKey(k), k);
  });
});
