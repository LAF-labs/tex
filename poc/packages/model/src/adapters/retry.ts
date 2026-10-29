// 어댑터 소유 재시도 정책(D04 §1). SDK 자동 재시도는 끈다(maxRetries: 0).
// 429 결제·한도 코드는 재시도하지 않는다. 503·5xx·일반 429는 Retry-After(없으면 지수 백오프) + 지터로 최대 2회.
// 판정은 실행 흐름 안에 있으므로 Retry-After가 상한을 넘으면 기다리지 않고 unknown으로 끝낸다.
import { AdapterError, type AdapterErrorCode } from './types.ts';

export interface RetryPolicy {
  maxRetries: number;
  baseMs: number;
  capMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, baseMs: 250, capMs: 4_000 };

/** R1 §A.8: 재시도하면 안 되는 429 코드 */
export const BILLING_CODES = new Set(['credit_balance_exhausted', 'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'insufficient_quota']);

export interface ErrorView {
  status?: number;
  code?: string | null;
  headers?: { get(name: string): string | null } | null;
  kind: 'api' | 'connection' | 'timeout' | 'other';
}

export type Verdict = { retry: true; delayMs: number } | { retry: false; code: AdapterErrorCode };

export function retryAfterMs(h: ErrorView['headers'], now = Date.now()): number | null {
  const ms = h?.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const ra = h?.get('retry-after');
  if (!ra) return null;
  if (Number.isFinite(Number(ra))) return Number(ra) * 1000;
  const at = Date.parse(ra);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function classify(e: ErrorView, attempt: number, p: RetryPolicy, random: () => number): Verdict {
  const backoff = () => Math.min(p.capMs, p.baseMs * 2 ** attempt) + Math.floor(random() * p.baseMs);
  if (e.kind === 'timeout') return { retry: false, code: 'timeout' };
  let code: AdapterErrorCode;
  let retryable = false;
  if (e.kind === 'connection') {
    code = 'unavailable';
    retryable = true;
  } else if (e.status === 429) {
    if (e.code && BILLING_CODES.has(e.code)) return { retry: false, code: 'quota' };
    code = 'rate_limited';
    retryable = true;
  } else if (e.status !== undefined && e.status >= 500) {
    code = 'unavailable';
    retryable = true;
  } else if (e.status === 401 || e.status === 403) {
    code = 'auth';
  } else if (e.status !== undefined && e.status >= 400) {
    code = 'bad_request';
  } else {
    code = 'unavailable';
  }
  if (!retryable || attempt >= p.maxRetries) return { retry: false, code };
  const ra = retryAfterMs(e.headers);
  if (ra !== null && ra > p.capMs) return { retry: false, code };
  return { retry: true, delayMs: Math.max(ra ?? 0, backoff()) };
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  view: (e: unknown) => ErrorView | AdapterError,
  opts: { policy?: RetryPolicy; sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<{ value: T; attempts: number }> {
  const policy = opts.policy ?? DEFAULT_RETRY;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  for (let attempt = 0; ; attempt++) {
    try {
      return { value: await fn(), attempts: attempt + 1 };
    } catch (e) {
      const v = view(e);
      if (v instanceof AdapterError) throw v;
      const verdict = classify(v, attempt, policy, random);
      if (!verdict.retry) throw new AdapterError(verdict.code, v.status);
      await sleep(verdict.delayMs);
    }
  }
}
