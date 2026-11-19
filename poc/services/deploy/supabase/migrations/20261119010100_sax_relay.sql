-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- relay: 서비스 마이그레이션은 스키마 relay, 한도 표는 relay_limits. 기록은 relay.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO relay;

-- relay/migrations/002_mailbox_slots.sql
-- 릴레이 v2: 우편함 자리(2026-11-19). PC가 폰을 끊을 때 우편함 지우기가 실패하면 개수(mailbox_quota)가 그대로 남아
-- 폰이 0대인데도 새 우편함을 만들 수 없었다. 자리를 (만든 PC, 연결한 폰)으로 세고, 계정에서 지워졌거나 정지된 폰의 자리는 새로 만들 때 비운다.
-- 우편함 ID는 담지 않는다(우편함과 기기 ID는 같은 테이블에 두지 않는다, D08 §8). mailbox_quota는 더 쓰지 않는다.
CREATE TABLE mailbox_slots (
  owner_dev TEXT NOT NULL,                  -- 우편함을 만든 PC의 기기 ID
  peer_dev TEXT NOT NULL,                   -- 그 우편함으로 이어진 폰의 기기 ID
  PRIMARY KEY (owner_dev, peer_dev)
);
CREATE INDEX mailbox_slots_peer ON mailbox_slots (peer_dev);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('relay', 2) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA relay, relay_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA relay, relay_limits TO sax_relay;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA relay, relay_limits TO sax_relay;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA relay, relay_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
