import { FIXTURE_PORTAL, loadPackage, APPROVAL_SUMMARIES, type LoadedPackage, type LoaderContext, type PackageFiles } from '@sax/engine/core';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { bundleOutcomes, loadPkg, signPackage, testKeys, type TestKeys } from './core-fixtures.ts';

export const CERT_PRODUCT_IDS = {
  'H-03': 'hometax.cert.biz_registration',
  'H-04': 'hometax.cert.taxpayment',
  'H-08': 'hometax.cert.vat_tax_base',
  'H-09': 'hometax.cert.financial_statements',
} as const;
export type CertCode = keyof typeof CERT_PRODUCT_IDS;
export const LOOKUP_PRODUCT_ID = 'hometax.cert.issued_list';
export const fixtureCertId = (id: string) => id.replace(/^hometax\./, 'fixture.');

const LOGIN_STEPS = new Set(['s0', 's1', 's2', 's3', 's4', 's4a', 's4b', 's4c', 's4d', 's4e', 's4f', 's4g', 's4h', 's5', 's6', 's7', 's7a', 's7b', 's7c', 's7d', 's7e', 's7f', 's7g', 's8', 's8a', 's8b', 's90', 's91', 's92', 's93']);

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
    delete (f.playbook as { closeLayers?: unknown }).closeLayers;
    delete (f.playbook as { closeWindows?: unknown }).closeWindows;
    f.manifest.bundlesUsed = f.manifest.bundlesUsed.filter((b) => b.id !== 'screen_state');
    f.selectors.commitEndpoints = [{ match: { method: 'POST', pathPattern: '^/cert/issue$' }, effect: 'issue_document', maxRequests: 1, encoding: 'form' }] as PackageFiles['selectors']['commitEndpoints'];
    f.selectors.knownEndpoints = [{ method: 'GET', pathPattern: '^/$' }, { method: 'GET', pathPattern: '^/websquare/.*$' }, { method: 'GET', pathPattern: '^/cert/doc$' }] as PackageFiles['selectors']['knownEndpoints'];
  } else {
    f.selectors.knownEndpoints = [{ method: 'GET', pathPattern: '^/websquare/.*$' }] as PackageFiles['selectors']['knownEndpoints'];
  }
  return f;
}

export interface LoadedCertFixture {
  docs: Map<string, LoadedPackage>;
  lookups: Map<string, LoadedPackage>;
  keys: TestKeys;
}

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
