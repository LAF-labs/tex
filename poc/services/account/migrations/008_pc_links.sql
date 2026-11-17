-- 계정 서비스 v8: 새 PC 연결 우편함(ADR-048 결정 3, D08 §4.3). 신청 하나에 메시지 넷(hello·challenge·reveal·grant).
-- 서버는 공개키·난수·AIK 서명 목록·인증서와 RK 봉인문(HPKE, 새 PC의 연결 전용 키로만 열린다)만 본다. 끝나면 지우고, 7일이 지나면 정리가 지운다.
CREATE TABLE pc_links (
  device_id TEXT PRIMARY KEY,               -- 새 PC(신청 중인 데스크톱)
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hello TEXT NOT NULL,                      -- m1(JSON): 새 PC 공개키와 약속 해시
  challenge TEXT,                           -- m2(JSON): 승인하는 PC의 기기 ID·AIK 공개키·난수
  reveal TEXT,                              -- m3(JSON): 새 PC 난수
  grant_msg TEXT,                           -- m4(JSON): 인증서·기기 목록·RK 봉인문
  created_at {{BIGINT}} NOT NULL,
  expires_at {{BIGINT}} NOT NULL
);
CREATE INDEX pc_links_account ON pc_links (account_id);
