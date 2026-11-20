import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { toQR } from 'toqr';
import { TEST_ONLY_SEED_HEX } from './test-account-key.ts';
import { WebSocket as WS } from 'ws';
import {
  AIK_PURPOSES, CAP, DesktopPairing, allowDevLanHosts, jcsBytes, DeviceTokenCache, ReceiveQueue, VD_PURPOSES, acceptDesktopSession, b64, b64url, certNotAfter, deviceAuthHeaders,
  drainQueue, ed25519Keygen, hpkeOpen, initialDeviceList, issueCert, makeQBundle, qbundleWindow, relayQueue, requestDeviceToken, softNoiseStatic, softSigner,
  uuid4, wsRelayClient, x25519Keygen, type DesktopKeys, type DeviceListJson, type HttpJson, type Link, type PairRecord, type WebSocketLike,
} from '../../packages/remote/src/index.ts';
import { MockMailSender } from '../../services/account/src/adapters.ts';
import { startAccount } from '../../services/account/src/main.ts';
import { startRelay } from '../../services/relay/src/main.ts';
import { ed25519Private, ed25519RawPublic } from '../../services/shared/src/index.ts';

const FRONT = 8787;
const ACCT = 8780;
const RELAY = 8783;
const HOST = process.env.STACK_HOST ?? `localhost:${FRONT}`;
if (!/^(localhost|[a-z0-9-]{1,63}\.local):\d{1,5}$/.test(HOST)) throw new Error('STACK_HOST must be localhost:<port> or <lowercase name>.local:<port>');
if (Number(HOST.split(':')[1]) !== FRONT) throw new Error(`STACK_HOST port must be ${FRONT}`);
const ORIGIN = `http://${HOST}`;
allowDevLanHosts(HOST.endsWith('.local:' + FRONT));
const OUT = join(import.meta.dirname, 'out');
mkdirSync(join(OUT, 'received'), { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hex = () => randomBytes(32).toString('hex');

for (const f of ['stack-account.db', 'stack-relay.db']) rmSync(join(OUT, f), { force: true });
const tokenSeed = hex();
const internal = hex();
const limitIdKey = hex();
const mail = new MockMailSender();
const account = await startAccount(
  {
    SAX_SQLITE_FILE: join(OUT, 'stack-account.db'), TOKEN_SIGNING_SEED: tokenSeed, CODE_MAC_KEY: hex(), ACCOUNT_PUBLIC_ORIGIN: ORIGIN, WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGINS: ORIGIN, BILLING_RETURN_URL: `${ORIGIN}/done`, PG_PROVIDER: 'mock', MAIL_PROVIDER: 'mock', INTERNAL_CALL_KEY: internal,
    STOP_HOOK_URLS: `http://127.0.0.1:${RELAY}`, RELAY_INTERNAL_URL: `http://127.0.0.1:${RELAY}`, LIMIT_ID_KEY: limitIdKey, PORT: String(ACCT), HOST: '127.0.0.1',
    ACCT_CLAIM_SIGNING_KEY: TEST_ONLY_SEED_HEX,
  },
  { mail },
);
const relaySvc = await startRelay({
  SAX_SQLITE_FILE: join(OUT, 'stack-relay.db'), QUEUE_KEY: hex(), RELAY_PUBLIC_ORIGIN: ORIGIN,
  TOKEN_PUBLIC_KEYS: `k1:${ed25519RawPublic(ed25519Private(Buffer.from(tokenSeed, 'hex'))).toString('base64')}`,
  ACCOUNT_INTERNAL_URL: `http://127.0.0.1:${ACCT}`, INTERNAL_CALL_KEY: internal, LIMIT_ID_KEY: limitIdKey, PORT: String(RELAY), HOST: '127.0.0.1',
  RELAY_ROOMS: '1', RELAY_LIVE: process.env.STACK_LIVE === '0' ? '0' : '1',
});
log(`account ${account.url} · relay ${relaySvc.url}`);

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

function qrPage(text: string): string {
  const m = toQR(text);
  const n = Math.sqrt(m.length);
  let rects = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y * n + x]) rects += `<rect x="${x + 4}" y="${y + 4}" width="1" height="1"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" width="420" height="420" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  return `<!doctype html><meta charset="utf-8"><title>더미 PC 폰 연결</title><body style="font-family:-apple-system,sans-serif;text-align:center;padding:24px"><h2>폰 연결(더미 PC)</h2><div id="q">${svg}</div><p id="n" hidden><b>시간이 지났어요.</b> <button onclick="location.reload()" style="font-size:20px">새 QR</button></p><p>폰에서 PC와 연결하기를 누른 <b>다음</b> [새 QR]을 누르고 30초 안에 찍어 주세요(PC 대역은 30초만 기다리고, 룸은 계정당 시간당 5개까지라 저절로 바꾸지 않습니다).</p><p>폰에 뜬 6자리를 여기에 넣어 주세요(PC 앱의 입력 칸 대역).</p><form id="f"><input id="c" inputmode="numeric" maxlength="6" autocomplete="off" style="font-size:28px;width:180px;text-align:center;letter-spacing:6px"> <button style="font-size:20px">확인</button></form><p id="r"></p><script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/dev/sas',{method:'POST',body:JSON.stringify({code:document.getElementById('c').value})});const j=await r.json().catch(()=>({}));document.getElementById('r').textContent=j.ok?'연결됐어요. 폰 화면을 확인해 주세요.':'맞지 않아요'+(j.triesLeft!==undefined?' (남은 횟수 '+j.triesLeft+')':'');};
const t=setInterval(async()=>{const st=await fetch('/dev/status').then(r=>r.json()).catch(()=>null);if(!st)return;const q=document.getElementById('q');if(st.pairing==='failed'){clearInterval(t);q.style.opacity='0.15';document.getElementById('n').hidden=false;}if(st.pairing==='paired'){clearInterval(t);document.getElementById('r').textContent='연결됐어요. 폰 화면을 확인해 주세요.';}},2000);</script></body>`;
}

const isRelay = (p: string) => p.startsWith('/v1/mailboxes') || p.startsWith('/v1/rooms') || p.startsWith('/internal/');
const front = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  const send = (code: number, body: string, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  if (path.startsWith('/dev/')) {
    try {
      if (req.method === 'GET' && path === '/dev/qr') return send(200, await startPairing(), 'text/plain');
      if (req.method === 'GET' && path === '/dev/qr.html') return send(200, qrPage(await startPairing()), 'text/html; charset=utf-8');
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
    accountClaim: async () => b64(jcsBytes(expect(await call('GET', '/v1/acct-claim', { headers: await dauth('GET', `${ORIGIN}/v1/acct-claim`) }), 200, 'GET /v1/acct-claim'))),
    desktopName: '더미 PC',
    enrollPhone: async (ph) => {
      const r = await call('POST', '/v1/devices/enroll', {
        headers: await dauth('POST', `${ORIGIN}/v1/devices/enroll`),
        body: { deviceId: ph.deviceId, role: 'mobile', platform: ph.platform, name: ph.name, Sx: b64(ph.Sm), Vx: b64(ph.Vm), roomId: b64url(ph.roomId) },
      });
      if (r.status === 201 || r.status === 200) return void log(`POST /v1/devices/enroll (PC 대리 등록) ${r.status}`);
      throw new Error(`POST /v1/devices/enroll: ${r.status} ${JSON.stringify(r.body)}`);
    },
    publishDeviceList: async (l) => {
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
  const qd = x25519Keygen();
  const rq = relayQueue({ http: fetchJson, origin: ORIGIN, mbxId, tok, deviceAuth: dauth });
  if (process.env.STACK_NO_BUNDLE === '1') log('bundle off (STACK_NO_BUNDLE=1)');
  else {
    await rq.putBundle(await makeQBundle(keys.vd, { Qx: qd.publicKey, seq: 1, ...qbundleWindow() }));
    log('PUT /v1/mailboxes/:id/bundle 204');
  }
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
