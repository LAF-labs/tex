// 임계값 프로필: (번들, 공급사·모델 스냅샷) 단위(D04 §1, ADR-015 결정 1).
// 번들 매핑 조건 안의 값이 기본(초기값)이고, 프로필은 같은 라벨 코퍼스로 재산정한 값을 행·조건 위치로 덮는다.
// 덮은 결과도 BV를 다시 통과해야 한다(프로필로 하한을 낮출 수 없다). 번들 다이제스트가 바뀌면 프로필은 무효다.
import fs from 'node:fs';
import type { Provider } from './contract.ts';
import { computeDigest } from './bundle/digest.ts';
import { validateBundle } from './bundle/validate.ts';
import type { BundleDef, LoadedBundle, Pred } from './bundle/types.ts';

export interface ThresholdProfile {
  bundle: string;
  bundleDigest: string;
  provider: Provider;
  /** 모델 스냅샷 접두(응답 model이 이 값으로 시작해야 한다) */
  model: string;
  /** initial: 설계 초기값 그대로(S7 재산정 전), calibrated: 라벨 코퍼스로 재산정, uncalibrated: 쓸 수 없음 */
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
