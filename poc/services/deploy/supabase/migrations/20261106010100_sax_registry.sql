-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- registry: 서비스 마이그레이션은 스키마 registry, 한도 표는 registry_limits. 기록은 registry.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO registry;

-- registry/migrations/001_log.sql
-- 투명성 로그(D09 §8.3, ADR-028, RFC 9162). 공개 산출물의 경로·다이제스트뿐이다(계정·기기·IP·앱 버전 없음).
-- 순번 idx가 PRIMARY KEY라 append가 겹치면 트랜잭션이 실패한다. append는 log_meta 행 잠금 안에서 하나씩 한다.
CREATE TABLE log_entries (
  idx BIGINT PRIMARY KEY,
  entry TEXT NOT NULL,                      -- JCS({v, kind, path, sha256, loggedAt}), 잎 바이트
  leaf_hash TEXT NOT NULL                   -- SHA-256(0x00 ‖ entry) hex
);
CREATE INDEX log_entries_leaf ON log_entries (leaf_hash);
CREATE TABLE log_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tree_size BIGINT NOT NULL,
  head TEXT                                 -- 최신 서명 트리 헤드(JCS)
);
INSERT INTO log_meta (id, tree_size, head) VALUES (1, 0, NULL);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('registry', 1) ON CONFLICT DO NOTHING;

SET search_path TO registry_limits;

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

-- shared/migrations/002_internal_nonces.sql
-- 내부 호출 서명의 1회용 nonce(팀장 결정 2026-11-06 #135 (1)). 무작위 16바이트(b64url)와 만료 시각만. 요청 내용·출처는 없다.
CREATE TABLE int_nonces (
  nonce TEXT PRIMARY KEY,                   -- 보낸 쪽이 만든 무작위 값(재전송 거부)
  expires_at BIGINT NOT NULL            -- 서명 시각 + 60초 + 1ms. 지나면 다음 기록 때 지운다
);
CREATE INDEX int_nonces_expires ON int_nonces (expires_at);

INSERT INTO registry.schema_migrations (service, version) VALUES ('limits', 1) ON CONFLICT DO NOTHING;
INSERT INTO registry.schema_migrations (service, version) VALUES ('limits', 2) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA registry, registry_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA registry, registry_limits TO sax_registry;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA registry, registry_limits TO sax_registry;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA registry, registry_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
