// 실행 허가(D03 §2 Running 진입 확인·정지 하향, §3.1 레지스트리 status 소비, §7.1 조회와 적용·만료 규칙, §12 실효 수준, ADR-023 결정 5·6).
// - 실효 수준은 앱 내장 상한(PORTAL_MODE_CEILING), status `portalModeCeiling`, 서명 정책 `portalMode`, 만료 규칙 가운데 가장 낮은 것이다.
//   정책이 없거나(none) 만료 뒤 168시간이 지났으면(fallback) 그 포털은 postprocess다(fail-closed, 팀장 결정 2026-11-09 ⑤).
//   만료 뒤 168시간 안(stale)은 마지막 유효 정책을 그대로 쓴다(D03 §7.1).
// - 자동 실행(IR·H01)은 실효 수준이 `auto`일 때만 허가한다. `assisted` 변환 실행은 아직 없어 그 수준에서는 멈춘다(fail-closed).
// - `killPlaybooks`에 든 플레이북은 실행하지 않는다.
// - hardStop: 새 수준이 `postprocess`이거나 kill이다. 자동화 Chrome을 닫는다(§2 하향 행).
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

/** 정책이 주는 그 포털의 수준: fresh·stale이면 정책 portalMode(키가 없으면 postprocess), none·fallback이면 postprocess. */
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
  // 만료 규칙 때문이면 policy.expired(D16), 그 밖은 운영 수준 불허.
  const expired = policy?.freshness === 'fallback' && effectiveMode(status, portal) !== 'postprocess';
  return { ok: false, code: expired ? 'policy.expired' : 'policy.portal_mode_denied', mode, hardStop: mode === 'postprocess' };
}
