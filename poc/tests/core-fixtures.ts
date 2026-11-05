// tests/fixtures/core의 골든 패키지(H-01 v2.1 + 조회 패키지 2개)를 읽는 도우미. 반례는 이것을 복제해 한 군데만 바꾼다.
import { generateKeyPairSync, sign as edSign, type KeyObject } from 'node:crypto';
import fs from 'node:fs';
import { BundleCatalog } from '@sax/model';
import { canonicalWithout, contentBytes, manifestDigest, sha256Hex, timestampBody, type BundleOutcomes, type PackageFiles, type RawPackage, type TrustRoots } from '@sax/engine/core';

const DIR = new URL('./fixtures/core/', import.meta.url);
const read = (p: string) => JSON.parse(fs.readFileSync(new URL(p, DIR), 'utf8')) as never;

export function loadPkg(dir: string): PackageFiles {
  return { manifest: read(`${dir}/manifest.json`), playbook: read(`${dir}/playbook.json`), selectors: read(`${dir}/selectors.json`), strings: read(`${dir}/strings.ko.json`) };
}

export const h01 = (): PackageFiles => structuredClone(loadPkg('h01'));
export const lookups = (): Map<string, PackageFiles> =>
  new Map(['hometax.invoice.lookup', 'hometax.invoice.email_status'].map((id) => [id, structuredClone(loadPkg(`lookups/${id}`))]));

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
