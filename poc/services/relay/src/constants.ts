// 릴레이 한도. 정본은 D08 §8(우편함)·§7(큐)·§4.2(페어링 룸)이다. [제안]은 문서에 수치가 없어 이 PR이 정한 값.
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

export const RELAY = {
  /** Noise 전송 한도 = WebSocket 프레임 상한 */
  frameMax: 65_535,
  msgPerSecPerMailbox: 20,
  mailboxesPerDevice: 3,
  /**
   * 우편함당 큐 한도(팀장 결정 2026-11-05, 폰 #84와 합의). 4 MiB 사진 = offer 1 + 32 KiB 청크 128 = 봉투 129개가 들어간다.
   * 서버는 봉투 종류(xfer 사진·현금매출 등)를 보지 않으므로 크기만 센다.
   */
  queueMaxEnvelopes: 160,
  queueMaxBytes: 6 * 1024 * 1024,
  /**
   * [제안] 큐 GET 한 번에 돌려주는 봉투 바이트 상한. 큐 전체(6 MiB)는 Vercel 함수 응답 상한(4.5MB)을 넘으므로 나눈다.
   * 3 MiB면 JSON 감싸기를 더해도 상한 아래이고, 4 MiB 사진(봉투 129개)은 두 번에 받는다. 봉투 하나(≤ 약 66KB)는 언제나 들어간다.
   */
  queuePageMaxBytes: 3 * 1024 * 1024,
  /** intent-envelope v1.5 바깥 객체의 `ct`(base64) 상한 */
  envelopeCtMax: 65_536,
  /**
   * queue.ttlHours(일반 72시간). 사진 24시간은 서버가 종류를 모르므로 봉투 안 서명된 `exp`(iat + 24시간 이하)로 끝단(PC)이 집행한다.
   * ack는 `seq`까지 일괄 삭제.
   */
  queueTtlMs: 72 * H,
  /** 연결당 실패 상한(형식이 틀린 프레임) */
  failuresPerConnection: 5,
  /** [제안] 우편함 토큰 실패는 IP(일 회전 HMAC)당 10분 20회 */
  authFailuresPerIp: 20,
  authFailureWindowMs: 10 * MIN,
  /** [제안] 업그레이드·HTTP 시도 IP당 분당 120회 */
  attemptsPerIpMinute: 120,
  roomTtlMs: 120 * S,
  roomsPerAccountHour: 5,
  /** [제안] 무통신 연결 종료(클라이언트는 30초마다 ping) */
  idleMs: 120 * S,
  statsRetentionDays: 7,
  /** [제안] 우편함 번들(서명된 {Qx, valid_from, valid_to, seq}) 크기 상한 */
  bundleMaxBytes: 2048,
} as const;

/** D08 §6 바깥 헤더 ver(1B) ‖ kind(1B) ‖ ctr(8B, DATA만) ‖ len(2B). kind 값은 [제안] HS=1, DATA=2(ENV=3은 큐 경로) */
export const OUTER = { ver: 1, HS: 1, DATA: 2, ENV: 3 } as const;

/** D08 §6 패딩 버킷(통계용 크기 버킷) */
export const SIZE_BUCKETS = [256, 512, 1024, 4096, 16_384, 65_536] as const;
export const sizeBucket = (n: number): number => SIZE_BUCKETS.find((b) => n <= b) ?? 65_536;
