// 엔진 패키지 공급(PR-D2 앞부분, D03 §3.1, D09 §8, ADR-013·028, 팀장 결정 (가) 2026-11-09): 가짜 레지스트리(고정 시드 샘플)에서
// 플레이북·조회 패키지를 받아 로더 전체로 검증한 .sxp만 저장하고, 실행을 시작할 때 저장본을 다시 loadPackage 해 IrPackage로 만든다.
// 서명 검증 실패·다이제스트 불일치·버전 내림·보류·설치 뒤 키 폐기·저장 바이트 변조를 본다. 네트워크는 주입한 fetch뿐이다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { openDatabase, type Db } from '@sax/db';
import {
  appVersionAllows, egressRegistryFetch, fixturePortal, HOMETAX_PORTAL, installedIrSource, memoryRegistryStore, packagePath, portalLookupDefs, PRODUCT_PACKAGES, REGISTRY_PATHS, RegistrySync, settingsRegistryStore,
  type RegistryFetch, type StoredPackage, type TrustPin,
} from '@sax/engine';
import { decodeSxp, encodeSxp, manifestDigest, sha256Hex, type PackageFiles, type RevokedKeys } from '@sax/engine/core';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { h01, signPackage, signTimestamped, type TestKey } from './core-fixtures.ts';
import { SAMPLE_NOW, sampleKeys } from './registry-samples.ts';

const DIR = path.resolve(import.meta.dirname, 'fixtures/registry');
const file = (p: string) => new Uint8Array(fs.readFileSync(path.join(DIR, p)));
const TRUST = JSON.parse(Buffer.from(file('trust.json')).toString('utf8')) as TrustPin;
const K = sampleKeys();
const TWO = K.pkg.slice(0, 2);
const ISSUED = '2026-11-05T00:00:00Z';
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const ID = 'hometax.invoice.issue';
const LOOKUP = 'hometax.invoice.lookup';
const MAIL = 'hometax.invoice.email_status';
const sxpPath = (id: string, v: string) => packagePath(id, v);

/** 샘플 조회 패키지의 manifest 다이제스트(H-01 lookupsUsed[].digest). */
const lookupDigest = (id: string) => {
  const d = decodeSxp(file(`packages/${id}@1.0.0.sxp`));
  assert.ok(d.ok && d.sxp.kind === 'package');
  return manifestDigest(JSON.parse(Buffer.from(d.sxp.raw.manifest).toString('utf8')) as never);
};
const LOOKUP_DIGESTS = [lookupDigest(LOOKUP), lookupDigest(MAIL)];

/** H-01을 버전만 바꿔 서명한 .sxp(signers 기본 패키지 키 2개). */
function h01Sxp(version: string, o: { signers?: TestKey[]; edit?: (f: PackageFiles) => void } = {}): Buffer {
  const f = h01();
  f.manifest.version = version;
  (f.playbook as { version: string }).version = version;
  o.edit?.(f);
  return encodeSxp({ kind: 'package', raw: signPackage(f, o.signers ?? TWO, LOOKUP_DIGESTS) });
}

type Entry = { id: string; version: string; kind: string; portal?: string; sxpDigest: string; size: number; rolloutPercent: number; minAppVersion?: string };
const entryOf = (id: string, version: string, kind: string, sxp: Uint8Array, over: Partial<Entry> = {}): Entry => ({ id, version, kind, portal: 'hometax', sxpDigest: sha256Hex(sxp), size: sxp.length, rolloutPercent: 100, ...over });

/** stable 인덱스(내용 = 패키지 키 2-of-3, 신선도 = timestamp 키, ADR-043). 샘플 인덱스(monotonic 7)보다 높은 monotonic으로 새로 서명한다. */
function indexBytes(entries: Entry[], monotonic: number): Uint8Array {
  const doc = signTimestamped({ channel: 'stable', monotonic, keyEpoch: 1, issuedAt: ISSUED, expiresAt: iso(Date.parse(ISSUED) + 14 * 24 * H), entries, signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' } }, TWO, K.ts);
  return new Uint8Array(Buffer.from(JSON.stringify(doc)));
}

/** 레지스트리 대역: 경로 → 바이트(ETag = sha256 앞 32 hex). 부른 경로를 남긴다. */
function fakeRegistry(files: Record<string, Uint8Array | number>) {
  const calls: string[] = [];
  const fetch: RegistryFetch = async (p, o) => {
    calls.push(p);
    const f = files[p];
    if (f === undefined) return { status: 404 };
    if (typeof f === 'number') return { status: f };
    const etag = `"${sha256Hex(f).slice(0, 32)}"`;
    return o.etag === etag ? { status: 304, etag } : { status: 200, body: f, etag };
  };
  return { fetch, calls, files };
}

const sampleFiles = (): Record<string, Uint8Array | number> => ({
  [REGISTRY_PATHS.revoked]: file('registry/revoked_keys.json'),
  [REGISTRY_PATHS.status]: file('registry/status.json'),
  [REGISTRY_PATHS.index]: file('registry/stable/index.json'),
  [sxpPath(LOOKUP, '1.0.0')]: file(`packages/${LOOKUP}@1.0.0.sxp`),
  [sxpPath(MAIL, '1.0.0')]: file(`packages/${MAIL}@1.0.0.sxp`),
  [sxpPath(ID, '2.1.0')]: file(`packages/${ID}@2.1.0.sxp`),
});

/** 샘플 조회 패키지 2개 + 주어진 H-01 판들로 새 인덱스를 만든 레지스트리 파일. */
function withVersions(versions: Array<{ version: string; sxp: Uint8Array; over?: Partial<Entry> }>, monotonic: number, base = sampleFiles()) {
  const files = { ...base };
  const entries = [entryOf(LOOKUP, '1.0.0', 'lookup', file(`packages/${LOOKUP}@1.0.0.sxp`)), entryOf(MAIL, '1.0.0', 'lookup', file(`packages/${MAIL}@1.0.0.sxp`))];
  for (const v of versions) {
    files[sxpPath(ID, v.version)] = v.sxp;
    entries.push(entryOf(ID, v.version, 'playbook', v.sxp, v.over));
  }
  files[REGISTRY_PATHS.index] = indexBytes(entries, monotonic);
  return files;
}

function setup(files = sampleFiles(), o: { now?: number; store?: ReturnType<typeof memoryRegistryStore>; appVersion?: string } = {}) {
  const reg = fakeRegistry(files);
  const store = o.store ?? memoryRegistryStore();
  const log = new FileEventLog(null, 'engine');
  let now = o.now ?? SAMPLE_NOW;
  const sync = new RegistrySync({ trust: TRUST, fetch: reg.fetch, store, packages: { ids: [ID] }, log, now: () => now, ...(o.appVersion ? { appVersion: o.appVersion } : {}) });
  return { sync, reg, store, log, setNow: (t: number) => (now = t) };
}

const current = (store: ReturnType<typeof memoryRegistryStore>) => store.get(`pkg.current.${ID}`);

describe('패키지 공급: 받기(가짜 레지스트리, 로더 전체 검증 뒤 저장)', () => {
  it('인덱스의 H-01과 lookupsUsed 조회 패키지 2개를 받아 검증하고 저장, 실행 시작 로드는 네트워크 없이 같은 패키지', async () => {
    const s = setup();
    const r = await s.sync.sync();
    assert.deepEqual(r.packages, { [ID]: 'accepted' });
    assert.deepEqual(s.reg.calls, [REGISTRY_PATHS.revoked, REGISTRY_PATHS.status, REGISTRY_PATHS.policy, REGISTRY_PATHS.index, sxpPath(ID, '2.1.0'), sxpPath(LOOKUP, '1.0.0'), sxpPath(MAIL, '1.0.0')]);
    assert.equal(current(s.store), '2.1.0');
    const rec = s.store.get(`pkg.${ID}@2.1.0`) as StoredPackage;
    assert.equal(rec.sxpDigest, sha256Hex(file(`packages/${ID}@2.1.0.sxp`)), '받은 .sxp 원본 바이트를 그대로 둔다');
    s.reg.calls.length = 0;
    const l = s.sync.loadInstalled(ID);
    assert.ok(l.ok, JSON.stringify(l));
    assert.deepEqual([l.pkg.files.manifest.id, l.pkg.files.manifest.version, l.pkg.files.manifest.portal], [ID, '2.1.0', 'hometax']);
    assert.deepEqual([...l.lookups.keys()], [LOOKUP, MAIL]);
    assert.deepEqual(l.pkg.lookupDigests, LOOKUP_DIGESTS);
    assert.equal(s.reg.calls.length, 0, '실행 시작 로드는 네트워크를 쓰지 않는다');
    // 로그에는 코드·개수만(경로·패키지 id 없음)
    const lines = s.log.lines.join('\n');
    assert.match(lines, /"registry\.synced"/);
    for (const bad of ['/packages', '.sxp', ID, LOOKUP]) assert.ok(!lines.includes(bad), bad);
  });

  it('다시 동기화하면 같은 판이라 .sxp를 다시 받지 않는다(unchanged)', async () => {
    const s = setup();
    await s.sync.sync();
    s.reg.calls.length = 0;
    const r = await s.sync.sync();
    assert.deepEqual(r.packages, { [ID]: 'unchanged' });
    assert.ok(!s.reg.calls.some((c) => c.endsWith('.sxp')));
  });

  it('제품 엔진(dist, fixture 관문 닫힘)도 같은 샘플을 받아 로드한다. 제품이 받는 id는 H-01', async () => {
    const dist = (await import(new URL('../packages/engine/dist/registry-sync.js', import.meta.url).href)) as { RegistrySync: typeof RegistrySync; PRODUCT_PACKAGES: typeof PRODUCT_PACKAGES };
    assert.equal(dist.PRODUCT_PACKAGES.h01, ID);
    const reg = fakeRegistry(sampleFiles());
    const sync = new dist.RegistrySync({ trust: TRUST, fetch: reg.fetch, store: memoryRegistryStore(), packages: { ids: [dist.PRODUCT_PACKAGES.h01] }, now: () => SAMPLE_NOW });
    assert.deepEqual((await sync.sync()).packages, { [ID]: 'accepted' });
    const l = sync.loadInstalled(ID);
    assert.ok(l.ok, JSON.stringify(l));
  });

  it('packages를 주지 않으면 플레이북·조회 패키지를 받지 않고 보고에도 없다(데이터 패키지만이던 동작 그대로)', async () => {
    const reg = fakeRegistry(sampleFiles());
    const sync = new RegistrySync({ trust: TRUST, fetch: reg.fetch, store: memoryRegistryStore(), now: () => SAMPLE_NOW });
    const r = await sync.sync();
    assert.equal(r.packages, undefined);
    assert.ok(!reg.calls.some((c) => c.endsWith('.sxp')));
    assert.deepEqual(sync.loadInstalled(ID), { ok: false, code: 'package.not_loaded', events: [] });
  });

  it('받을 패키지 id가 패키지 id 규칙이 아니거나 .hotfix면 만들 때 거부', () => {
    for (const id of ['hometax', 'Hometax.invoice', 'hometax.invoice.issue.hotfix', '../x.y'])
      assert.throws(() => new RegistrySync({ trust: TRUST, fetch: null, store: memoryRegistryStore(), packages: { ids: [id] } }), /registry\.package_id_invalid/, id);
  });

  it('DB settings 저장소(제품): 엔진을 다시 띄워도 설치본을 로드한다', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-pkgsupply-'));
    let db: Db | null = null;
    try {
      db = openDatabase(path.join(tmp, 'db.sqlite'), new Uint8Array(randomBytes(32)));
      const reg = fakeRegistry(sampleFiles());
      await new RegistrySync({ trust: TRUST, fetch: reg.fetch, store: settingsRegistryStore(db), packages: { ids: [ID] }, now: () => SAMPLE_NOW }).sync();
      const again = new RegistrySync({ trust: TRUST, fetch: null, store: settingsRegistryStore(db), packages: { ids: [ID] }, now: () => SAMPLE_NOW });
      const l = again.loadInstalled(ID);
      assert.ok(l.ok, JSON.stringify(l));
      assert.equal(l.pkg.files.manifest.version, '2.1.0');
    } finally {
      db?.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('패키지 공급: 서명·내용 검증 실패는 받지 않고 이전 설치본을 지킨다', () => {
  it('유효 서명 1개(2-of-3 미달, 나머지 하나는 package-2 이름의 다른 키) 패키지는 registry.signature_insufficient, 이전 판 유지', async () => {
    const s = setup();
    await s.sync.sync();
    const sxp = h01Sxp('2.2.0', { signers: [K.pkg[0]!, { ...K.root[0]!, keyId: 'package-2' }] });
    Object.assign(s.reg.files, withVersions([{ version: '2.2.0', sxp }], 8));
    const r = await s.sync.sync();
    assert.deepEqual(r.packages, { [ID]: 'registry.signature_insufficient' });
    assert.equal(current(s.store), '2.1.0');
    assert.equal(s.store.get(`pkg.${ID}@2.2.0`), null);
    assert.ok(s.sync.loadInstalled(ID).ok);
    assert.match(s.log.lines.join('\n'), /"registry\.rejected".*"what":"package".*"code_":"registry\.signature_insufficient"/);
  });

  it('핀에 없는 키로 서명한 패키지(서명 2개지만 유효 0)도 같은 거부', async () => {
    const foreign: TestKey[] = ['package-1', 'package-2'].map((keyId, i) => ({ ...K.root[i]!, keyId }));
    const s = setup(withVersions([{ version: '2.2.0', sxp: h01Sxp('2.2.0', { signers: foreign }) }], 8));
    const r = await s.sync.sync();
    assert.deepEqual(r.packages, { [ID]: 'registry.signature_insufficient' });
    assert.equal(current(s.store), null);
  });

  it('인덱스 다이제스트·크기와 다른 .sxp 바이트는 registry.content_digest_mismatch(인덱스 서명이 바이트를 묶는다)', async () => {
    const files = sampleFiles();
    const b = Buffer.from(files[sxpPath(ID, '2.1.0')] as Uint8Array);
    b[b.length - 2] ^= 1;
    files[sxpPath(ID, '2.1.0')] = b;
    const s = setup(files);
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'registry.content_digest_mismatch' });
    assert.equal(current(s.store), null);
  });

  it('조회 패키지 바이트가 틀리면 플레이북도 저장하지 않는다(조회 패키지 → 플레이북 → 지금 버전 순서)', async () => {
    const files = sampleFiles();
    files[sxpPath(MAIL, '1.0.0')] = new Uint8Array(Buffer.from('not sxp'));
    const s = setup(files);
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'registry.content_digest_mismatch' });
    assert.equal(current(s.store), null);
    assert.equal(s.store.get(`pkg.${ID}@2.1.0`), null);
    assert.deepEqual(s.sync.loadInstalled(ID), { ok: false, code: 'package.not_loaded', events: [] });
  });

  it('인덱스가 가리키는 조회 패키지 판이 인덱스에 없으면 loader.lookup_mismatch', async () => {
    const f = h01();
    f.manifest.version = '2.2.0';
    (f.playbook as { version: string }).version = '2.2.0';
    f.manifest.lookupsUsed[1]!.version = '1.1.0';
    const sxp = encodeSxp({ kind: 'package', raw: signPackage(f, TWO, LOOKUP_DIGESTS) });
    const s = setup(withVersions([{ version: '2.2.0', sxp }], 8));
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'loader.lookup_mismatch' });
  });

  it('정적 검증 실패(빈 스텝) 패키지는 loader.static_invalid 계열로 거부', async () => {
    const s = setup(withVersions([{ version: '2.2.0', sxp: h01Sxp('2.2.0', { edit: (f) => void ((f.playbook as { steps: unknown[] }).steps = []) }) }], 8));
    const code = (await s.sync.sync()).packages![ID]!;
    assert.match(code, /^loader\.(static_invalid|schema_invalid)$/);
    assert.equal(current(s.store), null);
  });

  it('인덱스 항목 종류·포털과 안의 manifest가 다르면 registry.kind_mismatch', async () => {
    const s = setup(withVersions([{ version: '2.1.0', sxp: file(`packages/${ID}@2.1.0.sxp`), over: { portal: 'gov24' } }], 8));
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'registry.kind_mismatch' });
  });
});

describe('패키지 공급: 버전 내림 방지·보류', () => {
  it('2.2.0을 받은 뒤 인덱스가 2.1.0만 가리키면 내리지 않는다(unchanged), 설치본은 2.2.0', async () => {
    const s = setup(withVersions([{ version: '2.2.0', sxp: h01Sxp('2.2.0') }], 8));
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'accepted' });
    assert.equal(current(s.store), '2.2.0');
    s.reg.files[REGISTRY_PATHS.index] = withVersions([{ version: '2.1.0', sxp: file(`packages/${ID}@2.1.0.sxp`) }], 9)[REGISTRY_PATHS.index]!;
    s.reg.calls.length = 0;
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'unchanged' });
    assert.ok(!s.reg.calls.some((c) => c.endsWith('.sxp')), '낮은 판은 받지도 않는다');
    const l = s.sync.loadInstalled(ID);
    assert.ok(l.ok);
    assert.equal(l.pkg.files.manifest.version, '2.2.0');
  });

  it('지금 판 포인터를 낮은 판으로 되돌려도(저장소 조작) 로더가 설치본 기준으로 다시 본다: 같은 버전 다른 내용은 registry.version_rollback', async () => {
    const s = setup(withVersions([{ version: '2.2.0', sxp: h01Sxp('2.2.0') }], 8));
    await s.sync.sync();
    // 2.2.0 기록의 바이트를 같은 버전의 다른 내용으로 바꾸되 sxpDigest도 맞춘다(저장 다이제스트 검사를 지나도 manifest 다이제스트가 다르다)
    const rec = s.store.get(`pkg.${ID}@2.2.0`) as StoredPackage;
    const other = h01Sxp('2.2.0', { edit: (f) => void (f.manifest.createdAt = '2026-11-08T00:00:00+09:00') });
    s.store.set(`pkg.${ID}@2.2.0`, { ...rec, sxp: other.toString('base64'), sxpDigest: sha256Hex(other) });
    assert.deepEqual(s.sync.loadInstalled(ID), { ok: false, code: 'registry.version_rollback', events: [] });
  });

  it('같은 버전이 인덱스에서 다른 바이트로 바뀌어도 다시 받지 않는다(불변 경로, 설치본 유지)', async () => {
    const s = setup();
    await s.sync.sync();
    const other = h01Sxp('2.1.0', { edit: (f) => void (f.manifest.createdAt = '2026-11-08T00:00:00+09:00') });
    Object.assign(s.reg.files, withVersions([{ version: '2.1.0', sxp: other }], 8));
    s.reg.calls.length = 0;
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'unchanged' });
    assert.ok(!s.reg.calls.includes(sxpPath(ID, '2.1.0')));
    const l = s.sync.loadInstalled(ID);
    assert.ok(l.ok);
    assert.equal(l.pkg.manifestDigest, (s.store.get(`pkg.${ID}@2.1.0`) as StoredPackage).manifestDigest);
  });

  it('폐기 목록 신선도를 잃으면(24시간) 새 패키지는 registry.update_held, 설치본은 계속 로드한다', async () => {
    const s = setup();
    await s.sync.sync();
    s.setNow(Date.parse(ISSUED) + 30 * H);
    Object.assign(s.reg.files, withVersions([{ version: '2.2.0', sxp: h01Sxp('2.2.0') }], 8));
    const r = await s.sync.sync();
    assert.equal(r.revokedFresh, false);
    assert.deepEqual(r.packages, { [ID]: 'registry.update_held' });
    assert.equal(current(s.store), '2.1.0');
    const l = s.sync.loadInstalled(ID);
    assert.ok(l.ok, JSON.stringify(l));
    assert.equal(l.pkg.files.manifest.version, '2.1.0');
  });

  it('보류 중 첫 설치(설치본 없음)도 받지 않는다', async () => {
    const s = setup(sampleFiles(), { now: Date.parse(ISSUED) + 30 * H });
    const r = await s.sync.sync();
    assert.deepEqual(r.packages, { [ID]: 'registry.update_held' });
  });
});

describe('패키지 공급: 앱 판(minAppVersion, 팀장 지시 2026-11-09)', () => {
  const sample21 = () => ({ version: '2.1.0', sxp: file(`packages/${ID}@2.1.0.sxp`) });
  it('appVersionAllows: 항목에 없으면 늘 된다, 같거나 높으면 된다, 낮거나 모르거나 semver가 아니면 안 된다', () => {
    assert.equal(appVersionAllows(undefined, null), true);
    assert.equal(appVersionAllows('1.2.0', '1.2.0'), true);
    assert.equal(appVersionAllows('1.2.0', '1.10.0'), true, '숫자 비교(문자열 비교 아님)');
    assert.equal(appVersionAllows('1.2.0', '1.1.9'), false);
    for (const v of [null, undefined, '', 'dev', '1.2', '1.2.0-beta']) assert.equal(appVersionAllows('1.2.0', v), false, String(v));
  });
  it('앱 판이 낮으면 그 판은 받지 않고(.sxp도 부르지 않음) 맞는 가장 높은 판을 받는다', async () => {
    const s = setup(withVersions([sample21(), { version: '2.2.0', sxp: h01Sxp('2.2.0'), over: { minAppVersion: '1.5.0' } }], 8), { appVersion: '1.4.9' });
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'accepted' });
    assert.equal(current(s.store), '2.1.0');
    assert.ok(!s.reg.calls.includes(sxpPath(ID, '2.2.0')));
    assert.match(s.log.lines.join('\n'), /"registry\.app_version_low"/);
    assert.ok(s.sync.loadInstalled(ID).ok);
    // 앱을 올리면(같은 경계 값) 다음 동기화에서 받는다
    const up = setup(s.reg.files, { appVersion: '1.5.0', store: s.store });
    assert.deepEqual((await up.sync.sync()).packages, { [ID]: 'accepted' });
    assert.equal(current(up.store), '2.2.0');
  });
  it('앱 판을 모르면(init에 없음·semver 아님) minAppVersion이 있는 판은 받지 않는다(fail-closed). 없는 판은 그대로 받는다', async () => {
    for (const appVersion of [undefined, 'dev']) {
      const s = setup(withVersions([{ version: '2.2.0', sxp: h01Sxp('2.2.0'), over: { minAppVersion: '0.0.1' } }], 8), appVersion ? { appVersion } : {});
      assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'registry.app_version_low' }, String(appVersion));
      assert.equal(current(s.store), null);
      assert.equal(s.sync.loadInstalled(ID).ok ? 'ok' : (s.sync.loadInstalled(ID) as { code: string }).code, 'package.not_loaded');
    }
    const plain = setup();
    assert.deepEqual((await plain.sync.sync()).packages, { [ID]: 'accepted' }, 'minAppVersion 없는 항목은 앱 판 없이도');
  });
  it('조회 하위 패키지 항목의 minAppVersion이 앱보다 높으면 플레이북도 저장하지 않는다', async () => {
    const files = sampleFiles();
    const lk = file(`packages/${LOOKUP}@1.0.0.sxp`);
    const entries = [entryOf(LOOKUP, '1.0.0', 'lookup', lk, { minAppVersion: '9.0.0' }), entryOf(MAIL, '1.0.0', 'lookup', file(`packages/${MAIL}@1.0.0.sxp`)), entryOf(ID, '2.1.0', 'playbook', file(`packages/${ID}@2.1.0.sxp`))];
    files[REGISTRY_PATHS.index] = indexBytes(entries, 8);
    const s = setup(files, { appVersion: '1.0.0' });
    assert.deepEqual((await s.sync.sync()).packages, { [ID]: 'registry.app_version_low' });
    assert.equal(current(s.store), null);
    assert.equal(s.store.get(`pkg.${LOOKUP}@1.0.0`), null);
  });
  it('실행 시작 로드도 매번 앱 판을 다시 본다: 설치 뒤 앱 판이 낮아지면(앱 되돌림) registry.app_version_low', async () => {
    const s = setup(withVersions([{ version: '2.2.0', sxp: h01Sxp('2.2.0'), over: { minAppVersion: '1.5.0' } }], 8), { appVersion: '1.5.0' });
    await s.sync.sync();
    assert.equal((s.store.get(`pkg.${ID}@2.2.0`) as StoredPackage).minAppVersion, '1.5.0', '받을 때의 minAppVersion을 저장');
    assert.ok(s.sync.loadInstalled(ID).ok);
    for (const appVersion of ['1.4.0', undefined]) {
      const down = setup(s.reg.files, { store: s.store, ...(appVersion ? { appVersion } : {}) });
      const l = down.sync.loadInstalled(ID);
      assert.equal(l.ok ? 'ok' : l.code, 'registry.app_version_low', String(appVersion));
    }
  });
  it('엔진 진입점: main init의 appVersion(문자열일 때만)을 RegistrySync에 준다', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../packages/engine/src/entry.ts'), 'utf8');
    assert.match(src, /new RegistrySync\(\{[^\n]*appVersion: typeof msg\.appVersion === 'string' \? msg\.appVersion : null \}\)/);
    assert.match(fs.readFileSync(path.resolve(import.meta.dirname, '../packages/engine/src/protocol.ts'), 'utf8'), /appVersion\?: string;/);
  });
});

describe('패키지 공급: 실행 시작 로드는 매번 다시 검증한다', () => {
  it('설치 뒤 서명 키가 폐기되면 다음 실행 시작이 registry.signature_insufficient(이벤트 registry.key_revoked)', async () => {
    const s = setup();
    await s.sync.sync();
    const revoked = signTimestamped({ revoked: [{ keyId: 'package-0', role: 'package', revokedAt: ISSUED }, { keyId: 'package-1', role: 'package', revokedAt: ISSUED }], monotonic: 2, keyEpoch: 1, issuedAt: ISSUED, expiresAt: iso(Date.parse(ISSUED) + 24 * H), signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' } } as RevokedKeys, K.root.slice(0, 2), K.ts);
    s.reg.files[REGISTRY_PATHS.revoked] = new Uint8Array(Buffer.from(JSON.stringify(revoked)));
    assert.equal((await s.sync.sync()).revoked, 'accepted');
    const l = s.sync.loadInstalled(ID);
    assert.equal(l.ok, false);
    assert.ok(!l.ok);
    assert.equal(l.code, 'registry.signature_insufficient');
    assert.ok(l.events.includes('registry.key_revoked'));
  });

  it('저장 바이트가 받을 때의 다이제스트와 다르면 package.store_corrupt(플레이북·조회 패키지 모두)', async () => {
    for (const id of [ID, MAIL]) {
      const s = setup();
      await s.sync.sync();
      const key = `pkg.${id}@${id === ID ? '2.1.0' : '1.0.0'}`;
      const rec = s.store.get(key) as StoredPackage;
      const b = Buffer.from(rec.sxp, 'base64');
      b[10] ^= 1;
      s.store.set(key, { ...rec, sxp: b.toString('base64') });
      assert.deepEqual(s.sync.loadInstalled(ID), { ok: false, code: 'package.store_corrupt', events: [] }, id);
    }
  });

  it('조회 패키지 저장본이 없으면 loader.lookup_mismatch', async () => {
    const s = setup();
    await s.sync.sync();
    s.store.set(`pkg.${LOOKUP}@1.0.0`, null);
    assert.deepEqual(s.sync.loadInstalled(ID), { ok: false, code: 'loader.lookup_mismatch', events: [] });
  });
});

describe('installedIrSource(RunServiceDeps.irSource)', () => {
  it('설치본 → IrPackage(함께 받은 서명 조회 패키지 2개, 앱 코드 조회 정의 없음), 부를 때마다 다시 로드한다', async () => {
    const s = setup();
    await s.sync.sync();
    let loads = 0;
    const reg = { loadInstalled: (id: string) => (loads++, s.sync.loadInstalled(id)) };
    const src = installedIrSource(reg, { id: ID, portal: HOMETAX_PORTAL });
    const a = src();
    assert.ok(a.ok);
    assert.equal(a.ir.pkg.files.manifest.id, ID);
    // 조회는 서명 조회 패키지 IR로 돈다(IrLookupPort, 팀장 결정 2026-11-09 (가)). 앱 코드 HOMETAX_PORTAL 조회 정의(TODO)는 쓰지 않는다.
    assert.deepEqual([...a.ir.lookupPackages!.keys()].sort(), [MAIL, LOOKUP].sort());
    assert.equal(a.ir.lookupPackages!.get(LOOKUP)!.files.manifest.kind, 'lookup');
    assert.equal(a.ir.lookupDefs, undefined);
    assert.equal(a.ir.fixtureGrant, undefined, '레지스트리 패키지에는 fixture 허가가 없다');
    src();
    assert.equal(loads, 2);
  });

  it('포털이 다르면 package.portal_mismatch, 설치본이 없으면 package.not_loaded', async () => {
    const s = setup();
    assert.deepEqual(installedIrSource(s.sync, { id: ID, portal: HOMETAX_PORTAL })(), { ok: false, code: 'package.not_loaded' });
    await s.sync.sync();
    assert.deepEqual(installedIrSource(s.sync, { id: ID, portal: fixturePortal('http://127.0.0.1:1') })(), { ok: false, code: 'package.portal_mismatch' });
  });

  it('포털 조회 정의 이름 규칙(가짜 페이지 시험): <kind>.invoice.lookup·<kind>.invoice.email_status', () => {
    const p = fixturePortal('http://127.0.0.1:1');
    assert.deepEqual([...portalLookupDefs(p).keys()], ['fixture.invoice.lookup', 'fixture.invoice.email_status']);
  });
});

describe('egressRegistryFetch(제품 fetch = @sax/net Egress 레지스트리 바이트 GET)', () => {
  it('Egress로 보내고 응답을 RegistryResponse로 옮긴다. 목록 밖 경로는 Egress가 막는다', async () => {
    const seen: Array<{ target: string; etag?: string }> = [];
    const fake = { getRegistryBytes: async (target: string, o: { etag?: string } = {}) => (seen.push({ target, ...o }), { status: 200, body: new Uint8Array([1]), etag: '"e"' }) };
    const f = egressRegistryFetch(fake);
    assert.deepEqual(await f(REGISTRY_PATHS.index, { etag: '"x"' }), { status: 200, body: new Uint8Array([1]), etag: '"e"' });
    assert.deepEqual(seen, [{ target: REGISTRY_PATHS.index, etag: '"x"' }]);
    const real = egressRegistryFetch(new Egress({ testOrigins: { registry: 'http://127.0.0.1:9' }, env: {} }));
    await assert.rejects(real('/packages/../x.json', {}), /path_not_allowed/);
  });

  it('엔진이 부르는 모든 경로가 Egress 허용 목록 안이다', async () => {
    const { registryTargetAllowed } = await import('@sax/net');
    for (const p of [...Object.values(REGISTRY_PATHS), sxpPath(ID, '2.1.0'), sxpPath(LOOKUP, '1.0.0'), sxpPath('payroll.rate-tables', '2026.11.1')]) assert.ok(registryTargetAllowed(p), p);
  });
});

