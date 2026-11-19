// D08 §6 라이브 메시지 봉투. JSON 모델(바이너리는 base64, 스키마 표기)과 와이어(CBOR, 바이너리는 바이트열)를 오간다.
// 검증은 remote-envelope.schema.json에서 미리 만든 코드(schema.gen.ts)로 한다. 송신 전·수신 후 모두 검증한다.

import { b64, fromB64 } from './bytes.ts';
import { decodeCbor, encodeCbor, type CborValue } from './cbor.ts';
import { MAX_INNER } from './frame.ts';
import { BINARY_KEYS, MESSAGE_TYPES, validate as schemaValidate } from './schema.gen.ts';
import { ulid } from './ulid.ts';

export type Role = 'desktop' | 'mobile';
/** 스키마 type enum과 같아야 한다(tests/remote-envelope.test.ts가 대조). */
export type MessageType = 'hello' | 'pair.ok' | 'kek.grant' | 'devlist.push' | 'mbx.reissue' | 'close' | 'ping' | 'pong' | 'receipt.offer' | 'receipt.chunk' | 'receipt.ack' | 'cash.entry' | 'cash.ack' | 'cmd.run' | 'cmd.abort' | 'cmd.resume' | 'run.event' | 'gate.request' | 'gate.response' | 'consent.request' | 'consent.response' | 'human.request' | 'human.response' | 'file.offer' | 'query.documents' | 'query.result' | 'rotate.static' | 'cmd.ack' | 'phone.copy' | 'share.key' | 'px.enroll' | 'px.ack' | 'gate.refresh' | 'gate.resolved';

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
  /** 계정 서비스가 서명한 계정 확인 주장(acctclaim.ts, v1.6). 폰은 검증 실패면 저장하지 않는다. */
  acctClaim: string;
  /** PC가 스스로 알린 이름(서명 없음, 참고 표시만). */
  desktopName?: string;
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
/** 종이 세금계산서·계산서 당사자(remote-envelope v1.7 $defs/paperParty). bizNo는 000-00-00000 */
export interface PaperParty {
  bizNo: string;
  name: string;
  ceo?: string;
  address?: string;
}
export interface PaperInvoiceItem {
  month?: number;
  day?: number;
  name: string;
  spec?: string;
  /** 정수(와이어 CBOR에 실수 없음). 소수 수량은 spec에 */
  qty?: number;
  unitPrice?: number;
  supply: number;
  vat?: number;
}
/**
 * 종이(손글씨·인쇄) 세금계산서·계산서를 폰에서 찍고 사장님이 확인한 값(v1.7, hello 기능 receipt.v2).
 * 폰 값은 후보다: PC가 자기 사업자번호로 direction을 다시 정하고 합계·체크섬을 다시 본다(checkPaperInvoice).
 */
export interface PaperInvoice {
  docKind: 'tax_invoice' | 'invoice';
  direction: 'sales' | 'purchase';
  writtenOn: string;
  approvalNo?: string;
  bookNo?: string;
  serialNo?: string;
  supplier: PaperParty;
  buyer: PaperParty;
  supplyAmount: number;
  vatAmount: number;
  total: number;
  items?: PaperInvoiceItem[];
  receiptOrClaim: 'receipt' | 'claim' | null;
  /** 칸 이름 → 0~100 정수(사장님이 고친 칸은 100) */
  fieldConfidence?: Record<string, number>;
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
  /** v1.7: PC가 receipt.v2를 알렸을 때만 */
  paperInvoice?: PaperInvoice;
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

// v1.8(ADR-046 결정 2·5): 폰 발급 명령·진행·폰 사본.
export interface CmdRunBody {
  cmdId: string;
  playbookId: string;
  inputs: Record<string, unknown>;
}
export type CmdAckState = 'accepted' | 'start_gate' | 'pc_only' | 'rejected';
export type CmdRejectReason = 'playbook_unavailable' | 'input_invalid' | 'counterparty_unknown' | 'duplicate' | 'pc_busy' | 'hometax_paused';
export interface CmdAckBody {
  cmdId: string;
  state: CmdAckState;
  runId?: string;
  reason?: CmdRejectReason;
}
export type RunPhase = 'prepare' | 'login' | 'readback' | 'approve' | 'issue' | 'verify' | 'done' | 'stopped';
export interface RunResult {
  approvalNo: string;
  total: number;
  emailSent?: boolean;
  docId?: string;
}
export interface RunEventBody {
  runId: string;
  event: string;
  at: number;
  stepId?: string;
  code?: string;
  status?: string;
  cmdId?: string;
  phase?: RunPhase;
  attempt?: number;
  deadline?: number;
  result?: RunResult;
  /** v1.11: 실행마다 PC가 run.event를 보낼 때마다 1씩 올린다. 폰은 적용한 것보다 크지 않은 rev를 버린다(sync.v1을 알린 폰에만). */
  rev?: number;
}
export interface GateField {
  key: string;
  value: string;
}
export interface GateRequestBody {
  runId: string;
  stepId: string;
  reqId: string;
  cardId: string;
  gateKind: 'start' | 'commit';
  queuedAt?: number;
  effects: string[];
  fields: GateField[];
  cardHashInputs: { readbackHash: string; packageDigest: string; authorizes: string[]; intentId: string };
  actionHash: string;
  requiredSigAlg: 'ed25519' | 'p256';
  challenge: string;
  exp: number;
}
export interface GateResponseBody {
  runId: string;
  stepId: string;
  reqId: string;
  decision: 'approve' | 'deny';
  actionHash: string;
  sigAlg: 'ed25519' | 'p256';
  sig: string;
}
/** v1.10(ADR-052 결정 2): 폰 승인 키(Px) 등록 알림과 답, 승인 요청 다시 받기. */
export type PxHw = 'ios_se' | 'android_strongbox' | 'android_tee';
export interface PxEnrollBody {
  /** P-256 공개키, SEC1 비압축 65바이트(base64) */
  pxPub: string;
  hw: PxHw;
  /** Ed25519_Vm("SAX-px-enroll-v1" ‖ CBOR([pairId, deviceId, pxPub, hw])) */
  sig: string;
}
export type PxAckState = 'enrolled' | 'needs_pc' | 'rejected';
export interface PxAckBody {
  state: PxAckState;
  pxId: string;
}
export interface GateRefreshBody {
  runId: string;
  reqId: string;
}
/** v1.11: 폰에 보낸 게이트가 닫혔다. 폰은 그 reqId의 승인 시트를 바로 닫는다(sync.v1을 알린 폰에만). */
export type GateResolvedBy = 'pc' | 'phone' | 'expired' | 'stopped';
export interface GateResolvedBody {
  runId: string;
  reqId: string;
  by: GateResolvedBy;
}
export interface MoneySide {
  unpaidCount: number;
  unpaidTotal: number;
  overdueCount: number;
  overdueTotal: number;
  dueSoonCount: number;
  dueSoonTotal: number;
  reviewCount: number;
}
export interface CopyCashflow {
  month: string;
  complete: boolean;
  missing?: string[];
  inTotal?: number | null;
  outTotal?: number | null;
  net?: number | null;
  in30?: number | null;
  out30?: number | null;
  noDueOutCount?: number;
  alerts?: { id: string; kind: 'low_balance' | 'slow_collection' | 'concentration' | 'unknown_inflow'; text: string }[];
}
export interface CopyCounterparty {
  ref: string;
  name: string;
  aliases?: string[];
  bizNo?: string;
  emailHint?: string;
  phoneApprovable?: boolean;
  last?: { supply: number; vatMode: 'excl' | 'incl'; item: string; day: string };
}
/**
 * 계정 공유 기록 열쇠(v1.9, ADR-048 결정 5, D07 §10). PC→폰, 라이브 세션 전용. 폰이 hello에서 share.v1을 알렸을 때만 보낸다.
 * shareKeys는 세대 0부터 지금 세대까지 빠짐없이 오름차순이다. 폰은 RK를 받지 않는다.
 */
export interface ShareKeyBody {
  /** Ws(Ed25519) 공개키. PC가 쓴 줄의 서명을 확인한다 */
  shareSignPub: string;
  shareKeys: { epoch: number; shareKey: string }[];
}
export interface PhoneCopyBody {
  asOf: number;
  counterparties: CopyCounterparty[];
  toIssue?: { ref: string; supply: number; item: string; due?: string }[];
  money?: { asOf: number; accounts?: number; receivable: MoneySide; payable: MoneySide; cashflow?: CopyCashflow };
  todayApprovalsLeft?: number;
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
  'cmd.run': CmdRunBody;
  'cmd.ack': CmdAckBody;
  'run.event': RunEventBody;
  'gate.request': GateRequestBody;
  'gate.response': GateResponseBody;
  'phone.copy': PhoneCopyBody;
  'share.key': ShareKeyBody;
  'px.enroll': PxEnrollBody;
  'px.ack': PxAckBody;
  'gate.refresh': GateRefreshBody;
  'gate.resolved': GateResolvedBody;
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
    const m = fromCborModel(decodeCbor(b, { maxBytes: MAX_INNER, maxItems: 8192 }));
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
