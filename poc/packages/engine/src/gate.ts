// 게이트 요청·승인 근거의 모양과 D03 §3 해시. main(승인 바)과 엔진이 같이 쓴다. node:crypto 말고 의존성이 없다
// (main이 엔진 코드를 끌어오지 않게 protocol.ts처럼 따로 둔다). 엔진과 main이 같은 함수를 쓰므로 자기 일치 확인이다(ADR-021).
import { createHash } from 'node:crypto';

// ---- 정규 인코딩 ----

type Cbor = string | number | boolean | null | Uint8Array | Cbor[] | { [k: string]: Cbor };

function head(major: number, n: number): Buffer {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('cbor_bad_length');
  const m = major << 5;
  if (n < 24) return Buffer.from([m | n]);
  if (n < 0x100) return Buffer.from([m | 24, n]);
  if (n < 0x10000) return Buffer.from([m | 25, n >> 8, n & 0xff]);
  if (n < 0x100000000) {
    const b = Buffer.alloc(5);
    b[0] = m | 26;
    b.writeUInt32BE(n, 1);
    return b;
  }
  const b = Buffer.alloc(9);
  b[0] = m | 27;
  b.writeBigUInt64BE(BigInt(n), 1);
  return b;
}

/**
 * RFC 8949 §4.2.1 결정적 인코딩(가장 짧은 길이, 맵 키는 인코딩된 바이트 사전순, 무한 길이 없음).
 * 이 PoC가 쓰는 모양만 받는다: 문자열·0 이상 정수·참거짓·null·바이트열·배열·문자열 키 맵. 그 밖은 던진다.
 */
export function cbor(v: Cbor): Buffer {
  if (typeof v === 'string') {
    const s = Buffer.from(v, 'utf8');
    return Buffer.concat([head(3, s.length), s]);
  }
  if (typeof v === 'number') return head(0, v);
  if (v === false) return Buffer.from([0xf4]);
  if (v === true) return Buffer.from([0xf5]);
  if (v === null) return Buffer.from([0xf6]);
  if (v instanceof Uint8Array) return Buffer.concat([head(2, v.length), v]);
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)]);
  const entries = Object.entries(v).map(([k, x]) => [cbor(k), cbor(x)] as const);
  entries.sort((a, b) => Buffer.compare(a[0], b[0]));
  return Buffer.concat([head(5, entries.length), ...entries.flat()]);
}

/** RFC 8785 JCS. 문자열·정수·배열·객체만 받는다(readback 값은 정규화한 문자열이다). */
export function jcs(v: unknown): string {
  if (typeof v === 'string' || typeof v === 'boolean' || v === null) return JSON.stringify(v);
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new Error('jcs_number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(jcs).join(',')}]`;
  if (typeof v === 'object') {
    // 키는 UTF-16 코드 단위 순서(기본 sort가 그렇다). undefined 값은 JSON.stringify처럼 뺀다.
    const keys = Object.keys(v as object).filter((k) => (v as Record<string, unknown>)[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  throw new Error('jcs_type');
}

export const sha256hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const hexBytes = (h: string) => {
  if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('bad_hash');
  return Buffer.from(h, 'hex');
};

// ---- 게이트 요청(엔진 → main 게이트 포트) ----

/** schemas/remote-envelope의 fieldKey 닫힌 목록(B-24). 예약 키($first.*·$dup.*)는 엔진만 만든다(ADR-021). */
export const FIELD_KEYS = [
  'supplyAmount', 'taxAmount', 'totalAmount', 'counterpartBizNo', 'counterpartName', 'counterpartEmail', 'supplierBizNo', 'supplierName',
  'issueDate', 'itemName', 'itemCount', 'remark', 'receiptType',
  '$first.bizNo', '$first.email', '$dup.businessKey', '$dup.priorNotCommitted', '$dup.otherDevice',
] as const;
export type FieldKey = (typeof FIELD_KEYS)[number];

export interface GateField {
  fieldKey: FieldKey;
  value: string;
}

export interface CardHashInputs {
  readbackHash: string;
  packageDigest: string;
  authorizes: string[];
  intentId: string;
}

export interface GateRequest {
  v: 2;
  runId: string;
  gateStepId: string;
  /** gate_requests.req_id. 같은 실행에서 게이트가 다시 열리면 바뀐다. */
  reqId: string;
  /** 엔진이 게이트 요청마다 만드는 로컬 전용 값(폰 챌린지·토큰 nonce와 다르다). */
  approvalNonce: string;
  docType: 'H-01';
  trigger: 'local';
  /** readback 값과 예약 키의 배열 전체. 순서도 cardHash에 들어간다. */
  fields: GateField[];
  cardHashInputs: CardHashInputs;
  actionHash: string;
  /** 승인 대기 상한(gate.waitMs). */
  waitMs: number;
}

export type Presence = 'click' | 'click+hello' | 'click+waiver';

/** main 승인 바가 발급하는 근거(ADR-021 결정 1). HMAC 문맥 SAX-local-approval-v2, exp = 발급 + 120초. */
export interface LocalApproval {
  v: 2;
  runId: string;
  gateStepId: string;
  reqId: string;
  approvalNonce: string;
  actionHash: string;
  exp: number;
  presence: Presence;
  mac: string;
}

export const LOCAL_APPROVAL_TTL_MS = 120_000;

/** 게이트 포트(main↔엔진 전용) 메시지. 이 포트에는 이것 말고 아무것도 다니지 않는다. */
export type GatePortMessage =
  | { t: 'gate.request'; req: GateRequest }
  | { t: 'gate.closed'; runId: string; reqId: string; reason: string }
  | { t: 'gate.answer'; approval: LocalApproval }
  | { t: 'gate.answer.result'; reqId: string; ok: boolean; code?: string };

// ---- D03 §3 해시 ----

/** cardHash = SHA-256(CBOR([[fieldKey, value], …])). 배열 전체(키·값·순서). */
export function cardHash(fields: readonly GateField[]): string {
  return sha256hex(cbor(fields.map((f) => [f.fieldKey, f.value])));
}

/** readbackHash = SHA-256(JCS{fieldKey: 정규화 값}). */
export function readbackHash(values: Readonly<Record<string, string>>): string {
  return sha256hex(jcs(values));
}

/** actionHash = SHA-256(CBOR{cardHash, readbackHash, authorizes[], packageDigest, intentId}). 해시는 바이트열로 넣는다. */
export function actionHash(card: string, i: CardHashInputs): string {
  return sha256hex(cbor({ cardHash: hexBytes(card), readbackHash: hexBytes(i.readbackHash), authorizes: i.authorizes, packageDigest: hexBytes(i.packageDigest), intentId: i.intentId }));
}

/** main이 게이트 요청을 받아 다시 계산한다. 같을 때만 바를 무장한다. */
export function recomputeActionHash(req: Pick<GateRequest, 'fields' | 'cardHashInputs'>): string {
  return actionHash(cardHash(req.fields), req.cardHashInputs);
}

export function isFieldKey(k: unknown): k is FieldKey {
  return typeof k === 'string' && (FIELD_KEYS as readonly string[]).includes(k);
}
