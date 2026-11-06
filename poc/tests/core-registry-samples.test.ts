// 고정 시드 레지스트리 샘플(tests/fixtures/registry): 파일 = 생성 결과(바이트 단위), 그리고 엔진이 전부 받는다.
// 클라우드 레지스트리(services/registry)는 같은 파일로 자기 검증기를 돌려 상호 검증한다(SIGNING.md §10.3).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import {
  acceptPolicy, acceptRevoked, acceptStatus, canonicalWithout, countSignatures, decodeSxp, ed25519PublicKey, hotfixDigest, loadDataPackage, loadPackage, sha256Hex,
  type LoadedPackage, type LoaderContext, type Policy, type RegistryStatus, type RevokedKeys,
} from '@sax/engine/core';
import { validatePackage } from '@sax/payroll';
import { bundleOutcomes } from './core-fixtures.ts';
import { SAMPLE_NOW, buildSamples, sampleKeys } from './registry-samples.ts';

const DIR = path.resolve(import.meta.dirname, 'fixtures/registry');
const samples = buildSamples();

if (process.env.SAX_WRITE_REGISTRY_SAMPLES === '1') {
  for (const [p, b] of samples) {
    fs.mkdirSync(path.dirname(path.join(DIR, p)), { recursive: true });
    fs.writeFileSync(path.join(DIR, p), b);
  }
}

const file = (p: string) => fs.readFileSync(path.join(DIR, p));
const doc = <T>(p: string) => JSON.parse(file(p).toString('utf8')) as T;
const K = sampleKeys();

describe('레지스트리 샘플 묶음(고정 시드)', () => {
  it('파일은 생성 결과와 바이트 단위로 같다(서명은 결정적)', () => {
    const listed = fs.readdirSync(DIR, { recursive: true, withFileTypes: true }).filter((d) => d.isFile() && d.name !== 'README.md').map((d) => path.relative(DIR, path.join(d.parentPath, d.name)).split(path.sep).join('/')).sort(); // 샘플 키는 `/` 구분(Windows는 `\`)
    assert.deepEqual(listed, [...samples.keys()].sort());
    for (const [p, b] of samples) assert.ok(file(p).equals(b), p);
  });

  it('trust.json의 공개키 = 시드 키', () => {
    const t = doc<{ keyEpoch: number; keys: Record<string, Record<string, string>> }>('trust.json');
    assert.equal(t.keyEpoch, 1);
    for (const [id, b64] of Object.entries(t.keys.package!)) assert.ok(ed25519PublicKey(Buffer.from(b64, 'base64')).equals(K.roots.packageKeys.get(id)!), id);
    assert.ok(ed25519PublicKey(Buffer.from(t.keys.timestamp!['timestamp-1']!, 'base64')).equals(K.roots.timestampKey.key));
    assert.equal(Object.keys(t.keys.release!).join(), 'release-1', '릴리스 역할 키(시드 0x61, 앱 업데이트 서명)');
  });

  it('인덱스: 패키지 키 2-of-3, sxpDigest·size = .sxp 바이트', () => {
    for (const ch of ['stable', 'hotfix']) {
      const ix = doc<{ entries: Array<{ id: string; version: string; sxpDigest: string; size: number }>; signatures: never[] }>(`registry/${ch}/index.json`);
      assert.equal(countSignatures(canonicalWithout(ix, ['signatures']), ix.signatures, K.roots.packageKeys, new Set()).valid.length, 2, ch);
      for (const e of ix.entries) {
        const b = file(`packages/${e.id}@${e.version}.sxp`);
        assert.equal(sha256Hex(b), e.sxpDigest);
        assert.equal(b.length, e.size);
      }
    }
  });

  it('엔진 로더: 조회 2개 → H-01 + 핫픽스 적용', () => {
    const ctx = (o: Partial<LoaderContext> = {}): LoaderContext => ({
      roots: K.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups: new Map(),
      storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: SAMPLE_NOW, ...o,
    });
    const unpack = (p: string) => {
      const r = decodeSxp(file(p));
      assert.ok(r.ok && r.sxp.kind === 'package', p);
      return r.sxp.raw;
    };
    const installed = new Map<string, LoadedPackage>();
    for (const id of ['hometax.invoice.lookup', 'hometax.invoice.email_status']) {
      const r = loadPackage(unpack(`packages/${id}@1.0.0.sxp`), ctx());
      assert.ok(r.ok, id);
      installed.set(id, r.pkg);
    }
    const hx = decodeSxp(file('packages/hometax.invoice.issue.hotfix@1.3.0.sxp'));
    assert.ok(hx.ok && hx.sxp.kind === 'hotfix');
    const r = loadPackage(unpack('packages/hometax.invoice.issue@2.1.0.sxp'), ctx({ installedLookups: installed, hotfix: { hotfix: hx.sxp.hotfix, stored: null } }));
    assert.ok(r.ok, r.ok ? '' : r.code);
    assert.deepEqual(r.events, ['registry.hotfix_applied']);
    assert.equal(r.pkg.hotfix?.digest, hotfixDigest(hx.sxp.hotfix));
  });

  it('데이터 패키지(kind:data): 인덱스 항목 → .sxp → loadDataPackage(급여 검증기)', () => {
    const ix = doc<{ entries: Array<{ id: string; version: string; kind: string }> }>('registry/stable/index.json');
    const e = ix.entries.find((x) => x.kind === 'data');
    assert.ok(e);
    const d = decodeSxp(file(`packages/${e.id}@${e.version}.sxp`));
    assert.ok(d.ok && d.sxp.kind === 'data');
    const r = loadDataPackage(d.sxp.raw, { roots: K.roots, revoked: new Set(), schemas: new Map([['sax.rate-tables/v1', validatePackage]]), installed: null, hold: false, now: SAMPLE_NOW });
    assert.ok(r.ok, r.ok ? '' : r.code);
    assert.equal(r.data.descriptor.version, e.version);
  });

  it('정책·status·긴급 status·폐기 목록을 받는다', () => {
    const revoked = acceptRevoked(doc<RevokedKeys>('registry/revoked_keys.json'), { roots: K.roots, current: null, now: SAMPLE_NOW });
    assert.ok(revoked.ok);
    const rv = revoked.accepted.keyIds;
    const pol = acceptPolicy(doc<Policy>('policy/current.json'), { roots: K.roots, revoked: rv, current: null, hold: false, now: SAMPLE_NOW });
    assert.ok(pol.ok, pol.ok ? '' : pol.code);
    assert.equal(pol.accepted.emergency, false);
    const st = acceptStatus(doc<RegistryStatus>('registry/status.json'), { roots: K.roots, revoked: rv, current: null, now: SAMPLE_NOW });
    assert.ok(st.ok);
    const em = acceptStatus(doc<RegistryStatus>('registry/status-emergency.json'), { roots: K.roots, revoked: rv, current: st.accepted, now: SAMPLE_NOW });
    assert.ok(em.ok && em.accepted.emergency);
  });
});
