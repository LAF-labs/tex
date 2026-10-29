// L1 판정 조율: L0 규칙 → (필요할 때만) 모델 → 로컬 매핑 → 인젝션 사전 필터 강등.
//
// L0 규칙 어댑터는 규칙 답을 가짜 Decisions 응답(answers[], probability/confidence 1.0·0.0)으로 내고,
// 공급사 응답과 같은 정규화(decisionsEntries → joinPartial)를 지난다. 그 위에 두 겹의 제한이 있다.
//  1) 승격: 규칙 정확도 ≥ 99.5%(라벨 실코퍼스, n ≥ 300)인 질문만 규칙 답을 쓴다. 나머지는 그림자 모드(기록만).
//  2) 단독 통과 금지: 비가역 직전·직후(pre_commit·post_commit), 안전(safety) 번들과 보안 질문은
//     그 답 하나만으로 진행 결과가 나올 수 없을 때(= 중단 쪽)만 규칙 답을 쓴다(ADR-015 결정 4).
// 모델 호출 생략: 쓸 수 있는 규칙 답이 번들의 모든 질문을 덮거나, 결과를 중단 쪽 하나로 확정할 때만.
// 진행 결과는 다른 질문(예: mentions_tax_advice)의 답이 뒤 단계에 필요하므로 규칙만으로 확정하지 않는다.
import {
  ZERO_USAGE,
  decisionsEntries,
  determinedOutcome,
  evaluateMapping,
  forcesNonProgress,
  joinPartial,
  progressOutcomes,
  resolveAnswer,
  statesOf,
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

  constructor(layer: DefaultModelLayer, promoted: Set<string>) {
    this.layer = layer;
    this.promoted = promoted;
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
    if (typeof def !== 'string' && Object.keys(usable).length) {
      const states = statesOf(def, usable);
      const fixed = Object.fromEntries(Object.keys(usable).map((k) => [k, states[k]!]));
      const all = b.def.questions.every((q) => q.name in usable);
      const decided = determinedOutcome(def, fixed);
      const prog = progressOutcomes(def);
      if (all || (decided !== null && !prog.has(decided))) {
        // 묻지 않은 질문은 상태에서 빼야 핵심 choice 미응답이 core_refusal로 오인되지 않는다.
        const m = evaluateMapping(def, fixed);
        const r: DecideResult = { outcome: m.outcome, confidence: m.confidence, raw: usable, usage: ZERO_USAGE, refusals: [], rule: m.rule, provider: 'rules', model: 'l0-rules', l0Only: true };
        return { ...downgrade(r, prog, injectionHit), shadow, injectionHit };
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
