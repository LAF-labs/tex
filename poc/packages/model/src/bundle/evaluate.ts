// 결과 매핑(첫 일치 승리)과 도달 가능 결과 계산. 결과·임계값은 언제나 로컬 번들 정의로 계산한다(D04 §5, C-24).
import type { Answer } from '../contract.ts';
import { predQuestion, type BundleDef, type Pred, type Question, type Rule } from './types.ts';

/** onRefusal을 적용한 뒤의 질문 상태. 'unknown'은 그 질문을 쓰는 조건이 모두 거짓이 된다. */
export type ResolvedState =
  | { t: 'p'; p: number }
  | { t: 'c'; value: string; confidence: number; probs: Record<string, number> }
  | { t: 's'; score: number; confidence: number }
  | { t: 'unknown' };

export function resolveAnswer(q: Question, a: Answer | undefined): ResolvedState {
  if (!a) return { t: 'unknown' };
  if (a.type === 'refusal') {
    if (q.type === 'predicate' && q.onRefusal === 'assume_true') return { t: 'p', p: 1 };
    if (q.type === 'predicate' && q.onRefusal === 'assume_false') return { t: 'p', p: 0 };
    return { t: 'unknown' };
  }
  if (a.type === 'predicate') return { t: 'p', p: a.probability };
  if (a.type === 'choice') return { t: 'c', value: a.value, confidence: a.confidence, probs: a.probabilities };
  return { t: 's', score: a.score, confidence: a.confidence };
}

/** D04 §2: choice 라벨 확률은 probabilities[]에 있으면 그 값, 없으면 argmax == label일 때 confidence. */
export function choiceProbability(s: Extract<ResolvedState, { t: 'c' }>, label: string): number {
  const p = s.probs[label];
  if (p !== undefined) return p;
  return s.value === label ? s.confidence : 0;
}

export function evalPred(p: Pred, s: ResolvedState): boolean {
  if (s.t === 'unknown') return false;
  if ('predicate' in p) {
    if (s.t !== 'p') return false;
    return 'gte' in p ? s.p >= p.gte : s.p <= p.lte;
  }
  if (s.t !== 'c') return false;
  if ('choiceProbability' in p) return choiceProbability(s, p.value) >= p.gte;
  const hit = 'value' in p ? s.value === p.value : p.valueIn.includes(s.value);
  return hit && s.confidence >= p.confidenceGte;
}

function predConfidence(p: Pred, s: ResolvedState): number {
  if (s.t === 'p') return 'lte' in p ? 1 - s.p : s.p;
  if (s.t === 'c') return 'choiceProbability' in p ? choiceProbability(s, p.value) : s.confidence;
  return 0;
}

export interface MappingResult {
  outcome: string;
  rule: number;
  confidence: number;
  /** 핵심 choice 질문이 refusal(→ unknown)이라 번들 전체를 unknown으로 내렸다(D04 §2). */
  coreRefusal: boolean;
}

const coreCache = new WeakMap<BundleDef, Set<string>>();

/**
 * 핵심 질문(D04 §2 "분류 choice") = 매핑이 참조하는 choice 질문. 번들 스키마에 core 표시가 없어 로더가 이렇게 정한다(보드 질문).
 * 핵심 질문의 refusal(→ unknown)만 번들 전체를 unknown으로 내리고, 그 밖의 질문은 그 질문만 unknown(조건 거짓)이다.
 */
export function coreQuestions(def: BundleDef): Set<string> {
  let c = coreCache.get(def);
  if (!c) {
    const used = new Set(def.mapping.flatMap((r) => (r.when === 'always' ? [] : 'all' in r.when ? r.when.all : r.when.any).map(predQuestion)));
    c = new Set(def.questions.filter((q) => q.type === 'choice' && used.has(q.name)).map((q) => q.name));
    coreCache.set(def, c);
  }
  return c;
}

export function evaluateMapping(def: BundleDef, states: Record<string, ResolvedState>): MappingResult {
  for (const q of coreQuestions(def)) {
    if (states[q]?.t === 'unknown') return { outcome: 'unknown', rule: -1, confidence: 0, coreRefusal: true };
  }
  for (const [i, r] of def.mapping.entries()) {
    const c = ruleConfidence(r, states);
    if (c !== null) return { outcome: r.outcome, rule: i, confidence: c, coreRefusal: false };
  }
  return { outcome: 'unknown', rule: -1, confidence: 0, coreRefusal: false };
}

function ruleConfidence(r: Rule, states: Record<string, ResolvedState>): number | null {
  if (r.when === 'always') return r.outcome === 'unknown' ? 0 : 1;
  const st = (p: Pred) => states[predQuestion(p)] ?? { t: 'unknown' as const };
  if ('all' in r.when) {
    if (!r.when.all.every((p) => evalPred(p, st(p)))) return null;
    return Math.min(...r.when.all.map((p) => predConfidence(p, st(p))));
  }
  const hits = r.when.any.filter((p) => evalPred(p, st(p)));
  return hits.length ? Math.max(...hits.map((p) => predConfidence(p, st(p)))) : null;
}

// ── 도달 가능 결과(BV-02, L0 단독 결정 가부) ──────────────────────────────
// 질문마다 매핑 조건의 임계값 경계로 대표 상태를 만들고, 조건 진리값 벡터가 같은 상태는 하나로 합친다.
// 그 위에서 질문 간 곱집합을 돌면 모든 답 조합에 대한 결과 집합을 정확히 얻는다(조건이 질문별 구간 조건뿐이므로).

const EPS = 1e-6;
const clamp = (x: number) => Math.min(1, Math.max(0, x));

function thresholdPoints(def: BundleDef, q: string, pick: (p: Pred) => number | null): number[] {
  const pts = new Set([0, 1]);
  for (const r of def.mapping) {
    if (r.when === 'always') continue;
    for (const p of 'all' in r.when ? r.when.all : r.when.any) {
      if (predQuestion(p) !== q) continue;
      const t = pick(p);
      if (t === null) continue;
      for (const x of [t - EPS, t, t + EPS]) pts.add(clamp(x));
    }
  }
  return [...pts].sort((a, b) => a - b);
}

/** 질문 q가 가질 수 있는 대표 상태(정상 답 + refusal 해석). */
export function representativeStates(def: BundleDef, q: Question, includeRefusal = true): ResolvedState[] {
  const out: ResolvedState[] = [];
  if (q.type === 'predicate') {
    for (const p of thresholdPoints(def, q.name, (x) => ('gte' in x ? x.gte : 'lte' in x ? x.lte : null))) out.push({ t: 'p', p });
  } else if (q.type === 'choice') {
    const confs = thresholdPoints(def, q.name, (x) => ('confidenceGte' in x ? x.confidenceGte : null));
    const labels = new Set<string>();
    for (const r of def.mapping) for (const p of r.when === 'always' ? [] : 'all' in r.when ? r.when.all : r.when.any) if ('choiceProbability' in p && p.choiceProbability === q.name) labels.add(p.value);
    const probPts = thresholdPoints(def, q.name, (x) => ('choiceProbability' in x ? x.gte : null));
    for (const c of q.choices) {
      for (const conf of confs) {
        // argmax의 확률이 가장 크므로 다른 라벨 확률은 min(conf, 1 − conf) 이하
        const combos: Array<Record<string, number>> = [{}];
        for (const l of labels) {
          if (l === c.value) continue;
          const next: Array<Record<string, number>> = [];
          for (const base of combos) for (const pp of probPts) if (pp <= Math.min(conf, 1 - conf) + EPS) next.push({ ...base, [l]: pp });
          combos.splice(0, combos.length, ...next);
        }
        for (const probs of combos) out.push({ t: 'c', value: c.value, confidence: conf, probs: { ...probs, [c.value]: conf } });
      }
    }
  } else {
    out.push({ t: 's', score: 0, confidence: 0 }, { t: 's', score: q.levels.length - 1, confidence: 1 });
  }
  if (includeRefusal) out.push(resolveAnswer(q, { type: 'refusal' }));
  return out;
}

function atomsOf(def: BundleDef, q: string): Pred[] {
  const atoms: Pred[] = [];
  for (const r of def.mapping) if (r.when !== 'always') for (const p of 'all' in r.when ? r.when.all : r.when.any) if (predQuestion(p) === q) atoms.push(p);
  return atoms;
}

/** 조건 진리값 벡터로 중복을 없앤 상태 목록. */
export function regions(def: BundleDef, q: Question, states: ResolvedState[]): ResolvedState[] {
  const atoms = atomsOf(def, q.name);
  const seen = new Map<string, ResolvedState>();
  for (const s of states) {
    const key = (coreQuestions(def).has(q.name) && s.t === 'unknown' ? 'U' : 'K') + atoms.map((a) => (evalPred(a, s) ? '1' : '0')).join('');
    if (!seen.has(key)) seen.set(key, s);
  }
  return [...seen.values()];
}

/** fixed에 없는 질문은 모든 상태(정상 답 + refusal 해석)를 돈다. */
export function reachableOutcomes(def: BundleDef, fixed: Record<string, ResolvedState> = {}): Set<string> {
  const dims = def.questions.map((q) => (q.name in fixed ? [fixed[q.name]!] : regions(def, q, representativeStates(def, q))));
  const out = new Set<string>();
  const cur: Record<string, ResolvedState> = {};
  const walk = (i: number) => {
    if (i === dims.length) {
      out.add(evaluateMapping(def, cur).outcome);
      return;
    }
    for (const s of dims[i]!) {
      cur[def.questions[i]!.name] = s;
      walk(i + 1);
    }
  };
  walk(0);
  return out;
}

export function progressOutcomes(def: BundleDef): Set<string> {
  return new Set(def.outcomes.filter((o) => o.kind === 'progress').map((o) => o.name));
}

/** 이 답(들)만으로 진행 결과가 나올 수 없는가(L0 중단 쪽 단독 결정 판정). */
export function forcesNonProgress(def: BundleDef, fixed: Record<string, ResolvedState>): boolean {
  const prog = progressOutcomes(def);
  for (const o of reachableOutcomes(def, fixed)) if (prog.has(o)) return false;
  return true;
}
