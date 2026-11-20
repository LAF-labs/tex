import { fromB64 } from './crypto.ts';
import { fail, type ErrorCode } from './errors.ts';
import { InternalClient } from './internal-call.ts';
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
 * 내부 HTTP 구현(GET {base}/internal/v1/devices/{id}, 서명 호출). 같은 배포 안에서는 쓰지 않고 계정 서비스를 함수로 부른다(cloud 진입점).
 * 룸 호스트처럼 다른 호스트에서만 쓴다. 캐시는 짧게(기본 5초) 두고, 계정 서비스의 정지 알림(onStopped)이 오면 즉시 지운다.
 */
export class HttpDeviceDirectory implements DeviceDirectory {
  private readonly cache = new Map<string, { rec: DeviceRecord | null; until: number }>();
  private readonly client: InternalClient;
  private readonly ttlMs: number;
  private readonly now: () => number;
  constructor(o: { base: string; key: Buffer; ttlMs?: number; now?: () => number; fetchFn?: typeof fetch; timeoutMs?: number }) {
    this.client = new InternalClient({ base: o.base, key: o.key, fetchFn: o.fetchFn, now: o.now, timeoutMs: o.timeoutMs ?? 3000 });
    this.ttlMs = o.ttlMs ?? 5000;
    this.now = o.now ?? Date.now;
  }
  invalidate(deviceId: string): void {
    this.cache.delete(deviceId);
  }
  async get(deviceId: string): Promise<DeviceRecord | null> {
    const c = this.cache.get(deviceId);
    if (c && c.until > this.now()) return c.rec;
    const res = await this.client.request('GET', `/internal/v1/devices/${encodeURIComponent(deviceId)}`);
    let rec: DeviceRecord | null = null;
    if (res.status === 200) rec = (await res.json()) as DeviceRecord;
    else if (res.status !== 404) throw new Error('directory_unavailable');
    this.cache.set(deviceId, { rec, until: this.now() + this.ttlMs });
    return rec;
  }
}

export interface DeviceAuthOpts {
  verifier: TokenVerifier;
  directory: DeviceDirectory;
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

  async check(ctx: { method: string; path: string; headers: Record<string, string | string[] | undefined> }, scope: Scope | readonly Scope[], code: ErrorCode, suspendedCode: ErrorCode = code): Promise<DeviceClaims> {
    const now = this.o.now();
    const token = dpopToken(String(ctx.headers.authorization ?? ''), code);
    const claims = this.o.verifier.verify(token, now, code);
    const anyOf: readonly Scope[] = typeof scope === 'string' ? [scope] : scope;
    if (!anyOf.some((x) => claims.scp.includes(x))) fail('account.scope_denied');
    const dpop = ctx.headers.dpop;
    verifyDpop(Array.isArray(dpop) ? undefined : dpop, { method: ctx.method, htu: this.o.publicOrigin + ctx.path, token, cnf: fromB64(claims.cnf, 32)!, now, jti: this.jti, code });
    const rec = await this.o.directory.get(claims.dev);
    if (!rec || rec.accountId !== claims.acc || rec.role !== claims.role) fail(code);
    if (rec!.state !== 'active') fail(suspendedCode);
    return claims;
  }
}
