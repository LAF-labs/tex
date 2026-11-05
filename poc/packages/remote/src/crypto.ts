// 암호 원시 연산 래퍼(D08 §2). @noble/*만 쓴다(폰·PC 공용, 네이티브 의존 없음).

import { chacha20poly1305, xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { blake2b } from '@noble/hashes/blake2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes as nobleRandom } from '@noble/hashes/utils.js';
import { concat, utf8 } from './bytes.ts';

export const randomBytes = (n: number): Uint8Array => nobleRandom(n);

export const sha256Hash = (m: Uint8Array): Uint8Array => sha256(m);
export const blake2b512 = (m: Uint8Array): Uint8Array => blake2b(m, { dkLen: 64 });
export const hmacBlake2b = (key: Uint8Array, m: Uint8Array): Uint8Array => hmac(blake2b, key, m);

/** HKDF-SHA256, 컨텍스트 문자열로 도메인 분리(D08 §2). */
export const hkdfSha256 = (ikm: Uint8Array, info: string, len: number, salt?: Uint8Array): Uint8Array =>
  hkdf(sha256, ikm, salt, utf8(info), len);

export const x25519Keygen = (): { secretKey: Uint8Array; publicKey: Uint8Array } => {
  const secretKey = x25519.utils.randomSecretKey();
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
};
export const x25519Public = (sk: Uint8Array): Uint8Array => x25519.getPublicKey(sk);
/** 저차 점·전부 0 결과는 거부한다(noble 기본 + 이중 확인). */
export function x25519Dh(sk: Uint8Array, pk: Uint8Array): Uint8Array {
  if (pk.length !== 32) throw new Error('x25519: bad public key length');
  const out = x25519.getSharedSecret(sk, pk);
  let z = 0;
  for (const x of out) z |= x;
  if (z === 0) throw new Error('x25519: low-order point');
  return out;
}

export const ed25519Keygen = (): { secretKey: Uint8Array; publicKey: Uint8Array } => {
  const secretKey = ed25519.utils.randomSecretKey();
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
};
export const ed25519Public = (sk: Uint8Array): Uint8Array => ed25519.getPublicKey(sk);

/** 서명 입력 = 용도 문자열 ‖ msg (D05 §5.1, D08 §2.1). 검증기는 용도를 고정 비교한다. */
export const signInput = (purpose: string, msg: Uint8Array): Uint8Array => concat(utf8(purpose), msg);

export const ed25519SignRaw = (sk: Uint8Array, m: Uint8Array): Uint8Array => ed25519.sign(m, sk);
export function ed25519Verify(pub: Uint8Array, purpose: string, msg: Uint8Array, sig: Uint8Array): boolean {
  if (pub.length !== 32 || sig.length !== 64) return false;
  try {
    return ed25519.verify(sig, signInput(purpose, msg), pub, { zip215: false });
  } catch {
    return false;
  }
}

/** ChaCha20-Poly1305(IETF). Noise·프레임 전송 전용. 논스 = 0^32 ‖ LE64(n). */
export function noiseNonce(n: bigint): Uint8Array {
  const out = new Uint8Array(12);
  new DataView(out.buffer).setBigUint64(4, n, true);
  return out;
}
export const chachaSeal = (k: Uint8Array, nonce: Uint8Array, ad: Uint8Array, pt: Uint8Array): Uint8Array =>
  chacha20poly1305(k, nonce, ad).encrypt(pt);
export const chachaOpen = (k: Uint8Array, nonce: Uint8Array, ad: Uint8Array, ct: Uint8Array): Uint8Array =>
  chacha20poly1305(k, nonce, ad).decrypt(ct);

/** XChaCha20-Poly1305(랜덤 24B 논스). 파일·로컬 저장(폰 보관함) 전용, Noise 밖. 출력 = nonce ‖ ct. */
export function xSeal(k: Uint8Array, pt: Uint8Array, ad: Uint8Array): Uint8Array {
  const nonce = randomBytes(24);
  return concat(nonce, xchacha20poly1305(k, nonce, ad).encrypt(pt));
}
export function xOpen(k: Uint8Array, box: Uint8Array, ad: Uint8Array): Uint8Array {
  if (box.length < 24 + 16) throw new Error('xOpen: short');
  return xchacha20poly1305(k, box.subarray(0, 24), ad).decrypt(box.subarray(24));
}
