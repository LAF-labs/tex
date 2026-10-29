# PoC-7 L1 판정 최소판 보고 (2026-10-29)

범위: D04 §1 계약과 OpenAI Decisions 어댑터, 번들 8종과 번들 검증기(BV-01~06), 규칙 L0 계층(S-L0), BYOK 로컬 검사 4종, S9 스크립트. **범위 밖**: 홈택스 화면 코퍼스 100장(PoC-3 로그인 스파이크 이후), Upstage 실호출(한국 리전 승인 전). 하위 보고: [S-L0.md](S-L0.md), [S9.md](S9.md).

## 1. 무엇을 만들었나

| 위치 | 내용 |
|---|---|
| `packages/redaction` | D06 최소판. `RedactedText` 브랜드(이 패키지만 만듦, 다른 곳의 `as RedactedText`는 린트 오류), 식별자 토큰화, 금액 기본 치환(`needsAmounts`만 원값), `SCREEN_DATA` 구분자 이스케이프 |
| `packages/model/src/contract.ts` | `ModelLayer.decide()/respond()`, `DecideResult.refusals`(빈 배열 허용), `UnknownReason`, `RunToken`, replay 브랜드(`GatewayTaggedItem`) |
| `packages/model/bundles/*.json` | 번들 8종(`bundle.schema.json` 적합). 고정 접두 = 공통 머리말 + 번들별 라벨 정의, o200k 기준 1,638~1,949토큰, 사용자 정보 없음 |
| `packages/model/src/bundle/` | 다이제스트(정의 + 접두), 결과 매핑(첫 일치 승리), 도달 가능 결과 계산, **BV-01~06 + 선택지 ≤ 26** 검증기, 앱 내장 카탈로그·허용 목록 |
| `packages/model/profiles/thresholds.json` | (번들, 공급사·모델) 임계값 프로필. OpenAI `gpt-6-luna` = 설계 초기값, Upstage `solar-decide` = 재산정 전이라 사용 불가 |
| `packages/model/src/adapters/` | `openai-decisions.ts`(SDK `client.decisions.create`, `maxRetries: 0`, 명시 캐시), `retry.ts`(어댑터 소유 재시도), `openai-responses.ts`(Terra 최소판, `store:false`), `upstage-systemone.ts`(스텁) |
| `packages/net/src/model-guard.ts`, `egress.ts` | BYOK 로컬 검사 4종 + 모델 송신 단일 입구 `toModel()`과 티켓 기반 `providerFetch` |
| `packages/engine/src/l0/` | 규칙(19문항), S-L0 표, 승격 기준, 결정적 인젝션 사전 필터, 규칙 어댑터, `Judge` 조율기, 측정기 |
| `scripts/` | `bundles-digest.ts`(다이제스트·허용 목록·프로필 재생성, `--check`), `s-l0-measure.ts`, `s9-decisions.ts` |
| `tests/` | `model-bundles`·`model-adapter`·`l0`·`redaction`·`s9-mock` 65건 추가(전체 105건 통과) |

## 2. 계약과 어댑터

- 어댑터는 공급사 응답을 **질문 이름으로 조인**한다(OpenAI 배열, System One 이름 키 객체 모두). 이름이 빠지거나 남거나 겹치면, 타입·값이 로컬 번들과 다르면, 응답 모델 스냅샷이 프로필 모델로 시작하지 않으면 결과는 `unknown`이다. 결과·임계값은 언제나 로컬 번들 정의로 계산한다(C-24).
- refusal 해석: predicate는 `onRefusal`(assume_true → 1, assume_false → 0, unknown → 조건 모두 거짓), 핵심 choice refusal은 번들 전체 `unknown`(D04 §2).
- 입력이 `maxInputBytes`를 넘거나 어댑터 요청 상한을 넘으면 절단하지 않고 `unknown`(`input_too_large`, `provider_context_exceeded`).
- 재시도: SDK 재시도는 끄고 어댑터가 소유한다. 429 결제·한도 코드는 재시도 금지, 일반 429·5xx·연결 오류는 `Retry-After`(없으면 지수 백오프) + 지터로 최대 2회, `Retry-After`가 4초를 넘으면 기다리지 않고 `unknown`. 타임아웃은 재시도하지 않는다.
- Decisions 요청: `prompt_cache_options: {mode: "explicit", ttl: "30m"}`, 브레이크포인트는 developer 접두 블록 끝에만, 화면 텍스트는 user 메시지. **Decisions에는 `store` 필드가 없다**(SDK `DecisionCreateParams`, R1 §A.2). `store:false`는 Responses 어댑터에 고정했다.
- System One 호환: 어댑터마다 `limits`(선택지·질문 상한, refusal 유무, 요청 바이트 상한)를 두고 번들과 정적으로 대조한다. 8종 모두 선택지 ≤ 26(최대 `intent_route_v1` 16개)이다. Upstage 어댑터는 요청 조립·정규화만 있고 호출은 `not_available`이다. egress 목적지에도 넣지 않았다.

## 3. 번들 8종과 BV

| 번들 | riskClass | 질문 | 결과(순서 = 우선순위) |
|---|---|---|---|
| `screen_state_v2` | safety | choice `screen` + predicate 8 | blocked(예약) > logged_out_by_other_session(예약) > captcha > mfa_pending > login_required > error > logged_in > unknown |
| `popup_class_v1` | safety | choice `popup` + `asks_to_proceed_or_issue` | security_warning(≥.80) > captcha > session_expired > consent_required > error > notice_dismissable(∧ asks ≤ .10) > unknown |
| `recovery_v1` | general | choice `situation` | 4종 각 ≥ .85 > unknown |
| `form_ready_v2` | pre_commit | `validation_error_visible`(`required_fields_filled` 삭제) | validation_error ≥ .85 > no_visible_error ≤ .05 > unknown |
| `issue_result_v2` | post_commit | choice `result` | 4종 각 ≥ .95 > unknown |
| `intent_route_v1` | routing | choice `playbook`(15 + none_of_these) + `mentions_tax_advice` | refuse_advice(세무 ∧ 해당 없음) > route(≥ .80) > refuse_advice(세무 ∧ 저신뢰) > unknown |
| `amount_parse_check_v1` | general, `needsAmounts` | `parse_matches_user_text` | ok ≥ .90 > mismatch ≤ .10 > unknown |
| `doc_meta_check_v1` | general | choice `issued_on`·`valid_until`(후보 8 + none + unknown) | ok(둘 다 후보 ≥ .90) > none_found > unknown. `needs_user`(규칙표와 30일 넘게 차이)는 엔진 후처리 몫 |

BV 검증기는 엔진 로더(`BundleCatalog.load`)와 번들 CI(`tests/model-bundles.test.ts`)가 같은 함수를 쓴다. BV-02(거절 단조성)는 매핑 조건의 임계값 경계로 질문별 대표 상태를 만들어 모든 답 조합의 도달 가능 결과를 정확히 계산한다(8종 전체 26ms). 변형 테스트로 각 규칙이 실제 위반을 잡는지 확인했다(예: `security_warning: assume_false`, `captcha_visible: unknown`, 직후 판정 0.94, 예약 행을 진행 행 뒤로, 임계값을 낮추고 다이제스트를 다시 계산한 위조본 → 허용 목록에 없어 로드 거부).

## 4. L0와 judge

[S-L0.md](S-L0.md)에 표와 판정이 있다. 요약:
- 규칙 정확도 ≥ 99.5%(라벨 실코퍼스, 답한 표본 n ≥ 300)인 질문만 L0로 보낸다. 지금은 실코퍼스가 없어 **승격 0건**이고 규칙은 그림자 모드(기록만)로 돈다.
- 비가역 직전·직후·안전 번들과 보안 질문은 규칙 답이 진행 결과를 만들 수 없을 때(중단 쪽)만 쓴다. 모델 호출은 규칙이 모든 질문을 덮거나 결과를 중단 하나로 확정할 때만 생략한다.
- 규칙 어댑터는 규칙 답을 가짜 Decisions 응답(`answers[]`, 확률 1.0/0.0)으로 내고 공급사 응답과 같은 정규화를 지난다.
- 질문 단위 55%(R8 추정)는 호출 단위로 환산되지 않는다(질문 부분집합 필드가 요청 스키마에 없음). 합성 코퍼스의 어려운 음성 사례에서 키워드 규칙 정확도가 50~83%로 떨어졌다.

## 5. BYOK 로컬 검사 4종(`net/egress`)

`egress.toModel()`이 모델 송신의 유일한 입구다. (1) 앱 내장 번들 다이제스트 허용 목록(+ `maxInputBytes`), (2) `gateway-request.schema.json` 검증(설계 원본의 사본, 원본과 같은지 테스트가 확인), (3) 실행당 예산 L1 ≤ 12·L2 ≤ 2, (4) 2차 PII 트립와이어(주민번호·사업자번호·카드·계좌 모양), 그리고 Phase 1 이미지 거부. 하나라도 실패하면 호출하지 않고 코드·카운트만 남긴다. 통과하면 그 본문의 해시에 묶인 일회 티켓을 발급하고, SDK에 넘긴 `providerFetch`는 티켓·목적지·경로·본문 해시가 모두 맞을 때만 나간다. 티켓은 재시도까지 3회 쓸 수 있고 예산은 1회만 소비한다. 린트: `packages/engine`·`packages/model`은 `fetch`·`http` 등을 직접 쓸 수 없다(기존 규칙 확장).

## 6. S9

[S9.md](S9.md). **실호출 미실행, 키 필요.** 스크립트는 키가 있으면 실측, 없으면 모의 서버로 같은 경로를 돈다. 계획 55회 호출, 사전 추정 상한 $0.202, 실행 중 $1.5 초과 시 중단(상한 $2).

## 7. 설계 질문(보드 PoC-7 스레드에 올림, 코드로 우회하지 않음)

1. **BV-03 "safety의 중단 결과 ≤ 0.80"의 범위.** D04 §3은 `logged_out_by_other_session`(예약)·`captcha`를 0.85로 정했다. 문자 그대로면 충돌한다. 구현은 D04 §2가 0.80으로 정한 `blocked`·`security_warning`만 대상으로 보았다(`SAFETY_STOP_OUTCOMES`). 맞는가?
2. **BV-03 routing 하한.** BV-03 "그 외 progress ≥ 0.85"와 D04 §2 "intent_route 0.80"이 다르다. 구현은 `routing` riskClass 하한을 0.80으로 두었다. D03 표에 routing 줄을 추가할지?
3. **L0 호출 절감 단위.** 게이트웨이 `decide` 요청에 질문 부분집합 필드가 없어서, 규칙이 일부 질문에 답해도 번들 전체를 묻는다. 질문 부분집합(또는 규칙 답 동봉) 필드를 스키마에 둘지, 번들을 "규칙으로 답하기 쉬운 질문"과 나머지로 나눌지?
4. **안전 번들 전체를 L0 중단 쪽만 허용.** ADR-015 결정 4는 보안 판정(`security_warning`, `blocked`)만 명시했다. 구현은 `screen_state_v2`·`popup_class_v1`의 모든 질문에 같은 제한을 걸었다(더 보수적). 유지할지?
5. **핵심 choice refusal 우선순위.** D04 §2대로 `screen` refusal이면 `security_warning`이 0.9여도 결과가 `unknown`(핸드오프)이다. `blocked`(예약, 쿨다운)가 먼저여야 하는지?
6. **`doc_meta_check_v1`의 `needs_user`.** "선택값이 규칙표와 30일 넘게 차이"는 매핑 조건(스키마)으로 표현할 수 없다. 번들 매핑은 `ok`/`none_found`까지만 두고 엔진 결정적 후처리가 `ok`를 `needs_user`로 내리는 구조로 했다(후처리는 PoC-8 몫). 맞는가?
7. **L2 예산 계수.** "L2 ≤ 2회(턴 포함 토큰 상한 별도)"를 replay 없는 호출 = L2 1회로 세고, 이어지는 턴은 L2 × 3(툴셋 턴 상한)으로 묶었다. 매 HTTP 호출을 세면 `selector_repair` 3턴이 예산을 넘는다.
8. **BYOK `prompt_cache_key`.** 게이트웨이 정본은 `acct:<HMAC>:b:<bundleId>`다. BYOK는 사용자 자기 조직이라 `sax:b:<bundleWireId>`를 썼다. 형식 제한은 S9 실측 대상.

## 8. 남은 일

- PoC-3 이후: 홈택스 화면 100장 라벨 → `screen_state_v2` 정확도 표, L0 실측·승격(S-L0), S7 축소.
- 키 수령 후: `pnpm s9` 1회 실측 → S9.md 표 교체.
- 엔진 실행 루프에 `Judge` 연결(`decide` 스텝·복구), `doc_meta` 후처리(PoC-8), D06 전체판(인접 노드 결합 탐지 등, 테스트에 공백 분절 사업자번호가 마스킹·트립와이어를 모두 빠져나가는 사례를 남겼다).
- `packages/net/schemas`·`packages/model/schemas`는 `sovereign-ax/design/schemas` 사본이다. 원본이 바뀌면 `tests/model-bundles.test.ts`의 사본 일치 검사가 실패하므로 함께 바꾼다.
