// 게이트 요청·승인 근거의 모양과 D03 §3 해시. main(승인 바)과 엔진이 같이 쓴다. node:crypto 말고 의존성이 없다
// (main이 엔진 코드를 끌어오지 않게 protocol.ts처럼 따로 둔다). 엔진과 main이 같은 함수를 쓰므로 자기 일치 확인이다(ADR-021).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Portal } from './core/types.ts';

// ---- 정규 인코딩 ----

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

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
    // 고립 서로게이트는 UTF-8로 바꿀 때 U+FFFD가 되어 다른 문자열과 같은 해시가 된다. 받지 않는다.
    if (LONE_SURROGATE.test(v)) throw new Error('cbor_bad_string');
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
  // 홈택스 민원증명 승인 카드(H-03·H-04·H-08·H-09 공통 cert.confirm, 팀장 결정 2026-11-09)
  'certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure',
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
  /** 서류 종류(승인 카드 id에서, CARD_DOC_TYPE). main은 이것으로 앞 readback 칸 수와 카드 줄을 고른다. */
  docType: GateDocType;
  trigger: 'local';
  /** readback 값과 예약 키의 배열 전체. 순서도 cardHash에 들어간다. */
  fields: GateField[];
  cardHashInputs: CardHashInputs;
  actionHash: string;
  /** 승인 대기 상한(gate.waitMs). */
  waitMs: number;
}

/** click+batch: 여러 건 묶음의 뒤 건. main이 같은 묶음의 처음 승인 카드에서 클릭을 관찰했고, 이 게이트의 되읽기 값이 그때 카드 값과 같다. */
export type Presence = 'click' | 'click+hello' | 'click+waiver' | 'click+batch';

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

// ---- InDoubt 증언(ADR-021 결정 5, D03 §2 InDoubt 행) ----

/** 증언 바 요약 2줄(공급받는자 상호·사업자번호, 합계금액). 이 순서·이 세 키만. */
export const ATTEST_SUMMARY_KEYS = ['counterpartName', 'counterpartBizNo', 'totalAmount'] as const satisfies readonly FieldKey[];

/**
 * 엔진 → main "증언을 받을 수 있다" 신호. 바를 띄우라는 뜻이 아니다: main은 무장만 하고, 렌더러가 그 "확인 필요" 카드를
 * 열었다고 요청할 때만 바를 띄운다. 보내는 때는 InDoubt이고 armed_at + policy.verify.minElapsedMs가 지나 조회 재시도를 1회 더 한 뒤,
 * 또는 정지 하향(postprocess·kill)이라 조회를 돌릴 수 없을 때 대기만 한 뒤(manualCheck). 철회될 때까지 유효하다(자기 만료 없음).
 */
export interface AttestRequest {
  v: 1;
  runId: string;
  intentId: string;
  stepId: string;
  /** 엔진이 증언 요청마다 만든다. 조회를 다시 해도 InDoubt가 그대로면 유지한다. */
  attestReqId: string;
  /** 로컬 전용 값. 게이트의 approvalNonce·토큰 nonce와 다르다. */
  attestNonce: string;
  portal: Portal;
  /** ATTEST_SUMMARY_KEYS 순서의 GateField 3개. */
  fields: GateField[];
  /** attestSummaryHash(fields). main이 다시 계산해 같을 때만 무장한다. */
  summaryHash: string;
  /** 조회 재시도 없이 받는 경우(정지 하향). 바에 "{포털} 발급목록을 직접 확인한 뒤 답해 주세요"를 더한다. */
  manualCheck: boolean;
}

/** main 증언 바가 발급하는 근거. 승인 근거와 다른 HMAC 문맥(LOCAL_ATTEST_CONTEXT), exp = 발급 + 120초. */
export interface LocalAttestation {
  v: 1;
  intentId: string;
  stepId: string;
  attestReqId: string;
  attestNonce: string;
  summaryHash: string;
  kind: 'not_committed';
  exp: number;
  mac: string;
}

export const LOCAL_ATTEST_TTL_MS = 120_000;
export const LOCAL_ATTEST_CONTEXT = 'SAX-local-attest-v1';

/** 요청 철회 사유: 조회로 해소, 게이트 바가 자리를 가져감, 실행 중지·kill. 카드 닫기는 main 안의 일이라 여기 없다. */
export type AttestWithdrawReason = 'resolved' | 'gate' | 'aborted';
/** 증언 거부 코드. 중계 통로에서 온 증언은 이 코드 대신 security.gate_answer_from_relay. */
export type AttestRejectCode = 'attest.no_request' | 'attest.mismatch' | 'attest.expired';

/** summaryHash = SHA-256(CBOR([[fieldKey, value], …])). cardHash와 같은 바이트 규칙. */
export function attestSummaryHash(fields: readonly GateField[]): string {
  return cardHash(fields);
}

/** 증언 요청 하나를 만든다. 엔진·개발 콘솔 시험 값·e2e가 같은 식을 쓴다. */
export function buildAttestRequest(d: {
  runId: string;
  intentId: string;
  stepId: string;
  portal: Portal;
  summary: Readonly<Record<(typeof ATTEST_SUMMARY_KEYS)[number], string>>;
  manualCheck: boolean;
  attestReqId?: string;
}): AttestRequest {
  const fields: GateField[] = ATTEST_SUMMARY_KEYS.map((k) => ({ fieldKey: k, value: d.summary[k] }));
  return {
    v: 1,
    runId: d.runId,
    intentId: d.intentId,
    stepId: d.stepId,
    attestReqId: d.attestReqId ?? randomUUID(),
    attestNonce: randomBytes(16).toString('base64url'),
    portal: d.portal,
    fields,
    summaryHash: attestSummaryHash(fields),
    manualCheck: d.manualCheck,
  };
}

/** main의 자기 일치 확인: 요약 키가 정확히 ATTEST_SUMMARY_KEYS 순서이고 summaryHash가 맞는지. 문제가 없으면 null. */
export function attestSelfCheck(req: Pick<AttestRequest, 'fields' | 'summaryHash'>): 'field_key' | 'summary_hash' | null {
  const f = req.fields;
  if (!Array.isArray(f) || f.length !== ATTEST_SUMMARY_KEYS.length || f.some((x, i) => x?.fieldKey !== ATTEST_SUMMARY_KEYS[i] || typeof x.value !== 'string')) return 'field_key';
  try {
    return attestSummaryHash(f) === req.summaryHash ? null : 'summary_hash';
  } catch {
    return 'summary_hash';
  }
}

/**
 * 엔진이 증언 근거를 미결 요청과 대조한다. 출처(게이트 포트만)·1회용은 엔진 상태로 따로 본다. 문제가 없으면 null.
 * HMAC은 Phase 1에 검증하는 쪽이 없다(ADR-021): 엔진은 키를 갖지 않고 게이트 포트로 왔다는 출처만 믿는다.
 */
export function checkAttestation(a: unknown, req: AttestRequest | null, now: number): AttestRejectCode | null {
  if (!req) return 'attest.no_request';
  const x = a as Partial<LocalAttestation> | null;
  if (!x || typeof x !== 'object' || x.attestReqId !== req.attestReqId) return 'attest.no_request';
  if (x.v !== 1 || x.kind !== 'not_committed' || x.attestNonce !== req.attestNonce || x.intentId !== req.intentId || x.stepId !== req.stepId || x.summaryHash !== req.summaryHash || typeof x.mac !== 'string') return 'attest.mismatch';
  if (typeof x.exp !== 'number' || !Number.isFinite(x.exp) || x.exp <= now || x.exp > now + LOCAL_ATTEST_TTL_MS) return 'attest.expired';
  return null;
}

/** 게이트 포트(main↔엔진 전용) 메시지. 이 포트에는 이것 말고 아무것도 다니지 않는다. */
export type GatePortMessage =
  | { t: 'gate.request'; req: GateRequest }
  | { t: 'gate.closed'; runId: string; reqId: string; reason: string }
  | { t: 'gate.answer'; approval: LocalApproval }
  | { t: 'gate.answer.result'; reqId: string; ok: boolean; code?: string }
  | { t: 'attest.request'; req: AttestRequest }
  | { t: 'attest.withdrawn'; runId: string; attestReqId: string; reason: AttestWithdrawReason }
  /** note는 선택이고 로컬 저널에만 남긴다(텔레메트리·로그 금지). */
  | { t: 'attest.answer'; attestation: LocalAttestation; note?: string }
  | { t: 'attest.answer.result'; attestReqId: string; ok: boolean; code?: AttestRejectCode };

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

/** readback 대상 fieldKey(D02 §8 s19b, 커밋 랜드마크 안 전부). 이 순서가 게이트 fields 앞 13칸의 순서다. */
export const READBACK_KEYS = [
  'supplierBizNo', 'supplierName', 'counterpartBizNo', 'counterpartName', 'counterpartEmail',
  'itemName', 'itemCount', 'supplyAmount', 'taxAmount', 'totalAmount', 'issueDate', 'remark', 'receiptType',
] as const satisfies readonly FieldKey[];
export type ReadbackKey = (typeof READBACK_KEYS)[number];

/** readback 칸(예약 키가 아닌 것) 수. 엔진은 readback 13칸을 앞에, 예약 키를 뒤에 둔다. */
export const READBACK_FIELD_COUNT = READBACK_KEYS.length;

/** 홈택스 민원증명 승인 카드(cert.confirm, H-03·H-04·H-08·H-09 공통)의 readback 칸. 순서가 게이트 fields 앞 칸의 순서다(APPROVAL_SUMMARIES와 같다). */
export const CERT_READBACK_KEYS = ['certDoc', 'certPurpose', 'certSubmitTo', 'rrnDisclosure'] as const satisfies readonly FieldKey[];

/** 게이트 요청 서류 종류. H-01 = 세금계산서, cert = 홈택스 민원증명. */
export type GateDocType = 'H-01' | 'cert';

/** 승인 카드 id → 서류 종류·게이트 fields 앞 readback 칸(앱 내장 표, 팀장 결정 2026-11-09). 표에 없는 카드는 게이트를 열지 않는다. */
export const GATE_CARDS: ReadonlyMap<string, { docType: GateDocType; keys: readonly FieldKey[] }> = new Map([
  ['invoice.confirm', { docType: 'H-01', keys: READBACK_KEYS }],
  ['cert.confirm', { docType: 'cert', keys: CERT_READBACK_KEYS }],
]);

/** 서류 종류 → readback 칸(gateSelfCheck가 앞 칸 수·키를 대조한다). */
const DOC_KEYS: Readonly<Record<GateDocType, readonly FieldKey[]>> = { 'H-01': READBACK_KEYS, cert: CERT_READBACK_KEYS };
/** 서류 종류별로 엔진이 늘 넣는 예약 키. H-01은 처음 거래·처음 보내는 주소다. 민원증명은 없다. */
const DOC_REQUIRED_RESERVED: Readonly<Record<GateDocType, readonly FieldKey[]>> = { 'H-01': ['$first.bizNo', '$first.email'], cert: [] };

/** 게이트 요청 하나를 만든다. 엔진 openGate·개발 콘솔 시험 값·e2e가 같은 식을 쓴다. */
export function buildGateRequest(d: {
  runId: string;
  gateStepId: string;
  /** 승인 카드 id(gate.card). 없으면 H-01 'invoice.confirm'. GATE_CARDS에 없으면 던진다. */
  card?: string;
  /** 카드의 readback 칸 값(GATE_CARDS keys 전부). */
  readback: Readonly<Record<string, string>>;
  reserved: GateField[];
  packageDigest: string;
  authorizes: string[];
  intentId: string;
  waitMs: number;
  reqId?: string;
}): GateRequest {
  const card = GATE_CARDS.get(d.card ?? 'invoice.confirm');
  if (!card) throw new Error('gate.unknown_card');
  const value = (k: FieldKey) => {
    const v = d.readback[k];
    if (typeof v !== 'string') throw new Error('gate.readback_missing');
    return v;
  };
  const fields: GateField[] = [...card.keys.map((k) => ({ fieldKey: k, value: value(k) })), ...d.reserved];
  const cardHashInputs = { readbackHash: readbackHash(Object.fromEntries(card.keys.map((k) => [k, value(k)]))), packageDigest: d.packageDigest, authorizes: d.authorizes, intentId: d.intentId };
  return {
    v: 2,
    runId: d.runId,
    gateStepId: d.gateStepId,
    reqId: d.reqId ?? randomUUID(),
    approvalNonce: randomBytes(16).toString('base64url'),
    docType: card.docType,
    trigger: 'local',
    fields,
    cardHashInputs,
    actionHash: actionHash(cardHash(fields), cardHashInputs),
    waitMs: d.waitMs,
  };
}

/**
 * main의 자기 일치 확인(ADR-021 "값 대조"): 닫힌 목록 밖 키·중복 키·예약 키 위치, readbackHash가 앞 13칸과 맞는지,
 * actionHash가 fields·cardHashInputs와 맞는지. 문제가 없으면 null. 엔진 버그를 잡는 장치이지 침해 방어가 아니다.
 */
export function gateSelfCheck(req: Pick<GateRequest, 'fields' | 'cardHashInputs' | 'actionHash'> & { docType?: GateDocType }): 'field_key' | 'duplicate' | 'readback_hash' | 'action_hash' | null {
  // docType이 없으면 H-01(이전 요청 모양). 모르는 서류 종류는 거부한다.
  const doc = req.docType ?? 'H-01';
  const rbKeys = Object.hasOwn(DOC_KEYS, doc) ? DOC_KEYS[doc] : null;
  if (!rbKeys) return 'field_key';
  const keys = req.fields.map((f) => f.fieldKey);
  if (!keys.every(isFieldKey) || req.fields.some((f) => typeof f.value !== 'string')) return 'field_key';
  if (new Set(keys).size !== keys.length) return 'duplicate';
  // H-01: 처음 거래·처음 보내는 주소는 엔진이 늘 넣는다. 빠지면 바가 표시 없이 무장하게 되므로 엔진 버그로 본다.
  if (DOC_REQUIRED_RESERVED[doc].some((k) => !keys.includes(k))) return 'field_key';
  // 앞 칸은 그 서류 종류의 readback 칸 그대로(키·순서), 뒤는 예약 키만.
  const n = rbKeys.length;
  const rb = req.fields.slice(0, n);
  if (rb.length !== n || rb.some((f, i) => f.fieldKey !== rbKeys[i]) || req.fields.slice(n).some((f) => !f.fieldKey.startsWith('$'))) return 'field_key';
  try {
    if (readbackHash(Object.fromEntries(rb.map((f) => [f.fieldKey, f.value]))) !== req.cardHashInputs.readbackHash) return 'readback_hash';
    if (recomputeActionHash(req) !== req.actionHash) return 'action_hash';
  } catch {
    return 'action_hash';
  }
  return null;
}

export function isFieldKey(k: unknown): k is FieldKey {
  return typeof k === 'string' && (FIELD_KEYS as readonly string[]).includes(k);
}
