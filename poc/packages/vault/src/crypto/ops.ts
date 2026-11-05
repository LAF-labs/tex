// 금고 장기 키 연산(D05 §5.1 VaultCrypto, D08 §2.1·§3, C-19). 개인키(Sd·Vd·Qd·Kv·RK→AIK)는 금고 밖으로 나가지 않는다.
// - 키는 KeyStore(OS 키체인, 무인 등급)에 32바이트 시드로 둔다. 없으면 만들고(vault.key_created), 길이가 틀리면 덮지 않고 실패한다(N-30).
// - 서명 입력은 utf8(purpose) ‖ msg(구분 바이트 없음, schemas/SIGNING.md §8). purpose는 허용 목록과 고정 비교한다.
// - 호출 감사: 연산·용도를 로그에 남기고, 한 시간 기대치를 넘으면 vault.crypto_rate_anomaly(막지는 않는다, D05 §5.1).
// - 오라클 한계(D05 §1): 침해된 엔진은 허용 용도 안의 서명·개봉을 요청할 수 있다. 키 자체는 나가지 않는다.
import { createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, hkdfSync, sign as edSign, type KeyObject } from 'node:crypto';
import type { EventLog } from '@sax/platform';
import type { KeyStore } from '../keystore.ts';
import {
  AIK_PURPOSES, CRYPTO_MSG_MAX, NOISE_CONTEXTS, VD_PURPOSES,
  type HpkeOpenParams, type NoiseDhParams, type SignAikParams, type SignVdParams, type VaultPublicKeys,
} from '../protocol.ts';

/** KeyStore 항목 이름(32바이트 시드). RK는 계정 루트 키이고 AIK는 그 파생이다(D08 §3). */
export const CRYPTO_KEY_ITEMS = { sd: 'device/sd', vd: 'device/vd', qd: 'device/qd', kv: 'device/kv', rk: 'account/rk' } as const;

/** 한 시간 기대치(넘으면 vault.crypto_rate_anomaly). DPoP는 요청마다 하나라 Vd가 가장 많다. */
export const CRYPTO_RATE_PER_HOUR: Record<CryptoOp, number> = { noiseDH: 240, signVd: 3_600, signAik: 60, hpkeOpen: 1_200 };

export type CryptoOp = 'noiseDH' | 'signVd' | 'signAik' | 'hpkeOpen';

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

/**
 * RFC 9180 Base 모드 단발 개봉(DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305, seq 0).
 * 실패(인증 태그 불일치 등)는 Error('open_failed').
 */
export function hpkeOpenBase(skR: KeyObject, pkR: Uint8Array, encap: Uint8Array, info: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const dh = x25519(skR, encap);
  const kemContext = cat(encap, pkR);
  const eaePrk = labeledExtract(KEM_SUITE, new Uint8Array(0), 'eae_prk', dh);
  const shared = labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', kemContext, 32);
  const pskIdHash = labeledExtract(HPKE_SUITE, new Uint8Array(0), 'psk_id_hash', new Uint8Array(0));
  const infoHash = labeledExtract(HPKE_SUITE, new Uint8Array(0), 'info_hash', info);
  const ksContext = cat(new Uint8Array([0]), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', new Uint8Array(0));
  const key = labeledExpand(HPKE_SUITE, secret, 'key', ksContext, 32);
  const nonce = labeledExpand(HPKE_SUITE, secret, 'base_nonce', ksContext, 12);
  try {
    if (ct.length < 16) throw new Error('short');
    const d = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    d.setAAD(aad, { plaintextLength: ct.length - 16 });
    d.setAuthTag(ct.subarray(ct.length - 16));
    return new Uint8Array(Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]));
  } catch {
    throw new Error('open_failed');
  } finally {
    for (const b of [dh, eaePrk, shared, secret, key]) b.fill(0);
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
      const aikSeed = aikSeedFromRk(await take(CRYPTO_KEY_ITEMS.rk));
      seeds.push(aikSeed);
      return { sd, vd, qd, kv, aik: ed25519FromSeed(aikSeed) };
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
}
