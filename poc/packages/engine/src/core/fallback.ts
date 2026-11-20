import { flatten } from './cfg.ts';
import { targetOf, type HealMemory } from './heal-memory.ts';
import { dropFirstCandidate, locatable, locateTarget, refindWithoutCss, type LocateEnv } from './locate.ts';
import type { PageReader } from './page.ts';
import type { PlaybookIR, SelectorDict, Step } from './types.ts';

const TYPES = new Set(['fill', 'click', 'select', 'wait']);
const TARGET_CODES = new Set(['step.selector_miss', 'step.identity_mismatch', 'step.timeout']);
const CHAIN_CODES = new Set([...TARGET_CODES, 'step.readback_mismatch']);
const ACTIONABILITY = (s: Step, cause: string) => cause === 'step.timeout' && (s.type === 'click' || s.type === 'fill' || s.type === 'select');

/** 예상 밖 화면 판정(run/judge.ts PageJudge). */
export interface StuckJudge {
  eligible(s: Step, cause: string): boolean;
  onStuck(stepId: string, cause: string, o?: { locateTried: boolean }): Promise<{ from: string } | false>;
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

const JUDGE_FIRST = new Set(['step.timeout', 'step.not_clickable']);

export interface FallbackDeps {
  ir: PlaybookIR;
  dict: SelectorDict;
  page: PageReader;
  irreversible: ReadonlySet<string>;
  locate?: LocateEnv;
  judge?: StuckJudge;
  vision?: StuckVision;
  replay?: StuckReplay;
  memory?: HealMemory;
  seeded?: Map<string, string>;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
}

interface StepState {
  refind: boolean;
  calls: { n: number };
  rejected: string[];
  added: string | null;
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
  private readonly passed = new Set<string>();

  constructor(d: FallbackDeps) {
    this.d = d;
    this.info = flatten(d.ir.steps).info;
    this.firstGate = Math.min(...[...this.info.values()].filter((v) => v.step.type === 'gate').map((v) => v.order), Number.POSITIVE_INFINITY);
  }

  eligible(s: Step, cause: string): boolean {
    return this.healEligible(s) || this.replayEligible(s) || this.visionEligible(s) || this.chainEligible(s, cause) || !!this.d.judge?.eligible(s, cause);
  }

  private replayEligible(s: Step): boolean {
    return !!this.d.replay && !this.state(s.id).replayed && this.d.replay.replayable(s.id);
  }

  fastEscalate(s: Step, cause: string, attempt = 0): boolean {
    return this.healEligible(s) || this.replayEligible(s) || (cause === 'step.selector_miss' && attempt >= 1 && this.chainEligible(s, cause));
  }

  private healEligible(s: Step): boolean {
    const key = targetOf(s);
    return key !== null && !!this.d.seeded?.has(key) && TYPES.has(s.type) && !this.d.irreversible.has(s.id);
  }

  confirmed(stepId: string): void {
    const st = this.per.get(stepId);
    const s = this.info.get(stepId)?.step;
    if (s?.type === 'checkpoint') this.passed.add(stepId);
    if (!st || !s || !this.d.memory) return;
    if (!st.added) {
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

  async recover(stepId: string, cause: string): Promise<{ from: string } | false> {
    const s = this.info.get(stepId)?.step;
    if (!s) return false;
    const st = this.state(stepId);
    const hk = targetOf(s);
    if (hk !== null && this.healEligible(s)) {
      const sel = this.d.seeded!.get(hk)!;
      this.d.seeded!.delete(hk);
      dropFirstCandidate(this.d.dict, hk);
      st.healDropped = true;
      st.tried.push('heal');
      this.d.journal('fallback.heal_dropped', { stepId, key: hk, selector: sel, code: cause });
      return { from: stepId };
    }
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
      const j = await judge.onStuck(stepId, cause, { locateTried: st.calls.n > 0 });
      if (j) return j;
    }
    const r = this.chainEligible(s, cause) ? await this.chain(s, st, cause) : false;
    if (r) return r;
    if (judge) {
      st.tried.push('judge');
      const j = await judge.onStuck(stepId, cause, { locateTried: st.calls.n > 0 });
      if (j) return j;
    }
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

  tried(stepId: string): string {
    return ['retry', ...(this.per.get(stepId)?.tried ?? [])].join(':');
  }

  private checkpointBefore(stepId: string): string | null {
    const me = this.info.get(stepId);
    if (!me || me.order >= this.firstGate || me.repeats.length) return null;
    let best: { id: string; order: number } | null = null;
    for (const [id, v] of this.info) if (v.step.type === 'checkpoint' && this.passed.has(id) && !v.repeats.length && v.order < me.order && (!best || v.order > best.order)) best = { id, order: v.order };
    return best?.id ?? null;
  }

  private state(stepId: string): StepState {
    let st = this.per.get(stepId);
    if (!st) this.per.set(stepId, (st = { refind: false, calls: { n: 0 }, rejected: [], added: null, via: null, tried: [], judgedFirst: false, replayed: false, vision: false, healDropped: false }));
    return st;
  }
}
