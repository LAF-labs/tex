# 계정 서비스 환경 변수

비밀(⚿)은 배포 환경의 KMS·비밀 관리자가 주입한다. 저장소·이미지·CI에 두지 않는다. 값이 없거나 형식이 틀리면 기동하지 않는다(`config_<이름>`).

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `DATABASE_URL` | 둘 중 하나 | `postgres://…?sslmode=verify-full` | 운영 DB(PostgreSQL). 원격은 `sslmode=verify-full`(고정 앵커 검증, `services/shared/src/pg-tls.ts`) |
| `SAX_SQLITE_FILE` | 둘 중 하나 | 경로 | 개발·시험용 node:sqlite 파일 |
| `DATABASE_POOL_MAX` | 아니오(`10`) | 1~99 | 인스턴스당 PostgreSQL 연결 수. 함수는 `1` |
| `MIGRATE_ON_START` | 아니오(`1`) | `0`·`1` | `0`이면 기동 때 마이그레이션을 하지 않는다(DDL 권한 없는 서비스 역할, [deploy/README](../deploy/README.md) 4절) |
| `TOKEN_SIGNING_SEED` ⚿ | 예 | hex 64자 | 기기 범위 토큰 서명 키(Ed25519 시드). 공개키는 게이트웨이·릴레이·푸시에 `TOKEN_PUBLIC_KEYS`로 준다 |
| `TOKEN_KID` | 아니오(`k1`) | 문자열 | 토큰 키 ID. 회전 시 새 kid로 바꾸고 검증 쪽에는 둘 다 둔다 |
| `CODE_MAC_KEY` ⚿ | 예 | hex 64자 | 로그인 코드 HMAC 키 |
| `ACCT_CLAIM_SIGNING_KEY` ⚿ | 아니오(없으면 `GET /v1/acct-claim` 404) | hex 64자 | `acct_claim` 전용 서명 키(Ed25519 시드). 기기 토큰 키·레지스트리 키와 섞지 않는다(`TOKEN_SIGNING_SEED`와 같으면 기동하지 않음). 공개키는 폰 앱에 고정한다. `cd poc && node --conditions=development services/account/src/acct-claim-pubkey-cli.ts < 시드_파일`(시드는 표준 입력으로, 셸 기록에 남기지 않는다) |
| `LIMIT_ID_KEY` ⚿ | 예 | hex 64자 | 한도 키(계정·기기 ID) HMAC 비밀. DB에 없다(DB를 읽어도 한도 키를 다시 계산할 수 없음, [CONTRACT §10](../shared/CONTRACT.md)). 바꾸면 진행 중인 한도 창(≤ 1시간)만 처음부터 센다 |
| `ACCOUNT_PUBLIC_ORIGIN` | 예 | `https://…` | DPoP `htu` 검증에 쓰는 공개 origin |
| `WEBAUTHN_RP_ID` | 예 | 도메인 | 패스키 RP ID |
| `WEBAUTHN_ORIGINS` | 예 | 쉼표 구분 origin | 패스키 허용 origin(정확히 일치) |
| `BILLING_RETURN_URL` | 예 | URL | 결제 창이 돌아올 주소 |
| `PG_PROVIDER` | 예 | `mock` | 이 저장소에는 모의 PG만 있다. 다른 값이면 기동하지 않는다 |
| `MOCK_PG_SECRET` ⚿ | 아니오 | 문자열 | 모의 PG 웹훅 서명 비밀(없으면 기동마다 무작위) |
| `MAIL_PROVIDER` | 예 | `mock` | 이 저장소에는 모의 메일만 있다 |
| `INTERNAL_CALL_KEY` ⚿ | 예 | hex 64자 | 내부 호출 서명 키(HMAC-SHA256: 메서드·경로·본문 SHA-256·시각 ±60초·1회용 nonce, 상수 시간 비교, 팀장 결정 2026-11-06 #135). 서비스·룸 호스트가 같은 값. `TOKEN_SIGNING_SEED`·`ACCT_CLAIM_SIGNING_KEY`와 같으면 기동하지 않는다 |
| `STOP_HOOK_URLS` | 아니오 | 쉼표 구분 내부 URL | 긴급 정지·폐기를 알릴 **다른 호스트**의 릴레이·푸시(서명 호출). 함수 배포에서는 같은 배포 안 푸시를 함수로 부르고 여기에는 룸 호스트만 둔다 |
| `RELAY_INTERNAL_URL` | 아니오 | 내부 URL | 폰 대리 등록 때 페어링 룸 소비를 확인할 릴레이 내부 주소(`/internal/v1/rooms/:id/redeem`, `INTERNAL_CALL_KEY` 서명). 없으면 데스크톱 기기 토큰의 폰 등록은 `404 relay.room_unavailable` |
| `TRUST_PROXY` | 아니오 | `1` | 앞단 프록시의 `X-Forwarded-For`를 한도 키에 쓴다(IP는 저장하지 않고 당일 솔트 HMAC만, CONTRACT §10) |
| `PORT` / `HOST` | 아니오(`8080` / `0.0.0.0`) | | |
