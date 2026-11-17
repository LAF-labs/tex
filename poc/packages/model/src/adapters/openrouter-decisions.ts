// OpenRouter decisions(알파, POST /api/alpha/decisions) 어댑터: System One 계약(state 문자열 + 이름 키 questions, predicate → noul)이라
// Upstage 스텁과 같은 요청·정규화를 쓰고 호출만 붙인다. Clef(cloudflare/clef-flash·clef·clef-omni)와 TypeSafe Jev가 같은 엔드포인트다
// (대표 2026-11-16 "jev와 clef는 기본적으로 같음", 맥북 탐침: 생성 없이 확률만, 호출 0.4~0.6초, 입력 토큰만 과금).
// 측정(scripts/s7-regression.ts --decisions=<모델>)용이다. 제품 경로는 게이트웨이를 거친다(키는 서버만).
import type { RedactedText, RunToken } from '../contract.ts';
import type { LoadedBundle } from '../bundle/types.ts';
import { AdapterError, type AdapterLimits, type ProviderDecision } from './types.ts';
import { UpstageSystemOneAdapter } from './upstage-systemone.ts';
import { L1_MODEL } from './gateway-decide.ts';

export interface OpenRouterDecisionsOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** 송신 함수(측정 스크립트는 fetch, 제품은 egress). 필수: 제품 코드에서 전역 fetch를 쓰지 않는다. */
  fetchFn: typeof fetch;
  timeoutMs?: number;
  /** OpenRouter provider 필드(보관 조건 등). 없으면 싣지 않는다. */
  provider?: Record<string, unknown>;
}

export class OpenRouterDecisionsAdapter extends UpstageSystemOneAdapter {
  override readonly provider = 'openai_compat' as const;
  /** 응답 model 접두·프로필 키. Jev(별칭 포함)는 계열 접두 L1_MODEL, 그 밖에는 요청 모델 그대로. */
  override readonly model: string;
  /** 요청에 싣는 모델(별칭 그대로) */
  readonly requestModel: string;
  /** clef/flash는 state 앞 약 2,000토큰만 읽는다(가이드). 바이트 상한은 보수적으로 그 근처. 선택지 상한은 미확인이라 System One 26. */
  override readonly limits: AdapterLimits = { maxChoices: 26, maxQuestions: 32, refusals: false, maxRequestBytes: 24_000 };
  private readonly o: OpenRouterDecisionsOptions;

  constructor(o: OpenRouterDecisionsOptions) {
    super();
    this.o = o;
    this.requestModel = o.model;
    this.model = /^~?typesafe\/jev-/.test(o.model) ? L1_MODEL : o.model;
  }

  override buildRequest(b: LoadedBundle, input: RedactedText) {
    return { ...super.buildRequest(b, input), model: this.requestModel };
  }

  override async call(b: LoadedBundle, input: RedactedText, _runToken: RunToken): Promise<ProviderDecision> {
    const body = { ...this.buildRequest(b, input), ...(this.o.provider ? { provider: this.o.provider } : {}) };
    const t0 = performance.now();
    let res: Response;
    try {
      res = await this.o.fetchFn(`${(this.o.baseUrl ?? 'https://openrouter.ai/api').replace(/\/$/, '')}/alpha/decisions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.o.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000),
      });
    } catch {
      throw new AdapterError('unavailable');
    }
    if (res.status === 429) throw new AdapterError('rate_limited', 429);
    if (res.status === 401 || res.status === 403) throw new AdapterError('auth', res.status);
    if (res.status >= 500) throw new AdapterError('unavailable', res.status);
    if (res.status !== 200) throw new AdapterError('bad_request', res.status);
    const d = (await res.json()) as { model?: string; usage?: { input_tokens?: number; output_tokens?: number; cost?: number } };
    return {
      model: String(d.model ?? this.model),
      body: d,
      usage: { inputTokens: d.usage?.input_tokens ?? 0, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: d.usage?.output_tokens ?? 0 },
      latencyMs: performance.now() - t0,
      rateLimit: {},
      attempts: 1,
    };
  }
}
