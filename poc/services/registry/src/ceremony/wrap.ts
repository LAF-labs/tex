// 서명 키 감싸기(macOS Secure Enclave)와 백업 파일 형식 — 바이트 규약(CEREMONY.md 부록 A, SIGNING.md 스타일). Swift 도우미(macos/sax-keychain.swift)와 같은 바이트를 낸다.
//
// 감싸기 SAX-ceremony-wrap-v1 (Ed25519 시드 32B를 Secure Enclave P-256 키 W로):
//   e      = 새 P-256 임시 키(감쌀 때마다)
//   Z      = ECDH(e, W_pub)의 x 좌표 32B
//   info   = utf8("SAX-ceremony-wrap-v1") ‖ X9.63(e_pub) 65B ‖ X9.63(W_pub) 65B ‖ utf8(keyId)
//   KEK    = HKDF-SHA256(ikm = Z, salt = 빈 값, info, 32B)
//   aad    = utf8("SAX-ceremony-wrap-v1") ‖ utf8(keyId)
//   ct‖tag = ChaCha20-Poly1305(KEK, nonce 12B 난수, seed, aad)
//   블롭   = JCS({v:1, alg:"SAX-ceremony-wrap-v1", keyId, pub: b64(Ed25519 공개키), epk: b64(e_pub), nonce: b64, ct: b64(ct‖tag 48B)})
// 풀기는 W(Secure Enclave)가 ECDH(W, e_pub)를 한다. W의 접근 제어가 privateKeyUsage + biometryCurrentSet이라 풀 때마다 Touch ID다.
// 푼 시드로 Ed25519(seed)의 공개키가 블롭 pub과 같아야 한다.
//
// 백업 SAX-ceremony-backup-v1 (오프라인 파일 1개, 강한 암호):
//   key    = scrypt(passphrase NFC utf8, salt 16B, N=2^17, r=8, p=1, 32B)
//   header = {v:1, alg:"SAX-ceremony-backup-v1", kdf:{name:"scrypt", N, r, p, salt}, nonce, createdAt}
//   aad    = utf8("SAX-ceremony-backup-v1") ‖ JCS(header)
//   ct‖tag = ChaCha20-Poly1305(key, nonce 12B, JCS({keys:[{keyId, pub, seed}]}), aad)
//   파일   = JCS({...header, ct})
import { createCipheriv, createDecipheriv, createECDH, createPrivateKey, createPublicKey, hkdfSync, randomBytes, scryptSync } from 'node:crypto';
import { canonicalJson } from '@sax/engine/core';
import { CeremonyError } from './content.ts';

export const WRAP_ALG = 'SAX-ceremony-wrap-v1';
export const BACKUP_ALG = 'SAX-ceremony-backup-v1';
export const BACKUP_SCRYPT = { N: 1 << 17, r: 8, p: 1 } as const;
/** 암호 최소 길이(문자). 단어 5개 이상을 권한다(CEREMONY.md §6). */
export const PASSPHRASE_MIN = 20;

const utf8 = (s: string) => Buffer.from(s, 'utf8');
const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
const unb64 = (s: unknown, n?: number): Buffer => {
  if (typeof s !== 'string') throw new CeremonyError('ceremony.blob_invalid');
  const b = Buffer.from(s, 'base64');
  if (b.toString('base64') !== s || (n !== undefined && b.length !== n)) throw new CeremonyError('ceremony.blob_invalid');
  return b;
};
const KEY_ID = /^(root|package|policy|emergency|timestamp|release)-[0-9]+$/;

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
/** Ed25519 시드 → 공개키 32B. */
export function ed25519PubFromSeed(seed: Uint8Array): Buffer {
  const k = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
  return Buffer.from(createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(12));
}

export interface WrappedKey {
  v: 1;
  alg: typeof WRAP_ALG;
  keyId: string;
  pub: string;
  epk: string;
  nonce: string;
  ct: string;
}

function wrapInfo(epk: Buffer, wpub: Buffer, keyId: string) {
  return Buffer.concat([utf8(WRAP_ALG), epk, wpub, utf8(keyId)]);
}

/**
 * 감싸기(소프트웨어 참조 구현: 시험 벡터·들여오기에 쓴다). wrapPub = W 공개키 X9.63 65B. 시험만 ephemeral·nonce를 고정한다.
 * 도우미는 같은 계산을 Swift로 한다.
 */
export function wrapSeed(keyId: string, seed: Uint8Array, wrapPub: Uint8Array, fixed?: { ephemeral: Uint8Array; nonce: Uint8Array }): WrappedKey {
  if (!KEY_ID.test(keyId) || seed.length !== 32 || wrapPub.length !== 65 || wrapPub[0] !== 0x04) throw new CeremonyError('ceremony.wrap_invalid');
  const e = createECDH('prime256v1');
  if (fixed) e.setPrivateKey(Buffer.from(fixed.ephemeral));
  else e.generateKeys();
  const epk = e.getPublicKey(); // 비압축 65B
  const z = e.computeSecret(Buffer.from(wrapPub));
  const kek = Buffer.from(hkdfSync('sha256', z, Buffer.alloc(0), wrapInfo(epk, Buffer.from(wrapPub), keyId), 32));
  z.fill(0);
  const nonce = fixed ? Buffer.from(fixed.nonce) : randomBytes(12);
  const c = createCipheriv('chacha20-poly1305', kek, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.concat([utf8(WRAP_ALG), utf8(keyId)]), { plaintextLength: 32 });
  const ct = Buffer.concat([c.update(Buffer.from(seed)), c.final(), c.getAuthTag()]);
  kek.fill(0);
  return { v: 1, alg: WRAP_ALG, keyId, pub: b64(ed25519PubFromSeed(seed)), epk: b64(epk), nonce: b64(nonce), ct: b64(ct) };
}

/** 풀기(소프트웨어 참조: 시험에서 W 개인키를 아는 경우만). 제품은 도우미가 Secure Enclave로 한다. */
export function unwrapSeed(w: WrappedKey, wrapPriv: Uint8Array): Buffer {
  if (w?.v !== 1 || w.alg !== WRAP_ALG || !KEY_ID.test(w.keyId)) throw new CeremonyError('ceremony.blob_invalid');
  const epk = unb64(w.epk, 65);
  const nonce = unb64(w.nonce, 12);
  const ct = unb64(w.ct, 48);
  const pub = unb64(w.pub, 32);
  const d = createECDH('prime256v1');
  d.setPrivateKey(Buffer.from(wrapPriv));
  const z = d.computeSecret(epk);
  const kek = Buffer.from(hkdfSync('sha256', z, Buffer.alloc(0), wrapInfo(epk, d.getPublicKey(), w.keyId), 32));
  z.fill(0);
  const dc = createDecipheriv('chacha20-poly1305', kek, nonce, { authTagLength: 16 });
  dc.setAAD(Buffer.concat([utf8(WRAP_ALG), utf8(w.keyId)]), { plaintextLength: 32 });
  dc.setAuthTag(ct.subarray(32));
  let seed: Buffer;
  try {
    seed = Buffer.concat([dc.update(ct.subarray(0, 32)), dc.final()]);
  } catch {
    throw new CeremonyError('ceremony.unwrap_failed');
  } finally {
    kek.fill(0);
  }
  if (!ed25519PubFromSeed(seed).equals(pub)) {
    seed.fill(0);
    throw new CeremonyError('ceremony.unwrap_failed', '공개키 불일치');
  }
  return seed;
}

// ---- 백업 ----

export interface BackupEntry {
  keyId: string;
  pub: string;
  seed: Buffer;
}

export function checkPassphrase(p: string): void {
  const s = p.normalize('NFC');
  if ([...s].length < PASSPHRASE_MIN || new Set(s).size < 8) throw new CeremonyError('ceremony.passphrase_weak', `${PASSPHRASE_MIN}자 이상, 서로 다른 문자 8개 이상`);
}

const scryptKey = (pass: string, salt: Buffer, k: { N: number; r: number; p: number }) => scryptSync(utf8(pass.normalize('NFC')), salt, 32, { N: k.N, r: k.r, p: k.p, maxmem: 256 * 1024 * 1024 });

/** 백업 파일 만들기. 시드 버퍼는 부르는 쪽이 다 쓴 뒤 지운다. */
export function sealBackup(entries: readonly BackupEntry[], passphrase: string, createdAt: string, fixed?: { salt: Uint8Array; nonce: Uint8Array; kdf?: { N: number; r: number; p: number } }): string {
  checkPassphrase(passphrase);
  if (!entries.length) throw new CeremonyError('ceremony.backup_empty');
  for (const e of entries) if (!KEY_ID.test(e.keyId) || e.seed.length !== 32 || !ed25519PubFromSeed(e.seed).equals(unb64(e.pub, 32))) throw new CeremonyError('ceremony.backup_invalid', e.keyId);
  const kdf = fixed?.kdf ?? BACKUP_SCRYPT;
  const salt = fixed ? Buffer.from(fixed.salt) : randomBytes(16);
  const nonce = fixed ? Buffer.from(fixed.nonce) : randomBytes(12);
  const header = { v: 1, alg: BACKUP_ALG, kdf: { name: 'scrypt', N: kdf.N, r: kdf.r, p: kdf.p, salt: b64(salt) }, nonce: b64(nonce), createdAt };
  const key = scryptKey(passphrase, salt, kdf);
  const pt = utf8(canonicalJson({ keys: [...entries].sort((a, b) => a.keyId.localeCompare(b.keyId)).map((e) => ({ keyId: e.keyId, pub: e.pub, seed: b64(e.seed) })) }));
  const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  c.setAAD(Buffer.concat([utf8(BACKUP_ALG), utf8(canonicalJson(header))]), { plaintextLength: pt.length });
  const ct = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
  pt.fill(0);
  key.fill(0);
  return `${canonicalJson({ ...header, ct: b64(ct) })}\n`;
}

/** 백업 파일 열기. 틀린 암호·변조·다른 형식은 ceremony.backup_open_failed. 시드는 부르는 쪽이 쓴 뒤 지운다. */
export function openBackup(file: string, passphrase: string): BackupEntry[] {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(file) as Record<string, unknown>;
  } catch {
    throw new CeremonyError('ceremony.backup_invalid');
  }
  const kdf = o.kdf as { name?: unknown; N?: unknown; r?: unknown; p?: unknown; salt?: unknown } | undefined;
  if (o.v !== 1 || o.alg !== BACKUP_ALG || !kdf || kdf.name !== 'scrypt' || typeof o.createdAt !== 'string') throw new CeremonyError('ceremony.backup_invalid');
  const N = Number(kdf.N);
  const r = Number(kdf.r);
  const p = Number(kdf.p);
  // 너무 약한(N < 2^14) 파일·이상한 매개변수는 받지 않는다. 만들 때는 늘 BACKUP_SCRYPT(N = 2^17)다.
  if (!Number.isSafeInteger(N) || N < 1 << 14 || N > 1 << 20 || (N & (N - 1)) !== 0 || r !== 8 || p !== 1) throw new CeremonyError('ceremony.backup_invalid', 'kdf');
  const header = { v: 1, alg: BACKUP_ALG, kdf: { name: 'scrypt', N, r, p, salt: kdf.salt }, nonce: o.nonce, createdAt: o.createdAt };
  const salt = unb64(kdf.salt, 16);
  const nonce = unb64(o.nonce, 12);
  const ct = unb64(o.ct);
  if (ct.length < 17) throw new CeremonyError('ceremony.backup_invalid');
  const key = scryptKey(passphrase, salt, { N, r, p });
  const dc = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
  dc.setAAD(Buffer.concat([utf8(BACKUP_ALG), utf8(canonicalJson(header))]), { plaintextLength: ct.length - 16 });
  dc.setAuthTag(ct.subarray(ct.length - 16));
  let pt: Buffer;
  try {
    pt = Buffer.concat([dc.update(ct.subarray(0, ct.length - 16)), dc.final()]);
  } catch {
    throw new CeremonyError('ceremony.backup_open_failed');
  } finally {
    key.fill(0);
  }
  try {
    const body = JSON.parse(pt.toString('utf8')) as { keys?: Array<{ keyId?: unknown; pub?: unknown; seed?: unknown }> };
    const out: BackupEntry[] = [];
    for (const k of body.keys ?? []) {
      const seed = unb64(k.seed, 32);
      if (typeof k.keyId !== 'string' || !KEY_ID.test(k.keyId) || !ed25519PubFromSeed(seed).equals(unb64(k.pub, 32))) throw new CeremonyError('ceremony.backup_invalid');
      out.push({ keyId: k.keyId, pub: k.pub as string, seed });
    }
    if (!out.length) throw new CeremonyError('ceremony.backup_empty');
    return out;
  } finally {
    pt.fill(0);
  }
}

/** 시드 버퍼들을 0으로 덮는다. */
export const wipeEntries = (es: readonly BackupEntry[]) => es.forEach((e) => e.seed.fill(0));
