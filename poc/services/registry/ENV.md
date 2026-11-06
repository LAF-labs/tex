# 레지스트리 환경 변수

이 서비스에는 **공개키만** 들어온다. 서명 개인 키(루트·패키지·정책·타임스탬프·긴급·릴리스)는 CI 밖 하드웨어 서명 의식에만 있다(ADR-013·028, D09 §8.2). 값이 없거나 형식이 틀리면 기동하지 않는다(`config_<이름>`).

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `TRUST_ROOT_JSON` | 예 | `{"keyEpoch":1,"keys":{"root":{"<keyId>":"<base64 32B>",…},"package":{…},"policy":{…},"timestamp":{…},"emergency":{…},"release":{…}}}` | 앱에 핀 고정된 공개키와 같은 값. 루트·패키지·정책 3개씩, 나머지 1개씩, 역할 사이 키·keyId 재사용 금지 |
| `REGISTRY_ADMIN_TOKEN` ⚿ | 예 | 문자열 | 게시 PUT의 `Authorization: Admin <token>`. **호스팅 쓰기 권한일 뿐 서명 권한이 아니다**(서명 없는 산출물은 이 토큰으로도 올라가지 않는다). KMS 주입·90일 회전 |
| `REGISTRY_DIR` | `REGISTRY_STORE=memory`가 아니면 예 | 경로 | 정적 파일 저장 위치(원자적 tmp+rename 쓰기). 운영은 이 디렉터리를 CDN 원본으로 쓴다 |
| `REGISTRY_STORE` | 아니오 | `memory` | 개발·시험용 메모리 저장소 |
| `TRUST_PROXY` | 아니오 | `1` | 앞단 프록시 신뢰 |
| `PORT` / `HOST` | 아니오(`8082` / `0.0.0.0`) | | |

`keyEpoch`를 올리는 키 회전은 앱 업데이트로 새 `TRUST_ROOT_JSON`을 핀 고정한 뒤에만 한다(ADR-013). 게시 관문은 핀과 다른 `keyEpoch` 산출물을 거부한다.
