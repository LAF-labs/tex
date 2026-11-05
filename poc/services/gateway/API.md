# 모델 게이트웨이 API(M4-6)

근거: D09 §3·§4.1, D04 §6·§7, [gateway-request.schema.json](../../packages/net/schemas/gateway-request.schema.json)(요청 본문 정본, B-20), ADR-015·029, C-23·C-24·C-25, B-18. 공통 형식은 [`../shared/CONTRACT.md`](../shared/CONTRACT.md).

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

- 툴셋: `selector_repair`, `query_parse`(정의 `packages/model/src/toolsets.ts`). `summarize`·`intent_fill`은 정의가 아직 없어 `400`.
- `effort`·`max_output_tokens`·도구 정의·`text.format`·`store:false`·캐시 필드는 툴셋 정의로 게이트웨이가 넣는다. 클라이언트가 `developer` 역할·이미지·`input_file`·도구·`store`를 보내면 `400`(Phase 1 `GW_ALLOW_IMAGES=false`). replay 항목 안의 이미지도 `400`.
- `tag = HMAC-SHA256(gw_key, accountId ‖ 0 ‖ deviceId ‖ 0 ‖ runToken ‖ 0 ‖ 정규 JSON(item))` hex. replay는 이 태그가 맞는 항목과, 그 항목 중 `function_call`의 `call_id`에 답하는 `function_call_output`만 받는다. 태그는 runToken에 묶여 다른 실행에서 재사용할 수 없다.
- `selector_repair`의 `scopeId`는 게이트웨이 정의에서 형식 제한(`^[A-Za-z0-9_.-]{1,64}$`)이다. 요청 스키마에 `scopeIds`가 없어서다. 엔진은 로컬 툴셋 정의(열거)로 도구 호출을 다시 검증한다.
- `toolsetDigest = sha256(정규 JSON({prefix, tools, output, effort, maxOutputTokens}))`.

오류는 decide와 같고, 더해 월 토큰 100%부터 `429 gateway.quota_exceeded`(L2 중단), 툴셋 턴 상한 도달 `429 gateway.run_budget_exceeded`, 계정당 분당 10회.

## POST /v1/biz/status (사업자등록 진위확인 프록시, D09 §4.1)

| 요청 | 응답 |
|---|---|
| `{b_no: ["0123456789", …]}` 1~10건, 숫자 10자리 | `200 {data:[{b_no, b_stt_cd, tax_type_cd, end_dt}]}` |

- 번호는 메모리로만 통과해 공공데이터포털(`nts-businessman/v1/status`)로 간다. DB·로그·통계에 남기지 않고, **이 경로의 접근 로그에는 계정 식별자(`aid`)도 없다**(상태코드·지연·바이트만). 한도는 계정당 분당 30회(메모리 카운터, 일 회전 HMAC 키).
- 원천 장애는 `503 gateway.upstream_error`.

## GET /healthz

`200 {ok:true}`

## 기기 자동 정지(D09 §3)

트립와이어·공급사 거절(refusal)이 한 기기에서 1시간에 20회가 되면 계정 서비스 `POST /internal/v1/devices/:id/auto-suspend`를 부른다. 계정 서비스가 그 기기를 정지하고 릴레이·푸시 정지 훅과 알림 메일(`device_auto_suspended`)을 보낸다. 해제는 사용자의 AIK 서명 재활성화뿐이다.
