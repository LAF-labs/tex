-- 계정 서비스 v9: 계정 공유 기록(ADR-048 결정 5, D07 §10). 계정의 PC와 폰이 발급 기록·거래처·맡긴 일을 같이 쓴다.
-- 서버는 줄의 종류·순번·시각·크기·올린 기기와 맡긴 일의 상태만 본다. 내용(sealed)은 계정 열쇠에서 나온 키로 봉인한 암호문이라 열 수 없다.
CREATE TABLE share_heads (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  next_seq {{BIGINT}} NOT NULL,             -- 다음 줄이 받을 순번
  epoch INTEGER NOT NULL                    -- 지금까지 본 가장 높은 세대(기기를 끊으면 오른다). 더 낮은 세대로 쓴 줄은 받지 않는다
);
CREATE TABLE share_rows (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seq {{BIGINT}} NOT NULL,                  -- 계정 안의 순번(1부터). 지운 줄의 번호는 다시 쓰지 않는다
  row_id TEXT NOT NULL,                     -- 올린 기기가 뽑은 무작위 id. 같은 줄을 두 번 올려도 한 줄이다
  kind TEXT NOT NULL,                       -- issue | party | task | task_result
  epoch INTEGER NOT NULL,                   -- 이 줄을 봉인한 키의 세대
  device_id TEXT NOT NULL,                  -- 올린 기기
  task_id TEXT,                             -- 맡긴 일과 그 결과 줄만: 일의 줄 id(끝난 일을 지울 때 같이 지운다)
  sealed TEXT NOT NULL,                     -- 줄 내용의 암호문(b64url). 버킷 크기로 패딩돼 있다
  created_at {{BIGINT}} NOT NULL,
  PRIMARY KEY (account_id, seq)
);
CREATE UNIQUE INDEX share_rows_id ON share_rows (account_id, row_id);
CREATE INDEX share_rows_task ON share_rows (account_id, task_id);
CREATE TABLE share_tasks (
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,                    -- 맡긴 일 줄의 row_id
  state TEXT NOT NULL,                      -- open | claimed | done | cancelled
  created_by TEXT NOT NULL,                 -- 맡긴 기기
  claimed_by TEXT,                          -- 맡은 데스크톱(한 번에 하나)
  claim_expires_at {{BIGINT}},              -- 맡김 만료. 지나면 다른 데스크톱이 다시 맡을 수 있다
  created_at {{BIGINT}} NOT NULL,
  updated_at {{BIGINT}} NOT NULL,
  PRIMARY KEY (account_id, task_id)
);
CREATE INDEX share_tasks_claimed ON share_tasks (claimed_by);
