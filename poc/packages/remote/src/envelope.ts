// D08 §6 라이브 메시지 봉투. JSON 모델(바이너리는 base64, 스키마 표기)과 와이어(CBOR, 바이너리는 바이트열)를 오간다.
// 검증은 remote-envelope.schema.json에서 미리 만든 코드(schema.gen.ts)로 한다. 송신 전·수신 후 모두 검증한다.

import { b64, fromB64 } from './bytes.ts';
import { decodeCbor, encodeCbor, type CborValue } from './cbor.ts';
import { MAX_INNER } from './frame.ts';
import { BINARY_KEYS, MESSAGE_TYPES, validate as schemaValidate } from './schema.gen.ts';
import { ulid } from './ulid.ts';

export type Role = 'desktop' | 'mobile';
/** 스키마 type enum과 같아야 한다(tests/remote-envelope.test.ts가 대조). */
export type MessageType = 'hello' | 'pair.ok' | 'kek.grant' | 'devlist.push' | 'mbx.reissue' | 'close' | 'ping' | 'pong' | 'receipt.offer' | 'receipt.chunk' | 'receipt.ack' | 'cash.entry' | 'cash.ack' | 'cmd.run' | 'cmd.abort' | 'cmd.resume' | 'run.event' | 'gate.request' | 'gate.response' | 'consent.request' | 'consent.response' | 'human.request' | 'human.response' | 'file.offer' | 'query.documents' | 'query.result' | 'rotate.static';

export const ALL_MESSAGE_TYPES: readonly string[] = MESSAGE_TYPES as readonly string[];
const BIN = new Set<string>(BINARY_KEYS as readonly string[]);

export interface DeviceListEntryJson {
  entry: { device_id: string; role: Role; Sx: string; Vx: string; registered_at: number; list_version: number };
  aikSig: string;
}
export interface RevokedJson {
  device_id: string;
  revoked_at: number;
  aikSig: string;
}
export interface DeviceListJson {
  listVersion: number;
  entries: DeviceListEntryJson[];
  revoked: RevokedJson[];
}

export interface HelloBody {
  appVersion: string;
  protocol: number;
  suites: ('noise-25519-chachapoly-blake2b' | 'hpke-x25519-sha256-chachapoly' | 'xwing-reserved')[];
  deviceListVersion: number;
  asyncSeqMax: number;
  registryHeadHash: string;
  registryTreeSize?: number;
  capabilities: string[];
}
export interface PairOkBody {
  cert: string;
  aikPub: string;
  kvPub: string;
  kvSig: string;
  deviceList: DeviceListJson;
  mbxId: string;
  tokRead: string;
  tokWrite: string;
  mbxEpoch: number;
}
export interface KekGrantBody {
  kek: string;
  kekVer: number;
  kekRecord: { n: number; salt: string; createdAt: number; aikSig: string };
}
export interface MbxReissueBody {
  mbxId: string;
  tokRead: string;
  tokWrite: string;
  mbxEpoch: number;
}
export interface ReceiptCandidates {
  amount?: number;
  issuedOn?: string;
  merchant?: string;
  merchantBizNo?: string;
}
export interface ReceiptOfferBody {
  msgId: string;
  capturedAt: number;
  mime: 'image/jpeg';
  bytes: number;
  sha256: string;
  chunkSize: number;
  chunkCount: number;
  width?: number;
  height?: number;
  ocrEngine: 'ios_vision' | 'android_mlkit' | 'none';
  ownerConfirmed: boolean;
  candidates?: ReceiptCandidates;
}
export interface ReceiptChunkBody {
  msgId: string;
  index: number;
  data: string;
}
export interface ReceiptAckBody {
  msgId: string;
  state: 'stored' | 'partial';
  missing?: number[];
}
export interface CashEntryBody {
  msgId: string;
  day: string;
  amount: number;
  enteredAt: number;
}
export interface CashAckBody {
  msgId: string;
  state: 'stored';
}
type Empty = Record<string, never>;

export interface Bodies {
  hello: HelloBody;
  'pair.ok': PairOkBody;
  'kek.grant': KekGrantBody;
  'devlist.push': { deviceList: DeviceListJson };
  'mbx.reissue': MbxReissueBody;
  close: Empty;
  ping: Empty;
  pong: Empty;
  'receipt.offer': ReceiptOfferBody;
  'receipt.chunk': ReceiptChunkBody;
  'receipt.ack': ReceiptAckBody;
  'cash.entry': CashEntryBody;
  'cash.ack': CashAckBody;
}
export type KnownType = keyof Bodies;
export type BodyOf<T extends string> = T extends KnownType ? Bodies[T] : object;

export interface Envelope<T extends string = string> {
  v: 1;
  type: T;
  id: string;
  pairId: string;
  from: Role;
  to: Role;
  seq: number;
  ts: number;
  ttl: number;
  replyTo?: string | null;
  body: BodyOf<T>;
}

/** 사진 청크 크기(스키마 const와 같다). */
export const RECEIPT_CHUNK = 49152;
export const RECEIPT_MAX_BYTES = 4194304;

function semanticOk(e: Envelope): boolean {
  if (e.from === e.to) return false;
  if (e.type === 'receipt.offer') {
    const b = e.body as ReceiptOfferBody;
    return b.chunkCount === Math.ceil(b.bytes / b.chunkSize);
  }
  if (e.type === 'receipt.chunk') {
    const b = e.body as ReceiptChunkBody;
    try {
      const n = fromB64(b.data).length;
      return n >= 1 && n <= RECEIPT_CHUNK;
    } catch {
      return false;
    }
  }
  return true;
}

/** 스키마 + 코드 검증(정규형 base64, 안전 정수 포함). 실패 이유는 로컬 디버그용으로만 쓴다(C/X-12). */
export function validateEnvelope(x: unknown): x is Envelope {
  if (!schemaValidate(x)) return false;
  if (!canonicalB64(x)) return false;
  return semanticOk(x as Envelope);
}

export function lastSchemaErrors(): unknown {
  return (schemaValidate as unknown as { errors?: unknown }).errors ?? null;
}

function canonicalB64(v: unknown, key?: string): boolean {
  if (key !== undefined && BIN.has(key)) {
    const items = Array.isArray(v) ? v : [v];
    for (const s of items) {
      if (typeof s !== 'string') return false;
      try {
        fromB64(s);
      } catch {
        return false;
      }
    }
    return true;
  }
  if (Array.isArray(v)) return v.every((x) => canonicalB64(x));
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => canonicalB64(x, k));
  // 모든 수는 안전 정수여야 한다(스키마 integer는 2^53 이상도 통과시키지만 CBOR 결정적 인코딩은 못 한다). 퍼징에서 발견.
  if (typeof v === 'number') return Number.isSafeInteger(v);
  return true;
}

/** JSON 모델 → CBOR 값(바이너리 키의 base64를 바이트열로). */
export function toCborModel(v: unknown, key?: string): CborValue {
  if (key !== undefined && BIN.has(key)) {
    if (Array.isArray(v)) return v.map((s) => fromB64(s as string));
    return fromB64(v as string);
  }
  if (v === undefined) throw new Error('envelope: undefined');
  if (Array.isArray(v)) return v.map((x) => toCborModel(x));
  if (v instanceof Uint8Array) throw new Error('envelope: raw bytes in JSON model');
  if (v && typeof v === 'object') {
    const o: Record<string, CborValue> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = toCborModel(x, k);
    return o;
  }
  return v as CborValue;
}

/** CBOR 값 → JSON 모델. 바이너리 키가 아닌 곳의 바이트열, 바이너리 키의 문자열은 거부한다. */
export function fromCborModel(v: CborValue, key?: string): unknown {
  if (key !== undefined && BIN.has(key)) {
    if (Array.isArray(v)) {
      return v.map((x) => {
        if (!(x instanceof Uint8Array)) throw new Error('envelope: expected bytes');
        return b64(x);
      });
    }
    if (!(v instanceof Uint8Array)) throw new Error('envelope: expected bytes');
    return b64(v);
  }
  if (v instanceof Uint8Array) throw new Error('envelope: unexpected bytes');
  if (Array.isArray(v)) return v.map((x) => fromCborModel(x));
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) o[k] = fromCborModel(x, k);
    return o;
  }
  return v;
}

export function encodeEnvelope(e: Envelope): Uint8Array {
  const type = e.type;
  if (!validateEnvelope(e)) throw new Error(`envelope: invalid ${type}`);
  const out = encodeCbor(toCborModel(e));
  if (out.length > MAX_INNER) throw new Error('envelope: too large for one frame');
  return out;
}

/** 실패는 null(조용히 버림). */
export function decodeEnvelope(b: Uint8Array): Envelope | null {
  try {
    const m = fromCborModel(decodeCbor(b, { maxBytes: MAX_INNER, maxItems: 2048 }));
    return validateEnvelope(m) ? m : null;
  } catch {
    return null;
  }
}

export interface EnvelopeCtx {
  pairId: string;
  from: Role;
  seq: number;
  now?: number;
  ttl?: number;
  replyTo?: string;
}

export function makeEnvelope<T extends KnownType>(type: T, body: Bodies[T], c: EnvelopeCtx): Envelope<T> {
  const now = c.now ?? Date.now();
  const e: Envelope<T> = {
    v: 1,
    type,
    id: ulid(now),
    pairId: c.pairId,
    from: c.from,
    to: c.from === 'desktop' ? 'mobile' : 'desktop',
    seq: c.seq,
    ts: now,
    ttl: c.ttl ?? 300,
    body: body as BodyOf<T>,
  };
  if (c.replyTo) e.replyTo = c.replyTo;
  return e;
}
