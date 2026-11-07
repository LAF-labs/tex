// D08 §7 오프라인 큐로 보내는 사진·현금매출(intent-envelope v1.5 kind xfer, 팀장 결정 2026-11-05).
// Phase 1은 라이브 WSS가 꺼져 있으므로, 라이브 세션이 없으면 폰 보관함을 릴레이 HTTPS 큐로 보낸다.
//   폰: Xfer{pair_id, from, to, seq, iat, exp, qbundle_seq, type, body} → Sign_Vm("SAX-env-v1" ‖ CBOR(Xfer))
//       → CBOR{xfer, sig} → 패딩(ENV_PAD_BUCKETS) → HPKE 봉인(pkR = Q_D, info "SAX-env-v1", aad "SAX-env-v1" ‖ mbx_epoch(8B BE))
//       → POST /v1/mailboxes/:id/envelopes {v:1, kind:"ENV", enc, ct}
//   PC: GET → 금고 hpkeOpen → Vm 서명·pair_id·exp·seq 검사 → ReceiveQueue(응답 없음) → POST ack{seq}(그 seq까지 릴레이가 지운다)
// 사진은 32 KiB 청크(QUEUE.chunk), 봉투 하나 = 청크 하나. 4 MiB 사진은 offer 1 + 청크 128 = 봉투 129개(릴레이 한도 160·6 MiB 안).
// 폰은 큐에 넣은 뒤에도 보관함에 둔다: 라이브 ack가 오면 지우고, 큐 TTL(24시간)이 지나면 다시 넣고(PC가 msgId로 중복을 없앤다),
// 처음 넣고 QUEUE.keepMs(7일)가 지나면 지운다. 개봉·서명·만료 실패는 조용히 버린다(오류 코드 없음, D08 §7).
// 이 모듈은 로그를 남기지 않는다.

import { b64, b64url, concat, fromB64, u64be, utf8 } from './bytes.ts';
import { decodeCbor, encodeCbor, type CborValue } from './cbor.ts';
import { CTX } from './contexts.ts';
import { ed25519Verify } from './crypto.ts';
import type { HttpJson } from './devauth.ts';
import { RECEIPT_MAX_BYTES, fromCborModel, toCborModel, validateEnvelope, type CashEntryBody, type Envelope, type ReceiptChunkBody, type ReceiptOfferBody } from './envelope.ts';
import { hpkeSeal } from './hpke.ts';
import type { Signer } from './keys.ts';
import type { QBundle } from './qbundle.ts';
import type { MailboxTokens } from './relay.ts';
import type { OutboxItem, OutboxStore, ReceiveQueue } from './transfer.ts';

const HOUR = 3_600_000;
export const QUEUE = {
  /** 큐 경로 사진 청크(라이브는 48 KiB) */
  chunk: 32_768,
  /** 릴레이 큐 TTL이자 봉투 exp 상한 */
  ttlMs: 24 * HOUR,
  /** 릴레이 우편함당 한도(services/relay) */
  maxEnvelopes: 160,
  maxBytes: 6 * 1024 * 1024,
  /** intent-envelope ct(base64) 상한 */
  ctMaxChars: 65_536,
  /** 폰 보관함에 큐 기록을 두는 기한 */
  keepMs: 7 * 24 * HOUR,
} as const;

/** 큐 봉투 평문 패딩 버킷(intent-envelope v1.5). 가장 큰 버킷의 암호문 base64가 ctMaxChars 안에 든다. */
export const ENV_PAD_BUCKETS = [256, 1024, 4096, 16384, 33792] as const;

const INFO = utf8(CTX.env);
const aadOf = (mbxEpoch: number) => concat(utf8(CTX.env), u64be(mbxEpoch));
const SKEW_S = 300;

export type XferType = 'receipt.offer' | 'receipt.chunk' | 'cash.entry';

export interface Xfer {
  pair_id: string;
  from: 'mobile';
  to: 'desktop';
  seq: number;
  /** 초 */
  iat: number;
  /** 초, iat + 24시간 이하 */
  exp: number;
  qbundle_seq: number;
  type: XferType;
  body: ReceiptOfferBody | ReceiptChunkBody | CashEntryBody;
}

/** 릴레이가 보는 바깥 객체(intent-envelope). */
export interface OuterEnv {
  v: 1;
  kind: 'ENV';
  enc: string;
  ct: string;
}

function padEnv(p: Uint8Array): Uint8Array {
  const bucket = ENV_PAD_BUCKETS.find((b) => b >= p.length + 1);
  if (bucket === undefined) throw new Error('queue: envelope too large');
  const out = new Uint8Array(bucket);
  out.set(p);
  out[p.length] = 0x80;
  return out;
}

function unpadEnv(p: Uint8Array): Uint8Array | null {
  if (!(ENV_PAD_BUCKETS as readonly number[]).includes(p.length)) return null;
  let i = p.length - 1;
  while (i >= 0 && p[i] === 0) i--;
  if (i < 0 || p[i] !== 0x80) return null;
  return p.subarray(0, i);
}

/** Xfer의 바디를 라이브 봉투 검증기로 확인할 수 있게 감싼다(같은 스키마·정규형 검사). */
function asEnvelope(x: Xfer): Envelope {
  const id = (x.body as { msgId: string }).msgId;
  return { v: 1, type: x.type, id, pairId: x.pair_id, from: 'mobile', to: 'desktop', seq: x.seq, ts: x.iat * 1000, ttl: 300, body: x.body } as Envelope;
}

const xferBytes = (x: Xfer): Uint8Array => encodeCbor(toCborModel(x));

/** 폰: Xfer 하나를 봉인한다. */
export async function sealXfer(x: Xfer, vm: Pick<Signer<typeof CTX.env>, 'sign'>, qd: Uint8Array, mbxEpoch: number): Promise<OuterEnv> {
  if (!validateEnvelope(asEnvelope(x))) throw new Error(`queue: invalid ${x.type}`);
  if (x.exp <= x.iat || x.exp - x.iat > QUEUE.ttlMs / 1000) throw new Error('queue: bad exp');
  const msg = xferBytes(x);
  const sig = await vm.sign(CTX.env, msg);
  const pt = padEnv(encodeCbor({ xfer: decodeCbor(msg), sig } as CborValue));
  const { enc, ct } = hpkeSeal(qd, INFO, aadOf(mbxEpoch), pt);
  pt.fill(0);
  const out: OuterEnv = { v: 1, kind: 'ENV', enc: b64(enc), ct: b64(ct) };
  if (out.ct.length > QUEUE.ctMaxChars) throw new Error('queue: ct too large');
  return out;
}

/** PC: 금고 crypto.hpkeOpen(개인키 Q_D는 금고 안). 실패는 던진다. */
export type HpkeOpenFn = (r: { enc: Uint8Array; ct: Uint8Array; info: Uint8Array; aad: Uint8Array }) => Promise<Uint8Array>;

/** PC: 바깥 객체 하나를 열어 검사한다. 실패는 null(조용히 버린다). */
export async function openXfer(outer: unknown, o: { hpkeOpen: HpkeOpenFn; pairId: string; phoneVm: Uint8Array; mbxEpoch: number; now?: number }): Promise<Xfer | null> {
  try {
    const e = outer as Partial<OuterEnv> | null;
    if (!e || e.v !== 1 || e.kind !== 'ENV' || typeof e.enc !== 'string' || typeof e.ct !== 'string' || e.ct.length > QUEUE.ctMaxChars) return null;
    if (Object.keys(e).sort().join() !== 'ct,enc,kind,v') return null;
    const enc = fromB64(e.enc);
    if (enc.length !== 32) return null;
    const padded = await o.hpkeOpen({ enc, ct: fromB64(e.ct), info: INFO, aad: aadOf(o.mbxEpoch) });
    const pt = unpadEnv(padded);
    if (!pt) return null;
    const m = decodeCbor(pt, { maxBytes: pt.length, maxItems: 256 }) as { xfer?: CborValue; sig?: CborValue };
    if (!m || typeof m !== 'object' || Object.keys(m).sort().join() !== 'sig,xfer' || !(m.sig instanceof Uint8Array)) return null;
    const msg = encodeCbor(m.xfer!);
    if (!ed25519Verify(o.phoneVm, CTX.env, msg, m.sig)) return null;
    const x = fromCborModel(m.xfer!) as Xfer;
    if (Object.keys(x).sort().join() !== 'body,exp,from,iat,pair_id,qbundle_seq,seq,to,type') return null;
    if (x.pair_id !== o.pairId || x.from !== 'mobile' || x.to !== 'desktop' || !Number.isSafeInteger(x.qbundle_seq)) return null;
    const now = Math.floor((o.now ?? Date.now()) / 1000);
    if (!Number.isSafeInteger(x.iat) || !Number.isSafeInteger(x.exp) || x.exp <= now || x.iat > now + SKEW_S || x.exp - x.iat > QUEUE.ttlMs / 1000) return null;
    if (x.type !== 'receipt.offer' && x.type !== 'receipt.chunk' && x.type !== 'cash.entry') return null;
    if (!validateEnvelope(asEnvelope(x))) return null;
    return x;
  } catch {
    return null;
  }
}

// ---- 릴레이 큐 HTTPS(services/relay/API.md) ----

export interface RelayQueueOptions {
  http: HttpJson;
  /** https://<릴레이 공개 origin>(DPoP htu 앞부분) */
  origin: string;
  mbxId: Uint8Array;
  tok: MailboxTokens;
  /** 기기 범위 토큰 헤더(devauth.ts deviceAuthHeaders) */
  deviceAuth: (htm: 'GET' | 'POST' | 'PUT', htu: string) => Promise<Record<string, string>>;
}

export type PostResult = 'ok' | 'full' | 'failed';

/** 큐 GET 한 쪽(services/relay/API.md, #204): 봉투 바이트 3 MiB까지, 남으면 more. */
export interface QueuePage {
  envelopes: { seq: number; env: unknown }[];
  more: boolean;
}

export interface RelayQueue {
  post(e: OuterEnv): Promise<PostResult>;
  /** 첫 쪽의 봉투만(옛 호출자용). 남은 쪽은 ACK 뒤 다음 호출에서 받는다. */
  list(): Promise<{ seq: number; env: unknown }[]>;
  /** 한 쪽과 more. after는 ACK 전에 다음 쪽을 받을 때만(받은 마지막 seq). */
  listPage(after?: number): Promise<QueuePage>;
  ack(seq: number): Promise<void>;
  getBundle(): Promise<string | null>;
  putBundle(b: string): Promise<void>;
}

export function relayQueue(o: RelayQueueOptions): RelayQueue {
  const base = `/v1/mailboxes/${b64url(o.mbxId)}`;
  const call = async (method: 'GET' | 'POST' | 'PUT', path: string, tokHeader: 'X-Mbx-Read' | 'X-Mbx-Write', body?: unknown, query = '') => {
    const url = o.origin.replace(/\/+$/, '') + base + path;
    const headers: Record<string, string> = { ...(await o.deviceAuth(method, url)), [tokHeader]: b64url(tokHeader === 'X-Mbx-Read' ? o.tok.read : o.tok.write) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    return o.http({ method, url: url + query, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  return {
    async post(e) {
      const r = await call('POST', '/envelopes', 'X-Mbx-Write', e);
      if (r.status === 202) return 'ok';
      const code = (r.body as { error?: unknown } | null)?.error;
      return r.status === 429 && code === 'relay.queue_full' ? 'full' : 'failed';
    },
    async list() {
      return (await this.listPage()).envelopes;
    },
    async listPage(after?: number) {
      if (after !== undefined && !(Number.isSafeInteger(after) && after >= 0)) throw new Error('queue: bad after');
      // DPoP htu는 쿼리를 뺀 origin + 경로다(API.md). 쿼리는 요청 URL에만 붙인다.
      const r = await call('GET', '/envelopes', 'X-Mbx-Read', undefined, after === undefined ? '' : `?after=${after}`);
      if (r.status !== 200) throw new Error(`queue: list ${r.status}`);
      const b = r.body as { envelopes?: unknown; more?: unknown } | null;
      const envs = b?.envelopes;
      if (!Array.isArray(envs)) throw new Error('queue: list shape');
      return {
        envelopes: envs.filter((x): x is { seq: number; env: unknown } => !!x && Number.isSafeInteger((x as { seq?: unknown }).seq)),
        // more를 모르는 옛 서버는 필드가 없다 → 한 쪽으로 본다
        more: b?.more === true,
      };
    },
    async ack(seq) {
      const r = await call('POST', '/ack', 'X-Mbx-Read', { seq });
      if (r.status !== 200) throw new Error(`queue: ack ${r.status}`);
    },
    async getBundle() {
      const r = await call('GET', '/bundle', 'X-Mbx-Read');
      if (r.status === 404) return null;
      const b = (r.body as { bundle?: unknown } | null)?.bundle;
      if (r.status !== 200 || typeof b !== 'string') throw new Error(`queue: bundle ${r.status}`);
      return b;
    },
    async putBundle(b) {
      const r = await call('PUT', '/bundle', 'X-Mbx-Write', { bundle: b });
      if (r.status !== 204) throw new Error(`queue: put bundle ${r.status}`);
    },
  };
}

// ---- 폰: 보관함 → 큐 ----

export interface QueueSendOptions {
  queue: Pick<RelayQueue, 'post'>;
  pairId: string;
  vm: Pick<Signer<typeof CTX.env>, 'sign'>;
  /** verifyQBundle을 통과한 번들 */
  bundle: QBundle;
  mbxEpoch: number;
  /** 봉투마다 새 seq(앱이 영속, 단조 증가) */
  nextSeq: () => number;
  now?: number;
}

export interface QueueSendResult {
  queued: string[];
  /** 큐가 차서 다음에 보낼 것 */
  waiting: string[];
  /** 보관 기한이 지나 지운 것 */
  expired: string[];
}

/** 보관함을 큐로 보낸다. 이미 넣었고 TTL 안이면 건너뛴다. 큐가 차면 멈추고 남은 것은 다음에. */
export async function queueOutbox(store: OutboxStore, o: QueueSendOptions): Promise<QueueSendResult> {
  const now = o.now ?? Date.now();
  const res: QueueSendResult = { queued: [], waiting: [], expired: [] };
  if (o.bundle.validTo <= now) throw new Error('queue: bundle expired');
  const items = (await store.list()).sort((a, b) => a.createdAt - b.createdAt);
  let full = false;
  for (const it of items) {
    if (it.queuedAt !== undefined && now - it.queuedAt < QUEUE.ttlMs) continue;
    if (it.firstQueuedAt !== undefined && now - it.firstQueuedAt >= QUEUE.keepMs) {
      await store.remove(it.msgId);
      res.expired.push(it.msgId);
      continue;
    }
    if (full) {
      res.waiting.push(it.msgId);
      continue;
    }
    let ok: PostResult = 'ok';
    try {
      for await (const x of xfersOf(store, it, o, now)) {
        ok = await o.queue.post(await sealXfer(x, o.vm, o.bundle.Qx, o.mbxEpoch));
        if (ok !== 'ok') break;
      }
    } catch {
      ok = 'failed';
    }
    if (ok === 'ok') {
      await store.put({ ...it, queuedAt: now, firstQueuedAt: it.firstQueuedAt ?? now });
      res.queued.push(it.msgId);
    } else {
      if (ok === 'full') full = true;
      res.waiting.push(it.msgId);
    }
  }
  return res;
}

async function* xfersOf(store: OutboxStore, it: OutboxItem, o: QueueSendOptions, now: number): AsyncGenerator<Xfer> {
  const iat = Math.floor(now / 1000);
  const head = () => ({ pair_id: o.pairId, from: 'mobile' as const, to: 'desktop' as const, seq: o.nextSeq(), iat, exp: iat + QUEUE.ttlMs / 1000, qbundle_seq: o.bundle.seq });
  if (it.kind === 'cash') {
    yield { ...head(), type: 'cash.entry', body: it.entry };
    return;
  }
  const jpeg = await store.readPhoto(it.msgId);
  try {
    if (jpeg.length !== it.offer.bytes || jpeg.length > RECEIPT_MAX_BYTES) throw new Error('queue: photo size');
    const chunkCount = Math.ceil(jpeg.length / QUEUE.chunk);
    const offer: ReceiptOfferBody = { ...it.offer, chunkSize: QUEUE.chunk, chunkCount };
    yield { ...head(), type: 'receipt.offer', body: offer };
    for (let i = 0; i < chunkCount; i++) {
      yield { ...head(), type: 'receipt.chunk', body: { msgId: it.msgId, index: i, data: b64(jpeg.subarray(i * QUEUE.chunk, (i + 1) * QUEUE.chunk)) } };
    }
  } finally {
    jpeg.fill(0);
  }
}

// ---- PC: 큐 → 수신 큐 ----

export interface QueueReceiverOptions {
  /** listPage가 있으면 more를 보고 쪽을 이어 읽는다. list만 있으면 한 쪽(옛 동작). */
  queue: Pick<RelayQueue, 'list' | 'ack'> & Partial<Pick<RelayQueue, 'listPage'>>;
  /** 금고 crypto.hpkeOpen */
  hpkeOpen: HpkeOpenFn;
  pairId: string;
  /** AIK 서명 기기 목록의 이 폰 Vm */
  phoneVm: Uint8Array;
  mbxEpoch: number;
  receive: ReceiveQueue;
  /** remote_pair_state.async_seq_max 영속(통과한 뒤에만 올린다) */
  seqMax: { get(): Promise<number>; set(seq: number): Promise<void> };
  now?: () => number;
}

export interface DrainResult {
  handled: number;
  dropped: number;
  ackedTo: number | null;
  /** 읽은 쪽 수(listPage로 쪽을 읽을 때만. list만 있는 옛 큐는 옛 결과 모양 그대로) */
  pages?: number;
  /** 서버가 more라고 했는데 상한·빈 쪽·진전 없음으로 멈췄다(호출자는 곧 다시 부르면 된다). listPage일 때만 */
  more?: boolean;
}

/**
 * 한 번 드레인에서 읽는 쪽 상한. 큐는 우편함당 160건·6 MiB이고 한 쪽은 3 MiB까지라 보통 3쪽 안이다(#204).
 * 서버가 more를 계속 주어도 이 수에서 멈춘다(무한 루프 방지).
 */
export const DRAIN_MAX_PAGES = 8;

/**
 * 큐를 비운다. 연 봉투든 버린 봉투든 처리한 relay seq까지 쪽마다 ack한다(버린 것은 폰이 TTL 뒤 다시 넣는다).
 * more면 ack한 뒤 곧바로 다음 쪽을 읽는다(ack로 앞쪽이 지워져 after가 필요 없다). 빈 쪽이나 seq가 앞으로 가지 않는 쪽,
 * DRAIN_MAX_PAGES에서 멈추고 more: true로 돌려준다. 쪽 중간에 실패하면 그때까지 처리한 seq까지 ack하고 던진다.
 */
export async function drainQueue(o: QueueReceiverOptions): Promise<DrainResult> {
  const paged = typeof o.queue.listPage === 'function';
  const res: DrainResult = paged ? { handled: 0, dropped: 0, ackedTo: null, pages: 0, more: false } : { handled: 0, dropped: 0, ackedTo: null };
  let max = await o.seqMax.get();
  // 큐에서는 PC가 폰에 답할 곳이 없다(receipt.ack 등은 버린다).
  const replier = { pairId: o.pairId, send: () => '' } as unknown as Parameters<ReceiveQueue['handle']>[0];
  const readPage = async (): Promise<QueuePage> => (paged ? o.queue.listPage!() : { envelopes: await o.queue.list(), more: false });
  let pages = 0;
  for (;;) {
    const page = await readPage();
    pages++;
    if (paged) res.pages = pages;
    const envs = [...page.envelopes].sort((a, b) => a.seq - b.seq);
    const before = res.ackedTo;
    let pageAck: number | null = null;
    try {
      for (const { seq, env } of envs) {
        const x = await openXfer(env, { hpkeOpen: o.hpkeOpen, pairId: o.pairId, phoneVm: o.phoneVm, mbxEpoch: o.mbxEpoch, now: o.now?.() });
        if (!x || x.seq <= max) {
          res.dropped++;
        } else {
          await o.receive.handle(replier, asEnvelope(x));
          max = x.seq;
          await o.seqMax.set(max);
          res.handled++;
        }
        pageAck = seq;
      }
    } finally {
      if (pageAck !== null) {
        await o.queue.ack(pageAck);
        res.ackedTo = pageAck;
      }
    }
    if (!page.more) return res;
    // more인데 빈 쪽이거나 앞으로 가지 않으면(서버 이상) 멈춘다. 상한도 같다.
    const progressed = pageAck !== null && (before === null || pageAck > before);
    if (!progressed || pages >= DRAIN_MAX_PAGES) {
      res.more = true;
      return res;
    }
  }
}
