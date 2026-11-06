# 계정 서비스 환경 변수

비밀(⚿)은 배포 환경의 KMS·비밀 관리자가 주입한다. 저장소·이미지·CI에 두지 않는다. 값이 없거나 형식이 틀리면 기동하지 않는다(`config_<이름>`).

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `DATABASE_URL` | 둘 중 하나 | `postgres://…` | 운영 DB(PostgreSQL) |
| `SAX_SQLITE_FILE` | 둘 중 하나 | 경로 | 개발·시험용 node:sqlite 파일 |
| `TOKEN_SIGNING_SEED` ⚿ | 예 | hex 64자 | 기기 범위 토큰 서명 키(Ed25519 시드). 공개키는 게이트웨이·릴레이·푸시에 `TOKEN_PUBLIC_KEYS`로 준다 |
| `TOKEN_KID` | 아니오(`k1`) | 문자열 | 토큰 키 ID. 회전 시 새 kid로 바꾸고 검증 쪽에는 둘 다 둔다 |
| `CODE_MAC_KEY` ⚿ | 예 | hex 64자 | 로그인 코드 HMAC 키 |
| `LIMIT_ID_KEY` ⚿ | 예 | hex 64자 | 한도 키(계정·기기 ID) HMAC 비밀. DB에 없다(DB를 읽어도 한도 키를 다시 계산할 수 없음, [CONTRACT §10](../shared/CONTRACT.md)). 바꾸면 진행 중인 한도 창(≤ 1시간)만 처음부터 센다 |
| `ACCOUNT_PUBLIC_ORIGIN` | 예 | `https://…` | DPoP `htu` 검증에 쓰는 공개 origin |
| `WEBAUTHN_RP_ID` | 예 | 도메인 | 패스키 RP ID |
| `WEBAUTHN_ORIGINS` | 예 | 쉼표 구분 origin | 패스키 허용 origin(정확히 일치) |
| `BILLING_RETURN_URL` | 예 | URL | 결제 창이 돌아올 주소 |
| `PG_PROVIDER` | 예 | `mock` | 이 저장소에는 모의 PG만 있다. 다른 값이면 기동하지 않는다 |
| `MOCK_PG_SECRET` ⚿ | 아니오 | 문자열 | 모의 PG 웹훅 서명 비밀(없으면 기동마다 무작위) |
| `MAIL_PROVIDER` | 예 | `mock` | 이 저장소에는 모의 메일만 있다 |
| `INTERNAL_TOKEN` ⚿ | 예 | 문자열(32바이트 이상 권장) | 내부 API(`/internal/v1/…`) 공유 비밀. 릴레이·푸시·게이트웨이와 같은 값 |
| `STOP_HOOK_URLS` | 아니오 | 쉼표 구분 내부 URL | 긴급 정지·폐기를 알릴 릴레이·푸시 서비스 |
| `TRUST_PROXY` | 아니오 | `1` | 앞단 프록시의 `X-Forwarded-For`를 한도 키에 쓴다(IP는 저장하지 않고 당일 솔트 HMAC만, CONTRACT §10) |
| `PORT` / `HOST` | 아니오(`8080` / `0.0.0.0`) | | |
