// 데스크톱 클라우드 포트(apps/desktop/src/remote-cloud.ts)와 egress 계정·릴레이 목적지(@sax/net cloud.ts, 팀장 결정 2026-11-06).
// 실제 계정·릴레이 서비스를 한 앞단 origin(개발 스택과 같은 모양)에 붙여 이메일 코드 로그인 → 첫 PC 등록 → 기기 토큰 → acct-claim·
// 기기 목록·룸·우편함 → 룸 WSS를 egress만으로 지난다. 운영 origin 판정은 허용 목록 함수와 testOrigins로 본다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { CLOUD_ORIGIN, CLOUD_WS_HOST, Egress, cloudHeaders, cloudRequestCheck, cloudSocketCheck } from '@sax/net';
import {
  AIK_PURPOSES,
  VD_PURPOSES,
  b64,
  certNotAfter,
  deviceAuthHeaders,
  ed25519Keygen,
  initialDeviceList,
  issueCert,
  jcsBytes,
  relayRoomPath,
  relayUrl,
  softNoiseStatic,
  softSigner,
  uuid4,
  verifyAcctClaim,
  wsRelayClient,
  x25519Keygen,
  type DesktopKeys,
} from '../packages/remote/src/index.ts';
import { cloudPorts, type CloudPorts, type DeviceAuth } from '../apps/desktop/src/remote-cloud.ts';
import { MockMailSender, startAccount } from '../services/account/src/index.ts';
import { startRelay } from '../services/relay/src/index.ts';
import { ed25519Private, ed25519RawPublic } from '../services/shared/src/index.ts';

const hex = () => randomBytes(32).toString('hex');

/** 개발 스택 모양의 앞단(apps/mobile/dev/stack.ts와 같은 갈래): /v1/mailboxes·/v1/rooms(WSS 포함) → 릴레이, 나머지 → 계정 */
async function stack() {
  const front = http.createServer();
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  const port = (front.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const seed = hex();
  const acctClaimSeed = hex();
  const internal = hex();
  const mail = new MockMailSender();
  // 내부 키 이름은 #135 전후 둘 다 넣는다(INTERNAL_TOKEN → INTERNAL_CALL_KEY)
  const common = { INTERNAL_TOKEN: internal, INTERNAL_CALL_KEY: internal, SAX_SQLITE_FILE: ':memory:', LIMIT_ID_KEY: hex(), HOST: '127.0.0.1', PORT: '0' };
  const account = await startAccount(
    {
      ...common,
      TOKEN_SIGNING_SEED: seed,
      ACCT_CLAIM_SIGNING_KEY: acctClaimSeed,
      CODE_MAC_KEY: hex(),
      ACCOUNT_PUBLIC_ORIGIN: origin,
      WEBAUTHN_RP_ID: '127.0.0.1',
      WEBAUTHN_ORIGINS: origin,
      BILLING_RETURN_URL: `${origin}/done`,
      PG_PROVIDER: 'mock',
      MAIL_PROVIDER: 'mock',
    },
    { mail },
  );
  const relay = await startRelay({ ...common, QUEUE_KEY: hex(), RELAY_PUBLIC_ORIGIN: origin, ACCOUNT_INTERNAL_URL: account.url, RELAY_ROOMS: '1', RELAY_LIVE: '1', TOKEN_PUBLIC_KEYS: `k1:${ed25519RawPublic(ed25519Private(Buffer.from(seed, 'hex'))).toString('base64')}` });
  const upstream = (p: string) => new URL(p.startsWith('/v1/mailboxes') || p.startsWith('/v1/rooms') ? relay.url : account.url);
  front.on('request', (req, res) => {
    const u = upstream(new URL(req.url ?? '/', 'http://x').pathname);
    const up = http.request({ host: u.hostname, port: u.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.writeHead(502).end());
    req.pipe(up);
  });
  front.on('upgrade', (req, sock, head) => {
    const u = upstream(new URL(req.url ?? '/', 'http://x').pathname);
    const up = connect(Number(u.port), u.hostname, () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(sock);
      sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  return {
    origin,
    host: `127.0.0.1:${port}`,
    mail,
    acctClaimPub: ed25519RawPublic(ed25519Private(Buffer.from(acctClaimSeed, 'hex'))),
    close: async () => {
      front.closeAllConnections();
      front.close();
      await Promise.all([account.close(), relay.close()]);
    },
  };
}

describe('egress 계정·릴레이 목적지(cloud.ts): 메서드·경로 정확히 일치, origin 고정', () => {
  it('운영 origin은 https://tax.laf-co.com 하나, 경로·메서드는 표대로만', () => {
    assert.deepEqual(cloudRequestCheck('POST', `${CLOUD_ORIGIN}/v1/auth/code`), { route: 'auth.code', kind: 'prod' });
    assert.deepEqual(cloudRequestCheck('DELETE', `${CLOUD_ORIGIN}/v1/mailboxes/${'a'.repeat(43)}`), { route: 'mailboxes.delete', kind: 'prod' });
    assert.deepEqual(cloudRequestCheck('GET', 'http://localhost:8787/v1/device-list'), { route: 'deviceList.get', kind: 'dev' });
    for (const [m, u] of [
      ['GET', `${CLOUD_ORIGIN}/v1/auth/code`], // 메서드
      ['POST', `${CLOUD_ORIGIN}/v1/auth/code/`], // 끝 슬래시
      ['POST', `${CLOUD_ORIGIN}/v1/auth/code?x=1`], // 쿼리
      ['POST', `${CLOUD_ORIGIN}/v1/auth/code#f`],
      ['POST', `${CLOUD_ORIGIN}/v1/x/../auth/code`], // 점 구간
      ['POST', `${CLOUD_ORIGIN}/v1/auth/%63ode`], // 인코딩
      ['POST', `${CLOUD_ORIGIN}//v1/auth/code`],
      ['GET', `${CLOUD_ORIGIN}/v1/me`], // 목록 밖
      ['GET', `${CLOUD_ORIGIN}/internal/v1/devices/x`],
      ['DELETE', `${CLOUD_ORIGIN}/v1/mailboxes/${'a'.repeat(42)}`],
    ]) assert.equal(cloudRequestCheck(m!, u!), 'path', `${m} ${u}`);
    for (const u of ['https://evil.example/v1/auth/code', 'http://tax.laf-co.com/v1/auth/code', 'https://tax.laf-co.com.evil.example/v1/auth/code', 'https://user@tax.laf-co.com/v1/auth/code', 'http://10.0.0.1:8787/v1/auth/code', 'http://localhost/v1/auth/code', 'https://tax.laf-co.com:443/v1/auth/code']) {
      assert.equal(cloudRequestCheck('POST', u), 'origin', u);
    }
  });

  it('WSS는 룸 호스트의 룸 참가·라이브 우편함만, 헤더는 인증·DPoP·우편함 토큰만', () => {
    const room = 'A'.repeat(22);
    assert.deepEqual(cloudSocketCheck(`wss://${CLOUD_WS_HOST}/v1/rooms/${room}`), { route: 'rooms.join', kind: 'prod' });
    assert.deepEqual(cloudSocketCheck(`wss://${CLOUD_WS_HOST}/v1/mailboxes/${'b'.repeat(43)}/live`), { route: 'mailboxes.live', kind: 'prod' });
    assert.deepEqual(cloudSocketCheck(`ws://localhost:8787/v1/rooms/${room}`), { route: 'rooms.join', kind: 'dev' });
    for (const u of [`ws://${CLOUD_WS_HOST}/v1/rooms/${room}`, `wss://tax.laf-co.com/v1/rooms/${room}`, `wss://${CLOUD_WS_HOST}/v1/rooms/${room}?t=1`, `wss://${CLOUD_WS_HOST}/v1/mailboxes/${'b'.repeat(43)}`, `wss://${CLOUD_WS_HOST}/v1/rooms`]) {
      assert.equal(cloudSocketCheck(u), null, u);
    }
    assert.deepEqual(cloudHeaders({ Authorization: 'DPoP x', DPoP: 'y', 'X-Mbx-Write': 'z' }), { authorization: 'DPoP x', dpop: 'y', 'x-mbx-write': 'z' });
    for (const h of [{ cookie: 'a' }, { host: 'x' }, { 'x-forwarded-for': '1.2.3.4' }, { authorization: 'a\r\nx: y' }, { authorization: 'a', Authorization: 'b' }]) assert.equal(cloudHeaders(h), null, JSON.stringify(h));
  });

  it('개발 origin은 cloudDevLocal을 켠 egress만 연다. 운영 경로는 testOrigins로 받아 경로 이름만 감사 기록에 남기고, 리디렉션은 따르지 않는다', async () => {
    const hits: string[] = [];
    const srv = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url} ${req.headers['content-type'] ?? '-'} ${req.headers.cookie ?? '-'}`);
      if (req.url === '/v1/auth/logout') return void res.writeHead(302, { location: 'https://evil.example/' }).end();
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"loginId":"l","expiresInSec":600}');
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    const prod = new Egress({ testOrigins: { cloud: base } });
    await assert.rejects(prod.cloud({ method: 'POST', url: `${base}/v1/auth/code`, body: '{}' }), { code: 'destination_not_allowed' });
    const r = await prod.cloud({ method: 'POST', url: `${CLOUD_ORIGIN}/v1/auth/code`, body: '{"email":"a@b.c"}' });
    assert.deepEqual(r, { status: 200, json: { loginId: 'l', expiresInSec: 600 } });
    await assert.rejects(prod.cloud({ method: 'POST', url: `${CLOUD_ORIGIN}/v1/auth/logout`, body: '{}' }), { code: 'network' }, '302는 따르지 않는다');
    await assert.rejects(prod.cloud({ method: 'POST', url: `${CLOUD_ORIGIN}/v1/auth/code`, body: '{}', headers: { cookie: 'a' } }), { code: 'header_not_allowed' });
    await assert.rejects(prod.cloud({ method: 'POST', url: `${CLOUD_ORIGIN}/v1/auth/code`, body: 'not json' }), { code: 'path_not_allowed' });
    await assert.rejects(prod.cloud({ method: 'GET', url: `${CLOUD_ORIGIN}/v1/device-list`, body: '{}' }), { code: 'path_not_allowed' });
    await assert.rejects(prod.cloud({ method: 'POST', url: `${CLOUD_ORIGIN}/v1/auth/code`, body: JSON.stringify({ x: 'a'.repeat(70_000) }) }), { code: 'path_not_allowed' });
    const tampered = new Egress({ testOrigins: { cloud: base }, env: { NODE_TLS_REJECT_UNAUTHORIZED: '0' } });
    await assert.rejects(tampered.cloud({ method: 'POST', url: `${CLOUD_ORIGIN}/v1/auth/code`, body: '{}' }), { code: 'egress_env_tampered' });
    assert.throws(() => tampered.openCloudSocket(`wss://${CLOUD_WS_HOST}/v1/rooms/${'A'.repeat(22)}`), { code: 'egress_env_tampered' });
    assert.throws(() => prod.openCloudSocket(`ws://127.0.0.1:1/v1/rooms/${'A'.repeat(22)}`), { code: 'destination_not_allowed' });
    assert.deepEqual(prod.audit.map((a) => `${a.dest} ${a.path} ${a.status}`), ['cloud auth.code 200', 'cloud auth.logout error']);
    assert.ok(hits.every((h) => h.endsWith(' -')), '쿠키 등 호출자 헤더는 나가지 않았다');
    srv.close();
  });
});

describe('cloudPorts(개발 스택 모양, 실제 계정·릴레이 서비스)', () => {
  let s: Awaited<ReturnType<typeof stack>>;
  let ports: CloudPorts;
  const egress = new Egress({ cloudDevLocal: true });
  before(async () => {
    s = await stack();
    ports = cloudPorts({ egress, env: 'dev', dev: { accountOrigin: s.origin, relayHost: s.host } });
  });
  after(async () => s.close());

  it('구성: 운영은 고정 origin·룸 호스트, 개발은 localhost만', () => {
    const prod = cloudPorts({ egress: new Egress(), env: 'prod' });
    assert.equal(prod.relayHost, CLOUD_WS_HOST);
    assert.equal(prod.insecureLocal, false);
    assert.equal(ports.insecureLocal, true);
    assert.throws(() => cloudPorts({ egress, env: 'dev', dev: { accountOrigin: 'http://10.0.0.2:8787', relayHost: '10.0.0.2:8787' } }), { code: 'config.cloud_dev' });
    assert.throws(() => cloudPorts({ egress, env: 'prod', dev: { accountOrigin: s.origin, relayHost: s.host } }), { code: 'config.cloud_dev' });
    assert.throws(() => cloudPorts({ egress, env: 'dev' }), { code: 'config.cloud_dev' });
  });

  it('이메일 코드 로그인 → 첫 PC 등록 → 기기 토큰 → acct-claim·기기 목록·룸·우편함, 오류는 서버 코드만', async () => {
    const { account, relay } = ports;
    const email = 'desk@example.com';
    await assert.rejects(account.verifyEmailCode('x'.repeat(43), '000000'), { code: 'account.code_invalid' });
    const start = await account.startEmailCode(email);
    assert.equal(start.expiresInSec, 600);
    await assert.rejects(account.verifyEmailCode(start.loginId, '000000'), (e: Error & { code: string }) => e.code === 'account.code_invalid' && e.message === 'account.code_invalid');
    const { session } = await account.verifyEmailCode(start.loginId, s.mail.lastCode(email)!);
    assert.deepEqual(await account.deviceList(session), { aikPub: null, deviceList: null });

    const sk = x25519Keygen();
    const vd = ed25519Keygen();
    const aik = ed25519Keygen();
    const keys: DesktopKeys = { noise: softNoiseStatic(sk.secretKey), vd: softSigner(vd.secretKey, VD_PURPOSES), aik: softSigner(aik.secretKey, AIK_PURPOSES), kvPublic: () => x25519Keygen().publicKey };
    const deviceId = uuid4();
    const list = await initialDeviceList(keys.aik, { deviceId, role: 'desktop', noisePub: keys.noise.publicKey, signPub: keys.vd.publicKey, registeredAt: Date.now() - 86_400_000 });
    assert.deepEqual(await account.pinFirstDesktop(session, { aikPub: b64(keys.aik.publicKey), deviceList: list, platform: 'macos', name: 'PC' }), { deviceId });
    await assert.rejects(account.pinFirstDesktop(session, { aikPub: b64(keys.aik.publicKey), deviceList: list, platform: 'macos', name: 'PC' }), { code: 'account.aik_already_pinned' });
    assert.equal((await account.deviceList(session)).aikPub, b64(keys.aik.publicKey));

    const cert = await issueCert(keys.aik, { device_id: deviceId, role: 'desktop', Sx: keys.noise.publicKey, Vx: keys.vd.publicKey, not_after: certNotAfter() });
    const tok = await account.deviceToken(cert, keys.vd);
    assert.match(tok.token, /^sxd1\./);
    // 다른 Vx로 증명하면 서버 코드 그대로
    await assert.rejects(account.deviceToken(cert, softSigner(ed25519Keygen().secretKey, VD_PURPOSES)), (e: Error & { code: string }) => /^account\./.test(e.code));
    const auth: DeviceAuth = async (htm, htu) => deviceAuthHeaders(tok.token, keys.vd, htm, htu) as Promise<{ Authorization: string; DPoP: string }>;

    const claim = await account.acctClaim(auth);
    assert.equal(claim.claim.email, email);
    // 폰과 같은 검증: PAIR_OK 필드 = b64(JCS(응답 그대로)), 앱 고정 공개키, AIK 일치
    const v = verifyAcctClaim(b64(jcsBytes(claim)), { accountKeys: [s.acctClaimPub], aikPub: keys.aik.publicKey });
    assert.equal(v.ok, true, JSON.stringify(v));
    await account.putDeviceList(auth, { ...list, listVersion: 1 }).then(
      () => assert.fail('같은 버전은 거부'),
      (e: Error & { code: string }) => assert.equal(e.code, 'account.list_version_stale'),
    );

    const roomId = randomBytes(16);
    const room = await relay.createRoom(auth, roomId);
    assert.ok(room.expiresAt > Date.now());
    // 폰이 붙지 않은 룸으로 대리 등록: 404 relay.room_unavailable(서버 코드)
    const ph = { deviceId: uuid4(), role: 'mobile' as const, platform: 'ios' as const, name: '폰', Sx: b64(x25519Keygen().publicKey), Vx: b64(ed25519Keygen().publicKey), roomId: Buffer.from(roomId).toString('base64url') };
    await assert.rejects(account.enrollPhone(auth, ph), { code: 'relay.room_unavailable' });
    // 룸 WSS: egress 소켓으로 데스크톱이 룸에 들어간다(wsRelayClient)
    const client = wsRelayClient({ host: ports.relayHost, insecureLocal: ports.insecureLocal, open: ports.openSocket });
    const link = await client.joinRoom(roomId, 'desktop');
    link.close();
    assert.throws(() => ports.openSocket(relayUrl(ports.relayHost, '/v1/rooms', true)), { code: 'net.path_not_allowed' });
    assert.ok(relayRoomPath(roomId).length > 0);

    const mbx = randomBytes(32);
    const r = randomBytes(32);
    const w = randomBytes(32);
    await relay.registerMailbox(auth, mbx, r, w);
    await assert.rejects(relay.deleteMailbox(auth, mbx, randomBytes(32)), (e: Error & { code: string }) => /^relay\./.test(e.code) || /^account\./.test(e.code));
    await relay.deleteMailbox(auth, mbx, w);
    await assert.rejects(relay.registerMailbox(auth, mbx.subarray(0, 16), r, w), { code: 'request.param_rejected' });

    await account.logout(session);
    await assert.rejects(account.deviceList(session), { code: 'account.unauthorized' });
    // 송신은 모두 egress 감사 기록에 경로 이름으로만 남고, 이메일·토큰·우편함 ID는 없다
    const audit = JSON.stringify(egress.audit);
    for (const secret of [email, session, tok.token, Buffer.from(mbx).toString('base64url')]) assert.ok(!audit.includes(secret));
    assert.ok(egress.audit.some((a) => a.dest === 'cloud.ws' && a.path === 'rooms.join'));
  });

  it('egress가 cloudDevLocal을 켜지 않았으면 개발 스택에 닿지 않는다(net.destination_not_allowed)', async () => {
    const off = cloudPorts({ egress: new Egress(), env: 'dev', dev: { accountOrigin: s.origin, relayHost: s.host } });
    await assert.rejects(off.account.startEmailCode('a@example.com'), { code: 'net.destination_not_allowed' });
    assert.throws(() => off.openSocket(relayUrl(s.host, relayRoomPath(randomBytes(16)), true)), { code: 'net.destination_not_allowed' });
  });
});
