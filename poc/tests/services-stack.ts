// 시험용 계정 서비스 스택: 게이트웨이·릴레이 시험이 실제 계정 서비스가 발급한 기기 범위 토큰으로 붙도록 한다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { Logger, TokenIssuer, TokenVerifier, createServer, ed25519RawPublic, jcs, listen, migrate, openSqlite, type DeviceDirectory, type Sql } from '../services/shared/src/index.ts';
import { AccountService, AcctClaimSigner, MIGRATIONS_DIR, MockMailSender, MockPaymentGateway, accountRouter, type DeviceStopHook, type PairingRooms } from '../services/account/src/index.ts';
import { Clock, D, cert, client, device, dpop, edKey, entry, type Device, type EdKey } from './services-kit.ts';

export const ACCOUNT_ORIGIN = 'https://account.test.invalid';

export interface Stack {
  clock: Clock;
  db: Sql;
  mail: MockMailSender;
  svc: AccountService;
  server: Server;
  req: ReturnType<typeof client>;
  verifier: TokenVerifier;
  directory: DeviceDirectory;
  stopped: string[];
  hooks: DeviceStopHook[];
  /** 페어링 룸 소비 확인(릴레이 시험이 실제 릴레이 내부 API로 바꿔 끼운다). 기본은 항상 실패 */
  pairing: { impl: PairingRooms | null };
  /** acct_claim 고정용 공개키(표준 base64). 서명 키를 끈 스택이면 null */
  acctClaimPub: string | null;
  close(): void;
}

export async function accountStack(clock = new Clock(), o: { acctClaims?: boolean } = {}): Promise<Stack> {
  const db = openSqlite();
  await migrate(db, 'account', MIGRATIONS_DIR);
  const mail = new MockMailSender();
  const signKey = edKey().priv;
  const stopped: string[] = [];
  const hooks: DeviceStopHook[] = [{ stopped: async (id) => void stopped.push(id) }];
  const pairing: Stack['pairing'] = { impl: null };
  const acctClaims = o.acctClaims === false ? undefined : AcctClaimSigner.fromSeedHex(randomBytes(32).toString('hex'));
  const svc = new AccountService({
    db,
    mail,
    payments: new MockPaymentGateway(),
    tokens: new TokenIssuer('k1', signKey),
    codeMacKey: randomBytes(32),
    rp: { rpId: 'account.test.invalid', origins: [ACCOUNT_ORIGIN] },
    publicOrigin: ACCOUNT_ORIGIN,
    billingReturnUrl: 'https://app.test.invalid/done',
    stopHooks: hooks,
    acctClaims,
    pairing: { redeem: (roomId, dev) => (pairing.impl ? pairing.impl.redeem(roomId, dev) : Promise.resolve(false)) },
    now: clock.now,
  });
  const verifier = new TokenVerifier({ k1: ed25519RawPublic(signKey) });
  const server = createServer(accountRouter({ svc, verifier, publicOrigin: ACCOUNT_ORIGIN, internalSecret: 'internal-test' }), { logger: new Logger('account', () => undefined, clock.now) });
  const req = client(await listen(server));
  return { clock, db, mail, svc, server, req, verifier, directory: { get: (id) => svc.deviceRecord(id) }, stopped, hooks, pairing, acctClaimPub: acctClaims?.publicKey ?? null, close: () => server.close() };
}

export interface Signed {
  aik: EdKey;
  d: Device;
  accountId: string;
  session: string;
  /** 계정 서비스에서 새 기기 범위 토큰을 받는다 */
  token(): Promise<string>;
  /** 다른 서비스 호출용 헤더(Authorization: DPoP + DPoP 증명) */
  headers(method: string, origin: string, path: string, token: string): Record<string, string>;
}

export async function login(s: Stack, email: string): Promise<string> {
  const a = await s.req('POST', '/v1/auth/code', { body: { email } });
  const v = await s.req('POST', '/v1/auth/code/verify', { body: { loginId: a.json.loginId, code: s.mail.lastCode(email) } });
  assert.equal(v.status, 200, v.text);
  return v.json.session as string;
}

export async function signedDesktop(s: Stack, email: string): Promise<Signed> {
  const session = await login(s, email);
  const aik = edKey();
  const d = device('desktop', s.clock.now());
  const r = await s.req('POST', '/v1/aik', { headers: { authorization: `Bearer ${session}` }, body: { aikPub: aik.b64, deviceList: { listVersion: 1, entries: [entry(aik, d, 1)], revoked: [] }, platform: 'windows', name: 'PC' } });
  assert.equal(r.status, 201, r.text);
  const accountId = (await s.db.one<{ id: string }>('SELECT id FROM accounts WHERE email = $1', [email]))!.id;
  return {
    aik,
    d,
    accountId,
    session,
    token: () => deviceToken(s, aik, d),
    headers: (method, origin, path, token) => ({ authorization: `DPoP ${token}`, dpop: dpop(method, origin + path, token, d.V, s.clock.now()) }),
  };
}

export async function deviceToken(s: Stack, aik: EdKey, d: Device): Promise<string> {
  const c = cert(aik, d, s.clock.now() + 90 * D);
  const t = await s.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ACCOUNT_ORIGIN + '/v1/device-tokens', jcs(c), d.V, s.clock.now()) }, body: { cert: c } });
  assert.equal(t.status, 200, t.text);
  return t.json.token as string;
}

/** 폰 등록 → PC가 AIK 목록에 넣어 활성화 → 폰 토큰 */
export async function signedPhone(s: Stack, pc: Signed): Promise<{ d: Device; token(): Promise<string>; headers: Signed['headers'] }> {
  const phone = device('mobile', s.clock.now());
  const en = await s.req('POST', '/v1/devices/enroll', { headers: { authorization: `Bearer ${pc.session}` }, body: { deviceId: phone.id, role: 'mobile', platform: 'ios', name: '폰', Sx: phone.S.b64, Vx: phone.V.b64 } });
  assert.equal(en.status, 201, en.text);
  const cur = (await s.req('GET', '/v1/device-list', { headers: { authorization: `Bearer ${pc.session}` } })).json.deviceList as { listVersion: number; entries: unknown[] };
  const t = await pc.token();
  const up = await s.req('PUT', '/v1/device-list', {
    headers: pc.headers('PUT', ACCOUNT_ORIGIN, '/v1/device-list', t),
    body: { deviceList: { listVersion: cur.listVersion + 1, entries: [...cur.entries, entry(pc.aik, phone, cur.listVersion + 1)], revoked: [] } },
  });
  assert.equal(up.status, 200, up.text);
  return {
    d: phone,
    token: () => deviceToken(s, pc.aik, phone),
    headers: (method, origin, path, token) => ({ authorization: `DPoP ${token}`, dpop: dpop(method, origin + path, token, phone.V, s.clock.now()) }),
  };
}
