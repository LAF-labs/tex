// 고정 시드 레지스트리 샘플 묶음(tests/fixtures/registry): 클라우드 레지스트리(services/registry)와 엔진의 상호 검증용.
// Ed25519 서명은 결정적이므로 같은 시드·같은 문서면 같은 바이트가 나온다. core-registry-samples.test.ts가 파일과 이 생성 결과를 바이트 단위로 비교한다.
// 키는 시험 전용 공개 시드다(실제 키 아님). 다시 만들기: SAX_WRITE_REGISTRY_SAMPLES=1 node --test --conditions=development tests/core-registry-samples.test.ts
import { createPrivateKey, createPublicKey } from 'node:crypto';
import {
  canonicalJson, canonicalWithout, encodeSxp, hotfixIndexName, manifestDigest, sha256Hex,
  type Hotfix, type PackageFiles, type Policy, type RawPackage, type RegistryStatus, type RevokedKeys, type TrustRoots,
} from '@sax/engine/core';
import { POLICY_EXAMPLE, h01, lookups, sigOf, signPackage, signTimestamped, type TestKey } from './core-fixtures.ts';

/** 샘플이 모두 유효한 기준 시각. */
export const SAMPLE_NOW = Date.parse('2026-11-05T06:00:00Z');
const ISSUED = '2026-11-05T00:00:00Z';
const PLUS_H = (h: number) => new Date(Date.parse(ISSUED) + h * 3_600_000).toISOString().replace('.000Z', 'Z');

/** 역할 → keyId → 시드 바이트(32바이트를 이 값으로 채운다). */
export const SAMPLE_SEEDS = {
  root: { 'root-1': 0x11, 'root-2': 0x12, 'root-3': 0x13 },
  package: { 'package-1': 0x21, 'package-2': 0x22, 'package-3': 0x23 },
  policy: { 'policy-1': 0x31, 'policy-2': 0x32, 'policy-3': 0x33 },
  emergency: { 'emergency-1': 0x41 },
  timestamp: { 'timestamp-1': 0x51 },
  release: { 'release-1': 0x61 },
} as const;

const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
function seedKey(keyId: string, seed: number): TestKey {
  const priv = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, Buffer.alloc(32, seed)]), format: 'der', type: 'pkcs8' });
  return { keyId, priv, pub: createPublicKey(priv) };
}
const keysOf = (role: keyof typeof SAMPLE_SEEDS) => Object.entries(SAMPLE_SEEDS[role]).map(([id, s]) => seedKey(id, s));
const rawPub = (k: TestKey) => k.pub.export({ format: 'der', type: 'spki' }).subarray(12);

export function sampleKeys() {
  const root = keysOf('root');
  const pkg = keysOf('package');
  const pol = keysOf('policy');
  const [emergency] = keysOf('emergency');
  const [ts] = keysOf('timestamp');
  const map = (ks: TestKey[]) => new Map(ks.map((k) => [k.keyId, k.pub]));
  const roots: TrustRoots = { keyEpoch: 1, rootKeys: map(root), packageKeys: map(pkg), policyKeys: map(pol), emergencyKey: { keyId: emergency!.keyId, key: emergency!.pub }, timestampKey: { keyId: ts!.keyId, key: ts!.pub } };
  return { root, pkg, pol, emergency: emergency!, ts: ts!, roots };
}

/** 데이터 패키지 샘플 본문(packages/payroll rate-table-package.schema.json 모양, data/rate-tables.json의 비과세 표만). 값은 시험용이다. */
export const SAMPLE_RATE_TABLES = {
  schema: 'sax.rate-tables/v1',
  packageVersion: '2026.11.1',
  tables: [
    {
      id: 'nontax-2026', kind: 'nontax_limits', effectiveFrom: '2026-01-01', effectiveTo: null, rounding: 'floor_1', review: 'needs_review',
      sources: [{ title: '소득세법 제12조제3호(비과세 근로소득)', url: 'https://www.law.go.kr/법령/소득세법/제12조' }],
      body: {
        kinds: {
          meal: { label: '식대', monthlyLimit: 200000, basis: '소득세법 제12조제3호러목' },
          vehicle: { label: '자가운전보조금', monthlyLimit: 200000, basis: '소득세법 시행령 제12조제3호' },
          childcare: { label: '출산·보육수당', monthlyLimit: 200000, basis: '소득세법 제12조제3호머목(자녀 1명당)' },
          research: { label: '연구보조비', monthlyLimit: 200000, basis: '소득세법 시행령 제12조제12호' },
        },
      },
    },
  ],
} as const;

const json = (o: unknown) => Buffer.from(`${JSON.stringify(o, null, 2)}\n`, 'utf8');
const jcsBytes = (o: unknown) => Buffer.from(canonicalJson(o), 'utf8');
const pkgPath = (id: string, version: string) => `packages/${id}@${version}.sxp`;

/** 파일 경로(tests/fixtures/registry 기준) → 바이트. */
export function buildSamples(): Map<string, Buffer> {
  const K = sampleKeys();
  const two = K.pkg.slice(0, 2);
  const out = new Map<string, Buffer>();

  // 핀 고정 키(services/registry TrustRoot 모양: 역할 → keyId → 표준 base64 공개키 32바이트)
  const keys: Record<string, Record<string, string>> = {};
  for (const [role, ids] of Object.entries(SAMPLE_SEEDS)) keys[role] = Object.fromEntries(Object.entries(ids).map(([id, s]) => [id, rawPub(seedKey(id, s)).toString('base64')]));
  out.set('trust.json', json({ keyEpoch: 1, keys }));

  // 패키지: 조회 2개 → H-01(lookupsUsed[].digest = 조회 manifest 다이제스트)
  const lookupDigest = new Map<string, string>();
  const entries: Array<Record<string, unknown>> = [];
  const addPkg = (files: PackageFiles, raw: RawPackage) => {
    const sxp = encodeSxp({ kind: 'package', raw });
    const { id, version, kind, portal } = files.manifest;
    out.set(pkgPath(id, version), sxp);
    entries.push({ id, version, kind, portal, sxpDigest: sha256Hex(sxp), size: sxp.length, rolloutPercent: 100 });
  };
  for (const [id, files] of lookups()) {
    const raw = signPackage(files, two);
    lookupDigest.set(id, manifestDigest(JSON.parse(raw.manifest.toString('utf8')) as never));
    addPkg(files, raw);
  }
  const h = h01();
  const hRaw = signPackage(h, two, h.manifest.lookupsUsed.map((l) => lookupDigest.get(l.id)!));
  addPkg(h, hRaw);

  // 핫픽스: 적격 항목 하나의 candidates 교체
  const hf = {
    appliesTo: { id: h.manifest.id, version: h.manifest.version, packageDigest: manifestDigest(JSON.parse(hRaw.manifest.toString('utf8')) as never) },
    version: 1, monotonic: 3, keyEpoch: 1, issuedAt: ISSUED, expiresAt: PLUS_H(7 * 24),
    entries: { 'hometax.login.simpleAuthButton': { candidates: [{ kind: 'role', role: 'button', name: '간편인증 로그인' }] } },
    signatures: [],
  } as unknown as Hotfix;
  hf.signatures = two.map((k) => sigOf(k, canonicalWithout(hf, ['signatures'])));
  const hfSxp = encodeSxp({ kind: 'hotfix', bytes: jcsBytes(hf) });
  const hfName = hotfixIndexName(hf);
  out.set(pkgPath(hfName.id, hfName.version), hfSxp);

  // 인덱스(ADR-043): 내용 = 인덱스 − signatures·issuedAt·expiresAt·timestamp에 패키지 키 2-of-3, 신선도 = 타임스탬프 키(받는 쪽 상한 14일)
  const index = (channel: string, es: Array<Record<string, unknown>>, monotonic: number) =>
    json(signTimestamped({ channel, monotonic, keyEpoch: 1, issuedAt: ISSUED, expiresAt: PLUS_H(14 * 24), entries: es, signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' } }, two, K.ts));
  // 데이터 패키지(SIGNING.md §6 kind:data): 급여 비과세 한도 표 하나(sax.rate-tables/v1). 기술자 = 패키지 키 2-of-3, bodyDigest = 본문 원시 바이트.
  const body = json(SAMPLE_RATE_TABLES);
  const desc: Record<string, unknown> = { id: 'payroll.rate-tables', version: SAMPLE_RATE_TABLES.packageVersion, schema: SAMPLE_RATE_TABLES.schema, bodyDigest: sha256Hex(body), keyEpoch: 1, issuedAt: ISSUED };
  desc.signatures = two.map((k) => sigOf(k, canonicalWithout(desc, ['signatures'])));
  const dataSxp = encodeSxp({ kind: 'data', raw: { descriptor: jcsBytes(desc), body } });
  out.set(pkgPath('payroll.rate-tables', SAMPLE_RATE_TABLES.packageVersion), dataSxp);
  entries.push({ id: 'payroll.rate-tables', version: SAMPLE_RATE_TABLES.packageVersion, kind: 'data', sxpDigest: sha256Hex(dataSxp), size: dataSxp.length, rolloutPercent: 100 });

  out.set('registry/stable/index.json', index('stable', entries, 7));
  out.set('registry/hotfix/index.json', index('hotfix', [{ ...hfName, kind: 'hotfix', portal: 'hometax', sxpDigest: sha256Hex(hfSxp), size: hfSxp.length, rolloutPercent: 100 }], 3));

  // 정책(정책 키 2-of-3 + 타임스탬프, 48시간)
  const pol = structuredClone(POLICY_EXAMPLE) as unknown as Policy;
  pol.issuedAt = ISSUED;
  pol.expiresAt = PLUS_H(48);
  out.set('policy/current.json', json(signTimestamped(pol, K.pol.slice(0, 2), K.ts)));

  // status(2-of-3)와 그 위의 긴급 하향(긴급 키 1개, monotonic +1)
  const status = (o: Partial<RegistryStatus>, signers: TestKey[]) =>
    signTimestamped({ monotonic: 10, keyEpoch: 1, issuedAt: ISSUED, expiresAt: PLUS_H(48), portalModeCeiling: { hometax: 'auto' }, killPlaybooks: [], signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' }, ...o } as RegistryStatus, signers, K.ts);
  out.set('registry/status.json', json(status({}, K.pol.slice(0, 2))));
  out.set('registry/status-emergency.json', json(status({ monotonic: 11, portalModeCeiling: { hometax: 'assisted' }, killPlaybooks: ['hometax.invoice.cancel'] }, [K.emergency])));

  // 폐기 목록(루트 2-of-3 + 타임스탬프, 24시간). 샘플 키는 하나도 폐기하지 않는다(package-0은 핀에 없는 키).
  out.set('registry/revoked_keys.json', json(signTimestamped({ revoked: [{ keyId: 'package-0', role: 'package', revokedAt: ISSUED }], monotonic: 1, keyEpoch: 1, issuedAt: ISSUED, expiresAt: PLUS_H(24), signatures: [], timestamp: { keyId: '', alg: 'ed25519', sig: '' } } as RevokedKeys, K.root.slice(0, 2), K.ts)));
  return out;
}
