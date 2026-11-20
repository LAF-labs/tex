import { createHash } from 'node:crypto';
import type { BundleAnswers, Provider, RedactedText, RunToken } from './contract.ts';

export interface CachedDecision {
  answers: BundleAnswers;
  refusals: string[];
  model: string;
  at: number;
}

export interface DecisionCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export function decisionKey(p: { bundleId: string; bundleDigest: string; provider: Provider; model: string; runToken: RunToken; input: RedactedText }): string {
  const h = createHash('sha256');
  for (const part of [p.bundleId, p.bundleDigest, p.provider, p.model, p.runToken]) h.update(part).update('\u0000');
  return h.update(p.input).digest('hex');
}

export class DecisionCache {
  private readonly items = new Map<string, CachedDecision>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;
  readonly stats = { hits: 0, misses: 0, stores: 0, evictions: 0 };

  constructor(opts: DecisionCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30_000;
    this.max = opts.maxEntries ?? 256;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): CachedDecision | undefined {
    const v = this.items.get(key);
    if (!v || this.now() - v.at > this.ttlMs) {
      if (v) this.items.delete(key);
      this.stats.misses++;
      return undefined;
    }
    this.stats.hits++;
    return { ...v, answers: structuredClone(v.answers), refusals: [...v.refusals] };
  }

  set(key: string, v: Omit<CachedDecision, 'at'>): void {
    this.items.delete(key);
    this.items.set(key, { answers: structuredClone(v.answers), refusals: [...v.refusals], model: v.model, at: this.now() });
    this.stats.stores++;
    while (this.items.size > this.max) {
      this.items.delete(this.items.keys().next().value!);
      this.stats.evictions++;
    }
  }

  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}
