import fs from 'node:fs';

export const PROMOTION_MIN_ACCURACY = 0.995;
export const PROMOTION_MIN_N = 300;

export interface L0Measurement {
  bundle: string;
  question: string;
  corpus: { id: string; kind: 'synthetic' | 'labeled_real'; n: number };
  answered: number;
  correct: number;
  measuredAt: string;
}

export function accuracy(m: L0Measurement): number {
  return m.answered ? m.correct / m.answered : 0;
}

export function qualifies(m: L0Measurement): boolean {
  return m.corpus.kind === 'labeled_real' && m.answered >= PROMOTION_MIN_N && accuracy(m) >= PROMOTION_MIN_ACCURACY;
}

/** `${bundle}.${question}` 집합. 측정 파일에 있어도 기준을 넘지 못하면 들어가지 않는다. */
export function promotedSet(ms: L0Measurement[]): Set<string> {
  return new Set(ms.filter(qualifies).map((m) => `${m.bundle}.${m.question}`));
}

export function loadPromotions(file: URL = new URL('../../l0-promotions.json', import.meta.url)): Set<string> {
  return promotedSet(JSON.parse(fs.readFileSync(file, 'utf8')) as L0Measurement[]);
}
