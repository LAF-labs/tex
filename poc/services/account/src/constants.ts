// 서버가 강제하고 투명성 페이지에 게시하는 상수(D09 §2·§2.2 "상수 account.*·device.*는 서버가 강제").
const H = 3600_000;
const D = 24 * H;

export const ACCOUNT = {
  loginCodeTtlMs: 10 * 60_000,
  loginCodeMaxAttempts: 5,
  loginCodeSendsPerEmailHour: 5,
  loginCodeSendsPerIpHour: 30,
  authAttemptsPerIpHour: 60,
  /** 계정 세션(sxs1) 수명. 30일 → 1시간(ADR-038 (f) 세부, 팀장 결정 2026-11-06). 자동 로그인은 갱신 토큰으로 새로 받는다 */
  sessionTtlMs: H,
  /** 갱신 토큰(sxa1): 30일 동안 쓰지 않으면 만료(회전마다 새로 30일) */
  refreshTtlMs: 30 * D,
  oauthCodeTtlMs: 60_000,
  webauthnChallengeTtlMs: 5 * 60_000,
  deleteGraceDays: 7,
} as const;

/** 비밀번호(ADR-038 (b)~(e), D09 §2.1) */
export const PASSWORD = {
  minLength: 10,
  maxLength: 128,
  /** 계정당 연속 실패 5회면 잠금 */
  maxFails: 5,
  /** 첫 잠금 15분, 잠금마다 두 배, 상한 24시간 */
  lockBaseMs: 15 * 60_000,
  lockMaxMs: 24 * H,
  /** 잠금·실패 없이 하루가 지나면 단계(점증)를 0으로(정리 작업) */
  lockDecayMs: 24 * H,
  /** 열거 방지: 비밀번호 로그인·재설정 요청의 응답 시각 하한(ms). argon2id p99(운영 실측 뒤 조정)보다 크게 */
  responseFloorMs: 700,
  /** 한 인스턴스에서 동시에 도는 argon2id(64MiB) 수와 기다리는 줄 길이. 넘으면 429(메모리·CPU 상한) */
  hashConcurrency: 2,
  hashQueue: 32,
  /** 비밀번호 설정·삭제는 최근 로그인(코드·패스키·비밀번호) 세션만(갱신으로 받은 세션 제외) */
  reauthMaxAgeMs: 10 * 60_000,
  /** 재설정 코드: 로그인 코드와 같은 수명·실패 잠금(10분, 5회)·발송 한도 */
  resetCodeTtlMs: 10 * 60_000,
  resetCodeMaxAttempts: 5,
  resetSendsPerEmailHour: 5,
  resetSendsPerIpHour: 30,
} as const;

/** 알림 메일 발송 큐(notice_outbox). 응답 경로 밖에서 보낸다(ADR-038 (b)·(d)) */
export const NOTICE = {
  /** 한 번에 꺼내 보내는 수 */
  batch: 50,
  /** 보내는 동안 다른 처리자가 같은 행을 집지 않게 미루는 시간 */
  leaseMs: 5 * 60_000,
  /** 실패 뒤 다시 시도: 5분 × 2^(시도-1), 상한 6시간. 정리 cron(한 시간)이 다시 집는다 */
  retryBaseMs: 5 * 60_000,
  retryMaxMs: 6 * H,
  /** 이만큼 실패하면 버린다(이벤트 이름만) */
  maxAttempts: 8,
} as const;

export const DEVICE = {
  emailOnlyAddDelayHours: 72,
  newDeviceCoolingDays: 7,
  maxDesktops: 2,
  maxMobiles: 3,
  /** 30일 등록 상한(C-32) */
  churnWindowDays: 30,
  churnDesktop: 3,
  churnMobile: 5,
  /** 페어링되지 않은 등록 신청은 7일 뒤 지운다 */
  pendingTtlDays: 7,
  /** 기기 인증서 수명(D08 §4.1 90일) + 하루 여유 */
  certMaxDays: 91,
  deviceTokensPerHour: 60,
  /** 검증 전 IP당 시도(같은 사무실 NAT 뒤 여러 기기) */
  deviceTokenAttemptsPerIpHour: 600,
  /** acct_claim 발급(페어링 7단계마다 한 번), 기기당 */
  acctClaimsPerHour: 30,
} as const;

export const PROFILE = {
  slotMax: 2,
  rebindMinDays: 90,
} as const;

/** 카드 정기결제(빌링키 PG, 토스페이먼츠 자동결제) */
export const BILLING = {
  /** 청구 임대: 이 시간 안에는 같은 구독을 다시 청구하지 않는다(cron·결과 페이지가 겹쳐도 한 번). 결과를 모르면 이 뒤에 같은 주문번호로 다시 묻는다 */
  chargeLeaseMs: 15 * 60_000,
  /** 갱신 청구가 카드 사유로 실패하면 하루 뒤 다시 */
  retryAfterMs: D,
  /** 확정 실패가 이만큼 쌓이면 해지(빌링키 삭제) */
  maxFailedCharges: 3,
  orderName: '세무 비서 월 구독',
  /** 가입 뒤 무료 체험(카드 없음, 자동 유료 전환 없음) */
  trialDays: 14,
  /** 청약철회 기간(전자상거래법 §17①) */
  refundWindowMs: 7 * D,
  /** 연체(past_due) 중에도 재시도가 끝날 때까지 쓸 수 있다 */
  pastDueGraceMs: 3 * D,
} as const;

export const MS = { H, D };
