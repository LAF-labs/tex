
import { b64, concat, fromB64, toHex, utf8 } from './bytes.ts';
import type { Channel } from './channel.ts';
import { randomBytes, sha256Hash, xOpen, xSeal } from './crypto.ts';
import { RECEIPT_CHUNK, RECEIPT_MAX_BYTES, type CashEntryBody, type Envelope, type ReceiptAckBody, type PaperInvoice, type ReceiptCandidates, type ReceiptChunkBody, type ReceiptOfferBody } from './envelope.ts';
import { ulid } from './ulid.ts';

export { RECEIPT_CHUNK, RECEIPT_MAX_BYTES };

/** 큐로 보낸 기록(queue.ts). 라이브 ack가 오면 지우고, 큐 TTL이 지나면 다시 넣는다. */
export interface QueuedMark {
  queuedAt?: number;
  firstQueuedAt?: number;
}

export type OutboxItem =
  | ({ kind: 'receipt'; msgId: string; offer: ReceiptOfferBody; createdAt: number; attempts: number } & QueuedMark)
  | ({ kind: 'cash'; msgId: string; entry: CashEntryBody; createdAt: number; attempts: number } & QueuedMark);

/** 폰 보관함 저장소. 앱이 파일 보호 등급·백업 제외 폴더에 암호화해 둔다(taxoff-mobile). */
export interface OutboxStore {
  list(): Promise<OutboxItem[]>;
  put(item: OutboxItem, photo?: Uint8Array): Promise<void>;
  readPhoto(msgId: string): Promise<Uint8Array>;
  remove(msgId: string): Promise<void>;
}

export function makeReceiptOffer(jpeg: Uint8Array, o: { capturedAt: number; width?: number; height?: number; ocrEngine: ReceiptOfferBody['ocrEngine']; ownerConfirmed: boolean; candidates?: ReceiptCandidates; paperInvoice?: PaperInvoice; now?: number }): ReceiptOfferBody {
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
  if (o.paperInvoice) {
    const bad = checkPaperInvoice(o.paperInvoice);
    if (bad.length) throw new Error(`receipt: paper invoice ${bad[0]}`);
    body.paperInvoice = structuredClone(o.paperInvoice);
  }
  return body;
}

export function makeCashEntry(day: string, amount: number, now = Date.now()): CashEntryBody {
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 100_000_000_000) throw new Error('cash: amount out of range');
  return { msgId: ulid(now), day, amount, enteredAt: now };
}

/** 같은 날 현금매출이 이미 대기 중이면 새 값으로 바꾼다(하루 숫자 하나). */
export async function enqueueCash(store: OutboxStore, entry: CashEntryBody, now = Date.now()): Promise<void> {
  const old = (await store.list()).filter((it) => it.kind === 'cash' && it.entry.day === entry.day && it.msgId !== entry.msgId);
  await store.put({ kind: 'cash', msgId: entry.msgId, entry, createdAt: now, attempts: 0 });
  for (const it of old) await store.remove(it.msgId);
}

export interface SenderOptions {
  ackTimeoutMs?: number;
  maxRounds?: number;
  pace?: () => Promise<void>;
}

export interface FlushResult {
  sent: string[];
  pending: string[];
}

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
  if (jpeg.length !== offer.bytes || toHex(sha256Hash(jpeg)) !== offer.sha256) return false;
  const all = [...Array(offer.chunkCount).keys()];
  const pick = (b: ReceiptAckBody) => (b.missing ?? []).filter((i) => i >= 0 && i < offer.chunkCount);
  let todo: number[] = all;
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

/** ReceiveQueue가 답을 보내는 곳. 라이브 Channel이 그대로 맞는다. */
export type Replier = Pick<Channel, 'pairId' | 'send'>;

/** PC 저장 쪽(데이터·데스크톱 트랙이 구현: documents(doc_type='paper_receipt') + receipts, cash_sales). */
export interface ReceiveSink {
  hasReceipt(msgId: string): Promise<boolean>;
  storeReceipt(r: { msgId: string; offer: ReceiptOfferBody; jpeg: Uint8Array; pairId: string }): Promise<void>;
  hasCash(msgId: string): Promise<boolean>;
  storeCash(c: { entry: CashEntryBody; pairId: string }): Promise<void>;
}

export interface ReceiveLimits {
  maxAssemblies?: number;
  maxBufferedBytes?: number;
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
      if (missing.length) ch.send('receipt.ack', { msgId: b.msgId, state: 'partial', missing }, { replyTo: e.id });
      return;
    }
    if (cur) this.#drop(b.msgId);
    if (this.#asm.size >= this.#lim.maxAssemblies) {
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
    if (a.chunks[b.index]) return;
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

/** 보관 파일 AEAD 연관 데이터 문맥. 키는 ThisDeviceOnly 키 저장소의 파일 키(D07, D08 §3.1). */
export const OUTBOX_AD = 'SAX-outbox-v1';

export function sealOutboxFile(fileKey: Uint8Array, msgId: string, plain: Uint8Array): Uint8Array {
  return xSeal(fileKey, plain, concat(utf8(OUTBOX_AD), utf8(msgId)));
}
export function openOutboxFile(fileKey: Uint8Array, msgId: string, box: Uint8Array): Uint8Array {
  return xOpen(fileKey, box, concat(utf8(OUTBOX_AD), utf8(msgId)));
}
export const newFileKey = (): Uint8Array => randomBytes(32);

/** 사업자등록번호 체크섬(국세청 규칙: 가중치 1,3,7,1,3,7,1,3,5, 9번째 자리 ×5의 십의 자리를 더한다). 000-00-00000 또는 숫자 10자리 */
export function bizNoValid(v: string): boolean {
  const d = v.replace(/-/g, '');
  if (!/^\d{10}$/.test(d) || (v.includes('-') && !/^\d{3}-\d{2}-\d{5}$/.test(v))) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * w[i]!;
  sum += Math.floor((Number(d[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(d[9]);
}

/**
 * 종이 세금계산서 값 검사(폰·PC 같은 규칙). 틀린 칸 이름 목록을 돌려준다(빈 목록이면 통과).
 * - 공급가액 + 세액 = 합계, 계산서(면세)는 세액 0, 품목이 있으면 품목 공급가액 합 = 공급가액(세액도 품목에 모두 있으면 같아야 한다)
 * - 공급자·공급받는자 사업자번호 체크섬, 두 번호가 같으면 안 된다
 */
export function checkPaperInvoice(p: PaperInvoice): string[] {
  const bad: string[] = [];
  const won = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 100_000_000_000;
  if (p.docKind !== 'tax_invoice' && p.docKind !== 'invoice') bad.push('docKind');
  if (p.direction !== 'sales' && p.direction !== 'purchase') bad.push('direction');
  if (typeof p.writtenOn !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(p.writtenOn) || new Date(`${p.writtenOn}T00:00:00Z`).toISOString().slice(0, 10) !== p.writtenOn) bad.push('writtenOn');
  if (!p.supplier || !bizNoValid(p.supplier.bizNo ?? '')) bad.push('supplier.bizNo');
  if (!p.buyer || !bizNoValid(p.buyer.bizNo ?? '')) bad.push('buyer.bizNo');
  if (p.supplier && p.buyer && p.supplier.bizNo?.replace(/-/g, '') === p.buyer.bizNo?.replace(/-/g, '')) bad.push('buyer.bizNo');
  if (!p.supplier?.name) bad.push('supplier.name');
  if (!p.buyer?.name) bad.push('buyer.name');
  for (const k of ['supplyAmount', 'vatAmount', 'total'] as const) if (!won(p[k])) bad.push(k);
  if (won(p.supplyAmount) && won(p.vatAmount) && won(p.total) && p.supplyAmount + p.vatAmount !== p.total) bad.push('total');
  if (p.docKind === 'invoice' && p.vatAmount !== 0) bad.push('vatAmount');
  if (p.items !== undefined) {
    if (!Array.isArray(p.items) || p.items.length > 20 || p.items.some((it) => !it || typeof it.name !== 'string' || !it.name || !won(it.supply) || (it.vat !== undefined && !won(it.vat)))) bad.push('items');
    else if (p.items.length) {
      if (p.items.reduce((s, it) => s + it.supply, 0) !== p.supplyAmount) bad.push('items.supply');
      if (p.items.every((it) => it.vat !== undefined) && p.items.reduce((s, it) => s + (it.vat ?? 0), 0) !== p.vatAmount) bad.push('items.vat');
    }
  }
  if (!(p.receiptOrClaim === 'receipt' || p.receiptOrClaim === 'claim' || p.receiptOrClaim === null)) bad.push('receiptOrClaim');
  return [...new Set(bad)];
}

/** PC 쪽 정본 방향: 내 사업자번호가 공급자면 매출, 공급받는자면 매입, 둘 다 아니면 null(사장님 확인 필요) */
export function paperDirection(p: Pick<PaperInvoice, 'supplier' | 'buyer'>, myBizNo: string | null): 'sales' | 'purchase' | null {
  const mine = myBizNo?.replace(/-/g, '');
  if (!mine) return null;
  if (p.supplier?.bizNo?.replace(/-/g, '') === mine) return 'sales';
  if (p.buyer?.bizNo?.replace(/-/g, '') === mine) return 'purchase';
  return null;
}
