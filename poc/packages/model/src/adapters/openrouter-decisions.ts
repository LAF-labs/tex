import type { RedactedText, RunToken } from '../contract.ts';
import type { LoadedBundle } from '../bundle/types.ts';
import { AdapterError, type AdapterLimits, type ProviderDecision } from './types.ts';
import { UpstageSystemOneAdapter } from './upstage-systemone.ts';
import { L1_MODEL } from './gateway-decide.ts';

export interface OpenRouterDecisionsOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchFn: typeof fetch;
  timeoutMs?: number;
  provider?: Record<string, unknown>;
}

export class OpenRouterDecisionsAdapter extends UpstageSystemOneAdapter {
  override readonly provider = 'openai_compat' as const;
  override readonly model: string;
  readonly requestModel: string;
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
