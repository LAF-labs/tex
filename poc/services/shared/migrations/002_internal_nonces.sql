-- 내부 호출 서명의 1회용 nonce(팀장 결정 2026-11-06 #135 (1)). 무작위 16바이트(b64url)와 만료 시각만. 요청 내용·출처는 없다.
CREATE TABLE int_nonces (
  nonce TEXT PRIMARY KEY,                   -- 보낸 쪽이 만든 무작위 값(재전송 거부)
  expires_at {{BIGINT}} NOT NULL            -- 서명 시각 + 60초 + 1ms. 지나면 다음 기록 때 지운다
);
CREATE INDEX int_nonces_expires ON int_nonces (expires_at);
