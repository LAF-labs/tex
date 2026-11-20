const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;

export const RELAY = {
  frameMax: 65_535,
  msgPerSecPerMailbox: 20,
  mailboxesPerDevice: 3,
  queueMaxEnvelopes: 160,
  queueMaxBytes: 6 * 1024 * 1024,
  queuePageMaxBytes: 3 * 1024 * 1024,
  envelopeCtMax: 65_536,
  queueTtlMs: 72 * H,
  failuresPerConnection: 5,
  authFailuresPerIp: 20,
  authFailureWindowMs: 10 * MIN,
  attemptsPerIpMinute: 120,
  roomTtlMs: 120 * S,
  roomsPerAccountHour: 5,
  idleMs: 120 * S,
  statsRetentionDays: 7,
  bundleMaxBytes: 2048,
} as const;

/** D08 §6 바깥 헤더 ver(1B) ‖ kind(1B) ‖ ctr(8B, DATA만) ‖ len(2B). kind 값은 [제안] HS=1, DATA=2(ENV=3은 큐 경로) */
export const OUTER = { ver: 1, HS: 1, DATA: 2, ENV: 3 } as const;

/** D08 §6 패딩 버킷(통계용 크기 버킷) */
export const SIZE_BUCKETS = [256, 512, 1024, 4096, 16_384, 65_536] as const;
export const sizeBucket = (n: number): number => SIZE_BUCKETS.find((b) => n <= b) ?? 65_536;
