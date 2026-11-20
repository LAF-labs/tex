const MS = { H: 3600_000 } as const;

export const GATEWAY = {
  l1PerRun: 12,
  l2PerRun: 2,
  l1PerChat: 12,
  l2PerChat: 20,
  agentPerRun: 32,
  agentUpstreamTimeoutMs: 50_000,
  runTokenTtlMs: 2 * MS.H,
  runTokensPerDeviceHour: 120,
  l1PerMinute: 60,
  l2PerMinute: 10,
  agentPerMinute: 40,
  monthlyTokensDefault: 3_000_000,
  hardCapMultiplier: 2,
  safetyAfterCapPerMinute: 6,
  providerRetries: 2,
  backoffBaseMs: 250,
  callRecordRetentionDays: 35,
  abuseWindowMs: MS.H,
  abuseThreshold: 20,
  bizPerRequest: 10,
  bizPerMinute: 30,
  codefTokenPerDeviceHour: 20,
} as const;

/** 단가(마이크로 달러 / 100만 토큰). S9 실측·계약 전에는 0이고 ENV(GW_PRICES_JSON)로 넣는다. 토큰 수 계량은 단가와 무관하게 정확하다. */
export interface Prices {
  decideIn: number;
  decideOut: number;
  respondIn: number;
  respondOut: number;
  decideCached?: number;
  respondCached?: number;
  agentIn?: number;
  agentCached?: number;
  agentOut?: number;
}
export const ZERO_PRICES: Prices = { decideIn: 0, decideOut: 0, respondIn: 0, respondOut: 0 };

/**
 * 일 한도용 기본 단가(마이크로 달러 / 100만 토큰). GW_PRICES_JSON이 0이어도 한도는 이 값으로 센다(무료 체험 비용 상한이 단가 설정에 기대지 않게).
 * decide = gpt-6-luna Decisions(R1 §A.7: 입력 $0.10, 캐시 $0.01, 출력 무료).
 * respond = DeepSeek V4.1 Flash 1017(사용자 확인 2026-11-16). OpenRouter 표시가는 입력 $0.02·출력 $0.108이지만 제공사 라우팅에 따라 달라서,
 * 한도는 DeepSeek 공식 피크 단가(입력 $0.30, 캐시 $0.006, 출력 $1.20)로 센다(실제보다 많게 세는 쪽).
 * 에이전트 라우터(jev-router) 단가는 모르므로 gpt-6.1-terra(입력 $1, 캐시 $0.05, 출력 $5)로 잡는다(보수적).
 */
export const LIMIT_PRICES: Required<Prices> = {
  decideIn: 100_000,
  decideCached: 10_000,
  decideOut: 0,
  respondIn: 300_000,
  respondCached: 6_000,
  respondOut: 1_200_000,
  agentIn: 1_000_000,
  agentCached: 50_000,
  agentOut: 5_000_000,
};

/** 하루 AI 사용 금액 한도(원, 사용자 결정 2026-11-16: 체험 50원. 유료 300원은 제안값). 하루는 한국 시간 새벽 4시에 바뀐다 */
export const DAILY = {
  trialKrw: 50,
  paidKrw: 300,
  krwPerUsd: 1450,
  resetHourKst: 4,
} as const;

/** 일 한도의 '하루'(KST 새벽 4시 기준 날짜)와 다음 초기화 시각 */
export function limitDay(ms: number): { day: string; resetAt: number } {
  const shifted = ms + 9 * MS.H - DAILY.resetHourKst * MS.H;
  const day = new Date(shifted).toISOString().slice(0, 10);
  const startShifted = Date.parse(`${day}T00:00:00Z`);
  return { day, resetAt: startShifted + 24 * MS.H - 9 * MS.H + DAILY.resetHourKst * MS.H };
}
