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
  afterClick?: string;
}

export interface Recording {
  elements: RecordedElement[];
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

  for (const [k, e] of entries) {
    if (e.commits) continue;
    const u = rec.resolved[k];
    if (!u) continue;
    const clash = commitIds.find((c) => rec.resolved[c] === u);
    if (clash) bad('SV-01', `비커밋 항목이 커밋 항목 ${clash}와 같은 요소로 해석됨`, k);
  }
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
