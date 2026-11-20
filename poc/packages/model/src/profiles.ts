import fs from 'node:fs';
import type { Provider } from './contract.ts';
import { computeDigest } from './bundle/digest.ts';
import { validateBundle } from './bundle/validate.ts';
import type { BundleDef, LoadedBundle, Pred } from './bundle/types.ts';

export interface ThresholdProfile {
  bundle: string;
  bundleDigest: string;
  provider: Provider;
  model: string;
  status: 'initial' | 'calibrated' | 'uncalibrated';
  corpus?: string;
  overrides: Array<{ rule: number; pred: number; value: number }>;
}

export type ProfileResolution = { ok: true; def: BundleDef; profile: ThresholdProfile } | { ok: false; reason: 'no_threshold_profile' | 'profile_uncalibrated' };

const PROFILES_FILE = new URL('../profiles/thresholds.json', import.meta.url);

function withThreshold(p: Pred, value: number): Pred {
  if ('gte' in p) return { ...p, gte: value };
  if ('lte' in p) return { ...p, lte: value };
  return { ...p, confidenceGte: value };
}

export class ThresholdProfiles {
  readonly items: ThresholdProfile[];

  constructor(items: ThresholdProfile[]) {
    this.items = items;
  }

  static load(file: URL = PROFILES_FILE): ThresholdProfiles {
    return new ThresholdProfiles(JSON.parse(fs.readFileSync(file, 'utf8')) as ThresholdProfile[]);
  }

  resolve(b: LoadedBundle, provider: Provider, model: string): ProfileResolution {
    const p = this.items.find((x) => x.bundle === b.wireId && x.bundleDigest === b.digest && x.provider === provider && x.model === model);
    if (!p) return { ok: false, reason: 'no_threshold_profile' };
    if (p.status === 'uncalibrated') return { ok: false, reason: 'profile_uncalibrated' };
    if (!p.overrides.length) return { ok: true, def: b.def, profile: p };
    const def = structuredClone(b.def);
    for (const o of p.overrides) {
      const r = def.mapping[o.rule];
      if (!r || r.when === 'always') throw new Error(`profile ${b.wireId}/${provider}: bad rule ${o.rule}`);
      const list = 'all' in r.when ? r.when.all : r.when.any;
      const pred = list[o.pred];
      if (!pred) throw new Error(`profile ${b.wireId}/${provider}: bad pred ${o.rule}.${o.pred}`);
      list[o.pred] = withThreshold(pred, o.value);
    }
    def.digest = computeDigest(def, b.prefixText);
    const v = validateBundle(def, b.prefixText, null);
    if (v.length) throw new Error(`profile ${b.wireId}/${provider} violates ${v.map((x) => x.rule).join(',')}`);
    return { ok: true, def, profile: p };
  }
}
