// M1-4 스키마 7종: 엔진 사본 = 설계 정본, strict 컴파일, 골든 픽스처 적합, 정책 예시(D03 §7) 적합.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { SCHEMA_NAMES, schemaPath, schemaViolations } from '@sax/engine/core';
import { BundleCatalog } from '@sax/model';
import { h01, lookups } from './core-fixtures.ts';

const design = path.resolve(import.meta.dirname, '../../sovereign-ax/design/schemas');

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

describe('스키마 7종(M1-4)', () => {
  it('엔진 사본은 설계 정본과 바이트 단위로 같다', () => {
    for (const n of SCHEMA_NAMES) assert.equal(fs.readFileSync(schemaPath(n), 'utf8'), fs.readFileSync(path.join(design, `${n}.schema.json`), 'utf8'), n);
  });
  it('골든 H-01·조회 패키지 파일이 스키마에 맞는다', () => {
    for (const p of [h01(), ...lookups().values()]) {
      assert.deepEqual(schemaViolations('playbook-ir', p.playbook), []);
      assert.deepEqual(schemaViolations('selectors', p.selectors), []);
      assert.deepEqual(schemaViolations('manifest', p.manifest), []);
    }
  });
  it('D03 §7 정책 예시(verify.maxMs·loginFailuresPerDay 포함)가 policy 스키마에 맞는다', () => {
    assert.deepEqual(schemaViolations('policy', POLICY_EXAMPLE), []);
    assert.ok(schemaViolations('policy', { ...POLICY_EXAMPLE, verify: { minElapsedMs: 60000, lookups: 2, maxMs: 100000 } }).length > 0);
    assert.ok(schemaViolations('policy', { ...POLICY_EXAMPLE, browser: { remoteDebuggingPort: 'allowed', webdriverSelfCheck: true } }).length > 0);
  });
  it('앱 내장 번들 정의가 bundle 스키마에 맞는다', () => {
    for (const b of BundleCatalog.load().list()) assert.deepEqual(schemaViolations('bundle', b.def), [], b.wireId);
  });
  it('셀렉터: secretKind와 secretPurpose는 함께, 비밀 칸은 fieldKey 불가, commits 항목은 비밀 칸 불가', () => {
    const base = { candidates: [{ kind: 'css', value: '#pw' }], role: 'textbox', namePattern: '^비밀번호$', frame: 'main', landmark: 'a.b', commits: false, lastVerified: '2026-11-01' };
    const dict = (e: object) => ({ portal: 'hometax', entries: { 'a.pw': e }, commitEndpoints: [], knownEndpoints: [] });
    assert.deepEqual(schemaViolations('selectors', dict({ ...base, secretKind: 'portal_password', secretPurpose: 'login' })), []);
    assert.ok(schemaViolations('selectors', dict({ ...base, secretKind: 'portal_password' })).length > 0);
    assert.ok(schemaViolations('selectors', dict({ ...base, secretKind: 'portal_password', secretPurpose: 'login', fieldKey: 'pw' })).length > 0);
    assert.ok(schemaViolations('selectors', dict({ ...base, commits: true, commitEffect: 'issue_document', secretKind: 'portal_password', secretPurpose: 'login' })).length > 0);
    assert.ok(schemaViolations('selectors', dict({ ...base, secretSlot: true })).length > 0);
  });
  it('gateway-request: 알 수 없는 필드는 거부', () => {
    assert.ok(schemaViolations('gateway-request', { bundleId: 'screen_state_v2', bundleDigest: '0'.repeat(64), input: 'x', runToken: 'r'.repeat(16), model: 'x' }).length > 0);
  });
});
