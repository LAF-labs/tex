# 계정 서비스 데이터

## `common-passwords.txt.gz`

유출·흔한 비밀번호 목록이다(ADR-038 (c), D09 §2.1). 한 줄에 하나이고 gzip이다. 서버는 NFKC 소문자로 비교한다(`src/password.ts` `CommonPasswords`). 외부 호출은 없다.

- **지금 파일은 자리표시다**(흔한 패턴 30개를 손으로 적었다). ADR-038의 "상위 10만 개" 번들은 출처를 정한 뒤 이 파일을 바꾼다(팀장·사용자 승인 대기).
  - 제안 출처: SecLists(MIT) `Passwords/Common-Credentials/10-million-password-list-top-100000.txt`, 커밋 고정본.
  - 바꿀 때 이 문서에 출처 URL·커밋·SHA-256·줄 수를 적는다.
- 10자 미만 항목은 길이 규칙이 먼저 거부하므로 넣어도 쓰이지 않는다.
