// HPKE Base 모드(RFC 9180), 스위트 v=1: DHKEM(X25519, HKDF-SHA256) · HKDF-SHA256 · ChaCha20-Poly1305 (D08 §7, intent-envelope v).
// 한 번 봉인·한 번 개봉(seq 0)만 쓴다. PC 쪽 개봉은 금고 crypto.hpkeOpen이 하고(개인키 Q_D는 금고 밖으로 나가지 않는다),
// 여기 있는 hpkeOpen은 시험·개발 더미용이다.

import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { expand, extract } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concat, utf8 } from './bytes.ts';
import { x25519Dh } from './crypto.ts';

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0003;
const N_SECRET = 32;
const N_K = 32;
const N_N = 12;

const i2osp = (n: number, len: number): Uint8Array => {
  const b = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    b[i] = n & 0xff;
    n >>>= 8;
  }
  return b;
};

const HPKE_V1 = utf8('HPKE-v1');
const SUITE_KEM = concat(utf8('KEM'), i2osp(KEM_ID, 2));
const SUITE = concat(utf8('HPKE'), i2osp(KEM_ID, 2), i2osp(KDF_ID, 2), i2osp(AEAD_ID, 2));

const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) =>
  extract(sha256, concat(HPKE_V1, suite, utf8(label), ikm), salt.length ? salt : undefined);
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(sha256, prk, concat(i2osp(len, 2), HPKE_V1, suite, utf8(label), info), len);

const EMPTY = new Uint8Array(0);

function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Uint8Array {
  const prk = labeledExtract(SUITE_KEM, EMPTY, 'eae_prk', dh);
  return labeledExpand(SUITE_KEM, prk, 'shared_secret', kemContext, N_SECRET);
}

function keySchedule(shared: Uint8Array, info: Uint8Array): { key: Uint8Array; baseNonce: Uint8Array } {
  const pskIdHash = labeledExtract(SUITE, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(SUITE, EMPTY, 'info_hash', info);
  const ctx = concat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = labeledExtract(SUITE, shared, 'secret', EMPTY);
  return { key: labeledExpand(SUITE, secret, 'key', ctx, N_K), baseNonce: labeledExpand(SUITE, secret, 'base_nonce', ctx, N_N) };
}

/** RFC 9180 §7.1.3 DeriveKeyPair(X25519). 시험 벡터 재현용. */
export function hpkeDeriveKeyPair(ikm: Uint8Array): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const prk = labeledExtract(SUITE_KEM, EMPTY, 'dkp_prk', ikm);
  const secretKey = labeledExpand(SUITE_KEM, prk, 'sk', EMPTY, 32);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export interface HpkeSealed {
  enc: Uint8Array;
  ct: Uint8Array;
}

/** SetupBaseS + Seal(seq 0). ephemeral은 시험 벡터 재현용(평소에는 비워 둔다). */
export function hpkeSeal(pkR: Uint8Array, info: Uint8Array, aad: Uint8Array, pt: Uint8Array, ephemeral?: Uint8Array): HpkeSealed {
  if (pkR.length !== 32) throw new Error('hpke: bad recipient key');
  const skE = ephemeral ?? x25519.utils.randomSecretKey();
  const enc = x25519.getPublicKey(skE);
  const dh = x25519Dh(skE, pkR);
  const shared = extractAndExpand(dh, concat(enc, pkR));
  const { key, baseNonce } = keySchedule(shared, info);
  const ct = chacha20poly1305(key, baseNonce, aad).encrypt(pt);
  key.fill(0);
  shared.fill(0);
  dh.fill(0);
  if (!ephemeral) skE.fill(0);
  return { enc, ct };
}

/** SetupBaseR + Open(seq 0). 실패는 던진다. */
export function hpkeOpen(skR: Uint8Array, enc: Uint8Array, info: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  if (enc.length !== 32) throw new Error('hpke: bad enc');
  const pkR = x25519.getPublicKey(skR);
  const dh = x25519Dh(skR, enc);
  const shared = extractAndExpand(dh, concat(enc, pkR));
  const { key, baseNonce } = keySchedule(shared, info);
  try {
    return chacha20poly1305(key, baseNonce, aad).decrypt(ct);
  } finally {
    key.fill(0);
    shared.fill(0);
    dh.fill(0);
  }
}
