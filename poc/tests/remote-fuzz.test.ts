// M7-8 사진 봉투 퍼징: 와이어 바이트 변이·구조 변이·무작위 수신 순서에서 예외 없이 거르고, 틀린 사진을 저장하지 않는다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  RECEIPT_CHUNK, ReceiveQueue, Transport, b64, decodeCbor, decodeEnvelope, encodeEnvelope, makeReceiptOffer, randomBytes, sha256Hash, toHex, ulid, validateEnvelope,
  type Channel, type Envelope,
} from '@sax/remote';
import { fakeJpeg } from './remote-support.ts';

let seed = 20261105;
const rnd = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
const ri = (n: number) => Math.floor(rnd() * n);
const ITER = Number(process.env.SAX_FUZZ_ITER ?? 3000);

const PAIR = ulid();
const mk = (type: string, body: object): Envelope =>
  ({ v: 1, type, id: ulid(), pairId: PAIR, from: 'mobile', to: 'desktop', seq: 0, ts: Date.now(), ttl: 300, body }) as Envelope;

const jpeg = fakeJpeg(RECEIPT_CHUNK * 2 + 333);
const offer = makeReceiptOffer(jpeg, { capturedAt: 1, ocrEngine: 'ios_vision', ownerConfirmed: true, candidates: { amount: 15000, issuedOn: '2026-11-01', merchant: '가나다상회', merchantBizNo: '220-81-62517' } });
const samples = [
  mk('receipt.offer', offer),
  mk('receipt.chunk', { msgId: offer.msgId, index: 2, data: b64(jpeg.subarray(RECEIPT_CHUNK * 2)) }),
  mk('cash.entry', { msgId: ulid(), day: '2026-11-05', amount: 1234, enteredAt: 1 }),
];

describe('와이어 바이트 변이', () => {
  it(`변이 ${ITER}회: decodeEnvelope는 던지지 않고, 받은 것은 항상 스키마를 통과한다`, () => {
    let accepted = 0;
    for (let i = 0; i < ITER; i++) {
      const w = encodeEnvelope(samples[i % samples.length]!).slice();
      const k = 1 + ri(4);
      for (let j = 0; j < k; j++) {
        const op = ri(3);
        const at = ri(w.length);
        if (op === 0) w[at] = ri(256);
        else if (op === 1) w[at] = w[at]! ^ (1 << ri(8));
        else w[at] = 0;
      }
      const cut = rnd() < 0.1 ? w.subarray(0, ri(w.length)) : w;
      const e = decodeEnvelope(cut);
      if (e) {
        accepted++;
        assert.ok(validateEnvelope(e));
      }
    }
    assert.ok(accepted < ITER, 'most mutations rejected');
  });
  it('무작위 바이트·깊은 중첩은 던지지 않는다', () => {
    for (let i = 0; i < ITER; i++) assert.equal(decodeEnvelope(randomBytes(1 + ri(300))), null);
    const deep = new Uint8Array(200).fill(0x81);
    assert.equal(decodeEnvelope(deep), null);
    assert.throws(() => decodeCbor(deep));
  });
  it('전송 프레임 무작위 입력은 null', () => {
    const t = new Transport({ send: randomBytes(32), recv: randomBytes(32) });
    for (let i = 0; i < ITER; i++) {
      const f = randomBytes(1 + ri(600));
      if (rnd() < 0.5) {
        f[0] = 1;
        f[1] = 2;
      }
      assert.equal(t.open(f), null);
    }
  });
});

describe('구조 변이', () => {
  const vals: unknown[] = [null, true, -1, 0, 1, 86, 2 ** 31, 2 ** 53, 1.5, '', 'x'.repeat(100), '가', [], {}, [1], { a: 1 }, 'AAAA', 'AAA=', '2026-02-30', '123-45-6789'];
  it(`offer·chunk 필드 무작위 치환 ${ITER}회: 통과하면 의미 규칙도 맞다`, () => {
    for (let i = 0; i < ITER; i++) {
      const base = samples[ri(2)]!;
      const body = { ...(base.body as Record<string, unknown>) };
      const keys = [...Object.keys(body), 'extra', 'candidates'];
      const k = keys[ri(keys.length)]!;
      if (rnd() < 0.2) delete body[k];
      else body[k] = vals[ri(vals.length)];
      const e = { ...base, body };
      let ok = false;
      try {
        ok = validateEnvelope(e);
      } catch (err) {
        assert.fail(`validate threw: ${String(err)}`);
      }
      if (ok && e.type === 'receipt.offer') {
        const b = body as typeof offer;
        assert.equal(b.chunkCount, Math.ceil(b.bytes / b.chunkSize));
        assert.ok(b.bytes <= 4194304);
      }
      if (ok) assert.deepEqual(decodeEnvelope(encodeEnvelope(e)), e);
    }
  });
});

describe('PC 수신 큐 무작위 순서', () => {
  it('무작위 순서·중복·가짜 청크를 섞어도 저장은 원본 sha와 같은 것뿐', async () => {
    const stored = new Map<string, string>();
    const sink = {
      hasReceipt: async (id: string) => stored.has(id),
      storeReceipt: async (r: { msgId: string; jpeg: Uint8Array }) => {
        stored.set(r.msgId, toHex(sha256Hash(r.jpeg)));
      },
      hasCash: async () => false,
      storeCash: async () => {},
    };
    const q = new ReceiveQueue(sink, { maxAssemblies: 3, maxBufferedBytes: 1024 * 1024 });
    const ch = { pairId: PAIR, closed: false, send: () => {} } as unknown as Channel;
    const photos = Array.from({ length: 5 }, (_, i) => {
      const j = fakeJpeg(RECEIPT_CHUNK * (1 + (i % 3)) + i * 11, 100 + i);
      return { j, o: makeReceiptOffer(j, { capturedAt: 1, ocrEngine: 'none', ownerConfirmed: false }) };
    });
    for (let step = 0; step < ITER; step++) {
      const p = photos[ri(photos.length)]!;
      const r = rnd();
      if (r < 0.15) await q.handle(ch, mk('receipt.offer', p.o));
      else if (r < 0.9) {
        const idx = ri(p.o.chunkCount);
        let data = p.j.subarray(idx * RECEIPT_CHUNK, Math.min(p.j.length, (idx + 1) * RECEIPT_CHUNK)).slice();
        if (rnd() < 0.1) data[ri(data.length)] ^= 0xff; // 내용 변조
        if (rnd() < 0.05) data = data.subarray(0, Math.max(1, data.length - 1)); // 크기 변조
        await q.handle(ch, mk('receipt.chunk', { msgId: p.o.msgId, index: idx, data: b64(data) }));
      } else await q.handle(ch, mk('receipt.chunk', { msgId: ulid(), index: ri(86), data: b64(randomBytes(10)) }));
      assert.ok(q.assembling <= 3);
    }
    for (const p of photos) if (stored.has(p.o.msgId)) assert.equal(stored.get(p.o.msgId), toHex(sha256Hash(p.j)));
    assert.ok(stored.size >= 1);
  });
});
