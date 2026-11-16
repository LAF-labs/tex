-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/004_billing_key.sql
-- 계정 서비스 v4: 카드 정기결제(빌링키, 토스페이먼츠 자동결제). PG가 매달 알아서 청구하지 않으므로 우리가 갱신일에 청구한다(정리 cron).
-- 빌링키는 BILLING_KEY_SEAL_KEY로 봉인해 저장한다(aad = pg_customer_ref, 다른 행으로 옮겨 붙이지 못함). 카드 번호·유효기간은 PG에만 있다.
-- 모의 PG(웹훅 방식)는 이 컬럼들을 쓰지 않는다.
ALTER TABLE subscriptions ADD COLUMN billing_key_sealed BYTEA;          -- 봉인된 빌링키(없으면 청구하지 않음)
ALTER TABLE subscriptions ADD COLUMN charge_attempts INTEGER NOT NULL DEFAULT 0; -- 이 기간에 확정 실패한 청구 수(주문번호에 들어가 재시도마다 새 주문)
ALTER TABLE subscriptions ADD COLUMN next_charge_at BIGINT;           -- 다음 청구 시도 시각. 청구 중에는 임대 끝 시각(두 번 청구하지 않게)
CREATE INDEX subscriptions_charge_due ON subscriptions (renew_at);

-- account/migrations/005_billing_refund.sql
-- 계정 서비스 v5: 청약철회 환불(결제 후 7일)을 위한 마지막 결제 참조. 결제 키는 PG의 결제 참조 ID다(시크릿 키 없이는 쓸 수 없다).
ALTER TABLE subscriptions ADD COLUMN last_payment_key TEXT;        -- 마지막으로 성공한 청구의 PG 결제 참조(환불하면 지운다)
ALTER TABLE subscriptions ADD COLUMN last_paid_at BIGINT;      -- 그 청구 시각(청약철회 7일 기준)
ALTER TABLE subscriptions ADD COLUMN last_paid_amount INTEGER;     -- 그 청구 금액(원, 부가세 포함)

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 4) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (service, version) VALUES ('account', 5) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
