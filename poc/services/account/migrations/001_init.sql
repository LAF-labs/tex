-- 계정·구독 서비스 스키마 v1 (D09 §2·§2.1·§2.2·§10). 저장 컬럼은 services/account/README.md의 가시성 표와 1:1로 맞춘다.
-- 넣지 않는 것: 비밀·RK 파생 키·사업자번호 평문·평문 IP·로그인 코드 평문·결제 수단 정보(PG 보관).

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                      -- 서버 발급 무작위 UUID
  email TEXT NOT NULL UNIQUE,               -- 소문자 정규화
  status TEXT NOT NULL CHECK (status IN ('active', 'frozen')),
  created_at {{BIGINT}} NOT NULL,           -- 가입 시각(ms)
  last_login_at {{BIGINT}},                 -- 마지막 로그인 시각(ms)
  aik_pub TEXT,                             -- 계정 신원 키 공개키(표준 base64 32B), 첫 데스크톱이 1회 고정
  aik_pinned_at {{BIGINT}},
  device_list_version INTEGER NOT NULL DEFAULT 0,
  device_list_json TEXT,                    -- 마지막 AIK 서명 기기 목록(보관·중계만, 신뢰 앵커 아님 C-01)
  last_biz_change_at {{BIGINT}}             -- 사업자 HMAC 재바인딩·바인딩된 슬롯 삭제 시각(90일 규칙, B-28)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,              -- sha256(세션 토큰). 토큰 평문은 저장하지 않는다
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  auth_method TEXT NOT NULL CHECK (auth_method IN ('email_code', 'passkey')),
  created_at {{BIGINT}} NOT NULL,
  expires_at {{BIGINT}} NOT NULL
);

CREATE TABLE login_codes (
  login_id_hash TEXT PRIMARY KEY,           -- sha256(loginId): 요청한 앱·브라우저 세션에 결속(C-30)
  email TEXT NOT NULL,
  code_mac TEXT NOT NULL,                   -- HMAC(CODE_MAC_KEY, loginId ‖ code). 코드 평문 없음
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at {{BIGINT}} NOT NULL            -- 발급 + 10분
);

CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,               -- sha256(인가 코드), 1회용, 60초
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  auth_method TEXT NOT NULL,
  client_id TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,               -- 루프백만(RFC 8252 §7.3)
  code_challenge TEXT NOT NULL,             -- PKCE S256
  expires_at {{BIGINT}} NOT NULL
);

CREATE TABLE passkeys (
  credential_id TEXT PRIMARY KEY,           -- base64url
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL,                 -- SPKI DER base64(공개키만)
  alg INTEGER NOT NULL,                     -- COSE alg(-7 ES256, -8 EdDSA)
  sign_count {{BIGINT}} NOT NULL,
  created_at {{BIGINT}} NOT NULL
);

CREATE TABLE webauthn_challenges (
  challenge_hash TEXT PRIMARY KEY,
  account_id TEXT,                          -- 등록: 세션 계정, 로그인: NULL(사용자 확인 가능 자격 증명)
  kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
  expires_at {{BIGINT}} NOT NULL            -- 5분
);

CREATE TABLE devices (
  device_id TEXT PRIMARY KEY,               -- 기기가 만든 UUIDv4
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('desktop', 'mobile')),
  platform TEXT NOT NULL CHECK (platform IN ('windows', 'macos', 'ios', 'android')),
  name TEXT NOT NULL,                       -- 사용자가 붙인 기기 이름(40자 이내)
  sx TEXT NOT NULL,                         -- Noise 정적 공개키(base64)
  vx TEXT NOT NULL,                         -- 서명 공개키(base64). 기기 범위 토큰 cnf
  registered_at {{BIGINT}} NOT NULL,
  attest_signal TEXT NOT NULL DEFAULT 'none', -- App Attest·Play Integrity 신호(Phase 1: none)
  state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'suspended', 'revoked')),
  email_hold_until {{BIGINT}},              -- 이메일만으로 추가한 기기의 72시간 대기 끝(D09 §2.2 (b))
  delete_after {{BIGINT}},                  -- 삭제 유예 끝(7일). NULL이면 유예 없음
  revoke_record TEXT                        -- AIK 서명 폐기 레코드(JSON). 폐기 뒤에는 이것만 의미가 있다
);
CREATE INDEX devices_account ON devices (account_id);

CREATE TABLE device_events (                -- 30일 등록·해제 이력 상한(C-32). 시각 대신 KST 일
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('add', 'remove')),
  day TEXT NOT NULL
);
CREATE INDEX device_events_account ON device_events (account_id);

CREATE TABLE profile_slots (
  slot_token TEXT PRIMARY KEY,              -- 계정별 무작위. 번호·종류 의미 없음(C-09)
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  biz_hmac TEXT,                            -- HMAC(K_idx, "SAX-bizno-v1" ‖ bizNo)[:16] hex. 사업자번호 평문 없음
  biz_bound_at {{BIGINT}}
);
CREATE INDEX profile_slots_account ON profile_slots (account_id);

CREATE TABLE subscriptions (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan TEXT NOT NULL CHECK (plan IN ('standard')),   -- 9,900원 한 플랜(ADR-034)
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'past_due', 'canceled')),
  period TEXT NOT NULL CHECK (period IN ('month')),
  renew_at {{BIGINT}},
  pg_customer_ref TEXT NOT NULL UNIQUE      -- 우리가 만든 불투명 참조(결제 수단 정보는 PG 보관)
);

CREATE TABLE consents (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  at {{BIGINT}} NOT NULL,
  PRIMARY KEY (account_id, version)
);
