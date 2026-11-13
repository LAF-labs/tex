# 모델 게이트웨이 API(M4-6)

근거: D09 §3·§4.1, D04 §6·§7, [gateway-request.schema.json](../../packages/net/schemas/gateway-request.schema.json)(요청 본문 정본, B-20), ADR-015·029, C-23·C-24·C-25, B-18. 공통 형식은 [`../shared/CONTRACT.md`](../shared/CONTRACT.md).

**호스트**: 공개 origin은 `https://tax.laf-co.com` 하나다(클라이언트 설정 `GATEWAY_ORIGIN`). 경로는 서비스마다 겹치지 않게 나누고, 앞단(Vercel 재작성)이 경로 접두로 서비스를 고른다. `GATEWAY_PUBLIC_ORIGIN`도 `https://tax.laf-co.com`이다(DPoP `htu` = origin + 아래 경로).

| 서비스 | 공개 경로 |
|---|---|
| 게이트웨이(M4-6) | `/v1/run-tokens`, `/v1/decide`, `/v1/respond`, `/v1/biz/status`, `/v1/codef/token` |
| 계정(M4-5) | `/v1/auth/*`, `/v1/oauth/*`, `/v1/passkeys*`, `/v1/me`, `/v1/consents`, `/v1/billing/*`, `/v1/devices*`, `/v1/device-tokens`, `/v1/device-list`, `/v1/aik`, `/v1/slots*` |
| 릴레이(M7-3) | `/v1/mailboxes/*`, `/v1/rooms*` |
| 푸시(M7-3) | `/v1/push-token`, `/v1/wake` |
| 레지스트리(M4-7) | `/registry/*`, `/policy/*`, `/packages/*`, `/releases/*`(게시 `/admin/v1/*`은 공개 origin에 두지 않는다) |

`/internal/v1/*`과 `/healthz`는 공개 경로로 내보내지 않는다(서비스끼리 내부 주소로만). Vercel 배포에서는 서비스 사이 호출을 HTTP 없이 함수로 부르고, 공개 함수는 `/internal/*`을 모두 404로 막는다. HTTP는 룸 호스트 연결만이고 `INTERNAL_CALL_KEY` 서명을 쓴다([deploy/README](../deploy/README.md) 6절 ①).

**배포 전제(yulmu 11-05, 미검증)**: DB는 Supabase Postgres, HTTP는 Vercel. 리전은 **미정**이다(서울이면 Supabase `ap-northeast-2`, Vercel 함수 `icn1`). 처리방침은 어느 쪽이든 "국외 이전 가능"으로 쓴다(R14). 모델 상류는 L1 판정 OpenAI Decisions 직결, 응답 OpenRouter(ZDR·수집 거부·공급자 고정, [ENV.md](ENV.md)). 게이트웨이는 무저장이라 함수로 올릴 수 있다. 한도(기기·계정 분당, 자동 정지 판정, 상한 뒤 안전 판정 속도)는 DB 카운터라 인스턴스가 여럿이어도 합산된다(키는 서버 비밀 HMAC, [CONTRACT §10](../shared/CONTRACT.md)).

**인증**: 모든 `/v1/*`는 데스크톱 기기 범위 토큰(`gateway` 범위) + DPoP(`htu = GATEWAY_PUBLIC_ORIGIN + 경로`). 계정 세션 토큰·폰 토큰은 거부한다. 기기 ID는 토큰에서 유도한다(`X-Device-Id` 헤더 없음, N-41). 긴급 정지·자동 정지된 기기는 `403 gateway.device_suspended`.

**오류 본문**은 `{"error":"<코드>"}`뿐이고 입력을 되풀이하지 않는다. 공통: `401 gateway.unauthorized`, `403 account.scope_denied`, `400 gateway.param_rejected`(스키마 밖 필드·형식), `429 policy.rate_limited`(+`Retry-After`), `413 request.too_large`.

## POST /v1/run-tokens

실행당 예산을 묶는 runToken을 발급한다.

| 요청 | 응답 |
|---|---|
| `{runId}`(플레이북 실행, 원장의 실행 ID) 또는 `{chatSessionId}`(실행 밖 대화: chat·intent_fill·query_parse). 각 `^[A-Za-z0-9_.-]{8,64}$` | `200 {runToken, expiresAt, budget:{l1, l2}}` |

- 형식: `sxr1.<b64u(JCS(claims))>.<b64u(Ed25519(SAX-run-token-v1 ‖ JCS(claims)))>`, claims `{v:1, typ:"run", acc, dev, sh, k:"run"|"chat", iat, exp}`. 수명 2시간. 발급한 기기·계정에서만 쓸 수 있다.
- 예산은 토큰이 아니라 **범위**(`HMAC(계정, 종류, ID)`)에 쌓인다. 같은 runId로 다시 받아도 초기화되지 않는다.
- 예산: 실행 `L1 ≤ 12`, `L2 ≤ 2`(replay 없는 respond 1회 = L2 1회), 이어지는 턴은 `L2 × (툴셋 턴 상한 − 1)`까지. 대화 범위 `L1 ≤ 12`, `L2 ≤ 20`(제안값).
- 한도: 기기당 시간당 120개.

## POST /v1/decide

| 요청(스키마 `$defs/decide`) | 응답 |
|---|---|
| `{bundleId, bundleDigest, input, runToken}` | `200 {model, answers, usage:{input_tokens, output_tokens}, questionsDigest}` |

- 질문·고정 접두·모델·`prompt_cache_options`(명시 모드, 브레이크포인트는 접두 끝)·`prompt_cache_key = acct:<HMAC(server_secret, accountId)[:32]>:b:<bundleId>`·`safety_identifier = hex(HMAC(K_sid, accountId ‖ yyyymm(KST)))[:32]`은 게이트웨이가 넣는다. 번들 정의는 `packages/model/bundles`(앱과 같은 원천, BV-06)를 기동 시 BV 검증과 함께 읽는다.
- `answers`는 공급사 Decisions `answers[]` 그대로다(비신뢰 입력, 엔진이 로컬 번들로 결과를 계산, C-24). `usage`에는 캐시 적중 정보(`cached_tokens`)가 없다.
- `questionsDigest = sha256(정규 JSON(번들 questions))`. 엔진이 로컬 번들과 대조한다.

| 오류 | 경우 |
|---|---|
| `409 gateway.digest_mismatch` | `bundleId@bundleDigest`가 게이트웨이 번들 집합에 없음(배포 불일치 감지) |
| `400 gateway.param_rejected` | 입력 UTF-8 바이트가 번들 `maxInputBytes` 초과, 스키마 위반 |
| `400 gateway.pii_tripwire` | 2차 트립와이어(주민번호·사업자번호·카드·계좌·긴 숫자열, `@sax/net piiTripwire`와 같은 규칙). 공급사로 보내지 않고 카운트만 |
| `401 gateway.run_token_invalid` | 서명·만료·기기/계정 불일치 |
| `429 gateway.run_budget_exceeded` | 실행 예산 소진 |
| `429 gateway.quota_exceeded` | 월 토큰 하드 상한(플랜 한도 × 2) 이후 안전 판정이 아닌 번들(`riskClass ≠ safety`), 또는 하드 상한 이후 안전 판정 번들이 계정당 분당 6회를 넘을 때. 월 100%~200% 사이 L1은 의도적으로 계속된다(D04 §6 "100% 이후 L1 유지", L2만 100%에서 중단) |
| `503 gateway.upstream_error` | 공급사 5xx·429·연결 오류 → 지수 백오프 2회 뒤, 또는 재시도 불가 오류. 엔진은 `unknown` |
| `429 policy.rate_limited` | 계정당 분당 60회 |

## POST /v1/respond

| 요청(스키마 `$defs/respond`) | 응답 |
|---|---|
| `{toolset, messages(role=user, input_text만), replay?, runToken}` | `200 {model, status, output:[{item, tag}], usage:{input_tokens, output_tokens}, toolsetDigest}` |

- 툴셋: `selector_repair`, `query_parse`, `chat_reply`, `chat_agent`, `page_judge`, `browser_agent`(정의 `packages/model/src/toolsets.ts`·`chat-agent.ts`). `summarize`·`intent_fill`은 정의가 아직 없어 `400`.
- `chat_reply`(대화 짧은 응대, 2026-11-10): 도구 없음·1턴·`max_output_tokens` 1000·effort low, 공통 판정기 머리말 없이 `toolsets/chat_reply.ko.txt`만. 대화 범위(`chatSessionId`) runToken으로 부르고 범위당 새 L2 예산(`l2PerChat`)을 쓴다. 출력 `{kind, reply, suggest[]}`의 길이·세무 문장 차단은 엔진이 한다(게이트웨이는 본문을 보지 않는다).
- `chat_agent`(대화 에이전트, 2026-11-12): 도구 6개(`sales_summary`·`invoice_history`·`receivables`·`invoice_draft`·`draft_edit`·`draft_discard`, 발급·전송 도구 없음)·4턴·`max_output_tokens` 4000·effort low, 공통 판정기 머리말 없이 `toolsets/chat_agent.ko.txt`만. `chat_reply`와 같은 대화 범위 예산을 쓴다. 사용자 턴마다 새 L2, 그 턴의 도구 왕복은 replay. 도구 결과·답 검사는 엔진 `chat.step`이 한다.
- `page_judge`(예상 밖 화면 판정, 2026-11-13): 도구 없음·1턴·effort medium, 공통 판정기 머리말 + `toolsets/page_judge.ko.txt`. 출력 `{situation, prescription(dismiss_dialog·relogin·reload_checkpoint·fix_field·agent_mode·handoff), button, dialog_answer, field, risk_flags}`.
  엔진 폴백 사슬이 실패했거나 예상 밖 상태(JS confirm·공지 레이어·다른 화면·세션 만료)일 때 첫 게이트 앞 스텝에서만 부른다. 처방 실행과 가드는 엔진(`run/judge.ts`)이 한다.
- `browser_agent`(브라우저 에이전트, 2026-11-13): 도구 없음·1턴·effort medium, 머리말 `toolsets/browser_agent.ko.txt`만. 출력 `{action(click·type·select·scroll·wait·done·fail), index, token, option, step}`. 엔진이 동작마다 한 번 부르고(실행당 최대 25동작) 지난 동작은 글로 싣는다(replay 없음). 값은 `{{inputs.…}}` 값토큰만 오간다.
- 두 툴셋은 **응답 모델과 따로** `MODEL_AGENT`(기본 `anthropic/claude-fable-5.2`)로 부르고, 예산도 따로다: 실행 범위 runToken만, 실행당 `agentPerRun` 32회(`run_scopes.agent_calls`, 마이그레이션 002), 계정당 분당 40회. L2 예산(`l2PerRun`)을 쓰지 않는다.
- `effort`·`max_output_tokens`·도구 정의·`text.format`·`store:false`·캐시 필드는 툴셋 정의로 게이트웨이가 넣는다. 클라이언트가 `developer` 역할·이미지·`input_file`·도구·`store`를 보내면 `400`(Phase 1 `GW_ALLOW_IMAGES=false`). replay 항목 안의 이미지도 `400`.
- `tag = HMAC-SHA256(gw_key, accountId ‖ 0 ‖ deviceId ‖ 0 ‖ runToken ‖ 0 ‖ 정규 JSON(item))` hex. replay는 이 태그가 맞는 항목과, 그 항목 중 `function_call`의 `call_id`에 답하는 `function_call_output`만 받는다. 태그는 runToken에 묶여 다른 실행에서 재사용할 수 없다.
- `selector_repair`의 `scopeId`는 게이트웨이 정의에서 형식 제한(`^[A-Za-z0-9_.-]{1,64}$`)이다. 요청 스키마에 `scopeIds`가 없어서다. 엔진은 로컬 툴셋 정의(열거)로 도구 호출을 다시 검증한다.
- `toolsetDigest = sha256(정규 JSON({prefix, tools, output, effort, maxOutputTokens}))`.

오류는 decide와 같고, 더해 월 토큰 100%부터 `429 gateway.quota_exceeded`(L2 중단), 툴셋 턴 상한 도달 `429 gateway.run_budget_exceeded`, 계정당 분당 10회(`page_judge`·`browser_agent`는 따로 분당 40회).

## POST /v1/biz/status (사업자등록 진위확인 프록시, D09 §4.1)

| 요청 | 응답 |
|---|---|
| `{b_no: ["0123456789", …]}` 1~10건, 숫자 10자리 | `200 {data:[{b_no, b_stt_cd, tax_type_cd, end_dt}]}` |

- 번호는 메모리로만 통과해 공공데이터포털(`nts-businessman/v1/status`)로 간다. DB·로그·통계에 남기지 않고, **이 경로의 접근 로그에는 계정 식별자(`aid`)도 없다**(상태코드·지연·바이트만). 한도는 계정당 분당 30회(DB 카운터, 서버 비밀 HMAC 키).
- 원천 장애는 `503 gateway.upstream_error`.
- 상태코드(`b_stt_cd` 01 계속·02 휴업·03 폐업·'' 미등록, `tax_type_cd` 과세유형)는 원천 값을 그대로 넘기고 게이트웨이가 해석하지 않는다. 키는 `NTS_BIZ_API_KEY`(ENV.md).
- 원천 호출 한도(공공데이터포털 15081808 "호출허용건수"): **1회 100건, 1일 100만 건**. 게이트웨이 한도(요청당 10건, 계정당 분당 30회)가 이보다 좁다. 일 한도를 넘기면 원천이 거절하고 게이트웨이는 `503 gateway.upstream_error`를 낸다.

## POST /v1/codef/token (계좌 자동조회 CODEF 접근 토큰, 대표 결정 2026-11-12)

| 요청 | 응답 |
|---|---|
| `{}` | `200 {accessToken, expiresAt(ISO), env: "sandbox"\|"demo"\|"prod", publicKey(base64 DER)}` |

- 게이트웨이가 서버 환경 변수의 CODEF 클라이언트 ID·시크릿으로 `https://oauth.codef.io/oauth/token`(client credentials)에서 받은 토큰을 만료 1시간 전까지 메모리에 두고 다시 준다. **시크릿은 PC로 가지 않는다.** 인증서·비밀번호·계좌·거래내역은 PC → CODEF로 바로 가고 이 서버를 지나지 않는다.
- `publicKey`는 PC가 인증서 비밀번호를 RSA로 감쌀 CODEF 공개키(비밀 아님). `env`는 PC가 부를 CODEF API 주소를 고른다(sandbox `sandbox.codef.io`, demo `development.codef.io`, prod `api.codef.io`).
- 토큰은 접근 로그·이벤트에 남기지 않고, 이 경로의 접근 로그에는 계정 식별자(`aid`)도 없다. 한도는 기기당 시간당 20회(PC는 만료 전까지 메모리에 두고 다시 쓴다).
- 기능 꺼짐(`CODEF_ENV` 없음)은 `503 gateway.codef_off`, CODEF 토큰 발급 실패는 `503 gateway.upstream_error`, 본문에 키가 있으면 `400 gateway.param_rejected`.

## GET /healthz

`200 {ok:true}`

## 기기 자동 정지(D09 §3)

트립와이어·공급사 거절(refusal)이 한 기기에서 1시간 창(고정 창, 인스턴스 합산)에 20회가 되면 계정 서비스 `POST /internal/v1/devices/:id/auto-suspend`를 부른다. 계정 서비스가 그 기기를 정지하고 릴레이·푸시 정지 훅과 알림 메일(`device_auto_suspended`)을 보낸다. 해제는 사용자의 AIK 서명 재활성화뿐이다.
