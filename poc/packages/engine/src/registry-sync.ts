import { createHash } from 'node:crypto';
import type { Db } from '@sax/db';
import { BUNDLE_ALLOWLIST, BundleCatalog } from '@sax/model';
import type { RegistryBytesResponse } from '@sax/net';
import type { EventLog, LogFields } from '@sax/platform';
import { canonicalizable, sha256Hex } from './core/canon.ts';
import { ISSUED_AT_MAX_SKEW_MIN } from './core/constants.ts';
import { loadDataPackage, type DataBodyValidator, type DataLoadResult } from './core/datapkg.ts';
import { compareSemver, loadPackage, type LoadedPackage, type LoaderContext, type RawPackage } from './core/loader.ts';
import {
  acceptPolicy, acceptRevoked, acceptStatus, contentBytes, countSignatures, ed25519PublicKey, effectiveStatus, epochProblem, monotonicProblem, revokedFresh,
  statusFreshness, verifyTimestamp, type AcceptedPolicy, type AcceptedRevoked, type AcceptedStatus, type KeyRole, type RegistryStatus, type RevokedKeys, type StatusFreshness, type TrustRoots,
} from './core/registry.ts';
import { decodeSxp } from './core/sxp.ts';
import { policyFreshness, type PolicyFreshness } from './core/policy.ts';
import type { Manifest, Policy, Signature } from './core/types.ts';
import type { BundleOutcomes } from './core/validate.ts';

/** 앱에 핀 고정한 키 한 세대(tests/fixtures/registry/trust.json·services/registry TrustRoot·@sax/updater TrustRoot와 같은 모양). 값 = Ed25519 공개키 32바이트 표준 base64. */
export interface TrustPin {
  keyEpoch: number;
  keys: Partial<Record<KeyRole, Record<string, string>>>;
}

const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** 핀 → 엔진 TrustRoots. 루트·패키지·정책 키 3개, 긴급·타임스탬프 키 1개가 아니면 registry.pin_invalid(fail-closed). release 키는 엔진이 쓰지 않는다(main 업데이터 몫). */
export function trustRootsFromPin(pin: TrustPin): TrustRoots {
  const bad = (): never => {
    throw new RegistrySyncError('registry.pin_invalid');
  };
  if (!pin || typeof pin !== 'object' || !Number.isSafeInteger(pin.keyEpoch) || pin.keyEpoch < 1 || !pin.keys || typeof pin.keys !== 'object') bad();
  const role = (r: KeyRole, n: number) => {
    const ks = pin.keys[r];
    if (!ks || typeof ks !== 'object' || Object.keys(ks).length !== n) return bad();
    const m = new Map<string, ReturnType<typeof ed25519PublicKey>>();
    for (const [id, b64] of Object.entries(ks)) {
      if (!KEY_ID.test(id) || typeof b64 !== 'string') bad();
      const raw = Buffer.from(b64, 'base64');
      if (raw.length !== 32 || raw.toString('base64') !== b64) bad();
      m.set(id, ed25519PublicKey(raw));
    }
    return m;
  };
  const rootKeys = role('root', 3);
  const packageKeys = role('package', 3);
  const policyKeys = role('policy', 3);
  const [emergency] = [...role('emergency', 1)];
  const [timestamp] = [...role('timestamp', 1)];
  const ids = [rootKeys, packageKeys, policyKeys].flatMap((m) => [...m.keys()]).concat(emergency![0], timestamp![0]);
  if (new Set(ids).size !== ids.length) bad();
  return { keyEpoch: pin.keyEpoch, rootKeys, packageKeys, policyKeys, emergencyKey: { keyId: emergency![0], key: emergency![1] }, timestampKey: { keyId: timestamp![0], key: timestamp![1] } };
}

export const REGISTRY_PATHS = { revoked: '/registry/revoked_keys.json', status: '/registry/status.json', policy: '/policy/current.json', index: '/registry/stable/index.json' } as const;
/** `.sxp` 경로. id·version은 인덱스 검증을 통과한 값만 넣는다. */
export const packagePath = (id: string, version: string) => `/packages/${id}@${version}.sxp`;

/** 받은 응답. 304는 body 없음(If-None-Match가 같다). */
export interface RegistryResponse {
  status: number;
  body?: Uint8Array;
  etag?: string;
}
/**
 * 레지스트리 GET 하나(제품: @sax/net Egress가 레지스트리 origin 고정·리디렉션 거부·시간 상한으로 보낸다). path는 REGISTRY_PATHS 또는 packagePath만.
 * 네트워크 실패는 던진다(코드는 부르는 쪽이 registry.fetch_failed로 바꾼다).
 */
export type RegistryFetch = (path: string, opts: { etag?: string }) => Promise<RegistryResponse>;

/**
 * 제품 RegistryFetch: @sax/net Egress 레지스트리 바이트 GET(origin tax.laf-co.com 고정·허용 경로·리디렉션 거부·시간 상한, ADR-028).
 * Egress 오류는 그대로 던진다(RegistrySync가 registry.fetch_failed로 바꾼다).
 */
export function egressRegistryFetch(egress: { getRegistryBytes(target: string, o?: { etag?: string }): Promise<RegistryBytesResponse> }): RegistryFetch {
  return async (path, opts) => {
    const r = await egress.getRegistryBytes(path, opts.etag ? { etag: opts.etag } : {});
    return { status: r.status, ...(r.body ? { body: r.body } : {}), ...(r.etag ? { etag: r.etag } : {}) };
  };
}

/** 문서(JSON) 응답 상한. 인덱스 게시 상한(512KB)과 같다. `.sxp`는 인덱스 항목 size가 상한이다. */
export const REGISTRY_DOC_MAX_BYTES = 512 * 1024;

export class RegistrySyncError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

export interface IndexEntry {
  id: string;
  version: string;
  kind: 'playbook' | 'lookup' | 'hotfix' | 'data';
  portal?: string;
  sxpDigest: string;
  size: number;
  rolloutPercent: number;
  minAppVersion?: string;
}

export interface RegistryIndex {
  channel: 'stable' | 'beta' | 'hotfix';
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  entries: IndexEntry[];
  signatures: Signature[];
  timestamp: Signature;
}

export const INDEX_MAX_VALIDITY_MS = 14 * 24 * 3_600_000;
const INDEX_KEYS = new Set(['channel', 'monotonic', 'keyEpoch', 'issuedAt', 'expiresAt', 'entries', 'signatures', 'timestamp']);
const ENTRY_KEYS = new Set(['id', 'version', 'kind', 'portal', 'sxpDigest', 'size', 'rolloutPercent', 'minAppVersion']);
const ID_RE = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const BLOCKED_PORTALS = ['wetax', 'fixture'];

export interface AcceptedIndex {
  index: RegistryIndex;
  contentDigest: string;
}

/**
 * 인덱스 수용(services/registry verifyIndex와 같은 규칙, API.md "인덱스", ADR-043): 모양 → keyEpoch → 내용(contentBytes = 신선도 필드를 뺀 JCS)에 패키지 키 2-of-3(폐기 반영) →
 * 타임스탬프 키 신선도 서명(폐기 반영) → 기간 ≤ 14일·미래 금지·도착 시 만료 금지 → 같은 keyEpoch 안 단조(+1000 이하, 같은 값은 같은 내용만 = 신선도 재서명).
 * 핫픽스 채널은 여기서 받지 않는다(stable만).
 */
export function acceptIndex(doc: RegistryIndex, ctx: { roots: TrustRoots; revoked: ReadonlySet<string>; current: AcceptedIndex | null; now: number }): { ok: true; accepted: AcceptedIndex; events: string[] } | { ok: false; code: string; events: string[] } {
  const events: string[] = [];
  const no = (code: string) => ({ ok: false as const, code, events });
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).some((k) => !INDEX_KEYS.has(k)) || !canonicalizable(doc)) return no('registry.schema_invalid');
  if (doc.channel !== 'stable' || !Number.isSafeInteger(doc.monotonic) || doc.monotonic < 0 || !Number.isSafeInteger(doc.keyEpoch)) return no('registry.schema_invalid');
  if (typeof doc.issuedAt !== 'string' || !ISO_RE.test(doc.issuedAt) || typeof doc.expiresAt !== 'string' || !ISO_RE.test(doc.expiresAt)) return no('registry.schema_invalid');
  if (!Array.isArray(doc.entries) || doc.entries.length > 500 || !Array.isArray(doc.signatures) || doc.signatures.length > 3) return no('registry.schema_invalid');
  const seen = new Set<string>();
  for (const e of doc.entries) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some((k) => !ENTRY_KEYS.has(k))) return no('registry.schema_invalid');
    if (typeof e.id !== 'string' || !ID_RE.test(e.id) || e.id.length > 128 || typeof e.version !== 'string' || !SEMVER_RE.test(e.version) || typeof e.sxpDigest !== 'string' || !/^[0-9a-f]{64}$/.test(e.sxpDigest)) return no('registry.schema_invalid');
    if (!['playbook', 'lookup', 'hotfix', 'data'].includes(e.kind) || !Number.isSafeInteger(e.size) || e.size < 1 || e.size > 16 * 1024 * 1024) return no('registry.schema_invalid');
    if (!Number.isInteger(e.rolloutPercent) || e.rolloutPercent < 0 || e.rolloutPercent > 100) return no('registry.schema_invalid');
    if (e.portal !== undefined && (typeof e.portal !== 'string' || !/^[a-z0-9_]{1,32}$/.test(e.portal))) return no('registry.schema_invalid');
    if (e.minAppVersion !== undefined && (typeof e.minAppVersion !== 'string' || !SEMVER_RE.test(e.minAppVersion))) return no('registry.schema_invalid');
    if (e.kind === 'hotfix' || e.id.endsWith('.hotfix')) return no('registry.schema_invalid');
    if (e.portal !== undefined && BLOCKED_PORTALS.includes(e.portal)) return no('registry.portal_blocked');
    const k = `${e.id}@${e.version}`;
    if (seen.has(k)) return no('registry.schema_invalid');
    seen.add(k);
  }
  const ep = epochProblem(doc, ctx.roots);
  if (ep) return no(ep);
  const content = contentBytes(doc);
  const digest = sha256Hex(content);
  const q = countSignatures(content, doc.signatures, ctx.roots.packageKeys, ctx.revoked);
  if (q.revoked.length) events.push('registry.key_revoked');
  if (q.valid.length < 2) return no('registry.signature_insufficient');
  const ts = doc.timestamp as Partial<Signature> | undefined;
  if (!ts || typeof ts !== 'object' || Array.isArray(ts) || ts.alg !== 'ed25519' || typeof ts.keyId !== 'string' || typeof ts.sig !== 'string' || !verifyTimestamp(digest, doc, ctx.roots, ctx.revoked)) return no('registry.timestamp_invalid');
  const iss = Date.parse(doc.issuedAt);
  const exp = Date.parse(doc.expiresAt);
  if (!(exp > iss) || exp - iss > INDEX_MAX_VALIDITY_MS) return no('registry.index_validity_too_long');
  if (iss > ctx.now + ISSUED_AT_MAX_SKEW_MIN * 60_000) return no('registry.issued_in_future');
  if (exp <= ctx.now) return no('registry.expired_on_arrival');
  const vp = monotonicProblem(ctx.current ? { ...ctx.current.index, contentDigest: ctx.current.contentDigest } : null, doc, digest);
  if (vp) return no(vp);
  return { ok: true, accepted: { index: doc, contentDigest: digest }, events };
}

/** 롤아웃 버킷(services/registry rolloutBucket과 같다): u32be(sha256("SAX-rollout-v1\0" ‖ id ‖ "\0" ‖ deviceId)[0..4]) mod 100. */
export function rolloutBucket(packageId: string, deviceId: string): number {
  return createHash('sha256').update(`SAX-rollout-v1\u0000${packageId}\u0000${deviceId}`, 'utf8').digest().readUInt32BE(0) % 100;
}

/** 받아 둔 문서 저장소. 값은 JSON으로 직렬화할 수 있는 것만. */
export interface RegistryStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

/** DB settings 표(엔진만 연다, D07 §1.3). 키는 registry.* 이름 공간. */
export function settingsRegistryStore(db: Db): RegistryStore {
  return {
    get(key) {
      const v = db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(`registry.${key}`) as string | undefined;
      return v === undefined ? null : (JSON.parse(v) as unknown);
    },
    set(key, value) {
      db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(`registry.${key}`, JSON.stringify(value));
    },
  };
}

export function memoryRegistryStore(): RegistryStore & { dump(): Record<string, unknown> } {
  const m = new Map<string, string>();
  return {
    get: (k) => (m.has(k) ? (JSON.parse(m.get(k)!) as unknown) : null),
    set: (k, v) => void m.set(k, JSON.stringify(v)),
    dump: () => Object.fromEntries([...m].map(([k, v]) => [k, JSON.parse(v) as unknown])),
  };
}

/** 데이터 패키지 하나(예: 급여 시행일 표 payroll.rate-tables, D14 M6-10). 본문 모양·저장은 받는 곳이 안다. */
export interface DataSink {
  id: string;
  schemas: ReadonlyMap<string, DataBodyValidator>;
  installed(): { version: string; digest: string } | null;
  apply(result: DataLoadResult): { ok: true } | { ok: false; code: string };
}

export type SyncOutcome = 'accepted' | 'unchanged' | string;

export interface SyncReport {
  revoked: SyncOutcome;
  status: SyncOutcome;
  policy: SyncOutcome;
  index: SyncOutcome;
  packages?: Record<string, SyncOutcome>;
  data: Record<string, SyncOutcome>;
  revokedFresh: boolean;
}

export interface PolicyView {
  freshness: PolicyFreshness;
  policy: Policy | null;
  monotonic: number | null;
  emergency: boolean;
  clamped: string[];
}

export interface RevocationView {
  keyIds: string[];
  fresh: boolean;
  monotonic: number | null;
  expiresAt: string | null;
}

export interface StatusView {
  freshness: StatusFreshness;
  emergency: boolean;
  monotonic: number | null;
  portalModeCeiling: RegistryStatus['portalModeCeiling'];
  killPlaybooks: string[];
}

interface StoredStatus {
  status: RegistryStatus;
  contentDigest: string;
  emergency: boolean;
  contentIssuedAt: string;
  acceptedAt: number;
}

export interface RegistrySyncOptions {
  trust: TrustPin;
  fetch: RegistryFetch | null;
  store: RegistryStore;
  sinks?: readonly DataSink[];
  packages?: PackageSupplyOptions;
  deviceId?: () => string | null;
  appVersion?: string | null;
  now?: () => number;
  log?: EventLog;
}

/** 이 앱 판으로 이 항목(minAppVersion)을 쓸 수 있는가. 항목에 minAppVersion이 없으면 늘 된다. 앱 판을 모르면 안 된다(fail-closed). */
export function appVersionAllows(minAppVersion: string | undefined, appVersion: string | null | undefined): boolean {
  if (minAppVersion === undefined) return true;
  if (!appVersion || !SEMVER_RE.test(appVersion)) return false;
  return (compareSemver(appVersion, minAppVersion) ?? -1) >= 0;
}

/**
 * 검증을 마치고 저장한 패키지 하나(RegistryStore `pkg.<id>@<version>`, 제품은 암호화 DB settings). sxp = 받은 .sxp 원본 바이트(표준 base64).
 * 같은 id@version은 불변이다(레지스트리 정적 경로와 같다). 플레이북의 지금 버전은 `pkg.current.<id>`이고 올라가기만 한다.
 */
export interface StoredPackage {
  id: string;
  version: string;
  kind: 'playbook' | 'lookup';
  manifestDigest: string;
  sxpDigest: string;
  sxp: string;
  acceptedAt: number;
  minAppVersion?: string;
}

/**
 * 제품이 받는 플레이북 id(엔진 entry, 서명 전 원본 packages/engine/playbooks/<id>). H-01 = 홈택스 전자세금계산서 발급,
 * H-03·H-04·H-08·H-09 = 홈택스 민원증명(승인 카드 cert.confirm, 팀장 지시 2026-11-09). 조회 하위 패키지(hometax.invoice.lookup·email_status,
 * 민원증명 공통 hometax.cert.issued_list)는 여기 넣지 않는다: 플레이북 manifest lookupsUsed를 따라 같이 받는다(인덱스에 게시되지 않은 id는 'unchanged').
 */
export const PRODUCT_PACKAGES = {
  h01: 'hometax.invoice.issue',
  h03: 'hometax.cert.biz_registration',
  h04: 'hometax.cert.taxpayment',
  h08: 'hometax.cert.vat_tax_base',
  h09: 'hometax.cert.financial_statements',
} as const;
/** 민원증명 플레이북 id(run.startCert가 받는 것). */
export const PRODUCT_CERT_IDS: readonly string[] = [PRODUCT_PACKAGES.h03, PRODUCT_PACKAGES.h04, PRODUCT_PACKAGES.h08, PRODUCT_PACKAGES.h09];
/** RegistrySync packages.ids(제품). */
export const PRODUCT_PACKAGE_IDS: readonly string[] = Object.values(PRODUCT_PACKAGES);

export interface PackageSupplyOptions {
  ids: readonly string[];
  bundleAllowlist?: ReadonlyArray<{ id: string; digest: string }>;
  bundles?: ReadonlyMap<string, BundleOutcomes>;
}

/** 설치본 로드 결과(실행 시작). lookups = lookupsUsed id → 로드한 조회 패키지. */
export type InstalledPackage = { ok: true; pkg: LoadedPackage; lookups: ReadonlyMap<string, LoadedPackage>; events: string[] } | { ok: false; code: string; events: string[] };

const PKG_ID = /^[a-z0-9]+(\.[a-z0-9_-]+)+$/;
const SEMVER_ONLY = /^\d+\.\d+\.\d+$/;

function lookupsUsedOf(manifest: Uint8Array): Array<{ id: string; version: string; digest: string }> {
  try {
    const m = JSON.parse(Buffer.from(manifest).toString('utf8')) as Partial<Manifest>;
    if (!Array.isArray(m.lookupsUsed) || m.lookupsUsed.length > 16) return [];
    return m.lookupsUsed.filter((l) => l && typeof l.id === 'string' && PKG_ID.test(l.id) && typeof l.version === 'string' && SEMVER_ONLY.test(l.version) && typeof l.digest === 'string' && /^[0-9a-f]{64}$/.test(l.digest));
  } catch {
    return [];
  }
}

/** 앱 내장 번들 결과(V-07, loader ctx.bundles). */
export function appBundleOutcomes(): Map<string, BundleOutcomes> {
  return new Map(BundleCatalog.load().list().map((b) => [b.wireId, { outcomes: b.def.outcomes.map((o) => o.name), reserved: b.def.reservedOutcomes }]));
}

const parseDoc = (b: Uint8Array | undefined): unknown => {
  if (!b || b.length === 0 || b.length > REGISTRY_DOC_MAX_BYTES) throw new RegistrySyncError('registry.response_invalid');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(b)) as unknown;
  } catch {
    throw new RegistrySyncError('registry.response_invalid');
  }
};

export class RegistrySync {
  private readonly o: RegistrySyncOptions;
  private readonly roots: TrustRoots;
  private running: Promise<SyncReport> | null = null;
  private bundleCache: ReadonlyMap<string, BundleOutcomes> | null = null;

  constructor(o: RegistrySyncOptions) {
    this.o = o;
    this.roots = trustRootsFromPin(o.trust);
    if (o.packages) for (const id of o.packages.ids) if (!PKG_ID.test(id) || id.endsWith('.hotfix')) throw new RegistrySyncError('registry.package_id_invalid');
  }

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private event(name: string, data: LogFields = {}): void {
    this.o.log?.event(name, data);
  }

  private currentRevoked(): AcceptedRevoked | null {
    const list = this.o.store.get('revoked') as RevokedKeys | null;
    if (!list) return null;
    return { list, contentDigest: sha256Hex(contentBytes(list)), keyIds: new Set(list.revoked.map((r) => r.keyId)) };
  }

  private storedStatus(key: 'status' | 'status_quorum'): AcceptedStatus | null {
    const s = this.o.store.get(key) as StoredStatus | null;
    return s ? { ...s } : null;
  }

  private storedPolicy(): AcceptedPolicy | null {
    const p = this.o.store.get('policy') as AcceptedPolicy | null;
    return p ? structuredClone(p) : null;
  }

  private currentIndex(): AcceptedIndex | null {
    const index = this.o.store.get('index.stable') as RegistryIndex | null;
    return index ? { index, contentDigest: sha256Hex(contentBytes(index)) } : null;
  }

  pins(): TrustPin {
    return structuredClone(this.o.trust);
  }

  revocation(): RevocationView {
    const r = this.currentRevoked();
    return { keyIds: r ? [...r.keyIds].sort() : [], fresh: revokedFresh(r, this.now()), monotonic: r?.list.monotonic ?? null, expiresAt: r?.list.expiresAt ?? null };
  }

  status(): StatusView {
    const now = this.now();
    const latest = this.storedStatus('status');
    const quorum = this.storedStatus('status_quorum');
    const eff = effectiveStatus(latest, quorum, now);
    const emergency = !!latest && eff === latest.status && latest.emergency;
    return {
      freshness: statusFreshness(eff, now),
      emergency,
      monotonic: eff?.monotonic ?? null,
      portalModeCeiling: { ...(eff?.portalModeCeiling ?? {}) },
      killPlaybooks: [...(eff?.killPlaybooks ?? [])],
    };
  }

  policy(): PolicyView {
    const a = this.storedPolicy();
    return { freshness: policyFreshness(a?.policy ?? null, this.now()), policy: a?.policy ?? null, monotonic: a?.raw.monotonic ?? null, emergency: a?.emergency ?? false, clamped: a?.clamped ?? [] };
  }

  sync(): Promise<SyncReport> {
    if (!this.running) this.running = this.syncOnce().finally(() => (this.running = null));
    return this.running;
  }

  private async get(path: string, etagKey: string | null): Promise<{ notModified: true } | { notModified: false; body: Uint8Array; etag?: string }> {
    const etag = etagKey ? ((this.o.store.get(`etag.${etagKey}`) as string | null) ?? undefined) : undefined;
    let r: RegistryResponse;
    try {
      r = await this.o.fetch!(path, { etag });
    } catch {
      throw new RegistrySyncError('registry.fetch_failed');
    }
    if (r.status === 304 && etag) return { notModified: true };
    if (r.status !== 200 || !r.body) throw new RegistrySyncError(r.status === 404 ? 'registry.not_found' : 'registry.fetch_failed');
    return { notModified: false, body: r.body, etag: typeof r.etag === 'string' && r.etag.length <= 128 ? r.etag : undefined };
  }

  private async syncOnce(): Promise<SyncReport> {
    const report: SyncReport = { revoked: 'skipped', status: 'skipped', policy: 'skipped', index: 'skipped', data: {}, revokedFresh: false };
    if (!this.o.fetch) {
      report.revoked = report.status = report.policy = report.index = 'registry.fetch_unavailable';
      report.revokedFresh = revokedFresh(this.currentRevoked(), this.now());
      return report;
    }
    report.revoked = await this.step('revoked', () => this.syncRevoked());
    const revoked = this.currentRevoked();
    report.revokedFresh = revokedFresh(revoked, this.now());
    const revokedIds = revoked?.keyIds ?? new Set<string>();
    report.status = await this.step('status', () => this.syncStatus(revokedIds, !report.revokedFresh));
    report.policy = await this.step('policy', () => this.syncPolicy(revokedIds, !report.revokedFresh));
    report.index = await this.step('index', () => this.syncIndex(revokedIds));
    const index = this.currentIndex();
    if (this.o.packages) {
      report.packages = {};
      for (const id of this.o.packages.ids) report.packages[id] = index ? await this.step('package', () => this.syncPackage(id, index.index, revokedIds, !report.revokedFresh)) : 'registry.index_missing';
    }
    for (const sink of this.o.sinks ?? []) report.data[sink.id] = index ? await this.step('data', () => this.syncData(sink, index.index, revokedIds, !report.revokedFresh)) : 'registry.index_missing';
    const accepted = (r: Record<string, SyncOutcome> | undefined) => Object.values(r ?? {}).filter((v) => v === 'accepted').length;
    this.event('registry.synced', { revoked: report.revoked, status: report.status, policy: report.policy, index: report.index, packages: accepted(report.packages), data: accepted(report.data), fresh: report.revokedFresh });
    return report;
  }

  private async step(what: string, fn: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    try {
      return await fn();
    } catch (e) {
      const code = e instanceof RegistrySyncError ? e.code : 'registry.sync_failed';
      this.event('registry.rejected', { what, code });
      return code;
    }
  }

  private async syncRevoked(): Promise<SyncOutcome> {
    const r = await this.get(REGISTRY_PATHS.revoked, 'revoked');
    if (r.notModified) return 'unchanged';
    const d = acceptRevoked(parseDoc(r.body) as RevokedKeys, { roots: this.roots, current: this.currentRevoked(), now: this.now() });
    if (!d.ok) throw new RegistrySyncError(d.code);
    this.o.store.set('revoked', d.accepted.list);
    if (r.etag) this.o.store.set('etag.revoked', r.etag);
    return 'accepted';
  }

  private async syncStatus(revoked: ReadonlySet<string>, hold: boolean): Promise<SyncOutcome> {
    const r = await this.get(REGISTRY_PATHS.status, 'status');
    if (r.notModified) return 'unchanged';
    const d = acceptStatus(parseDoc(r.body) as RegistryStatus, { roots: this.roots, revoked, current: this.storedStatus('status'), hold, now: this.now() });
    for (const ev of d.events) this.event(ev, { what: 'status' });
    if (!d.ok) throw new RegistrySyncError(d.code);
    const a = d.accepted;
    const rec: StoredStatus = { status: a.status, contentDigest: a.contentDigest, emergency: a.emergency, contentIssuedAt: a.contentIssuedAt, acceptedAt: a.acceptedAt };
    this.o.store.set('status', rec);
    if (!a.emergency) this.o.store.set('status_quorum', rec);
    if (r.etag) this.o.store.set('etag.status', r.etag);
    return 'accepted';
  }

  private async syncPolicy(revoked: ReadonlySet<string>, hold: boolean): Promise<SyncOutcome> {
    const r = await this.get(REGISTRY_PATHS.policy, 'policy');
    if (r.notModified) return 'unchanged';
    const d = acceptPolicy(parseDoc(r.body) as Policy, { roots: this.roots, revoked, current: this.storedPolicy(), hold, now: this.now() });
    for (const ev of d.events) this.event(ev, { what: 'policy' });
    if (!d.ok) throw new RegistrySyncError(d.code);
    this.o.store.set('policy', d.accepted);
    if (r.etag) this.o.store.set('etag.policy', r.etag);
    return 'accepted';
  }

  private async syncIndex(revoked: ReadonlySet<string>): Promise<SyncOutcome> {
    const r = await this.get(REGISTRY_PATHS.index, 'index.stable');
    if (r.notModified) return 'unchanged';
    const d = acceptIndex(parseDoc(r.body) as RegistryIndex, { roots: this.roots, revoked, current: this.currentIndex(), now: this.now() });
    for (const ev of d.events) this.event(ev, { what: 'index' });
    if (!d.ok) throw new RegistrySyncError(d.code);
    this.o.store.set('index.stable', d.accepted.index);
    if (r.etag) this.o.store.set('etag.index.stable', r.etag);
    return 'accepted';
  }

  private async syncData(sink: DataSink, index: RegistryIndex, revoked: ReadonlySet<string>, hold: boolean): Promise<SyncOutcome> {
    const deviceId = this.o.deviceId?.() ?? null;
    const rolled = index.entries.filter((e) => e.kind === 'data' && e.id === sink.id && e.portal === undefined && (deviceId ? rolloutBucket(e.id, deviceId) < e.rolloutPercent : e.rolloutPercent === 100));
    const candidates = this.compatible(rolled, 'data');
    if (!candidates.length) return rolled.length ? 'registry.app_version_low' : 'unchanged';
    const entry = candidates.reduce((a, b) => ((compareSemver(b.version, a.version) ?? 0) > 0 ? b : a));
    const installed = sink.installed();
    if (installed && entry.version === installed.version) return 'unchanged';
    if (installed && (compareSemver(entry.version, installed.version) ?? -1) < 0) return 'unchanged';
    const res = await this.get(packagePath(entry.id, entry.version), null);
    if (res.notModified) return 'unchanged';
    const bytes = res.body;
    if (bytes.length !== entry.size || sha256Hex(bytes) !== entry.sxpDigest) throw new RegistrySyncError('registry.content_digest_mismatch');
    const sxp = decodeSxp(bytes);
    if (!sxp.ok) throw new RegistrySyncError(sxp.code);
    if (sxp.sxp.kind !== 'data') throw new RegistrySyncError('registry.kind_mismatch');
    const loaded = loadDataPackage(sxp.sxp.raw, { roots: this.roots, revoked, schemas: sink.schemas, installed, hold, now: this.now() });
    for (const ev of loaded.events) this.event(ev, { what: 'data' });
    if (loaded.ok && (loaded.data.descriptor.id !== entry.id || loaded.data.descriptor.version !== entry.version)) throw new RegistrySyncError('registry.kind_mismatch');
    const applied = sink.apply(loaded);
    if (!applied.ok) throw new RegistrySyncError(applied.code);
    return 'accepted';
  }

  private storedPackage(id: string, version: string): StoredPackage | null {
    return (this.o.store.get(`pkg.${id}@${version}`) as StoredPackage | null) ?? null;
  }

  private currentPackage(id: string): StoredPackage | null {
    const v = this.o.store.get(`pkg.current.${id}`);
    return typeof v === 'string' ? this.storedPackage(id, v) : null;
  }

  private loaderCtx(installedLookups: ReadonlyMap<string, LoadedPackage>, installed: StoredPackage | null, hold: boolean, revoked: ReadonlySet<string>): LoaderContext {
    this.bundleCache ??= this.o.packages?.bundles ?? appBundleOutcomes();
    return {
      roots: this.roots, revoked, bundleAllowlist: this.o.packages?.bundleAllowlist ?? BUNDLE_ALLOWLIST, bundles: this.bundleCache, installedLookups,
      storedVersion: installed?.version ?? null, installedDigest: installed?.manifestDigest ?? null, hold,
      policyFresh: this.policy().freshness === 'fresh', now: this.now(),
    };
  }

  private compatible(entries: IndexEntry[], what: 'package' | 'data'): IndexEntry[] {
    const ok = entries.filter((e) => appVersionAllows(e.minAppVersion, this.o.appVersion));
    if (ok.length < entries.length) this.event('registry.app_version_low', { what });
    return ok;
  }

  private async fetchPackage(entry: IndexEntry): Promise<{ raw: RawPackage; bytes: Uint8Array }> {
    const res = await this.get(packagePath(entry.id, entry.version), null);
    if (res.notModified) throw new RegistrySyncError('registry.fetch_failed');
    const bytes = res.body;
    if (bytes.length !== entry.size || sha256Hex(bytes) !== entry.sxpDigest) throw new RegistrySyncError('registry.content_digest_mismatch');
    return { raw: this.decodePackage(bytes), bytes };
  }

  private decodePackage(bytes: Uint8Array): RawPackage {
    const sxp = decodeSxp(bytes);
    if (!sxp.ok) throw new RegistrySyncError(sxp.code);
    if (sxp.sxp.kind !== 'package') throw new RegistrySyncError('registry.kind_mismatch');
    return sxp.sxp.raw;
  }

  private loadStored(s: StoredPackage, installedLookups: ReadonlyMap<string, LoadedPackage>, revoked: ReadonlySet<string>, hold: boolean, events: string[]): LoadedPackage {
    if (!appVersionAllows(s.minAppVersion, this.o.appVersion)) throw new RegistrySyncError('registry.app_version_low');
    const bytes = Buffer.from(s.sxp, 'base64');
    if (sha256Hex(bytes) !== s.sxpDigest) throw new RegistrySyncError('package.store_corrupt');
    const r = loadPackage(this.decodePackage(bytes), this.loaderCtx(installedLookups, s, hold, revoked));
    events.push(...r.events);
    if (!r.ok) throw new RegistrySyncError(r.code);
    const m = r.pkg.files.manifest;
    if (m.id !== s.id || m.version !== s.version || m.kind !== s.kind || r.pkg.manifestDigest !== s.manifestDigest) throw new RegistrySyncError('package.store_corrupt');
    return r.pkg;
  }

  private record(entry: IndexEntry, pkg: LoadedPackage, bytes: Uint8Array): StoredPackage {
    return { id: entry.id, version: entry.version, kind: entry.kind as StoredPackage['kind'], manifestDigest: pkg.manifestDigest, sxpDigest: entry.sxpDigest, sxp: Buffer.from(bytes).toString('base64'), acceptedAt: this.now(), ...(entry.minAppVersion !== undefined ? { minAppVersion: entry.minAppVersion } : {}) };
  }

  private async syncPackage(id: string, index: RegistryIndex, revoked: ReadonlySet<string>, hold: boolean): Promise<SyncOutcome> {
    const deviceId = this.o.deviceId?.() ?? null;
    const rolled = index.entries.filter((e) => e.kind === 'playbook' && e.id === id && (deviceId ? rolloutBucket(e.id, deviceId) < e.rolloutPercent : e.rolloutPercent === 100));
    const candidates = this.compatible(rolled, 'package');
    if (!candidates.length) return rolled.length ? 'registry.app_version_low' : 'unchanged';
    const entry = candidates.reduce((a, b) => ((compareSemver(b.version, a.version) ?? 0) > 0 ? b : a));
    const current = this.currentPackage(id);
    if (current && (compareSemver(entry.version, current.version) ?? -1) <= 0) return 'unchanged';
    const events: string[] = [];
    try {
      const top = await this.fetchPackage(entry);
      const lookups = new Map<string, LoadedPackage>();
      const fresh: StoredPackage[] = [];
      for (const l of lookupsUsedOf(top.raw.manifest)) {
        const have = this.storedPackage(l.id, l.version);
        if (have) {
          if (have.manifestDigest !== l.digest) throw new RegistrySyncError('loader.lookup_mismatch');
          lookups.set(l.id, this.loadStored(have, new Map(), revoked, hold, events));
          continue;
        }
        const le = index.entries.find((e) => e.kind === 'lookup' && e.id === l.id && e.version === l.version);
        if (!le) throw new RegistrySyncError('loader.lookup_mismatch');
        if (!appVersionAllows(le.minAppVersion, this.o.appVersion)) throw new RegistrySyncError('registry.app_version_low');
        const got = await this.fetchPackage(le);
        const r = loadPackage(got.raw, this.loaderCtx(new Map(), null, hold, revoked));
        events.push(...r.events);
        if (!r.ok) throw new RegistrySyncError(r.code);
        if (r.pkg.files.manifest.id !== le.id || r.pkg.files.manifest.version !== le.version || r.pkg.files.manifest.kind !== 'lookup') throw new RegistrySyncError('registry.kind_mismatch');
        lookups.set(l.id, r.pkg);
        fresh.push(this.record(le, r.pkg, got.bytes));
      }
      const r = loadPackage(top.raw, this.loaderCtx(lookups, current, hold, revoked));
      events.push(...r.events);
      if (!r.ok) throw new RegistrySyncError(r.code);
      const m = r.pkg.files.manifest;
      if (m.id !== entry.id || m.version !== entry.version || m.kind !== 'playbook' || (entry.portal !== undefined && m.portal !== entry.portal)) throw new RegistrySyncError('registry.kind_mismatch');
      for (const f of fresh) this.o.store.set(`pkg.${f.id}@${f.version}`, f);
      this.o.store.set(`pkg.${id}@${entry.version}`, this.record(entry, r.pkg, top.bytes));
      this.o.store.set(`pkg.current.${id}`, entry.version);
      return 'accepted';
    } finally {
      for (const ev of new Set(events)) this.event(ev, { what: 'package' });
    }
  }

  loadInstalled(id: string): InstalledPackage {
    const events: string[] = [];
    const current = this.currentPackage(id);
    if (!current || current.kind !== 'playbook') return { ok: false, code: 'package.not_loaded', events };
    const rev = this.currentRevoked();
    const revoked = rev?.keyIds ?? new Set<string>();
    const hold = !revokedFresh(rev, this.now());
    try {
      const top = Buffer.from(current.sxp, 'base64');
      if (sha256Hex(top) !== current.sxpDigest) throw new RegistrySyncError('package.store_corrupt');
      const lookups = new Map<string, LoadedPackage>();
      for (const l of lookupsUsedOf(this.decodePackage(top).manifest)) {
        const s = this.storedPackage(l.id, l.version);
        if (!s || s.kind !== 'lookup' || s.manifestDigest !== l.digest) throw new RegistrySyncError('loader.lookup_mismatch');
        lookups.set(l.id, this.loadStored(s, new Map(), revoked, hold, events));
      }
      const pkg = this.loadStored(current, lookups, revoked, hold, events);
      return { ok: true, pkg, lookups, events: [...new Set(events)] };
    } catch (e) {
      return { ok: false, code: e instanceof RegistrySyncError ? e.code : 'package.load_failed', events: [...new Set(events)] };
    }
  }

  async handle(method: string): Promise<unknown> {
    switch (method) {
      case 'registry.sync':
        return this.sync();
      case 'db.query.registry.revocation':
        return this.revocation();
      case 'db.query.registry.pins':
        return this.pins();
      case 'db.query.registry.status':
        return this.status();
    }
    throw new RegistrySyncError('unknown_method');
  }
}
