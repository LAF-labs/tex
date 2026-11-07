// 라이브 세션이 없을 때 릴레이 HTTPS 큐로 사진·현금매출 보내기(intent-envelope v1.5 kind xfer, 팀장 결정 2026-11-05).
// HPKE(RFC 9180 벡터) · 우편함 번들 · 폰 보관함 → 큐 → PC 수신 큐 · 재생·변조·만료 · 큐 한도.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CTX, DRAIN_MAX_PAGES, ENV_PAD_BUCKETS, QUEUE, ReceiveQueue, VD_PURPOSES, VM_PURPOSES, b64, drainQueue, ed25519Keygen, enqueueCash, fromHex, hpkeDeriveKeyPair, hpkeOpen, hpkeSeal,
  makeCashEntry, makeQBundle, makeReceiptOffer, newFileKey, openOutboxFile, openXfer, qbundleWindow, relayQueue, sealOutboxFile, sealXfer, sha256Hash, softSigner, toHex,
  ulid, utf8, verifyQBundle, x25519Keygen, type CashEntryBody, type HttpJson, type OuterEnv, type OutboxItem, type OutboxStore, type QBundle, type ReceiveSink, type Xfer,
} from '@sax/remote';
import { fakeJpeg } from './remote-support.ts';

describe('HPKE base (RFC 9180 A.2.1, X25519/HKDF-SHA256/ChaCha20-Poly1305)', () => {
  const ikmE = fromHex('909a9b35d3dc4713a5e72a4da274b55d3d3821a37e5d099e74a647db583a904b');
  const ikmR = fromHex('1ac01f181fdf9f352797655161c58b75c656a6cc2716dcb66372da835542e1df');
  const info = fromHex('4f6465206f6e2061204772656369616e2055726e');
  const pt = fromHex('4265617574792069732074727574682c20747275746820626561757479');
  const aad = fromHex('436f756e742d30');
  const ct = '1c5250d8034ec2b784ba2cfd69dbdb8af406cfe3ff938e131f0def8c8b60b4db21993c62ce81883d2dd1b51a28';

  it('키 유도·봉인·개봉이 벡터와 같다', () => {
    const e = hpkeDeriveKeyPair(ikmE);
    const r = hpkeDeriveKeyPair(ikmR);
    assert.equal(toHex(e.secretKey), 'f4ec9b33b792c372c1d2c2063507b684ef925b8c75a42dbcbf57d63ccd381600');
    assert.equal(toHex(e.publicKey), '1afa08d3dec047a643885163f1180476fa7ddb54c6a8029ea33f95796bf2ac4a');
    assert.equal(toHex(r.secretKey), '8057991eef8f1f1af18f4a9491d16a1ce333f695d4db8e38da75975c4478e0fb');
    assert.equal(toHex(r.publicKey), '4310ee97d88cc1f088a5576c77ab0cf5c3ac797f3d95139c6c84b5429c59662a');
    const s = hpkeSeal(r.publicKey, info, aad, pt, e.secretKey);
    assert.equal(toHex(s.enc), toHex(e.publicKey));
    assert.equal(toHex(s.ct), ct);
    assert.deepEqual(hpkeOpen(r.secretKey, s.enc, info, aad, s.ct), pt);
  });

  it('aad·info·암호문이 다르면 열리지 않는다', () => {
    const r = x25519Keygen();
    const s = hpkeSeal(r.publicKey, info, aad, pt);
    assert.throws(() => hpkeOpen(r.secretKey, s.enc, info, utf8('x'), s.ct));
    assert.throws(() => hpkeOpen(r.secretKey, s.enc, utf8('x'), aad, s.ct));
    const bad = s.ct.slice();
    bad[0] ^= 1;
    assert.throws(() => hpkeOpen(r.secretKey, s.enc, info, aad, bad));
    assert.throws(() => hpkeOpen(x25519Keygen().secretKey, s.enc, info, aad, s.ct));
  });
});

const NOW = Date.UTC(2026, 10, 5, 3, 0, 0);
const DAY = 86_400_000;

describe('우편함 번들(SAX-qbundle-v1)', () => {
  const vd = softSigner(ed25519Keygen().secretKey, VD_PURPOSES);
  const q = x25519Keygen();
  const make = (o: Partial<QBundle> = {}) => makeQBundle(vd, { Qx: q.publicKey, seq: 3, ...qbundleWindow(NOW), ...o });

  it('Vd로 확인하고 Qx·seq·기간을 돌려준다', async () => {
    const field = await make();
    assert.ok(field.length <= 2048);
    const b = verifyQBundle(field, vd.publicKey, { now: NOW + DAY, minSeq: 3 });
    assert.ok(b);
    assert.deepEqual(b.Qx, q.publicKey);
    assert.equal(b.seq, 3);
    assert.equal(b.validTo, NOW + 7 * DAY);
  });

  it('만료·seq 역행·다른 Vd·변조·미래 시작은 거부한다', async () => {
    const field = await make();
    assert.equal(verifyQBundle(field, vd.publicKey, { now: NOW + 7 * DAY }), null);
    assert.equal(verifyQBundle(field, vd.publicKey, { now: NOW, minSeq: 4 }), null);
    assert.equal(verifyQBundle(field, softSigner(ed25519Keygen().secretKey, VD_PURPOSES).publicKey, { now: NOW }), null);
    const json = JSON.parse(Buffer.from(field, 'base64').toString());
    json.bundle.seq = 9;
    assert.equal(verifyQBundle(Buffer.from(JSON.stringify(json)).toString('base64'), vd.publicKey, { now: NOW }), null);
    assert.equal(verifyQBundle(await make({ validFrom: NOW + DAY, validTo: NOW + 2 * DAY }), vd.publicKey, { now: NOW }), null);
    assert.equal(verifyQBundle(await make({ validFrom: NOW, validTo: NOW + 30 * DAY }), vd.publicKey, { now: NOW }), null);
    assert.equal(verifyQBundle('not base64!', vd.publicKey, { now: NOW }), null);
  });
});

// ---- 시험용 릴레이 큐(services/relay 한도: 160 봉투 / 6 MiB / ct 65,536자, ack = seq까지 삭제) ----
// GET은 #204처럼 쪽을 나눈다: 봉투 바이트 pageBytes까지(봉투 하나는 언제나), 남으면 more, 선택 ?after=<seq>.
class FakeRelay {
  envs: { seq: number; env: OuterEnv; size: number }[] = [];
  seq = 0;
  pageBytes = 3 * 1024 * 1024;
  /** 이 횟수를 넘는 GET /envelopes는 500(중간 실패 시험) */
  failGetAfter = Infinity;
  gets = 0;
  /** 우편함 초당 한도(services/relay 20건, 고정 창). tick()이 창을 넘긴다 */
  ratePerWindow = Infinity;
  windowPosts = 0;
  windows = 0;
  tick() {
    this.windows++;
    this.windowPosts = 0;
  }
  bundle: string | null = null;
  posts = 0;
  seen: { method: string; url: string; headers: Record<string, string> }[] = [];
  http: HttpJson = async (req) => {
    this.seen.push({ method: req.method, url: req.url, headers: req.headers });
    const path = new URL(req.url).pathname;
    const body = req.body ? JSON.parse(req.body) : undefined;
    if (!req.headers.Authorization?.startsWith('DPoP ') || !req.headers.DPoP) return { status: 401, body: { error: 'auth' } };
    if (path.endsWith('/envelopes') && req.method === 'POST') {
      if (!req.headers['X-Mbx-Write']) return { status: 403, body: null };
      if (++this.windowPosts > this.ratePerWindow) return { status: 429, body: { error: 'policy.rate_limited' } };
      if (body.ct.length > QUEUE.ctMaxChars) return { status: 413, body: { error: 'relay.too_large' } };
      const size = req.body!.length;
      if (this.envs.length >= QUEUE.maxEnvelopes || this.bytes + size > QUEUE.maxBytes) return { status: 429, body: { error: 'relay.queue_full' } };
      this.posts++;
      this.envs.push({ seq: ++this.seq, env: body, size });
      return { status: 202, body: { seq: this.seq } };
    }
    if (path.endsWith('/envelopes') && req.method === 'GET') {
      if (++this.gets > this.failGetAfter) return { status: 500, body: { error: 'internal' } };
      const after = Number(new URL(req.url).searchParams.get('after') ?? '0');
      const pending = this.envs.filter((e) => e.seq > after);
      let n = 0;
      let bytes = 0;
      while (n < pending.length && (n === 0 || bytes + pending[n]!.size <= this.pageBytes)) bytes += pending[n++]!.size;
      return { status: 200, body: { envelopes: pending.slice(0, n).map(({ seq, env }) => ({ seq, env })), more: n < pending.length } };
    }
    if (path.endsWith('/ack')) {
      this.envs = this.envs.filter((e) => e.seq > body.seq);
      return { status: 200, body: {} };
    }
    if (path.endsWith('/bundle') && req.method === 'PUT') {
      this.bundle = body.bundle;
      return { status: 204, body: null };
    }
    if (path.endsWith('/bundle')) return this.bundle ? { status: 200, body: { bundle: this.bundle } } : { status: 404, body: null };
    return { status: 404, body: null };
  };
  get bytes() {
    return this.envs.reduce((n, e) => n + e.size, 0);
  }
}

class MemOutbox implements OutboxStore {
  items = new Map<string, OutboxItem>();
  photos = new Map<string, Uint8Array>();
  key = newFileKey();
  async list() {
    return [...this.items.values()];
  }
  async put(it: OutboxItem, photo?: Uint8Array) {
    this.items.set(it.msgId, it);
    if (photo) this.photos.set(it.msgId, sealOutboxFile(this.key, it.msgId, photo));
  }
  async readPhoto(id: string) {
    return openOutboxFile(this.key, id, this.photos.get(id)!);
  }
  async remove(id: string) {
    this.items.delete(id);
    this.photos.delete(id);
  }
}

class MemSink implements ReceiveSink {
  receipts = new Map<string, string>();
  cash = new Map<string, CashEntryBody>();
  storeCalls = 0;
  async hasReceipt(id: string) {
    return this.receipts.has(id);
  }
  async storeReceipt(r: Parameters<ReceiveSink['storeReceipt']>[0]) {
    this.storeCalls++;
    this.receipts.set(r.msgId, toHex(sha256Hash(r.jpeg)));
  }
  async hasCash(id: string) {
    return this.cash.has(id);
  }
  async storeCash({ entry }: { entry: CashEntryBody }) {
    this.cash.set(entry.msgId, entry);
  }
}

async function world() {
  const relay = new FakeRelay();
  const vd = softSigner(ed25519Keygen().secretKey, VD_PURPOSES);
  const vm = softSigner(ed25519Keygen().secretKey, VM_PURPOSES);
  const qd = x25519Keygen();
  const pairId = ulid(NOW);
  const mbxEpoch = 2;
  const tok = { read: new Uint8Array(32).fill(1), write: new Uint8Array(32).fill(2) };
  const deviceAuth = async () => ({ Authorization: 'DPoP t', DPoP: 'proof' });
  const q = relayQueue({ http: relay.http, origin: 'https://tax.laf-co.com', mbxId: new Uint8Array(16).fill(7), tok, deviceAuth });
  // PC: 번들을 슬롯에 둔다
  await q.putBundle(await makeQBundle(vd, { Qx: qd.publicKey, seq: 1, ...qbundleWindow(NOW) }));
  const bundle = verifyQBundle((await q.getBundle())!, vd.publicKey, { now: NOW })!;
  assert.ok(bundle);
  let seq = 10;
  const outbox = new MemOutbox();
  const sink = new MemSink();
  const receive = new ReceiveQueue(sink, {}, () => NOW);
  let seqMax = 0;
  const hpkeOpenVault = async (r: { enc: Uint8Array; ct: Uint8Array; info: Uint8Array; aad: Uint8Array }) => hpkeOpen(qd.secretKey, r.enc, r.info, r.aad, r.ct);
  const sleeps: number[] = [];
  const send = (now = NOW) =>
    import('@sax/remote').then((m) =>
      m.queueOutbox(outbox, { queue: q, pairId, vm, bundle, mbxEpoch, nextSeq: () => ++seq, now, sleep: async (ms) => void (sleeps.push(ms), relay.tick()) }),
    );
  const drain = (now = NOW) =>
    drainQueue({ queue: q, hpkeOpen: hpkeOpenVault, pairId, phoneVm: vm.publicKey, mbxEpoch, receive, seqMax: { get: async () => seqMax, set: async (s) => void (seqMax = s) }, now: () => now });
  const xfer = (o: Partial<Xfer> = {}): Xfer => {
    const iat = Math.floor(NOW / 1000);
    return { pair_id: pairId, from: 'mobile', to: 'desktop', seq: ++seq, iat, exp: iat + 3600, qbundle_seq: 1, type: 'cash.entry', body: makeCashEntry('2026-11-05', 1000, NOW), ...o };
  };
  const openOpts = { hpkeOpen: hpkeOpenVault, pairId, phoneVm: vm.publicKey, mbxEpoch, now: NOW };
  return { relay, q, vm, vd, qd, pairId, mbxEpoch, bundle, outbox, sink, receive, send, drain, xfer, openOpts, getSeqMax: () => seqMax, sleeps, lastSeq: () => seq };
}

async function addReceipt(outbox: MemOutbox, size: number, seed = 1) {
  const jpeg = fakeJpeg(size, seed);
  const offer = makeReceiptOffer(jpeg, { capturedAt: NOW, ocrEngine: 'none', ownerConfirmed: false, now: NOW });
  await outbox.put({ kind: 'receipt', msgId: offer.msgId, offer, createdAt: NOW, attempts: 0 }, jpeg);
  return { jpeg, offer };
}

describe('큐 전송(라이브 없음)', () => {
  it('사진·현금매출이 큐를 거쳐 PC에 저장되고, ack 뒤 릴레이에서 지워진다', async () => {
    const t = await world();
    const { jpeg, offer } = await addReceipt(t.outbox, QUEUE.chunk * 2 + 5);
    const cash = makeCashEntry('2026-11-05', 52000, NOW);
    await enqueueCash(t.outbox, cash, NOW);
    const r = await t.send();
    assert.deepEqual(r.queued.sort(), [offer.msgId, cash.msgId].sort());
    assert.equal(t.relay.envs.length, 1 + 3 + 1, 'offer + 청크 3 + 현금');
    // 릴레이에는 바깥 객체만: 평문 필드가 보이지 않는다
    for (const { env } of t.relay.envs) assert.deepEqual(Object.keys(env).sort(), ['ct', 'enc', 'kind', 'v']);
    assert.ok(!JSON.stringify(t.relay.envs).includes(t.pairId));
    // 헤더: 쓰기는 X-Mbx-Write, 읽기는 X-Mbx-Read, 모두 DPoP, 공개 origin
    assert.ok(t.relay.seen.every((s) => s.url.startsWith('https://tax.laf-co.com/v1/mailboxes/')));
    assert.ok(t.relay.seen.filter((s) => s.url.endsWith('/envelopes') && s.method === 'POST').every((s) => s.headers['X-Mbx-Write'] && !s.headers['X-Mbx-Read']));

    const d = await t.drain();
    assert.equal(d.handled, 5);
    assert.equal(t.sink.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
    assert.equal(t.sink.cash.get(cash.msgId)?.amount, 52000);
    assert.equal(t.relay.envs.length, 0);
    // 폰은 큐에 넣은 기록을 남겨 두고(라이브 ack가 없으므로) TTL 안에서는 다시 넣지 않는다
    assert.equal(t.outbox.items.get(offer.msgId)?.queuedAt, NOW);
    const again = await t.send(NOW + 1000);
    assert.deepEqual(again.queued, []);
    assert.equal(t.relay.envs.length, 0);
  });

  it('4 MiB 사진은 봉투 129개, 릴레이 한도(160·6 MiB·ct 65,536자) 안에 든다', async () => {
    const t = await world();
    const { jpeg, offer } = await addReceipt(t.outbox, 4 * 1024 * 1024, 3);
    const r = await t.send();
    assert.deepEqual(r.queued, [offer.msgId]);
    assert.equal(t.relay.envs.length, 129);
    assert.ok(t.relay.bytes <= QUEUE.maxBytes, `${t.relay.bytes}`);
    assert.ok(Math.max(...t.relay.envs.map((e) => e.env.ct.length)) <= QUEUE.ctMaxChars);
    await t.drain();
    assert.equal(t.sink.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
  });

  it('패딩: 모든 봉투가 버킷 크기로만 보인다', async () => {
    const t = await world();
    await addReceipt(t.outbox, 777);
    await enqueueCash(t.outbox, makeCashEntry('2026-11-05', 1, NOW), NOW);
    await t.send();
    const sizes = new Set(t.relay.envs.map((e) => Buffer.from(e.env.ct, 'base64').length - 16));
    for (const s of sizes) assert.ok((ENV_PAD_BUCKETS as readonly number[]).includes(s), `${s}`);
  });

  it('큐가 차면 남은 항목은 다음으로 미루고, 비워진 뒤 보낸다', async () => {
    const t = await world();
    const a = await addReceipt(t.outbox, 4 * 1024 * 1024, 1);
    const b = await addReceipt(t.outbox, 4 * 1024 * 1024, 2);
    await t.outbox.put({ ...t.outbox.items.get(b.offer.msgId)!, createdAt: NOW + 1 });
    const r = await t.send();
    assert.deepEqual(r.queued, [a.offer.msgId]);
    assert.deepEqual(r.waiting, [b.offer.msgId]);
    assert.equal(t.outbox.items.get(b.offer.msgId)?.queuedAt, undefined);
    await t.drain();
    const r2 = await t.send(NOW + 60_000);
    assert.deepEqual(r2.queued, [b.offer.msgId]);
    await t.drain(NOW + 60_000);
    assert.equal(t.sink.receipts.size, 2);
  });

  it('TTL이 지나면 다시 넣고(PC는 msgId로 중복을 없앤다), 보관 기한이 지나면 지운다', async () => {
    const t = await world();
    const cash = makeCashEntry('2026-11-05', 9, NOW);
    await enqueueCash(t.outbox, cash, NOW);
    await t.send();
    await t.drain();
    const later = NOW + QUEUE.ttlMs;
    // 번들이 7일짜리라 시험 시각 안에서 유효하다
    const r = await t.send(later);
    assert.deepEqual(r.queued, [cash.msgId]);
    assert.equal(t.outbox.items.get(cash.msgId)?.firstQueuedAt, NOW);
    const d = await t.drain(later);
    assert.equal(d.handled, 1);
    assert.equal(t.sink.cash.size, 1);
    const r3 = await t.send(NOW + QUEUE.keepMs).catch((e: Error) => e);
    // 번들 만료(7일) 뒤에는 봉인하지 않는다
    assert.ok(r3 instanceof Error);
    // 보관 기한이 지난 항목은 지운다(새 번들로)
    const fresh = verifyQBundle(await makeQBundle(t.vd, { Qx: t.qd.publicKey, seq: 2, ...qbundleWindow(NOW + QUEUE.keepMs) }), t.vd.publicKey, { now: NOW + QUEUE.keepMs })!;
    const { queueOutbox } = await import('@sax/remote');
    const r4 = await queueOutbox(t.outbox, { queue: t.q, pairId: t.pairId, vm: t.vm, bundle: fresh, mbxEpoch: t.mbxEpoch, nextSeq: () => 999, now: NOW + QUEUE.keepMs });
    assert.deepEqual(r4.expired, [cash.msgId]);
    assert.equal(t.outbox.items.size, 0);
  });
});

describe('24시간 뒤 다시 넣은 사진(팀장 결정 ④: PC가 한 장만)', () => {
  it('같은 msgId로 다시 오므로 offer 단계에서 거르고 저장을 다시 부르지 않는다', async () => {
    const t = await world();
    const { jpeg, offer } = await addReceipt(t.outbox, QUEUE.chunk * 3 + 9);
    await t.send();
    await t.drain();
    assert.equal(t.sink.storeCalls, 1);
    const later = NOW + QUEUE.ttlMs;
    const r = await t.send(later);
    assert.deepEqual(r.queued, [offer.msgId]);
    assert.equal(t.relay.envs.length, 1 + 4, '다시 넣은 offer + 청크 4');
    const d = await t.drain(later);
    assert.equal(d.handled, 5);
    assert.equal(t.sink.storeCalls, 1, '두 번째 저장 없음');
    assert.equal(t.sink.receipts.size, 1);
    assert.equal(t.sink.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
    assert.equal(t.receive.assembling, 0, '조립 버퍼도 남지 않는다');
    assert.equal(t.relay.envs.length, 0);
  });
});

describe('PC 검사(조용히 버린다)', () => {
  it('재생(같은 seq 이하)은 버리고 ack는 한다', async () => {
    const t = await world();
    const e = await sealXfer(t.xfer(), t.vm, t.bundle.Qx, t.mbxEpoch);
    await t.q.post(e);
    await t.q.post(e);
    const d = await t.drain();
    assert.deepEqual([d.handled, d.dropped], [1, 1]);
    assert.equal(t.relay.envs.length, 0);
    assert.equal(t.getSeqMax(), 11);
  });

  it('다른 Vm·다른 pair·다른 epoch·만료·미래 iat·변조는 열지 않는다', async () => {
    const t = await world();
    const other = softSigner(ed25519Keygen().secretKey, VM_PURPOSES);
    const iat = Math.floor(NOW / 1000);
    assert.ok(await openXfer(await sealXfer(t.xfer(), t.vm, t.bundle.Qx, t.mbxEpoch), t.openOpts));
    assert.equal(await openXfer(await sealXfer(t.xfer(), other, t.bundle.Qx, t.mbxEpoch), t.openOpts), null);
    assert.equal(await openXfer(await sealXfer(t.xfer({ pair_id: ulid(NOW + 5) }), t.vm, t.bundle.Qx, t.mbxEpoch), t.openOpts), null);
    assert.equal(await openXfer(await sealXfer(t.xfer(), t.vm, t.bundle.Qx, t.mbxEpoch + 1), t.openOpts), null);
    assert.equal(await openXfer(await sealXfer(t.xfer({ iat: iat - 7200, exp: iat - 1 }), t.vm, t.bundle.Qx, t.mbxEpoch), t.openOpts), null);
    assert.equal(await openXfer(await sealXfer(t.xfer({ iat: iat + 3600, exp: iat + 7200 }), t.vm, t.bundle.Qx, t.mbxEpoch), t.openOpts), null);
    const e = await sealXfer(t.xfer(), t.vm, t.bundle.Qx, t.mbxEpoch);
    const ct = Buffer.from(e.ct, 'base64');
    ct[5] ^= 1;
    assert.equal(await openXfer({ ...e, ct: b64(ct) }, t.openOpts), null);
    assert.equal(await openXfer({ ...e, extra: 1 }, t.openOpts), null);
    assert.equal(await openXfer(null, t.openOpts), null);
    // 다른 Q_D로 봉인
    assert.equal(await openXfer(await sealXfer(t.xfer(), t.vm, x25519Keygen().publicKey, t.mbxEpoch), t.openOpts), null);
  });

  it('봉인 쪽도 잘못된 바디·24시간 넘는 exp를 거부한다', async () => {
    const t = await world();
    const iat = Math.floor(NOW / 1000);
    await assert.rejects(sealXfer(t.xfer({ exp: iat + 86401 }), t.vm, t.bundle.Qx, t.mbxEpoch));
    await assert.rejects(sealXfer(t.xfer({ body: { msgId: 'x' } as unknown as CashEntryBody }), t.vm, t.bundle.Qx, t.mbxEpoch));
    // 서명 용도는 SAX-env-v1
    assert.equal(CTX.env, 'SAX-env-v1');
  });
});

/** FakeRelay와 같은 규칙으로 쪽마다 봉투 수를 센다(봉투 하나는 언제나). */
function pageSplit(sizes: number[], pageBytes: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < sizes.length; ) {
    let n = 0;
    let bytes = 0;
    while (i + n < sizes.length && (n === 0 || bytes + sizes[i + n]! <= pageBytes)) bytes += sizes[i + n++]!;
    out.push(n);
    i += n;
  }
  return out;
}

describe('큐 쪽 나누기(#204: 3 MiB·more)', () => {
  it('more를 보고 ack 뒤 곧바로 다음 쪽을 읽어 한 번에 비운다', async () => {
    const t = await world();
    const { jpeg, offer } = await addReceipt(t.outbox, QUEUE.chunk * 5 + 7, 4);
    const cash = makeCashEntry('2026-11-05', 1000, NOW);
    await enqueueCash(t.outbox, cash, NOW);
    await t.send();
    assert.equal(t.relay.envs.length, 1 + 6 + 1);
    // 한 쪽에 사진 조각 둘쯤만 들어가게 줄인다
    t.relay.pageBytes = Math.max(...t.relay.envs.map((e) => e.size)) * 2;
    const split = pageSplit(t.relay.envs.map((e) => e.size), t.relay.pageBytes);
    assert.ok(split.length >= 3, `${split}`);
    const acks = () => t.relay.seen.filter((x) => x.url.endsWith('/ack')).length;
    const d = await t.drain();
    assert.equal(d.handled, 8);
    assert.equal(d.more, false);
    assert.equal(d.pages, split.length);
    assert.equal(acks(), split.length, '쪽마다 ack');
    assert.equal(t.relay.envs.length, 0);
    assert.equal(t.sink.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
    assert.equal(t.sink.cash.get(cash.msgId)?.amount, 1000);
    // ack 뒤 다시 읽으므로 after 쿼리를 쓰지 않는다
    assert.ok(t.relay.seen.filter((x) => x.method === 'GET' && x.url.includes('/envelopes')).every((x) => x.url.endsWith('/envelopes')));
  });

  it('4 MiB 사진(봉투 129개)은 3 MiB 쪽 둘로 나뉘어도 한 번 드레인으로 모두 받는다', async () => {
    const t = await world();
    const { jpeg, offer } = await addReceipt(t.outbox, 4 * 1024 * 1024, 5);
    await t.send();
    const d = await t.drain();
    assert.equal(d.pages, 2);
    assert.equal(d.handled, 129);
    assert.equal(t.relay.envs.length, 0);
    assert.equal(t.sink.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
  });

  it('중간 쪽 GET이 실패하면 앞쪽은 ack된 채로 던지고, 다음 드레인이 나머지를 받는다(한 장만 저장)', async () => {
    const t = await world();
    const { jpeg, offer } = await addReceipt(t.outbox, QUEUE.chunk * 5 + 7, 6);
    await t.send();
    t.relay.pageBytes = Math.max(...t.relay.envs.map((e) => e.size)) * 3;
    const first = pageSplit(t.relay.envs.map((e) => e.size), t.relay.pageBytes)[0]!;
    assert.ok(first < 7);
    t.relay.failGetAfter = 1;
    await assert.rejects(() => t.drain(), /queue: list 500/);
    assert.equal(t.relay.envs.length, 7 - first, '첫 쪽은 ack로 지워졌다');
    assert.equal(t.getSeqMax() > 0, true);
    assert.equal(t.sink.storeCalls, 0, '조각이 다 오기 전에는 저장하지 않는다');
    t.relay.failGetAfter = Infinity;
    const d = await t.drain();
    assert.equal(d.handled, 7 - first);
    assert.equal(d.more, false);
    assert.equal(t.relay.envs.length, 0);
    assert.equal(t.sink.storeCalls, 1);
    assert.equal(t.sink.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
  });

  // 서버가 이상할 때: drainQueue에 가짜 쪽을 직접 준다(연 봉투는 없어도 seq·ack 흐름만 본다).
  const base = async () => {
    const t = await world();
    return { hpkeOpen: t.openOpts.hpkeOpen, pairId: t.pairId, phoneVm: t.vm.publicKey, mbxEpoch: t.mbxEpoch, receive: t.receive, seqMax: { get: async () => 0, set: async () => {} } };
  };

  it('more인데 빈 쪽이면 한 번 읽고 멈춘다(more: true, ack 없음)', async () => {
    const acked: number[] = [];
    let reads = 0;
    const d = await drainQueue({
      ...(await base()),
      queue: { list: async () => [], listPage: async () => (reads++, { envelopes: [], more: true }), ack: async (n) => void acked.push(n) },
    });
    assert.deepEqual({ pages: d.pages, more: d.more, ackedTo: d.ackedTo }, { pages: 1, more: true, ackedTo: null });
    assert.equal(reads, 1);
    assert.deepEqual(acked, []);
  });

  it('ack를 무시하고 같은 쪽을 다시 주면 진전 없음으로 멈춘다', async () => {
    const acked: number[] = [];
    const page = { envelopes: [{ seq: 1, env: { bad: true } }, { seq: 2, env: { bad: true } }], more: true };
    const d = await drainQueue({ ...(await base()), queue: { list: async () => page.envelopes, listPage: async () => page, ack: async (n) => void acked.push(n) } });
    assert.equal(d.pages, 2);
    assert.equal(d.more, true);
    assert.equal(d.dropped, 4, '모양이 틀린 봉투는 열지 않고 버린다');
    assert.deepEqual(acked, [2, 2]);
  });

  it('서버가 more를 끝없이 주어도 DRAIN_MAX_PAGES 쪽에서 멈춘다', async () => {
    let next = 0;
    const acked: number[] = [];
    const d = await drainQueue({
      ...(await base()),
      queue: { list: async () => [], listPage: async () => ({ envelopes: [{ seq: ++next, env: {} }], more: true }), ack: async (n) => void acked.push(n) },
    });
    assert.equal(d.pages, DRAIN_MAX_PAGES);
    assert.equal(d.more, true);
    assert.equal(acked.length, DRAIN_MAX_PAGES);
    assert.equal(d.ackedTo, DRAIN_MAX_PAGES);
  });

  it('listPage가 없는 옛 큐(list만)는 한 쪽만 읽는다', async () => {
    let reads = 0;
    const d = await drainQueue({ ...(await base()), queue: { list: async () => (reads++, [{ seq: 1, env: {} }]), ack: async () => {} } });
    assert.equal(reads, 1);
    assert.deepEqual(d, { handled: 0, dropped: 1, ackedTo: 1 }, '옛 결과 모양 그대로(pages·more 없음)');
  });

  it('listPage(after): 쿼리는 요청 URL에만, DPoP htu는 쿼리 없는 경로. more가 없는 옛 응답은 한 쪽', async () => {
    const relay = new FakeRelay();
    const htus: string[] = [];
    const q = relayQueue({
      http: relay.http, origin: 'https://tax.laf-co.com', mbxId: new Uint8Array(16).fill(7), tok: { read: new Uint8Array(32).fill(1), write: new Uint8Array(32).fill(2) },
      deviceAuth: async (_m, htu) => (htus.push(htu), { Authorization: 'DPoP t', DPoP: 'proof' }),
    });
    await q.listPage(5);
    assert.ok(relay.seen.at(-1)!.url.endsWith('/envelopes?after=5'));
    assert.ok(htus.at(-1)!.endsWith('/envelopes'));
    await assert.rejects(() => q.listPage(-1), /bad after/);
    await assert.rejects(() => q.listPage(1.5), /bad after/);
    const old = relayQueue({ http: async () => ({ status: 200, body: { envelopes: [{ seq: 1, env: {} }] } }), origin: 'https://x', mbxId: new Uint8Array(16), tok: { read: new Uint8Array(32), write: new Uint8Array(32) }, deviceAuth: async () => ({}) });
    assert.deepEqual(await old.listPage(), { envelopes: [{ seq: 1, env: {} }], more: false });
  });
});

describe('우편함 초당 한도(429 policy.rate_limited)', () => {
  it('4 MiB 사진(봉투 129개)도 1초씩 기다리며 같은 봉투를 다시 보내 한 번에 큐에 넣는다', async () => {
    const t = await world();
    t.relay.ratePerWindow = 20;
    const { jpeg, offer } = await addReceipt(t.outbox, 4 * 1024 * 1024, 7);
    const cash = makeCashEntry('2026-11-05', 1000, NOW);
    await enqueueCash(t.outbox, cash, NOW);
    const startSeq = t.lastSeq();
    const r = await t.send();
    assert.deepEqual(r.queued.sort(), [offer.msgId, cash.msgId].sort());
    assert.deepEqual(r.waiting, []);
    assert.equal(t.relay.envs.length, 130);
    assert.equal(t.sleeps.length, Math.ceil(130 / 20) - 1, '창마다 한 번 기다림');
    assert.ok(t.sleeps.every((ms) => ms === QUEUE.rateWaitMs));
    assert.equal(t.lastSeq() - startSeq, 130, '다시 보낸 봉투는 새 seq를 쓰지 않는다');
    const d = await t.drain();
    assert.equal(d.handled, 130);
    assert.equal(t.sink.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
    assert.equal(t.sink.cash.get(cash.msgId)?.amount, 1000);
  });

  it('기다려도 풀리지 않으면 rateRetries번 뒤 멈추고 남은 항목은 다음으로 미룬다', async () => {
    const t = await world();
    t.relay.ratePerWindow = 2;
    t.relay.tick = () => void t.relay.windows++; // 창이 넘어가지 않는 서버
    const { offer } = await addReceipt(t.outbox, QUEUE.chunk * 4, 8);
    const cash = makeCashEntry('2026-11-05', 1000, NOW);
    await enqueueCash(t.outbox, cash, NOW + 1);
    const r = await t.send();
    assert.deepEqual(r.queued, []);
    assert.deepEqual(r.waiting.sort(), [offer.msgId, cash.msgId].sort(), '현금매출도 이번에는 보내지 않는다');
    assert.equal(t.sleeps.length, QUEUE.rateRetries);
    assert.equal(t.relay.envs.length, 2);
  });

  it('relayQueue.post: 429 policy.rate_limited → rate, relay.queue_full → full, 그 밖 → failed', async () => {
    const mk = (status: number, body: unknown) =>
      relayQueue({ http: async () => ({ status, body }), origin: 'https://x', mbxId: new Uint8Array(16), tok: { read: new Uint8Array(32), write: new Uint8Array(32) }, deviceAuth: async () => ({}) });
    const e = { v: 1, kind: 'ENV', enc: 'a', ct: 'b' } as OuterEnv;
    assert.equal(await mk(202, { seq: 1 }).post(e), 'ok');
    assert.equal(await mk(429, { error: 'policy.rate_limited' }).post(e), 'rate');
    assert.equal(await mk(429, { error: 'relay.queue_full' }).post(e), 'full');
    assert.equal(await mk(500, { error: 'internal' }).post(e), 'failed');
  });
});
