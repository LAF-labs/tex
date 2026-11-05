// 암호 도우미. 서명 입력 규칙(CONTRACT.md §1): utf8(context) ‖ utf8(JCS(object)). context는 D08 §2.1 표의 고정 문자열이다.
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes, sign as edSign, timingSafeEqual, verify as edVerify, type KeyObject } from 'node:crypto';

/** RFC 8785 JCS(정수·문자열·불리언·null·배열·객체만). 엔진 gate.ts의 jcs와 같은 규칙이다. */
export function jcs(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('jcs_number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(o[k])}`).join(',')}}`;
  }
  throw new Error('jcs_type');
}

export const sha256 = (b: Buffer | string): Buffer => createHash('sha256').update(b).digest();
export const sha256hex = (b: Buffer | string): string => sha256(b).toString('hex');
export const hmac = (key: Buffer | string, ...parts: Array<Buffer | string>): Buffer => {
  const h = createHmac('sha256', key);
  for (const p of parts) h.update(p);
  return h.digest();
};
export const hmacHex = (key: Buffer | string, ...parts: Array<Buffer | string>): string => hmac(key, ...parts).toString('hex');

export const b64u = (b: Buffer): string => b.toString('base64url');
export const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

/** 표준 base64(패딩 있든 없든). remote-envelope 스키마의 b64 필드 형식이다. 형식이 틀리면 null. */
export function fromB64(s: unknown, len?: number): Buffer | null {
  if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  if (len !== undefined && b.length !== len) return null;
  // 왕복이 같아야 한다(비정규 인코딩 거부).
  if (b.toString('base64').replace(/=+$/, '') !== s.replace(/=+$/, '')) return null;
  return b;
}

export const randomToken = (bytes = 32): string => b64u(randomBytes(bytes));

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const x = Buffer.isBuffer(a) ? a : Buffer.from(a);
  const y = Buffer.isBuffer(b) ? b : Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** D08 §2.1 서명 컨텍스트. 검증기는 컨텍스트를 고정 비교한다(C-33). */
export type SigContext = 'SAX-devlist-v1' | 'SAX-revoke-v1' | 'SAX-cert-v1' | 'SAX-acct-op-v1' | 'SAX-dpop-v1' | 'SAX-token-v1' | 'SAX-run-token-v1';

export const sigInput = (ctx: SigContext, obj: unknown): Buffer => Buffer.from(ctx + jcs(obj), 'utf8');

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function ed25519Public(raw: Buffer): KeyObject {
  if (raw.length !== 32) throw new Error('ed25519_pub_len');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function ed25519Private(seed: Buffer): KeyObject {
  if (seed.length !== 32) throw new Error('ed25519_seed_len');
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function ed25519RawPublic(k: KeyObject): Buffer {
  const der = createPublicKey(k).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
}

/** 컨텍스트 서명 검증. 키·서명 형식이 틀려도 예외 없이 false. */
export function verifyCtx(ctx: SigContext, obj: unknown, pubRaw: Buffer, sig: Buffer): boolean {
  try {
    if (sig.length !== 64) return false;
    return edVerify(null, sigInput(ctx, obj), ed25519Public(pubRaw), sig);
  } catch {
    return false;
  }
}

/** 서버 자신의 서명(토큰 발급 키)과 테스트의 기기 키 흉내에만 쓴다. 레지스트리 서명은 이 코드에 없다(ADR-013·028). */
export const signCtx = (ctx: SigContext, obj: unknown, key: KeyObject): Buffer => edSign(null, sigInput(ctx, obj), key);

/** 32B 키 자료. 형식: 64자 hex. 환경 변수에서 읽는 서버 비밀(KMS가 주입, D09 §3 키 관리). */
export function key32(hex: string | undefined, name: string): Buffer {
  if (!hex || !/^[0-9a-f]{64}$/.test(hex)) throw new Error(`config_${name}`);
  return Buffer.from(hex, 'hex');
}

const KST_OFFSET_MS = 9 * 3600_000;
/** KST 날짜 'YYYY-MM-DD'. */
export const kstDay = (ms: number): string => new Date(ms + KST_OFFSET_MS).toISOString().slice(0, 10);
/** KST 'YYYYMM'. */
export const kstMonth = (ms: number): string => kstDay(ms).slice(0, 7).replace('-', '');

/**
 * 일 회전 솔트(D08 §8, D09 §4·§10): KST 날짜마다 새 무작위 솔트를 메모리에서만 만들고, 날짜가 바뀌면 옛 솔트를 버린다.
 * 영속하지 않으므로 하루가 지나면 그날의 HMAC을 다시 계산할 수 없다. 인스턴스마다 솔트가 다르다(한도는 인스턴스 단위).
 */
export class DailySalt {
  private day = '';
  private salt: Buffer = Buffer.alloc(0);
  private readonly now: () => number;
  private readonly label: string;
  constructor(label: string, now: () => number) {
    this.label = label;
    this.now = now;
  }
  /** hex 앞 32자(128비트). */
  hash(value: string): string {
    const d = kstDay(this.now());
    if (d !== this.day) {
      this.salt.fill(0);
      this.salt = randomBytes(32);
      this.day = d;
    }
    return hmacHex(this.salt, this.label, '\u0000', value).slice(0, 32);
  }
}
