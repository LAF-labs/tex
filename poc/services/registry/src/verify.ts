// 레지스트리 게시 관문 검증(D09 §8, ADR-013·023·028, D03 §3.1). 서버는 서명하지 않는다: 서명은 CI 밖 하드웨어 의식이고
// 여기에는 공개키만 있다. 서명 바이트·수용 규칙의 정본은 엔진 트랙의 design/schemas/SIGNING.md와 엔진 로더(packages/engine/src/core)다.
// 관문은 엔진이 받지 않을 것을 올리지 않으려고 같은 규칙을 먼저 적용한다. 스키마 검사·.sxp 해석·보수성 판정은 엔진 함수를 그대로 쓰고,
// 서명 세기·버전·신선도는 SIGNING.md §1~§7을 따라 여기서 센다(오류 코드도 엔진과 같다, D16).
import { verify as edVerify } from 'node:crypto';
import {
  HOTFIX_MAX_VALIDITY_D,
  canonicalJson,
  canonicalizable,
  canonicalWithout,
  decodeSxp,
  hotfixIndexName,
  isStrictlyConservative,
  loadDataPackage,
  schemaViolations,
  sha256Hex,
  statusIsConservative,
  type Hotfix,
  type Manifest,
  type Policy,
  type RegistryStatus as EngineStatus,
  type TrustRoots,
} from '@sax/engine/core';
import { validatePackage } from '@sax/payroll';
import { ed25519Public, fail, fromB64, type ErrorCode } from '@sax/svc-shared';

export type Role = 'root' | 'package' | 'policy' | 'timestamp' | 'emergency' | 'release';

/** 앱에 핀 고정된 키(keyEpoch 한 세대). 값은 Ed25519 공개키 32바이트 표준 base64. */
export interface TrustRoot {
  keyEpoch: number;
  keys: Record<Role, Record<string, string>>;
}

export interface Sig {
  keyId: string;
  alg: 'ed25519';
  sig: string;
}

const HOUR = 3_600_000;
export const LIMITS = {
  /** 새 단조 값 ≤ 저장값 + 1000(같은 keyEpoch, SIGNING.md §7) */
  versionJumpMax: 1000,
  /** issuedAt이 현재 + 5분보다 미래면 거부 */
  futureSkewMs: 5 * 60_000,
  indexMaxValidityMs: 14 * 24 * HOUR,
  hotfixMaxValidityMs: HOTFIX_MAX_VALIDITY_D * 24 * HOUR,
  policyMaxValidityMs: 72 * HOUR,
  statusMaxValidityMs: 48 * HOUR,
  revokedMaxValidityMs: 24 * HOUR,
  releaseMaxValidityMs: 14 * 24 * HOUR,
} as const;

/** 정책·status·폐기 목록의 내용 서명에서 빼는 필드(SIGNING.md §2) */
const FRESHNESS_FIELDS = ['signatures', 'issuedAt', 'expiresAt', 'timestamp'];
/** manifest·hotfix·인덱스·패키지 id(manifest.schema.json id 패턴: 점 필수) */
/** 인덱스 항목 id. 플레이북 manifest는 `-`를 받지 않지만 데이터 기술자(data_descriptor)는 받는다. 종류별 규칙은 .sxp 안 스키마가 본다. */
export const ID_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;

export function without<T extends Record<string, unknown>>(o: T, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
}

/** 정책·status·폐기 목록의 내용 다이제스트 = SHA-256(JCS(문서 − signatures·issuedAt·expiresAt·timestamp)) */
export const contentDigest = (doc: object): string => sha256Hex(canonicalWithout(doc, FRESHNESS_FIELDS));

/**
 * 검증 중 생긴 이벤트(코드만, 값 없음). 서명은 맞지만 폐기된 키 = registry.key_revoked(그 서명은 세지 않는다).
 * 호출 측이 넘기면 거부로 끝나도 이벤트가 남는다(엔진처럼 거부와 이벤트를 함께 기록).
 */
export interface Verdict {
  events: string[];
}

function edOk(pubB64: string, data: Buffer, sigB64u: unknown): boolean {
  const raw = fromB64(pubB64, 32);
  if (!raw || typeof sigB64u !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(sigB64u)) return false;
  try {
    return edVerify(null, data, ed25519Public(raw), Buffer.from(sigB64u, 'base64url'));
  } catch {
    return false;
  }
}

/**
 * 서로 다른 핀 키(그 역할)의 유효 서명을 센다(SIGNING.md §3). 같은 키 두 번은 1개, 다른 역할·모르는 keyId·alg ≠ ed25519는 세지 않는다.
 * 폐기된 키의 유효 서명은 revoked에 따로 모은다.
 */
export function countSignatures(data: Buffer, sigs: unknown, role: Role, trust: TrustRoot, revoked: ReadonlySet<string>): { valid: string[]; revoked: string[] } {
  const pinned = trust.keys[role] ?? {};
  const valid = new Set<string>();
  const rev = new Set<string>();
  for (const s of Array.isArray(sigs) ? (sigs as Sig[]) : []) {
    if (!s || typeof s !== 'object' || s.alg !== 'ed25519' || typeof s.keyId !== 'string' || !Object.hasOwn(pinned, s.keyId)) continue;
    if (!edOk(pinned[s.keyId]!, data, s.sig)) continue;
    if (revoked.has(s.keyId)) rev.add(s.keyId);
    else valid.add(s.keyId);
  }
  return { valid: [...valid], revoked: [...rev] };
}

function quorum(data: Buffer, sigs: unknown, role: Role, trust: TrustRoot, revoked: ReadonlySet<string>, need: number, v: Verdict): void {
  const q = countSignatures(data, sigs, role, trust, revoked);
  if (q.revoked.length) v.events.push('registry.key_revoked');
  if (q.valid.length < need) fail('registry.signature_insufficient');
}

/** 1인 긴급 키 서명본인가(서명이 정확히 1개, 그것이 핀 고정 긴급 키의 유효 서명) */
function emergencyOnly(data: Buffer, sigs: unknown, trust: TrustRoot, revoked: ReadonlySet<string>): boolean {
  return Array.isArray(sigs) && sigs.length === 1 && countSignatures(data, sigs, 'emergency', trust, revoked).valid.length === 1;
}

/** 2-of-3 또는 긴급 키 1개. 반환 true = 긴급 키 단독. */
function quorumOrEmergency(data: Buffer, sigs: unknown, role: 'policy', trust: TrustRoot, revoked: ReadonlySet<string>, v: Verdict): boolean {
  const q = countSignatures(data, sigs, role, trust, revoked);
  if (q.revoked.length) v.events.push('registry.key_revoked');
  if (q.valid.length >= 2) return false;
  if (emergencyOnly(data, sigs, trust, revoked)) return true;
  return fail('registry.signature_insufficient');
}

/** 아티팩트의 keyEpoch는 핀 고정 세대와 같아야 한다(SIGNING.md §3) */
function epoch(doc: { keyEpoch?: unknown }, trust: TrustRoot): void {
  if (doc.keyEpoch !== trust.keyEpoch) fail('registry.key_epoch_mismatch');
}

/** 타임스탬프(신선도) 서명 = 온라인 타임스탬프 키 1개가 JCS({contentDigest, monotonic, issuedAt, expiresAt})에(SIGNING.md §4) */
function timestamp(digest: string, doc: { timestamp?: unknown; monotonic: number; issuedAt: string; expiresAt: string }, trust: TrustRoot, revoked: ReadonlySet<string>): void {
  const ts = doc.timestamp as Sig | undefined;
  const body = Buffer.from(canonicalJson({ contentDigest: digest, monotonic: doc.monotonic, issuedAt: doc.issuedAt, expiresAt: doc.expiresAt }), 'utf8');
  if (!ts || typeof ts !== 'object' || ts.alg !== 'ed25519' || revoked.has(ts.keyId) || countSignatures(body, [ts], 'timestamp', trust, new Set()).valid.length !== 1) fail('registry.timestamp_invalid');
}

type WindowCodes = { tooLong: string; future: string; expired: string };
const REGISTRY_WINDOW = (tooLong: string): WindowCodes => ({ tooLong, future: 'registry.issued_in_future', expired: 'registry.expired_on_arrival' });

/** expiresAt > issuedAt, 유효 기간 ≤ 최대, issuedAt ≤ now + 5분, 도착 시 만료 아님 */
export function checkWindow(issuedAt: unknown, expiresAt: unknown, maxValidityMs: number, now: number, codes: WindowCodes): void {
  const i = typeof issuedAt === 'string' ? Date.parse(issuedAt) : NaN;
  const e = typeof expiresAt === 'string' ? Date.parse(expiresAt) : NaN;
  if (!Number.isFinite(i) || !Number.isFinite(e)) fail('registry.schema_invalid');
  if (!(e > i) || e - i > maxValidityMs) fail(codes.tooLong as never);
  if (i > now + LIMITS.futureSkewMs) fail(codes.future as never);
  if (e <= now) fail(codes.expired as never);
}

interface Mark {
  keyEpoch: number;
  monotonic: number;
}

/**
 * 같은 keyEpoch 안 단조(SIGNING.md §4·§7): 같은 monotonic은 내용 다이제스트가 같을 때만(신선도 재서명),
 * 그 밖에는 저장값 < 새 값 ≤ 저장값 + 1000. 반환 true = 같은 내용 재서명.
 */
export function checkMonotonic(next: Mark, digest: string, stored: (Mark & { digest: string }) | null): boolean {
  if (!Number.isSafeInteger(next.monotonic) || next.monotonic < 0) fail('registry.schema_invalid');
  if (!stored) return false;
  if (next.keyEpoch < stored.keyEpoch) fail('registry.key_epoch_rollback');
  if (next.keyEpoch > stored.keyEpoch) return false;
  if (next.monotonic === stored.monotonic) {
    if (digest !== stored.digest) fail('registry.version_rollback');
    return true;
  }
  if (next.monotonic < stored.monotonic) fail('registry.version_rollback');
  if (next.monotonic > stored.monotonic + LIMITS.versionJumpMax) fail('registry.version_jump_rejected');
  return false;
}

function schema(name: Parameters<typeof schemaViolations>[0], doc: unknown): void {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || schemaViolations(name, doc).length || !canonicalizable(doc)) fail('registry.schema_invalid');
}

// ---------- 폐기 목록 /registry/revoked_keys.json ----------

export interface RevokedKeys {
  monotonic: number;
  keyEpoch: number;
  revoked: Array<{ keyId: string; role: Role; revokedAt: string }>;
  issuedAt: string;
  expiresAt: string;
  signatures: Sig[];
  timestamp: Sig;
}

/**
 * 내용은 오프라인 루트 2-of-3(지금 받아 둔 이전 목록으로 거른 루트 키), 24시간 신선도는 타임스탬프 키(새 목록으로 거른다).
 * 폐기 목록은 줄어들 수 없다(registry.revoked_shrunk). 반환 keyIds = 새 폐기 집합.
 */
export function verifyRevoked(doc: RevokedKeys, trust: TrustRoot, stored: RevokedKeys | null, now: number, v: Verdict = { events: [] }): Verdict & { keyIds: Set<string> } {
  schema('revoked_keys', doc);
  const nextIds = new Set(doc.revoked.map((r) => r.keyId));
  if (nextIds.size !== doc.revoked.length) fail('registry.schema_invalid');
  epoch(doc, trust);
  const content = canonicalWithout(doc, FRESHNESS_FIELDS);
  const digest = sha256Hex(content);
  const prev = new Set(stored?.revoked.map((r) => r.keyId) ?? []);
  quorum(content, doc.signatures, 'root', trust, prev, 2, v);
  timestamp(digest, doc, trust, nextIds);
  checkWindow(doc.issuedAt, doc.expiresAt, LIMITS.revokedMaxValidityMs, now, REGISTRY_WINDOW('registry.revoked_validity_too_long'));
  checkMonotonic(doc, digest, stored ? { ...stored, digest: contentDigest(stored) } : null);
  for (const k of prev) if (!nextIds.has(k)) fail('registry.revoked_shrunk');
  return { ...v, keyIds: nextIds };
}

// ---------- 긴급 채널 /registry/status.json ----------

export interface RegistryStatus {
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  portalModeCeiling: Record<string, 'postprocess' | 'assisted' | 'auto'>;
  killPlaybooks: string[];
  timestamp: Sig;
  signatures: Sig[];
}

/**
 * status: 내용은 정책 키 2-of-3 또는 1인 긴급 키(하향·킬스위치 추가만), 신선도는 타임스탬프 키, 48시간.
 * 긴급 키 단독본은 저장된 status 대비 엄격하게 보수적일 때만 받는다. 저장된 status가 없으면(첫 설치) "상한 없음·킬 없음" 대비(SIGNING.md §2).
 */
export function verifyStatus(doc: RegistryStatus, trust: TrustRoot, revoked: ReadonlySet<string>, stored: RegistryStatus | null, now: number, v: Verdict = { events: [] }): Verdict & { emergency: boolean } {
  schema('status', doc);
  epoch(doc, trust);
  const content = canonicalWithout(doc, FRESHNESS_FIELDS);
  const digest = sha256Hex(content);
  const emergency = quorumOrEmergency(content, doc.signatures, 'policy', trust, revoked, v);
  const restamp = !!stored && contentDigest(stored) === digest;
  if (emergency && !restamp && !statusIsConservative(stored as EngineStatus | null, doc as EngineStatus)) fail('policy.rejected_not_conservative');
  timestamp(digest, doc, trust, revoked);
  checkWindow(doc.issuedAt, doc.expiresAt, LIMITS.statusMaxValidityMs, now, REGISTRY_WINDOW('registry.status_validity_too_long'));
  checkMonotonic(doc, digest, stored ? { ...stored, digest: contentDigest(stored) } : null);
  return { ...v, emergency };
}

// ---------- 정책 /policy/{ver}.json, /policy/current.json ----------

export interface SignedPolicy {
  version: string;
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  timestamp: Sig;
  signatures: Sig[];
  [k: string]: unknown;
}

/**
 * 정책: 내용은 정책 키 2-of-3 또는 1인 긴급 키(저장된 정책보다 엄격하게 보수적일 때만, 엔진 isStrictlyConservative),
 * 신선도는 타임스탬프 키, 72시간. 신선도 오류 코드는 엔진 정책 코드(policy.*)와 같다.
 */
export function verifyPolicy(doc: SignedPolicy, trust: TrustRoot, revoked: ReadonlySet<string>, stored: SignedPolicy | null, now: number, v: Verdict = { events: [] }): Verdict & { emergency: boolean } {
  schema('policy', doc);
  epoch(doc, trust);
  const content = canonicalWithout(doc, FRESHNESS_FIELDS);
  const digest = sha256Hex(content);
  const emergency = quorumOrEmergency(content, doc.signatures, 'policy', trust, revoked, v);
  timestamp(digest, doc, trust, revoked);
  checkWindow(doc.issuedAt, doc.expiresAt, LIMITS.policyMaxValidityMs, now, { tooLong: 'policy.validity_too_long', future: 'policy.issued_in_future', expired: 'policy.expired_on_arrival' });
  const restamp = checkMonotonic(doc, digest, stored ? { ...stored, digest: contentDigest(stored) } : null);
  if (emergency && !restamp && !(stored && isStrictlyConservative(stored as unknown as Policy, doc as unknown as Policy))) fail('policy.rejected_not_conservative');
  return { ...v, emergency };
}

// ---------- 패키지·핫픽스 .sxp /packages/{id}@{version}.sxp ----------

export interface SxpInfo extends Verdict {
  kind: 'playbook' | 'lookup' | 'hotfix' | 'data';
  /** 패키지 manifest의 portal(핫픽스는 대상 패키지 id의 첫 마디). 데이터 패키지에는 없다 */
  portal?: string;
}

/**
 * 레지스트리가 게시(패키지·핫픽스)와 배포(인덱스)에서 거부하는 portal.
 * wetax: 허락 회신 전(D09 §8.6, ADR-022 결정 2). fixture: 엔진 시험 가짜 페이지 패키지는 레지스트리로 오가지 않는다(ADR-039 결정 2 ③).
 */
export const BLOCKED_PORTALS: readonly string[] = ['wetax', 'fixture'];

const parse = (b: Uint8Array): unknown => {
  try {
    return JSON.parse(Buffer.from(b).toString('utf8'));
  } catch {
    return null;
  }
};

/**
 * .sxp v1(SIGNING.md §6)을 풀어 안의 서명까지 본다. 패키지: manifest 스키마, 패키지 키 2-of-3(JCS(manifest − signatures)),
 * contentDigests = 원시 파일 바이트, 파일 이름 = manifest id·version. 핫픽스: hotfix 스키마, 패키지 키 2-of-3(JCS(hotfix − signatures)),
 * keyEpoch, ≤ 14일, 파일 이름 = <appliesTo.id>.hotfix@<keyEpoch>.<monotonic>.0. 데이터 패키지(kind data)의 컨테이너는 SIGNING.md 범위 밖이라 아직 받지 않는다.
 */
/** 데이터 패키지 본문 검증기(schema 이름 → 앱 패키지의 검증 함수). 규칙은 그 패키지가 정본이고 관문은 그대로 부른다. */
export const DATA_SCHEMAS: ReadonlyMap<string, (body: unknown) => string[]> = new Map([['sax.rate-tables/v1', validatePackage]]);

/** 엔진 로더가 받는 신뢰 루트 모양(KeyObject 맵) */
export function engineRoots(trust: TrustRoot): TrustRoots {
  const m = (role: Role) => new Map(Object.entries(trust.keys[role] ?? {}).map(([id, b64]) => [id, ed25519Public(fromB64(b64, 32)!)] as const));
  const one = (role: Role) => {
    const [e] = [...m(role)];
    return e ? { keyId: e[0], key: e[1] } : { keyId: '', key: undefined as never };
  };
  return { keyEpoch: trust.keyEpoch, rootKeys: m('root'), packageKeys: m('package'), policyKeys: m('policy'), emergencyKey: one('emergency'), timestampKey: one('timestamp') };
}

/** 엔진 데이터 로더 코드 → 관문 오류 코드(D16 목록 안) */
const DATA_CODE: Record<string, ErrorCode> = {
  'loader.content_digest_mismatch': 'registry.content_digest_mismatch',
  'registry.signature_insufficient': 'registry.signature_insufficient',
  'registry.key_epoch_mismatch': 'registry.key_epoch_mismatch',
  'registry.issued_in_future': 'registry.issued_in_future',
};

export function verifySxp(bytes: Buffer, name: { id: string; version: string }, trust: TrustRoot, revoked: ReadonlySet<string>, now: number, v: Verdict = { events: [] }): SxpInfo {
  const d = decodeSxp(bytes);
  if (!d.ok) return fail(d.code);
  if (d.sxp.kind === 'data') {
    // SIGNING.md §6: 기술자 스키마·패키지 키 2-of-3·keyEpoch·bodyDigest·본문 검증기(급여 validatePackage)는 엔진 loadDataPackage가 본다.
    // 버전 내림은 인덱스 단조성으로 막으므로 여기서는 설치본이 없는 것으로 본다.
    const r = loadDataPackage(d.sxp.raw, { roots: engineRoots(trust), revoked, schemas: DATA_SCHEMAS, installed: null, hold: false, now });
    v.events.push(...r.events);
    if (!r.ok) return fail(DATA_CODE[r.code] ?? 'registry.schema_invalid');
    if (r.data.descriptor.id !== name.id || r.data.descriptor.version !== name.version) fail('registry.schema_invalid');
    return { ...v, kind: 'data' };
  }
  if (d.sxp.kind === 'package') {
    const m = parse(d.sxp.raw.manifest) as Manifest | null;
    schema('manifest', m);
    const manifest = m!;
    if (manifest.id.endsWith('.hotfix') || manifest.id !== name.id || manifest.version !== name.version) fail('registry.schema_invalid');
    quorum(canonicalWithout(manifest, ['signatures']), manifest.signatures, 'package', trust, revoked, 2, v);
    for (const k of ['playbook', 'selectors', 'strings'] as const) if (sha256Hex(d.sxp.raw[k]) !== manifest.contentDigests[k]) fail('registry.content_digest_mismatch');
    if (BLOCKED_PORTALS.includes(manifest.portal)) fail('registry.portal_blocked');
    return { ...v, kind: manifest.kind, portal: manifest.portal };
  }
  const h: Hotfix = d.sxp.hotfix;
  schema('hotfix', h);
  const n = hotfixIndexName(h);
  if (n.id !== name.id || n.version !== name.version) fail('registry.schema_invalid');
  quorum(canonicalWithout(h, ['signatures']), h.signatures, 'package', trust, revoked, 2, v);
  epoch(h, trust);
  checkWindow(h.issuedAt, h.expiresAt, LIMITS.hotfixMaxValidityMs, now, { tooLong: 'hotfix.validity_too_long', future: 'registry.issued_in_future', expired: 'hotfix.expired' });
  const portal = h.appliesTo.id.split('.')[0]!;
  if (BLOCKED_PORTALS.includes(portal)) fail('registry.portal_blocked');
  return { ...v, kind: 'hotfix', portal };
}

// ---------- 인덱스 /registry/{channel}/index.json ----------

export type Channel = 'stable' | 'beta' | 'hotfix';
export const CHANNELS: readonly Channel[] = ['stable', 'beta', 'hotfix'];

export interface IndexEntry {
  id: string;
  version: string;
  kind: 'playbook' | 'lookup' | 'hotfix' | 'data';
  portal?: string;
  /** SHA-256(.sxp 파일 바이트), SIGNING.md §5 */
  sxpDigest: string;
  size: number;
  /** 단계적 롤아웃 1 → 10 → 100 */
  rolloutPercent: number;
  minAppVersion?: string;
}

export interface RegistryIndex {
  channel: Channel;
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  entries: IndexEntry[];
  signatures: Sig[];
}

const INDEX_KEYS = new Set(['channel', 'monotonic', 'keyEpoch', 'issuedAt', 'expiresAt', 'entries', 'signatures']);
const ENTRY_KEYS = new Set(['id', 'version', 'kind', 'portal', 'sxpDigest', 'size', 'rolloutPercent', 'minAppVersion']);

/**
 * 인덱스: JCS(index − signatures)에 패키지 키 2-of-3, 문서 안 issuedAt·expiresAt(≤ 14일, 타임스탬프 없음), 채널별 단조 +1000(SIGNING.md §2·§7).
 * 핫픽스 채널은 핫픽스 항목만, 다른 채널은 핫픽스 항목 없음. 위택스 거부.
 */
export function verifyIndex(doc: RegistryIndex, channel: Channel, trust: TrustRoot, revoked: ReadonlySet<string>, stored: RegistryIndex | null, now: number, v: Verdict = { events: [] }): Verdict {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).some((k) => !INDEX_KEYS.has(k)) || doc.channel !== channel || !Array.isArray(doc.entries) || doc.entries.length > 500 || !canonicalizable(doc)) fail('registry.schema_invalid');
  const seen = new Set<string>();
  for (const e of doc.entries) {
    if (!e || typeof e !== 'object' || Object.keys(e).some((k) => !ENTRY_KEYS.has(k))) fail('registry.schema_invalid');
    if (typeof e.id !== 'string' || !ID_RE.test(e.id) || e.id.length > 128 || typeof e.version !== 'string' || !SEMVER_RE.test(e.version) || typeof e.sxpDigest !== 'string' || !/^[0-9a-f]{64}$/.test(e.sxpDigest)) fail('registry.schema_invalid');
    if (!['playbook', 'lookup', 'hotfix', 'data'].includes(e.kind) || !Number.isSafeInteger(e.size) || e.size < 1 || e.size > 16 * 1024 * 1024) fail('registry.schema_invalid');
    if (!Number.isInteger(e.rolloutPercent) || e.rolloutPercent < 0 || e.rolloutPercent > 100) fail('registry.schema_invalid');
    if (e.portal !== undefined && (typeof e.portal !== 'string' || !/^[a-z0-9_]{1,32}$/.test(e.portal))) fail('registry.schema_invalid');
    if (e.minAppVersion !== undefined && (typeof e.minAppVersion !== 'string' || !SEMVER_RE.test(e.minAppVersion))) fail('registry.schema_invalid');
    // 핫픽스 이름 규칙(SIGNING.md §6): id = <appliesTo.id>.hotfix, version = <keyEpoch>.<monotonic>.0. 패키지 id는 .hotfix로 끝날 수 없다.
    const hot = e.kind === 'hotfix';
    if (hot !== e.id.endsWith('.hotfix') || hot !== (channel === 'hotfix')) fail('registry.schema_invalid');
    if (hot && !new RegExp(`^${trust.keyEpoch}\\.\\d+\\.0$`).test(e.version)) fail('registry.schema_invalid');
    if (e.portal !== undefined && BLOCKED_PORTALS.includes(e.portal)) fail('registry.portal_blocked');
    const k = `${e.id}@${e.version}`;
    if (seen.has(k)) fail('registry.schema_invalid');
    seen.add(k);
  }
  epoch(doc, trust);
  const content = canonicalWithout(doc, ['signatures']);
  quorum(content, doc.signatures, 'package', trust, revoked, 2, v);
  checkWindow(doc.issuedAt, doc.expiresAt, LIMITS.indexMaxValidityMs, now, REGISTRY_WINDOW('registry.index_validity_too_long'));
  checkMonotonic(doc, sha256Hex(content), stored ? { ...stored, digest: sha256Hex(canonicalWithout(stored, ['signatures'])) } : null);
  return v;
}

/** .sxp 바이트가 인덱스 항목의 sxpDigest·size와 같은가 */
export function verifyPackageBytes(bytes: Buffer, entry: Pick<IndexEntry, 'sxpDigest' | 'size'>): void {
  if (bytes.length !== entry.size || sha256Hex(bytes) !== entry.sxpDigest) fail('registry.content_digest_mismatch');
}

/** 롤아웃 버킷: sha256('SAX-rollout-v1' ‖ 0 ‖ packageId ‖ 0 ‖ deviceId)의 앞 4바이트 mod 100. 클라이언트가 자기 비율을 정한다. */
export function rolloutBucket(packageId: string, deviceId: string): number {
  return Buffer.from(sha256Hex(`SAX-rollout-v1\u0000${packageId}\u0000${deviceId}`), 'hex').readUInt32BE(0) % 100;
}

export const inRollout = (e: Pick<IndexEntry, 'id' | 'rolloutPercent'>, deviceId: string): boolean => rolloutBucket(e.id, deviceId) < e.rolloutPercent;

// ---------- 앱 업데이트 /releases/{channel}/latest.json (+ latest.yml) ----------
// 릴리스 매니페스트 형식은 이 서비스가 정한다(SIGNING.md §9). 서명 바이트 규약(JCS, 맥락 없음, base64url)은 §1과 같다.

export interface ReleaseManifest {
  channel: Channel;
  version: string;
  releaseDate: string;
  expiresAt: string;
  rolloutPercent: number;
  files: Array<{ url: string; sha512: string; size: number }>;
  signature: Sig;
  /** 뿌리 변경 릴리스(ADR-028 결정 3, @sax/updater #76 제안): 루트 2-of-3 서명 */
  rootChange?: RootChange;
}

export const ROOT_CHANGES = ['keyEpoch', 'allowlist', 'ceiling'] as const;
export interface RootChange {
  /** 새 앱이 핀 고정할 keyEpoch. changes에 'keyEpoch'가 있으면 지금보다 커야 하고, 없으면 지금과 같아야 한다 */
  keyEpoch: number;
  changes: Array<(typeof ROOT_CHANGES)[number]>;
  signatures: Sig[];
}

const RELEASE_KEYS = new Set(['channel', 'version', 'releaseDate', 'expiresAt', 'rolloutPercent', 'files', 'signature', 'rootChange']);
const ROOT_CHANGE_KEYS = new Set(['keyEpoch', 'changes', 'signatures']);

/** 루트 키가 서명하는 내용: JCS(매니페스트 − signature, rootChange − signatures). 릴리스 키는 루트 서명까지 포함한 매니페스트 − signature에 서명한다(@sax/updater rootChangeContent와 같다) */
export function rootChangeContent(m: ReleaseManifest): Buffer {
  const rest = without(m as unknown as Record<string, unknown>, ['signature', 'rootChange']);
  return Buffer.from(canonicalJson(m.rootChange ? { ...rest, rootChange: without(m.rootChange as unknown as Record<string, unknown>, ['signatures']) } : rest), 'utf8');
}

function verifyRootChange(doc: ReleaseManifest, trust: TrustRoot, revoked: ReadonlySet<string>, v: Verdict): void {
  const rc = doc.rootChange as unknown as Record<string, unknown>;
  if (!rc || typeof rc !== 'object' || Array.isArray(rc) || Object.keys(rc).some((k) => !ROOT_CHANGE_KEYS.has(k))) fail('registry.schema_invalid');
  const { keyEpoch, changes, signatures } = rc as Partial<RootChange>;
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch! < 1) fail('registry.schema_invalid');
  if (!Array.isArray(changes) || changes.length < 1 || new Set(changes).size !== changes.length || !changes.every((c) => (ROOT_CHANGES as readonly unknown[]).includes(c))) fail('registry.schema_invalid');
  if (!Array.isArray(signatures) || signatures.length < 1 || signatures.length > 3) fail('registry.schema_invalid');
  // 세대 교체는 루트 서명으로만(D09 §8.4): keyEpoch를 바꾸면 커져야 하고, 안 바꾸면 그대로여야 한다
  if (changes!.includes('keyEpoch') ? keyEpoch! <= trust.keyEpoch : keyEpoch !== trust.keyEpoch) fail('registry.key_epoch_mismatch');
  quorum(rootChangeContent(doc), signatures, 'root', trust, revoked, 2, v);
}

const semver = (v: unknown): [number, number, number] => {
  const m = typeof v === 'string' ? /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v) : null;
  if (!m) return fail('registry.schema_invalid');
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};
export const semverGt = (a: string, b: string): boolean => {
  const x = semver(a);
  const y = semver(b);
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! > y[i]!;
  return false;
};

/**
 * 릴리스 매니페스트: CI 밖 하드웨어 1인 키(release) 서명, 만료 ≤ 14일, 다운그레이드 금지(저장값보다 큰 version만).
 * 클라이언트 main은 이 검증과 투명성 로그·미러 확인 뒤에만 electron-updater에 sha512를 넘긴다(ADR-028).
 */
export function verifyRelease(doc: ReleaseManifest, channel: Channel, trust: TrustRoot, revoked: ReadonlySet<string>, stored: ReleaseManifest | null, now: number, v: Verdict = { events: [] }): Verdict {
  if (!doc || typeof doc !== 'object' || Object.keys(doc).some((k) => !RELEASE_KEYS.has(k)) || doc.channel !== channel || !Array.isArray(doc.files) || doc.files.length < 1 || doc.files.length > 8 || !canonicalizable(doc)) fail('registry.schema_invalid');
  for (const f of doc.files) {
    if (!f || !/^[A-Za-z0-9._-]{1,128}$/.test(f.url) || !/^[A-Za-z0-9+/]{86}==$/.test(f.sha512) || !Number.isSafeInteger(f.size) || f.size < 1) fail('registry.schema_invalid');
  }
  if (!Number.isInteger(doc.rolloutPercent) || doc.rolloutPercent < 0 || doc.rolloutPercent > 100) fail('registry.schema_invalid');
  semver(doc.version);
  quorum(canonicalWithout(doc, ['signature']), [doc.signature], 'release', trust, revoked, 1, v);
  if (doc.rootChange !== undefined) verifyRootChange(doc, trust, revoked, v);
  // 같은 버전은 신선도 재발행(파일 목록이 같을 때만, @sax/updater와 같은 규칙), 낮은 버전은 롤백
  if (stored && !semverGt(doc.version, stored.version) && !(doc.version === stored.version && canonicalJson(doc.files) === canonicalJson(stored.files))) fail('registry.version_rollback');
  checkWindow(doc.releaseDate, doc.expiresAt, LIMITS.releaseMaxValidityMs, now, REGISTRY_WINDOW('registry.release_validity_too_long'));
  return v;
}

/** electron-updater용 latest.yml. 검증을 통과한 매니페스트에서만 만들고 값은 위 정규식으로 제한돼 YAML 주입이 없다. */
export function renderLatestYml(m: ReleaseManifest): string {
  const lines = [`version: ${m.version}`, 'files:'];
  for (const f of m.files) lines.push(`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`);
  lines.push(`path: ${m.files[0]!.url}`, `sha512: ${m.files[0]!.sha512}`, `releaseDate: '${new Date(Date.parse(m.releaseDate)).toISOString()}'`);
  return lines.join('\n') + '\n';
}
