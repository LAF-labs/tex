-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/011_device_last_seen.sql
-- 계정 서비스 v11: 기기 마지막 접속(2026-11-19 대표: 기기 목록에는 이름과 "YYYY.MM.DD 마지막 접속"만).
-- 기기가 기기 범위 토큰을 받을 때 적는다(10분 안에 다시 받으면 쓰지 않는다). 날짜만 보이므로 이보다 자세할 필요가 없다.
ALTER TABLE devices ADD COLUMN last_seen_at BIGINT;

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 11) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
