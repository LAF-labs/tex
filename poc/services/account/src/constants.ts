const H = 3600_000;
const D = 24 * H;

export const ACCOUNT = {
  loginCodeTtlMs: 10 * 60_000,
  loginCodeMaxAttempts: 5,
  loginCodeSendsPerEmailHour: 5,
  loginCodeSendsPerIpHour: 30,
  authAttemptsPerIpHour: 60,
  sessionTtlMs: H,
  refreshTtlMs: 30 * D,
  oauthCodeTtlMs: 60_000,
  webauthnChallengeTtlMs: 5 * 60_000,
  deleteGraceDays: 7,
} as const;

/** 비밀번호(ADR-038 (b)~(e), D09 §2.1) */
export const PASSWORD = {
  minLength: 10,
  maxLength: 128,
  maxFails: 5,
  lockBaseMs: 15 * 60_000,
  lockMaxMs: 24 * H,
  lockDecayMs: 24 * H,
  responseFloorMs: 700,
  hashConcurrency: 2,
  hashQueue: 32,
  reauthMaxAgeMs: 10 * 60_000,
  resetCodeTtlMs: 10 * 60_000,
  resetCodeMaxAttempts: 5,
  resetSendsPerEmailHour: 5,
  resetSendsPerIpHour: 30,
} as const;

/** 알림 메일 발송 큐(notice_outbox). 응답 경로 밖에서 보낸다(ADR-038 (b)·(d)) */
export const NOTICE = {
  batch: 50,
  leaseMs: 5 * 60_000,
  retryBaseMs: 5 * 60_000,
  retryMaxMs: 6 * H,
  maxAttempts: 8,
} as const;

export const DEVICE = {
  emailOnlyAddDelayHours: 72,
  newDeviceCoolingDays: 7,
  maxDesktops: 3,
  maxMobiles: 3,
  churnWindowDays: 30,
  churnDesktop: 5,
  pendingTtlDays: 7,
  certMaxDays: 91,
  deviceTokensPerHour: 60,
  lastSeenWriteMs: 10 * 60_000,
  deviceTokenAttemptsPerIpHour: 600,
  stopsPerDeviceDay: 5,
  acctClaimsPerHour: 30,
} as const;

/** 새 PC 연결 우편함(ADR-048 결정 3, D08 §4.3) */
export const PC_LINK = {
  ttlDays: 7,
  hellosPerAccountHour: 10,
  callsPerHour: 1200,
} as const;

/** 계정 열쇠 보관(ADR-050) */
export const KEY_ESCROW = {
  claimsPerAccountDay: 6,
  callsPerHour: 60,
} as const;

/** 발급 잠금(ADR-048 결정 7) */
export const ISSUE_LOCK = {
  ttlMs: 90_000,
  callsPerDeviceHour: 1200,
} as const;

/** 계정 공유 기록(ADR-048 결정 5, D07 §10). 값은 @sax/remote share.ts와 같아야 한다(시험이 대조한다). */
export const SHARE = {
  kinds: ['issue', 'party', 'self', 'money', 'task', 'task_result'],
  latestOnlyKinds: ['money'],
  mobileKinds: ['task'],
  maxBodyChars: 21_899,
  maxEpoch: 64,
  maxRows: 50_000,
  pageRows: 200,
  pageChars: 1_000_000,
  taskTtlMs: 72 * 3_600_000,
  claimMs: 15 * 60_000,
  closedTaskDays: 30,
  writesPerDeviceHour: 600,
  readsPerDeviceHour: 1200,
} as const;

export const PROFILE = {
  slotMax: 2,
  rebindMinDays: 90,
} as const;

/** 카드 정기결제(빌링키 PG, 토스페이먼츠 자동결제) */
export const BILLING = {
  chargeLeaseMs: 15 * 60_000,
  retryAfterMs: D,
  maxFailedCharges: 3,
  orderName: '세무 비서 월 구독',
  trialMonths: 1,
  refundWindowMs: 7 * D,
  trialNoticeMs: 7 * D,
  pastDueGraceMs: 3 * D,
} as const;

export const MS = { H, D };
