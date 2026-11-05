// 개발용 계정 서비스 대역: POST /v1/device-tokens(AIK 인증서 + DPoP → 15분 토큰)와, 릴레이가 쓰는 토큰·DPoP 검사.
// 형식은 services/shared/CONTRACT.md §2·§3, services/account/API.md와 같다(서버 구현 대신 쓰는 시험 대역이다).
import {
  CTX, athOf, b64url, ed25519Verify, jcs, parseJcs, randomBytes, verifyCert, type SignedCert,
} from '../../../packages/remote/src/index.ts';

const TOKEN_MS = 15 * 60_000;
const IAT_SKEW_S = 60;

interface Issued {
  deviceId: string;
  role: 'desktop' | 'mobile';
  vx: Uint8Array;
  exp: number;
}

export class DevAuth {
  #tokens = new Map<string, Issued>();
  #jti = new Set<string>();
  readonly #aikPub: Uint8Array;
  readonly #origin: string;
  constructor(aikPub: Uint8Array, origin: string) {
    this.#aikPub = aikPub;
    this.#origin = origin;
  }

  /** POST /v1/device-tokens 본문·DPoP 헤더 → 응답. */
  issue(body: string, dpop: string | undefined, now = Date.now()): { status: number; body: unknown } {
    let cert: SignedCert;
    try {
      cert = (JSON.parse(body) as { cert: SignedCert }).cert;
    } catch {
      return { status: 400, body: { error: 'request.param_rejected' } };
    }
    const c = verifyCert(cert, this.#aikPub, now);
    if (!c) return { status: 401, body: { error: 'account.cert_invalid' } };
    if (!this.#dpop(dpop, 'POST', `${this.#origin}/v1/device-tokens`, jcs(cert), c.Vx, now)) return { status: 401, body: { error: 'account.dpop_invalid' } };
    const token = `sxd1.${b64url(randomBytes(24))}`;
    const exp = now + TOKEN_MS;
    this.#tokens.set(token, { deviceId: c.device_id, role: c.role === 'desktop' ? 'desktop' : 'mobile', vx: c.Vx, exp });
    return { status: 200, body: { token, expiresAt: exp, scopes: ['relay'] } };
  }

  /** 토큰을 쓰는 요청(릴레이 업그레이드 등)의 Authorization·DPoP 검사. 통과하면 기기 역할과 만료. */
  check(authorization: string | undefined, dpop: string | undefined, htm: string, htu: string, now = Date.now()): Issued | null {
    const m = /^DPoP (sxd1\.[A-Za-z0-9_-]+)$/.exec(authorization ?? '');
    const t = m ? this.#tokens.get(m[1]!) : undefined;
    if (!t || t.exp <= now) return null;
    return this.#dpop(dpop, htm, htu, m![1]!, t.vx, now) ? t : null;
  }

  #dpop(h: string | undefined, htm: string, htu: string, boundTo: string, vx: Uint8Array, now: number): boolean {
    const parts = (h ?? '').split('.');
    if (parts.length !== 2) return false;
    const bytes = new Uint8Array(Buffer.from(parts[0]!, 'base64url'));
    const sig = new Uint8Array(Buffer.from(parts[1]!, 'base64url'));
    const p = parseJcs(bytes) as { htm?: unknown; htu?: unknown; iat?: unknown; jti?: unknown; ath?: unknown } | null;
    if (!p || typeof p !== 'object' || Object.keys(p).sort().join() !== 'ath,htm,htu,iat,jti') return false;
    if (p.htm !== htm || p.htu !== htu || p.ath !== athOf(boundTo)) return false;
    if (typeof p.iat !== 'number' || Math.abs(p.iat - now / 1000) > IAT_SKEW_S) return false;
    if (typeof p.jti !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(p.jti) || this.#jti.has(p.jti)) return false;
    if (!ed25519Verify(vx, CTX.dpop, bytes, sig)) return false;
    this.#jti.add(p.jti);
    return true;
  }
}
