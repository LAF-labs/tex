// D03 §7.1 정책 적용 규칙: 상한·하한 클램프(필드별, policy.clamped), 범위 역전은 하한 우선(E-17), 포털 키 없음 = postprocess,
// 신선도(72시간·issuedAt 미래 5분), 만료 뒤 유지·168시간 뒤 전 포털 postprocess, 1인 긴급 키의 '엄격하게 보수적' 판정(C-26, E-04).
// 서명 검증은 registry.ts가 하고 여기서는 내용만 본다.
import { CAPTCHA_ORDER, CAPTCHA_RELAY_CEILING, ISSUED_AT_MAX_SKEW_MIN, MODE_ORDER, POLICY_FLOOR, POLICY_MAX_VALIDITY_H, POLICY_STALE_FALLBACK_H, PORTAL_MODE_CEILING } from './constants.ts';
import { PORTALS, type CaptchaRelay, type Policy, type Portal, type PortalMode } from './types.ts';

const H = 3_600_000;

export interface ClampResult {
  policy: Policy;
  /** 고정된 필드 경로(값 없음). 저널 policy.clamped{field}로 남긴다. */
  clamped: string[];
}

const lowerMode = (a: PortalMode, b: PortalMode): PortalMode => (MODE_ORDER[a] <= MODE_ORDER[b] ? a : b);
const lowerRelay = (a: CaptchaRelay, b: CaptchaRelay): CaptchaRelay => (CAPTCHA_ORDER[a] <= CAPTCHA_ORDER[b] ? a : b);

/** 상한·하한을 넘는 필드만 내장 값으로 고정한다. 정책 전체를 거부하지 않는다. */
export function clampPolicy(input: Policy): ClampResult {
  const p = structuredClone(input);
  const clamped: string[] = [];
  const fix = <T>(path: string, cur: T, next: T, set: (v: T) => void) => {
    if (cur !== next) {
      set(next);
      clamped.push(path);
    }
  };
  for (const portal of PORTALS) {
    const m = p.portalMode[portal];
    if (m !== undefined) fix(`portalMode.${portal}`, m, lowerMode(m, PORTAL_MODE_CEILING[portal]), (v) => (p.portalMode[portal] = v));
    const c = p.captchaRelay[portal];
    if (c !== undefined) fix(`captchaRelay.${portal}`, c, lowerRelay(c, CAPTCHA_RELAY_CEILING[portal]), (v) => (p.captchaRelay[portal] = v));
    const l = p.limits[portal];
    if (l?.loginFailuresPerDay !== undefined) fix(`limits.${portal}.loginFailuresPerDay`, l.loginFailuresPerDay, Math.min(l.loginFailuresPerDay, POLICY_FLOOR.loginFailuresPerDayMax), (v) => (l.loginFailuresPerDay = v));
  }
  const range = (path: string, r: [number, number], min: number) => {
    fix(`${path}[0]`, r[0], Math.max(r[0], min), (v) => (r[0] = v));
    if (r[1] < r[0]) fix(`${path}[1]`, r[1], r[0], (v) => (r[1] = v)); // E-17: 하한 우선
  };
  for (const prof of ['interactive', 'daemon'] as const) {
    range(`pace.${prof}.stepDelayMs`, p.pace[prof].stepDelayMs, POLICY_FLOOR.stepDelayMsMin);
    range(`pace.${prof}.afterNavSettleMs`, p.pace[prof].afterNavSettleMs, POLICY_FLOOR.afterNavSettleMsMin);
  }
  range('daemon.gapBetweenRunsMin', p.daemon.gapBetweenRunsMin, 0);
  const cd = p.cooldown;
  fix('cooldown.onBlockSignalHours', cd.onBlockSignalHours, Math.max(cd.onBlockSignalHours, POLICY_FLOOR.onBlockSignalHoursMin), (v) => (cd.onBlockSignalHours = v));
  fix('cooldown.positiveDetectionsForCooldown', cd.positiveDetectionsForCooldown, Math.min(cd.positiveDetectionsForCooldown, POLICY_FLOOR.positiveDetectionsForCooldownMax), (v) => (cd.positiveDetectionsForCooldown = v));
  fix('cooldown.onCaptchaBurst.count', cd.onCaptchaBurst.count, Math.min(cd.onCaptchaBurst.count, POLICY_FLOOR.onCaptchaBurstCountMax), (v) => (cd.onCaptchaBurst.count = v));
  fix('cooldown.onCaptchaBurst.windowMin', cd.onCaptchaBurst.windowMin, Math.max(cd.onCaptchaBurst.windowMin, POLICY_FLOOR.onCaptchaBurstWindowMinMin), (v) => (cd.onCaptchaBurst.windowMin = v));
  fix('run.commitWindowMs', p.run.commitWindowMs, Math.min(p.run.commitWindowMs, POLICY_FLOOR.commitWindowMsMax), (v) => (p.run.commitWindowMs = v));
  fix('run.l2MaxAttempts', p.run.l2MaxAttempts, Math.min(p.run.l2MaxAttempts, POLICY_FLOOR.l2MaxAttemptsMax), (v) => (p.run.l2MaxAttempts = v));
  fix('remote.irreversiblePerDay', p.remote.irreversiblePerDay, Math.min(p.remote.irreversiblePerDay, POLICY_FLOOR.remoteIrreversiblePerDayMax), (v) => (p.remote.irreversiblePerDay = v));
  fix('queue.maxIntentsPerPair', p.queue.maxIntentsPerPair, Math.min(p.queue.maxIntentsPerPair, POLICY_FLOOR.queueMaxIntentsPerPairMax), (v) => (p.queue.maxIntentsPerPair = v));
  fix('queue.ttlHours', p.queue.ttlHours, Math.min(p.queue.ttlHours, POLICY_FLOOR.queueTtlHoursMax), (v) => (p.queue.ttlHours = v));
  fix('verify.minElapsedMs', p.verify.minElapsedMs, Math.max(p.verify.minElapsedMs, POLICY_FLOOR.verifyMinElapsedMsMin), (v) => (p.verify.minElapsedMs = v));
  fix('verify.lookups', p.verify.lookups, Math.max(p.verify.lookups, POLICY_FLOOR.verifyLookupsMin), (v) => (p.verify.lookups = v));
  const maxMs = p.verify.maxMs ?? POLICY_FLOOR.verifyMaxMsMin;
  if (p.verify.maxMs === undefined) p.verify.maxMs = maxMs; // 기본값 채움은 클램프가 아니다
  else fix('verify.maxMs', maxMs, Math.max(maxMs, POLICY_FLOOR.verifyMaxMsMin), (v) => (p.verify.maxMs = v));
  return { policy: p, clamped };
}

/** 포털의 정책상 수준(키가 없으면 postprocess, fail-closed). 실효 수준은 status·만료까지 합친 effectiveMode다. */
export const policyMode = (p: Policy | null, portal: Portal): PortalMode => lowerMode(p?.portalMode[portal] ?? 'postprocess', PORTAL_MODE_CEILING[portal]);

// ---- 신선도 ----

export type FreshnessProblem = 'policy.validity_too_long' | 'policy.issued_in_future' | 'policy.expired_on_arrival';

/** 받은 정책 파일 자체의 신선도. 문제가 있으면 그 파일을 거부하고 마지막 유효 정책을 유지한다. */
export function freshnessProblem(p: Pick<Policy, 'issuedAt' | 'expiresAt'>, now: number): FreshnessProblem | null {
  const iss = Date.parse(p.issuedAt);
  const exp = Date.parse(p.expiresAt);
  if (!(exp > iss) || exp - iss > POLICY_MAX_VALIDITY_H * H) return 'policy.validity_too_long';
  if (iss > now + ISSUED_AT_MAX_SKEW_MIN * 60_000) return 'policy.issued_in_future';
  if (exp <= now) return 'policy.expired_on_arrival';
  return null;
}

export type PolicyFreshness = 'none' | 'fresh' | 'stale' | 'fallback';

/**
 * 마지막 유효 정책의 상태. stale = 만료 뒤(유지하되 완화 거부·데몬 정지·핫픽스 거부·홈택스 auto 경고),
 * fallback = 만료 168시간 뒤(전 포털 postprocess), none = 유효 정책이 한 번도 없음(전 포털 postprocess).
 */
export function policyFreshness(p: Pick<Policy, 'expiresAt'> | null, now: number): PolicyFreshness {
  if (!p) return 'none';
  const exp = Date.parse(p.expiresAt);
  if (now < exp) return 'fresh';
  return now < exp + POLICY_STALE_FALLBACK_H * H ? 'stale' : 'fallback';
}

// ---- 1인 긴급 키: 엄격하게 보수적인가(D03 §7.1 표) ----

type Dir = 'le' | 'ge' | 'superset' | 'mode' | 'relay' | 'burstAction' | 'eq';
const META = new Set(['version', 'monotonic', 'keyEpoch', 'issuedAt', 'expiresAt', 'timestamp', 'signatures']);

/** 필드 경로(배열 원소는 [i]) → 보수 방향. 표에 없는 필드는 eq(같음만). */
export function conservativeDirection(path: string): Dir {
  const [head, a, b] = path.split('.');
  if (head === 'portalMode') return 'mode';
  if (head === 'captchaRelay') return 'relay';
  if (head === 'limits') return 'le';
  if (head === 'cooldown') {
    if (a === 'onBlockSignalHours') return 'ge';
    if (a === 'positiveDetectionsForCooldown') return 'le';
    if (a === 'onCaptchaBurst') return b === 'count' ? 'le' : b === 'windowMin' ? 'ge' : b === 'action' ? 'burstAction' : 'eq';
    if (a?.startsWith('blockSignalsAdd')) return 'superset';
  }
  if (head === 'pace') return 'ge';
  if (head === 'run') return 'le';
  if (head === 'retries') return a === 'stepMax' ? 'le' : a === 'baseMs' || a === 'capMs' ? 'ge' : 'eq';
  if (head === 'remote') {
    if (a === 'irreversiblePerDay') return 'le';
    if (a === 'minProtocolVersion') return 'ge';
    if (a === 'disabledFeatures' || a === 'notifyOnIrreversible') return 'superset';
  }
  if (head === 'queue') return 'le';
  if (head === 'verify') return a === 'minElapsedMs' || a === 'lookups' || a === 'maxMs' ? 'ge' : 'eq';
  if (head === 'daemon') return a === 'windowJitterMin' || a?.startsWith('gapBetweenRunsMin') || a === 'startupGraceMin' || a === 'retryAfterMin' ? 'ge' : 'eq';
  return 'eq';
}

const SET_FIELDS = new Set(['remote.disabledFeatures', 'remote.notifyOnIrreversible', 'cooldown.blockSignalsAdd.urlPatterns', 'cooldown.blockSignalsAdd.phrases']);

function leaves(o: unknown, prefix: string, out: Map<string, unknown>): void {
  if (Array.isArray(o)) {
    if (SET_FIELDS.has(prefix)) out.set(prefix, o);
    else o.forEach((x, i) => leaves(x, `${prefix}[${i}]`, out));
    return;
  }
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) if (prefix || !META.has(k)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  out.set(prefix, o);
}

/** 각 필드: -1 보수(엄격), 0 같음, 1 완화 또는 표 밖 변경. */
function compareField(path: string, cur: unknown, next: unknown): -1 | 0 | 1 {
  const dir = conservativeDirection(path.replace(/\[\d+\]/g, ''));
  if (dir === 'superset') {
    const c = new Set((cur as string[] | undefined) ?? []);
    const n = new Set((next as string[] | undefined) ?? []);
    if ([...c].some((x) => !n.has(x))) return 1;
    return n.size > c.size ? -1 : 0;
  }
  if (cur === next) return 0;
  // 포털 키가 없으면 postprocess로 본다(fail-closed). 그 밖의 필드가 생기거나 없어지면 표 밖 변경이다.
  if (dir === 'mode') {
    const r = (x: unknown) => (x === undefined ? 0 : MODE_ORDER[x as PortalMode]);
    return r(next) < r(cur) ? -1 : 1;
  }
  if (dir === 'relay') {
    const r = (x: unknown) => (x === undefined ? 0 : CAPTCHA_ORDER[x as CaptchaRelay]);
    return r(next) < r(cur) ? -1 : 1;
  }
  if (cur === undefined || next === undefined) return 1;
  if (dir === 'burstAction') return cur === 'slow+notify' && next === 'pause' ? -1 : 1;
  if (typeof cur !== 'number' || typeof next !== 'number') return 1;
  if (dir === 'le') return next < cur ? -1 : 1;
  if (dir === 'ge') return next > cur ? -1 : 1;
  return 1;
}

/** 1인 긴급 키로만 서명된 정책은 모든 필드가 보수 방향이고 하나 이상이 엄격할 때만 받는다. */
export function isStrictlyConservative(cur: Policy, next: Policy): boolean {
  const a = new Map<string, unknown>();
  const b = new Map<string, unknown>();
  leaves(cur, '', a);
  leaves(next, '', b);
  let strict = false;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const c = compareField(k, a.get(k), b.get(k));
    if (c === 1) return false;
    if (c === -1) strict = true;
  }
  return strict;
}
