// M1-4 패키지 로더(D03 §3.1 1~8단계, B-01·B-08·B-22·C-26, ADR-021): 서명 2-of-3·폐기 키, 원시 바이트 내용 결속, 버전 내림 금지,
// 번들 허용 목록(BV-06), 조회 하위 패키지(V-22), 정적 검증, 핫픽스(적격·서명·단조·14일·정책 만료·재검증), 승인 바 요약 표, 보류.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { canonicalWithout, hotfixDigest, loadPackage, packageDigest, type Hotfix, type LoadedPackage, type LoaderContext, type PackageFiles, type RawPackage, type VersionMark } from '@sax/engine/core';
import { bundleOutcomes, digestOfRaw, h01, lookups, sigOf, signPackage, testKeys, type TestKey } from './core-fixtures.ts';

const K = testKeys();
const NOW = Date.parse('2026-11-05T12:00:00+09:00');
const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();
const two = K.pkg.slice(0, 2);
const BUNDLES = bundleOutcomes();

const baseCtx = (o: Partial<LoaderContext> = {}): LoaderContext => ({
  roots: K.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: BUNDLES, installedLookups: new Map(),
  storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: NOW, ...o,
});

/** 조회 패키지 2개를 먼저 로드한다(lookupsUsed 순서). */
function installedLookups(): Map<string, LoadedPackage> {
  const out = new Map<string, LoadedPackage>();
  for (const [id, files] of lookups()) {
    const r = loadPackage(signPackage(files, two), baseCtx());
    assert.ok(r.ok, `조회 패키지 ${id} 로드`);
    out.set(id, r.pkg);
  }
  return out;
}
const LOOKUPS = installedLookups();
const lookupDigests = (files: PackageFiles) => files.manifest.lookupsUsed.map((l) => LOOKUPS.get(l.id)!.manifestDigest);
const signH01 = (f: (p: PackageFiles) => void = () => {}, signers: TestKey[] = two): RawPackage => {
  const p = h01();
  f(p);
  return signPackage(p, signers, lookupDigests(p));
};
const load = (raw: RawPackage, o: Partial<LoaderContext> = {}) => loadPackage(raw, baseCtx({ installedLookups: LOOKUPS, ...o }));
const code = (r: ReturnType<typeof loadPackage>) => (r.ok ? 'ok' : r.code);

describe('loadPackage: 골든 H-01', () => {
  it('2-of-3 서명·결속·번들·조회·정적 검증·요약 표를 통과한다', () => {
    const r = load(signH01());
    assert.ok(r.ok, r.ok ? '' : `${r.code} ${JSON.stringify(r.violations)}`);
    assert.equal(r.pkg.hotfix, null);
    assert.deepEqual(r.pkg.lookupDigests, lookupDigests(h01()));
    assert.deepEqual(r.events, []);
  });
  it('packageDigest는 핫픽스·조회·정책·프로필 버전마다 달라진다(B-08)', () => {
    const b = { manifest: 'a'.repeat(64), hotfix: null, lookups: ['b'], policyVersion: '2026.10', profileVersion: '1' };
    const d = packageDigest(b);
    for (const o of [{ hotfix: 'c' }, { lookups: ['c'] }, { policyVersion: '2026.11' }, { profileVersion: '2' }]) assert.notEqual(packageDigest({ ...b, ...o }), d);
  });
});

describe('1단계 서명', () => {
  it('서명 1개면 registry.signature_insufficient(스키마도 2개 이상 요구)', () => {
    assert.match(code(load(signH01(undefined, [K.pkg[0]!]))), /schema_invalid|signature_insufficient/);
  });
  it('같은 키 두 번은 1개로 센다', () => assert.equal(code(load(signH01(undefined, [K.pkg[0]!, K.pkg[0]!]))), 'registry.signature_insufficient'));
  it('정책 키·루트 키 서명은 패키지 서명이 아니다', () => assert.equal(code(load(signH01(undefined, [K.pol[0]!, K.root[0]!]))), 'registry.signature_insufficient'));
  it('폐기된 키는 세지 않고 registry.key_revoked를 남긴다', () => {
    const r = load(signH01(), { revoked: new Set(['pkg-2']) });
    assert.equal(code(r), 'registry.signature_insufficient');
    assert.deepEqual(r.events, ['registry.key_revoked']);
    assert.ok(load(signH01(undefined, [K.pkg[0]!, K.pkg[1]!, K.pkg[2]!]), { revoked: new Set(['pkg-2']) }).ok, '남은 두 키로 2-of-3');
  });
  it('서명 뒤 manifest를 바꾸면(도메인 추가) 서명이 깨진다', () => {
    const raw = signH01();
    const m = JSON.parse(raw.manifest.toString());
    m.domains.push('evil.example');
    assert.equal(code(load({ ...raw, manifest: Buffer.from(JSON.stringify(m)) })), 'registry.signature_insufficient');
  });
});

describe('2단계 내용 결속(원시 바이트)', () => {
  it('playbook·selectors·strings 바이트가 하나라도 다르면 loader.content_digest_mismatch', () => {
    const raw = signH01();
    for (const k of ['playbook', 'selectors', 'strings'] as const) {
      const t = { ...raw, [k]: Buffer.concat([raw[k], Buffer.from(' ')]) };
      assert.equal(code(load(t)), 'loader.content_digest_mismatch', k);
    }
  });
});

describe('3단계 버전', () => {
  it('저장 버전보다 낮으면 registry.version_rollback', () => assert.equal(code(load(signH01(), { storedVersion: '2.2.0' })), 'registry.version_rollback'));
  it('같은 버전은 설치본과 같은 내용일 때만(재로드)', () => {
    const raw = signH01();
    assert.ok(load(raw, { storedVersion: '2.1.0', installedDigest: digestOfRaw(raw) }).ok);
    const other = signH01((p) => (p.strings['invoice.title'] = '세금계산서 발급(수정)'));
    assert.equal(code(load(other, { storedVersion: '2.1.0', installedDigest: digestOfRaw(raw) })), 'registry.version_rollback');
  });
  it('높은 버전은 받는다', () => assert.ok(load(signH01(), { storedVersion: '2.0.9' }).ok));
});

describe('4단계 번들(BV-06)', () => {
  it('허용 목록에 없는 번들 다이제스트는 loader.bundle_not_allowed', () => {
    const r = load(signH01((p) => (p.manifest.bundlesUsed[0]!.digest = 'f'.repeat(64))));
    assert.equal(code(r), 'loader.bundle_not_allowed');
    assert.equal(!r.ok && r.violations[0]?.rule, 'BV-06');
  });
  it('없는 번들 버전(ver)도 거부', () => assert.equal(code(load(signH01((p) => (p.manifest.bundlesUsed[0]!.ver = 9)))), 'loader.bundle_not_allowed'));
});

describe('5단계 조회 하위 패키지(V-22)', () => {
  it('설치되지 않은 조회 패키지는 loader.lookup_mismatch', () => assert.equal(code(load(signH01(), { installedLookups: new Map() })), 'loader.lookup_mismatch'));
  it('다이제스트가 다르면 거부', () => {
    const p = h01();
    const raw = signPackage(p, two, ['e'.repeat(64), lookupDigests(p)[1]!]);
    assert.equal(code(load(raw)), 'loader.lookup_mismatch');
  });
  it('kind가 lookup이 아닌 패키지는 조회로 쓸 수 없다', () => {
    const fake = new Map(LOOKUPS);
    const l = structuredClone(fake.get('hometax.invoice.lookup')!);
    l.files.manifest.kind = 'playbook';
    fake.set('hometax.invoice.lookup', l);
    assert.equal(code(load(signH01(), { installedLookups: fake })), 'loader.lookup_mismatch');
  });
});

describe('6단계 정적 검증', () => {
  it('서명이 맞아도 V-규칙 위반이면 로드하지 않는다(게이트 제거 → V-03a)', () => {
    const r = load(signH01((p) => {
      const g = p.playbook.steps.findIndex((s) => s.type === 'gate');
      p.playbook.steps.splice(g, 1);
    }));
    assert.equal(code(r), 'loader.static_invalid');
    assert.ok(!r.ok && r.violations.some((v) => v.rule.startsWith('V-')));
  });
});

describe('8단계 승인 바 요약 표(ADR-021)', () => {
  it('앱 내장 표에 없는 카드면 loader.approval_summary_missing', () => {
    assert.equal(code(load(signH01(), { approvalSummaries: new Map() })), 'loader.approval_summary_missing');
  });
  it('요약 fieldKey가 게이트 카드(readback)에 없으면 거부', () => {
    assert.equal(code(load(signH01(), { approvalSummaries: new Map([['invoice.confirm', ['counterpartName', 'unknownKey']]]) })), 'loader.approval_summary_missing');
  });
  it('커밋 게이트가 없는 조회 패키지는 표와 무관', () => {
    const [id, files] = [...lookups()][0]!;
    assert.ok(loadPackage(signPackage(files, two), baseCtx({ approvalSummaries: new Map() })).ok, id);
  });
});

describe('보류(헤드 불일치·폐기 목록 신선도 상실)', () => {
  it('새 패키지는 registry.update_held, 설치본은 계속 로드', () => {
    const raw = signH01();
    assert.equal(code(load(raw, { hold: true })), 'registry.update_held');
    assert.ok(load(raw, { hold: true, installedDigest: digestOfRaw(raw) }).ok);
  });
});

const ELIGIBLE = 'hometax.login.simpleAuthButton';
function hotfix(raw: RawPackage, o: Partial<Hotfix> = {}, signers: TestKey[] = two): Hotfix {
  const h: Hotfix = {
    appliesTo: { id: 'hometax.invoice.issue', version: '2.1.0', packageDigest: digestOfRaw(raw) },
    version: 1, monotonic: 3, keyEpoch: 1, issuedAt: iso(NOW - DAY), expiresAt: iso(NOW + 6 * DAY),
    entries: { [ELIGIBLE]: { candidates: [{ kind: 'role', role: 'button', name: '간편인증 로그인' }] } },
    signatures: [], ...o,
  } as Hotfix;
  const signed = canonicalWithout(h, ['signatures']);
  h.signatures = signers.map((k) => sigOf(k, signed));
  return h;
}

describe('7단계 핫픽스', () => {
  const raw = signH01();
  const withHf = (h: Hotfix, o: Partial<LoaderContext> = {}, stored: (VersionMark & { digest: string }) | null = null) => load(raw, { hotfix: { hotfix: h, stored }, ...o });
  const rejected = (r: ReturnType<typeof loadPackage>) => {
    assert.ok(r.ok, '핫픽스가 거부돼도 패키지는 로드');
    assert.equal(r.pkg.hotfix, null);
    assert.deepEqual(r.pkg.selectors, r.pkg.files.selectors, '원래 후보로');
    assert.ok(r.events.includes('registry.hotfix_rejected'));
  };
  it('적격 항목의 candidates만 교체하고 원본 사전은 그대로', () => {
    const r = withHf(hotfix(raw));
    assert.ok(r.ok);
    assert.ok(r.pkg.hotfix);
    assert.equal(r.pkg.selectors.entries[ELIGIBLE]!.candidates[0]!.name, '간편인증 로그인');
    assert.notEqual(r.pkg.files.selectors.entries[ELIGIBLE]!.candidates[0]!.name, '간편인증 로그인');
    assert.deepEqual(r.events, ['registry.hotfix_applied']);
  });
  it('커밋 항목(issueButton)은 적격이 아니다(E-03)', () => {
    const sel = h01().selectors;
    const commit = Object.keys(sel.entries).find((k) => sel.entries[k]!.commits)!;
    rejected(withHf(hotfix(raw, { entries: { [commit]: { candidates: [{ kind: 'role', role: 'button', name: '발급하기' }] } } })));
  });
  it('다른 패키지·다른 버전을 가리키면 거부', () => {
    rejected(withHf(hotfix(raw, { appliesTo: { id: 'hometax.invoice.issue', version: '2.1.0', packageDigest: 'a'.repeat(64) } })));
    rejected(withHf(hotfix(raw, { appliesTo: { id: 'hometax.invoice.issue', version: '2.0.0', packageDigest: digestOfRaw(raw) } })));
  });
  it('서명 부족·폐기 키', () => {
    rejected(withHf(hotfix(raw, {}, [K.pkg[0]!, K.pkg[0]!])));
    const rawB = signH01(undefined, [K.pkg[1]!, K.pkg[2]!]);
    rejected(load(rawB, { revoked: new Set(['pkg-1']), hotfix: { hotfix: hotfix(rawB, {}, [K.pkg[0]!, K.pkg[1]!]), stored: null } }));
  });
  it('monotonic 롤백·+1000 초과 점프', () => {
    const other = { keyEpoch: 1, monotonic: 3, digest: 'b'.repeat(64) };
    rejected(withHf(hotfix(raw), {}, other));
    rejected(withHf(hotfix(raw, { monotonic: 1004 }), {}, other));
    const r = withHf(hotfix(raw, { monotonic: 4 }), {}, other);
    assert.ok(r.ok && r.pkg.hotfix);
  });
  it('이미 적용한 핫픽스의 재로드(재시작)는 롤백이 아니다, 같은 monotonic에 내용이 다르면 거부', () => {
    const h = hotfix(raw);
    const st = { keyEpoch: h.keyEpoch, monotonic: h.monotonic, digest: hotfixDigest(h) };
    const r = withHf(h, {}, st);
    assert.ok(r.ok && r.pkg.hotfix);
    assert.equal(r.pkg.hotfix.digest, st.digest);
    rejected(withHf(hotfix(raw, { expiresAt: iso(NOW + 2 * DAY) }), {}, st));
  });
  it('14일 넘는 유효기간·만료·미래 issuedAt', () => {
    rejected(withHf(hotfix(raw, { issuedAt: iso(NOW - DAY), expiresAt: iso(NOW + 14 * DAY) })));
    rejected(withHf(hotfix(raw, { issuedAt: iso(NOW - 3 * DAY), expiresAt: iso(NOW - 1) })));
    rejected(withHf(hotfix(raw, { issuedAt: iso(NOW + 10 * 60_000), expiresAt: iso(NOW + DAY) })));
  });
  it('정책이 만료(stale)면 핫픽스 로드 거부(D03 §7.1 (c)), 보류 중에도 거부', () => {
    rejected(withHf(hotfix(raw), { policyFresh: false }));
    rejected(withHf(hotfix(raw), { hold: true, installedDigest: digestOfRaw(raw) }));
  });
  it('보류(hold) 중: 설치본에 이미 적용한 핫픽스는 그대로 얼려 두고, 새 핫픽스만 보류', () => {
    const h = hotfix(raw);
    const st = { keyEpoch: h.keyEpoch, monotonic: h.monotonic, digest: hotfixDigest(h) };
    const held = { hold: true, installedDigest: digestOfRaw(raw) };
    const r = withHf(h, held, st);
    assert.ok(r.ok && r.pkg.hotfix, '설치된 핫픽스 유지');
    assert.ok(r.events.includes('registry.hotfix_applied'));
    rejected(withHf(hotfix(raw, { monotonic: h.monotonic + 1 }), held, st));
    rejected(withHf(h, { ...held, policyFresh: false }, st));
  });
  it('조회 패키지에 대한 핫픽스는 항상 거부', () => {
    const files = lookups().get('hometax.invoice.lookup')!;
    const lraw = signPackage(files, two);
    const any = Object.keys(files.selectors.entries)[0]!;
    const r = loadPackage(lraw, baseCtx({ hotfix: { hotfix: hotfix(lraw, { appliesTo: { id: files.manifest.id, version: files.manifest.version, packageDigest: digestOfRaw(lraw) }, entries: { [any]: { candidates: [{ kind: 'role', role: 'button', name: 'x' }] } } }), stored: null } }));
    rejected(r);
  });
});
