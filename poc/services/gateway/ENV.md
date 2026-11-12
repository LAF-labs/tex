# 게이트웨이 환경 변수

비밀(⚿)은 클라우드 KMS가 주입하고 90일마다 회전한다(D09 §3 키 관리). 저장소·이미지·CI에 두지 않는다. 레지스트리 서명 키는 여기에 두지 않는다. 값이 없거나 형식이 틀리면 기동하지 않는다(`config_<이름>`).

| 이름 | 필수 | 형식 | 설명 |
|---|---|---|---|
| `DATABASE_URL` / `SAX_SQLITE_FILE` | 둘 중 하나 | | 계량 DB |
| `DATABASE_POOL_MAX` | 아니오(`10`) | 1~99 | 인스턴스당 PostgreSQL 연결 수. 함수는 `1` |
| `MIGRATE_ON_START` | 아니오(`1`) | `0`·`1` | `0`이면 기동 때 마이그레이션을 하지 않는다(DDL 권한 없는 서비스 역할, [deploy/README](../deploy/README.md) 4절) |
| `GATEWAY_PUBLIC_ORIGIN` | 예 | `https://…` | DPoP `htu` 검증 origin |
| `TOKEN_PUBLIC_KEYS` | 예 | `kid:base64(32B)[,…]` | 계정 서비스 기기 범위 토큰 공개키 |
| `ACCOUNT_INTERNAL_URL` | 상시 서버만 | 내부 URL | 기기 상태 조회·자동 정지(서명 호출). 함수 배포(`@sax/svc-cloud`)는 계정 서비스를 함수로 부르므로 쓰지 않는다 |
| `INTERNAL_CALL_KEY` ⚿ | 상시 서버만 | hex 64자 | 내부 호출 서명 키(`ACCOUNT_INTERNAL_URL`과 함께, 계정 서비스와 같은 값) |
| `RUN_TOKEN_SEED` ⚿ | 예 | hex 64자 | runToken 서명 키(Ed25519 시드) |
| `LIMIT_ID_KEY` ⚿ | 예 | hex 64자 | 한도 키(계정·기기 ID) HMAC 비밀. DB에 없다(DB를 읽어도 한도 키를 다시 계산할 수 없음, [CONTRACT §10](../shared/CONTRACT.md)). 바꾸면 진행 중인 한도 창(≤ 1시간)만 처음부터 센다 |
| `CACHE_KEY_SECRET` ⚿ | 예 | hex 64자 | `prompt_cache_key` HMAC 비밀 |
| `SAFETY_ID_KEY` ⚿ | 예 | hex 64자 | `K_sid`(safety_identifier) |
| `REPLAY_TAG_KEY` ⚿ | 예 | hex 64자 | replay 태그 키(`gw_key`). 바꾸면 진행 중인 L2 대화의 replay가 무효가 된다 |
| `RUN_SCOPE_KEY` ⚿ | 예 | hex 64자 | 실행 예산 범위 해시 키 |
| `GW_PROVIDER` | 예 | `openai+openrouter` \| `openrouter` \| `openai-compat` \| `upstage-systemone` \| `mock` | 공급사 어댑터. 운영 기본은 `openai+openrouter`(팀장 결정 11-05: L1 판정은 OpenAI Decisions 직결, 응답은 OpenRouter) |
| `OPENAI_API_KEY` ⚿ | openai+openrouter | | OpenAI 키(판정 전용, 서버 환경 변수만). 조직 ZDR 신청은 EX-7 |
| `OPENAI_BASE_URL` | 아니오(`https://api.openai.com`) | `https://…` | 판정 상류 주소 |
| `OPENROUTER_API_KEY` ⚿ | openrouter | | OpenRouter API 키(서버 환경 변수만, 저장소·클라이언트 금지) |
| `OPENROUTER_ZDR` | openrouter | `true`만 | ZDR 엔드포인트만(R14 ①). 다른 값·없음이면 기동 거부 |
| `OPENROUTER_DATA_COLLECTION` | openrouter | `deny`만 | 데이터 수집 공급자 제외(R14 ①). 다른 값·없음이면 기동 거부 |
| `OPENROUTER_PROVIDERS` | openrouter | 슬러그 `a,b`(1~8개, 중복 금지) | 공급자 고정(`only` + `allow_fallbacks:false`). 비면 기동 거부 |
| `PROVIDER_BASE_URL` | openai-compat | `https://…` | 공급사 주소 |
| `PROVIDER_API_KEY` ⚿ | openai-compat | | 공급사 API 키 |
| `MODEL_DECIDE` / `MODEL_RESPOND` | 예 | 모델 ID | 판정·응답 모델(클라이언트가 정하지 않는다) |
| `GW_MONTHLY_TOKENS` | 아니오(3,000,000) | 양의 정수(아니면 기동 거부) | 계정 월 토큰 한도(100% L2 중단, 200% 이후 안전 판정만 계정당 분당 6회) |
| `GW_PRICES_JSON` | 아니오(0) | `{"decideIn":…,"decideOut":…,"respondIn":…,"respondOut":…}` | 마이크로 달러 / 100만 토큰. S9·계약 전에는 0 |
| `GW_ALLOW_IMAGES` | 아니오 | `false`만 | Phase 1 이미지 입력 없음(B-18). 다른 값이면 기동 거부 |
| `NTS_PROVIDER` | 예 | `odcloud` \| `mock` | 진위확인 원천 |
| `NTS_BIZ_API_KEY` ⚿ | odcloud | | 공공데이터포털 "국세청_사업자등록정보 진위확인 및 상태조회 서비스"(15081808) 인증키. 쿼리 `serviceKey`로만 보낸다. 로그·저장소·메시지에 두지 않는다 |
| `NTS_BIZ_API_BASE` | 아니오(`https://api.odcloud.kr/api`) | `https://…` | 원천 주소. 경로는 `{base}/nts-businessman/v1/status` |
| `CODEF_ENV` | 아니오(없으면 꺼짐) | `sandbox` \| `demo` \| `prod` \| `mock` | 계좌 자동조회 CODEF 환경. 없으면 `/v1/codef/token`이 `503 gateway.codef_off`. 값이 틀리면 기동 거부 |
| `CODEF_CLIENT_ID` ⚿ | CODEF_ENV가 mock 밖 | 8~128자 | CODEF 홈페이지 키 관리의 클라이언트 아이디(환경마다 다르다: 데모·정식) |
| `CODEF_CLIENT_SECRET` ⚿ | CODEF_ENV가 mock 밖 | 8~256자 | CODEF 클라이언트 시크릿. 토큰 발급(Basic 인증)에만 쓰고 PC·로그·응답에 보내지 않는다 |
| `CODEF_PUBLIC_KEY` | CODEF_ENV가 mock 밖 | base64(DER SPKI, 줄바꿈 무시) | CODEF 홈페이지 키 관리의 RSA 공개키. 비밀은 아니지만 계정마다 다르다. PC가 인증서 비밀번호를 감싸는 데 쓴다 |
| `TRUST_PROXY` | 아니오 | `1` | 앞단 프록시 신뢰 |
| `PORT` / `HOST` | 아니오(`8081` / `0.0.0.0`) | | |

OpenRouter 라우팅 설정은 코드 상수가 아니다. 위 세 값은 운영 환경 설정에서만 오고, 게이트웨이는 요청마다 `provider:{zdr:true, data_collection:"deny", only:[…], allow_fallbacks:false, require_parameters:true}`를 실은 뒤 이벤트 `upstream_zdr_pinned`(개수만, 값·내용 없음)를 남긴다. 응답이 고정 목록 밖 공급자를 밝히면 결과를 버린다(`upstream_provider_mismatch`). OpenRouter에는 Decisions(L1 보정 확률) 엔드포인트가 없다. `openrouter` 단독이면 `/v1/decide`는 상류를 부르지 않고 `503 gateway.upstream_error`를 낸다. 운영은 `openai+openrouter`로 판정만 OpenAI `/v1/decisions`에 직결한다(D04 확률·임계값 계약 유지, 팀장 결정 2026-11-05).
