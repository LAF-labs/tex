import type { Provider, RedactedText, RunToken, Usage } from '../contract.ts';
import type { LoadedBundle } from '../bundle/types.ts';
import type { NormalizeResult } from '../normalize.ts';

export interface AdapterLimits {
  maxChoices: number;
  maxQuestions: number;
  refusals: boolean;
  maxRequestBytes: number;
}

export interface ProviderDecision {
  model: string;
  body: unknown;
  usage: Usage;
  latencyMs: number;
  rateLimit: Record<string, string>;
  attempts: number;
}

export type AdapterErrorCode =
  | 'unavailable'
  | 'timeout'
  | 'rate_limited'
  | 'quota'
  | 'bad_request'
  | 'auth'
  | 'not_available'
  | 'egress'
  | 'questions_digest_mismatch'
  | `guard_${string}`
  | `gateway_${string}`;

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly status?: number;
  constructor(code: AdapterErrorCode, status?: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export interface DecideAdapter {
  readonly provider: Provider;
  readonly model: string;
  readonly limits: AdapterLimits;
  requestBytes(b: LoadedBundle, input: RedactedText): number;
  call(b: LoadedBundle, input: RedactedText, runToken: RunToken): Promise<ProviderDecision>;
  normalize(b: LoadedBundle, raw: ProviderDecision): NormalizeResult;
}

/** 번들이 어댑터 한도 안에 드는가(정적 검사). 위반 목록이 비면 호환. */
export function incompatibilities(b: LoadedBundle, limits: AdapterLimits): string[] {
  const out: string[] = [];
  if (b.def.questions.length > limits.maxQuestions) out.push(`questions ${b.def.questions.length} > ${limits.maxQuestions}`);
  for (const q of b.def.questions) if (q.type === 'choice' && q.choices.length > limits.maxChoices) out.push(`${q.name} choices ${q.choices.length} > ${limits.maxChoices}`);
  return out;
}
