-- 계정 서비스 v4: 탈퇴(계정 삭제) 7일 유예(D09 §2.2 "계정 세션만 있는 삭제 요청은 7일 유예", 개인정보 보호법 §38④, 처리방침 3항·약관 제15조).
-- 유예가 끝나면 주기 작업이 기기 정지 훅을 부르고 계정 행을 지운다(다른 계정 표는 ON DELETE CASCADE).
ALTER TABLE accounts ADD COLUMN delete_after {{BIGINT}};   -- 탈퇴 예정 시각(ms). NULL이면 요청 없음
