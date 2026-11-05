// 더미 PC 상대 스모크(시뮬레이터 없이): Node가 폰 역할로 릴레이(services/relay/API.md 경로·헤더) 위에서
// 페어링 → 기기 토큰(AIK 인증서 + DPoP) → 우편함 라이브 → IK 세션 → 사진·현금매출 전송.
//   node dev/dummy-pc.ts &  node dev/smoke-phone.ts          (라이브)
//   node dev/dummy-pc.ts &  node dev/smoke-phone.ts --queue  (라이브 없이 HTTPS 큐: 번들 확인 → HPKE 봉인 → POST → PC가 꺼내 감)
import { WebSocket as WS } from 'ws';
import {
  CAP, DeviceTokenCache, MobilePairing, RECEIPT_CHUNK, VM_PURPOSES, deviceAuthHeaders, ed25519Keygen, enqueueCash, flushOutbox, fromB64, makeCashEntry,
  makeReceiptOffer, monotonicClock, openMobileSession, queueOutbox, relayQueue, requestDeviceToken, softNoiseStatic, softSigner, uuid4, verifyQBundle,
  wsRelayClient, x25519Keygen,
  type HttpJson, type OutboxItem, type OutboxStore, type SignedCert, type WebSocketLike,
} from '../../../packages/remote/src/index.ts';

const HOST = 'localhost:8787';
const base = `http://${HOST}`;
const fetchJson: HttpJson = async (r) => {
  const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
  const t = await res.text();
  return { status: res.status, body: t ? (JSON.parse(t) as unknown) : null };
};
let tokens: DeviceTokenCache | null = null;
const client = wsRelayClient({
  host: HOST, insecureLocal: true,
  open: (u, headers) => new WS(u, { headers }) as unknown as WebSocketLike,
  deviceAuth: async (htm, htu) => deviceAuthHeaders(await tokens!.token(), vmSigner, htm, htu),
});

const acct = (await (await fetch(`${base}/dev/account`)).json()) as { aikPub: string; deviceList: never };
const qr = await (await fetch(`${base}/dev/qr`)).text();
const s = x25519Keygen();
const vm = ed25519Keygen();
const km = x25519Keygen();
const noise = softNoiseStatic(s.secretKey);
const vmSigner = softSigner(vm.secretKey, VM_PURPOSES);
const mp = new MobilePairing({
  keys: { noise, vmPub: vm.publicKey, kmPub: km.publicKey, deviceId: uuid4(), name: 'smoke', platform: 'ios' },
  accountAikPub: fromB64(acct.aikPub), serverDeviceList: acct.deviceList, relayAllowlist: [HOST], pairOkTimeoutMs: 15_000,
});
if (!mp.scan(qr)) throw new Error(`scan failed: ${mp.failure}`);
const link = await client.joinRoom(mp.roomId, 'mobile');
mp.onState((st) => {
  if (st === 'show_sas') void fetch(`${base}/dev/sas`, { method: 'POST', body: JSON.stringify({ code: mp.sas }) });
});
const r = await mp.run(link);
if (!r) throw new Error(`pair failed: ${mp.failure}`);
r.channel.close();
console.log('paired', r.pairId);
await new Promise((res) => setTimeout(res, 300));

const items = new Map<string, { it: OutboxItem; photo?: Uint8Array }>();
const store: OutboxStore = {
  list: async () => [...items.values()].map((x) => x.it),
  put: async (it, photo) => void items.set(it.msgId, { it, photo: photo ?? items.get(it.msgId)?.photo }),
  readPhoto: async (id) => items.get(id)!.photo!,
  remove: async (id) => void items.delete(id),
};
const jpeg = new Uint8Array(RECEIPT_CHUNK * 3 + 77);
jpeg.set([0xff, 0xd8, 0xff, 0xe0]);
for (let i = 4; i < jpeg.length; i++) jpeg[i] = (i * 31) & 0xff;
const offer = makeReceiptOffer(jpeg, { capturedAt: Date.now(), ocrEngine: 'none', ownerConfirmed: true });
await store.put({ kind: 'receipt', msgId: offer.msgId, offer, createdAt: Date.now(), attempts: 0 }, jpeg);
await enqueueCash(store, makeCashEntry('2026-11-05', 1234));

const myCert: SignedCert = r.cert;
tokens = new DeviceTokenCache(() => requestDeviceToken(fetchJson, base, myCert, vmSigner));

if (process.argv.includes('--queue')) {
  const rq = relayQueue({
    http: fetchJson, origin: base, mbxId: fromB64(r.mbxId), tok: { read: fromB64(r.tokRead), write: fromB64(r.tokWrite) },
    deviceAuth: async (htm, htu) => deviceAuthHeaders(await tokens!.token(), vmSigner, htm, htu),
  });
  let field: string | null = null;
  for (let i = 0; i < 20 && !field; i++) {
    field = await rq.getBundle();
    if (!field) await new Promise((res) => setTimeout(res, 200));
  }
  const bundle = field ? verifyQBundle(field, r.desktopVd) : null;
  if (!bundle) throw new Error('no valid bundle');
  let seq = 0;
  const q = await queueOutbox(store, { queue: rq, pairId: r.pairId, vm: vmSigner, bundle, mbxEpoch: r.mbxEpoch, nextSeq: () => ++seq });
  console.log('queued', q.queued.length, 'waiting', q.waiting.length);
  let st: { received: { receipts: number; cash: number; viaQueue: number } } | null = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 500));
    st = (await (await fetch(`${base}/dev/status`)).json()) as typeof st;
    if (st!.received.viaQueue >= 1 + Math.ceil(jpeg.length / 32768) + 1) break;
  }
  console.log('pc status', JSON.stringify(st));
  process.exit(q.queued.length === 2 && st!.received.receipts === 1 && st!.received.cash === 1 ? 0 : 1);
}
const mbx = await client.joinMailbox(fromB64(r.mbxId), { read: fromB64(r.tokRead), write: fromB64(r.tokWrite) }, 'mobile');
const sess = await openMobileSession(mbx, {
  pairId: r.pairId, noise, desktopStatic: r.desktopStatic, nextTimestamp: monotonicClock(0),
  hello: { appVersion: 'smoke', deviceListVersion: r.deviceList.listVersion, capabilities: [CAP.receipt, CAP.cash] },
});
if (!sess) throw new Error('session failed');
const f = await flushOutbox(sess.channel, store, { pace: async () => {} });
console.log('flushed', f.sent.length, 'pending', f.pending.length);
sess.channel.close();
const st = await (await fetch(`${base}/dev/status`)).json();
console.log('pc status', JSON.stringify(st));
process.exit(f.pending.length === 0 && f.sent.length === 2 ? 0 : 1);
