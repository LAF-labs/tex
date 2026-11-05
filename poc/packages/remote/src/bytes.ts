// 바이트 유틸. Node Buffer를 쓰지 않는다(폰 Hermes에서도 돈다).

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: true });

export const utf8 = (s: string): Uint8Array => enc.encode(s);
export const fromUtf8 = (b: Uint8Array): string => dec.decode(b);

export function concat(...parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 상수 시간 비교(길이가 다르면 바로 false). */
export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

export function wipe(b: Uint8Array | undefined): void {
  if (b) b.fill(0);
}

export function u64le(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), true);
  return out;
}

export function u64be(n: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

export function readU64be(b: Uint8Array, off: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(off, false);
}

const HEX = '0123456789abcdef';
export function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += HEX[x >> 4]! + HEX[x & 15]!;
  return s;
}
export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) throw new Error('hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_INV = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) m[B64.charCodeAt(i)] = i;
  return m;
})();
const B64URL_INV = (() => {
  const m = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) m[B64URL.charCodeAt(i)] = i;
  return m;
})();

function encode64(b: Uint8Array, alpha: string, pad: boolean): string {
  let s = '';
  let i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8) | b[i + 2]!;
    s += alpha[n >> 18]! + alpha[(n >> 12) & 63]! + alpha[(n >> 6) & 63]! + alpha[n & 63]!;
  }
  const rest = b.length - i;
  if (rest === 1) {
    const n = b[i]! << 16;
    s += alpha[n >> 18]! + alpha[(n >> 12) & 63]! + (pad ? '==' : '');
  } else if (rest === 2) {
    const n = (b[i]! << 16) | (b[i + 1]! << 8);
    s += alpha[n >> 18]! + alpha[(n >> 12) & 63]! + alpha[(n >> 6) & 63]! + (pad ? '=' : '');
  }
  return s;
}

function decode64(s: string, inv: Int16Array, pad: boolean): Uint8Array {
  let body = s;
  if (pad) {
    if (s.length % 4 !== 0) throw new Error('base64 length');
    if (s.endsWith('==')) body = s.slice(0, -2);
    else if (s.endsWith('=')) body = s.slice(0, -1);
  }
  if (body.length % 4 === 1) throw new Error('base64 length');
  const out = new Uint8Array(Math.floor((body.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const v = c < 128 ? inv[c]! : -1;
    if (v < 0) throw new Error('base64 char');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  // 남은 비트가 0이 아니면 정규형이 아니다(같은 바이트에 둘 이상의 표기를 허용하지 않는다).
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) throw new Error('base64 non-canonical');
  return out;
}

/** 표준 base64(패딩 있음). 스키마의 b64 필드 표기. */
export const b64 = (b: Uint8Array): string => encode64(b, B64, true);
/** 정규형 base64만 받는다(다시 인코딩하면 같은 문자열). */
export const fromB64 = (s: string): Uint8Array => decode64(s, B64_INV, true);
export const b64url = (b: Uint8Array): string => encode64(b, B64URL, false);
export const fromB64url = (s: string): Uint8Array => decode64(s, B64URL_INV, false);
