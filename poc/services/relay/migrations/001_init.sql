-- 릴레이(D08 §8, D09 §4). 우편함 ID·능력 토큰은 PC가 만든 32B 난수이고 여기에는 SHA-256 해시만 둔다.
-- 계정·기기 ID와 우편함은 같은 행·같은 테이블에 없다(조인 불가, D08 §8 "분리 저장"). 큐는 이미 E2E 암호문이고 저장 전 한 번 더 봉인한다.
CREATE TABLE mailboxes (
  mbx_key TEXT PRIMARY KEY,
  read_hash TEXT NOT NULL,
  write_hash TEXT NOT NULL,
  next_seq {{BIGINT}} NOT NULL DEFAULT 1
);

-- 오프라인 의도 봉투 큐(폰 → PC). ACK 또는 72시간 만료로 지운다.
CREATE TABLE queue (
  mbx_key TEXT NOT NULL,
  seq {{BIGINT}} NOT NULL,
  sealed {{BLOB}} NOT NULL,
  bytes INTEGER NOT NULL,
  expires_at {{BIGINT}} NOT NULL,
  PRIMARY KEY (mbx_key, seq)
);
CREATE INDEX queue_expires ON queue (expires_at);

-- 우편함 번들 슬롯(PC의 Vx 서명 {Qx, valid_from, valid_to, seq}). 릴레이는 검증하지 않고 그대로 돌려준다(폰이 검증).
CREATE TABLE mailbox_bundles (
  mbx_key TEXT PRIMARY KEY,
  sealed {{BLOB}} NOT NULL
);

-- 기기당 우편함 3개 상한용 개수. 어느 우편함인지는 담지 않는다.
CREATE TABLE mailbox_quota (
  device_id TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0
);

-- 메시지 메타 통계(D09 §10 "크기 버킷·시각 7일"): 우편함 ID 없이 (KST 일, 바깥 kind, 크기 버킷) 개수만
CREATE TABLE relay_stats (
  day TEXT NOT NULL,
  kind TEXT NOT NULL,
  size_bucket INTEGER NOT NULL,
  n {{BIGINT}} NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, size_bucket)
);
