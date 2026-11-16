-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- gateway: 서비스 마이그레이션은 스키마 gateway, 한도 표는 gateway_limits. 기록은 gateway.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO gateway;

-- gateway/migrations/003_usage_daily.sql
-- 게이트웨이 v3: 하루 사용 금액(체험·유료 일 한도, 사용자 결정 2026-11-16). 하루 = 한국 시간 새벽 4시부터 다음 날 새벽 4시까지(day = KST 날짜, 4시 이전은 전날).
-- 금액은 실제 토큰 × 단가(캐시 적중 따로)로 센다(마이크로 달러). 결제 대사용이 아니라 한도 판정용이고 보존은 이틀이면 된다(정리 cron이 지운다).
CREATE TABLE usage_daily (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  cost_micro_usd BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('gateway', 3) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA gateway, gateway_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway, gateway_limits TO sax_gateway;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway, gateway_limits TO sax_gateway;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA gateway, gateway_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
