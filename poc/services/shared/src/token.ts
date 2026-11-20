import { randomBytes, type KeyObject } from 'node:crypto';
import { b64u, fromB64, fromB64u, jcs, safeEqual, sha256, signCtx, verifyCtx } from './crypto.ts';
import { fail, type ErrorCode } from './errors.ts';

/**
 * 범위. Phase 1 폰은 relay·push에 더해 chat(ADR-047: PC가 꺼져 있을 때 폰이 게이트웨이로 대화 모델을 직접 부른다)만 받는다.
 * chat은 gateway와 다른 범위다: 게이트웨이는 chat 토큰에 대화 범위 실행 토큰·폰 대화 툴셋·사용량만 열고, 판정·진위확인·CODEF·실행 범위는 열지 않는다.
 */
export type Scope = 'gateway' | 'relay' | 'wake' | 'push' | 'slots' | 'devlist' | 'acct_op' | 'chat' | 'devices' | 'share';
/** share(ADR-048 결정 5): 계정 공유 기록 줄 올리기·받기, 맡긴 일 상태. 데스크톱과 폰이 다 받는다(쓸 수 있는 종류는 계정 서비스가 역할로 가른다). */
export const DESKTOP_SCOPES: readonly Scope[] = ['gateway', 'relay', 'wake', 'slots', 'devlist', 'acct_op', 'share'];
/**
 * devices(ADR-048 결정 6): 폰의 기기 관리. 계정 서비스가 기기 목록 보기·스스로 나가기·다른 기기 정지만 연다.
 * 폰은 AIK가 없어 목록을 바꾸지 못한다(devlist는 데스크톱만).
 */
export const MOBILE_SCOPES_P1: readonly Scope[] = ['relay', 'push', 'chat', 'devices', 'share'];
/** 모든 범위 이름(요청 스키마의 열거, ADR-040 결정 1) */
export const ALL_SCOPES: readonly Scope[] = ['gateway', 'relay', 'wake', 'push', 'slots', 'devlist', 'acct_op', 'chat', 'devices', 'share'];
/** 유료 기능 범위(모델 비용이 드는 것): 체험 중이거나 낸 기간 안일 때만 주고, 줄 때 등급(tier)을 싣는다. */
export const PAID_SCOPES: readonly Scope[] = ['gateway', 'chat'];

export interface DeviceClaims {
  v: 1;
  typ: 'device';
  kid: string;
  acc: string;
  dev: string;
  role: 'desktop' | 'mobile';
  scp: Scope[];
  cnf: string;
  tier?: 'trial' | 'paid';
  iat: number;
  exp: number;
  jti: string;
}

export const DEVICE_TOKEN_TTL_MS = 15 * 60_000;
const PREFIX = 'sxd1.';

export class TokenIssuer {
  readonly kid: string;
  private readonly key: KeyObject;
  constructor(kid: string, key: KeyObject) {
    this.kid = kid;
    this.key = key;
  }
  issue(c: Omit<DeviceClaims, 'v' | 'typ' | 'kid' | 'iat' | 'exp' | 'jti'>, now: number, ttlMs = DEVICE_TOKEN_TTL_MS): { token: string; claims: DeviceClaims } {
    const claims: DeviceClaims = { v: 1, typ: 'device', kid: this.kid, ...c, iat: now, exp: now + ttlMs, jti: b64u(randomBytes(16)) };
    const sig = signCtx('SAX-token-v1', claims, this.key);
    return { token: `${PREFIX}${b64u(Buffer.from(jcs(claims)))}.${b64u(sig)}`, claims };
  }
}

export class TokenVerifier {
  private readonly keys: Map<string, Buffer>;
  constructor(keys: Record<string, Buffer>) {
    this.keys = new Map(Object.entries(keys));
  }
  verify(token: string, now: number, code: ErrorCode): DeviceClaims {
    if (!token.startsWith(PREFIX)) fail(code);
    const [p, s, extra] = token.slice(PREFIX.length).split('.');
    if (!p || !s || extra !== undefined || p.length > 2048) fail(code);
    let claims: DeviceClaims;
    try {
      claims = JSON.parse(fromB64u(p!).toString('utf8')) as DeviceClaims;
    } catch {
      return fail(code);
    }
    if (claims?.v !== 1 || claims.typ !== 'device' || typeof claims.kid !== 'string') fail(code);
    const pub = this.keys.get(claims.kid);
    if (!pub || !canonical(claims, p!) || !verifyCtx('SAX-token-v1', claims, pub, fromB64u(s!))) fail(code);
    if (!Number.isSafeInteger(claims.exp) || claims.exp <= now) fail(code);
    if (!Array.isArray(claims.scp) || !fromB64(claims.cnf, 32)) fail(code);
    return claims;
  }
}

export interface DpopProof {
  htm: string;
  htu: string;
  iat: number;
  jti: string;
  ath: string;
}

export const DPOP_SKEW_SEC = 60;
const JTI_TTL_MS = 5 * 60_000;

/** jti 재사용 차단(메모리, 5분). 다중 인스턴스에서는 인스턴스 단위다(iat ±60초와 함께 재전송 창을 좁힌다). */
export class JtiCache {
  private readonly seen = new Map<string, number>();
  private readonly max: number;
  constructor(max = 100_000) {
    this.max = max;
  }
  add(jti: string, now: number): boolean {
    if (this.seen.size > this.max || this.seen.size % 1000 === 0) for (const [k, t] of this.seen) if (t <= now) this.seen.delete(k);
    const t = this.seen.get(jti);
    if (t !== undefined && t > now) return false;
    this.seen.set(jti, now + JTI_TTL_MS);
    return true;
  }
}

/** 바깥 형식의 가운데 JSON이 JCS 정규형인가(정규형이 아니면 같은 클레임을 여러 바이트열로 쓸 수 있다). */
export function canonical(obj: unknown, b64: string): boolean {
  try {
    return jcs(obj) === fromB64u(b64).toString('utf8');
  } catch {
    return false;
  }
}

export const athOf = (token: string): string => b64u(sha256(token));

/** 시험·클라이언트 참조 구현: DPoP 헤더 값 만들기. */
export function makeDpop(proof: DpopProof, deviceKey: KeyObject): string {
  return `${b64u(Buffer.from(jcs(proof)))}.${b64u(signCtx('SAX-dpop-v1', proof, deviceKey))}`;
}

export interface DpopCheck {
  method: string;
  htu: string;
  token: string;
  cnf: Buffer;
  now: number;
  jti: JtiCache;
  code: ErrorCode;
}

export function verifyDpop(header: string | undefined, c: DpopCheck): DpopProof {
  if (!header || header.length > 2048) fail(c.code);
  const [p, s, extra] = header!.split('.');
  if (!p || !s || extra !== undefined) fail(c.code);
  let proof: DpopProof;
  try {
    proof = JSON.parse(fromB64u(p!).toString('utf8')) as DpopProof;
  } catch {
    return fail(c.code);
  }
  if (!proof || typeof proof !== 'object' || Object.keys(proof).sort().join(',') !== 'ath,htm,htu,iat,jti') fail(c.code);
  if (!canonical(proof, p!)) fail(c.code);
  if (!verifyCtx('SAX-dpop-v1', proof, c.cnf, fromB64u(s!))) fail(c.code);
  if (proof.htm !== c.method || proof.htu !== c.htu) fail(c.code);
  if (!Number.isSafeInteger(proof.iat) || Math.abs(proof.iat - Math.floor(c.now / 1000)) > DPOP_SKEW_SEC) fail(c.code);
  if (typeof proof.jti !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(proof.jti)) fail(c.code);
  if (!safeEqual(proof.ath, athOf(c.token))) fail(c.code);
  if (!c.jti.add(proof.jti, c.now)) fail(c.code);
  return proof;
}

/** `Authorization: DPoP <token>`만 받는다. Bearer·세션 토큰은 거부. */
export function dpopToken(authorization: string | undefined, code: ErrorCode): string {
  const m = /^DPoP ([A-Za-z0-9_.-]{1,4096})$/.exec(authorization ?? '');
  if (!m) fail(code);
  return m![1]!;
}
