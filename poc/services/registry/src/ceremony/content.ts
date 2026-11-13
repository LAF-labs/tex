// 서명 의식: 문서 종류별 서명 입력 바이트와 서명이 들어갈 자리(SIGNING.md §1·§2·§4, API.md "서명 규칙" 표).
// 서명 입력은 utf8(JCS(내용))이고 맥락 문자열이 없다. Ed25519는 다이제스트가 아니라 이 바이트 전체에 서명한다(PureEdDSA).
// 사람이 대조하는 값은 SHA-256(서명 입력)이다(의식 진행자가 읽고, 보유자가 자기 화면의 값과 맞춰 본 뒤에만 서명한다).
import { createHash } from 'node:crypto';
import { canonicalJson, canonicalWithout, timestampBody } from '@sax/engine/core';
import { rootChangeContent, type ReleaseManifest, type Role } from '../verify.ts';

/** 의식에서 서명하는 문서 종류. trust_root = 루트 메타데이터(핀 키·keyId → 보유자 역할 표, D09 §8.2). */
export const DOC_KINDS = ['revoked_keys', 'status', 'policy', 'index', 'manifest', 'hotfix', 'data_descriptor', 'release', 'root_change', 'trust_root'] as const;
export type DocKind = (typeof DOC_KINDS)[number];

/** 종류마다 서명할 수 있는 역할(D09 §8.2). status·policy는 정책 키 2-of-3 또는 1인 긴급 키. */
export const SIGNER_ROLES: Record<DocKind, readonly Role[]> = {
  revoked_keys: ['root'],
  status: ['policy', 'emergency'],
  policy: ['policy', 'emergency'],
  index: ['package'],
  manifest: ['package'],
  hotfix: ['package'],
  data_descriptor: ['package'],
  release: ['release'],
  root_change: ['root'],
  trust_root: ['root'],
};

/** 정족수(서로 다른 핀 키 수). 긴급 키는 1개 단독(정책 키와 섞지 않는다). */
export function quorumFor(role: Role): number {
  if (role === 'emergency' || role === 'release') return 1;
  return 2;
}

/** 타임스탬프(신선도) 서명이 붙는 문서(SIGNING.md §4, 인덱스는 ADR-043). 내용 서명과 따로, 온라인 타임스탬프 키 1개가 한다. */
export const TIMESTAMPED: ReadonlySet<DocKind> = new Set(['revoked_keys', 'status', 'policy', 'index']);

const FRESHNESS = ['signatures', 'issuedAt', 'expiresAt', 'timestamp'];

export class CeremonyError extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const obj = (doc: unknown): Record<string, unknown> => {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new CeremonyError('ceremony.doc_invalid');
  return doc as Record<string, unknown>;
};

/** 내용 서명 입력 바이트. */
export function signingBytes(kind: DocKind, doc: unknown): Buffer {
  const d = obj(doc);
  switch (kind) {
    case 'revoked_keys':
    case 'status':
    case 'policy':
    case 'index': // ADR-043: 인덱스도 신선도 필드를 뺀 내용에 서명한다
      return canonicalWithout(d, FRESHNESS);
    case 'manifest':
    case 'hotfix':
    case 'data_descriptor':
    case 'trust_root':
      return canonicalWithout(d, ['signatures']);
    case 'release': // 기간·타임스탬프는 게시 관문과 재서명 cron이 붙인다(services/registry verify.ts RELEASE_FRESHNESS)
      return canonicalWithout(d, ['signature', 'issuedAt', 'expiresAt', 'timestamp']);
    case 'root_change':
      if (!d.rootChange || typeof d.rootChange !== 'object') throw new CeremonyError('ceremony.doc_invalid', 'rootChange 없음');
      return rootChangeContent(d as unknown as ReleaseManifest);
  }
  throw new CeremonyError('ceremony.kind_unknown');
}

/** 타임스탬프 키 서명 입력 = JCS({contentDigest, monotonic, issuedAt, expiresAt}). */
export function timestampBytes(kind: DocKind, doc: unknown): Buffer {
  if (!TIMESTAMPED.has(kind)) throw new CeremonyError('ceremony.no_timestamp', kind);
  const d = obj(doc) as { monotonic?: unknown; issuedAt?: unknown; expiresAt?: unknown };
  if (!Number.isSafeInteger(d.monotonic) || typeof d.issuedAt !== 'string' || typeof d.expiresAt !== 'string') throw new CeremonyError('ceremony.doc_invalid', 'monotonic·issuedAt·expiresAt');
  const digest = createHash('sha256').update(signingBytes(kind, doc)).digest('hex');
  return timestampBody(digest, { monotonic: d.monotonic as number, issuedAt: d.issuedAt, expiresAt: d.expiresAt });
}

export const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/**
 * 서명 대상 파일(.tosign): 서명 입력 바이트 그대로. 의식 진행자가 만들어 보유자에게 건넨다.
 * 보유자의 서명 도구는 이 바이트의 SHA-256을 보이고, 보유자가 진행자가 읽은 값과 같다고 입력해야만 장치에 넘긴다.
 */
export interface ToSign {
  kind: DocKind;
  /** 'content'(역할 키) 또는 'timestamp'(타임스탬프 키) */
  part: 'content' | 'timestamp';
  bytes: Buffer;
  sha256: string;
  /** 화면에 보이는 요약(값 없음): 종류·keyEpoch·monotonic·버전 */
  summary: string;
}

export function prepare(kind: DocKind, doc: unknown, part: 'content' | 'timestamp' = 'content'): ToSign {
  const bytes = part === 'timestamp' ? timestampBytes(kind, doc) : signingBytes(kind, doc);
  const d = obj(doc);
  const bits = [`kind=${kind}`, `part=${part}`];
  for (const k of ['keyEpoch', 'monotonic', 'channel', 'id', 'version', 'issuedAt', 'expiresAt', 'releaseDate']) if (typeof d[k] === 'string' || typeof d[k] === 'number') bits.push(`${k}=${String(d[k])}`);
  if (kind === 'root_change') bits.push(`rootChange.keyEpoch=${String((d.rootChange as { keyEpoch?: unknown }).keyEpoch)}`);
  return { kind, part, bytes, sha256: sha256(bytes), summary: bits.join(' ') };
}

/** 사람이 읽고 맞춰 보는 형태: 4자씩 띄운 SHA-256 앞 32자(128비트). 서명 도구의 --confirm 값이다. */
export const confirmCode = (sha: string) => sha.slice(0, 32).match(/.{4}/g)!.join('-');

export { canonicalJson };
