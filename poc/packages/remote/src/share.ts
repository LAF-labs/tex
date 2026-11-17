// 계정 공유 기록(ADR-048 결정 5, D07 §10). 계정의 PC와 폰이 발급 기록·거래처·내 사업자·받을 돈과 낼 돈 요약·밀린 일을 같이 쓴다. 대화는 싣지 않는다.
// [검토] 암호 리뷰(SP-5) 대상이다.
//
// 서버(계정 서비스)는 줄의 종류·순번·시각·크기·올린 기기만 보고, 내용은 계정 열쇠에서 나온 키로 봉인한 암호문이다.
//   K_share(e) = HKDF-SHA256(RK, "share/v1/" ‖ e)       e = 기기 목록의 폐기 레코드 수(세대). PC는 금고가 RK에서 만들고, 폰은 PC가 종단간 통로로 준다.
//   Ws         = Ed25519(HKDF-SHA256(RK, "share/sig/v1")) 계정 공유 기록 서명 키. PC 금고만 서명한다. 공개키는 폰이 K_share와 같이 받는다.
//   줄         = XChaCha20-Poly1305(K_share(e), pad(JCS({core, sig})), aad = "SAX-share-v1" ‖ JCS({epoch, kind, row_id}))
//   sig        = Ed25519("SAX-share-v1" ‖ JCS(core))     PC가 쓴 줄은 Ws, 폰이 쓴 줄은 그 폰의 Vm
//
// - 세대: 기기를 끊으면 폐기 레코드가 하나 늘고(AIK 서명, 목록 버전으로 되돌리기를 막는다) 세대가 오른다. 끊긴 폰은 새 세대 키를 받지 못한다.
//   끊긴 PC는 RK를 갖고 있어서 세대로는 막지 못한다. 서버가 그 PC의 호출을 거부하는 것에 기댄다(ADR-048 결정 6 남는 위험).
// - PC 줄을 기기 키가 아니라 Ws로 서명하는 이유: 끊긴 기기의 공개키는 목록에서 빠지므로, 나중에 붙은 기기가 옛 줄을 확인할 길이 없어진다.
//   Ws는 RK에서 나오므로 계정의 PC면 누구나 서명·검증하고, 폰은 공개키로 검증만 한다. 폰은 PC 줄(발급 기록·거래처)을 지어낼 수 없다.
// - 폰 줄(맡긴 일)은 그 폰의 Vm으로 서명한다. 일을 맡는 PC는 그 폰이 지금 기기 목록에 있을 때만 받는다.
// - 서버는 줄을 숨기거나 순서를 바꿀 수 있다. 그래서 줄은 순서에 기대지 않는다: 발급 기록은 승인번호가 같으면 한 건이고,
//   거래처는 사업자번호마다, 내 사업자와 돈 요약은 계정에서 (at, dev)가 가장 큰 줄이 이긴다.
//   같은 건을 두 번 내지 않는 판단은 공유 기록이 아니라 포털 기준선(D03 §4)이 한다.
import { b64, b64url, concat, equal, fromB64, fromB64url, fromUtf8, utf8 } from './bytes.ts';
import { CTX } from './contexts.ts';
import { ed25519Verify, hkdfSha256, randomBytes, xOpen, xSeal } from './crypto.ts';
import { MAX_REVOKED } from './devlist.ts';
import type { DeviceListJson, Role, ShareKeyBody } from './envelope.ts';
import { jcs, jcsBytes } from './jcs.ts';

/** 줄 종류. 계정 서비스 SHARE.kinds와 같다. */
export const SHARE_KINDS = ['issue', 'party', 'self', 'money', 'task', 'task_result'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
/** 폰이 쓸 수 있는 종류. 나머지는 PC만 쓴다(서버도 역할로 막는다). */
export const SHARE_MOBILE_KINDS: readonly ShareKind[] = ['task'];
/** 평문 패딩 버킷(바이트). 서버는 버킷 크기만 본다. 서명과 줄 머리만으로 300바이트쯤이라 가장 작은 버킷이 512다. */
export const SHARE_PAD_BUCKETS = [512, 1024, 4096, 16384] as const;
/** 줄 본문(b64url) 최대 길이: (가장 큰 버킷 + 논스 24 + 태그 16)의 b64url. 계정 서비스 SHARE.maxBodyChars와 같다. */
export const SHARE_MAX_BODY_CHARS = Math.ceil(((SHARE_PAD_BUCKETS[SHARE_PAD_BUCKETS.length - 1]! + 40) * 4) / 3);
export const SHARE_MAX_EPOCH = MAX_REVOKED;
/** 맡긴 일의 유효 시간. 지나면 서버가 맡김을 주지 않는다(계정 서비스 SHARE.taskTtlMs와 같다, D08 §7 queue.ttlHours). */
export const SHARE_TASK_TTL_MS = 72 * 3_600_000;

const ROW_ID = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BIZ_NO = /^\d{10}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** 전자세금계산서 승인번호: 숫자 24자리(가운데 줄표는 쓰는 쪽이 뺀다). */
const APPROVAL_NO = /^\d{24}$/;
const CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;
const MONTH = /^\d{4}-\d{2}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

/** 거래처 줄에 싣는 저장 품목 수 상한(@sax/db COUNTERPARTY_ITEMS_MAX와 같다). */
export const SHARE_PARTY_ITEMS_MAX = 20;
/** 돈 요약의 "많은 순" 목록 길이 상한. */
export const SHARE_MONEY_TOP_MAX = 5;
/** 돈 요약에 싣는 "입금 확인이 안 된 승인번호" 수 상한. 넘으면 오래된 것부터 싣고 count로 전체 수를 알린다. */
export const SHARE_MONEY_OPEN_MAX = 300;
/** 폰이 맡길 수 있는 일. 값이 늘면 PC가 모르는 일은 받지 않는다. */
export const SHARE_TASK_DO = ['tax_invoice.issue'] as const;
export type ShareTaskDo = (typeof SHARE_TASK_DO)[number];

/** 지금 세대: AIK로 검증한 기기 목록의 폐기 레코드 수. 목록은 받는 쪽이 먼저 verifyDeviceList로 확인한다. */
export const shareEpoch = (list: DeviceListJson): number => list.revoked.length;
/** K_share(e)의 HKDF info. 금고가 RK로 만든다. */
export const shareKeyInfo = (epoch: number): string => {
  if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch > SHARE_MAX_EPOCH) throw new Error('share: epoch');
  return `share/v1/${epoch}`;
};
/** Ws 시드의 HKDF info. 금고가 RK로 만든다. */
export const SHARE_SIGN_INFO = 'share/sig/v1';
/** 시험·금고 구현이 같이 쓰는 유도식. RK는 금고 밖으로 나오지 않는다. */
export const deriveShareKey = (rk: Uint8Array, epoch: number): Uint8Array => hkdfSha256(rk, shareKeyInfo(epoch), 32);
export const deriveShareSignSeed = (rk: Uint8Array): Uint8Array => hkdfSha256(rk, SHARE_SIGN_INFO, 32);

export const newShareRowId = (): string => b64url(randomBytes(16));

// ---- 종류별 본문 ----

/** 발급 기록. 승인번호가 같으면 한 건이다(먼저 본 줄을 쓴다). 수정세금계산서는 새 승인번호의 새 줄이고 금액이 음수일 수 있다. */
export interface ShareIssue {
  doc: 'tax_invoice';
  approvalNo: string;
  /** 작성일자 YYYY-MM-DD */
  writtenOn: string;
  buyerBizNo: string;
  buyerName: string;
  supply: number;
  tax: number;
  item?: string;
  /** 이 발급이 맡긴 일에서 나왔으면 그 일의 줄 id */
  taskRow?: string;
  /** app: 앱이 발급. manual: 사람이 포털에서 직접 낸 것을 앱이 확인 */
  how: 'app' | 'manual';
}
/** 거래처에 저장한 품목(@sax/db CounterpartyItem과 같다). 고르는 후보일 뿐 발급 값이 아니다. */
export interface SharePartyItem {
  name: string;
  /** 원 단위 정수(0 이상). 정하지 않았으면 null */
  unitPrice: number | null;
  unit: string | null;
}
/** 거래처. 사업자번호마다 (at, dev)가 가장 큰 줄이 이긴다. */
export interface ShareParty {
  bizNo: string;
  name: string;
  rep?: string;
  address?: string;
  email?: string;
  /** 저장 품목. 없으면 "모른다"이고 빈 배열이면 "없다"다 */
  items?: SharePartyItem[];
  /** 지운 거래처 */
  removed?: true;
}
/** 내 사업자(공급자). 계정에서 (at, dev)가 가장 큰 줄이 이긴다. 폰이 "내 사업자번호"를 말로 받았을 때 대조하는 데 쓴다. */
export interface ShareSelf {
  bizNo: string;
  name: string;
  rep?: string;
}
/** 돈 요약의 상대 한 곳. cp는 장부의 상호만 쓴다(개인 입금자 이름·은행 메모·계좌번호는 싣지 않는다). */
export interface ShareMoneyTop {
  cp: string;
  total: number;
  count: number;
}
/**
 * 받을 돈·낼 돈·이번 달 현금 요약. 은행 자료가 있는 PC가 한 장으로 올리고, 계정에서 (at, dev)가 가장 큰 줄이 이긴다.
 * 모르는 값은 0이 아니라 null이다. 거래 내역·계좌번호·은행 메모는 싣지 않는다.
 */
export interface ShareMoney {
  /** 요약을 만든 시각(ISO, UTC) */
  asOf: string;
  /** 은행 자료의 마지막 날짜. 은행 자료가 없으면 null */
  latestDay: string | null;
  /** 은행 자료가 오래돼 숫자를 그대로 믿기 어렵다 */
  stale: boolean;
  recv: {
    count: number | null;
    total: number | null;
    overdueCount: number | null;
    overdueTotal: number | null;
    oldest: { cp: string; writtenOn: string; daysOver: number } | null;
    top: ShareMoneyTop[];
    /** 입금 확인이 안 된 발급의 승인번호(발급 기록 줄과 맞춰 본다). 없으면 "모른다" */
    open?: string[];
  };
  pay: { count: number | null; total: number | null; overdueCount: number | null; overdueTotal: number | null; top: ShareMoneyTop[] };
  /** 은행 자료가 없으면 null */
  cash: {
    /** YYYY-MM */
    month: string;
    /** 이 날짜까지의 자료다 */
    through: string;
    complete: boolean;
    in: number | null;
    out: number | null;
    net: number | null;
    balance: number | null;
    nextIn: number | null;
    nextOut: number | null;
  } | null;
}
/**
 * 맡긴 일. 실행은 PC 한 대가 서버에서 맡은 뒤(claim) 시작 게이트·커밋 게이트를 그대로 지난다(D08 §7). 비밀은 넣지 않는다.
 * PC는 거래처(buyerBizNo)가 자기 장부에 있을 때만 받고, 값은 승인 카드에 그대로 보인다.
 */
export interface ShareTask {
  do: ShareTaskDo;
  buyerBizNo: string;
  /** 공급가액·세액(원). 0보다 크다. 수정 발급은 맡기지 못한다 */
  supply: number;
  tax: number;
  item: string;
  /** 없으면 거래처에 저장된 이메일 */
  email?: string;
  note?: string;
}
export interface ShareTaskResult {
  taskRow: string;
  outcome: 'issued' | 'failed' | 'cancelled';
  approvalNo?: string;
  /** 실패 코드(D16). 값은 넣지 않는다 */
  code?: string;
}
export interface ShareBodies {
  issue: ShareIssue;
  party: ShareParty;
  self: ShareSelf;
  money: ShareMoney;
  task: ShareTask;
  task_result: ShareTaskResult;
}

const str = (v: unknown, max: number, min = 1): v is string => typeof v === 'string' && v.length >= min && v.length <= max && v === v.normalize('NFC');
const optStr = (v: unknown, max: number): boolean => v === undefined || str(v, max);
const WON_MAX = 999_999_999_999;
const won = (v: unknown): v is number => Number.isSafeInteger(v) && Math.abs(v as number) <= WON_MAX;
const wonOrNull = (v: unknown): boolean => v === null || won(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1_000_000;
const countOrNull = (v: unknown): boolean => v === null || count(v);
const only = (o: Record<string, unknown>, keys: readonly string[]): boolean => Object.keys(o).every((k) => keys.includes(k));
const has = (o: Record<string, unknown>, keys: readonly string[]): boolean => keys.every((k) => k in o);
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const day = (v: unknown): v is string => typeof v === 'string' && DAY.test(v);
const bizNo = (v: unknown): v is string => typeof v === 'string' && BIZ_NO.test(v);
const approvalNo = (v: unknown): v is string => typeof v === 'string' && APPROVAL_NO.test(v);

const partyItem = (v: unknown): boolean =>
  obj(v) && only(v, ['name', 'unitPrice', 'unit']) && has(v, ['name', 'unitPrice', 'unit']) && str(v.name, 100) &&
  (v.unitPrice === null || (won(v.unitPrice) && v.unitPrice >= 0)) && (v.unit === null || str(v.unit, 20));
const moneyTop = (v: unknown): boolean =>
  Array.isArray(v) && v.length <= SHARE_MONEY_TOP_MAX && v.every((t) => obj(t) && only(t, ['cp', 'total', 'count']) && str(t.cp, 100) && won(t.total) && count(t.count));
const MONEY_SUM = ['count', 'total', 'overdueCount', 'overdueTotal'] as const;
const moneySum = (o: Record<string, unknown>): boolean => has(o, MONEY_SUM) && countOrNull(o.count) && wonOrNull(o.total) && countOrNull(o.overdueCount) && wonOrNull(o.overdueTotal);
const CASH_KEYS = ['month', 'through', 'complete', 'in', 'out', 'net', 'balance', 'nextIn', 'nextOut'] as const;

const BODY_CHECK: { [K in ShareKind]: (b: Record<string, unknown>) => boolean } = {
  issue: (b) =>
    only(b, ['doc', 'approvalNo', 'writtenOn', 'buyerBizNo', 'buyerName', 'supply', 'tax', 'item', 'taskRow', 'how']) && b.doc === 'tax_invoice' &&
    approvalNo(b.approvalNo) && day(b.writtenOn) && bizNo(b.buyerBizNo) && str(b.buyerName, 100) && won(b.supply) && won(b.tax) && optStr(b.item, 100) &&
    (b.taskRow === undefined || (typeof b.taskRow === 'string' && ROW_ID.test(b.taskRow))) && (b.how === 'app' || b.how === 'manual'),
  party: (b) =>
    only(b, ['bizNo', 'name', 'rep', 'address', 'email', 'items', 'removed']) && bizNo(b.bizNo) && str(b.name, 100) &&
    optStr(b.rep, 50) && optStr(b.address, 200) && optStr(b.email, 254) && (b.removed === undefined || b.removed === true) &&
    (b.items === undefined || (Array.isArray(b.items) && b.items.length <= SHARE_PARTY_ITEMS_MAX && b.items.every(partyItem))),
  self: (b) => only(b, ['bizNo', 'name', 'rep']) && bizNo(b.bizNo) && str(b.name, 100) && optStr(b.rep, 50),
  money: (b) => {
    if (!only(b, ['asOf', 'latestDay', 'stale', 'recv', 'pay', 'cash']) || !has(b, ['asOf', 'latestDay', 'stale', 'recv', 'pay', 'cash'])) return false;
    if (typeof b.asOf !== 'string' || !ISO_TIME.test(b.asOf) || !(b.latestDay === null || day(b.latestDay)) || typeof b.stale !== 'boolean') return false;
    const { recv, pay, cash } = b;
    if (!obj(recv) || !only(recv, [...MONEY_SUM, 'oldest', 'top', 'open']) || !moneySum(recv) || !moneyTop(recv.top)) return false;
    const old = recv.oldest;
    if (!(old === null || (obj(old) && only(old, ['cp', 'writtenOn', 'daysOver']) && str(old.cp, 100) && day(old.writtenOn) && count(old.daysOver)))) return false;
    if (!(recv.open === undefined || (Array.isArray(recv.open) && recv.open.length <= SHARE_MONEY_OPEN_MAX && recv.open.every(approvalNo) && new Set(recv.open).size === recv.open.length))) return false;
    if (!obj(pay) || !only(pay, [...MONEY_SUM, 'top']) || !moneySum(pay) || !moneyTop(pay.top)) return false;
    if (cash === null) return true;
    return obj(cash) && only(cash, CASH_KEYS) && has(cash, CASH_KEYS) && typeof cash.month === 'string' && MONTH.test(cash.month) && day(cash.through) && typeof cash.complete === 'boolean' &&
      wonOrNull(cash.in) && wonOrNull(cash.out) && wonOrNull(cash.net) && wonOrNull(cash.balance) && wonOrNull(cash.nextIn) && wonOrNull(cash.nextOut);
  },
  task: (b) =>
    only(b, ['do', 'buyerBizNo', 'supply', 'tax', 'item', 'email', 'note']) && (SHARE_TASK_DO as readonly unknown[]).includes(b.do) && bizNo(b.buyerBizNo) &&
    won(b.supply) && b.supply > 0 && won(b.tax) && b.tax >= 0 && str(b.item, 100) && optStr(b.email, 254) && optStr(b.note, 200),
  task_result: (b) =>
    only(b, ['taskRow', 'outcome', 'approvalNo', 'code']) && typeof b.taskRow === 'string' && ROW_ID.test(b.taskRow) &&
    (b.outcome === 'issued' || b.outcome === 'failed' || b.outcome === 'cancelled') &&
    (b.approvalNo === undefined || approvalNo(b.approvalNo)) && (b.outcome !== 'issued' || b.approvalNo !== undefined) &&
    (b.code === undefined || (typeof b.code === 'string' && b.code.length <= 64 && CODE.test(b.code))),
};

// ---- 줄 ----

/** 서명되는 줄의 속. 서버는 보지 못한다. */
export interface ShareRowCore<K extends ShareKind = ShareKind> {
  v: 1;
  row_id: string;
  kind: K;
  epoch: number;
  /** 쓴 기기의 시계(ms). 순서 판단은 거래처·내 사업자·돈 요약의 "마지막 값"에만 쓴다 */
  at: number;
  /** 쓴 기기 */
  dev: string;
  by: Role;
  body: ShareBodies[K];
}
/** 서버에 올리는 모양(계정 서비스 PUT /v1/share/rows/:rowId). */
export interface ShareRowWire {
  rowId: string;
  kind: ShareKind;
  epoch: number;
  /** b64url(nonce ‖ ct) */
  body: string;
}

const aadOf = (w: { rowId: string; kind: ShareKind; epoch: number }): Uint8Array => concat(utf8(CTX.share), jcsBytes({ epoch: w.epoch, kind: w.kind, row_id: w.rowId }));
const coreOf = (c: ShareRowCore): ShareRowCore => ({ v: c.v, row_id: c.row_id, kind: c.kind, epoch: c.epoch, at: c.at, dev: c.dev, by: c.by, body: c.body });
const coreInput = (c: ShareRowCore): Uint8Array => jcsBytes(coreOf(c));

function padRow(p: Uint8Array): Uint8Array {
  const bucket = SHARE_PAD_BUCKETS.find((b) => b >= p.length + 1);
  if (bucket === undefined) throw new Error('share: row too large');
  const out = new Uint8Array(bucket);
  out.set(p);
  out[p.length] = 0x80;
  return out;
}
function unpadRow(p: Uint8Array): Uint8Array | null {
  if (!(SHARE_PAD_BUCKETS as readonly number[]).includes(p.length)) return null;
  let i = p.length - 1;
  while (i >= 0 && p[i] === 0) i--;
  if (i < 0 || p[i] !== 0x80) return null;
  return p.subarray(0, i);
}

function checkCore(c: unknown): c is ShareRowCore {
  if (!obj(c) || !only(c, ['v', 'row_id', 'kind', 'epoch', 'at', 'dev', 'by', 'body'])) return false;
  if (c.v !== 1 || typeof c.row_id !== 'string' || !ROW_ID.test(c.row_id) || !(SHARE_KINDS as readonly unknown[]).includes(c.kind)) return false;
  if (!Number.isSafeInteger(c.epoch) || (c.epoch as number) < 0 || (c.epoch as number) > SHARE_MAX_EPOCH) return false;
  if (!Number.isSafeInteger(c.at) || (c.at as number) <= 0 || typeof c.dev !== 'string' || !UUID.test(c.dev)) return false;
  if (c.by !== 'desktop' && c.by !== 'mobile') return false;
  if (c.by === 'mobile' && !SHARE_MOBILE_KINDS.includes(c.kind as ShareKind)) return false;
  return obj(c.body) && BODY_CHECK[c.kind as ShareKind](c.body);
}

/** 서명 함수: PC는 금고의 Ws 서명(crypto.signShare), 폰은 Vm(SAX-share-v1). 입력은 컨텍스트를 뺀 JCS(core)다. */
export type ShareSign = (msg: Uint8Array) => Promise<Uint8Array>;

/** 줄을 서명하고 봉인한다. 본문이 규칙에 맞지 않으면 던진다(올리기 전에 막는다). */
export async function sealShareRow<K extends ShareKind>(key: Uint8Array, core: ShareRowCore<K>, sign: ShareSign): Promise<ShareRowWire> {
  if (key.length !== 32) throw new Error('share: key');
  if (!checkCore(core)) throw new Error('share: row shape');
  const sig = await sign(coreInput(core));
  if (sig.length !== 64) throw new Error('share: signature');
  const plain = jcsBytes({ core: coreOf(core), sig: b64url(sig) });
  const wire = { rowId: core.row_id, kind: core.kind, epoch: core.epoch };
  return { ...wire, body: b64url(xSeal(key, padRow(plain), aadOf(wire))) };
}

/** 서명자를 찾는 쪽이 주는 것: PC 줄은 Ws 공개키, 폰 줄은 지금 기기 목록에 있는 그 폰의 Vm 공개키(없으면 null). */
export interface ShareVerifyKeys {
  sharePub: Uint8Array;
  mobileSignPub(deviceId: string): Uint8Array | null;
}
export type ShareOpen =
  | { ok: true; row: ShareRowCore }
  /** key: 이 키로 열리지 않는다(다른 세대·손상). shape: 모양이 규칙 밖. mismatch: 바깥(종류·세대·id)과 속이 다르다. signer: 서명자를 모른다(목록에 없는 폰). signature: 서명이 틀리다 */
  | { ok: false; reason: 'key' | 'shape' | 'mismatch' | 'signer' | 'signature' };

/** 받은 줄을 열고 서명을 확인한다. 서버가 준 입력이라 어떤 모양이 와도 던지지 않는다. */
export function openShareRow(key: Uint8Array, wire: ShareRowWire, keys: ShareVerifyKeys): ShareOpen {
  try {
    if (key.length !== 32 || typeof wire.body !== 'string' || wire.body.length > SHARE_MAX_BODY_CHARS || !ROW_ID.test(wire.rowId)) return { ok: false, reason: 'shape' };
    let padded: Uint8Array;
    try {
      padded = xOpen(key, fromB64url(wire.body), aadOf(wire));
    } catch {
      return { ok: false, reason: 'key' };
    }
    const plain = unpadRow(padded);
    if (!plain) return { ok: false, reason: 'shape' };
    const text = fromUtf8(plain);
    const v: unknown = JSON.parse(text);
    if (jcs(v) !== text || !obj(v) || !only(v, ['core', 'sig']) || typeof v.sig !== 'string' || !checkCore(v.core)) return { ok: false, reason: 'shape' };
    const core = v.core;
    if (core.row_id !== wire.rowId || core.kind !== wire.kind || core.epoch !== wire.epoch) return { ok: false, reason: 'mismatch' };
    const pub = core.by === 'desktop' ? keys.sharePub : keys.mobileSignPub(core.dev);
    if (!pub) return { ok: false, reason: 'signer' };
    const sig = fromB64url(v.sig);
    if (sig.length !== 64 || !ed25519Verify(pub, CTX.share, coreInput(core), sig)) return { ok: false, reason: 'signature' };
    return { ok: true, row: core };
  } catch {
    return { ok: false, reason: 'shape' };
  }
}

// ---- 읽는 쪽 합치기(순서에 기대지 않는다) ----

/** 발급 기록: 승인번호마다 한 건. 같은 번호가 또 오면 먼저 받은 줄을 둔다. */
export function mergeShareIssues(rows: readonly ShareRowCore<'issue'>[]): ShareRowCore<'issue'>[] {
  const seen = new Map<string, ShareRowCore<'issue'>>();
  for (const r of rows) if (!seen.has(r.body.approvalNo)) seen.set(r.body.approvalNo, r);
  return [...seen.values()];
}
const newer = (a: ShareRowCore, b: ShareRowCore): boolean => a.at > b.at || (a.at === b.at && a.dev > b.dev);
/** 내 사업자·돈 요약: 계정에서 (at, dev)가 가장 큰 줄 하나. 없으면 null. */
export function latestShareRow<K extends 'self' | 'money'>(rows: readonly ShareRowCore<K>[]): ShareRowCore<K> | null {
  let last: ShareRowCore<K> | null = null;
  for (const r of rows) if (!last || newer(r, last)) last = r;
  return last;
}
/** 거래처: 사업자번호마다 (at, dev)가 가장 큰 줄. 지운 거래처(removed)는 결과에서 뺀다. */
export function mergeShareParties(rows: readonly ShareRowCore<'party'>[]): ShareRowCore<'party'>[] {
  const last = new Map<string, ShareRowCore<'party'>>();
  for (const r of rows) {
    const cur = last.get(r.body.bizNo);
    if (!cur || newer(r, cur)) last.set(r.body.bizNo, r);
  }
  return [...last.values()].filter((r) => !r.body.removed);
}

// ---- 폰에 열쇠 주기(remote-envelope v1.9 share.key, D08 §6) ----

/** 폰이 갖는 계정 공유 기록 열쇠: 세대마다 K_share(e), 그리고 PC 줄 서명 확인용 Ws 공개키. */
export interface ShareKeySet {
  signPub: Uint8Array;
  /** 세대 0부터 지금 세대까지(빠짐없이). keys[e] = K_share(e) */
  keys: Uint8Array[];
}

/** share.key 본문을 만든다. keys[e] = K_share(e), 세대 0부터 빠짐없이. */
export function makeShareKeyBody(set: ShareKeySet): ShareKeyBody {
  if (set.signPub.length !== 32 || set.keys.length < 1 || set.keys.length > SHARE_MAX_EPOCH + 1 || set.keys.some((k) => k.length !== 32)) throw new Error('share: key set shape');
  return { shareSignPub: b64(set.signPub), shareKeys: set.keys.map((k, epoch) => ({ epoch, shareKey: b64(k) })) };
}

/**
 * 받은 share.key 본문을 연다(폰). 세대가 0부터 빠짐없이 오름차순이 아니거나 길이가 다르면 null.
 * have가 있으면(이미 가진 열쇠) 겹치는 세대의 값과 서명 키가 같아야 한다: 같은 계정의 열쇠는 바뀌지 않는다.
 * 다르면 null이고, 폰은 가진 것을 그대로 둔다(PC가 계정 열쇠를 바꾼 경우는 다시 연결해야 한다, D08 §9.4).
 */
export function readShareKeyBody(body: ShareKeyBody, have?: ShareKeySet | null): ShareKeySet | null {
  let signPub: Uint8Array;
  const keys: Uint8Array[] = [];
  try {
    signPub = fromB64(body.shareSignPub);
    if (!Array.isArray(body.shareKeys) || body.shareKeys.length < 1 || body.shareKeys.length > SHARE_MAX_EPOCH + 1) return null;
    for (const [i, k] of body.shareKeys.entries()) {
      if (k.epoch !== i) return null;
      keys.push(fromB64(k.shareKey));
    }
  } catch {
    return null;
  }
  if (signPub.length !== 32 || keys.some((k) => k.length !== 32)) return null;
  if (have) {
    if (!equal(have.signPub, signPub)) return null;
    for (let e = 0; e < Math.min(have.keys.length, keys.length); e++) if (!equal(have.keys[e]!, keys[e]!)) return null;
    // 세대는 내려가지 않는다: 가진 것보다 짧은 묶음은 옛 세션의 것이다
    if (keys.length < have.keys.length) return null;
  }
  return { signPub, keys };
}
