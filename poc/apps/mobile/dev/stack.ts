// 실제 계정·릴레이 서비스(services/account·relay, #63) 위의 통합 시험 스택. 시뮬레이터 앱은 바꾸지 않는다.
//   node --conditions=development dev/stack.ts   → http://localhost:8787 (운영처럼 계정·릴레이가 한 공개 origin, 팀장 결정 2026-11-05)
//   STACK_LIVE=0 이면 PC가 라이브 우편함에 붙지 않는다(Phase 1처럼 큐만).
//   앞단 8787: /v1/mailboxes·/v1/rooms(WSS 포함) → 릴레이(127.0.0.1:8783), 나머지 /v1/* → 계정(127.0.0.1:8780), /dev/* → 더미 PC
//   더미 PC: 계정 로그인(모의 메일 코드) → AIK 고정 → 기기 토큰 → POST /v1/rooms → 페어링 → 폰 등록 대역 + PUT /v1/device-list
//            → POST /v1/mailboxes → 번들 PUT → 큐 드레인(GET → 개봉 → ack) + 라이브 우편함.
// 비밀은 기동마다 새로 만들고 출력하지 않는다. 로그에 금액·사진·토큰을 넣지 않는다. DB는 dev/out/stack-*.db(git 제외).
// 대역(실제와 다른 것): 폰 기기 등록(POST /v1/devices/enroll)은 폰 계정 로그인이 아직 없어 더미 PC가 같은 계정 세션으로 대신 한다.
//   /dev/account(폰이 페어링 3단계에 받는 AIK·기기 목록)도 같은 이유로 PC 세션의 GET /v1/device-list를 그대로 준다.
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { WebSocket as WS } from 'ws';
import {
  AIK_PURPOSES, CAP, DesktopPairing, DeviceTokenCache, ReceiveQueue, VD_PURPOSES, acceptDesktopSession, b64, b64url, certNotAfter, deviceAuthHeaders,
  drainQueue, ed25519Keygen, hpkeOpen, initialDeviceList, issueCert, makeQBundle, qbundleWindow, relayQueue, requestDeviceToken, softNoiseStatic, softSigner,
  uuid4, wsRelayClient, x25519Keygen, type DesktopKeys, type DeviceListJson, type HttpJson, type Link, type PairRecord, type WebSocketLike,
} from '../../../packages/remote/src/index.ts';
import { MockMailSender } from '../../../services/account/src/adapters.ts';
import { startAccount } from '../../../services/account/src/main.ts';
import { startRelay } from '../../../services/relay/src/main.ts';
import { ed25519Private, ed25519RawPublic } from '../../../services/shared/src/index.ts';

const FRONT = 8787;
const ACCT = 8780;
const RELAY = 8783;
const ORIGIN = `http://localhost:${FRONT}`;
const HOST = `localhost:${FRONT}`;
const OUT = join(import.meta.dirname, 'out');
mkdirSync(join(OUT, 'received'), { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hex = () => randomBytes(32).toString('hex');

// ---- 서비스 기동(비밀은 매번 새로) ----
for (const f of ['stack-account.db', 'stack-relay.db']) rmSync(join(OUT, f), { force: true });
const tokenSeed = hex();
const internal = randomBytes(32).toString('base64url');
const mail = new MockMailSender();
const account = await startAccount(
  {
    SAX_SQLITE_FILE: join(OUT, 'stack-account.db'), TOKEN_SIGNING_SEED: tokenSeed, CODE_MAC_KEY: hex(), ACCOUNT_PUBLIC_ORIGIN: ORIGIN, WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGINS: ORIGIN, BILLING_RETURN_URL: `${ORIGIN}/done`, PG_PROVIDER: 'mock', MAIL_PROVIDER: 'mock', INTERNAL_TOKEN: internal,
    STOP_HOOK_URLS: `http://127.0.0.1:${RELAY}`, PORT: String(ACCT), HOST: '127.0.0.1',
  },
  { mail },
);
const relaySvc = await startRelay({
  SAX_SQLITE_FILE: join(OUT, 'stack-relay.db'), QUEUE_KEY: hex(), RELAY_PUBLIC_ORIGIN: ORIGIN,
  TOKEN_PUBLIC_KEYS: `k1:${ed25519RawPublic(ed25519Private(Buffer.from(tokenSeed, 'hex'))).toString('base64')}`,
  ACCOUNT_INTERNAL_URL: `http://127.0.0.1:${ACCT}`, INTERNAL_TOKEN: internal, PORT: String(RELAY), HOST: '127.0.0.1',
});
log(`account ${account.url} · relay ${relaySvc.url}`);

// ---- HTTP 도우미 ----
const fetchJson: HttpJson = async (r) => {
  const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
  const t = await res.text();
  let body: unknown;
  try {
    body = t ? JSON.parse(t) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
};
async function call(method: string, path: string, o: { headers?: Record<string, string>; body?: unknown } = {}) {
  const r = await fetchJson({ method, url: ORIGIN + path, headers: { ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers }, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
  return r;
}
function expect(r: { status: number; body: unknown }, ok: number, what: string) {
  if (r.status !== ok) throw new Error(`${what}: ${r.status} ${JSON.stringify(r.body)}`);
  log(`${what} ${r.status}`);
  return r.body as Record<string, unknown>;
}

// ---- 앞단: 한 공개 origin ----
const isRelay = (p: string) => p.startsWith('/v1/mailboxes') || p.startsWith('/v1/rooms') || p.startsWith('/internal/');
const front = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const send = (code: number, body: string, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  if (path.startsWith('/dev/')) {
    try {
      if (req.method === 'GET' && path === '/dev/account') {
        const r = expect(await call('GET', '/v1/device-list', { headers: bearer }), 200, 'GET /v1/device-list (대역 /dev/account)');
        return send(200, JSON.stringify({ aikPub: r.aikPub, deviceList: r.deviceList }));
      }
      if (req.method === 'GET' && path === '/dev/qr') return send(200, await startPairing(), 'text/plain');
      if (req.method === 'GET' && path === '/dev/status') return send(200, JSON.stringify({ pairing: pairing?.state ?? 'idle', received }));
      if (req.method === 'POST' && path === '/dev/sas') {
        let body = '';
        for await (const c of req) body += c;
        if (!pairing || pairing.state !== 'awaiting_sas') return send(409, JSON.stringify({ ok: false, state: pairing?.state }));
        const r = await pairing.submitSas(String((JSON.parse(body) as { code?: string }).code ?? ''));
        if (!r.ok) return send(200, JSON.stringify(r));
        const rec: PairRecord = { pairId: r.result.pairId, phoneStatic: r.result.phone.Sm, revoked: false, ikTsMax: 0 };
        r.result.channel.close();
        log('paired', rec.pairId, r.result.phone.platform);
        void serve(rec, r.result.mbxId, { read: r.result.tokRead, write: r.result.tokWrite }, r.result.phone.Vm, r.result.mbxEpoch);
        return send(200, JSON.stringify({ ok: true }));
      }
      return send(404, '{}');
    } catch (e) {
      log('dev error', (e as Error).message);
      return send(500, '{}');
    }
  }
  if (path.startsWith('/internal/')) return send(404, '{"error":"request.not_found"}');
  const up = request({ host: '127.0.0.1', port: isRelay(path) ? RELAY : ACCT, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
    if (!path.startsWith('/dev')) log(`→ ${req.method} ${path.replace(/\/v1\/mailboxes\/[^/]+/, '/v1/mailboxes/:id')} ${r.statusCode}`);
  });
  up.on('error', () => send(502, '{}'));
  req.pipe(up);
});
front.on('upgrade', (req: IncomingMessage, sock, head) => {
  const up = connect(RELAY, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  const path = new URL(req.url ?? '/', 'http://x').pathname.replace(/\/v1\/(mailboxes|rooms)\/[^/]+/, '/v1/$1/:id');
  log(`→ WSS ${path}`);
  up.on('error', () => sock.destroy());
  sock.on('error', () => up.destroy());
});
await new Promise<void>((r) => front.listen(FRONT, r));
log(`stack front on ${ORIGIN} (account + relay + dummy PC)`);

// ---- 더미 PC: 계정 로그인 → AIK 고정 → 기기 토큰 ----
const s = x25519Keygen();
const vd = ed25519Keygen();
const aik = ed25519Keygen();
const kv = x25519Keygen();
const keys: DesktopKeys = { noise: softNoiseStatic(s.secretKey), vd: softSigner(vd.secretKey, VD_PURPOSES), aik: softSigner(aik.secretKey, AIK_PURPOSES), kvPublic: () => kv.publicKey };
const deviceId = uuid4();
const email = 'owner@example.test';
const code = expect(await call('POST', '/v1/auth/code', { body: { email } }), 200, 'POST /v1/auth/code');
const session = expect(await call('POST', '/v1/auth/code/verify', { body: { loginId: code.loginId, code: mail.lastCode(email) } }), 200, 'POST /v1/auth/code/verify').session as string;
const bearer = { authorization: `Bearer ${session}` };
let deviceList: DeviceListJson = await initialDeviceList(keys.aik, { deviceId, role: 'desktop', noisePub: keys.noise.publicKey, signPub: keys.vd.publicKey, registeredAt: Date.now() - 30 * 86_400_000 });
expect(await call('POST', '/v1/aik', { headers: bearer, body: { aikPub: b64(keys.aik.publicKey), deviceList, platform: 'macos', name: 'dummy PC' } }), 201, 'POST /v1/aik');
const deskCert = await issueCert(keys.aik, { device_id: deviceId, role: 'desktop', Sx: keys.noise.publicKey, Vx: keys.vd.publicKey, not_after: certNotAfter() });
const tokens = new DeviceTokenCache(() => requestDeviceToken(fetchJson, ORIGIN, deskCert, keys.vd));
await tokens.token();
log('desktop device token ok');
const dauth = async (htm: string, htu: string) => deviceAuthHeaders(await tokens.token(), keys.vd, htm, htu);
const client = wsRelayClient({ host: HOST, insecureLocal: true, open: (url, headers) => new WS(url, { headers }) as unknown as WebSocketLike, deviceAuth: dauth });

let pairing: DesktopPairing | null = null;
let qr: string | null = null;
const received = { receipts: 0, cash: 0, viaQueue: 0, acked: 0, dropped: 0 };
const stored = new Set<string>();

async function startPairing(): Promise<string> {
  if (pairing && qr && pairing.state === 'waiting_phone' && !pairing.expired) return qr;
  pairing?.cancel();
  const p = new DesktopPairing({
    keys, deviceList, relayHost: HOST,
    // 대역: 폰 등록은 publishDeviceList에서 같은 계정 세션으로 한다(폰 계정 로그인 없음)
    isPhoneKeyRegistered: async () => true,
    publishDeviceList: async (l) => {
      const added = l.entries.map((x) => x.entry).filter((e) => !deviceList.entries.some((y) => y.entry.device_id === e.device_id));
      for (const e of added) {
        expect(await call('POST', '/v1/devices/enroll', { headers: bearer, body: { deviceId: e.device_id, role: e.role, platform: 'ios', name: '폰', Sx: e.Sx, Vx: e.Vx } }), 201, 'POST /v1/devices/enroll (대역)');
      }
      expect(await call('PUT', '/v1/device-list', { headers: await dauth('PUT', `${ORIGIN}/v1/device-list`), body: { deviceList: l } }), 200, 'PUT /v1/device-list');
      deviceList = l;
    },
    registerMailbox: async (id, r, w) => {
      expect(await call('POST', '/v1/mailboxes', { headers: await dauth('POST', `${ORIGIN}/v1/mailboxes`), body: { mbxId: b64url(id), tokRead: b64url(r), tokWrite: b64url(w) } }), 201, 'POST /v1/mailboxes');
    },
  });
  pairing = p;
  const o = p.offer();
  qr = o.qr;
  p.onState((st) => log('pairing:', st));
  expect(await call('POST', '/v1/rooms', { headers: await dauth('POST', `${ORIGIN}/v1/rooms`), body: { roomId: b64url(p.roomId) } }), 201, 'POST /v1/rooms');
  const link = await client.joinRoom(p.roomId, 'desktop');
  void p.run(link);
  return o.qr;
}

function receiver(): ReceiveQueue {
  return new ReceiveQueue({
    hasReceipt: async (id) => stored.has(id),
    storeReceipt: async ({ msgId, offer, jpeg }) => {
      writeFileSync(join(OUT, 'received', `${msgId}.jpg`), jpeg);
      writeFileSync(join(OUT, 'received', `${msgId}.json`), JSON.stringify({ ...offer, candidates: undefined }, null, 2));
      stored.add(msgId);
      received.receipts++;
      log(`receipt stored ${msgId} (${jpeg.length} B)`);
    },
    hasCash: async (id) => stored.has(id),
    storeCash: async ({ entry }) => {
      stored.add(entry.msgId);
      received.cash++;
      log(`cash stored ${entry.day}`);
    },
  });
}

async function serve(rec: PairRecord, mbxId: Uint8Array, tok: { read: Uint8Array; write: Uint8Array }, phoneVm: Uint8Array, mbxEpoch: number) {
  const q = receiver();
  // 큐: Q_D 번들(실제 PC는 금고 안 Q_D, 7일마다 회전) → 2초마다 드레인
  const qd = x25519Keygen();
  const rq = relayQueue({ http: fetchJson, origin: ORIGIN, mbxId, tok, deviceAuth: dauth });
  await rq.putBundle(await makeQBundle(keys.vd, { Qx: qd.publicKey, seq: 1, ...qbundleWindow() }));
  log('PUT /v1/mailboxes/:id/bundle 204');
  let seqMax = 0;
  void (async () => {
    for (;;) {
      try {
        const r = await drainQueue({
          queue: rq, receive: q, pairId: rec.pairId, phoneVm, mbxEpoch,
          hpkeOpen: async ({ enc, ct, info, aad }) => hpkeOpen(qd.secretKey, enc, info, aad, ct),
          seqMax: { get: async () => seqMax, set: async (v) => void (seqMax = v) },
        });
        if (r.ackedTo !== null) {
          received.viaQueue += r.handled;
          received.dropped += r.dropped;
          received.acked = r.ackedTo;
          log(`queue: GET envelopes ${r.handled + r.dropped} → handled ${r.handled}, dropped ${r.dropped} → POST ack {seq:${r.ackedTo}} 200`);
        }
      } catch (e) {
        log('queue error', (e as Error).message);
      }
      await new Promise((res) => setTimeout(res, 2000));
    }
  })();
  // 라이브. STACK_LIVE=0이면 붙지 않는다(Phase 1 운영처럼 라이브 WSS 없음 → 폰은 큐로 보낸다).
  if (process.env.STACK_LIVE === '0') {
    log('live off (STACK_LIVE=0): phone must use the queue');
    return;
  }
  for (;;) {
    let link: Link;
    try {
      link = await client.joinMailbox(mbxId, tok, 'desktop');
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    while (!link.closed) {
      const sess = await acceptDesktopSession(link, { noise: keys.noise, pair: rec, hello: { appVersion: 'stack-pc', deviceListVersion: deviceList.listVersion, capabilities: [CAP.receipt, CAP.cash] }, persistTs: async () => {} });
      if (!sess) continue;
      log('live session open');
      while (!sess.channel.closed) {
        const env = await sess.channel.recv(30_000);
        if (env) await q.handle(sess.channel, env);
      }
    }
  }
}
