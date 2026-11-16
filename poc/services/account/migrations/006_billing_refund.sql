-- 계정 서비스 v6: 청약철회 환불(결제 후 7일)을 위한 마지막 결제 참조. 결제 키는 PG의 결제 참조 ID다(시크릿 키 없이는 쓸 수 없다).
ALTER TABLE subscriptions ADD COLUMN last_payment_key TEXT;        -- 마지막으로 성공한 청구의 PG 결제 참조(환불하면 지운다)
ALTER TABLE subscriptions ADD COLUMN last_paid_at {{BIGINT}};      -- 그 청구 시각(청약철회 7일 기준)
ALTER TABLE subscriptions ADD COLUMN last_paid_amount INTEGER;     -- 그 청구 금액(원, 부가세 포함)
ALTER TABLE subscriptions ADD COLUMN trial_notice_at {{BIGINT}};   -- 체험 → 첫 결제 전환 안내(7일 전)를 보낸 시각(한 번만)
