import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import http2 from 'node:http2';

export type Platform = 'apns' | 'apns_dev' | 'fcm';
export const PLATFORMS: readonly Platform[] = ['apns', 'apns_dev', 'fcm'];
/** 깨우기 종류(ADR-053 결정 3). approve: 승인을 기다리는 발급이 있다, update: 맡긴 일에 새 소식이 있다 */
export type WakeKind = 'approve' | 'update';
export const WAKE_KINDS: readonly WakeKind[] = ['approve', 'update'];
/** ok: 접수, invalid: 토큰이 더는 유효하지 않음(저장 토큰 삭제), retry: 일시 장애 */
export type SendResult = 'ok' | 'invalid' | 'retry';

export interface PushSender {
  send(platform: Platform, token: string, kind: WakeKind): Promise<SendResult>;
}

/**
 * 종류별 깨우기. 글은 앱 번들에 있고 서버는 현지화 키만 보낸다(SAX_WAKE_APPROVE "승인을 기다리는 발급이 있어요", SAX_WAKE_UPDATE "맡긴 일에 새 소식이 있어요").
 * 유효 시간: approve는 승인 게이트가 열려 있는 10분, update는 12시간. 같은 종류는 하나로 접힌다.
 */
export const WAKE = {
  approve: { locKey: 'SAX_WAKE_APPROVE', ttlSec: 600, collapse: 'sax-wake-approve' },
  update: { locKey: 'SAX_WAKE_UPDATE', ttlSec: 12 * 3600, collapse: 'sax-wake-update' },
} as const satisfies Record<WakeKind, { locKey: string; ttlSec: number; collapse: string }>;

/** APNs 페이로드: 현지화 키와 기본 소리뿐(거래처·금액·실행 번호 없음). mutable-content 없음(ADR-053 결정 6). */
export const apnsPayload = (kind: WakeKind) => ({ aps: { alert: { 'loc-key': WAKE[kind].locKey }, sound: 'default' } });

export const APNS_ORIGIN = { apns: 'https://api.push.apple.com', apns_dev: 'https://api.sandbox.push.apple.com' } as const;

export class MockPushSender implements PushSender {
  readonly sent: Array<{ platform: Platform; token: string; kind: WakeKind }> = [];
  readonly invalid = new Set<string>();
  failNext = 0;
  async send(platform: Platform, token: string, kind: WakeKind): Promise<SendResult> {
    if (this.failNext > 0) {
      this.failNext--;
      return 'retry';
    }
    if (this.invalid.has(token)) return 'invalid';
    this.sent.push({ platform, token, kind });
    return 'ok';
  }
}

const b64uJson = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

/**
 * APNs 제공자 토큰(ES256 JWT, 50분마다 갱신) + HTTP/2. 같은 키가 샌드박스와 운영 둘 다에 쓰인다.
 * 주소는 토큰을 올린 폰이 밝힌 플랫폼으로 고른다(apns_dev = 샌드박스, apns = 운영). production: false면 운영 토큰은 보내지 않고 'retry'(토큰은 지우지 않는다).
 */
export class ApnsSender implements PushSender {
  private readonly o: { origins: Record<'apns' | 'apns_dev', string>; production: boolean; teamId: string; keyId: string; key: KeyObject; topic: string; now: () => number };
  private jwt = { token: '', at: 0 };
  private readonly sessions = new Map<string, http2.ClientHttp2Session>();
  constructor(o: { origins?: Partial<Record<'apns' | 'apns_dev', string>>; production?: boolean; teamId: string; keyId: string; p8: string; topic: string; now?: () => number }) {
    this.o = { origins: { ...APNS_ORIGIN, ...o.origins }, production: o.production ?? false, teamId: o.teamId, keyId: o.keyId, key: createPrivateKey(o.p8), topic: o.topic, now: o.now ?? Date.now };
  }

  private bearer(): string {
    const now = this.o.now();
    if (!this.jwt.token || now - this.jwt.at > 50 * 60_000) {
      const input = `${b64uJson({ alg: 'ES256', kid: this.o.keyId })}.${b64uJson({ iss: this.o.teamId, iat: Math.floor(now / 1000) })}`;
      const sig = sign('sha256', Buffer.from(input), { key: this.o.key, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      this.jwt = { token: `${input}.${sig}`, at: now };
    }
    return this.jwt.token;
  }

  private client(origin: string): http2.ClientHttp2Session {
    let s = this.sessions.get(origin);
    if (!s || s.closed || s.destroyed) {
      const fresh = http2.connect(origin);
      fresh.on('error', () => this.sessions.get(origin) === fresh && this.sessions.delete(origin));
      fresh.unref();
      this.sessions.set(origin, fresh);
      s = fresh;
    }
    return s;
  }

  async send(platform: Platform, token: string, kind: WakeKind): Promise<SendResult> {
    if ((platform !== 'apns' && platform !== 'apns_dev') || !/^[0-9a-f]{64,200}$/.test(token)) return 'invalid';
    if (platform === 'apns' && !this.o.production) return 'retry';
    const w = WAKE[kind];
    const body = Buffer.from(JSON.stringify(apnsPayload(kind)));
    return new Promise<SendResult>((resolve) => {
      let req: http2.ClientHttp2Stream;
      try {
        req = this.client(this.o.origins[platform]).request({
          ':method': 'POST',
          ':path': `/3/device/${token}`,
          authorization: `bearer ${this.bearer()}`,
          'apns-topic': this.o.topic,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'apns-expiration': String(Math.floor(this.o.now() / 1000) + w.ttlSec),
          'apns-collapse-id': w.collapse,
          'content-type': 'application/json',
        });
      } catch {
        return resolve('retry');
      }
      req.setTimeout(10_000, () => req.close());
      let status = 0;
      let reply = '';
      req.on('response', (h) => (status = Number(h[':status'])));
      req.on('data', (d: Buffer) => (reply = (reply + d.toString('utf8')).slice(0, 512)));
      req.on('end', () => resolve(status === 200 ? 'ok' : status === 410 || (status === 400 && /BadDeviceToken|DeviceTokenNotForTopic/.test(reply)) ? 'invalid' : 'retry'));
      req.on('error', () => resolve('retry'));
      req.on('close', () => resolve('retry'));
      req.end(body);
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }
}

/**
 * FCM HTTP v1. 접근 토큰은 서비스 계정 JWT(RS256) → OAuth 교환으로 받는다. fetch는 주입한다.
 * 서버는 깨우기를 쌓아 두고 다시 보내지 않는다('retry'는 이번 깨우기가 안 갔다는 뜻이고, PC가 다음 의도에서 한도 안에서 다시 부른다).
 * 공급사가 429·5xx를 내면 Retry-After(없으면 30초, 최대 5분) 동안 공급사를 부르지 않는다. 호출마다 시간 제한(기본 10초).
 */
export class FcmSender implements PushSender {
  private readonly o: { endpoint: string; clientEmail: string; key: KeyObject; tokenUri: string; now: () => number; fetchFn: typeof fetch; timeoutMs: number };
  private access = { token: '', until: 0 };
  private backoffUntil = 0;
  constructor(o: { projectId: string; serviceAccountJson: string; endpointBase?: string; now?: () => number; fetchFn?: typeof fetch; timeoutMs?: number }) {
    const sa = JSON.parse(o.serviceAccountJson) as { client_email?: string; private_key?: string; token_uri?: string };
    if (!sa.client_email || !sa.private_key || !sa.token_uri || !/^https:\/\//.test(sa.token_uri)) throw new Error('config_FCM_SERVICE_ACCOUNT_JSON');
    this.o = {
      endpoint: `${o.endpointBase ?? 'https://fcm.googleapis.com'}/v1/projects/${encodeURIComponent(o.projectId)}/messages:send`,
      clientEmail: sa.client_email,
      key: createPrivateKey(sa.private_key),
      tokenUri: sa.token_uri,
      now: o.now ?? Date.now,
      fetchFn: o.fetchFn ?? fetch,
      timeoutMs: o.timeoutMs ?? 10_000,
    };
  }

  private async bearer(): Promise<string | null> {
    const now = this.o.now();
    if (this.access.token && now < this.access.until) return this.access.token;
    const iat = Math.floor(now / 1000);
    const input = `${b64uJson({ alg: 'RS256', typ: 'JWT' })}.${b64uJson({ iss: this.o.clientEmail, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: this.o.tokenUri, iat, exp: iat + 3600 })}`;
    const assertion = `${input}.${sign('sha256', Buffer.from(input), this.o.key).toString('base64url')}`;
    const res = await this.o.fetchFn(this.o.tokenUri, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(this.o.timeoutMs),
    }).catch(() => null);
    if (!res || res.status !== 200) return null;
    const j = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!j.access_token) return null;
    this.access = { token: j.access_token, until: now + Math.max(60, (j.expires_in ?? 3600) - 300) * 1000 };
    return this.access.token;
  }

  async send(platform: Platform, token: string, kind: WakeKind): Promise<SendResult> {
    if (platform !== 'fcm' || !/^[A-Za-z0-9_:-]{32,4096}$/.test(token)) return 'invalid';
    if (this.o.now() < this.backoffUntil) return 'retry';
    const bearer = await this.bearer();
    if (!bearer) return 'retry';
    const res = await this.o.fetchFn(this.o.endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token, data: { t: 'wake', k: kind }, android: { priority: 'HIGH', ttl: `${WAKE[kind].ttlSec}s`, collapse_key: WAKE[kind].collapse } } }),
      redirect: 'error',
      signal: AbortSignal.timeout(this.o.timeoutMs),
    }).catch(() => null);
    if (!res) return 'retry';
    if (res.status === 200) return 'ok';
    if (res.status === 404) return 'invalid';
    if (res.status === 400) {
      const t = await res.text().catch(() => '');
      return /UNREGISTERED|INVALID_ARGUMENT/.test(t) ? 'invalid' : 'retry';
    }
    if (res.status === 401) this.access = { token: '', until: 0 };
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      this.backoffUntil = this.o.now() + Math.min(Number.isFinite(ra) && ra > 0 ? ra : 30, 300) * 1000;
    }
    return 'retry';
  }
}

/** 플랫폼별 발송기 묶음 */
export class RoutingSender implements PushSender {
  private readonly by: Partial<Record<Platform, PushSender>>;
  constructor(by: Partial<Record<Platform, PushSender>>) {
    this.by = by;
  }
  send(platform: Platform, token: string, kind: WakeKind): Promise<SendResult> {
    const s = this.by[platform];
    return s ? s.send(platform, token, kind) : Promise.resolve('retry');
  }
}
