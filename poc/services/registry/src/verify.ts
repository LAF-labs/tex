// 레지스트리 산출물 검증(D09 §8, ADR-013·023·028, D03 §3.1). 서버는 서명하지 않는다: 서명은 CI 밖 하드웨어 의식이고
// 여기에는 공개키만 있다. 같은 함수를 게시 관문(서버)과 클라이언트가 쓰도록 순수 함수로 둔다(입력 → 결과 또는 ServiceError).
//
// 서명 입력: utf8(JCS(내용)). 내용 = 산출물에서 서명 필드를 뺀 것. 정책·status·폐기 목록은 신선도 필드(issuedAt·expiresAt·timestamp)도 뺀 것이고,
// 신선도는 타임스탬프 키가 JCS({contentDigest, monotonic, issuedAt, expiresAt})에 따로 서명한다(policy.schema.json 설명과 같은 규칙).
import { createHash, verify as edVerify } from 'node:crypto';
import { ed25519Public, fail, fromB64, fromB64u, jcs, sha256hex } from '@sax/svc-shared';

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

export const LIMITS = {
  /** 새 단조 값 ≤ 저장값 + 1000(같은 keyEpoch, 버전 인플레이션 잠금 방지) */
  versionJumpMax: 1000,
  /** issuedAt이 현재 + 5분보다 미래면 거부 */
  futureSkewMs: 5 * 60_000,
  indexMaxValidityMs: 14 * 24 * 3600_000,
  policyMaxValidityMs: 72 * 3600_000,
  statusMaxValidityMs: 48 * 3600_000,
  revokedMaxValidityMs: 24 * 3600_000,
  releaseMaxValidityMs: 14 * 24 * 3600_000,
} as const;

const PORTAL_MODE_ORDER: Record<string, number> = { postprocess: 0, assisted: 1, auto: 2 };

/** JCS 서명 검증(레지스트리 산출물은 맥락 문자열 없이 JCS만, manifest·policy·hotfix 스키마 정의). */
function edOk(pubB64: string, content: unknown, sigB64u: string): boolean {
  const raw = fromB64(pubB64, 32);
  if (!raw || !/^[A-Za-z0-9_-]{86}$/.test(sigB64u)) return false;
  try {
    return edVerify(null, Buffer.from(jcs(content), 'utf8'), ed25519Public(raw), fromB64u(sigB64u));
  } catch {
    return false;
  }
}

export function without<T extends Record<string, unknown>>(o: T, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
}

export const contentDigest = (content: unknown): string => sha256hex(jcs(content));

/**
 * 서로 다른 핀 키의 유효 서명이 need개 이상인가. 폐기된 키의 서명은 세지 않는다.
 * 모자라면: 폐기 키 서명이 섞여 있었으면 registry.key_revoked, 아니면 registry.signature_insufficient.
 */
export function verifyQuorum(content: unknown, sigs: unknown, role: Role, trust: TrustRoot, revoked: ReadonlySet<string>, need: number): string[] {
  if (!Array.isArray(sigs) || sigs.length > 3) fail('registry.signature_insufficient');
  const pinned = trust.keys[role] ?? {};
  const ok = new Set<string>();
  let sawRevoked = false;
  for (const s of sigs as Sig[]) {
    if (!s || typeof s !== 'object' || s.alg !== 'ed25519' || typeof s.keyId !== 'string' || typeof s.sig !== 'string') continue;
    const pub = pinned[s.keyId];
    if (!pub || ok.has(s.keyId)) continue;
    if (revoked.has(s.keyId)) {
      sawRevoked = true;
      continue;
    }
    if (edOk(pub, content, s.sig)) ok.add(s.keyId);
  }
  if (ok.size < need) fail(sawRevoked ? 'registry.key_revoked' : 'registry.signature_insufficient');
  return [...ok];
}

function parseTime(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(t)) fail('request.param_rejected');
  return t;
}

/** issuedAt ≤ now + 5분, expires > now, expires − issuedAt ≤ 최대 유효 기간 */
export function checkWindow(issuedAt: unknown, expires: unknown, maxValidityMs: number, now: number, staleCode: 'registry.expired' | 'registry.status_stale' | 'registry.revocation_stale' = 'registry.expired'): { issued: number; expires: number } {
  const i = parseTime(issuedAt);
  const e = parseTime(expires);
  if (i > now + LIMITS.futureSkewMs) fail('registry.issued_in_future');
  if (e <= i || e - i > maxValidityMs) fail('request.param_rejected');
  if (e <= now) fail(staleCode);
  return { issued: i, expires: e };
}

/** 같은 keyEpoch 안에서만 비교, 저장값 < 새 값 ≤ 저장값 + 1000. 핀과 다른 keyEpoch는 거부(세대 교체는 앱 업데이트·루트 서명으로만). */
export function checkMonotonic(next: { keyEpoch: unknown; monotonic: unknown }, stored: { keyEpoch: number; monotonic: number } | null, trust: TrustRoot): void {
  if (next.keyEpoch !== trust.keyEpoch) fail('registry.signature_insufficient');
  if (!Number.isSafeInteger(next.monotonic) || (next.monotonic as number) < 1) fail('request.param_rejected');
  if (stored && stored.keyEpoch === trust.keyEpoch) {
    const n = next.monotonic as number;
    if (n <= stored.monotonic || n > stored.monotonic + LIMITS.versionJumpMax) fail('registry.version_jump_rejected');
  }
}

const FRESHNESS_FIELDS = ['signatures', 'issuedAt', 'expiresAt', 'timestamp'];

/**
 * 정책·status·폐기 목록: 내용이 같은 재발행(타임스탬프 키의 48시간·24시간 신선도 재서명)은 같은 monotonic을 쓴다.
 * 같은 monotonic인데 내용이 다르면 거부한다(내용 변경은 monotonic을 올려야 한다). 반환 true = 신선도 재발행.
 */
export function monotonicOrRefresh(doc: { keyEpoch: unknown; monotonic: unknown }, content: unknown, stored: ({ keyEpoch: number; monotonic: number } & Record<string, unknown>) | null, trust: TrustRoot): boolean {
  if (stored && stored.keyEpoch === doc.keyEpoch && stored.monotonic === doc.monotonic) {
    if (doc.keyEpoch !== trust.keyEpoch) fail('registry.signature_insufficient');
    if (contentDigest(content) !== contentDigest(without(stored, FRESHNESS_FIELDS))) fail('registry.version_jump_rejected');
    return true;
  }
  checkMonotonic(doc, stored, trust);
  return false;
}

/** 타임스탬프(신선도) 서명: JCS({contentDigest, monotonic, issuedAt, expiresAt}) */
export function verifyTimestamp(doc: { timestamp?: unknown; monotonic: number; issuedAt: unknown; expiresAt: unknown }, content: unknown, trust: TrustRoot, revoked: ReadonlySet<string>): void {
  const ts = { contentDigest: contentDigest(content), monotonic: doc.monotonic, issuedAt: doc.issuedAt, expiresAt: doc.expiresAt };
  verifyQuorum(ts, [doc.timestamp], 'timestamp', trust, revoked, 1);
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

const REVOCABLE: readonly Role[] = ['root', 'package', 'policy', 'timestamp', 'emergency', 'release'];

/** 내용은 오프라인 루트 2-of-3, 24시간 신선도는 타임스탬프 키. 신선도를 잃으면 registry.revocation_stale(새 패키지·정책 로드 보류). */
export function verifyRevoked(doc: RevokedKeys, trust: TrustRoot, stored: RevokedKeys | null, now: number): Set<string> {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.revoked) || doc.revoked.length > 64) fail('request.param_rejected');
  for (const r of doc.revoked) {
    if (!r || typeof r.keyId !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(r.keyId) || !REVOCABLE.includes(r.role) || !Number.isFinite(Date.parse(String(r.revokedAt)))) fail('request.param_rejected');
  }
  const content = without(doc as unknown as Record<string, unknown>, FRESHNESS_FIELDS);
  monotonicOrRefresh(doc, content, stored as never, trust);
  // 폐기 목록 자체는 이전 폐기 목록으로 걸러진 루트 키로 검증한다(루트 키도 폐기될 수 있다)
  const prev = new Set(stored?.revoked.map((r) => r.keyId) ?? []);
  verifyQuorum(content, doc.signatures, 'root', trust, prev, 2);
  // 폐기는 되돌릴 수 없다: 이전 목록의 키가 빠지면 거부
  const next = new Set(doc.revoked.map((r) => r.keyId));
  for (const k of prev) if (!next.has(k)) fail('registry.version_jump_rejected');
  verifyTimestamp(doc, content, trust, next);
  checkWindow(doc.issuedAt, doc.expiresAt, LIMITS.revokedMaxValidityMs, now, 'registry.revocation_stale');
  return next;
}

// ---------- 인덱스 /registry/{channel}/index.json ----------

export type Channel = 'stable' | 'beta' | 'hotfix';
export const CHANNELS: readonly Channel[] = ['stable', 'beta', 'hotfix'];

export interface IndexEntry {
  id: string;
  version: string;
  kind: 'playbook' | 'lookup' | 'hotfix' | 'data';
  portal?: string;
  /** sha256(.sxp 바이트) */
  packageDigest: string;
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

/** 허락 회신 전 위택스 패키지는 레지스트리가 거부한다(D09 §8.6, ADR-022 결정 2). */
export const BLOCKED_PORTALS: readonly string[] = ['wetax'];

/** 인덱스: 패키지 키 2-of-3, 14일 만료, 단조 +1000, 채널 일치, 위택스 거부. 내용 = 서명 뺀 전체(만료 포함). */
export function verifyIndex(doc: RegistryIndex, channel: Channel, trust: TrustRoot, revoked: ReadonlySet<string>, stored: RegistryIndex | null, now: number): void {
  if (!doc || typeof doc !== 'object' || doc.channel !== channel || !Array.isArray(doc.entries) || doc.entries.length > 500) fail('request.param_rejected');
  checkMonotonic(doc, stored, trust);
  verifyQuorum(without(doc as unknown as Record<string, unknown>, ['signatures']), doc.signatures, 'package', trust, revoked, 2);
  checkWindow(doc.issuedAt, doc.expiresAt, LIMITS.indexMaxValidityMs, now);
  const seen = new Set<string>();
  for (const e of doc.entries) {
    if (!e || !/^[a-z0-9_.-]{1,64}$/.test(e.id) || !/^\d+\.\d+\.\d+$/.test(e.version) || !/^[0-9a-f]{64}$/.test(e.packageDigest)) fail('request.param_rejected');
    if (!['playbook', 'lookup', 'hotfix', 'data'].includes(e.kind) || !Number.isSafeInteger(e.size) || e.size < 1 || e.size > 16 * 1024 * 1024) fail('request.param_rejected');
    if (!Number.isInteger(e.rolloutPercent) || e.rolloutPercent < 0 || e.rolloutPercent > 100) fail('request.param_rejected');
    if (e.portal !== undefined && BLOCKED_PORTALS.includes(e.portal)) fail('registry.portal_blocked');
    const k = `${e.id}@${e.version}`;
    if (seen.has(k)) fail('request.param_rejected');
    seen.add(k);
  }
}

/** 패키지 바이트가 인덱스가 묶은 다이제스트와 같은가(클라이언트는 이 뒤에 manifest 2-of-3을 따로 본다, D03 §3.1). */
export function verifyPackageBytes(bytes: Buffer, entry: Pick<IndexEntry, 'packageDigest' | 'size'>): void {
  if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.packageDigest) fail('registry.content_digest_mismatch');
}

/** 롤아웃 버킷: sha256('SAX-rollout-v1' ‖ 0 ‖ packageId ‖ 0 ‖ deviceId)의 앞 4바이트 mod 100. 클라이언트가 자기 비율을 정한다. */
export function rolloutBucket(packageId: string, deviceId: string): number {
  return createHash('sha256').update(`SAX-rollout-v1\u0000${packageId}\u0000${deviceId}`).digest().readUInt32BE(0) % 100;
}

export const inRollout = (e: Pick<IndexEntry, 'id' | 'rolloutPercent'>, deviceId: string): boolean => rolloutBucket(e.id, deviceId) < e.rolloutPercent;

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
 * 정책: 내용은 정책 키 2-of-3 또는 긴급 키 1개, 신선도는 타임스탬프 키, 72시간. 반환값 emergency=true면 긴급 키 서명본이다.
 * 긴급 정책의 "엄격하게 보수적" 필드별 판정(D03 §7.1)은 엔진이 한다. 레지스트리는 서명·신선도·버전만 본다.
 */
export function verifyPolicy(doc: SignedPolicy, trust: TrustRoot, revoked: ReadonlySet<string>, stored: SignedPolicy | null, now: number): { emergency: boolean } {
  if (!doc || typeof doc !== 'object' || !/^\d{4}\.\d{2}(\.\d+)?$/.test(String(doc.version))) fail('request.param_rejected');
  const content = without(doc, FRESHNESS_FIELDS);
  monotonicOrRefresh(doc, content, stored, trust);
  const emergency = emergencyOnly(content, doc.signatures, 'policy', trust, revoked);
  verifyTimestamp(doc, content, trust, revoked);
  checkWindow(doc.issuedAt, doc.expiresAt, LIMITS.policyMaxValidityMs, now);
  return { emergency };
}

/** 2-of-3이면 false, 아니면 긴급 키 1개 서명이어야 true. 둘 다 아니면 서명 부족. */
function emergencyOnly(content: unknown, sigs: unknown, role: 'policy', trust: TrustRoot, revoked: ReadonlySet<string>): boolean {
  try {
    verifyQuorum(content, sigs, role, trust, revoked, 2);
    return false;
  } catch (e) {
    if (!Array.isArray(sigs) || sigs.length !== 1) throw e;
    verifyQuorum(content, sigs, 'emergency', trust, revoked, 1);
    return true;
  }
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
 * status: 내용은 정책 키 2-of-3 또는 1인 긴급 키(하향·킬스위치 추가만), 48시간 만료(status_stale).
 * 긴급 키 서명본은 저장된 2-of-3 값보다 엄격하게 보수적일 때만 받는다: 모든 포털 상한 ≤, killPlaybooks ⊇, 하나 이상 엄격, 그 밖 필드 같음.
 */
export function verifyStatus(doc: RegistryStatus, trust: TrustRoot, revoked: ReadonlySet<string>, stored: RegistryStatus | null, now: number): { emergency: boolean } {
  if (!doc || typeof doc !== 'object' || !doc.portalModeCeiling || typeof doc.portalModeCeiling !== 'object' || !Array.isArray(doc.killPlaybooks)) fail('request.param_rejected');
  for (const m of Object.values(doc.portalModeCeiling)) if (!(m in PORTAL_MODE_ORDER)) fail('request.param_rejected');
  if (doc.killPlaybooks.some((k) => typeof k !== 'string' || !/^[a-z0-9_.-]{1,64}$/.test(k))) fail('request.param_rejected');
  const content = without(doc as unknown as Record<string, unknown>, FRESHNESS_FIELDS);
  const refresh = monotonicOrRefresh(doc, content, stored as never, trust);
  const emergency = emergencyOnly(content, doc.signatures, 'policy', trust, revoked);
  if (emergency && !refresh && !strictlyMoreConservative(doc, stored)) fail('registry.not_conservative');
  verifyTimestamp(doc, content, trust, revoked);
  checkWindow(doc.issuedAt, doc.expiresAt, LIMITS.statusMaxValidityMs, now, 'registry.status_stale');
  return { emergency };
}

export function strictlyMoreConservative(next: RegistryStatus, prev: RegistryStatus | null): boolean {
  if (!prev) return false;
  const known = new Set(['monotonic', 'keyEpoch', 'issuedAt', 'expiresAt', 'portalModeCeiling', 'killPlaybooks', 'timestamp', 'signatures']);
  if (Object.keys(next).some((k) => !known.has(k)) || next.keyEpoch !== prev.keyEpoch) return false;
  let strict = false;
  const portals = new Set([...Object.keys(prev.portalModeCeiling), ...Object.keys(next.portalModeCeiling)]);
  for (const p of portals) {
    // 상한이 없는 포털은 auto와 같다(상한 없음). 새 status에서 상한이 빠지면 완화다.
    const a = PORTAL_MODE_ORDER[prev.portalModeCeiling[p] ?? 'auto']!;
    const b = next.portalModeCeiling[p] === undefined ? 3 : PORTAL_MODE_ORDER[next.portalModeCeiling[p]]!;
    if (b > a) return false;
    if (b < a) strict = true;
  }
  const prevKill = new Set(prev.killPlaybooks);
  const nextKill = new Set(next.killPlaybooks);
  for (const k of prevKill) if (!nextKill.has(k)) return false;
  if (nextKill.size > prevKill.size) strict = true;
  return strict;
}

// ---------- 앱 업데이트 /releases/{channel}/latest.json (+ latest.yml) ----------

export interface ReleaseManifest {
  channel: Channel;
  version: string;
  releaseDate: string;
  expiresAt: string;
  rolloutPercent: number;
  files: Array<{ url: string; sha512: string; size: number }>;
  signature: Sig;
}

const semver = (v: string): [number, number, number] => {
  const m = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/.exec(v);
  if (!m) return fail('request.param_rejected');
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
export function verifyRelease(doc: ReleaseManifest, channel: Channel, trust: TrustRoot, revoked: ReadonlySet<string>, stored: ReleaseManifest | null, now: number): void {
  if (!doc || typeof doc !== 'object' || doc.channel !== channel || !Array.isArray(doc.files) || doc.files.length < 1 || doc.files.length > 8) fail('request.param_rejected');
  for (const f of doc.files) {
    if (!f || !/^[A-Za-z0-9._-]{1,128}$/.test(f.url) || !/^[A-Za-z0-9+/]{86}==$/.test(f.sha512) || !Number.isSafeInteger(f.size) || f.size < 1) fail('request.param_rejected');
  }
  if (!Number.isInteger(doc.rolloutPercent) || doc.rolloutPercent < 0 || doc.rolloutPercent > 100) fail('request.param_rejected');
  semver(doc.version);
  verifyQuorum(without(doc as unknown as Record<string, unknown>, ['signature']), [doc.signature], 'release', trust, revoked, 1);
  if (stored && !semverGt(doc.version, stored.version)) fail('registry.version_jump_rejected');
  checkWindow(doc.releaseDate, doc.expiresAt, LIMITS.releaseMaxValidityMs, now);
}

/** electron-updater용 latest.yml. 검증을 통과한 매니페스트에서만 만들고 값은 위 정규식으로 제한돼 YAML 주입이 없다. */
export function renderLatestYml(m: ReleaseManifest): string {
  const lines = [`version: ${m.version}`, 'files:'];
  for (const f of m.files) lines.push(`  - url: ${f.url}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`);
  lines.push(`path: ${m.files[0]!.url}`, `sha512: ${m.files[0]!.sha512}`, `releaseDate: '${new Date(Date.parse(m.releaseDate)).toISOString()}'`);
  return lines.join('\n') + '\n';
}
