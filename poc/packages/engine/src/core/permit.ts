import { MODE_ORDER, PORTAL_MODE_CEILING } from './constants.ts';
import { policyMode, type PolicyFreshness } from './policy.ts';
import type { Policy, Portal, PortalMode } from './types.ts';

/** 허가에 쓰는 status 부분(RegistrySync.status()의 StatusView). */
export interface PermitStatus {
  portalModeCeiling: Partial<Record<Portal, PortalMode>>;
  killPlaybooks: readonly string[];
}

/** 허가에 쓰는 정책 부분(RegistrySync.policy()의 PolicyView). */
export interface PermitPolicy {
  freshness: PolicyFreshness;
  policy: Policy | null;
}

export type RunPermit =
  | { ok: true; mode: PortalMode }
  | { ok: false; code: 'policy.playbook_killed' | 'policy.portal_mode_denied' | 'policy.expired'; mode: PortalMode; hardStop: boolean };

const lower = (a: PortalMode, b: PortalMode): PortalMode => (MODE_ORDER[a] <= MODE_ORDER[b] ? a : b);

const policyLevel = (p: PermitPolicy, portal: Portal): PortalMode => (p.freshness === 'fresh' || p.freshness === 'stale' ? policyMode(p.policy, portal) : 'postprocess');

/**
 * 그 포털의 실효 수준: 내장 상한 ∧ status 상한(status가 없으면 내장 상한) ∧ 정책 수준.
 * policy를 넘기지 않으면(undefined) 정책은 보지 않는다(fixture 개발 포털, 시험). null 정책은 none과 같다.
 */
export function effectiveMode(status: PermitStatus | null, portal: Portal, policy?: PermitPolicy): PortalMode {
  const m = lower(PORTAL_MODE_CEILING[portal], status?.portalModeCeiling[portal] ?? 'auto');
  return policy === undefined ? m : lower(m, policyLevel(policy, portal));
}

/** 이 플레이북을 지금 자동으로 돌려도 되는가. */
export function runPermit(status: PermitStatus | null, portal: Portal, playbookId: string, policy?: PermitPolicy): RunPermit {
  const mode = effectiveMode(status, portal, policy);
  if (status?.killPlaybooks.includes(playbookId)) return { ok: false, code: 'policy.playbook_killed', mode, hardStop: true };
  if (mode === 'auto') return { ok: true, mode };
  const expired = policy?.freshness === 'fallback' && effectiveMode(status, portal) !== 'postprocess';
  return { ok: false, code: expired ? 'policy.expired' : 'policy.portal_mode_denied', mode, hardStop: mode === 'postprocess' };
}
