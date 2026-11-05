// WebAuthn용 최소 CBOR 디코더(RFC 8949, 정한 길이만). attestationObject·COSE 키만 읽는다. 깊이·길이 상한으로 거부한다.
export class CborError extends Error {}

const MAX_DEPTH = 8;

export function decodeCbor(buf: Buffer): { value: unknown; rest: Buffer } {
  let off = 0;
  const need = (n: number) => {
    if (off + n > buf.length) throw new CborError('truncated');
  };
  const readLen = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) {
      need(1);
      return buf.readUInt8(off++);
    }
    if (info === 25) {
      need(2);
      const v = buf.readUInt16BE(off);
      off += 2;
      return v;
    }
    if (info === 26) {
      need(4);
      const v = buf.readUInt32BE(off);
      off += 4;
      return v;
    }
    if (info === 27) {
      need(8);
      const v = buf.readBigUInt64BE(off);
      off += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new CborError('too_big');
      return Number(v);
    }
    throw new CborError('indefinite');
  };
  const item = (depth: number): unknown => {
    if (depth > MAX_DEPTH) throw new CborError('depth');
    need(1);
    const b = buf.readUInt8(off++);
    const major = b >> 5;
    const info = b & 31;
    switch (major) {
      case 0:
        return readLen(info);
      case 1:
        return -1 - readLen(info);
      case 2: {
        const n = readLen(info);
        need(n);
        const v = Buffer.from(buf.subarray(off, off + n));
        off += n;
        return v;
      }
      case 3: {
        const n = readLen(info);
        need(n);
        const v = buf.toString('utf8', off, off + n);
        off += n;
        return v;
      }
      case 4: {
        const n = readLen(info);
        if (n > 64) throw new CborError('array_len');
        return Array.from({ length: n }, () => item(depth + 1));
      }
      case 5: {
        const n = readLen(info);
        if (n > 64) throw new CborError('map_len');
        const m = new Map<unknown, unknown>();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          m.set(k, item(depth + 1));
        }
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new CborError('simple');
      default:
        throw new CborError('tag');
    }
  };
  const value = item(0);
  return { value, rest: buf.subarray(off) };
}

/** 시험용 최소 인코더(정수·바이트·문자열·배열·Map). */
export function encodeCbor(v: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(n, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encodeCbor)]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [encodeCbor(k), encodeCbor(x)])]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === false) return Buffer.from([0xf4]);
  if (v === null) return Buffer.from([0xf6]);
  throw new Error('cbor_type');
}
