-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/003_notice_outbox.sql
-- 계정 서비스 v3: 알림 메일 발송 큐(ADR-038 (b) 열거 방지 "같은 응답을 같은 시간에", (d) 잠금 알림 잠금 주기마다 1회).
-- 잠금 알림을 응답 경로에서 뺀다: 잠금과 같은 트랜잭션에서 큐에 넣고, 응답과 따로(요청 뒤 즉시 시도 + 정리 cron) 보낸다.
-- 메일 지연·실패가 로그인 응답 시각·상태를 바꾸지 않고, 실패해도 알림이 사라지지 않는다.
-- 넣지 않는 것: 이메일 주소(보낼 때 accounts에서 읽는다), 메일 본문(종류별 고정 문구), 기기 이름 같은 값.
CREATE TABLE notice_outbox (
  id TEXT PRIMARY KEY,                      -- 무작위
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- 알림 종류(adapters.ts NoticeKind)
  created_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,      -- 실패한 발송 시도 수(상한을 넘으면 버리고 이벤트 이름만 남긴다)
  next_at BIGINT NOT NULL               -- 다음 시도 시각. 보내는 중에는 임대 끝 시각(같은 행을 두 번 보내지 않게)
);
CREATE INDEX notice_outbox_due ON notice_outbox (next_at);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 3) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
