# REVIEW-A — 플레이북 IR·엔진·모델 계층 설계 검수

> 대상: `design/00-overview.md`, `02-playbook-dsl.md`, `schemas/playbook-ir.schema.json`, `03-engine.md`, `04-model-layer.md`, ADR-002/003/004
> 교차 확인: D01, D05, D06, D07, D08, D09, D10, D11, D12, D14, 기획 `03-architecture.md`·`06-feasibility.md`·`README.md`
> 검수일 2026-10-28 · 검수자: 리뷰어 A(IR·엔진·상태 머신·복구) · 설계 문서는 수정하지 않았다.
> 방법: 문서 정독 → 제어 흐름 반례 구성 → JSON Schema 2020-12 하위 집합 검증기로 H-01 예시와 반례 IR 6개를 실제 검증(모두 **스키마 통과**).
> 판본 주의: 검수 도중(10:45) D02·D03·D04·D05·D08과 ADR-001/005/010/011이 갱신되었다. 모든 발견 사항을 10:45 판본에 다시 대조했다. 일부 해소된 항목은 본문에 "(10:45 판 반영)"으로 표시했다. 스키마 파일(10:15)은 바뀌지 않았다.

## 0. 총평

방향은 맞다. 선언적 IR, 승인 없이는 빠져나갈 수 없는 게이트 상태, 열거형 판정, 읽기 전용 복구 도구라는 뼈대는 유지할 가치가 있다. 그러나 ADR-002가 내세우는 핵심 주장, 곧 **"비가역 앞 승인을 코드 리뷰가 아니라 기계적으로 보장한다"는 현재 명세로는 성립하지 않는다.** 이유는 셋이다.

1. **비가역성을 작성자가 스스로 신고한다.** 커밋 버튼에 `irreversible`을 안 붙인 `click`이나 `press Enter`는 V-03 검사 대상이 아니다.
2. **V-03은 "게이트가 앞에 있다"(지배 관계)만 본다. 승인이 아직 유효한지, 승인과 실행 사이 구간이 온전한지는 보지 않는다.** 게다가 검사의 바탕이 될 제어 흐름 그래프(CFG)의 간선 정의가 아예 없다. 폴스루, `onFail` 점프, `recover`/`handoff` 의사 동작, `resumeAt`, 엔진이 암묵적으로 하는 세션 체크포인트 복귀가 모두 빠져 있다.
3. **아이덴포턴시가 "로컬 키 + 현재 화면 판정"뿐이다.** 크래시나 네트워크 단절 뒤에 남는 "제출됐는지 모름" 상태를 풀 수단이 없다. 상태 머신에도 그 상태가 없다.

심각도 집계: **치명 8 · 높음 22 · 중간 18 · 낮음 7**(총 55건)

---

## 1. 반례 IR — 스키마와 문서상 정적 규칙을 통과하지만 위험하게 실행되는 것

공통 머리(생략): `{"ir":1,"id":"hometax.invoice.issue","version":"1.3.1","portal":"hometax","profileKinds":["business"],"inputs":{…},"postconditions":[…]}`. `G` = `{"id":"s1","type":"gate","card":"invoice.confirm","fields":["inputs.amounts"],"ttlMs":600000}`.

### CE-1 게이트 뒤 체크포인트와 역방향 점프로 재제출(다른 값, 같은 토큰)

```json
[G,
 {"id":"s2","type":"checkpoint","name":"form"},
 {"id":"s3","type":"extract","name":"supply","from":{"selector":"hometax.invoice.form.altSupply"}},
 {"id":"s4","type":"fill","target":"hometax.invoice.form.item1.supply","value":"$vars.supply"},
 {"id":"s5","type":"submit","target":"hometax.invoice.form.issueButton","irreversible":true,
  "idempotencyKey":"$vars.supply|$inputs.issueDate","verify":"s6",
  "onFail":{"retry":0,"then":"checkpoint:form"}},
 {"id":"s6","type":"decide","bundle":"issue_result_v1","scope":"root",
  "on":{"issued":"s7","pending_auth":"s7","duplicate":"s7","rejected":"s2","unknown":"handoff"}},
 {"id":"s7","type":"end","status":"success"}]
```
- 정적 검사: s1이 s5를 지배하고, 사이에 `goto`·`handoff`가 없다(V-03 ✓). V-04 ✓, V-07 ✓.
- 실행 흐름: s1 승인 → s5 제출 → s6이 `rejected`(오판일 수 있음) → s2 → s3이 vars를 바꿈 → s5 **재제출**.
- 런타임 토큰: `runId|stepId|inputsHash|exp`는 그대로이고 10분 안이므로 통과한다. 키에 `$vars`가 들어 있어 `irreversible_log`에도 걸리지 않는다.
- 결과: 사용자가 본 적 없는 값으로 두 번째 발급이 나간다. `onFail: checkpoint:form`에서도 같은 일이 생긴다.

### CE-2 `repeat` 안의 비가역 스텝에 게이트는 한 번

```json
[G,
 {"id":"s2","type":"repeat","max":20,"until":{"exists":"hometax.invoice.list.empty"},"steps":[
   {"id":"s3","type":"click","target":"hometax.invoice.list.firstRow"},
   {"id":"s4","type":"submit","target":"hometax.invoice.form.reissueButton","irreversible":true,"idempotencyKey":"$vars.rowNo","verify":"s5"},
   {"id":"s5","type":"decide","bundle":"issue_result_v1","scope":"root","on":{"issued":"s3","pending_auth":"s3","duplicate":"s3","rejected":"handoff","unknown":"handoff"}}]},
 {"id":"s6","type":"end","status":"success"}]
```
승인 1회로 비가역 20회가 나간다. 중첩 깊이 2(V-05)까지 쓰면 400회다. D03 §8의 "건별 토큰"을 IR로 표현할 수단이 없다.

### CE-3 자기 신고 누락과 오탈자: 게이트 없는 커밋

```json
[{"id":"s1","type":"fill","target":"hometax.invoice.form.item1.supply","value":"$inputs.amounts.supply"},
 {"id":"s2","type":"press","key":"Enter"},
 {"id":"s3","type":"click","target":"hometax.invoice.form.issueButton","irreversable":true},
 {"id":"s4","type":"goto","url":"https://hometax.go.kr/","irreversible":true,"evil":{"anything":1}},
 {"id":"s5","type":"end","status":"success"}]
```
- s2(폼 안 Enter)와 s3(발급 버튼)이 실제 커밋인데, `irreversible` 스텝이 없으니 V-03은 공허하게 참이다.
- 오탈자 `irreversable`과 임의 필드 `evil`이 스키마를 통과한다(`additionalProperties`/`unevaluatedProperties` 없음).
- `goto`에 `irreversible:true`를 붙여도 통과한다.

### CE-4 게이트–제출 구간의 사람 개입, 제출 타깃 L2 수리, `unknown`→재제출, 상수 키, 이메일 4회

```json
[G,
 {"id":"s2","type":"decide","bundle":"form_ready_v1","scope":"hometax.invoice.form.root","on":{"ready":"s3","validation_error":"handoff","unknown":"handoff"}},
 {"id":"s3","type":"fill","target":"hometax.invoice.form.memo","value":"x","onFail":{"retry":0,"then":"human:manual"}},
 {"id":"s4","type":"submit","target":"hometax.invoice.form.issueButton","irreversible":true,
  "idempotencyKey":"const","verify":"s5","onFail":{"retry":0,"then":"recover","handoffAfter":2}},
 {"id":"s5","type":"decide","bundle":"issue_result_v1","scope":"root","on":{"issued":"s6","pending_auth":"s6","duplicate":"s6","rejected":"handoff","unknown":"s4"}},
 {"id":"s6","type":"send_email","via":"portal","to":"$inputs.notDeclared","irreversible":true,"onFail":{"retry":3,"backoffMs":[0,0,0]}},
 {"id":"s7","type":"end","status":"success"}]
```
- s2·s3: `handoff`/`human:manual`이 게이트–제출 사이에 들어간다. V-03은 `handoff` **스텝**만 금지하고, 의사 동작은 막지 않는다.
- s4: 제출 실패 시 `recover`(L2)가 발급 버튼 셀렉터를 모델 제안으로 바꾼다.
- s5: `unknown → s4`로 확인되지 않은 상태에서 재제출한다. V-07은 `unknown` 키가 있는지만 본다.
- 키 `"const"`는 허용된다.
- s6: 선언되지 않은 입력을 참조하고, 비가역인데 재시도 3회에 지연 0이다. V-04는 `submit`에만 적용된다.

### CE-5 게이트 앞의 `handoff`가 `resumeAt`으로 게이트 뒤에 착지

```json
[{"id":"s1","type":"checkpoint","name":"session"},
 {"id":"s2","type":"handoff","reason":"manual_login","resumeAt":"form"},
 {"id":"s3","type":"gate","card":"invoice.confirm","fields":["inputs.amounts"],"ttlMs":600000},
 {"id":"s4","type":"checkpoint","name":"form"},
 {"id":"s5","type":"submit","target":"hometax.invoice.form.issueButton","irreversible":true,"idempotencyKey":"$inputs.issueDate","verify":"s6"},
 {"id":"s6","type":"decide","bundle":"issue_result_v1","scope":"root","on":{"issued":"s7","pending_auth":"s7","duplicate":"s7","rejected":"handoff","unknown":"handoff"}},
 {"id":"s7","type":"end","status":"success"}]
```
- `resumeAt`을 CFG 간선으로 보느냐는 명세에 없다. 안 보면 V-03을 통과하고, 실행 시 s2→s4→s5로 게이트를 건너뛴다.
- 첫 통과라면 토큰이 없어 런타임 검사가 막는다. 그러나 같은 실행에서 앞서 게이트를 지난 적이 있으면(10분 이내) 그때 받은 토큰이 유효하다.

### CE-6 `goto` 스킴과 상수 수신자

```json
[G,
 {"id":"s2","type":"goto","url":"javascript:document.querySelector('#issueBtn').click()"},
 {"id":"s3","type":"send_email","via":"local","to":"ops@example.org","irreversible":true},
 {"id":"s4","type":"end","status":"success"}]
```
- 2020-12에서 `format: "uri"`는 기본적으로 주석(annotation)일 뿐이다. 설사 검증을 켜도 `javascript:` URI는 RFC 3986상 유효하다.
- V-06을 "호스트가 있으면 목록 확인"으로 구현하면 호스트 없는 스킴은 그대로 통과한다.
- `send_email.to`는 상수 문자열을 받는다. V-13은 사업자번호·주민번호 형식만 막으므로, 서명된 패키지가 고정된 외부 주소로 서류를 보낼 수 있다.

---

## 2. 발견 사항

### A. IR과 정적 규칙(V-03 중심)

#### A-01 [치명] 비가역성이 작성자의 자기 신고에 의존한다
- **위치**: D02 §4 표(`click` "기본 아니오. `irreversible: true` 가능"), §6 V-03, 스키마 `stepBase.irreversible`
- **내용**: V-03은 `irreversible: true`인 스텝에만 걸린다. 실제로 커밋을 일으키는 동작은 여러 가지다. 플래그 없는 발급 버튼 `click`, 폼 안에서의 `press Enter`, L1이 팝업을 "닫는" 클릭(D-01), `confirm()` 수락(D-01). 이들은 모두 규칙 밖에 있다(CE-3).
- **영향**: 원칙 4("최종 실행 버튼은 항상 사용자")가 플레이북 작성자의 실수 한 번, 또는 서명된 악성 패키지 하나로 무너진다. 이것이 ADR-002가 막겠다고 한 시나리오 그 자체다.
- **수정**:
  1. `selectors.json` 항목에 `commits: true|false`(필수)를 둔다. 접근성 이름이 `/발급|제출|신청|전송|서명|승인|삭제|취소|확인|저장/`에 맞는 버튼은 `commits:false`일 때 검토자 주석을 필수로 한다(린트).
  2. 정적 규칙 **V-16**: `commits:true` 타깃에 대한 `click`/`press`는 `irreversible:true`여야 한다. `press`는 `key ∈ {Enter, Space}`이고 포커스 타깃이 `commitForm` 안이면 비가역으로 간주한다.
  3. 런타임 **커밋 가드**: `manifest.commitEndpoints[]`(호스트+경로 패턴, 메서드)를 둔다. 엔진은 `page.route`로 이 요청을 감시한다. 무장된(armed) 게이트 토큰이 없으면 요청을 중단(abort)하고 보안 이벤트를 남긴다. 사용자가 직접 조작하는 `HandedOff` 상태에서는 감시만 한다. 실제 Chrome에서 route 가로채기가 탐지 신호가 되는지는 S8에서 같이 측정한다.

#### A-02 [치명] V-03은 지배 관계만 보고 승인의 신선도와 구간 무결성은 보지 않는다
- **위치**: D02 §6 V-03, D03 §2(gateToken), D03 §4(체크포인트 복귀)
- **내용**: "도달 가능한 모든 경로상 앞에 gate"는 지배(dominance) 검사다. CFG에 순환(`decide.on` 역방향 점프, `checkpoint:` 복귀, `repeat`)이 있으면, 게이트를 한 번 지난 뒤 게이트와 비가역 스텝 사이로 다시 들어오는 경로가 생긴다. 이 경로도 지배 조건은 만족한다(CE-1, CE-2). 토큰은 단일 사용이 아니고 `inputsHash`만 묶으므로 런타임 이중 안전장치도 통과한다.
- **영향**: 승인 1회로 여러 번, 또는 승인과 다른 값으로 비가역 실행이 나간다.
- **수정**: §3의 **"커밋 구간(commit window) 규칙" V-03a~h**로 교체하고, 런타임 규칙 R-G1~G5(§3)를 추가한다.

#### A-03 [치명] 게이트와 비가역 스텝 사이에서 화면 상태를 바꾸는 스텝이 허용되고, 카드는 입력값만 보여준다
- **위치**: D02 §6 V-03(금지 목록이 `goto`·`handoff` 둘뿐), §7 s20 `fields`, D03 §8
- **내용**:
  - 게이트 뒤의 `fill`/`select`/`click`/`extract`/`human`/`secret_fill`/`sign`/L2 수리가 모두 허용된다.
  - 카드는 `inputs.*`, 곧 "의도한 값"만 보여 주고 "화면에 실제 입력된 값"은 보여 주지 않는다.
  - 구체 시나리오: s16·s17의 셀렉터가 드리프트하거나 L2 수리로 공급가액과 세액 칸이 **뒤바뀌어** 입력된다. s18 `sumEquals`는 합이 같으니 통과하고, `form_ready_v1`도 ready로 판정한다. 카드는 입력값을 정상으로 보여 주고, 사용자가 승인하면 뒤바뀐 세금계산서가 발급된다.
- **영향**: "보여 준 것 ≠ 제출하는 것". 승인의 의미가 사라진다.
- **수정**:
  1. 게이트 직전에 **readback 단계**를 필수로 한다. 비가역 스텝이 제출할 각 필드를 화면에서 다시 읽는다. 읽을 때는 셀렉터 사전의 `readbackOf` 항목을 쓰되, 라벨·역할로 찾고 수리된 셀렉터는 쓰지 않는다. 읽은 값을 정규화해 입력값과 비교한다.
  2. 카드는 **readback 값**을 표시한다. 토큰에는 readback 해시를 묶는다(R-G1).
  3. 게이트 뒤에는 V-03c의 허용 스텝만 둔다.

#### A-04 [높음] `repeat` 안의 비가역 스텝을 막는 규칙이 없다
- **위치**: D02 §4 `repeat`, V-05; D03 §8 묶음 승인
- **내용**: CE-2 참조.
- **수정**: V-03e(§3). 묶음 발급(Phase 3)은 `repeat` 대신 `batch_gate`라는 전용 스텝 타입으로 설계한다. 이 스텝은 건별 토큰을 발급하고 건별로 소비하며, 각 건은 자기 readback 해시에 묶인다.

#### A-05 [높음] CFG의 간선 집합이 정의되지 않았다
- **위치**: D02 §4·§5·§6(V-03, V-11), D03 §3 `plan()`, §4, §5
- **내용**: 정적 분석기를 짜려면 간선 목록이 필요한데 다음이 모두 미정이다.
  - 폴스루 순서(배열 순서인가?)
  - `submit` 성공 뒤 다음 스텝(H-01의 s21 → s22인가, `verify`인 s30인가?)
  - `on`/`then`의 의사 동작 `recover`·`handoff`·`human:*`·`abort`의 착지점
  - `handoff.resumeAt`, 엔진 암묵 전이(D03 §4(3) "세션 만료 → `session` 체크포인트", "가장 가까운 체크포인트")
  - `repeat` 본문 안으로 들어가거나 밖으로 나가는 점프, `repeat.max` 소진 시 동작
  - 이 때문에 CE-4·CE-5는 구현자의 해석에 따라 통과도 거부도 된다.
- **영향**: M1-4(정적 검증기, 8일)를 착수할 수 없다. 두 구현자가 서로 다른 V-03을 만들게 된다.
- **수정**: D02에 "§4.3 제어 흐름 의미론"을 신설한다.
  - (1) 폴스루 = 같은 `steps` 배열의 다음 원소. `repeat` 본문의 마지막 → `repeat` 헤더. 헤더는 `until` 참 또는 `max` 소진 시 다음 원소로 간다. **`max` 소진은 실패로 처리하고 `onFail`을 탄다.**
  - (2) `submit`/비가역 스텝의 다음은 항상 `verify`다. 폴스루는 없다.
  - (3) 의사 동작 정의: `handoff`는 합성 노드 H로 가며, H의 재개 간선은 IR에 `resumeAt`으로 **반드시 명시**한다. `recover`는 그 스텝을 지배하는 모든 체크포인트로 가는 간선이다. `checkpoint:n`은 이름 n인 단일 스텝으로 간다(**체크포인트 이름은 유일**, V-17).
  - (4) 엔진 암묵 전이(세션 만료, 팝업 처리)도 CFG에 합성 간선으로 넣는다.
  - (5) `repeat` 경계를 넘는 점프는 금지한다.
  - (6) V-11 = "모든 노드에서 `end` 또는 `abort`에 도달 가능하고, `repeat` 밖의 순환은 V-18(순환 상한 선언)을 가져야 한다."

#### A-06 [높음] 비가역 스텝의 파라미터가 게이트 카드에 없어도 통과한다
- **위치**: D02 §7 s20 `fields`(email 없음) vs s33 `to: $inputs.email`; §7 `inputs`에 `email` 미선언; 스키마 `send_email.to`(valueRef 상수 허용)
- **내용**:
  - H-01의 s33은 사용자가 승인한 적 없는 수신자에게 비가역 전송을 한다.
  - `inputs.email`이 선언되지 않은 상태로 참조되는데, 이를 잡는 규칙이 없다.
  - `required:false`인 입력이 비어 있을 때 `send_email`이 무엇을 하는지 정의가 없다.
  - 상수 `to`가 허용된다(CE-6).
- **수정**:
  - V-03h(§3).
  - **V-15**: 모든 `$inputs.X`는 선언된 입력이어야 한다. `$vars.X`는 그 변수를 쓰는 `extract`/`capture`가 사용 지점을 지배해야 한다. `$human.sN`은 sN이 `human`이고 사용 지점을 지배해야 한다.
  - `send_email.to`와 `attach`는 `$inputs`/`$artifacts` 참조만 받는다.
  - 선택 입력을 쓰는 비가역 스텝 앞에는 `branch`로 존재를 확인하도록 강제한다.

#### A-07 [중간] H-01 예시가 자기 규칙을 어기거나 모순된다
- **위치**: D02 §7, "검증기 통과 근거"
- **내용**:
  - (1) s2·s6·s93의 `on`에 `screen_state_v1`의 결과 `blocked`가 없어 V-07을 위반한다(엔진이 가로챈다면 그 사실을 V-07에 적어야 한다. E-01 참조).
  - (2) s10 체크포인트는 `form.root`를 기대하는데, 이동(s11 `goto`)보다 앞에 있다. 체크포인트 `expect`가 사전조건인지 사후조건인지 정의가 없다.
  - (3) `captcha_or_mfa` → s90(캡차 전용, `region` 필요)이라 MFA(앱 승인 대기)가 캡차 입력 경로로 간다.
  - (4) s22 `sign` ↔ s30 `pending_auth` 순환에 상한이 없다.
  - (5) s3 다음의 "인증서 선택"이 모델링되어 있지 않다(D05 §6은 하네스가 고른다고 함).
  - (6) (10:45 판과 충돌) D05 §4가 "홈택스 브라우저 인증서 모드는 가상키패드 필수, 타이피스트는 대신 누르지 않음"으로 바뀌었다. 그런데 예시 s4는 여전히 `secret_fill cert_password`를 기본 경로로 두고 있다. 실제로는 항상 `human:secret`으로 떨어진다.
- **영향**: 구현자가 예시를 기준 구현으로 삼으면 결함이 그대로 복제된다.
- **수정**: 예시를 새 규칙으로 다시 쓰고 리플레이 하네스의 골든 테스트로 고정한다. 순환에는 `{"loopGuard": {"max": 3}}`(V-18)를 붙인다.

#### A-08 [중간] 체크포인트 선언 방식이 세 가지이고 의미가 미정이다
- **위치**: 스키마 최상위 `checkpoints[]`, `stepBase.checkpoint`, `checkpoint` 스텝 타입; D03 §4 `{name, expect, url?, sessionRequired}`
- **내용**: 같은 개념을 세 곳에서 선언할 수 있다. `url`과 `sessionRequired`는 스키마에 없다. "현재 탭에서 `expect`가 참이면 그 지점부터 재실행"하면 이미 채워진 폼 위에서 다시 입력한다. 10:45 판의 기본 `fill()`은 Playwright가 기존 값을 지우므로 괜찮다. 그러나 `keyEvents: true` 칸은 키 이벤트로 덧붙을 수 있고, 지우는 규칙이 없다. 게다가 `keyEvents`는 산문(D02 §4)에만 있고 스키마에는 없다.
- **수정**:
  - `checkpoint` 스텝 하나로 통일한다(`stepBase.checkpoint`와 최상위 배열 삭제).
  - `fill`의 의미를 "기존 값 제거(키 이벤트 칸은 전체 선택 → 삭제) → 입력 → readback 일치 확인"으로 고정하고, `keyEvents`를 스키마에 추가한다.
  - 체크포인트 `expect`는 **도착 조건**(그 스텝을 지난 뒤 참)으로 정의한다.

#### A-09 [높음] `portalMode` 변환으로 만든 플랜은 정적 검증을 다시 받지 않고, `assisted`의 비가역 의미가 정의되지 않았다(10:45 판 신설 부분)
- **위치**: D02 §10, D03 §12, ADR-011
- **내용**:
  - 엔진이 **로드·검증 뒤에** IR을 변환한다. `assisted`는 로그인 구간과 `submit`·`sign`을 `human(kind=manual)`로 바꾼다.
  - 변환된 플랜에서 비가역 지점은 "사람이 직접 누르는 순간"이다. 그런데 (1) 게이트 토큰을 언제 소비하는지, (2) `irreversible_log`의 `armed`를 누가 언제 기록하는지, (3) 사람이 두 번 누르거나 누르지 않고 "완료"를 누르는 경우, (4) `verify` 간선이 `human` 스텝 뒤에서도 유지되는지가 모두 정해지지 않았다.
  - `send_email`은 변환 대상이 아니어서 자동 비가역으로 남는다. 그 사이 `human(manual)`이 끼면 V-03의 "핸드오프 금지" 취지와 충돌한다.
  - `postprocess`의 `guide` 변환은 `fill` 값을 '복사' 버튼으로 준다. 사업자번호·금액이 OS 클립보드에 남는데, 그 보존과 삭제 규칙이 없다.
- **수정**:
  - 변환 결과를 **같은 검증기로 다시 검증**하고, 검증 실패 시 그 모드에서 실행하지 않는다.
  - `human_commit` 스텝 타입을 정의한다. 토큰 소비 → `armed` 기록 → 사람에게 화면 전달 → 사람의 "제출함/안 함" 증언 → `verify`(조회) 순서이고, 증언은 `verify`를 대신하지 못한다.
  - `assisted`에서는 후속 `send_email`도 `human_commit`으로 바꾼다.
  - 복사 버튼은 30초 뒤 클립보드를 비운다(값이 바뀌지 않았을 때만).

### B. 아이덴포턴시(`submit` + `idempotencyKey` + `verify`)

#### 실패 시퀀스별 판정

| # | 시퀀스 | 현재 설계에서 중복 발급 가능? | 근거 |
|---|---|---|---|
| 1 | 클릭 → 포털 처리 완료 → 결과 렌더 전 네트워크 단절 → 타임아웃 | **가능** | `verify`(s30)는 현재 화면만 판정한다. 오류 페이지가 `unknown`이면 handoff, 사용자가 다시 누른다. `rejected`(≥0.95 오판)이고 다른 플레이북이 체크포인트로 매핑했다면 재게이트 → 재제출 |
| 2 | 포털 이중 제출(이중 클릭, Enter + 클릭, `confirm` 재표시) | **가능** | `click irreversible`/`send_email`에는 V-04가 없어 재시도 최대 3회. `pending_auth` ↔ `sign` 무한 순환 |
| 3 | 클릭과 `verify` 사이에 프로세스 크래시 | **가능** | Running 상태 복구 규칙이 없다. `irreversible_log` 기록 시점이 정해지지 않았다(`executed_at NOT NULL`이라 사후 기록으로 읽힘). 재시작 후 새 실행 → 재게이트 → 재제출 |
| 4 | 제출 뒤 `sign` 단계의 human TTL 초과 → "체크포인트 복귀 후 Paused" → 재개 | **가능 또는 고착** | 복귀 지점이 `form`(게이트 앞)이라 재게이트 후 s21 재실행. 키가 같으면 "건너뛰기"인데 그 의미가 미정이고, 다르면(자정을 넘겨 `issueDate`가 바뀌면) 중복 |
| 5 | 리모트 `cmd.run`이 큐(≤7일)에 있다가 재전달(at-least-once), 데스크톱 재기동으로 10분 `id` 캐시 소실 | **가능** | 다음 날 실행되면 `issueDate default "today"`가 바뀌어 키가 달라진다 |
| 6 | 데스크톱 2대(D09: desktop 1~2) 또는 재설치 | **가능** | `irreversible_log`가 기기 로컬에만 있다 |
| 7 | 정당한 동일 거래 2건(같은 거래처·금액·날짜) | **거짓 차단** | 업무 키가 충돌해 두 번째 건이 영구히 막힌다 |

#### B-01 [치명] `verify`가 "제출되지 않았음"을 증명할 수단이 없다
- **위치**: D02 §5("verify 스텝으로 실제 제출 여부 확인(아이덴포턴시 키 조회) → 미제출 확인 후에만 체크포인트 복귀"), D04 §3 `issue_result_v1`, 기획 `03-architecture.md` §68("승인번호 조회로 확인")
- **내용**:
  - 포털은 우리 아이덴포턴시 키를 모르므로 "키 조회"가 불가능하다.
  - `issue_result_v1`의 결과 {issued, pending_auth, duplicate, rejected, unknown}에는 `not_submitted`가 없다. `rejected`는 "포털이 거부함"이지 "제출이 안 됨"이 아니다.
  - 현재 화면 판정은 크래시나 단절 뒤에 아무 정보도 주지 못한다.
  - 기획서가 의도한 "승인번호 조회"가 설계에서 빠졌다.
- **수정**:
  - `verify`를 화면 판정이 아니라 **포털 측 조회 하위 흐름**으로 바꾼다. `verify: {"playbook":"hometax.invoice.lookup","match":{"counterpartBizNo":…,"issueDate":…,"supply":…,"tax":…,"itemName":…},"window":"issueDate±0"}`.
  - 판정은 결정적 비교(모델 아님)로 하고, 결과는 `committed|not_committed|unknown`이다.
  - `not_committed`일 때만 재시도 경로로 간다. `unknown`이면 InDoubt(C-01) 상태로 두고 사람에게 넘긴다. 카드에 "홈택스 발급목록에서 먼저 확인하세요"를 고정 문구로 넣는다.
  - 선택안: 사용자 동의를 받아 비고란에 짧은 의도 코드(예: `AX-7K3P`)를 기재해 조회 정확도를 높인다.

#### B-02 [치명] `irreversible_log`의 선행 기록(write-ahead) 규칙이 없다
- **위치**: D07 `irreversible_log(executed_at NOT NULL, verified DEFAULT 0)`, D03 §4 `runRecord.irreversibleDone[]`
- **내용**: 클릭 전에 기록하는지 후에 기록하는지 정의가 없다. 클릭 후 기록이면 시퀀스 3에서 중복이 난다. 또 실행별 목록(`irreversibleDone[]`)과 전역 테이블(`irreversible_log`)이 이중으로 정의되어 있다.
- **수정**:
  - 상태를 `armed → dispatched → committed | not_committed | in_doubt`로 정의한다.
  - **토큰 소비와 `armed` 기록을 한 트랜잭션으로** 하고, 커밋 후(`PRAGMA synchronous=FULL`) 클릭한다.
  - 클릭이 반환되면 `dispatched`, verify 결과에 따라 마지막 상태로 바꾼다.
  - 재시작 시 `armed|dispatched` 행은 모두 `in_doubt`로 승격한다.
  - 같은 의도 키나 업무 키에 `armed|dispatched|in_doubt|committed`가 있으면 재실행을 금지한다. `in_doubt`를 해소하는 방법은 B-01의 조회나 사용자의 명시적 확인("발급목록에 없음을 확인했습니다") 둘뿐이다.
  - `irreversibleDone[]`은 삭제하고 테이블 하나로 통일한다.

#### B-03 [높음] 키 설계가 유일하지도, 안정적이지도, 공유되지도 않는다
- **위치**: D02 §7 s21 `idempotencyKey`, 스키마(`idempotencyKey: string`, 상수 허용)
- **내용**:
  - (a) 업무 키는 정당한 동일 거래를 막는다(시퀀스 7).
  - (b) `issueDate default "today"`의 확정 시점(폰에서 명령을 만든 시점? `prepare`? 사용 시점?)이 정해지지 않아 키가 흔들린다.
  - (c) 금액 표기("3,300,000"과 3300000)와 구분자 연결의 정규화 규칙이 없다.
  - (d) 기기 간에 공유되지 않는다.
  - (e) 상수 키가 허용된다(CE-4).
- **수정**:
  - **의도 키 = `intentId`**(ULID): `prepare()`가 만들고 카드에 표시하며, 리모트 `cmd.run`이라면 폰에서 만든다. 아이덴포턴시 판정은 이 키로 한다.
  - **업무 중복 키**: 정규화(JCS, RFC 8785)한 (거래처, 공급가, 세액, 날짜)의 해시. 적중하면 차단하지 않고 카드에 경고를 띄워 명시적 확인을 받는다.
  - 기본값(`today`)은 `prepare()`에서 한 번만 확정해 입력에 고정한다.
  - 선택안: 업무 중복 키의 HMAC을 메타데이터 서버에 올려 기기 간 경고에 쓴다(`dedup_token`과 같은 방식).
  - 스키마: `idempotencyKey`는 `$intent.id`를 포함해야 한다(패턴).

#### B-04 [높음] V-04가 `submit`에만 적용된다
- **위치**: D02 §1("비가역 스텝은 … 아이덴포턴시 키를 가져야 한다") vs V-04, 스키마 `send_email`/`click`
- **내용**: `send_email`과 `click irreversible`에는 키·`verify`·`retry=0`이 강제되지 않는다(CE-4 s6: 재시도 3회, 지연 0).
- **수정**: V-04를 "모든 비가역 스텝"으로 넓힌다. `onFail.retry`는 0으로 고정하고, `onFail.then`은 `handoff|abort`만 허용한다(V-03f).

#### B-05 [높음] 이미 실행된 비가역 스텝의 "건너뛰기" 의미가 정의되지 않았다
- **위치**: D03 §4("다시 실행되지 않는다")
- **내용**: 건너뛴 뒤의 `StepResult`가 무엇인지, `verify`로 가는지, 다음 스텝(예: `sign`)으로 가는지 정의가 없다. 시퀀스 4에서 "제출은 건너뛰었는데 서명 대화상자는 없음" 상태로 빠진다.
- **수정**: 건너뛰기는 금지한다. 같은 의도 키가 `committed`이면 `verify` 결과를 재사용해 **사후 스텝**(`capture` 이후)으로 점프한다. `in_doubt`이면 InDoubt 상태로 간다. 그 외에는 B-02 규칙을 따른다.

#### B-06 [중간] 리모트 명령의 중복 제거가 비가역 원장과 연결되지 않는다(10:45 판 일부 반영)
- **위치**: D08(10:45 판) `Intent{…cmd_id…}`, "처리 `cmd_id` 디스크 영속, 큐는 실행이 아니라 새 승인", `cmd.run.body.idempotency`(필드명만 존재)
- **내용**: 10:45 판에서 `cmd_id` 영속과 "큐 드레인 시 새 게이트"가 들어가 시퀀스 5의 자동 재실행은 막혔다. 남은 문제는 세 가지다.
  - `cmd_id`는 "같은 명령 재처리 방지"일 뿐이다. 사용자가 폰에서 같은 발급을 두 번 지시하거나(서로 다른 `cmd_id`), 데스크톱에서 이미 처리한 건이 늦게 도착하면 막지 못한다.
  - `issueDate default "today"`를 폰에서 확정하는지, 드레인 시점에 확정하는지 정해지지 않았다.
  - 본문의 `idempotency` 필드와 `cmd_id`의 관계가 정해지지 않았다.
- **수정**: `cmd_id`를 B-03의 `intentId`로 쓰고(폰에서 생성), 기본값은 폰에서 확정해 `Intent.inputs`에 고정한다. 드레인 시 `irreversible_log`의 업무 중복 키와 대조해 카드에 "이미 데스크톱에서 같은 건 발급됨" 경고를 띄운다. `idempotency` 필드는 삭제하거나 `cmd_id`와 통합한다.

#### B-07 [중간] 데몬의 "1회 재시도(30분 후)"가 InDoubt를 확인하지 않는다
- **위치**: D10 §3
- **수정**: 직전 실행에 `in_doubt` 기록이 있으면 재시도하지 않고 `notify`로 강등한다. 민원서류는 재발급 비용이 작더라도 일일 상한과 캡차 노출에 영향을 준다.

### C. 상태 머신

#### C-01 [치명] 크래시와 강제 종료에 대한 복구 규칙이 없고, InDoubt 상태가 없다
- **위치**: D03 §2(Paused만 직렬화), §10("앱 종료 시 Chrome도 종료")
- **내용**: `Running`·`WaitingGate`·`WaitingHuman`·`HandedOff`·`Recovering` 도중 크래시가 나면 실행이 어디로 가는지 정의가 없다. 커밋 도중 앱을 종료하면 Chrome이 강제 종료된다.
- **수정**:
  - 상태를 추가한다. `Interrupted`(재시작 시 비종료 상태를 일괄 변환)와 **`InDoubt`**(비가역을 시도했지만 결과 미확정. 빠져나가는 길은 verify 조회 또는 사용자 증언뿐).
  - 실행 저널(`run_events`)을 상태 전이의 단일 진실로 삼는다.
  - 커밋 구간에서는 앱 종료를 막고 확인 대화상자를 띄운다. OS 종료 신호를 받으면 저널에 `in_doubt`를 선기록한다.

#### C-02 [높음] 게이트 토큰 바인딩이 부족하다. 게이트 뒤에 vars가 바뀌면 `inputsHash`로는 못 잡는다
- **위치**: D03 §2, §8 `HMAC(runKey, runId|stepId|inputsHash|exp)`
- **내용**:
  - 비가역 실행의 실제 파라미터는 `inputs`만이 아니다. `vars`(추출값), `$human` 답, `$profile`(서명 수단, 사업자번호), **화면 상태**, 셀렉터(핫픽스 `selectors.json`, L2 수리)도 포함된다. 이 중 어느 것도 해시에 묶이지 않는다.
  - `stepId`가 게이트 스텝인지 비가역 스텝인지 정해지지 않았다. 토큰 하나로 s21과 s33을 함께 허가하는지도 알 수 없다.
  - 재사용 금지 규정이 없다.
  - 문자열 연결 인코딩이 모호하다.
  - (10:45 판 반영) D08은 이제 `gate.request`에 `actionHash`·`challenge`·`exp(120s)`를 넣고, 폰이 기기 키로 `reqId‖challenge‖actionHash‖decision`에 서명한다. 방향은 옳다. 그러나 (1) **`actionHash`의 원상(무엇을 해시하는지)이 어디에도 정의되어 있지 않고**, (2) 서명에 들어가는 `reqId`가 `gate.request` 필드에 없으며, (3) D03 §2·§8의 토큰은 여전히 `inputsHash`만 묶는다. 폰 서명과 엔진 토큰이 서로 다른 것에 묶여 있다.
- **수정**(R-G1):
  - 토큰 = `HMAC(runKey, CBOR{runId, gateStepId, authorizes:[stepIds], cardHash, readbackHash, packageDigest(IR+selectors+핫픽스), profileVersion, intentId, exp, nonce})`.
  - **단일 사용**으로 하고, 소비는 B-02의 `armed` 기록과 원자적으로 한다.
  - D08의 `actionHash`를 위의 `cardHash‖readbackHash‖authorizes‖packageDigest‖intentId`로 **정의**하고, D03 토큰이 같은 값을 묶게 한다. `gate.request`에 `reqId`(= `gateRequestId`)를 추가한다. 로컬 승인도 같은 `actionHash`를 렌더 측에서 계산해 검증한다.
  - 비가역 스텝 진입 시 readback을 다시 계산한다. 불일치하면 보안 이벤트가 아니라 **재게이트**한다. 정상 흐름에서도 생길 수 있으므로 경보 피로를 막아야 한다.
  - `runKey`는 실행마다 32바이트를 무작위로 만들고 메모리에만 둔다. 영속하지 않으므로 크래시 후에는 반드시 재게이트하게 된다.

#### C-03 [높음] TTL이 세 개로 갈려 있고, 커밋 뒤 토큰 만료가 "보안 이벤트 + 중단"이 된다
- **위치**: 스키마 `gate.ttlMs`(10초~1시간), D03 §2 토큰 "10분 유효", D08 `gate.request.exp`(10:45 판: 120초 고정), D03 §2 "TTL 초과 → Paused(재개 시 게이트부터)" vs §7 "human TTL → 체크포인트 복귀 후 Paused". 폰 요청은 120초에 만료되는데 게이트는 최대 1시간 기다린다. 120초가 지난 뒤 재요청하는지, 그대로 Paused로 가는지 정해지지 않았다.
- **내용**:
  - H-01에서 s20 승인 → s21 → s22(보안카드를 폰으로 입력, human TTL 최대 600초) → s30 → s31 → s32 → s33이 10분을 넘기면, s33 진입 시 토큰이 만료된다. 그러면 "실행 중단 + 보안 이벤트"가 되고, 발급은 끝났는데 화면은 중단/보안 경고를 보여 준다. 사용자가 재실행하면 B 시퀀스 4·7로 이어진다.
  - "게이트부터 재개"는 세션이 만료된 페이지에서 제출로 이어진다.
- **수정**:
  - `gate.ttlMs`는 승인 대기 시간, 토큰 `exp`는 "승인 시각 + 구간 상한(정책 상수)"으로 분리하고 이름을 붙인다.
  - 커밋 뒤 후속 비가역(이메일)은 별도 게이트, 또는 `followUpOf: s21`로 선언하고 카드에 미리 표시한 뒤 **커밋 시점에 함께 발급되는 후속 토큰**으로 처리한다.
  - TTL로 인한 Paused는 항상 **게이트 앞 체크포인트**로 되감아 재개한다(게이트 직행 금지).
  - 토큰 만료는 보안 이벤트가 아니다. 보안 이벤트는 위조, 다른 실행의 토큰, 이미 소비된 토큰에만 쓴다.

#### C-04 [높음] 비가역 도중 `abort()`의 의미가 정의되지 않았다
- **위치**: D03 §2("제출 중이면 완료를 기다린 뒤 중단")
- **내용**: "완료"가 클릭 반환인지, `confirm`인지, 서명인지, verify인지 알 수 없다. `sign`은 비가역 표시가 없어 즉시 중단되는데, 간편인증 PUSH는 사용자 폰에 살아 있어 중단 **뒤에** 발급될 수 있다.
- **수정**: 커밋 구간을 "토큰 소비 ~ verify 완료"로 정의한다(포털 `confirm`·서명 포함). 이 구간의 abort는 "verify 후 중단"으로 처리하고 상한(예: 120초)을 둔다. 상한을 넘기면 `InDoubt`로 보내고, 사용자에게 "홈택스 앱의 승인 요청을 거절하세요"를 고정 안내한다.

#### C-05 [중간] 전이표에 빠진 상태와 전이가 있다
- **위치**: D03 §2 다이어그램
- **내용**:
  - `Preparing→Failed`, `Recovering→Failed`, `WaitingGate→Paused`(TTL), `HandedOff→Paused`가 없다.
  - `HandedOff`에 TTL이 없어 포털 동시 실행 슬롯(`concurrent:1`)을 무기한 점유하고, 데몬이 굶는다.
  - 의사 동작 `handoff` 뒤의 재개 지점이 정해지지 않았다.
  - "비가역은 완료됐는데 후속 실패(이메일·PDF 실패)" 종료 상태가 없다. `Failed`로 보이면 사용자가 재실행한다.
- **수정**: 전이표를 명시한다(상태 × 이벤트 → 상태, 부수효과). `CompletedWithIssues`(비가역 커밋 + 후속 실패)를 추가하고, UI에 "재실행하지 마세요. 발급은 완료되었습니다"를 고정한다. `HandedOff` TTL(예: 30분)이 지나면 Paused로 보내고 슬롯을 해제한다.

#### C-06 [중간] 두 채널 동시 승인 경합과 렌더러 승인의 신뢰 문제
- **위치**: 기획 `03-architecture.md` §165("둘 중 하나 승인"), D03 §8, D01 §2.1
- **수정**: 전이는 "먼저 도착한 결정이 이김"으로 하고 원자적으로 처리한다. 승인 뒤 커밋 직전까지 다른 채널에서 거부가 오면 중단한다(거부 우선 창). 로컬 승인은 렌더러의 신뢰 사용자 제스처(`isTrusted`)와 카드 렌더 해시를 `main`에서 검증한다.

#### C-07 [중간] 데몬 `auto`의 "사전 승인으로 게이트 통과"가 D03과 모순된다
- **위치**: D10 §2(`consent_json.preapproved`), D03 §2("승인 없이 Running으로 가는 전이는 존재하지 않는다"), D01 §5.3("미승인 24h") vs `gate.ttlMs ≤ 1h`, D01 §5.3의 실행 시작 게이트
- **내용**: 사전 승인 토큰을 발급하는 경로가 없다. 데몬의 "갱신 시작할까요"는 실행 시작 시점의 게이트인데, 그 뒤 로그인을 위한 `goto`가 끼므로 V-03을 통과할 수 없다. 24시간 대기는 `ttlMs` 최대값(1시간)을 넘는다.
- **수정**:
  - "시작 동의"(스케줄러 수준, 토큰 아님)와 "커밋 게이트"를 분리한다.
  - `auto`는 `StandingAuthorization{scheduleId, playbookId@major, docType, profileId, maxPerPeriod, expiresAt, userSignature}` 객체로 정의하고, 엔진이 이 객체에서 **건별 단일 사용 토큰**을 만든다.
  - V-14(D10이 인용하지만 D02에는 없음)를 실제로 정의한다. 비가역 종류 필드 `effect: issue_document|send|sign|pay`를 추가하고, 데몬은 `issue_document`만 허용한다.

#### C-08 [낮음] 토큰의 위협 모델을 명시해야 한다
- **위치**: D03 §2 "런타임 이중 안전장치"
- **내용**: 엔진이 발급과 검증을 모두 하므로, 토큰은 **엔진 로직 버그**만 막는다. 엔진이 침해되면 무력하다.
- **수정**: 문서에 그렇게 적는다. 더 강하게 하려면 승인 수신자(`main`)가 발급하고, A-01의 커밋 가드(네트워크 계층)가 검증하도록 분리한다.

### D. 복구 계층

#### D-01 [치명] L1 "팝업 닫기"와 브라우저 대화상자 처리 규칙이 없어 게이트 없는 커밋이 가능하다
- **위치**: D04 §3 `popup_class_v1`("`safe_to_close` ≥ 0.90일 때만 닫기"), D03 §5 L1, D04 §5("모델은 제출을 유발할 수 없다")
- **내용**:
  - 닫기 대상을 **어떻게 고르는지** 정의가 없다.
  - 한국 포털에는 "발급하시겠습니까? [확인] [취소]" 같은 DOM 모달이 흔하다. 이것이 `notice_dismissable`/`safe_to_close`로 판정되고 엔진이 기본 버튼("확인")을 누르면 게이트 없이 발급된다.
  - 네이티브 `window.confirm` 정책도 없다. Playwright는 리스너가 없으면 자동 dismiss하므로, 팀이 `alert` 처리를 위해 `dialog.accept()` 핸들러를 붙이는 순간 모든 `confirm`이 수락된다.
- **영향**: 모델 판정 하나가 비가역을 일으킨다. D04 §5의 주장과 정면으로 어긋난다.
- **수정**:
  - 팝업 닫기는 셀렉터 사전에 `closeAffordance:true`로 등록된 요소(X, 닫기, 취소)만 클릭한다. 접근성 이름이 `/확인|예|OK|발급|제출|동의/`인 요소는 닫기 대상에서 하드 금지한다.
  - 대화상자 정책: `alert`는 accept(선택지가 하나)하고 텍스트를 판정 입력으로 쓴다. `confirm`/`beforeunload`는 **무장된 커밋 구간 안에서, 사전에 선언한 `expectConfirm` 패턴과 일치할 때만** accept하고, 나머지는 dismiss + 보안 이벤트로 처리한다. `prompt`는 dismiss.

#### D-02 [치명] L2가 비가역 스텝의 타깃을 수리할 수 있다
- **위치**: D02 §5(`submit`은 retry 0만 고정, `then` 무제한), D03 §5 L2, D04 §5
- **내용**: `submit.onFail.then = "recover"`가 허용된다(CE-4). 그러면 L2가 제안한 셀렉터로 엔진이 **발급 버튼을 다시 클릭**한다. 비가역 클릭이 떨어질 요소를 모델이 고르는 셈이다.
- **수정**: V-03f에 따라 비가역 스텝과 커밋 구간 스텝에는 L2 수리를 금지한다. 커밋 셀렉터 실패 시 할 수 있는 일은 `verify`(조회) → handoff뿐이다.

#### D-03 [높음] `expect` 검사는 동일성 검증이 아니다(그럴듯한 다른 요소 문제)
- **위치**: D03 §5 L2 세부("후보를 `expect` 검사 → 통과한 첫 후보"), D02 §4.2 `expect: {visible, editable}`, D04 §4.1 `propose_selectors{kind: role|css|label}`
- **내용**: `visible`/`editable`은 다른 폼의 같은 이름 칸, 숨겨진 탭의 버튼, 다른 프레임의 요소, 공급가액 ↔ 세액에서도 모두 참이다. `css` 종류는 `button.btn_blue` 같은 범용 셀렉터를 허용한다. 모델이 주장하는 `name`은 검증되지 않는다.
- **수정**: 적용 조건을 아래 **모두**로 한다.
  - (1) 정확히 1개 일치(strict)
  - (2) 원래 스텝과 같은 프레임
  - (3) 스텝 `scope` 서브트리 안
  - (4) 역할이 사전의 기대 역할과 같음
  - (5) 실제 접근성 이름이 **사전에 선언된** `namePattern`과 일치(모델 제안 이름은 쓰지 않음)
  - (6) 가장 가까운 `form`/`dialog` 랜드마크 ID가 원래 후보들의 것과 같음
  - (7) `fill`이면 입력 후 readback 일치
  - (8) `css` 종류는 ID/속성 셀렉터만 허용
  - `commits:true` 요소는 L2 대상에서 제외한다.

#### D-04 [높음] 인젝션 사전 필터가 L2가 읽는 텍스트를 덮지 못하고, 모델이 준 정규식을 로컬에서 실행한다
- **위치**: D04 §3(`page_text_addresses_agent` — `screen_state_v1` 요청에서 얻음), §4 툴셋(`get_a11y_subtree(scopeId)`, `find_candidates(role, nameRegex)`)
- **내용**:
  - 필터는 `screen_state_v1`의 스냅샷(루트, 6KB 이하)에 대해 계산된다. L2는 도구로 **다른 시점, 다른 범위**(8KB 이하, 모델이 고른 `scopeId`)를 읽는다.
  - `nameRegex`는 모델이 정한 정규식을 로컬에서 실행하므로 ReDoS 위험이 있다.
- **수정**: `scopeId`는 엔진이 정한 값만 쓴다(도구 인자에서 제거하거나 열거형으로). 도구가 돌려주는 텍스트마다 같은 predicate로 재검사하거나, 최소한 결정적 키워드 필터를 건다. `nameRegex`는 RE2 또는 부분 문자열 일치로 바꾼다.

#### D-05 [높음] `secretSlot` 칸의 값이 스냅샷에 실려 모델로 나간다
- **위치**: D06 §4("`type=password` 값은 스냅샷에서 제외"), D05 §4(`secretSlot: true` 칸 허용), H-01 s22→s30(서명 직후 `scope: root` 판정)
- **내용**: 보안카드 입력칸은 `type=text`이면서 `secretSlot`인 경우가 있다. 이 값은 접근성 스냅샷에 남고, 체크디지트 없는 숫자 2~4자리라 마스킹 엔티티에도 걸리지 않는다. 그대로 Decisions/Terra로 송신된다. 또 타이피스트가 위치 확인 후 입력하기 전에 포커스가 일반 칸으로 옮겨지는 TOCTOU 문제가 있다.
- **수정**:
  - 스냅샷 필터를 "`type=password` **또는** 셀렉터 사전의 `secretSlot` **또는** 최근 타이피스트 대상 요소"의 값 제거로 넓힌다.
  - 타이피스트는 키 입력마다 `activeElement`가 대상과 같은지와 `type`을 재확인한다.
  - 누출 스캐너(D13 §6)에 보안카드 숫자 패턴을 넣는다.

#### D-06 [중간] L2 트리거와 복구 뒤 재개 지점이 정의되지 않았다
- **위치**: D03 §5 L2 트리거("L1이 '화면은 맞는데 요소를 못 찾음'으로 판정"), H-01 `error: "recover"`, D02 §5 `handoffAfter`
- **내용**:
  - 그런 판정 결과를 내는 번들이 없다.
  - `decide`의 결과로 `recover`를 고르면 L1 → `screen_state_v1` → 다시 `recover`로 재귀한다.
  - 복구 성공 뒤 어느 스텝을 다시 실행하는지 정해지지 않았다.
  - `handoffAfter`는 D02에서 "L2 시도 상한(기본 1)", D03에서 "실행당", 스키마에서 최대 2, D04 §6에서 "L2 ≤ 2회/실행"으로 서로 다르다.
- **수정**:
  - `recovery_v1` 번들(결과: `element_missing_same_screen`, `different_screen`, `modal_blocking`, `session_expired`, `unknown`)을 정의한다.
  - 복구 성공 → **실패한 그 스텝**을 재실행한다.
  - `decide.on`의 `recover`는 금지한다(`handoff`/스텝 ID만 허용).
  - 이름을 `l2MaxAttempts`로 바꾸고 실행당 상한 하나로 통일한다.

#### D-07 [중간] 셀렉터 핫픽스가 비가역 타깃을 경량 채널로 바꿀 수 있다
- **위치**: D02 §9(셀렉터 핫픽스 패키지), D12 §3(1% → 1시간 → 100%), §3.4(L2 제안이 후보로 집계)
- **내용**: `issueButton`의 정의가 IR 버전 변경 없이 바뀐다. L2 제안은 인젝션에 오염될 수 있는 입력인데 공급망 후보로 올라간다.
- **수정**: `commits:true`/`secretSlot`/`closeAffordance` 항목은 핫픽스 대상에서 제외한다(정식 버전 + 전체 리플레이 필수). 핫픽스 다이제스트는 게이트 토큰의 `packageDigest`에 포함한다.

### E. Decisions 번들

#### E-01 [높음] 결과 매핑이 결정적이지도 전부를 덮지도 않는다
- **위치**: D04 §3 표, §2 규약, D02 §8, V-07
- **내용**:
  - (1) `screen_state_v1`의 선택지(`logged_in_home`/`form`/`result`/`error_page`/`blocked`)가 결과 라벨(`logged_in`/`login_required`/…)로 어떻게 매핑되는지 정의가 없다(`form`이나 `result`는 무엇이 되는가?).
  - (2) 여러 predicate가 동시에 참일 때 우선순위가 없다(예: `screen=form` 0.9, `has_error_modal` 0.9, `captcha_or_mfa` 0.86).
  - (3) 엔진이 가로채는 결과(`blocked`, `security_warning` → 즉시 중단, D03 §6)와 플레이북 매핑(V-07)의 관계가 정해지지 않아 H-01이 V-07을 위반한다.
  - (4) 게이트웨이 `unavailable`, 타임아웃, 예산 초과의 결과가 정해지지 않았다.
  - (5) (10:45 판에서 재발) `screen_state_v1`에 predicate `logged_out_by_other_session`이 추가되고 D03 §12가 "≥ 0.85면 일시정지"를 규정했다. 그러나 결과 라벨 목록은 6개 그대로이고 우선순위도 없다. 예를 들어 `login_page` 0.9와 이 predicate 0.9가 동시에 나오면 `login_required`(자동 재로그인)인지 일시정지인지 정해지지 않았다. 이 predicate는 상대 세션을 끊지 않기 위한 안전 규칙이므로 `login_required`보다 앞서야 한다. 질문을 하나 추가할 때마다 이런 공백이 생기는 구조라는 증거다.
- **수정**: 번들 정의 스키마(`bundles/*.schema.json`)를 신설한다. 필수 항목은 `questions`, `thresholds`, **순서 있는 매핑 규칙표**(첫 일치 승리, 마지막 행은 `unknown`), `onRefusal`(질문별), `reservedOutcomes`(엔진 처리, 플레이북 매핑 금지), `digest`.
  - 예: `screen_state_v1` 우선순위 = `security_warning ≥ .80 ∨ P(blocked) ≥ .80` → `blocked`(예약) > `captcha_or_mfa ≥ .85` > `login_page ∨ session_expired_notice ≥ .85` → `login_required` > `error_page ∨ has_error_modal ≥ .85` → `error` > `{logged_in_home, form, result}`, conf ≥ .85 → `logged_in` > `unknown`.
  - 오류·불가·예산 초과는 모두 `unknown`이다.
  - V-07 = "`on` 키 집합 = 번들 결과 − `reservedOutcomes`, 그리고 `unknown` 포함".

#### E-02 [높음] 임계값이 서로 모순된다
- **위치**: D04 §3·§5, README "비가역 직전은 0.95", `06-feasibility.md` Q7 "직전 0.95", R1 §322 "발급하기 클릭 직전 0.95"
- **내용**:
  - D04는 0.95를 **직후**(`issue_result_v1`)에만 쓰고, 직전 판정(`form_ready_v1`)은 0.90이다.
  - `blocked` p ≥ 0.80과 choice confidence ≥ 0.85가 충돌한다(`blocked` 0.82: 중단인가 unknown인가?).
  - D04 §5는 "그 외 0.85"인데 `intent_route_v1`은 0.80이다.
  - `form_ready_v1`은 `totals_consistent`를 질문하고도 임계값에 쓰지 않으며, `validation_error` 결과의 조건도 없다.
  - `captcha_or_mfa_v1`은 둘 다 참일 때의 처리가 없다.
  - R1 예시 응답의 `probabilities[]`는 최상위 값만 담고 있다. 전체 분포가 보장되지 않으면 "P(blocked) ≥ 0.80" 자체를 계산할 수 없다(S9에서 확인).
- **수정**: 기획 결정(직전 0.95)과 설계를 하나로 맞춘다. 권고는 **직전 판정도 0.95 + readback의 결정적 비교**다. 모든 임계값은 번들 정의 파일에만 두고 D04 표는 생성물로 만든다. choice의 예약 라벨은 "확률이 있으면 P(label), 없으면 argmax=label ∧ conf"로 정의한다.

#### E-03 [높음] 질문 단위 거절(refusal)의 "보수적 해석"이 미정이고, 이로 인한 쿨다운이 서비스 거부가 된다
- **위치**: D04 §2("보조 predicate refusal → 보수적 쪽, 예: `security_warning` → 경고 있음으로 간주해 중단"), D03 §6("`security_warning` 결과 → 즉시 중단 + cooldown 24h")
- **내용**:
  - 거절은 화면 내용으로 유발할 수 있다. 거절 한 번이 포털 24시간 쿨다운으로 이어진다.
  - `issuance_success_text` 같은 질문은 무엇이 "보수적"인지 방향이 정해지지 않았다. 중복 방지 관점에서는 "발급됐을 수 있음", 성공 판정 관점에서는 "실패"다.
- **수정**: 번들 정의에 질문별 `onRefusal: assume_true|assume_false|unknown`을 명시한다. **거절에서 나온 중단은 쿨다운이 아니라 handoff로** 처리한다. 쿨다운은 양성 탐지(p ≥ 임계값)가 2회 연속일 때만 건다. 거절률은 텔레메트리 `decide.stats`에 추가한다.

#### E-04 [중간] 질문 독립성 위반과 중복 질문
- **위치**: D04 §3 `intent_route_v1.needs_clarification`, `amount_parse_check_v1`, `form_ready_v1.totals_consistent`
- **내용**:
  - `needs_clarification`("필수 정보가 빠졌다")은 **어느 플레이북인지**에 따라 답이 달라지므로 같은 요청의 `playbook` choice 답에 의존한다. 이는 D04 §2 규약 위반이다.
  - `tax_type`과 `parse_matches_user_text`의 결합 규칙이 없다(영세율인데 10% 분리 파싱).
  - `totals_consistent`는 s18의 결정적 `sumEquals`와 중복된다.
- **수정**: "되묻기 필요"는 `intent_fill` 결과에 대한 **로컬 결정적 검사**(필수 입력 누락)로 바꾼다. `amount_parse_check`는 파서가 가정한 과세 유형을 입력에 넣고 "일치 여부" 하나로 묻는다. `totals_consistent`는 삭제한다.

#### E-05 [중간] `unknown` 순환과 "2회 연속 unknown" 규칙의 적용 범위가 모호하다
- **위치**: D04 §5, D03 §5(L1 스텝당 2회), D04 §6(실행당 L1 ≤ 12), D01 §5.2(간편인증 대기 중 `decide` 폴링)
- **내용**:
  - 같은 스텝 기준이라 두 `decide` 스텝을 번갈아 돌면 카운터가 초기화된다.
  - 플레이북의 `on.unknown` 매핑보다 우선하는지 불분명하다. CE-4는 `unknown → submit`을 매핑한다.
  - 간편인증 PUSH 대기를 `decide` 폴링으로 하면 실행당 L1 12회를 순식간에 소진한다.
- **수정**:
  - V-07b: `unknown`의 목적지는 `handoff`/`abort`, 또는 **비가역 스텝을 거치지 않고** 다시 같은 `decide`로 돌아오는 대기 루프(`loopGuard` 필수)만 허용한다.
  - 엔진 규칙: 실행 전체에서 연속 `unknown` 2회(스텝 무관) → L3.
  - PUSH 대기는 결정적 `wait`(텍스트/요소 변화) + 사람 속도 간격으로 처리하고, 상태 확인은 종료 시 1회만 한다.

#### E-06 [중간] 번들 정의의 진실 원천이 세 곳이다
- **위치**: D02 §2("번들 카탈로그는 엔진 배포에 포함"), D01 §7(`playbooks` 패키지에 번들 카탈로그), D09 §3("질문 정의는 게이트웨이가 주입"), D04 §8(BYOK는 엔진 배포본 사용)
- **영향**: 게이트웨이가 선택지를 하나 추가하면 클라이언트 매핑이 깨진다(버전 불일치).
- **수정**: 번들은 `bundleId@ver + sha256 digest`로 식별한다. 클라이언트가 digest를 보내고, 게이트웨이는 불일치 시 409를 돌려준다. 원천은 저장소 한 곳에 두고, 엔진과 게이트웨이 양쪽에 빌드 산출물로 배포한다.

#### E-07 [낮음] "결정성 우선" 주장이 모델 분기와 양립하지 않는다
- **위치**: D00 §3("같은 입력·같은 화면이면 같은 경로")
- **수정**: "판정 결과는 저널에 기록하고, 재개·재생 시 과거 판정을 재질문하지 않는다"로 고친다. 리플레이 하네스는 `decide`를 기록값으로 스텁한다.

### F. 사람 속도 정책

#### F-01 [높음] 상한의 단위와 범위가 정의되지 않았다
- **위치**: D03 §6 `limits.hometax {perSession:10, perDay:20}`, "`policy.beforeStep`: 상한 카운터 증가·검사", D07 `rate_counters(bucket 'session:<id>'|'day:YYYY-MM-DD')`, `05-access-and-detection.md` "프로필당 포털별 20작업"
- **내용**:
  - `beforeStep`이 스텝마다 증가시킨다면, 스텝 35개짜리 H-01 한 번에 상한을 넘는다. 그러니 단위는 "작업"이어야 하는데 명시되어 있지 않다.
  - 프로필별인지 포털별인지 정해지지 않았다.
  - `session:<id>`의 세션(앱? 포털 로그인? Chrome?)이 무엇인지 정의가 없다. 앱 재시작으로 초기화된다면 우회할 수 있다.
  - 조회 작업에는 상한이 사실상 없다.
- **수정**: 카운터를 분리하고 각각 증가 지점을 명시한다.
  - `runs/day/profile/portal`: `start` 시점
  - `irreversible/day/profile/portal`: `armed` 시점
  - `navigations/min/portal`: 네비게이션 이벤트
  - `logins/day/portal`
  - 세션 = 포털 로그인 세션(로그인 성공 판정 ~ 로그아웃·만료)으로 정의한다.

#### F-02 [높음] 스텝이 아닌 브라우저 동작이 `beforeStep`을 우회한다
- **위치**: D03 §3 루프(`failurePolicy` 내부 재시도), 스키마 `backoffMs` 최솟값 0, D03 §6 `retries.backoff: "full_jitter"`(10:45 판), D03 §4(체크포인트 복귀 네비게이션), §5(L1 팝업 클릭), D02 `sign`(내부에서 인증서 선택·비밀번호·보안카드 수행), D05 타이피스트, `save_pdf print`
- **내용**:
  - `onFail {retry:3, backoffMs:[0,0,0]}`이면 즉시 3연타가 나간다.
  - 10:45 판이 정책에 Full Jitter를 넣었지만, Full Jitter는 `[0, min(cap, base·2ⁿ)]`에서 고르므로 **하한이 0**이다. 거의 즉시 재시도가 설계상 가능하다. 또 IR의 `backoffMs`와 정책의 `retries.backoff` 중 무엇이 이기는지 정해지지 않았다.
  - 복구 네비게이션, 팝업 클릭, `sign` 매크로 내부 동작은 지연도 카운트도 없다.
- **수정**: 페이지에 영향을 주는 모든 동작(클릭, 키 입력, 네비게이션, 대화상자 응답, 타이피스트 포함)을 단일 **Actuator** 인터페이스로 모으고, `policy.beforeAction`을 그 안에 둔다. 스텝 핸들러, 복구기, `sign`, 금고가 모두 이를 거친다(금고는 Actuator가 발급한 타이밍 허가를 받는다). 재시도 지연은 정책만 소유하고 IR `backoffMs`는 삭제한다. 정책은 Equal Jitter(`base/2 + rand(0, base/2)`) 또는 하한 = `stepDelayMs` 하한으로 바꾼다.

#### F-03 [중간] 플레이북이 페이스 프로필을 고를 수 있다
- **위치**: 스키마 `pacing.profile: interactive|daemon`, D03 §6 "플레이북은 완화 불가", 스키마 `pace: slow`(정책에 정의 없음)
- **내용**: 데몬이 트리거한 실행에서 IR이 `interactive`를 지정하면 더 빠른 프로필이 적용될 수 있다.
- **수정**: 프로필은 트리거에서 정하고(`daemon` 트리거면 `daemon`), IR은 그보다 느린 쪽만 고를 수 있다(`effective = slower(trigger, ir)`). `slow`는 정책에 배수(예: 1.5×)로 정의한다. 데몬 간격 상수(5~15분, 10분 유예, 30분 재시도)도 서명된 `policy.json`으로 옮긴다.

#### F-04 [중간] 카운터의 크래시 안전성과 시계 안전성
- **위치**: D07 `rate_counters`, `cooldowns(until)`, D03 §6 캡차 버스트("10분 창 3회" — 저장 위치 없음), D12 §1(텔레메트리 옵트인) vs D03 §6("운영팀 알림")
- **내용**: 10:45 판 D03 §6이 "카운터는 SQLite에 영속해 크래시 후에도 이어진다"를 명시해 **프로세스 크래시 부분은 해소**되었다. 남은 문제는 다음과 같다.
  - `day:` 버킷의 시간대가 정해지지 않았다.
  - 시계를 되돌리면 상한과 쿨다운이 풀린다.
  - 캡차 버스트 카운터는 메모리에 있어 재시작하면 초기화된다.
  - 텔레메트리를 끈 사용자는 운영팀 알림과 핫픽스 탐지에서 빠진다.
- **수정**:
  - KST로 고정한다. "마지막으로 본 시각"을 저장해 역행을 감지하고, 역행하면 보수 모드로 간다.
  - 캡차 이벤트는 `rate_counters`에 넣는다.
  - 카운터 증가와 행동은 "증가 커밋 → 행동" 순서로 한다(과소 계수 방지).
  - 텔레메트리 옵트아웃 사용자의 운영 알림은 로컬 알림으로 대체하고, 대시보드 지표에 옵트인 편향을 표기한다.

#### F-05 [낮음] 실행당 총 동작 상한이 없다
- **내용**: `repeat` 20 × 20 = 400회, 그리고 `decide.on` 순환.
- **수정**: 정책에 `maxActuationsPerRun`(예: 150)과 `maxRunWallClock`을 둔다.

### G. 스키마 품질(draft 2020-12)

#### G-01 [높음] 스텝 변형에 `unevaluatedProperties: false`가 없다
- **위치**: `$defs.step`(`allOf:[stepBase]` + `oneOf`), `stepBase`
- **내용**: `allOf` + `oneOf` 조합 자체는 유효하다. 그러나 어느 쪽에도 미정의 속성 금지가 없어 오탈자(`irreversable`)와 임의 필드가 통과한다(CE-3 검증으로 확인). 각 변형에 `additionalProperties:false`를 넣는 것은 **해법이 아니다**. 변형은 `id`/`label`/`pace` 같은 기반 속성을 모르기 때문에 모든 스텝이 실패한다. `irreversible`이 기반에 있어 `goto`·`wait` 등에도 붙는다.
- **수정**: `step`에 `"unevaluatedProperties": false`를 추가한다(2020-12에서 성공한 `allOf`/`oneOf` 하위 스키마의 주석을 인식한다). `irreversible`은 기반에서 빼고 `click`(boolean), `submit`/`send_email`(const true)에만 정의한다.

#### G-02 [높음] 열린 객체: `extract.from`, `capture.from`
- **위치**: 스키마 `{"type":"object"}`, D02 §3("임의 JSON은 허용하지 않는다"), D02 §4 표(`from: selector|regex|a11y, pattern`) vs §7 s31(`from: {"regex":{"target","pattern"}}`)
- **수정**: `from`을 `oneOf[{selector: targetRef}, {regex:{target, pattern}}, {a11y:{target, role?}}]`로 닫고, 산문 표를 예시 형식에 맞춘다. 정규식 패턴은 RE2 호환 하위 집합으로 제한한다(ReDoS 방지).

#### G-03 [높음] `goto.url`의 `format: "uri"`는 보호가 되지 않는다
- **위치**: 스키마 `goto.url`, D02 V-06, §7 s11 `https://hometax.go.kr/…/건별발급`
- **내용**:
  - 2020-12에서 `format`은 기본적으로 주석이다. Ajv strict 모드는 `ajv-formats`가 없으면 알 수 없는 format이라며 컴파일 오류를 낸다. Python `jsonschema`는 무시한다. 결국 검증기 설정에 따라 동작이 달라진다.
  - 검증을 켜도 `javascript:`·`data:`·`file:`, `https://hometax.go.kr@evil.example/` 같은 userinfo 우회가 통과한다(CE-6).
  - 예시의 비ASCII 경로는 `uri`로는 무효이고 `iri`여야 한다.
- **수정**: `"pattern": "^https://[^/@:]+(/|$)"`로 두고, V-06은 WHATWG URL 파서로 해석한 뒤 `protocol === "https:"`, `username/password` 비어 있음, 포트 없음, `hostname ∈ manifest.domains`(정확 일치, 하위 도메인은 명시 와일드카드만)로 검사한다.

#### G-04 [중간] 참조 필드에 형식이 없다
- **위치**: `decide.on` 값, `branch.cases` 값, `verify`, `handoff.resumeAt`, `sign.method`(`$profile.signMethod` 문자열), `sign.then`, `gate.fields`(`$` 없는 `inputs.x`, valueRef와 표기 불일치), `decide.scope`(`"root"` 또는 targetRef), `wait.value`, `idempotencyKey`, `textMatches.pattern`(`$inputs…` 참조를 패턴 자리에 넣음)
- **내용**: 체크포인트 이름은 자유 문자열인데 `onFail.then`의 패턴은 `checkpoint:[a-z_]+`이다. 그래서 `form2` 같은 이름은 참조할 수 없다.
- **수정**:
  - `stepRef = ^s[0-9]{1,3}$`, `outcomeTarget = stepRef | handoff | abort`, `cpName = ^[a-z_][a-z0-9_]*$`(양쪽 공용).
  - `fieldRef`는 valueRef와 같은 `$` 표기로 통일한다.
  - `scope = anyOf[{const:"root"}, targetRef]`.
  - `wait`는 `for`별 `if/then`(`selector` → `value: targetRef`, `idle` → `value` 금지).
  - `sign.method = enum | $profile.signMethod`.
  - `textMatches`에 `patternRef`를 따로 둔다.
  - 참조가 실재하는지는 V-15/V-17로 검사한다.

#### G-05 [중간] 산문과 스키마가 맞지 않는다
- **내용**:
  - `branch.cases`: 산문은 "스텝 ID **목록**", 스키마는 문자열 하나다. 목록이라면 합류(join) 의미론이 없다.
  - `checkpoint` 스텝: 산문(D03 §4)에는 `url`·`sessionRequired`가 있지만 스키마에는 없다.
  - `human(kind=secret)`에 입력 대상 `target`이 없다. 타이피스트 `fillFromRemote(..., element)`가 요구하는 값을 IR에서 줄 수 없다.
  - `secret_fill.secret`이 `security_card:{row}`라는 리터럴 자리표시자다. 칸 번호를 어디서 읽는지(`rowFrom`)가 없다(D05 §4는 "엔진이 화면에서 읽어 전달").
  - `human.inputSpec`(D03 §7)이 IR에 없다.
  - `label`·`prompt`가 IR에 한국어 리터럴로 들어 있는데, D02 §2는 "사용자 라벨 = `strings.ko.json`"이라고 한다.
  - `preconditions`/`postconditions`는 문자열 미니 언어로, §4.1 "조건은 열거형 객체" 원칙과 다르다.
  - `pace: slow`가 정의되지 않았다.
  - `manifest.json`, `selectors.json`(`expect`, `secretSlot`, `commits`), 번들 정의, `policy.json`, 핫픽스 패키지(`playbookVersionRange`)의 스키마가 없다. V-02·V-06·V-12가 이 파일들에 의존한다.
  - D10이 인용하는 V-14가 D02에 없다.
- **수정**: 위 항목마다 스키마를 추가하거나 산문을 고친다. `schemas/` 아래 `manifest`, `selectors`, `bundle`, `policy`, `hotfix` 스키마 5종을 M1-4 착수 전에 만든다.

#### G-06 [낮음] 정규식 이식성과 유일성 검사
- **내용**: valueRef 상수의 `^(?!\$)…` 전방탐색은 JSON Schema 권장 정규식 하위 집합 밖이라 RE2 기반 검증기(Go, Rust 등)에서 컴파일되지 않는다. 클라우드 레지스트리가 다른 언어로 검증하면 문제가 된다. 스텝 `id`의 유일성(중첩 `repeat` 포함)은 스키마로 표현할 수 없는데, 이를 검사하는 V 규칙이 없다. `profileKinds`에는 `uniqueItems`가 없다.
- **수정**: `"not": {"pattern": "^\\$"}` + `"pattern": "^[^\\n]{0,200}$"`로 바꾸고, V-19(전역 id 유일)를 추가한다. 레지스트리 CI와 엔진은 같은 검증기 구현(Ajv 8, `strict:true`, `ajv-formats`)을 쓴다.

#### G-07 [낮음] 오류 메시지 품질
- **내용**: `oneOf`가 실패하면 "0개 일치"만 나와 작성자가 원인을 알 수 없다.
- **수정**: `type` 값별 `if/then` 분기 또는 Ajv `discriminator`를 쓴다(`oneOf` + `discriminator: {propertyName: "type"}`, 각 분기에 `required:["type"]`).

### H. 구현 1주차 장애물(소유권 공백, 문서 간 모순)

#### H-01 [높음] 금고 타이피스트의 "자기 CDP 세션"은 파이프 전용 실행 방식과 양립하지 않는다
- **위치**: D03 §10(10:45 판: `ignoreDefaultArgs: true, args: ['--remote-debugging-pipe', …]`), D05 §3·§4(`cdpEndpoint: string`, "금고가 자기 CDP 세션을 연다"), ADR-005 "결정"
- **내용**:
  - 10:45 판에서 Chrome 실행 인자를 정리하면서(`--disable-extensions` 제거, `navigator.webdriver`는 ADR-010으로 수용) CDP 연결이 **파이프 전용**이 되었다. 파이프는 실행한 프로세스(엔진) 하나만 쥘 수 있어 금고가 붙을 `cdpEndpoint`가 없다.
  - 남은 선택지가 셋인데 모두 비용이 있다.
    - (a) `--remote-debugging-port`를 추가하면 **같은 PC의 아무 프로세스나** 로그인된 홈택스 세션을 조종할 수 있는 루프백 포트가 열린다. 플래그도 하나 늘어난다.
    - (b) 엔진이 CDP 메시지를 중계하면 `Input.dispatchKeyEvent`에 평문 글자가 실려 TB-2를 지나간다. ADR-005의 존재 이유가 사라진다.
    - (c) 금고가 Chrome을 띄워 파이프를 쥐고 엔진이 그 위로 붙으려면, 금고가 브라우저 제어 중계자가 되어 공격면이 커진다.
- **수정**: S6에서 (a)~(c) 중 하나를 정해 ADR-005와 D05 §3의 `fill(req)` 시그니처를 갱신한다. M1-3·M2-3보다 먼저다. (a)라면 무작위 포트, 짧은 수명(타이핑 동안만 열고 닫는 것은 불가하므로 실행 동안 유지), `--remote-allow-origins` 제한을 두고 같은 OS 사용자의 악성코드 위험(D11 T2)을 잔여 위험에 명시한다.

#### H-02 [중간] 문서 간 모순 목록(1주차에 질문이 쏟아질 지점)

| # | 모순 | 위치 |
|---|---|---|
| 1 | `prompt_cache_key`: 플레이북 샤드(`pb:<id>:v<major>:shard<n>`, "계정별 분할은 적중률 저하") vs 계정 격리(`acct:<hash>:`) | D04 §2.1 vs D09 §3 |
| 2 | `/v1/respond` 화이트리스트에 `replay[]` 없음 → L2 다회 턴이 400 | D04 §7 vs D09 §3 |
| 3 | 인젝션 필터: 별도 번들 없음 vs `injection_screen_v1` | D04 §3 vs D11 T4 |
| 4 | 번들 7종 vs 8종 | D14 M3-7 vs D04 §3 |
| 5 | 캡차 감지: `captcha_or_mfa_v1` vs `screen_state_v1.captcha_or_mfa` | D01 §5.4 vs D02 §7 |
| 6 | "운영 정책 §6.4"는 존재하지 않음 | D01 §5.4 |
| 7 | `irreversibleDone[]`(실행별) vs `irreversible_log`(전역) | D03 §4 vs D07 |
| 8 | Paused가 vars를 직렬화 vs `runs`에 vars 컬럼 없음 | D03 §2 vs D07 `runs` |
| 9 | V-14 인용 vs 규칙은 V-13까지 | D10 §2 vs D02 §6, ADR-002 |
| 10 | 0.95 = 비가역 직전 vs 직후 | README·06 Q7 vs D04 §5 |
| 11 | 데몬 `auto` 사전 승인 vs 승인 없는 전이 없음 | D10 §2 vs D03 §2 |
| 12 | 게이트 대기 24h vs `ttlMs ≤ 1h` | D01 §5.3 vs 스키마 |
| 13 | 무인 갱신 = "공동인증서 + 저장 비밀번호" vs 법률 의견 전까지 반자동만, 그리고 10:45 판 D05 §4 "홈택스 공동인증서 경로 무인 사실상 불가" | `02-product-spec.md` §74, D10 §2 `auto` 조건 vs README·06 Q4, D05 §4 |
| 14 | (10:45) 폰 승인은 `actionHash`에 서명 vs 엔진 토큰은 `inputsHash`. `actionHash` 정의 없음 | D08 `gate.*` vs D03 §2·§8 |
| 15 | (10:45) 폰 게이트 요청 `exp` 120초 vs `gate.ttlMs` 최대 1시간 | D08 vs 스키마 |
| 16 | (10:45) 재시도 지연의 소유자: IR `onFail.backoffMs` vs 정책 `retries.backoff: full_jitter` | D02 §5·스키마 vs D03 §6 |

#### H-03 [중간] 소유권 공백과 빠진 인터페이스
- **내용**:
  - 게이트 토큰을 누가 발급하는지가 문서마다 다르다. D08 "데스크톱이 발급", D03 엔진, `RunHandle.answerGate(token: GateDecision)`은 UI가 토큰을 넘기는 것처럼 읽힌다.
  - 결과 매핑의 위치가 `model/번들 실행기`인지 `engine`인지 정해지지 않았다.
  - 체크포인트 복귀 네비게이션을 누가 소유하는지 정해지지 않았다.
  - `sign` 매크로의 내부 동작(인증서 선택, 보안카드 칸 번호 읽기)에 명세가 없다.
- **필요한 인터페이스**(현재 없음): `Actuator`(F-02), `CommitGuard`(A-01), `RunJournal`/`IrreversibleLedger`(B-02), `VerifyLookup`(B-01), `BundleDefinition`(E-01), `SelectorDictionary`(G-05), `StandingAuthorization`(C-07).
- **수정**: D03 §11에 위 인터페이스 시그니처를 추가한다. `answerGate`는 `GateDecision{gateRequestId, approved, channel, cardHash}`만 받고 토큰은 엔진(또는 C-08의 `main`)이 발급한다고 명시한다.

#### H-04 [낮음] `answerHuman(stepId, value)`에 요청 ID가 없다
- **내용**: 순환 안에서 같은 `stepId`로 다시 낸 `human` 요청에 이전 답이 적용될 수 있다. D08 `human.response`도 같은 문제가 있다.
- **수정**: `humanRequestId`를 필수로 하고, 만료된 요청의 답은 버린다.

#### H-05 [낮음] 캡차 답이 다음 판정 스냅샷에 실린다
- **위치**: D06 §4("`human` 결과 변수는 모델 입력 금지(타입 시스템)") vs H-01 s91(`fill`) → s93(`decide`, `scope: root`)
- **내용**: 변수는 막혀 있지만, 입력된 캡차 칸의 값은 접근성 트리에 남는다.
- **수정**: D-05의 스냅샷 값 제거 대상에 "최근 `human` 답을 입력한 요소"를 포함한다.

---

## 3. V-03 대체 규칙 초안(커밋 구간 규칙)과 런타임 규칙

**정의**
- CFG는 §A-05의 간선 정의를 따른다. 의사 동작, `resumeAt`, 엔진 암묵 전이를 모두 포함한다.
- 비가역 스텝 X마다 **허가 게이트** `G(X)` = `authorizes` 배열에 X를 담은 게이트 스텝(정확히 1개).
- **커밋 구간** `W(X)` = CFG에서 `G(X)`로부터 X로 가는 경로 위의 모든 노드.

**정적 규칙**
- **V-03a** 모든 비가역 스텝 X는 정확히 하나의 `G(X)`를 가진다. `gate.authorizes`의 각 원소는 비가역 스텝이어야 한다.
- **V-03b** 진입점에서 X로 가는 모든 경로는 `G(X)`를 지난다(지배).
- **V-03c** `W(X) \ {G(X), X}`의 스텝 타입은 `{wait, assert, decide(번들 메타 `sideEffectFree:true`), extract(대상 `readback:true`)}`만 허용한다. `goto, fill, select, press, click, human, handoff, secret_fill, sign, repeat, branch, checkpoint, send_email, submit, save_pdf, capture`는 금지한다.
- **V-03d(단일 진입)** `W(X) \ {G(X)}`에 속한 노드로 들어오는 간선의 출발점은 모두 `W(X)` 안에 있다. 의사 동작·`onFail`·`resumeAt`·암묵 전이 간선도 포함한다. 곧 `G(X)`를 거치지 않고 구간 안으로 들어오는 길은 없다.
- **V-03e** X가 `repeat` 본문 안에 있으면 `G(X)`도 같은 본문 안에서 X보다 먼저 있다.
- **V-03f** X와 `W(X)` 안 스텝의 `onFail.then`은 `handoff|abort`만 허용하고, `retry=0`이다. `W(X)` 안 `decide.on`의 목적지는 `W(X)` 안, 또는 `handoff`/`abort`다. X 뒤의 `verify` 결과 중 `not_committed`의 목적지에서 X로 돌아오는 모든 경로는 `G(X)`를 다시 지나야 한다.
- **V-03g** X가 `click`/`press`이고 그 타깃이 `commits:true`가 아니면 경고, `commits:true` 타깃에 비가역 표시가 없으면 오류(A-01, V-16).
- **V-03h** `G(X).fields`는 (카드 템플릿의 필수 필드) ∪ (X의 모든 파라미터: `to`·`attach`·제출 폼의 readback 필드) ∪ (`idempotencyKey` 구성 요소)를 포함한다.

**후속 비가역(예: 이메일)**: `followUpOf: Xc`를 선언하고 `G(Xc).authorizes`에 포함하면, `W`에 `Xc`, verify, `capture`, `save_pdf`를 허용한다. 단 `handoff`/`human`은 금지이고, 후속 토큰은 Xc 커밋 시 발급된다.

**런타임 규칙**
- **R-G1** 토큰 내용과 단일 사용(C-02).
- **R-G2** `Recovering`, `WaitingHuman`, `HandedOff`, `Paused`, `Interrupted` 진입, 체크포인트 복귀, L2 셀렉터 적용, 핫픽스 적용 중 하나라도 일어나면 그 실행의 미소비 토큰을 전부 폐기한다.
- **R-G3** X 진입 직전에 readback을 재계산해 토큰과 비교한다. 불일치하면 재게이트한다.
- **R-G4** 커밋 가드: 무장된 토큰 없이 `commitEndpoints` 요청이 나가면 중단하고 보안 이벤트를 남긴다. 토큰 하나당 커밋 요청 1회.
- **R-G5** 대화상자 정책(D-01). `confirm`은 무장 구간 + `expectConfirm` 일치일 때만 accept.

---

## 4. 유지할 것(좋은 점)

- 선언적 IR, 서명 패키지, 동적 스텝 생성 금지, 새 동작은 앱 업데이트로(ADR-002의 "의도된 마찰").
- "승인 없이 `WaitingGate`를 떠나는 전이는 전이표에 없다"는 구조. `Paused` 직렬화에서 게이트 토큰을 제외한 것(재개 시 재승인이 강제된다).
- `submit`의 `retry: 0` 고정과 "먼저 확인, 그다음 복귀"라는 원칙(수단만 보강하면 된다).
- 플레이북이 질문을 쓸 수 없고 번들을 참조만 하는 구조. 임계값을 플레이북 밖에 두는 것. 모든 choice에 `unknown`. 게이트웨이 화이트리스트와 서버 정의 툴셋.
- Terra를 읽기 전용 strict 도구 3종으로 제한하고, 컴퓨터 사용 도구를 노출하지 않고, 제안은 "이 실행에서만" 쓰며, 영구 반영은 사람 검토로 하는 것. "모델의 순응에 기대지 않는다"는 전제(D04 §4).
- 모델 출력으로 가능한 행동 집합을 열거한 D04 §5(이 주장을 사실로 만드는 것이 이 리뷰의 D-01·D-02다).
- 정책은 서명 배포, 강화만 가능하고, 위조·지문 필드가 아예 없는 정책 스키마.
- 비밀 응답 경로(`sealedForVault`, `HumanAnswer`에 secret 없음), 마스킹 브랜드 타입.
- 리플레이 수용 기준에 "비가역 스텝 2회 실행 없음"이 이미 들어 있는 점(시나리오에 B의 시퀀스 1~7을 추가하면 된다).
- D04가 근거 없는 수치를 지우고 "미확인"을 표시하는 정직한 서술 방식.

---

## 5. 구현 전 반드시 고칠 것 Top 5

1. **제어 흐름 의미론과 V-03 재작성**(A-01, A-02, A-03, A-05, A-06, §3)
   - D02에 CFG 간선 정의(폴스루, 의사 동작, `resumeAt`, 암묵 전이, `repeat` 경계)를 넣는다.
   - V-03을 "커밋 구간 규칙" V-03a~h로 교체한다.
   - `selectors.json`의 `commits` 표시로 비가역성을 **작성자 신고에서 사전 속성으로** 옮기고, 네트워크 커밋 가드를 설계에 넣는다.
   - CE-1~CE-6을 검증기 퍼징의 고정 회귀 세트로 등록한다.
2. **아이덴포턴시 원장과 InDoubt**(B-01~B-06, C-01)
   - `intentId`, `armed → dispatched → committed|not_committed|in_doubt` 선행 기록, 포털 조회형 `verify`, `InDoubt`/`Interrupted` 상태, 커밋 구간 중 종료 방지, V-04를 모든 비가역 스텝으로 확장한다.
3. **게이트 토큰 재정의**(C-02, C-03, C-04)
   - 단일 사용으로 하고, 카드 해시·readback 해시·패키지/셀렉터 다이제스트·허가 스텝 집합에 묶는다.
   - 복구, 핸드오프, 되감기 시 폐기한다. TTL은 대기와 구간으로 분리한다. 폰 응답은 카드 해시에 묶는다. 커밋 구간의 abort 의미론을 정한다.
4. **복구 계층의 비가역 차단**(D-01, D-02, D-03, D-05)
   - L1 팝업 닫기는 `closeAffordance` 요소만 클릭한다. 네이티브 대화상자 정책을 정한다(`confirm` 기본 dismiss).
   - 비가역과 커밋 구간에서는 L2를 금지한다. L2 셀렉터 동일성 검사 8항을 적용한다.
   - `secretSlot`과 `human` 입력 요소의 값을 스냅샷에서 제거한다.
5. **번들 정의 스키마와 결과 매핑**(E-01, E-02, E-03, E-05, A-07)
   - 순서 있는 매핑 규칙표, 질문별 `onRefusal`, 예약 결과, 단일 임계값 원천(직전 0.95로 기획과 정합), 거절 → handoff(쿨다운 아님), `unknown`의 목적지 제한, PUSH 대기의 결정적 폴링.
   - 이 모든 규칙으로 H-01 예시를 다시 써서 골든 테스트로 고정한다.
