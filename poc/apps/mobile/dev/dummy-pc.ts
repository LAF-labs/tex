// 시뮬레이터 개발용 더미 PC + 릴레이(D14 M7-2·M7-4 "PC 역할은 시험 더미"). 실제 PC 배선은 데스크톱·금고 트랙 몫이다.
//   node dev/dummy-pc.ts          → http://localhost:8787
//   GET  /dev/account             계정 AIK_pub + AIK 서명 기기 목록(계정 서버 대역)
//   GET  /dev/qr                  새 페어링 QR 텍스트(시뮬레이터에는 카메라가 없어 앱의 개발 버튼이 가져간다)
//   POST /dev/sas  {"code":"123456"}  사용자가 PC에 6자리를 입력하는 것을 대신한다
//   GET  /dev/status              페어링·수신 상태(금액·사진 내용 없음)
// 받은 사진·현금매출은 dev/out/에 쓴다(git 제외). 로그에 금액·사진·비밀을 넣지 않는다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import {
  AIK_PURPOSES, CAP, DesktopPairing, ReceiveQueue, VD_PURPOSES, acceptDesktopSession, b64, b64url, ed25519Keygen, initialDeviceList, sha256Hash,
  softNoiseStatic, softSigner, toHex, uuid4, wsRelayClient, x25519Keygen,
  type DesktopKeys, type DeviceListJson, type Link, type PairRecord, type WebSocketLike,
} from '../../../packages/remote/src/index.ts';
import { DevRelay } from './relay-server.ts';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = `localhost:${PORT}`;
const OUT = join(import.meta.dirname, 'out');
mkdirSync(join(OUT, 'received'), { recursive: true });

const s = x25519Keygen();
const vd = ed25519Keygen();
const aik = ed25519Keygen();
const kv = x25519Keygen();
const keys: DesktopKeys = { noise: softNoiseStatic(s.secretKey), vd: softSigner(vd.secretKey, VD_PURPOSES), aik: softSigner(aik.secretKey, AIK_PURPOSES), kvPublic: () => kv.publicKey };
const deviceId = uuid4();
// 30일 전에 등록된 PC로 둔다(24시간 경고 화면은 DUMMY_NEW_PC=1로 본다)
const registeredAt = Date.now() - (process.env.DUMMY_NEW_PC ? 3_600_000 : 30 * 86_400_000);
let deviceList: DeviceListJson = await initialDeviceList(keys.aik, { deviceId, role: 'desktop', noisePub: keys.noise.publicKey, signPub: keys.vd.publicKey, registeredAt });

const relay = new DevRelay();
const client = wsRelayClient({ host: HOST, insecureLocal: true, open: (url) => new WebSocket(url) as unknown as WebSocketLike });
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

let pairing: DesktopPairing | null = null;
let qr: { text: string; exp: number } | null = null;
const pairs: PairRecord[] = [];
const received = { receipts: 0, cash: 0 };

async function startPairing(): Promise<string> {
  if (pairing && qr && pairing.state === 'waiting_phone' && !pairing.expired) return qr.text;
  pairing?.cancel();
  const p = new DesktopPairing({
    keys, deviceList, relayHost: HOST,
    isPhoneKeyRegistered: async () => true,
    publishDeviceList: async (l) => {
      deviceList = l;
    },
    registerMailbox: async (id, r, w) => relay.registerMailbox(b64url(id), toHex(sha256Hash(r)), toHex(sha256Hash(w))),
  });
  pairing = p;
  const o = p.offer();
  qr = { text: o.qr, exp: o.exp };
  p.onState((st) => log('pairing:', st));
  const link = await client.joinRoom(p.roomId, 'desktop');
  void p.run(link);
  return o.qr;
}

async function serveMailbox(rec: PairRecord, mbxId: Uint8Array, tokRead: Uint8Array) {
  const q = new ReceiveQueue({
    hasReceipt: async () => false,
    storeReceipt: async ({ msgId, offer, jpeg }) => {
      writeFileSync(join(OUT, 'received', `${msgId}.jpg`), jpeg);
      writeFileSync(join(OUT, 'received', `${msgId}.json`), JSON.stringify(offer, null, 2));
      received.receipts++;
      log(`receipt stored ${msgId} (${jpeg.length} B)`);
    },
    hasCash: async () => false,
    storeCash: async ({ entry }) => {
      writeFileSync(join(OUT, 'received', `cash-${entry.day}.json`), JSON.stringify(entry));
      received.cash++;
      log(`cash stored ${entry.day}`);
    },
  });
  for (;;) {
    let link: Link;
    try {
      link = await client.joinMailbox(mbxId, tokRead, 'desktop');
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }
    while (!link.closed) {
      const sess = await acceptDesktopSession(link, {
        noise: keys.noise, pair: rec, hello: { appVersion: 'dummy-pc', deviceListVersion: deviceList.listVersion, capabilities: [CAP.receipt, CAP.cash] },
        persistTs: async () => {},
      });
      if (!sess) continue;
      log('session open', sess.deviceListMismatch ? '(device list mismatch)' : '');
      while (!sess.channel.closed) {
        const env = await sess.channel.recv(30_000);
        if (env) await q.handle(sess.channel, env);
      }
      log('session closed');
    }
  }
}

const server = createServer(async (req, res) => {
  const send = (code: number, body: string, type = 'application/json') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  try {
    if (req.method === 'GET' && req.url === '/dev/account') return send(200, JSON.stringify({ aikPub: b64(keys.aik.publicKey), deviceList }));
    if (req.method === 'GET' && req.url === '/dev/qr') return send(200, await startPairing(), 'text/plain');
    if (req.method === 'GET' && req.url === '/dev/status') return send(200, JSON.stringify({ pairing: pairing?.state ?? 'idle', pairs: pairs.length, received, frames: relay.frames }));
    if (req.method === 'POST' && req.url === '/dev/sas') {
      let body = '';
      for await (const c of req) body += c;
      const code = String((JSON.parse(body) as { code?: string }).code ?? '');
      if (!pairing || pairing.state !== 'awaiting_sas') return send(409, JSON.stringify({ ok: false, state: pairing?.state }));
      const r = await pairing.submitSas(code);
      if (!r.ok) return send(200, JSON.stringify(r));
      const rec: PairRecord = { pairId: r.result.pairId, phoneStatic: r.result.phone.Sm, revoked: false, ikTsMax: 0 };
      pairs.push(rec);
      r.result.channel.close();
      log('paired', rec.pairId, r.result.phone.platform);
      void serveMailbox(rec, r.result.mbxId, r.result.tokRead);
      return send(200, JSON.stringify({ ok: true, pairId: rec.pairId }));
    }
    send(404, '{}');
  } catch (e) {
    log('error', (e as Error).message);
    send(500, '{}');
  }
});
relay.attach(server);
server.listen(PORT, () => log(`dummy PC + relay on http://${HOST}`));
