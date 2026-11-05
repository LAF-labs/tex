// 더미 PC 상대 스모크(시뮬레이터 없이): Node가 폰 역할로 WSS 초안 프로토콜 위에서 페어링 → IK 세션 → 사진·현금매출 전송.
//   node dev/dummy-pc.ts &  node dev/smoke-phone.ts
import {
  CAP, MobilePairing, RECEIPT_CHUNK, VM_PURPOSES, ed25519Keygen, enqueueCash, flushOutbox, fromB64, makeCashEntry, makeReceiptOffer, monotonicClock,
  openMobileSession, softNoiseStatic, softSigner, uuid4, wsRelayClient, x25519Keygen,
  type OutboxItem, type OutboxStore, type WebSocketLike,
} from '../../../packages/remote/src/index.ts';

const HOST = 'localhost:8787';
const base = `http://${HOST}`;
const client = wsRelayClient({ host: HOST, insecureLocal: true, open: (u) => new WebSocket(u) as unknown as WebSocketLike });

const acct = (await (await fetch(`${base}/dev/account`)).json()) as { aikPub: string; deviceList: never };
const qr = await (await fetch(`${base}/dev/qr`)).text();
const s = x25519Keygen();
const vm = ed25519Keygen();
const km = x25519Keygen();
const noise = softNoiseStatic(s.secretKey);
softSigner(vm.secretKey, VM_PURPOSES);
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

const mbx = await client.joinMailbox(fromB64(r.mbxId), fromB64(r.tokWrite), 'mobile');
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
