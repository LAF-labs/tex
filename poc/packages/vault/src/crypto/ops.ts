// 금고 장기 키 연산(D05 §5.1 VaultCrypto, D08 §2.1·§3, C-19). 개인키(Sd·Vd·Qd·Kv·RK→AIK)는 금고 밖으로 나가지 않는다.
// - 키는 KeyStore(OS 키체인, 무인 등급)에 32바이트 시드로 둔다. 없으면 만들고(vault.key_created), 길이가 틀리면 덮지 않고 실패한다(N-30).
// - 서명 입력은 utf8(purpose) ‖ msg(구분 바이트 없음, schemas/SIGNING.md §8). purpose는 허용 목록과 고정 비교한다.
// - 호출 감사: 연산·용도를 로그에 남기고, 한 시간 기대치를 넘으면 vault.crypto_rate_anomaly(막지는 않는다, D05 §5.1).
// - 오라클 한계(D05 §1): 침해된 엔진은 허용 용도 안의 서명·개봉을 요청할 수 있다. 키 자체는 나가지 않는다.
import { createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, randomBytes, sign as edSign, timingSafeEqual, type KeyObject } from 'node:crypto';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import type { EventLog } from '@sax/platform';
import type { KeyStore } from '../keystore.ts';
import {
  AIK_PURPOSES, CRYPTO_MSG_MAX, NOISE_CONTEXTS, RK_LINK_INFO, RK_SEALS_PER_DAY, SHARE_EPOCH_MAX, SHARE_KEY_INFO_PREFIX, SHARE_SIGN_CONTEXT, SHARE_SIGN_INFO, SHARE_SIGN_MSG_MAX, VD_PURPOSES,
  type HpkeOpenParams, type NoiseDhParams, type RkImportParams, type RkSealParams, type ShareKeyParams, type SignAikParams, type SignShareParams, type SignVdParams, type VaultPublicKeys,
} from '../protocol.ts';

/** KeyStore 항목 이름(32바이트 시드). RK는 계정 루트 키이고 AIK는 그 파생이다(D08 §3). */
export const CRYPTO_KEY_ITEMS = { sd: 'device/sd', vd: 'device/vd', qd: 'device/qd', kv: 'device/kv', rk: 'account/rk' } as const;

/** 한 시간 기대치(넘으면 vault.crypto_rate_anomaly). DPoP는 요청마다 하나라 Vd가 가장 많다. */
export const CRYPTO_RATE_PER_HOUR: Record<CryptoOp, number> = { noiseDH: 240, signVd: 3_600, signAik: 60, hpkeOpen: 1_200, linkKey: 30, rkSeal: 3, rkImport: 10, shareKey: 600, signShare: 1_200 };

export type CryptoOp = 'noiseDH' | 'signVd' | 'signAik' | 'hpkeOpen' | 'linkKey' | 'rkSeal' | 'rkImport' | 'shareKey' | 'signShare';

/** 쓰던 RK를 옮겨 두는 보관 항목 이름(뒤에 넘겨받은 시각 ms가 붙는다). 읽는 코드는 없다(사람이 되돌릴 때 쓴다). */
export const RK_PREV_ITEM = 'account/rk-prev-';

const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

const enc = new TextEncoder();
const HPKE_INFO = 'SAX-env-v1';
const HPKE_AAD_PREFIX = enc.encode('SAX-env-v1');

interface Pair {
  priv: KeyObject;
  pub: Uint8Array;
}
interface Keys {
  sd: Pair;
  vd: Pair;
  qd: Pair;
  kv: Pair;
  aik: Pair;
  /** 계정 공유 기록 서명 키 Ws(RK 파생, D07 §10) */
  ws: Pair;
}

export function x25519FromSeed(seed: Uint8Array): Pair {
  const priv = createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return { priv, pub: rawPublic(priv) };
}

export function ed25519FromSeed(seed: Uint8Array): Pair {
  const priv = createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });
  return { priv, pub: rawPublic(priv) };
}

function rawPublic(priv: KeyObject): Uint8Array {
  const der = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return new Uint8Array(der.subarray(der.length - 32));
}

/** RK → 계정 공유 기록 서명 키(Ws) 시드: HKDF-SHA256(RK, salt=없음, info="share/sig/v1", 32)(D07 §10). */
export function shareSignSeedFromRk(rk: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', rk, new Uint8Array(0), SHARE_SIGN_INFO, 32));
}

/** RK → 계정 공유 기록 봉인 키 K_share(e): HKDF-SHA256(RK, salt=없음, info="share/v1/" ‖ e, 32)(D07 §10). */
export function shareKeyFromRk(rk: Uint8Array, epoch: number): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', rk, new Uint8Array(0), `${SHARE_KEY_INFO_PREFIX}${epoch}`, 32));
}

/** RK → AIK 시드: HKDF-SHA256(ikm=RK, salt=없음, info="aik", 32)(D08 §3 "RK ─ HKDF("aik")"). */
export function aikSeedFromRk(rk: Uint8Array): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', rk, new Uint8Array(0), 'aik', 32));
}

function x25519(priv: KeyObject, remotePub: Uint8Array): Uint8Array {
  const pub = createPublicKey({ key: Buffer.concat([X25519_SPKI, remotePub]), format: 'der', type: 'spki' });
  // 낮은 차수 점(전부 0 출력)은 거부한다(RFC 7748 §6.1). OpenSSL은 스스로 거부하고, 아니면 여기서 본다.
  let out: Uint8Array;
  try {
    out = new Uint8Array(diffieHellman({ privateKey: priv, publicKey: pub }));
  } catch {
    throw new Error('bad_point');
  }
  if (out.every((b) => b === 0)) throw new Error('bad_point');
  return out;
}

const isBytes = (x: unknown, min: number, max: number): x is Uint8Array => x instanceof Uint8Array && x.length >= min && x.length <= max;

// ───────────────────────── HPKE(RFC 9180) Base 개봉 ─────────────────────────

const i2osp = (n: number, len: number) => {
  const b = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--, n = Math.floor(n / 256)) b[i] = n & 0xff;
  return b;
};
const cat = (...xs: Uint8Array[]) => new Uint8Array(Buffer.concat(xs));
const KEM_SUITE = cat(enc.encode('KEM'), i2osp(0x0020, 2));
const HPKE_SUITE = cat(enc.encode('HPKE'), i2osp(0x0020, 2), i2osp(0x0001, 2), i2osp(0x0003, 2));

const extract = (salt: Uint8Array, ikm: Uint8Array) => new Uint8Array(createHmac('sha256', salt).update(ikm).digest());
function expand(prk: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  const out: Buffer[] = [];
  let t: Buffer = Buffer.alloc(0);
  for (let i = 1; out.reduce((n, b) => n + b.length, 0) < len; i++) {
    t = createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out.push(t);
  }
  return new Uint8Array(Buffer.concat(out).subarray(0, len));
}
const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) => extract(salt, cat(enc.encode('HPKE-v1'), suite, enc.encode(label), ikm));
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(prk, cat(i2osp(len, 2), enc.encode('HPKE-v1'), suite, enc.encode(label), info), len);

/** RFC 9180 §5.1 KeySchedule(Base)에서 seq 0의 키·논스. dh와 중간값은 지운다. */
function hpkeKeys(dh: Uint8Array, encap: Uint8Array, pkR: Uint8Array, info: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const kemContext = cat(encap, pkR);
  const eaePrk = labeledExtract(KEM_SUITE, new Uint8Array(0), 'eae_prk', dh);
  const shared = labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', kemContext, 32);
  const pskIdHash = labeledExtract(HPKE_SUITE, new Uint8Array(0), 'psk_id_hash', new Uint8Array(0));
  const infoHash = labeledExtract(HPKE_SUITE, new Uint8Array(0), 'info_hash', info);
  const ksContext = cat(new Uint8Array([0]), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', new Uint8Array(0));
  try {
    return { key: labeledExpand(HPKE_SUITE, secret, 'key', ksContext, 32), nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', ksContext, 12) };
  } finally {
    for (const b of [dh, eaePrk, shared, secret]) b.fill(0);
  }
}

/**
 * ChaCha20-Poly1305(RFC 8439). node:crypto의 'chacha20-poly1305'는 쓰지 않는다: 금고가 도는 Electron(BoringSSL)에는 그 이름의 암호가 없어
 * createCipheriv가 "Unknown cipher"로 던진다(Node에서 도는 시험은 통과한다). @sax/remote·폰과 같은 구현(@noble/ciphers)을 쓴다.
 * 한 번 봉인하거나 한 번 여는 데만 쓴다(부를 때마다 새로 만든다).
 */
const aead = (key: Uint8Array, nonce: Uint8Array, aad: Uint8Array) => chacha20poly1305(key, nonce, aad);

/**
 * RFC 9180 Base 모드 단발 개봉(DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, seq 0).
 * 실패(인증 태그 불일치 등)는 Error('open_failed').
 */
export function hpkeOpenBase(skR: KeyObject, pkR: Uint8Array, encap: Uint8Array, info: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const { key, nonce } = hpkeKeys(x25519(skR, encap), encap, pkR, info);
  try {
    if (ct.length < 16) throw new Error('short');
    return aead(key, nonce, aad).decrypt(ct);
  } catch {
    throw new Error('open_failed');
  } finally {
    key.fill(0);
  }
}

/**
 * RFC 9180 Base 모드 단발 봉인(위와 같은 스위트, seq 0). 임시 키는 부를 때마다 새로 뽑는다(skE는 시험 벡터용).
 * 받는 키가 낮은 차수 점이면 Error('bad_point').
 */
export function hpkeSealBase(pkR: Uint8Array, info: Uint8Array, aad: Uint8Array, pt: Uint8Array, skE?: Uint8Array): { enc: Uint8Array; ct: Uint8Array } {
  const seed = skE ? Uint8Array.from(skE) : new Uint8Array(randomBytes(32));
  try {
    const e = x25519FromSeed(seed);
    const { key, nonce } = hpkeKeys(x25519(e.priv, pkR), e.pub, pkR, info);
    try {
      return { enc: e.pub, ct: aead(key, nonce, aad).encrypt(pt) };
    } finally {
      key.fill(0);
    }
  } finally {
    seed.fill(0);
  }
}

// ───────────────────────── 금고 연산 ─────────────────────────

export interface VaultCryptoOptions {
  keyStore: KeyStore;
  log: EventLog;
  now?: () => number;
}

export class VaultCrypto {
  private readonly o: VaultCryptoOptions;
  private keysP: Promise<Keys> | null = null;
  private readonly calls = new Map<CryptoOp, number[]>();
  private readonly anomalyAt = new Map<CryptoOp, number>();
  /** 새 PC 연결의 넘겨받기 키(Hx). 메모리에만 있고, 다시 만들거나 한 번 쓰면 사라진다 */
  private link: Pair | null = null;
  private readonly rkSeals: number[] = [];

  constructor(opts: VaultCryptoOptions) {
    this.o = opts;
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** 키를 한 번 읽는다(없으면 만든다). 실패는 캐시하지 않는다(다음 호출에서 다시 읽는다). */
  private keys(): Promise<Keys> {
    if (!this.keysP) {
      const p = this.load();
      this.keysP = p;
      p.catch(() => {
        if (this.keysP === p) this.keysP = null;
      });
    }
    return this.keysP;
  }

  private async seed(name: string): Promise<Uint8Array> {
    const got = await this.o.keyStore.get(name, 32);
    if (got) return got;
    const fresh = await this.o.keyStore.create(name, 32);
    this.o.log.event('vault.key_created', { name });
    return fresh;
  }

  private async load(): Promise<Keys> {
    const seeds: Uint8Array[] = [];
    try {
      const take = async (name: string) => {
        const s = await this.seed(name);
        seeds.push(s);
        return s;
      };
      const sd = x25519FromSeed(await take(CRYPTO_KEY_ITEMS.sd));
      const vd = ed25519FromSeed(await take(CRYPTO_KEY_ITEMS.vd));
      const qd = x25519FromSeed(await take(CRYPTO_KEY_ITEMS.qd));
      const kv = x25519FromSeed(await take(CRYPTO_KEY_ITEMS.kv));
      const rk = await take(CRYPTO_KEY_ITEMS.rk);
      const aikSeed = aikSeedFromRk(rk);
      const wsSeed = shareSignSeedFromRk(rk);
      seeds.push(aikSeed, wsSeed);
      return { sd, vd, qd, kv, aik: ed25519FromSeed(aikSeed), ws: ed25519FromSeed(wsSeed) };
    } finally {
      for (const s of seeds) s.fill(0);
    }
  }

  private audit(op: CryptoOp, purpose?: string): void {
    const now = this.now();
    const hour = 3_600_000;
    const xs = (this.calls.get(op) ?? []).filter((t) => now - t < hour);
    xs.push(now);
    this.calls.set(op, xs);
    this.o.log.event('vault.crypto_op', purpose ? { op, purpose } : { op });
    if (xs.length > CRYPTO_RATE_PER_HOUR[op] && now - (this.anomalyAt.get(op) ?? -Infinity) >= hour) {
      this.anomalyAt.set(op, now);
      this.o.log.event('vault.crypto_rate_anomaly', { op, count: xs.length });
    }
  }

  async publicKeys(): Promise<VaultPublicKeys> {
    const k = await this.keys();
    return { noiseStatic: k.sd.pub.slice(), vd: k.vd.pub.slice(), qd: k.qd.pub.slice(), kv: k.kv.pub.slice(), aik: k.aik.pub.slice() };
  }

  async noiseDH(x: unknown): Promise<Uint8Array> {
    const p = x as Partial<NoiseDhParams> | undefined;
    if (!isBytes(p?.remotePub, 32, 32) || !(NOISE_CONTEXTS as readonly unknown[]).includes(p?.ctx)) throw new Error('bad_params');
    const k = await this.keys();
    this.audit('noiseDH', p!.ctx);
    return x25519(k.sd.priv, p!.remotePub!);
  }

  async signVd(x: unknown): Promise<Uint8Array> {
    const p = x as Partial<SignVdParams> | undefined;
    if (!isBytes(p?.msg, 0, CRYPTO_MSG_MAX) || typeof p?.purpose !== 'string') throw new Error('bad_params');
    if (!(VD_PURPOSES as readonly string[]).includes(p.purpose)) {
      this.o.log.event('vault.crypto_purpose_denied', { op: 'signVd' });
      throw new Error('purpose_not_allowed');
    }
    const k = await this.keys();
    this.audit('signVd', p.purpose);
    return new Uint8Array(edSign(null, cat(enc.encode(p.purpose), p.msg!), k.vd.priv));
  }

  async signAik(x: unknown): Promise<Uint8Array> {
    const p = x as Partial<SignAikParams> | undefined;
    if (!isBytes(p?.msg, 0, CRYPTO_MSG_MAX) || typeof p?.purpose !== 'string') throw new Error('bad_params');
    if (!(AIK_PURPOSES as readonly string[]).includes(p.purpose)) {
      this.o.log.event('vault.crypto_purpose_denied', { op: 'signAik' });
      throw new Error('purpose_not_allowed');
    }
    const k = await this.keys();
    this.audit('signAik', p.purpose);
    return new Uint8Array(edSign(null, cat(enc.encode(p.purpose), p.msg!), k.aik.priv));
  }

  async hpkeOpen(x: unknown): Promise<Uint8Array> {
    const p = x as Partial<HpkeOpenParams> | undefined;
    if (
      !isBytes(p?.enc, 32, 32) || !isBytes(p?.ct, 16, CRYPTO_MSG_MAX) || p?.info !== HPKE_INFO
      || !isBytes(p?.aad, HPKE_AAD_PREFIX.length, HPKE_AAD_PREFIX.length + 64)
      || !HPKE_AAD_PREFIX.every((b, i) => p.aad![i] === b)
    ) throw new Error('bad_params');
    const k = await this.keys();
    this.audit('hpkeOpen');
    try {
      return hpkeOpenBase(k.qd.priv, k.qd.pub, p.enc!, enc.encode(HPKE_INFO), p.aad!, p.ct!);
    } catch (e) {
      this.o.log.event('vault.hpke_open_failed');
      throw e;
    }
  }

  // ───────── 계정 공유 기록(ADR-048 결정 5, D07 §10). control 포트(main)만 부른다 ─────────

  /**
   * 세대 e의 줄 봉인 키와 Ws 공개키. RK는 나가지 않는다. 계정 열쇠를 넘겨받으면(rkImport) 값이 바뀐다.
   * 키는 계정 공유 기록 줄만 연다. 부른 쪽(main)이 쓰고 지운다.
   */
  async shareKey(x: unknown): Promise<{ key: Uint8Array; signPub: Uint8Array }> {
    const p = x as Partial<ShareKeyParams> | undefined;
    if (!Number.isSafeInteger(p?.epoch) || p!.epoch! < 0 || p!.epoch! > SHARE_EPOCH_MAX) throw new Error('bad_params');
    const k = await this.keys();
    const rk = await this.o.keyStore.get(CRYPTO_KEY_ITEMS.rk, 32);
    if (!rk) throw new Error('vault.keystore_mismatch');
    try {
      this.audit('shareKey');
      return { key: shareKeyFromRk(rk, p!.epoch!), signPub: k.ws.pub.slice() };
    } finally {
      rk.fill(0);
    }
  }

  /** PC가 쓴 줄의 서명: Ed25519(Ws, utf8("SAX-share-v1") ‖ msg). 컨텍스트는 여기서 붙인다(다른 용도의 서명으로 쓸 수 없다). */
  async signShare(x: unknown): Promise<Uint8Array> {
    const p = x as Partial<SignShareParams> | undefined;
    if (!isBytes(p?.msg, 1, SHARE_SIGN_MSG_MAX)) throw new Error('bad_params');
    const k = await this.keys();
    this.audit('signShare');
    return new Uint8Array(edSign(null, cat(enc.encode(SHARE_SIGN_CONTEXT), p!.msg!), k.ws.priv));
  }

  // ───────── 새 PC 연결(ADR-048 결정 3, D08 §4.3). control 포트(main)만 부른다 ─────────

  /** [새 PC] 넘겨받기 키를 새로 만든다(앞 키는 버린다). 공개키만 돌려준다. */
  async linkKey(): Promise<Uint8Array> {
    const seed = new Uint8Array(randomBytes(32));
    try {
      this.link = x25519FromSeed(seed);
    } finally {
      seed.fill(0);
    }
    this.audit('linkKey');
    return this.link.pub.slice();
  }

  /**
   * [쓰던 PC] RK를 새 PC의 넘겨받기 키로 봉인한다. RK 평문은 여기 밖으로 나가지 않는다.
   * 24시간에 RK_SEALS_PER_DAY번까지(이 프로세스가 떠 있는 동안의 셈). 넘으면 Error('rate_limited').
   */
  async rkSeal(x: unknown): Promise<{ enc: Uint8Array; ct: Uint8Array }> {
    const p = x as Partial<RkSealParams> | undefined;
    if (!isBytes(p?.recipient, 32, 32) || p?.info !== RK_LINK_INFO || !isBytes(p?.aad, 32, 32)) throw new Error('bad_params');
    const now = this.now();
    const recent = this.rkSeals.filter((t) => now - t < 86_400_000);
    if (recent.length >= RK_SEALS_PER_DAY) {
      this.o.log.event('vault.rk_seal_denied', { reason: 'rate' });
      throw new Error('rate_limited');
    }
    await this.keys(); // RK가 없으면 여기서 만들어진다(첫 PC가 아직 계정 키를 고정하기 전이어도 같은 값)
    const rk = await this.o.keyStore.get(CRYPTO_KEY_ITEMS.rk, 32);
    if (!rk) throw new Error('vault.keystore_mismatch');
    try {
      const out = hpkeSealBase(p.recipient!, enc.encode(RK_LINK_INFO), p.aad!, rk);
      this.rkSeals.length = 0;
      this.rkSeals.push(...recent, now);
      this.audit('rkSeal');
      this.o.log.event('vault.rk_sealed');
      return out;
    } finally {
      rk.fill(0);
    }
  }

  /**
   * [새 PC] 봉인문을 넘겨받기 키로 열고, 연 RK의 AIK 공개키가 aikPub와 같을 때만 계정 루트 키를 바꾼다.
   * 쓰던 RK는 보관 항목으로 먼저 옮긴다. 성공하면 넘겨받기 키를 지우고 키를 다시 읽는다(AIK가 바뀐다). 새 AIK 공개키를 돌려준다.
   */
  async rkImport(x: unknown): Promise<Uint8Array> {
    const p = x as Partial<RkImportParams> | undefined;
    if (!isBytes(p?.enc, 32, 32) || !isBytes(p?.ct, 48, 48) || p?.info !== RK_LINK_INFO || !isBytes(p?.aad, 32, 32) || !isBytes(p?.aikPub, 32, 32)) throw new Error('bad_params');
    const link = this.link;
    if (!link) throw new Error('no_link_key');
    this.audit('rkImport');
    let rk: Uint8Array;
    try {
      rk = hpkeOpenBase(link.priv, link.pub, p.enc!, enc.encode(RK_LINK_INFO), p.aad!, p.ct!);
    } catch (e) {
      this.o.log.event('vault.rk_import_failed', { reason: 'open' });
      throw e;
    }
    const aikSeed = aikSeedFromRk(rk);
    try {
      const aik = ed25519FromSeed(aikSeed).pub;
      if (rk.length !== 32 || !timingSafeEqual(aik, p.aikPub!)) {
        this.o.log.event('vault.rk_import_failed', { reason: 'aik' });
        throw new Error('aik_mismatch');
      }
      const old = await this.o.keyStore.get(CRYPTO_KEY_ITEMS.rk, 32);
      if (old) {
        try {
          // 이미 같은 RK면(다시 받은 경우) 옮기지 않는다
          if (!timingSafeEqual(old, rk)) await this.o.keyStore.put(`${RK_PREV_ITEM}${this.now()}`, old);
        } finally {
          old.fill(0);
        }
      }
      await this.o.keyStore.put(CRYPTO_KEY_ITEMS.rk, rk);
      this.keysP = null;
      this.link = null;
      this.o.log.event('vault.rk_imported');
      return aik;
    } finally {
      rk.fill(0);
      aikSeed.fill(0);
    }
  }
}
