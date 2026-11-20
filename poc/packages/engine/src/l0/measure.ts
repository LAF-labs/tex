import type { Observation } from './observation.ts';
import type { L0Measurement } from './promotion.ts';
import { RULES } from './rules.ts';

export interface LabeledSample {
  id: string;
  bundle: string;
  obs: Observation;
  labels: Record<string, boolean | string>;
}

export interface L0Tally extends L0Measurement {
  abstained: number;
  errors: string[];
}

export function measureL0(samples: LabeledSample[], corpus: { id: string; kind: 'synthetic' | 'labeled_real' }, now = new Date().toISOString()): L0Tally[] {
  const tallies = new Map<string, L0Tally>();
  for (const s of samples) {
    for (const [q, label] of Object.entries(s.labels)) {
      const key = `${s.bundle}.${q}`;
      let t = tallies.get(key);
      if (!t) tallies.set(key, (t = { bundle: s.bundle, question: q, corpus: { ...corpus, n: 0 }, answered: 0, correct: 0, abstained: 0, errors: [], measuredAt: now }));
      t.corpus.n++;
      const a = RULES[s.bundle]?.[q]?.(s.obs) ?? null;
      if (!a) {
        t.abstained++;
        continue;
      }
      t.answered++;
      const got = a.type === 'predicate' ? a.probability >= 0.5 : a.choice;
      if (got === label) t.correct++;
      else if (t.errors.length < 5) t.errors.push(`${s.id}: ${String(got)} ≠ ${String(label)}`);
    }
  }
  return [...tallies.values()];
}
