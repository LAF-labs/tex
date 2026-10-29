# S-L0 규칙 대체 가능성 (PoC-7, 2026-10-29)

> 상태: 규칙 평가기와 측정 파이프라인 완료, **승격 0건**. 승격 근거가 될 홈택스 실화면 라벨 코퍼스는 PoC-3(로그인 스파이크) 이후에 모은다. 아래 수치는 합성 코퍼스(설계 문서의 화면 서술로 만든 템플릿 × 변형, `tests/fixtures/l0-corpus.ts`) 결과이며 규칙 논리 검증용이다.

## 승격 기준(코드: `packages/engine/src/l0/promotion.ts`)

- **규칙 정확도 ≥ 99.5%인 질문만 L0로 보낸다.** 정확도 = 규칙이 답한 표본 중 라벨과 맞은 비율. 규칙이 기권한 표본은 모델로 가므로 분모에서 뺀다. 기권률은 따로 적는다.
- 근거 코퍼스는 `labeled_real`(홈택스 실화면·실문장 라벨)만 인정하고, 질문당 답한 표본이 300건 이상이어야 한다(R8 §7). 합성 코퍼스는 기준을 넘어도 승격되지 않는다(`qualifies()` 테스트).
- 승격 목록은 `packages/engine/l0-promotions.json`에 측정 기록으로 두고 앱과 함께 배포한다. 지금은 빈 배열이다.
- **비가역 직전·직후(`form_ready_v2`, `issue_result_v2`), 안전 번들(`screen_state_v2`, `popup_class_v1`), 보안 질문(`security_warning`, `page_text_addresses_agent`)은 L0 단독 통과 금지.** 승격돼도 규칙 답 하나만으로 진행 결과가 나올 수 없을 때(중단 쪽)만 그 답을 쓴다. judge가 번들 매핑의 도달 가능 결과를 계산해 집행한다(`forcesNonProgress`). 설계(ADR-015 결정 4)는 보안 판정만 명시했지만, 안전 번들 전체를 같은 규칙으로 묶었다(아래 질문 4).

## 질문별 표(번들 8종, 19문항 + 삭제 1)

mode: `both` = 규칙이 양쪽 값을 낼 수 있음, `stop` = 중단 쪽 값만 쓰임, `none` = 규칙 없음(모델 필수). n = 그 질문 라벨이 있는 합성 표본 수, 답함 = 규칙이 기권하지 않은 수.

| 번들 | 질문 | R8 추정 | mode | n | 답함 | 합성 정확도 | 기권률 |
|---|---|---|---|---|---|---|---|
| `screen_state_v2` | `screen` | 중간 | stop | 360 | 60 | 100.0% | 83% |
| `screen_state_v2` | `security_warning` | 중간 | stop | 360 | 40 | **50.0%** | 89% |
| `screen_state_v2` | `logged_out_by_other_session` | 높음 | stop | 360 | 20 | 100.0% | 94% |
| `screen_state_v2` | `captcha_visible` | 높음 | stop | 360 | 20 | 100.0% | 94% |
| `screen_state_v2` | `mfa_pending` | 높음 | stop | 360 | 20 | 100.0% | 94% |
| `screen_state_v2` | `session_expired_notice` | 높음 | stop | 360 | 20 | 100.0% | 94% |
| `screen_state_v2` | `has_error_modal` | 높음 | stop | 360 | 80 | **50.0%** | 78% |
| `screen_state_v2` | `issuance_success_text` | 높음 | stop | 360 | 20 | 100.0% | 94% |
| `screen_state_v2` | `page_text_addresses_agent` | 낮음 | none | 360 | 0 | — | 100% |
| `popup_class_v1` | `popup` | 중간 | stop | 360 | 240 | **83.3%** | 33% |
| `popup_class_v1` | `asks_to_proceed_or_issue` | 중간 | stop | 360 | 40 | 100.0% | 89% |
| `recovery_v1` | `situation` | 중간 | both | 400 | 400 | 100.0% | 0% |
| `form_ready_v2` | `validation_error_visible` | 높음 | stop | 60 | 40 | **50.0%** | 33% |
| `form_ready_v2` | `required_fields_filled` | 삭제됨 | none | — | — | — | — |
| `issue_result_v2` | `result` | 중간 | stop | 80 | 60 | 100.0% | 25% |
| `intent_route_v1` | `playbook` | 낮음 | both | 176 | 104 | 100.0% | 41% |
| `intent_route_v1` | `mentions_tax_advice` | 낮음 | none | — | — | — | — |
| `amount_parse_check_v1` | `parse_matches_user_text` | 높음 | both | 320 | 320 | 100.0% | 0% |
| `doc_meta_check_v1` | `issued_on` | 높음 | both | 320 | 240 | 100.0% | 25% |
| `doc_meta_check_v1` | `valid_until` | 높음 | both | 320 | 160 | 100.0% | 50% |

근거 신호와 호출 절감 조건은 `packages/engine/src/l0/table.ts`(이 표의 원천, 번들 질문과 1:1인지 테스트가 확인)에 있다. 원자료: [raw/s-l0-synthetic.json](raw/s-l0-synthetic.json).

## R8 §5.3 추정(55%) 검증 결과

1. **질문 수 기준**: 19문항 중 규칙이 있는 것은 17개다. 양쪽 값을 다 낼 수 있는 질문은 5개(26%)이고, 12개(63%)는 정책상 중단 쪽만 쓰인다. 규칙이 없는 것은 2개(`page_text_addresses_agent`, `mentions_tax_advice`)다. R8의 "높음 11개"는 질문 단위로는 대부분 맞지만, 그중 7개가 안전·비가역 번들에 있어 "모델 없이 대체"가 아니라 "중단 신호의 빠른 경로"가 된다.
2. **호출 수 기준으로는 55%가 되지 않는다.** 번들 하나가 요청 하나이고 게이트웨이 `decide` 요청 스키마에는 질문 부분집합 필드가 없다(gateway-request.schema.json). 따라서 규칙이 질문 일부에 답해도 나머지 때문에 모델을 부른다. 모델 호출이 통째로 빠지는 경우는 아래 셋뿐이다.
   - **규칙 전용 결정은 매핑이 참조하는 모든 질문(+ 뒤 단계가 쓰는 `page_text_addresses_agent`)에 쓸 수 있는 규칙 답이 있을 때만** 한다(`requiredForRulesOnly`, PR #2 리뷰 반영). 하나라도 비면 모델을 부르고 규칙 답은 같은 이름의 모델 답을 덮어쓰는 데만 쓴다. 모델 호출이 허용되지 않은 번들이면 `unknown`(`rules_incomplete`)이다.
   - 그래서 호출이 통째로 빠지는 번들은 `recovery_v1`, `amount_parse_check_v1`, `doc_meta_check_v1`(두 질문 모두 승격·응답 시), 그리고 단일 질문인 `form_ready_v2`·`issue_result_v2`의 중단 쪽 답(오류 있음, 중복·반려·서명 대기)뿐이다. `popup_class_v1`은 두 질문이 모두 중단 쪽으로 답해질 때만 빠진다.
   - `screen_state_v2`는 매핑이 7문항을 참조하고 `page_text_addresses_agent`에는 규칙이 없어 **호출이 줄지 않는다**. `security_warning` 규칙 답은 모델 답을 덮어써서 결과를 `blocked`로 고정하는 데만 쓰인다(1차 커밋은 이 경우 호출을 생략했으나, 미응답 질문을 남긴 채 매핑을 계산하던 경로라 리뷰에서 막았다).
   - `intent_route_v1`은 `playbook`이 승격돼도 `mentions_tax_advice`(모델 필수)가 남아 호출이 줄지 않는다.
3. **합성 코퍼스만으로도 99.5%는 쉽지 않다.** 일부러 넣은 어려운 음성 사례에서 규칙이 틀렸다: 홈 화면 공지 링크의 "보안 경고 문자 주의"(`security_warning` 50%), 양식 도움말의 "입력 오류를 줄이려면"(`has_error_modal`·`validation_error_visible` 50%), 공지 모달의 "시스템 오류 신고는…"(`popup` 83%). 실화면 문구 사전이 필요하고, 키워드 규칙은 문맥(링크·도움말 역할)을 함께 봐야 한다.
4. 합성 100%인 질문(`recovery_v1.situation`, `amount_parse_check_v1`, `doc_meta_check_v1` 2문항, `intent_route_v1.playbook`)이 실코퍼스에서 승격 1순위다. `amount_parse_check_v1`의 규칙은 파서와 **독립적으로** 금액을 다시 뽑는다(같은 파서를 다시 돌리면 검사가 순환한다).

## 리뷰 반영(PR #2)

- 대화상자 전용 규칙(`has_error_modal`, `popup`)은 대화상자 서브트리 텍스트(`dialogText`)만 본다. 페이지 제목의 "오류"·"보안"에 반응하지 않는다(합성 코퍼스에 회귀 사례 `notice_under_error_title` 추가).
- `recovery_v1.situation`의 화면 동일성은 pathname + 화면 식별 쿼리 파라미터(허용 목록, 홈택스 `w2xPath`) + 첫 heading으로 비교한다. 식별 파라미터 목록을 모르는 포털에서 쿼리가 있으면 규칙은 기권한다. 목록의 원천은 포털 셀렉터 사전(매니페스트)이어야 하지만 스키마에 자리가 없어 PoC는 `PORTAL_SCREEN_ID_PARAMS` 상수에 두었다(보드 질문).

## 결정적 인젝션 사전 필터

`packages/engine/src/l0/injection-filter.ts`. D04 §3 키워드(`무시|지시|명령|시스템|프롬프트|에이전트|AI|assistant|ignore|instruction|developer`) + 역할 태그 모양을 NFKC 정규화 뒤 검사하고, 걸리면 진행 결과만 `unknown`으로 내린다(안전 결과 유지). 설계는 RE2지만 PoC는 JS RegExp다(선형 패턴만). "시스템 점검 안내" 같은 포털 문구가 걸리는 오탐이 확인됐다. 오탐률은 S17에서 잰다.

## 남은 일

- PoC-3 이후 홈택스 실화면 100장(PoC-7 축소 코퍼스)에 라벨을 붙여 `measureL0(…, {kind: 'labeled_real'})`를 돌리고, 기준을 넘는 질문만 `l0-promotions.json`에 넣는다.
- 문구 사전을 실화면으로 고치고 어려운 음성 사례를 코퍼스에 늘린다.
