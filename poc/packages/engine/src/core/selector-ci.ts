// D02 §6.3 셀렉터 CI SV-01~06(B-01·B-02·B-03·B-05·B-17·B-32). 레지스트리의 패키지·핫픽스 CI에서만 돈다
// (녹화 DOM·HAR이 필요하다). 클라이언트는 다시 돌리지 않고 런타임에 R-A1·R-A2·DENY_ACTION_NAME을 매번 한다(D03 §3.1-6).
import { COMMIT_NAME_LINT, isDenyActionName, normalizeName } from './constants.ts';
import { compileRe2, isAnchored } from './re2.ts';
import type { CommitEndpoint, EndpointMatch, PortalMode, SelectorDict, Violation } from './types.ts';

/** 녹화 DOM의 접근성 요소 하나. landmark는 가장 가까운 form·dialog 랜드마크 요소의 uid. */
export interface RecordedElement {
  uid: string;
  role: string;
  name: string;
  frame: string;
  landmark: string | null;
}

export interface RecordedRequest {
  method: string;
  path: string;
  params?: Record<string, string>;
  /** 이 요청 직전에 녹화가 누른 요소의 uid(클릭 직후 요청). */
  afterClick?: string;
}

export interface Recording {
  elements: RecordedElement[];
  /** 사전 stable_id → 녹화 DOM에서 후보를 순서대로 해석한 결과 uid(없으면 null). */
  resolved: Record<string, string | null>;
  har: RecordedRequest[];
}

const INPUT_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'spinbutton', 'searchbox']);
const ACTION_ROLES = new Set(['button', 'link', 'menuitem']);

export function endpointMatches(m: EndpointMatch, req: Pick<RecordedRequest, 'method' | 'path' | 'params'>): boolean {
  if (m.method !== req.method.toUpperCase()) return false;
  if (!compileRe2(m.pathPattern).test(req.path)) return false;
  if (m.actionParam && req.params?.[m.actionParam.name] !== m.actionParam.value) return false;
  return true;
}

/** 랜드마크 uid의 서브트리 소속(중첩 랜드마크 포함). */
function inSubtree(rec: Recording, el: RecordedElement, landmarkUid: string): boolean {
  const byUid = new Map(rec.elements.map((e) => [e.uid, e]));
  let cur: string | null = el.landmark;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    if (cur === landmarkUid) return true;
    seen.add(cur);
    cur = byUid.get(cur)?.landmark ?? null;
  }
  return false;
}

export function selectorCi(sel: SelectorDict, rec: Recording): Violation[] {
  const v: Violation[] = [];
  const bad = (rule: string, message: string, target?: string) => v.push({ rule, message, ...(target ? { target } : {}) });
  const byUid = new Map(rec.elements.map((e) => [e.uid, e]));
  const entries = Object.entries(sel.entries);
  const commitIds = entries.filter(([, e]) => e.commits).map(([k]) => k);

  // SV-01: 비커밋 항목의 해석 결과가 어떤 커밋 항목과도 같은 요소가 아니다.
  for (const [k, e] of entries) {
    if (e.commits) continue;
    const u = rec.resolved[k];
    if (!u) continue;
    const clash = commitIds.find((c) => rec.resolved[c] === u);
    if (clash) bad('SV-01', `비커밋 항목이 커밋 항목 ${clash}와 같은 요소로 해석됨`, k);
  }
  // SV-02: 클릭 직후 커밋 요청을 만든 요소는 commits:true, 이름 린트.
  for (const r of rec.har) {
    if (!r.afterClick || !sel.commitEndpoints.some((c) => endpointMatches(c.match, r))) continue;
    const owners = entries.filter(([k]) => rec.resolved[k] === r.afterClick);
    if (!owners.length) bad('SV-02', `커밋 요청(${r.method} ${r.path})을 만든 요소가 사전에 없음`);
    for (const [k, e] of owners) if (!e.commits) bad('SV-02', '커밋 요청을 만든 요소가 commits:false', k);
  }
  for (const [k, e] of entries) {
    if (e.commits || e.reviewNote || !ACTION_ROLES.has(e.role)) continue;
    const u = rec.resolved[k];
    const name = u ? byUid.get(u)?.name ?? '' : e.namePattern;
    if (COMMIT_NAME_LINT.test(normalizeName(name))) bad('SV-02', '진행·제출형 이름의 commits:false 항목에 reviewNote가 없음', k);
  }
  // SV-03: 커밋 항목 랜드마크 안 입력 요소에는 fieldKey가 있어야 한다.
  const keyed = new Set(entries.filter(([, e]) => e.fieldKey).map(([k]) => rec.resolved[k]).filter((u): u is string => !!u));
  const secret = new Set(entries.filter(([, e]) => e.secretKind || e.inputType === 'password').map(([k]) => rec.resolved[k]).filter((u): u is string => !!u));
  for (const c of commitIds) {
    const lm = rec.resolved[sel.entries[c]!.landmark];
    if (!lm) {
      bad('SV-03', '커밋 항목의 랜드마크가 녹화에서 해석되지 않음', c);
      continue;
    }
    for (const el of rec.elements) {
      if (!INPUT_ROLES.has(el.role) || !inSubtree(rec, el, lm) || keyed.has(el.uid) || secret.has(el.uid)) continue;
      bad('SV-03', `커밋 랜드마크 안 입력 요소(${el.role})에 fieldKey 항목이 없음`, c);
    }
  }
  // SV-04: namePattern 앵커, 같은 랜드마크 안 정확히 1개.
  for (const [k, e] of entries) {
    if (!isAnchored(e.namePattern)) {
      bad('SV-04', 'namePattern이 ^…$ 앵커가 아님', k);
      continue;
    }
    const lm = rec.resolved[e.landmark];
    if (!lm) continue;
    if (k === e.landmark) continue;
    const re = compileRe2(e.namePattern);
    const n = rec.elements.filter((el) => inSubtree(rec, el, lm) && re.test(normalizeName(el.name))).length;
    if (n !== 1) bad('SV-04', `namePattern이 랜드마크 안 ${n}개 요소에 맞음`, k);
  }
  // SV-05: 닫기 요소의 녹화 이름이 DENY_ACTION_NAME에 맞으면 거부.
  for (const [k, e] of entries) {
    if (!e.closeAffordance) continue;
    const u = rec.resolved[k];
    const name = u ? byUid.get(u)?.name ?? '' : '';
    if (isDenyActionName(name)) bad('SV-05', '닫기 요소 이름이 승인·진행 동작 이름', k);
  }
  return v;
}

/** SV-06: 같은 포털의 설치된 모든 패키지 commitEndpoints 합집합이 비면 auto·assisted로 실행하지 않는다(엔진도 실행 시 확인). */
export function sv06(union: readonly CommitEndpoint[], mode: PortalMode): Violation[] {
  return union.length === 0 && mode !== 'postprocess' ? [{ rule: 'SV-06', message: `commitEndpoints 합집합이 비어 ${mode} 실행 불가` }] : [];
}
