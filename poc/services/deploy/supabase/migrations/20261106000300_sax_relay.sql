-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- relay: 서비스 마이그레이션은 스키마 relay, 한도 표는 relay_limits. 기록은 relay.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO relay;

-- relay/migrations/001_init.sql
-- 릴레이(D08 §8, D09 §4). 우편함 ID·능력 토큰은 PC가 만든 32B 난수이고 여기에는 SHA-256 해시만 둔다.
-- 계정·기기 ID와 우편함은 같은 행·같은 테이블에 없다(조인 불가, D08 §8 "분리 저장"). 큐는 이미 E2E 암호문이고 저장 전 한 번 더 봉인한다.
CREATE TABLE mailboxes (
  mbx_key TEXT PRIMARY KEY,
  read_hash TEXT NOT NULL,
  write_hash TEXT NOT NULL,
  next_seq BIGINT NOT NULL DEFAULT 1
);

-- 오프라인 의도 봉투 큐(폰 → PC). ACK 또는 72시간 만료로 지운다.
CREATE TABLE queue (
  mbx_key TEXT NOT NULL,
  seq BIGINT NOT NULL,
  sealed BYTEA NOT NULL,
  bytes INTEGER NOT NULL,
  expires_at BIGINT NOT NULL,
  PRIMARY KEY (mbx_key, seq)
);
CREATE INDEX queue_expires ON queue (expires_at);

-- 우편함 번들 슬롯(PC의 Vx 서명 {Qx, valid_from, valid_to, seq}). 릴레이는 검증하지 않고 그대로 돌려준다(폰이 검증).
CREATE TABLE mailbox_bundles (
  mbx_key TEXT PRIMARY KEY,
  sealed BYTEA NOT NULL
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
  n BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind, size_bucket)
);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('relay', 1) ON CONFLICT DO NOTHING;

SET search_path TO relay_limits;

-- shared/migrations/001_limits.sql
-- 다중 인스턴스 한도(팀장 결정 2026-11-05 (가)): 카운터와 당일 솔트를 DB에 둔다. 평문 IP·이메일·계정·기기 ID는 없다(키는 당일 솔트 HMAC).
-- Supabase에서는 별도 스키마(함수 역할만 읽기·쓰기)로 옮겨 둔다(supabase/migrations 내보내기 PR).
CREATE TABLE lim_salts (
  label TEXT NOT NULL,                      -- 솔트 용도(ip·email·acct·dev 등 고정 문자열)
  day TEXT NOT NULL,                        -- KST 날짜(YYYY-MM-DD). 날짜가 바뀌면 지난 행을 지운다
  salt BYTEA NOT NULL,                   -- 32바이트 무작위. 당일만 존재(지난 날 HMAC 재계산 불가)
  PRIMARY KEY (label, day)
);

CREATE TABLE lim_windows (
  k TEXT PRIMARY KEY,                       -- 창 길이 | 용도:당일 솔트 HMAC
  start_ms BIGINT NOT NULL,             -- 고정 창 시작 시각(ms)
  n INTEGER NOT NULL,                       -- 창 안 횟수(한도 + 1에서 멈춤)
  expires_at BIGINT NOT NULL            -- start_ms + 창 길이. 지나면 sweep이 지운다
);
CREATE INDEX lim_windows_expires ON lim_windows (expires_at);

INSERT INTO relay.schema_migrations (service, version) VALUES ('limits', 1) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA relay, relay_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA relay, relay_limits TO sax_relay;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA relay, relay_limits TO sax_relay;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA relay, relay_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
