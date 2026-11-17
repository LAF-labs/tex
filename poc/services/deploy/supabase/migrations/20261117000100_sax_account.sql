-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/007_issue_locks.sql
-- 계정 서비스 v7: 발급 잠금(ADR-048 결정 7). PC가 여러 대인 계정에서 홈택스 발급은 잠금을 잡은 PC 하나만 들어간다.
-- 잡고 있는 동안만 계정당 한 줄이 있다. 놓으면 지우고, 만료된 줄은 정리(sweep)가 지운다. 무엇을 몇 번 발급했는지는 남지 않는다.
CREATE TABLE issue_locks (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,                  -- 잡은 데스크톱
  hold_id TEXT NOT NULL,                    -- 잡을 때마다 새로 뽑는 값. 갱신·놓기는 이 값으로만
  expires_at BIGINT NOT NULL            -- 만료(ms). 지났으면 비어 있는 것으로 본다
);

-- account/migrations/008_pc_links.sql
-- 계정 서비스 v8: 새 PC 연결 우편함(ADR-048 결정 3, D08 §4.3). 신청 하나에 메시지 넷(hello·challenge·reveal·grant).
-- 서버는 공개키·난수·AIK 서명 목록·인증서와 RK 봉인문(HPKE, 새 PC의 연결 전용 키로만 열린다)만 본다. 끝나면 지우고, 7일이 지나면 정리가 지운다.
CREATE TABLE pc_links (
  device_id TEXT PRIMARY KEY,               -- 새 PC(신청 중인 데스크톱)
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hello TEXT NOT NULL,                      -- m1(JSON): 새 PC 공개키와 약속 해시
  challenge TEXT,                           -- m2(JSON): 승인하는 PC의 기기 ID·AIK 공개키·난수
  reveal TEXT,                              -- m3(JSON): 새 PC 난수
  grant_msg TEXT,                           -- m4(JSON): 인증서·기기 목록·RK 봉인문
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX pc_links_account ON pc_links (account_id);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 7) ON CONFLICT DO NOTHING;
INSERT INTO schema_migrations (service, version) VALUES ('account', 8) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
