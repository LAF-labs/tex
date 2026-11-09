// 실행 허가(D03 §2 Running 진입 확인·정지 하향, §3.1 레지스트리 status 소비, §7.1 조회와 적용, §12 실효 수준, ADR-023 결정 5·6).
// - 실효 수준은 앱 내장 상한(PORTAL_MODE_CEILING)과 status `portalModeCeiling` 가운데 낮은 쪽이다(하향 전용).
//   정책 `portalMode`와 만료 규칙은 정책 동기화가 붙으면 여기에 더한다(D03 §7.1, 팀장 결정 2026-11-09 ②③⑤).
// - 자동 실행(IR·H01)은 실효 수준이 `auto`일 때만 허가한다. `assisted` 변환 실행은 아직 없어 그 수준에서는 멈춘다(fail-closed).
// - `killPlaybooks`에 든 플레이북은 실행하지 않는다.
// - hardStop: 새 수준이 `postprocess`이거나 kill이다. 자동화 Chrome을 닫는다(§2 하향 행).
import { MODE_ORDER, PORTAL_MODE_CEILING } from './constants.ts';
import type { Portal, PortalMode } from './types.ts';

/** 허가에 쓰는 status 부분(RegistrySync.status()의 StatusView). */
export interface PermitStatus {
  portalModeCeiling: Partial<Record<Portal, PortalMode>>;
  killPlaybooks: readonly string[];
}

export type RunPermit =
  | { ok: true; mode: PortalMode }
  | { ok: false; code: 'policy.playbook_killed' | 'policy.portal_mode_denied'; mode: PortalMode; hardStop: boolean };

const lower = (a: PortalMode, b: PortalMode): PortalMode => (MODE_ORDER[a] <= MODE_ORDER[b] ? a : b);

/** 그 포털의 실효 수준(정책 전): 내장 상한과 status 상한 중 낮은 쪽. status가 없으면 내장 상한. */
export function effectiveMode(status: PermitStatus | null, portal: Portal): PortalMode {
  return lower(PORTAL_MODE_CEILING[portal], status?.portalModeCeiling[portal] ?? 'auto');
}

/** 이 플레이북을 지금 자동으로 돌려도 되는가. status가 없으면(받은 적 없음) 내장 상한만 본다. */
export function runPermit(status: PermitStatus | null, portal: Portal, playbookId: string): RunPermit {
  const mode = effectiveMode(status, portal);
  if (status?.killPlaybooks.includes(playbookId)) return { ok: false, code: 'policy.playbook_killed', mode, hardStop: true };
  if (mode !== 'auto') return { ok: false, code: 'policy.portal_mode_denied', mode, hardStop: mode === 'postprocess' };
  return { ok: true, mode };
}
