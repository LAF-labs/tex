// ULID(Crockford base32, 48비트 ms 시각 + 80비트 난수). 봉투 id·pairId·msgId.

import { randomBytes } from './crypto.ts';

const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function ulid(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 2 ** 48 - 1) throw new Error('ulid: time');
  let t = now;
  let ts = '';
  for (let i = 0; i < 10; i++) {
    ts = ALPHA[t % 32]! + ts;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(10);
  let bits = 0n;
  for (const x of r) bits = (bits << 8n) | BigInt(x);
  let rs = '';
  for (let i = 0; i < 16; i++) {
    rs = ALPHA[Number(bits & 31n)]! + rs;
    bits >>= 5n;
  }
  return ts + rs;
}

/** 무작위 UUIDv4(시각 없음, C-09). device_id. */
export function uuid4(): string {
  const b = randomBytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
