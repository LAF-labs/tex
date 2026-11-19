-- 계정 서비스 v10: 계정 열쇠 보관(ADR-050, 대표 결정 2026-11-18). 쓰던 PC 없이 로그인한 새 PC가 이메일 인증만으로 계정 열쇠를 받는다.
-- 로그인된 PC가 계정 열쇠(RK)를 계정 서비스의 보관 키(KEY_ESCROW_KEY의 공개키)로 봉인해 맡긴다. 이 표에는 그 봉인문만 있다.
-- 보관 키는 DB에 없다. DB만 새면 열 수 없고, 보관 키와 함께 새면 열린다. 계정당 한 줄이고 시각은 두지 않는다.
CREATE TABLE key_escrow (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  aik_pub TEXT NOT NULL,                    -- 맡길 때의 계정 AIK 공개키(계정의 AIK와 다르면 쓰지 않는다)
  key_pub TEXT NOT NULL,                    -- 봉인에 쓴 보관 키의 공개키(보관 키를 바꾸면 PC가 다시 맡긴다)
  enc TEXT NOT NULL,                        -- HPKE 캡슐(b64 32B)
  ct TEXT NOT NULL                          -- 계정 열쇠 봉인문(b64 48B)
);
