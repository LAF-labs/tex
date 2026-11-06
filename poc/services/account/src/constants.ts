// 서버가 강제하고 투명성 페이지에 게시하는 상수(D09 §2·§2.2 "상수 account.*·device.*는 서버가 강제").
const H = 3600_000;
const D = 24 * H;

export const ACCOUNT = {
  loginCodeTtlMs: 10 * 60_000,
  loginCodeMaxAttempts: 5,
  loginCodeSendsPerEmailHour: 5,
  loginCodeSendsPerIpHour: 30,
  authAttemptsPerIpHour: 60,
  sessionTtlMs: 30 * D,
  oauthCodeTtlMs: 60_000,
  webauthnChallengeTtlMs: 5 * 60_000,
  deleteGraceDays: 7,
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

export const MS = { H, D };
