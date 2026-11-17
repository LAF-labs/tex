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
  /** 계정당 PC 3대·폰 3대(폐기 제외, 연결 대기·정지 포함. ADR-048 결정 1, 사용자 결정 2026-11-16). @sax/remote MAX_DESKTOPS·MAX_MOBILES와 같다 */
  maxDesktops: 3,
  maxMobiles: 3,
  /** 30일 등록 상한(C-32) */
  churnWindowDays: 30,
  /** 한도 3 + 교체 2(ADR-048 결정 1) */
  churnDesktop: 5,
  churnMobile: 5,
  /** 페어링되지 않은 등록 신청은 7일 뒤 지운다 */
  pendingTtlDays: 7,
  /** 기기 인증서 수명(D08 §4.1 90일) + 하루 여유 */
  certMaxDays: 91,
  deviceTokensPerHour: 60,
  /** 검증 전 IP당 시도(같은 사무실 NAT 뒤 여러 기기) */
  deviceTokenAttemptsPerIpHour: 600,
  /** 기기 토큰으로 하는 다른 기기 정지(ADR-048 결정 6), 요청 기기당 하루 */
  stopsPerDeviceDay: 5,
  /** acct_claim 발급(페어링 7단계마다 한 번), 기기당 */
  acctClaimsPerHour: 30,
} as const;

/** 새 PC 연결 우편함(ADR-048 결정 3, D08 §4.3) */
export const PC_LINK = {
  /** 신청 보관(기존 PC가 꺼져 있으면 켤 때까지 기다린다) */
  ttlDays: 7,
  /** 새 PC의 신청 올리기, 계정당 시간 */
  hellosPerAccountHour: 10,
  /** 우편함 읽기·쓰기 합계, 세션·기기당 시간(새 PC가 3초마다 답을 기다리는 10분 + 여유) */
  callsPerHour: 1200,
} as const;

/** 발급 잠금(ADR-048 결정 7) */
export const ISSUE_LOCK = {
  /** 잡거나 갱신한 뒤 이만큼 지나면 풀린다(PC가 죽어도 90초 뒤 다른 PC가 잡는다). PC는 30초마다 갱신한다 */
  ttlMs: 90_000,
  /** 잡기·갱신·놓기·보기 합계, 기기당 시간(다른 PC를 기다리며 5초마다 다시 잡아 보는 10분 + 갱신) */
  callsPerDeviceHour: 1200,
} as const;

/** 계정 공유 기록(ADR-048 결정 5, D07 §10). 값은 @sax/remote share.ts와 같아야 한다(시험이 대조한다). */
export const SHARE = {
  kinds: ['issue', 'party', 'self', 'money', 'task', 'task_result'],
  /** 새 줄이 오면 같은 종류의 앞 줄을 지우는 종류(계정에 마지막 한 장만 뜻이 있다. 받을 돈·낼 돈 요약) */
  latestOnlyKinds: ['money'],
  /** 폰이 올릴 수 있는 종류 */
  mobileKinds: ['task'],
  /** 줄 본문(b64url) 최대 길이: 가장 큰 패딩 버킷 16,384 + 논스 24 + 태그 16 */
  maxBodyChars: 21_899,
  /** 세대 상한 = 기기 목록의 폐기 레코드 상한(64) */
  maxEpoch: 64,
  /** 계정당 줄 수 상한(끝난 일의 줄은 30일 뒤 지운다) */
  maxRows: 50_000,
  /** 한 번에 주는 줄 수와 본문 합계(문자) */
  pageRows: 200,
  pageChars: 1_000_000,
  /** 맡긴 일의 유효 시간(D08 §7 queue.ttlHours). 지나면 맡김을 주지 않는다 */
  taskTtlMs: 72 * 3_600_000,
  /** 맡은 PC가 죽었을 때 다른 PC가 다시 맡을 수 있게 되는 시간. 맡은 PC는 5분마다 다시 맡아 늘린다 */
  claimMs: 15 * 60_000,
  /** 끝난·취소된·유효 시간이 지난 일을 지우기까지 */
  closedTaskDays: 30,
  /** 올리기·맡기, 기기당 시간 */
  writesPerDeviceHour: 600,
  /** 받기·일 목록, 기기당 시간(1분마다 받기 + 여유) */
  readsPerDeviceHour: 1200,
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
  /** 가입 뒤 무료 체험 개월 수(KST 달력, 카드 없음, 자동 유료 전환 없음. 사용자 결정 2026-11-16: 1달) */
  trialMonths: 1,
  /** 청약철회 기간(전자상거래법 §17①) */
  refundWindowMs: 7 * D,
  /** 체험 → 첫 결제 전환 안내를 보내는 때(첫 결제 7일 전, 약관 제12조) */
  trialNoticeMs: 7 * D,
  /** 연체(past_due) 중에도 재시도가 끝날 때까지 쓸 수 있다 */
  pastDueGraceMs: 3 * D,
} as const;

export const MS = { H, D };
