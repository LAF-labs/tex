import type { RedactedText, RunToken } from '../contract.ts';
import type { LoadedBundle } from '../bundle/types.ts';
import { joinByName, type NormalizeResult, type RawAnswer } from '../normalize.ts';
import { AdapterError, type AdapterLimits, type DecideAdapter, type ProviderDecision } from './types.ts';

export const SOLAR_DECIDE = 'solar-decide';

type SystemOneQuestion =
  | { type: 'noul'; instructions: string }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface SystemOneRequest {
  model: string;
  state: string;
  questions: Record<string, SystemOneQuestion>;
}

export class UpstageSystemOneAdapter implements DecideAdapter {
  readonly provider: 'upstage' | 'openai_compat' = 'upstage';
  readonly model: string = SOLAR_DECIDE;
  readonly limits: AdapterLimits = { maxChoices: 26, maxQuestions: 64, refusals: false, maxRequestBytes: 256_000 };

  buildRequest(b: LoadedBundle, input: RedactedText): SystemOneRequest {
    const questions: Record<string, SystemOneQuestion> = {};
    for (const q of b.def.questions) {
      if (q.type === 'predicate') questions[q.name] = { type: 'noul', instructions: q.instructions };
      else if (q.type === 'choice') questions[q.name] = { type: 'choice', instructions: q.instructions, criteria: Object.fromEntries(q.choices.map((c) => [c.value, c.description])) };
      else questions[q.name] = { type: 'score', instructions: q.instructions, criteria: q.levels.map((l) => l.label) };
    }
    return { model: this.model, state: `${b.prefixText}\n\n${input}`, questions };
  }

  requestBytes(b: LoadedBundle, input: RedactedText): number {
    return Buffer.byteLength(JSON.stringify(this.buildRequest(b, input)), 'utf8');
  }

  async call(_b: LoadedBundle, _input: RedactedText, _runToken: RunToken): Promise<ProviderDecision> {
    throw new AdapterError('not_available');
  }

  normalize(b: LoadedBundle, raw: ProviderDecision): NormalizeResult {
    const answers = (raw.body as { answers?: unknown }).answers;
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return { ok: false, reason: 'answer_names_mismatch' };
    const qType = new Map(b.def.questions.map((q) => [q.name, q.type]));
    const entries: Array<[unknown, RawAnswer]> = [];
    for (const [name, a] of Object.entries(answers as Record<string, Record<string, unknown>>)) {
      const t = qType.get(name);
      if (t === 'predicate') entries.push([name, { type: 'predicate', probability: a?.noul }]);
      else if (t === 'choice') {
        const p = a?.probabilities;
        const list = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.entries(p).map(([value, probability]) => ({ value, probability })) : p;
        entries.push([name, { type: 'choice', choice: a?.choice, confidence: a?.confidence, probabilities: list }]);
      } else if (t === 'score') entries.push([name, { type: 'score', score: a?.score, confidence: a?.confidence }]);
      else entries.push([name, { type: 'refusal' }]);
    }
    const r = joinByName(b.def, entries);
    if (r.ok && r.refusals.length) return { ok: false, reason: 'answer_names_mismatch' };
    return r;
  }
}
