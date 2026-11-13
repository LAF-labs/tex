// 게이트웨이 한도(D04 §6·§7, D09 §3·§4.1). 바꾸면 API.md와 시험을 함께 고친다.
const MS = { H: 3600_000 } as const;

export const GATEWAY = {
  /** 실행당 예산(D04 §6): L1 ≤ 12, L2 ≤ 2(새 L2 = replay 없는 respond) */
  l1PerRun: 12,
  l2PerRun: 2,
  /** 실행 밖 대화 범위(chatSessionId)의 예산(D04 §1 "자기 예산"). 제안값, D04 확정 필요 */
  l1PerChat: 12,
  l2PerChat: 20,
  /** 실행당 예상 밖 화면 판정·브라우저 에이전트 호출(page_judge·browser_agent, 에이전트 25걸음 + 판정). packages/net AGENT_CALLS_PER_RUN과 같다 */
  agentPerRun: 32,
  runTokenTtlMs: 2 * MS.H,
  /** runToken 발급 한도(범위 ID를 바꿔 예산을 늘리는 것을 늦춘다) */
  runTokensPerDeviceHour: 120,
  /** 분당 요청 한도(계정 단위, D09 §3) */
  l1PerMinute: 60,
  l2PerMinute: 10,
  /** 판정·에이전트 분당 한도(계정 단위). 에이전트는 걸음마다 부른다 */
  agentPerMinute: 40,
  /** 월 토큰 한도(입력+출력). 100%에서 L2 중단, 200%(하드 상한)에서 안전 판정 번들만 */
  monthlyTokensDefault: 3_000_000,
  hardCapMultiplier: 2,
  /** [제안] 하드 상한 이후 안전 판정 번들의 "낮은 속도"(D04 §6): 계정당 분당 6회 */
  safetyAfterCapPerMinute: 6,
  /** 공급사 5xx·429 → 지수 백오프 2회 */
  providerRetries: 2,
  backoffBaseMs: 250,
  /** 호출 단위 계정 연결 기록 보존(결제 대사, C-23) */
  callRecordRetentionDays: 35,
  /** 기기 자동 정지: 1시간 안에 트립와이어·거절이 이만큼 */
  abuseWindowMs: MS.H,
  abuseThreshold: 20,
  /** 진위확인 프록시(D09 §4.1): 요청당 ≤ 10건, 계정당 분당 30회 */
  bizPerRequest: 10,
  bizPerMinute: 30,
  /** CODEF 토큰(계좌 자동조회): 기기당 시간당 20회. PC는 만료 전까지 메모리에 두고 다시 쓰므로 실제로는 하루 몇 번이다 */
  codefTokenPerDeviceHour: 20,
} as const;

/** 단가(마이크로 달러 / 100만 토큰). S9 실측·계약 전에는 0이고 ENV(GW_PRICES_JSON)로 넣는다. 토큰 수 계량은 단가와 무관하게 정확하다. */
export interface Prices {
  decideIn: number;
  decideOut: number;
  respondIn: number;
  respondOut: number;
}
export const ZERO_PRICES: Prices = { decideIn: 0, decideOut: 0, respondIn: 0, respondOut: 0 };
