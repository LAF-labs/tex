// 기기 범위 토큰·DPoP(SAX-dpop-v1) 클라이언트 쪽. 형식 정본은 services/shared/CONTRACT.md §2·§3, services/account/API.md "기기 범위 토큰".
//   DPoP: <b64u(JCS(proof))>.<b64u(Ed25519_Vx(SAX-dpop-v1 ‖ JCS(proof)))>
//   proof = {htm, htu, iat(초), jti(16~64자 b64u), ath = b64u(sha256(토큰))}
//   POST /v1/device-tokens에서는 아직 토큰이 없으므로 ath = b64u(sha256(JCS(SignedCert))).
// 이 패키지는 소켓을 열지 않는다. HTTP는 호출자가 넘긴다(PC는 @sax/net egress, 폰은 앱의 fetch).

import { isDevPlainHost } from './devhosts.ts';
import { b64url, utf8 } from './bytes.ts';
import { CTX } from './contexts.ts';
import { randomBytes, sha256Hash } from './crypto.ts';
import type { SignedCert } from './devlist.ts';
import { jcs, jcsBytes } from './jcs.ts';
import type { Signer } from './keys.ts';

/** Vx로 SAX-dpop-v1에 서명할 수 있는 기기 키(데스크톱 Vd·폰 Vm 모두 dpop 용도가 허용 목록에 있다). */
export type DpopSigner = Pick<Signer<typeof CTX.dpop>, 'sign'>;

export interface DpopProof {
  htm: string;
  htu: string;
  iat: number;
  jti: string;
  ath: string;
}

export const athOf = (boundTo: string): string => b64url(sha256Hash(utf8(boundTo)));

const METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE']);

/**
 * htu는 쿼리·조각 없는 공개 주소(origin + 경로). https만, 로컬 개발만 http://localhost·127.0.0.1. 개발 빌드가 allowDevLanHosts(true)를
 * 켰으면 같은 LAN의 mDNS `<이름>.local`도(ws-link의 insecureLocal과 같은 규칙, devhosts.ts).
 */
export function checkHtu(htu: string): string {
  let u: URL;
  try {
    u = new URL(htu);
  } catch {
    throw new Error('dpop: bad htu');
  }
  const local = u.protocol === 'http:' && u.hostname !== '[::1]' && isDevPlainHost(u.hostname);
  if ((u.protocol !== 'https:' && !local) || u.search || u.hash || u.username || u.password || htu.includes('?') || htu.includes('#')) {
    throw new Error('dpop: bad htu');
  }
  return htu;
}

export async function makeDpop(key: DpopSigner, o: { htm: string; htu: string; boundTo: string; now?: number; jti?: string }): Promise<string> {
  if (!METHODS.has(o.htm)) throw new Error('dpop: bad method');
  const proof: DpopProof = {
    htm: o.htm,
    htu: checkHtu(o.htu),
    iat: Math.floor((o.now ?? Date.now()) / 1000),
    jti: o.jti ?? b64url(randomBytes(16)),
    ath: athOf(o.boundTo),
  };
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(proof.jti)) throw new Error('dpop: bad jti');
  const sig = await key.sign(CTX.dpop, jcsBytes(proof));
  return `${b64url(jcsBytes(proof))}.${b64url(sig)}`;
}

/** 호출자가 넘기는 HTTP(JSON). 응답 본문은 JSON이거나 비어 있다. */
export type HttpJson = (req: { method: string; url: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; body: unknown }>;

export interface DeviceToken {
  token: string;
  expiresAt: number;
  scopes: string[];
}

/** 오류 본문은 {"error":"<영역>.<코드>"}(CONTRACT §7). 코드는 로컬 UI 전용이고 값·본문은 담지 않는다. */
export class DeviceAuthError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(`device-auth: ${status} ${code}`);
    this.status = status;
    this.code = code;
  }
}

const errCode = (b: unknown): string => {
  const e = (b as { error?: unknown } | null)?.error;
  return typeof e === 'string' && /^[a-z_]+\.[a-z_]+$/.test(e) ? e : 'unknown';
};

/** 계정 서비스 origin(예: https://account.tex.laf-co.com). 경로는 붙이지 않는다. */
const joinUrl = (origin: string, path: string) => `${origin.replace(/\/+$/, '')}${path}`;

/** POST /v1/device-tokens: AIK 인증서 + 그 인증서 Vx의 DPoP(ath = sha256(JCS(SignedCert))) → 15분 토큰. */
export async function requestDeviceToken(http: HttpJson, accountOrigin: string, cert: SignedCert, key: DpopSigner, now = Date.now()): Promise<DeviceToken> {
  const url = joinUrl(accountOrigin, '/v1/device-tokens');
  const dpop = await makeDpop(key, { htm: 'POST', htu: url, boundTo: jcs(cert), now });
  const r = await http({ method: 'POST', url, headers: { 'content-type': 'application/json', DPoP: dpop }, body: jcs({ cert }) });
  if (r.status !== 200) throw new DeviceAuthError(r.status, errCode(r.body));
  const b = r.body as Partial<DeviceToken> | null;
  if (!b || typeof b.token !== 'string' || !b.token.startsWith('sxd1.') || !Number.isSafeInteger(b.expiresAt) || !Array.isArray(b.scopes)) {
    throw new DeviceAuthError(r.status, 'response.shape');
  }
  return { token: b.token, expiresAt: b.expiresAt!, scopes: b.scopes.filter((s): s is string => typeof s === 'string') };
}

/** 토큰을 쓰는 요청의 헤더: Authorization: DPoP <token> + DPoP 증명(ath = sha256(토큰)). */
export async function deviceAuthHeaders(token: string, key: DpopSigner, htm: string, htu: string, now = Date.now()): Promise<Record<string, string>> {
  return { Authorization: `DPoP ${token}`, DPoP: await makeDpop(key, { htm, htu, boundTo: token, now }) };
}

/** 만료 1분 전에 새로 받는 토큰 보관(메모리만, 영속하지 않는다). */
export class DeviceTokenCache {
  #t: DeviceToken | null = null;
  readonly #get: () => Promise<DeviceToken>;
  readonly #now: () => number;
  constructor(get: () => Promise<DeviceToken>, now: () => number = Date.now) {
    this.#get = get;
    this.#now = now;
  }
  async token(): Promise<string> {
    if (!this.#t || this.#t.expiresAt - 60_000 <= this.#now()) this.#t = await this.#get();
    return this.#t.token;
  }
  clear(): void {
    this.#t = null;
  }
}
