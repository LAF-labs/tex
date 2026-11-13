// 폴백 사슬(부장 지시 2026-11-13): 되돌릴 수 있는 스텝이 실패하면 사람에게 넘기기 전에 이 순서로 간다.
//   1. 패키지 recovery 재시도(실행기가 이미 한다: effectiveOnFail.retry, 정책 stepMax 상한)
//   2. 패키지의 role·label 후보로 다시 찾기(css 건너뜀, 모델 없음, core/locate.ts refindWithoutCss)
//   3. AI 위치 찾기(게이트웨이 selector_repair, core/locate.ts locateTarget, 스텝당 모델 2번)
//   4. 체크포인트 재진입(이 스텝 앞 마지막 체크포인트, 실행당 체크포인트마다 1번. 첫 게이트 앞 스텝만)
//   5. 사람(false를 돌려주면 조율기가 핸드오프한다)
// 쓰는 곳: fill·click·select·wait 중 비가역 스텝이 아니고 대상 항목이 commits·비밀 칸·비밀번호 칸이 아닌 것. 제출·서명·게이트·checkpoint는 타입에서 빠진다.
// 2·3단계가 찾은 선택자는 실행 사본 사전의 그 항목 첫 후보로 남는다(GuardedActuator R-A1 재확인도 같은 후보를 본다). 되읽기가 틀리면 빼고 다음 단계로 간다.
import { flatten } from './cfg.ts';
import { dropFirstCandidate, locatable, locateTarget, refindWithoutCss, type LocateEnv } from './locate.ts';
import type { PageReader } from './page.ts';
import type { PlaybookIR, SelectorDict, Step } from './types.ts';

const TYPES = new Set(['fill', 'click', 'select', 'wait']);
/** 대상을 다시 찾을 만한 실패. */
const TARGET_CODES = new Set(['step.selector_miss', 'step.identity_mismatch', 'step.timeout']);
/** 폴백 사슬을 탈 실패(그 밖의 코드는 같은 동작을 다시 해도 같은 결과라 바로 사람에게). */
const CHAIN_CODES = new Set([...TARGET_CODES, 'step.readback_mismatch']);

export interface FallbackDeps {
  ir: PlaybookIR;
  /** 실행 사본 사전(runLocalDict). */
  dict: SelectorDict;
  page: PageReader;
  irreversible: ReadonlySet<string>;
  locate?: LocateEnv;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
}

interface StepState {
  refind: boolean;
  calls: { n: number };
  rejected: string[];
  /** 폴백이 사전에 넣은 맨 앞 후보(되읽기가 틀리면 뺀다). */
  added: string | null;
  tried: string[];
}

/** 스텝의 대상 셀렉터 키(fill·click·select는 target, wait는 for:selector의 value). */
function targetOf(s: Step): string | null {
  const x = s as Step & { target?: unknown; for?: unknown; value?: unknown };
  if (typeof x.target === 'string') return x.target;
  if (s.type === 'wait' && x.for === 'selector' && typeof x.value === 'string') return x.value;
  return null;
}

export class FallbackChain {
  private readonly d: FallbackDeps;
  private readonly info: ReturnType<typeof flatten>['info'];
  private readonly firstGate: number;
  private readonly per = new Map<string, StepState>();
  private readonly reentered = new Set<string>();

  constructor(d: FallbackDeps) {
    this.d = d;
    this.info = flatten(d.ir.steps).info;
    this.firstGate = Math.min(...[...this.info.values()].filter((v) => v.step.type === 'gate').map((v) => v.order), Number.POSITIVE_INFINITY);
  }

  /** 실행기 escalate: 이 실패를 사람에게 넘기기 전에 사슬로 보낼지. */
  eligible(s: Step, cause: string): boolean {
    if (!TYPES.has(s.type) || this.d.irreversible.has(s.id) || !CHAIN_CODES.has(cause)) return false;
    const key = targetOf(s);
    if (key === null) return s.type === 'wait';
    return locatable(this.d.dict.entries[key], s.id, this.d.irreversible);
  }

  /** 조율기 recover 훅. 다시 돌 곳(그 스텝 또는 체크포인트)이나 false(사람). */
  async recover(stepId: string, cause: string): Promise<{ from: string } | false> {
    const s = this.info.get(stepId)?.step;
    if (!s || !this.eligible(s, cause)) return false;
    const st = this.state(stepId);
    const key = targetOf(s);
    const entry = key ? this.d.dict.entries[key] : undefined;
    if (key && entry && (TARGET_CODES.has(cause) || st.added)) {
      if (st.added) {
        // 폴백으로 넣은 후보로 해 봤는데 또 틀렸다: 빼고 다음 단계로.
        dropFirstCandidate(this.d.dict, key);
        st.rejected.push(st.added);
        this.d.journal('fallback.dropped', { stepId, key, selector: st.added, code: cause });
        st.added = null;
      }
      if (!st.refind) {
        st.refind = true;
        st.tried.push('refind');
        const r = await refindWithoutCss(this.d.page, this.d.dict, key, st.rejected);
        this.d.journal('fallback.refind', { stepId, key, found: !!r, ...(r ? { selector: r.selector } : {}) });
        if (r) {
          st.added = r.selector;
          return { from: stepId };
        }
      }
      const purpose = s.type === 'wait' ? null : (s.type as 'fill' | 'click' | 'select');
      if (this.d.locate && purpose && st.calls.n < 2) {
        st.tried.push('locate');
        const r = await locateTarget({ page: this.d.page, dict: this.d.dict, loc: this.d.locate, stepId, key, purpose, rejected: st.rejected, calls: st.calls });
        if (r) {
          st.added = r.selector;
          return { from: stepId };
        }
      }
    }
    const cp = this.checkpointBefore(stepId);
    if (cp && !this.reentered.has(cp)) {
      this.reentered.add(cp);
      st.tried.push('checkpoint');
      this.d.journal('fallback.checkpoint', { stepId, checkpoint: cp, code: cause });
      return { from: cp };
    }
    return false;
  }

  /** 핸드오프 기록용: 이 스텝에서 거친 폴백 단계(재시도 뒤). */
  tried(stepId: string): string {
    return ['retry', ...(this.per.get(stepId)?.tried ?? [])].join(':');
  }

  /** 이 스텝 앞(같은 줄기) 마지막 체크포인트. 첫 게이트 뒤 스텝은 재진입하지 않는다(커밋을 다시 지나는 길을 만들지 않는다). */
  private checkpointBefore(stepId: string): string | null {
    const me = this.info.get(stepId);
    if (!me || me.order >= this.firstGate || me.repeats.length) return null;
    let best: { id: string; order: number } | null = null;
    for (const [id, v] of this.info) if (v.step.type === 'checkpoint' && !v.repeats.length && v.order < me.order && (!best || v.order > best.order)) best = { id, order: v.order };
    return best?.id ?? null;
  }

  private state(stepId: string): StepState {
    let st = this.per.get(stepId);
    if (!st) this.per.set(stepId, (st = { refind: false, calls: { n: 0 }, rejected: [], added: null, tried: [] }));
    return st;
  }
}
