-- 계정 서비스 v3: 알림 메일 발송 큐(ADR-038 (b) 열거 방지 "같은 응답을 같은 시간에", (d) 잠금 알림 잠금 주기마다 1회).
-- 잠금 알림을 응답 경로에서 뺀다: 잠금과 같은 트랜잭션에서 큐에 넣고, 응답과 따로(요청 뒤 즉시 시도 + 정리 cron) 보낸다.
-- 메일 지연·실패가 로그인 응답 시각·상태를 바꾸지 않고, 실패해도 알림이 사라지지 않는다.
-- 넣지 않는 것: 이메일 주소(보낼 때 accounts에서 읽는다), 메일 본문(종류별 고정 문구), 기기 이름 같은 값.
CREATE TABLE notice_outbox (
  id TEXT PRIMARY KEY,                      -- 무작위
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                       -- 알림 종류(adapters.ts NoticeKind)
  created_at {{BIGINT}} NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,      -- 실패한 발송 시도 수(상한을 넘으면 버리고 이벤트 이름만 남긴다)
  next_at {{BIGINT}} NOT NULL               -- 다음 시도 시각. 보내는 중에는 임대 끝 시각(같은 행을 두 번 보내지 않게)
);
CREATE INDEX notice_outbox_due ON notice_outbox (next_at);
