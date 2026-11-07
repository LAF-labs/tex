// M4-7 레지스트리(D09 §8, ADR-013·023·028, D11 "레지스트리 테스트"). 서명 바이트·수용 규칙은 엔진 SIGNING.md가 정본이다.
// 키는 엔진 샘플 묶음과 같은 공개 시험 시드(tests/registry-samples.ts, 실제 키 아님)와 시험 중에만 만드는 릴리스 키다(저장소·CI에 운영 개인 키 없음).
import assert from 'node:assert/strict';
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import {
  acceptPolicy,
  acceptRevoked,
  acceptStatus,
  canonicalJson,
  canonicalWithout,
  countSignatures as engineCount,
  decodeSxp,
  encodeSxp,
  loadDataPackage,
  loadPackage,
  sha256Hex,
  type LoadedPackage,
  type LoaderContext,
  type Policy,
  type RegistryStatus as EngineStatus,
  type RevokedKeys as EngineRevoked,
  consistencyProof as engineConsistencyProof,
  headMismatch,
  merkleRoot,
  verifyConsistency,
} from '@sax/engine/core';
import { Logger, createServer, ed25519RawPublic, jcs, listen, looksSensitive, openPg, openSqlite, type Sql } from '../services/shared/src/index.ts';
import {
  DirStore,
  MemoryStore,
  TransparencyLog,
  consistencyPath,
  contentDigest,
  inRollout,
  inclusionPath,
  leafHashOf,
  logSigningKey,
  parseTrustRoot,
  registryRouter,
  rolloutBucket,
  rootOf,
  startRegistry,
  verifyInclusion,
  verifyTreeHead,
  without,
  type Role,
  type Sig,
  type SignedTreeHead,
  type Store,
  type TrustRoot,
} from '../services/registry/src/index.ts';
import { validatePackage } from '@sax/payroll';
import { verifyRelease as updaterVerify } from '../packages/updater/src/index.ts';
import { bundleOutcomes, lookups, signPackage } from './core-fixtures.ts';
import { SAMPLE_NOW, SAMPLE_RATE_TABLES, SAMPLE_SEEDS, buildSamples, sampleKeys } from './registry-samples.ts';
import { Clock, D, H, client } from './services-kit.ts';

type Key = { keyId: string; priv: KeyObject };
type Ring = Record<Role, Key[]>;

const SAMPLES = buildSamples();
const K = sampleKeys();
const sample = (p: string): Buffer => SAMPLES.get(p)!;
const sampleDoc = <T>(p: string): T => JSON.parse(sample(p).toString('utf8')) as T;
const FIXTURE_DIR = path.resolve(import.meta.dirname, 'fixtures/registry');

/** 샘플 릴리스 키(release-1, 시드 0x61: 패키징 #76·엔진 #85 trust.json과 같은 키) */
function makeRelease(): { key: Key; pub: string } {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, SAMPLE_SEEDS.release['release-1'])]), format: 'der', type: 'pkcs8' });
  return { key: { keyId: 'release-1', priv: privateKey }, pub: ed25519RawPublic(privateKey).toString('base64') };
}

/** 샘플 trust.json(핀 키) 그대로 */
function sampleTrust(): { ring: Ring; trust: TrustRoot } {
  const rel = makeRelease();
  const t = sampleDoc<{ keyEpoch: number; keys: Record<string, Record<string, string>> }>('trust.json');
  assert.deepEqual(t.keys.release, { [rel.key.keyId]: rel.pub });
  const trust = t as TrustRoot;
  const ring: Ring = { root: K.root, package: K.pkg, policy: K.pol, emergency: [K.emergency], timestamp: [K.ts], release: [rel.key] };
  return { ring, trust };
}

/** SIGNING.md §1: sig = base64url(Ed25519(utf8(JCS(내용)))), 맥락 문자열 없음 */
const sigOf = (content: unknown, k: Key): Sig => ({ keyId: k.keyId, alg: 'ed25519', sig: sign(null, Buffer.from(jcs(content)), k.priv).toString('base64url') });
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const FRESH = ['signatures', 'issuedAt', 'expiresAt', 'timestamp'];

interface Env {
  clock: Clock;
  ring: Ring;
  trust: TrustRoot;
  store: MemoryStore;
  server: Server;
  req: ReturnType<typeof client>;
  logs: string[];
  events: string[];
  log: TransparencyLog;
  db: Sql;
  put(path: string, body: unknown): ReturnType<Env['req']>;
  stage(file: string, bytes?: Buffer): ReturnType<Env['req']>;
}

/** 투명성 로그 헤드 서명 키 = 샘플 타임스탬프 역할 키(시드 0x51, registry-samples.ts) */
const TS_SEED = '51'.repeat(32);

async function start(o: { store?: Store; db?: Sql } = {}): Promise<Env> {
  const clock = new Clock(SAMPLE_NOW);
  const { ring, trust } = sampleTrust();
  const store = (o.store ?? new MemoryStore()) as MemoryStore;
  const logs: string[] = [];
  const events: string[] = [];
  const db = o.db ?? openSqlite();
  const log = await TransparencyLog.open({ db, signer: logSigningKey(TS_SEED, trust), now: clock.now });
  const server = createServer(registryRouter({ store, trust, adminToken: 'admin-test-token', now: clock.now, onEvent: (x) => events.push(x), log }), { logger: new Logger('registry', (l) => logs.push(l), clock.now) });
  const req = client(await listen(server));
  const put = (p: string, body: unknown) => req('PUT', p, { headers: { authorization: 'Admin admin-test-token' }, body });
  return { clock, ring, trust, store, server, req, logs, events, log, db, put, stage: (file, bytes) => put(`/admin/v1/packages/${file}`, { data: (bytes ?? sample(`packages/${file}`)).toString('base64') }) };
}

const H01 = 'hometax.invoice.issue@2.1.0.sxp';
const LOOKUP = 'hometax.invoice.lookup@1.0.0.sxp';
const HOTFIX = 'hometax.invoice.issue.hotfix@1.3.0.sxp';
const DATA = 'payroll.rate-tables@2026.11.1.sxp';

/** SIGNING.md §6 데이터 패키지: 기술자(패키지 키 2-of-3) + 본문 원시 바이트(bodyDigest) */
function dataSxp(body: unknown, o: { schema?: string; version?: string; signers?: number[]; bodyBytes?: Buffer } = {}): Buffer {
  const b = o.bodyBytes ?? Buffer.from(JSON.stringify(body));
  const desc: Record<string, unknown> = { id: 'payroll.rate-tables', version: o.version ?? '2026.11.1', schema: o.schema ?? 'sax.rate-tables/v1', bodyDigest: sha256Hex(b), keyEpoch: 1, issuedAt: '2026-11-05T00:00:00Z' };
  desc.signatures = (o.signers ?? [0, 1]).map((i) => sigOf(without(desc, ['signatures']), K.pkg[i]!));
  return encodeSxp({ kind: 'data', raw: { descriptor: Buffer.from(canonicalJson(desc)), body: b } });
}
const entryOf = (file: string, kind: string, o: object = {}) => {
  const b = sample(`packages/${file}`);
  const [id, v] = file.replace(/\.sxp$/, '').split('@');
  return { id: id!, version: v!, kind, portal: 'hometax', sxpDigest: sha256Hex(b), size: b.length, rolloutPercent: 10, ...o };
};

/** 패키지 키 2-of-3(기본 1·2번)로 서명한 인덱스. 내용 = index − signatures(만료 포함, 타임스탬프 없음) */
function index(e: Env, o: { monotonic?: number; entries?: unknown[]; signers?: number[]; ring?: Role; issuedAt?: number; expiresAt?: number; keyEpoch?: number; channel?: string } = {}) {
  const now = e.clock.now();
  const doc = { channel: o.channel ?? 'stable', monotonic: o.monotonic ?? 1, keyEpoch: o.keyEpoch ?? 1, issuedAt: iso(o.issuedAt ?? now), expiresAt: iso(o.expiresAt ?? now + 7 * D), entries: o.entries ?? [] };
  return { ...doc, signatures: (o.signers ?? [0, 1]).map((i) => sigOf(doc, e.ring[o.ring ?? 'package'][i]!)) };
}

/** 정책·status·폐기 목록 공통: 내용 서명 + 타임스탬프 서명(SIGNING.md §2·§4) */
function fresh<T extends Record<string, unknown>>(e: Env, body: T, role: Role, signers: number[], o: { issuedAt?: number; ttl?: number; noTimestamp?: boolean } = {}) {
  const issuedAt = iso(o.issuedAt ?? e.clock.now());
  const expiresAt = iso((o.issuedAt ?? e.clock.now()) + (o.ttl ?? 24 * H));
  const content = without(body, FRESH);
  const signatures = signers.map((i) => sigOf(content, e.ring[role][i]!));
  const ts = { contentDigest: sha256Hex(jcs(content)), monotonic: body.monotonic, issuedAt, expiresAt };
  return { ...body, issuedAt, expiresAt, signatures, ...(o.noTimestamp ? {} : { timestamp: sigOf(ts, e.ring.timestamp[0]!) }) };
}

const POLICY_BASE = without(sampleDoc<Record<string, unknown>>('policy/current.json'), FRESH);
const policyBody = (monotonic: number, o: { version?: string; hometax?: string } = {}) => ({
  ...POLICY_BASE,
  version: o.version ?? '2026.11',
  monotonic,
  portalMode: { ...(POLICY_BASE.portalMode as object), hometax: o.hometax ?? 'auto' },
});
const statusBody = (monotonic: number, ceiling: Record<string, string>, kill: string[] = []) => ({ monotonic, keyEpoch: 1, portalModeCeiling: ceiling, killPlaybooks: kill });

/** 샘플 .sxp를 풀어 일부를 바꾼 뒤 다시 정규형으로 싼다 */
function repack(file: string, edit: (raw: { manifest: Uint8Array; playbook: Uint8Array; selectors: Uint8Array; strings: Uint8Array }) => void): Buffer {
  const d = decodeSxp(sample(`packages/${file}`));
  assert.ok(d.ok && d.sxp.kind === 'package');
  const raw = { ...d.sxp.raw };
  edit(raw);
  return encodeSxp({ kind: 'package', raw });
}

describe('M4-7 레지스트리: 엔진 샘플 묶음과 상호 검증(SIGNING.md §10.3)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('저장소의 샘플 파일이 생성기 결과와 같을 때 그 파일로 시험한다', () => {
    if (!fs.existsSync(FIXTURE_DIR)) return;
    for (const [p, b] of SAMPLES) assert.ok(fs.readFileSync(path.join(FIXTURE_DIR, p)).equals(b), p);
  });

  it('svc-shared jcs = 엔진 canonicalJson(소수·유니코드 포함, RFC 8785)', () => {
    for (const p of ['policy/current.json', 'registry/status.json', 'registry/revoked_keys.json', 'registry/stable/index.json']) {
      const d = sampleDoc<unknown>(p);
      assert.equal(jcs(d), canonicalJson(d), p);
    }
    for (const v of [1.5, -0, 1e21, 0.1 + 0.2, { b: 'é', a: ' ', 'é': [true, null] }]) assert.equal(jcs(v), canonicalJson(v));
    assert.throws(() => jcs(NaN));
    assert.throws(() => jcs('\ud800'));
  });

  it('관문이 샘플 전부(폐기 목록·패키지 4개·데이터 패키지·인덱스 2개·정책·status·긴급 status)를 받는다', async () => {
    assert.equal((await e.put('/admin/v1/revoked-keys', sampleDoc('registry/revoked_keys.json'))).status, 200);
    for (const f of [LOOKUP, 'hometax.invoice.email_status@1.0.0.sxp', H01, HOTFIX, DATA]) {
      const r = await e.stage(f);
      assert.equal(r.status, 201, `${f} ${r.text}`);
      assert.equal(r.json.sxpDigest, sha256Hex(sample(`packages/${f}`)));
    }
    assert.equal((await e.stage(DATA)).json.kind, 'data');
    for (const ch of ['stable', 'hotfix']) assert.equal((await e.put(`/admin/v1/index/${ch}`, sampleDoc(`registry/${ch}/index.json`))).status, 200, ch);
    assert.deepEqual((await e.put('/admin/v1/policy', sampleDoc('policy/current.json'))).json, { monotonic: 41, emergency: false });
    assert.deepEqual((await e.put('/admin/v1/status', sampleDoc('registry/status.json'))).json, { monotonic: 10, emergency: false });
    assert.deepEqual((await e.put('/admin/v1/status', sampleDoc('registry/status-emergency.json'))).json, { monotonic: 11, emergency: true });
  });

  it('직전 status가 없어도(첫 설치) 엄격하게 보수적인 긴급 status는 받는다', async () => {
    assert.deepEqual((await e.put('/admin/v1/status', sampleDoc('registry/status-emergency.json'))).json, { monotonic: 11, emergency: true });
    // 첫 설치에서 "상한 없음·킬 없음"보다 엄격하지 않으면 거부
    const e2 = await start();
    try {
      assert.equal((await e2.put('/admin/v1/status', fresh(e2, statusBody(12, {}), 'emergency', [0]))).json.error, 'policy.rejected_not_conservative');
      assert.equal((await e2.put('/admin/v1/status', fresh(e2, statusBody(12, { hometax: 'auto' }), 'emergency', [0]))).json.error, 'policy.rejected_not_conservative');
    } finally {
      e2.server.close();
    }
  });

  it('관문이 게시한 파일을 엔진이 되읽는다(정책·status·폐기 목록 수용, 인덱스 2-of-3·sxpDigest, 로더가 H-01 + 핫픽스 적용)', async () => {
    await e.put('/admin/v1/revoked-keys', sampleDoc('registry/revoked_keys.json'));
    for (const f of [LOOKUP, 'hometax.invoice.email_status@1.0.0.sxp', H01, HOTFIX, DATA]) await e.stage(f);
    for (const ch of ['stable', 'hotfix']) await e.put(`/admin/v1/index/${ch}`, sampleDoc(`registry/${ch}/index.json`));
    await e.put('/admin/v1/policy', sampleDoc('policy/current.json'));
    await e.put('/admin/v1/status', sampleDoc('registry/status.json'));
    const get = async (p: string) => {
      const r = await e.req('GET', p);
      assert.equal(r.status, 200, p);
      return Buffer.from(r.text, 'utf8');
    };
    const rv = acceptRevoked(JSON.parse((await get('/registry/revoked_keys.json')).toString()) as EngineRevoked, { roots: K.roots, current: null, now: SAMPLE_NOW });
    assert.ok(rv.ok);
    const pol = acceptPolicy(JSON.parse((await get('/policy/current.json')).toString()) as Policy, { roots: K.roots, revoked: rv.accepted.keyIds, current: null, hold: false, now: SAMPLE_NOW });
    assert.ok(pol.ok, pol.ok ? '' : pol.code);
    const st = acceptStatus(JSON.parse((await get('/registry/status.json')).toString()) as EngineStatus, { roots: K.roots, revoked: rv.accepted.keyIds, current: null, now: SAMPLE_NOW });
    assert.ok(st.ok);
    const files = new Map<string, Buffer>();
    for (const ch of ['stable', 'hotfix']) {
      const ix = JSON.parse((await get(`/registry/${ch}/index.json`)).toString()) as { entries: Array<{ id: string; version: string; sxpDigest: string; size: number }>; signatures: never[] };
      assert.equal(engineCount(canonicalWithout(ix, ['signatures']), ix.signatures, K.roots.packageKeys, new Set()).valid.length, 2, ch);
      for (const x of ix.entries) {
        const b = await get(`/packages/${x.id}@${x.version}.sxp`);
        assert.equal(sha256Hex(b), x.sxpDigest);
        assert.equal(b.length, x.size);
        files.set(`${x.id}@${x.version}.sxp`, b);
      }
    }
    const ctx = (o: Partial<LoaderContext> = {}): LoaderContext => ({
      roots: K.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups: new Map(),
      storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: SAMPLE_NOW, ...o,
    });
    const unpack = (f: string) => {
      const d = decodeSxp(files.get(f)!);
      assert.ok(d.ok && d.sxp.kind === 'package', f);
      return d.sxp.raw;
    };
    const installed = new Map<string, LoadedPackage>();
    for (const id of ['hometax.invoice.lookup', 'hometax.invoice.email_status']) {
      const r = loadPackage(unpack(`${id}@1.0.0.sxp`), ctx());
      assert.ok(r.ok, id);
      installed.set(id, r.pkg);
    }
    const hx = decodeSxp(files.get(HOTFIX)!);
    assert.ok(hx.ok && hx.sxp.kind === 'hotfix');
    const r = loadPackage(unpack(H01), ctx({ installedLookups: installed, hotfix: { hotfix: hx.sxp.hotfix, stored: null } }));
    assert.ok(r.ok, r.ok ? '' : r.code);
    assert.deepEqual(r.events, ['registry.hotfix_applied']);
    // 데이터 패키지: 엔진 loadDataPackage + 급여 validatePackage(SIGNING.md §6)
    const dx = decodeSxp(files.get(DATA)!);
    assert.ok(dx.ok && dx.sxp.kind === 'data');
    const dr = loadDataPackage(dx.sxp.raw, { roots: K.roots, revoked: new Set(), schemas: new Map([['sax.rate-tables/v1', validatePackage]]), installed: null, hold: false, now: SAMPLE_NOW });
    assert.ok(dr.ok, dr.ok ? '' : dr.code);
  });

  it('데이터 패키지 관문(SIGNING.md §6): 본문 다이제스트·기술자 2-of-3·등록된 schema·급여 validatePackage·이름·인덱스 종류', async () => {
    const T = SAMPLE_RATE_TABLES;
    // 거부 경우를 먼저(같은 파일 이름에 한 번 올라간 바이트는 바꿀 수 없다)
    const tampered = decodeSxp(dataSxp(T));
    assert.ok(tampered.ok && tampered.sxp.kind === 'data');
    const forged = encodeSxp({ kind: 'data', raw: { descriptor: tampered.sxp.raw.descriptor, body: Buffer.from(JSON.stringify({ ...T, tables: [] })) } });
    assert.equal((await e.stage(DATA, forged)).json.error, 'registry.content_digest_mismatch');
    assert.equal((await e.stage(DATA, dataSxp(T, { signers: [0] }))).json.error, 'registry.schema_invalid'); // 기술자 스키마 minItems 2
    assert.equal((await e.stage(DATA, dataSxp(T, { signers: [0, 0] }))).json.error, 'registry.signature_insufficient');
    assert.equal((await e.stage(DATA, dataSxp({ ...T, schema: 'sax.other/v1' }, { schema: 'sax.other/v1' }))).json.error, 'registry.schema_invalid');
    // 규칙은 급여 패키지가 정본: 같은 종류·같은 시작일 표 둘(겹침)은 거부
    const t0 = T.tables[0];
    assert.ok(validatePackage({ ...T, tables: [t0, { ...t0, id: 'nontax-2026b' }] }).length > 0);
    assert.equal((await e.stage(DATA, dataSxp({ ...T, tables: [t0, { ...t0, id: 'nontax-2026b' }] }))).json.error, 'registry.schema_invalid');
    // 파일 이름 = 기술자 id@version
    assert.equal((await e.stage('payroll.rate-tables@2026.11.2.sxp', dataSxp(T))).json.error, 'registry.schema_invalid');
    // 인덱스 항목: 종류 data, portal 없음
    const b = sample(`packages/${DATA}`);
    assert.equal((await e.stage(DATA)).status, 201);
    assert.equal((await e.stage(DATA, dataSxp({ ...T, tables: [] }))).json.error, 'registry.content_digest_mismatch'); // 올라간 파일은 불변
    const entry = { id: 'payroll.rate-tables', version: '2026.11.1', kind: 'data', sxpDigest: sha256Hex(b), size: b.length, rolloutPercent: 100 };
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, kind: 'lookup' }] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, portal: 'hometax' }] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [entry] }))).status, 200);
  });
});

describe('M4-7 레지스트리: 인덱스 2-of-3·버전·만료·채널', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('서로 다른 핀 키 2개 서명이면 게시, 공개 GET은 ETag 조건부·max-age=60', async () => {
    await e.stage(LOOKUP);
    const r = await e.put('/admin/v1/index/stable', index(e, { entries: [entryOf(LOOKUP, 'lookup')] }));
    assert.equal(r.status, 200, r.text);
    const g = await e.req('GET', '/registry/stable/index.json');
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('cache-control'), 'public, max-age=60');
    const etag = g.headers.get('etag')!;
    assert.equal((await e.req('GET', '/registry/stable/index.json', { headers: { 'if-none-match': etag } })).status, 304);
    const p = await e.req('GET', `/packages/${LOOKUP}`);
    assert.equal(p.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal((await e.req('GET', '/registry/beta/index.json')).json.error, 'registry.not_found');
    assert.equal((await e.req('GET', '/registry/nightly/index.json')).json.error, 'registry.not_found');
  });

  it('서명 1개·같은 키 두 번·핀 밖 키·정책 키 서명은 서명 부족, 운영자 토큰만으로는 올릴 수 없다', async () => {
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { signers: [0] }))).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { signers: [1, 1] }))).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { ring: 'policy' }))).json.error, 'registry.signature_insufficient');
    const doc = index(e);
    const outsider = generateKeyPairSync('ed25519').privateKey;
    const forged = { ...doc, signatures: [doc.signatures[0]!, sigOf(without(doc, ['signatures']), { keyId: 'package-2', priv: outsider })] };
    assert.equal((await e.put('/admin/v1/index/stable', forged)).json.error, 'registry.signature_insufficient');
    // 서명 뒤 내용 변경
    assert.equal((await e.put('/admin/v1/index/stable', { ...doc, monotonic: 2 })).json.error, 'registry.signature_insufficient');
    assert.equal((await e.req('PUT', '/admin/v1/index/stable', { body: doc })).json.error, 'registry.unauthorized');
    assert.equal((await e.req('PUT', '/admin/v1/index/stable', { headers: { authorization: 'Admin wrong' }, body: doc })).json.error, 'registry.unauthorized');
  });

  it('단조 버전: 같은 값은 같은 내용일 때만, 낮으면 version_rollback, +1000 초과는 version_jump_rejected. keyEpoch가 핀과 다르면 거부', async () => {
    const same = index(e, { monotonic: 5 });
    assert.equal((await e.put('/admin/v1/index/stable', same)).status, 200);
    assert.equal((await e.put('/admin/v1/index/stable', same)).status, 200);
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 5, expiresAt: e.clock.now() + 8 * D }))).json.error, 'registry.version_rollback');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 4 }))).json.error, 'registry.version_rollback');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 1006 }))).json.error, 'registry.version_jump_rejected');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 1005 }))).status, 200);
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 1006, keyEpoch: 2 }))).json.error, 'registry.key_epoch_mismatch');
    // 채널은 따로 센다
    assert.equal((await e.put('/admin/v1/index/beta', index(e, { channel: 'beta', monotonic: 1 }))).status, 200);
    assert.equal((await e.put('/admin/v1/index/beta', index(e, { channel: 'stable', monotonic: 2 }))).json.error, 'registry.schema_invalid');
  });

  it('만료 ≤ 14일, 도착 시 만료·5분 넘는 미래 발행 거부', async () => {
    const now = e.clock.now();
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { expiresAt: now + 14 * D + 1000 }))).json.error, 'registry.index_validity_too_long');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { issuedAt: now - 8 * D, expiresAt: now - 1000 }))).json.error, 'registry.expired_on_arrival');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { issuedAt: now + 6 * 60_000, expiresAt: now + D }))).json.error, 'registry.issued_in_future');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { issuedAt: now + 4 * 60_000, expiresAt: now + D }))).status, 200);
  });
});

describe('M4-7 레지스트리: .sxp 관문(SIGNING.md §5·§6)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('정규형 sxp/1만, 안의 manifest 2-of-3·contentDigests·파일 이름까지 본다', async () => {
    assert.equal((await e.stage(LOOKUP, randomBytes(64))).json.error, 'sxp.malformed');
    const pretty = Buffer.from(JSON.stringify(JSON.parse(sample(`packages/${LOOKUP}`).toString()), null, 1));
    assert.equal((await e.stage(LOOKUP, pretty)).json.error, 'sxp.not_canonical');
    assert.equal((await e.stage(LOOKUP, Buffer.from(canonicalJson({ format: 'sxp/2', kind: 'package' })))).json.error, 'sxp.unknown_format');
    // 다른 이름으로 올리면 거부(manifest id·version = 경로)
    assert.equal((await e.stage('hometax.invoice.lookup@1.0.1.sxp', sample(`packages/${LOOKUP}`))).json.error, 'registry.schema_invalid');
    // ADR-039 결정 2 ③: 서명·결속이 맞아도 portal fixture 패키지는 게시하지 않는다
    const fx = lookups().get('hometax.invoice.lookup')!;
    fx.manifest.portal = 'fixture';
    fx.playbook.portal = 'fixture';
    fx.selectors.portal = 'fixture';
    fx.manifest.domains = ['127.0.0.1'];
    assert.equal((await e.stage(LOOKUP, encodeSxp({ kind: 'package', raw: signPackage(fx, sampleKeys().pkg.slice(0, 2)) }))).json.error, 'registry.portal_blocked');
    assert.equal((await e.stage('hometax.invoice.email_status@1.0.0.sxp', sample(`packages/${LOOKUP}`))).json.error, 'registry.schema_invalid');
    // 원시 파일 바꾸기 → contentDigests 불일치
    assert.equal((await e.stage(LOOKUP, repack(LOOKUP, (r) => (r.strings = Buffer.from('{}'))))).json.error, 'registry.content_digest_mismatch');
    // manifest 서명 1개
    const one = repack(LOOKUP, (r) => {
      const m = JSON.parse(Buffer.from(r.manifest).toString()) as { signatures: unknown[] };
      r.manifest = Buffer.from(JSON.stringify({ ...m, signatures: m.signatures.slice(0, 1) }));
    });
    assert.equal((await e.stage(LOOKUP, one)).json.error, 'registry.schema_invalid'); // manifest.schema: 서명 2~3개
    const outsider = generateKeyPairSync('ed25519').privateKey;
    const forged = repack(LOOKUP, (r) => {
      const m = JSON.parse(Buffer.from(r.manifest).toString()) as { signatures: Sig[] };
      r.manifest = Buffer.from(JSON.stringify({ ...m, signatures: [m.signatures[0]!, sigOf(without(m, ['signatures']), { keyId: 'package-2', priv: outsider })] }));
    });
    assert.equal((await e.stage(LOOKUP, forged)).json.error, 'registry.signature_insufficient');
    // 데이터 패키지(kind data)의 컨테이너는 SIGNING.md 범위 밖: 아직 받지 않는다
    assert.equal((await e.stage('payroll.rate_tables@2026.1.0.sxp', Buffer.from(canonicalJson({ format: 'sxp/1', kind: 'data', body: 'e30=' })))).json.error, 'sxp.malformed');
    assert.equal((await e.put('/admin/v1/packages/..%2Fx@1.0.0.sxp', { data: 'AAAA' })).status, 404);
    assert.equal((await e.put('/admin/v1/packages/nodot@1.0.0.sxp', { data: 'AAAA' })).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/packages/a..b@1.0.0.sxp', { data: 'AAAA' })).json.error, 'request.param_rejected');
    // 정상본은 받고, 같은 이름의 다른 바이트 덮어쓰기는 거부
    assert.equal((await e.stage(LOOKUP)).status, 201);
    assert.equal((await e.stage(LOOKUP)).status, 201);
    assert.equal((await e.stage(LOOKUP, repack(LOOKUP, () => undefined).subarray(0, 10))).json.error, 'registry.content_digest_mismatch');
  });

  it('핫픽스: 이름 = <appliesTo.id>.hotfix@<keyEpoch>.<monotonic>.0, 핫픽스 채널 전용', async () => {
    assert.equal((await e.stage('hometax.invoice.issue.hotfix@1.4.0.sxp', sample(`packages/${HOTFIX}`))).json.error, 'registry.schema_invalid');
    const r = await e.stage(HOTFIX);
    assert.equal(r.status, 201, r.text);
    assert.equal(r.json.kind, 'hotfix');
    const hx = entryOf(HOTFIX, 'hotfix');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [hx] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/hotfix', index(e, { channel: 'hotfix', entries: [{ ...hx, version: '2.3.0' }] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/hotfix', index(e, { channel: 'hotfix', entries: [hx] }))).status, 200);
    // 만료된 핫픽스는 올라가지 않는다
    e.clock.advance(15 * D);
    assert.equal((await e.stage(HOTFIX)).json.error, 'hotfix.expired');
  });

  it('인덱스 항목: 패키지가 먼저 있어야 하고 sxpDigest·size·종류·포털이 맞아야 한다. 위택스·중복·형식 거부', async () => {
    await e.stage(LOOKUP);
    const entry = entryOf(LOOKUP, 'lookup');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, version: '9.9.9' }] }))).json.error, 'registry.not_found');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, sxpDigest: '0'.repeat(64) }] }))).json.error, 'registry.content_digest_mismatch');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, size: entry.size + 1 }] }))).json.error, 'registry.content_digest_mismatch');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, kind: 'playbook' }] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, portal: 'gov24' }] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, portal: 'wetax' }] }))).json.error, 'registry.portal_blocked');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, portal: 'fixture' }] }))).json.error, 'registry.portal_blocked', 'ADR-039: fixture는 배포 거부');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [entry, entry] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, rolloutPercent: 101 }] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, id: 'nodot' }] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, packageDigest: entry.sxpDigest }] }))).json.error, 'registry.schema_invalid');
    // 데이터 패키지 항목(M6-10, 본문 스키마 packages/payroll/schema/rate-table-package.schema.json)은 파일이 있어야 한다
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [entry, { ...entry, id: 'payroll.rate_tables', version: '2026.1.0', kind: 'data', portal: 'public_api' }] }))).json.error, 'registry.not_found');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [entry] }))).status, 200);
  });
});

describe('M4-7 레지스트리: 폐기 목록·정책·status', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  const revokedAt = '2026-11-04T00:00:00Z';
  const revoked = (e: Env, monotonic: number, ids: string[], o: { issuedAt?: number; ttl?: number; signers?: number[] } = {}) =>
    fresh(e, { monotonic, keyEpoch: 1, revoked: ids.map((keyId) => ({ keyId, role: keyId.split('-')[0], revokedAt })) }, 'root', o.signers ?? [0, 1], { ttl: 12 * H, ...o });

  it('폐기 목록: 루트 2-of-3 + 24시간 신선도. 폐기된 키 서명은 세지 않고(key_revoked 이벤트), 목록은 줄어들 수 없다', async () => {
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 1, ['package-1']))).status, 200);
    // package-1 + package-2 → package-1이 폐기라 유효 1개
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { signers: [0, 1] }))).json.error, 'registry.signature_insufficient');
    assert.ok(e.events.includes('registry.key_revoked'));
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { signers: [1, 2] }))).status, 200);
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, []))).json.error, 'registry.revoked_shrunk');
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, ['package-1'], { ttl: 25 * H }))).json.error, 'registry.revoked_validity_too_long');
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, ['package-1'], { issuedAt: e.clock.now() - 13 * H }))).json.error, 'registry.expired_on_arrival');
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 1, ['package-1', 'package-3']))).json.error, 'registry.version_rollback');
    // 내용이 같은 재발행(같은 monotonic, 새 타임스탬프)은 받는다
    e.clock.advance(6 * H);
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 1, ['package-1']))).status, 200);
    const pk = fresh(e, { monotonic: 2, keyEpoch: 1, revoked: [] }, 'package', [0, 1]);
    assert.equal((await e.put('/admin/v1/revoked-keys', pk)).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/revoked-keys', { ...revoked(e, 2, ['package-1']), extra: 1 })).json.error, 'registry.schema_invalid');
  });

  it('루트 키 폐기: 루트 서명은 이전 목록으로, 타임스탬프 서명은 새 목록으로 거른다(SIGNING.md §3)', async () => {
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 1, ['root-1']))).status, 200);
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, ['root-1', 'package-3']))).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, ['root-1', 'package-3'], { signers: [1, 2] }))).status, 200);
    // 타임스탬프 키를 폐기하는 목록은 그 키의 타임스탬프로 신선해질 수 없다
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 3, ['root-1', 'package-3', 'timestamp-1'], { signers: [1, 2] }))).json.error, 'registry.timestamp_invalid');
  });

  it('정책: 정책 키 2-of-3 + 타임스탬프, 72시간, {ver}.json = current.json, 같은 monotonic은 같은 내용일 때만', async () => {
    const p1 = fresh(e, policyBody(41), 'policy', [0, 2]);
    assert.equal((await e.put('/admin/v1/policy', p1)).status, 200);
    assert.equal((await e.req('GET', '/policy/current.json')).text, (await e.req('GET', '/policy/2026.11.json')).text);
    assert.equal((await e.req('GET', '/policy/current.json')).headers.get('cache-control'), 'public, max-age=60');
    assert.equal((await e.req('GET', '/policy/2026.11.json')).headers.get('cache-control'), 'public, max-age=60');
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(42), 'policy', [0, 1], { noTimestamp: true }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(42), 'policy', [0, 1], { ttl: 73 * H }))).json.error, 'policy.validity_too_long');
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(42), 'policy', [0, 1], { issuedAt: e.clock.now() - 25 * H }))).json.error, 'policy.expired_on_arrival');
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(41, { hometax: 'assisted' }), 'policy', [0, 1]))).json.error, 'registry.version_rollback');
    e.clock.advance(20 * H);
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(41), 'policy', [0, 2]))).status, 200);
    // 타임스탬프를 다른 내용 다이제스트에 붙이면 거부
    const p2 = fresh(e, policyBody(43, { version: '2026.11.1' }), 'policy', [0, 1]);
    assert.equal((await e.put('/admin/v1/policy', { ...p2, timestamp: p1.timestamp })).json.error, 'registry.timestamp_invalid');
    // 이미 있는 버전 파일을 새 monotonic으로 덮어쓰지 않는다({ver}.json은 같은 내용의 재서명만)
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(43), 'policy', [0, 1]))).json.error, 'registry.version_rollback');
    // 긴급 키 1개: 저장된 정책보다 엄격하게 보수적일 때만(엔진 isStrictlyConservative)
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(44, { version: '2026.11.2' }), 'emergency', [0]))).json.error, 'policy.rejected_not_conservative');
    const em = await e.put('/admin/v1/policy', fresh(e, policyBody(44, { version: '2026.11.2', hometax: 'assisted' }), 'emergency', [0]));
    assert.deepEqual(em.json, { monotonic: 44, emergency: true });
    assert.equal((await e.put('/admin/v1/policy', fresh(e, { ...policyBody(45), version: 'x' }, 'policy', [0, 1]))).json.error, 'registry.schema_invalid');
    // 소수 값(slowFactor 1.5)은 그대로 서명 대상이다
    assert.equal(((await e.req('GET', '/policy/current.json')).json.pace as { interactive: { slowFactor: number } }).interactive.slowFactor, 1.5);
    // current.json 쓰기가 실패한 뒤: 같은 버전·monotonic의 다른 내용은 {ver}.json을 덮지 못하고, 같은 문서 재시도는 끝까지 간다
    const put = e.store.put.bind(e.store);
    e.store.put = (k: string, b: Buffer) => (k === 'policy/current.json' ? Promise.reject(new Error('disk')) : put(k, b));
    const half = fresh(e, policyBody(46, { version: '2026.11.3' }), 'policy', [0, 1]);
    assert.equal((await e.put('/admin/v1/policy', half)).status, 500);
    e.store.put = put;
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(46, { version: '2026.11.3', hometax: 'assisted' }), 'policy', [0, 1]))).json.error, 'registry.version_rollback');
    assert.equal((await e.put('/admin/v1/policy', half)).status, 200);
    assert.equal((await e.req('GET', '/policy/current.json')).text, (await e.req('GET', '/policy/2026.11.3.json')).text);
  });

  it('status: 48시간, 긴급 키는 엄격하게 보수적인 변경(상한 하향·킬 추가)만', async () => {
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(1, { hometax: 'auto', gov24: 'assisted' }), 'policy', [0, 1]))).status, 200);
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(2, { hometax: 'auto', gov24: 'assisted' }), 'policy', [0, 1], { ttl: 49 * H }))).json.error, 'registry.status_validity_too_long');
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(2, { hometax: 'auto', gov24: 'assisted' }), 'policy', [0, 1], { issuedAt: e.clock.now() - 25 * H }))).json.error, 'registry.expired_on_arrival');
    const em = (m: number, c: Record<string, string>, k: string[] = []) => e.put('/admin/v1/status', fresh(e, statusBody(m, c, k), 'emergency', [0]));
    assert.equal((await em(2, { hometax: 'auto', gov24: 'assisted' })).json.error, 'policy.rejected_not_conservative'); // 변화 없음
    assert.equal((await em(2, { hometax: 'auto', gov24: 'auto' })).json.error, 'policy.rejected_not_conservative'); // 상향
    assert.equal((await em(2, { hometax: 'postprocess' })).json.error, 'policy.rejected_not_conservative'); // gov24 상한이 빠짐 = 완화
    assert.equal((await em(2, { hometax: 'assisted', gov24: 'auto' })).json.error, 'policy.rejected_not_conservative'); // 하나 하향, 하나 상향
    const down = await em(2, { hometax: 'assisted', gov24: 'assisted', iros: 'postprocess' });
    assert.deepEqual(down.json, { monotonic: 2, emergency: true });
    assert.equal((await em(3, { hometax: 'assisted', gov24: 'assisted', iros: 'postprocess' }, ['hometax.invoice.issue'])).status, 200);
    assert.equal((await em(4, { hometax: 'assisted', gov24: 'assisted', iros: 'postprocess' }, [])).json.error, 'policy.rejected_not_conservative'); // 킬 제거
    // 2-of-3은 상향도 할 수 있다
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(4, { hometax: 'auto' }), 'policy', [1, 2]))).status, 200);
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(5, { hometax: 'fast' }), 'policy', [1, 2]))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(5, { mars: 'auto' }), 'policy', [1, 2]))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(5, {}, ['nodot']), 'policy', [1, 2]))).json.error, 'registry.schema_invalid');
    for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(5, { hometax: m }), 'policy', [1, 2]))).json.error, 'registry.schema_invalid', m);
  });
});

describe('M4-7 레지스트리: 앱 업데이트 경로(latest.json 서명 → latest.yml)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  const sha512 = () => createHash('sha512').update(randomBytes(32)).digest('base64');
  const release = (e: Env, version: string, o: { ttl?: number; role?: Role; files?: unknown[] } = {}) => {
    const now = e.clock.now();
    const doc = { channel: 'stable', version, releaseDate: iso(now), expiresAt: iso(now + (o.ttl ?? 7 * D)), rolloutPercent: 10, files: o.files ?? [{ url: `tex-Setup-${version}.exe`, sha512: sha512(), size: 123_456 }] };
    return { ...doc, signature: sigOf(doc, e.ring[o.role ?? 'release'][0]!) };
  };

  it('릴리스 키 서명·만료 ≤ 14일·다운그레이드 금지, latest.yml은 검증된 매니페스트에서만 만든다', async () => {
    const r1 = release(e, '1.2.0');
    assert.equal((await e.put('/admin/v1/releases/stable', r1)).status, 200);
    const yml = await e.req('GET', '/releases/stable/latest.yml');
    assert.equal(yml.headers.get('content-type'), 'text/yaml; charset=utf-8');
    assert.match(yml.text, /^version: 1\.2\.0\nfiles:\n {2}- url: tex-Setup-1\.2\.0\.exe\n {4}sha512: [A-Za-z0-9+/]{86}==\n {4}size: 123456\npath: tex-Setup-1\.2\.0\.exe\nsha512: /);
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.1.9'))).json.error, 'registry.version_rollback');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.2.0'))).json.error, 'registry.version_rollback');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.3.0', { ttl: 15 * D }))).json.error, 'registry.release_validity_too_long');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.3.0', { role: 'package' }))).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.3.0', { files: [{ url: 'x.exe\nevil: 1', sha512: sha512(), size: 1 }] }))).json.error, 'registry.schema_invalid');
    assert.equal((await e.put('/admin/v1/releases/stable', { ...r1, version: '1.3.0' })).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.3.0'))).status, 200);
  });

  it('릴리스 rootChange(ADR-028 결정 3): 루트 2-of-3·keyEpoch 규칙, 같은 버전은 파일이 같을 때만 재발행, 게시본을 @sax/updater가 받는다', async () => {
    const now = e.clock.now();
    const files = [{ url: 'tex-Setup-1.4.0.exe', sha512: sha512(), size: 123_456 }];
    const rooted = (rc: { keyEpoch: number; changes: string[] }, roots: number[] = [0, 1], version = '1.4.0', f = files) => {
      const base = { channel: 'stable', version, releaseDate: iso(now), expiresAt: iso(now + 7 * D), rolloutPercent: 10, files: f };
      const doc = { ...base, rootChange: { ...rc, signatures: roots.map((i) => sigOf({ ...base, rootChange: rc }, e.ring.root[i]!)) } };
      return { ...doc, signature: sigOf(doc, e.ring.release[0]!) };
    };
    const put = (doc: unknown) => e.put('/admin/v1/releases/stable', doc);
    assert.equal((await put(rooted({ keyEpoch: 1, changes: ['allowlist'] }, [0]))).json.error, 'registry.signature_insufficient');
    assert.equal((await put(rooted({ keyEpoch: 1, changes: ['allowlist'] }, [0, 0]))).json.error, 'registry.signature_insufficient');
    assert.equal((await put(rooted({ keyEpoch: 1, changes: ['keyEpoch'] }))).json.error, 'registry.key_epoch_mismatch');
    assert.equal((await put(rooted({ keyEpoch: 2, changes: ['allowlist'] }))).json.error, 'registry.key_epoch_mismatch');
    assert.equal((await put(rooted({ keyEpoch: 1, changes: ['other'] }))).json.error, 'registry.schema_invalid');
    assert.equal((await put(rooted({ keyEpoch: 1, changes: ['allowlist', 'allowlist'] }))).json.error, 'registry.schema_invalid');
    const ok = rooted({ keyEpoch: 2, changes: ['keyEpoch', 'ceiling'] });
    assert.equal((await put(ok)).status, 200);
    // 업데이터가 게시된 latest.json을 그대로 받는다(루트 2개 셈)
    const pub = (await e.req('GET', '/releases/stable/latest.json')).json;
    const v = updaterVerify({ doc: pub, channel: 'stable', trust: e.trust, revocation: { keyIds: new Set(), fresh: true }, highestSeen: null, now });
    assert.equal(v.rootKeyIds.length, 2);
    assert.equal(v.releaseKeyId, 'release-1');
    // 같은 버전: 파일이 같으면 신선도 재발행, 다르면 롤백
    assert.equal((await put(release(e, '1.4.0', { files }))).status, 200);
    assert.equal((await put(release(e, '1.4.0'))).json.error, 'registry.version_rollback');
  });
});

describe('M4-7 레지스트리: 게시 원자성·재시도', () => {
  it('릴리스: yml 다음 json 순서라 중간 실패 뒤 같은 버전을 다시 올릴 수 있다', async () => {
    const inner = new MemoryStore();
    let failJson = 1;
    const flaky: Store = { get: (k) => inner.get(k), put: async (k, b) => (k.endsWith('latest.json') && failJson-- > 0 ? Promise.reject(new Error('disk')) : inner.put(k, b)) };
    const e = await start({ store: flaky });
    const now = e.clock.now();
    const doc = { channel: 'stable', version: '2.0.0', releaseDate: iso(now), expiresAt: iso(now + D), rolloutPercent: 1, files: [{ url: 'tex-Setup-2.0.0.exe', sha512: createHash('sha512').update('x').digest('base64'), size: 9 }] };
    const r = { ...doc, signature: sigOf(doc, e.ring.release[0]!) };
    assert.equal((await e.put('/admin/v1/releases/stable', r)).status, 500);
    assert.equal((await e.req('GET', '/releases/stable/latest.json')).status, 404);
    assert.equal((await e.put('/admin/v1/releases/stable', r)).status, 200);
    assert.match((await e.req('GET', '/releases/stable/latest.yml')).text, /^version: 2\.0\.0\n/);
    e.server.close();
  });

  it('동시 게시는 하나씩: 같은 monotonic의 다른 인덱스 둘 중 하나만, 같은 키 동시 쓰기도 섞이지 않는다', async () => {
    const e = await start();
    const rs = await Promise.all([e.put('/admin/v1/index/stable', index(e, { monotonic: 7 })), e.put('/admin/v1/index/stable', index(e, { monotonic: 7, expiresAt: e.clock.now() + 8 * D }))]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 422]);
    e.server.close();
    const dir = await mkdtemp(path.join(tmpdir(), 'sax-registry-'));
    try {
      const ds = new DirStore(dir);
      const a = randomBytes(1 << 20);
      const b = randomBytes(1 << 20);
      await Promise.all([ds.put('packages/x@1.0.0.sxp', a), ds.put('packages/x@1.0.0.sxp', b)]);
      const got = (await ds.get('packages/x@1.0.0.sxp'))!;
      assert.ok(got.equals(a) || got.equals(b), '둘 중 하나가 온전히');
      assert.deepEqual(await readdir(path.join(dir, 'packages')), ['x@1.0.0.sxp'], '임시 파일이 남지 않는다');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('M4-7 레지스트리: 롤아웃·핀 키 설정·로그', () => {
  it('롤아웃 버킷은 기기·패키지마다 결정적이고 비율대로 나뉜다', () => {
    assert.equal(rolloutBucket('p', 'dev-1'), rolloutBucket('p', 'dev-1'));
    const n = Array.from({ length: 2000 }, () => randomUUID()).filter((d) => inRollout({ id: 'hometax.invoice.issue', rolloutPercent: 10 }, d)).length;
    assert.ok(n > 120 && n < 280, String(n));
    assert.equal(inRollout({ id: 'x', rolloutPercent: 0 }, 'd'), false);
    assert.equal(inRollout({ id: 'x', rolloutPercent: 100 }, 'd'), true);
  });

  it('내용 다이제스트 = SHA-256(JCS(문서 − signatures·issuedAt·expiresAt·timestamp)), SIGNING.md §10.1 값', () => {
    const st = { monotonic: 12, keyEpoch: 1, issuedAt: '2026-11-05T09:00:00+09:00', expiresAt: '2026-11-07T09:00:00+09:00', portalModeCeiling: { hometax: 'assisted' }, killPlaybooks: ['hometax.invoice.cancel'] };
    assert.equal(contentDigest(st), '3f95477f12f9d94d2c939c24f952a1455c7c5fab54cff87b7c5c87a7efdb0c3f');
  });

  it('핀 키 설정: 역할별 개수, 역할 사이 키 재사용 금지, 공개키만', () => {
    const { trust } = sampleTrust();
    assert.deepEqual(parseTrustRoot(JSON.stringify(trust)), trust);
    const reuse = structuredClone(trust);
    reuse.keys.emergency = { 'emergency-1': trust.keys.policy['policy-1']! };
    assert.throws(() => parseTrustRoot(JSON.stringify(reuse)), /config_TRUST_ROOT_JSON/);
    const two = structuredClone(trust);
    delete two.keys.package['package-3'];
    assert.throws(() => parseTrustRoot(JSON.stringify(two)), /config_TRUST_ROOT_JSON/);
    assert.throws(() => parseTrustRoot('{'), /config_TRUST_ROOT_JSON/);
  });

  it('접근 로그는 고정 필드·라우트 패턴뿐(IP·앱 버전·토큰 없음)', async () => {
    const e = await start();
    await e.put('/admin/v1/index/stable', index(e));
    await e.req('GET', '/registry/stable/index.json', { headers: { 'user-agent': 'tex/1.2.0' } });
    e.server.close();
    for (const l of e.logs) {
      assert.ok(!looksSensitive(l), l);
      assert.ok(!l.includes('admin-test-token') && !l.includes('1.2.0') && !l.includes('127.0.0.1'), l);
    }
    assert.ok(e.logs.some((l) => l.includes('"route":"/registry/:channel/index.json"')));
  });
});

describe('투명성 로그(RFC 9162, D09 §8.3, 팀장 결정 2026-11-06): 서버 산출물을 엔진 검증기로 그대로 검증', () => {
  const tsPub = () => sampleTrust().trust.keys.timestamp['timestamp-1']!;
  const hex = (bs: readonly Uint8Array[]) => bs.map((b) => Buffer.from(b).toString('hex'));
  const bytesOf = (hs: readonly string[]) => hs.map((h) => Buffer.from(h, 'hex'));

  it('머클 루트·일관성 증명은 엔진(merkleRoot·consistencyProof·verifyConsistency)과 같고, 포함 증명은 모든 잎에서 통과·변조하면 실패', () => {
    for (let n = 0; n <= 20; n++) {
      const data = Array.from({ length: n }, (_, i) => Buffer.from(`entry-${i}-${randomUUID()}`));
      const leaves = data.map(leafHashOf);
      const root = rootOf(leaves);
      assert.ok(root.equals(merkleRoot(data)), `root n=${n}`);
      for (let m = 1; m < n; m++) {
        const p = consistencyPath(m, leaves);
        assert.deepEqual(hex(p), hex(engineConsistencyProof(m, data)), `consistency ${m}/${n}`);
        assert.ok(verifyConsistency({ treeSize: m, rootHash: rootOf(leaves.slice(0, m)).toString('hex') }, { treeSize: n, rootHash: root.toString('hex') }, p), `verify ${m}/${n}`);
      }
      for (let i = 0; i < n; i++) {
        const path = inclusionPath(i, leaves);
        assert.ok(verifyInclusion(leaves[i]!, i, n, path, root), `inclusion ${i}/${n}`);
        if (n > 1) {
          assert.equal(verifyInclusion(leaves[i]!, (i + 1) % n, n, path, root), false, `wrong index ${i}/${n}`);
          assert.equal(verifyInclusion(leafHashOf(Buffer.from('other')), i, n, path, root), false);
          const bad = path.map((b, j) => (j === 0 ? leafHashOf(b) : b));
          assert.equal(verifyInclusion(leaves[i]!, i, n, bad, root), false);
        }
      }
      assert.equal(verifyInclusion(leaves[0] ?? root, n, n, [], root), false, 'index ≥ size');
    }
  });

  it('게시마다 공개 전에 항목 1건, 헤드는 타임스탬프 키 서명, 항목 다이제스트 = 공개 바이트, HTTP 포함·일관성 증명이 엔진 검증을 통과', async () => {
    const e = await start();
    try {
      const head0 = (await e.req('GET', '/registry/log/head.json')).json as unknown as SignedTreeHead;
      assert.deepEqual({ treeSize: head0.treeSize, rootHash: head0.rootHash }, { treeSize: 0, rootHash: createHash('sha256').digest('hex') });
      assert.ok(verifyTreeHead(tsPub(), head0));
      assert.equal(head0.signature.keyId, 'timestamp-1');

      const published: string[] = [];
      assert.equal((await e.put('/admin/v1/revoked-keys', sampleDoc('registry/revoked_keys.json'))).status, 200);
      published.push('registry/revoked_keys.json');
      for (const f of [LOOKUP, 'hometax.invoice.email_status@1.0.0.sxp', H01]) {
        assert.equal((await e.stage(f)).status, 201, f);
        published.push(`packages/${f}`);
      }
      const mid = (await e.req('GET', '/registry/log/head.json')).json as unknown as SignedTreeHead;
      assert.equal(mid.treeSize, published.length);
      // 같은 바이트 재게시(멱등)는 항목을 더하지 않는다
      assert.equal((await e.stage(LOOKUP)).status, 201);
      assert.equal(((await e.req('GET', '/registry/log/head.json')).json as unknown as SignedTreeHead).treeSize, published.length);
      for (const f of [HOTFIX, DATA]) {
        assert.equal((await e.stage(f)).status, 201, f);
        published.push(`packages/${f}`);
      }
      for (const ch of ['stable', 'hotfix']) {
        assert.equal((await e.put(`/admin/v1/index/${ch}`, sampleDoc(`registry/${ch}/index.json`))).status, 200, ch);
        published.push(`registry/${ch}/index.json`);
      }
      assert.equal((await e.put('/admin/v1/policy', sampleDoc('policy/current.json'))).status, 200);
      published.push(`policy/${sampleDoc<{ version: string }>('policy/current.json').version}.json`, 'policy/current.json');
      assert.equal((await e.put('/admin/v1/status', sampleDoc('registry/status.json'))).status, 200);
      published.push('registry/status.json');

      const head = (await e.req('GET', '/registry/log/head.json')).json as unknown as SignedTreeHead;
      assert.equal(head.treeSize, published.length);
      assert.ok(verifyTreeHead(tsPub(), head));
      assert.equal(verifyTreeHead(tsPub(), { ...head, treeSize: head.treeSize + 1 }), false, '헤드 변조');
      assert.equal(verifyTreeHead(sampleTrust().trust.keys.package['package-1']!, head), false, '다른 역할 키');

      const entries: Array<{ index: number; entry: { kind: string; path: string; sha256: string }; leafHash: string }> = [];
      for (let i = 0; i < head.treeSize; i++) {
        const r = await e.req('GET', `/registry/log/entries/${i}.json`);
        assert.equal(r.status, 200);
        entries.push(r.json as unknown as (typeof entries)[number]);
      }
      assert.deepEqual(
        entries.map((x) => x.entry.path),
        published,
      );
      for (const x of entries) {
        // 항목 다이제스트 = 지금 공개된 바이트(정적 GET), 잎 해시 = SHA-256(0x00 ‖ JCS(항목))
        const served = await fetch(`http://127.0.0.1:${(e.server.address() as { port: number }).port}/${x.entry.path}`);
        assert.equal(sha256Hex(Buffer.from(await served.arrayBuffer())), x.entry.sha256, x.entry.path);
        assert.equal(leafHashOf(Buffer.from(jcs(x.entry))).toString('hex'), x.leafHash);
      }
      // 엔진 merkleRoot(항목 바이트) = 서버 헤드 루트
      assert.equal(merkleRoot(entries.map((x) => Buffer.from(jcs(x.entry)))).toString('hex'), head.rootHash);
      // HTTP 포함 증명
      for (const x of entries) {
        const p = await e.req('GET', `/registry/log/proof/inclusion?leaf=${x.leafHash}&size=${head.treeSize}`);
        assert.equal(p.status, 200, p.text);
        const pj = p.json as unknown as { leafIndex: number; treeSize: number; path: string[] };
        assert.equal(pj.leafIndex, x.index);
        assert.ok(verifyInclusion(Buffer.from(x.leafHash, 'hex'), pj.leafIndex, pj.treeSize, bytesOf(pj.path), Buffer.from(head.rootHash, 'hex')), x.entry.path);
      }
      // HTTP 일관성 증명: 앞서 본 헤드 → 지금 헤드(엔진 verifyConsistency·headMismatch)
      const c = await e.req('GET', `/registry/log/proof/consistency?from=${mid.treeSize}&to=${head.treeSize}`);
      assert.equal(c.status, 200, c.text);
      const proof = bytesOf((c.json as unknown as { proof: string[] }).proof);
      assert.ok(verifyConsistency(mid, head, proof));
      assert.equal(headMismatch(mid, head, proof), false);
      assert.equal(headMismatch(head, { ...head, rootHash: 'ab'.repeat(32) }, null), true, '같은 크기 다른 루트 = split view');
      assert.equal(verifyConsistency({ ...mid, rootHash: 'ab'.repeat(32) }, head, proof), false);
    } finally {
      e.server.close();
    }
  });

  it('조회 쿼리는 정해진 키만 정확히: 추가·중복·빠짐·형식 틀림 400, 범위 밖 404', async () => {
    const e = await start();
    try {
      assert.equal((await e.put('/admin/v1/revoked-keys', sampleDoc('registry/revoked_keys.json'))).status, 200);
      const leaf = ((await e.req('GET', '/registry/log/entries/0.json')).json as unknown as { leafHash: string }).leafHash;
      for (const q of [`leaf=${leaf}`, `leaf=${leaf}&size=1&x=1`, `leaf=${leaf}&leaf=${leaf}&size=1`, `leaf=${leaf.toUpperCase()}&size=1`, `leaf=${leaf}&size=01`]) {
        assert.equal((await e.req('GET', `/registry/log/proof/inclusion?${q}`)).status, 400, q);
      }
      for (const q of ['from=1', 'from=1&to=1&to=1', 'from=1&size=1', 'from=a&to=1']) assert.equal((await e.req('GET', `/registry/log/proof/consistency?${q}`)).status, 400, q);
      assert.equal((await e.req('GET', '/registry/log/head.json?x=1')).status, 400);
      assert.equal((await e.req('GET', `/registry/log/proof/inclusion?leaf=${leaf}&size=2`)).status, 404, 'size > 현재');
      assert.equal((await e.req('GET', `/registry/log/proof/inclusion?leaf=${'00'.repeat(32)}&size=1`)).status, 404, '없는 잎');
      assert.equal((await e.req('GET', '/registry/log/proof/consistency?from=0&to=1')).status, 404);
      assert.equal((await e.req('GET', '/registry/log/proof/consistency?from=1&to=2')).status, 404);
      assert.equal((await e.req('GET', '/registry/log/proof/consistency?from=1&to=1')).status, 200);
      for (const f of ['1.json', '01.json', 'x.json', '0']) assert.equal((await e.req('GET', `/registry/log/entries/${f}`)).status, 404, f);
    } finally {
      e.server.close();
    }
  });

  it('로그 append가 실패하면 공개하지 않는다(먼저 기록)', async () => {
    const e = await start();
    try {
      await e.db.close();
      assert.equal((await e.stage(LOOKUP)).status, 500);
      assert.equal((await e.req('GET', `/packages/${LOOKUP}`)).status, 404);
    } finally {
      e.server.close();
    }
  });

  it('동시 게시 N건 → treeSize N, 순번 0..N-1 빠짐·겹침 없음, 모든 앞 크기에서 일관성 증명 통과', async () => {
    const e = await start();
    try {
      const N = 12;
      const files = Array.from({ length: N }, (_, k) => ({ f: `payroll.rate-tables@2026.11.${k + 1}.sxp`, b: dataSxp({ ...SAMPLE_RATE_TABLES, packageVersion: `2026.11.${k + 1}` }, { version: `2026.11.${k + 1}` }) }));
      const rs = await Promise.all(files.map((x) => e.stage(x.f, x.b)));
      assert.deepEqual(
        rs.map((r) => r.status),
        Array(N).fill(201),
        rs.map((r) => r.text).join('\n'),
      );
      const head = await e.log.head();
      assert.equal(head.treeSize, N);
      const got = await Promise.all(Array.from({ length: N }, (_, i) => e.log.entry(i)));
      assert.deepEqual(got.map((x) => x!.index), [...Array(N).keys()]);
      assert.deepEqual(new Set(got.map((x) => x!.entry.path)), new Set(files.map((x) => `packages/${x.f}`)));
      const leaves = got.map((x) => Buffer.from(jcs(x!.entry)));
      assert.equal(merkleRoot(leaves).toString('hex'), head.rootHash);
      for (let m = 1; m < N; m++) {
        const c = (await e.log.consistency(m, N))!;
        assert.ok(verifyConsistency({ treeSize: m, rootHash: merkleRoot(leaves.slice(0, m)).toString('hex') }, head, bytesOf(c.proof)), `m=${m}`);
      }
    } finally {
      e.server.close();
    }
  });

  const pgUrl = process.env.SAX_PG_TEST_URL;
  it('PostgreSQL: 인스턴스 둘이 같은 DB에 동시에 append해도 treeSize가 겹치거나 빠지지 않는다(메타 행 잠금)', { skip: !pgUrl }, async () => {
    const admin = openPg(pgUrl!, 2);
    await admin.exec("DROP TABLE IF EXISTS log_entries; DROP TABLE IF EXISTS log_meta; CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version)); DELETE FROM schema_migrations WHERE service = 'registry';");
    await admin.close();
    const { trust } = sampleTrust();
    const clock = new Clock(SAMPLE_NOW);
    const dbs = [openPg(pgUrl!, 4), openPg(pgUrl!, 4)];
    try {
      const a = await TransparencyLog.open({ db: dbs[0]!, signer: logSigningKey(TS_SEED, trust), now: clock.now });
      const b = await TransparencyLog.open({ db: dbs[1]!, signer: logSigningKey(TS_SEED, trust), now: clock.now, migrate: false });
      const N = 40;
      const out = await Promise.all(Array.from({ length: N }, (_, i) => (i % 2 ? a : b).append({ kind: 'package', path: `packages/p${i}@1.0.0.sxp`, sha256: sha256Hex(Buffer.from(String(i))) })));
      assert.deepEqual(out.map((x) => x.index).sort((x, y) => x - y), [...Array(N).keys()]);
      const head = await b.head();
      assert.equal(head.treeSize, N);
      assert.ok(verifyTreeHead(tsPub(), head));
      const got = await Promise.all(Array.from({ length: N }, (_, i) => a.entry(i)));
      const leaves = got.map((x) => Buffer.from(jcs(x!.entry)));
      assert.equal(merkleRoot(leaves).toString('hex'), head.rootHash);
      for (const m of [1, 7, 20, 39]) {
        const c = (await a.consistency(m, N))!;
        assert.ok(verifyConsistency({ treeSize: m, rootHash: merkleRoot(leaves.slice(0, m)).toString('hex') }, head, bytesOf(c.proof)), `m=${m}`);
      }
    } finally {
      for (const d of dbs) await d.close();
    }
  });

  it('헤드 서명 키: 핀 고정된 타임스탬프 키여야 하고 다른 역할 키·임의 키·형식 틀림은 거부, 운영 기동은 키 없으면 거부', async () => {
    const { trust } = sampleTrust();
    assert.equal(logSigningKey(TS_SEED, trust).keyId, 'timestamp-1');
    for (const seed of ['21'.repeat(32), '11'.repeat(32), '61'.repeat(32), '41'.repeat(32), randomBytes(32).toString('hex'), 'zz', undefined]) {
      assert.throws(() => logSigningKey(seed, trust), /config_REGISTRY_LOG_SIGNING_KEY/, String(seed));
    }
    const env = { REGISTRY_STORE: 'memory', REGISTRY_ADMIN_TOKEN: 'admin-test-token', TRUST_ROOT_JSON: JSON.stringify(trust), HOST: '127.0.0.1', PORT: '0' };
    await assert.rejects(startRegistry(env), /config_REGISTRY_LOG_SIGNING_KEY/);
    await assert.rejects(startRegistry({ ...env, REGISTRY_LOG_SIGNING_KEY: '21'.repeat(32) }), /config_REGISTRY_LOG_SIGNING_KEY/);
    const ok = await startRegistry({ ...env, REGISTRY_LOG_SIGNING_KEY: TS_SEED });
    try {
      const h = await client(ok.url)('GET', '/registry/log/head.json');
      assert.equal(h.status, 200);
      assert.ok(verifyTreeHead(tsPub(), h.json));
    } finally {
      await ok.close();
    }
  });
});
