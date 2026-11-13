// AI 위치 찾기(대표 지시 2026-11-13 "스크립트 → 폴백 → 사람"): fill·click·select의 대상을 사전 후보로 다 못 찾았을 때, 사람에게 넘기기 전에 한 번 더 찾는다.
// - 쓰는 곳: 비밀 칸이 아니고, commits가 아니고, 비가역 스텝이 아닌 항목만. 게이트·checkpoint·제출·서명·발급은 지금처럼 멈춘다.
// - 화면 목록: 그 항목 frame의 같은 역할 요소만, 역할·접근성 이름·DOM id만 담는다. 입력값은 읽지 않는다. 모델에는 포트가 마스킹해서 보낸다.
// - 모델 제안은 그대로 쓰지 않는다. 제안 선택자를 이 실행의 사전 사본에서 그 항목 후보 맨 앞에 두고 resolveTarget(유일 일치·보임·역할·이름 패턴)을 통과할 때만 받는다.
//   통과한 선택자는 이번 실행 동안 그 항목의 첫 후보로 남는다(같은 실행의 다음 스텝·GuardedActuator의 R-A1 재확인도 그것을 본다).
// - 모델 호출은 스텝당 최대 2번이다(게이트웨이 실행당 L2 예산 2와 같다). 그래도 못 찾으면 원래 코드(step.selector_miss)로 사람에게 간다.
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

const selectorText = (c: LocateCandidate) => (c.kind === 'role' ? `role=${c.value}[name="${c.name}"]` : c.kind === 'css' ? c.value : `label=${c.value}`);

/**
 * 사전 후보로 못 찾은 항목을 모델 제안으로 다시 찾는다. 찾으면 실행 사본 사전의 그 항목 첫 후보로 남기고 Resolved를 돌려준다.
 * exclude: 이번 스텝에서 이미 써 보고 되읽기가 틀린 요소(같은 요소를 다시 고르지 않게).
 */
export async function locateTarget(
  o: { page: PageReader; dict: SelectorDict; loc: LocateEnv; stepId: string; key: string; purpose: LocateRequest['purpose']; exclude?: string[]; calls?: { n: number } },
): Promise<Resolved | null> {
  const entry = o.dict.entries[o.key];
  if (!entry || !o.page.listRole) return null;
  const calls = o.calls ?? { n: 0 };
  const rejected = [...(o.exclude ?? [])];
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
      listing: listed.map((x, i) => ({ n: i + 1, name: x.name, id: x.id })), rejected,
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
      const sel = selectorText(c);
      if (rejected.includes(sel)) continue;
      const cand = c.kind === 'role' ? { kind: 'role' as const, role: c.value, name: c.name } : c.kind === 'css' ? { kind: 'css' as const, value: c.value } : { kind: 'label' as const, value: c.value };
      const before = o.dict.entries[o.key]!;
      o.dict.entries[o.key] = { ...entry, candidates: [cand, ...entry.candidates] };
      const r = await resolveTarget(o.page, o.dict, o.key);
      if (r.ok) {
        o.loc.journal('locate.found', { stepId: o.stepId, key: o.key, call: calls.n, selector: sel });
        return r.t;
      }
      o.dict.entries[o.key] = before;
      rejected.push(sel);
      o.loc.journal('locate.rejected', { stepId: o.stepId, key: o.key, call: calls.n, selector: sel, code: r.code });
    }
  }
  return null;
}
