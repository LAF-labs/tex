-- 계정 서비스 v5: 카드 정기결제(빌링키, 토스페이먼츠 자동결제). PG가 매달 알아서 청구하지 않으므로 우리가 갱신일에 청구한다(정리 cron).
-- 빌링키는 BILLING_KEY_SEAL_KEY로 봉인해 저장한다(aad = pg_customer_ref, 다른 행으로 옮겨 붙이지 못함). 카드 번호·유효기간은 PG에만 있다.
-- 모의 PG(웹훅 방식)는 이 컬럼들을 쓰지 않는다.
ALTER TABLE subscriptions ADD COLUMN billing_key_sealed {{BLOB}};          -- 봉인된 빌링키(없으면 청구하지 않음)
ALTER TABLE subscriptions ADD COLUMN charge_attempts INTEGER NOT NULL DEFAULT 0; -- 이 기간에 확정 실패한 청구 수(주문번호에 들어가 재시도마다 새 주문)
ALTER TABLE subscriptions ADD COLUMN next_charge_at {{BIGINT}};           -- 다음 청구 시도 시각. 청구 중에는 임대 끝 시각(두 번 청구하지 않게)
CREATE INDEX subscriptions_charge_due ON subscriptions (renew_at);
