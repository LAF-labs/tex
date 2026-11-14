// H-01 골든(게시본 2.1.1 고정 사본 + 조회 2개, 서명 전)과 제품 원본을 읽는 도우미. 반례는 이것을 복제해 한 군데만 바꾼다.
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import { BundleCatalog } from '@sax/model';
import { canonicalWithout, contentBytes, manifestDigest, sha256Hex, timestampBody, type BundleOutcomes, type PackageFiles, type RawPackage, type TrustRoots } from '@sax/engine/core';

const DIR = new URL('../packages/engine/playbooks/', import.meta.url);
/**
 * 게시본 H-01 2.1.1 묶음(2026-11-11까지의 제품 원본, 자리표시 셀렉터) 고정 사본. 엔진 규칙·조율기·가짜 H-01 페이지 시험의 골든이다.
 * 제품 원본은 2026-11-12 실화면 판(2.2.0)으로 바뀌었고, 그 판은 tests/h01-real-dryrun.test.ts(가짜 홈택스)가 본다.
 */
const GOLDEN = new URL('./fixtures/published-2.1.1/', import.meta.url);
const readIn = (base: URL, p: string) => JSON.parse(fs.readFileSync(new URL(p, base), 'utf8')) as never;
const filesIn = (base: URL, dir: string): PackageFiles => ({
  manifest: readIn(base, `${dir}/manifest.json`), playbook: readIn(base, `${dir}/playbook.json`), selectors: readIn(base, `${dir}/selectors.json`), strings: readIn(base, `${dir}/strings.ko.json`),
});

/** 제품 원본(packages/engine/playbooks)의 한 패키지. */
export function loadPkg(dir: string): PackageFiles {
  return filesIn(DIR, dir);
}

/** H-01 3종은 게시본 2.1.1 고정 사본(판 그대로), 그 밖(민원증명 등)은 제품 원본. */
export function golden(dir: string): PackageFiles {
  return dir.startsWith('hometax.invoice.') ? filesIn(GOLDEN, dir) : filesIn(DIR, dir);
}

/**
 * 시험 고정 판(2026-11-09): 제품 원본 판은 재게시마다 올라간다(scripts/h01-republish.mjs). 시험·샘플 묶음은 판 이름을 첫 게시 판(H-01 2.1.0, 조회 1.0.0)으로 고정하고 내용만 원본을 따른다.
 * 원본 판 자체를 보는 시험은 loadPkg를 쓴다.
 */
export const TEST_VERSIONS: Readonly<Record<string, string>> = { 'hometax.invoice.issue': '2.1.0', 'hometax.invoice.lookup': '1.0.0', 'hometax.invoice.email_status': '1.0.0' };
function pinned(f: PackageFiles): PackageFiles {
  const v = TEST_VERSIONS[f.manifest.id];
  if (v) f.manifest.version = f.playbook.version = v;
  f.manifest.lookupsUsed = f.manifest.lookupsUsed.map((l) => ({ ...l, version: TEST_VERSIONS[l.id] ?? l.version }));
  return f;
}

export const h01 = (): PackageFiles => pinned(golden('hometax.invoice.issue'));
export const lookups = (): Map<string, PackageFiles> =>
  new Map(['hometax.invoice.lookup', 'hometax.invoice.email_status'].map((id) => [id, pinned(golden(id))]));

export function bundleOutcomes(): Map<string, BundleOutcomes> {
  return new Map(BundleCatalog.load().list().map((b) => [b.wireId, { outcomes: b.def.outcomes.map((o) => o.name), reserved: b.def.reservedOutcomes }]));
}

/** D03 §7 정책 예시(스키마 적합). 서명·타임스탬프는 자리표시. */
export const POLICY_EXAMPLE = {
  version: '2026.10', monotonic: 41, keyEpoch: 1, issuedAt: '2026-10-28T00:00:00+09:00', expiresAt: '2026-10-31T00:00:00+09:00',
  timestamp: { keyId: 'ts-1', alg: 'ed25519', sig: 'T'.repeat(86) },
  pace: { interactive: { stepDelayMs: [800, 2500], keyEventDelayMs: 150, afterNavSettleMs: [600, 1500], slowFactor: 1.5 }, daemon: { stepDelayMs: [1200, 3500], keyEventDelayMs: 150, afterNavSettleMs: [800, 2000], slowFactor: 1.5 } },
  browser: { remoteDebuggingPort: 'forbidden', webdriverSelfCheck: true },
  captchaRelay: { hometax: 'allowed', gov24: 'disabled_until_permission', wetax: 'disabled_until_permission', sminfo: 'disabled', insure4: 'disabled' },
  limits: {
    hometax: { runsPerDayPerProfile: 40, irreversiblePerDayPerProfile: 30, runsPerLoginSession: 15, navigationsPerMin: 12, loginsPerDay: 6, loginFailuresPerDay: 2, concurrent: 1 },
    gov24: { runsPerDayPerProfile: 20, irreversiblePerDayPerProfile: 5, runsPerLoginSession: 5, navigationsPerMin: 12, loginsPerDay: 6, concurrent: 1 },
    sminfo: { runsPerDayPerProfile: 10, irreversiblePerDayPerProfile: 3, runsPerLoginSession: 5, navigationsPerMin: 10, loginsPerDay: 4, concurrent: 1 },
    insure4: { runsPerDayPerProfile: 10, irreversiblePerDayPerProfile: 3, runsPerLoginSession: 5, navigationsPerMin: 10, loginsPerDay: 4, concurrent: 1 },
  },
  retries: { stepMax: 3, backoff: 'equal_jitter', baseMs: 800, capMs: 10000 },
  run: { maxActuationsPerRun: 150, maxWallClockMs: 1800000, commitWindowMs: 600000, l2MaxAttempts: 1 },
  cooldown: { onBlockSignalHours: 24, onCaptchaBurst: { windowMin: 10, count: 3, action: 'slow+notify' }, positiveDetectionsForCooldown: 2 },
  daemon: { windowJitterMin: 30, gapBetweenRunsMin: [5, 15], startupGraceMin: 10, retryAfterMin: 30, autoAllowed: false },
  portalMode: { hometax: 'auto', gov24: 'postprocess', wetax: 'postprocess', sminfo: 'postprocess', insure4: 'postprocess' },
  verify: { minElapsedMs: 60000, lookups: 2, maxMs: 300000 },
  remote: { irreversiblePerDay: 5, newCounterpartyRequiresLocal: true, notifyOnIrreversible: ['desktop', 'email'], minProtocolVersion: 1, disabledFeatures: [] },
  queue: { maxIntentsPerPair: 5, ttlHours: 72 },
  signatures: [{ keyId: 'pol-1', alg: 'ed25519', sig: 'P'.repeat(86) }, { keyId: 'pol-2', alg: 'ed25519', sig: 'Q'.repeat(86) }],
};

// ---- 서명 도우미(시험 전용 키, 실행마다 새로 만든다) ----

export interface TestKey {
  keyId: string;
  priv: KeyObject;
  pub: KeyObject;
}
const key = (keyId: string): TestKey => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { keyId, priv: privateKey, pub: publicKey };
};
export const sigOf = (k: TestKey, data: Uint8Array) => ({ keyId: k.keyId, alg: 'ed25519' as const, sig: edSign(null, data, k.priv).toString('base64url') });

export interface TestKeys {
  root: TestKey[];
  pkg: TestKey[];
  pol: TestKey[];
  emergency: TestKey;
  ts: TestKey;
  roots: TrustRoots;
}
export function testKeys(): TestKeys {
  const root = ['root-1', 'root-2', 'root-3'].map(key);
  const pkg = ['pkg-1', 'pkg-2', 'pkg-3'].map(key);
  const pol = ['pol-1', 'pol-2', 'pol-3'].map(key);
  const emergency = key('emg-1');
  const ts = key('ts-1');
  const map = (ks: TestKey[]) => new Map(ks.map((k) => [k.keyId, k.pub]));
  return {
    root, pkg, pol, emergency, ts,
    roots: { keyEpoch: 1, rootKeys: map(root), packageKeys: map(pkg), policyKeys: map(pol), emergencyKey: { keyId: emergency.keyId, key: emergency.pub }, timestampKey: { keyId: ts.keyId, key: ts.pub } },
  };
}

/** 정책·status·폐기 목록: 본문 서명(signers) + 타임스탬프 서명. */
export function signTimestamped<T extends { monotonic: number; issuedAt: string; expiresAt: string }>(doc: T, signers: TestKey[], ts: TestKey): T {
  const body = { ...doc } as T & { signatures?: unknown; timestamp?: unknown };
  delete body.signatures;
  delete body.timestamp;
  const content = contentBytes(body);
  const signatures = signers.map((k) => sigOf(k, content));
  const timestamp = sigOf(ts, timestampBody(sha256Hex(content), doc));
  return { ...body, signatures, timestamp } as T;
}

const bytes = (o: unknown) => Buffer.from(JSON.stringify(o), 'utf8');

/** 파일 → 원시 바이트 + contentDigests·서명을 채운 manifest. lookupDigests는 lookupsUsed 순서. */
export function signPackage(files: PackageFiles, signers: TestKey[], lookupDigests: string[] = []): RawPackage {
  const playbook = bytes(files.playbook);
  const selectors = bytes(files.selectors);
  const strings = bytes(files.strings);
  const m = structuredClone(files.manifest);
  m.contentDigests = { playbook: sha256Hex(playbook), selectors: sha256Hex(selectors), strings: sha256Hex(strings) };
  m.lookupsUsed = m.lookupsUsed.map((l, i) => ({ ...l, digest: lookupDigests[i] ?? l.digest }));
  const signed = canonicalWithout(m, ['signatures']);
  m.signatures = signers.map((k) => sigOf(k, signed));
  return { manifest: bytes(m), playbook, selectors, strings };
}

export const digestOfRaw = (raw: RawPackage) => manifestDigest(JSON.parse(raw.manifest.toString()) as never);
