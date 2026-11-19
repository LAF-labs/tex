-- 릴레이 v2: 우편함 자리(2026-11-19). PC가 폰을 끊을 때 우편함 지우기가 실패하면 개수(mailbox_quota)가 그대로 남아
-- 폰이 0대인데도 새 우편함을 만들 수 없었다. 자리를 (만든 PC, 연결한 폰)으로 세고, 계정에서 지워졌거나 정지된 폰의 자리는 새로 만들 때 비운다.
-- 우편함 ID는 담지 않는다(우편함과 기기 ID는 같은 테이블에 두지 않는다, D08 §8). mailbox_quota는 더 쓰지 않는다.
CREATE TABLE mailbox_slots (
  owner_dev TEXT NOT NULL,                  -- 우편함을 만든 PC의 기기 ID
  peer_dev TEXT NOT NULL,                   -- 그 우편함으로 이어진 폰의 기기 ID
  PRIMARY KEY (owner_dev, peer_dev)
);
CREATE INDEX mailbox_slots_peer ON mailbox_slots (peer_dev);
