// bundle.schema.json(design/schemas, 사본은 packages/model/schemas)의 TS 표현.

export type RiskClass = 'pre_commit' | 'post_commit' | 'safety' | 'routing' | 'general';
export type OutcomeKind = 'progress' | 'conservative' | 'reserved' | 'unknown';
export type OnRefusal = 'assume_true' | 'assume_false' | 'unknown';

export interface Choice {
  value: string;
  description: string;
}

export type Question =
  | { type: 'predicate'; name: string; instructions: string; onRefusal: OnRefusal }
  | { type: 'choice'; name: string; instructions: string; onRefusal: OnRefusal; choices: Choice[] }
  | { type: 'score'; name: string; instructions: string; onRefusal: OnRefusal; levels: Array<{ label: string; description: string }> };

export type Pred =
  | { predicate: string; gte: number }
  | { predicate: string; lte: number }
  | { choice: string; value: string; confidenceGte: number }
  | { choice: string; valueIn: string[]; confidenceGte: number }
  | { choiceProbability: string; value: string; gte: number };

export type When = 'always' | { all: Pred[] } | { any: Pred[] };

export interface Rule {
  outcome: string;
  when: When;
}

export interface BundleDef {
  id: string;
  version: number;
  digest: string;
  riskClass: RiskClass;
  outcomes: Array<{ name: string; kind: OutcomeKind }>;
  needsAmounts?: boolean;
  maxInputBytes: number;
  prefix?: { stringsKey: string; minTokens: number };
  questions: Question[];
  mapping: Rule[];
  reservedOutcomes: string[];
}

/** 로드된 번들: 정의 + 조립된 고정 접두 + 와이어 ID. */
export interface LoadedBundle {
  def: BundleDef;
  /** `${id}_v${version}` — gateway-request.schema.json의 bundleId 형식 */
  wireId: string;
  digest: string;
  prefixText: string;
}

export const wireIdOf = (def: Pick<BundleDef, 'id' | 'version'>) => `${def.id}_v${def.version}`;

export function predQuestion(p: Pred): string {
  return 'predicate' in p ? p.predicate : 'choice' in p ? p.choice : p.choiceProbability;
}

export function predThreshold(p: Pred): number {
  return 'gte' in p ? p.gte : 'lte' in p ? p.lte : p.confidenceGte;
}

export function rulePreds(r: Rule): Pred[] {
  return r.when === 'always' ? [] : 'all' in r.when ? r.when.all : r.when.any;
}
