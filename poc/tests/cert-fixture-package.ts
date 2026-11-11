// ADR-039 fixture 포털 민원증명 패키지 빌더(시험 전용). 제품 원본(packages/engine/playbooks/hometax.cert.*)을 가짜 민원증명 페이지(tests/cert-fixture.ts)에 맞춘다.
// 바꾸는 것은 이것뿐이다: origin(https://hometax.go.kr → 127.0.0.1:PORT), id 접두(hometax. → fixture.), 포털(fixture), 로그인·캡차 스텝(s0~s6·s90~s93)과
// 그것만 쓰는 번들(screen_state)을 뺀다(가짜 페이지는 세션이 있다고 본다. H-01 fixture 패키지와 같음), 커밋 엔드포인트는 가짜 접수 POST다.
// 셀렉터 후보·흐름·입력 선언·승인 카드·verify는 제품 원본 그대로다. 그래서 실행 시험이 제품 패키지의 흐름을 그대로 돈다.
import { FIXTURE_PORTAL, loadPackage, APPROVAL_SUMMARIES, type LoadedPackage, type LoaderContext, type PackageFiles } from '@sax/engine/core';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { bundleOutcomes, loadPkg, signPackage, testKeys, type TestKeys } from './core-fixtures.ts';

/** 제품 민원증명 플레이북 id → 카탈로그 번호. */
export const CERT_PRODUCT_IDS = {
  'H-03': 'hometax.cert.biz_registration',
  'H-04': 'hometax.cert.taxpayment',
  'H-08': 'hometax.cert.vat_tax_base',
  'H-09': 'hometax.cert.financial_statements',
} as const;
export type CertCode = keyof typeof CERT_PRODUCT_IDS;
export const LOOKUP_PRODUCT_ID = 'hometax.cert.issued_list';
/** fixture 변형 id(hometax. → fixture.). */
export const fixtureCertId = (id: string) => id.replace(/^hometax\./, 'fixture.');

const LOGIN_STEPS = new Set(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's90', 's91', 's92', 's93']);

/** 제품 원본 → fixture 변형(서명 전). */
export function certFixtureFiles(productId: string, origin: string): PackageFiles {
  const host = new URL(origin).hostname;
  const text = JSON.stringify(loadPkg(productId)).replaceAll('https://hometax.go.kr', origin).replaceAll('"hometax.', '"fixture.');
  const f = JSON.parse(text) as PackageFiles;
  f.manifest.portal = FIXTURE_PORTAL;
  f.manifest.domains = [host];
  f.playbook.portal = FIXTURE_PORTAL;
  f.selectors.portal = FIXTURE_PORTAL;
  const lookup = f.manifest.kind === 'lookup';
  if (!lookup) {
    f.playbook.steps = f.playbook.steps.filter((s) => !LOGIN_STEPS.has(s.id));
    // screen_state는 로그인·캡차 decide(s2·s6·s93)만 쓴다
    f.manifest.bundlesUsed = f.manifest.bundlesUsed.filter((b) => b.id !== 'screen_state');
    // 로그인 전제(signMethod)는 엔진 startCert가 프로필로 본다. 패키지 전제 식은 그대로 둔다
    f.selectors.commitEndpoints = [{ match: { method: 'POST', pathPattern: '^/cert/issue$' }, effect: 'issue_document', maxRequests: 1, encoding: 'form' }] as PackageFiles['selectors']['commitEndpoints'];
    f.selectors.knownEndpoints = [{ method: 'GET', pathPattern: '^/$' }, { method: 'GET', pathPattern: '^/websquare/.*$' }, { method: 'GET', pathPattern: '^/cert/doc$' }] as PackageFiles['selectors']['knownEndpoints'];
  } else {
    f.selectors.knownEndpoints = [{ method: 'GET', pathPattern: '^/websquare/.*$' }] as PackageFiles['selectors']['knownEndpoints'];
  }
  return f;
}

export interface LoadedCertFixture {
  /** fixture id(fixture.cert.*) → 로드한 발급 패키지. */
  docs: Map<string, LoadedPackage>;
  lookups: Map<string, LoadedPackage>;
  keys: TestKeys;
}

/** 시험 키로 서명하고 개발 조건 로더로 로드한다(조회 패키지 먼저). 실패면 던진다. */
export function loadCertFixtures(origin: string, o: { keys?: TestKeys } = {}): LoadedCertFixture {
  const keys = o.keys ?? testKeys();
  const two = keys.pkg.slice(0, 2);
  const ctx = (installedLookups: ReadonlyMap<string, LoadedPackage>): LoaderContext => ({
    roots: keys.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups,
    storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.now(), approvalSummaries: APPROVAL_SUMMARIES,
  });
  const lr = loadPackage(signPackage(certFixtureFiles(LOOKUP_PRODUCT_ID, origin), two), ctx(new Map()));
  if (!lr.ok) throw new Error(`fixture 조회 패키지: ${lr.code} ${JSON.stringify(lr.violations)}`);
  const lookups = new Map([[fixtureCertId(LOOKUP_PRODUCT_ID), lr.pkg]]);
  const docs = new Map<string, LoadedPackage>();
  for (const id of Object.values(CERT_PRODUCT_IDS)) {
    const files = certFixtureFiles(id, origin);
    const r = loadPackage(signPackage(files, two, [lr.pkg.manifestDigest]), ctx(lookups));
    if (!r.ok) throw new Error(`fixture ${id}: ${r.code} ${JSON.stringify(r.violations)}`);
    docs.set(files.manifest.id, r.pkg);
  }
  return { docs, lookups, keys };
}
