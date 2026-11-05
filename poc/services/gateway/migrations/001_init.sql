-- 모델 게이트웨이(D09 §3 계량 분리 C-23). 요청·응답 본문을 담는 컬럼은 없다.
-- (1) 결제 레코드: 계정·월·토큰·비용만
CREATE TABLE usage_monthly (
  account_id TEXT NOT NULL,
  month TEXT NOT NULL,
  input_tokens {{BIGINT}} NOT NULL DEFAULT 0,
  output_tokens {{BIGINT}} NOT NULL DEFAULT 0,
  cost_micro_usd {{BIGINT}} NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, month)
);

-- (3) 호출 단위 계정 연결 기록: 결제 대사용 35일만
CREATE TABLE call_records (
  call_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  at {{BIGINT}} NOT NULL,
  surface TEXT NOT NULL,
  input_tokens {{BIGINT}} NOT NULL,
  output_tokens {{BIGINT}} NOT NULL
);
CREATE INDEX call_records_at ON call_records (at);

-- (2) 운영 통계: 계정·기기 ID 없이 (KST 일, 번들·툴셋, 결과)
CREATE TABLE ops_stats (
  day TEXT NOT NULL,
  surface TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n {{BIGINT}} NOT NULL DEFAULT 0,
  latency_ms_sum {{BIGINT}} NOT NULL DEFAULT 0,
  PRIMARY KEY (day, surface, outcome)
);

-- 실행당 예산(runToken 범위). 범위 키는 HMAC(계정·범위 ID)라 runId·chatSessionId 원문이 없다.
CREATE TABLE run_scopes (
  scope_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  l1 INTEGER NOT NULL DEFAULT 0,
  l2_calls INTEGER NOT NULL DEFAULT 0,
  l2_turns INTEGER NOT NULL DEFAULT 0,
  expires_at {{BIGINT}} NOT NULL
);
