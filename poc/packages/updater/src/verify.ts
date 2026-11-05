// 릴리스 매니페스트 검증(ADR-028 결정 1·3, D09 §8.2·§8.4, D11 §4 자동 업데이트 행, services/registry API.md).
// 서명 바이트는 SIGNING.md §1·§3(맥락 문자열 없음, JCS, base64url 서명, 핀 키만 센다, 폐기 키는 세지 않는다).
// 실패는 모두 던진다(fail-closed). 부르는 쪽은 실패면 설치본을 그대로 두고 "업데이트를 확인하지 못했습니다"만 보인다.
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
  /** releaseDate가 지금 + 5분보다 미래면 거부(D09 §8.4) */
  futureSkewMs: 5 * 60_000,
  /** 릴리스 매니페스트 유효 기간 상한 14일(API.md) */
  maxValidityMs: 14 * 24 * 3600_000,
  /** 뿌리 변경 릴리스의 루트 서명 정족수(ADR-028 결정 3) */
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

/** 릴리스 키가 서명하는 바이트: 매니페스트 − signature(API.md, 클라우드 verifyRelease와 같다) */
export function releaseContent(m: ReleaseManifest): Record<string, unknown> {
  return without(m, ['signature']);
}

/** 루트 키가 서명하는 바이트: 매니페스트 − signature, rootChange − signatures */
export function rootChangeContent(m: ReleaseManifest): Record<string, unknown> {
  const rest = without(m, ['signature', 'rootChange']);
  return m.rootChange ? { ...rest, rootChange: without(m.rootChange, ['signatures']) } : rest;
}

/** 저장해 두는 "본 것 중 가장 높은 릴리스": 버전과 파일 목록 다이제스트 */
export interface SeenRelease {
  version: string;
  filesDigest: string;
}

/** 파일 목록 다이제스트 = sha256 hex(JCS(files)). 같은 버전에 다른 설치본을 끼워 넣는 것을 잡는다 */
export const filesDigest = (m: ReleaseManifest): string => createHash('sha256').update(jcs(m.files), 'utf8').digest('hex');

export interface VerifyInput {
  /** latest.json을 JSON.parse한 값 */
  doc: unknown;
  /** 이 앱이 구독하는 채널(설정값). 매니페스트 channel과 경로 채널이 모두 이것이어야 한다 */
  channel: Channel;
  trust: TrustRoot;
  revocation: Revocation;
  /** 이 채널에서 지금까지 검증을 통과한 가장 높은 릴리스(저장값). 처음이면 null */
  highestSeen: SeenRelease | null;
  now: number;
}

export interface VerifiedRelease {
  manifest: ReleaseManifest;
  releaseKeyId: string;
  /** 뿌리 변경 릴리스면 센 루트 keyId */
  rootKeyIds: string[];
}

/**
 * 릴리스 매니페스트 한 건 검증. 순서: 모양 → 폐기 목록 신선도 → 채널 → 서명(릴리스 키 1 + 뿌리 변경이면 루트 2-of-3) → 시각 → 단조 버전.
 * 서명을 시각보다 먼저 본다(위조본에 만료·미래 시각 같은 덜 무거운 코드가 붙지 않게).
 */
export function verifyRelease(input: VerifyInput): VerifiedRelease {
  const m = parseManifest(input.doc);
  // 폐기 목록을 24시간 안에 확인하지 못했으면 새 로드를 보류한다(D09 §8.4: 설치본 유지)
  if (!input.revocation.fresh) fail('registry.revocation_stale');
  if (m.channel !== input.channel) fail('update.channel_mismatch');
  const [releaseKeyId] = countQuorum(releaseContent(m), [m.signature], 'release', input.trust, input.revocation.keyIds, 1);
  let rootKeyIds: string[] = [];
  if (m.rootChange) {
    const rc = m.rootChange;
    // keyEpoch를 바꾸면 커져야 하고, 안 바꾸면 그대로여야 한다(세대 교체는 루트 서명으로만, D09 §8.4)
    const epochUp = rc.changes.includes('keyEpoch');
    if (epochUp ? rc.keyEpoch <= input.trust.keyEpoch : rc.keyEpoch !== input.trust.keyEpoch) fail('update.root_change_unsigned');
    try {
      rootKeyIds = countQuorum(rootChangeContent(m), rc.signatures, 'root', input.trust, input.revocation.keyIds, LIMITS.rootQuorum);
    } catch (e) {
      // 루트 서명이 모자란 뿌리 변경 릴리스는 릴리스 키 1인 서명만으로 설치하지 않는다
      if ((e as { code?: string }).code === 'registry.key_revoked') throw e;
      fail('update.root_change_unsigned');
    }
  }
  const issued = Date.parse(m.releaseDate);
  const expires = Date.parse(m.expiresAt);
  if (issued > input.now + LIMITS.futureSkewMs) fail('registry.issued_in_future');
  if (expires <= issued || expires - issued > LIMITS.maxValidityMs) fail('update.validity_too_long');
  if (expires <= input.now) fail('registry.expired');
  // 단조: 이 채널에서 본 가장 높은 버전보다 낮으면 롤백(동결·되감기 공격). 같은 버전은 신선도 재발행이라 파일이 같을 때만 받는다
  if (input.highestSeen !== null) {
    const c = semverCmp(m.version, input.highestSeen.version);
    if (c < 0 || (c === 0 && filesDigest(m) !== input.highestSeen.filesDigest)) fail('registry.version_rollback');
  }
  return { manifest: m, releaseKeyId: releaseKeyId!, rootKeyIds };
}
