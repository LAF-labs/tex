// D02 §2.2 셀렉터 핫픽스 적격 조건과 참조 집합(B-01, E-03, ADR-012). 엔진 로더와 레지스트리 핫픽스 CI가 같은 계산을 한다.
// 서명·단조·만료 검사는 로더(registry)가 하고, 여기서는 "어느 항목의 candidates를 바꿀 수 있는가"만 정한다.
import { semanticViolations, stepTargets, type ValidateOptions } from './validate.ts';
import type { CommitEndpoint, Hotfix, PackageFiles, SelectorDict, Violation } from './types.ts';

export type IneligibleReason =
  | 'commits' | 'secret' | 'close_affordance' | 'readback_of' | 'field_key'
  | 'landmark' | 'decide_scope' | 'cond' | 'sign_row_label' | 'sign_confirm' | 'commit_window' | 'unknown_entry';

/** stable_id → 핫픽스 불가 사유(적격이면 맵에 없음). */
export function ineligibleEntries(pkg: PackageFiles, opts: ValidateOptions = {}): Map<string, IneligibleReason> {
  const { selectors: sel } = pkg;
  const out = new Map<string, IneligibleReason>();
  const mark = (k: string, r: IneligibleReason) => !out.has(k) && out.set(k, r);
  for (const [k, e] of Object.entries(sel.entries)) {
    if (e.commits) mark(k, 'commits');
    else if (e.secretKind || e.inputType === 'password') mark(k, 'secret');
    else if (e.closeAffordance) mark(k, 'close_affordance');
    else if (e.readbackOf) mark(k, 'readback_of');
    else if (e.fieldKey) mark(k, 'field_key');
    mark(e.landmark, 'landmark');
  }
  const { analysis } = semanticViolations(pkg, opts);
  const inWindow = new Set<string>();
  for (const w of analysis.windows.values()) for (const n of w) inWindow.add(n);
  for (const { step: s } of analysis.cfg.info.values()) {
    for (const t of stepTargets(s)) {
      if (t.role === 'scope') mark(t.ref, 'decide_scope');
      if (t.role === 'cond') mark(t.ref, 'cond');
      if (t.role === 'rowLabel') mark(t.ref, 'sign_row_label');
      if (t.role === 'confirmTarget') mark(t.ref, 'sign_confirm');
      if (inWindow.has(s.id)) mark(t.ref, 'commit_window');
    }
  }
  return out;
}

/** 핫픽스 항목의 적격성(HF-ELIGIBLE)과 조회 패키지 거부(HF-LOOKUP). */
export function hotfixEligibilityViolations(hf: Hotfix, pkg: PackageFiles, opts: ValidateOptions = {}): Violation[] {
  if (pkg.manifest.kind === 'lookup') return [{ rule: 'HF-LOOKUP', message: '조회 패키지는 핫픽스 대상이 아님' }];
  const bad = ineligibleEntries(pkg, opts);
  const v: Violation[] = [];
  for (const k of Object.keys(hf.entries)) {
    if (!pkg.selectors.entries[k]) v.push({ rule: 'HF-ELIGIBLE', target: k, message: '사전에 없는 항목' });
    else if (bad.has(k)) v.push({ rule: 'HF-ELIGIBLE', target: k, message: `핫픽스 불가 항목(${bad.get(k)})` });
  }
  return v;
}

/** candidates 교체 + commitEndpoints 추가만 반영한 새 사전(원본은 그대로). */
export function applyHotfix(sel: SelectorDict, hf: Hotfix): SelectorDict {
  const out = structuredClone(sel);
  for (const [k, { candidates }] of Object.entries(hf.entries)) if (out.entries[k]) out.entries[k]!.candidates = structuredClone(candidates);
  const add: CommitEndpoint[] = hf.commitEndpointsAdd ?? [];
  out.commitEndpoints = [...out.commitEndpoints, ...structuredClone(add)];
  return out;
}
