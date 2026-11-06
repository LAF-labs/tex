-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- gateway: 서비스 마이그레이션은 스키마 gateway, 한도 표는 gateway_limits. 기록은 gateway.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO gateway;

-- gateway/migrations/001_init.sql
-- 모델 게이트웨이(D09 §3 계량 분리 C-23). 요청·응답 본문을 담는 컬럼은 없다.
-- (1) 결제 레코드: 계정·월·토큰·비용만
CREATE TABLE usage_monthly (
  account_id TEXT NOT NULL,
  month TEXT NOT NULL,
  input_tokens BIGINT NOT NULL DEFAULT 0,
  output_tokens BIGINT NOT NULL DEFAULT 0,
  cost_micro_usd BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

-- (3) 호출 단위 계정 연결 기록: 결제 대사용 35일만
CREATE TABLE call_records (
  call_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  at BIGINT NOT NULL,
  surface TEXT NOT NULL,
  input_tokens BIGINT NOT NULL,
  output_tokens BIGINT NOT NULL
);
CREATE INDEX call_records_at ON call_records (at);

-- (2) 운영 통계: 계정·기기 ID 없이 (KST 일, 번들·툴셋, 결과)
CREATE TABLE ops_stats (
  day TEXT NOT NULL,
  surface TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n BIGINT NOT NULL DEFAULT 0,
  latency_ms_sum BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, surface, outcome)
);

-- 실행당 예산(runToken 범위). 범위 키는 HMAC(계정·범위 ID)라 runId·chatSessionId 원문이 없다.
CREATE TABLE run_scopes (
  scope_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  l1 INTEGER NOT NULL DEFAULT 0,
  l2_calls INTEGER NOT NULL DEFAULT 0,
  l2_turns INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('gateway', 1) ON CONFLICT DO NOTHING;

SET search_path TO gateway_limits;

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

INSERT INTO gateway.schema_migrations (service, version) VALUES ('limits', 1) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA gateway, gateway_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway, gateway_limits TO sax_gateway;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway, gateway_limits TO sax_gateway;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA gateway, gateway_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
