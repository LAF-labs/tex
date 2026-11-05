// 결정적 CBOR(RFC 8949 §4.2.1 core deterministic) 부분집합. D08 §6 inner, 서명 입력의 canonical 인코딩.
// 지원: 정수(안전 정수 범위), 바이트열, 문자열, 배열, 문자열 키 맵, true/false/null. 실수·태그·무한 길이는 거부.
// 디코더는 엄격하다: 최단 길이 아닌 정수, 정렬되지 않았거나 겹친 키, 남는 바이트를 거부한다(같은 값에 표기 하나).

import { concat, fromUtf8, utf8 } from './bytes.ts';

export type CborValue = number | string | boolean | null | Uint8Array | CborValue[] | { [k: string]: CborValue };

const MAX_DEPTH = 16;

function head(major: number, n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('cbor: length/int out of range');
  const m = major << 5;
  if (n < 24) return Uint8Array.of(m | n);
  if (n < 0x100) return Uint8Array.of(m | 24, n);
  if (n < 0x10000) return Uint8Array.of(m | 25, n >> 8, n & 0xff);
  if (n < 0x100000000) return Uint8Array.of(m | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  const out = new Uint8Array(9);
  out[0] = m | 27;
  new DataView(out.buffer).setBigUint64(1, BigInt(n), false);
  return out;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function enc(v: CborValue | undefined, depth: number): Uint8Array {
  if (depth > MAX_DEPTH) throw new Error('cbor: too deep');
  if (v === null) return Uint8Array.of(0xf6);
  if (v === true) return Uint8Array.of(0xf5);
  if (v === false) return Uint8Array.of(0xf4);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('cbor: only safe integers');
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  }
  if (typeof v === 'string') {
    const b = utf8(v);
    return concat(head(3, b.length), b);
  }
  if (v instanceof Uint8Array) return concat(head(2, v.length), v);
  if (Array.isArray(v)) return concat(head(4, v.length), ...v.map((x) => enc(x, depth + 1)));
  if (typeof v === 'object') {
    const entries: [Uint8Array, Uint8Array][] = [];
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) continue;
      entries.push([enc(k, depth + 1), enc(x, depth + 1)]);
    }
    entries.sort((a, b) => cmpBytes(a[0], b[0]));
    return concat(head(5, entries.length), ...entries.flat());
  }
  throw new Error(`cbor: unsupported ${typeof v}`);
}

export function encodeCbor(v: CborValue): Uint8Array {
  return enc(v, 0);
}

export interface DecodeLimits {
  maxBytes?: number;
  maxItems?: number;
}

export function decodeCbor(b: Uint8Array, limits: DecodeLimits = {}): CborValue {
  const maxItems = limits.maxItems ?? 4096;
  if (limits.maxBytes !== undefined && b.length > limits.maxBytes) throw new Error('cbor: too large');
  let pos = 0;
  let items = 0;
  const need = (n: number) => {
    if (pos + n > b.length) throw new Error('cbor: truncated');
  };
  const readArg = (info: number): number => {
    if (info < 24) return info;
    let n: number;
    if (info === 24) {
      need(1);
      n = b[pos]!;
      pos += 1;
      if (n < 24) throw new Error('cbor: non-shortest');
    } else if (info === 25) {
      need(2);
      n = (b[pos]! << 8) | b[pos + 1]!;
      pos += 2;
      if (n < 0x100) throw new Error('cbor: non-shortest');
    } else if (info === 26) {
      need(4);
      n = ((b[pos]! << 24) >>> 0) + (b[pos + 1]! << 16) + (b[pos + 2]! << 8) + b[pos + 3]!;
      pos += 4;
      if (n < 0x10000) throw new Error('cbor: non-shortest');
    } else if (info === 27) {
      need(8);
      const big = new DataView(b.buffer, b.byteOffset + pos, 8).getBigUint64(0, false);
      pos += 8;
      if (big < 0x100000000n || big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('cbor: int range');
      n = Number(big);
    } else throw new Error('cbor: indefinite or reserved');
    return n;
  };
  const dec = (depth: number): CborValue => {
    if (depth > MAX_DEPTH) throw new Error('cbor: too deep');
    if (++items > maxItems) throw new Error('cbor: too many items');
    need(1);
    const ib = b[pos++]!;
    const major = ib >> 5;
    const info = ib & 31;
    switch (major) {
      case 0:
        return readArg(info);
      case 1:
        return -1 - readArg(info);
      case 2: {
        const n = readArg(info);
        need(n);
        const out = b.slice(pos, pos + n);
        pos += n;
        return out;
      }
      case 3: {
        const n = readArg(info);
        need(n);
        const s = fromUtf8(b.subarray(pos, pos + n));
        pos += n;
        return s;
      }
      case 4: {
        const n = readArg(info);
        if (n > maxItems) throw new Error('cbor: too many items');
        const arr: CborValue[] = [];
        for (let i = 0; i < n; i++) arr.push(dec(depth + 1));
        return arr;
      }
      case 5: {
        const n = readArg(info);
        if (n > maxItems) throw new Error('cbor: too many items');
        const obj: { [k: string]: CborValue } = Object.create(null);
        let prev: Uint8Array | null = null;
        for (let i = 0; i < n; i++) {
          const kStart = pos;
          const k = dec(depth + 1);
          if (typeof k !== 'string') throw new Error('cbor: map key must be text');
          const kBytes = b.subarray(kStart, pos);
          if (prev && cmpBytes(prev, kBytes) >= 0) throw new Error('cbor: map keys not sorted or duplicated');
          prev = kBytes;
          if (k === '__proto__') throw new Error('cbor: forbidden key');
          obj[k] = dec(depth + 1);
        }
        return { ...obj };
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('cbor: unsupported simple/float');
      default:
        throw new Error('cbor: unsupported major type');
    }
  };
  const v = dec(0);
  if (pos !== b.length) throw new Error('cbor: trailing bytes');
  return v;
}
