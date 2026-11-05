// M4-7 레지스트리(D09 §8, ADR-013·023·028, D11 "레지스트리 테스트"). 서명 키는 시험 실행 중에만 메모리에서 만든다(저장소·CI에 개인 키 없음).
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Logger, createServer, ed25519RawPublic, jcs, listen, looksSensitive } from '../services/shared/src/index.ts';
import { DirStore, MemoryStore, contentDigest, inRollout, parseTrustRoot, registryRouter, rolloutBucket, without, type Role, type Sig, type Store, type TrustRoot } from '../services/registry/src/index.ts';
import { Clock, D, H, client } from './services-kit.ts';

type Ring = Record<Role, Array<{ id: string; priv: KeyObject }>>;
const ROLES: Record<Role, number> = { root: 3, package: 3, policy: 3, timestamp: 1, emergency: 1, release: 1 };

function makeRing(): { ring: Ring; trust: TrustRoot } {
  const ring = {} as Ring;
  const keys = {} as TrustRoot['keys'];
  for (const [role, n] of Object.entries(ROLES) as Array<[Role, number]>) {
    ring[role] = [];
    keys[role] = {};
    for (let i = 0; i < n; i++) {
      const { privateKey } = generateKeyPairSync('ed25519');
      const id = `${role}-${i + 1}`;
      ring[role].push({ id, priv: privateKey });
      keys[role][id] = ed25519RawPublic(privateKey).toString('base64');
    }
  }
  return { ring, trust: { keyEpoch: 1, keys } };
}

const sigOf = (content: unknown, k: { id: string; priv: KeyObject }): Sig => ({ keyId: k.id, alg: 'ed25519', sig: sign(null, Buffer.from(jcs(content)), k.priv).toString('base64url') });
const iso = (ms: number) => new Date(ms).toISOString();
const FRESH = ['signatures', 'issuedAt', 'expiresAt', 'timestamp'];

interface Env {
  clock: Clock;
  ring: Ring;
  trust: TrustRoot;
  store: MemoryStore;
  server: Server;
  req: ReturnType<typeof client>;
  logs: string[];
  put(path: string, body: unknown): ReturnType<Env['req']>;
}

async function start(o: { store?: Store } = {}): Promise<Env> {
  const clock = new Clock();
  const { ring, trust } = makeRing();
  const store = (o.store ?? new MemoryStore()) as MemoryStore;
  const logs: string[] = [];
  const server = createServer(registryRouter({ store, trust, adminToken: 'admin-test-token', now: clock.now }), { logger: new Logger('registry', (l) => logs.push(l), clock.now) });
  const req = client(await listen(server));
  return { clock, ring, trust, store, server, req, logs, put: (path, body) => req('PUT', path, { headers: { authorization: 'Admin admin-test-token' }, body }) };
}

/** 패키지 키 2-of-3(기본 1·2번)로 서명한 인덱스 */
function index(e: Env, o: { monotonic?: number; entries?: unknown[]; signers?: number[]; ring?: Role; issuedAt?: number; expiresAt?: number; keyEpoch?: number; channel?: string } = {}) {
  const now = e.clock.now();
  const doc = { channel: o.channel ?? 'stable', monotonic: o.monotonic ?? 1, keyEpoch: o.keyEpoch ?? 1, issuedAt: iso(o.issuedAt ?? now), expiresAt: iso(o.expiresAt ?? now + 7 * D), entries: o.entries ?? [] };
  return { ...doc, signatures: (o.signers ?? [0, 1]).map((i) => sigOf(doc, e.ring[o.ring ?? 'package'][i]!)) };
}

async function stagePackage(e: Env, id = 'hometax_cert_issue', version = '1.0.0', portal = 'hometax') {
  const bytes = randomBytes(256);
  const r = await e.put(`/admin/v1/packages/${id}@${version}.sxp`, { data: bytes.toString('base64') });
  assert.equal(r.status, 201, r.text);
  return { id, version, kind: 'playbook', portal, packageDigest: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, rolloutPercent: 10 };
}

/** 정책·status·폐기 목록 공통: 내용 서명 + 타임스탬프 서명 */
function fresh<T extends Record<string, unknown>>(e: Env, body: T, role: Role, signers: number[], o: { issuedAt?: number; ttl?: number; noTimestamp?: boolean } = {}) {
  const issuedAt = iso(o.issuedAt ?? e.clock.now());
  const expiresAt = iso((o.issuedAt ?? e.clock.now()) + (o.ttl ?? 24 * H));
  const content = without(body, FRESH);
  const signatures = signers.map((i) => sigOf(content, e.ring[role][i]!));
  const ts = { contentDigest: contentDigest(content), monotonic: body.monotonic, issuedAt, expiresAt };
  return { ...body, issuedAt, expiresAt, signatures, ...(o.noTimestamp ? {} : { timestamp: sigOf(ts, e.ring.timestamp[0]!) }) };
}

const policyBody = (monotonic: number, extra: object = {}, version = '2026.11') => ({ version, monotonic, keyEpoch: 1, pace: { stepDelayMs: [800, 2000] }, portalMode: { hometax: 'assisted' }, ...extra });
const statusBody = (monotonic: number, ceiling: Record<string, string>, kill: string[] = []) => ({ monotonic, keyEpoch: 1, portalModeCeiling: ceiling, killPlaybooks: kill });

describe('M4-7 레지스트리: 인덱스 2-of-3·버전·만료·채널', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  it('서로 다른 핀 키 2개 서명이면 게시, 공개 GET은 ETag 조건부·max-age=60', async () => {
    const entry = await stagePackage(e);
    const r = await e.put('/admin/v1/index/stable', index(e, { entries: [entry] }));
    assert.equal(r.status, 200, r.text);
    const g = await e.req('GET', '/registry/stable/index.json');
    assert.equal(g.status, 200);
    assert.equal(g.headers.get('cache-control'), 'public, max-age=60');
    const etag = g.headers.get('etag')!;
    assert.equal((await e.req('GET', '/registry/stable/index.json', { headers: { 'if-none-match': etag } })).status, 304);
    const p = await e.req('GET', `/packages/${entry.id}@${entry.version}.sxp`);
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
    const forged = { ...doc, signatures: [doc.signatures[0]!, sigOf(without(doc, ['signatures']), { id: 'package-2', priv: outsider })] };
    assert.equal((await e.put('/admin/v1/index/stable', forged)).json.error, 'registry.signature_insufficient');
    // 서명 뒤 내용 변경
    assert.equal((await e.put('/admin/v1/index/stable', { ...doc, monotonic: 2 })).json.error, 'registry.signature_insufficient');
    assert.equal((await e.req('PUT', '/admin/v1/index/stable', { body: doc })).json.error, 'registry.unauthorized');
    assert.equal((await e.req('PUT', '/admin/v1/index/stable', { headers: { authorization: 'Admin wrong' }, body: doc })).json.error, 'registry.unauthorized');
  });

  it('단조 버전: 같거나 낮으면, +1000 초과면 거부. keyEpoch가 핀과 다르면 거부', async () => {
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 5 }))).status, 200);
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 5 }))).json.error, 'registry.version_jump_rejected');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 4 }))).json.error, 'registry.version_jump_rejected');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 1006 }))).json.error, 'registry.version_jump_rejected');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 1005 }))).status, 200);
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { monotonic: 1006, keyEpoch: 2 }))).json.error, 'registry.signature_insufficient');
    // 채널은 따로 센다
    assert.equal((await e.put('/admin/v1/index/beta', index(e, { channel: 'beta', monotonic: 1 }))).status, 200);
    assert.equal((await e.put('/admin/v1/index/beta', index(e, { channel: 'stable', monotonic: 2 }))).json.error, 'request.param_rejected');
  });

  it('만료 ≤ 14일, 만료된 인덱스·5분 넘는 미래 발행 거부', async () => {
    const now = e.clock.now();
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { expiresAt: now + 14 * D + 1 }))).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { issuedAt: now - 8 * D, expiresAt: now - 1 }))).json.error, 'registry.expired');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { issuedAt: now + 6 * 60_000, expiresAt: now + D }))).json.error, 'registry.issued_in_future');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { issuedAt: now + 4 * 60_000, expiresAt: now + D }))).status, 200);
  });

  it('패키지: 인덱스 전에 올라와 있어야 하고 바이트가 다이제스트·크기와 같아야 한다. 같은 이름 덮어쓰기 금지, 위택스 거부', async () => {
    const entry = await stagePackage(e);
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, version: '9.9.9' }] }))).json.error, 'registry.not_found');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, packageDigest: '0'.repeat(64) }] }))).json.error, 'registry.content_digest_mismatch');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, size: entry.size + 1 }] }))).json.error, 'registry.content_digest_mismatch');
    assert.equal((await e.put(`/admin/v1/packages/${entry.id}@${entry.version}.sxp`, { data: randomBytes(10).toString('base64') })).json.error, 'registry.content_digest_mismatch');
    const wetax = await stagePackage(e, 'wetax_local_tax', '1.0.0', 'wetax');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [wetax] }))).json.error, 'registry.portal_blocked');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [entry, entry] }))).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [{ ...entry, rolloutPercent: 101 }] }))).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/packages/..%2Fx@1.0.0.sxp', { data: 'AAAA' })).status, 404);
    // 시행일 표 같은 데이터 패키지도 같은 경로(D14 M6-10)
    const data = { ...(await stagePackage(e, 'payroll_rate_tables', '1.0.1', 'public_api')), kind: 'data' };
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { entries: [entry, data] }))).status, 200);
  });
});

describe('M4-7 레지스트리: 폐기 목록·정책·status', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => e.server.close());

  const revokedAt = iso(Date.UTC(2026, 10, 9));
  const revoked = (e: Env, monotonic: number, ids: string[], o: { issuedAt?: number; ttl?: number } = {}) =>
    fresh(e, { monotonic, keyEpoch: 1, revoked: ids.map((keyId) => ({ keyId, role: keyId.split('-')[0], revokedAt })) }, 'root', [0, 1], { ttl: 12 * H, ...o });

  it('폐기 목록: 루트 2-of-3 + 24시간 신선도. 폐기된 키 서명은 세지 않고, 폐기는 되돌릴 수 없다', async () => {
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 1, ['package-1']))).status, 200);
    // package-1 + package-2 → package-1이 폐기라 유효 1개
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { signers: [0, 1] }))).json.error, 'registry.key_revoked');
    assert.equal((await e.put('/admin/v1/index/stable', index(e, { signers: [1, 2] }))).status, 200);
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, []))).json.error, 'registry.version_jump_rejected');
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, ['package-1'], { ttl: 25 * H }))).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, ['package-1'], { issuedAt: e.clock.now() - 13 * H }))).json.error, 'registry.revocation_stale');
    // 내용이 같은 재발행(같은 monotonic, 새 타임스탬프)은 받는다
    e.clock.advance(6 * H);
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 1, ['package-1']))).status, 200);
    const pk = fresh(e, { monotonic: 2, keyEpoch: 1, revoked: [] }, 'package', [0, 1]);
    assert.equal((await e.put('/admin/v1/revoked-keys', pk)).json.error, 'registry.signature_insufficient');
  });

  it('정책: 정책 키 2-of-3 + 타임스탬프, 72시간, {ver}.json = current.json, 내용 같은 재발행만 같은 monotonic', async () => {
    const p1 = fresh(e, policyBody(41), 'policy', [0, 2]);
    assert.equal((await e.put('/admin/v1/policy', p1)).status, 200);
    assert.equal((await e.req('GET', '/policy/current.json')).text, (await e.req('GET', '/policy/2026.11.json')).text);
    assert.equal((await e.req('GET', '/policy/current.json')).headers.get('cache-control'), 'public, max-age=60');
    // {ver}.json도 신선도 재발행으로 바뀌므로 불변 캐시가 아니다
    assert.equal((await e.req('GET', '/policy/2026.11.json')).headers.get('cache-control'), 'public, max-age=60');
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(42), 'policy', [0, 1], { noTimestamp: true }))).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(42), 'policy', [0, 1], { ttl: 73 * H }))).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(41, { portalMode: { hometax: 'auto' } }), 'policy', [0, 1]))).json.error, 'registry.version_jump_rejected');
    e.clock.advance(48 * H);
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(41), 'policy', [0, 2]))).status, 200);
    // 타임스탬프를 다른 내용 다이제스트에 붙이면 거부
    const p2 = fresh(e, policyBody(43, {}, '2026.11.1'), 'policy', [0, 1]);
    assert.equal((await e.put('/admin/v1/policy', { ...p2, timestamp: p1.timestamp })).json.error, 'registry.signature_insufficient');
    // 긴급 키 1개 서명본은 받되 표시한다(필드별 보수 판정은 엔진, D03 §7.1)
    // 이미 있는 버전 파일을 새 monotonic으로 덮어쓰지 않는다({ver}.json은 불변)
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(43), 'policy', [0, 1]))).json.error, 'registry.version_jump_rejected');
    const em = await e.put('/admin/v1/policy', fresh(e, policyBody(44, {}, '2026.11.2'), 'emergency', [0]));
    assert.deepEqual(em.json, { monotonic: 44, emergency: true });
    assert.equal((await e.put('/admin/v1/policy', fresh(e, { ...policyBody(45), version: 'x' }, 'policy', [0, 1]))).json.error, 'request.param_rejected');
  });

  it('status: 48시간, 긴급 키는 엄격하게 보수적인 변경(상한 하향·킬 추가)만', async () => {
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(1, { hometax: 'auto', gov24: 'assisted' }), 'policy', [0, 1]))).status, 200);
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(2, { hometax: 'auto', gov24: 'assisted' }), 'policy', [0, 1], { ttl: 49 * H }))).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(2, { hometax: 'auto', gov24: 'assisted' }), 'policy', [0, 1], { issuedAt: e.clock.now() - 25 * H }))).json.error, 'registry.status_stale');
    const em = (m: number, c: Record<string, string>, k: string[] = []) => e.put('/admin/v1/status', fresh(e, statusBody(m, c, k), 'emergency', [0]));
    assert.equal((await em(2, { hometax: 'auto', gov24: 'assisted' })).json.error, 'registry.not_conservative'); // 변화 없음
    assert.equal((await em(2, { hometax: 'auto', gov24: 'auto' })).json.error, 'registry.not_conservative'); // 상향
    assert.equal((await em(2, { hometax: 'postprocess' })).json.error, 'registry.not_conservative'); // gov24 상한이 빠짐 = 완화
    assert.equal((await em(2, { hometax: 'assisted', gov24: 'auto' })).json.error, 'registry.not_conservative'); // 하나 하향, 하나 상향
    const down = await em(2, { hometax: 'assisted', gov24: 'assisted', iros: 'postprocess' });
    assert.deepEqual(down.json, { monotonic: 2, emergency: true });
    assert.equal((await em(3, { hometax: 'assisted', gov24: 'assisted', iros: 'postprocess' }, ['hometax_cert_issue'])).status, 200);
    assert.equal((await em(4, { hometax: 'assisted', gov24: 'assisted', iros: 'postprocess' }, [])).json.error, 'registry.not_conservative'); // 킬 제거
    // 2-of-3은 상향도 할 수 있다
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(4, { hometax: 'auto' }), 'policy', [1, 2]))).status, 200);
    assert.equal((await e.put('/admin/v1/status', fresh(e, { ...statusBody(5, { hometax: 'fast' }) }, 'policy', [1, 2]))).json.error, 'request.param_rejected');
    // 프로토타입 이름은 모드가 아니다
    for (const m of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(5, { hometax: m }), 'policy', [1, 2]))).json.error, 'request.param_rejected', m);
  });

  it('타임스탬프 키 폐기: 그 키로 마지막 목록을 찍을 수 있고, 그 뒤 정책·status·폐기 목록은 그 키로 신선해질 수 없다', async () => {
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(1), 'policy', [0, 1]))).status, 200);
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 1, ['timestamp-1']))).status, 200);
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(2, {}, '2026.11.1'), 'policy', [0, 1]))).json.error, 'registry.key_revoked');
    // 같은 내용의 신선도 재발행도 막힌다(옛 내용 서명 + 새 타임스탬프로 영원히 신선하게 만들 수 없다)
    e.clock.advance(H);
    assert.equal((await e.put('/admin/v1/policy', fresh(e, policyBody(1), 'policy', [0, 1]))).json.error, 'registry.key_revoked');
    assert.equal((await e.put('/admin/v1/status', fresh(e, statusBody(1, { hometax: 'assisted' }), 'policy', [0, 1]))).json.error, 'registry.key_revoked');
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 1, ['timestamp-1']))).json.error, 'registry.key_revoked');
    assert.equal((await e.put('/admin/v1/revoked-keys', revoked(e, 2, ['timestamp-1', 'package-3']))).json.error, 'registry.key_revoked');
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
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.1.9'))).json.error, 'registry.version_jump_rejected');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.2.0'))).json.error, 'registry.version_jump_rejected');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.3.0', { ttl: 15 * D }))).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.3.0', { role: 'package' }))).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.3.0', { files: [{ url: 'x.exe\nevil: 1', sha512: sha512(), size: 1 }] }))).json.error, 'request.param_rejected');
    assert.equal((await e.put('/admin/v1/releases/stable', { ...r1, version: '1.3.0' })).json.error, 'registry.signature_insufficient');
    assert.equal((await e.put('/admin/v1/releases/stable', release(e, '1.3.0'))).status, 200);
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

  it('동시 게시는 하나씩: 같은 monotonic 인덱스 둘 중 하나만, 같은 키 동시 쓰기도 섞이지 않는다', async () => {
    const e = await start();
    const rs = await Promise.all([e.put('/admin/v1/index/stable', index(e, { monotonic: 7 })), e.put('/admin/v1/index/stable', index(e, { monotonic: 7 }))]);
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
    const n = Array.from({ length: 2000 }, () => randomUUID()).filter((d) => inRollout({ id: 'hometax_cert_issue', rolloutPercent: 10 }, d)).length;
    assert.ok(n > 120 && n < 280, String(n));
    assert.equal(inRollout({ id: 'x', rolloutPercent: 0 }, 'd'), false);
    assert.equal(inRollout({ id: 'x', rolloutPercent: 100 }, 'd'), true);
  });

  it('핀 키 설정: 역할별 개수, 역할 사이 키 재사용 금지, 공개키만', () => {
    const { trust } = makeRing();
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
