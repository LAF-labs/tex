-- 계정 서비스 v2: 이메일·비밀번호 로그인과 자동 로그인(ADR-038, D09 §2.1·§10, 사용자 결정 2026-11-06).
-- 넣지 않는 것: 비밀번호 평문, 페퍼(환경 변수에만), 재설정 코드 평문, 갱신 토큰 평문(해시만).

-- 비밀번호 해시(설정한 계정만). argon2id(HMAC-SHA256(pepper, utf8(NFKC(pw))), salt)
CREATE TABLE pw_creds (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  pw_hash TEXT NOT NULL,                    -- argon2id 출력 32B(base64url)
  salt TEXT NOT NULL,                       -- 16B 무작위(base64url), 계정마다
  params TEXT NOT NULL,                     -- 매개변수 버전 + 페퍼 키 ID(예 a2id-v1:m65536:t3:p1:k1). 낮으면 로그인 성공 때 재해시
  set_at {{BIGINT}} NOT NULL
);

-- 비밀번호 연속 실패·잠금(계정당). 잠금은 비밀번호 수단만 막는다(코드·패스키는 그대로)
CREATE TABLE pw_locks (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  fails INTEGER NOT NULL DEFAULT 0,         -- 이번 주기 연속 실패 횟수(성공·잠금 때 0)
  locked_until {{BIGINT}},                  -- 잠금 끝 시각(ms). NULL이면 잠금 없음
  lock_level INTEGER NOT NULL DEFAULT 0,    -- 지금까지 잠긴 횟수(점증: 15분 × 2^단계, 상한 24시간)
  updated_at {{BIGINT}} NOT NULL            -- 마지막 실패·잠금 시각(조용한 하루 뒤 정리)
);

-- 비밀번호 재설정 코드(이메일 6자리, 10분, 5회). 로그인 코드와 같은 모양이고 표를 나눠 용도를 섞지 않는다
CREATE TABLE reset_codes (
  reset_id_hash TEXT PRIMARY KEY,           -- sha256(resetId): 요청한 창에 결속
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_mac TEXT NOT NULL,                   -- HMAC(CODE_MAC_KEY, "SAX-reset-code-v1" ‖ resetId ‖ code). 평문 없음
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at {{BIGINT}} NOT NULL            -- 발급 + 10분
);
CREATE INDEX reset_codes_account ON reset_codes (account_id);

-- 갱신 토큰(자동 로그인). 쓸 때마다 회전하고, 회전된 토큰이 다시 오면 계정 전체 세션·갱신 토큰 폐기(재사용 감지)
CREATE TABLE refresh_tokens (
  token_hash TEXT PRIMARY KEY,              -- sha256(토큰). 평문 없음
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL,                  -- 회전 계보(처음 로그인 때 무작위)
  parent_hash TEXT,                         -- 회전 계보: 이전 토큰 해시
  auth_method TEXT NOT NULL,                -- 처음 로그인 수단(기록용. 갱신으로 받은 세션은 'refresh')
  issued_at {{BIGINT}} NOT NULL,
  expires_at {{BIGINT}} NOT NULL,           -- 발급 + 30일(30일 미사용 만료: 회전마다 새로 30일)
  rotated_at {{BIGINT}}                     -- NULL = 현재 토큰. 값이 있으면 이미 회전됨(다시 오면 재사용)
);
CREATE INDEX refresh_tokens_account ON refresh_tokens (account_id);
CREATE INDEX refresh_tokens_family ON refresh_tokens (family_id);

-- 세션: 로그인 방식에 password·refresh를 더하고 인증 시각(auth_at)을 둔다. CHECK를 바꾸려면 표를 다시 만든다(SQLite·PostgreSQL 공통 문법).
-- 세션 수명은 코드 상수(ACCOUNT.sessionTtlMs, 1시간)다. 기존 세션은 그대로 옮긴다(만료 시각 유지, auth_at = created_at).
CREATE TABLE sessions_v2 (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('email_code', 'passkey', 'password', 'refresh')),
  created_at {{BIGINT}} NOT NULL,
  auth_at {{BIGINT}} NOT NULL,              -- 실제 인증 시각. 루프백 교환 세션은 원래 세션 값을 잇는다(최근 로그인 판정: 비밀번호 설정·삭제)
  expires_at {{BIGINT}} NOT NULL
);
INSERT INTO sessions_v2 (token_hash, account_id, auth_method, created_at, auth_at, expires_at) SELECT token_hash, account_id, auth_method, created_at, created_at, expires_at FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_v2 RENAME TO sessions;
CREATE INDEX sessions_account ON sessions (account_id);

-- 루프백 인가 코드: 원래 세션의 인증 시각(교환 세션이 잇는다). 기존 코드(60초)는 NULL = 0으로 본다
ALTER TABLE oauth_codes ADD COLUMN auth_at {{BIGINT}};
