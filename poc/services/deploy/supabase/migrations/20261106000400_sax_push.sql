-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- push: 서비스 마이그레이션은 스키마 push, 한도 표는 push_limits. 기록은 push.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO push;

-- push/migrations/001_init.sql
-- 푸시 디스패처(D08 §8.1, D09 §4.2): device_id → 암호화된 푸시 토큰뿐. 우편함 ID·계정은 이 경로에 없다. 깨우기 시각은 저장하지 않는다.
CREATE TABLE push_tokens (
  device_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  sealed_token BYTEA NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('push', 1) ON CONFLICT DO NOTHING;

SET search_path TO push_limits;

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

INSERT INTO push.schema_migrations (service, version) VALUES ('limits', 1) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA push, push_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA push, push_limits TO sax_push;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA push, push_limits TO sax_push;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA push, push_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
