-- 푸시 디스패처(D08 §8.1, D09 §4.2): device_id → 암호화된 푸시 토큰뿐. 우편함 ID·계정은 이 경로에 없다. 깨우기 시각은 저장하지 않는다.
CREATE TABLE push_tokens (
  device_id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  sealed_token {{BLOB}} NOT NULL
);
