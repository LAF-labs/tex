// H-01 게시 도구(services/registry/src/publish, PUBLISH-H01.md, 팀장 지시 2026-11-09): 로컬 레지스트리(가짜 S3 + 함수 라우터 + 메모리 로그)로 끝까지.
// 서명은 시험 키(tests/fixtures/registry 공개 시드)로, 사용자가 칠 ceremony sign 명령을 도구가 출력한 그대로 돌린다.
// 게시 뒤 엔진(RegistrySync·loadPackage)이 받는지, 운영자 토큰이 출력·파일에 남지 않는지, dry-run은 PUT을 보내지 않는지 본다.
import assert from 'node:assert/strict';
import { createPrivateKey, sign as edSign } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { acceptPolicy, decodeSxp, loadPackage, type LoadedPackage, type Policy } from '@sax/engine/core';
import { POC_OVERRIDES, RegistrySync, memoryRegistryStore, trustRootsFromPin, type TrustPin } from '@sax/engine';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { Logger } from '../services/shared/src/index.ts';
import { RESIGN_TTL, buildRegistryDeploy, logSigningKey, registryRouter, resignAll, MemoryStore, type TrustRoot } from '../services/registry/src/index.ts';
import { main as ceremony, type CliDeps } from '../services/registry/src/ceremony/cli.ts';
import { signingBytes } from '../services/registry/src/ceremony/content.ts';
import { main as publish, nodeFs, type PublishCliDeps } from '../services/registry/src/publish/cli.ts';
import { appBundles, httpRegistry, shq, type RegistryClient } from '../services/registry/src/publish/pipeline.ts';
import { MemorySigner } from '../services/registry/src/publish/rehearsal.ts';
import { SAMPLE_SEEDS } from './registry-samples.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const TRUST_PATH = path.join(ROOT, 'tests/fixtures/registry/trust.json');
const TRUST = JSON.parse(fs.readFileSync(TRUST_PATH, 'utf8')) as TrustRoot;
const SOURCES = ['packages/engine/playbooks/hometax.invoice.lookup', 'packages/engine/playbooks/hometax.invoice.email_status', 'packages/engine/playbooks/hometax.invoice.issue'].map((p) => path.join(ROOT, p));
/** 원본 판(재게시마다 올라간다, scripts/h01-republish.mjs). 게시 경로 이름은 이 판을 따른다 */
const srcVersion = (dir: string) => (JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as { version: string }).version;
const V = { lookup: srcVersion(SOURCES[0]!), mail: srcVersion(SOURCES[1]!), issue: srcVersion(SOURCES[2]!) };
/** 정책 초안(팀장 결정 2026-11-09: 홈택스 auto, 요청률 상한은 ADR-025 PoC 값) */
const POLICY_PATH = path.join(ROOT, 'services/registry/policy/2026.11.json');
const TS_SEED = Buffer.alloc(32, SAMPLE_SEEDS.timestamp['timestamp-1']).toString('hex');
const ADMIN = 'admin-token-for-publish-test-0123456789';
const PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** 시험 시드 전부(서명 의식 키체인 대역). 타임스탬프 키는 넣지 않는다(서버 온라인 키) */
const signer = () => new MemorySigner(new Map(Object.entries(SAMPLE_SEEDS).filter(([r]) => r !== 'timestamp').flatMap(([, ids]) => Object.entries(ids).map(([id, s]) => [id, Buffer.alloc(32, s)] as const))));

/** 가짜 S3(경로 방식) + 공개 URL(없으면 Supabase처럼 400 NoSuchKey). put·get 횟수를 센다 */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type: string; cache: string }>();
  const counts = { put: 0, get: 0 };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const m = /^\/sax-registry\/(.+)$/.exec(req.url ?? '');
      const key = m ? decodeURIComponent(m[1]!) : '';
      if (!m || !String(req.headers.authorization ?? '').startsWith('AWS4-HMAC-SHA256 ')) return (res.writeHead(403), res.end());
      if (req.method === 'PUT') {
        counts.put++;
        objects.set(key, { body: Buffer.concat(chunks), type: String(req.headers['content-type']), cache: String(req.headers['cache-control']) });
        return (res.writeHead(200), res.end());
      }
      counts.get++;
      const o = objects.get(key);
      if (!o) return (res.writeHead(404), res.end());
      res.writeHead(200, { 'content-length': String(o.body.length), 'content-type': o.type });
      res.end(o.body);
    });
  });
  return { server, objects, counts };
}

/** 운영 모양: 공개 GET은 버킷(함수 밖), /registry/log/*·/admin/v1/*는 레지스트리 함수 라우터 */
async function localProd() {
  const s3 = fakeS3();
  await new Promise<void>((r) => s3.server.listen(0, '127.0.0.1', r));
  const s3Origin = `http://127.0.0.1:${(s3.server.address() as AddressInfo).port}`;
  const events: string[] = [];
  const built = await buildRegistryDeploy(
    { TRUST_ROOT_JSON: JSON.stringify(TRUST), REGISTRY_LOG_SIGNING_KEY: TS_SEED, REGISTRY_ADMIN_TOKEN: ADMIN, REGISTRY_STORE: 'memory', S3_ENDPOINT: s3Origin, S3_REGION: 'ap-northeast-2', S3_BUCKET: 'sax-registry', S3_ACCESS_KEY_ID: 'ak-test', S3_SECRET_ACCESS_KEY: 'sk-test-value' },
    { logger: new Logger('registry', (l) => events.push(l)) },
  );
  const front = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    if ((req.method === 'GET' && u.pathname.startsWith('/registry/log/')) || (req.method === 'PUT' && u.pathname.startsWith('/admin/v1/'))) return void built.listener(req, res);
    if (req.method !== 'GET') return (res.writeHead(405), res.end());
    const o = s3.objects.get(decodeURIComponent(u.pathname.slice(1)));
    if (!o) return (res.writeHead(400, { 'content-type': 'application/json' }), res.end('{"statusCode":"404","error":"not_found","message":"Object not found","code":"NoSuchKey"}'));
    res.writeHead(200, { 'content-type': o.type, 'cache-control': o.cache, 'content-length': String(o.body.length) });
    res.end(o.body);
  });
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${(front.address() as AddressInfo).port}`;
  return {
    origin,
    s3,
    events,
    built,
    close: async () => {
      await new Promise<void>((r) => front.close(() => r()));
      await new Promise<void>((r) => s3.server.close(() => r()));
      await built.close();
    },
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sax-publish-'));

function cliDeps(lines: string[], token = ADMIN): PublishCliDeps {
  return { fs: nodeFs, out: (l) => lines.push(l), now: () => Date.now(), registry: (o) => httpRegistry(o), secret: () => Promise.resolve(token), env: {} };
}

function ceremonyDeps(lines: string[]): CliDeps {
  const s = signer();
  return {
    backend: () => s,
    passphrase: () => Promise.reject(new Error('no')),
    out: (l) => lines.push(l),
    env: {},
    read: (p) => fs.readFileSync(p),
    write: (p, d) => fs.writeFileSync(p, d, { flag: 'wx' }),
    now: () => new Date(),
  };
}

/** 도구가 출력한 사용자 서명 명령을 그대로 돌린다(ceremony sign, 시험 키) */
async function runPrinted(lines: string[]): Promise<number> {
  const prefix = 'node --conditions=development services/registry/src/ceremony/cli.ts ';
  const cmds = lines.map((l) => l.trim()).filter((l) => l.startsWith(prefix));
  for (const c of cmds) assert.equal(await ceremony(shellWords(c.slice(prefix.length)), ceremonyDeps([])), 0, c);
  return cmds.length;
}

/** 셸이 하는 만큼만 낱말로 나눈다: 공백 구분, '…'(POSIX, '\\'' 이어 붙이기)·"…"(Windows) 인용을 벗긴다 */
function shellWords(c: string, platform: NodeJS.Platform = process.platform): string[] {
  const out: string[] = [];
  let cur = '';
  let open = false;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i]!;
    if (ch === ' ') {
      if (open) out.push(cur);
      cur = '';
      open = false;
    } else if (ch === "'" || ch === '"') {
      const j = c.indexOf(ch, i + 1);
      assert.ok(j > i, `닫히지 않은 인용: ${c}`);
      cur += c.slice(i + 1, j);
      open = true;
      i = j;
    } else if (ch === '\\' && platform !== 'win32') {
      cur += c[++i] ?? '';
      open = true;
    } else {
      cur += ch;
      open = true;
    }
  }
  if (open) out.push(cur);
  return out;
}

/** 루트 2개로 서명한 폐기 목록(서명 의식 산출물 모양: 신선도 필드는 있지만 낡았다, timestamp 없음) */
function rootSignedRevoked(): Record<string, unknown> {
  const doc: Record<string, unknown> = { revoked: [{ keyId: 'package-0', role: 'package', revokedAt: '2026-11-06T07:52:13Z' }], monotonic: 1, keyEpoch: 1, issuedAt: '2026-11-06T07:52:13Z', expiresAt: '2026-11-07T07:52:13Z', signatures: [] };
  const bytes = signingBytes('revoked_keys', doc);
  doc.signatures = (['root-1', 'root-2'] as const).map((id) => ({ keyId: id, alg: 'ed25519', sig: edSign(null, bytes, createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, SAMPLE_SEEDS.root[id])]), format: 'der', type: 'pkcs8' })).toString('base64url') }));
  return doc;
}

const read = (p: string) => fs.readFileSync(p, 'utf8');
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));

describe('H-01 게시 도구: 로컬 레지스트리(가짜 S3)로 끝까지', () => {
  let prod: Awaited<ReturnType<typeof localProd>>;
  let dir: string;
  const out: string[] = [];
  before(async () => {
    prod = await localProd();
    dir = tmp();
  });
  after(async () => {
    await prod.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('dry-run: 레지스트리는 읽기만(가짜 S3 PUT 0, 로그 0), 리허설은 임시 키로 6건을 로컬에 게시·증명한다', async () => {
    const revokedFile = path.join(dir, 'revoked.signed.json');
    fs.writeFileSync(revokedFile, JSON.stringify(rootSignedRevoked()));
    const lines: string[] = [];
    const code = await publish(['dry-run', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 'dry'), '--revoked', revokedFile, '--policy', POLICY_PATH, '--ceiling', 'hometax=auto', ...SOURCES], cliDeps(lines));
    assert.equal(code, 0);
    assert.equal(prod.s3.counts.put, 0, '운영 모양 레지스트리에 쓰지 않는다');
    assert.equal(prod.s3.objects.size, 0);
    assert.equal((await prod.built.log.head()).treeSize, 0);
    assert.ok(lines.some((l) => l.startsWith('리허설: 임시 키 서명 14번, 게시 8건')), lines.join('\n'));
    // 리허설 핀은 실제 핀과 keyId·keyEpoch가 같고 공개키는 다르다
    const eph = JSON.parse(read(path.join(dir, 'dry/rehearsal/trust.json'))) as TrustRoot;
    assert.deepEqual(Object.fromEntries(Object.entries(eph.keys).map(([r, k]) => [r, Object.keys(k)])), Object.fromEntries(Object.entries(TRUST.keys).map(([r, k]) => [r, Object.keys(k)])));
    assert.notEqual(eph.keys.package['package-1'], TRUST.keys.package['package-1']);
    out.push(...lines);
  });

  it('prepare → ceremony sign(출력된 명령 그대로) → assemble → sign → push: 폐기 목록·status·패키지 3개·인덱스, 되읽기·로그 증명, 기록', async () => {
    const work = path.join(dir, 'real');
    const revokedFile = path.join(dir, 'revoked.signed.json');
    const p: string[] = [];
    assert.equal(await publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', work, '--revoked', revokedFile, '--policy', POLICY_PATH, '--ceiling', 'hometax=auto', ...SOURCES], cliDeps(p)), 0);
    // dry-run이 보인 manifest 확인 코드 = 실제 준비의 확인 코드(서명 입력은 서명과 무관하다)
    const codes = (ls: string[]) => ls.filter((l) => /@\d+\.\d+\.\d+\(.*확인 코드/.test(l)).map((l) => l.trim());
    assert.deepEqual(codes(p), codes(out));
    assert.equal(codes(p).length, 3);
    assert.ok(p.some((l) => l.includes('revoked_keys monotonic 1: 루트 2개 서명이 이미 있다')));
    assert.ok(p.some((l) => /^ {2}policy monotonic 1 확인 코드 /.test(l)), p.join('\n'));
    // 순서: 패키지(package 키) → 정책(policy 키) → status(policy 키)
    const kinds = p.filter((l) => l.includes(' sign --kind ')).map((l) => /--kind (\S+)/.exec(l)![1]);
    assert.deepEqual(kinds, ['manifest', 'manifest', 'manifest', 'manifest', 'manifest', 'manifest', 'policy', 'policy', 'status', 'status']);
    assert.equal(await runPrinted(p), 10, 'manifest 3개 × package 2 + 정책 × policy 2 + status × policy 2');

    const a: string[] = [];
    assert.equal(await publish(['assemble', '--trust', TRUST_PATH, '--work', work], cliDeps(a)), 0);
    assert.ok(a.some((l) => /^인덱스 stable monotonic 1, /.test(l)), a.join('\n'));
    assert.equal(await runPrinted(a), 2);

    const u: string[] = [];
    assert.equal(await publish(['push', '--trust', TRUST_PATH, '--work', work], cliDeps(u)), 0);
    const record = JSON.parse(read(path.join(work, 'record.json'))) as { published: Array<{ kind: string; path: string; logIndex: number }>; logHead: { before: number; after: number } };
    assert.deepEqual(record.published.map((x) => x.path), ['registry/revoked_keys.json', 'policy/2026.11.json', 'policy/current.json', 'registry/status.json', `packages/hometax.invoice.lookup@${V.lookup}.sxp`, `packages/hometax.invoice.email_status@${V.mail}.sxp`, `packages/hometax.invoice.issue@${V.issue}.sxp`, 'registry/stable/index.json']);
    assert.deepEqual(record.published.map((x) => x.logIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(record.logHead, { ...record.logHead, before: 0, after: 8 });

    // 버킷: 패키지는 불변 캐시, 서버가 붙인 타임스탬프(첫 게시 도장)
    assert.equal(prod.s3.objects.get(`packages/hometax.invoice.issue@${V.issue}.sxp`)?.cache, 'public, max-age=31536000, immutable');
    const status = JSON.parse(prod.s3.objects.get('registry/status.json')!.body.toString()) as { timestamp: { keyId: string }; portalModeCeiling: unknown };
    assert.equal(status.timestamp.keyId, 'timestamp-1');
    assert.deepEqual(status.portalModeCeiling, { hometax: 'auto' });
    // 폐기 목록·정책·status·인덱스(ADR-043) 넷 다 서버가 신선도를 붙였다. 사용자가 서명한 인덱스 초안에는 기간이 없다
    assert.equal(prod.events.filter((l) => l.includes('registry.stamped_on_publish')).length, 4);
    const draft = JSON.parse(read(path.join(work, 'index.json'))) as Record<string, unknown>;
    assert.deepEqual(['issuedAt', 'expiresAt', 'timestamp'].filter((k) => k in draft), []);
    const ix = JSON.parse(prod.s3.objects.get('registry/stable/index.json')!.body.toString()) as { issuedAt: string; expiresAt: string; timestamp: { keyId: string } };
    assert.equal(ix.timestamp.keyId, 'timestamp-1');
    assert.equal(Date.parse(ix.expiresAt) - Date.parse(ix.issuedAt), RESIGN_TTL.index);

    // 토큰은 출력·작업 폴더·서버 로그 어디에도 없다
    for (const l of [...p, ...a, ...u, ...prod.events]) assert.ok(!l.includes(ADMIN));
    for (const f of walk(work)) assert.ok(!fs.readFileSync(f).includes(ADMIN), f);
  });

  it('엔진이 받는다: RegistrySync(폐기 목록·status·인덱스)·acceptPolicy와 loadPackage(조회 2개 → H-01, 앱 내장 번들 허용 목록)', async () => {
    const pin = TRUST as unknown as TrustPin;
    const sync = new RegistrySync({
      trust: pin,
      store: memoryRegistryStore(),
      sinks: [],
      fetch: async (p, o) => {
        const r = await fetch(prod.origin + p, { headers: o.etag ? { 'if-none-match': o.etag } : {} });
        return { status: r.status === 400 ? 404 : r.status, body: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get('etag') ?? undefined };
      },
    });
    const r = await sync.sync();
    assert.deepEqual({ revoked: r.revoked, status: r.status, index: r.index, fresh: r.revokedFresh }, { revoked: 'accepted', status: 'accepted', index: 'accepted', fresh: true });
    assert.deepEqual(sync.status().portalModeCeiling, { hometax: 'auto' });
    // 정책(D03 §7.1): 엔진이 받고, 홈택스 auto, 요청률은 ADR-025 PoC 값
    const pol = JSON.parse(Buffer.from(await (await fetch(`${prod.origin}/policy/current.json`)).arrayBuffer()).toString()) as Policy;
    const ap = acceptPolicy(pol, { roots: trustRootsFromPin(pin), revoked: new Set(['package-0']), current: null, hold: false, now: Date.now() });
    assert.ok(ap.ok, ap.ok ? '' : ap.code);
    assert.equal(pol.portalMode.hometax, 'auto');
    assert.equal(pol.monotonic, 1);

    const index = JSON.parse(prod.s3.objects.get('registry/stable/index.json')!.body.toString()) as { entries: Array<{ id: string; version: string; kind: string }> };
    assert.deepEqual(index.entries.map((e) => `${e.id}@${e.version}:${e.kind}`), [`hometax.invoice.email_status@${V.mail}:lookup`, `hometax.invoice.issue@${V.issue}:playbook`, `hometax.invoice.lookup@${V.lookup}:lookup`]);
    const installed = new Map<string, LoadedPackage>();
    for (const name of [`hometax.invoice.lookup@${V.lookup}`, `hometax.invoice.email_status@${V.mail}`, `hometax.invoice.issue@${V.issue}`]) {
      const b = Buffer.from(await (await fetch(`${prod.origin}/packages/${name}.sxp`)).arrayBuffer());
      const d = decodeSxp(b);
      assert.ok(d.ok && d.sxp.kind === 'package');
      const l = loadPackage(d.sxp.raw, { roots: trustRootsFromPin(pin), revoked: new Set(['package-0']), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: appBundles(), installedLookups: installed, storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.now() });
      assert.ok(l.ok, `${name} ${l.ok ? '' : l.code}`);
      installed.set(l.pkg.files.manifest.id, l.pkg);
    }
    assert.deepEqual(installed.get('hometax.invoice.issue')!.lookupDigests, [installed.get('hometax.invoice.lookup')!.manifestDigest, installed.get('hometax.invoice.email_status')!.manifestDigest]);
  });

  it('두 번째 게시: 같은 패키지는 서명 없이 이어 두고 인덱스만 monotonic 2, 같은 버전에 다른 내용은 거부', async () => {
    const p: string[] = [];
    assert.equal(await publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 'again'), '--policy', POLICY_PATH, ...SOURCES], cliDeps(p)), 0);
    assert.equal(p.filter((l) => l.includes('이미 게시됨(서명 없음)')).length, 3);
    assert.ok(p.some((l) => l.includes('정책 2026.11 monotonic 1: 레지스트리에 같은 내용이 있다')), p.join('\n'));
    assert.equal(await runPrinted(p), 0);
    // 준비한 뒤 cron이 인덱스 신선도를 다시 서명해도(바이트만 바뀜) 내용이 같으니 이어 간다(ADR-043)
    const before = prod.s3.objects.get('registry/stable/index.json')!.body;
    const later = Date.now() + 30 * 3_600_000;
    const rr = await resignAll({ store: prod.built.store, trust: prod.built.trust, log: prod.built.log, signer: logSigningKey(TS_SEED, prod.built.trust), now: () => later });
    assert.equal(rr.index.stable, 'resigned');
    assert.ok(!prod.s3.objects.get('registry/stable/index.json')!.body.equals(before));
    const a: string[] = [];
    assert.equal(await publish(['assemble', '--trust', TRUST_PATH, '--work', path.join(dir, 'again')], cliDeps(a)), 0);
    assert.ok(a.some((l) => l.startsWith('인덱스 stable monotonic 2')));
    assert.equal(await runPrinted(a), 2);
    assert.equal(await publish(['push', '--trust', TRUST_PATH, '--work', path.join(dir, 'again')], cliDeps([])), 0);
    const rec = JSON.parse(read(path.join(dir, 'again/record.json'))) as { published: Array<{ path: string }> };
    assert.deepEqual(rec.published.map((x) => x.path), ['registry/stable/index.json']);

    // 같은 버전에 다른 playbook 바이트 → 버전을 올리라고 거부
    const changed = path.join(dir, 'h01-changed');
    fs.cpSync(SOURCES[2]!, changed, { recursive: true });
    fs.appendFileSync(path.join(changed, 'playbook.json'), '\n');
    await assert.rejects(publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 'changed'), SOURCES[0]!, SOURCES[1]!, changed], cliDeps([])), /publish\.version_exists/);
  });
});

describe('H-01 게시 도구: 거부(서명 전·서명 뒤·게시 직전)', () => {
  let prod: Awaited<ReturnType<typeof localProd>>;
  let dir: string;
  before(async () => {
    prod = await localProd();
    dir = tmp();
  });
  after(async () => {
    await prod.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const prep = (work: string, sources = SOURCES, extra: string[] = []) => publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, work), ...extra, ...sources], cliDeps([]));
  const copySrc = (name: string, edit: (m: Record<string, unknown>) => void) => {
    const d = path.join(dir, name);
    fs.cpSync(SOURCES[2]!, d, { recursive: true });
    const m = JSON.parse(read(path.join(d, 'manifest.json'))) as Record<string, unknown>;
    edit(m);
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(m));
    return d;
  };

  it('엔진이 받지 않을 패키지는 서명 전에 멈춘다: 번들 다이제스트, 조회 없음, fixture·위택스 포털, 틀린 버전 형식', async () => {
    await assert.rejects(prep('b', [SOURCES[0]!, SOURCES[1]!, copySrc('bundle', (m) => ((m.bundlesUsed as Array<{ digest: string }>)[0]!.digest = '0'.repeat(64)))]), new RegExp(`publish\\.engine_rejected: hometax\\.invoice\\.issue@${V.issue.replaceAll('.', '\\.')} loader\\.bundle_not_allowed BV-06`));
    await assert.rejects(prep('l', [SOURCES[2]!]), /publish\.lookup_missing/);
    await assert.rejects(prep('f', [copySrc('fixture', (m) => (m.portal = 'fixture'))]), /registry\.portal_blocked/);
    await assert.rejects(prep('w', [copySrc('wetax', (m) => (m.portal = 'wetax'))]), /registry\.portal_blocked/);
    await assert.rejects(prep('v', [copySrc('ver', (m) => (m.version = '2.1'))]), /publish\.source_invalid/);
    await assert.rejects(prep('k', SOURCES, ['--ceiling', 'hometax=full']), /ceremony\.usage/);
    assert.equal(prod.s3.counts.put, 0);
  });

  it('서명 뒤: manifest를 바꾸면, 서명이 하나뿐이면, 다른 문서 서명이면 assemble이 거부한다', async () => {
    const lines: string[] = [];
    assert.equal(await publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 's'), ...SOURCES], cliDeps(lines)), 0);
    await runPrinted(lines);
    const asm = () => publish(['assemble', '--trust', TRUST_PATH, '--work', path.join(dir, 's')], cliDeps([]));
    const sig2 = path.join(dir, `s/sig/hometax.invoice.issue@${V.issue}.package-2.json`);
    const keep = read(sig2);
    fs.rmSync(sig2);
    await assert.rejects(asm(), /ceremony\.quorum_short/);
    fs.writeFileSync(sig2, read(path.join(dir, `s/sig/hometax.invoice.lookup@${V.lookup}.package-2.json`)));
    await assert.rejects(asm(), /ceremony\.wrong_document/);
    fs.writeFileSync(sig2, keep);
    const mf = path.join(dir, `s/manifests/hometax.invoice.issue@${V.issue}.json`);
    const m = JSON.parse(read(mf)) as { title: string };
    const orig = read(mf);
    m.title = 'invoice.other';
    fs.writeFileSync(mf, JSON.stringify(m));
    await assert.rejects(asm(), /ceremony\.wrong_document/);
    fs.writeFileSync(mf, orig);
    assert.equal(await asm(), 0);
  });

  it('게시 직전: 틀린 토큰은 아무것도 올리지 않고, 준비 뒤 인덱스가 바뀌면 멈춘다', async () => {
    const work = path.join(dir, 's');
    const lines: string[] = [];
    // 인덱스 서명(앞 시험의 assemble 출력이 없으니 다시 출력을 만들지 않고 서명 명령을 직접 짓는다)
    const confirm = (JSON.parse(read(path.join(work, 'assembled.json'))) as { indexConfirm: string }).indexConfirm;
    for (const k of ['package-1', 'package-2']) lines.push(`node --conditions=development services/registry/src/ceremony/cli.ts sign --kind index --key-id ${k} --confirm ${confirm} --trust ${TRUST_PATH} --out ${path.join(work, `sig/index.${k}.json`)} ${path.join(work, 'index.json')}`);
    await runPrinted(lines);
    await assert.rejects(publish(['push', '--trust', TRUST_PATH, '--work', work], cliDeps([], 'wrong-token-wrong-token-1234')), /registry\.unauthorized/);
    assert.equal(prod.s3.counts.put, 0);
    assert.equal((await prod.built.log.head()).treeSize, 0);

    // 다른 운영자가 그사이 인덱스를 올렸다(빈 인덱스, 같은 시험 키) → 이 계획은 낡았다
    const other: string[] = [];
    assert.equal(await publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 'o'), SOURCES[0]!], cliDeps(other)), 0);
    await runPrinted(other);
    const oa: string[] = [];
    await publish(['assemble', '--trust', TRUST_PATH, '--work', path.join(dir, 'o')], cliDeps(oa));
    await runPrinted(oa);
    assert.equal(await publish(['push', '--trust', TRUST_PATH, '--work', path.join(dir, 'o')], cliDeps([])), 0);
    const puts = prod.s3.counts.put;
    await assert.rejects(publish(['push', '--trust', TRUST_PATH, '--work', work], cliDeps([])), /publish\.index_changed/);
    assert.equal(prod.s3.counts.put, puts);
  });

  it('정책 초안: 엔진 스키마 통과, 홈택스 auto·나머지 postprocess, 홈택스 상한 = ADR-025 PoC 값, 같은 버전에 다른 내용·스키마 위반은 서명 전에 거부', async () => {
    const draft = JSON.parse(read(POLICY_PATH)) as Policy;
    assert.deepEqual(draft.portalMode, { hometax: 'auto', gov24: 'postprocess', wetax: 'postprocess', sminfo: 'postprocess', insure4: 'postprocess' });
    const L = draft.limits.hometax!;
    assert.deepEqual([L.runsPerDayPerProfile, L.irreversiblePerDayPerProfile, L.loginsPerDay, draft.cooldown.positiveDetectionsForCooldown], [POC_OVERRIDES.runsPerDayPerProfile, POC_OVERRIDES.irreversiblePerDayPerProfile, POC_OVERRIDES.loginsPerDay, POC_OVERRIDES.positiveDetectionsForCooldown]);
    for (const k of ['monotonic', 'keyEpoch', 'issuedAt', 'expiresAt', 'timestamp', 'signatures']) assert.ok(!(k in draft), k);
    // 스키마 위반(홈택스 동시 실행 2)
    const bad = path.join(dir, 'policy-bad.json');
    fs.writeFileSync(bad, JSON.stringify({ ...draft, limits: { ...draft.limits, hometax: { ...L, concurrent: 2 } } }));
    await assert.rejects(publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 'pbad'), '--policy', bad], cliDeps([])), /publish\.policy_invalid/);
    // 정책만 게시(서명 2번) → 같은 버전에 다른 내용은 version을 올리라고 거부
    const p: string[] = [];
    assert.equal(await publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 'pol'), '--policy', POLICY_PATH], cliDeps(p)), 0);
    assert.equal(await runPrinted(p), 2);
    assert.equal(await publish(['push', '--trust', TRUST_PATH, '--work', path.join(dir, 'pol')], cliDeps([])), 0);
    const changed = path.join(dir, 'policy-changed.json');
    fs.writeFileSync(changed, JSON.stringify({ ...draft, limits: { ...draft.limits, hometax: { ...L, runsPerDayPerProfile: 10 } } }));
    await assert.rejects(publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 'pchg'), '--policy', changed], cliDeps([])), /publish\.policy_version_exists/);
    fs.writeFileSync(changed, JSON.stringify({ ...draft, version: '2026.11.1', limits: { ...draft.limits, hometax: { ...L, runsPerDayPerProfile: 10 } } }));
    const q: string[] = [];
    assert.equal(await publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', path.join(dir, 'pchg2'), '--policy', changed], cliDeps(q)), 0);
    assert.ok(q.some((l) => /^ {2}policy monotonic 2 확인 코드 /.test(l)), q.join('\n'));
  });

  it('출력 명령의 경로 인용: POSIX는 작은따옴표, Windows는 큰따옴표(\\·드라이브 문자는 그대로), 셸 낱말로 되돌리면 같은 경로', () => {
    assert.equal(shq('/Users/me/sax-publish/h01-1/manifests/hometax.invoice.lookup@1.0.0.json', 'darwin'), '/Users/me/sax-publish/h01-1/manifests/hometax.invoice.lookup@1.0.0.json');
    assert.equal(shq("/tmp/a b/it's.json", 'darwin'), "'/tmp/a b/it'\\''s.json'");
    assert.deepEqual(shellWords(`--out ${shq("/tmp/a b/it's.json", 'darwin')} x`, 'darwin'), ['--out', "/tmp/a b/it's.json", 'x']);
    const win = 'C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\sax-publish-x\\manifests\\hometax.invoice.lookup@1.0.0.json';
    assert.equal(shq(win, 'win32'), win);
    assert.equal(shq('C:\\Program Files\\sax\\trust.json', 'win32'), '"C:\\Program Files\\sax\\trust.json"');
    assert.throws(() => shq('C:\\a"b', 'win32'), /publish\.path_invalid/);
    assert.deepEqual(shellWords(`--out ${shq('C:\\Program Files\\x.json', 'win32')} ${shq(win, 'win32')}`, 'win32'), ['--out', 'C:\\Program Files\\x.json', win]);
  });

  it('레지스트리 origin은 https(시험만 127.0.0.1·localhost), 경로·쿼리·사용자 정보 없음', () => {
    for (const bad of ['http://tax.laf-co.com', 'https://tax.laf-co.com/x', 'https://u:p@tax.laf-co.com', 'https://tax.laf-co.com?a=1', 'ftp://x']) assert.throws(() => httpRegistry(bad), /publish\.registry_invalid/);
    assert.equal(httpRegistry('https://tax.laf-co.com/').origin, 'https://tax.laf-co.com');
  });
});

describe('게시 관문 첫 게시 도장(CEREMONY.md §5·§6 "타임스탬프는 서버가 붙인다")', () => {
  const status = (o: Record<string, unknown> = {}) => {
    const doc: Record<string, unknown> = { monotonic: 1, keyEpoch: 1, portalModeCeiling: { hometax: 'auto' }, killPlaybooks: [], signatures: [], ...o };
    const bytes = signingBytes('status', doc);
    doc.signatures = (['policy-1', 'policy-2'] as const).map((id) => ({ keyId: id, alg: 'ed25519', sig: edSign(null, bytes, createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, SAMPLE_SEEDS.policy[id])]), format: 'der', type: 'pkcs8' })).toString('base64url') }));
    return doc;
  };

  it('timestamp 없는 status: 도장 키가 있으면 붙여 받고, 없으면 거부, 틀린 timestamp는 다시 찍지 않고 거부', async () => {
    const built = await buildRegistryDeploy({ TRUST_ROOT_JSON: JSON.stringify(TRUST), REGISTRY_LOG_SIGNING_KEY: TS_SEED, REGISTRY_ADMIN_TOKEN: ADMIN, REGISTRY_STORE: 'memory' }, { store: new MemoryStore(), logger: new Logger('t', () => undefined) });
    const server = http.createServer((req, res) => void built.listener(req, res));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = httpRegistry(origin);
    try {
      const bad = await client.put('/admin/v1/status', { ...status(), timestamp: { keyId: 'timestamp-1', alg: 'ed25519', sig: 'A'.repeat(86) }, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString() }, ADMIN);
      assert.deepEqual([bad.status, bad.body.error], [422, 'registry.timestamp_invalid']);
      const ok = await client.put('/admin/v1/status', status(), ADMIN);
      assert.deepEqual([ok.status, ok.body], [200, { monotonic: 1, emergency: false }]);
      const stored = JSON.parse((await client.get('/registry/status.json'))!.toString()) as { issuedAt: string; expiresAt: string; timestamp: { keyId: string } };
      assert.equal(Date.parse(stored.expiresAt) - Date.parse(stored.issuedAt), 48 * 3600_000);
      assert.equal(stored.timestamp.keyId, 'timestamp-1');
      // 정책 키가 아닌 서명(패키지 키)은 도장을 찍어도 관문이 거부한다(도장은 신선도뿐, 내용 서명 권한이 아니다)
      const pkgSigned = status({ monotonic: 2 });
      const bytes = signingBytes('status', pkgSigned);
      pkgSigned.signatures = (['package-1', 'package-2'] as const).map((id) => ({ keyId: id, alg: 'ed25519', sig: edSign(null, bytes, createPrivateKey({ key: Buffer.concat([PKCS8, Buffer.alloc(32, SAMPLE_SEEDS.package[id])]), format: 'der', type: 'pkcs8' })).toString('base64url') }));
      const unsigned = await client.put('/admin/v1/status', pkgSigned, ADMIN);
      assert.deepEqual([unsigned.status, unsigned.body.error], [422, 'registry.signature_insufficient']);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await built.close();
    }
    // 도장 키 없는 라우터(stamper 없음): timestamp가 없으면 스키마부터 거부
    const plain = registryRouter({ store: new MemoryStore(), trust: TRUST, adminToken: ADMIN, now: Date.now });
    const s2 = http.createServer((req, res) => void import('../services/shared/src/index.ts').then(({ requestListener }) => requestListener(plain, { logger: new Logger('t', () => undefined) })(req, res)));
    await new Promise<void>((r) => s2.listen(0, '127.0.0.1', r));
    try {
      const r = await httpRegistry(`http://127.0.0.1:${(s2.address() as AddressInfo).port}`).put('/admin/v1/status', status(), ADMIN);
      assert.equal(r.status, 422);
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
  });
});

describe('H-01 게시 도구: push 중간 실패 뒤 같은 폴더로 다시', () => {
  it('인덱스 PUT 직전에 끊겨도 다시 push하면 끝난다(패키지는 같은 바이트라 로그에 다시 쓰지 않고, 앞선 항목으로 증명)', async () => {
    const prod = await localProd();
    const dir = tmp();
    try {
      const work = path.join(dir, 'w');
      const revokedFile = path.join(dir, 'revoked.json');
      fs.writeFileSync(revokedFile, JSON.stringify(rootSignedRevoked()));
      const p: string[] = [];
      assert.equal(await publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', work, '--revoked', revokedFile, '--ceiling', 'hometax=auto', ...SOURCES], cliDeps(p)), 0);
      await runPrinted(p);
      const a: string[] = [];
      assert.equal(await publish(['assemble', '--trust', TRUST_PATH, '--work', work], cliDeps(a)), 0);
      await runPrinted(a);
      const flaky: PublishCliDeps = {
        ...cliDeps([]),
        registry: (o) => {
          const c = httpRegistry(o);
          return { ...c, origin: c.origin, put: (pp, b, t) => (pp.startsWith('/admin/v1/index/') ? Promise.reject(new Error('net')) : c.put(pp, b, t)) };
        },
      };
      await assert.rejects(publish(['push', '--trust', TRUST_PATH, '--work', work], flaky), /net/);
      assert.ok(prod.s3.objects.has(`packages/hometax.invoice.issue@${V.issue}.sxp`));
      assert.ok(!prod.s3.objects.has('registry/stable/index.json'));
      assert.equal(await publish(['push', '--trust', TRUST_PATH, '--work', work], cliDeps([])), 0);
      const rec = JSON.parse(read(path.join(work, 'record.json'))) as { published: Array<{ path: string; logIndex: number }> };
      assert.equal(rec.published.length, 6);
      // 첫 시도: 폐기 목록 0, status 1, 패키지 2·3·4. 다시: 폐기 목록·status 재도장 5·6, 패키지는 앞선 항목, 인덱스 7
      assert.deepEqual(rec.published.map((x) => x.logIndex), [5, 6, 2, 3, 4, 7]);
    } finally {
      await prod.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Vercel CDN 대역: 조회 주기 파일(head·status·폐기 목록·정책·인덱스, max-age=60)을 가상 시계로 60초 캐시한다(404도). frozenHead면 head는 끝까지 처음 것 */
function cdnRegistry(origin: string, clock: { t: number }, o: { frozenHead?: boolean } = {}): RegistryClient {
  const c = httpRegistry(origin);
  const cache = new Map<string, { at: number; body: Buffer | null }>();
  const polled = (p: string) => p === '/registry/log/head.json' || p === '/registry/status.json' || p === '/registry/revoked_keys.json' || /^\/registry\/[a-z]+\/index\.json$/.test(p) || p.startsWith('/policy/');
  return {
    ...c,
    origin: c.origin,
    async get(p) {
      if (!polled(p)) return c.get(p);
      const hit = cache.get(p);
      if (hit && (clock.t - hit.at < 60_000 || (o.frozenHead && p === '/registry/log/head.json'))) return hit.body;
      const body = await c.get(p);
      cache.set(p, { at: clock.t, body });
      return body;
    },
  };
}

describe('H-01 게시 도구: 공개 GET이 CDN 캐시일 때(운영 2026-11-09 18:18 publish.log_invalid)', () => {
  const setup = async (prod: Awaited<ReturnType<typeof localProd>>, dir: string) => {
    const work = path.join(dir, 'w');
    const revokedFile = path.join(dir, 'revoked.json');
    fs.writeFileSync(revokedFile, JSON.stringify(rootSignedRevoked()));
    const p: string[] = [];
    assert.equal(await publish(['prepare', '--registry', prod.origin, '--trust', TRUST_PATH, '--work', work, '--revoked', revokedFile, '--policy', POLICY_PATH, '--ceiling', 'hometax=auto', ...SOURCES], cliDeps(p)), 0);
    await runPrinted(p);
    const a: string[] = [];
    assert.equal(await publish(['assemble', '--trust', TRUST_PATH, '--work', work], cliDeps(a)), 0);
    await runPrinted(a);
    return work;
  };
  const viaCdn = (clock: { t: number }, sleeps: number[], o: { frozenHead?: boolean } = {}): PublishCliDeps => ({
    ...cliDeps([]),
    registry: (origin) => cdnRegistry(origin, clock, o),
    settle: { sleep: async (ms) => void (sleeps.push(ms), (clock.t += ms)) },
  });
  type Rec = { published: Array<{ path: string; logIndex: number }>; logHead: { before: number | null; after: number } };

  it('push는 head·되읽기가 옛 캐시면 다시 읽어(최대 약 90초) 끝까지 간다', async () => {
    const prod = await localProd();
    const dir = tmp();
    try {
      const work = await setup(prod, dir);
      const clock = { t: 0 };
      const sleeps: number[] = [];
      const deps = viaCdn(clock, sleeps);
      // push가 시작할 때 읽은 head(treeSize 0)·404가 캐시에 남는다
      assert.equal(await publish(['push', '--trust', TRUST_PATH, '--work', work], deps), 0);
      const rec = JSON.parse(read(path.join(work, 'record.json'))) as Rec;
      assert.equal(rec.published.length, 8);
      assert.deepEqual(rec.logHead, { ...rec.logHead, before: 0, after: 8 });
      assert.ok(sleeps.length > 0 && sleeps.length <= 18, `다시 읽기 ${sleeps.length}번`);
      assert.ok(clock.t >= 60_000 && clock.t <= 90_000, `기다린 시간 ${clock.t}ms`);
    } finally {
      await prod.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('head가 끝까지 안 바뀌면 log_invalid. 그 폴더로 verify(PUT 없음)가 record.json을 쓴다', async () => {
    const prod = await localProd();
    const dir = tmp();
    try {
      const work = await setup(prod, dir);
      const sleeps: number[] = [];
      await assert.rejects(publish(['push', '--trust', TRUST_PATH, '--work', work], viaCdn({ t: 0 }, sleeps, { frozenHead: true })), /publish\.log_invalid: registry\/revoked_keys\.json 항목 없음/);
      assert.equal(sleeps.length, 18, '90초(5초 × 18) 기다린 뒤 멈춘다');
      assert.ok(!fs.existsSync(path.join(work, 'record.json')));
      assert.ok(fs.existsSync(path.join(work, 'push-started.json')));

      const puts = prod.s3.counts.put;
      const logSize = (await prod.built.log.head()).treeSize;
      const v: string[] = [];
      assert.equal(await publish(['verify', '--trust', TRUST_PATH, '--work', work], cliDeps(v)), 0);
      assert.equal(prod.s3.counts.put, puts, 'verify는 PUT하지 않는다');
      assert.equal((await prod.built.log.head()).treeSize, logSize);
      const rec = JSON.parse(read(path.join(work, 'record.json'))) as Rec;
      assert.deepEqual(rec.published.map((x) => x.logIndex), [0, 1, 2, 3, 4, 5, 6, 7]);
      assert.deepEqual(rec.logHead, { ...rec.logHead, before: 0, after: 8 });
      assert.ok(v.some((l) => l.startsWith('되읽기·로그 확인: 8건, 로그 크기 0 → 8')), v.join('\n'));
      await assert.rejects(publish(['verify', '--trust', TRUST_PATH, '--work', work], cliDeps([])), /publish\.work_exists/);

      // push-started.json이 없는 폴더(이 수정 전 push, 운영 h01-1): 일관성 증명만 건너뛰고 항목·포함 증명은 본다
      fs.rmSync(path.join(work, 'record.json'));
      fs.rmSync(path.join(work, 'push-started.json'));
      const v2: string[] = [];
      assert.equal(await publish(['verify', '--trust', TRUST_PATH, '--work', work], cliDeps(v2)), 0);
      assert.ok(v2.some((l) => l.includes('push-started.json 없음')), v2.join('\n'));
      assert.equal((JSON.parse(read(path.join(work, 'record.json'))) as Rec).logHead.before, null);
    } finally {
      await prod.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
