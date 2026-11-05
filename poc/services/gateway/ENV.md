# 게이트웨이 환경 변수

비밀(⚿)은 클라우드 KMS가 주입하고 90일마다 회전한다(D09 §3 키 관리). 저장소·이미지·CI에 두지 않는다. 레지스트리 서명 키는 여기에 두지 않는다. 값이 없거나 형식이 틀리면 기동하지 않는다(`config_<이름>`).

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `DATABASE_URL` / `SAX_SQLITE_FILE` | 둘 중 하나 | | 계량 DB |
| `GATEWAY_PUBLIC_ORIGIN` | 예 | `https://…` | DPoP `htu` 검증 origin |
| `TOKEN_PUBLIC_KEYS` | 예 | `kid:base64(32B)[,…]` | 계정 서비스 기기 범위 토큰 공개키 |
| `ACCOUNT_INTERNAL_URL` | 예 | 내부 URL | 기기 상태 조회·자동 정지 |
| `INTERNAL_TOKEN` ⚿ | 예 | 문자열 | 내부 API 공유 비밀 |
| `RUN_TOKEN_SEED` ⚿ | 예 | hex 64자 | runToken 서명 키(Ed25519 시드) |
| `CACHE_KEY_SECRET` ⚿ | 예 | hex 64자 | `prompt_cache_key` HMAC 비밀 |
| `SAFETY_ID_KEY` ⚿ | 예 | hex 64자 | `K_sid`(safety_identifier) |
| `REPLAY_TAG_KEY` ⚿ | 예 | hex 64자 | replay 태그 키(`gw_key`). 바꾸면 진행 중인 L2 대화의 replay가 무효가 된다 |
| `RUN_SCOPE_KEY` ⚿ | 예 | hex 64자 | 실행 예산 범위 해시 키 |
| `GW_PROVIDER` | 예 | `openai-compat` \| `upstage-systemone` \| `mock` | 공급사 어댑터 |
| `PROVIDER_BASE_URL` | openai-compat | `https://…` | 공급사 주소 |
| `PROVIDER_API_KEY` ⚿ | openai-compat | | 공급사 API 키 |
| `MODEL_DECIDE` / `MODEL_RESPOND` | 예 | 모델 ID | 판정·응답 모델(클라이언트가 정하지 않는다) |
| `GW_MONTHLY_TOKENS` | 아니오(3,000,000) | 양의 정수(아니면 기동 거부) | 계정 월 토큰 한도(100% L2 중단, 200% 이후 안전 판정만 계정당 분당 6회) |
| `GW_PRICES_JSON` | 아니오(0) | `{"decideIn":…,"decideOut":…,"respondIn":…,"respondOut":…}` | 마이크로 달러 / 100만 토큰. S9·계약 전에는 0 |
| `GW_ALLOW_IMAGES` | 아니오 | `false`만 | Phase 1 이미지 입력 없음(B-18). 다른 값이면 기동 거부 |
| `NTS_PROVIDER` | 예 | `odcloud` \| `mock` | 진위확인 원천 |
| `NTS_SERVICE_KEY` ⚿ | odcloud | | 공공데이터포털 서비스 키 |
| `TRUST_PROXY` | 아니오 | `1` | 앞단 프록시 신뢰 |
| `PORT` / `HOST` | 아니오(`8081` / `0.0.0.0`) | | |
