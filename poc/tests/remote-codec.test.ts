// D08 §6 바탕: 결정적 CBOR, 정규형 base64, ULID, 패딩 버킷, ctr 창, 결정적 rekey, 변조 거부.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MAX_INNER, PAD_BUCKETS, REKEY_INTERVAL, Transport, ULID_RE, b64, decodeCbor, encodeCbor, encodeHs, fromB64, fromHex, pad, parseFrame, randomBytes, toHex,
  ulid, unpad, uuid4,
} from '@sax/remote';

describe('결정적 CBOR', () => {
  it('맵 키는 정렬되고 같은 값은 같은 바이트', () => {
    const a = encodeCbor({ b: 1, a: [true, null, 'x'], c: new Uint8Array([1, 2]) });
    const b = encodeCbor({ c: new Uint8Array([1, 2]), a: [true, null, 'x'], b: 1 });
    assert.equal(toHex(a), toHex(b));
    assert.deepEqual(decodeCbor(a), { a: [true, null, 'x'], b: 1, c: new Uint8Array([1, 2]) });
  });
  it('RFC 8949 예시 값', () => {
    assert.equal(toHex(encodeCbor(0)), '00');
    assert.equal(toHex(encodeCbor(23)), '17');
    assert.equal(toHex(encodeCbor(24)), '1818');
    assert.equal(toHex(encodeCbor(1000000)), '1a000f4240');
    assert.equal(toHex(encodeCbor(-1000)), '3903e7');
    assert.equal(toHex(encodeCbor('IETF')), '6449455446');
    assert.equal(toHex(encodeCbor(9007199254740991)), '1b001fffffffffffff');
  });
  it('엄격 디코딩: 최단 아님·정렬 안 됨·중복 키·남는 바이트·실수·무한 길이를 거부', () => {
    for (const hex of ['1817', '190017', 'a2616201616101', 'a2616101616102', '0000', 'f93c00', '9fff', '5f40ff', 'a1010203']) {
      assert.throws(() => decodeCbor(fromHex(hex)), hex);
    }
  });
  it('실수·큰 정수는 인코딩하지 않는다', () => {
    assert.throws(() => encodeCbor(1.5));
    assert.throws(() => encodeCbor(2 ** 60));
  });
  it('깊이·항목 수 상한', () => {
    let v: unknown = 1;
    for (let i = 0; i < 20; i++) v = [v];
    assert.throws(() => encodeCbor(v as never));
    const big = new Uint8Array([0x9a, 0x00, 0x10, 0x00, 0x00]);
    assert.throws(() => decodeCbor(big));
  });
});

describe('base64 정규형', () => {
  it('왕복과 비정규형 거부', () => {
    for (let n = 0; n < 40; n++) {
      const b = randomBytes(n);
      assert.deepEqual(fromB64(b64(b)), b);
    }
    assert.throws(() => fromB64('AB=='.replace('B', 'C')) /* 남는 비트 */);
    assert.throws(() => fromB64('AAA'));
    assert.throws(() => fromB64('AA*A'));
  });
});

describe('식별자', () => {
  it('ULID 형식·시각 순서, UUIDv4', () => {
    const a = ulid(1_700_000_000_000);
    const b = ulid(1_700_000_000_001);
    assert.match(a, ULID_RE);
    assert.ok(a.slice(0, 10) < b.slice(0, 10));
    assert.match(uuid4(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('패딩 버킷(ISO/IEC 7816-4)', () => {
  it('버킷 크기로만 나가고 되돌아온다', () => {
    for (const n of [0, 1, 254, 255, 256, 600, 4000, 16383, MAX_INNER]) {
      const p = pad(new Uint8Array(n).fill(9));
      assert.ok((PAD_BUCKETS as readonly number[]).includes(p.length), `${n} -> ${p.length}`);
      assert.equal(unpad(p)!.length, n);
    }
    assert.throws(() => pad(new Uint8Array(MAX_INNER + 1)));
    assert.equal(unpad(new Uint8Array(256)), null);
  });
});

function pair() {
  const k1 = randomBytes(32), k2 = randomBytes(32);
  return { a: new Transport({ send: k1, recv: k2 }), b: new Transport({ send: k2, recv: k1 }) };
}

describe('전송 프레임', () => {
  it('왕복, 바깥 머리에 ctr·길이만 보인다', () => {
    const { a, b } = pair();
    const f = a.seal(new TextEncoder().encode('비밀 아님 확인용'));
    const p = parseFrame(f)!;
    assert.equal(p.kind, 2);
    assert.equal(p.ctr, 0n);
    assert.equal(f.length, 12 + 256 + 16);
    assert.equal(new TextDecoder().decode(b.open(f)!), '비밀 아님 확인용');
  });
  it('재전송은 버리고, 1024 창 안의 역전은 받는다', () => {
    const { a, b } = pair();
    const fs = Array.from({ length: 5 }, (_, i) => a.seal(Uint8Array.of(i)));
    assert.ok(b.open(fs[4]!));
    assert.equal(b.open(fs[4]!), null, 'replay');
    assert.ok(b.open(fs[1]!), 'reorder within window');
    assert.equal(b.open(fs[1]!), null);
  });
  it('창 밖의 오래된 프레임은 버린다', () => {
    const { a, b } = pair();
    const old = a.seal(Uint8Array.of(1));
    for (let i = 0; i < 1100; i++) assert.ok(b.open(a.seal(Uint8Array.of(2))));
    assert.equal(b.open(old), null);
  });
  it('변조(머리·본문)·다른 키는 조용히 null', () => {
    const { a, b } = pair();
    const f = a.seal(Uint8Array.of(1, 2, 3));
    for (const i of [1, 5, 11, 12, f.length - 1]) {
      const g = f.slice();
      g[i] = g[i]! ^ 0x80;
      assert.equal(b.open(g), null, `byte ${i}`);
    }
    const other = pair();
    assert.equal(other.b.open(f), null);
    assert.equal(b.open(encodeHs(Uint8Array.of(1))), null, 'HS frame on data channel');
  });
  it('ctr가 2^20 경계를 넘을 때 양쪽이 같은 rekey를 한다', () => {
    const { a, b } = pair();
    a._testSetSendCtr(REKEY_INTERVAL - 2n);
    const f1 = a.seal(Uint8Array.of(1));
    const f2 = a.seal(Uint8Array.of(2));
    const f3 = a.seal(Uint8Array.of(3)); // 새 epoch
    const f4 = a.seal(Uint8Array.of(4));
    assert.deepEqual(b.open(f3), Uint8Array.of(3));
    assert.deepEqual(b.open(f1), Uint8Array.of(1), '직전 epoch도 창 안이면 연다');
    assert.deepEqual(b.open(f4), Uint8Array.of(4));
    assert.deepEqual(b.open(f2), Uint8Array.of(2));
  });
  it('epoch를 두 칸 건너뛴 프레임은 버린다', () => {
    const { a, b } = pair();
    a._testSetSendCtr(REKEY_INTERVAL * 2n);
    assert.equal(b.open(a.seal(Uint8Array.of(1))), null);
  });
});
