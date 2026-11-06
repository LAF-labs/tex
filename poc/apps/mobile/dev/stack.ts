// 실제 계정·릴레이 서비스(services/account·relay, #63) 위의 통합 시험 스택. 시뮬레이터 앱은 바꾸지 않는다.
//   node --conditions=development dev/stack.ts   → http://localhost:8787 (운영처럼 계정·릴레이가 한 공개 origin, 팀장 결정 2026-11-05)
//   STACK_LIVE=0 이면 PC가 라이브 우편함에 붙지 않는다(Phase 1처럼 큐만).
//   STACK_HOST=<소문자 LocalHostName>.local:8787 이면 같은 LAN의 실기기가 붙는다(공개 origin·QR의 릴레이 호스트가 이 이름이 된다).
//     실기기 앱은 Metro를 EXPO_PUBLIC_TEX_DEV_HOST=<같은 값> 으로 띄운다. QR은 브라우저에서 /dev/qr.html 을 열어 폰 카메라로 찍는다.
//   앞단 8787: /v1/mailboxes·/v1/rooms(WSS 포함) → 릴레이(127.0.0.1:8783), 나머지 /v1/* → 계정(127.0.0.1:8780), /dev/* → 더미 PC
//   더미 PC: 계정 로그인(모의 메일 코드) → AIK 고정 → 기기 토큰 → POST /v1/rooms → 페어링 → SAS 일치 → 폰 대리 등록
//            (POST /v1/devices/enroll, 데스크톱 기기 토큰 + roomId) → PUT /v1/device-list → POST /v1/mailboxes → pair.ok
//            → 번들 PUT → 큐 드레인(GET → 개봉 → ack) + 라이브 우편함.
// 비밀(토큰 서명 시드·큐 키·내부 토큰·한도 ID 키 등)은 기동마다 새로 만들고 출력하지 않는다. 로그에 금액·사진·토큰을 넣지 않는다. DB는 dev/out/stack-*.db(git 제외).
// 폰에는 계정 로그인이 없다. 폰의 계정 등록은 PC가 대신 하고(팀장 결정 2026-11-06, #115), 폰은 기기 목록을 서버에서 받지 않는다
// (PAIR_OK의 AIK 서명 목록을 검사한다). STACK_NO_BUNDLE=1 이면 번들을 올리지 않는다(폰의 'PC 연결 확인 안 됨' 화면 확인용).
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { toQR } from 'toqr';
import { devAcctClaim } from './test-account-key.ts';
import { WebSocket as WS } from 'ws';
import {
  AIK_PURPOSES, CAP, DesktopPairing, allowDevLanHosts, DeviceTokenCache, ReceiveQueue, VD_PURPOSES, acceptDesktopSession, b64, b64url, certNotAfter, deviceAuthHeaders,
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
const HOST = process.env.STACK_HOST ?? `localhost:${FRONT}`;
if (!/^(localhost|[a-z0-9-]{1,63}\.local):\d{1,5}$/.test(HOST)) throw new Error('STACK_HOST must be localhost:<port> or <lowercase name>.local:<port>');
if (Number(HOST.split(':')[1]) !== FRONT) throw new Error(`STACK_HOST port must be ${FRONT}`);
const ORIGIN = `http://${HOST}`;
// 실기기용 .local이면 이 프로세스(더미 PC의 DPoP·WSS)도 mDNS 평문을 켠다. localhost면 끈 채로 둔다.
allowDevLanHosts(HOST.endsWith('.local:' + FRONT));
const OUT = join(import.meta.dirname, 'out');
mkdirSync(join(OUT, 'received'), { recursive: true });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
const hex = () => randomBytes(32).toString('hex');

// ---- 서비스 기동(비밀은 매번 새로) ----
for (const f of ['stack-account.db', 'stack-relay.db']) rmSync(join(OUT, f), { force: true });
const tokenSeed = hex();
const internal = randomBytes(32).toString('base64url');
const limitIdKey = hex();
const mail = new MockMailSender();
const account = await startAccount(
  {
    SAX_SQLITE_FILE: join(OUT, 'stack-account.db'), TOKEN_SIGNING_SEED: tokenSeed, CODE_MAC_KEY: hex(), ACCOUNT_PUBLIC_ORIGIN: ORIGIN, WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGINS: ORIGIN, BILLING_RETURN_URL: `${ORIGIN}/done`, PG_PROVIDER: 'mock', MAIL_PROVIDER: 'mock', INTERNAL_TOKEN: internal,
    STOP_HOOK_URLS: `http://127.0.0.1:${RELAY}`, RELAY_INTERNAL_URL: `http://127.0.0.1:${RELAY}`, LIMIT_ID_KEY: limitIdKey, PORT: String(ACCT), HOST: '127.0.0.1',
  },
  { mail },
);
const relaySvc = await startRelay({
  SAX_SQLITE_FILE: join(OUT, 'stack-relay.db'), QUEUE_KEY: hex(), RELAY_PUBLIC_ORIGIN: ORIGIN,
  TOKEN_PUBLIC_KEYS: `k1:${ed25519RawPublic(ed25519Private(Buffer.from(tokenSeed, 'hex'))).toString('base64')}`,
  ACCOUNT_INTERNAL_URL: `http://127.0.0.1:${ACCT}`, INTERNAL_TOKEN: internal, LIMIT_ID_KEY: limitIdKey, PORT: String(RELAY), HOST: '127.0.0.1',
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

/** QR 텍스트 → 단순 SVG 페이지(외부 자원 없음). */
function qrPage(text: string): string {
  const m = toQR(text);
  const n = Math.sqrt(m.length);
  let rects = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (m[y * n + x]) rects += `<rect x="${x + 4}" y="${y + 4}" width="1" height="1"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 8} ${n + 8}" width="420" height="420" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
  return `<!doctype html><meta charset="utf-8"><title>더미 PC 폰 연결</title><body style="font-family:-apple-system,sans-serif;text-align:center;padding:24px"><h2>폰 연결(더미 PC)</h2><div id="q">${svg}</div><p id="n" hidden><b>시간이 지났어요.</b> <button onclick="location.reload()" style="font-size:20px">새 QR</button></p><p>폰에서 PC와 연결하기를 누른 <b>다음</b> [새 QR]을 누르고 30초 안에 찍어 주세요(PC 대역은 30초만 기다리고, 룸은 계정당 시간당 5개까지라 저절로 바꾸지 않습니다).</p><p>폰에 뜬 6자리를 여기에 넣어 주세요(PC 앱의 입력 칸 대역).</p><form id="f"><input id="c" inputmode="numeric" maxlength="6" autocomplete="off" style="font-size:28px;width:180px;text-align:center;letter-spacing:6px"> <button style="font-size:20px">확인</button></form><p id="r"></p><script>document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const r=await fetch('/dev/sas',{method:'POST',body:JSON.stringify({code:document.getElementById('c').value})});const j=await r.json().catch(()=>({}));document.getElementById('r').textContent=j.ok?'연결됐어요. 폰 화면을 확인해 주세요.':'맞지 않아요'+(j.triesLeft!==undefined?' (남은 횟수 '+j.triesLeft+')':'');};
const t=setInterval(async()=>{const st=await fetch('/dev/status').then(r=>r.json()).catch(()=>null);if(!st)return;const q=document.getElementById('q');if(st.pairing==='failed'){clearInterval(t);q.style.opacity='0.15';document.getElementById('n').hidden=false;}if(st.pairing==='paired'){clearInterval(t);document.getElementById('r').textContent='연결됐어요. 폰 화면을 확인해 주세요.';}},2000);</script></body>`;
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
      if (req.method === 'GET' && path === '/dev/qr') return send(200, await startPairing(), 'text/plain');
      // 실기기: 맥 화면의 QR을 폰 카메라로 찍는다(PC 앱의 [폰 연결] 화면 대역). 1회용·120초, 폰이 찍으면 새로고침해도 같은 QR이다.
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
    // 7단계: SAS 일치 뒤, pair.ok 전(룸이 열려 있을 때) 데스크톱 기기 토큰 + 이 룸 id로 폰을 대신 등록한다.
    // 설계 #120: 계정 서비스가 서명할 acct_claim. 서버 구현 전이라 시험 키(dev/test-account-key.ts)로 대신 서명한다.
    accountClaim: async () => devAcctClaim(keys.aik.publicKey, email),
    desktopName: '더미 PC',
    enrollPhone: async (ph) => {
      const r = await call('POST', '/v1/devices/enroll', {
        headers: await dauth('POST', `${ORIGIN}/v1/devices/enroll`),
        body: { deviceId: ph.deviceId, role: 'mobile', platform: ph.platform, name: ph.name, Sx: b64(ph.Sm), Vx: b64(ph.Vm), roomId: b64url(ph.roomId) },
      });
      if (r.status === 201) return void log('POST /v1/devices/enroll (PC 대리 등록) 201');
      // 앞 시도에서 등록만 되고 목록을 못 올린 폰: 같은 키로 이미 있으면 성공으로 본다(계약: 같은 기기 ID 재등록은 400).
      const list = expect(await call('GET', '/v1/devices', { headers: await dauth('GET', `${ORIGIN}/v1/devices`) }), 200, 'GET /v1/devices').devices as { deviceId: string; Sx: string; Vx: string }[];
      if (list.some((d) => d.deviceId === ph.deviceId && d.Sx === b64(ph.Sm) && d.Vx === b64(ph.Vm))) return void log('POST /v1/devices/enroll', r.status, '(이미 같은 키로 등록됨)');
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
  // 큐: Q_D 번들(실제 PC는 금고 안 Q_D, 7일마다 회전) → 2초마다 드레인
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
