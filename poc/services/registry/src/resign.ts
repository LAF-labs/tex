// 타임스탬프 자동 재서명(정리 cron, 팀장 결정 2026-11-06, D09 §8.2 "타임스탬프 역할 = 온라인 키").
// - 대상: 폐기 목록(24시간), status(48시간), 정책 current·{ver}(48시간), 채널 인덱스(48시간, ADR-043), 채널 릴리스 매니페스트(7일), 투명성 로그 트리 헤드.
//   릴리스는 판·파일·주소를 사람(release 키)이 서명하고 기간만 서버가 붙인다(부장 결정 2026-11-13: 13일마다 Touch ID를 받지 않는다).
// - 내용은 바꾸지 않는다. 바뀌는 것은 신선도 필드(issuedAt·expiresAt·timestamp)뿐이다. 내용 서명(루트·정책·긴급·패키지 키)은 신선도 필드를
//   서명 바이트에서 빼므로 그대로 유효하다(SIGNING.md §2·§4). 내용이 바뀌는 서명은 사람이 서명 의식(#149)으로 한다.
// - 서명 입력은 엔진 timestampBody(JCS({contentDigest, monotonic, issuedAt, expiresAt}))이고, 게시 전에 게시 관문과 같은 검증
//   (verifyRevoked·verifyStatus·verifyPolicy·verifyIndex, 저장본 대비 "같은 monotonic·같은 내용")을 통과해야 한다. 못 통과하면 다시 서명하지 않는다.
//   인덱스가 가리키는 패키지는 다시 보지 않는다(게시 때 관문이 봤고 경로가 불변이다).
// - 순서: 로그 항목을 먼저 쓰고(공개 전 기록) → 저장본이 그사이 바뀌지 않았는지 다시 읽어 보고 → 공개. 바뀌었으면(운영자 게시가 끼었으면) 이번 회차는 건너뛴다.
import { sign, type KeyObject } from 'node:crypto';
import { timestampBody } from '@sax/engine/core';
import { sha256hex } from '@sax/svc-shared';
import type { LogKind, TransparencyLog } from './log.ts';
import type { Store } from './store.ts';
import {
  CHANNELS,
  contentDigest,
  releaseStampContent,
  verifyIndex,
  verifyPolicy,
  verifyRelease,
  verifyRevoked,
  verifyStatus,
  type Channel,
  type RegistryIndex,
  type RegistryStatus,
  type ReleaseManifest,
  type RevokedKeys,
  type SignedPolicy,
  type TrustRoot,
} from './verify.ts';

const H = 3600_000;

/** 재서명 뒤 유효 기간(팀장 결정: 폐기 목록 24시간, status·정책 48시간, 인덱스 48시간 ADR-043). 남은 기간이 절반 아래로 떨어지면 다시 서명한다 */
export const RESIGN_TTL = { revoked_keys: 24 * H, status: 48 * H, policy: 48 * H, index: 48 * H, release: 7 * 24 * H } as const;
/** 헤드 timestamp가 이보다 오래되면 같은 트리에 다시 서명한다(cron 매시) */
export const HEAD_MAX_AGE_MS = 30 * 60_000;

export type ResignOutcome = 'resigned' | 'fresh' | 'missing' | 'changed' | `rejected:${string}`;
export interface ResignReport {
  revoked_keys: ResignOutcome;
  status: ResignOutcome;
  policy: ResignOutcome;
  /** 채널마다(ADR-043). 인덱스가 없는 채널은 missing */
  index: Record<Channel, ResignOutcome>;
  /** 채널 릴리스 매니페스트마다. 게시한 판이 없는 채널은 missing */
  release: Record<Channel, ResignOutcome>;
  head: 'resigned' | 'fresh';
}

export interface ResignDeps {
  store: Store;
  trust: TrustRoot;
  log: TransparencyLog;
  /** 타임스탬프 역할 키(logSigningKey: 공개키가 핀 고정 timestamp 키와 같음을 기동 때 확인했다) */
  signer: { keyId: string; key: KeyObject };
  now: () => number;
  onEvent?: (e: string) => void;
}

const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

type Freshness = { monotonic: number; issuedAt: string; expiresAt: string; timestamp: unknown };

/** 같은 내용에 새 issuedAt·expiresAt·timestamp. 내용 다이제스트는 저장본과 같다(재서명 정의) */
export function restamp<T extends Freshness>(doc: T, ttlMs: number, now: number, signer: ResignDeps['signer']): T {
  const issuedAt = iso(now);
  const expiresAt = iso(now + ttlMs);
  const digest = contentDigest(doc);
  const sig = sign(null, timestampBody(digest, { monotonic: doc.monotonic, issuedAt, expiresAt }), signer.key).toString('base64url');
  return { ...doc, issuedAt, expiresAt, timestamp: { keyId: signer.keyId, alg: 'ed25519', sig } };
}

/** 릴리스: 같은 내용(판·파일·주소·사람 서명)에 새 issuedAt·expiresAt·timestamp(releaseStampContent) */
export function restampRelease(doc: ReleaseManifest, ttlMs: number, now: number, signer: ResignDeps['signer']): ReleaseManifest {
  const fresh = { ...doc, issuedAt: iso(now), expiresAt: iso(now + ttlMs) };
  return { ...fresh, timestamp: { keyId: signer.keyId, alg: 'ed25519', sig: sign(null, releaseStampContent(fresh), signer.key).toString('base64url') } };
}

const parse = <T>(b: Buffer | null): T | null => {
  if (!b) return null;
  try {
    return JSON.parse(b.toString('utf8')) as T;
  } catch {
    return null;
  }
};

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown })?.code;
  return typeof c === 'string' ? c : 'error';
};

export async function resignAll(d: ResignDeps): Promise<ResignReport> {
  const now = d.now();
  const due = (doc: Freshness, ttl: number) => Date.parse(doc.expiresAt) - now < ttl / 2;

  /** 로그 → 다시 읽어 그대로인지 → 공개. 대상 키 여럿(정책 {ver}·current)도 같은 바이트 */
  const publish = async (kind: LogKind, targets: { key: string; before: Buffer }[], next: unknown): Promise<ResignOutcome> => {
    const bytes = Buffer.from(JSON.stringify(next));
    for (const t of targets) await d.log.append({ kind, path: t.key, sha256: sha256hex(bytes) });
    for (const t of targets) {
      const again = await d.store.get(t.key);
      if (!again || !again.equals(t.before)) return 'changed';
    }
    for (const t of targets) await d.store.put(t.key, bytes);
    return 'resigned';
  };

  const revokedSet = async () => new Set(parse<RevokedKeys>(await d.store.get('registry/revoked_keys.json'))?.revoked.map((r) => r.keyId) ?? []);

  const one = async (name: keyof typeof RESIGN_TTL, fn: () => Promise<ResignOutcome>): Promise<ResignOutcome> => {
    try {
      const r = await fn();
      if (r === 'resigned') d.onEvent?.(`registry.resigned_${name}`);
      return r;
    } catch (e) {
      d.onEvent?.('registry.resign_rejected');
      return `rejected:${codeOf(e)}`;
    }
  };

  const revoked_keys = await one('revoked_keys', async () => {
    const key = 'registry/revoked_keys.json';
    const before = await d.store.get(key);
    const cur = parse<RevokedKeys>(before);
    if (!cur || !before) return 'missing';
    if (!due(cur, RESIGN_TTL.revoked_keys)) return 'fresh';
    const next = restamp(cur, RESIGN_TTL.revoked_keys, now, d.signer);
    verifyRevoked(next, d.trust, cur, now);
    return publish('revoked_keys', [{ key, before }], next);
  });

  const status = await one('status', async () => {
    const key = 'registry/status.json';
    const before = await d.store.get(key);
    const cur = parse<RegistryStatus>(before);
    if (!cur || !before) return 'missing';
    if (!due(cur, RESIGN_TTL.status)) return 'fresh';
    const next = restamp(cur, RESIGN_TTL.status, now, d.signer);
    verifyStatus(next, d.trust, await revokedSet(), cur, now);
    return publish('status', [{ key, before }], next);
  });

  const policy = await one('policy', async () => {
    const curKey = 'policy/current.json';
    const before = await d.store.get(curKey);
    const cur = parse<SignedPolicy>(before);
    if (!cur || !before) return 'missing';
    if (!due(cur, RESIGN_TTL.policy)) return 'fresh';
    // {ver}.json과 current.json은 같은 내용이어야 한다(ADR-023). 다르면 사람이 게시로 맞춘다(재서명이 고치지 않는다)
    const verKey = `policy/${cur.version}.json`;
    const verBefore = await d.store.get(verKey);
    const ver = parse<SignedPolicy>(verBefore);
    if (!ver || !verBefore || ver.monotonic !== cur.monotonic || contentDigest(ver) !== contentDigest(cur)) return 'rejected:registry.version_rollback';
    const next = restamp(cur, RESIGN_TTL.policy, now, d.signer);
    verifyPolicy(next, d.trust, await revokedSet(), cur, now);
    return publish(
      'policy',
      [
        { key: verKey, before: verBefore },
        { key: curKey, before },
      ],
      next,
    );
  });

  const index = {} as Record<Channel, ResignOutcome>;
  for (const channel of CHANNELS) {
    index[channel] = await one('index', async () => {
      const key = `registry/${channel}/index.json`;
      const before = await d.store.get(key);
      const cur = parse<RegistryIndex>(before);
      if (!cur || !before) return 'missing';
      if (!due(cur, RESIGN_TTL.index)) return 'fresh';
      const next = restamp(cur, RESIGN_TTL.index, now, d.signer);
      verifyIndex(next, channel, d.trust, await revokedSet(), cur, now);
      return publish('index', [{ key, before }], next);
    });
  }

  const release = {} as Record<Channel, ResignOutcome>;
  for (const channel of CHANNELS) {
    release[channel] = await one('release', async () => {
      const key = `releases/${channel}/latest.json`;
      const before = await d.store.get(key);
      const cur = parse<ReleaseManifest>(before);
      if (!cur || !before) return 'missing';
      if (!due(cur as unknown as Freshness, RESIGN_TTL.release)) return 'fresh';
      const next = restampRelease(cur, RESIGN_TTL.release, now, d.signer);
      verifyRelease(next, channel, d.trust, await revokedSet(), cur, now);
      return publish('release', [{ key, before }], next);
    });
  }

  const head = (await d.log.refreshHead(HEAD_MAX_AGE_MS)) ? 'resigned' : 'fresh';
  if (head === 'resigned') d.onEvent?.('registry.resigned_head');
  return { revoked_keys, status, policy, index, release, head };
}
