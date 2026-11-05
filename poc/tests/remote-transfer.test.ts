// D14 M7-4 전송 + SP-5(릴레이 재전송·드롭): 폰 보관함 → IK 세션 → PC 수신 큐 → 저장(모의 sink) → ack → 폰 삭제.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CAP, MemoryRelay, RECEIPT_CHUNK, ReceiveQueue, acceptDesktopSession, b64, enqueueCash, flushOutbox, fromB64, makeCashEntry, makeReceiptOffer, monotonicClock,
  newFileKey, openMobileSession, openOutboxFile, sealOutboxFile, sha256Hash, toHex, type CashEntryBody, type Channel, type OutboxItem, type OutboxStore,
  type PairRecord, type ReceiveSink,
} from '@sax/remote';
import { fakeJpeg, pairOnce, pairWorld } from './remote-support.ts';

class MemOutbox implements OutboxStore {
  items = new Map<string, OutboxItem>();
  photos = new Map<string, Uint8Array>();
  key = newFileKey();
  async list() {
    return [...this.items.values()];
  }
  async put(it: OutboxItem, photo?: Uint8Array) {
    this.items.set(it.msgId, it);
    if (photo) this.photos.set(it.msgId, sealOutboxFile(this.key, it.msgId, photo));
  }
  async readPhoto(id: string) {
    return openOutboxFile(this.key, id, this.photos.get(id)!);
  }
  async remove(id: string) {
    this.items.delete(id);
    this.photos.delete(id);
  }
}

class MemSink implements ReceiveSink {
  receipts = new Map<string, { sha: string; bytes: number; candidates?: object }>();
  cash = new Map<string, CashEntryBody>();
  cashIds = new Set<string>();
  storeCalls = 0;
  failNext = false;
  async hasReceipt(id: string) {
    return this.receipts.has(id);
  }
  async storeReceipt(r: Parameters<ReceiveSink['storeReceipt']>[0]) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('disk full');
    }
    this.storeCalls++;
    this.receipts.set(r.msgId, { sha: toHex(sha256Hash(r.jpeg)), bytes: r.jpeg.length, candidates: r.offer.candidates });
  }
  async hasCash(id: string) {
    return this.cashIds.has(id);
  }
  async storeCash({ entry }: { entry: CashEntryBody }) {
    this.cashIds.add(entry.msgId);
    const cur = this.cash.get(entry.day);
    if (!cur || cur.enteredAt < entry.enteredAt) this.cash.set(entry.day, entry);
  }
}

async function world(relay = new MemoryRelay()) {
  const w = await pairWorld({ relay });
  w.relay.faults = {};
  const { pc, phone } = await pairOnce(w);
  pc.channel.close();
  const rec: PairRecord = { pairId: pc.pairId, phoneStatic: pc.phone.Sm, revoked: false, ikTsMax: 0 };
  const clock = monotonicClock(0);
  const sink = new MemSink();
  const queue = new ReceiveQueue(sink);
  const outbox = new MemOutbox();
  /** PC가 켜져 있을 때 한 세션: PC는 받은 봉투를 큐에 넘기고, 폰은 보관함을 비운다. */
  const session = async (o: { faults?: MemoryRelay['faults']; ackTimeoutMs?: number; maxRounds?: number } = {}) => {
    const pcLink = await w.relay.joinMailbox(pc.mbxId, { read: pc.tokRead, write: pc.tokWrite }, 'desktop');
    const phLink = await w.relay.joinMailbox(fromB64(phone.mbxId), { read: fromB64(phone.tokRead), write: fromB64(phone.tokWrite) }, 'mobile');
    const [a, b] = await Promise.all([
      acceptDesktopSession(pcLink, { noise: w.desk.keys.noise, pair: rec, hello: { appVersion: 'pc', deviceListVersion: 2, capabilities: [CAP.receipt, CAP.cash] }, persistTs: async () => {} }),
      openMobileSession(phLink, { pairId: phone.pairId, noise: w.phone.keys.noise, desktopStatic: phone.desktopStatic, nextTimestamp: clock, hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [CAP.receipt, CAP.cash] } }),
    ]);
    assert.ok(a && b, 'session');
    w.relay.faults = o.faults ?? {};
    let stop = false;
    const pcLoop = (async (ch: Channel) => {
      while (!stop && !ch.closed) {
        const e = await ch.recv(50);
        if (e) await queue.handle(ch, e);
      }
    })(a.channel);
    const res = await flushOutbox(b.channel, outbox, { pace: async () => {}, ackTimeoutMs: o.ackTimeoutMs ?? 300, maxRounds: o.maxRounds ?? 5 });
    stop = true;
    await pcLoop;
    w.relay.faults = {};
    pcLink.close();
    phLink.close();
    return res;
  };
  /** PC 꺼짐: 폰만 우편함에 들어가 IK msg1을 보내고 응답이 없다. */
  const pcOffline = async () => {
    const phLink = await w.relay.joinMailbox(fromB64(phone.mbxId), { read: fromB64(phone.tokRead), write: fromB64(phone.tokWrite) }, 'mobile');
    const r = await openMobileSession(phLink, { pairId: phone.pairId, noise: w.phone.keys.noise, desktopStatic: phone.desktopStatic, nextTimestamp: clock, responseTimeoutMs: 100, hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [] } });
    phLink.close();
    return r;
  };
  return { w, sink, queue, outbox, session, pcOffline };
}

async function addReceipt(outbox: MemOutbox, size: number, seed = 1) {
  const jpeg = fakeJpeg(size, seed);
  const offer = makeReceiptOffer(jpeg, { capturedAt: Date.now(), ocrEngine: 'none', ownerConfirmed: false });
  await outbox.put({ kind: 'receipt', msgId: offer.msgId, offer, createdAt: Date.now(), attempts: 0 }, jpeg);
  return { jpeg, offer };
}

describe('사진 전송', () => {
  it('여러 청크 사진이 PC에 그대로 저장되고 폰 보관함에서 지워진다', async () => {
    const t = await world();
    const { jpeg, offer } = await addReceipt(t.outbox, RECEIPT_CHUNK * 3 + 17);
    assert.equal(offer.chunkCount, 4);
    const r = await t.session();
    assert.deepEqual(r.sent, [offer.msgId]);
    assert.equal(t.sink.receipts.get(offer.msgId)?.sha, toHex(sha256Hash(jpeg)));
    assert.equal(t.outbox.items.size, 0);
    assert.equal(t.queue.assembling, 0);
  });

  it('PC가 꺼져 있으면 폰에 남고, 켜진 뒤 세션에서 보낸다', async () => {
    const t = await world();
    const { offer } = await addReceipt(t.outbox, 1000);
    // PC 꺼짐: 우편함에 PC가 없다 → 세션이 열리지 않는다. 사진은 릴레이에 남기지 않는다(프레임 = 핸드셰이크 1개뿐)
    const before = t.w.relay.observed.length;
    assert.equal(await t.pcOffline(), null);
    assert.equal(t.w.relay.observed.length - before, 1);
    assert.equal(t.outbox.items.size, 1, '폰 보관함에 그대로');
    const r = await t.session();
    assert.deepEqual(r.sent, [offer.msgId]);
  });

  it('이미 받은 msgId를 다시 보내면 저장하지 않고 stored로 답한다(중복 제거)', async () => {
    const t = await world();
    const { offer } = await addReceipt(t.outbox, 5000);
    const item = t.outbox.items.get(offer.msgId)!;
    const box = t.outbox.photos.get(offer.msgId)!;
    await t.session();
    assert.equal(t.sink.storeCalls, 1);
    // 폰이 ack를 못 받았다고 가정하고 같은 항목을 다시 보낸다
    t.outbox.items.set(offer.msgId, item);
    t.outbox.photos.set(offer.msgId, box);
    const r = await t.session();
    assert.deepEqual(r.sent, [offer.msgId]);
    assert.equal(t.sink.storeCalls, 1);
  });

  it('SP-5: 릴레이가 프레임 25%를 버리고 20%를 중복해도 결국 정확히 한 번 저장', async () => {
    const t = await world();
    let seed = 42;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const items = [];
    for (let i = 0; i < 3; i++) items.push(await addReceipt(t.outbox, RECEIPT_CHUNK * 2 + i * 1000, i + 3));
    for (let round = 0; round < 8 && t.outbox.items.size; round++) await t.session({ faults: { drop: 0.25, duplicate: 0.2, rand } });
    assert.equal(t.outbox.items.size, 0, 'all delivered eventually');
    for (const it of items) assert.equal(t.sink.receipts.get(it.offer.msgId)?.sha, toHex(sha256Hash(it.jpeg)));
    assert.equal(t.sink.storeCalls, 3);
  });

  it('SP-5: 변조 프레임은 버려지고 저장된 내용은 원본과 같다', async () => {
    const t = await world();
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const { jpeg, offer } = await addReceipt(t.outbox, RECEIPT_CHUNK + 5);
    for (let round = 0; round < 10 && t.outbox.items.size; round++) await t.session({ faults: { tamper: 0.3, rand } });
    assert.equal(t.outbox.items.size, 0);
    assert.equal(t.sink.receipts.get(offer.msgId)?.sha, toHex(sha256Hash(jpeg)));
  });

  it('PC 저장 실패면 ack하지 않아 폰이 보관하고 다음에 다시 보낸다', async () => {
    const t = await world();
    const { offer } = await addReceipt(t.outbox, 3000);
    t.sink.failNext = true;
    const r1 = await t.session({ maxRounds: 1 });
    assert.deepEqual(r1.pending, [offer.msgId]);
    assert.equal(t.outbox.items.get(offer.msgId)?.attempts, 1);
    const r2 = await t.session();
    assert.deepEqual(r2.sent, [offer.msgId]);
  });

  it('보관 파일이 손상되면 보내지 않는다(복호 실패는 그 항목만)', async () => {
    const t = await world();
    const { offer } = await addReceipt(t.outbox, 3000);
    const box = t.outbox.photos.get(offer.msgId)!;
    box[box.length - 1]! ^= 1;
    await assert.rejects(() => t.outbox.readPhoto(offer.msgId));
    // 손상 항목이 먼저 와도 뒤 항목은 보낸다(flush 전체가 멈추지 않는다)
    const { offer: good } = await addReceipt(t.outbox, 2000, 9);
    await enqueueCash(t.outbox, makeCashEntry('2026-11-05', 50_000, 5000));
    const r = await t.session();
    assert.deepEqual(r.pending, [offer.msgId]);
    assert.equal(r.sent.length, 2);
    assert.ok(t.sink.receipts.has(good.msgId));
    assert.equal(t.outbox.items.get(offer.msgId)?.attempts, 1);
  });

  it('JPEG가 아니거나 4MiB를 넘으면 봉투를 만들지 않는다', () => {
    assert.throws(() => makeReceiptOffer(new Uint8Array(100), { capturedAt: 1, ocrEngine: 'none', ownerConfirmed: false }));
    assert.throws(() => makeReceiptOffer(fakeJpeg(4 * 1024 * 1024 + 1), { capturedAt: 1, ocrEngine: 'none', ownerConfirmed: false }));
    const ok = makeReceiptOffer(fakeJpeg(4 * 1024 * 1024), { capturedAt: 1, ocrEngine: 'ios_vision', ownerConfirmed: true, candidates: { amount: 1 } });
    assert.equal(ok.chunkCount, 86);
  });
});

describe('현금매출 전송', () => {
  it('하루 숫자 하나: 같은 날은 대기 항목을 바꾸고, PC는 늦은 값을 남긴다', async () => {
    const t = await world();
    await enqueueCash(t.outbox, makeCashEntry('2026-11-05', 100_000, 1000));
    await enqueueCash(t.outbox, makeCashEntry('2026-11-05', 120_000, 2000));
    await enqueueCash(t.outbox, makeCashEntry('2026-11-04', 90_000, 1500));
    assert.equal(t.outbox.items.size, 2);
    const r = await t.session();
    assert.equal(r.sent.length, 2);
    assert.equal(t.sink.cash.get('2026-11-05')?.amount, 120_000);
    assert.equal(t.sink.cash.get('2026-11-04')?.amount, 90_000);
  });

  it('같은 날 새 값 쓰기가 실패하면 옛 값이 보관함에 남는다', async () => {
    const o = new MemOutbox();
    await enqueueCash(o, makeCashEntry('2026-11-05', 100_000, 1000));
    const put = o.put.bind(o);
    o.put = async () => {
      throw new Error('disk full');
    };
    await assert.rejects(enqueueCash(o, makeCashEntry('2026-11-05', 120_000, 2000)));
    o.put = put;
    const left = await o.list();
    assert.equal(left.length, 1);
    assert.equal(left[0]!.kind === 'cash' && left[0]!.entry.amount, 100_000);
  });

  it('cash.entry 재전송은 중복 저장 없이 stored', async () => {
    const t = await world();
    const e = makeCashEntry('2026-11-05', 5000);
    await enqueueCash(t.outbox, e);
    await t.session();
    await enqueueCash(t.outbox, e);
    const r = await t.session();
    assert.deepEqual(r.sent, [e.msgId]);
    assert.equal(t.sink.cashIds.size, 1);
  });

  it('금액 범위 밖은 만들지 않는다', () => {
    assert.throws(() => makeCashEntry('2026-11-05', -1));
    assert.throws(() => makeCashEntry('2026-11-05', 1.5));
  });
});

describe('PC 수신 큐 한도', () => {
  it('청크 크기가 offer와 다르거나 조립 없는 청크는 무시', async () => {
    const sink = new MemSink();
    const q = new ReceiveQueue(sink);
    const sent: { type: string; body: unknown }[] = [];
    const ch = { pairId: 'P', closed: false, send: (type: string, body: unknown) => sent.push({ type, body }) } as unknown as Channel;
    const jpeg = fakeJpeg(RECEIPT_CHUNK + 10);
    const offer = makeReceiptOffer(jpeg, { capturedAt: 1, ocrEngine: 'none', ownerConfirmed: false });
    const env = (type: string, body: object) => ({ v: 1, type, id: 'x', pairId: 'P', from: 'mobile', to: 'desktop', seq: 0, ts: 0, ttl: 60, body }) as never;
    await q.handle(ch, env('receipt.chunk', { msgId: offer.msgId, index: 0, data: b64(jpeg.subarray(0, RECEIPT_CHUNK)) }));
    assert.equal(q.ignored, 1);
    await q.handle(ch, env('receipt.offer', offer));
    await q.handle(ch, env('receipt.chunk', { msgId: offer.msgId, index: 1, data: b64(jpeg.subarray(RECEIPT_CHUNK, RECEIPT_CHUNK + 5)) }));
    assert.equal(q.ignored, 2);
    // 내용이 바뀐 청크(크기는 같음) → sha 불일치 → 전부 다시 요청
    const bad = jpeg.slice();
    bad[RECEIPT_CHUNK + 1]! ^= 1;
    await q.handle(ch, env('receipt.chunk', { msgId: offer.msgId, index: 0, data: b64(bad.subarray(0, RECEIPT_CHUNK)) }));
    await q.handle(ch, env('receipt.chunk', { msgId: offer.msgId, index: 1, data: b64(bad.subarray(RECEIPT_CHUNK)) }));
    assert.deepEqual(sent.at(-1), { type: 'receipt.ack', body: { msgId: offer.msgId, state: 'partial', missing: [0, 1] } });
    assert.equal(sink.storeCalls, 0);
  });

  it('동시 조립 수 상한을 넘으면 가장 오래 쉰 조립을 버린다', async () => {
    let now = 0;
    const q = new ReceiveQueue(new MemSink(), { maxAssemblies: 2 }, () => now);
    const ch = { pairId: 'P', closed: false, send: () => {} } as unknown as Channel;
    const env = (body: object) => ({ v: 1, type: 'receipt.offer', id: 'x', pairId: 'P', from: 'mobile', to: 'desktop', seq: 0, ts: 0, ttl: 60, body }) as never;
    for (let i = 0; i < 3; i++) {
      now += 1;
      await q.handle(ch, env(makeReceiptOffer(fakeJpeg(RECEIPT_CHUNK * 2, i + 1), { capturedAt: 1, ocrEngine: 'none', ownerConfirmed: false })));
    }
    assert.equal(q.assembling, 2);
    now += 11 * 60_000;
    await q.handle(ch, { ...env({}), type: 'ping' });
    assert.equal(q.assembling, 0, '유휴 만료');
  });
});
