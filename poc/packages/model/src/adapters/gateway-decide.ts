// 게이트웨이 경로 판정 어댑터(기본 경로, D04 §1·§7). 요청 본문은 gateway-request.schema `decide`
// {bundleId, bundleDigest, input, runToken}뿐이고, 모델·캐시·safety_identifier·질문은 게이트웨이가 넣는다.
// 응답은 비신뢰(C-24): 게이트웨이가 질문을 만든 번들 정의의 해시(questionsDigest)를 로컬 번들과 대조하고, 답은 이름 조인 후
// 로컬 매핑으로만 결과를 낸다. 재시도는 게이트웨이가 공급사에 대해 한다(D09 §3 장애: 백오프 2회). 클라이언트는 재시도하지 않는다
// (실행 예산이 runToken에 묶여 있어 중복 호출은 예산을 쓴다).
import { createHash } from 'node:crypto';
import { GatewayError, ModelGuardError, isDecideResponse, type Egress } from '@sax/net';
import type { RedactedText, RunToken } from '../contract.ts';
import type { LoadedBundle } from '../bundle/types.ts';
import { canonicalJson } from '../bundle/digest.ts';
import { joinByName, type NormalizeResult } from '../normalize.ts';
import { decisionsEntries, decisionsQuestions, LUNA } from './openai-decisions.ts';
import { AdapterError, type AdapterLimits, type DecideAdapter, type ProviderDecision } from './types.ts';

/**
 * 질문 목록 해시(게이트웨이 /v1/decide 응답 questionsDigest와 같은 정의, services/gateway/API.md):
 * sha256(정규 JSON(번들 정의 questions)). 정규 JSON = 키 정렬, undefined 제외(bundle/digest.ts canonicalJson).
 * 공급사 와이어(decisionsQuestions, onRefusal 없음)가 아니라 정의를 해시한다. 게이트웨이도 같은 packages/model/bundles 원천의
 * def.questions를 해시하므로(BV-06) 와이어 변환을 바꿔도 양쪽이 어긋나지 않고, 로컬 전용 필드(onRefusal)가 달라도 잡는다.
 */
export function questionsDigest(b: LoadedBundle): string {
  return createHash('sha256').update(canonicalJson(b.def.questions)).digest('hex');
}

/**
 * 제품 결정 모델: OpenRouter decisions의 TypeSafe Jev, 별칭으로 부른다(대표 2026-11-16 "jev만, latest로"). 게이트웨이 MODEL_DECIDE·MODEL_DECISION 기본값.
 * 2026-11-16 탐침: ~typesafe/jev-latest → 응답 model typesafe/jev-1.14-20261014.
 */
export const JEV_LATEST = '~typesafe/jev-latest';
/**
 * L1 판정 응답 model 접두이자 임계값 프로필 키: Jev 계열 전체. 별칭이 새 버전으로 옮겨 가도 판정은 멈추지 않고 같은 프로필을 쓴다.
 * 그래서 풀린 버전을 호출마다 남기고(decide.result model, 게이트웨이 ops_stats model:<이름>), 버전이 바뀌면 S7·칸 고르기 평가를 다시 돌린다.
 * 진행 쪽 하한(BV-03 0.85)은 프로필로 낮출 수 없어 새 버전이 덜 뾰족해도 unknown(멈춤) 쪽으로만 기운다.
 */
export const L1_MODEL = 'typesafe/jev-';

export interface GatewayDecideOptions {
  egress: Egress;
  /** 게이트웨이가 쓰는 공급사 모델(응답 model 접두 확인·임계값 프로필 선택). 기본 gpt-6-luna(시험), 제품은 L1_MODEL */
  model?: string;
}

export class GatewayDecideAdapter implements DecideAdapter {
  /** 임계값 프로필의 공급사 칸: OpenAI Decisions(gpt-6-luna)는 openai, OpenRouter decisions(jev 등)는 openai_compat */
  readonly provider: 'openai' | 'openai_compat';
  readonly model: string;
  /** 게이트웨이 뒤 공급사가 OpenAI Decisions이므로 같은 한도. 입력 한도는 번들 maxInputBytes(≤ 16KB)가 먼저 막는다. */
  readonly limits: AdapterLimits = { maxChoices: 255, maxQuestions: 400, refusals: true, maxRequestBytes: 900_000 };
  private readonly egress: Egress;

  constructor(opts: GatewayDecideOptions) {
    this.egress = opts.egress;
    this.model = opts.model ?? LUNA;
    this.provider = this.model === LUNA ? 'openai' : 'openai_compat';
  }

  requestBytes(b: LoadedBundle, input: RedactedText): number {
    return Buffer.byteLength(b.prefixText, 'utf8') + Buffer.byteLength(input, 'utf8') + Buffer.byteLength(JSON.stringify(decisionsQuestions(b)), 'utf8');
  }

  async call(b: LoadedBundle, input: RedactedText, runToken: RunToken): Promise<ProviderDecision> {
    const started = performance.now();
    let res: unknown;
    try {
      res = await this.egress.toGateway({ surface: 'decide', body: { bundleId: b.wireId, bundleDigest: b.digest, input, runToken } });
    } catch (e) {
      if (e instanceof GatewayError) throw new AdapterError(`gateway_${e.code.slice('gateway.'.length)}`, e.status);
      if (e instanceof ModelGuardError) throw new AdapterError(`guard_${e.code}`);
      throw new AdapterError('egress');
    }
    if (!isDecideResponse(res)) throw new AdapterError('gateway_bad_response');
    if (res.questionsDigest !== questionsDigest(b)) throw new AdapterError('questions_digest_mismatch');
    const u = res.usage ?? {};
    return {
      model: res.model,
      body: res,
      // cached_tokens는 게이트웨이가 넘기지 않는다(D04 §7, 적중 여부 오라클 차단).
      usage: { inputTokens: u.input_tokens ?? 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: u.output_tokens ?? 0 },
      latencyMs: performance.now() - started,
      rateLimit: {},
      attempts: 1,
    };
  }

  normalize(b: LoadedBundle, raw: ProviderDecision): NormalizeResult {
    const entries = decisionsEntries((raw.body as { answers?: unknown }).answers);
    return entries ? joinByName(b.def, entries) : { ok: false, reason: 'answer_type_mismatch' };
  }
}
