// L1 판정 조율: L0 규칙 → (필요할 때만) 모델 → 로컬 매핑 → 인젝션 사전 필터 강등.
//
// L0 규칙 어댑터는 규칙 답을 가짜 Decisions 응답(answers[], probability/confidence 1.0·0.0)으로 내고,
// 공급사 응답과 같은 정규화(decisionsEntries → joinPartial)를 지난다. 그 위에 두 겹의 제한이 있다.
//  1) 승격: 규칙 정확도 ≥ 99.5%(라벨 실코퍼스, n ≥ 300)인 질문만 규칙 답을 쓴다. 나머지는 그림자 모드(기록만).
//  2) 단독 통과 금지: 비가역 직전·직후(pre_commit·post_commit), 안전(safety) 번들과 보안 질문은
//     그 답 하나만으로 진행 결과가 나올 수 없을 때(= 중단 쪽)만 규칙 답을 쓴다(ADR-015 결정 4).
// 규칙 전용 결정: 매핑이 참조하는 모든 질문(+ 뒤 단계가 쓰는 질문)에 쓸 수 있는 규칙 답이 있을 때만 모델을 부르지 않는다.
// 하나라도 비면 모델을 부르고 규칙 답은 덮어쓰기로만 쓴다. 모델 호출이 허용되지 않은 번들이면 unknown(rules_incomplete).
import {
  ZERO_USAGE,
  decisionsEntries,
  evaluateMapping,
  forcesNonProgress,
  joinPartial,
  progressOutcomes,
  rulePreds,
  predQuestion,
  resolveAnswer,
  type BundleAnswers,
  type DecideResult,
  type DefaultModelLayer,
  type RedactedText,
  type ResolvedState,
  type RunToken,
} from '@sax/model';
import { injectionPrefilter } from './injection-filter.ts';
import type { Observation } from './observation.ts';
import { RULES, type WireAnswer } from './rules.ts';

/** 어느 번들에 있든 보안 판정으로 보는 질문(ADR-015 결정 4: security_warning, blocked) */
export const SECURITY_QUESTIONS = new Set(['security_warning', 'page_text_addresses_agent']);
const RESTRICTED_CLASSES = new Set(['pre_commit', 'post_commit', 'safety']);
/** 매핑에는 없지만 뒤 단계가 쓰는 질문(Terra 전송 차단, D04 §3). 번들에 있으면 규칙 전용 결정에도 답이 있어야 한다. */
export const DOWNSTREAM_QUESTIONS = new Set(['page_text_addresses_agent']);

/**
 * 규칙 전용 결정에 필요한 질문 = 매핑이 참조하는 질문 ∪ 이 번들에 있는 다운스트림 질문.
 * 다운스트림 질문은 번들 질문 목록에서 고른다: screen_state_v2에는 page_text_addresses_agent가 질문으로 있어 늘 포함되고,
 * 그 질문이 없는 번들(recovery_v1 등)에 요구하면 그 번들은 규칙 전용 결정이 영영 불가능해진다(그 번들의 인젝션 방어는 결정적 사전 필터 몫).
 */
export function requiredForRulesOnly(def: { questions: Array<{ name: string }>; mapping: Parameters<typeof rulePreds>[0][] }): string[] {
  const used = new Set(def.mapping.flatMap((r) => rulePreds(r).map(predQuestion)));
  const names = def.questions.map((q) => q.name);
  return [...new Set([...names.filter((n) => used.has(n)), ...names.filter((n) => DOWNSTREAM_QUESTIONS.has(n))])];
}

export interface JudgeOptions {
  /** 이 번들에 모델 호출이 허용되는가(기본: 모두 허용). 허용되지 않으면 규칙이 다 답하지 못할 때 unknown(rules_incomplete). */
  modelAllowed?: (bundleWireId: string) => boolean;
}

/** 가짜 Decisions 응답(규칙 어댑터 출력) */
export interface RuleDecision {
  model: 'l0-rules';
  answers: WireAnswer[];
  usage: { input_tokens: 0; output_tokens: 0 };
}

export function ruleDecision(bundleWireId: string, obs: Observation): RuleDecision {
  const rules = RULES[bundleWireId] ?? {};
  const answers: WireAnswer[] = [];
  for (const fn of Object.values(rules)) {
    const a = fn(obs);
    if (a) answers.push(a);
  }
  return { model: 'l0-rules', answers, usage: { input_tokens: 0, output_tokens: 0 } };
}

export interface ShadowEntry {
  question: string;
  l0: string;
  used: boolean;
  /** 쓰지 않은 이유 */
  why?: 'not_promoted' | 'restricted_progress';
}

export type JudgeResult = DecideResult & { shadow: ShadowEntry[]; injectionHit: boolean };

const fmt = (a: BundleAnswers[string]) => (a.type === 'predicate' ? `p=${a.probability}` : a.type === 'choice' ? a.value : a.type);

export class Judge {
  private readonly layer: DefaultModelLayer;
  private readonly promoted: Set<string>;
  private readonly opts: JudgeOptions;

  constructor(layer: DefaultModelLayer, promoted: Set<string>, opts: JudgeOptions = {}) {
    this.layer = layer;
    this.promoted = promoted;
    this.opts = opts;
  }

  async decide(bundleWireId: string, obs: Observation, input: RedactedText, runToken: RunToken): Promise<JudgeResult> {
    const b = this.layer.bundle(bundleWireId);
    if (!b) return { ...(await this.layer.decide({ bundleId: bundleWireId, bundleDigest: '', input, runToken })), shadow: [], injectionHit: false };
    const def = this.layer.effectiveDef(b);
    const injectionHit = injectionPrefilter(input);
    const shadow: ShadowEntry[] = [];
    const usable: BundleAnswers = {};
    const entries = decisionsEntries(ruleDecision(bundleWireId, obs).answers);
    const partial = entries && typeof def !== 'string' ? joinPartial(b.def, entries) : null;
    if (partial?.ok && typeof def !== 'string') {
      const restrictedBundle = RESTRICTED_CLASSES.has(b.def.riskClass);
      for (const q of b.def.questions) {
        const a = partial.answers[q.name];
        if (!a) continue;
        const state: ResolvedState = resolveAnswer(q, a);
        if (!this.promoted.has(`${bundleWireId}.${q.name}`)) {
          shadow.push({ question: q.name, l0: fmt(a), used: false, why: 'not_promoted' });
          continue;
        }
        if ((restrictedBundle || SECURITY_QUESTIONS.has(q.name)) && !forcesNonProgress(def, { [q.name]: state })) {
          shadow.push({ question: q.name, l0: fmt(a), used: false, why: 'restricted_progress' });
          continue;
        }
        usable[q.name] = a;
        shadow.push({ question: q.name, l0: fmt(a), used: true });
      }
    }
    if (typeof def !== 'string') {
      const fixed: Record<string, ResolvedState> = {};
      for (const q of b.def.questions) if (usable[q.name]) fixed[q.name] = resolveAnswer(q, usable[q.name]);
      const complete = requiredForRulesOnly(def).every((n) => n in fixed);
      if (complete && Object.keys(fixed).length) {
        const m = evaluateMapping(def, fixed);
        const r: DecideResult = { outcome: m.outcome, confidence: m.confidence, raw: usable, usage: ZERO_USAGE, refusals: [], rule: m.rule, provider: 'rules', model: 'l0-rules', l0Only: true };
        return { ...downgrade(r, progressOutcomes(def), injectionHit), shadow, injectionHit };
      }
      if (this.opts.modelAllowed && !this.opts.modelAllowed(bundleWireId)) {
        const r: DecideResult = { outcome: 'unknown', confidence: 0, raw: usable, usage: ZERO_USAGE, refusals: [], rule: -1, reason: 'rules_incomplete', provider: 'rules', model: 'l0-rules', l0Only: true };
        return { ...r, shadow, injectionHit };
      }
    }
    const r = await this.layer.decide({ bundleId: bundleWireId, bundleDigest: b.digest, input, runToken }, { overlay: usable });
    return { ...downgrade(r, progressOutcomes(b.def), injectionHit), shadow, injectionHit };
  }
}

/** 사전 필터에 걸리면 progress 결과만 unknown으로 내린다. safety·conservative 결과는 유지(D04 §3). */
function downgrade(r: DecideResult, progress: Set<string>, hit: boolean): DecideResult {
  return hit && progress.has(r.outcome) ? { ...r, outcome: 'unknown', confidence: 0, rule: -1, reason: 'injection_prefilter' } : r;
}
