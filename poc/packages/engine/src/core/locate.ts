// 대상 다시 찾기(폴백 사슬 2·3단계, core/fallback.ts가 부른다): 사전 후보로 못 찾은 대상을 패키지의 role·label 후보로, 그다음 AI 위치 찾기로 찾는다.
// - 쓰는 곳: 비밀 칸이 아니고, commits가 아니고, 비가역 스텝이 아닌 항목만. 게이트·checkpoint·제출·서명·발급은 지금처럼 멈춘다.
// - 화면 목록: 그 항목 frame의 같은 역할 요소만, 역할·접근성 이름·DOM id만 담는다. 입력값은 읽지 않는다. 모델에는 포트가 마스킹해서 보낸다.
// - 모델 제안은 그대로 쓰지 않는다. 제안 선택자를 이 실행의 사전 사본에서 그 항목 후보 맨 앞에 두고 resolveTarget(유일 일치·보임·역할·이름 패턴)을 통과할 때만 받는다.
//   통과한 선택자는 이번 실행 동안 그 항목의 첫 후보로 남는다(같은 실행의 다음 스텝·GuardedActuator의 R-A1 재확인도 그것을 본다).
// - 모델 호출은 스텝당 최대 2번이다(게이트웨이 실행당 L2 예산 2와 같다).
import type { ElementRef, PageReader, Resolved } from './page.ts';
import { maskScreenText, normalizeName } from './constants.ts';
import { nameMatches, resolveTarget } from './resolve.ts';
import { isSecretEntry, type SelectorDict, type SelectorEntry } from './types.ts';

/** 프레임의 같은 역할 요소 한 줄(값 없음). */
export interface ListedElement {
  el: ElementRef;
  name: string;
  /** DOM id. 없으면 null. */
  id: string | null;
  visible: boolean;
  enabled: boolean;
}

/** 모델이 낸 선택자 후보(selector_repair 출력과 같은 꼴). */
export interface LocateCandidate {
  kind: 'css' | 'role' | 'label';
  value: string;
  name: string;
}

export interface LocateRequest {
  stepId: string;
  key: string;
  purpose: 'fill' | 'click' | 'select';
  role: string;
  namePattern: string;
  /** 대상 설명(사전 항목 키·필드 키·입력 종류). 코드 이름뿐이라 값이 없다. */
  describe: string;
  /** 같은 역할 요소 목록(마스킹 전). 포트가 마스킹한다. */
  listing: Array<{ n: number; name: string; id: string | null }>;
  /** 앞 시도에서 받았지만 검사를 통과하지 못한 선택자. */
  rejected: string[];
  /** 사전 후보가 찾은 요소의 목록 번호(역할은 맞고 이름만 namePattern과 다를 때, step.identity_mismatch). 모델이 맞다고 하면 받는다. */
  found?: number;
}

/** 모델 쪽 포트(제품: 게이트웨이 selector_repair). 실패·거절이면 null. */
export interface LocateModel {
  propose(req: LocateRequest): Promise<LocateCandidate[] | null>;
}

export interface LocateEnv {
  model: LocateModel;
  /** 저널(코드·키·선택자만, 화면 글·값 없음). */
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
}

/** 스텝당 모델 호출 상한 */
export const LOCATE_MAX_CALLS = 2;

/** 실행 사본 사전: 원본 패키지 사전을 바꾸지 않고 항목만 갈아 끼운다. */
export function runLocalDict(d: SelectorDict): SelectorDict {
  return { ...d, entries: { ...d.entries } };
}

/** 이 항목에 AI 위치 찾기를 써도 되는가(비밀·커밋·비가역 스텝·사전에 없는 항목은 아니다). */
export function locatable(entry: SelectorEntry | undefined, stepId: string, irreversible: ReadonlySet<string>): entry is SelectorEntry {
  return !!entry && !isSecretEntry(entry) && !entry.commits && !irreversible.has(stepId) && entry.inputType !== 'password';
}

type Cand = SelectorEntry['candidates'][number];

/** 저널·제외 목록에 쓰는 선택자 글(코드 이름·접근성 이름뿐). */
export const candidateText = (c: Cand): string => (c.kind === 'role' ? `role=${c.role}[name="${c.name}"]` : c.kind === 'css' ? c.value : `label=${c.value}`);

/**
 * 실행 사본 사전의 그 항목 맨 앞에 후보를 두고 resolveTarget을 통과하면 남긴다. 아니면 되돌린다.
 * namePattern: 모델이 확인한 요소의 이름으로 그 항목 이름 규칙을 이번 실행 동안 바꾼다(identity_mismatch 확인 길만).
 */
async function tryCandidate(page: PageReader, dict: SelectorDict, key: string, cand: Cand, namePattern?: string): Promise<{ ok: true; t: Resolved } | { ok: false; code: string }> {
  const before = dict.entries[key]!;
  dict.entries[key] = { ...before, ...(namePattern ? { namePattern } : {}), candidates: [cand, ...before.candidates] };
  const r = await resolveTarget(page, dict, key);
  if (r.ok) return r;
  dict.entries[key] = before;
  return { ok: false, code: r.ambiguous ? 'step.ambiguous' : r.code };
}

/** 실행 사본 사전에서 폴백으로 넣은 맨 앞 후보를 뺀다(되읽기가 틀렸을 때). */
export function dropFirstCandidate(dict: SelectorDict, key: string): void {
  const e = dict.entries[key];
  if (e && e.candidates.length > 1) dict.entries[key] = { ...e, candidates: e.candidates.slice(1) };
}

/**
 * 폴백 2단계: 패키지에 서명된 role·label 후보만으로 다시 찾는다(모델 없음). resolveTarget은 첫 후보(css)가 모호하거나 동일성이 틀리면
 * 뒤 후보를 보지 않고 멈춘다(fail-closed). 여기서는 css를 건너뛰고 role·label 후보를 하나씩 맨 앞에 두어 본다. 유일 일치·landmark·동일성은 그대로 본다.
 * 새 후보를 지어내지 않는다(namePattern이 느슨한 항목에서 이름으로 지어내면 다른 칸을 고를 수 있다).
 */
export async function refindWithoutCss(page: PageReader, dict: SelectorDict, key: string, skip: readonly string[] = []): Promise<{ t: Resolved; selector: string } | null> {
  const entry = dict.entries[key];
  if (!entry) return null;
  for (const c of entry.candidates) {
    if (c.kind === 'css') continue;
    const sel = candidateText(c);
    if (skip.includes(sel)) continue;
    const r = await tryCandidate(page, dict, key, c);
    if (r.ok) return { t: r.t, selector: sel };
  }
  return null;
}

const reEscape = (s: string) => s.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/**
 * step.identity_mismatch의 그 요소: 사전 후보가 (landmark 안에서) 정확히 하나를 찾았고 역할은 같은데 이름만 namePattern과 다르면 그 정규화 이름.
 * 역할이 다르거나 모호하면 null(모델에게 확인시키지 않는다).
 */
async function nameMismatched(page: PageReader, dict: SelectorDict, key: string): Promise<string | null> {
  const entry = dict.entries[key];
  if (!entry) return null;
  let within = null;
  if (entry.landmark !== key) {
    const lm = await resolveTarget(page, dict, entry.landmark);
    if (!lm.ok) return null;
    within = lm.t.el;
  }
  for (const c of entry.candidates) {
    const hits = [];
    for (const el of await page.query(c, entry.frame, within)) {
      const info = await page.info(el);
      if (entry.expect?.visible && !info.visible) continue;
      if (entry.expect?.enabled && !info.enabled) continue;
      hits.push(info);
    }
    if (!hits.length) continue;
    if (hits.length > 1) return null;
    const info = hits[0]!;
    return info.role === entry.role && !nameMatches(entry.namePattern, info.name) ? normalizeName(info.name) : null;
  }
  return null;
}

/**
 * 사전 후보로 못 찾은 항목을 모델 제안으로 다시 찾는다. 찾으면 실행 사본 사전의 그 항목 첫 후보로 남기고 Resolved를 돌려준다.
 * rejected: 이 스텝에서 이미 써 보고 틀린 선택자(같은 것을 다시 고르지 않게). 이번에 거절한 것도 여기에 더한다(호출자 목록을 바꾼다).
 * calls: 이 스텝의 모델 호출 수(호출자가 들고 있어 사슬을 다시 돌아도 스텝당 2번을 넘지 않는다).
 * identity_mismatch(사전 후보가 찾은 요소의 이름만 다름): 그 요소를 빼지 않고 목록 번호(found)로 알려 모델에게 확인시킨다.
 * 모델이 그 요소를 고르면 이번 실행 동안만 그 항목 namePattern을 그 요소의 이름으로 바꿔 받는다(역할·유일 일치·landmark는 그대로 본다).
 */
export async function locateTarget(
  o: { page: PageReader; dict: SelectorDict; loc: LocateEnv; stepId: string; key: string; purpose: LocateRequest['purpose']; rejected: string[]; calls: { n: number } },
): Promise<{ t: Resolved; selector: string } | null> {
  const entry = o.dict.entries[o.key];
  if (!entry || !o.page.listRole) return null;
  const { calls, rejected } = o;
  const mism = await nameMismatched(o.page, o.dict, o.key);
  // 결과 한 줄(engine.log): 고른 선택자 또는 고르지 못한 이유. mismatchName은 사전 요소의 실제 접근성 이름(숫자 가림).
  const result = (why: string, extra: Record<string, string | number | boolean> = {}) =>
    o.loc.journal('locate.result', { stepId: o.stepId, key: o.key, result: why, calls: calls.n, rejected: rejected.length, mismatch: mism !== null, ...(mism !== null ? { mismatchName: maskScreenText(mism) } : {}), ...extra });
  while (calls.n < LOCATE_MAX_CALLS) {
    const listed = (await o.page.listRole(entry.frame, entry.role)).filter((x) => (!entry.expect?.visible || x.visible) && (!entry.expect?.enabled || x.enabled));
    if (!listed.length) {
      o.loc.journal('locate.none', { stepId: o.stepId, key: o.key });
      result('no_elements_of_role', { role: entry.role });
      return null;
    }
    calls.n++;
    const same = mism === null ? [] : listed.map((x, i) => ({ x, n: i + 1 })).filter(({ x }) => normalizeName(x.name) === mism);
    const found = same.length === 1 ? same[0]! : null;
    const req: LocateRequest = {
      stepId: o.stepId, key: o.key, purpose: o.purpose, role: entry.role, namePattern: entry.namePattern,
      describe: [o.key, entry.fieldKey, entry.inputType].filter(Boolean).join(' · '),
      listing: listed.map((x, i) => ({ n: i + 1, name: x.name, id: x.id })), rejected: [...rejected],
      ...(found ? { found: found.n } : {}),
    };
    let cands: LocateCandidate[] | null;
    try {
      cands = await o.loc.model.propose(req);
    } catch {
      cands = null;
    }
    // sameName: 목록에서 사전 요소와 같은 이름 수(1이어야 모델에게 그 번호를 알려 확인시킨다)
    o.loc.journal('locate.asked', { stepId: o.stepId, key: o.key, call: calls.n, listed: listed.length, proposed: cands?.length ?? 0, mismatch: mism !== null, sameName: same.length, foundN: found?.n ?? 0 });
    if (!cands) {
      // not_found·응답 없음·가림 실패 모두(어느 쪽인지는 locate.answer·locate.unavailable 줄)
      result('model_gave_none');
      return null;
    }
    for (const c of cands) {
      const cand: Cand = c.kind === 'role' ? { kind: 'role', role: c.value, name: c.name } : c.kind === 'css' ? { kind: 'css', value: c.value } : { kind: 'label', value: c.value };
      const sel = candidateText(cand);
      if (rejected.includes(sel)) continue;
      // 모델이 사전이 찾은 그 요소를 골랐다(css #id 또는 같은 이름): 이름 규칙을 그 이름으로 바꿔 확인한다.
      const confirms = !!found && mism !== null && (cand.kind === 'css' ? !!found.x.id && cand.value === `#${found.x.id}` : normalizeName(cand.kind === 'role' ? cand.name : cand.value) === mism);
      const r = await tryCandidate(o.page, o.dict, o.key, cand, confirms ? `^${reEscape(mism!)}$` : undefined);
      if (r.ok) {
        o.loc.journal(confirms ? 'locate.identity_confirmed' : 'locate.found', { stepId: o.stepId, key: o.key, call: calls.n, selector: sel });
        result(confirms ? 'identity_confirmed' : 'found', { selector: sel });
        return { t: r.t, selector: sel };
      }
      rejected.push(sel);
      o.loc.journal('locate.rejected', { stepId: o.stepId, key: o.key, call: calls.n, selector: sel, code: r.code });
    }
  }
  result('calls_exhausted');
  return null;
}
