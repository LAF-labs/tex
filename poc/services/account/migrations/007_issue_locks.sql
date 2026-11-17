-- 계정 서비스 v7: 발급 잠금(ADR-048 결정 7). PC가 여러 대인 계정에서 홈택스 발급은 잠금을 잡은 PC 하나만 들어간다.
-- 잡고 있는 동안만 계정당 한 줄이 있다. 놓으면 지우고, 만료된 줄은 정리(sweep)가 지운다. 무엇을 몇 번 발급했는지는 남지 않는다.
CREATE TABLE issue_locks (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,                  -- 잡은 데스크톱
  hold_id TEXT NOT NULL,                    -- 잡을 때마다 새로 뽑는 값. 갱신·놓기는 이 값으로만
  expires_at {{BIGINT}} NOT NULL            -- 만료(ms). 지났으면 비어 있는 것으로 본다
);
