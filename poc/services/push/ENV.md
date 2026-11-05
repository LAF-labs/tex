# 푸시 디스패처 환경 변수

비밀(⚿)은 클라우드 KMS가 주입하고 저장소·이미지·CI에 두지 않는다(절대 규칙 ⑥). Phase 1에는 실제 푸시를 보내지 않는다: 기본 `PUSH_PROVIDER=mock`, 실기기 시험은 `sandbox`(APNs 샌드박스 주소만 허용)로만.

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `DATABASE_URL` / `SAX_SQLITE_FILE` | 둘 중 하나 | | 푸시 토큰 DB. 릴레이·계정 DB와 분리 |
| `PUSH_TOKEN_KEY` ⚿ | 예 | hex 64자 | 푸시 토큰 봉인 키("별도 키", D09 §4.2) |
| `PUSH_PUBLIC_ORIGIN` | 예 | `https://…` | DPoP `htu` 검증 origin |
| `TOKEN_PUBLIC_KEYS` | 예 | `kid:base64(32B)[,…]` | 계정 서비스 기기 범위 토큰 공개키 |
| `ACCOUNT_INTERNAL_URL` | 예 | 내부 URL | 기기 상태 조회(깨울 폰이 같은 계정의 활성 폰인지) |
| `INTERNAL_TOKEN` ⚿ | 예 | 문자열 | 내부 API 공유 비밀(정지 훅) |
| `PUSH_PROVIDER` | 아니오(`mock`) | `mock` \| `sandbox` | |
| `APNS_TEAM_ID` / `APNS_KEY_ID` / `APNS_TOPIC` | sandbox | | APNs 제공자 토큰·번들 ID |
| `APNS_P8` ⚿ | sandbox | PEM | APNs 인증 키(.p8) |
| `APNS_ORIGIN` | 아니오 | `https://api.sandbox.push.apple.com`만 | Phase 1은 운영 주소로 기동 거부 |
| `FCM_PROJECT_ID` | sandbox | | |
| `FCM_SERVICE_ACCOUNT_JSON` ⚿ | sandbox | JSON | 서비스 계정(`client_email`·`private_key`·`token_uri`) |
| `TRUST_PROXY` | 아니오 | `1` | |
| `PORT` / `HOST` | 아니오(`8084` / `0.0.0.0`) | | |

계정 서비스의 `STOP_HOOK_URLS`에 이 서비스의 내부 주소를 넣어야 긴급 정지·폐기 때 푸시 토큰이 즉시 지워진다.
