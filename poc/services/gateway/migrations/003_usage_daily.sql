-- 게이트웨이 v3: 하루 사용 금액(체험·유료 일 한도, 사용자 결정 2026-11-16). 하루 = 한국 시간 새벽 4시부터 다음 날 새벽 4시까지(day = KST 날짜, 4시 이전은 전날).
-- 금액은 실제 토큰 × 단가(캐시 적중 따로)로 센다(마이크로 달러). 결제 대사용이 아니라 한도 판정용이고 보존은 이틀이면 된다(정리 cron이 지운다).
CREATE TABLE usage_daily (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  cost_micro_usd {{BIGINT}} NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, day)
);
