// 공급사 응답 → BundleAnswers. 위치가 아니라 질문 이름으로 조인한다(D04 §1).
// 응답은 비신뢰 입력이다(C-24): 이름이 빠지거나 남거나 겹치면, 타입·값이 로컬 번들과 다르면 결과는 unknown이다.
import type { Answer, BundleAnswers, UnknownReason } from './contract.ts';
import type { BundleDef } from './bundle/types.ts';

/** 공급사 중립 중간 표현. 어댑터가 자기 와이어 형식을 이것으로 바꾼다. */
export type RawAnswer =
  | { type: 'predicate'; probability: unknown }
  | { type: 'choice'; choice: unknown; confidence: unknown; probabilities: unknown }
  | { type: 'score'; score: unknown; confidence: unknown }
  | { type: 'refusal' };

export type NormalizeResult = { ok: true; answers: BundleAnswers; refusals: string[] } | { ok: false; reason: UnknownReason };

const prob = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1 ? x : null);

type Converted = { ok: true; answer: Answer } | { ok: false; reason: UnknownReason };

function convert(q: BundleDef['questions'][number], a: RawAnswer): Converted {
  if (a.type === 'refusal') return { ok: true, answer: { type: 'refusal' } };
  if (a.type !== q.type) return { ok: false, reason: 'answer_type_mismatch' };
  if (a.type === 'predicate') {
    const p = prob(a.probability);
    return p === null ? { ok: false, reason: 'answer_value_invalid' } : { ok: true, answer: { type: 'predicate', probability: p } };
  }
  if (a.type === 'choice' && q.type === 'choice') {
    const allowed = new Set(q.choices.map((c) => c.value));
    const conf = prob(a.confidence);
    if (typeof a.choice !== 'string' || !allowed.has(a.choice) || conf === null || !Array.isArray(a.probabilities)) return { ok: false, reason: 'answer_value_invalid' };
    const probabilities: Record<string, number> = {};
    for (const e of a.probabilities as Array<{ value?: unknown; probability?: unknown }>) {
      const p = prob(e?.probability);
      if (typeof e?.value !== 'string' || !allowed.has(e.value) || p === null || e.value in probabilities) return { ok: false, reason: 'answer_value_invalid' };
      probabilities[e.value] = p;
    }
    return { ok: true, answer: { type: 'choice', value: a.choice, confidence: conf, probabilities, fullDistribution: Object.keys(probabilities).length === allowed.size } };
  }
  if (a.type === 'score') {
    const conf = prob(a.confidence);
    if (typeof a.score !== 'number' || !Number.isFinite(a.score) || conf === null) return { ok: false, reason: 'answer_value_invalid' };
    return { ok: true, answer: { type: 'score', score: a.score, confidence: conf } };
  }
  return { ok: false, reason: 'answer_type_mismatch' };
}

function collect(entries: Array<[name: unknown, answer: RawAnswer]>): Map<string, RawAnswer> | null {
  const byName = new Map<string, RawAnswer>();
  for (const [name, a] of entries) {
    if (typeof name !== 'string' || byName.has(name)) return null;
    byName.set(name, a);
  }
  return byName;
}

/** 공급사 응답: 로컬 번들의 모든 질문에 정확히 한 번씩 답해야 한다. */
export function joinByName(def: BundleDef, entries: Array<[name: unknown, answer: RawAnswer]>, source: 'model' | 'l0' = 'model'): NormalizeResult {
  const byName = collect(entries);
  if (!byName || byName.size !== def.questions.length) return { ok: false, reason: 'answer_names_mismatch' };
  const answers: BundleAnswers = {};
  const refusals: string[] = [];
  for (const q of def.questions) {
    const a = byName.get(q.name);
    if (!a) return { ok: false, reason: 'answer_names_mismatch' };
    const c = convert(q, a);
    if (!c.ok) return c;
    if (c.answer.type === 'refusal') refusals.push(q.name);
    answers[q.name] = { ...c.answer, source };
  }
  return { ok: true, answers, refusals };
}

/** L0 규칙 어댑터: 답하지 않은(기권한) 질문은 빠져도 되지만 모르는 이름·refusal은 안 된다. */
export function joinPartial(def: BundleDef, entries: Array<[name: unknown, answer: RawAnswer]>): NormalizeResult {
  const byName = collect(entries);
  if (!byName) return { ok: false, reason: 'answer_names_mismatch' };
  const qs = new Map(def.questions.map((q) => [q.name, q]));
  const answers: BundleAnswers = {};
  for (const [name, a] of byName) {
    const q = qs.get(name);
    if (!q || a.type === 'refusal') return { ok: false, reason: 'answer_names_mismatch' };
    const c = convert(q, a);
    if (!c.ok) return c;
    answers[name] = { ...c.answer, source: 'l0' };
  }
  return { ok: true, answers, refusals: [] };
}
