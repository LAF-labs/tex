// D14 M7-4: 폰 → PC 종이 증빙 사진·현금매출 전송. 라이브 세션이 있으면 라이브로, 없으면 릴레이 HTTPS 큐로 보낸다(queue.ts, 팀장 결정 2026-11-05).
//  - 폰 보관함(Outbox): PC가 꺼져 있으면 폰에 두고, 세션이 열리면 보낸다. PC가 stored로 답한 뒤에만 지운다.
//  - PC 수신 큐(ReceiveQueue): 청크 재조립(메모리만, 디스크 임시 파일 없음), sha256 확인, msgId 중복 제거, ack.
//  - 재전송: 폰은 ack가 없으면 offer를 다시 보내고, PC는 이미 받은 msgId면 stored, 조립 중이면 partial(missing)로 답한다.
// 비밀·사진·금액을 로그에 넣지 않는다. 이 모듈은 로그를 남기지 않는다.

import { b64, concat, fromB64, toHex, utf8 } from './bytes.ts';
import type { Channel } from './channel.ts';
import { randomBytes, sha256Hash, xOpen, xSeal } from './crypto.ts';
import { RECEIPT_CHUNK, RECEIPT_MAX_BYTES, type CashEntryBody, type Envelope, type ReceiptAckBody, type ReceiptCandidates, type ReceiptChunkBody, type ReceiptOfferBody } from './envelope.ts';
import { ulid } from './ulid.ts';

export { RECEIPT_CHUNK, RECEIPT_MAX_BYTES };

// ======================= 폰 =======================

/** 큐로 보낸 기록(queue.ts). 라이브 ack가 오면 지우고, 큐 TTL이 지나면 다시 넣는다. */
export interface QueuedMark {
  /** 마지막으로 큐에 넣은 시각 */
  queuedAt?: number;
  /** 처음 큐에 넣은 시각(보관 기한 기준) */
  firstQueuedAt?: number;
}

export type OutboxItem =
  | ({ kind: 'receipt'; msgId: string; offer: ReceiptOfferBody; createdAt: number; attempts: number } & QueuedMark)
  | ({ kind: 'cash'; msgId: string; entry: CashEntryBody; createdAt: number; attempts: number } & QueuedMark);

/** 폰 보관함 저장소. 앱이 파일 보호 등급·백업 제외 폴더에 암호화해 둔다(apps/mobile). */
export interface OutboxStore {
  list(): Promise<OutboxItem[]>;
  put(item: OutboxItem, photo?: Uint8Array): Promise<void>;
  readPhoto(msgId: string): Promise<Uint8Array>;
  remove(msgId: string): Promise<void>;
}

export function makeReceiptOffer(jpeg: Uint8Array, o: { capturedAt: number; width?: number; height?: number; ocrEngine: ReceiptOfferBody['ocrEngine']; ownerConfirmed: boolean; candidates?: ReceiptCandidates; now?: number }): ReceiptOfferBody {
  if (jpeg.length < 1 || jpeg.length > RECEIPT_MAX_BYTES) throw new Error('receipt: size out of range');
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('receipt: not a JPEG');
  const body: ReceiptOfferBody = {
    msgId: ulid(o.now),
    capturedAt: o.capturedAt,
    mime: 'image/jpeg',
    bytes: jpeg.length,
    sha256: toHex(sha256Hash(jpeg)),
    chunkSize: RECEIPT_CHUNK,
    chunkCount: Math.ceil(jpeg.length / RECEIPT_CHUNK),
    ocrEngine: o.ocrEngine,
    ownerConfirmed: o.ownerConfirmed,
  };
  if (o.width) body.width = o.width;
  if (o.height) body.height = o.height;
  if (o.candidates && Object.keys(o.candidates).length) body.candidates = { ...o.candidates };
  return body;
}

export function makeCashEntry(day: string, amount: number, now = Date.now()): CashEntryBody {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100_000_000_000) throw new Error('cash: amount out of range');
  return { msgId: ulid(now), day, amount, enteredAt: now };
}

/** 같은 날 현금매출이 이미 대기 중이면 새 값으로 바꾼다(하루 숫자 하나). */
export async function enqueueCash(store: OutboxStore, entry: CashEntryBody, now = Date.now()): Promise<void> {
  // 새 값을 먼저 쓰고 옛 값을 지운다(쓰기에 실패하거나 중간에 죽어도 그날 숫자는 보관함에 남는다).
  const old = (await store.list()).filter((it) => it.kind === 'cash' && it.entry.day === entry.day && it.msgId !== entry.msgId);
  await store.put({ kind: 'cash', msgId: entry.msgId, entry, createdAt: now, attempts: 0 });
  for (const it of old) await store.remove(it.msgId);
}

export interface SenderOptions {
  /** ack를 기다리는 시간(마지막 청크 뒤). */
  ackTimeoutMs?: number;
  /** 한 항목의 offer 재전송 상한(이 세션 안). 넘으면 다음 세션으로 미룬다. */
  maxRounds?: number;
  /** 프레임 간격. 릴레이 한도(우편함당 초당 20, D08 §8) 아래로 맞춘다. */
  pace?: () => Promise<void>;
}

export interface FlushResult {
  sent: string[];
  pending: string[];
}

// 릴레이는 우편함마다 초당 20프레임(양방향 합)을 넘으면 버린다(services/relay RELAY.msgPerSecPerMailbox). ack 몫을 남겨 12개.
const defaultPace = () => new Promise<void>((r) => setTimeout(r, 1000 / 12));

/** 보관함을 비운다. 세션이 끊기거나 응답이 없으면 남은 것은 다음 세션에 보낸다. */
export async function flushOutbox(ch: Channel, store: OutboxStore, o: SenderOptions = {}): Promise<FlushResult> {
  const pace = o.pace ?? defaultPace;
  const ackTimeout = o.ackTimeoutMs ?? 8000;
  const maxRounds = o.maxRounds ?? 5;
  const res: FlushResult = { sent: [], pending: [] };
  const items = (await store.list()).sort((a, b) => a.createdAt - b.createdAt);
  for (const it of items) {
    if (ch.closed) {
      res.pending.push(it.msgId);
      continue;
    }
    // 항목마다 격리한다: 보관 파일 복호 실패·잘못된 항목·보관함 쓰기 실패가 나머지 항목의 전송을 막지 않는다.
    let ok: boolean;
    try {
      ok = it.kind === 'cash' ? await sendCash(ch, it.entry, ackTimeout, maxRounds) : await sendReceipt(ch, store, it.offer, ackTimeout, maxRounds, pace);
    } catch {
      ok = false;
    }
    try {
      if (ok) await store.remove(it.msgId);
      else await store.put({ ...it, attempts: it.attempts + 1 });
    } catch {
      // 지우지 못했으면 다음 세션에 다시 보내고 PC가 msgId로 중복을 거른다. 횟수를 못 올린 것은 다음에 센다.
    }
    (ok ? res.sent : res.pending).push(it.msgId);
  }
  return res;
}

async function waitAck(ch: Channel, type: 'receipt.ack' | 'cash.ack', msgId: string, timeoutMs: number): Promise<Envelope | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0 || ch.closed) return null;
    const e = await ch.recv(left);
    if (!e) return null;
    if (e.type === type && (e.body as { msgId: string }).msgId === msgId) return e;
    // 다른 메시지(ping 등)는 여기서 처리하지 않는다
  }
}

async function sendCash(ch: Channel, entry: CashEntryBody, ackTimeout: number, maxRounds: number): Promise<boolean> {
  for (let r = 0; r < maxRounds && !ch.closed; r++) {
    ch.send('cash.entry', entry);
    if (await waitAck(ch, 'cash.ack', entry.msgId, ackTimeout)) return true;
  }
  return false;
}

async function sendReceipt(ch: Channel, store: OutboxStore, offer: ReceiptOfferBody, ackTimeout: number, maxRounds: number, pace: () => Promise<void>): Promise<boolean> {
  const jpeg = await store.readPhoto(offer.msgId);
  if (jpeg.length !== offer.bytes || toHex(sha256Hash(jpeg)) !== offer.sha256) return false; // 보관 파일 손상: 보내지 않는다
  const all = [...Array(offer.chunkCount).keys()];
  const pick = (b: ReceiptAckBody) => (b.missing ?? []).filter((i) => i >= 0 && i < offer.chunkCount);
  let todo: number[] = all;
  // probe: 앞 회차에 응답이 없었다. offer만 먼저 보내 PC가 이미 받았는지(stored)·빠진 청크(partial)를 묻고,
  // 답이 없으면(offer부터 잃었거나 PC가 새로 조립을 시작) 전부 다시 보낸다.
  let probe = false;
  try {
    for (let r = 0; r < maxRounds && !ch.closed; r++) {
      ch.send('receipt.offer', offer);
      await pace();
      if (probe) {
        const a = await waitAck(ch, 'receipt.ack', offer.msgId, Math.min(ackTimeout, 3000));
        if (a && (a.body as ReceiptAckBody).state === 'stored') return true;
        todo = a ? pick(a.body as ReceiptAckBody) : all;
      }
      for (const i of todo) {
        if (ch.closed) return false;
        const data = jpeg.subarray(i * offer.chunkSize, Math.min(jpeg.length, (i + 1) * offer.chunkSize));
        ch.send('receipt.chunk', { msgId: offer.msgId, index: i, data: b64(data) });
        await pace();
      }
      const ack = await waitAck(ch, 'receipt.ack', offer.msgId, ackTimeout);
      if (!ack) {
        probe = true;
        continue;
      }
      const b = ack.body as ReceiptAckBody;
      if (b.state === 'stored') return true;
      todo = pick(b);
      probe = false;
    }
    return false;
  } finally {
    jpeg.fill(0);
  }
}

// ======================= PC =======================

/** ReceiveQueue가 답을 보내는 곳. 라이브 Channel이 그대로 맞는다. */
export type Replier = Pick<Channel, 'pairId' | 'send'>;

/** PC 저장 쪽(데이터·데스크톱 트랙이 구현: documents(doc_type='paper_receipt') + receipts, cash_sales). */
export interface ReceiveSink {
  /** receipts.phone_msg_id가 이미 있는가 */
  hasReceipt(msgId: string): Promise<boolean>;
  /** 원본 사진을 보관함에 넣고 receipts 행을 만든다. docparse 샌드박스 재판독은 PC가 뒤에서 한다. 성공해야 stored로 답한다. */
  storeReceipt(r: { msgId: string; offer: ReceiptOfferBody; jpeg: Uint8Array; pairId: string }): Promise<void>;
  hasCash(msgId: string): Promise<boolean>;
  /** cash_sales 업서트(같은 날은 enteredAt이 늦은 값). */
  storeCash(c: { entry: CashEntryBody; pairId: string }): Promise<void>;
}

export interface ReceiveLimits {
  /** 동시에 조립하는 사진 수 */
  maxAssemblies?: number;
  /** 조립 중 메모리 상한(바이트) */
  maxBufferedBytes?: number;
  /** 조립 유휴 만료(ms) */
  idleMs?: number;
}

interface Assembly {
  offer: ReceiptOfferBody;
  chunks: (Uint8Array | undefined)[];
  have: number;
  buffered: number;
  touched: number;
}

export class ReceiveQueue {
  #sink: ReceiveSink;
  #asm = new Map<string, Assembly>();
  #lim: Required<ReceiveLimits>;
  #now: () => number;
  /** 거부·무시한 메시지 수(진단용, 원인·내용 없음). */
  ignored = 0;

  constructor(sink: ReceiveSink, lim: ReceiveLimits = {}, now: () => number = Date.now) {
    this.#sink = sink;
    this.#lim = { maxAssemblies: lim.maxAssemblies ?? 4, maxBufferedBytes: lim.maxBufferedBytes ?? 16 * 1024 * 1024, idleMs: lim.idleMs ?? 10 * 60_000 };
    this.#now = now;
  }

  get assembling(): number {
    return this.#asm.size;
  }

  #buffered(): number {
    let n = 0;
    for (const a of this.#asm.values()) n += a.buffered;
    return n;
  }

  #gc(): void {
    const now = this.#now();
    for (const [k, a] of this.#asm) if (now - a.touched > this.#lim.idleMs) this.#drop(k);
  }

  #drop(k: string): void {
    const a = this.#asm.get(k);
    if (!a) return;
    for (const c of a.chunks) c?.fill(0);
    this.#asm.delete(k);
  }

  /** 세션 루프(또는 큐 드레인)에서 봉투마다 부른다. 응답할 것이 있으면 ch로 보낸다(큐에서는 응답할 곳이 없어 버린다). */
  async handle(ch: Replier, e: Envelope): Promise<void> {
    this.#gc();
    switch (e.type) {
      case 'cash.entry': {
        const b = e.body as CashEntryBody;
        if (!(await this.#sink.hasCash(b.msgId))) await this.#sink.storeCash({ entry: b, pairId: ch.pairId });
        ch.send('cash.ack', { msgId: b.msgId, state: 'stored' }, { replyTo: e.id });
        return;
      }
      case 'receipt.offer':
        return this.#offer(ch, e, e.body as ReceiptOfferBody);
      case 'receipt.chunk':
        return this.#chunk(ch, e.body as ReceiptChunkBody);
      default:
        return;
    }
  }

  async #offer(ch: Replier, e: Envelope, b: ReceiptOfferBody): Promise<void> {
    if (await this.#sink.hasReceipt(b.msgId)) {
      this.#drop(b.msgId);
      ch.send('receipt.ack', { msgId: b.msgId, state: 'stored' }, { replyTo: e.id });
      return;
    }
    const cur = this.#asm.get(b.msgId);
    if (cur && sameOffer(cur.offer, b)) {
      cur.touched = this.#now();
      const missing = cur.chunks.flatMap((c, i) => (c ? [] : [i]));
      // 조립 중인 offer가 다시 오면(폰의 재전송) 빠진 청크를 알려 준다.
      if (missing.length) ch.send('receipt.ack', { msgId: b.msgId, state: 'partial', missing }, { replyTo: e.id });
      return;
    }
    if (cur) this.#drop(b.msgId); // 같은 msgId에 다른 내용: 처음부터
    if (this.#asm.size >= this.#lim.maxAssemblies) {
      // 가장 오래 쉰 조립을 버린다(폰이 다시 보낸다)
      let oldest: string | null = null;
      let t = Infinity;
      for (const [k, a] of this.#asm) if (a.touched < t) [oldest, t] = [k, a.touched];
      if (oldest) this.#drop(oldest);
    }
    this.#asm.set(b.msgId, { offer: b, chunks: new Array(b.chunkCount).fill(undefined), have: 0, buffered: 0, touched: this.#now() });
  }

  async #chunk(ch: Replier, b: ReceiptChunkBody): Promise<void> {
    const a = this.#asm.get(b.msgId);
    if (!a || b.index >= a.offer.chunkCount) {
      this.ignored++;
      return;
    }
    a.touched = this.#now();
    if (a.chunks[b.index]) return; // 중복 청크
    const data = fromB64(b.data);
    const last = b.index === a.offer.chunkCount - 1;
    const want = last ? a.offer.bytes - (a.offer.chunkCount - 1) * a.offer.chunkSize : a.offer.chunkSize;
    if (data.length !== want) {
      this.ignored++;
      return;
    }
    if (this.#buffered() + data.length > this.#lim.maxBufferedBytes) {
      this.ignored++;
      return;
    }
    a.chunks[b.index] = data;
    a.have++;
    a.buffered += data.length;
    if (a.have < a.offer.chunkCount) return;
    const jpeg = concat(...(a.chunks as Uint8Array[]));
    if (toHex(sha256Hash(jpeg)) !== a.offer.sha256) {
      // 내용이 맞지 않으면 모두 다시 받는다
      jpeg.fill(0);
      for (let i = 0; i < a.chunks.length; i++) {
        a.chunks[i]?.fill(0);
        a.chunks[i] = undefined;
      }
      a.have = 0;
      a.buffered = 0;
      ch.send('receipt.ack', { msgId: b.msgId, state: 'partial', missing: [...Array(a.offer.chunkCount).keys()] });
      return;
    }
    try {
      await this.#sink.storeReceipt({ msgId: b.msgId, offer: a.offer, jpeg, pairId: ch.pairId });
    } catch {
      // 저장 실패: ack하지 않는다. 폰이 다시 보낸다.
      this.#drop(b.msgId);
      jpeg.fill(0);
      return;
    }
    this.#drop(b.msgId);
    jpeg.fill(0);
    ch.send('receipt.ack', { msgId: b.msgId, state: 'stored' });
  }
}

function sameOffer(a: ReceiptOfferBody, b: ReceiptOfferBody): boolean {
  return a.bytes === b.bytes && a.sha256 === b.sha256 && a.chunkCount === b.chunkCount && a.chunkSize === b.chunkSize;
}

// ======================= 폰 로컬 저장 암호화 =======================

/** 보관 파일 AEAD 연관 데이터 문맥. 키는 ThisDeviceOnly 키 저장소의 파일 키(D07, D08 §3.1). */
export const OUTBOX_AD = 'SAX-outbox-v1';

export function sealOutboxFile(fileKey: Uint8Array, msgId: string, plain: Uint8Array): Uint8Array {
  return xSeal(fileKey, plain, concat(utf8(OUTBOX_AD), utf8(msgId)));
}
export function openOutboxFile(fileKey: Uint8Array, msgId: string, box: Uint8Array): Uint8Array {
  return xOpen(fileKey, box, concat(utf8(OUTBOX_AD), utf8(msgId)));
}
export const newFileKey = (): Uint8Array => randomBytes(32);
