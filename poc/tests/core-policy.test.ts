// M1-4 정책 상한·하한 집행(D03 §7.1): 필드별 클램프·범위 역전(E-17)·포털 키 없음 = postprocess·신선도·1인 긴급 키 보수성 판정(E-04).
// CE-16: gov24 auto 정책은 postprocess로 고정된다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampPolicy, freshnessProblem, isStrictlyConservative, policyFreshness, policyMode, type Policy } from '@sax/engine/core';
import { POLICY_EXAMPLE } from './core-fixtures.ts';

const pol = (): Policy => structuredClone(POLICY_EXAMPLE) as unknown as Policy;
const H = 3_600_000;
const T0 = Date.parse('2026-10-28T00:00:00+09:00');

describe('clampPolicy (D03 §7.1 적용 규칙)', () => {
  it('예시 정책은 고칠 것이 없다', () => {
    const r = clampPolicy(pol());
    assert.deepEqual(r.clamped, []);
    assert.equal(r.policy.portalMode.hometax, 'auto');
  });
  it('CE-16: gov24 auto → postprocess, 그 필드만 고정', () => {
    const p = pol();
    p.portalMode.gov24 = 'auto';
    p.captchaRelay.gov24 = 'allowed';
    const r = clampPolicy(p);
    assert.equal(r.policy.portalMode.gov24, 'postprocess');
    assert.equal(r.policy.captchaRelay.gov24, 'disabled_until_permission');
    assert.deepEqual(r.clamped.sort(), ['captchaRelay.gov24', 'portalMode.gov24']);
    assert.equal(p.portalMode.gov24, 'auto', '원본은 그대로');
  });
  it('하한·상한: 스텝 지연·쿨다운·커밋 구간·L2·원격·큐·verify·로그인 실패', () => {
    const p = pol();
    p.pace.interactive.stepDelayMs = [500, 2000];
    p.cooldown.onBlockSignalHours = 1;
    p.cooldown.positiveDetectionsForCooldown = 5;
    p.cooldown.onCaptchaBurst = { windowMin: 5, count: 9, action: 'slow+notify' };
    p.run.commitWindowMs = 2_000_000;
    p.run.l2MaxAttempts = 3;
    p.remote.irreversiblePerDay = 9;
    p.queue = { maxIntentsPerPair: 9, ttlHours: 100 };
    p.verify = { minElapsedMs: 1000, lookups: 1, maxMs: 100_000 };
    p.limits.hometax.loginFailuresPerDay = 3;
    const r = clampPolicy(p).policy;
    assert.deepEqual(r.pace.interactive.stepDelayMs, [800, 2000]);
    assert.equal(r.cooldown.onBlockSignalHours, 24);
    assert.equal(r.cooldown.positiveDetectionsForCooldown, 2);
    assert.deepEqual([r.cooldown.onCaptchaBurst.windowMin, r.cooldown.onCaptchaBurst.count], [10, 3]);
    assert.equal(r.run.commitWindowMs, 900_000);
    assert.equal(r.run.l2MaxAttempts, 2);
    assert.equal(r.remote.irreversiblePerDay, 5);
    assert.deepEqual(r.queue, { maxIntentsPerPair: 5, ttlHours: 72 });
    assert.deepEqual(r.verify, { minElapsedMs: 30_000, lookups: 2, maxMs: 300_000 });
    assert.equal(r.limits.hometax.loginFailuresPerDay, 2);
  });
  it('E-17: 클램프 뒤 max < min이면 max = min(하한 우선), 그것도 clamped', () => {
    const p = pol();
    p.pace.daemon.afterNavSettleMs = [100, 300];
    const r = clampPolicy(p);
    assert.deepEqual(r.policy.pace.daemon.afterNavSettleMs, [600, 600]);
    assert.ok(r.clamped.includes('pace.daemon.afterNavSettleMs[0]') && r.clamped.includes('pace.daemon.afterNavSettleMs[1]'));
  });
  it('verify.maxMs가 없으면 기본 300초를 채우되 clamped로 남기지 않는다', () => {
    const p = pol();
    delete (p.verify as { maxMs?: number }).maxMs;
    const r = clampPolicy(p);
    assert.equal(r.policy.verify.maxMs, 300_000);
    assert.deepEqual(r.clamped, []);
  });
  it('포털 키가 없으면 postprocess(fail-closed), 정책이 없어도 postprocess', () => {
    assert.equal(policyMode(pol(), 'wetax'), 'postprocess');
    assert.equal(policyMode(pol(), 'hometax'), 'auto');
    assert.equal(policyMode(null, 'hometax'), 'postprocess');
    const p = pol();
    p.portalMode.gov24 = 'auto';
    assert.equal(policyMode(p, 'gov24'), 'postprocess', '상한 위의 값도 상한으로');
  });
});

describe('정책 신선도 (C-26, E-05)', () => {
  const at = (iss: number, exp: number) => ({ issuedAt: new Date(iss).toISOString(), expiresAt: new Date(exp).toISOString() });
  it('72시간 초과 유효기간·5분 넘는 미래 issuedAt·도착 시 만료는 거부', () => {
    assert.equal(freshnessProblem(at(T0, T0 + 73 * H), T0), 'policy.validity_too_long');
    assert.equal(freshnessProblem(at(T0, T0), T0), 'policy.validity_too_long');
    assert.equal(freshnessProblem(at(T0 + 6 * 60_000, T0 + 24 * H), T0), 'policy.issued_in_future');
    assert.equal(freshnessProblem(at(T0 + 4 * 60_000, T0 + 24 * H), T0), null, '5분 이내 시계 차이는 받는다');
    assert.equal(freshnessProblem(at(T0 - 72 * H, T0), T0), 'policy.expired_on_arrival');
    assert.equal(freshnessProblem(at(T0, T0 + 72 * H), T0), null);
  });
  it('만료 뒤 stale, 168시간 뒤 fallback(전 포털 postprocess), 정책 없음 = none', () => {
    const p = { expiresAt: new Date(T0).toISOString() };
    assert.equal(policyFreshness(p, T0 - 1), 'fresh');
    assert.equal(policyFreshness(p, T0), 'stale');
    assert.equal(policyFreshness(p, T0 + 168 * H - 1), 'stale');
    assert.equal(policyFreshness(p, T0 + 168 * H), 'fallback');
    assert.equal(policyFreshness(null, T0), 'none');
  });
});

describe('isStrictlyConservative (D03 §7.1 보수 방향 표, E-04)', () => {
  const ch = (f: (p: Policy) => void) => {
    const n = pol();
    f(n);
    return isStrictlyConservative(pol(), n);
  };
  it('같은 정책은 엄격하지 않다(거부)', () => assert.equal(isStrictlyConservative(pol(), pol()), false));
  it('메타 필드(monotonic·issuedAt·signatures)만 바뀌면 엄격하지 않다', () => assert.equal(ch((p) => { p.monotonic += 1; p.issuedAt = '2026-10-29T00:00:00+09:00'; }), false));
  it('portalMode 하향·포털 키 삭제는 보수, 상향·새 포털 키는 완화', () => {
    assert.equal(ch((p) => (p.portalMode.hometax = 'assisted')), true);
    assert.equal(ch((p) => delete (p.portalMode as Record<string, unknown>).hometax), true);
    assert.equal(ch((p) => (p.portalMode.wetax = 'assisted')), false);
  });
  it('이미 최저값(postprocess·disabled)인 포털 키를 빼는 것은 같음(다른 필드 강화와 함께 수용)', () => {
    assert.equal(ch((p) => { delete (p.portalMode as Record<string, unknown>).gov24; p.portalMode.hometax = 'assisted'; }), true);
    assert.equal(ch((p) => { delete (p.captchaRelay as Record<string, unknown>).sminfo; p.captchaRelay.hometax = 'disabled'; }), true);
    assert.equal(ch((p) => delete (p.portalMode as Record<string, unknown>).gov24), false, '그것만으로는 엄격하지 않다');
  });
  it('captchaRelay는 disabled 방향만', () => {
    assert.equal(ch((p) => (p.captchaRelay.hometax = 'disabled')), true);
    assert.equal(ch((p) => (p.captchaRelay.sminfo = 'allowed')), false);
  });
  it('limits ≤, pace ≥, run ≤, retries(stepMax ≤, baseMs ≥)', () => {
    assert.equal(ch((p) => (p.limits.hometax.runsPerDayPerProfile = 10)), true);
    assert.equal(ch((p) => (p.limits.hometax.runsPerDayPerProfile = 50)), false);
    assert.equal(ch((p) => (p.pace.interactive.stepDelayMs = [900, 2500])), true);
    assert.equal(ch((p) => (p.pace.interactive.slowFactor = 1.2)), false);
    assert.equal(ch((p) => (p.run.maxWallClockMs = 900_000)), true);
    assert.equal(ch((p) => (p.retries.stepMax = 5)), false);
    assert.equal(ch((p) => (p.retries.baseMs = 1000)), true);
  });
  it('cooldown: hours ≥, burst count ≤·windowMin ≥, action은 slow+notify → pause만', () => {
    assert.equal(ch((p) => (p.cooldown.onBlockSignalHours = 48)), true);
    assert.equal(ch((p) => (p.cooldown.onCaptchaBurst.action = 'pause')), true);
    assert.equal(ch((p) => (p.cooldown.onCaptchaBurst.windowMin = 5)), false);
  });
  it('집합 필드는 상위 집합만(notifyOnIrreversible·disabledFeatures)', () => {
    assert.equal(ch((p) => (p.remote.disabledFeatures = ['live_view'])), true);
    assert.equal(ch((p) => (p.remote.notifyOnIrreversible = ['desktop'])), false);
  });
  it('표에 없는 필드(browser·autoAllowed·newCounterpartyRequiresLocal)는 같음만', () => {
    assert.equal(ch((p) => (p.remote.newCounterpartyRequiresLocal = false)), false);
    assert.equal(ch((p) => { p.portalMode.hometax = 'assisted'; (p.browser as { webdriverSelfCheck: boolean }).webdriverSelfCheck = false; }), false);
  });
  it('하나라도 반대 방향이면 거부', () => assert.equal(ch((p) => { p.portalMode.hometax = 'assisted'; p.limits.hometax.loginsPerDay = 99; }), false));
});
