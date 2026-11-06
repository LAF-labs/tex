-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- 서비스별 로그인 역할(비밀번호 없음)과 스키마. 역할 비밀번호는 사용자가 SQL 편집기에서 ALTER ROLE … PASSWORD로 정한다.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sax_account') THEN CREATE ROLE sax_account LOGIN NOINHERIT; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS account;
CREATE SCHEMA IF NOT EXISTS account_limits;
REVOKE ALL ON SCHEMA account, account_limits FROM PUBLIC;
GRANT USAGE ON SCHEMA account, account_limits TO sax_account;
ALTER ROLE sax_account SET search_path = account, account_limits;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sax_gateway') THEN CREATE ROLE sax_gateway LOGIN NOINHERIT; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS gateway;
CREATE SCHEMA IF NOT EXISTS gateway_limits;
REVOKE ALL ON SCHEMA gateway, gateway_limits FROM PUBLIC;
GRANT USAGE ON SCHEMA gateway, gateway_limits TO sax_gateway;
ALTER ROLE sax_gateway SET search_path = gateway, gateway_limits;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sax_relay') THEN CREATE ROLE sax_relay LOGIN NOINHERIT; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS relay;
CREATE SCHEMA IF NOT EXISTS relay_limits;
REVOKE ALL ON SCHEMA relay, relay_limits FROM PUBLIC;
GRANT USAGE ON SCHEMA relay, relay_limits TO sax_relay;
ALTER ROLE sax_relay SET search_path = relay, relay_limits;

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sax_push') THEN CREATE ROLE sax_push LOGIN NOINHERIT; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS push;
CREATE SCHEMA IF NOT EXISTS push_limits;
REVOKE ALL ON SCHEMA push, push_limits FROM PUBLIC;
GRANT USAGE ON SCHEMA push, push_limits TO sax_push;
ALTER ROLE sax_push SET search_path = push, push_limits;
