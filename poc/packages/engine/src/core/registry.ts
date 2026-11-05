// D03 §3.1 레지스트리 신뢰 검사(B-22, C-26, E-04·E-05·E-14, ADR-013·023): 핀 고정 키의 Ed25519 2-of-3, 폐기 목록,
// keyEpoch 안 단조 버전(+1000 이하), 타임스탬프 키 신선도 서명, issuedAt 미래 거부, status(하향·킬스위치 전용),
// 미러 트리 헤드 비교(일관성 증명). 결과는 코드만 담는다(값 없음).
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalJson, canonicalWithout, sha256Hex } from './canon.ts';
import { EMERGENCY_STATUS_TTL_H, ISSUED_AT_MAX_SKEW_MIN, MODE_ORDER, STATUS_MAX_AGE_H, STATUS_STALE_DAEMON_STOP_H, VERSION_JUMP_MAX } from './constants.ts';
import { clampPolicy, freshnessProblem, isStrictlyConservative } from './policy.ts';
import { schemaViolations } from './schema.ts';
import type { Policy, Portal, PortalMode, Signature } from './types.ts';

const H = 3_600_000;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 32바이트 원시 공개키 → KeyObject. */
export function ed25519PublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new Error('ed25519_key_length');
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' });
}

/** 앱에 핀 고정된 키(앱 업데이트로만 바뀐다, D09 §8.2). 키 세대 keyEpoch도 핀 고정이다. */
export interface TrustRoots {
  keyEpoch: number;
  /** 오프라인 루트 키 3개(2-of-3, revoked_keys.json 본문 서명). */
  rootKeys: ReadonlyMap<string, KeyObject>;
  packageKeys: ReadonlyMap<string, KeyObject>;
  policyKeys: ReadonlyMap<string, KeyObject>;
  emergencyKey: { keyId: string; key: KeyObject };
  timestampKey: { keyId: string; key: KeyObject };
}

/** revoked_keys.json(D09 §8.4): 본문은 루트 2-of-3, 24시간 신선도는 타임스탬프 키 재서명. */
export interface RevokedKeys {
  keyIds: string[];
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  signatures: Signature[];
  timestamp: Signature;
}

export function verifyEd25519(key: KeyObject, data: Uint8Array, sig: string): boolean {
  try {
    const b = Buffer.from(sig, 'base64url');
    return b.length === 64 && edVerify(null, data, key, b);
  } catch {
    return false;
  }
}

export interface QuorumResult {
  /** 서로 다른 유효 키 id(폐기 키 제외). */
  valid: string[];
  /** 서명은 맞지만 폐기된 키(registry.key_revoked). */
  revoked: string[];
}

/** 서로 다른 핀 고정 키의 유효 서명을 센다. 같은 키 id가 둘이면 한 번만 센다. */
export function countSignatures(data: Uint8Array, sigs: readonly Signature[], keys: ReadonlyMap<string, KeyObject>, revoked: ReadonlySet<string>): QuorumResult {
  const valid = new Set<string>();
  const rev = new Set<string>();
  for (const s of sigs) {
    if (s.alg !== 'ed25519') continue;
    const k = keys.get(s.keyId);
    if (!k || !verifyEd25519(k, data, s.sig)) continue;
    if (revoked.has(s.keyId)) rev.add(s.keyId);
    else valid.add(s.keyId);
  }
  return { valid: [...valid], revoked: [...rev] };
}

// ---- 버전(같은 keyEpoch 안 단조) ----

export interface VersionMark {
  keyEpoch: number;
  monotonic: number;
}

export type VersionProblem = 'registry.version_rollback' | 'registry.version_jump_rejected' | 'registry.key_epoch_rollback';

/** 저장값과 비교(D03 §3.1-3). keyEpoch가 올라가면 그 세대의 첫 값으로 받는다. 같은 값의 재수신은 monotonicProblem이 내용으로 가른다. */
export function versionProblem(stored: VersionMark | null, next: VersionMark): VersionProblem | null {
  if (!stored) return null;
  if (next.keyEpoch < stored.keyEpoch) return 'registry.key_epoch_rollback';
  if (next.keyEpoch > stored.keyEpoch) return null;
  if (next.monotonic <= stored.monotonic) return 'registry.version_rollback';
  if (next.monotonic > stored.monotonic + VERSION_JUMP_MAX) return 'registry.version_jump_rejected';
  return null;
}

// ---- 타임스탬프 신선도(E-05) ----

export interface Timestamped {
  monotonic: number;
  issuedAt: string;
  expiresAt: string;
  timestamp: Signature;
}

/** 타임스탬프 키 서명 대상 = JCS({contentDigest, monotonic, issuedAt, expiresAt}). */
export function timestampBody(contentDigest: string, d: Pick<Timestamped, 'monotonic' | 'issuedAt' | 'expiresAt'>): Buffer {
  return Buffer.from(canonicalJson({ contentDigest, monotonic: d.monotonic, issuedAt: d.issuedAt, expiresAt: d.expiresAt }), 'utf8');
}

export function verifyTimestamp(contentDigest: string, d: Timestamped, roots: TrustRoots): boolean {
  return d.timestamp.keyId === roots.timestampKey.keyId && verifyEd25519(roots.timestampKey.key, timestampBody(contentDigest, d), d.timestamp.sig);
}

export const issuedInFuture = (issuedAt: string, now: number) => Date.parse(issuedAt) > now + ISSUED_AT_MAX_SKEW_MIN * 60_000;

/** 서명 대상 본문 = 신선도 필드(issuedAt·expiresAt·timestamp)와 signatures를 뺀 JCS. 정책·status·폐기 목록이 같다. */
export const contentBytes = (o: object) => canonicalWithout(o, ['signatures', 'issuedAt', 'expiresAt', 'timestamp']);

/** 아티팩트의 keyEpoch는 앱에 핀 고정된 세대와 같아야 한다(세대 변경은 오프라인 루트 서명 + 앱 업데이트). */
export const epochProblem = (a: { keyEpoch: number }, roots: TrustRoots) => (a.keyEpoch === roots.keyEpoch ? null : ('registry.key_epoch_mismatch' as const));

/** 같은 monotonic은 내용이 같을 때만(신선도 재서명). 내용이 바뀌었는데 monotonic이 같으면 롤백으로 본다. */
export function monotonicProblem(stored: (VersionMark & { contentDigest: string }) | null, next: VersionMark, contentDigest: string): VersionProblem | null {
  if (stored && next.keyEpoch === stored.keyEpoch && next.monotonic === stored.monotonic) return contentDigest === stored.contentDigest ? null : 'registry.version_rollback';
  return versionProblem(stored, next);
}

export interface AcceptedRevoked {
  list: RevokedKeys;
  contentDigest: string;
  keyIds: Set<string>;
}

export type RevokedDecision = { ok: true; accepted: AcceptedRevoked } | { ok: false; code: string };

export const REVOKED_MAX_VALIDITY_H = 24;

/** 폐기 목록 수용. 실패하면 그 파일만 버리고 마지막 유효 목록을 유지한다(목록이 줄어드는 롤백 방지: monotonic). */
export function acceptRevoked(next: RevokedKeys, ctx: { roots: TrustRoots; current: AcceptedRevoked | null; now: number }): RevokedDecision {
  if (schemaViolations('revoked_keys', next).length) return { ok: false, code: 'registry.schema_invalid' };
  const ep = epochProblem(next, ctx.roots);
  if (ep) return { ok: false, code: ep };
  const content = contentBytes(next);
  const digest = sha256Hex(content);
  if (countSignatures(content, next.signatures, ctx.roots.rootKeys, new Set()).valid.length < 2) return { ok: false, code: 'registry.signature_insufficient' };
  if (!verifyTimestamp(digest, next, ctx.roots)) return { ok: false, code: 'registry.timestamp_invalid' };
  if (issuedInFuture(next.issuedAt, ctx.now)) return { ok: false, code: 'registry.issued_in_future' };
  const iss = Date.parse(next.issuedAt);
  const exp = Date.parse(next.expiresAt);
  if (!(exp > iss) || exp - iss > REVOKED_MAX_VALIDITY_H * H) return { ok: false, code: 'registry.revoked_validity_too_long' };
  const cur = ctx.current;
  const vp = monotonicProblem(cur ? { ...cur.list, contentDigest: cur.contentDigest } : null, next, digest);
  if (vp) return { ok: false, code: vp };
  // 폐기는 되돌릴 수 없다: 새 목록은 현재 목록의 상위 집합.
  if (cur && [...cur.keyIds].some((k) => !next.keyIds.includes(k))) return { ok: false, code: 'registry.revoked_shrunk' };
  return { ok: true, accepted: { list: next, contentDigest: digest, keyIds: new Set(next.keyIds) } };
}

/** 24시간 신선도를 잃으면 새 패키지·정책·핫픽스 로드를 보류한다(설치본 유지, 엄격하게 보수적인 정책·status는 통과). */
export const revokedFresh = (r: AcceptedRevoked | null, now: number) => !!r && now < Date.parse(r.list.expiresAt);

// ---- 레지스트리 status(하향·킬스위치 전용) ----

export interface RegistryStatus {
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  portals: Partial<Record<Portal, { portalModeCeiling: PortalMode }>>;
  killPlaybooks: string[];
  signatures: Signature[];
  timestamp: Signature;
}

/** status 내용 다이제스트 = JCS(status − signatures·issuedAt·expiresAt·timestamp). */
export const statusContentDigest = (s: RegistryStatus) => sha256Hex(contentBytes(s));

export interface AcceptedStatus {
  status: RegistryStatus;
  contentDigest: string;
  /** 1인 긴급 키만으로 서명됨(72시간 뒤 자동 만료, 2-of-3 재확인 없으면 되돌림). */
  emergency: boolean;
  /** 이 내용이 처음 발행된 시각(타임스탬프 재서명으로 늘어나지 않는다). 긴급 status 72시간 만료의 기준. */
  contentIssuedAt: string;
  acceptedAt: number;
}

export type StatusDecision = { ok: true; accepted: AcceptedStatus; events: string[] } | { ok: false; code: string; events: string[] };

/** 하향·킬스위치만 하는가(현재 대비 모든 포털 상한 ≤, kill ⊇, 하나 이상 엄격). */
export function statusIsConservative(cur: RegistryStatus | null, next: RegistryStatus): boolean {
  const ceil = (s: RegistryStatus | null, p: Portal) => MODE_ORDER[s?.portals[p]?.portalModeCeiling ?? 'auto'];
  let strict = false;
  for (const p of new Set([...Object.keys(cur?.portals ?? {}), ...Object.keys(next.portals)]) as Set<Portal>) {
    if (ceil(next, p) > ceil(cur, p)) return false;
    if (ceil(next, p) < ceil(cur, p)) strict = true;
  }
  const ck = new Set(cur?.killPlaybooks ?? []);
  const nk = new Set(next.killPlaybooks);
  if ([...ck].some((k) => !nk.has(k))) return false;
  if (nk.size > ck.size) strict = true;
  return strict;
}

export function acceptStatus(next: RegistryStatus, ctx: { roots: TrustRoots; revoked: ReadonlySet<string>; current: AcceptedStatus | null; hold?: boolean; now: number }): StatusDecision {
  const events: string[] = [];
  if (schemaViolations('status', next).length) return { ok: false, code: 'registry.schema_invalid', events };
  const ep = epochProblem(next, ctx.roots);
  if (ep) return { ok: false, code: ep, events };
  const content = contentBytes(next);
  const digest = sha256Hex(content);
  const q = countSignatures(content, next.signatures, ctx.roots.policyKeys, ctx.revoked);
  if (q.revoked.length) events.push('registry.key_revoked');
  const emergencyOnly =
    q.valid.length < 2 &&
    next.signatures.length === 1 &&
    next.signatures[0]!.keyId === ctx.roots.emergencyKey.keyId &&
    !ctx.revoked.has(ctx.roots.emergencyKey.keyId) &&
    verifyEd25519(ctx.roots.emergencyKey.key, content, next.signatures[0]!.sig);
  if (q.valid.length < 2 && !emergencyOnly) return { ok: false, code: 'registry.signature_insufficient', events };
  const restamp = ctx.current?.contentDigest === digest; // 내용 그대로의 타임스탬프 재서명
  if (emergencyOnly && !restamp && !statusIsConservative(ctx.current?.status ?? null, next)) return { ok: false, code: 'policy.rejected_not_conservative', events };
  if (!verifyTimestamp(digest, next, ctx.roots)) return { ok: false, code: 'registry.timestamp_invalid', events };
  if (issuedInFuture(next.issuedAt, ctx.now)) return { ok: false, code: 'registry.issued_in_future', events };
  const exp = Date.parse(next.expiresAt);
  if (!(exp > Date.parse(next.issuedAt)) || exp - Date.parse(next.issuedAt) > STATUS_MAX_AGE_H * H) return { ok: false, code: 'registry.status_validity_too_long', events };
  const cur = ctx.current;
  const vp = monotonicProblem(cur ? { ...cur.status, contentDigest: cur.contentDigest } : null, next, digest);
  if (vp) return { ok: false, code: vp, events };
  if (ctx.hold && !restamp && !emergencyOnly && !statusIsConservative(cur?.status ?? null, next)) return { ok: false, code: 'registry.update_held', events };
  const contentIssuedAt = restamp && cur ? cur.contentIssuedAt : next.issuedAt;
  return { ok: true, accepted: { status: next, contentDigest: digest, emergency: emergencyOnly, contentIssuedAt, acceptedAt: ctx.now }, events };
}

export type StatusFreshness = 'fresh' | 'stale' | 'daemon_stop';

/** 마지막 유효 status의 나이(받은 시각 기준이 아니라 issuedAt 기준). 48시간 넘으면 stale, 72시간이면 데몬 정지. */
export function statusFreshness(s: Pick<RegistryStatus, 'issuedAt'> | null, now: number): StatusFreshness {
  if (!s) return 'daemon_stop';
  const age = now - Date.parse(s.issuedAt);
  if (age > STATUS_STALE_DAEMON_STOP_H * H) return 'daemon_stop';
  if (age > STATUS_MAX_AGE_H * H) return 'stale';
  return 'fresh';
}

/** 실효 status: 긴급 키 하향은 72시간 뒤 자동 만료되고 마지막 2-of-3 status로 되돌린다(E-04). */
export function effectiveStatus(latest: AcceptedStatus | null, lastQuorum: AcceptedStatus | null, now: number): RegistryStatus | null {
  if (latest?.emergency && now - Date.parse(latest.contentIssuedAt) > EMERGENCY_STATUS_TTL_H * H) return lastQuorum?.status ?? null;
  return latest?.status ?? null;
}

// ---- 정책(D03 §7.1 서명과 신선도, C-26·E-04·E-05) ----

export interface AcceptedPolicy {
  /** 클램프 뒤 값(엔진이 쓰는 값). */
  policy: Policy;
  /** 받은 그대로(다음 보수성 판정의 기준). */
  raw: Policy;
  contentDigest: string;
  emergency: boolean;
  clamped: string[];
}

export type PolicyDecision = { ok: true; accepted: AcceptedPolicy; events: string[] } | { ok: false; code: string; events: string[] };

/**
 * 정책 파일 수용. 실패하면 그 파일만 거부하고 마지막 유효 정책을 유지한다.
 * hold = 헤드 불일치·폐기 목록 신선도 상실(그동안은 엄격하게 보수적인 정책만), current가 만료(stale)면 완화는
 * 신선한 2-of-3 정책으로만 들어온다(긴급 키는 원래 보수 변경만).
 */
export function acceptPolicy(next: Policy, ctx: { roots: TrustRoots; revoked: ReadonlySet<string>; current: AcceptedPolicy | null; hold: boolean; now: number }): PolicyDecision {
  const events: string[] = [];
  if (schemaViolations('policy', next).length) return { ok: false, code: 'registry.schema_invalid', events };
  const ep = epochProblem(next, ctx.roots);
  if (ep) return { ok: false, code: ep, events };
  const content = contentBytes(next);
  const digest = sha256Hex(content);
  const q = countSignatures(content, next.signatures, ctx.roots.policyKeys, ctx.revoked);
  if (q.revoked.length) events.push('registry.key_revoked');
  const emergencyOnly =
    q.valid.length < 2 &&
    next.signatures.length === 1 &&
    next.signatures[0]!.keyId === ctx.roots.emergencyKey.keyId &&
    !ctx.revoked.has(ctx.roots.emergencyKey.keyId) &&
    verifyEd25519(ctx.roots.emergencyKey.key, content, next.signatures[0]!.sig);
  if (q.valid.length < 2 && !emergencyOnly) return { ok: false, code: 'registry.signature_insufficient', events };
  if (!verifyTimestamp(digest, next, ctx.roots)) return { ok: false, code: 'registry.timestamp_invalid', events };
  const fp = freshnessProblem(next, ctx.now);
  if (fp) return { ok: false, code: fp, events };
  const cur = ctx.current;
  const vp = monotonicProblem(cur ? { ...cur.raw, contentDigest: cur.contentDigest } : null, next, digest);
  if (vp) return { ok: false, code: vp, events };
  const restamp = !!cur && cur.contentDigest === digest;
  if (!restamp && (emergencyOnly || ctx.hold) && !(cur && isStrictlyConservative(cur.raw, next))) {
    if (emergencyOnly) events.push('policy.rejected_not_conservative');
    return { ok: false, code: emergencyOnly ? 'policy.rejected_not_conservative' : 'registry.update_held', events };
  }
  const { policy, clamped } = clampPolicy(next);
  if (clamped.length) events.push('policy.clamped');
  return { ok: true, accepted: { policy, raw: next, contentDigest: digest, emergency: emergencyOnly, clamped }, events };
}

// ---- 투명성 로그 헤드 비교(E-14, Phase 1 split-view 점검) ----

export interface TreeHead {
  treeSize: number;
  rootHash: string; // hex
}

const sha = (...parts: Uint8Array[]) => createHash('sha256').update(Buffer.concat(parts)).digest();
export const leafHash = (data: Uint8Array) => sha(Buffer.from([0]), data);
export const nodeHash = (l: Uint8Array, r: Uint8Array) => sha(Buffer.from([1]), l, r);

/** RFC 9162 §2.1.1 MTH. 시험·미러 비교용. */
export function merkleRoot(leaves: readonly Uint8Array[]): Buffer {
  if (leaves.length === 0) return sha();
  if (leaves.length === 1) return leafHash(leaves[0]!);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return nodeHash(merkleRoot(leaves.slice(0, k)), merkleRoot(leaves.slice(k)));
}

/** RFC 9162 §2.1.4.1 일관성 증명 생성(m < n). 시험 도우미. */
export function consistencyProof(m: number, leaves: readonly Uint8Array[]): Buffer[] {
  const sub = (mm: number, ls: readonly Uint8Array[], b: boolean): Buffer[] => {
    const n = ls.length;
    if (mm === n) return b ? [] : [merkleRoot(ls)];
    let k = 1;
    while (k * 2 < n) k *= 2;
    if (mm <= k) return [...sub(mm, ls.slice(0, k), b), merkleRoot(ls.slice(k))];
    return [...sub(mm - k, ls.slice(k), false), merkleRoot(ls.slice(0, k))];
  };
  return sub(m, leaves, true);
}

/** RFC 9162 §2.1.4.2 일관성 증명 검증. */
export function verifyConsistency(first: TreeHead, second: TreeHead, proof: readonly Uint8Array[]): boolean {
  const r1 = Buffer.from(first.rootHash, 'hex');
  const r2 = Buffer.from(second.rootHash, 'hex');
  if (first.treeSize > second.treeSize) return false;
  if (first.treeSize === second.treeSize) return proof.length === 0 && r1.equals(r2);
  if (first.treeSize === 0) return proof.length === 0;
  let path = [...proof].map((x) => Buffer.from(x));
  if (!path.length) return false;
  if ((first.treeSize & (first.treeSize - 1)) === 0) path = [r1, ...path];
  let fn = first.treeSize - 1;
  let sn = second.treeSize - 1;
  while (fn & 1) {
    fn >>= 1;
    sn >>= 1;
  }
  let fr = path[0]!;
  let sr = path[0]!;
  for (const c of path.slice(1)) {
    if (sn === 0) return false;
    if (fn & 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if (!(fn & 1)) {
        while (!(fn & 1) && fn !== 0) {
          fn >>= 1;
          sn >>= 1;
        }
      }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1;
    sn >>= 1;
  }
  return fr.equals(r1) && sr.equals(r2) && sn === 0;
}

/**
 * 레지스트리 헤드와 미러 헤드(다른 도메인·운영 계정) 비교. 같은 크기에서 루트가 다르거나, 크기가 다른데 미러가
 * 일관성 증명을 주지 못하면 registry.head_mismatch(보안 이벤트, 새 패키지·정책·핫픽스 보류). 보수적 정책·status는 보류 중에도 적용한다.
 */
export function headMismatch(registry: TreeHead, mirror: TreeHead, proof: readonly Uint8Array[] | null): boolean {
  if (registry.treeSize === mirror.treeSize) return registry.rootHash !== mirror.rootHash;
  if (!proof) return true;
  const [a, b] = registry.treeSize < mirror.treeSize ? [registry, mirror] : [mirror, registry];
  return !verifyConsistency(a, b, proof);
}
