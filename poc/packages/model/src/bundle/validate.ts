// 번들 정의 검증: 스키마 → 구조 → BV-01~06(D03 §3.2) + 선택지 ≤ 26(D04 §1, System One 호환).
// 엔진 로더와 번들 CI(tests/model-bundles.test.ts)가 같은 함수를 쓴다.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import type { ValidateFunction } from 'ajv';
import { computeDigest } from './digest.ts';
import { progressOutcomes, reachableOutcomes, regions, representativeStates, resolveAnswer } from './evaluate.ts';
import { predQuestion, rulePreds, wireIdOf, type BundleDef, type Pred, type RiskClass } from './types.ts';

export type BvRule = 'SCHEMA' | 'BV-00' | 'BV-01' | 'BV-02' | 'BV-03' | 'BV-04' | 'BV-05' | 'BV-06' | 'BV-C26';

export interface BvViolation {
  rule: BvRule;
  message: string;
}

/** D03 BV-03: 진행 결과로 가는 조건의 하한. routing은 D04 §2 "intent_route 0.80"(보드 질문 참조). */
export const PROGRESS_FLOOR: Record<RiskClass, number> = { pre_commit: 0.95, post_commit: 0.95, routing: 0.8, safety: 0.85, general: 0.85 };
/** D03 BV-03 "safety의 중단 결과 ≤ 0.80" 의 대상. D04 §2가 0.80으로 정한 blocked·security_warning만으로 해석한다. */
export const SAFETY_STOP_OUTCOMES = new Set(['blocked', 'security_warning']);
export const SAFETY_STOP_CEILING = 0.8;
/** D03 BV-02 "결과적으로 … assume_true" 목록. 인젝션 필터 predicate의 refusal은 "지시문 있음"이다. */
export const MUST_ASSUME_TRUE = new Set(['security_warning', 'asks_to_proceed_or_issue', 'page_text_addresses_agent', 'has_error_modal']);
/** D04 §1: System One 구현체 선택지 상한 */
export const MAX_CHOICES = 26;

let schemaValidator: ValidateFunction | null = null;
function schema(): ValidateFunction {
  if (schemaValidator) return schemaValidator;
  const s = JSON.parse(fs.readFileSync(new URL('../../schemas/bundle.schema.json', import.meta.url), 'utf8')) as object;
  const Ajv2020 = createRequire(import.meta.url)('ajv/dist/2020') as typeof import('ajv').default;
  schemaValidator = new Ajv2020({ allErrors: true, strict: false }).compile(s);
  return schemaValidator;
}

function structural(def: BundleDef, v: BvViolation[]): void {
  const bad = (message: string) => v.push({ rule: 'BV-00', message });
  const qs = new Map(def.questions.map((q) => [q.name, q]));
  if (qs.size !== def.questions.length) bad('질문 이름 중복');
  const kinds = new Map(def.outcomes.map((o) => [o.name, o.kind]));
  for (const r of def.mapping) if (!kinds.has(r.outcome)) bad(`매핑 결과 ${r.outcome}가 outcomes에 없음`);
  for (const r of def.reservedOutcomes) if (kinds.get(r) !== 'reserved') bad(`예약 결과 ${r}의 kind가 reserved가 아님`);
  for (const [n, k] of kinds) {
    if (k === 'reserved' && !def.reservedOutcomes.includes(n)) bad(`kind reserved인 ${n}가 reservedOutcomes에 없음`);
    if ((k === 'unknown') !== (n === 'unknown')) bad(`unknown kind는 결과 unknown에만`);
  }
  for (const [i, r] of def.mapping.entries()) {
    for (const p of rulePreds(r)) {
      const q = qs.get(predQuestion(p));
      if (!q) {
        bad(`행 ${i}: 없는 질문 ${predQuestion(p)}`);
        continue;
      }
      if ('predicate' in p && q.type !== 'predicate') bad(`행 ${i}: ${q.name}는 predicate가 아님`);
      if (!('predicate' in p)) {
        if (q.type !== 'choice') {
          bad(`행 ${i}: ${q.name}는 choice가 아님`);
          continue;
        }
        const values = new Set(q.choices.map((c) => c.value));
        const used = 'valueIn' in p ? p.valueIn : [p.value];
        for (const x of used) if (!values.has(x)) bad(`행 ${i}: ${q.name}에 없는 값 ${x}`);
      }
    }
  }
  for (const q of def.questions) if (q.type !== 'predicate' && q.onRefusal !== 'unknown') bad(`${q.name}: choice·score의 onRefusal은 unknown만(핵심 질문 refusal → 번들 unknown, D04 §2)`);
}

function bv01(def: BundleDef, v: BvViolation[]): void {
  const last = def.mapping.at(-1);
  if (!last || last.outcome !== 'unknown' || last.when !== 'always') v.push({ rule: 'BV-01', message: '마지막 행이 {unknown, always}가 아님' });
  def.mapping.slice(0, -1).forEach((r, i) => {
    if (r.when === 'always') v.push({ rule: 'BV-01', message: `행 ${i}: 마지막이 아닌 always(뒤 행이 도달 불가)` });
  });
}

/**
 * BV-02 거절 단조성: refusal을 onRefusal로 해석했을 때 도달하는 진행 결과는, 그 질문이 가장 보수적인 정상 값을 가질 때도
 * 도달 가능한 진행 결과(모든 정상 값에 대한 교집합)에 들어 있어야 한다. 즉 거절로 새 진행 경로가 열리면 안 된다.
 */
function bv02(def: BundleDef, v: BvViolation[]): void {
  const prog = progressOutcomes(def);
  for (const q of def.questions) {
    if (MUST_ASSUME_TRUE.has(q.name) && q.onRefusal !== 'assume_true') v.push({ rule: 'BV-02', message: `${q.name}: onRefusal은 assume_true여야 함` });
    const onlyProgress = (s: Set<string>) => new Set([...s].filter((o) => prog.has(o)));
    const viaRefusal = onlyProgress(reachableOutcomes(def, { [q.name]: resolveAnswer(q, { type: 'refusal' }) }));
    if (!viaRefusal.size) continue;
    let floor: Set<string> | undefined;
    for (const s of regions(def, q, representativeStates(def, q, false))) {
      const r = onlyProgress(reachableOutcomes(def, { [q.name]: s }));
      const prev: Set<string> | undefined = floor;
      floor = prev ? new Set([...prev].filter((o) => r.has(o))) : r;
    }
    const extra = [...viaRefusal].filter((o) => !floor || !floor.has(o));
    if (extra.length) v.push({ rule: 'BV-02', message: `${q.name}: refusal(${q.onRefusal})이 진행 결과 ${extra.join(',')}를 새로 연다` });
  }
}

function bv03(def: BundleDef, v: BvViolation[]): void {
  const kinds = new Map(def.outcomes.map((o) => [o.name, o.kind]));
  const floor = PROGRESS_FLOOR[def.riskClass];
  const lower = (p: Pred) => ('gte' in p ? p.gte : 'confidenceGte' in p ? p.confidenceGte : null);
  for (const [i, r] of def.mapping.entries()) {
    if (kinds.get(r.outcome) === 'progress') {
      for (const p of rulePreds(r)) {
        const lo = lower(p);
        if (lo !== null && lo < floor) v.push({ rule: 'BV-03', message: `행 ${i}(${r.outcome}): ${predQuestion(p)} 하한 ${lo} < ${floor}` });
        if ('lte' in p && p.lte > 1 - floor + 1e-9) v.push({ rule: 'BV-03', message: `행 ${i}(${r.outcome}): ${p.predicate} lte ${p.lte} > ${(1 - floor).toFixed(2)}` });
      }
    }
    if (def.riskClass === 'safety' && SAFETY_STOP_OUTCOMES.has(r.outcome)) {
      for (const p of rulePreds(r)) {
        const lo = lower(p);
        if (lo !== null && lo > SAFETY_STOP_CEILING) v.push({ rule: 'BV-03', message: `행 ${i}(${r.outcome}): 안전 중단 임계값 ${lo} > ${SAFETY_STOP_CEILING}` });
      }
    }
  }
}

function bv04c26(def: BundleDef, v: BvViolation[]): void {
  for (const q of def.questions) {
    if (q.type !== 'choice') continue;
    if (!q.choices.some((c) => c.value === 'unknown' || c.value === 'none_of_these')) v.push({ rule: 'BV-04', message: `${q.name}: unknown/none_of_these 없음` });
    if (q.choices.length > MAX_CHOICES) v.push({ rule: 'BV-C26', message: `${q.name}: 선택지 ${q.choices.length} > ${MAX_CHOICES}` });
  }
}

function bv05(def: BundleDef, v: BvViolation[]): void {
  const kinds = new Map(def.outcomes.map((o) => [o.name, o.kind]));
  const firstProgress = def.mapping.findIndex((r) => kinds.get(r.outcome) === 'progress');
  if (firstProgress < 0) return;
  def.mapping.forEach((r, i) => {
    if (def.reservedOutcomes.includes(r.outcome) && i > firstProgress) v.push({ rule: 'BV-05', message: `예약 결과 ${r.outcome}(행 ${i})가 진행 행 ${firstProgress} 뒤에 있음` });
  });
}

/**
 * BV-06: 다이제스트가 정의·접두와 일치하고 앱 내장 허용 목록에 있어야 한다. 허용 목록 밖 정의(레지스트리·파일 주입)는 로드하지 않는다.
 */
function bv06(def: BundleDef, prefixText: string, allow: ReadonlyArray<{ id: string; digest: string }> | null, v: BvViolation[]): void {
  const d = computeDigest(def, prefixText);
  if (d !== def.digest) v.push({ rule: 'BV-06', message: `digest 불일치(계산 ${d.slice(0, 12)}…)` });
  if (allow && !allow.some((a) => a.id === wireIdOf(def) && a.digest === def.digest)) v.push({ rule: 'BV-06', message: `${wireIdOf(def)}@${def.digest.slice(0, 12)}…가 앱 내장 허용 목록에 없음` });
}

export function validateBundle(def: BundleDef, prefixText: string, allow: ReadonlyArray<{ id: string; digest: string }> | null): BvViolation[] {
  const v: BvViolation[] = [];
  const s = schema();
  if (!s(def)) {
    for (const e of s.errors ?? []) v.push({ rule: 'SCHEMA', message: `${e.instancePath} ${e.message ?? ''}` });
    return v;
  }
  structural(def, v);
  if (v.length) return v;
  bv01(def, v);
  bv02(def, v);
  bv03(def, v);
  bv04c26(def, v);
  bv05(def, v);
  bv06(def, prefixText, allow, v);
  return v;
}
