// 데스크톱 클라우드 포트(apps/desktop/src/remote-cloud.ts)와 egress 계정·릴레이 목적지(@sax/net cloud.ts, 팀장 결정 2026-11-06).
// 실제 계정·릴레이 서비스를 한 앞단 origin(개발 스택과 같은 모양)에 붙여 이메일 코드 로그인 → 첫 PC 등록 → 기기 토큰 → acct-claim·
// 기기 목록·룸·우편함 → 룸 WSS를 egress만으로 지난다. 운영 origin 판정은 허용 목록 함수와 testOrigins로 본다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { CLOUD_ORIGIN, CLOUD_WS_HOST, Egress, cloudHeaders, cloudRequestCheck, cloudSocketCheck } from '@sax/net';
import {
  AIK_PURPOSES,
  VD_PURPOSES,
  b64,
  certNotAfter,
  deviceAuthHeaders,
  ed25519Keygen,
  addDevice,
  initialDeviceList,
  issueCert,
  jcsBytes,
  relayRoomPath,
  relayUrl,
  softNoiseStatic,
  softSigner,
  uuid4,
  verifyAcctClaim,
  verifyDeviceList,
  wsRelayClient,
  x25519Keygen,
  type DesktopKeys,
} from '../packages/remote/src/index.ts';
import { DesktopAccount, RemoteIdentityFile } from '../apps/desktop/src/remote-account.ts';
import { cloudPorts, type CloudPorts, type DeviceAuth } from '../apps/desktop/src/remote-cloud.ts';
import { DeviceManager, type DeviceManagerSession } from '../apps/desktop/src/remote-devices.ts';
import { vaultDesktopKeys, type VaultDesktopKeys } from '../apps/desktop/src/remote-keys.ts';
import { PcLinkHost, PcLinkJoin } from '../apps/desktop/src/remote-pclink.ts';
import { FileEventLog } from '../packages/platform/src/index.ts';
import { CRYPTO_KEY_ITEMS, MemoryKeyStore, VaultCrypto } from '../packages/vault/src/index.ts';
import { CLOUD_ROUTES } from '../packages/net/src/cloud.ts';
import { argon2Available } from '../services/account/src/index.ts';
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
      // 비밀번호 경로(ADR-038): argon2id가 있는 런타임에서만 켠다(없으면 404, 그 시험은 건너뛴다)
      ...(argon2Available() ? { PASSWORD_PEPPER_KEYS: `k1:${hex()}` } : {}),
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
      ['POST', `${CLOUD_ORIGIN}/v1/me`], // 메서드(GET만)
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

describe('계정 화면 경로(#224 비밀번호 로그인이 실제 앱에서 net.path로 거부되던 결함 수정)', () => {
  const ACCOUNT_SCREEN_ROUTES: Array<[string, string, string]> = [
    ['POST', '/v1/auth/password', 'auth.password'],
    ['POST', '/v1/auth/password/reset', 'auth.reset'],
    ['POST', '/v1/auth/password/reset/verify', 'auth.resetVerify'],
    ['POST', '/v1/auth/refresh', 'auth.refresh'],
    ['POST', '/v1/auth/refresh/revoke', 'auth.refreshRevoke'],
    ['POST', '/v1/auth/logout-all', 'auth.logoutAll'],
    ['POST', '/v1/auth/reauth', 'auth.reauth'],
    ['POST', '/v1/auth/reauth/verify', 'auth.reauthVerify'],
    ['GET', '/v1/me', 'me.get'],
    ['PUT', '/v1/password', 'password.put'],
    ['DELETE', '/v1/password', 'password.delete'],
  ];

  it('11개는 메서드·경로 정확히 일치로 열린다(운영·개발 origin)', () => {
    for (const [m, p, name] of ACCOUNT_SCREEN_ROUTES) {
      assert.deepEqual(cloudRequestCheck(m, CLOUD_ORIGIN + p), { route: name, kind: 'prod' }, `${m} ${p}`);
      assert.deepEqual(cloudRequestCheck(m, `http://localhost:8787${p}`), { route: name, kind: 'dev' }, `${m} ${p}`);
    }
    // 경로 정규식은 모두 ^…$ 고정이다(접두·와일드카드 없음). ID 칸이 있는 경로는 길이가 정해진 문자 묶음뿐이다.
    for (const r of CLOUD_ROUTES) assert.ok(r.path.source.startsWith('^') && r.path.source.endsWith('$') && !/\.\*|\.\+|\[\^/.test(r.path.source), r.name);
  });

  it('반대 방향: 목록에 없는 계정 경로·메서드는 여전히 거부(net.path_not_allowed)', async () => {
    const no: Array<[string, string]> = [
      ['GET', '/internal/v1/accounts'],
      ['POST', '/internal/v1/token-verify'],
      ['POST', '/v1/auth'],
      ['POST', '/v1/auth/password/'],
      ['POST', '/v1/auth/password/x'],
      ['POST', '/v1/auth/password/reset/verify/x'],
      ['GET', '/v1/auth/password'],
      ['PUT', '/v1/auth/password'],
      ['POST', '/v1/auth/refresh/'],
      ['POST', '/v1/auth/refresh/revoke/all'],
      ['POST', '/v1/auth/reauth/verify2'],
      ['POST', '/v1/me'],
      ['GET', '/v1/me/x'],
      ['GET', '/v1/password'],
      ['POST', '/v1/password'],
      ['PATCH', '/v1/password'],
      ['POST', '/v1/passkeys/options'], // 패스키는 G7 결정 뒤
      ['POST', '/v1/passkeys'],
      ['POST', '/v1/auth/passkey/options'],
      // 구독은 화면이 부르는 넷만. 웹훅·카드 창(기본 브라우저)·권리 단독 조회는 이 egress로 나가지 않는다
      ['POST', '/v1/billing/webhook'],
      ['GET', '/v1/billing/card'],
      ['GET', '/v1/billing/entitlement'],
      ['POST', '/v1/billing/subscription'],
      ['GET', '/v1/billing/checkout'],
    ];
    for (const [m, p] of no) assert.equal(cloudRequestCheck(m, CLOUD_ORIGIN + p), 'path', `${m} ${p}`);
    const eg = new Egress();
    for (const [m, p] of no.filter(([m]) => m !== 'PATCH')) {
      await assert.rejects(eg.cloud({ method: m as never, url: CLOUD_ORIGIN + p, body: m === 'POST' || m === 'PUT' ? '{}' : undefined }), { code: 'path_not_allowed' }, `${m} ${p}`);
    }
    const ports = cloudPorts({ egress: eg, env: 'prod' });
    await assert.rejects(ports.account.passwordLogin('a@example.com', 'x'.repeat(12)).then(() => null), (e: Error & { code: string }) => e.code !== 'net.path_not_allowed', '비밀번호 로그인은 허용 목록을 지난다(운영 origin, 네트워크 단계에서 실패)');
  });

  it('대조: main 계정·릴레이 클라이언트가 부르는 모든 (메서드, 경로)가 CLOUD_ROUTES에 있다(메서드를 더하면 이 표도 채워야 통과)', async () => {
    const seen: Array<{ method: string; url: string; route: string }> = [];
    const recorder = {
      cloud: async (req: { method: string; url: string }) => {
        const c = cloudRequestCheck(req.method, req.url);
        seen.push({ method: req.method, url: req.url, route: typeof c === 'object' ? c.route : c });
        return { status: 599, json: null };
      },
      openCloudSocket: () => {
        throw new Error('no');
      },
    } as unknown as Egress;
    const ports = cloudPorts({ egress: recorder, env: 'prod' });
    const aik = softSigner(ed25519Keygen().secretKey, AIK_PURPOSES);
    const vd = softSigner(ed25519Keygen().secretKey, VD_PURPOSES);
    const cert = await issueCert(aik, { device_id: uuid4(), role: 'desktop', Sx: x25519Keygen().publicKey, Vx: vd.publicKey, not_after: certNotAfter() });
    const auth: DeviceAuth = async () => ({});
    const rt = `sxa1.${'A'.repeat(43)}`;
    const list = await initialDeviceList(aik, { deviceId: uuid4(), role: 'desktop', noisePub: x25519Keygen().publicKey, signPub: vd.publicKey, registeredAt: Date.now() });
    const args: Record<string, unknown[]> = {
      startEmailCode: ['a@example.com'],
      verifyEmailCode: ['L', '123456', true],
      passwordLogin: ['a@example.com', 'pw-pw-pw-pw-1', true],
      logout: ['sxs1.s'],
      deviceList: ['sxs1.s'],
      pinFirstDesktop: ['sxs1.s', { aikPub: b64(aik.publicKey), deviceList: list, platform: 'windows', name: 'PC' }],
      deviceToken: [cert, vd],
      acctClaim: [auth],
      enrollPhone: [auth, { deviceId: uuid4(), role: 'mobile', platform: 'ios', name: '폰', Sx: 'x', Vx: 'y', roomId: 'r' }],
      putDeviceList: [auth, list],
      devices: [auth],
      leaveDevice: [auth],
      devicesBySession: ['sxs1.s'],
      deviceListByDevice: [auth],
      enrollDesktop: ['sxs1.s', { deviceId: uuid4(), platform: 'macos', name: '새 PC', Sx: 'x', Vx: 'y' }],
      pcLinkHello: ['sxs1.s', uuid4(), { v: 1 }],
      pcLinkAnswer: ['sxs1.s', uuid4()],
      pcLinkReveal: ['sxs1.s', uuid4(), { v: 1, nonce: 'n' }],
      pcLinkCancel: ['sxs1.s', uuid4()],
      pcLinks: [auth],
      pcLinkChallenge: [auth, uuid4(), { v: 1 }],
      pcLinkGrant: [auth, uuid4(), { v: 1 }],
      pcLinkDrop: [auth, uuid4()],
      billing: [auth],
      billingCheckout: [auth],
      billingCancel: [auth],
      billingRefund: [auth],
      accountDeletion: [auth],
      requestAccountDelete: [auth],
      cancelAccountDelete: [auth],
      me: ['sxs1.s'],
      setPassword: ['sxs1.s', 'pw-pw-pw-pw-1'],
      deletePassword: ['sxs1.s'],
      startReauth: ['sxs1.s'],
      verifyReauth: ['sxs1.s', 'R', '123456'],
      startPasswordReset: ['a@example.com'],
      verifyPasswordReset: ['R', '123456', 'pw-pw-pw-pw-1', true],
      refresh: [rt],
      revokeRefresh: [rt],
      logoutAll: ['sxs1.s'],
    };
    const methods = Object.keys(ports.account);
    assert.deepEqual(methods.filter((m) => !(m in args)), [], '새 계정 메서드는 이 대조 표에 넣는다');
    for (const m of methods) {
      const before = seen.length;
      await (ports.account as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]!(...args[m]!).catch(() => {});
      assert.equal(seen.length, before + 1, `${m}는 요청 하나`);
    }
    const relayArgs: Record<string, unknown[]> = { createRoom: [auth, randomBytes(16)], registerMailbox: [auth, randomBytes(32), randomBytes(32), randomBytes(32)], deleteMailbox: [auth, randomBytes(32), randomBytes(32)] };
    assert.deepEqual(Object.keys(ports.relay).filter((m) => !(m in relayArgs)), []);
    for (const m of Object.keys(ports.relay)) await (ports.relay as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[m]!(...relayArgs[m]!).catch(() => {});
    // 연결된 폰 수신(phone-link.ts)이 부르는 큐 경로: 쪽 읽기·ACK·번들 올리기
    const q = ports.mailboxQueue!(randomBytes(32), { read: randomBytes(32), write: randomBytes(32) }, auth);
    const before = seen.length;
    await q.listPage().catch(() => {});
    await q.ack(3).catch(() => {});
    await q.putBundle('b').catch(() => {});
    assert.deepEqual(seen.slice(before).map((x) => [x.method, x.route]), [['GET', 'mailboxes.envelopes'], ['POST', 'mailboxes.ack'], ['PUT', 'mailboxes.bundle']]);
    const bad = seen.filter((x) => x.route === 'path' || x.route === 'origin');
    assert.deepEqual(bad, [], '허용 목록 밖으로 나가는 호출');
    for (const [m, p, name] of ACCOUNT_SCREEN_ROUTES) assert.ok(seen.some((x) => x.method === m && x.url === CLOUD_ORIGIN + p && x.route === name), `${m} ${p}를 부르는 메서드가 있다`);
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
    const auth: DeviceAuth = async (htm, htu) => deviceAuthHeaders(tok.token, keys.vd, htm, htu);

    const claim = await account.acctClaim(auth);
    // 데스크톱 헤더도 egress 허용 목록을 지난다(쿠키 등은 보내지 않는다)
    await assert.rejects(account.acctClaim(async (htm, htu) => ({ ...(await auth(htm, htu)), cookie: 'x' })), { code: 'net.header_not_allowed' });
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

  it('기기 관리(remote-devices.ts, ADR-048 결정 6): 폰 끊기는 AIK 폐기로 바로, 스스로 나간 폰은 목록을 맞춘 뒤 새 폰을 받는다, 마지막 PC는 나가지 못한다', async () => {
    const { account } = ports;
    const email = 'devices@example.com';
    const start = await account.startEmailCode(email);
    const { session } = await account.verifyEmailCode(start.loginId, s.mail.lastCode(email)!);
    const keys = { noise: softNoiseStatic(x25519Keygen().secretKey), vd: softSigner(ed25519Keygen().secretKey, VD_PURPOSES), aik: softSigner(ed25519Keygen().secretKey, AIK_PURPOSES) };
    const pcId = uuid4();
    let list = await initialDeviceList(keys.aik, { deviceId: pcId, role: 'desktop', noisePub: keys.noise.publicKey, signPub: keys.vd.publicKey, registeredAt: Date.now() });
    await account.pinFirstDesktop(session, { aikPub: b64(keys.aik.publicKey), deviceList: list, platform: 'macos', name: '사무실 PC' });
    const tok = await account.deviceToken(await issueCert(keys.aik, { device_id: pcId, role: 'desktop', Sx: keys.noise.publicKey, Vx: keys.vd.publicKey, not_after: certNotAfter() }), keys.vd);
    const auth: DeviceAuth = async (htm, htu) => deviceAuthHeaders(tok.token, keys.vd, htm, htu);
    // 폰: 계정 세션으로 신청하고 PC가 AIK 목록에 올려 활성으로 만든다
    const phone = async (name: string) => {
      const p = { id: uuid4(), noise: x25519Keygen(), vd: softSigner(ed25519Keygen().secretKey, VD_PURPOSES) };
      const r = await fetch(`${s.origin}/v1/devices/enroll`, { method: 'POST', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: p.id, role: 'mobile', platform: 'ios', name, Sx: b64(p.noise.publicKey), Vx: b64(p.vd.publicKey) }) });
      assert.equal(r.status, 201);
      list = await addDevice(keys.aik, list, { deviceId: p.id, role: 'mobile', noisePub: p.noise.publicKey, signPub: p.vd.publicKey, registeredAt: Date.now() });
      await account.putDeviceList(auth, list);
      return p;
    };
    const p1 = await phone('폰 하나');
    const p2 = await phone('폰 둘');
    const dropped: string[] = [];
    const session2: DeviceManagerSession = {
      deviceId: pcId,
      get deviceList() {
        return list;
      },
      auth,
      clearToken: () => {},
      setDeviceList: async (l) => void (list = l),
    };
    const mgr = new DeviceManager({ client: account, session: () => session2, aik: async () => keys.aik, dropPhone: async (id) => void dropped.push(id) });

    const all = await mgr.list();
    assert.deepEqual(all.map((d) => [d.name, d.role, d.state, d.self, d.listed]), [['사무실 PC', 'desktop', 'active', true, true], ['폰 하나', 'mobile', 'active', false, true], ['폰 둘', 'mobile', 'active', false, true]]);
    assert.ok(!JSON.stringify(all).includes(b64(p1.vd.publicKey)), '키는 렌더러로 가지 않는다');

    // 폰 끊기: 목록에서 빠지고 폐기 레코드가 생기며, 서버는 그 폰의 토큰을 바로 주지 않는다
    const after = await mgr.unlink(p1.id);
    assert.deepEqual(after.map((d) => d.name), ['사무실 PC', '폰 둘']);
    assert.deepEqual(dropped, [p1.id]);
    assert.deepEqual(list.revoked.map((r) => r.device_id), [p1.id]);
    assert.ok(verifyDeviceList(list, keys.aik.publicKey).ok);
    const c1 = await issueCert(keys.aik, { device_id: p1.id, role: 'mobile', Sx: p1.noise.publicKey, Vx: p1.vd.publicKey, not_after: certNotAfter() });
    await assert.rejects(account.deviceToken(c1, p1.vd), (e: Error & { code: string }) => /^account\./.test(e.code));
    // 이미 끊긴 기기를 다시 눌러도 그대로다. 자기 자신은 leave로만
    assert.deepEqual((await mgr.unlink(p1.id)).map((d) => d.name), ['사무실 PC', '폰 둘']);
    await assert.rejects(mgr.unlink(pcId), { code: 'account.use_leave' });

    // 폰이 스스로 나감(폰 기기 토큰, devices 범위): 서버는 바로 폐기하지만 AIK 목록에는 아직 남아 있다
    const c2 = await issueCert(keys.aik, { device_id: p2.id, role: 'mobile', Sx: p2.noise.publicKey, Vx: p2.vd.publicKey, not_after: certNotAfter() });
    const t2 = await account.deviceToken(c2, p2.vd);
    assert.ok(t2.scopes.includes('devices'));
    const leaveUrl = `${s.origin}/v1/devices/self/leave`;
    assert.equal((await fetch(leaveUrl, { method: 'POST', headers: await deviceAuthHeaders(t2.token, p2.vd, 'POST', leaveUrl) })).status, 204);
    assert.ok(list.entries.some((e) => e.entry.device_id === p2.id));
    // 맞추기 전에는 새 목록(새 폰 올리기)을 서버가 받지 않는다
    const stale = list;
    assert.equal(await mgr.reconcile(), 1);
    assert.ok(!list.entries.some((e) => e.entry.device_id === p2.id));
    assert.deepEqual(list.revoked.map((r) => r.device_id), [p1.id, p2.id]);
    assert.ok(dropped.includes(p2.id), '스스로 나간 폰의 연결 기록도 지운다');
    assert.equal(await mgr.reconcile(), 0);
    assert.ok(stale.listVersion < list.listVersion);
    const p3 = await phone('새 폰');
    assert.deepEqual((await mgr.list()).map((d) => d.name), ['사무실 PC', '새 폰']);
    assert.ok(p3.id);

    // 계정에 남은 마지막 PC는 나갈 수 없다(로그아웃만)
    await assert.rejects(mgr.leave(), { code: 'account.last_desktop' });
    assert.equal((await mgr.list()).find((d) => d.self)?.state, 'active');
  });

  it('새 PC 연결(ADR-048 결정 3): 로그인한 새 PC가 신청하고, 쓰던 PC가 6자리로 승인하면 금고가 계정 열쇠를 넘겨받아 같은 AIK로 붙는다', async () => {
    const { account } = ports;
    const email = 'pclink@example.com';
    const dirs: string[] = [];
    // PC 한 대: 금고(장기 키 연산) + 계정 로그인 + 기기 관리 + 새 PC 승인. 금고는 control 포트 대신 VaultCrypto를 바로 부른다
    const pc = async (name: string) => {
      const ks = new MemoryKeyStore();
      const vlog = new FileEventLog(null, 'vault');
      const c = new VaultCrypto({ keyStore: ks, log: vlog });
      const control = async (m: string, p?: Record<string, unknown>): Promise<unknown> => {
        if (m === 'crypto.publicKeys') return c.publicKeys();
        if (m === 'crypto.noiseDH') return { shared: await c.noiseDH(p) };
        if (m === 'crypto.signVd') return { sig: await c.signVd(p) };
        if (m === 'crypto.signAik') return { sig: await c.signAik(p) };
        if (m === 'crypto.hpkeOpen') return { pt: await c.hpkeOpen(p) };
        if (m === 'crypto.linkKey') return { pub: await c.linkKey() };
        if (m === 'crypto.rkSeal') return c.rkSeal(p);
        if (m === 'crypto.rkImport') return { aik: await c.rkImport(p) };
        throw new Error(`vault: ${m}`);
      };
      let kp: Promise<VaultDesktopKeys> | null = null;
      const keys = () => (kp ??= vaultDesktopKeys(control));
      const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-pclink-'));
      dirs.push(dir);
      const events: string[] = [];
      const acct = new DesktopAccount({
        client: account,
        keys,
        identity: new RemoteIdentityFile(dir),
        platform: 'macos',
        deviceName: name,
        linkVault: async () => (await keys()).link,
        resetKeys: () => void (kp = null),
        log: (n, d) => void events.push(`${n}:${String(d.result ?? '')}`),
      });
      await acct.init();
      const login = async () => {
        await acct.sendCode(email);
        return acct.verify(s.mail.lastCode(email)!);
      };
      const mgr = () => new DeviceManager({ client: account, session: () => acct.device(), aik: async () => (await keys()).aik, dropPhone: async () => {} });
      return { acct, keys, ks, vlog, events, login, mgr, dir };
    };
    try {
      const a = await pc('사무실 PC');
      assert.equal((await a.login()).step, 'signed_in');
      const aMgr = a.mgr();
      const host = new PcLinkHost({ client: account, exclusive: (f) => aMgr.exclusive(f), aik: async () => (await a.keys()).aik, vault: async () => (await a.keys()).link });
      assert.deepEqual(await host.list(), []);

      // 새 PC가 같은 계정으로 로그인하면 연결을 기다린다(전에는 account.aik_already_pinned로 끝났다)
      const b = await pc('집 PC');
      const bAikBefore = b64((await b.keys()).aik.publicKey);
      const v1 = await b.login();
      assert.deepEqual([v1.step, v1.email, v1.linkCode], ['link_wait', email, undefined]);
      assert.equal(await b.acct.linkPoll(), false, '쓰던 PC가 답하기 전');
      await assert.rejects(b.acct.sendCode(email), /account_linking/);

      // 쓰던 PC: 신청이 보이고, [연결]을 누르면 새 PC에 6자리가 뜬다
      const [req] = await host.list();
      assert.deepEqual([req!.name, req!.platform, req!.stage, req!.triesLeft], ['집 PC', 'macos', 'new', null]);
      assert.ok(!JSON.stringify(req).includes('commit'), '키·약속은 렌더러로 가지 않는다');
      assert.equal((await host.begin(req!.deviceId))[0]!.stage, 'wait');
      await assert.rejects(host.begin(req!.deviceId), { code: 'account.link_state' });
      assert.equal(await b.acct.linkPoll(), true);
      const v2 = b.acct.view();
      assert.equal(v2.step, 'link_code');
      assert.match(v2.linkCode!, /^\d{6}$/);
      await assert.rejects(b.acct.linkAccept(), /account_no_link/, '열쇠가 오기 전에는 받지 못한다');
      assert.equal(b.acct.view().step, 'link_code');
      const code = v2.linkCode!;
      assert.deepEqual((await host.list()).map((x) => [x.stage, x.triesLeft]), [['code', 3]]);

      // 틀린 6자리는 횟수만 줄고, 맞으면 목록에 새 PC가 올라가고 쓰던 PC에 "연결됐어요"가 남는다
      const wrong = code === '000000' ? '000001' : '000000';
      const bad = await host.confirm(req!.deviceId, wrong);
      assert.deepEqual([bad.ok, bad.requests[0]!.triesLeft], [false, 2]);
      assert.equal(await b.acct.linkPoll(), false);
      const good = await host.confirm(req!.deviceId, code);
      assert.deepEqual([good.ok, good.requests.map((x) => x.stage)], [true, ['done']]);
      assert.ok(a.vlog.lines.some((l) => l.includes('vault.rk_sealed')));
      assert.equal(a.acct.identity!.deviceList.entries.filter((e) => e.entry.role === 'desktop').length, 2);

      // 새 PC: 열쇠가 왔다. 사용자가 확인한 뒤에만 금고에 넣는다
      assert.equal(await b.acct.linkPoll(), true);
      assert.equal(b.acct.view().step, 'link_confirm');
      assert.equal(b64((await b.keys()).aik.publicKey), bAikBefore, '확인 전에는 금고가 그대로다');
      const done = await b.acct.linkAccept();
      assert.deepEqual([done.step, done.email, done.linkCode], ['signed_in', email, undefined]);
      assert.equal(b.acct.identity!.aikPub, a.acct.identity!.aikPub);
      assert.equal(b64((await b.keys()).aik.publicKey), a.acct.identity!.aikPub, '새 PC 금고의 AIK = 계정 AIK');
      assert.ok(b.vlog.lines.some((l) => l.includes('vault.rk_imported')));
      assert.ok(b.events.includes('main.account_link:ok'));
      // 계정 열쇠는 로그·신원 파일에 없다
      const rk = Buffer.from((await b.ks.get(CRYPTO_KEY_ITEMS.rk, 32))!);
      const idFile = await fs.readFile(path.join(b.dir, 'remote-identity.json'), 'utf8');
      for (const text of [idFile, ...a.vlog.lines, ...b.vlog.lines, ...a.events, ...b.events]) assert.ok(!text.includes(rk.toString('base64')) && !text.includes(rk.toString('hex')) && !text.includes(code));
      // 우편함은 비었고, 앱을 다시 켜도 신원이 맞다
      assert.deepEqual((await host.list()).map((x) => x.stage), ['done']);
      const again = new DesktopAccount({ client: account, keys: b.keys, identity: new RemoteIdentityFile(b.dir), platform: 'macos', deviceName: '집 PC' });
      assert.equal((await again.init()).step, 'signed_in');

      // 두 PC 모두 기기 토큰으로 같은 목록을 보고, 한 PC가 바꾼 목록을 다른 PC가 받아들인다
      const bMgr = b.mgr();
      assert.deepEqual((await bMgr.list()).map((d) => [d.name, d.state, d.self, d.listed]), [['사무실 PC', 'active', false, true], ['집 PC', 'active', true, true]]);
      const start = await account.startEmailCode(email);
      const { session } = await account.verifyEmailCode(start.loginId, s.mail.lastCode(email)!);
      const ph = { id: uuid4(), noise: x25519Keygen(), vd: softSigner(ed25519Keygen().secretKey, VD_PURPOSES) };
      const r = await fetch(`${s.origin}/v1/devices/enroll`, { method: 'POST', headers: { authorization: `Bearer ${session}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: ph.id, role: 'mobile', platform: 'ios', name: '폰', Sx: b64(ph.noise.publicKey), Vx: b64(ph.vd.publicKey) }) });
      assert.equal(r.status, 201);
      const bDev = b.acct.device()!;
      const withPhone = await addDevice((await b.keys()).aik, bDev.deviceList, { deviceId: ph.id, role: 'mobile', noisePub: ph.noise.publicKey, signPub: ph.vd.publicKey, registeredAt: Date.now() });
      await account.putDeviceList(bDev.auth, withPhone);
      await bDev.setDeviceList(withPhone);
      const before = a.acct.identity!.deviceList.listVersion;
      assert.deepEqual((await aMgr.list()).map((d) => [d.name, d.listed]), [['사무실 PC', true], ['집 PC', true], ['폰', true]]);
      assert.equal(a.acct.identity!.deviceList.listVersion, before + 1, '쓰던 PC가 새 PC가 올린 목록을 받아들였다');
      // 쓰던 PC가 폰을 끊으면(최신 목록 위에서) 새 PC도 다음에 그 목록을 받는다
      await aMgr.unlink(ph.id);
      assert.deepEqual((await bMgr.list()).map((d) => d.name), ['사무실 PC', '집 PC']);
      assert.deepEqual(b.acct.identity!.deviceList.revoked.map((x) => x.device_id), [ph.id]);

      // 세 번째 PC: 쓰던 PC가 거절하면 로그인 화면으로 돌아가고 자리가 빈다. 새 PC가 승인해도 된다(모든 PC가 같은 열쇠)
      const c3 = await pc('매장 PC');
      assert.equal((await c3.login()).step, 'link_wait');
      const cReq = (await host.list()).find((x) => x.stage === 'new')!;
      assert.equal(cReq.name, '매장 PC');
      await host.reject(cReq.deviceId);
      assert.equal(await c3.acct.linkPoll(), true);
      assert.deepEqual([c3.acct.view().step, c3.acct.view().error], ['signed_out', 'account.link_rejected']);
      assert.equal((await aMgr.list()).length, 2);
      assert.equal((await c3.login()).step, 'link_wait');
      const host2 = new PcLinkHost({ client: account, exclusive: (f) => bMgr.exclusive(f), aik: async () => (await b.keys()).aik, vault: async () => (await b.keys()).link });
      const c2 = (await host2.list())[0]!;
      await host2.begin(c2.deviceId);
      assert.deepEqual((await host.list()).filter((x) => x.deviceId === c2.deviceId).map((x) => x.stage), ['other'], '다른 PC가 먼저 답한 신청');
      await c3.acct.linkPoll();
      assert.equal((await host2.confirm(c2.deviceId, c3.acct.view().linkCode!)).ok, true);
      await c3.acct.linkPoll();
      assert.equal((await c3.acct.linkAccept()).step, 'signed_in');
      assert.equal(c3.acct.identity!.aikPub, a.acct.identity!.aikPub);
      assert.deepEqual((await aMgr.list()).map((d) => d.name), ['사무실 PC', '집 PC', '매장 PC']);

      // 네 번째 PC는 한도에 걸린다(PC 3대). 로그인 코드 한도(이메일당 5회/시) 때문에 앞에서 받은 세션으로 신청만 해 본다
      const d4 = await pc('네 번째');
      await assert.rejects(PcLinkJoin.start({ client: account, session, aikPub: a.acct.identity!.aikPub, keys: await d4.keys(), vault: (await d4.keys()).link, platform: 'windows', name: '네 번째' }), { code: 'account.device_limit' });
    } finally {
      for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
    }
  });

  it('계정 화면 경로 전부를 제품 Egress로(실제 계정 서비스): 만들기·로그인·갱신 회전·재인증·바꾸기·지우기·재설정·모든 기기 로그아웃', { skip: !argon2Available() && 'argon2id 없음' }, async () => {
    const { account } = ports;
    const email = 'pw-desk@example.com';
    const mailCode = (kind: string) => [...s.mail.outbox].reverse().find((m) => m.to === email && m.kind === kind)?.code ?? '';
    const start = await account.startEmailCode(email);
    const first = await account.verifyEmailCode(start.loginId, s.mail.lastCode(email)!);
    assert.equal(first.refreshToken, undefined, 'remember 없으면 갱신 토큰 없음');
    const me0 = await account.me(first.session);
    assert.equal(me0.email, email);
    assert.equal(me0.hasPassword, false);
    assert.ok(typeof me0.reauthUntil === 'number' && me0.reauthUntil > Date.now(), '방금 코드로 들어온 세션은 최근 인증');
    await assert.rejects(account.setPassword(first.session, 'short'), { code: 'account.password_too_short' });
    await assert.rejects(account.setPassword(first.session, 'pw-desk-sovereign-1'), { code: 'account.password_contains_identity' });
    assert.deepEqual(await account.setPassword(first.session, 'mangwon-kimchi-12'), {}, '만들기는 204');
    assert.equal((await account.me(first.session)).hasPassword, true);
    await assert.rejects(account.passwordLogin(email, 'not-the-password-1'), { code: 'account.credentials_invalid' });
    const pw = await account.passwordLogin(email, 'mangwon-kimchi-12', true);
    assert.match(pw.refreshToken ?? '', /^sxa1\./);
    const r1 = await account.refresh(pw.refreshToken!);
    assert.notEqual(r1.refreshToken, pw.refreshToken, '회전');
    assert.equal((await account.me(r1.session)).reauthUntil, null, '갱신 세션은 최근 인증이 아니다');
    await assert.rejects(account.deletePassword(r1.session), { code: 'account.reauth_required' });
    const ra = await account.startReauth(r1.session);
    await assert.rejects(account.verifyReauth(r1.session, ra.reauthId, '000000'), { code: 'account.code_invalid' });
    const v = await account.verifyReauth(r1.session, ra.reauthId, mailCode('reauth_code'));
    assert.equal(v.reauthMaxAgeSec, 600);
    await assert.rejects(account.setPassword(r1.session, 'jangdok-gimbap-77', 'wrong-current-1'), { code: 'account.current_password_invalid' });
    const changed = await account.setPassword(r1.session, 'jangdok-gimbap-77', 'mangwon-kimchi-12');
    assert.match(changed.refreshToken ?? '', /^sxa1\./, '바꾸기는 이 기기용 새 갱신 토큰');
    await assert.rejects(account.refresh(r1.refreshToken), { code: 'account.unauthorized' }, '바꾸면 옛 계보 폐기');
    await account.revokeRefresh(changed.refreshToken!);
    await assert.rejects(account.refresh(changed.refreshToken!), { code: 'account.unauthorized' });
    await account.deletePassword(r1.session);
    assert.equal((await account.me(r1.session)).hasPassword, false);
    await assert.rejects(account.me(first.session), { code: 'account.unauthorized' }, '바꾸면 이 세션 뺀 세션 폐기');
    await account.setPassword(r1.session, 'mangwon-kimchi-12');
    const reset = await account.startPasswordReset(email);
    const same = await account.startPasswordReset('nobody@example.com');
    assert.equal(typeof same.resetId, 'string', '없는 계정도 같은 응답');
    const after = await account.verifyPasswordReset(reset.resetId, mailCode('reset_code'), 'gwangjang-bindae-3', true);
    assert.match(after.refreshToken ?? '', /^sxa1\./);
    await assert.rejects(account.me(r1.session), { code: 'account.unauthorized' }, '재설정하면 다른 세션 폐기');
    await account.logoutAll(after.session);
    await assert.rejects(account.me(after.session), { code: 'account.unauthorized' });
    await assert.rejects(account.refresh(after.refreshToken!), { code: 'account.unauthorized' });
    // 모두 운영 허용 목록 이름으로 egress 감사 기록에 남고, 비밀번호·토큰·이메일은 없다
    const names = new Set(egress.audit.map((a) => a.path));
    for (const n of ['auth.password', 'me.get', 'password.put', 'password.delete', 'auth.refresh', 'auth.refreshRevoke', 'auth.reauth', 'auth.reauthVerify', 'auth.reset', 'auth.resetVerify', 'auth.logoutAll']) assert.ok(names.has(n), n);
    const audit = JSON.stringify(egress.audit);
    for (const secret of [email, 'mangwon-kimchi-12', 'jangdok-gimbap-77', pw.refreshToken!, first.session]) assert.ok(!audit.includes(secret));
  });

  it('egress가 cloudDevLocal을 켜지 않았으면 개발 스택에 닿지 않는다(net.destination_not_allowed)', async () => {
    const off = cloudPorts({ egress: new Egress(), env: 'dev', dev: { accountOrigin: s.origin, relayHost: s.host } });
    await assert.rejects(off.account.startEmailCode('a@example.com'), { code: 'net.destination_not_allowed' });
    assert.throws(() => off.openSocket(relayUrl(s.host, relayRoomPath(randomBytes(16)), true)), { code: 'net.destination_not_allowed' });
  });
});
