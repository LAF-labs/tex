// 폰 사진·현금 수신 배선(phone-receive.ts, 데스크톱 ③c, D08 §6): 실제 ReceiveQueue(offer·chunk 조립) → main 싱크 → 엔진 명령 →
// 실제 PhoneIntake(@sax/bundle, #123)·DB. rpc 경계는 structuredClone으로 흉내 낸다(엔진 utilityProcess 메시지와 같다).
// 팀장 기준: "24시간 뒤 같은 msgId 재수신이면 영수증 1장, 고아 문서 0". 중복은 msgId로만.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PhoneIntake } from '@sax/bundle';
import { CashSalesRepo, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import { b64, makeCashEntry, makeReceiptOffer, RECEIPT_CHUNK, type Envelope } from '@sax/remote';
import { engineReceiveSink, offerParams, phoneReceiver, type EngineRpc } from '../apps/desktop/src/phone-receive.ts';

const T0 = Date.parse('2026-11-06T01:00:00.000Z');
const HOUR = 3_600_000;
let dir: string;
let vault: string;
let db: Db;
let profileId: string;
let clock = T0;

before(() => {
  dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-phone-recv-'));
  vault = path.join(dir, 'vault');
  db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  profileId = new ProfileRepo(db).upsert({ kind: 'business', displayName: '가게', bizNo: syntheticBizNo(41), corpNo: null, repName: null, bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
});
after(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const count = (sql: string) => db.prepare(sql).pluck().get() as number;
const state = () => ({
  receipts: count('SELECT count(*) FROM receipts'),
  docs: count("SELECT count(*) FROM documents WHERE doc_type = 'paper_receipt'"),
  orphans: count("SELECT count(*) FROM documents d LEFT JOIN receipts r ON r.doc_id = d.id WHERE d.doc_type = 'paper_receipt' AND r.doc_id IS NULL"),
  files: fs.existsSync(vault) ? fs.readdirSync(vault).length : 0,
});

/** 엔진 프로세스를 다시 띄운 것처럼 매번 새 PhoneIntake(같은 DB·보관함). 호출 기록은 메서드 이름만. */
function engine(o: { fail?: string } = {}) {
  const calls: string[] = [];
  const rpc: EngineRpc = async (m, p) => {
    calls.push(m);
    if (o.fail === m) throw Object.assign(new Error('db_not_ready'), { code: 'db_not_ready' });
    return new PhoneIntake(db, { vaultDir: vault, now: () => new Date(clock) }).handle(m, structuredClone(p));
  };
  return { rpc, calls };
}

const jpeg = (n: number, seed = 1) => {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
  b.set([0xff, 0xd8, 0xff, 0xe0]);
  return b;
};
const env = (type: string, body: object): Envelope => ({ v: 1, type, id: `e${randomBytes(4).toString('hex')}`, pairId: 'P', from: 'mobile', to: 'desktop', seq: 0, ts: 0, ttl: 60, body }) as unknown as Envelope;

/** 폰 한 번 보내기(offer + 청크 전부). 받은 ack 목록을 돌려준다. */
async function send(queue: ReturnType<typeof phoneReceiver>['queue'], img: Uint8Array, offer = makeReceiptOffer(img, { capturedAt: T0 - HOUR, ocrEngine: 'ios_vision', ownerConfirmed: true, candidates: { amount: 12_000 } })) {
  const acks: Array<{ type: string; body: { msgId: string; state: string } }> = [];
  const ch = { pairId: 'pair-1', send: (type: string, body: object) => (acks.push({ type, body: body as never }), 'id') };
  await queue.handle(ch as never, env('receipt.offer', offer));
  for (let i = 0; i < offer.chunkCount; i++) await queue.handle(ch as never, env('receipt.chunk', { msgId: offer.msgId, index: i, data: b64(img.subarray(i * RECEIPT_CHUNK, (i + 1) * RECEIPT_CHUNK)) }));
  return { offer, acks };
}

describe('폰 사진 수신: ReceiveQueue → main 싱크 → 엔진 PhoneIntake', () => {
  it('청크 조립 → 엔진 저장 → stored ack, 문서·영수증 한 쌍과 파일 하나. 새 영수증만 onReceipt', async () => {
    const e = engine();
    let fresh = 0;
    const logs: unknown[] = [];
    const r = phoneReceiver(e.rpc, { onReceipt: () => fresh++, log: (n, d) => logs.push([n, d]) });
    const img = jpeg(RECEIPT_CHUNK * 2 + 100);
    const { acks } = await send(r.queue, img);
    assert.deepEqual(acks.at(-1), { type: 'receipt.ack', body: { msgId: acks.at(-1)!.body.msgId, state: 'stored' } });
    assert.deepEqual(e.calls, ['receipt.phoneHas', 'receipt.phoneStore']);
    assert.deepEqual(state(), { receipts: 1, docs: 1, orphans: 0, files: 1 });
    assert.equal(fresh, 1);
    assert.deepEqual(logs, [['main.phone_receipt', { result: 'stored' }]]);
  });

  it('24시간 뒤 같은 msgId 재수신(엔진·main 재기동) → 영수증 1장, 고아 문서 0, 파일 그대로, stored ack', async () => {
    const img = jpeg(RECEIPT_CHUNK + 7, 2);
    const offer = makeReceiptOffer(img, { capturedAt: T0 - HOUR, ocrEngine: 'none', ownerConfirmed: false });
    await send(phoneReceiver(engine().rpc).queue, img, offer);
    const before = state();
    clock = T0 + 24 * HOUR;
    let fresh = 0;
    const e = engine();
    const { acks } = await send(phoneReceiver(e.rpc, { onReceipt: () => fresh++ }).queue, img, offer);
    assert.deepEqual(state(), before);
    assert.equal(before.orphans, 0);
    assert.deepEqual(acks.map((a) => a.body.state), ['stored'], 'offer 단계에서 바로 stored(조립하지 않음)');
    assert.deepEqual(e.calls, ['receipt.phoneHas']);
    assert.equal(fresh, 0);
    clock = T0;
  });

  it('조립 중에 다른 쪽이 같은 msgId를 넣었어도(늦은 중복) phoneStore가 duplicate로 받아 고아를 남기지 않는다', async () => {
    const img = jpeg(RECEIPT_CHUNK + 9, 3);
    const offer = makeReceiptOffer(img, { capturedAt: T0 - HOUR, ocrEngine: 'none', ownerConfirmed: false });
    const e = engine();
    const logs: unknown[] = [];
    const r = phoneReceiver(e.rpc, { log: (n, d) => logs.push([n, d]) });
    const acks: string[] = [];
    const ch = { pairId: 'pair-1', send: (_t: string, b: { state: string }) => (acks.push(b.state), 'id') };
    await r.queue.handle(ch as never, env('receipt.offer', offer));
    // 그 사이 같은 msgId가 다른 길(라이브 세션·큐)로 먼저 들어온다
    await new PhoneIntake(db, { vaultDir: vault }).handle('receipt.phoneStore', { msgId: offer.msgId, pairId: 'pair-1', jpeg: img, offer: offerParams(offer) });
    const before = state();
    for (let i = 0; i < offer.chunkCount; i++) await r.queue.handle(ch as never, env('receipt.chunk', { msgId: offer.msgId, index: i, data: b64(img.subarray(i * RECEIPT_CHUNK, (i + 1) * RECEIPT_CHUNK)) }));
    assert.deepEqual(state(), before);
    assert.deepEqual(acks, ['stored']);
    assert.deepEqual(logs, [['main.phone_receipt', { result: 'duplicate' }]]);
  });

  it('같은 사진이라도 msgId가 다르면 따로 받는다(SHA로 보지 않는다)', async () => {
    const img = jpeg(500, 4);
    const r = phoneReceiver(engine().rpc);
    const before = state();
    await send(r.queue, img);
    await send(r.queue, img);
    assert.equal(state().receipts, before.receipts + 2);
    assert.equal(state().orphans, 0);
  });

  it('엔진 저장이 실패하면 ack하지 않는다(폰이 다시 보낸다), 아무것도 남지 않는다', async () => {
    const e = engine({ fail: 'receipt.phoneStore' });
    const logs: unknown[] = [];
    const before = state();
    const { acks } = await send(phoneReceiver(e.rpc, { log: (n, d) => logs.push([n, d]) }).queue, jpeg(300, 5));
    assert.deepEqual(acks, []);
    assert.deepEqual(state(), before);
    assert.deepEqual(logs, [['main.phone_receipt', { result: 'failed', code: 'db_not_ready' }]]);
  });

  it('엔진 응답 모양이 틀리면 던진다(ack 없음)', async () => {
    const sink = engineReceiveSink(async () => ({ has: 'yes' }));
    await assert.rejects(sink.hasReceipt('01JC0000000000000000000000'), /phone\.bad_response/);
    const s2 = engineReceiveSink(async () => ({ docId: 1, duplicate: false }));
    await assert.rejects(s2.storeReceipt({ msgId: 'x', pairId: 'p', jpeg: jpeg(10), offer: makeReceiptOffer(jpeg(10), { capturedAt: 1, ocrEngine: 'none', ownerConfirmed: false }) }), /phone\.bad_response/);
  });

  it('엔진에는 offer의 조립 정보·sha256을 넘기지 않는다', () => {
    const o = makeReceiptOffer(jpeg(100), { capturedAt: 5, width: 10, height: 20, ocrEngine: 'android_mlkit', ownerConfirmed: true, candidates: { merchant: '가게' } });
    assert.deepEqual(offerParams(o), { capturedAt: 5, width: 10, height: 20, ocrEngine: 'android_mlkit', ownerConfirmed: true, candidates: { merchant: '가게' } });
    const bare = makeReceiptOffer(jpeg(100), { capturedAt: 5, ocrEngine: 'none', ownerConfirmed: false });
    assert.deepEqual(offerParams(bare), { capturedAt: 5, ocrEngine: 'none', ownerConfirmed: false });
  });

  it('로그에 msgId·금액·날짜가 없다', async () => {
    const logs: unknown[] = [];
    const r = phoneReceiver(engine().rpc, { log: (n, d) => logs.push([n, d]) });
    const { offer } = await send(r.queue, jpeg(200, 6));
    const s = JSON.stringify(logs);
    assert.ok(!s.includes(offer.msgId) && !s.includes('12000') && !s.includes('2026'));
  });
});

describe('폰 현금 수신', () => {
  it('cash.entry → cash.phonePut, 같은 메시지 재수신은 멱등(applied false), 늦은 값만 바꾼다', async () => {
    const e = engine();
    let changed = 0;
    const logs: unknown[] = [];
    const r = phoneReceiver(e.rpc, { onCash: () => changed++, log: (n, d) => logs.push([n, d]) });
    const acks: string[] = [];
    const ch = { pairId: 'pair-1', send: (_t: string, b: { state: string }) => (acks.push(b.state), 'id') };
    const entry = makeCashEntry('2026-11-05', 52_000, T0);
    await r.queue.handle(ch as never, env('cash.entry', entry));
    await r.queue.handle(ch as never, env('cash.entry', entry));
    assert.deepEqual(acks, ['stored', 'stored']);
    assert.equal(new CashSalesRepo(db).get(profileId, '2026-11-05')?.amount, 52_000);
    await r.queue.handle(ch as never, env('cash.entry', makeCashEntry('2026-11-05', 1, T0 - HOUR)));
    assert.equal(new CashSalesRepo(db).get(profileId, '2026-11-05')?.amount, 52_000, '이른 값은 바꾸지 않는다');
    await r.queue.handle(ch as never, env('cash.entry', makeCashEntry('2026-11-05', 61_000, T0 + HOUR)));
    assert.equal(new CashSalesRepo(db).get(profileId, '2026-11-05')?.amount, 61_000);
    assert.equal(changed, 2);
    assert.deepEqual(logs.map((l) => (l as [string, { applied: boolean }])[1].applied), [true, false, false, true]);
    assert.ok(!e.calls.includes('cash.phoneHas'));
  });
});

describe('큐 드레인', () => {
  it('열 수 없는 봉투는 버리고 그 seq까지 ack, 겹친 드레인은 한 번만 연다', async () => {
    let lists = 0;
    const acked: number[] = [];
    const queue = {
      list: async () => (lists++, [{ seq: 7, env: { junk: true } }]) as never,
      ack: async (s: number) => void acked.push(s),
    };
    const r = phoneReceiver(engine().rpc);
    const d = { queue, hpkeOpen: async () => new Uint8Array(0), pairId: 'pair-1', phoneVm: new Uint8Array(32), mbxEpoch: 1, seqMax: { get: async () => 0, set: async () => {} } };
    const [a, b] = await Promise.all([r.drain(d), r.drain(d)]);
    assert.deepEqual(a, { handled: 0, dropped: 1, ackedTo: 7 });
    assert.equal(a, b);
    assert.equal(lists, 1);
    assert.deepEqual(acked, [7]);
    assert.equal((await r.drain(d)).dropped, 1, '끝난 뒤에는 다시 연다');
  });
});

describe('소스 검사', () => {
  it('phone-receive는 DB·Electron·파일 시스템을 직접 쓰지 않는다, 엔진 명령은 PHONE_COMMANDS 셋만', () => {
    const s = fs.readFileSync(path.join(import.meta.dirname, '../apps/desktop/src/phone-receive.ts'), 'utf8');
    assert.doesNotMatch(s, /from '@sax\/(db|bundle)'|from 'electron'|from 'node:fs/);
    const methods = [...s.matchAll(/rpc\('([a-zA-Z.]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...new Set(methods)].sort(), ['cash.phonePut', 'receipt.phoneHas', 'receipt.phoneStore']);
  });
});
