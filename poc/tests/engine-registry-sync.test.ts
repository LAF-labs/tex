// 엔진 레지스트리 동기화(D03 §3.1·§7.1, D09 §8.4, ADR-013·023·028, 데스크톱 #126 "켜려면 필요한 것").
// 상호 검증 샘플(tests/fixtures/registry, 고정 시드)을 주입한 fetch로 내려 엔진이 다시 검증하는지, 실패하면 그 문서만 버리고 마지막 유효본을 지키는지,
// main 전용 질의(폐기 목록·신선도·핀 키·status)와 급여 시행일 표 데이터 패키지 수용(DB 트랜잭션)을 본다.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { openDatabase, RateTableRepo, type Db } from '@sax/db';
import {
  acceptIndex, memoryRegistryStore, packagePath, rateTableSink, REGISTRY_PATHS, REGISTRY_TRUST_PIN, RegistrySync, rolloutBucket, settingsRegistryStore, trustRootsFromPin,
  type DataSink, type RegistryFetch, type RegistryIndex, type RegistryResponse, type TrustPin,
} from '@sax/engine';
import { canonicalWithout, sha256Hex, type Policy, type RevokedKeys, type RegistryStatus } from '@sax/engine/core';
import { COMMANDS, MAIN_ONLY, READ_QUERIES, REGISTRY_COMMANDS, REGISTRY_MAIN_ONLY, REGISTRY_READ_QUERIES } from '@sax/engine/protocol';
import { FileEventLog } from '@sax/platform';
import { rolloutBucket as serverBucket, verifyIndex } from '../services/registry/src/verify.ts';
import { sigOf, signTimestamped } from './core-fixtures.ts';
import { SAMPLE_NOW, sampleKeys } from './registry-samples.ts';

const DIR = path.resolve(import.meta.dirname, 'fixtures/registry');
const file = (p: string) => new Uint8Array(fs.readFileSync(path.join(DIR, p)));
const json = <T>(p: string) => JSON.parse(Buffer.from(file(p)).toString('utf8')) as T;
const bytes = (o: unknown) => new Uint8Array(Buffer.from(JSON.stringify(o)));
const TRUST = json<TrustPin>('trust.json');
const K = sampleKeys();
const H = 3_600_000;
const DATA_PATH = packagePath('payroll.rate-tables', '2026.11.1');

/** 레지스트리 대역: 경로 → 바이트. ETag = sha256 앞 32 hex(API.md), If-None-Match가 같으면 304. 부른 경로를 남긴다. */
function fakeRegistry(files: Record<string, Uint8Array | (() => Uint8Array) | number | Error>) {
  const calls: Array<{ path: string; etag?: string }> = [];
  const fetch: RegistryFetch = async (p, o) => {
    calls.push({ path: p, etag: o.etag });
    const f = files[p];
    if (f === undefined) return { status: 404 };
    if (f instanceof Error) throw f;
    if (typeof f === 'number') return { status: f };
    const body = typeof f === 'function' ? f() : f;
    const etag = `"${sha256Hex(body).slice(0, 32)}"`;
    if (o.etag === etag) return { status: 304, etag } satisfies RegistryResponse;
    return { status: 200, body, etag };
  };
  return { fetch, calls, files };
}

const baseFiles = () => ({
  [REGISTRY_PATHS.revoked]: file('registry/revoked_keys.json'),
  [REGISTRY_PATHS.status]: file('registry/status.json'),
  [REGISTRY_PATHS.policy]: file('policy/current.json'),
  [REGISTRY_PATHS.index]: file('registry/stable/index.json'),
  [DATA_PATH]: file('packages/payroll.rate-tables@2026.11.1.sxp'),
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sax-regsync-'));
const opened: Db[] = [];
// Windows는 열린 DB 파일을 지우지 못한다(EPERM). 닫고 지운다.
after(() => {
  for (const d of opened) d.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
let dbn = 0;
const freshDb = () => {
  const d = openDatabase(path.join(tmp, `${dbn++}.sqlite`), new Uint8Array(randomBytes(32)));
  opened.push(d);
  return d;
};

function setup(files = baseFiles(), o: { now?: () => number; store?: ReturnType<typeof memoryRegistryStore>; sinks?: DataSink[]; deviceId?: string } = {}) {
  const reg = fakeRegistry(files);
  const db = freshDb();
  const store = o.store ?? memoryRegistryStore();
  const log = new FileEventLog(null, 'engine');
  let now = SAMPLE_NOW;
  const sync = new RegistrySync({ trust: TRUST, fetch: reg.fetch, store, sinks: o.sinks ?? [rateTableSink(db)], log, now: o.now ?? (() => now), deviceId: o.deviceId ? () => o.deviceId! : undefined });
  return { sync, reg, db, store, log, setNow: (t: number) => (now = t), rates: new RateTableRepo(db) };
}

describe('레지스트리 동기화: 정상 경로(고정 시드 샘플)', () => {
  it('폐기 목록 → status → 인덱스 → 급여 시행일 표를 받아 엔진이 검증하고 DB에 넣는다', async () => {
    const s = setup();
    const r = await s.sync.sync();
    assert.deepEqual(r, { revoked: 'accepted', status: 'accepted', policy: 'accepted', index: 'accepted', data: { 'payroll.rate-tables': 'accepted' }, revokedFresh: true });
    assert.deepEqual(s.reg.calls.map((c) => c.path), [REGISTRY_PATHS.revoked, REGISTRY_PATHS.status, REGISTRY_PATHS.policy, REGISTRY_PATHS.index, DATA_PATH], '이 다섯 경로 말고는 부르지 않는다(핫픽스 인덱스 없음)');
    assert.deepEqual(s.sync.revocation(), { keyIds: ['package-0'], fresh: true, monotonic: 1, expiresAt: '2026-11-06T00:00:00Z' });
    assert.deepEqual(s.sync.pins(), TRUST);
    assert.deepEqual(s.sync.status(), { freshness: 'fresh', emergency: false, monotonic: 10, portalModeCeiling: { hometax: 'auto' }, killPlaybooks: [] });
    const inst = s.rates.installedPackage('payroll.rate-tables');
    assert.equal(inst?.version, '2026.11.1');
    assert.deepEqual(s.rates.list().map((t) => t.id), ['nontax-2026']);
    // 로그에는 코드·개수만(키 id·경로 없음)
    const lines = s.log.lines.join('\n');
    assert.match(lines, /"registry\.synced"/);
    for (const bad of ['package-0', '/registry', '.sxp', 'payroll.rate-tables', 'nontax']) assert.ok(!lines.includes(bad), bad);
  });

  it('다시 부르면 ETag 304로 그대로, 데이터 패키지는 같은 판이라 받지 않는다', async () => {
    const s = setup();
    await s.sync.sync();
    s.reg.calls.length = 0;
    const r = await s.sync.sync();
    assert.deepEqual(r, { revoked: 'unchanged', status: 'unchanged', policy: 'unchanged', index: 'unchanged', data: { 'payroll.rate-tables': 'unchanged' }, revokedFresh: true });
    assert.ok(s.reg.calls.every((c) => c.etag), 'If-None-Match를 보낸다');
    assert.ok(!s.reg.calls.some((c) => c.path === DATA_PATH), '.sxp를 다시 받지 않는다');
  });

  it('겹친 호출은 한 번만 돈다', async () => {
    const s = setup();
    const [a, b] = await Promise.all([s.sync.sync(), s.sync.sync()]);
    assert.equal(a, b);
    assert.equal(s.reg.calls.filter((c) => c.path === REGISTRY_PATHS.revoked).length, 1);
  });

  it('DB settings 저장소: 엔진을 다시 띄워도(새 RegistrySync) 받아 둔 문서로 답한다', async () => {
    const db = freshDb();
    const reg = fakeRegistry(baseFiles());
    const a = new RegistrySync({ trust: TRUST, fetch: reg.fetch, store: settingsRegistryStore(db), sinks: [rateTableSink(db)], now: () => SAMPLE_NOW });
    await a.sync();
    const b = new RegistrySync({ trust: TRUST, fetch: null, store: settingsRegistryStore(db), sinks: [rateTableSink(db)], now: () => SAMPLE_NOW });
    assert.deepEqual(b.revocation().keyIds, ['package-0']);
    assert.equal(b.status().monotonic, 10);
    assert.deepEqual(await b.sync(), { revoked: 'registry.fetch_unavailable', status: 'registry.fetch_unavailable', policy: 'registry.fetch_unavailable', index: 'registry.fetch_unavailable', data: {}, revokedFresh: true });
    const keys = (db.prepare("SELECT key FROM settings WHERE key LIKE 'registry.%' ORDER BY key").pluck().all() as string[]);
    assert.deepEqual(keys, ['registry.etag.index.stable', 'registry.etag.policy', 'registry.etag.revoked', 'registry.etag.status', 'registry.index.stable', 'registry.policy', 'registry.revoked', 'registry.status', 'registry.status_quorum']);
  });
});

describe('레지스트리 동기화: 실패는 그 문서만 버리고 마지막 유효본을 지킨다', () => {
  it('폐기 목록 서명 변조·축소·만료: 저장본 유지, 이유 코드', async () => {
    const s = setup();
    await s.sync.sync();
    const good = json<RevokedKeys>('registry/revoked_keys.json');
    // 서명 한 글자 바꿈
    const bad = structuredClone(good);
    bad.signatures[0]!.sig = (bad.signatures[0]!.sig[0] === 'A' ? 'B' : 'A') + bad.signatures[0]!.sig.slice(1);
    s.reg.files[REGISTRY_PATHS.revoked] = bytes(bad);
    assert.equal((await s.sync.sync()).revoked, 'registry.signature_insufficient');
    assert.deepEqual(s.sync.revocation().keyIds, ['package-0']);
    // 루트 1개 서명만
    const one = structuredClone(good);
    one.signatures = one.signatures.slice(0, 1);
    s.reg.files[REGISTRY_PATHS.revoked] = bytes(one);
    assert.equal((await s.sync.sync()).revoked, 'registry.signature_insufficient');
    // 깨진 JSON·너무 큰 응답·404·네트워크 실패
    s.reg.files[REGISTRY_PATHS.revoked] = new Uint8Array(Buffer.from('{"revoked":'));
    assert.equal((await s.sync.sync()).revoked, 'registry.response_invalid');
    s.reg.files[REGISTRY_PATHS.revoked] = new Uint8Array(512 * 1024 + 1);
    assert.equal((await s.sync.sync()).revoked, 'registry.response_invalid');
    s.reg.files[REGISTRY_PATHS.revoked] = 404;
    assert.equal((await s.sync.sync()).revoked, 'registry.not_found');
    s.reg.files[REGISTRY_PATHS.revoked] = new Error('ECONNRESET');
    assert.equal((await s.sync.sync()).revoked, 'registry.fetch_failed');
    s.reg.files[REGISTRY_PATHS.revoked] = 500;
    assert.equal((await s.sync.sync()).revoked, 'registry.fetch_failed');
    assert.deepEqual(s.sync.revocation().keyIds, ['package-0'], '어떤 실패도 저장본을 바꾸지 않는다');
    assert.ok(!s.log.lines.join('\n').includes('ECONNRESET'));
  });

  it('폐기 목록 24시간 신선도: 만료가 지나면 fresh=false, 만료된 재전송은 받지 않는다, 보류 중 데이터 패키지는 설치본만', async () => {
    let now = SAMPLE_NOW;
    const s = setup(baseFiles(), { now: () => now, sinks: [] });
    await s.sync.sync();
    assert.equal(s.sync.revocation().fresh, true);
    now = Date.parse('2026-11-06T00:00:00Z');
    assert.equal(s.sync.revocation().fresh, false, 'expiresAt 시각부터 낡음');
    s.reg.calls.length = 0;
    // 같은 바이트는 304라 다시 검증하지 않는다. ETag를 지우면 다시 받아 expired_on_arrival.
    s.store.set('etag.revoked', null);
    const r = await s.sync.sync();
    assert.equal(r.revoked, 'registry.expired_on_arrival');
    assert.equal(r.revokedFresh, false);
    // 새 판(monotonic 2, 다시 서명)이 오면 신선해진다
    const next = resign({ ...json<RevokedKeys>('registry/revoked_keys.json'), monotonic: 2, issuedAt: '2026-11-05T23:30:00Z', expiresAt: '2026-11-06T23:30:00Z' });
    s.reg.files[REGISTRY_PATHS.revoked] = bytes(next);
    assert.equal((await s.sync.sync()).revoked, 'accepted');
    assert.deepEqual(s.sync.revocation(), { keyIds: ['package-0'], fresh: true, monotonic: 2, expiresAt: '2026-11-06T23:30:00Z' });
    // 폐기는 되돌릴 수 없다: 목록이 줄면 거부
    const shrunk = resign({ ...next, revoked: [], monotonic: 3 });
    s.reg.files[REGISTRY_PATHS.revoked] = bytes(shrunk);
    assert.equal((await s.sync.sync()).revoked, 'registry.revoked_shrunk');
    // 되감기(monotonic 1)
    s.reg.files[REGISTRY_PATHS.revoked] = file('registry/revoked_keys.json');
    s.store.set('etag.revoked', null);
    now = SAMPLE_NOW + H;
    assert.equal((await s.sync.sync()).revoked, 'registry.version_rollback');
  });

  it('폐기 목록이 낡으면 보류: 새 데이터 패키지는 받지 않는다(registry.update_held), 기존 표는 그대로', async () => {
    let now = SAMPLE_NOW;
    const db = freshDb();
    const store = memoryRegistryStore();
    const reg = fakeRegistry(baseFiles());
    // 폐기 목록만 받아 두고 데이터는 아직
    const first = new RegistrySync({ trust: TRUST, fetch: reg.fetch, store, sinks: [], now: () => now });
    await first.sync();
    now = Date.parse('2026-11-06T01:00:00Z');
    reg.files[REGISTRY_PATHS.index] = reindex((ix) => ({ ...ix, monotonic: 8, issuedAt: '2026-11-06T00:30:00Z', expiresAt: '2026-11-19T00:00:00Z' }));
    const s = new RegistrySync({ trust: TRUST, fetch: reg.fetch, store, sinks: [rateTableSink(db)], now: () => now });
    store.set('etag.revoked', null);
    const r = await s.sync();
    assert.equal(r.revokedFresh, false);
    assert.equal(r.data['payroll.rate-tables'], 'registry.update_held');
    assert.equal(new RateTableRepo(db).installedPackage('payroll.rate-tables'), null);
  });

  it('status: 서명 부족·되감기는 거부, 긴급 키 하향은 받고 72시간 뒤 마지막 2-of-3로 되돌린다, 48시간 뒤 stale', async () => {
    let now = SAMPLE_NOW;
    const s = setup(baseFiles(), { now: () => now, sinks: [] });
    await s.sync.sync();
    s.reg.files[REGISTRY_PATHS.status] = file('registry/status-emergency.json');
    assert.equal((await s.sync.sync()).status, 'accepted');
    assert.deepEqual(s.sync.status(), { freshness: 'fresh', emergency: true, monotonic: 11, portalModeCeiling: { hometax: 'assisted' }, killPlaybooks: ['hometax.invoice.cancel'] });
    s.reg.files[REGISTRY_PATHS.status] = file('registry/status.json');
    s.store.set('etag.status', null);
    assert.equal((await s.sync.sync()).status, 'registry.version_rollback');
    const forged = json<RegistryStatus>('registry/status.json');
    forged.portalModeCeiling = { hometax: 'auto', gov24: 'auto' } as RegistryStatus['portalModeCeiling'];
    forged.monotonic = 12;
    s.reg.files[REGISTRY_PATHS.status] = bytes(forged);
    assert.equal((await s.sync.sync()).status, 'registry.signature_insufficient');
    now = Date.parse('2026-11-07T00:00:01Z'); // 발행 48시간 넘음
    assert.equal(s.sync.status().freshness, 'stale');
    now = Date.parse('2026-11-08T00:00:01Z'); // 긴급본 72시간 넘음 → 2-of-3(monotonic 10)로
    const st = s.sync.status();
    assert.equal(st.emergency, false);
    assert.equal(st.monotonic, 10);
    assert.equal(st.freshness, 'daemon_stop');
  });

  it('인덱스 변조 → 데이터 패키지를 받지 않는다, .sxp 바이트가 인덱스와 다르면 거부, 표는 그대로', async () => {
    const files = baseFiles();
    const ix = json<RegistryIndex>('registry/stable/index.json');
    ix.entries[0]!.size += 1;
    files[REGISTRY_PATHS.index] = bytes(ix);
    const s = setup(files);
    const r = await s.sync.sync();
    assert.equal(r.index, 'registry.signature_insufficient');
    assert.equal(r.data['payroll.rate-tables'], 'registry.index_missing');
    assert.ok(!s.reg.calls.some((c) => c.path === DATA_PATH));

    const f2 = baseFiles();
    const sxp = Buffer.from(f2[DATA_PATH]!);
    sxp[sxp.length - 3] ^= 1;
    f2[DATA_PATH] = new Uint8Array(sxp);
    const s2 = setup(f2);
    assert.equal((await s2.sync.sync()).data['payroll.rate-tables'], 'registry.content_digest_mismatch');
    assert.equal(s2.rates.installedPackage('payroll.rate-tables'), null);
  });

  it('데이터 패키지: 인덱스가 가리키는 .sxp가 데이터가 아니면·기술자 서명이 모자라면 거부, 낮은 판은 내리지 않는다', async () => {
    // 인덱스의 데이터 항목이 플레이북 .sxp를 가리키게(다시 서명)
    const pb = file('packages/hometax.invoice.lookup@1.0.0.sxp');
    const files = { ...baseFiles(), [DATA_PATH]: pb, [REGISTRY_PATHS.index]: reindex((ix) => ({ ...ix, entries: ix.entries.map((e) => (e.kind === 'data' ? { ...e, sxpDigest: sha256Hex(pb), size: pb.length } : e)) })) };
    const s = setup(files);
    assert.equal((await s.sync.sync()).data['payroll.rate-tables'], 'registry.kind_mismatch');
    // 설치본보다 낮은 판만 가리키면 그대로
    const s3 = setup();
    await s3.sync.sync();
    s3.reg.files[REGISTRY_PATHS.index] = reindex((ix) => ({ ...ix, monotonic: 8, entries: ix.entries.map((e) => (e.kind === 'data' ? { ...e, version: '2026.10.1' } : e)) }));
    s3.reg.calls.length = 0;
    const r = await s3.sync.sync();
    assert.equal(r.index, 'accepted');
    assert.equal(r.data['payroll.rate-tables'], 'unchanged');
    assert.ok(!s3.reg.calls.some((c) => c.path.startsWith('/packages/')));
  });

  it('롤아웃: 기기 id가 없으면 100%만, 있으면 서버와 같은 버킷 규칙', async () => {
    const files = { ...baseFiles(), [REGISTRY_PATHS.index]: reindex((ix) => ({ ...ix, entries: ix.entries.map((e) => (e.kind === 'data' ? { ...e, rolloutPercent: 50 } : e)) })) };
    assert.equal((await setup(files).sync.sync()).data['payroll.rate-tables'], 'unchanged');
    let inside = '';
    let outside = '';
    for (let i = 0; i < 400 && (!inside || !outside); i++) {
      const d = `dev-${i}`;
      if (rolloutBucket('payroll.rate-tables', d) < 50) inside ||= d;
      else outside ||= d;
    }
    assert.equal((await setup(files, { deviceId: inside }).sync.sync()).data['payroll.rate-tables'], 'accepted');
    assert.equal((await setup(files, { deviceId: outside }).sync.sync()).data['payroll.rate-tables'], 'unchanged');
    for (let i = 0; i < 50; i++) assert.equal(rolloutBucket('payroll.rate-tables', `d${i}`), serverBucket('payroll.rate-tables', `d${i}`));
  });
});

describe('인덱스 수용: services/registry verifyIndex와 같은 판정', () => {
  const roots = trustRootsFromPin(TRUST);
  const trust = TRUST as never;
  const base = json<RegistryIndex>('registry/stable/index.json');
  const cases: Array<[string, (ix: RegistryIndex) => RegistryIndex, boolean]> = [
    ['원본', (ix) => ix, true],
    ['핫픽스 항목', (ix) => ({ ...ix, entries: [...ix.entries, { id: 'hometax.invoice.issue.hotfix', version: '1.3.0', kind: 'hotfix', portal: 'hometax', sxpDigest: 'a'.repeat(64), size: 10, rolloutPercent: 100 }] }), false],
    ['위택스', (ix) => ({ ...ix, entries: [...ix.entries, { ...ix.entries[0]!, id: 'wetax.x.y', portal: 'wetax' }] }), false],
    ['fixture 포털(ADR-039)', (ix) => ({ ...ix, entries: [...ix.entries, { ...ix.entries[0]!, id: 'fixture.x.y', portal: 'fixture' }] }), false],
    ['중복 항목', (ix) => ({ ...ix, entries: [...ix.entries, ix.entries[0]!] }), false],
    ['모르는 필드', (ix) => ({ ...ix, extra: 1 }) as RegistryIndex, false],
    ['항목 모르는 필드', (ix) => ({ ...ix, entries: [{ ...ix.entries[0]!, x: 1 } as never] }), false],
    ['14일 초과', (ix) => ({ ...ix, expiresAt: '2026-11-19T00:00:01Z' }), false],
    ['미래 발행', (ix) => ({ ...ix, issuedAt: '2026-11-05T06:05:01Z', expiresAt: '2026-11-12T00:00:00Z' }), false],
    ['도착 시 만료', (ix) => ({ ...ix, issuedAt: '2026-11-04T00:00:00Z', expiresAt: '2026-11-05T05:59:59Z' }), false],
    ['다른 채널', (ix) => ({ ...ix, channel: 'beta' }), false],
    ['keyEpoch 다름', (ix) => ({ ...ix, keyEpoch: 2 }), false],
    ['size 0', (ix) => ({ ...ix, entries: [{ ...ix.entries[0]!, size: 0 }] }), false],
    ['rollout 101', (ix) => ({ ...ix, entries: [{ ...ix.entries[0]!, rolloutPercent: 101 }] }), false],
    ['빈 항목', (ix) => ({ ...ix, entries: [] }), true],
  ];
  for (const [name, mut, ok] of cases) {
    it(`${name} → ${ok ? '받음' : '거부'}`, () => {
      const doc = sign(mut(structuredClone(base)));
      const e = acceptIndex(doc, { roots, revoked: new Set(), current: null, now: SAMPLE_NOW });
      let s: boolean;
      try {
        verifyIndex(doc as never, 'stable', trust, new Set(), null, SAMPLE_NOW);
        s = true;
      } catch {
        s = false;
      }
      assert.equal(e.ok, ok, e.ok ? 'engine ok' : e.code);
      assert.equal(s, ok, 'server');
    });
  }
  it('단조: 되감기·같은 값 다른 내용·+1000 초과는 거부, 같은 내용 재전송은 받음', () => {
    const cur = acceptIndex(sign(structuredClone(base)), { roots, revoked: new Set(), current: null, now: SAMPLE_NOW });
    assert.ok(cur.ok);
    const at = (m: (ix: RegistryIndex) => RegistryIndex) => acceptIndex(sign(m(structuredClone(base))), { roots, revoked: new Set(), current: cur.ok ? cur.accepted : null, now: SAMPLE_NOW });
    assert.equal(at((ix) => ix).ok, true);
    assert.deepEqual(pick(at((ix) => ({ ...ix, monotonic: 6 }))), 'registry.version_rollback');
    assert.deepEqual(pick(at((ix) => ({ ...ix, entries: [] }))), 'registry.version_rollback');
    assert.deepEqual(pick(at((ix) => ({ ...ix, monotonic: 1008 }))), 'registry.version_jump_rejected');
    assert.equal(at((ix) => ({ ...ix, monotonic: 1007 })).ok, true);
    // 폐기된 패키지 키의 서명은 세지 않는다
    const rev = acceptIndex(sign(structuredClone(base)), { roots, revoked: new Set(['package-1']), current: null, now: SAMPLE_NOW });
    assert.deepEqual(rev.ok ? null : [rev.code, rev.events], ['registry.signature_insufficient', ['registry.key_revoked']]);
  });
});

describe('핀 키·main 통로', () => {
  it('trustRootsFromPin: 역할별 키 수·base64·역할 사이 같은 keyId를 본다, release는 엔진이 쓰지 않는다', () => {
    assert.equal(trustRootsFromPin(TRUST).rootKeys.size, 3);
    const bad = (m: (t: TrustPin) => void) => {
      const t = structuredClone(TRUST);
      m(t);
      assert.throws(() => trustRootsFromPin(t), /registry\.pin_invalid/);
    };
    bad((t) => delete t.keys.timestamp);
    bad((t) => (t.keys.root = { 'root-1': t.keys.root!['root-1']! }));
    bad((t) => (t.keys.package!['package-1'] = 'AAAA'));
    bad((t) => (t.keys.package!['package-1'] = t.keys.package!['package-1']!.replace(/=$/, '')));
    bad((t) => {
      // 역할 사이에 같은 keyId(정책 키 하나를 root-1 이름으로)
      const p3 = t.keys.policy!['policy-3']!;
      delete t.keys.policy!['policy-3'];
      t.keys.policy!['root-1'] = p3;
    });
    bad((t) => (t.keyEpoch = 0));
    bad((t) => (t.keys.emergency = { ...t.keys.emergency, 'emergency-2': t.keys.emergency!['emergency-1']! }));
    const noRelease = structuredClone(TRUST);
    delete noRelease.keys.release;
    assert.equal(trustRootsFromPin(noRelease).keyEpoch, 1);
  });

  it('제품 핀은 keyEpoch 1 서명 의식 결과(trust-root.json)와 같고, 시험 키를 넣지 않았다', () => {
    const published = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../services/registry/ceremony/keyepoch-1/trust-root.json'), 'utf8')) as TrustPin;
    assert.deepEqual(REGISTRY_TRUST_PIN, published);
    assert.equal(trustRootsFromPin(REGISTRY_TRUST_PIN!).keyEpoch, 1);
    const pubs = (p: TrustPin) => Object.values(p.keys).flatMap((ks) => Object.values(ks ?? {}));
    const fixture = new Set(pubs(TRUST));
    assert.ok(!pubs(REGISTRY_TRUST_PIN!).some((k) => fixture.has(k)), '시험 시드 공개키가 제품 핀에 있다');
    assert.equal(new Set(pubs(REGISTRY_TRUST_PIN!)).size, 12, '키 12개, 서로 다르다');
  });

  it('질의·명령은 main 전용 목록에만 있다(렌더러 목록 READ_QUERIES·COMMANDS에 없음), handle이 같은 이름을 받는다', async () => {
    assert.deepEqual([...REGISTRY_MAIN_ONLY].sort(), [...REGISTRY_READ_QUERIES, ...REGISTRY_COMMANDS].sort());
    for (const m of REGISTRY_MAIN_ONLY) {
      assert.ok(!(READ_QUERIES as readonly string[]).includes(m) && !(COMMANDS as readonly string[]).includes(m) && !(MAIN_ONLY as readonly string[]).includes(m), m);
    }
    const s = setup();
    await s.sync.handle('registry.sync');
    assert.deepEqual(await s.sync.handle('db.query.registry.revocation'), s.sync.revocation());
    assert.deepEqual(await s.sync.handle('db.query.registry.pins'), TRUST);
    assert.deepEqual(await s.sync.handle('db.query.registry.status'), s.sync.status());
    await assert.rejects(s.sync.handle('db.query.registry.other'), /unknown_method/);
    // 질의 결과는 구조화 복제로 main에 간다(Set·KeyObject 없음)
    for (const m of REGISTRY_READ_QUERIES) {
      const v = await s.sync.handle(m);
      assert.doesNotThrow(() => structuredClone(v), m);
    }
    assert.ok(Array.isArray(s.sync.revocation().keyIds));
  });

  it('엔진 진입점 배선: 레지스트리 이름을 허용하고, 핀이 없으면 registry.not_pinned, fetch는 Egress 레지스트리 바이트 GET(PR-D2), H-01 패키지를 받는다', () => {
    const src = fs.readFileSync(path.resolve(import.meta.dirname, '../packages/engine/src/entry.ts'), 'utf8');
    assert.match(src, /REGISTRY_READ_QUERIES, \.\.\.REGISTRY_COMMANDS/);
    assert.match(src, /registry\.not_pinned/);
    assert.match(src, /if \(REGISTRY_TRUST_PIN\) registry = new RegistrySync\(\{ trust: REGISTRY_TRUST_PIN, fetch: egressRegistryFetch\(egress\), store: settingsRegistryStore\(db\), packages: \{ ids: \[PRODUCT_PACKAGES\.h01\] \},/);
    assert.ok(!/fetch\(/.test(fs.readFileSync(path.resolve(import.meta.dirname, '../packages/engine/src/registry-sync.ts'), 'utf8').replace(/this\.o\.fetch!\(/g, '')), '동기화 모듈은 전역 fetch를 쓰지 않는다');
  });
});

describe('정책 동기화(/policy/current.json, D03 §7.1, 팀장 결정 2026-11-09 ②)', () => {
  const POL = () => json<Policy>('policy/current.json');
  /** 정책 키 2-of-3(또는 주어진 서명자) + 타임스탬프로 다시 서명. */
  const signPolicy = (p: Policy, signers = K.pol.slice(0, 2)) => bytes(signTimestamped(p, signers, K.ts));

  it('status 뒤에 받아 검증·클램프해 저장하고, policy()가 마지막 유효 정책과 신선도를 준다', async () => {
    const s = setup();
    assert.equal(s.sync.policy().freshness, 'none', '받기 전에는 none');
    const r = await s.sync.sync();
    assert.equal(r.policy, 'accepted');
    const v = s.sync.policy();
    assert.equal(v.freshness, 'fresh');
    assert.equal(v.monotonic, POL().monotonic);
    assert.equal(v.emergency, false);
    assert.equal(v.policy?.limits.hometax?.runsPerDayPerProfile, POL().limits.hometax?.runsPerDayPerProfile);
    assert.equal((await s.sync.sync()).policy, 'unchanged', 'ETag 304');
  });

  it('신선도: 만료 뒤 168시간 안은 stale(유지), 그 뒤는 fallback', async () => {
    const s = setup();
    await s.sync.sync();
    const exp = Date.parse(s.sync.policy().policy!.expiresAt);
    s.setNow(exp + 1);
    assert.equal(s.sync.policy().freshness, 'stale');
    assert.ok(s.sync.policy().policy, '마지막 유효 정책은 그대로 둔다');
    s.setNow(exp + 168 * H + 1);
    assert.equal(s.sync.policy().freshness, 'fallback');
  });

  it('서명이 모자라거나 내용이 바뀐 정책은 거부하고 마지막 유효 정책을 지킨다', async () => {
    const files = baseFiles();
    const s = setup(files);
    await s.sync.sync();
    const before = s.sync.policy();
    const forged = POL();
    forged.monotonic += 1;
    forged.limits.hometax!.runsPerDayPerProfile += 1;
    files[REGISTRY_PATHS.policy] = bytes(forged);
    assert.equal((await s.sync.sync()).policy, 'registry.signature_insufficient');
    files[REGISTRY_PATHS.policy] = signPolicy({ ...POL(), monotonic: POL().monotonic + 1 }, K.pol.slice(0, 1));
    assert.equal((await s.sync.sync()).policy, 'registry.signature_insufficient', '정책 키 하나');
    assert.deepEqual(s.sync.policy(), before);
  });

  it('1인 긴급 키: 엄격하게 보수적인 변경만 받는다(완화는 policy.rejected_not_conservative)', async () => {
    const files = baseFiles();
    const s = setup(files);
    await s.sync.sync();
    const base = POL();
    const looser = structuredClone(base);
    looser.monotonic += 1;
    looser.limits.hometax!.runsPerDayPerProfile += 1;
    files[REGISTRY_PATHS.policy] = signPolicy(looser, [K.emergency]);
    assert.equal((await s.sync.sync()).policy, 'policy.rejected_not_conservative');
    const tighter = structuredClone(base);
    tighter.monotonic += 1;
    tighter.limits.hometax!.runsPerDayPerProfile -= 1;
    files[REGISTRY_PATHS.policy] = signPolicy(tighter, [K.emergency]);
    assert.equal((await s.sync.sync()).policy, 'accepted');
    assert.equal(s.sync.policy().emergency, true);
    assert.equal(s.sync.policy().policy?.limits.hometax?.runsPerDayPerProfile, base.limits.hometax!.runsPerDayPerProfile - 1);
  });

  it('monotonic 역행은 거부한다', async () => {
    const files = baseFiles();
    const s = setup(files);
    await s.sync.sync();
    files[REGISTRY_PATHS.policy] = signPolicy({ ...POL(), monotonic: POL().monotonic - 1 });
    assert.equal((await s.sync.sync()).policy, 'registry.version_rollback');
  });

  it('정책 파일이 없으면 registry.not_found, 다른 단계는 그대로 진행하고 policy()는 none', async () => {
    const files = baseFiles() as Record<string, Uint8Array>;
    delete files[REGISTRY_PATHS.policy];
    const s = setup(files);
    const r = await s.sync.sync();
    assert.equal(r.policy, 'registry.not_found');
    assert.equal(r.index, 'accepted');
    assert.equal(s.sync.policy().freshness, 'none');
  });
});

// ── 도우미 ──
function pick(r: { ok: boolean; code?: string }) {
  return r.ok ? 'ok' : r.code;
}
/** 인덱스를 패키지 키 1·2로 다시 서명한다. */
function sign(ix: RegistryIndex): RegistryIndex {
  const doc = { ...ix } as RegistryIndex & { signatures?: unknown };
  delete doc.signatures;
  return { ...doc, signatures: K.pkg.slice(0, 2).map((k) => sigOf(k, canonicalWithout(doc, ['signatures']))) } as RegistryIndex;
}
function reindex(m: (ix: RegistryIndex) => RegistryIndex): Uint8Array {
  return bytes(sign(m(json<RegistryIndex>('registry/stable/index.json'))));
}
/** 폐기 목록을 루트 1·2 + 타임스탬프로 다시 서명한다. */
function resign(list: RevokedKeys): RevokedKeys {
  return signTimestamped(list, K.root.slice(0, 2), K.ts);
}
