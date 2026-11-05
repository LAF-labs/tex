// ModelLayer 구현. 순서: 번들 조회(앱 내장) → 입력 한도(절단 금지) → 어댑터 정적 호환 → 임계값 프로필 → (판정 캐시) → 호출 →
// 스냅샷 확인 → 이름 조인 → (L0 덮어쓰기) → 로컬 매핑. 어느 단계든 실패하면 outcome은 unknown이다(D04 §2).
import type { BundleAnswers, DecideRequest, DecideResult, ModelLayer, Provider, RespondRequest, RespondResult, UnknownReason, Usage } from './contract.ts';
import { ZERO_USAGE } from './contract.ts';
import type { BundleCatalog } from './bundle/catalog.ts';
import { evaluateMapping, resolveAnswer, type ResolvedState } from './bundle/evaluate.ts';
import type { BundleDef, LoadedBundle } from './bundle/types.ts';
import type { ThresholdProfiles } from './profiles.ts';
import { AdapterError, incompatibilities, type DecideAdapter } from './adapters/types.ts';
import type { OpenAIResponsesAdapter } from './adapters/openai-responses.ts';
import type { ToolsetDef } from './toolsets.ts';
import { decisionKey, type DecisionCache } from './cache.ts';

export interface DecideOptions {
  /** L0 규칙 답. 같은 이름의 모델 답을 덮는다(엔진 judge가 승격된 질문만 넘긴다). 모델로 보내지 않는다. */
  overlay?: BundleAnswers;
}

export interface LayerDeps {
  catalog: BundleCatalog;
  profiles: ThresholdProfiles;
  decider: DecideAdapter;
  responder?: OpenAIResponsesAdapter;
  toolsets?: Partial<Record<RespondRequest['toolset'], ToolsetDef>>;
  /** 같은 실행·같은 입력 판정 재사용(입력 해시). 없으면 매번 부른다. */
  cache?: DecisionCache;
}

/** 어댑터 오류 코드 → unknown 이유. */
export function reasonOf(code: string): UnknownReason {
  if (code.startsWith('guard_')) return `guard:${code.slice(6)}`;
  if (code.startsWith('gateway_')) return `gateway:${code.slice(8)}`;
  if (code === 'questions_digest_mismatch') return 'questions_digest_mismatch';
  return `provider:${code}`;
}

export function statesOf(def: BundleDef, answers: BundleAnswers): Record<string, ResolvedState> {
  const s: Record<string, ResolvedState> = {};
  for (const q of def.questions) s[q.name] = resolveAnswer(q, answers[q.name]);
  return s;
}

export class DefaultModelLayer implements ModelLayer {
  private readonly d: LayerDeps;

  constructor(deps: LayerDeps) {
    this.d = deps;
  }

  get decider(): DecideAdapter {
    return this.d.decider;
  }

  bundle(wireId: string): LoadedBundle | undefined {
    return this.d.catalog.get(wireId);
  }

  /** 이 공급사·모델에 적용할 매핑(프로필 반영). */
  effectiveDef(b: LoadedBundle, provider: Provider = this.d.decider.provider, model: string = this.d.decider.model): BundleDef | UnknownReason {
    const r = this.d.profiles.resolve(b, provider, model);
    return r.ok ? r.def : r.reason;
  }

  private unknown(reason: UnknownReason, usage: Usage = ZERO_USAGE, raw: BundleAnswers = {}, refusals: string[] = []): DecideResult {
    return { outcome: 'unknown', confidence: 0, raw, usage, refusals, rule: -1, reason, provider: this.d.decider.provider, model: this.d.decider.model, l0Only: false };
  }

  async decide(req: DecideRequest, opts: DecideOptions = {}): Promise<DecideResult> {
    const b = this.d.catalog.get(req.bundleId);
    if (!b) return this.unknown('bundle_not_found');
    if (b.digest !== req.bundleDigest) return this.unknown('bundle_digest_mismatch');
    if (Buffer.byteLength(req.input, 'utf8') > b.def.maxInputBytes) return this.unknown('input_too_large');
    const a = this.d.decider;
    if (incompatibilities(b, a.limits).length) return this.unknown('adapter_incompatible');
    if (a.requestBytes(b, req.input) > a.limits.maxRequestBytes) return this.unknown('provider_context_exceeded');
    const def = this.effectiveDef(b);
    if (typeof def === 'string') return this.unknown(def);
    const key = this.d.cache ? decisionKey({ bundleId: b.wireId, bundleDigest: b.digest, provider: a.provider, model: a.model, runToken: req.runToken, input: req.input }) : null;
    const hit = key ? this.d.cache!.get(key) : undefined;
    let usage: Usage = ZERO_USAGE;
    let model: string;
    let n: { answers: BundleAnswers; refusals: string[] };
    if (hit) {
      model = hit.model;
      n = { answers: hit.answers, refusals: hit.refusals };
    } else {
      let raw;
      try {
        raw = await a.call(b, req.input, req.runToken);
      } catch (e) {
        return this.unknown(reasonOf(e instanceof AdapterError ? e.code : 'unavailable'));
      }
      usage = raw.usage;
      if (!raw.model.startsWith(a.model)) return this.unknown('model_snapshot_mismatch', raw.usage);
      const norm = a.normalize(b, raw);
      if (!norm.ok) return this.unknown(norm.reason, raw.usage);
      model = raw.model;
      n = { answers: norm.answers, refusals: norm.refusals };
      if (key) this.d.cache!.set(key, { answers: norm.answers, refusals: norm.refusals, model });
    }
    const answers: BundleAnswers = { ...n.answers, ...(opts.overlay ?? {}) };
    const m = evaluateMapping(def, statesOf(def, answers));
    return {
      outcome: m.outcome,
      confidence: m.confidence,
      raw: answers,
      usage,
      refusals: a.limits.refusals ? n.refusals : [],
      rule: m.rule,
      ...(m.outcome === 'unknown' ? { reason: m.coreRefusal ? ('core_refusal' as const) : ('mapping_unknown' as const) } : {}),
      provider: a.provider,
      model,
      l0Only: false,
      ...(hit ? { cached: true } : {}),
    };
  }

  async respond(req: RespondRequest): Promise<RespondResult> {
    const t = this.d.toolsets?.[req.toolset];
    if (!this.d.responder || !t) return { status: 'incomplete', toolCalls: [], replay: [], usage: ZERO_USAGE, reason: 'toolset_not_in_poc' };
    return this.d.responder.respond(t, req);
  }
}
