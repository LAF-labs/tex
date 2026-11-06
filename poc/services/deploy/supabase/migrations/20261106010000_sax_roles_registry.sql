-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- 서비스별 로그인 역할(비밀번호 없음)과 스키마. 역할 비밀번호는 사용자가 SQL 편집기에서 ALTER ROLE … PASSWORD로 정한다.

DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sax_registry') THEN CREATE ROLE sax_registry LOGIN NOINHERIT; END IF; END $$;
CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS registry_limits;
REVOKE ALL ON SCHEMA registry, registry_limits FROM PUBLIC;
GRANT USAGE ON SCHEMA registry, registry_limits TO sax_registry;
ALTER ROLE sax_registry SET search_path = registry, registry_limits;
