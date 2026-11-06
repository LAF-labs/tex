# 레지스트리 환경 변수

이 서비스에는 산출물 서명 키의 **공개키만** 들어온다. 루트·패키지·정책·긴급·릴리스 개인 키는 CI 밖 하드웨어 서명 의식에만 있다(ADR-013·028, D09 §8.2). 예외는 투명성 로그 헤드용 온라인 타임스탬프 키(`REGISTRY_LOG_SIGNING_KEY`) 하나다. 값이 없거나 형식이 틀리면 기동하지 않는다(`config_<이름>`).

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `TRUST_ROOT_JSON` | 예 | `{"keyEpoch":1,"keys":{"root":{"<keyId>":"<base64 32B>",…},"package":{…},"policy":{…},"timestamp":{…},"emergency":{…},"release":{…}}}` | 앱에 핀 고정된 공개키와 같은 값. 루트·패키지·정책 3개씩, 나머지 1개씩, 역할 사이 키·keyId 재사용 금지 |
| `REGISTRY_LOG_SIGNING_KEY` ⚿ | 예 | hex 64자 | 투명성 로그 트리 헤드 서명 키(타임스탬프 역할 Ed25519 시드, D09 §8.2). 공개키가 `TRUST_ROOT_JSON`의 `timestamp` 키와 같아야 하고, 다른 역할(루트·패키지·정책·긴급·릴리스) 공개키와 같으면 기동하지 않는다(`config_REGISTRY_LOG_SIGNING_KEY`). 국내 서버 HSM·KMS가 주입한다 |
| `DATABASE_URL` ⚿ | 운영 예 | `postgres://…` | 투명성 로그 저장(PostgreSQL). 개발은 `SAX_SQLITE_FILE`(파일), `REGISTRY_STORE=memory`면 메모리 SQLite |
| `MIGRATE_ON_START` | 아니오(켬) | `0` | `0`이면 기동 때 로그 테이블 마이그레이션을 하지 않는다(배포 절차가 적용) |
| `REGISTRY_ADMIN_TOKEN` ⚿ | 예 | 문자열 | 게시 PUT의 `Authorization: Admin <token>`. **호스팅 쓰기 권한일 뿐 서명 권한이 아니다**(서명 없는 산출물은 이 토큰으로도 올라가지 않는다). KMS 주입·90일 회전 |
| `REGISTRY_DIR` | `REGISTRY_STORE=memory`가 아니면 예 | 경로 | 정적 파일 저장 위치(원자적 tmp+rename 쓰기). 운영은 이 디렉터리를 CDN 원본으로 쓴다 |
| `REGISTRY_STORE` | 아니오 | `memory` | 개발·시험용 메모리 저장소 |
| `TRUST_PROXY` | 아니오 | `1` | 앞단 프록시 신뢰 |
| `PORT` / `HOST` | 아니오(`8082` / `0.0.0.0`) | | |

`keyEpoch`를 올리는 키 회전은 앱 업데이트로 새 `TRUST_ROOT_JSON`을 핀 고정한 뒤에만 한다(ADR-013). 게시 관문은 핀과 다른 `keyEpoch` 산출물을 거부한다.
