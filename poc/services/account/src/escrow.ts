import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto';
import { key32 } from '@sax/svc-shared';

export const RK_ESCROW_INFO = 'SAX-rk-escrow-v1';
const STORE_AAD = 'SAX-rk-escrow-store-v1';
const CLAIM_AAD = 'SAX-rk-escrow-claim-v1';

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

const rawPublic = (priv: KeyObject): Buffer => {
  const der = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
};
const x25519Priv = (seed: Uint8Array) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });

function dh(priv: KeyObject, pub: Uint8Array): Buffer {
  let out: Buffer;
  try {
    out = diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, pub]), format: 'der', type: 'spki' }) });
  } catch {
    throw new Error('bad_point');
  }
  if (out.every((b) => b === 0)) throw new Error('bad_point');
  return out;
}

const i2osp = (n: number, len: number) => {
  const b = Buffer.alloc(len);
  b.writeUIntBE(n, 0, len);
  return b;
};
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(0x0020, 2)]);
const HPKE_SUITE = Buffer.concat([Buffer.from('HPKE'), i2osp(0x0020, 2), i2osp(0x0001, 2), i2osp(0x0003, 2)]);
const EMPTY = Buffer.alloc(0);

const extract = (salt: Uint8Array, ikm: Uint8Array) => createHmac('sha256', salt).update(ikm).digest();
function expand(prk: Uint8Array, info: Uint8Array, len: number): Buffer {
  const out: Buffer[] = [];
  let t: Buffer = EMPTY;
  for (let i = 1; out.length * 32 < len; i++) {
    t = createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, len);
}
const labeledExtract = (suite: Buffer, salt: Uint8Array, label: string, ikm: Uint8Array) => extract(salt, Buffer.concat([Buffer.from('HPKE-v1'), suite, Buffer.from(label), ikm]));
const labeledExpand = (suite: Buffer, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(prk, Buffer.concat([i2osp(len, 2), Buffer.from('HPKE-v1'), suite, Buffer.from(label), info]), len);

function hpkeKeys(shared0: Buffer, encap: Uint8Array, pkR: Uint8Array, info: Uint8Array): { key: Buffer; nonce: Buffer } {
  const eaePrk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', shared0);
  const shared = labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', Buffer.concat([encap, pkR]), 32);
  const ksContext = Buffer.concat([Buffer.from([0]), labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY), labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info)]);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', EMPTY);
  try {
    return { key: labeledExpand(HPKE_SUITE, secret, 'key', ksContext, 32), nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', ksContext, 12) };
  } finally {
    for (const b of [shared0, eaePrk, shared, secret]) b.fill(0);
  }
}

/** 단발 봉인. 결과 {enc 32B, ct = 암호문 ‖ 태그 16B}. skE는 시험 벡터용이다. */
export function hpkeSeal(pkR: Uint8Array, info: Uint8Array, aad: Uint8Array, pt: Uint8Array, skE?: Uint8Array): { enc: Buffer; ct: Buffer } {
  const seed = skE ? Buffer.from(skE) : randomBytes(32);
  try {
    const e = x25519Priv(seed);
    const enc = rawPublic(e);
    const { key, nonce } = hpkeKeys(dh(e, pkR), enc, pkR, info);
    try {
      const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      c.setAAD(aad, { plaintextLength: pt.length });
      return { enc, ct: Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]) };
    } finally {
      key.fill(0);
    }
  } finally {
    seed.fill(0);
  }
}

/** 단발 개봉. 실패는 Error('open_failed'). */
export function hpkeOpen(skR: KeyObject, pkR: Uint8Array, encap: Uint8Array, info: Uint8Array, aad: Uint8Array, ct: Uint8Array): Buffer {
  let k: { key: Buffer; nonce: Buffer };
  try {
    k = hpkeKeys(dh(skR, encap), encap, pkR, info);
  } catch {
    throw new Error('open_failed');
  }
  try {
    if (ct.length < 16) throw new Error('short');
    const d = createDecipheriv('chacha20-poly1305', k.key, k.nonce, { authTagLength: 16 });
    d.setAAD(aad, { plaintextLength: ct.length - 16 });
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    throw new Error('open_failed');
  } finally {
    k.key.fill(0);
  }
}

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
/** 맡길 때의 aad(@sax/remote escrowStoreAad와 같다) */
export const escrowStoreAad = (aikPub: Uint8Array): Buffer => sha256(Buffer.from(STORE_AAD), aikPub);
/** 받을 때의 aad(@sax/remote escrowClaimAad와 같다) */
export const escrowClaimAad = (aikPub: Uint8Array, deviceId: string, linkPub: Uint8Array): Buffer => sha256(Buffer.from(CLAIM_AAD), aikPub, Buffer.from(deviceId, 'utf8'), linkPub);

function aikPubOf(rk: Uint8Array): Buffer {
  const seed = Buffer.from(hkdfSync('sha256', rk, EMPTY, 'aik', 32));
  try {
    return rawPublic(createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' }));
  } finally {
    seed.fill(0);
  }
}

export class KeyEscrow {
  private readonly key: KeyObject;
  private readonly pub: Buffer;
  readonly publicKey: string;
  constructor(seed: Uint8Array) {
    this.key = x25519Priv(seed);
    this.pub = rawPublic(this.key);
    this.publicKey = this.pub.toString('base64');
  }
  static fromSeedHex(hex: string | undefined): KeyEscrow {
    const seed = key32(hex, 'KEY_ESCROW_KEY');
    try {
      return new KeyEscrow(seed);
    } finally {
      seed.fill(0);
    }
  }

  private open(enc: Uint8Array, ct: Uint8Array, aikPub: Uint8Array): Buffer | null {
    let rk: Buffer;
    try {
      rk = hpkeOpen(this.key, this.pub, enc, Buffer.from(RK_ESCROW_INFO), escrowStoreAad(aikPub), ct);
    } catch {
      return null;
    }
    if (rk.length === 32 && timingSafeEqual(aikPubOf(rk), aikPub)) return rk;
    rk.fill(0);
    return null;
  }

  holds(enc: Uint8Array, ct: Uint8Array, aikPub: Uint8Array): boolean {
    const rk = this.open(enc, ct, aikPub);
    rk?.fill(0);
    return !!rk;
  }

  reseal(enc: Uint8Array, ct: Uint8Array, aikPub: Uint8Array, deviceId: string, linkPub: Uint8Array): { enc: Buffer; ct: Buffer } | null {
    const rk = this.open(enc, ct, aikPub);
    if (!rk) return null;
    try {
      return hpkeSeal(linkPub, Buffer.from(RK_ESCROW_INFO), escrowClaimAad(aikPub, deviceId, linkPub), rk);
    } finally {
      rk.fill(0);
    }
  }
}
