// M4-5 계정·구독 서비스(D09 §2·§2.1·§2.2·§10): 요청 검증·권한·한도마다 시험한다. DB는 node:sqlite 메모리, PG·메일은 모의.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import {
  FORBIDDEN_COLUMN,
  Logger,
  PROPOSED_D16,
  TokenIssuer,
  TokenVerifier,
  createServer,
  ed25519RawPublic,
  jcs,
  listen,
  looksSensitive,
  migrate,
  openSqlite,
  schemaColumns,
  signInternalCall,
  type Sql,
} from '../services/shared/src/index.ts';
import { ACCOUNT_VISIBILITY, AccountService, MIGRATIONS_DIR, MockMailSender, MockPaymentGateway, accountRouter } from '../services/account/src/index.ts';
import { DEVICE, ISSUE_LOCK, PC_LINK } from '../services/account/src/constants.ts';
import { Clock, D, H, SoftPasskey, acctOp, cert, client, device, dpop, edKey, entry, internalAuth, internalHeaders, revokeRec, type Device, type EdKey } from './services-kit.ts';

const ORIGIN = 'https://account.test.invalid';
const RP = { rpId: 'account.test.invalid', origins: [ORIGIN] };

interface Env {
  clock: Clock;
  db: Sql;
  mail: MockMailSender;
  pg: MockPaymentGateway;
  svc: AccountService;
  server: Server;
  req: ReturnType<typeof client>;
  logs: string[];
  stopped: string[];
  events: string[];
  verifyKey: Uint8Array;
}

async function start(): Promise<Env> {
  const clock = new Clock();
  const db = openSqlite();
  await migrate(db, 'account', MIGRATIONS_DIR);
  const mail = new MockMailSender();
  const pg = new MockPaymentGateway();
  const signKey = edKey().priv;
  const stopped: string[] = [];
  const events: string[] = [];
  const svc = new AccountService({
    db,
    mail,
    payments: pg,
    tokens: new TokenIssuer('k1', signKey),
    codeMacKey: randomBytes(32),
    rp: RP,
    publicOrigin: ORIGIN,
    billingReturnUrl: 'https://app.test.invalid/billing/done',
    stopHooks: [{ stopped: async (id) => void stopped.push(id) }],
    onEvent: (n) => void events.push(n),
    now: clock.now,
  });
  const logs: string[] = [];
  const router = accountRouter({ svc, verifier: new TokenVerifier({ k1: ed25519RawPublic(signKey) }), publicOrigin: ORIGIN, internal: internalAuth() });
  const server = createServer(router, { logger: new Logger('account', (l) => logs.push(l), clock.now) });
  const base = await listen(server);
  return { clock, db, mail, pg, svc, server, req: client(base), logs, stopped, events, verifyKey: ed25519RawPublic(signKey) };
}

const bearer = (s: string) => ({ authorization: `Bearer ${s}` });

async function login(e: Env, email: string): Promise<string> {
  const s = await e.req('POST', '/v1/auth/code', { body: { email } });
  assert.equal(s.status, 200);
  const v = await e.req('POST', '/v1/auth/code/verify', { body: { loginId: s.json.loginId, code: e.mail.lastCode(email.toLowerCase()) } });
  assert.equal(v.status, 200, v.text);
  return v.json.session as string;
}

/** 첫 데스크톱 + AIK 고정 + 기기 토큰까지 */
async function desktop(e: Env, session: string): Promise<{ aik: EdKey; d: Device; token: () => Promise<string>; call: (m: string, p: string, body?: unknown) => ReturnType<Env['req']> }> {
  const aik = edKey();
  const d = device('desktop', e.clock.now());
  const r = await e.req('POST', '/v1/aik', { headers: bearer(session), body: { aikPub: aik.b64, deviceList: { listVersion: 1, entries: [entry(aik, d, 1)], revoked: [] }, platform: 'windows', name: '사무실 PC' } });
  assert.equal(r.status, 201, r.text);
  const token = async () => {
    const c = cert(aik, d, e.clock.now() + 90 * D);
    const t = await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), d.V, e.clock.now()) }, body: { cert: c } });
    assert.equal(t.status, 200, t.text);
    return t.json.token as string;
  };
  const call = async (m: string, p: string, body?: unknown) => {
    const t = await token();
    return e.req(m, p, { headers: { authorization: `DPoP ${t}`, dpop: dpop(m, ORIGIN + p, t, d.V, e.clock.now()) }, body });
  };
  return { aik, d, token, call };
}

/** 그 기기의 인증서(AIK 서명)로 기기 토큰을 받아 부른다. 데스크톱·폰 공통 */
function caller(e: Env, aik: EdKey, d: Device) {
  return async (m: string, p: string, body?: unknown) => {
    const c = cert(aik, d, e.clock.now() + 90 * D);
    const t = await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), d.V, e.clock.now()) }, body: { cert: c } });
    assert.equal(t.status, 200, t.text);
    const tok = t.json.token as string;
    return e.req(m, p, { headers: { authorization: `DPoP ${tok}`, dpop: dpop(m, ORIGIN + p, tok, d.V, e.clock.now()) }, body });
  };
}

/** 첫 PC + 두 번째 PC + 폰 n대를 모두 활성으로(목록 v2). */
async function fleet(e: Env, email: string, phones = 2): Promise<{ s: string; pc: Awaited<ReturnType<typeof desktop>>; d2: Device; ps: Device[]; state: (id: string) => Promise<Record<string, unknown>> }> {
  const s = await login(e, email);
  const pc = await desktop(e, s);
  e.clock.advance(60_000); // 두 번째 PC는 AIK 고정 뒤에 붙는다(첫 PC와 등록 시각이 같을 수 없다)
  const d2 = device('desktop', e.clock.now());
  const ps = Array.from({ length: phones }, () => device('mobile', e.clock.now()));
  assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: d2.id, role: 'desktop', platform: 'macos', name: '집 PC', Sx: d2.S.b64, Vx: d2.V.b64 } })).status, 201);
  for (const p of ps) assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: p.id, role: 'mobile', platform: 'ios', name: '폰', Sx: p.S.b64, Vx: p.V.b64 } })).status, 201);
  const up = await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, d2, 2), ...ps.map((p) => entry(pc.aik, p, 2))], revoked: [] } });
  assert.equal(up.status, 200, up.text);
  const state = async (id: string) => ((await pc.call('GET', '/v1/devices')).json.devices as Array<Record<string, unknown>>).find((x) => x.deviceId === id)!;
  return { s, pc, d2, ps, state };
}

describe('M4-5 계정: 이메일 6자리 코드 로그인(C-30)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('코드 발급 → 같은 loginId로 검증 → 세션, 계정은 첫 검증 때 만든다', async () => {
    const s = await login(e, 'Owner@Example.com');
    const me = await e.req('GET', '/v1/me', { headers: bearer(s) });
    assert.equal(me.status, 200);
    assert.equal(me.json.email, 'owner@example.com');
    assert.equal(me.json.aikPinned, false);
  });

  it('틀린 코드 5회면 잠기고, 맞는 코드도 더는 통하지 않는다', async () => {
    const s = await e.req('POST', '/v1/auth/code', { body: { email: 'a@example.com' } });
    const code = e.mail.lastCode('a@example.com')!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 4; i++) assert.equal((await e.req('POST', '/v1/auth/code/verify', { body: { loginId: s.json.loginId, code: wrong } })).json.error, 'account.code_invalid');
    assert.equal((await e.req('POST', '/v1/auth/code/verify', { body: { loginId: s.json.loginId, code: wrong } })).json.error, 'account.code_locked');
    assert.equal((await e.req('POST', '/v1/auth/code/verify', { body: { loginId: s.json.loginId, code } })).json.error, 'account.code_invalid');
  });

  it('코드는 10분 뒤 만료, 다른 loginId로는 완료할 수 없다(세션 결속)', async () => {
    const a = await e.req('POST', '/v1/auth/code', { body: { email: 'b@example.com' } });
    const codeA = e.mail.lastCode('b@example.com')!;
    const b = await e.req('POST', '/v1/auth/code', { body: { email: 'b@example.com' } });
    assert.equal((await e.req('POST', '/v1/auth/code/verify', { body: { loginId: b.json.loginId, code: codeA } })).status, 400);
    e.clock.advance(10 * 60_000 + 1);
    assert.equal((await e.req('POST', '/v1/auth/code/verify', { body: { loginId: a.json.loginId, code: codeA } })).json.error, 'account.code_invalid');
  });

  it('같은 이메일 코드 발급은 시간당 5회, 스키마 밖 필드·잘못된 본문은 400이고 응답은 입력을 되풀이하지 않는다', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await e.req('POST', '/v1/auth/code', { body: { email: 'c@example.com' } })).status, 200);
    const sixth = await e.req('POST', '/v1/auth/code', { body: { email: 'c@example.com' } });
    assert.equal(sixth.status, 429);
    assert.equal(sixth.json.error, 'policy.rate_limited');
    assert.ok(Number(sixth.headers.get('retry-after')) > 0);
    const extra = await e.req('POST', '/v1/auth/code', { body: { email: 'd@example.com', admin: true } });
    assert.deepEqual([extra.status, extra.json], [400, { error: 'request.param_rejected' }]);
    const bad = await e.req('POST', '/v1/auth/code', { raw: '{"email":' });
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes('email'));
    const nonJson = await e.req('POST', '/v1/auth/code', { raw: 'email=x', headers: { 'content-type': 'text/plain' } });
    assert.equal(nonJson.json.error, 'request.unsupported_media');
    const big = await e.req('POST', '/v1/auth/code', { body: { email: 'x'.repeat(70_000) } });
    assert.equal(big.json.error, 'request.too_large');
  });

  it('세션 없는·위조 세션·기기 토큰은 계정 세션 API에서 거부', async () => {
    assert.equal((await e.req('GET', '/v1/me')).json.error, 'account.unauthorized');
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer('sxs1.' + 'A'.repeat(43)) })).json.error, 'account.unauthorized');
    assert.equal((await e.req('GET', '/v1/me', { headers: { authorization: 'DPoP sxd1.x.y' } })).json.error, 'account.unauthorized');
    const s = await login(e, 'e@example.com');
    e.clock.advance(H - 1);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).status, 200);
    e.clock.advance(1);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.error, 'account.unauthorized', '세션 1시간(ADR-038 (f))');
  });
});

describe('M4-5 계정: 데스크톱 루프백 + PKCE(RFC 8252, 디바이스 플로우 없음)', () => {
  let e: Env;
  before(async () => (e = await start()));
  after(() => e.server.close());

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('base64url');

  it('루프백 IP 주소만 받는다(localhost·https·외부 호스트 거부)', async () => {
    const s = await login(e, 'pkce@example.com');
    for (const uri of ['http://localhost:51234/cb', 'https://127.0.0.1:51234/cb', 'http://evil.example/cb', 'http://127.0.0.1:80/cb', 'http://127.0.0.1.evil.example:5000/cb']) {
      const r = await e.req('POST', '/v1/oauth/authorize', { headers: bearer(s), body: { client_id: 'sax-desktop', redirect_uri: uri, code_challenge: challenge, code_challenge_method: 'S256', state } });
      assert.equal(r.json.error, 'account.redirect_not_loopback', uri);
    }
    const plain = await e.req('POST', '/v1/oauth/authorize', { headers: bearer(s), body: { client_id: 'sax-desktop', redirect_uri: 'http://127.0.0.1:51234/cb', code_challenge: challenge, code_challenge_method: 'plain', state } });
    assert.equal(plain.status, 400);
  });

  it('인가 코드는 검증자·주소가 맞아야 하고 1회용이다', async () => {
    const s = await login(e, 'pkce2@example.com');
    const a = await e.req('POST', '/v1/oauth/authorize', { headers: bearer(s), body: { client_id: 'sax-desktop', redirect_uri: 'http://127.0.0.1:51234/cb', code_challenge: challenge, code_challenge_method: 'S256', state } });
    assert.equal(a.status, 200);
    const u = new URL(a.json.redirect as string);
    assert.equal(u.origin, 'http://127.0.0.1:51234');
    assert.equal(u.searchParams.get('state'), state);
    const code = u.searchParams.get('code')!;
    const wrong = await e.req('POST', '/v1/oauth/token', { body: { grant_type: 'authorization_code', code, code_verifier: randomBytes(32).toString('base64url'), redirect_uri: 'http://127.0.0.1:51234/cb', client_id: 'sax-desktop' } });
    assert.equal(wrong.json.error, 'account.pkce_invalid');
    // 틀린 시도로 코드는 이미 소진됐다.
    const again = await e.req('POST', '/v1/oauth/token', { body: { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:51234/cb', client_id: 'sax-desktop' } });
    assert.equal(again.json.error, 'account.pkce_invalid');

    const b = await e.req('POST', '/v1/oauth/authorize', { headers: bearer(s), body: { client_id: 'sax-desktop', redirect_uri: 'http://[::1]:51234/cb', code_challenge: challenge, code_challenge_method: 'S256', state } });
    const code2 = new URL(b.json.redirect as string).searchParams.get('code')!;
    const otherUri = await e.req('POST', '/v1/oauth/token', { body: { grant_type: 'authorization_code', code: code2, code_verifier: verifier, redirect_uri: 'http://[::1]:51235/cb', client_id: 'sax-desktop' } });
    assert.equal(otherUri.json.error, 'account.pkce_invalid');

    const c = await e.req('POST', '/v1/oauth/authorize', { headers: bearer(s), body: { client_id: 'sax-desktop', redirect_uri: 'http://127.0.0.1:51234/cb', code_challenge: challenge, code_challenge_method: 'S256', state } });
    const code3 = new URL(c.json.redirect as string).searchParams.get('code')!;
    e.clock.advance(61_000);
    assert.equal((await e.req('POST', '/v1/oauth/token', { body: { grant_type: 'authorization_code', code: code3, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:51234/cb', client_id: 'sax-desktop' } })).json.error, 'account.pkce_invalid');

    const d = await e.req('POST', '/v1/oauth/authorize', { headers: bearer(s), body: { client_id: 'sax-desktop', redirect_uri: 'http://127.0.0.1:51234/cb', code_challenge: challenge, code_challenge_method: 'S256', state } });
    const code4 = new URL(d.json.redirect as string).searchParams.get('code')!;
    const ok = await e.req('POST', '/v1/oauth/token', { body: { grant_type: 'authorization_code', code: code4, code_verifier: verifier, redirect_uri: 'http://127.0.0.1:51234/cb', client_id: 'sax-desktop' } });
    assert.equal(ok.status, 200);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(ok.json.session as string) })).json.email, 'pkce2@example.com');
  });
});

describe('M4-5 계정: 패스키(WebAuthn)', () => {
  let e: Env;
  before(async () => (e = await start()));
  after(() => e.server.close());

  it('등록(attestation none, UV) → 로그인, 카운터 되감기·다른 origin·UV 없음·챌린지 재사용 거부', async () => {
    const s = await login(e, 'pk@example.com');
    const pk = new SoftPasskey(RP.rpId, ORIGIN);
    const opt = await e.req('POST', '/v1/passkeys/options', { headers: bearer(s) });
    assert.equal(opt.json.attestation, 'none');
    const reg = await e.req('POST', '/v1/passkeys', { headers: bearer(s), body: pk.register(opt.json.challenge as string) });
    assert.equal(reg.status, 201, reg.text);
    assert.equal((await e.req('POST', '/v1/passkeys', { headers: bearer(s), body: pk.register(opt.json.challenge as string) })).json.error, 'account.passkey_invalid');

    const lo = await e.req('POST', '/v1/auth/passkey/options');
    const ok = await e.req('POST', '/v1/auth/passkey/verify', { body: pk.assert(lo.json.challenge as string) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(ok.json.session as string) })).json.authMethod, 'passkey');

    const lo2 = await e.req('POST', '/v1/auth/passkey/options');
    assert.equal((await e.req('POST', '/v1/auth/passkey/verify', { body: pk.assert(lo2.json.challenge as string, { keepCount: true }) })).json.error, 'account.passkey_invalid');
    const lo3 = await e.req('POST', '/v1/auth/passkey/options');
    assert.equal((await e.req('POST', '/v1/auth/passkey/verify', { body: pk.assert(lo3.json.challenge as string, { origin: 'https://evil.example' }) })).json.error, 'account.passkey_invalid');
    const lo4 = await e.req('POST', '/v1/auth/passkey/options');
    assert.equal((await e.req('POST', '/v1/auth/passkey/verify', { body: pk.assert(lo4.json.challenge as string, { flags: 0x01 }) })).json.error, 'account.passkey_invalid');
    assert.equal((await e.req('POST', '/v1/auth/passkey/verify', { body: pk.assert(lo.json.challenge as string) })).json.error, 'account.passkey_invalid');
    const lo5 = await e.req('POST', '/v1/auth/passkey/options');
    e.clock.advance(5 * 60_000 + 1);
    assert.equal((await e.req('POST', '/v1/auth/passkey/verify', { body: pk.assert(lo5.json.challenge as string) })).json.error, 'account.passkey_invalid');
  });

  it('패스키가 있는 계정은 이메일 코드 세션만으로 기기를 추가할 수 없다(D09 §2.2)', async () => {
    const s = await login(e, 'pk2@example.com');
    const pk = new SoftPasskey(RP.rpId, ORIGIN);
    const opt = await e.req('POST', '/v1/passkeys/options', { headers: bearer(s) });
    await e.req('POST', '/v1/passkeys', { headers: bearer(s), body: pk.register(opt.json.challenge as string) });
    const phone = device('mobile', 0);
    const body = { deviceId: phone.id, role: 'mobile', platform: 'ios', name: '내 폰', Sx: phone.S.b64, Vx: phone.V.b64 };
    assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body })).json.error, 'account.passkey_required');
    const aik = edKey();
    const d = device('desktop', 0);
    const pin = await e.req('POST', '/v1/aik', { headers: bearer(s), body: { aikPub: aik.b64, deviceList: { listVersion: 1, entries: [entry(aik, d, 1)], revoked: [] }, platform: 'windows', name: 'PC' } });
    assert.equal(pin.json.error, 'account.passkey_required');
    const lo = await e.req('POST', '/v1/auth/passkey/options');
    const ps = (await e.req('POST', '/v1/auth/passkey/verify', { body: pk.assert(lo.json.challenge as string) })).json.session as string;
    assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(ps), body })).status, 201);
  });
});

describe('M4-5 계정: AIK 고정·기기 목록·기기 범위 토큰', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('첫 데스크톱이 AIK를 1회 고정, 두 번째 고정·서명 위조는 거부', async () => {
    const s = await login(e, 'aik@example.com');
    const forged = edKey();
    const d0 = device('desktop', 0);
    const bad = await e.req('POST', '/v1/aik', { headers: bearer(s), body: { aikPub: edKey().b64, deviceList: { listVersion: 1, entries: [entry(forged, d0, 1)], revoked: [] }, platform: 'windows', name: 'PC' } });
    assert.equal(bad.json.error, 'account.aik_signature_invalid');
    await desktop(e, s);
    const again = edKey();
    const d1 = device('desktop', 0);
    const r = await e.req('POST', '/v1/aik', { headers: bearer(s), body: { aikPub: again.b64, deviceList: { listVersion: 1, entries: [entry(again, d1, 1)], revoked: [] }, platform: 'windows', name: 'PC2' } });
    assert.equal(r.json.error, 'account.aik_already_pinned');
    assert.equal(e.mail.outbox.filter((m) => m.kind === 'aik_pinned').length, 1);
  });

  it('AIK 전에 등록 신청만 한 데스크톱(pending)은 첫 고정을 막지 않는다', async () => {
    const s = await login(e, 'pend@example.com');
    const other = device('desktop', 0);
    const same = device('desktop', 0);
    for (const d of [other, same]) {
      const r = await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: d.id, role: 'desktop', platform: 'windows', name: 'PC', Sx: d.S.b64, Vx: d.V.b64 } });
      assert.equal(r.status, 201, r.text);
    }
    // 신청했던 같은 기기가 고정: pending 행을 대신한다
    const aik = edKey();
    const r = await e.req('POST', '/v1/aik', { headers: bearer(s), body: { aikPub: aik.b64, deviceList: { listVersion: 1, entries: [entry(aik, same, 1)], revoked: [] }, platform: 'windows', name: 'PC' } });
    assert.equal(r.status, 201, r.text);
    const list = (await e.req('GET', '/v1/devices', { headers: bearer(s) })).json.devices as Array<Record<string, unknown>>;
    assert.equal(list.find((x) => x.deviceId === same.id)!.state, 'active');
    assert.equal(list.find((x) => x.deviceId === other.id)!.state, 'pending');
    // 신청 때 센 등록 이력을 고정이 다시 세지 않는다(30일 데스크톱 등록 이력 = 신청 2건)
    const adds = await e.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_events WHERE kind = 'add' AND role = 'desktop'");
    assert.equal(Number(adds!.n), 2);
    // 이제는 고정된 계정
    const again = edKey();
    assert.equal((await e.req('POST', '/v1/aik', { headers: bearer(s), body: { aikPub: again.b64, deviceList: { listVersion: 1, entries: [entry(again, other, 1)], revoked: [] }, platform: 'windows', name: 'PC' } })).json.error, 'account.aik_already_pinned');
  });

  it('기기 토큰 범위 축소(ADR-040 결정 1): 부분집합만, 빈 배열·모르는 범위·중복·역할 밖은 400, 발급 기록에 역할·범위(ID 없음)', async () => {
    const s = await login(e, 'scope@example.com');
    const { aik, d } = await desktop(e, s);
    const htu = ORIGIN + '/v1/device-tokens';
    const ask = (scopes: unknown) => {
      const c = cert(aik, d, e.clock.now() + 90 * D);
      return e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(c), d.V, e.clock.now()) }, body: { cert: c, scopes } });
    };
    e.events.length = 0;
    const g = await ask(['gateway']);
    assert.equal(g.status, 200, g.text);
    assert.deepEqual(g.json.scopes, ['gateway']);
    const v = new TokenVerifier({ k1: e.verifyKey }).verify(g.json.token as string, e.clock.now(), 'account.unauthorized');
    assert.deepEqual(v.scp, ['gateway']);
    // 순서는 역할 범위 순서로
    assert.deepEqual((await ask(['devlist', 'gateway'])).json.scopes, ['gateway', 'devlist']);
    // 역할의 전체를 다 고르면 전체와 같다
    assert.deepEqual((await ask(['acct_op', 'devlist', 'slots', 'wake', 'relay', 'gateway'])).json.scopes, ['gateway', 'relay', 'wake', 'slots', 'devlist', 'acct_op']);
    for (const bad of [[], ['gateway', 'gateway'], ['admin'], 'gateway', [1], ['push']]) assert.equal((await ask(bad)).json.error, 'request.param_rejected', JSON.stringify(bad));
    assert.deepEqual(e.events, ['account.device_token_issued.desktop.gateway', 'account.device_token_issued.desktop.gateway-devlist', 'account.device_token_issued.desktop.all']);
    // 범위 없는 요청은 전체(하위 호환)
    const c = cert(aik, d, e.clock.now() + 90 * D);
    const all = await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(c), d.V, e.clock.now()) }, body: { cert: c } });
    assert.deepEqual(all.json.scopes, ['gateway', 'relay', 'wake', 'slots', 'devlist', 'acct_op']);
    assert.equal(e.events.at(-1), 'account.device_token_issued.desktop.all');
    for (const ev of e.events) assert.ok(!looksSensitive(ev) && !ev.includes(d.id), ev);
  });

  it('기기 토큰: AIK 인증서 + Vx DPoP만. 다른 키의 DPoP·만료 인증서·위조 인증서·jti 재사용 거부', async () => {
    const s = await login(e, 'tok@example.com');
    const { aik, d } = await desktop(e, s);
    const now = e.clock.now();
    const c = cert(aik, d, now + 90 * D);
    const htu = ORIGIN + '/v1/device-tokens';
    const otherKey = edKey();
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(c), otherKey, now) }, body: { cert: c } })).json.error, 'account.dpop_invalid');
    assert.equal((await e.req('POST', '/v1/device-tokens', { body: { cert: c } })).json.error, 'account.dpop_invalid');
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', 'https://other.invalid/v1/device-tokens', jcs(c), d.V, now) }, body: { cert: c } })).json.error, 'account.dpop_invalid');
    const expired = cert(aik, d, now - 1);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(expired), d.V, now) }, body: { cert: expired } })).json.error, 'account.cert_invalid');
    const tooLong = cert(aik, d, now + 200 * D);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(tooLong), d.V, now) }, body: { cert: tooLong } })).json.error, 'account.cert_invalid');
    const forged = cert(edKey(), d, now + 90 * D);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(forged), d.V, now) }, body: { cert: forged } })).json.error, 'account.cert_invalid');
    const proof = dpop('POST', htu, jcs(c), d.V, now);
    const ok = await e.req('POST', '/v1/device-tokens', { headers: { dpop: proof }, body: { cert: c } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json.scopes, ['gateway', 'relay', 'wake', 'slots', 'devlist', 'acct_op']);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: proof }, body: { cert: c } })).json.error, 'account.dpop_invalid');
    const stale = dpop('POST', htu, jcs(c), d.V, now - 120_000);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: stale }, body: { cert: c } })).json.error, 'account.dpop_invalid');
  });

  it('pending 신청이 데스크톱 상한을 채웠으면 다른 기기로 첫 고정을 할 수 없다(상한 우회 없음)', async () => {
    const s = await login(e, 'cap@example.com');
    for (let i = 0; i < DEVICE.maxDesktops; i++) {
      const d = device('desktop', 0);
      assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: d.id, role: 'desktop', platform: 'windows', name: 'PC', Sx: d.S.b64, Vx: d.V.b64 } })).status, 201);
    }
    const aik = edKey();
    const fourth = device('desktop', 0);
    assert.equal((await e.req('POST', '/v1/aik', { headers: bearer(s), body: { aikPub: aik.b64, deviceList: { listVersion: 1, entries: [entry(aik, fourth, 1)], revoked: [] }, platform: 'windows', name: 'PC' } })).json.error, 'account.device_limit');
  });

  it('계정당 PC 3대·폰 3대(ADR-048): 네 번째는 account.device_limit(코드뿐), 서버는 있던 기기를 끊지 않고 하나가 폐기되면 다시 받는다', async () => {
    assert.equal(DEVICE.maxDesktops, 3);
    assert.equal(DEVICE.maxMobiles, 3);
    const s = await login(e, 'three@example.com');
    const enroll = (p: Device) => e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: p.id, role: p.role, platform: p.role === 'desktop' ? 'macos' : 'ios', name: p.role === 'desktop' ? 'PC' : '폰', Sx: p.S.b64, Vx: p.V.b64 } });
    const pcs = [device('desktop', 0), device('desktop', 0), device('desktop', 0)];
    const phones = [device('mobile', 0), device('mobile', 0), device('mobile', 0)];
    for (const d of [...pcs, ...phones]) assert.equal((await enroll(d)).status, 201);
    for (const role of ['desktop', 'mobile'] as const) {
      const r = await enroll(device(role, 0));
      assert.equal(r.status, 409);
      assert.deepEqual(r.json, { error: 'account.device_limit' });
    }
    // 자동으로 끊긴 기기가 없다: 여섯 대가 그대로 있다
    const list = (await e.req('GET', '/v1/devices', { headers: bearer(s) })).json.devices as Array<{ deviceId: string; state: string }>;
    assert.deepEqual(list.map((d) => d.deviceId).sort(), [...pcs, ...phones].map((d) => d.id).sort());
    assert.ok(list.every((d) => d.state === 'pending'));
    // PC 하나가 폐기되면 PC 자리만 하나 빈다
    await e.db.run("UPDATE devices SET state = 'revoked' WHERE device_id = $1", [pcs[0]!.id]);
    assert.equal((await enroll(device('mobile', 0))).json.error, 'account.device_limit');
    assert.equal((await enroll(device('desktop', 0))).status, 201);
    assert.equal((await enroll(device('desktop', 0))).json.error, 'account.device_limit');
  });

  it('30일 추가 한도(ADR-048): PC는 5번째까지 받고 6번째는 account.device_churn_limit', async () => {
    assert.equal(DEVICE.churnDesktop, 5);
    const s = await login(e, 'churn@example.com');
    const enroll = (p: Device) => e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: p.id, role: 'desktop', platform: 'windows', name: 'PC', Sx: p.S.b64, Vx: p.V.b64 } });
    for (let i = 0; i < DEVICE.churnDesktop; i++) {
      const d = device('desktop', 0);
      assert.equal((await enroll(d)).status, 201);
      await e.db.run("UPDATE devices SET state = 'revoked' WHERE device_id = $1", [d.id]);
    }
    assert.equal((await enroll(device('desktop', 0))).json.error, 'account.device_churn_limit');
  });

  it('기기별 발급 한도는 검증을 통과한 요청만 센다(device_id만 아는 남이 한도를 태우지 못한다)', async () => {
    const s = await login(e, 'burn@example.com');
    const { aik, d } = await desktop(e, s);
    const now = e.clock.now();
    const htu = ORIGIN + '/v1/device-tokens';
    const attacker = edKey();
    for (let i = 0; i < 70; i++) {
      const forged = cert(attacker, d, now + 90 * D);
      assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(forged), attacker, now) }, body: { cert: forged } })).json.error, 'account.cert_invalid');
    }
    const c = cert(aik, d, now + 90 * D);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(c), d.V, now) }, body: { cert: c } })).status, 200);
    // 검증을 통과한 요청은 기기당 60회/시
    for (let i = 1; i < 60; i++) assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(c), d.V, now) }, body: { cert: c } })).status, 200);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', htu, jcs(c), d.V, now) }, body: { cert: c } })).status, 429);
  });

  it('폰: 등록 신청(대기) → PC가 AIK 서명 목록에 넣으면 즉시 활성 → 폰 토큰은 relay·push·chat 범위만(gateway 없음)', async () => {
    const s = await login(e, 'phone@example.com');
    const pc = await desktop(e, s);
    const phone = device('mobile', e.clock.now());
    const en = await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: phone.id, role: 'mobile', platform: 'android', name: '내 폰', Sx: phone.S.b64, Vx: phone.V.b64 } });
    assert.equal(en.status, 201);
    assert.equal(en.json.holdUntil, e.clock.now() + 72 * H);
    // 대기 중(활성 전)에는 인증서가 있어도 토큰을 받지 못한다.
    const c = cert(pc.aik, phone, e.clock.now() + 90 * D);
    const early = await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), phone.V, e.clock.now()) }, body: { cert: c } });
    assert.equal(early.json.error, 'account.device_suspended');
    // 목록 키가 등록 신청과 다르면 거부
    const imposter = { ...phone, V: edKey() };
    const badList = await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, imposter, 2)], revoked: [] } });
    assert.equal(badList.json.error, 'request.param_rejected');
    const up = await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, phone, 2)], revoked: [] } });
    assert.equal(up.status, 200, up.text);
    const tok = await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), phone.V, e.clock.now()) }, body: { cert: c } });
    assert.equal(tok.status, 200, tok.text);
    assert.deepEqual(tok.json.scopes, ['relay', 'push', 'chat', 'devices']);
    // 폰은 gateway 범위를 달라고 할 수 없다(역할 범위 밖)
    const gw = await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), phone.V, e.clock.now()) }, body: { cert: c, scopes: ['gateway'] } });
    assert.equal(gw.json.error, 'request.param_rejected');
    // 폰 토큰으로 데스크톱 범위(slots·devlist) 호출 불가
    const t = tok.json.token as string;
    const slot = await e.req('POST', '/v1/slots', { headers: { authorization: `DPoP ${t}`, dpop: dpop('POST', ORIGIN + '/v1/slots', t, phone.V, e.clock.now()) } });
    assert.equal(slot.json.error, 'account.scope_denied');
    // 폰도 서버의 AIK 서명 목록을 받을 수 있다(페어링 3단계, 세션으로)
    const dl = await e.req('GET', '/v1/device-list', { headers: bearer(s) });
    assert.equal(dl.json.aikPub, pc.aik.b64);
  });

  it('기기 목록: 낮은 버전·서명 없는 항목·폐기 레코드 없이 빠지는 기기·계정 세션 호출 거부', async () => {
    const s = await login(e, 'list@example.com');
    const pc = await desktop(e, s);
    const phone = device('mobile', 0);
    await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: phone.id, role: 'mobile', platform: 'ios', name: '폰', Sx: phone.S.b64, Vx: phone.V.b64 } });
    assert.equal((await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 1, entries: [entry(pc.aik, pc.d, 1)], revoked: [] } })).json.error, 'account.list_version_stale');
    const unsigned = { ...entry(pc.aik, phone, 2), aikSig: entry(edKey(), phone, 2).aikSig };
    assert.equal((await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(pc.aik, pc.d, 1), unsigned], revoked: [] } })).json.error, 'account.aik_signature_invalid');
    assert.equal((await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, phone, 3)], revoked: [] } })).json.error, 'account.aik_signature_invalid');
    assert.equal((await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, phone, 2)], revoked: [] } })).status, 200);
    assert.equal((await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 3, entries: [entry(pc.aik, pc.d, 1)], revoked: [] } })).json.error, 'request.param_rejected');
    assert.equal((await e.req('PUT', '/v1/device-list', { headers: bearer(s), body: { deviceList: { listVersion: 3, entries: [entry(pc.aik, pc.d, 1)], revoked: [] } } })).json.error, 'account.unauthorized');
  });

  it('폐기: 나중에 붙은 PC가 등록 7일 안에 끊으면 폰은 바로 정지되고 7일 뒤 폐기, 7일이 지나면 즉시(ADR-048 결정 6)', async () => {
    const { pc, d2, ps, state } = await fleet(e, 'rev@example.com');
    const [p1, p2] = ps as [Device, Device];
    const call2 = caller(e, pc.aik, d2);
    const keep = [entry(pc.aik, pc.d, 1), entry(pc.aik, d2, 2)];
    const r = await call2('PUT', '/v1/device-list', { deviceList: { listVersion: 3, entries: [...keep, entry(pc.aik, p2, 2)], revoked: [revokeRec(pc.aik, p1.id, e.clock.now())] } });
    assert.equal(r.status, 200, r.text);
    const deleteAfter = e.clock.now() + 7 * D;
    // 자리는 아직 차 있지만(폐기 전) 토큰·우편함·푸시는 바로 멈춘다
    assert.equal((await state(p1.id)).state, 'suspended');
    assert.equal((await state(p1.id)).deleteAfter, deleteAfter);
    assert.deepEqual(e.stopped, [p1.id]);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_suspended'));
    const c1 = cert(pc.aik, p1, e.clock.now() + 90 * D);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c1), p1.V, e.clock.now()) }, body: { cert: c1 } })).json.error, 'account.device_suspended');
    // 유예 중 목록을 다시 올려도 유예는 다시 시작하지 않는다
    e.clock.advance(3 * D);
    assert.equal((await call2('PUT', '/v1/device-list', { deviceList: { listVersion: 4, entries: [...keep, entry(pc.aik, p2, 2)], revoked: [revokeRec(pc.aik, p1.id, e.clock.now())] } })).status, 200);
    assert.equal((await state(p1.id)).deleteAfter, deleteAfter);
    e.clock.advance(4 * D);
    await e.svc.sweep();
    assert.equal((await state(p1.id)).state, 'revoked');
    // 두 번째 PC도 7일이 넘었으니 이번에는 즉시
    const r2 = await call2('PUT', '/v1/device-list', { deviceList: { listVersion: 5, entries: keep, revoked: [revokeRec(pc.aik, p1.id, 1), revokeRec(pc.aik, p2.id, e.clock.now())] } });
    assert.equal(r2.status, 200, r2.text);
    assert.equal((await state(p2.id)).state, 'revoked');
    assert.equal(e.stopped.at(-1), p2.id);
  });

  it('폐기: 계정의 첫 PC는 가입 첫 주에도 유예 없이 즉시 끊는다(ADR-048 결정 6)', async () => {
    const { pc, d2, ps, state } = await fleet(e, 'rev1@example.com', 1);
    const p1 = ps[0]!;
    const r = await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 3, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, d2, 2)], revoked: [revokeRec(pc.aik, p1.id, e.clock.now())] } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await state(p1.id)).state, 'revoked');
    assert.equal((await state(p1.id)).deleteAfter, null);
    assert.deepEqual(e.stopped, [p1.id]);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_revoked'));
    // 자리가 바로 빈다: 새 폰을 받는다
    const s = await login(e, 'rev1@example.com');
    const np = device('mobile', 0);
    assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: np.id, role: 'mobile', platform: 'ios', name: '새 폰', Sx: np.S.b64, Vx: np.V.b64 } })).status, 201);
  });

  it('폐기: 나중에 붙은 PC가 7일 안에 쓰던 PC를 끊으면 그 PC는 정지되지 않고 7일 유예만 걸린다', async () => {
    const { pc, d2, ps, state } = await fleet(e, 'rev2@example.com', 1);
    const call2 = caller(e, pc.aik, d2);
    const r = await call2('PUT', '/v1/device-list', { deviceList: { listVersion: 3, entries: [entry(pc.aik, d2, 2), entry(pc.aik, ps[0]!, 2)], revoked: [revokeRec(pc.aik, pc.d.id, e.clock.now())] } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(e.stopped, []);
    const st = await state(pc.d.id); // 첫 PC의 토큰이 아직 살아 있다
    assert.equal(st.state, 'active');
    assert.equal(st.deleteAfter, e.clock.now() + 7 * D);
  });
});

describe('M4-5 계정: 긴급 정지·삭제 유예·기기 상한·72시간 대기', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('계정 웹 긴급 정지: 폰 토큰이 즉시 막히고(정지 훅), 재활성화는 AIK 서명 계정 작업만', async () => {
    const s = await login(e, 'stop@example.com');
    const pc = await desktop(e, s);
    const phone = device('mobile', 0);
    await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: phone.id, role: 'mobile', platform: 'ios', name: '폰', Sx: phone.S.b64, Vx: phone.V.b64 } });
    await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, phone, 2)], revoked: [] } });
    assert.equal((await e.req('POST', `/v1/devices/${phone.id}/suspend`, { headers: bearer(s) })).status, 204);
    assert.deepEqual(e.stopped, [phone.id]);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_suspended'));
    const c = cert(pc.aik, phone, e.clock.now() + 90 * D);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), phone.V, e.clock.now()) }, body: { cert: c } })).json.error, 'account.device_suspended');
    // 계정 세션으로는 재활성화 경로가 없다(정지만)
    assert.equal((await e.req('POST', `/v1/devices/${phone.id}/reactivate`, { headers: bearer(s), body: acctOp(pc.aik, 'device.reactivate', 'x', phone.id, e.clock.now()) })).json.error, 'account.unauthorized');
    const accountId = (await e.db.one<{ id: string }>('SELECT id FROM accounts WHERE email = $1', ['stop@example.com']))!.id;
    assert.equal((await pc.call('POST', `/v1/devices/${phone.id}/reactivate`, acctOp(edKey(), 'device.reactivate', accountId, phone.id, e.clock.now()))).json.error, 'account.aik_signature_invalid');
    assert.equal((await pc.call('POST', `/v1/devices/${phone.id}/reactivate`, acctOp(pc.aik, 'device.reactivate', accountId, phone.id, e.clock.now() - 10 * 60_000))).json.error, 'account.aik_signature_invalid');
    assert.equal((await pc.call('POST', `/v1/devices/${phone.id}/reactivate`, acctOp(pc.aik, 'device.reactivate', accountId, pc.d.id, e.clock.now()))).json.error, 'account.aik_signature_invalid');
    assert.equal((await pc.call('POST', `/v1/devices/${phone.id}/reactivate`, acctOp(pc.aik, 'device.reactivate', accountId, phone.id, e.clock.now()))).status, 204);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), phone.V, e.clock.now()) }, body: { cert: c } })).status, 200);
  });

  it('스스로 나가기(ADR-048 결정 6): 폰이 기기 토큰으로 나가면 바로 폐기·정지 훅·자리 비움, PC가 다음 목록에서 폐기 레코드로 옮긴다', async () => {
    const { s, pc, d2, ps, state } = await fleet(e, 'leave@example.com', 3);
    const [p1, p2, p3] = ps as [Device, Device, Device];
    const phone = caller(e, pc.aik, p1);
    // 폰은 기기 목록을 본다(devices 범위). 목록을 바꾸는 호출은 못 한다
    const seen = (await phone('GET', '/v1/devices')).json.devices as Array<Record<string, unknown>>;
    assert.equal(seen.length, 5);
    assert.equal((await phone('PUT', '/v1/device-list', { deviceList: { listVersion: 3, entries: [], revoked: [] } })).json.error, 'account.scope_denied');
    assert.equal((await phone('POST', '/v1/devices/self/leave')).status, 204);
    assert.equal((await state(p1.id)).state, 'revoked');
    assert.deepEqual(e.stopped, [p1.id]);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_revoked'));
    const c1 = cert(pc.aik, p1, e.clock.now() + 90 * D);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c1), p1.V, e.clock.now()) }, body: { cert: c1 } })).json.error, 'account.device_suspended');
    // 자리가 바로 빈다
    const np = device('mobile', 0);
    assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: np.id, role: 'mobile', platform: 'android', name: '새 폰', Sx: np.S.b64, Vx: np.V.b64 } })).status, 201);
    // PC는 나간 폰을 항목에 둔 채로는 목록을 올리지 못하고, 폐기 레코드로 옮기면 받는다
    const rest = [entry(pc.aik, pc.d, 1), entry(pc.aik, d2, 2), entry(pc.aik, p2, 2), entry(pc.aik, p3, 2)];
    assert.equal((await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 3, entries: [...rest, entry(pc.aik, p1, 2)], revoked: [] } })).json.error, 'request.param_rejected');
    assert.equal((await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 3, entries: rest, revoked: [revokeRec(pc.aik, p1.id, e.clock.now())] } })).status, 200);
  });

  it('스스로 나가기: PC도 나갈 수 있지만 마지막 남은 활성 PC는 account.last_desktop', async () => {
    const { pc, d2, state } = await fleet(e, 'leave2@example.com', 1);
    const call2 = caller(e, pc.aik, d2);
    assert.equal((await call2('POST', '/v1/devices/self/leave')).status, 204);
    assert.equal((await state(d2.id)).state, 'revoked');
    const last = await pc.call('POST', '/v1/devices/self/leave');
    assert.equal(last.status, 409);
    assert.equal(last.json.error, 'account.last_desktop');
    assert.equal((await state(pc.d.id)).state, 'active');
  });

  it('폰에서 다른 기기 정지(ADR-048 결정 6): 바로 정지 + 7일 뒤 폐기 예약 + 알림, PC가 AIK로 되돌리면 예약도 취소', async () => {
    const { pc, d2, ps, state } = await fleet(e, 'halt@example.com', 2);
    const [p1, p2] = ps as [Device, Device];
    const phone = caller(e, pc.aik, p1);
    // 폰은 devices 범위로 기기 목록(서버 상태)과 AIK 서명 목록을 읽는다. 목록을 바꾸지는 못한다
    assert.equal(((await phone('GET', '/v1/devices')).json.devices as unknown[]).length, 4);
    const dl = await phone('GET', '/v1/device-list');
    assert.equal(dl.json.aikPub, pc.aik.b64);
    assert.equal(dl.json.deviceList.listVersion, 2);
    assert.equal((await phone('PUT', '/v1/device-list', { deviceList: dl.json.deviceList })).json.error, 'account.scope_denied');
    // 잃어버린 폰
    const r = await phone('POST', `/v1/devices/${p2.id}/stop`);
    assert.equal(r.status, 202, r.text);
    assert.equal(r.json.deleteAfter, e.clock.now() + 7 * D);
    assert.equal((await state(p2.id)).state, 'suspended');
    assert.deepEqual(e.stopped, [p2.id]);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_suspended'));
    // 자기 자신·없는 기기·다른 계정 기기
    assert.equal((await phone('POST', `/v1/devices/${p1.id}/stop`)).json.error, 'request.param_rejected');
    assert.equal((await phone('POST', `/v1/devices/${device('mobile', 0).id}/stop`)).json.error, 'account.device_not_found');
    // PC가 재활성화하면 폐기 예약도 사라진다
    const accountId = (await e.db.one<{ id: string }>('SELECT id FROM accounts WHERE email = $1', ['halt@example.com']))!.id;
    assert.equal((await pc.call('POST', `/v1/devices/${p2.id}/reactivate`, acctOp(pc.aik, 'device.reactivate', accountId, p2.id, e.clock.now()))).status, 204);
    assert.equal((await state(p2.id)).state, 'active');
    assert.equal((await state(p2.id)).deleteAfter, null);
    // 잃어버린 PC: 다른 PC가 남아 있으면 정지된다. 되돌리지 않으면 7일 뒤 폐기
    assert.equal((await phone('POST', `/v1/devices/${d2.id}/stop`)).status, 202);
    assert.equal((await state(d2.id)).state, 'suspended');
    // 마지막 남은 활성 PC는 폰이 정지할 수 없다
    const last = await phone('POST', `/v1/devices/${pc.d.id}/stop`);
    assert.equal(last.status, 409);
    assert.equal(last.json.error, 'account.last_desktop');
    assert.equal((await state(pc.d.id)).state, 'active');
    e.clock.advance(8 * D);
    await e.svc.sweep();
    assert.equal((await state(d2.id)).state, 'revoked');
  });

  it('다른 기기 정지는 요청 기기당 하루 5번까지', async () => {
    const { pc, ps } = await fleet(e, 'halt2@example.com', 2);
    const phone = caller(e, pc.aik, ps[0]!);
    for (let i = 0; i < DEVICE.stopsPerDeviceDay; i++) assert.equal((await phone('POST', `/v1/devices/${ps[1]!.id}/stop`)).status, 202);
    assert.equal((await phone('POST', `/v1/devices/${ps[1]!.id}/stop`)).status, 429);
  });

  it('발급 잠금(ADR-048 결정 7): 계정당 한 PC만 잡는다, 90초 뒤 풀린다, 갱신·놓기는 내가 잡은 값으로만, 폰은 못 잡는다', async () => {
    const { pc, d2, ps } = await fleet(e, 'lock@example.com', 1);
    const pc2 = caller(e, pc.aik, d2);
    const phone = caller(e, pc.aik, ps[0]!);
    const rows = async () => Number((await e.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM issue_locks'))!.n);
    assert.deepEqual((await pc.call('GET', '/v1/issue-lock')).json, { held: false, deviceId: null, expiresAt: null, mine: false });
    const a = await pc.call('POST', '/v1/issue-lock/acquire');
    assert.equal(a.status, 200, a.text);
    assert.match(a.json.lockId, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(a.json.expiresAt, e.clock.now() + ISSUE_LOCK.ttlMs);
    const id1 = a.json.lockId as string;
    // 다른 PC는 못 잡고, 누가 잡았는지는 본다(잠금 값은 보이지 않는다)
    const b = await pc2('POST', '/v1/issue-lock/acquire');
    assert.deepEqual([b.status, b.json], [409, { error: 'account.issue_locked' }]);
    assert.deepEqual((await pc2('GET', '/v1/issue-lock')).json, { held: true, deviceId: pc.d.id, expiresAt: a.json.expiresAt, mine: false });
    assert.equal((await pc.call('GET', '/v1/issue-lock')).json.mine, true);
    // 다른 PC·다른 값으로는 갱신·놓기가 안 된다(놓기는 조용히 아무 일도 없다)
    assert.equal((await pc2('POST', '/v1/issue-lock/renew', { lockId: id1 })).json.error, 'account.issue_lock_lost');
    assert.equal((await pc2('POST', '/v1/issue-lock/release', { lockId: id1 })).status, 204);
    assert.equal((await pc.call('GET', '/v1/issue-lock')).json.held, true);
    assert.equal((await pc.call('POST', '/v1/issue-lock/renew', { lockId: 'x'.repeat(43) })).json.error, 'account.issue_lock_lost');
    assert.equal((await pc.call('POST', '/v1/issue-lock/renew', {})).json.error, 'request.param_rejected');
    // 갱신하면 그때부터 90초
    e.clock.advance(30_000);
    assert.deepEqual((await pc.call('POST', '/v1/issue-lock/renew', { lockId: id1 })).json, { expiresAt: e.clock.now() + ISSUE_LOCK.ttlMs });
    // 갱신이 끊기면(PC가 죽음) 90초 뒤 다른 PC가 잡고, 앞 PC의 갱신은 거부된다(커밋 직전 갱신 실패 = 커밋하지 않음)
    e.clock.advance(ISSUE_LOCK.ttlMs);
    assert.equal((await pc.call('POST', '/v1/issue-lock/renew', { lockId: id1 })).json.error, 'account.issue_lock_lost');
    const c = await pc2('POST', '/v1/issue-lock/acquire');
    assert.equal(c.status, 200);
    assert.notEqual(c.json.lockId, id1);
    assert.equal((await pc.call('POST', '/v1/issue-lock/acquire')).json.error, 'account.issue_locked');
    // 놓으면 줄이 지워지고(횟수가 남지 않는다) 바로 다른 PC가 잡는다
    assert.equal((await pc2('POST', '/v1/issue-lock/release', { lockId: c.json.lockId })).status, 204);
    assert.equal(await rows(), 0);
    const d = await pc.call('POST', '/v1/issue-lock/acquire');
    // 같은 PC가 다시 잡으면 새 값이고 앞 값은 죽는다
    const f = await pc.call('POST', '/v1/issue-lock/acquire');
    assert.notEqual(f.json.lockId, d.json.lockId);
    assert.equal((await pc.call('POST', '/v1/issue-lock/renew', { lockId: d.json.lockId })).json.error, 'account.issue_lock_lost');
    // 만료된 줄은 정리가 지운다
    e.clock.advance(ISSUE_LOCK.ttlMs + 1);
    await e.svc.sweep();
    assert.equal(await rows(), 0);
    // 폰 토큰은 범위 밖
    assert.equal((await phone('POST', '/v1/issue-lock/acquire')).json.error, 'account.scope_denied');
    assert.equal((await phone('GET', '/v1/issue-lock')).json.error, 'account.scope_denied');
  });

  it('새 PC 연결 우편함(ADR-048 결정 3): hello → challenge → reveal → grant 순서만 받는다, 새 PC는 세션·기존 PC는 기기 토큰, 7일 뒤 지운다', async () => {
    const { s, pc, d2, ps } = await fleet(e, 'link@example.com', 1);
    const pc2 = caller(e, pc.aik, d2);
    const phone = caller(e, pc.aik, ps[0]!);
    const k = () => randomBytes(32).toString('base64');
    // 새 PC(d3)가 로그인하고 신청한다(pending)
    const d3 = device('desktop', e.clock.now());
    const base = `/v1/pc-links/${d3.id}`;
    const hello = { v: 1, device_id: d3.id, Sx: d3.S.b64, Vx: d3.V.b64, Hx: k(), commit: k() };
    // 신청(enroll) 전에는 우편함을 열 수 없다
    assert.deepEqual([(await e.req('PUT', base, { headers: bearer(s), body: { hello } })).status], [404]);
    assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: d3.id, role: 'desktop', platform: 'windows', name: '새 노트북', Sx: d3.S.b64, Vx: d3.V.b64 } })).status, 201);
    // 세션 없이, 신청한 키와 다른 키로, 모양이 틀리면 거부
    assert.equal((await e.req('PUT', base, { body: { hello } })).status, 401);
    assert.equal((await e.req('PUT', base, { headers: bearer(s), body: { hello: { ...hello, Sx: k() } } })).json.error, 'request.param_rejected');
    assert.equal((await e.req('PUT', base, { headers: bearer(s), body: { hello: { ...hello, extra: 1 } } })).json.error, 'request.param_rejected');
    assert.equal((await e.req('PUT', '/v1/pc-links/not-a-uuid', { headers: bearer(s), body: { hello } })).json.error, 'request.param_rejected');
    // 이미 활성인 기기 이름으로는 못 연다
    assert.equal((await e.req('PUT', `/v1/pc-links/${d2.id}`, { headers: bearer(s), body: { hello: { ...hello, device_id: d2.id, Sx: d2.S.b64, Vx: d2.V.b64 } } })).status, 404);
    assert.equal((await e.req('PUT', base, { headers: bearer(s), body: { hello } })).status, 204);
    // 다른 계정은 보지 못한다
    const other = await login(e, 'link-other@example.com');
    assert.deepEqual([(await e.req('GET', base, { headers: bearer(other) })).status, (await e.req('GET', base, { headers: bearer(other) })).json], [404, { error: 'account.link_not_found' }]);
    // 기존 PC가 신청을 본다. 폰은 못 본다(범위)
    assert.equal((await phone('GET', '/v1/pc-links')).status, 403);
    const seen = await pc.call('GET', '/v1/pc-links');
    assert.deepEqual(seen.json, { links: [{ deviceId: d3.id, name: '새 노트북', platform: 'windows', createdAt: e.clock.now(), hello, challengedBy: null, reveal: null }] });
    assert.deepEqual((await e.req('GET', base, { headers: bearer(s) })).json, { challenge: null, grant: null });
    // 순서: challenge 전에 reveal·grant는 안 된다
    const reveal = { v: 1, nonce: k() };
    assert.equal((await e.req('POST', `${base}/reveal`, { headers: bearer(s), body: { reveal } })).json.error, 'account.link_state');
    const challenge = { v: 1, device_id: pc.d.id, aik_pub: pc.aik.b64, nonce: k() };
    // challenge의 기기 ID는 부르는 기기여야 한다
    assert.equal((await pc2('POST', `${base}/challenge`, { challenge })).json.error, 'request.param_rejected');
    assert.equal((await pc.call('POST', `${base}/challenge`, { challenge })).status, 204);
    // 먼저 답한 PC가 승인한다. 두 번째 답은 거부
    assert.equal((await pc2('POST', `${base}/challenge`, { challenge: { ...challenge, device_id: d2.id } })).json.error, 'account.link_state');
    assert.deepEqual((await e.req('GET', base, { headers: bearer(s) })).json, { challenge, grant: null });
    assert.equal((await e.req('POST', `${base}/reveal`, { headers: bearer(s), body: { reveal } })).status, 204);
    assert.equal((await e.req('POST', `${base}/reveal`, { headers: bearer(s), body: { reveal } })).json.error, 'account.link_state');
    const l = ((await pc2('GET', '/v1/pc-links')).json.links as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual([l.challengedBy, l.reveal], [pc.d.id, reveal]);
    // grant: 새 PC가 목록으로 활성화되기 전에는 안 된다, 답한 PC만 된다
    const list = { listVersion: 3, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, d2, 2), entry(pc.aik, ps[0]!, 2), entry(pc.aik, d3, 3)], revoked: [] };
    const grant = { v: 1, cert: cert(pc.aik, d3, e.clock.now() + 90 * D), deviceList: list, enc: k(), ct: randomBytes(48).toString('base64') };
    assert.equal((await pc.call('POST', `${base}/grant`, { grant })).json.error, 'account.link_state');
    assert.equal((await pc.call('PUT', '/v1/device-list', { deviceList: list })).status, 200);
    assert.equal((await pc2('POST', `${base}/grant`, { grant })).json.error, 'account.link_state');
    assert.equal((await pc.call('POST', `${base}/grant`, { grant: { ...grant, ct: 'AAAA' } })).json.error, 'request.param_rejected');
    assert.equal((await pc.call('POST', `${base}/grant`, { grant })).status, 204);
    assert.equal((await pc.call('POST', `${base}/grant`, { grant })).json.error, 'account.link_state');
    // 끝난 신청은 기존 PC 목록에서 빠지고, 새 PC가 받아 간 뒤 지운다
    assert.deepEqual((await pc.call('GET', '/v1/pc-links')).json, { links: [] });
    assert.deepEqual((await e.req('GET', base, { headers: bearer(s) })).json, { challenge, grant });
    assert.equal((await e.req('DELETE', base, { headers: bearer(s) })).status, 204);
    assert.equal((await e.req('GET', base, { headers: bearer(s) })).status, 404);
    assert.equal((await e.req('DELETE', base, { headers: bearer(s) })).status, 204);

    // 기존 PC가 거절하면(6자리가 틀림) 지워진다. 7일이 지난 신청은 정리가 지운다
    const s2 = await login(e, 'link2@example.com');
    const pcB = await desktop(e, s2);
    e.clock.advance(60_000);
    const d4 = device('desktop', e.clock.now());
    const h4 = { v: 1, device_id: d4.id, Sx: d4.S.b64, Vx: d4.V.b64, Hx: k(), commit: k() };
    assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s2), body: { deviceId: d4.id, role: 'desktop', platform: 'macos', name: '또 다른 PC', Sx: d4.S.b64, Vx: d4.V.b64 } })).status, 201);
    assert.equal((await e.req('PUT', `/v1/pc-links/${d4.id}`, { headers: bearer(s2), body: { hello: h4 } })).status, 204);
    // 새 PC가 그만두면 우편함만 비고 신청 중인 기기 기록은 남는다(다시 시도할 때 쓴다)
    assert.equal((await e.req('DELETE', `/v1/pc-links/${d4.id}`, { headers: bearer(s2) })).status, 204);
    assert.equal(((await pcB.call('GET', '/v1/devices')).json.devices as Array<{ deviceId: string; state: string }>).find((x) => x.deviceId === d4.id)?.state, 'pending');
    assert.equal((await e.req('PUT', `/v1/pc-links/${d4.id}`, { headers: bearer(s2), body: { hello: h4 } })).status, 204);
    // 쓰던 PC가 거절하면 신청 기록까지 지워 자리가 빈다. 활성 기기는 이 경로로 지워지지 않는다
    assert.equal((await pcB.call('DELETE', `/v1/pc-links/${d4.id}`)).status, 204);
    assert.equal((await e.req('GET', `/v1/pc-links/${d4.id}`, { headers: bearer(s2) })).status, 404);
    assert.equal(((await pcB.call('GET', '/v1/devices')).json.devices as Array<{ deviceId: string }>).some((x) => x.deviceId === d4.id), false);
    assert.equal((await pcB.call('DELETE', `/v1/pc-links/${pcB.d.id}`)).status, 204);
    assert.equal(((await pcB.call('GET', '/v1/devices')).json.devices as Array<{ deviceId: string; state: string }>).find((x) => x.deviceId === pcB.d.id)?.state, 'active');
    assert.equal((await e.req('PUT', `/v1/pc-links/${d4.id}`, { headers: bearer(s2), body: { hello: h4 } })).status, 404);
    assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s2), body: { deviceId: d4.id, role: 'desktop', platform: 'macos', name: '또 다른 PC', Sx: d4.S.b64, Vx: d4.V.b64 } })).status, 201);
    // 다시 올리면 앞 단계가 지워지고 새로 시작한다
    assert.equal((await e.req('PUT', `/v1/pc-links/${d4.id}`, { headers: bearer(s2), body: { hello: h4 } })).status, 204);
    assert.equal((await pcB.call('POST', `/v1/pc-links/${d4.id}/challenge`, { challenge: { ...challenge, device_id: pcB.d.id, aik_pub: pcB.aik.b64 } })).status, 204);
    assert.equal((await e.req('PUT', `/v1/pc-links/${d4.id}`, { headers: bearer(s2), body: { hello: { ...h4, commit: k() } } })).status, 204);
    assert.deepEqual((await e.req('GET', `/v1/pc-links/${d4.id}`, { headers: bearer(s2) })).json, { challenge: null, grant: null });
    e.clock.advance(PC_LINK.ttlDays * D + 1);
    assert.equal(Number((await e.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM pc_links'))!.n), 1);
    await e.svc.sweep();
    assert.equal(Number((await e.db.one<{ n: number }>('SELECT COUNT(*) AS n FROM pc_links'))!.n), 0);
  });

  it('발급 잠금: 잡고 있던 PC가 끊기거나 정지되면 잠금도 바로 풀린다', async () => {
    const { s, pc, d2, ps } = await fleet(e, 'lock2@example.com', 1);
    const pc2 = caller(e, pc.aik, d2);
    assert.equal((await pc2('POST', '/v1/issue-lock/acquire')).status, 200);
    assert.equal((await e.req('POST', `/v1/devices/${d2.id}/suspend`, { headers: bearer(s) })).status, 204);
    assert.equal((await pc.call('GET', '/v1/issue-lock')).json.held, false);
    assert.equal((await pc.call('POST', '/v1/issue-lock/acquire')).status, 200);
    // 다른 계정의 잠금과는 무관하다
    const other = await desktop(e, await login(e, 'lock3@example.com'));
    assert.equal((await other.call('POST', '/v1/issue-lock/acquire')).status, 200);
    assert.ok(ps.length === 1);
  });

  it('데스크톱이 정지되면 그 데스크톱의 기존 토큰도 즉시 거부된다', async () => {
    const s = await login(e, 'stop2@example.com');
    const pc = await desktop(e, s);
    const t = await pc.token();
    await e.req('POST', `/v1/devices/${pc.d.id}/suspend`, { headers: bearer(s) });
    const r = await e.req('POST', '/v1/slots', { headers: { authorization: `DPoP ${t}`, dpop: dpop('POST', ORIGIN + '/v1/slots', t, pc.d.V, e.clock.now()) } });
    assert.equal(r.json.error, 'account.device_suspended');
  });

  it('계정 세션 삭제 요청은 7일 유예 + 알림 + 취소 가능', async () => {
    let s = await login(e, 'del@example.com');
    const pc = await desktop(e, s);
    const r = await e.req('POST', `/v1/devices/${pc.d.id}/delete-request`, { headers: bearer(s) });
    assert.equal(r.status, 202);
    assert.equal(r.json.deleteAfter, e.clock.now() + 7 * D);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_delete_pending'));
    assert.equal((await e.req('POST', `/v1/devices/${pc.d.id}/delete-cancel`, { headers: bearer(s) })).status, 204);
    e.clock.advance(8 * D);
    await e.svc.sweep();
    assert.deepEqual(e.stopped, []);
    s = await login(e, 'del@example.com'); // 세션 1시간(ADR-038 (f))
    await e.req('POST', `/v1/devices/${pc.d.id}/delete-request`, { headers: bearer(s) });
    e.clock.advance(7 * D - 1);
    await e.svc.sweep();
    assert.deepEqual(e.stopped, []);
    e.clock.advance(1);
    await e.svc.sweep();
    assert.deepEqual(e.stopped, [pc.d.id]);
  });

  it('이메일만으로 추가한 기기는 72시간 대기 뒤에야 활성화(AIK 인증서 없이는 여전히 토큰 없음)', async () => {
    let s = await login(e, 'hold@example.com');
    await desktop(e, s);
    const phone = device('mobile', 0);
    await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: phone.id, role: 'mobile', platform: 'android', name: '폰', Sx: phone.S.b64, Vx: phone.V.b64 } });
    e.clock.advance(72 * H - 1000);
    s = await login(e, 'hold@example.com'); // 세션 1시간(ADR-038 (f))
    const early = await e.req('POST', `/v1/devices/${phone.id}/activate`, { headers: bearer(s) });
    assert.equal(early.json.error, 'account.device_hold');
    assert.ok(Number(early.headers.get('retry-after')) >= 1);
    e.clock.advance(1000);
    assert.equal((await e.req('POST', `/v1/devices/${phone.id}/activate`, { headers: bearer(s) })).status, 204);
    const fake = cert(edKey(), phone, e.clock.now() + 90 * D);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(fake), phone.V, e.clock.now()) }, body: { cert: fake } })).json.error, 'account.cert_invalid');
  });

  it('기기 상한(모바일 3)·30일 등록 상한(모바일 5)·플랫폼과 역할 불일치·중복 ID', async () => {
    let s = await login(e, 'lim@example.com');
    const enroll = (p: Device, platform = 'ios') => e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: p.id, role: p.role, platform, name: '폰', Sx: p.S.b64, Vx: p.V.b64 } });
    const ps = [device('mobile', 0), device('mobile', 0), device('mobile', 0)];
    for (const p of ps) assert.equal((await enroll(p)).status, 201);
    assert.equal((await enroll(device('mobile', 0))).json.error, 'account.device_limit');
    assert.equal((await enroll(ps[0]!)).json.error, 'account.device_limit');
    for (const p of ps) await e.req('POST', `/v1/devices/${p.id}/suspend`, { headers: bearer(s) });
    // 정지는 상한에서 빠지지 않는다(폐기만 빠진다). 폐기를 흉내 내려 대기 기기를 7일 뒤 정리
    e.clock.advance(8 * D);
    await e.svc.sweep();
    s = await login(e, 'lim@example.com'); // 세션 1시간(ADR-038 (f))
    assert.equal((await enroll(device('mobile', 0))).json.error, 'account.device_limit');
    await e.db.run("UPDATE devices SET state = 'revoked'");
    assert.equal((await enroll(device('mobile', 0))).status, 201);
    assert.equal((await enroll(device('mobile', 0))).status, 201);
    // 30일 안 추가 5회째까지 썼으니 기기 수(2)가 상한 아래여도 막힌다
    assert.equal((await enroll(device('mobile', 0))).json.error, 'account.device_churn_limit');
    assert.equal((await enroll(device('mobile', 0), 'windows')).json.error, 'request.param_rejected');
  });
});

describe('M4-5 계정: 프로필 슬롯·사업자 HMAC 재바인딩 90일(B-28)', () => {
  let e: Env;
  before(async () => (e = await start()));
  after(() => e.server.close());

  it('슬롯 2개 상한, 바인딩·재바인딩 90일, 삭제로 우회 불가, RK 교체 재등록은 세지 않음', async () => {
    const s = await login(e, 'slot@example.com');
    const pc = await desktop(e, s);
    const accountId = (await e.db.one<{ id: string }>('SELECT id FROM accounts WHERE email = $1', ['slot@example.com']))!.id;
    const a = (await pc.call('POST', '/v1/slots')).json.slotToken as string;
    const b = (await pc.call('POST', '/v1/slots')).json.slotToken as string;
    assert.equal((await pc.call('POST', '/v1/slots')).json.error, 'account.slot_limit');
    const h1 = randomBytes(16).toString('hex');
    const h2 = randomBytes(16).toString('hex');
    assert.equal((await pc.call('PUT', `/v1/slots/${a}/biz`, { bizHmac: '1234567890' })).json.error, 'request.param_rejected');
    assert.deepEqual((await pc.call('PUT', `/v1/slots/${a}/biz`, { bizHmac: h1 })).json, { changed: true });
    assert.deepEqual((await pc.call('PUT', `/v1/slots/${a}/biz`, { bizHmac: h1 })).json, { changed: false });
    const tooSoon = await pc.call('PUT', `/v1/slots/${a}/biz`, { bizHmac: h2 });
    assert.equal(tooSoon.json.error, 'account.rebind_too_soon');
    // RK 교체 재등록(AIK 서명)은 횟수에 세지 않는다. 대상은 slot:hmac에 결속.
    assert.equal((await pc.call('PUT', `/v1/slots/${a}/biz`, { bizHmac: h2, rkOp: acctOp(pc.aik, 'slot.rebind_rk', accountId, `${a}:${h1}`, e.clock.now()) })).json.error, 'account.aik_signature_invalid');
    assert.deepEqual((await pc.call('PUT', `/v1/slots/${a}/biz`, { bizHmac: h2, rkOp: acctOp(pc.aik, 'slot.rebind_rk', accountId, `${a}:${h2}`, e.clock.now()) })).json, { changed: true });
    e.clock.advance(90 * D);
    assert.deepEqual((await pc.call('PUT', `/v1/slots/${a}/biz`, { bizHmac: h1 })).json, { changed: true });
    // 바인딩된 슬롯을 지우고 다른 슬롯에 새로 바인딩해 90일 규칙을 피할 수 없다
    e.clock.advance(91 * D);
    assert.equal((await pc.call('DELETE', `/v1/slots/${a}`)).status, 204);
    assert.equal((await pc.call('PUT', `/v1/slots/${b}/biz`, { bizHmac: h2 })).json.error, 'account.rebind_too_soon');
    // 세션은 1시간이라 시계를 181일 돌린 뒤엔 다시 로그인한다
    const s2 = await login(e, 'slot@example.com');
    const slots = await e.req('GET', '/v1/slots', { headers: bearer(s2) });
    assert.equal(slots.status, 200, slots.text);
    assert.deepEqual(slots.json.slots, [{ slotToken: b, bound: false }]);
    assert.equal((await pc.call('PUT', `/v1/slots/nonexistent/biz`, { bizHmac: h2 })).json.error, 'account.slot_not_found');
    const me = await e.req('GET', '/v1/me', { headers: bearer(s2) });
    assert.equal(me.json.hasBizProfile, false);
    assert.equal(me.json.slotsUsed, 1);
  });
});

describe('M4-5 계정: 구독(19,900원 한 플랜, 모의 PG)', () => {
  let e: Env;
  before(async () => (e = await start()));
  after(() => e.server.close());

  it('결제 창 → 서명된 웹훅으로 활성, 서명 틀린 웹훅 거부, 해지', async () => {
    const s = await login(e, 'pay@example.com');
    const t0 = e.clock.now();
    const c = await e.req('POST', '/v1/billing/checkout', { headers: bearer(s) });
    assert.equal(c.status, 200);
    assert.equal(e.pg.checkouts[0]!.amountKrw, 19900);
    const ref = e.pg.checkouts[0]!.pgCustomerRef;
    assert.ok(!ref.includes('pay@example.com'));
    const event = JSON.stringify({ type: 'subscription.activated', pgCustomerRef: ref, renewAt: t0 + 30 * D, at: t0 + 1 });
    assert.equal((await e.req('POST', '/v1/billing/webhook', { raw: event, headers: { 'x-mock-pg-signature': '0'.repeat(64) } })).json.error, 'account.billing_signature_invalid');
    const noAt = JSON.stringify({ type: 'subscription.activated', pgCustomerRef: ref, renewAt: t0 + 30 * D });
    assert.equal((await e.req('POST', '/v1/billing/webhook', { raw: noAt, headers: { 'x-mock-pg-signature': e.pg.sign(Buffer.from(noAt)) } })).json.error, 'account.billing_signature_invalid');
    assert.equal((await e.req('POST', '/v1/billing/webhook', { raw: event, headers: { 'x-mock-pg-signature': e.pg.sign(Buffer.from(event)) } })).status, 200);
    const sub = await e.req('GET', '/v1/billing/subscription', { headers: bearer(s) });
    assert.deepEqual(sub.json.subscription, { plan: 'standard', status: 'active', renewAt: t0 + 30 * D, amountKrw: 19900, period: 'month' });
    assert.equal((await e.req('POST', '/v1/billing/checkout', { headers: bearer(s) })).status, 400);
    const unknown = JSON.stringify({ type: 'payment.failed', pgCustomerRef: 'cus_unknown', at: t0 });
    assert.equal((await e.req('POST', '/v1/billing/webhook', { raw: unknown, headers: { 'x-mock-pg-signature': e.pg.sign(Buffer.from(unknown)) } })).status, 200);
    assert.equal((await e.req('POST', '/v1/billing/cancel', { headers: bearer(s) })).status, 204);
    assert.deepEqual(e.pg.canceled, [ref]);
    assert.equal((await e.req('POST', '/v1/consents', { headers: bearer(s), body: { version: 'privacy-2026.11' } })).status, 204);
    assert.deepEqual((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.consents, ['privacy-2026.11']);
  });

  it('탈퇴: 7일 유예, 구독 바로 해지·알림 메일, 유예 중 취소, 유예 끝나면 계정 삭제(처리방침 3항·약관 제15조)', async () => {
    const s = await login(e, 'bye@example.com');
    const pc = await desktop(e, s);
    const t0 = e.clock.now();
    await e.req('POST', '/v1/billing/checkout', { headers: bearer(s) });
    const ref = e.pg.checkouts.at(-1)!.pgCustomerRef;
    const act = JSON.stringify({ type: 'subscription.activated', pgCustomerRef: ref, renewAt: t0 + 30 * D, at: t0 + 1 });
    await e.req('POST', '/v1/billing/webhook', { raw: act, headers: { 'x-mock-pg-signature': e.pg.sign(Buffer.from(act)) } });
    assert.equal((await e.req('POST', '/v1/account/delete-cancel', { headers: bearer(s) })).json.error, 'account.not_pending');
    const r = await e.req('POST', '/v1/account/delete-request', { headers: bearer(s) });
    assert.equal(r.status, 202);
    assert.equal(r.json.deleteAfter, t0 + 7 * D);
    assert.ok(e.pg.canceled.includes(ref), '다음 결제가 없게 구독을 바로 해지');
    assert.ok(e.mail.outbox.some((m) => m.to === 'bye@example.com' && m.kind === 'account_delete_pending'));
    // 다시 눌러도 같은 예정 시각
    assert.equal((await e.req('POST', '/v1/account/delete-request', { headers: bearer(s) })).json.deleteAfter, t0 + 7 * D);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.deleteAfter, t0 + 7 * D);
    assert.deepEqual((await e.req('GET', '/v1/account/deletion', { headers: bearer(s) })).json, { deleteAfter: t0 + 7 * D });
    assert.equal((await e.req('POST', '/v1/account/delete-cancel', { headers: bearer(s) })).status, 204);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.deleteAfter, null);
    // 데스크톱은 세션 없이 기기 토큰으로 요청한다(등록 뒤 세션을 버린다)
    assert.equal((await pc.call('POST', '/v1/account/delete-request')).status, 202);
    assert.equal((await pc.call('GET', '/v1/account/deletion')).json.deleteAfter, e.clock.now() + 7 * D);
    e.clock.advance(7 * D - 60_000);
    const left = async () => Number((await e.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM accounts WHERE email = 'bye@example.com'"))?.n ?? 0);
    await e.svc.sweep();
    assert.equal(await left(), 1, '유예 중에는 남는다');
    e.clock.advance(2 * 60_000);
    await e.svc.sweep();
    assert.equal(await left(), 0, '유예가 끝나면 계정이 없다');
    assert.ok(e.stopped.includes(pc.d.id), '기기 정지 훅(릴레이·푸시)');
    assert.ok(e.events.includes('account.deleted'));
  });

  it('웹훅 순서는 PG 이벤트 시각: 늦은·재전송 이벤트 무시, 결제 실패 뒤 같은 기간 재결제는 active, 해지는 끝 상태', async () => {
    const s = await login(e, 'order@example.com');
    const t0 = e.clock.now();
    const hook = (o: object) => {
      const raw = JSON.stringify(o);
      return e.req('POST', '/v1/billing/webhook', { raw, headers: { 'x-mock-pg-signature': e.pg.sign(Buffer.from(raw)) } });
    };
    const status = async () => (await e.req('GET', '/v1/billing/subscription', { headers: bearer(s) })).json.subscription as Record<string, unknown>;
    // 동시에 두 번 눌러도 같은 참조
    const [a, b] = await Promise.all([e.req('POST', '/v1/billing/checkout', { headers: bearer(s) }), e.req('POST', '/v1/billing/checkout', { headers: bearer(s) })]);
    assert.equal(a.json.checkoutUrl, b.json.checkoutUrl);
    const ref = e.pg.checkouts.at(-1)!.pgCustomerRef;
    await hook({ type: 'subscription.activated', pgCustomerRef: ref, renewAt: t0 + 30 * D, at: t0 + 10 });
    await hook({ type: 'payment.failed', pgCustomerRef: ref, at: t0 + 20 });
    assert.equal((await status()).status, 'past_due');
    // 재전송된 옛 활성 이벤트(at이 이전)는 무시
    await hook({ type: 'subscription.activated', pgCustomerRef: ref, renewAt: t0 + 30 * D, at: t0 + 10 });
    assert.equal((await status()).status, 'past_due');
    // 같은 기간(같은 renewAt)을 확정하는 재결제 성공은 더 늦은 이벤트라 active
    await hook({ type: 'subscription.renewed', pgCustomerRef: ref, renewAt: t0 + 30 * D, at: t0 + 30 });
    assert.deepEqual([(await status()).status, (await status()).renewAt], ['active', t0 + 30 * D]);
    // 순서가 뒤바뀐 옛 결제 실패는 무시
    await hook({ type: 'payment.failed', pgCustomerRef: ref, at: t0 + 25 });
    assert.equal((await status()).status, 'active');
    assert.equal((await e.req('POST', '/v1/billing/cancel', { headers: bearer(s) })).status, 204);
    for (const ev of [
      { type: 'subscription.renewed', pgCustomerRef: ref, renewAt: t0 + 60 * D, at: t0 + 99 },
      { type: 'subscription.activated', pgCustomerRef: ref, renewAt: t0 + 30 * D, at: t0 + 100 },
      { type: 'payment.failed', pgCustomerRef: ref, at: t0 + 101 },
    ])
      await hook(ev);
    assert.equal((await status()).status, 'canceled');
    // 다시 구독: 새 PG 참조(동시 클릭도 같은 참조). 옛 참조 이벤트는 새 구독에 닿지 않는다
    const [c1, c2] = await Promise.all([e.req('POST', '/v1/billing/checkout', { headers: bearer(s) }), e.req('POST', '/v1/billing/checkout', { headers: bearer(s) })]);
    assert.equal(c1.json.checkoutUrl, c2.json.checkoutUrl);
    const ref2 = e.pg.checkouts.at(-1)!.pgCustomerRef;
    assert.notEqual(ref2, ref);
    await hook({ type: 'subscription.activated', pgCustomerRef: ref, renewAt: t0 + 30 * D, at: t0 + 200 });
    assert.equal((await status()).status, 'pending');
    await hook({ type: 'subscription.activated', pgCustomerRef: ref2, renewAt: t0 + 30 * D, at: t0 + 201 });
    assert.equal((await status()).status, 'active');
    // 옛 참조의 해지 재전송(시각이 더 늦어도)은 새 구독을 해지하지 않는다. 같은 참조 안에서는 해지 뒤 활성이 없으므로 해지에 최신성 필터가 필요 없다
    await hook({ type: 'subscription.canceled', pgCustomerRef: ref, at: t0 + 300 });
    assert.equal((await status()).status, 'active');
  });
});

describe('유료 기능 권리(체험 1달): 체험이 끝나고 구독이 없으면 게이트웨이 범위 토큰을 주지 않는다', () => {
  let e: Env;
  before(async () => (e = await start()));
  after(() => e.server.close());

  it('체험 중 전체 범위 → 체험 뒤 게이트웨이만 빠짐, 게이트웨이만 요청하면 402, 구독하면 다시', async () => {
    const s = await login(e, 'gate@example.com');
    const { aik, d, call } = await desktop(e, s);
    // 데스크톱은 기기 토큰(devlist)으로 구독 경로를 부른다(기기 등록 뒤 계정 세션을 버린다)
    assert.equal((await call('GET', '/v1/billing/entitlement')).json.state, 'trial');
    assert.equal((await call('GET', '/v1/billing/subscription')).json.subscription, null);
    const tok = async (scopes?: string[]) => {
      const c = cert(aik, d, e.clock.now() + 90 * D);
      return e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), d.V, e.clock.now()) }, body: scopes ? { cert: c, scopes } : { cert: c } });
    };
    assert.ok(((await tok()).json.scopes as string[]).includes('gateway'));
    // 같은 계정의 폰: 체험 중에는 chat 범위와 등급(tier)이 실린다
    const phone = device('mobile', e.clock.now());
    assert.equal((await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: phone.id, role: 'mobile', platform: 'ios', name: '폰', Sx: phone.S.b64, Vx: phone.V.b64 } })).status, 201);
    assert.equal((await call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(aik, d, 1), entry(aik, phone, 2)], revoked: [] } })).status, 200);
    const ptok = async (scopes?: string[]) => {
      const c = cert(aik, phone, e.clock.now() + 90 * D);
      return e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(c), phone.V, e.clock.now()) }, body: scopes ? { cert: c, scopes } : { cert: c } });
    };
    const trialTok = await ptok();
    assert.deepEqual(trialTok.json.scopes, ['relay', 'push', 'chat', 'devices']);
    assert.equal(JSON.parse(Buffer.from((trialTok.json.token as string).split('.')[1]!, 'base64url').toString('utf8')).tier, 'trial');
    e.clock.advance(32 * D);
    const t = await tok();
    assert.equal(t.status, 200);
    assert.ok(!(t.json.scopes as string[]).includes('gateway'));
    assert.ok((t.json.scopes as string[]).includes('relay'));
    const g = await tok(['gateway']);
    assert.deepEqual([g.status, g.json.error], [402, 'account.subscription_required']);
    // 폰 대화(chat 범위, ADR-047)도 유료 기능이다: 체험 뒤에는 빠지고 relay·push·devices(기기 끊기, ADR-048)는 남는다. chat만 달라면 402
    const pt = await ptok();
    assert.deepEqual(pt.json.scopes, ['relay', 'push', 'devices']);
    const pg = await ptok(['chat']);
    assert.deepEqual([pg.status, pg.json.error], [402, 'account.subscription_required']);
    // 모의 PG로 구독 활성
    const s2 = await login(e, 'gate@example.com');
    await e.req('POST', '/v1/billing/checkout', { headers: bearer(s2) });
    const ref = e.pg.checkouts.at(-1)!.pgCustomerRef;
    const raw = JSON.stringify({ type: 'subscription.activated', pgCustomerRef: ref, renewAt: e.clock.now() + 30 * D, at: e.clock.now() });
    await e.req('POST', '/v1/billing/webhook', { raw, headers: { 'x-mock-pg-signature': e.pg.sign(Buffer.from(raw)) } });
    assert.equal((await tok(['gateway'])).status, 200);
    assert.equal((await call('GET', '/v1/billing/entitlement')).json.state, 'paid');
    assert.equal((await ptok(['chat'])).status, 200);
    assert.equal((await call('POST', '/v1/billing/cancel')).status, 204);
  });
});

describe('M4-5 계정: 내부 API·로그·저장 컬럼(D09 §1.1)', () => {
  let e: Env;
  before(async () => (e = await start()));
  after(() => e.server.close());

  it('내부 기기 상태 API는 INTERNAL_CALL_KEY 서명이 있어야 한다(옛 Internal 비밀·다른 키 서명은 401)', async () => {
    const s = await login(e, 'int@example.com');
    const pc = await desktop(e, s);
    const dev = `/internal/v1/devices/${pc.d.id}`;
    const sus = `${dev}/auto-suspend`;
    assert.equal((await e.req('GET', dev)).status, 401);
    assert.equal((await e.req('GET', dev, { headers: { authorization: 'Internal wrong' } })).status, 401);
    assert.equal((await e.req('GET', dev, { headers: { authorization: signInternalCall(randomBytes(32), 'GET', dev) } })).status, 401);
    const r = await e.req('GET', dev, { headers: internalHeaders('GET', dev) });
    assert.equal(r.json.state, 'active');
    assert.equal(r.json.role, 'desktop');
    // 게이트웨이 자동 정지(D09 §3): 서명 필요, 정지 훅·알림, 두 번째는 변화 없음
    assert.equal((await e.req('POST', sus)).status, 401);
    const a = await e.req('POST', sus, { headers: internalHeaders('POST', sus) });
    assert.deepEqual(a.json, { suspended: true });
    assert.deepEqual(e.stopped, [pc.d.id]);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_auto_suspended'));
    assert.deepEqual((await e.req('POST', sus, { headers: internalHeaders('POST', sus) })).json, { suspended: false });
    assert.equal((await e.req('GET', dev, { headers: internalHeaders('GET', dev) })).json.state, 'suspended');
  });

  it('접근 로그는 고정 필드·라우트 패턴뿐이고 이메일·IP·토큰·기기 ID가 없다', async () => {
    assert.ok(e.logs.length > 5);
    for (const line of e.logs) {
      const o = JSON.parse(line) as Record<string, unknown>;
      assert.deepEqual(Object.keys(o).filter((k) => !['t', 'svc', 'm', 'route', 'status', 'code', 'bytesIn', 'bytesOut', 'ms', 'aid'].includes(k)), []);
      assert.ok(!looksSensitive(line), line);
      assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-4/.test(line), line);
    }
    assert.ok(e.logs.some((l) => l.includes('"route":"/internal/v1/devices/:id"')));
  });

  it('마이그레이션의 저장 컬럼 = 가시성 표(README·PR 본문), 금지 컬럼 없음', () => {
    const cols = schemaColumns(MIGRATIONS_DIR);
    assert.deepEqual(Object.keys(cols).sort(), Object.keys(ACCOUNT_VISIBILITY).sort());
    for (const [t, cs] of Object.entries(cols)) {
      assert.deepEqual([...cs].sort(), Object.keys(ACCOUNT_VISIBILITY[t]!).sort(), t);
      for (const c of cs) assert.ok(!FORBIDDEN_COLUMN.test(c), `${t}.${c}`);
    }
  });

  it('D16 추가 제안 코드는 형식 <영역>.<코드>', () => {
    for (const c of PROPOSED_D16) assert.match(c, /^[a-z_]+\.[a-z_]+$/);
  });
});
