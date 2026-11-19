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
| `GW_RESPOND_PROVIDER` | 아니오(`base`) | `base` \| `anthropic` | 생성 호출(대화, 폰 대화, 요약, 선택자 수리, 예상 밖 화면 판정, 브라우저 에이전트, 화면 보기)의 공급사. `base`는 `GW_PROVIDER`가 다 한다(지금까지와 같다). `anthropic`이면 생성만 Anthropic Messages API로 보내고, **L1 판정(`/v1/decide`, jev)과 결정 모델 고르기(`decision_pick`)는 `GW_PROVIDER`에 그대로 둔다**(ADR-051 판정 단의 확률·임계값 계약과 평가 기준선 유지). 대표 결정 2026-11-19: 시험 기간에는 조직 크레딧을 쓰려고 `anthropic`. 되돌릴 때는 이 값을 지우고 재배포한다. 다른 값이면 기동 거부 |
| `ANTHROPIC_API_KEY` ⚿ | anthropic | | Anthropic Console(platform.claude.com) API 키. 서버 환경 변수만, 저장소·클라이언트·메시지 금지. 넣기와 끄기는 [`set-anthropic-key.sh`](../deploy/set-anthropic-key.sh)(키를 화면에 보이지 않게 받아 Vercel `GATEWAY__ANTHROPIC_API_KEY`와 `GATEWAY__GW_RESPOND_PROVIDER=anthropic`을 넣는다) |
| `ANTHROPIC_MODEL_RESPOND` | 아니오(`claude-opus-5-5`) | `claude-…` | anthropic일 때 대화·요약·선택자 수리 모델(`MODEL_RESPOND` 대신) |
| `ANTHROPIC_MODEL_AGENT` | 아니오(`ANTHROPIC_MODEL_RESPOND`) | `claude-…` | anthropic일 때 예상 밖 화면 판정·브라우저 에이전트·화면 보기 모델(`MODEL_AGENT`·`MODEL_VISION` 대신). 화면 보기 사진도 이 모델로 간다 |
| `ANTHROPIC_BASE_URL` | 아니오(`https://api.anthropic.com`) | `https://…` | 시험용 주소 바꾸기 |
| `PROVIDER_BASE_URL` | openai-compat | `https://…` | 공급사 주소 |
| `PROVIDER_API_KEY` ⚿ | openai-compat | | 공급사 API 키 |
| `MODEL_DECIDE` / `MODEL_RESPOND` | 예 | 모델 ID | 판정·응답 모델(클라이언트가 정하지 않는다). OpenRouter 운영의 `MODEL_DECIDE`는 `~typesafe/jev-latest`(L1을 `/api/alpha/decisions`로). PC는 응답 model이 `typesafe/jev-`로 시작해야 받고, 그 계열의 임계값 프로필을 쓴다 |
| `MODEL_AGENT` | 아니오(`typesafe/jev-router`) | OpenRouter 모델 ID | 예상 밖 화면 판정·브라우저 에이전트(`page_judge`·`browser_agent`) 모델. 기본은 요청마다 모델·추론 강도를 고르는 라우터다. **이 두 툴셋 호출에는 `OPENROUTER_ZDR`·`OPENROUTER_DATA_COLLECTION`·`OPENROUTER_PROVIDERS`를 적용하지 않는다**(provider 필드 없이 보낸다, 대표 2026-11-13: 라우터 뒤쪽 공급사가 요청마다 달라 고정하면 막힌다). 보내는 글은 지금처럼 가린 요소 목록·대화상자 문구뿐이다. 다른 툴셋은 그대로 고정한다 |
| `OPENROUTER_AGENT_PRIVACY` | 아니오(`off`) | `off` \| `deny` \| `zdr` | 위 두 툴셋 호출의 보관 조건. 공급자는 고정하지 않고 `provider`에 보관 조건만 싣는다: `deny` = `data_collection:"deny"`, `zdr` = `zdr:true` + `data_collection:"deny"`. `off`는 provider 필드 없음(대표 2026-11-13 결정). 처리방침 6항의 예외 문구를 지우려면 `zdr`로 켜야 한다. 라우터 뒤 공급사가 못 맞추면 OpenRouter가 거절할 수 있으니 실키로 판정 몇 건을 돌려 본 뒤 켠다. 다른 값이면 기동 거부 |
| `MODEL_VISION` | 아니오(`MODEL_AGENT`) | OpenRouter 모델 ID(이미지 입력·structured outputs 지원) | 화면 보기(`computer_use`, 대표 결정 2026-11-16) 모델. PC가 입력 칸·숫자·메일 글을 검게 가린 JPEG 한 장을 받는다. **판정·에이전트와 달리 `OPENROUTER_ZDR`·`OPENROUTER_DATA_COLLECTION`·`OPENROUTER_PROVIDERS` 고정을 그대로 건다**: 고정 목록 공급사가 이미지 입력을 받는 모델을 골라야 한다. 이미지는 이 툴셋에서만 받고 다른 툴셋의 이미지는 `400 gateway.param_rejected` |
| `MODEL_DECISION` | 아니오(`~typesafe/jev-latest`) | OpenRouter decisions 모델 ID | 결정 모델 고르기(`decision_pick`, 위치 찾기 앞 칸: 가린 같은 역할 요소 목록에서 목표 칸 번호 하나). OpenRouter `/api/alpha/decisions`(생성 없이 선택지 확률)로 부른다. 공급자 고정 없이 `OPENROUTER_AGENT_PRIVACY` 보관 조건만 건다(판정·에이전트와 같다). 2026-11-16 비교로 jev를 골랐고 대표 지시로 별칭(latest)으로 부른다. 풀린 버전은 `ops_stats`(surface `model:<이름>`, outcome `seen`)에 날마다 센다. 버전이 바뀌면 `scripts/s7-regression.ts --decisions=~typesafe/jev-latest --n=100 --answers --gate`와 `tests/ladder-live/pick-eval.ts`를 다시 돌린다 |
| `GW_MONTHLY_TOKENS` | 아니오(3,000,000) | 양의 정수(아니면 기동 거부) | 계정 월 토큰 한도(100% L2 중단, 200% 이후 안전 판정만 계정당 분당 6회) |
| `GW_PRICES_JSON` | 아니오(0) | `{"decideIn":…,"decideOut":…,"respondIn":…,"respondOut":…}` | 마이크로 달러 / 100만 토큰. S9·계약 전에는 0 |
| `GW_DAILY_KRW_TRIAL` | 아니오(`50`) | 양의 정수(원) | 무료 체험 하루 AI 사용 금액 한도. 하루는 한국 시간 새벽 4시에 바뀐다(사용자 결정 2026-11-16) |
| `GW_DAILY_KRW_PAID` | 아니오(`300`) | 양의 정수(원) | 구독자 하루 한도 |
| `GW_KRW_PER_USD` | 아니오(`1450`) | 양의 정수 | 한도 계산 환율 |
| `GW_LIMIT_PRICES_JSON` | 아니오(constants.ts `LIMIT_PRICES`) | `{"decideIn":…,"decideCached":…,"respondIn":…,"respondCached":…,"respondOut":…,"agentIn":…,"agentCached":…,"agentOut":…}` | 일 한도용 단가(마이크로 달러 / 100만 토큰). `GW_PRICES_JSON`(월 계량)과 따로라 그 값이 0이어도 한도는 돈다 |
| `GW_ALLOW_IMAGES` | 아니오 | `false`만 | Phase 1 이미지 입력 없음(B-18). 다른 값이면 기동 거부 |
| `NTS_PROVIDER` | 예 | `odcloud` \| `mock` | 진위확인 원천 |
| `NTS_BIZ_API_KEY` ⚿ | odcloud | | 공공데이터포털 "국세청_사업자등록정보 진위확인 및 상태조회 서비스"(15081808) 인증키. 쿼리 `serviceKey`로만 보낸다. 로그·저장소·메시지에 두지 않는다 |
| `NTS_BIZ_API_BASE` | 아니오(`https://api.odcloud.kr/api`) | `https://…` | 원천 주소. 경로는 `{base}/nts-businessman/v1/status` |
| `CODEF_ENV` | 아니오(`CODEF_CLIENT_ID`가 있으면 `demo`, 둘 다 없으면 꺼짐) | `sandbox` \| `demo` \| `prod` \| `mock` | 계좌 자동조회 CODEF 환경. demo = `https://development.codef.io`(데모: 실제 기관, 하루 100회·1개월), prod = `https://api.codef.io`, sandbox = `https://sandbox.codef.io`(고정 응답). 토큰 주소는 셋 다 `https://oauth.codef.io/oauth/token`. 꺼짐이면 `/v1/codef/token`이 `503 gateway.codef_off`. 값이 틀리면 기동 거부 |
| `CODEF_CLIENT_ID` ⚿ | CODEF_ENV가 mock 밖 | 8~128자 | CODEF 홈페이지 키 관리의 클라이언트 아이디(환경마다 다르다: 데모·정식) |
| `CODEF_CLIENT_SECRET` ⚿ | CODEF_ENV가 mock 밖 | 8~256자 | CODEF 클라이언트 시크릿. 토큰 발급(Basic 인증)에만 쓰고 PC·로그·응답에 보내지 않는다 |
| `CODEF_PUBLIC_KEY` | CODEF_ENV가 mock 밖 | base64(DER SPKI, 줄바꿈 무시) | CODEF 홈페이지 키 관리의 RSA 공개키. 비밀은 아니지만 계정마다 다르다. PC가 인증서 비밀번호를 감싸는 데 쓴다 |
| `TRUST_PROXY` | 아니오 | `1` | 앞단 프록시 신뢰 |
| `PORT` / `HOST` | 아니오(`8081` / `0.0.0.0`) | | |

OpenRouter 라우팅 설정은 코드 상수가 아니다. 위 세 값은 운영 환경 설정에서만 오고, 게이트웨이는 요청마다 `provider:{zdr:true, data_collection:"deny", only:[…], allow_fallbacks:false, require_parameters:true}`를 실은 뒤 이벤트 `upstream_zdr_pinned`(개수만, 값·내용 없음)를 남긴다. 응답이 고정 목록 밖 공급자를 밝히면 결과를 버린다(`upstream_provider_mismatch`). 예외: `page_judge`·`browser_agent`(`MODEL_AGENT`) 호출은 provider 필드 없이 보내고 이벤트 `upstream_unpinned`를 남긴다(위 `MODEL_AGENT` 줄). OpenRouter에는 Decisions(L1 보정 확률) 엔드포인트가 없다. `openrouter` 단독이면 `/v1/decide`는 상류를 부르지 않고 `503 gateway.upstream_error`를 낸다. 운영은 `openai+openrouter`로 판정만 OpenAI `/v1/decisions`에 직결한다(D04 확률·임계값 계약 유지, 팀장 결정 2026-11-05).

`GW_RESPOND_PROVIDER=anthropic`일 때: 머리말은 system 블록 하나로 캐시하고(`cache_control`), 툴셋 `effort`는 `output_config.effort`, 출력 스키마는 `output_config.format`(json_schema), 도구는 `strict:true`로 보낸다. Anthropic 구조화 출력이 받지 않는 제약(`maxLength`·`maximum`·`maxItems`·`pattern` 등)은 빼고 보내며, PC·폰이 받은 출력과 도구 인자를 원래 스키마로 다시 검사한다. 응답의 assistant 내용 원본(사고 블록 서명 포함)은 첫 출력 항목 `reasoning.anthropic_content`에 실려 PC·폰이 다음 턴에 그대로 되돌려 보낸다(태그 검증은 그대로). 안전 분류기 거절은 서버 쪽 대체(`fallbacks:"default"`)가 먼저 받고, 그래도 거절이면 지금처럼 `refusal`이다. 일 한도 단가(`LIMIT_PRICES`)는 바꾸지 않는다: 시험 중 실제 비용은 한도 계산보다 크다(월 토큰 한도 `GW_MONTHLY_TOKENS`가 상한).
