// 판정 어댑터 인터페이스. 공급사 종속 코드는 adapters/*에만 둔다(ADR-003·ADR-015).
import type { Provider, RedactedText, RunToken, Usage } from '../contract.ts';
import type { LoadedBundle } from '../bundle/types.ts';
import type { NormalizeResult } from '../normalize.ts';

export interface AdapterLimits {
  /** choice 선택지 상한(OpenAI 255, System One 26) */
  maxChoices: number;
  /** 요청당 질문 상한 */
  maxQuestions: number;
  /** 질문 단위 refusal이 있는가. 없으면 refusals는 항상 빈 배열이고 onRefusal은 쓰이지 않는다. */
  refusals: boolean;
  /** 접두 + 입력 + 질문의 UTF-8 바이트 상한(토큰 수 ≤ 바이트 수라 보수적). 넘으면 unknown, 절단 금지. */
  maxRequestBytes: number;
}

export interface ProviderDecision {
  /** 응답이 밝힌 모델 스냅샷 */
  model: string;
  /** 공급사 원형 응답(비신뢰). normalize()만 읽는다. */
  body: unknown;
  usage: Usage;
  latencyMs: number;
  /** x-ratelimit-*·retry-after (S9) */
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
  /** 게이트웨이 응답의 질문 해시가 로컬 번들과 다름(C-24) */
  | 'questions_digest_mismatch'
  | `guard_${string}`
  /** 게이트웨이 경로 오류(gateway.<code> → gateway_<code>) */
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
  /** 요청 바이트 추정(접두·입력·질문). 절단하지 않고 한도 비교에만 쓴다. */
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
