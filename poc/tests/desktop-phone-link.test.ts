import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  CAP, MemoryRelay, b64, deriveShareKey, deriveShareSignSeed, ed25519Public, makeShareKeyBody, randomBytes, readShareKeyBody, enqueueCash, flushOutbox, fromB64, hpkeOpen, makeCashEntry, makeReceiptOffer, monotonicClock, newFileKey, openMobileSession, openOutboxFile,
  queueOutbox, sealOutboxFile, sha256Hash, toHex, verifyQBundle, x25519Keygen,
  type Link, type OuterEnv, type OutboxItem, type OutboxStore, type RelayLink, type ShareKeyBody,
} from '@sax/remote';
import { LIVE_BACKOFF, PhoneLink, PhoneStore, packTok, unpackTok, type PhoneLinkOptions, type TokenSeal } from '../apps/desktop/src/phone-link.ts';
import { closeAction, shouldStartPhones, shouldStayAwake, StayAwake } from '../apps/desktop/src/phone-presence.ts';
import { phoneReceiver } from '../apps/desktop/src/phone-receive.ts';
import { fakeJpeg, pairOnce, pairWorld, until } from './remote-support.ts';

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

class MemQueue {
  envs: { seq: number; env: OuterEnv }[] = [];
  seq = 0;
  bundle: string | null = null;
  bundlePuts = 0;
  async post(e: OuterEnv) {
    this.envs.push({ seq: ++this.seq, env: JSON.parse(JSON.stringify(e)) as OuterEnv });
    return 'ok' as const;
  }
  async list() {
    return this.envs.map((x) => ({ ...x }));
  }
  async listPage() {
    return { envelopes: await this.list(), more: false };
  }
  async ack(seq: number) {
    this.envs = this.envs.filter((x) => x.seq > seq);
  }
  async putBundle(b: string) {
    this.bundle = b;
    this.bundlePuts++;
  }
}

function fakeEngine() {
  const receipts = new Map<string, string>();
  const cash: { day: string; amount: number }[] = [];
  const rpc = async (m: string, p: Record<string, unknown>) => {
    if (m === 'receipt.phoneHas') return { has: receipts.has(p.msgId as string) };
    if (m === 'receipt.phoneStore') {
      const dup = receipts.has(p.msgId as string);
      receipts.set(p.msgId as string, toHex(sha256Hash(p.jpeg as Uint8Array)));
      return { docId: `doc-${p.msgId as string}`, duplicate: dup };
    }
    if (m === 'cash.phonePut') {
      cash.push({ day: p.day as string, amount: p.amount as number });
      return { applied: true };
    }
    throw new Error('unknown');
  };
  return { rpc, receipts, cash };
}

const asRelayLink = (l: Link): RelayLink => Object.assign(l, { onEnv() {}, closeCode: null }) as unknown as RelayLink;
const seal: TokenSeal = { seal: (p) => `sealed:${b64(p.map((x) => x ^ 0x5a))}`, open: (s) => fromB64(s.slice(7)).map((x) => x ^ 0x5a) };

let dirs: string[] = [];
let links: PhoneLink[] = [];
afterEach(async () => {
  for (const l of links) {
    l.stop();
    await l.idle();
  }
  links = [];
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  dirs = [];
});

async function world(o: { mailboxKeepsPeer?: boolean } = {}) {
  const relay = new MemoryRelay(o);
  const w = await pairWorld({ relay });
  const { pc, phone } = await pairOnce(w);
  pc.channel.close();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-link-'));
  dirs.push(dir);
  const file = path.join(dir, 'remote-phones.json');
  const qd = x25519Keygen();
  const queues = new Map<string, MemQueue>();
  const queueOf = (id: Uint8Array) => {
    const k = b64(id);
    let q = queues.get(k);
    if (!q) queues.set(k, (q = new MemQueue()));
    return q;
  };
  const eng = fakeEngine();
  const deleted: string[] = [];
  const mk = (live = true, over: Partial<PhoneLinkOptions> = {}) => {
    const l = new PhoneLink({
      store: new PhoneStore(file),
      seal,
      keys: async () => ({ noise: w.desk.keys.noise, vd: w.desk.keys.vd, qdPublic: qd.publicKey, hpkeOpen: async (r) => hpkeOpen(qd.secretKey, r.enc, r.info, r.aad, r.ct) }),
      joinMailbox: live ? async (id, tok) => asRelayLink(await relay.joinMailbox(id, tok, 'desktop')) : undefined,
      queue: (id) => queueOf(id),
      receiver: () => phoneReceiver(eng.rpc),
      deleteMailbox: async (id) => void deleted.push(b64(id)),
      deviceListVersion: () => 2,
      appVersion: 'test',
      pollMs: { live: 60_000, idle: 60_000 },
      ...over,
    });
    links.push(l);
    return l;
  };
  return { w, relay, pc, phone, file, qd, queueOf, eng, deleted, mk };
}

describe('PC 폰 수신(phone-link)', () => {
  it('페어링 결과를 보관하고(토큰은 봉인만), 라이브 IK 세션으로 사진·현금을 받아 엔진에 넘긴다', async () => {
    const x = await world();
    const link = x.mk();
    await link.start();
    await link.add(x.pc);
    const raw = await fs.readFile(x.file, 'utf8');
    assert.ok(!raw.includes(b64(x.pc.tokRead)) && !raw.includes(b64(x.pc.tokWrite)), '토큰 원문 없음');
    if (process.platform !== 'win32') assert.equal((await fs.stat(x.file)).mode & 0o777, 0o600, 'POSIX 권한(Windows는 사용자 폴더 ACL)');
    const rec = JSON.parse(raw).phones[0];
    assert.equal(rec.mbxId, b64(x.pc.mbxId));
    assert.equal(rec.name, x.w.phone.keys.name);
    assert.deepEqual(unpackTok(seal.open(rec.tok)), { read: x.pc.tokRead, write: x.pc.tokWrite });
    await until(() => x.queueOf(x.pc.mbxId).bundle !== null);
    const bundle = verifyQBundle(x.queueOf(x.pc.mbxId).bundle!, x.w.desk.keys.vd.publicKey, { now: Date.now() });
    assert.ok(bundle && toHex(bundle.Qx) === toHex(x.qd.publicKey));

    await until(() => x.relay.observed.length >= 0 && link.list().length === 1);
    await new Promise((r) => setTimeout(r, 20));
    const phLink = await x.relay.joinMailbox(fromB64(x.phone.mbxId), { read: fromB64(x.phone.tokRead), write: fromB64(x.phone.tokWrite) }, 'mobile');
    const sess = await openMobileSession(phLink, {
      pairId: x.phone.pairId, noise: x.w.phone.keys.noise, desktopStatic: x.phone.desktopStatic, nextTimestamp: monotonicClock(0),
      hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [CAP.receipt, CAP.cash] },
    });
    assert.ok(sess, '세션');
    assert.ok(sess.peerHello.capabilities.includes(CAP.receipt));
    const outbox = new MemOutbox();
    const jpeg = fakeJpeg(150_000);
    const offer = makeReceiptOffer(jpeg, { capturedAt: Date.now(), ocrEngine: 'none', ownerConfirmed: false });
    await outbox.put({ kind: 'receipt', msgId: offer.msgId, offer, createdAt: Date.now(), attempts: 0 }, jpeg);
    await enqueueCash(outbox, makeCashEntry('2026-11-15', 120_000));
    const res = await flushOutbox(sess.channel, outbox, { pace: async () => {}, ackTimeoutMs: 2000, maxRounds: 3 });
    assert.equal(outbox.items.size, 0, `보관함이 비었다 ${JSON.stringify(res)}`);
    assert.equal(x.eng.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
    assert.deepEqual(x.eng.cash, [{ day: '2026-11-15', amount: 120_000 }]);
    await until(() => link.list()[0]!.online);
    assert.ok(link.list()[0]!.lastSeenAt);
    assert.ok(JSON.parse(await fs.readFile(x.file, 'utf8')).phones[0].ikTsMax > 0);
    sess.channel.close();
    phLink.close();
    link.stop();
  });

  it('PC가 꺼져 있던 동안 큐에 쌓인 봉투를 다시 켤 때 비운다(파일에서 복원, 중복 seq는 버림)', async () => {
    const x = await world();
    const first = x.mk(false);
    await first.start();
    await first.add(x.pc);
    await until(() => x.queueOf(x.pc.mbxId).bundle !== null);
    for (let i = 0; ; i++) {
      let ok = false;
      try {
        ok = JSON.parse(readFileSync(x.file, 'utf8')).phones[0]?.qbundleValidTo > 0;
      } catch {
        /* 쓰는 중 */
      }
      if (ok) break;
      assert.ok(i < 100, '번들 기간이 파일에 남는다');
      await new Promise((r) => setTimeout(r, 50));
    }
    first.stop();
    const q = x.queueOf(fromB64(x.phone.mbxId));
    const bundle = verifyQBundle(q.bundle!, x.w.desk.keys.vd.publicKey, { now: Date.now() })!;
    const outbox = new MemOutbox();
    const jpeg = fakeJpeg(60_000, 3);
    const offer = makeReceiptOffer(jpeg, { capturedAt: Date.now(), ocrEngine: 'none', ownerConfirmed: true });
    await outbox.put({ kind: 'receipt', msgId: offer.msgId, offer, createdAt: Date.now(), attempts: 0 }, jpeg);
    await enqueueCash(outbox, makeCashEntry('2026-11-14', 33_000));
    let seq = 0;
    await queueOutbox(outbox, { queue: q, pairId: x.phone.pairId, vm: x.w.phone.vm, bundle, mbxEpoch: x.phone.mbxEpoch, nextSeq: () => ++seq });
    assert.ok(q.envs.length > 0);
    q.envs.push({ seq: ++q.seq, env: q.envs[0]!.env });

    const second = x.mk(false);
    await second.start();
    await until(() => x.eng.receipts.has(offer.msgId) && x.eng.cash.length === 1);
    assert.equal(x.eng.receipts.get(offer.msgId), toHex(sha256Hash(jpeg)));
    await until(() => q.envs.length === 0);
    assert.equal(x.eng.cash.length, 1, '중복 seq는 엔진에 가지 않는다');
    assert.ok(JSON.parse(await fs.readFile(x.file, 'utf8')).phones[0].asyncSeqMax >= seq);
    assert.equal(q.bundlePuts, 1, '유효한 번들은 다시 올리지 않는다');
    second.stop();
  });

  it('우편함 지우기가 실패하면 기록은 지우고, 지울 일을 남겨 다음에 켤 때 다시 지운다(폰 자리도 같이, 2026-11-19)', async () => {
    const x = await world();
    const calls: Array<{ id: string; peer?: string }> = [];
    let fail = true;
    const del = async (id: Uint8Array, _w: Uint8Array, peer?: string) => {
      calls.push({ id: b64(id), peer });
      if (fail) throw Object.assign(new Error('net'), { code: 'net.offline' });
    };
    const link = x.mk(false, { deleteMailbox: del });
    await link.start();
    await link.add(x.pc);
    assert.equal(await link.remove(x.pc.pairId), true);
    assert.equal(link.list().length, 0, '목록에서는 빠진다');
    assert.deepEqual(calls, [{ id: b64(x.pc.mbxId), peer: x.pc.phone.deviceId }], '폰 기기 ID를 같이 알린다(릴레이가 자리를 비운다)');
    const saved = JSON.parse(await fs.readFile(x.file, 'utf8'));
    assert.equal(saved.trash.length, 1);
    assert.ok(!JSON.stringify(saved.trash).includes(b64(x.pc.tokWrite)), '토큰은 봉인된 채');
    link.stop();
    fail = false;
    const again = x.mk(false, { deleteMailbox: del });
    await again.start();
    await until(() => calls.length === 2);
    await until(() => !JSON.parse(readFileSync(x.file, 'utf8')).trash);
    assert.deepEqual(calls[1], { id: b64(x.pc.mbxId), peer: x.pc.phone.deviceId });
  });

  it('연결 해제는 우편함을 지우고 기록을 없앤다. 같은 폰을 다시 연결하면 옛 기록을 바꾼다', async () => {
    const x = await world();
    const link = x.mk(false);
    await link.start();
    await link.add(x.pc);
    await link.add({ ...x.pc, pairId: 'p2' });
    assert.deepEqual(link.list().map((p) => p.pairId), ['p2']);
    assert.equal(await link.remove('p2'), true);
    assert.deepEqual(x.deleted, [b64(x.pc.mbxId)]);
    assert.equal(link.list().length, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(x.file, 'utf8')).phones, []);
    assert.equal(await link.remove('p2'), false);
    x.deleted.length = 0;
    await link.add({ ...x.pc, pairId: 'p3' });
    const mbx2 = new Uint8Array(32).fill(9);
    await link.add({ ...x.pc, pairId: 'p4', mbxId: mbx2 });
    await until(() => x.deleted.length === 1);
    assert.deepEqual(x.deleted, [b64(x.pc.mbxId)]);
    assert.deepEqual(link.list().map((p) => p.pairId), ['p4']);
    link.stop();
  });

  it('토큰 묶음 형식과 깨진 파일', async () => {
    assert.throws(() => packTok(new Uint8Array(31), new Uint8Array(32)));
    assert.throws(() => unpackTok(new Uint8Array(63)));
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phone-link-'));
    dirs.push(dir);
    const f = path.join(dir, 'remote-phones.json');
    await fs.writeFile(f, '{not json');
    assert.deepEqual(await new PhoneStore(f).load(), []);
    await fs.writeFile(f, JSON.stringify({ v: 1, phones: [{ pairId: 'x' }] }));
    assert.deepEqual(await new PhoneStore(f).load(), [], '모양이 틀린 기록은 버린다');
  });

  it('라이브 재연결: 1초부터 두 배, 30초 상한(집에 둔 PC가 밖의 폰에 늦어도 30초 안에 다시 붙는다)', async () => {
    const x = await world();
    const waits: number[] = [];
    let joins = 0;
    const link = x.mk(true, {
      joinMailbox: async () => {
        joins++;
        throw Object.assign(new Error('down'), { code: 'relay.down' });
      },
      sleep: (ms, signal) => (ms === 60_000 ? new Promise((r) => signal.addEventListener('abort', () => r(), { once: true })) : (waits.push(ms), new Promise((r) => setTimeout(r, 1)))),
    });
    await link.start();
    await link.add(x.pc);
    await until(() => joins >= 9);
    assert.deepEqual(waits.slice(0, 8), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
    assert.equal(LIVE_BACKOFF.maxMs, 30_000);
    link.stop();
  });

  it('wake: 깨어나면 재시도 대기를 끊고 백오프를 처음으로, resume이면 열린(죽었을) 연결도 새로 붙는다', async () => {
    const x = await world();
    const waits: number[] = [];
    let joins = 0;
    let fail = true;
    const links: RelayLink[] = [];
    const hold = (signal: AbortSignal) => new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    const link = x.mk(true, {
      joinMailbox: async (id, tok) => {
        joins++;
        if (fail) throw Object.assign(new Error('down'), { code: 'relay.down' });
        const l = asRelayLink(await x.relay.joinMailbox(id, tok, 'desktop'));
        links.push(l);
        return l;
      },
      sleep: (ms, signal) => (ms === 60_000 ? hold(signal) : (waits.push(ms), fail ? hold(signal) : new Promise((r) => setTimeout(r, 1)))),
    });
    await link.start();
    await link.add(x.pc);
    await until(() => joins === 1 && waits.length === 1);
    link.wake('unlock');
    await until(() => joins === 2 && waits.length === 2);
    assert.deepEqual(waits, [1000, 1000], 'wake가 끊은 대기는 백오프를 늘리지 않는다');
    fail = false;
    link.wake('unlock');
    await until(() => links.length === 1);
    assert.equal(links[0]!.closed, false);
    link.wake('unlock');
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(links[0]!.closed, false, 'unlock은 살아 있는 연결을 그대로 둔다');
    link.wake('resume');
    assert.equal(links[0]!.closed, true);
    await until(() => links.length === 2);
    assert.equal(links[1]!.closed, false);
    link.stop();
  });

  it('계정 공유 기록 열쇠(share.key): 폰이 share.v1을 알린 세션에만 주고, 세대가 오르면 연결된 폰에 다시 준다', async () => {
    const rk = randomBytes(32);
    let epochs = 1;
    let allow = true;
    const body = () => makeShareKeyBody({ signPub: ed25519Public(deriveShareSignSeed(rk)), keys: Array.from({ length: epochs }, (_, e) => deriveShareKey(rk, e)) });
    const setup = async (give: boolean, caps: string[]) => {
      const x = await world();
      const asked: string[] = [];
      const logs: Array<Record<string, unknown>> = [];
      const link = x.mk(true, {
        ...(give ? { shareKeys: async (deviceId: string) => (asked.push(deviceId), allow ? body() : null) } : {}),
        log: (n, d) => void (n === 'main.phone_live' && d?.step === 'share_key' && logs.push(d)),
      });
      await link.start();
      await link.add(x.pc);
      await until(() => link.list().length === 1);
      await new Promise((r) => setTimeout(r, 20));
      const phLink = await x.relay.joinMailbox(fromB64(x.phone.mbxId), { read: fromB64(x.phone.tokRead), write: fromB64(x.phone.tokWrite) }, 'mobile');
      const sess = await openMobileSession(phLink, {
        pairId: x.phone.pairId, noise: x.w.phone.keys.noise, desktopStatic: x.phone.desktopStatic, nextTimestamp: monotonicClock(0),
        hello: { appVersion: 'm', deviceListVersion: 2, capabilities: caps },
      });
      assert.ok(sess, '세션');
      await until(() => link.list()[0]!.online);
      const end = () => {
        sess.channel.close();
        phLink.close();
        link.stop();
      };
      return { x, link, sess, asked, logs, end };
    };
    const oldApp = await setup(true, [CAP.receipt, CAP.cash]);
    assert.ok(oldApp.sess.peerHello.capabilities.includes(CAP.share));
    assert.equal(await oldApp.sess.channel.recv(150), null);
    assert.deepEqual([oldApp.asked, await oldApp.link.pushShareKeys(), oldApp.logs], [[], 0, []]);
    oldApp.end();
    const plain = await setup(false, [CAP.share]);
    assert.ok(!plain.sess.peerHello.capabilities.includes(CAP.share));
    assert.equal(await plain.sess.channel.recv(150), null);
    plain.end();
    const a = await setup(true, [CAP.receipt, CAP.cash, CAP.share]);
    const first = await a.sess.channel.recv(2000);
    assert.equal(first?.type, 'share.key');
    const have = readShareKeyBody(first!.body as ShareKeyBody);
    assert.ok(have && have.keys.length === 1);
    assert.deepEqual(have.keys[0], deriveShareKey(rk, 0));
    assert.deepEqual(a.asked, [a.x.pc.phone.deviceId]);
    epochs = 2;
    assert.equal(await a.link.pushShareKeys(), 1);
    const second = await a.sess.channel.recv(2000);
    assert.equal(readShareKeyBody(second!.body as ShareKeyBody, have)?.keys.length, 2);
    allow = false;
    assert.equal(await a.link.pushShareKeys(), 0);
    assert.equal(await a.sess.channel.recv(150), null);
    assert.equal(a.sess.channel.closed, false);
    assert.deepEqual(a.logs.map((d) => [d.result, d.epochs]), [['sent', 1], ['sent', 2], ['none', undefined]]);
    assert.ok(!JSON.stringify(a.logs).includes(a.x.pc.phone.deviceId), '로그에 기기 id 없음');
    a.end();
    assert.equal(await a.link.pushShareKeys(), 0, '멈춘 뒤에는 보내지 않는다');
  });

  it('폰이 세션을 닫고 나갔다 다시 와도(60초마다 동기화) 새 세션을 받는다. 닫기 없이 사라졌다 와도 같다(2026-11-18 실기기: 첫 세션만 "PC 켜짐")', async () => {
    const x = await world({ mailboxKeepsPeer: true });
    const logs: string[] = [];
    const link = x.mk(true, { log: (n, d) => void (n === 'main.phone_live' && logs.push(String(d?.step))) });
    await link.start();
    await link.add(x.pc);
    await new Promise((r) => setTimeout(r, 20));
    let ts = 0;
    const open = async () => {
      const l = await x.relay.joinMailbox(fromB64(x.phone.mbxId), { read: fromB64(x.phone.tokRead), write: fromB64(x.phone.tokWrite) }, 'mobile');
      const s = await openMobileSession(l, {
        pairId: x.phone.pairId, noise: x.w.phone.keys.noise, desktopStatic: x.phone.desktopStatic, nextTimestamp: () => (ts = Math.max(Date.now(), ts + 1)),
        hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [CAP.receipt] }, responseTimeoutMs: 2_000,
      });
      return { l, s };
    };
    const a = await open();
    assert.ok(a.s, '첫 세션');
    a.s.channel.close();
    const b = await open();
    assert.ok(b.s, '닫고 나간 뒤 다시 온 폰의 세션');
    b.l.close();
    await until(() => logs.includes('peer_gone'));
    const c = await open();
    assert.ok(c.s, '닫기 없이 사라졌다 다시 온 폰의 세션');
    c.s.channel.close();
    await until(() => logs.filter((s) => s === 'session').length >= 3);
    assert.ok(logs.includes('closed_by_phone'), logs.join(','));
    link.stop();
  });

  it('지키기 전에 연결을 더해도 바로 우편함을 지킨다(2026-11-18 실기기: 기록만 저장되고 폰에 "PC 꺼짐")', async () => {
    const x = await world();
    const link = x.mk(true);
    await link.add(x.pc);
    assert.equal(link.list().length, 1);
    await new Promise((r) => setTimeout(r, 20));
    const phLink = await x.relay.joinMailbox(fromB64(x.phone.mbxId), { read: fromB64(x.phone.tokRead), write: fromB64(x.phone.tokWrite) }, 'mobile');
    const sess = await openMobileSession(phLink, {
      pairId: x.phone.pairId, noise: x.w.phone.keys.noise, desktopStatic: x.phone.desktopStatic, nextTimestamp: monotonicClock(0),
      hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [CAP.receipt] },
    });
    assert.ok(sess, '연결 직후 PC가 세션을 받는다');
    sess.channel.close();
    phLink.close();
    link.stop();
  });

  it('같은 실행에서 로그아웃 → 다시 로그인하면 저장된 폰을 다시 지킨다(전에는 앱을 다시 켤 때까지 폰에 "PC 꺼짐")', async () => {
    const x = await world();
    let running: PhoneLink | null = null;
    let signedIn = true;
    const onAccount = async () => {
      if (shouldStartPhones({ signedIn, running: !!running })) {
        running = x.mk(true);
        await running.start();
      }
    };
    await onAccount();
    await running!.add(x.pc);
    running!.stop();
    await running!.idle();
    running = null;
    signedIn = false;
    await onAccount();
    assert.equal(running, null, '로그아웃 중에는 켜지 않는다');
    signedIn = true;
    await onAccount();
    const again = running as PhoneLink | null;
    assert.ok(again, '다시 로그인하면 켠다');
    assert.equal(again.list().length, 1);
    assert.equal(again.list()[0]!.pairId, x.pc.pairId);
    await new Promise((r) => setTimeout(r, 20));
    const phLink = await x.relay.joinMailbox(fromB64(x.phone.mbxId), { read: fromB64(x.phone.tokRead), write: fromB64(x.phone.tokWrite) }, 'mobile');
    const sess = await openMobileSession(phLink, {
      pairId: x.phone.pairId, noise: x.w.phone.keys.noise, desktopStatic: x.phone.desktopStatic, nextTimestamp: monotonicClock(0),
      hello: { appVersion: 'm', deviceListVersion: 2, capabilities: [CAP.receipt] },
    });
    assert.ok(sess, '다시 로그인한 PC와 세션이 열린다');
    sess.channel.close();
    phLink.close();
    await onAccount();
    assert.equal(running, again);
    assert.equal(shouldStartPhones({ signedIn: true, running: true }), false);
    assert.equal(shouldStartPhones({ signedIn: false, running: false }), false);
    again.stop();
  });

  it('창 닫기·잠자기 규칙(phone-presence): 폰이 있을 때만 남고, 전원 연결 중에만 잠자기를 막는다', () => {
    assert.equal(closeAction({ phones: 0, quitting: false, platform: 'win32' }), 'quit');
    assert.equal(closeAction({ phones: 1, quitting: false, platform: 'win32' }), 'minimize');
    assert.equal(closeAction({ phones: 1, quitting: false, platform: 'darwin' }), 'hide');
    assert.equal(closeAction({ phones: 2, quitting: true, platform: 'darwin' }), 'quit', '메뉴 끝내기·업데이트 설치는 막지 않는다');
    assert.equal(shouldStayAwake({ phones: 1, onBattery: false }), true);
    assert.equal(shouldStayAwake({ phones: 1, onBattery: true }), false);
    assert.equal(shouldStayAwake({ phones: 0, onBattery: false }), false);
    const calls: string[] = [];
    const a = new StayAwake({ start: (t) => (calls.push(`start:${t}`), 7), stop: (id) => void calls.push(`stop:${id}`) });
    a.set(true);
    a.set(true);
    assert.ok(a.on);
    a.set(false);
    a.set(false);
    assert.deepEqual(calls, ['start:prevent-app-suspension', 'stop:7']);
  });
});
