-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/010_key_escrow.sql
-- 계정 서비스 v10: 계정 열쇠 보관(ADR-050, 대표 결정 2026-11-18). 쓰던 PC 없이 로그인한 새 PC가 이메일 인증만으로 계정 열쇠를 받는다.
-- 로그인된 PC가 계정 열쇠(RK)를 계정 서비스의 보관 키(KEY_ESCROW_KEY의 공개키)로 봉인해 맡긴다. 이 표에는 그 봉인문만 있다.
-- 보관 키는 DB에 없다. DB만 새면 열 수 없고, 보관 키와 함께 새면 열린다. 계정당 한 줄이고 시각은 두지 않는다.
CREATE TABLE key_escrow (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  aik_pub TEXT NOT NULL,                    -- 맡길 때의 계정 AIK 공개키(계정의 AIK와 다르면 쓰지 않는다)
  key_pub TEXT NOT NULL,                    -- 봉인에 쓴 보관 키의 공개키(보관 키를 바꾸면 PC가 다시 맡긴다)
  enc TEXT NOT NULL,                        -- HPKE 캡슐(b64 32B)
  ct TEXT NOT NULL                          -- 계정 열쇠 봉인문(b64 48B)
);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 10) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
