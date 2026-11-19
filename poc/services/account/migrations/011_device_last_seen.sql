-- 계정 서비스 v11: 기기 마지막 접속(2026-11-19 대표: 기기 목록에는 이름과 "YYYY.MM.DD 마지막 접속"만).
-- 기기가 기기 범위 토큰을 받을 때 적는다(10분 안에 다시 받으면 쓰지 않는다). 날짜만 보이므로 이보다 자세할 필요가 없다.
ALTER TABLE devices ADD COLUMN last_seen_at {{BIGINT}};
