// Noise 프레임워크(rev 34) 핸드셰이크: 25519 / ChaChaPoly / BLAKE2b. D08 §2·§4·§5.
// 페어링 Noise_XXpsk0(개시자 폰), 상시 세션 Noise_IK(개시자 폰). 정적키 DH는 NoiseStatic(데스크톱은 금고)로 한다.
// 시험 벡터(cacophony·snow)로 XX·XXpsk3·XXpsk0+psk1·IK를 확인한다(tests/remote-noise.test.ts).

import { concat, equal, utf8, wipe } from './bytes.ts';
import { blake2b512, chachaOpen, chachaSeal, hmacBlake2b, noiseNonce, x25519Dh, x25519Keygen, x25519Public } from './crypto.ts';
import type { NoiseCtx } from './contexts.ts';
import type { NoiseStatic } from './keys.ts';

const HASHLEN = 64;
const DHLEN = 32;
export const NOISE_MAX_MSG = 65535;
const MAX_NONCE = 2n ** 64n - 1n;

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';
type Pattern = 'XX' | 'IK';

const PATTERNS: Record<Pattern, { pre: { init: Token[]; resp: Token[] }; msgs: Token[][] }> = {
  XX: { pre: { init: [], resp: [] }, msgs: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']] },
  IK: { pre: { init: [], resp: ['s'] }, msgs: [['e', 'es', 's', 'ss'], ['e', 'ee', 'se']] },
};

export function protocolName(pattern: Pattern, psks: readonly number[] = []): string {
  const mod = psks.length ? psks.map((p) => `psk${p}`).join('+') : '';
  return `Noise_${pattern}${mod}_25519_ChaChaPoly_BLAKE2b`;
}

function hkdf(ck: Uint8Array, ikm: Uint8Array, n: 2 | 3): Uint8Array[] {
  const tk = hmacBlake2b(ck, ikm);
  const o1 = hmacBlake2b(tk, Uint8Array.of(1));
  const o2 = hmacBlake2b(tk, concat(o1, Uint8Array.of(2)));
  if (n === 2) return [o1, o2];
  return [o1, o2, hmacBlake2b(tk, concat(o2, Uint8Array.of(3)))];
}

/** Noise 표준 CipherState(암시적 논스). 핸드셰이크 안과 시험 벡터 대조에 쓴다. */
export class CipherState {
  #k: Uint8Array | null;
  #n = 0n;
  constructor(k: Uint8Array | null = null) {
    this.#k = k;
  }
  hasKey(): boolean {
    return this.#k !== null;
  }
  encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    if (!this.#k) return pt;
    if (this.#n >= MAX_NONCE) throw new Error('noise: nonce exhausted');
    return chachaSeal(this.#k, noiseNonce(this.#n++), ad, pt);
  }
  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array {
    if (!this.#k) return ct;
    if (this.#n >= MAX_NONCE) throw new Error('noise: nonce exhausted');
    const pt = chachaOpen(this.#k, noiseNonce(this.#n), ad, ct);
    this.#n++;
    return pt;
  }
  /** 키 사본(전송 계층으로 넘길 때만). */
  key(): Uint8Array {
    if (!this.#k) throw new Error('noise: no key');
    return this.#k.slice();
  }
  destroy(): void {
    wipe(this.#k ?? undefined);
    this.#k = null;
  }
}

export interface HandshakeOptions {
  pattern: Pattern;
  /** psk 수정자 위치. 페어링은 [0]. */
  psks?: readonly number[];
  initiator: boolean;
  prologue: Uint8Array;
  s: NoiseStatic;
  /** 사전 공유 상대 정적키(IK 개시자). */
  rs?: Uint8Array;
  /** psk 토큰마다 차례로 쓴다. 32B. */
  psk?: readonly Uint8Array[];
  ctx: NoiseCtx;
  /** 시험 벡터 전용: 임시 비밀키 고정. 제품 코드에서 넘기지 않는다. */
  testEphemeral?: Uint8Array;
}

export class Handshake {
  readonly initiator: boolean;
  #msgs: Token[][];
  #idx = 0;
  #ck: Uint8Array;
  #h: Uint8Array;
  #cs = new CipherState();
  #s: NoiseStatic;
  #e: { secretKey: Uint8Array; publicKey: Uint8Array } | null = null;
  #rs: Uint8Array | null;
  #re: Uint8Array | null = null;
  #psks: Uint8Array[];
  #hasPsk: boolean;
  #ctx: NoiseCtx;
  #testE: Uint8Array | undefined;
  #done = false;

  constructor(o: HandshakeOptions) {
    const p = PATTERNS[o.pattern];
    const psks = [...(o.psks ?? [])];
    this.#msgs = p.msgs.map((m) => [...m]);
    for (const n of psks) {
      if (n === 0) this.#msgs[0]!.unshift('psk');
      else if (n <= this.#msgs.length) this.#msgs[n - 1]!.push('psk');
      else throw new Error('noise: bad psk position');
    }
    this.#hasPsk = psks.length > 0;
    this.#psks = (o.psk ?? []).map((x) => {
      if (x.length !== 32) throw new Error('noise: psk must be 32 bytes');
      return x.slice();
    });
    const tokensNeeded = this.#msgs.flat().filter((t) => t === 'psk').length;
    if (this.#psks.length !== tokensNeeded) throw new Error('noise: psk count');
    this.initiator = o.initiator;
    this.#s = o.s;
    this.#rs = o.rs ? o.rs.slice() : null;
    this.#ctx = o.ctx;
    this.#testE = o.testEphemeral;
    const name = utf8(protocolName(o.pattern, psks));
    this.#h = name.length <= HASHLEN ? concat(name, new Uint8Array(HASHLEN - name.length)) : blake2b512(name);
    this.#ck = this.#h.slice();
    this.#mixHash(o.prologue);
    // 사전 메시지: IK는 응답자 정적키를 양쪽이 미리 안다.
    for (const t of p.pre.init) if (t === 's') this.#mixHash(this.initiator ? this.#s.publicKey : this.#need(this.#rs));
    for (const t of p.pre.resp) if (t === 's') this.#mixHash(this.initiator ? this.#need(this.#rs) : this.#s.publicKey);
  }

  #need<T>(x: T | null): T {
    if (x === null) throw new Error('noise: missing key');
    return x;
  }
  #mixHash(d: Uint8Array): void {
    this.#h = blake2b512(concat(this.#h, d));
  }
  #mixKey(ikm: Uint8Array): void {
    const [ck, tk] = hkdf(this.#ck, ikm, 2);
    this.#ck = ck!;
    this.#cs.destroy();
    this.#cs = new CipherState(tk!.slice(0, 32));
  }
  #mixKeyAndHash(ikm: Uint8Array): void {
    const [ck, th, tk] = hkdf(this.#ck, ikm, 3);
    this.#ck = ck!;
    this.#mixHash(th!);
    this.#cs.destroy();
    this.#cs = new CipherState(tk!.slice(0, 32));
  }
  #encryptAndHash(pt: Uint8Array): Uint8Array {
    const ct = this.#cs.encrypt(this.#h, pt);
    this.#mixHash(ct);
    return ct;
  }
  #decryptAndHash(ct: Uint8Array): Uint8Array {
    const pt = this.#cs.decrypt(this.#h, ct);
    this.#mixHash(ct);
    return pt;
  }
  async #dh(token: 'ee' | 'es' | 'se' | 'ss'): Promise<Uint8Array> {
    const e = () => this.#need(this.#e).secretKey;
    const re = () => this.#need(this.#re);
    const rs = () => this.#need(this.#rs);
    // es: 개시자의 e × 응답자의 s, se: 개시자의 s × 응답자의 e.
    switch (token) {
      case 'ee':
        return x25519Dh(e(), re());
      case 'ss':
        return this.#s.dh(rs(), this.#ctx);
      case 'es':
        return this.initiator ? x25519Dh(e(), rs()) : this.#s.dh(re(), this.#ctx);
      case 'se':
        return this.initiator ? this.#s.dh(re(), this.#ctx) : x25519Dh(e(), rs());
    }
  }

  get myTurn(): boolean {
    return !this.#done && (this.#idx % 2 === 0) === this.initiator;
  }
  get complete(): boolean {
    return this.#done;
  }
  /** 핸드셰이크 해시 h(완료 뒤). SAS·채널 바인딩에만 쓴다(D08 §4.2 5단계·7단계). */
  get handshakeHash(): Uint8Array {
    if (!this.#done) throw new Error('noise: handshake not complete');
    return this.#h.slice();
  }
  /** 상대 정적키(받은 뒤). */
  get remoteStatic(): Uint8Array | null {
    return this.#rs ? this.#rs.slice() : null;
  }

  async writeMessage(payload: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    if (!this.myTurn) throw new Error('noise: not my turn');
    const out: Uint8Array[] = [];
    for (const t of this.#msgs[this.#idx]!) {
      if (t === 'e') {
        if (this.#testE) this.#e = { secretKey: this.#testE.slice(), publicKey: x25519Public(this.#testE) };
        else this.#e = x25519Keygen();
        out.push(this.#e.publicKey);
        this.#mixHash(this.#e.publicKey);
        if (this.#hasPsk) this.#mixKey(this.#e.publicKey);
      } else if (t === 's') out.push(this.#encryptAndHash(this.#s.publicKey));
      else if (t === 'psk') this.#mixKeyAndHash(this.#psks.shift()!);
      else this.#mixKey(await this.#dh(t));
    }
    out.push(this.#encryptAndHash(payload));
    const msg = concat(...out);
    if (msg.length > NOISE_MAX_MSG) throw new Error('noise: message too long');
    this.#advance();
    return msg;
  }

  async readMessage(msg: Uint8Array): Promise<Uint8Array> {
    if (this.#done || this.myTurn) throw new Error('noise: not their turn');
    if (msg.length > NOISE_MAX_MSG) throw new Error('noise: message too long');
    let off = 0;
    const take = (n: number) => {
      if (off + n > msg.length) throw new Error('noise: short message');
      const x = msg.subarray(off, off + n);
      off += n;
      return x;
    };
    for (const t of this.#msgs[this.#idx]!) {
      if (t === 'e') {
        const re = take(DHLEN).slice();
        this.#re = re;
        this.#mixHash(re);
        if (this.#hasPsk) this.#mixKey(re);
      } else if (t === 's') {
        const len = this.#cs.hasKey() ? DHLEN + 16 : DHLEN;
        const rs = this.#decryptAndHash(take(len));
        if (this.#rs && !equal(this.#rs, rs)) throw new Error('noise: unexpected remote static');
        this.#rs = rs;
      } else if (t === 'psk') this.#mixKeyAndHash(this.#psks.shift()!);
      else this.#mixKey(await this.#dh(t));
    }
    const payload = this.#decryptAndHash(msg.subarray(off));
    this.#advance();
    return payload;
  }

  #advance(): void {
    this.#idx++;
    if (this.#idx === this.#msgs.length) this.#done = true;
  }

  /** 전송 키 [개시자→응답자, 응답자→개시자]. 내 송신·수신 순서로 돌려준다. 임시키는 지운다. */
  split(): { send: Uint8Array; recv: Uint8Array } {
    if (!this.#done) throw new Error('noise: handshake not complete');
    const [k1, k2] = hkdf(this.#ck, new Uint8Array(), 2);
    const i2r = k1!.slice(0, 32);
    const r2i = k2!.slice(0, 32);
    if (this.#e) wipe(this.#e.secretKey);
    this.#cs.destroy();
    for (const p of this.#psks) wipe(p);
    wipe(this.#ck);
    return this.initiator ? { send: i2r, recv: r2i } : { send: r2i, recv: i2r };
  }
}
