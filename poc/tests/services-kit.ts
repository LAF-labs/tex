// 클라우드 서비스 시험 도구: 기기 키·AIK 서명·DPoP·소프트웨어 패스키·HTTP 클라이언트·시계.
// 클라이언트 쪽 서명 형식의 참조 구현이기도 하다(services/shared/CONTRACT.md). 레지스트리 서명 키는 여기에도 없다.
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { athOf, b64u, ed25519RawPublic, jcs, makeDpop, signCtx, type SigContext } from '../services/shared/src/index.ts';
import { encodeCbor } from '../services/account/src/cbor.ts';

export class Clock {
  t: number;
  constructor(t = Date.UTC(2026, 10, 10, 0, 0, 0)) {
    this.t = t;
  }
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}

export const H = 3600_000;
export const D = 24 * H;

export interface EdKey {
  priv: KeyObject;
  raw: Buffer;
  b64: string;
}

export function edKey(): EdKey {
  const { privateKey } = generateKeyPairSync('ed25519');
  const raw = ed25519RawPublic(privateKey);
  return { priv: privateKey, raw, b64: raw.toString('base64') };
}

export const sigB64 = (ctx: SigContext, obj: unknown, k: EdKey): string => signCtx(ctx, obj, k.priv).toString('base64');

export interface Device {
  id: string;
  role: 'desktop' | 'mobile';
  S: EdKey;
  V: EdKey;
  registeredAt: number;
}

export function device(role: 'desktop' | 'mobile', registeredAt: number): Device {
  return { id: randomUUID(), role, S: edKey(), V: edKey(), registeredAt };
}

export function entry(aik: EdKey, d: Device, listVersion: number) {
  const e = { device_id: d.id, role: d.role, Sx: d.S.b64, Vx: d.V.b64, registered_at: d.registeredAt, list_version: listVersion };
  return { entry: e, aikSig: sigB64('SAX-devlist-v1', e, aik) };
}

export function revokeRec(aik: EdKey, id: string, at: number) {
  return { device_id: id, revoked_at: at, aikSig: sigB64('SAX-revoke-v1', { device_id: id, revoked_at: at }, aik) };
}

export function cert(aik: EdKey, d: Device, notAfter: number) {
  const c = { device_id: d.id, role: d.role, Sx: d.S.b64, Vx: d.V.b64, not_after: notAfter };
  return { cert: c, aikSig: sigB64('SAX-cert-v1', c, aik) };
}

export function acctOp(aik: EdKey, op: 'device.reactivate' | 'slot.rebind_rk', accountId: string, target: string, ts: number) {
  const o = { op, account_id: accountId, target, ts };
  return { op: o, aikSig: sigB64('SAX-acct-op-v1', o, aik) };
}

export function dpop(method: string, htu: string, tokenOrBound: string, k: EdKey, nowMs: number): string {
  return makeDpop({ htm: method, htu, iat: Math.floor(nowMs / 1000), jti: b64u(randomBytes(16)), ath: athOf(tokenOrBound) }, k.priv);
}

export interface Res {
  status: number;
  json: Record<string, unknown> & { error?: string };
  headers: Headers;
  text: string;
}

export function client(base: string) {
  return async function req(method: string, path: string, o: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}): Promise<Res> {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    let body: string | undefined;
    if (o.raw !== undefined) {
      body = o.raw;
      headers['content-type'] ??= 'application/json';
    } else if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(base + path, { method, headers, body });
    const text = await res.text();
    let json: Record<string, unknown>;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      json = {};
    }
    return { status: res.status, json, headers: res.headers, text };
  };
}

/** 소프트웨어 패스키(ES256, attestation none, UV). 시험 전용. */
export class SoftPasskey {
  readonly key = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  readonly credId = randomBytes(32);
  count = 0;
  readonly rpId: string;
  readonly origin: string;
  constructor(rpId: string, origin: string) {
    this.rpId = rpId;
    this.origin = origin;
  }

  private authData(flags: number, attested?: Buffer): Buffer {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(this.count);
    return Buffer.concat([createHash('sha256').update(this.rpId).digest(), Buffer.from([flags]), c, attested ?? Buffer.alloc(0)]);
  }

  register(challenge: string, o: { origin?: string; flags?: number } = {}) {
    const jwk = this.key.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const cose = encodeCbor(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, 'base64url')],
        [-3, Buffer.from(jwk.y, 'base64url')],
      ]),
    );
    const len = Buffer.alloc(2);
    len.writeUInt16BE(this.credId.length);
    const attested = Buffer.concat([Buffer.alloc(16), len, this.credId, cose]);
    const authData = this.authData(o.flags ?? 0x45, attested);
    const att = encodeCbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin: o.origin ?? this.origin }));
    return { challenge, clientDataJSON: b64u(cd), attestationObject: b64u(att) };
  }

  assert(challenge: string, o: { origin?: string; flags?: number; keepCount?: boolean } = {}) {
    if (!o.keepCount) this.count++;
    const authData = this.authData(o.flags ?? 0x05);
    const cd = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin: o.origin ?? this.origin }));
    const sig = sign('sha256', Buffer.concat([authData, createHash('sha256').update(cd).digest()]), this.key.privateKey);
    return { challenge, credentialId: b64u(this.credId), clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(sig) };
  }
}

export { jcs };
