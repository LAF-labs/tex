// 데스크톱 계정·페어링 시험용 개발 스택: 실제 계정 서비스(services/account, SQLite 메모리)를 localhost에 띄우고,
// remote-ports.ts의 AccountClient를 fetch로 구현한 시험용 클라이언트와 소프트 DesktopKeys를 준다.
// 제품 클라이언트(egress 경유)는 apps/desktop/src/remote-cloud.ts다. 이 파일은 시험에서만 쓴다.
// 이 클라이언트도 보내기 전에 제품 egress 허용 목록(@sax/net cloudRequestCheck)을 거친다. 목록에 없는 경로는 제품과 같이
// net.path_not_allowed로 실패한다(#224 비밀번호 로그인이 시험을 지나고 실제 앱에서 막힌 결함의 재발 방지).
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { AIK_PURPOSES, requestDeviceToken, softNoiseStatic, softSigner, VD_PURPOSES, x25519Public, type DesktopKeys, type HttpJson, type SignedAcctClaim } from '@sax/remote';
import { fileURLToPath } from 'node:url';
import { CLOUD_ORIGIN, cloudRequestCheck } from '@sax/net';
import { AcctClaimSigner, AccountService, accountRouter, argon2Available, COMMON_PASSWORDS_FILE, CommonPasswords, MIGRATIONS_DIR, MockMailSender, MockPaymentGateway, parsePepperKeys, PasswordHasher } from '../services/account/src/index.ts';
import { createServer, ed25519RawPublic, Logger, listen, migrate, openSqlite, TokenIssuer, TokenVerifier } from '../services/shared/src/index.ts';
import type { AccountClient, AccountLogin, AccountMe } from '../apps/desktop/src/remote-ports.ts';
import { Clock, edKey } from './services-kit.ts';

export const ORIGIN = 'https://account.test.invalid';

export interface DevStack {
  clock: Clock;
  mail: MockMailSender;
  svc: AccountService;
  server: Server;
  base: string;
  claimSigner: AcctClaimSigner;
  rooms: FakeRooms;
  /** 시험용 AccountClient(요청 URL은 ORIGIN으로 만들고 localhost로 보낸다: DPoP htu는 서버 publicOrigin 기준). */
  client: AccountClient & { calls: string[] };
  http: HttpJson;
  close(): void;
}

const err = (status: number, body: unknown) => {
  const e = (body as { error?: unknown } | null)?.error;
  return Object.assign(new Error(`http ${status}`), { code: typeof e === 'string' ? e : `http.${status}` });
};

/** 릴레이 룸 소비 대역(services/account PairingRooms): 데스크톱이 연 룸만, 한 번만. */
export class FakeRooms {
  readonly opened = new Map<string, { owner: string; used: boolean }>();
  open(roomId: string, owner: string) {
    this.opened.set(roomId, { owner, used: false });
  }
  async redeem(roomId: string, desktopDeviceId: string): Promise<'ok' | 'used' | 'unavailable'> {
    const r = this.opened.get(roomId);
    if (!r || r.owner !== desktopDeviceId) return 'unavailable';
    if (r.used) return 'used';
    r.used = true;
    return 'ok';
  }
}

/** 이 런타임에서 비밀번호 경로를 켤 수 있나(argon2id). 없으면 비밀번호 시험은 건너뛴다. */
export const devStackPasswords = argon2Available();

/** passwords: 비밀번호 경로(ADR-038)를 켠다(실제 argon2id + 페퍼, 흔한 비밀번호 목록). 기본은 꺼짐(지금 운영 기본과 같다). */
export async function startDevStack(o: { passwords?: boolean } = {}): Promise<DevStack> {
  const clock = new Clock();
  const db = openSqlite();
  await migrate(db, 'account', MIGRATIONS_DIR);
  const mail = new MockMailSender();
  const signKey = edKey().priv;
  const claimSigner = AcctClaimSigner.fromSeedHex(randomBytes(32).toString('hex'));
  const rooms = new FakeRooms();
  const svc = new AccountService({
    db,
    mail,
    payments: new MockPaymentGateway(),
    tokens: new TokenIssuer('k1', signKey),
    codeMacKey: randomBytes(32),
    rp: { rpId: 'account.test.invalid', origins: [ORIGIN] },
    publicOrigin: ORIGIN,
    billingReturnUrl: 'https://app.test.invalid/billing/done',
    acctClaims: claimSigner,
    pairing: rooms,
    now: clock.now,
    ...(o.passwords && devStackPasswords
      ? { passwords: { hasher: new PasswordHasher(parsePepperKeys(`k1:${randomBytes(32).toString('hex')}`)!), common: CommonPasswords.fromFile(fileURLToPath(COMMON_PASSWORDS_FILE)), onEvent: () => {} } }
      : {}),
  });
  const router = accountRouter({ svc, verifier: new TokenVerifier({ k1: ed25519RawPublic(signKey) }), publicOrigin: ORIGIN, internalSecret: randomBytes(32).toString('hex') });
  const server = createServer(router, { logger: new Logger('account', (l) => process.env.SAX_DEVSTACK_LOG && console.error(l), clock.now) });
  const base = await listen(server);
  const http: HttpJson = async (req) => {
    const res = await fetch(req.url.replace(ORIGIN, base), { method: req.method, headers: req.headers, body: req.body });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const calls: string[] = [];
  const call = async (method: string, path: string, headers: Record<string, string>, body?: unknown) => {
    // 제품 egress와 같은 판정: 운영 origin에서 이 (메서드, 경로)가 허용 목록에 있어야 보낸다.
    if (typeof cloudRequestCheck(method, CLOUD_ORIGIN + path) !== 'object') throw Object.assign(new Error('net.path_not_allowed'), { code: 'net.path_not_allowed' });
    calls.push(`${method} ${path}`);
    const r = await http({ method, url: ORIGIN + path, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status >= 300) throw err(r.status, r.body);
    return r.body as Record<string, unknown>;
  };
  const bearer = (s: string) => ({ authorization: `Bearer ${s}` });
  const client: AccountClient & { calls: string[] } = {
    calls,
    startEmailCode: async (email) => (await call('POST', '/v1/auth/code', {}, { email })) as { loginId: string; expiresInSec: number },
    verifyEmailCode: async (loginId, code, remember) => (await call('POST', '/v1/auth/code/verify', {}, { loginId, code, ...(remember ? { remember } : {}) })) as unknown as AccountLogin,
    passwordLogin: async (email, password, remember) => (await call('POST', '/v1/auth/password', {}, { email, password, ...(remember ? { remember } : {}) })) as unknown as AccountLogin,
    me: async (s) => (await call('GET', '/v1/me', bearer(s))) as unknown as AccountMe,
    setPassword: async (s, password, currentPassword) => ((await call('PUT', '/v1/password', bearer(s), currentPassword === undefined ? { password } : { password, currentPassword })) ?? {}) as { refreshToken?: string },
    deletePassword: async (s) => void (await call('DELETE', '/v1/password', bearer(s))),
    startReauth: async (s) => (await call('POST', '/v1/auth/reauth', bearer(s), {})) as { reauthId: string; expiresInSec: number },
    verifyReauth: async (s, reauthId, code) => (await call('POST', '/v1/auth/reauth/verify', bearer(s), { reauthId, code })) as { authAt: number; reauthMaxAgeSec: number },
    startPasswordReset: async (email) => (await call('POST', '/v1/auth/password/reset', {}, { email })) as { resetId: string; expiresInSec: number },
    verifyPasswordReset: async (resetId, code, password, remember) => (await call('POST', '/v1/auth/password/reset/verify', {}, { resetId, code, password, ...(remember ? { remember } : {}) })) as unknown as AccountLogin,
    refresh: async (refreshToken) => (await call('POST', '/v1/auth/refresh', {}, { refreshToken })) as unknown as Required<AccountLogin>,
    revokeRefresh: async (refreshToken) => void (await call('POST', '/v1/auth/refresh/revoke', {}, { refreshToken })),
    logoutAll: async (s) => void (await call('POST', '/v1/auth/logout-all', bearer(s), {})),
    logout: async (s) => void (await call('POST', '/v1/auth/logout', bearer(s))),
    deviceList: async (s) => (await call('GET', '/v1/device-list', bearer(s))) as never,
    pinFirstDesktop: async (s, b) => (await call('POST', '/v1/aik', bearer(s), b)) as { deviceId: string },
    deviceToken: async (cert, dpop, scopes) => {
      calls.push(scopes ? `POST /v1/device-tokens ${scopes.join(',')}` : 'POST /v1/device-tokens');
      const h: HttpJson = scopes ? (req) => http({ ...req, body: JSON.stringify({ ...(JSON.parse(req.body!) as object), scopes: [...scopes] }) }) : http;
      return requestDeviceToken(h, ORIGIN, cert, dpop, clock.now());
    },
    acctClaim: async (auth) => (await call('GET', '/v1/acct-claim', await auth('GET', ORIGIN + '/v1/acct-claim'))) as unknown as SignedAcctClaim,
    enrollPhone: async (auth, b) => void (await call('POST', '/v1/devices/enroll', await auth('POST', ORIGIN + '/v1/devices/enroll'), b)),
    putDeviceList: async (auth, list) => void (await call('PUT', '/v1/device-list', await auth('PUT', ORIGIN + '/v1/device-list'), { deviceList: list })),
  };
  return { clock, mail, svc, server, base, claimSigner, rooms, client, http, close: () => server.close() };
}

/** 소프트 DesktopKeys(금고 대역). 같은 seed면 같은 키(같은 금고로 다시 설치). */
export function softDesktopKeys(seed = randomBytes(32)): DesktopKeys {
  const part = (i: number) => {
    const b = new Uint8Array(seed);
    b[0] = (b[0]! + i) & 0xff;
    return b;
  };
  const kv = part(4);
  return {
    noise: softNoiseStatic(part(1)),
    vd: softSigner(part(2), VD_PURPOSES),
    aik: softSigner(part(3), AIK_PURPOSES),
    kvPublic: () => x25519Public(kv),
  };
}
