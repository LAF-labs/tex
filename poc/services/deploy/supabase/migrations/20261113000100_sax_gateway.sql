-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- gateway: 서비스 마이그레이션은 스키마 gateway, 한도 표는 gateway_limits. 기록은 gateway.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO gateway;

-- gateway/migrations/002_agent_budget.sql
-- 예상 밖 화면 판정·브라우저 에이전트(page_judge·browser_agent) 실행당 호출 수(GATEWAY.agentPerRun)
ALTER TABLE run_scopes ADD COLUMN agent_calls INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('gateway', 2) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA gateway, gateway_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway, gateway_limits TO sax_gateway;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway, gateway_limits TO sax_gateway;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA gateway, gateway_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
