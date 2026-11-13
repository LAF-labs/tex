// 셀렉터 사전 항목 해석(D02 §2.1)과 R-A1 동일성 검사(D03 §5.2).
// - 랜드마크 항목을 먼저 해석해 그 하위에서만 찾는다(frame·landmark 범위). 루트 항목은 landmark가 자기 자신이다.
// - 후보를 순서대로 시도한다. 한 후보에 expect(보임·활성·입력 가능)를 만족하는 요소가 정확히 1개일 때만 받는다. 2개 이상이면 다음 후보로
//   넘어가지 않고 실패한다(fail-closed: 첫 후보가 모호하면 다른 후보가 맞혀도 그것이 의도한 요소라는 보장이 없다).
// - 받은 요소의 실제 역할·접근성 이름(NFKC·제로폭 제거·공백 접기 뒤)이 사전의 role·namePattern과 맞지 않으면 step.identity_mismatch.
import { normalizeName } from './constants.ts';
import type { ElementInfo, PageReader, Resolved } from './page.ts';
import { compileRe2 } from './re2.ts';
import type { SelectorDict, SelectorEntry } from './types.ts';

export type ResolveCode = 'step.selector_miss' | 'step.identity_mismatch';
export type ResolveResult = { ok: true; t: Resolved } | { ok: false; code: ResolveCode; ambiguous?: boolean; stale?: boolean };

/**
 * IR rev v1.3.7(부장 2026-11-13): 동일성 검사 중 찾은 요소가 바뀌면(ElementInfo.stale) 바로 끝내지 않고 이만큼 다시 본다.
 * 커밋 항목(비가역 동작의 대상)은 다시 보지 않는다.
 */
export const STALE_RETRIES = 5;
export const STALE_WAIT_MS = 100;

/** 랜드마크 사슬 깊이 상한(사전 순환 방어. 정적 검사가 이미 막는다). */
const MAX_LANDMARK_DEPTH = 8;

const patternCache = new Map<string, RegExp>();
function namePattern(p: string): RegExp {
  let re = patternCache.get(p);
  if (!re) {
    re = compileRe2(p);
    patternCache.set(p, re);
  }
  return re;
}

/** 정규화한(NFKC·제로폭 제거·공백 접기) 이름이 namePattern(RE2)에 맞는가. 패턴이 RE2로 안 되면 거짓. */
export function nameMatches(pattern: string, name: string): boolean {
  try {
    return namePattern(pattern).test(normalizeName(name));
  } catch {
    return false;
  }
}

/** R-A1: 역할은 정확히 같고, 정규화한 이름이 namePattern에 맞아야 한다. 문제가 없으면 null. */
export function identityProblem(entry: Pick<SelectorEntry, 'role' | 'namePattern'>, info: Pick<ElementInfo, 'role' | 'name'>): 'role' | 'name' | null {
  if (info.role !== entry.role) return 'role';
  return nameMatches(entry.namePattern, info.name) ? null : 'name';
}

export async function resolveTarget(page: PageReader, dict: SelectorDict, key: string, depth = 0): Promise<ResolveResult> {
  for (let i = 0; ; i++) {
    const r = await resolveOnce(page, dict, key, depth);
    if (r.ok || !r.stale || i >= STALE_RETRIES || dict.entries[key]?.commits) return r;
    await new Promise((res) => setTimeout(res, STALE_WAIT_MS));
  }
}

async function resolveOnce(page: PageReader, dict: SelectorDict, key: string, depth: number): Promise<ResolveResult> {
  const entry = dict.entries[key];
  if (!entry || depth > MAX_LANDMARK_DEPTH) return { ok: false, code: 'step.selector_miss' };
  let within = null;
  if (entry.landmark !== key) {
    const lm = await resolveTarget(page, dict, entry.landmark, depth + 1);
    if (!lm.ok) return lm;
    within = lm.t.el;
  }
  for (const c of entry.candidates) {
    const hits: Array<{ el: Resolved['el']; info: ElementInfo }> = [];
    for (const el of await page.query(c, entry.frame, within)) {
      const info = await page.info(el);
      if (entry.expect?.visible && !info.visible) continue;
      if (entry.expect?.enabled && !info.enabled) continue;
      if (entry.expect?.editable && info.editable !== true) continue;
      hits.push({ el, info });
    }
    if (hits.length === 0) continue;
    if (hits.length > 1) return { ok: false, code: 'step.selector_miss', ambiguous: true };
    if (identityProblem(entry, hits[0]!.info)) return { ok: false, code: 'step.identity_mismatch', ...(hits[0]!.info.stale ? { stale: true } : {}) };
    return { ok: true, t: { key, entry, el: hits[0]!.el } };
  }
  return { ok: false, code: 'step.selector_miss' };
}
