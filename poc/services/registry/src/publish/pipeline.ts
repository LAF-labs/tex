import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  canonicalJson,
  decodeSxp,
  encodeSxp,
  loadPackage,
  manifestDigest,
  schemaViolations,
  verifyConsistency,
  type BundleOutcomes,
  type LoadedPackage,
  type Manifest,
  type RawPackage,
} from '@sax/engine/core';
import { BUNDLE_ALLOWLIST, BundleCatalog } from '@sax/model';
import { leafHashOf, verifyInclusion, verifyTreeHead, type LogEntryRecord, type SignedTreeHead } from '../log.ts';
import {
  BLOCKED_PORTALS,
  CHANNELS,
  contentDigest,
  countSignatures,
  engineRoots,
  verifyIndex,
  verifyPackageBytes,
  verifyPolicy,
  verifyRevoked,
  verifySxp,
  verifyStatus,
  type Channel,
  type IndexEntry,
  type RegistryIndex,
  type RegistryStatus,
  type RevokedKeys,
  type SignedPolicy,
  type TrustRoot,
} from '../verify.ts';
import { collectSignatures, type SignatureRecord, type TrustPin } from '../ceremony/collect.ts';
import { CeremonyError, confirmCode, prepare as prepareDoc, type DocKind } from '../ceremony/content.ts';

export const PLAN_TOOL = 'sax-publish/1';
/** 게시 관문 함수 본문 상한(Vercel 함수 4.5MB, JSON base64 포함)보다 낮게 */
export const PUT_BODY_MAX = 4_000_000;
const POLICY_ASSIGNED = ['monotonic', 'keyEpoch', 'issuedAt', 'expiresAt', 'timestamp', 'signatures'];
const SIG_PROBE = { keyId: 'probe', alg: 'ed25519', sig: 'A'.repeat(86) };
const without = (o: object, keys: readonly string[]): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
const DOC_MAX = 512 * 1024;
const SXP_MAX = 16 * 1024 * 1024;
const ID = /^[a-z0-9]+(\.[a-z0-9_]+)+$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const SOURCE_FILES = { manifest: 'manifest.json', playbook: 'playbook.json', selectors: 'selectors.json', strings: 'strings.ko.json' } as const;

const err = (code: string, detail?: string): never => {
  throw new CeremonyError(code, detail);
};
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const iso = (ms: number) => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');
const pretty = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

export interface RegistryClient {
  readonly origin: string;
  get(p: string): Promise<Buffer | null>;
  put(p: string, body: unknown, token: string): Promise<{ status: number; body: Record<string, unknown> }>;
}

/** 레지스트리 origin: https(운영), 시험만 http://127.0.0.1·localhost. 경로·쿼리·사용자 정보 없음 */
export function checkOrigin(origin: string): string {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return err('publish.registry_invalid', origin);
  }
  const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
  if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) err('publish.registry_invalid', origin);
  return u.origin;
}

const PATH_OK = /^\/(registry|packages|policy|admin\/v1)\/[A-Za-z0-9_.@/?=&-]+$/;

export function httpRegistry(origin: string, fetchFn: typeof fetch = fetch, timeoutMs = 30_000): RegistryClient {
  const base = checkOrigin(origin);
  const url = (p: string) => {
    if (!PATH_OK.test(p) || p.includes('..')) err('publish.path_invalid', p);
    return base + p;
  };
  const read = async (r: Response, max: number): Promise<Buffer> => {
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > max) err('publish.response_too_large');
    return b;
  };
  return {
    origin: base,
    async get(p) {
      let r: Response;
      try {
        r = await fetchFn(url(p), { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json, application/octet-stream' } });
      } catch (e) {
        if (e instanceof CeremonyError) throw e;
        return err('publish.fetch_failed', p);
      }
      if (r.status === 200) return read(r, SXP_MAX + 1024);
      const body = await read(r, 64 * 1024).catch(() => Buffer.alloc(0));
      if (r.status === 404) return null;
      if (r.status === 400 && /"(NoSuchKey|not_found)"|"statusCode"\s*:\s*"404"/.test(body.toString('utf8'))) return null;
      return err('publish.fetch_failed', `${p} ${r.status}`);
    },
    async put(p, body, token) {
      const payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > PUT_BODY_MAX) err('publish.body_too_large', p);
      let r: Response;
      try {
        r = await fetchFn(url(p), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'content-type': 'application/json', authorization: `Admin ${token}` }, body: payload });
      } catch {
        return err('publish.put_failed', p);
      }
      const o = await read(r, 64 * 1024)
        .then((b) => JSON.parse(b.toString('utf8')) as Record<string, unknown>)
        .catch(() => ({}) as Record<string, unknown>);
      return { status: r.status, body: o && typeof o === 'object' ? o : {} };
    },
  };
}

const parseJson = <T>(b: Buffer | null, what: string): T | null => {
  if (!b) return null;
  try {
    return JSON.parse(b.toString('utf8')) as T;
  } catch {
    return err('publish.registry_doc_invalid', what);
  }
};

export interface PublishFs {
  read(p: string): Buffer;
  exists(p: string): boolean;
  write(p: string, d: string | Buffer): void;
  mkdir(p: string): void;
  list(dir: string): string[];
}

export interface PlanPackage {
  name: string;
  id: string;
  version: string;
  kind: 'playbook' | 'lookup';
  portal: string;
  manifestDigest: string;
  confirm: string;
  published: boolean;
}

export interface PlanDoc {
  kind: 'status' | 'revoked_keys' | 'policy';
  file: string;
  monotonic: number;
  confirm: string;
  signed: boolean;
}

export interface Plan {
  v: 1;
  tool: typeof PLAN_TOOL;
  registry: string;
  channel: Channel;
  createdAt: string;
  keyEpoch: number;
  trustSha256: string;
  rolloutPercent: number;
  minAppVersion?: string;
  baseIndex: { monotonic: number; contentDigest: string } | null;
  packages: PlanPackage[];
  docs: PlanDoc[];
}

export const W = {
  plan: 'plan.json',
  manifest: (name: string) => `manifests/${name}.json`,
  raw: (name: string, part: string) => `raw/${name}/${part}.json`,
  sig: (doc: string, keyId: string) => `sig/${doc}.${keyId}.json`,
  sxp: (name: string) => `packages/${name}.sxp`,
  index: 'index.json',
  assembled: 'assembled.json',
  doc: (kind: string) => `docs/${kind}.json`,
  record: 'record.json',
  pushStarted: 'push-started.json',
} as const;

export interface Work {
  dir: string;
  fs: PublishFs;
}
const wp = (w: Work, rel: string) => path.join(w.dir, rel);
const wread = (w: Work, rel: string) => w.fs.read(wp(w, rel));
const wjson = <T>(w: Work, rel: string): T => {
  try {
    return JSON.parse(wread(w, rel).toString('utf8')) as T;
  } catch {
    return err('publish.work_invalid', rel);
  }
};
const wwrite = (w: Work, rel: string, d: string | Buffer) => {
  w.fs.mkdir(path.dirname(wp(w, rel)));
  w.fs.write(wp(w, rel), d);
};

/** 사용자가 칠 서명 명령(ceremony sign). 확인 코드는 화면의 값을 눈으로 맞춰 다시 입력한다 */
export function signCommand(o: { kind: DocKind; keyId: string; confirm: string; trust: string; doc: string; out: string }): string {
  return `node --conditions=development services/registry/src/ceremony/cli.ts sign --kind ${o.kind} --key-id ${o.keyId} --confirm ${o.confirm} --trust ${shq(o.trust)} --out ${shq(o.out)} ${shq(o.doc)}`;
}

/**
 * 셸에 그대로 붙여 넣을 수 있게: 안전한 문자만이면 그대로, 아니면 인용한다.
 * 출력하는 명령의 경로 인용. POSIX 셸(macOS·Linux)은 작은따옴표, Windows(PowerShell·cmd)는 큰따옴표다.
 * Windows 경로의 `\\`·`C:`는 그 셸에서 특별하지 않아 그대로 둔다(작은따옴표는 cmd가 벗기지 않는다). Windows 경로에는 `"`가 올 수 없다.
 */
export const shq = (s: string, platform: NodeJS.Platform = process.platform): string => {
  if (platform === 'win32') {
    if (s.includes('"')) return err('publish.path_invalid', s);
    return /^[A-Za-z0-9_@%+=:,./~\\-]+$/.test(s) ? s : `"${s}"`;
  }
  return /^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
};

let catalog: Map<string, BundleOutcomes> | null = null;
/** 앱 내장 번들 결과(V-07). 앱에 들어간 번들 정의 그대로다 */
export function appBundles(): Map<string, BundleOutcomes> {
  catalog ??= new Map(BundleCatalog.load().list().map((b) => [b.wireId, { outcomes: b.def.outcomes.map((o) => o.name), reserved: b.def.reservedOutcomes }]));
  return catalog;
}

/**
 * 엔진 로더(loadPackage)를 실제 핀과 같은 keyEpoch의 신뢰 루트로 돌린다. 패키지는 의존 순서(조회 먼저)여야 한다.
 * 부르는 쪽이 서명한 RawPackage를 넘긴다(준비 단계는 임시 키, assemble은 실제 서명). 실패는 publish.engine_rejected:<id> <코드> <규칙들>.
 */
export function engineLoadAll(pkgs: ReadonlyArray<{ name: string; raw: RawPackage }>, trust: TrustRoot, revoked: ReadonlySet<string>, now: number): Map<string, LoadedPackage> {
  const roots = engineRoots(trust);
  const installed = new Map<string, LoadedPackage>();
  for (const p of pkgs) {
    const r = loadPackage(p.raw, {
      roots,
      revoked,
      bundleAllowlist: BUNDLE_ALLOWLIST,
      bundles: appBundles(),
      installedLookups: installed,
      storedVersion: null,
      installedDigest: null,
      hold: false,
      policyFresh: true,
      now,
    });
    if (!r.ok) err('publish.engine_rejected', `${p.name} ${r.code}${r.violations.length ? ` ${[...new Set(r.violations.map((v) => v.rule))].join(',')}` : ''}`);
    else installed.set(r.pkg.files.manifest.id, r.pkg);
  }
  return installed;
}

interface Source {
  dir: string;
  manifest: Manifest;
  raw: { playbook: Buffer; selectors: Buffer; strings: Buffer };
}

function readSource(fsys: PublishFs, dir: string): Source {
  const read = (f: string) => {
    try {
      return fsys.read(path.join(dir, f));
    } catch {
      return err('publish.source_missing', path.join(dir, f));
    }
  };
  let manifest: Manifest;
  try {
    manifest = JSON.parse(read(SOURCE_FILES.manifest).toString('utf8')) as Manifest;
  } catch (e) {
    if (e instanceof CeremonyError) throw e;
    return err('publish.source_invalid', `${dir} manifest`);
  }
  const raw = { playbook: read(SOURCE_FILES.playbook), selectors: read(SOURCE_FILES.selectors), strings: read(SOURCE_FILES.strings) };
  for (const [k, b] of Object.entries(raw)) {
    try {
      JSON.parse(b.toString('utf8'));
    } catch {
      err('publish.source_invalid', `${dir} ${k}`);
    }
  }
  if (!manifest || typeof manifest !== 'object' || typeof manifest.id !== 'string' || !ID.test(manifest.id) || typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) err('publish.source_invalid', `${dir} id·version`);
  if (manifest.kind !== 'playbook' && manifest.kind !== 'lookup') err('publish.source_invalid', `${dir} kind ${String(manifest.kind)}(playbook·lookup만)`);
  if (BLOCKED_PORTALS.includes(manifest.portal)) err('registry.portal_blocked', `${manifest.id} ${manifest.portal}`);
  return { dir, manifest, raw };
}

function order(srcs: Source[]): Source[] {
  const byId = new Map(srcs.map((s) => [s.manifest.id, s]));
  if (byId.size !== srcs.length) err('publish.source_duplicate');
  const out: Source[] = [];
  const seen = new Set<string>();
  const visit = (s: Source, stack: Set<string>) => {
    if (seen.has(s.manifest.id)) return;
    if (stack.has(s.manifest.id)) err('publish.source_cycle', s.manifest.id);
    stack.add(s.manifest.id);
    for (const l of s.manifest.lookupsUsed ?? []) {
      const d = byId.get(l.id);
      if (d) visit(d, stack);
    }
    stack.delete(s.manifest.id);
    seen.add(s.manifest.id);
    out.push(s);
  };
  for (const s of srcs) visit(s, new Set());
  return out;
}

export interface PrepareOpts {
  work: Work;
  src: PublishFs;
  sources: string[];
  registry: RegistryClient;
  trust: TrustRoot;
  trustPath: string;
  trustBytes: Buffer;
  channel: Channel;
  rolloutPercent: number;
  minAppVersion?: string;
  status?: { portalModeCeiling: Record<string, string>; killPlaybooks: string[] };
  revoked?: RevokedKeys;
  policy?: Record<string, unknown>;
  now: number;
  rehearsalSign: (manifest: Manifest) => Manifest;
  rehearsalTrust: TrustRoot;
  out: (line: string) => void;
}

const minAppOf = (v: string | undefined) => (v !== undefined ? { minAppVersion: v } : {});

/** 패키지 묶기 → 서명할 manifest·문서와 확인 코드, 사용자 서명 명령. 레지스트리는 읽기만 한다 */
export async function prepare(o: PrepareOpts): Promise<Plan> {
  if (o.work.fs.exists(wp(o.work, W.plan))) err('publish.work_exists', o.work.dir);
  if (!(CHANNELS as readonly string[]).includes(o.channel) || o.channel === 'hotfix') err('publish.channel_invalid', o.channel);
  if (!Number.isInteger(o.rolloutPercent) || o.rolloutPercent < 0 || o.rolloutPercent > 100) err('publish.rollout_invalid');
  if (o.minAppVersion !== undefined && !/^\d+\.\d+\.\d+$/.test(o.minAppVersion)) err('publish.min_app_version_invalid', o.minAppVersion);
  if (!o.sources.length && !o.status && !o.revoked && !o.policy) err('ceremony.usage', '패키지 폴더 또는 --status·--revoked·--policy');

  const indexBytes = await o.registry.get(`/registry/${o.channel}/index.json`);
  const index = parseJson<RegistryIndex>(indexBytes, 'index');
  const revokedStored = parseJson<RevokedKeys>(await o.registry.get('/registry/revoked_keys.json'), 'revoked_keys');
  const statusStored = parseJson<RegistryStatus>(await o.registry.get('/registry/status.json'), 'status');
  const policyStored = parseJson<SignedPolicy>(await o.registry.get('/policy/current.json'), 'policy');
  const revokedIds = new Set(revokedStored?.revoked.map((r) => r.keyId) ?? []);
  if (index && index.keyEpoch !== o.trust.keyEpoch) err('registry.key_epoch_mismatch', 'index');

  const srcs = order(o.sources.map((d) => readSource(o.src, d)));
  const publishedDigest = async (id: string, version: string): Promise<string | null> => {
    const b = await o.registry.get(`/packages/${id}@${version}.sxp`);
    if (!b) return null;
    const d = decodeSxp(b);
    if (!d.ok || d.sxp.kind !== 'package') return err('publish.registry_doc_invalid', `${id}@${version}`);
    return manifestDigest(JSON.parse(Buffer.from(d.sxp.raw.manifest).toString('utf8')) as Manifest);
  };

  const digests = new Map<string, string>();
  const built: Array<{ src: Source; manifest: Manifest; pkg: PlanPackage }> = [];
  for (const s of srcs) {
    const m = structuredClone(s.manifest);
    m.contentDigests = { playbook: sha(s.raw.playbook), selectors: sha(s.raw.selectors), strings: sha(s.raw.strings) };
    const lookups = [];
    for (const l of m.lookupsUsed ?? []) {
      const own = srcs.find((x) => x.manifest.id === l.id);
      if (own && own.manifest.version !== l.version) err('publish.lookup_version', `${m.id} → ${l.id}@${l.version}(계획은 ${own.manifest.version})`);
      const digest = own ? digests.get(l.id) : await publishedDigest(l.id, l.version);
      if (!digest) err('publish.lookup_missing', `${m.id} → ${l.id}@${l.version}: 같은 계획에도 레지스트리에도 없다`);
      lookups.push({ ...l, digest: digest! });
    }
    m.lookupsUsed = lookups;
    m.signatures = [];
    const name = `${m.id}@${m.version}`;
    const md = manifestDigest(m);
    digests.set(m.id, md);
    const existing = await publishedDigest(m.id, m.version);
    if (existing !== null && existing !== md) err('publish.version_exists', `${name}: 같은 이름에 다른 내용이 이미 게시됐다(버전을 올린다)`);
    const p = prepareDoc('manifest', m);
    built.push({ src: s, manifest: m, pkg: { name, id: m.id, version: m.version, kind: m.kind as 'playbook' | 'lookup', portal: m.portal, manifestDigest: md, confirm: confirmCode(p.sha256), published: existing === md } });
  }

  const rehearsal = built.map((b) => {
    const signed = o.rehearsalSign(b.manifest);
    const raw: RawPackage = { manifest: Buffer.from(JSON.stringify(signed)), playbook: b.src.raw.playbook, selectors: b.src.raw.selectors, strings: b.src.raw.strings };
    const sxp = encodeSxp({ kind: 'package', raw });
    if (sxp.length > SXP_MAX) err('sxp.too_large', b.pkg.name);
    if (Buffer.byteLength(JSON.stringify({ data: sxp.toString('base64') })) > PUT_BODY_MAX) err('publish.body_too_large', b.pkg.name);
    verifySxp(sxp, { id: b.pkg.id, version: b.pkg.version }, o.rehearsalTrust, new Set(), o.now);
    return { name: b.pkg.name, raw };
  });
  engineLoadAll(rehearsal, o.rehearsalTrust, new Set(), o.now);

  const docs: PlanDoc[] = [];
  const work = o.work;
  for (const b of built) {
    if (b.pkg.published) continue;
    wwrite(work, W.manifest(b.pkg.name), pretty(b.manifest));
    for (const k of ['playbook', 'selectors', 'strings'] as const) wwrite(work, W.raw(b.pkg.name, k), b.src.raw[k]);
  }
  if (o.revoked) {
    const r = structuredClone(o.revoked) as Partial<RevokedKeys>;
    delete r.timestamp;
    delete r.issuedAt;
    delete r.expiresAt;
    if (r.keyEpoch !== o.trust.keyEpoch) err('registry.key_epoch_mismatch', 'revoked_keys');
    if (!Number.isSafeInteger(r.monotonic) || (revokedStored && r.monotonic! <= revokedStored.monotonic)) err('registry.version_rollback', 'revoked_keys');
    const content = prepareDoc('revoked_keys', r);
    const signed = countSignatures(content.bytes, r.signatures, 'root', o.trust, revokedIds).valid.length >= 2;
    if (!signed) r.signatures = [];
    wwrite(work, W.doc('revoked_keys'), pretty(r));
    docs.push({ kind: 'revoked_keys', file: W.doc('revoked_keys'), monotonic: r.monotonic!, confirm: confirmCode(content.sha256), signed });
  }
  let policyNote = '';
  if (o.policy) {
    const draft = structuredClone(o.policy);
    for (const k of POLICY_ASSIGNED) delete draft[k];
    if (typeof draft.version !== 'string') err('publish.policy_invalid', 'version');
    const same = !!policyStored && policyStored.keyEpoch === o.trust.keyEpoch && canonicalJson(without(policyStored, POLICY_ASSIGNED)) === canonicalJson(draft);
    if (same) policyNote = `  정책 ${policyStored.version} monotonic ${policyStored.monotonic}: 레지스트리에 같은 내용이 있다(서명·게시 없음, 신선도는 cron이 다시 서명한다)`;
    else {
      if (policyStored && policyStored.version === draft.version) err('publish.policy_version_exists', `${String(draft.version)}: 내용을 바꾸면 version을 올린다`);
      const doc = { ...draft, monotonic: (policyStored?.monotonic ?? 0) + 1, keyEpoch: o.trust.keyEpoch, signatures: [] };
      const probe = { ...doc, issuedAt: iso(o.now), expiresAt: iso(o.now + 48 * 3_600_000), timestamp: SIG_PROBE, signatures: [SIG_PROBE, SIG_PROBE] };
      const v = schemaViolations('policy', probe);
      if (v.length) err('publish.policy_invalid', v.map((x) => x.message).join('; ').slice(0, 300));
      const p = prepareDoc('policy', doc);
      wwrite(work, W.doc('policy'), pretty(doc));
      docs.push({ kind: 'policy', file: W.doc('policy'), monotonic: doc.monotonic, confirm: confirmCode(p.sha256), signed: false });
    }
  }
  if (o.status) {
    const s = { monotonic: (statusStored?.monotonic ?? 0) + 1, keyEpoch: o.trust.keyEpoch, portalModeCeiling: o.status.portalModeCeiling, killPlaybooks: o.status.killPlaybooks, signatures: [] };
    const p = prepareDoc('status', s);
    wwrite(work, W.doc('status'), pretty(s));
    docs.push({ kind: 'status', file: W.doc('status'), monotonic: s.monotonic, confirm: confirmCode(p.sha256), signed: false });
  }

  const plan: Plan = {
    v: 1,
    tool: PLAN_TOOL,
    registry: o.registry.origin,
    channel: o.channel,
    createdAt: iso(o.now),
    keyEpoch: o.trust.keyEpoch,
    trustSha256: sha(o.trustBytes),
    rolloutPercent: o.rolloutPercent,
    ...(o.minAppVersion !== undefined ? { minAppVersion: o.minAppVersion } : {}),
    baseIndex: index ? { monotonic: index.monotonic, contentDigest: contentDigest(index) } : null,
    packages: built.map((b) => b.pkg),
    docs,
  };
  wwrite(work, W.plan, pretty(plan));
  work.fs.mkdir(wp(work, 'sig'));

  o.out(`계획 ${work.dir}: 레지스트리 ${plan.registry}, 채널 ${plan.channel}, keyEpoch ${plan.keyEpoch}, 지금 인덱스 monotonic ${index?.monotonic ?? '없음'}`);
  for (const b of built) o.out(`  ${b.pkg.name}(${b.pkg.kind}, ${b.pkg.portal}) manifest ${b.pkg.manifestDigest}${b.pkg.published ? ' — 이미 게시됨(서명 없음)' : ` 확인 코드 ${b.pkg.confirm}`}`);
  o.out('엔진 로더 연습(임시 키): 통과. 서명 키만 실제 키로 바뀐다');
  if (policyNote) o.out(policyNote);
  const cmds: string[] = [];
  for (const b of built) {
    if (b.pkg.published) continue;
    for (const keyId of ['package-1', 'package-2']) cmds.push(signCommand({ kind: 'manifest', keyId, confirm: b.pkg.confirm, trust: o.trustPath, doc: wp(work, W.manifest(b.pkg.name)), out: wp(work, W.sig(b.pkg.name, keyId)) }));
  }
  for (const d of docs) {
    if (d.signed) {
      o.out(`  ${d.kind} monotonic ${d.monotonic}: 루트 2개 서명이 이미 있다. 서버가 올릴 때 타임스탬프를 붙인다`);
      continue;
    }
    const keys = d.kind === 'revoked_keys' ? ['root-1', 'root-2'] : ['policy-1', 'policy-2'];
    o.out(`  ${d.kind} monotonic ${d.monotonic} 확인 코드 ${d.confirm}`);
    for (const keyId of keys) cmds.push(signCommand({ kind: d.kind, keyId, confirm: d.confirm, trust: o.trustPath, doc: wp(work, d.file), out: wp(work, W.sig(d.kind, keyId)) }));
  }
  if (cmds.length) {
    o.out(`다음: 서명 ${cmds.length}번(Touch ID). 화면의 확인 코드가 위와 같은지 보고 누른다`);
    for (const c of cmds) o.out(`  ${c}`);
  }
  o.out(`그다음: assemble --work ${work.dir}`);
  return plan;
}

function sigRecords(w: Work, doc: string): SignatureRecord[] {
  const dir = wp(w, 'sig');
  const files = w.fs.exists(dir) ? w.fs.list(dir).filter((f) => f.startsWith(`${doc}.`) && f.endsWith('.json') && /^[a-z]+-[0-9]+$/.test(f.slice(doc.length + 1, -5))) : [];
  return files.sort().map((f) => wjson<SignatureRecord>(w, `sig/${f}`));
}

function loadPlan(w: Work, trust: TrustRoot, trustBytes: Buffer): Plan {
  const plan = wjson<Plan>(w, W.plan);
  if (plan.v !== 1 || plan.tool !== PLAN_TOOL) err('publish.work_invalid', W.plan);
  if (plan.trustSha256 !== sha(trustBytes) || plan.keyEpoch !== trust.keyEpoch) err('publish.trust_changed');
  return plan;
}

async function checkBase(plan: Plan, registry: RegistryClient): Promise<RegistryIndex | null> {
  if (checkOrigin(plan.registry) !== registry.origin) err('publish.registry_changed', registry.origin);
  const cur = parseJson<RegistryIndex>(await registry.get(`/registry/${plan.channel}/index.json`), 'index');
  const now = cur ? { monotonic: cur.monotonic, contentDigest: contentDigest(cur) } : null;
  if (JSON.stringify(now) !== JSON.stringify(plan.baseIndex)) err('publish.index_changed', '준비한 뒤 레지스트리 인덱스가 바뀌었다(prepare부터 다시)');
  return cur;
}

export interface AssembleOpts {
  work: Work;
  registry: RegistryClient;
  trust: TrustRoot;
  trustPath: string;
  trustBytes: Buffer;
  now: number;
  carry?: boolean;
  out: (line: string) => void;
}

export async function assemble(o: AssembleOpts): Promise<RegistryIndex> {
  const w = o.work;
  const plan = loadPlan(w, o.trust, o.trustBytes);
  if (w.fs.exists(wp(w, W.index))) err('publish.work_exists', W.index);
  const current = await checkBase(plan, o.registry);
  const revokedStored = parseJson<RevokedKeys>(await o.registry.get('/registry/revoked_keys.json'), 'revoked_keys');
  const pending = plan.docs.find((d) => d.kind === 'revoked_keys');
  const revoked = new Set([...(revokedStored?.revoked.map((r) => r.keyId) ?? []), ...(pending ? wjson<RevokedKeys>(w, pending.file).revoked.map((r) => r.keyId) : [])]);

  const raws: Array<{ name: string; raw: RawPackage }> = [];
  const entries: IndexEntry[] = [];
  const toWrite: Array<{ name: string; sxp: Buffer }> = [];
  for (const p of plan.packages) {
    let sxp: Buffer;
    if (p.published) {
      sxp = (await o.registry.get(`/packages/${p.name}.sxp`)) ?? err('publish.registry_changed', `${p.name} 없음`);
    } else {
      const m = wjson<Record<string, unknown>>(w, W.manifest(p.name));
      if (manifestDigest(m as unknown as Manifest) !== p.manifestDigest) err('ceremony.wrong_document', `${p.name}: 준비한 manifest가 바뀌었다`);
      const signed = collectSignatures('manifest', m, sigRecords(w, p.name), o.trust as unknown as TrustPin, revoked).doc;
      const raw: RawPackage = { manifest: Buffer.from(JSON.stringify(signed)), playbook: wread(w, W.raw(p.name, 'playbook')), selectors: wread(w, W.raw(p.name, 'selectors')), strings: wread(w, W.raw(p.name, 'strings')) };
      sxp = encodeSxp({ kind: 'package', raw });
      toWrite.push({ name: p.name, sxp });
    }
    const info = verifySxp(sxp, { id: p.id, version: p.version }, o.trust, revoked, o.now);
    const d = decodeSxp(sxp);
    if (!d.ok || d.sxp.kind !== 'package') return err('sxp.malformed', p.name);
    raws.push({ name: p.name, raw: d.sxp.raw });
    entries.push({ id: p.id, version: p.version, kind: info.kind, portal: info.portal, sxpDigest: sha(sxp), size: sxp.length, rolloutPercent: plan.rolloutPercent, ...minAppOf(p.published ? current?.entries.find((e) => e.id === p.id && e.version === p.version)?.minAppVersion : plan.minAppVersion) });
  }
  engineLoadAll(raws, o.trust, revoked, o.now);

  const newIds = new Set(entries.map((e) => e.id));
  const carried = o.carry === false ? [] : (current?.entries ?? []).filter((e) => !newIds.has(e.id));
  for (const e of carried) {
    const b = (await o.registry.get(`/packages/${e.id}@${e.version}.sxp`)) ?? err('publish.registry_changed', `${e.id}@${e.version} 없음`);
    verifyPackageBytes(b, e);
    verifySxp(b, e, o.trust, revoked, o.now);
  }
  const index = {
    channel: plan.channel,
    monotonic: (current?.monotonic ?? 0) + 1,
    keyEpoch: o.trust.keyEpoch,
    entries: [...carried, ...entries].sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`)),
    signatures: [],
  } as unknown as RegistryIndex;
  if (Buffer.byteLength(JSON.stringify(index)) > DOC_MAX) err('publish.body_too_large', 'index');
  for (const t of toWrite) {
    if (w.fs.exists(wp(w, W.sxp(t.name)))) {
      if (!wread(w, W.sxp(t.name)).equals(t.sxp)) err('publish.work_invalid', W.sxp(t.name));
    } else wwrite(w, W.sxp(t.name), t.sxp);
  }
  wwrite(w, W.index, pretty(index));
  const p = prepareDoc('index', index);
  wwrite(w, W.assembled, pretty({ indexConfirm: confirmCode(p.sha256), packages: entries.map((e) => ({ name: `${e.id}@${e.version}`, sxpDigest: e.sxpDigest, size: e.size })) }));

  o.out(`묶음: 패키지 ${entries.length}개(엔진 로더·관문 규칙 통과, 실제 서명)`);
  for (const e of entries) o.out(`  ${e.id}@${e.version} ${e.kind} ${e.size}B sxp ${e.sxpDigest}`);
  if (carried.length) o.out(`  이어 둔 항목 ${carried.length}개: ${carried.map((e) => `${e.id}@${e.version}`).join(', ')}`);
  o.out(`인덱스 ${plan.channel} monotonic ${index.monotonic}, 항목 ${index.entries.length}개(기간은 서버가 붙이고 다시 서명한다)`);
  o.out(`인덱스 확인 코드 ${confirmCode(p.sha256)}`);
  o.out('다음: 서명 2번(Touch ID)');
  for (const keyId of ['package-1', 'package-2']) o.out(`  ${signCommand({ kind: 'index', keyId, confirm: confirmCode(p.sha256), trust: o.trustPath, doc: wp(w, W.index), out: wp(w, W.sig('index', keyId)) })}`);
  o.out(`그다음: push --work ${w.dir}`);
  return index;
}

export interface PushOpts {
  work: Work;
  registry: RegistryClient;
  trust: TrustRoot;
  trustBytes: Buffer;
  token: string;
  now: number;
  out: (line: string) => void;
  sleep?: (ms: number) => Promise<void>;
  settleMs?: number;
}

export type VerifyOpts = Omit<PushOpts, 'token'>;

export interface PublishRecord {
  v: 1;
  tool: typeof PLAN_TOOL;
  registry: string;
  channel: Channel;
  publishedAt: string;
  published: Array<{ kind: string; path: string; sha256: string; logIndex: number }>;
  index: { monotonic: number; expiresAt: string };
  logHead: { before: number | null; after: number; rootHash: string };
}

const SETTLE_MS = 90_000;
const POLL_MS = 5_000;

const putOk = async (registry: RegistryClient, p: string, body: unknown, token: string, want: number): Promise<Record<string, unknown>> => {
  const r = await registry.put(p, body, token);
  if (r.status !== want) err(typeof r.body.error === 'string' ? r.body.error : 'publish.put_failed', `${p} ${r.status}`);
  return r.body;
};

function checkHead(h: SignedTreeHead | null, trust: TrustRoot): SignedTreeHead {
  const pub = h ? trust.keys.timestamp?.[h.signature?.keyId] : undefined;
  if (!h || !pub || !verifyTreeHead(pub, h)) return err('publish.log_invalid', 'head');
  return h;
}

const logHead = async (registry: RegistryClient, trust: TrustRoot): Promise<SignedTreeHead> => checkHead(parseJson<SignedTreeHead>(await registry.get('/registry/log/head.json'), 'log head'), trust);

interface Outgoing {
  plan: Plan;
  revoked: Set<string>;
  revokedOut: RevokedKeys | null;
  policyOut: SignedPolicy | null;
  statusOut: RegistryStatus | null;
  index: RegistryIndex | null;
  sxps: Map<string, Buffer>;
  published: Array<{ kind: string; path: string; bytes?: Buffer; digest?: string }>;
}

async function outgoing(o: VerifyOpts, stored: { revoked: RevokedKeys | null; current: RegistryIndex | null }): Promise<Outgoing> {
  const w = o.work;
  const plan = loadPlan(w, o.trust, o.trustBytes);
  const docOf = (d: PlanDoc): Record<string, unknown> => {
    const doc = wjson<Record<string, unknown>>(w, d.file);
    if (d.signed) return doc;
    return collectSignatures(d.kind, doc, sigRecords(w, d.kind), o.trust as unknown as TrustPin, new Set(stored.revoked?.revoked.map((r) => r.keyId) ?? [])).doc;
  };
  const docFor = (kind: string) => plan.docs.find((d) => d.kind === kind);
  const revokedDoc = docFor('revoked_keys');
  const policyDoc = docFor('policy');
  const statusDoc = docFor('status');
  const revokedOut = revokedDoc ? (docOf(revokedDoc) as unknown as RevokedKeys) : null;
  const policyOut = policyDoc ? (docOf(policyDoc) as unknown as SignedPolicy) : null;
  const statusOut = statusDoc ? (docOf(statusDoc) as unknown as RegistryStatus) : null;
  const revoked = new Set([...(stored.revoked?.revoked.map((r) => r.keyId) ?? []), ...(revokedOut?.revoked.map((r) => r.keyId) ?? [])]);

  let index: RegistryIndex | null = null;
  const sxps = new Map<string, Buffer>();
  if (plan.packages.length > 0) {
    const draft = wjson<Record<string, unknown>>(w, W.index);
    index = collectSignatures('index', draft, sigRecords(w, 'index'), o.trust as unknown as TrustPin, revoked).doc as unknown as RegistryIndex;
    verifyIndex(index, plan.channel, o.trust, revoked, stored.current, o.now, undefined, { content: true });
    for (const p of plan.packages.filter((x) => !x.published)) {
      const b = wread(w, W.sxp(p.name));
      const e = index.entries.find((x) => x.id === p.id && x.version === p.version) ?? err('publish.work_invalid', `${p.name} 인덱스 항목 없음`);
      verifyPackageBytes(b, e);
      verifySxp(b, e, o.trust, revoked, o.now);
      sxps.set(p.name, b);
    }
  }
  const published: Outgoing['published'] = [];
  if (revokedOut) published.push({ kind: 'revoked_keys', path: 'registry/revoked_keys.json', digest: contentDigest(revokedOut) });
  if (policyOut) for (const path of [`policy/${policyOut.version}.json`, 'policy/current.json']) published.push({ kind: 'policy', path, digest: contentDigest(policyOut) });
  if (statusOut) published.push({ kind: 'status', path: 'registry/status.json', digest: contentDigest(statusOut) });
  for (const [name, b] of sxps) published.push({ kind: 'package', path: `packages/${name}.sxp`, bytes: b });
  if (index) published.push({ kind: 'index', path: `registry/${plan.channel}/index.json`, digest: contentDigest(index) });
  return { plan, revoked, revokedOut, policyOut, statusOut, index, sxps, published };
}

export async function push(o: PushOpts): Promise<PublishRecord> {
  const w = o.work;
  const plan = loadPlan(w, o.trust, o.trustBytes);
  if (w.fs.exists(wp(w, W.record))) err('publish.work_exists', W.record);
  if (!o.token || o.token.length < 16) err('publish.token_missing');
  const current = await checkBase(plan, o.registry);
  const fresh = await logHead(o.registry, o.trust);
  const revokedStored = parseJson<RevokedKeys>(await o.registry.get('/registry/revoked_keys.json'), 'revoked_keys');
  const statusStored = parseJson<RegistryStatus>(await o.registry.get('/registry/status.json'), 'status');
  const policyStored = parseJson<SignedPolicy>(await o.registry.get('/policy/current.json'), 'policy');
  const out = await outgoing(o, { revoked: revokedStored, current });
  const before = w.fs.exists(wp(w, W.pushStarted)) ? checkHead(wjson<SignedTreeHead>(w, W.pushStarted), o.trust) : fresh;
  if (!w.fs.exists(wp(w, W.pushStarted))) wwrite(w, W.pushStarted, pretty(before));

  if (out.revokedOut) {
    await putOk(o.registry, '/admin/v1/revoked-keys', out.revokedOut, o.token, 200);
    o.out(`게시 revoked_keys monotonic ${out.revokedOut.monotonic}`);
  }
  if (out.policyOut) {
    await putOk(o.registry, '/admin/v1/policy', out.policyOut, o.token, 200);
    o.out(`게시 정책 ${out.policyOut.version} monotonic ${out.policyOut.monotonic}`);
  }
  if (out.statusOut) {
    await putOk(o.registry, '/admin/v1/status', out.statusOut, o.token, 200);
    o.out(`게시 status monotonic ${out.statusOut.monotonic}`);
  }
  for (const [name, b] of out.sxps) {
    const r = await putOk(o.registry, `/admin/v1/packages/${name}.sxp`, { data: b.toString('base64') }, o.token, 201);
    if (r.sxpDigest !== sha(b) || r.size !== b.length) err('publish.registry_mismatch', name);
    o.out(`게시 ${name}.sxp ${b.length}B`);
  }
  if (out.index) {
    await putOk(o.registry, `/admin/v1/index/${plan.channel}`, out.index, o.token, 200);
    o.out(`게시 인덱스 ${plan.channel} monotonic ${out.index.monotonic}`);
  }
  return confirm(o, out, { before, current, revokedStored, statusStored, policyStored });
}

/**
 * 사후 확인만(PUT 없음): push가 올린 뒤 되읽기·로그 확인에서 멈췄을 때(예 CDN 캐시로 publish.log_invalid) 같은 폴더로 record.json을 쓴다.
 * 올린 것이 사용자가 서명한 내용 그대로인지(내용 다이제스트·서명·바이트)를 보므로 단조 기준(저장본)은 쓰지 않는다
 */
export async function verifyPublished(o: VerifyOpts): Promise<PublishRecord> {
  const w = o.work;
  const plan = loadPlan(w, o.trust, o.trustBytes);
  if (w.fs.exists(wp(w, W.record))) err('publish.work_exists', W.record);
  if (checkOrigin(plan.registry) !== o.registry.origin) err('publish.registry_changed', o.registry.origin);
  const revokedStored = parseJson<RevokedKeys>(await o.registry.get('/registry/revoked_keys.json'), 'revoked_keys');
  const out = await outgoing(o, { revoked: revokedStored, current: null });
  const before = w.fs.exists(wp(w, W.pushStarted)) ? checkHead(wjson<SignedTreeHead>(w, W.pushStarted), o.trust) : null;
  if (!before) o.out(`  ${W.pushStarted} 없음: 이전 헤드와의 일관성 증명은 건너뛴다(항목·포함 증명은 본다)`);
  return confirm(o, out, { before, current: null, revokedStored: null, statusStored: null, policyStored: null });
}

async function confirm(
  o: VerifyOpts,
  out: Outgoing,
  base: { before: SignedTreeHead | null; current: RegistryIndex | null; revokedStored: RevokedKeys | null; statusStored: RegistryStatus | null; policyStored: SignedPolicy | null },
): Promise<PublishRecord> {
  const w = o.work;
  const { plan, revoked } = out;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let waits = Math.max(0, Math.ceil((o.settleMs ?? SETTLE_MS) / POLL_MS));
  const until = async <T>(attempt: () => Promise<T | null>, fail: () => never): Promise<T> => {
    for (;;) {
      const r = await attempt();
      if (r !== null) return r;
      if (waits-- <= 0) return fail();
      await sleep(POLL_MS);
    }
  };

  const got = new Map<string, Buffer>();
  for (const p of out.published) {
    const b = await until(
      async () => {
        const b = await o.registry.get(`/${p.path}`);
        if (!b) return null;
        if (p.bytes) return b.equals(p.bytes) ? b : null;
        const doc = parseJson<Record<string, unknown>>(b, p.path);
        return doc && contentDigest(doc) === p.digest ? b : null;
      },
      () => err('publish.readback_failed', p.path),
    );
    got.set(p.path, b);
  }
  let indexOut: RegistryIndex | null = null;
  if (out.index) {
    indexOut = parseJson<RegistryIndex>(got.get(`registry/${plan.channel}/index.json`)!, 'index')!;
    if (canonicalJson(indexOut.signatures) !== canonicalJson(out.index.signatures)) err('publish.readback_failed', 'index');
    verifyIndex(indexOut, plan.channel, o.trust, revoked, base.current, o.now);
  }
  if (out.revokedOut) verifyRevoked(parseJson<RevokedKeys>(got.get('registry/revoked_keys.json')!, 'revoked_keys')!, o.trust, base.revokedStored, o.now);
  if (out.policyOut) {
    const cur = got.get('policy/current.json')!;
    if (!cur.equals(got.get(`policy/${out.policyOut.version}.json`)!)) err('publish.readback_failed', 'policy {ver} ≠ current');
    verifyPolicy(parseJson<SignedPolicy>(cur, 'policy')!, o.trust, revoked, base.policyStored, o.now);
  }
  if (out.statusOut) verifyStatus(parseJson<RegistryStatus>(got.get('registry/status.json')!, 'status')!, o.trust, revoked, base.statusStored, o.now);

  const entries = new Map<number, LogEntryRecord | null>();
  const entryAt = async (i: number) => {
    if (!entries.has(i)) entries.set(i, parseJson<LogEntryRecord>(await o.registry.get(`/registry/log/entries/${i}.json`), 'log entry'));
    return entries.get(i)!;
  };
  const find = async (size: number, path: string, sha256: string) => {
    for (let i = size - 1; i >= 0; i--) {
      const e = await entryAt(i);
      if (e && e.entry.path === path && e.entry.sha256 === sha256) return e;
    }
    return null;
  };
  let missing = '';
  const settled = await until(
    async () => {
      const h = await logHead(o.registry, o.trust);
      const b = base.before;
      if (b && (h.treeSize < b.treeSize || (h.treeSize === b.treeSize && h.rootHash !== b.rootHash))) {
        missing = 'treeSize';
        return null;
      }
      const hits: LogEntryRecord[] = [];
      for (const p of out.published) {
        const e = await find(h.treeSize, p.path, sha(got.get(p.path)!));
        if (!e) {
          missing = `${p.path} 항목 없음`;
          return null;
        }
        hits.push(e);
      }
      return { after: h, hits };
    },
    () => err('publish.log_invalid', missing),
  );
  const { after, hits } = settled;
  const before = base.before;
  if (before && before.treeSize > 0) {
    const c = parseJson<{ proof: string[] }>(await o.registry.get(`/registry/log/proof/consistency?from=${before.treeSize}&to=${after.treeSize}`), 'consistency');
    if (!c || !verifyConsistency(before, after, c.proof.map((h) => Buffer.from(h, 'hex')))) err('publish.log_invalid', 'consistency');
  }
  const logged: PublishRecord['published'] = [];
  for (const [i, p] of out.published.entries()) {
    const hit = hits[i]!;
    const leaf = leafHashOf(Buffer.from(canonicalJson(hit.entry), 'utf8')).toString('hex');
    if (leaf !== hit.leafHash) err('publish.log_invalid', `${p.path} 잎 해시`);
    const proof = parseJson<{ leafIndex: number; path: string[] }>(await o.registry.get(`/registry/log/proof/inclusion?leaf=${leaf}&size=${after.treeSize}`), 'inclusion');
    if (!proof || !verifyInclusion(Buffer.from(leaf, 'hex'), proof.leafIndex, after.treeSize, proof.path.map((h) => Buffer.from(h, 'hex')), Buffer.from(after.rootHash, 'hex'))) err('publish.log_invalid', `${p.path} 포함 증명`);
    logged.push({ kind: p.kind, path: p.path, sha256: hit.entry.sha256, logIndex: hit.index });
  }

  const current = base.current;
  const record: PublishRecord = {
    v: 1,
    tool: PLAN_TOOL,
    registry: plan.registry,
    channel: plan.channel,
    publishedAt: iso(o.now),
    published: logged,
    index: indexOut ? { monotonic: indexOut.monotonic, expiresAt: indexOut.expiresAt } : { monotonic: current?.monotonic ?? 0, expiresAt: current?.expiresAt ?? '' },
    logHead: { before: before?.treeSize ?? null, after: after.treeSize, rootHash: after.rootHash },
  };
  wwrite(w, W.record, pretty(record));
  o.out(`되읽기·로그 확인: ${logged.length}건, 로그 크기 ${before?.treeSize ?? '?'} → ${after.treeSize}, 루트 ${after.rootHash}`);
  o.out(`기록 ${wp(w, W.record)}`);
  return record;
}
