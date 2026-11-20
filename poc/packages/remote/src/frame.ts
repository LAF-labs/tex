
import { concat, u64be, readU64be, wipe } from './bytes.ts';
import { chachaOpen, chachaSeal, noiseNonce } from './crypto.ts';
import { NOISE_MAX_MSG } from './noise.ts';

export const FRAME_VER = 1;
export const KIND = { HS: 1, DATA: 2, ENV: 3 } as const;
export type FrameKind = (typeof KIND)[keyof typeof KIND];

const HS_HEADER = 4;
const DATA_HEADER = 12;
const TAG = 16;
/** DATA 평문(패딩 포함) 최대 = 65535 − 머리 12 − 태그 16. */
export const MAX_PADDED = NOISE_MAX_MSG - DATA_HEADER - TAG;
export const PAD_BUCKETS = [256, 512, 1024, 4096, 16384, MAX_PADDED] as const;
/** 패딩 표식(0x80) 1바이트를 뺀 inner 최대. */
export const MAX_INNER = MAX_PADDED - 1;

export const REKEY_INTERVAL = 2n ** 20n;
export const REPLAY_WINDOW = 1024n;

export function pad(inner: Uint8Array): Uint8Array {
  const need = inner.length + 1;
  const bucket = PAD_BUCKETS.find((b) => b >= need);
  if (bucket === undefined) throw new Error('frame: inner too large');
  const out = new Uint8Array(bucket);
  out.set(inner);
  out[inner.length] = 0x80;
  return out;
}

export function unpad(p: Uint8Array): Uint8Array | null {
  if (!PAD_BUCKETS.includes(p.length as (typeof PAD_BUCKETS)[number])) return null;
  let i = p.length - 1;
  while (i >= 0 && p[i] === 0) i--;
  if (i < 0 || p[i] !== 0x80) return null;
  return p.subarray(0, i);
}

function u16(n: number): Uint8Array {
  return Uint8Array.of((n >> 8) & 0xff, n & 0xff);
}

export function encodeHs(msg: Uint8Array): Uint8Array {
  if (msg.length > NOISE_MAX_MSG - HS_HEADER) throw new Error('frame: hs too large');
  return concat(Uint8Array.of(FRAME_VER, KIND.HS), u16(msg.length), msg);
}

export interface ParsedFrame {
  kind: FrameKind;
  ctr?: bigint;
  header: Uint8Array;
  body: Uint8Array;
}

/** 바깥 머리만 해석한다. 형식이 틀리면 null(조용히 버림). */
export function parseFrame(f: Uint8Array): ParsedFrame | null {
  if (f.length < HS_HEADER || f.length > NOISE_MAX_MSG) return null;
  if (f[0] !== FRAME_VER) return null;
  const kind = f[1];
  if (kind === KIND.HS || kind === KIND.ENV) {
    const len = (f[2]! << 8) | f[3]!;
    if (len !== f.length - HS_HEADER) return null;
    return { kind, header: f.subarray(0, HS_HEADER), body: f.subarray(HS_HEADER) };
  }
  if (kind === KIND.DATA) {
    if (f.length < DATA_HEADER + TAG) return null;
    const ctr = readU64be(f, 2);
    const len = (f[10]! << 8) | f[11]!;
    if (len !== f.length - DATA_HEADER) return null;
    return { kind, ctr, header: f.subarray(0, DATA_HEADER), body: f.subarray(DATA_HEADER) };
  }
  return null;
}

function rekey(k: Uint8Array): Uint8Array {
  return chachaSeal(k, noiseNonce(2n ** 64n - 1n), new Uint8Array(), new Uint8Array(32)).slice(0, 32);
}

class EpochKeys {
  #epoch = 0n;
  #cur: Uint8Array;
  #prev: Uint8Array | null = null;
  constructor(k: Uint8Array) {
    this.#cur = k.slice();
  }
  forSend(epoch: bigint): Uint8Array {
    while (this.#epoch < epoch) this.#advance();
    if (epoch !== this.#epoch) throw new Error('frame: epoch went backwards');
    return this.#cur;
  }
  peek(epoch: bigint): { key: Uint8Array; commit: () => void } | null {
    if (epoch === this.#epoch) return { key: this.#cur, commit: () => {} };
    if (epoch + 1n === this.#epoch && this.#prev) return { key: this.#prev, commit: () => {} };
    if (epoch === this.#epoch + 1n) {
      const next = rekey(this.#cur);
      return { key: next, commit: () => this.#advanceTo(next) };
    }
    return null;
  }
  #advance(): void {
    this.#advanceTo(rekey(this.#cur));
  }
  #advanceTo(next: Uint8Array): void {
    wipe(this.#prev ?? undefined);
    this.#prev = this.#cur;
    this.#cur = next;
    this.#epoch++;
  }
  destroy(): void {
    wipe(this.#cur);
    wipe(this.#prev ?? undefined);
  }
}

/** DATA 프레임 송수신(라이브 세션 1개). Noise split 키를 받는다. */
export class Transport {
  #tx: EpochKeys;
  #rx: EpochKeys;
  #ctr = 0n;
  #top = -1n;
  #seen = new Set<bigint>();

  constructor(keys: { send: Uint8Array; recv: Uint8Array }) {
    this.#tx = new EpochKeys(keys.send);
    this.#rx = new EpochKeys(keys.recv);
  }

  seal(inner: Uint8Array): Uint8Array {
    const ctr = this.#ctr++;
    const p = pad(inner);
    const header = concat(Uint8Array.of(FRAME_VER, KIND.DATA), u64be(ctr), u16(p.length + TAG));
    const key = this.#tx.forSend(ctr / REKEY_INTERVAL);
    return concat(header, chachaSeal(key, noiseNonce(ctr), header, p));
  }

  open(frame: Uint8Array): Uint8Array | null {
    const f = parseFrame(frame);
    if (!f || f.kind !== KIND.DATA || f.ctr === undefined) return null;
    const ctr = f.ctr;
    if (ctr >= 2n ** 64n - 1n) return null;
    if (ctr <= this.#top && (this.#top - ctr >= REPLAY_WINDOW || this.#seen.has(ctr))) return null;
    const k = this.#rx.peek(ctr / REKEY_INTERVAL);
    if (!k) return null;
    let p: Uint8Array;
    try {
      p = chachaOpen(k.key, noiseNonce(ctr), f.header, f.body);
    } catch {
      return null;
    }
    const inner = unpad(p);
    if (!inner) return null;
    k.commit();
    this.#mark(ctr);
    return inner.slice();
  }

  #mark(ctr: bigint): void {
    if (ctr > this.#top) this.#top = ctr;
    this.#seen.add(ctr);
    if (this.#seen.size > Number(REPLAY_WINDOW) * 2) {
      for (const c of this.#seen) if (this.#top - c >= REPLAY_WINDOW) this.#seen.delete(c);
    }
  }

  _testSetSendCtr(ctr: bigint): void {
    this.#ctr = ctr;
  }

  destroy(): void {
    this.#tx.destroy();
    this.#rx.destroy();
  }
}
