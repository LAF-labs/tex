// 판정 캐시(입력 해시, D14 §2.1 M1-6). 같은 실행(runToken) 안에서 같은 번들·다이제스트·공급사·모델·마스킹 입력이면
// 정규화된 답을 재사용한다(폴링·재진입 판정의 중복 호출과 예산 소비를 줄인다). 매핑은 매번 로컬 번들로 다시 계산한다.
// - 키에 runToken을 넣는다: 실행·대화 세션 사이에 답이 새지 않는다. 입력 원문은 저장하지 않고 sha256만 키로 쓴다.
// - 공급사 오류·스키마 불일치·응답 이름 불일치 등 정규화 실패는 저장하지 않는다(unknown을 굳히지 않는다).
// - 공급사 프롬프트 캐시(prompt_cache_*, D04 §2.1)와는 별개다. 이것은 클라이언트 메모리 캐시이며 디스크에 쓰지 않는다.
import { createHash } from 'node:crypto';
import type { BundleAnswers, Provider, RedactedText, RunToken } from './contract.ts';

export interface CachedDecision {
  answers: BundleAnswers;
  refusals: string[];
  model: string;
  at: number;
}

export interface DecisionCacheOptions {
  /** 기본 30초. 화면이 같아도 오래된 판정은 다시 묻는다. */
  ttlMs?: number;
  /** 기본 256. 넘으면 가장 오래된 것부터 버린다. */
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

  /** 실행 종료 시 그 실행의 항목을 지울 수 없으므로(키가 해시) 전체를 비운다. 실행 수명보다 TTL이 짧아 보통 필요 없다. */
  clear(): void {
    this.items.clear();
  }

  get size(): number {
    return this.items.size;
  }
}
