-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/007_issue_locks.sql
-- 계정 서비스 v7: 발급 잠금(ADR-048 결정 7). PC가 여러 대인 계정에서 홈택스 발급은 잠금을 잡은 PC 하나만 들어간다.
-- 잡고 있는 동안만 계정당 한 줄이 있다. 놓으면 지우고, 만료된 줄은 정리(sweep)가 지운다. 무엇을 몇 번 발급했는지는 남지 않는다.
CREATE TABLE issue_locks (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,                  -- 잡은 데스크톱
  hold_id TEXT NOT NULL,                    -- 잡을 때마다 새로 뽑는 값. 갱신·놓기는 이 값으로만
  expires_at BIGINT NOT NULL            -- 만료(ms). 지났으면 비어 있는 것으로 본다
);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 7) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
