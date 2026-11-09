// 패키지 게시 도구(PUBLISH-H01.md "H-01 게시 — 사용자 단계", 팀장 지시 2026-11-09, D09 §8, ADR-013·023·028).
// 흐름: 패키지 묶기(prepare) → package 키 서명(사용자, ceremony sign, Touch ID) → .sxp·인덱스 묶기(assemble)
//       → 인덱스(·status) 서명(사용자) → 게시 관문 PUT(push) → 되읽기·투명성 로그 포함 증명 → 기록(record.json).
// 서명 단계 앞뒤(prepare·assemble·push)는 사람 없이 돈다. 이 모듈은 개인 키를 갖지 않는다: 서명은 ceremony sign이 도우미(Secure Enclave)로 하고,
// 여기서는 서명 기록을 모아(collectSignatures) 같은 규칙으로 센다. 시험·리허설(rehearsal.ts)만 메모리 안 임시 키로 서명한다.
// 형식은 지금 main 그대로다: .sxp v1(SIGNING.md §6, encodeSxp), 인덱스(API.md "인덱스"), 엔진 로더 loadPackage가 받는 모양.
// 게시 전에 관문 규칙(verifySxp·verifyIndex)과 엔진 로더(loadPackage, 앱 내장 번들 허용 목록·조회 설치본)를 함께 돌린다:
// 엔진이 받지 않을 패키지는 올리지 않는다.
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  canonicalJson,
  decodeSxp,
  encodeSxp,
  loadPackage,
  manifestDigest,
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
  verifyRevoked,
  verifySxp,
  verifyStatus,
  type Channel,
  type IndexEntry,
  type RegistryIndex,
  type RegistryStatus,
  type RevokedKeys,
  type TrustRoot,
} from '../verify.ts';
import { collectSignatures, type SignatureRecord, type TrustPin } from '../ceremony/collect.ts';
import { CeremonyError, confirmCode, prepare as prepareDoc, type DocKind } from '../ceremony/content.ts';

export const PLAN_TOOL = 'sax-publish/1';
/** 게시 관문 함수 본문 상한(Vercel 함수 4.5MB, JSON base64 포함)보다 낮게 */
export const PUT_BODY_MAX = 4_000_000;
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

// ───────────────────────── 레지스트리 접근 ─────────────────────────

export interface RegistryClient {
  readonly origin: string;
  /** 공개 GET. 없으면 null(404, 또는 Storage 공개 URL의 NoSuchKey). 그 밖의 오류는 publish.fetch_failed */
  get(p: string): Promise<Buffer | null>;
  /** 게시 PUT(`Authorization: Admin <token>`). 응답 본문은 오류 코드만 꺼낸다(입력을 되풀이하지 않는다) */
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
      // Supabase Storage 공개 URL은 없는 객체를 400 {"statusCode":"404","code":"NoSuchKey"}로 답한다(운영 확인 2026-11-09)
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

// ───────────────────────── 작업 폴더 ─────────────────────────

export interface PublishFs {
  read(p: string): Buffer;
  exists(p: string): boolean;
  /** 새 파일만 쓴다(덮지 않는다). 작업 폴더의 단계 산출물은 한 번 쓰면 바뀌지 않는다 */
  write(p: string, d: string | Buffer): void;
  mkdir(p: string): void;
  list(dir: string): string[];
}

export interface PlanPackage {
  /** `<id>@<version>` */
  name: string;
  id: string;
  version: string;
  kind: 'playbook' | 'lookup';
  portal: string;
  /** SHA-256(서명 입력 = JCS(manifest − signatures)) = manifest 다이제스트 */
  manifestDigest: string;
  confirm: string;
  /** 레지스트리에 같은 manifest 다이제스트의 같은 이름이 이미 있다(서명·업로드 없이 인덱스에만 넣는다) */
  published: boolean;
}

export interface PlanDoc {
  kind: 'status' | 'revoked_keys';
  file: string;
  monotonic: number;
  confirm: string;
  /** 이미 정족수 서명이 들어 있다(폐기 목록: 서명 의식에서 루트 2개로 서명한 문서) */
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
  /** 준비할 때 본 레지스트리 인덱스(assemble·push가 그사이 바뀌지 않았는지 본다). 바이트가 아니라 내용으로 본다: cron 신선도 재서명은 바이트만 바꾼다(ADR-043) */
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

/** 셸에 그대로 붙여 넣을 수 있게: 안전한 문자만이면 그대로, 아니면 작은따옴표 */
export const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./~-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

// ───────────────────────── 엔진 로더 연습(임시 키) ─────────────────────────

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

// ───────────────────────── 1. prepare: 패키지 묶기 ─────────────────────────

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
  // 원시 바이트 그대로 서명·묶는다(저장소에서 검토한 바이트 = 서명한 바이트). JSON이어야 엔진이 읽는다.
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

/** 의존 순서: lookupsUsed가 가리키는 같은 계획의 패키지를 먼저 */
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
  /** 소스 파일 시스템(패키지 폴더 읽기) */
  src: PublishFs;
  sources: string[];
  registry: RegistryClient;
  trust: TrustRoot;
  /** 화면에 보일 핀 파일 경로(서명 명령에 넣는다) */
  trustPath: string;
  trustBytes: Buffer;
  channel: Channel;
  rolloutPercent: number;
  /** status 초안 {portalModeCeiling, killPlaybooks}(정책 키 2-of-3으로 서명한다) */
  status?: { portalModeCeiling: Record<string, string>; killPlaybooks: string[] };
  /** 서명 의식에서 루트 2개로 서명한 폐기 목록(신선도 필드는 버리고 서버가 도장을 찍는다) */
  revoked?: RevokedKeys;
  now: number;
  /** 엔진 로더 연습용 임시 서명(rehearsal.ts ephemeralPackageSigner) */
  rehearsalSign: (manifest: Manifest) => Manifest;
  rehearsalTrust: TrustRoot;
  out: (line: string) => void;
}

/** 패키지 묶기 → 서명할 manifest·문서와 확인 코드, 사용자 서명 명령. 레지스트리는 읽기만 한다 */
export async function prepare(o: PrepareOpts): Promise<Plan> {
  if (o.work.fs.exists(wp(o.work, W.plan))) err('publish.work_exists', o.work.dir);
  if (!(CHANNELS as readonly string[]).includes(o.channel) || o.channel === 'hotfix') err('publish.channel_invalid', o.channel);
  if (!Number.isInteger(o.rolloutPercent) || o.rolloutPercent < 0 || o.rolloutPercent > 100) err('publish.rollout_invalid');
  if (!o.sources.length && !o.status && !o.revoked) err('ceremony.usage', '패키지 폴더 또는 --status·--revoked');

  const indexBytes = await o.registry.get(`/registry/${o.channel}/index.json`);
  const index = parseJson<RegistryIndex>(indexBytes, 'index');
  const revokedStored = parseJson<RevokedKeys>(await o.registry.get('/registry/revoked_keys.json'), 'revoked_keys');
  const statusStored = parseJson<RegistryStatus>(await o.registry.get('/registry/status.json'), 'status');
  const revokedIds = new Set(revokedStored?.revoked.map((r) => r.keyId) ?? []);
  if (index && index.keyEpoch !== o.trust.keyEpoch) err('registry.key_epoch_mismatch', 'index');

  const srcs = order(o.sources.map((d) => readSource(o.src, d)));
  // 이미 게시된 조회 패키지의 manifest 다이제스트(인덱스 항목 → .sxp)
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

  // 엔진 로더 연습: 실제 핀과 같은 keyEpoch의 임시 키로 서명해 loadPackage·관문 verifySxp까지 돌린다(서명 키만 다르다)
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
    baseIndex: index ? { monotonic: index.monotonic, contentDigest: contentDigest(index) } : null,
    packages: built.map((b) => b.pkg),
    docs,
  };
  wwrite(work, W.plan, pretty(plan));
  // ceremony sign은 출력 파일만 새로 쓴다(폴더를 만들지 않는다)
  work.fs.mkdir(wp(work, 'sig'));

  o.out(`계획 ${work.dir}: 레지스트리 ${plan.registry}, 채널 ${plan.channel}, keyEpoch ${plan.keyEpoch}, 지금 인덱스 monotonic ${index?.monotonic ?? '없음'}`);
  for (const b of built) o.out(`  ${b.pkg.name}(${b.pkg.kind}, ${b.pkg.portal}) manifest ${b.pkg.manifestDigest}${b.pkg.published ? ' — 이미 게시됨(서명 없음)' : ` 확인 코드 ${b.pkg.confirm}`}`);
  o.out('엔진 로더 연습(임시 키): 통과. 서명 키만 실제 키로 바뀐다');
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

// ───────────────────────── 2. assemble: .sxp·인덱스 ─────────────────────────

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
  /** 지금 인덱스의 다른 항목을 새 인덱스에 이어 둔다(기본). 리허설은 실제 키로 서명된 기존 패키지를 임시 핀으로 검증할 수 없어 끈다 */
  carry?: boolean;
  out: (line: string) => void;
}

export async function assemble(o: AssembleOpts): Promise<RegistryIndex> {
  const w = o.work;
  const plan = loadPlan(w, o.trust, o.trustBytes);
  if (w.fs.exists(wp(w, W.index))) err('publish.work_exists', W.index);
  const current = await checkBase(plan, o.registry);
  const revokedStored = parseJson<RevokedKeys>(await o.registry.get('/registry/revoked_keys.json'), 'revoked_keys');
  // 이번에 올릴 폐기 목록이 있으면 그 목록으로 센다(관문은 폐기 목록을 먼저 올린 뒤 패키지·인덱스를 본다)
  const pending = plan.docs.find((d) => d.kind === 'revoked_keys');
  const revoked = new Set([...(revokedStored?.revoked.map((r) => r.keyId) ?? []), ...(pending ? wjson<RevokedKeys>(w, pending.file).revoked.map((r) => r.keyId) : [])]);

  const raws: Array<{ name: string; raw: RawPackage }> = [];
  const entries: IndexEntry[] = [];
  // 검사를 모두 마친 뒤에만 쓴다(중간에 실패하면 작업 폴더가 그대로라 서명을 고쳐 다시 돌릴 수 있다)
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
    entries.push({ id: p.id, version: p.version, kind: info.kind, portal: info.portal, sxpDigest: sha(sxp), size: sxp.length, rolloutPercent: plan.rolloutPercent });
  }
  // 실제 서명으로 엔진 로더 전체(서명 2-of-3·번들·조회 다이제스트·정적 검증·승인 바 요약)
  engineLoadAll(raws, o.trust, revoked, o.now);

  // 지금 인덱스의 다른 패키지는 그대로 잇는다(같은 id는 새 판으로 바꾼다). 이어 둘 항목도 실제 핀으로 다시 본다
  const newIds = new Set(entries.map((e) => e.id));
  const carried = o.carry === false ? [] : (current?.entries ?? []).filter((e) => !newIds.has(e.id));
  for (const e of carried) {
    const b = (await o.registry.get(`/packages/${e.id}@${e.version}.sxp`)) ?? err('publish.registry_changed', `${e.id}@${e.version} 없음`);
    verifyPackageBytes(b, e);
    verifySxp(b, e, o.trust, revoked, o.now);
  }
  // 초안에는 신선도 필드(issuedAt·expiresAt·timestamp)가 없다. 게시 관문이 올릴 때 타임스탬프 키로 붙이고, 그 뒤로는 cron이 다시 서명한다(ADR-043)
  const index = {
    channel: plan.channel,
    monotonic: (current?.monotonic ?? 0) + 1,
    keyEpoch: o.trust.keyEpoch,
    entries: [...carried, ...entries].sort((a, b) => `${a.id}@${a.version}`.localeCompare(`${b.id}@${b.version}`)),
    signatures: [],
  } as unknown as RegistryIndex;
  if (Buffer.byteLength(JSON.stringify(index)) > DOC_MAX) err('publish.body_too_large', 'index');
  for (const t of toWrite) {
    // 서명이 결정적(Ed25519)이라 다시 돌리면 같은 바이트다. 다르면 작업 폴더가 섞인 것이다
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

// ───────────────────────── 3. push: 게시 관문 PUT → 되읽기 → 로그 ─────────────────────────

export interface PushOpts {
  work: Work;
  registry: RegistryClient;
  trust: TrustRoot;
  trustBytes: Buffer;
  token: string;
  now: number;
  out: (line: string) => void;
}

export interface PublishRecord {
  v: 1;
  tool: typeof PLAN_TOOL;
  registry: string;
  channel: Channel;
  publishedAt: string;
  published: Array<{ kind: string; path: string; sha256: string; logIndex: number }>;
  index: { monotonic: number; expiresAt: string };
  logHead: { before: number; after: number; rootHash: string };
}

const putOk = async (registry: RegistryClient, p: string, body: unknown, token: string, want: number): Promise<Record<string, unknown>> => {
  const r = await registry.put(p, body, token);
  if (r.status !== want) err(typeof r.body.error === 'string' ? r.body.error : 'publish.put_failed', `${p} ${r.status}`);
  return r.body;
};

async function logHead(registry: RegistryClient, trust: TrustRoot): Promise<SignedTreeHead> {
  const h = parseJson<SignedTreeHead>(await registry.get('/registry/log/head.json'), 'log head');
  const pub = h ? trust.keys.timestamp?.[h.signature?.keyId] : undefined;
  if (!h || !pub || !verifyTreeHead(pub, h)) return err('publish.log_invalid', 'head');
  return h;
}

export async function push(o: PushOpts): Promise<PublishRecord> {
  const w = o.work;
  const plan = loadPlan(w, o.trust, o.trustBytes);
  if (w.fs.exists(wp(w, W.record))) err('publish.work_exists', W.record);
  if (!o.token || o.token.length < 16) err('publish.token_missing');
  const current = await checkBase(plan, o.registry);
  const before = await logHead(o.registry, o.trust);
  const revokedStored = parseJson<RevokedKeys>(await o.registry.get('/registry/revoked_keys.json'), 'revoked_keys');
  const statusStored = parseJson<RegistryStatus>(await o.registry.get('/registry/status.json'), 'status');

  // 문서 서명 모으기(올리기 전에 모두 갖춰졌는지 먼저 본다: 중간에 멈추지 않게)
  const docOf = (d: PlanDoc): Record<string, unknown> => {
    const doc = wjson<Record<string, unknown>>(w, d.file);
    if (d.signed) return doc;
    return collectSignatures(d.kind, doc, sigRecords(w, d.kind), o.trust as unknown as TrustPin, new Set(revokedStored?.revoked.map((r) => r.keyId) ?? [])).doc;
  };
  const revokedDoc = plan.docs.find((d) => d.kind === 'revoked_keys');
  const statusDoc = plan.docs.find((d) => d.kind === 'status');
  const revokedOut = revokedDoc ? (docOf(revokedDoc) as unknown as RevokedKeys) : null;
  const statusOut = statusDoc ? (docOf(statusDoc) as unknown as RegistryStatus) : null;
  const revoked = new Set([...(revokedStored?.revoked.map((r) => r.keyId) ?? []), ...(revokedOut?.revoked.map((r) => r.keyId) ?? [])]);

  const hasIndex = plan.packages.length > 0;
  let index: RegistryIndex | null = null;
  const sxps = new Map<string, Buffer>();
  if (hasIndex) {
    const draft = wjson<Record<string, unknown>>(w, W.index);
    index = collectSignatures('index', draft, sigRecords(w, 'index'), o.trust as unknown as TrustPin, revoked).doc as unknown as RegistryIndex;
    verifyIndex(index, plan.channel, o.trust, revoked, current, o.now, undefined, { content: true });
    for (const p of plan.packages.filter((x) => !x.published)) {
      const b = wread(w, W.sxp(p.name));
      const e = index.entries.find((x) => x.id === p.id && x.version === p.version) ?? err('publish.work_invalid', `${p.name} 인덱스 항목 없음`);
      verifyPackageBytes(b, e);
      verifySxp(b, e, o.trust, revoked, o.now);
      sxps.set(p.name, b);
    }
  }

  // 올리기: 폐기 목록 → status → 패키지(조회 먼저, 계획 순서) → 인덱스. 관문이 같은 규칙으로 다시 보고, 공개 전에 로그를 쓴다
  const published: Array<{ kind: string; path: string; bytes?: Buffer }> = [];
  if (revokedOut) {
    await putOk(o.registry, '/admin/v1/revoked-keys', revokedOut, o.token, 200);
    published.push({ kind: 'revoked_keys', path: 'registry/revoked_keys.json' });
    o.out(`게시 revoked_keys monotonic ${revokedOut.monotonic}`);
  }
  if (statusOut) {
    await putOk(o.registry, '/admin/v1/status', statusOut, o.token, 200);
    published.push({ kind: 'status', path: 'registry/status.json' });
    o.out(`게시 status monotonic ${statusOut.monotonic}`);
  }
  for (const [name, b] of sxps) {
    const r = await putOk(o.registry, `/admin/v1/packages/${name}.sxp`, { data: b.toString('base64') }, o.token, 201);
    if (r.sxpDigest !== sha(b) || r.size !== b.length) err('publish.registry_mismatch', name);
    published.push({ kind: 'package', path: `packages/${name}.sxp`, bytes: b });
    o.out(`게시 ${name}.sxp ${b.length}B`);
  }
  if (index) {
    await putOk(o.registry, `/admin/v1/index/${plan.channel}`, index, o.token, 200);
    published.push({ kind: 'index', path: `registry/${plan.channel}/index.json` });
    o.out(`게시 인덱스 ${plan.channel} monotonic ${index.monotonic}`);
  }

  // 되읽기: 공개 경로가 올린 것과 같은가(관문이 쓴 그 바이트를 공개 GET으로)
  const got = new Map<string, Buffer>();
  for (const p of published) {
    const b = (await o.registry.get(`/${p.path}`)) ?? err('publish.readback_failed', p.path);
    if (p.bytes && !b.equals(p.bytes)) err('publish.readback_failed', p.path);
    got.set(p.path, b);
  }
  // 인덱스: 서명한 내용 그대로이고(서버는 신선도 필드만 붙인다), 붙인 신선도까지 관문 규칙을 통과해야 한다
  let indexOut: RegistryIndex | null = null;
  if (index) {
    indexOut = parseJson<RegistryIndex>(got.get(`registry/${plan.channel}/index.json`)!, 'index')!;
    if (contentDigest(indexOut) !== contentDigest(index) || canonicalJson(indexOut.signatures) !== canonicalJson(index.signatures)) err('publish.readback_failed', 'index');
    verifyIndex(indexOut, plan.channel, o.trust, revoked, current, o.now);
  }
  if (revokedOut) {
    const r = parseJson<RevokedKeys>(got.get('registry/revoked_keys.json')!, 'revoked_keys')!;
    if (contentDigest(r) !== contentDigest(revokedOut)) err('publish.readback_failed', 'revoked_keys');
    verifyRevoked(r, o.trust, revokedStored, o.now);
  }
  if (statusOut) {
    const s = parseJson<RegistryStatus>(got.get('registry/status.json')!, 'status')!;
    if (contentDigest(s) !== contentDigest(statusOut)) err('publish.readback_failed', 'status');
    verifyStatus(s, o.trust, revoked, statusStored, o.now);
  }

  // 투명성 로그: 새 헤드(핀 고정 타임스탬프 키), 이전 헤드와의 일관성, 올린 경로마다 항목·포함 증명
  const after = await logHead(o.registry, o.trust);
  // 같은 바이트의 패키지 재게시(중간 실패 뒤 다시 push)는 로그에 다시 쓰지 않으므로 새 항목이 올린 건수보다 적을 수 있다
  if (after.treeSize < before.treeSize || (before.treeSize === after.treeSize && before.rootHash !== after.rootHash)) err('publish.log_invalid', 'treeSize');
  if (before.treeSize > 0) {
    const c = parseJson<{ proof: string[] }>(await o.registry.get(`/registry/log/proof/consistency?from=${before.treeSize}&to=${after.treeSize}`), 'consistency');
    if (!c || !verifyConsistency(before, after, c.proof.map((h) => Buffer.from(h, 'hex')))) err('publish.log_invalid', 'consistency');
  }
  const logged: PublishRecord['published'] = [];
  for (const p of published) {
    const want = sha(got.get(p.path)!);
    let hit: LogEntryRecord | null = null;
    // 새 항목부터 거꾸로, 없으면 그 앞(다시 push한 같은 바이트 패키지는 앞선 항목에 있다)
    for (let i = after.treeSize - 1; i >= 0 && !hit; i--) {
      const e = parseJson<LogEntryRecord>(await o.registry.get(`/registry/log/entries/${i}.json`), 'log entry');
      if (e && e.entry.path === p.path && e.entry.sha256 === want) hit = e;
    }
    if (!hit) return err('publish.log_invalid', `${p.path} 항목 없음`);
    const leaf = leafHashOf(Buffer.from(canonicalJson(hit.entry), 'utf8')).toString('hex');
    if (leaf !== hit.leafHash) err('publish.log_invalid', `${p.path} 잎 해시`);
    const proof = parseJson<{ leafIndex: number; path: string[] }>(await o.registry.get(`/registry/log/proof/inclusion?leaf=${leaf}&size=${after.treeSize}`), 'inclusion');
    if (!proof || !verifyInclusion(Buffer.from(leaf, 'hex'), proof.leafIndex, after.treeSize, proof.path.map((h) => Buffer.from(h, 'hex')), Buffer.from(after.rootHash, 'hex'))) err('publish.log_invalid', `${p.path} 포함 증명`);
    logged.push({ kind: p.kind, path: p.path, sha256: want, logIndex: hit.index });
  }

  const record: PublishRecord = {
    v: 1,
    tool: PLAN_TOOL,
    registry: plan.registry,
    channel: plan.channel,
    publishedAt: iso(o.now),
    published: logged,
    index: indexOut ? { monotonic: indexOut.monotonic, expiresAt: indexOut.expiresAt } : { monotonic: current?.monotonic ?? 0, expiresAt: current?.expiresAt ?? '' },
    logHead: { before: before.treeSize, after: after.treeSize, rootHash: after.rootHash },
  };
  wwrite(w, W.record, pretty(record));
  o.out(`되읽기·로그 확인: ${logged.length}건, 로그 크기 ${before.treeSize} → ${after.treeSize}, 루트 ${after.rootHash}`);
  o.out(`기록 ${wp(w, W.record)}`);
  return record;
}
