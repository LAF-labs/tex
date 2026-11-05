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
  type Sql,
} from '../services/shared/src/index.ts';
import { ACCOUNT_VISIBILITY, AccountService, MIGRATIONS_DIR, MockMailSender, MockPaymentGateway, accountRouter } from '../services/account/src/index.ts';
import { Clock, D, H, SoftPasskey, acctOp, cert, client, device, dpop, edKey, entry, revokeRec, type Device, type EdKey } from './services-kit.ts';

const ORIGIN = 'https://account.test.invalid';
const RP = { rpId: 'account.test.invalid', origins: [ORIGIN] };
const INTERNAL = randomBytes(32).toString('hex');

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
}

async function start(): Promise<Env> {
  const clock = new Clock();
  const db = openSqlite();
  await migrate(db, 'account', MIGRATIONS_DIR);
  const mail = new MockMailSender();
  const pg = new MockPaymentGateway();
  const signKey = edKey().priv;
  const stopped: string[] = [];
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
    now: clock.now,
  });
  const logs: string[] = [];
  const router = accountRouter({ svc, verifier: new TokenVerifier({ k1: ed25519RawPublic(signKey) }), publicOrigin: ORIGIN, internalSecret: INTERNAL });
  const server = createServer(router, { logger: new Logger('account', (l) => logs.push(l), clock.now) });
  const base = await listen(server);
  return { clock, db, mail, pg, svc, server, req: client(base), logs, stopped };
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
    e.clock.advance(31 * D);
    assert.equal((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.error, 'account.unauthorized');
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

  it('폰: 등록 신청(대기) → PC가 AIK 서명 목록에 넣으면 즉시 활성 → 폰 토큰은 relay·push 범위만', async () => {
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
    assert.deepEqual(tok.json.scopes, ['relay', 'push']);
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

  it('폐기: 등록 7일 미만 데스크톱의 서명은 7일 유예 뒤 폐기, 7일 이상이면 즉시. 폐기 시 릴레이·푸시 정지 훅', async () => {
    const s = await login(e, 'rev@example.com');
    const pc = await desktop(e, s);
    const p1 = device('mobile', 0);
    const p2 = device('mobile', 0);
    for (const p of [p1, p2]) await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: p.id, role: 'mobile', platform: 'ios', name: '폰', Sx: p.S.b64, Vx: p.V.b64 } });
    await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 2, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, p1, 2), entry(pc.aik, p2, 2)], revoked: [] } });
    const r = await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 3, entries: [entry(pc.aik, pc.d, 1), entry(pc.aik, p2, 2)], revoked: [revokeRec(pc.aik, p1.id, e.clock.now())] } });
    assert.equal(r.status, 200);
    const list1 = (await e.req('GET', '/v1/devices', { headers: bearer(s) })).json.devices as Array<Record<string, unknown>>;
    assert.equal(list1.find((x) => x.deviceId === p1.id)!.state, 'active');
    assert.equal(list1.find((x) => x.deviceId === p1.id)!.deleteAfter, e.clock.now() + 7 * D);
    assert.deepEqual(e.stopped, []);
    e.clock.advance(7 * D);
    await e.svc.sweep();
    assert.deepEqual(e.stopped, [p1.id]);
    // 데스크톱이 7일 넘었으니 이번에는 즉시
    const r2 = await pc.call('PUT', '/v1/device-list', { deviceList: { listVersion: 4, entries: [entry(pc.aik, pc.d, 1)], revoked: [revokeRec(pc.aik, p1.id, 1), revokeRec(pc.aik, p2.id, e.clock.now())] } });
    assert.equal(r2.status, 200, r2.text);
    assert.deepEqual(e.stopped, [p1.id, p2.id]);
    const list2 = (await e.req('GET', '/v1/devices', { headers: bearer(s) })).json.devices as Array<Record<string, unknown>>;
    assert.equal(list2.find((x) => x.deviceId === p2.id)!.state, 'revoked');
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

  it('데스크톱이 정지되면 그 데스크톱의 기존 토큰도 즉시 거부된다', async () => {
    const s = await login(e, 'stop2@example.com');
    const pc = await desktop(e, s);
    const t = await pc.token();
    await e.req('POST', `/v1/devices/${pc.d.id}/suspend`, { headers: bearer(s) });
    const r = await e.req('POST', '/v1/slots', { headers: { authorization: `DPoP ${t}`, dpop: dpop('POST', ORIGIN + '/v1/slots', t, pc.d.V, e.clock.now()) } });
    assert.equal(r.json.error, 'account.device_suspended');
  });

  it('계정 세션 삭제 요청은 7일 유예 + 알림 + 취소 가능', async () => {
    const s = await login(e, 'del@example.com');
    const pc = await desktop(e, s);
    const r = await e.req('POST', `/v1/devices/${pc.d.id}/delete-request`, { headers: bearer(s) });
    assert.equal(r.status, 202);
    assert.equal(r.json.deleteAfter, e.clock.now() + 7 * D);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_delete_pending'));
    assert.equal((await e.req('POST', `/v1/devices/${pc.d.id}/delete-cancel`, { headers: bearer(s) })).status, 204);
    e.clock.advance(8 * D);
    await e.svc.sweep();
    assert.deepEqual(e.stopped, []);
    await e.req('POST', `/v1/devices/${pc.d.id}/delete-request`, { headers: bearer(s) });
    e.clock.advance(7 * D - 1);
    await e.svc.sweep();
    assert.deepEqual(e.stopped, []);
    e.clock.advance(1);
    await e.svc.sweep();
    assert.deepEqual(e.stopped, [pc.d.id]);
  });

  it('이메일만으로 추가한 기기는 72시간 대기 뒤에야 활성화(AIK 인증서 없이는 여전히 토큰 없음)', async () => {
    const s = await login(e, 'hold@example.com');
    await desktop(e, s);
    const phone = device('mobile', 0);
    await e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: phone.id, role: 'mobile', platform: 'android', name: '폰', Sx: phone.S.b64, Vx: phone.V.b64 } });
    e.clock.advance(72 * H - 1000);
    const early = await e.req('POST', `/v1/devices/${phone.id}/activate`, { headers: bearer(s) });
    assert.equal(early.json.error, 'account.device_hold');
    assert.ok(Number(early.headers.get('retry-after')) >= 1);
    e.clock.advance(1000);
    assert.equal((await e.req('POST', `/v1/devices/${phone.id}/activate`, { headers: bearer(s) })).status, 204);
    const fake = cert(edKey(), phone, e.clock.now() + 90 * D);
    assert.equal((await e.req('POST', '/v1/device-tokens', { headers: { dpop: dpop('POST', ORIGIN + '/v1/device-tokens', jcs(fake), phone.V, e.clock.now()) }, body: { cert: fake } })).json.error, 'account.cert_invalid');
  });

  it('기기 상한(모바일 3)·30일 등록 상한(모바일 5)·플랫폼과 역할 불일치·중복 ID', async () => {
    const s = await login(e, 'lim@example.com');
    const enroll = (p: Device, platform = 'ios') => e.req('POST', '/v1/devices/enroll', { headers: bearer(s), body: { deviceId: p.id, role: p.role, platform, name: '폰', Sx: p.S.b64, Vx: p.V.b64 } });
    const ps = [device('mobile', 0), device('mobile', 0), device('mobile', 0)];
    for (const p of ps) assert.equal((await enroll(p)).status, 201);
    assert.equal((await enroll(device('mobile', 0))).json.error, 'account.device_limit');
    assert.equal((await enroll(ps[0]!)).json.error, 'account.device_limit');
    for (const p of ps) await e.req('POST', `/v1/devices/${p.id}/suspend`, { headers: bearer(s) });
    // 정지는 상한에서 빠지지 않는다(폐기만 빠진다). 폐기를 흉내 내려 대기 기기를 7일 뒤 정리
    e.clock.advance(8 * D);
    await e.svc.sweep();
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
    // 세션은 30일이라 시계를 181일 돌린 뒤엔 다시 로그인한다
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

describe('M4-5 계정: 구독(9,900원 한 플랜, 모의 PG)', () => {
  let e: Env;
  before(async () => (e = await start()));
  after(() => e.server.close());

  it('결제 창 → 서명된 웹훅으로 활성, 서명 틀린 웹훅 거부, 해지', async () => {
    const s = await login(e, 'pay@example.com');
    const c = await e.req('POST', '/v1/billing/checkout', { headers: bearer(s) });
    assert.equal(c.status, 200);
    assert.equal(e.pg.checkouts[0]!.amountKrw, 9900);
    const ref = e.pg.checkouts[0]!.pgCustomerRef;
    assert.ok(!ref.includes('pay@example.com'));
    const event = JSON.stringify({ type: 'subscription.activated', pgCustomerRef: ref, renewAt: e.clock.now() + 30 * D });
    assert.equal((await e.req('POST', '/v1/billing/webhook', { raw: event, headers: { 'x-mock-pg-signature': '0'.repeat(64) } })).json.error, 'account.billing_signature_invalid');
    assert.equal((await e.req('POST', '/v1/billing/webhook', { raw: event, headers: { 'x-mock-pg-signature': e.pg.sign(Buffer.from(event)) } })).status, 200);
    const sub = await e.req('GET', '/v1/billing/subscription', { headers: bearer(s) });
    assert.deepEqual(sub.json.subscription, { plan: 'standard', status: 'active', renewAt: e.clock.now() + 30 * D, amountKrw: 9900, period: 'month' });
    assert.equal((await e.req('POST', '/v1/billing/checkout', { headers: bearer(s) })).status, 400);
    const unknown = JSON.stringify({ type: 'payment.failed', pgCustomerRef: 'cus_unknown' });
    assert.equal((await e.req('POST', '/v1/billing/webhook', { raw: unknown, headers: { 'x-mock-pg-signature': e.pg.sign(Buffer.from(unknown)) } })).status, 200);
    assert.equal((await e.req('POST', '/v1/billing/cancel', { headers: bearer(s) })).status, 204);
    assert.deepEqual(e.pg.canceled, [ref]);
    assert.equal((await e.req('POST', '/v1/consents', { headers: bearer(s), body: { version: 'privacy-2026.11' } })).status, 204);
    assert.deepEqual((await e.req('GET', '/v1/me', { headers: bearer(s) })).json.consents, ['privacy-2026.11']);
  });
});

describe('M4-5 계정: 내부 API·로그·저장 컬럼(D09 §1.1)', () => {
  let e: Env;
  before(async () => (e = await start()));
  after(() => e.server.close());

  it('내부 기기 상태 API는 내부 비밀이 있어야 한다', async () => {
    const s = await login(e, 'int@example.com');
    const pc = await desktop(e, s);
    assert.equal((await e.req('GET', `/internal/v1/devices/${pc.d.id}`)).status, 401);
    assert.equal((await e.req('GET', `/internal/v1/devices/${pc.d.id}`, { headers: { authorization: 'Internal wrong' } })).status, 401);
    const r = await e.req('GET', `/internal/v1/devices/${pc.d.id}`, { headers: { authorization: `Internal ${INTERNAL}` } });
    assert.equal(r.json.state, 'active');
    assert.equal(r.json.role, 'desktop');
    // 게이트웨이 자동 정지(D09 §3): 내부 비밀 필요, 정지 훅·알림, 두 번째는 변화 없음
    assert.equal((await e.req('POST', `/internal/v1/devices/${pc.d.id}/auto-suspend`)).status, 401);
    const a = await e.req('POST', `/internal/v1/devices/${pc.d.id}/auto-suspend`, { headers: { authorization: `Internal ${INTERNAL}` } });
    assert.deepEqual(a.json, { suspended: true });
    assert.deepEqual(e.stopped, [pc.d.id]);
    assert.ok(e.mail.outbox.some((m) => m.kind === 'device_auto_suspended'));
    assert.deepEqual((await e.req('POST', `/internal/v1/devices/${pc.d.id}/auto-suspend`, { headers: { authorization: `Internal ${INTERNAL}` } })).json, { suspended: false });
    assert.equal((await e.req('GET', `/internal/v1/devices/${pc.d.id}`, { headers: { authorization: `Internal ${INTERNAL}` } })).json.state, 'suspended');
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
