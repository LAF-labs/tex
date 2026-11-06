# 릴레이 환경 변수

비밀(⚿)은 클라우드 KMS가 주입하고 90일마다 회전한다. 저장소·이미지·CI에 두지 않는다. 값이 없거나 형식이 틀리면 기동하지 않는다(`config_<이름>`).

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `DATABASE_URL` / `SAX_SQLITE_FILE` | 둘 중 하나 | | 우편함 해시·큐 DB. **계정 DB와 다른 DB**(분리 저장, D08 §8) |
| `DATABASE_POOL_MAX` | 아니오(`10`) | 1~99 | 인스턴스당 PostgreSQL 연결 수. 함수는 `1` |
| `MIGRATE_ON_START` | 아니오(`1`) | `0`·`1` | `0`이면 기동 때 마이그레이션을 하지 않는다(DDL 권한 없는 서비스 역할, [deploy/README](../deploy/README.md) 4절) |
| `RELAY_ROOMS` | 아니오(`0`) | `0`·`1` | **룸 켬**: 1회용 페어링 룸(`/v1/rooms`, WSS 참가, `/internal/v1/rooms/:id/redeem`). 상시 룸 호스트 한 대에서만 `1`(팀장 결정 2026-11-06). 함수 진입점은 늘 끈다 |
| `RELAY_LIVE` | 아니오(`0`) | `0`·`1` | 우편함 라이브 WSS(`/v1/mailboxes/:id/live`). Phase 1은 `0`(HTTPS 큐 폴링만, D08 §8) |
| `QUEUE_KEY` ⚿ | 예 | hex 64자 | 큐 본문·번들 저장 전 봉인 키(AES-256-GCM). 바꾸면 남은 큐(≤ 72시간)는 열리지 않고 버려진다 |
| `LIMIT_ID_KEY` ⚿ | 예 | hex 64자 | 한도 키(계정·기기 ID) HMAC 비밀. DB에 없다(DB를 읽어도 한도 키를 다시 계산할 수 없음, [CONTRACT §10](../shared/CONTRACT.md)). 바꾸면 진행 중인 한도 창(≤ 1시간)만 처음부터 센다 |
| `RELAY_PUBLIC_ORIGIN` | 예 | `https://…` | DPoP `htu` 검증 origin(WSS 업그레이드는 같은 origin + 경로) |
| `TOKEN_PUBLIC_KEYS` | 예 | `kid:base64(32B)[,…]` | 계정 서비스 기기 범위 토큰 공개키 |
| `ACCOUNT_INTERNAL_URL` | 예 | 내부 URL | 기기 상태 조회 |
| `INTERNAL_TOKEN` ⚿ | 예 | 문자열 | 내부 API 공유 비밀(계정 서비스의 정지 훅, 큐 전면 폐기) |
| `TRUST_PROXY` | 아니오 | `1` | 앞단 L4/TLS 프록시 신뢰(레이트리밋 IP HMAC용) |
| `PORT` / `HOST` | 아니오(`8083` / `0.0.0.0`) | | |

계정 서비스의 `STOP_HOOK_URLS`에 이 서비스의 내부 주소를 넣어야 긴급 정지·폐기가 라이브 연결을 즉시 끊는다.
