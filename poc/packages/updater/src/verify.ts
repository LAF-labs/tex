import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { jcs } from './jcs.ts';
import { fail, parseManifest, semverCmp, type Channel, type ReleaseManifest, type Sig } from './manifest.ts';

/** 핀 고정 역할(services/registry TrustRoot와 같은 모양). 업데이터는 release·root만 쓴다. */
export type Role = 'root' | 'package' | 'policy' | 'timestamp' | 'emergency' | 'release';

/** 앱에 내장된 핀 키 한 세대. 값은 Ed25519 공개키 32바이트 표준 base64(tests/fixtures/registry/trust.json 모양). */
export interface TrustRoot {
  keyEpoch: number;
  keys: Partial<Record<Role, Record<string, string>>>;
}

/** 엔진이 수용한 폐기 목록(acceptRevoked 결과). fresh = 24시간 신선도 안(D09 §8.4). */
export interface Revocation {
  keyIds: ReadonlySet<string>;
  fresh: boolean;
}

export const LIMITS = {
  futureSkewMs: 5 * 60_000,
  maxValidityMs: 14 * 24 * 3600_000,
  rootQuorum: 2,
} as const;

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function pubKey(b64: string) {
  const raw = Buffer.from(b64, 'base64');
  if (raw.length !== 32 || raw.toString('base64') !== b64) return null;
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' });
}

function edOk(pubB64: string, content: unknown, sigB64u: string): boolean {
  const key = pubKey(pubB64);
  if (!key) return false;
  const sig = Buffer.from(sigB64u, 'base64url');
  if (sig.length !== 64) return false;
  try {
    return edVerify(null, Buffer.from(jcs(content), 'utf8'), key, sig);
  } catch {
    return false;
  }
}

/**
 * 서로 다른 핀 키의 유효 서명 수가 need 이상인가(SIGNING.md §3). 모르는 keyId·다른 역할·같은 키 두 번은 세지 않는다.
 * 모자라면 폐기 키가 섞여 있었을 때 registry.key_revoked, 아니면 registry.signature_insufficient.
 */
export function countQuorum(content: unknown, sigs: readonly Sig[], role: Role, trust: TrustRoot, revoked: ReadonlySet<string>, need: number): string[] {
  if (sigs.length > 3) fail('registry.signature_insufficient');
  const pinned = trust.keys[role] ?? {};
  const ok = new Set<string>();
  let sawRevoked = false;
  for (const s of sigs) {
    if (s.alg !== 'ed25519' || ok.has(s.keyId) || !Object.hasOwn(pinned, s.keyId)) continue;
    if (revoked.has(s.keyId)) {
      sawRevoked = true;
      continue;
    }
    if (edOk(pinned[s.keyId]!, content, s.sig)) ok.add(s.keyId);
  }
  if (ok.size < need) fail(sawRevoked ? 'registry.key_revoked' : 'registry.signature_insufficient');
  return [...ok];
}

const without = (o: object, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

const RELEASE_FRESHNESS = ['signature', 'issuedAt', 'expiresAt', 'timestamp'];

/** 릴리스 키가 서명하는 바이트: 매니페스트 − 서명·신선도(API.md, services/registry verifyRelease와 같다) */
export function releaseContent(m: ReleaseManifest): Record<string, unknown> {
  return without(m, RELEASE_FRESHNESS);
}

/** 루트 키가 서명하는 바이트: 매니페스트 − 서명·신선도, rootChange − signatures */
export function rootChangeContent(m: ReleaseManifest): Record<string, unknown> {
  const rest = without(m, [...RELEASE_FRESHNESS, 'rootChange']);
  return m.rootChange ? { ...rest, rootChange: without(m.rootChange, ['signatures']) } : rest;
}

/** 타임스탬프 키가 서명하는 내용: {contentDigest = sha256 hex(JCS(releaseContent)), issuedAt, expiresAt}(services/registry releaseStampContent와 같다) */
export function releaseStampContent(m: ReleaseManifest): Record<string, unknown> {
  return { contentDigest: createHash('sha256').update(jcs(releaseContent(m)), 'utf8').digest('hex'), issuedAt: m.issuedAt, expiresAt: m.expiresAt };
}

/** 저장해 두는 "본 것 중 가장 높은 릴리스": 버전과 파일 목록 다이제스트 */
export interface SeenRelease {
  version: string;
  filesDigest: string;
}

/** 파일 목록 다이제스트 = sha256 hex(JCS(files)). 같은 버전에 다른 설치본을 끼워 넣는 것을 잡는다 */
export const filesDigest = (m: ReleaseManifest): string => createHash('sha256').update(jcs(m.files), 'utf8').digest('hex');

export interface VerifyInput {
  doc: unknown;
  channel: Channel;
  trust: TrustRoot;
  revocation: Revocation;
  highestSeen: SeenRelease | null;
  now: number;
}

export interface VerifiedRelease {
  manifest: ReleaseManifest;
  releaseKeyId: string;
  rootKeyIds: string[];
}

/**
 * 릴리스 매니페스트 한 건 검증. 순서: 모양 → 폐기 목록 신선도 → 채널 → 서명(릴리스 키 1 + 뿌리 변경이면 루트 2-of-3) → 서버 타임스탬프 → 시각 → 단조 버전.
 * 서명을 시각보다 먼저 본다(위조본에 만료·미래 시각 같은 덜 무거운 코드가 붙지 않게).
 */
export function verifyRelease(input: VerifyInput): VerifiedRelease {
  const m = parseManifest(input.doc);
  if (!input.revocation.fresh) fail('registry.revocation_stale');
  if (m.channel !== input.channel) fail('update.channel_mismatch');
  const [releaseKeyId] = countQuorum(releaseContent(m), [m.signature], 'release', input.trust, input.revocation.keyIds, 1);
  let rootKeyIds: string[] = [];
  if (m.rootChange) {
    const rc = m.rootChange;
    const epochUp = rc.changes.includes('keyEpoch');
    if (epochUp ? rc.keyEpoch <= input.trust.keyEpoch : rc.keyEpoch !== input.trust.keyEpoch) fail('update.root_change_unsigned');
    try {
      rootKeyIds = countQuorum(rootChangeContent(m), rc.signatures, 'root', input.trust, input.revocation.keyIds, LIMITS.rootQuorum);
    } catch (e) {
      if ((e as { code?: string }).code === 'registry.key_revoked') throw e;
      fail('update.root_change_unsigned');
    }
  }
  try {
    countQuorum(releaseStampContent(m), [m.timestamp], 'timestamp', input.trust, input.revocation.keyIds, 1);
  } catch {
    fail('registry.timestamp_invalid');
  }
  const issued = Date.parse(m.issuedAt);
  const expires = Date.parse(m.expiresAt);
  if (Date.parse(m.releaseDate) > input.now + LIMITS.futureSkewMs || issued > input.now + LIMITS.futureSkewMs) fail('registry.issued_in_future');
  if (expires <= issued || expires - issued > LIMITS.maxValidityMs) fail('update.validity_too_long');
  if (expires <= input.now) fail('registry.expired');
  if (input.highestSeen !== null) {
    const c = semverCmp(m.version, input.highestSeen.version);
    if (c < 0 || (c === 0 && filesDigest(m) !== input.highestSeen.filesDigest)) fail('registry.version_rollback');
  }
  return { manifest: m, releaseKeyId: releaseKeyId!, rootKeyIds };
}
