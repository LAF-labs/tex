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
  client: AccountClient & { calls: string[] };
  http: HttpJson;
  close(): void;
}

const err = (status: number, body: unknown) => {
  const e = (body as { error?: unknown } | null)?.error;
  return Object.assign(new Error(`http ${status}`), { code: typeof e === 'string' ? e : `http.${status}` });
};

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

export const devStackPasswords = argon2Available();

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
    billing: async (auth) => ({
      ...((await call('GET', '/v1/billing/subscription', await auth('GET', ORIGIN + '/v1/billing/subscription'))) as never),
    }),
    billingCheckout: async (auth) => (await call('POST', '/v1/billing/checkout', await auth('POST', ORIGIN + '/v1/billing/checkout'))) as { checkoutUrl: string },
    billingCancel: async (auth) => void (await call('POST', '/v1/billing/cancel', await auth('POST', ORIGIN + '/v1/billing/cancel'))),
    billingRefund: async (auth) => (await call('POST', '/v1/billing/refund', await auth('POST', ORIGIN + '/v1/billing/refund'))) as { amountKrw: number },
    accountDeletion: async (auth) => (await call('GET', '/v1/account/deletion', await auth('GET', ORIGIN + '/v1/account/deletion'))) as { deleteAfter: number | null },
    requestAccountDelete: async (auth) => (await call('POST', '/v1/account/delete-request', await auth('POST', ORIGIN + '/v1/account/delete-request'), {})) as { deleteAfter: number },
    cancelAccountDelete: async (auth) => void (await call('POST', '/v1/account/delete-cancel', await auth('POST', ORIGIN + '/v1/account/delete-cancel'), {})),
  };
  return { clock, mail, svc, server, base, claimSigner, rooms, client, http, close: () => server.close() };
}

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
