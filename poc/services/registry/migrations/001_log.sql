-- 투명성 로그(D09 §8.3, ADR-028, RFC 9162). 공개 산출물의 경로·다이제스트뿐이다(계정·기기·IP·앱 버전 없음).
-- 순번 idx가 PRIMARY KEY라 append가 겹치면 트랜잭션이 실패한다. append는 log_meta 행 잠금 안에서 하나씩 한다.
CREATE TABLE log_entries (
  idx {{BIGINT}} PRIMARY KEY,
  entry TEXT NOT NULL,                      -- JCS({v, kind, path, sha256, loggedAt}), 잎 바이트
  leaf_hash TEXT NOT NULL                   -- SHA-256(0x00 ‖ entry) hex
);
CREATE INDEX log_entries_leaf ON log_entries (leaf_hash);
CREATE TABLE log_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tree_size {{BIGINT}} NOT NULL,
  head TEXT                                 -- 최신 서명 트리 헤드(JCS)
);
INSERT INTO log_meta (id, tree_size, head) VALUES (1, 0, NULL);
