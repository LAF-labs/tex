// 폴백 사슬(부장 지시 2026-11-13): 되돌릴 수 있는 스텝이 실패하면 사람에게 넘기기 전에 이 순서로 간다.
//   0. 고친 선택자 기억(core/heal-memory.ts, 2026-11-16): 실행 시작 때 앞 실행이 고친 선택자를 첫 후보로 둔다. 그 후보로 실패하면 버리고 패키지 후보로 바로 다시 돈다(0원).
//   1. 패키지 recovery 재시도(실행기가 이미 한다: effectiveOnFail.retry, 정책 stepMax 상한)
//   2. 패키지의 role·label 후보로 다시 찾기(css 건너뜀, 모델 없음, core/locate.ts refindWithoutCss)
//   3. AI 위치 찾기(게이트웨이 selector_repair, core/locate.ts locateTarget, 스텝당 모델 2번)
//   4. 체크포인트 재진입(이 스텝 앞 마지막 체크포인트, 실행당 체크포인트마다 1번. 첫 게이트 앞 스텝만)
//   5. AI 판정(run/judge.ts, 있으면): 예상 밖 화면을 모델이 보고 처방 하나(팝업 닫기·재로그인·체크포인트·칸 다시 찾기·브라우저 에이전트·사람)
//      click이 timeout·not_clickable이면(덮은 레이어가 흔하다) 판정을 먼저 부른다. 판정은 사슬 밖 스텝(검사·체크포인트 등)도 첫 게이트 앞이면 본다.
//   6. 사람(false를 돌려주면 조율기가 핸드오프한다)
// 쓰는 곳: fill·click·select·wait 중 비가역 스텝이 아니고 대상 항목이 commits·비밀 칸·비밀번호 칸이 아닌 것. 제출·서명·게이트·checkpoint는 타입에서 빠진다.
// 2·3단계가 찾은 선택자는 실행 사본 사전의 그 항목 첫 후보로 남는다(GuardedActuator R-A1 재확인도 같은 후보를 본다). 되읽기가 틀리면 빼고 다음 단계로 간다.
import { flatten } from './cfg.ts';
import { targetOf, type HealMemory } from './heal-memory.ts';
import { dropFirstCandidate, locatable, locateTarget, refindWithoutCss, type LocateEnv } from './locate.ts';
import type { PageReader } from './page.ts';
import type { PlaybookIR, SelectorDict, Step } from './types.ts';

const TYPES = new Set(['fill', 'click', 'select', 'wait']);
/** 대상을 다시 찾을 만한 실패. */
const TARGET_CODES = new Set(['step.selector_miss', 'step.identity_mismatch', 'step.timeout']);
/** 폴백 사슬을 탈 실패(그 밖의 코드는 같은 동작을 다시 해도 같은 결과라 바로 사람에게). */
const CHAIN_CODES = new Set([...TARGET_CODES, 'step.readback_mismatch']);
/**
 * 대상은 찾았는데 동작이 시간 안에 안 끝난 실패(누름·입력·선택의 step.timeout: 덮은 레이어·처리 중 표시·읽기 전용 등).
 * 다시 찾기·AI 위치 찾기는 같은 요소를 다시 낼 뿐이라(2026-11-13 실화면 예행: s13 [확인]에 패키지와 같은 선택자를 받고 실행 예산만 씀) 건너뛰고
 * 판정(덮은 것 닫기 등)·체크포인트로 간다. wait의 timeout은 대상을 못 찾은 것이라 그대로 다시 찾는다.
 */
const ACTIONABILITY = (s: Step, cause: string) => cause === 'step.timeout' && (s.type === 'click' || s.type === 'fill' || s.type === 'select');

/** 예상 밖 화면 판정(run/judge.ts PageJudge). */
export interface StuckJudge {
  eligible(s: Step, cause: string): boolean;
  onStuck(stepId: string, cause: string): Promise<{ from: string } | false>;
}

/** 기억한 에이전트 길 다시 걷기(run/browser-agent.ts BrowserAgent.replay, 0원). */
export interface StuckReplay {
  replayable(stepId: string): boolean;
  replay(stepId: string): Promise<string | null>;
}

/** 화면 보기(computer-use, run/browser-agent.ts BrowserAgent.vision): 판정·에이전트까지 안 되면 사람 앞 마지막 칸. */
export interface StuckVision {
  visionable(stepId: string): boolean;
  vision(stepId: string): Promise<string | null>;
}

/** 판정을 사슬보다 먼저 부를 실패(덮은 팝업 레이어가 누름을 막는 꼴). */
const JUDGE_FIRST = new Set(['step.timeout', 'step.not_clickable']);

export interface FallbackDeps {
  ir: PlaybookIR;
  /** 실행 사본 사전(runLocalDict). */
  dict: SelectorDict;
  page: PageReader;
  irreversible: ReadonlySet<string>;
  locate?: LocateEnv;
  judge?: StuckJudge;
  /** 화면 보기(가린 사진, 스텝마다 한 번). 판정·에이전트가 안 되면. */
  vision?: StuckVision;
  /** 기억한 에이전트 길(0원). 판정·위치 찾기보다 먼저, 스텝마다 한 번. */
  replay?: StuckReplay;
  /** 고친 선택자 기억. 있으면 폴백이 고친 후보가 스텝을 통과시킬 때 남긴다. */
  memory?: HealMemory;
  /** 실행 시작 때 기억으로 첫 후보를 둔 항목(HealMemory.seed 결과). */
  seeded?: Map<string, string>;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
}

interface StepState {
  refind: boolean;
  calls: { n: number };
  rejected: string[];
  /** 폴백이 사전에 넣은 맨 앞 후보(되읽기가 틀리면 뺀다). */
  added: string | null;
  /** added를 찾은 단계(refind·locate) */
  via: string | null;
  tried: string[];
  judgedFirst: boolean;
  replayed: boolean;
  vision: boolean;
  healDropped: boolean;
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
    return this.healEligible(s) || this.replayEligible(s) || this.visionEligible(s) || this.chainEligible(s, cause) || !!this.d.judge?.eligible(s, cause);
  }

  private replayEligible(s: Step): boolean {
    return !!this.d.replay && !this.state(s.id).replayed && this.d.replay.replayable(s.id);
  }

  /** 실행기 fastEscalate: 0원 칸(기억한 선택자 버리기·기억한 길 다시 걷기)이 있으면 재시도를 기다리지 않는다. */
  fastEscalate(s: Step, _cause: string): boolean {
    return this.healEligible(s) || this.replayEligible(s);
  }

  /** 기억으로 첫 후보를 둔 항목을 겨누는 되돌릴 수 있는 스텝(어떤 실패든 기억을 먼저 버려 본다). */
  private healEligible(s: Step): boolean {
    const key = targetOf(s);
    return key !== null && !!this.d.seeded?.has(key) && TYPES.has(s.type) && !this.d.irreversible.has(s.id);
  }

  /**
   * 실행기 step.finished(코드 없음): 이 스텝을 폴백이 고친 후보로 통과했으면 기억한다.
   * 같은 항목을 겨누는 뒤 스텝이 있어도 한 번 통과로 충분하다(같은 실행 사본 항목이다).
   */
  confirmed(stepId: string): void {
    const st = this.per.get(stepId);
    const s = this.info.get(stepId)?.step;
    if (!st || !s || !this.d.memory) return;
    if (!st.added) {
      // 기억한 후보를 버린 뒤 패키지 후보로 통과했다: 그 기억은 필요 없다.
      const k = targetOf(s);
      if (st.healDropped && k) this.d.memory.forget(k, 'package_ok');
      st.healDropped = false;
      return;
    }
    st.healDropped = false;
    const key = targetOf(s);
    const e = key ? this.d.dict.entries[key] : undefined;
    if (!key || !e) return;
    this.d.memory.remember(key, e, st.via ?? 'fallback');
    st.added = null;
  }

  private chainEligible(s: Step, cause: string): boolean {
    if (!TYPES.has(s.type) || this.d.irreversible.has(s.id) || !CHAIN_CODES.has(cause)) return false;
    const key = targetOf(s);
    if (key === null) return s.type === 'wait';
    return locatable(this.d.dict.entries[key], s.id, this.d.irreversible);
  }

  /** 조율기 recover 훅. 다시 돌 곳(그 스텝 또는 체크포인트)이나 false(사람). */
  async recover(stepId: string, cause: string): Promise<{ from: string } | false> {
    const s = this.info.get(stepId)?.step;
    if (!s) return false;
    const st = this.state(stepId);
    // 0단계: 기억한 후보로 실패했다. 버리고(다음 실행에도 안 쓴다) 패키지 후보로 그 스텝을 다시 돈다.
    const hk = targetOf(s);
    if (hk !== null && this.healEligible(s)) {
      const sel = this.d.seeded!.get(hk)!;
      this.d.seeded!.delete(hk);
      dropFirstCandidate(this.d.dict, hk);
      // 저장소에서는 아직 지우지 않는다(화면이 늦어 실패했을 수도 있다). 패키지 후보로 통과하면 그때 지우고, 폴백이 새로 고치면 덮어쓴다.
      st.healDropped = true;
      st.tried.push('heal');
      this.d.journal('fallback.heal_dropped', { stepId, key: hk, selector: sel, code: cause });
      return { from: stepId };
    }
    // 0.5단계: 같은 스텝을 앞 실행에서 에이전트가 넘겼던 길이 있으면 모델 없이 다시 걷는다(스텝마다 한 번).
    if (this.replayEligible(s)) {
      st.replayed = true;
      st.tried.push('replay');
      const resume = await this.d.replay!.replay(stepId);
      this.d.journal('fallback.replay', { stepId, ok: resume !== null, code: cause });
      if (resume) return { from: resume };
    }
    const judge = this.d.judge?.eligible(s, cause) ? this.d.judge : null;
    if (judge && s.type === 'click' && JUDGE_FIRST.has(cause) && !st.judgedFirst) {
      st.judgedFirst = true;
      st.tried.push('judge');
      const j = await judge.onStuck(stepId, cause);
      if (j) return j;
    }
    const r = this.chainEligible(s, cause) ? await this.chain(s, st, cause) : false;
    if (r) return r;
    if (judge) {
      st.tried.push('judge');
      const j = await judge.onStuck(stepId, cause);
      if (j) return j;
    }
    // 마지막 칸(사람 앞): 화면 보기. 스텝마다 한 번.
    if (this.visionEligible(s)) {
      st.vision = true;
      st.tried.push('vision');
      const resume = await this.d.vision!.vision(stepId);
      this.d.journal('fallback.vision', { stepId, ok: resume !== null, code: cause });
      if (resume) return { from: resume };
    }
    return false;
  }

  private visionEligible(s: Step): boolean {
    return !!this.d.vision && !this.state(s.id).vision && this.d.vision.visionable(s.id);
  }

  private async chain(s: Step, st: StepState, cause: string): Promise<{ from: string } | false> {
    const stepId = s.id;
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
      if (ACTIONABILITY(s, cause)) {
        this.d.journal('fallback.skip_locate', { stepId, key, code: cause });
      } else if (!st.refind) {
        st.refind = true;
        st.tried.push('refind');
        const r = await refindWithoutCss(this.d.page, this.d.dict, key, st.rejected);
        this.d.journal('fallback.refind', { stepId, key, found: !!r, ...(r ? { selector: r.selector } : {}) });
        if (r) {
          st.added = r.selector;
          st.via = 'refind';
          return { from: stepId };
        }
      }
      const purpose = s.type === 'wait' ? null : (s.type as 'fill' | 'click' | 'select');
      if (this.d.locate && purpose && st.calls.n < 2 && !ACTIONABILITY(s, cause)) {
        st.tried.push('locate');
        const r = await locateTarget({ page: this.d.page, dict: this.d.dict, loc: this.d.locate, stepId, key, purpose, rejected: st.rejected, calls: st.calls });
        if (r) {
          st.added = r.selector;
          st.via = 'locate';
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
    if (!st) this.per.set(stepId, (st = { refind: false, calls: { n: 0 }, rejected: [], added: null, via: null, tried: [], judgedFirst: false, replayed: false, vision: false, healDropped: false }));
    return st;
  }
}
