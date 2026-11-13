// 대상 다시 찾기(폴백 사슬 2·3단계, core/fallback.ts가 부른다): 사전 후보로 못 찾은 대상을 패키지의 role·label 후보로, 그다음 AI 위치 찾기로 찾는다.
// - 쓰는 곳: 비밀 칸이 아니고, commits가 아니고, 비가역 스텝이 아닌 항목만. 게이트·checkpoint·제출·서명·발급은 지금처럼 멈춘다.
// - 화면 목록: 그 항목 frame의 같은 역할 요소만, 역할·접근성 이름·DOM id만 담는다. 입력값은 읽지 않는다. 모델에는 포트가 마스킹해서 보낸다.
// - 모델 제안은 그대로 쓰지 않는다. 제안 선택자를 이 실행의 사전 사본에서 그 항목 후보 맨 앞에 두고 resolveTarget(유일 일치·보임·역할·이름 패턴)을 통과할 때만 받는다.
//   통과한 선택자는 이번 실행 동안 그 항목의 첫 후보로 남는다(같은 실행의 다음 스텝·GuardedActuator의 R-A1 재확인도 그것을 본다).
// - 모델 호출은 스텝당 최대 2번이다(게이트웨이 실행당 L2 예산 2와 같다).
import type { ElementRef, PageReader, Resolved } from './page.ts';
import { resolveTarget } from './resolve.ts';
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

/** 실행 사본 사전의 그 항목 맨 앞에 후보를 두고 resolveTarget을 통과하면 남긴다. 아니면 되돌린다. */
async function tryCandidate(page: PageReader, dict: SelectorDict, key: string, cand: Cand): Promise<{ ok: true; t: Resolved } | { ok: false; code: string }> {
  const before = dict.entries[key]!;
  dict.entries[key] = { ...before, candidates: [cand, ...before.candidates] };
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

/**
 * 사전 후보로 못 찾은 항목을 모델 제안으로 다시 찾는다. 찾으면 실행 사본 사전의 그 항목 첫 후보로 남기고 Resolved를 돌려준다.
 * rejected: 이 스텝에서 이미 써 보고 틀린 선택자(같은 것을 다시 고르지 않게). 이번에 거절한 것도 여기에 더한다(호출자 목록을 바꾼다).
 * calls: 이 스텝의 모델 호출 수(호출자가 들고 있어 사슬을 다시 돌아도 스텝당 2번을 넘지 않는다).
 */
export async function locateTarget(
  o: { page: PageReader; dict: SelectorDict; loc: LocateEnv; stepId: string; key: string; purpose: LocateRequest['purpose']; rejected: string[]; calls: { n: number } },
): Promise<{ t: Resolved; selector: string } | null> {
  const entry = o.dict.entries[o.key];
  if (!entry || !o.page.listRole) return null;
  const { calls, rejected } = o;
  while (calls.n < LOCATE_MAX_CALLS) {
    const listed = (await o.page.listRole(entry.frame, entry.role)).filter((x) => (!entry.expect?.visible || x.visible) && (!entry.expect?.enabled || x.enabled));
    if (!listed.length) {
      o.loc.journal('locate.none', { stepId: o.stepId, key: o.key });
      return null;
    }
    calls.n++;
    const req: LocateRequest = {
      stepId: o.stepId, key: o.key, purpose: o.purpose, role: entry.role, namePattern: entry.namePattern,
      describe: [o.key, entry.fieldKey, entry.inputType].filter(Boolean).join(' · '),
      listing: listed.map((x, i) => ({ n: i + 1, name: x.name, id: x.id })), rejected: [...rejected],
    };
    let cands: LocateCandidate[] | null;
    try {
      cands = await o.loc.model.propose(req);
    } catch {
      cands = null;
    }
    o.loc.journal('locate.asked', { stepId: o.stepId, key: o.key, call: calls.n, listed: listed.length, proposed: cands?.length ?? 0 });
    if (!cands) return null;
    for (const c of cands) {
      const cand: Cand = c.kind === 'role' ? { kind: 'role', role: c.value, name: c.name } : c.kind === 'css' ? { kind: 'css', value: c.value } : { kind: 'label', value: c.value };
      const sel = candidateText(cand);
      if (rejected.includes(sel)) continue;
      const r = await tryCandidate(o.page, o.dict, o.key, cand);
      if (r.ok) {
        o.loc.journal('locate.found', { stepId: o.stepId, key: o.key, call: calls.n, selector: sel });
        return { t: r.t, selector: sel };
      }
      rejected.push(sel);
      o.loc.journal('locate.rejected', { stepId: o.stepId, key: o.key, call: calls.n, selector: sel, code: r.code });
    }
  }
  return null;
}
