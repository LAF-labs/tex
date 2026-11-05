// 기기 범위 토큰 + DPoP 인증 미들웨어와 기기 상태 조회(긴급 정지 즉시 반영, D09 §2.2·D08 §9.3).
import { fromB64, safeEqual } from './crypto.ts';
import { fail, type ErrorCode } from './errors.ts';
import type { Ctx } from './http.ts';
import { JtiCache, TokenVerifier, dpopToken, verifyDpop, type DeviceClaims, type Scope } from './token.ts';

export type DeviceState = 'pending' | 'active' | 'suspended' | 'revoked';

export interface DeviceRecord {
  accountId: string;
  deviceId: string;
  role: 'desktop' | 'mobile';
  state: DeviceState;
}

/** 기기 상태의 정본은 계정 서비스다. 다른 서비스는 이 인터페이스로 묻는다(in-process 또는 HTTP 내부 API). */
export interface DeviceDirectory {
  get(deviceId: string): Promise<DeviceRecord | null>;
}

/**
 * 내부 HTTP 구현(GET {base}/internal/v1/devices/{id}). 캐시는 짧게(기본 5초) 두고, 계정 서비스의 정지 알림(onStopped)이 오면 즉시 지운다.
 * fetch는 주입한다(서비스 경계 밖 송신이 한 곳에 모이게).
 */
export class HttpDeviceDirectory implements DeviceDirectory {
  private readonly cache = new Map<string, { rec: DeviceRecord | null; until: number }>();
  private readonly base: string;
  private readonly secret: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  constructor(o: { base: string; secret: string; ttlMs?: number; now?: () => number; fetchFn?: typeof fetch }) {
    this.base = o.base;
    this.secret = o.secret;
    this.ttlMs = o.ttlMs ?? 5000;
    this.now = o.now ?? Date.now;
    this.fetchFn = o.fetchFn ?? fetch;
  }
  invalidate(deviceId: string): void {
    this.cache.delete(deviceId);
  }
  async get(deviceId: string): Promise<DeviceRecord | null> {
    const c = this.cache.get(deviceId);
    if (c && c.until > this.now()) return c.rec;
    const res = await this.fetchFn(`${this.base}/internal/v1/devices/${encodeURIComponent(deviceId)}`, { headers: { authorization: `Internal ${this.secret}` }, redirect: 'error' });
    let rec: DeviceRecord | null = null;
    if (res.status === 200) rec = (await res.json()) as DeviceRecord;
    else if (res.status !== 404) throw new Error('directory_unavailable');
    this.cache.set(deviceId, { rec, until: this.now() + this.ttlMs });
    return rec;
  }
}

export function requireInternal(ctx: Ctx, secret: string): void {
  const m = /^Internal (.+)$/.exec(String(ctx.headers.authorization ?? ''));
  if (!m || !secret || !safeEqual(m[1]!, secret)) fail('account.unauthorized');
}

export interface DeviceAuthOpts {
  verifier: TokenVerifier;
  directory: DeviceDirectory;
  /** 이 서비스가 공개하는 origin(예: https://gw.example). DPoP htu = origin + 경로 */
  publicOrigin: string;
  now: () => number;
  jti?: JtiCache;
}

export class DeviceAuth {
  private readonly o: DeviceAuthOpts;
  private readonly jti: JtiCache;
  constructor(o: DeviceAuthOpts) {
    this.o = o;
    this.jti = o.jti ?? new JtiCache();
  }

  /**
   * 토큰 서명·만료 → 범위 → DPoP(메서드·URL·시각·jti·ath·Vx 서명) → 계정 서비스의 기기 상태(active, 역할 일치) 순서로 본다.
   * 실패 코드는 하나(code)로 모은다(어느 단계에서 떨어졌는지 응답으로 알려 주지 않는다). 정지된 기기만 suspendedCode로 구분한다.
   */
  async check(ctx: { method: string; path: string; headers: Record<string, string | string[] | undefined> }, scope: Scope, code: ErrorCode, suspendedCode: ErrorCode = code): Promise<DeviceClaims> {
    const now = this.o.now();
    const token = dpopToken(String(ctx.headers.authorization ?? ''), code);
    const claims = this.o.verifier.verify(token, now, code);
    if (!claims.scp.includes(scope)) fail('account.scope_denied');
    const dpop = ctx.headers.dpop;
    verifyDpop(Array.isArray(dpop) ? undefined : dpop, { method: ctx.method, htu: this.o.publicOrigin + ctx.path, token, cnf: fromB64(claims.cnf, 32)!, now, jti: this.jti, code });
    const rec = await this.o.directory.get(claims.dev);
    if (!rec || rec.accountId !== claims.acc || rec.role !== claims.role) fail(code);
    if (rec!.state !== 'active') fail(suspendedCode);
    return claims;
  }
}
