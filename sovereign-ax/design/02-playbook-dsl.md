# D02. 플레이북 IR 스펙

> v1.1 — Review A(research/REVIEW-A-ir-engine.md)의 치명·높음 지적을 반영해 제어 흐름 의미론, 커밋 구간 규칙(V-03a~h), 셀렉터 사전 속성, 조회형 `verify`, 의도 키를 다시 정의했다. 반례 CE-1~6은 검증기 퍼징의 고정 회귀 세트다(D13 §7).

## 1. 설계 결정 요약

- 플레이북은 **TypeScript 빌더로 작성 → JSON IR로 컴파일 → 서명 패키지로 배포 → 엔진이 해석**한다(ADR-002). 사용자 기기에서 임의 코드가 실행되지 않는다.
- IR은 JSON Schema([schemas/playbook-ir.schema.json](schemas/playbook-ir.schema.json)) + **정적 검증 규칙**(§6)을 모두 통과해야 로드된다. 검증기는 레지스트리 CI와 엔진이 **같은 구현**(Ajv 8, strict, ajv-formats)을 쓴다.
- 비가역성은 작성자 신고가 아니라 **셀렉터 사전의 `commits` 속성**에서 온다. `commits: true` 타깃을 누르는 스텝은 비가역 스텝이며, 반드시 **커밋 구간 규칙**(V-03a~h)을 만족해야 한다. 런타임은 **네트워크 커밋 가드**(D03 §5.4)로 이중 방어한다.
- 비가역 스텝의 결과는 화면 판정이 아니라 **포털 조회형 `verify`**로 확정한다. 미확정이면 `InDoubt`.
- 모델은 `decide`(Decisions 번들)와 복구 정책에서만 개입하며, 커밋 구간 안에서는 개입하지 않는다.

## 2. 패키지 구조

```text
<playbook-id>@<semver>.sxp   (zip)
├── manifest.json      # id, version, portal, title, profileKinds, engineRange, domains[], bundlesUsed[{id,ver,digest}], effects[], createdAt
├── playbook.json      # IR 본문
├── selectors.json     # 셀렉터 사전 (stable_id → 후보·속성)
├── strings.ko.json    # 사용자에게 보이는 라벨·프롬프트·변경 로그 (IR의 label/prompt는 이 파일의 키)
└── SIGNATURE          # Ed25519(manifest + playbook + selectors + strings)
```

- `domains[]`: 이동·요청 허용 호스트(정확 일치, 하위 도메인은 명시 와일드카드만). 엔진이 네비게이션·요청을 감시해 밖으로의 이동을 차단한다.
- `effects[]`: 이 플레이북이 일으킬 수 있는 비가역 효과의 종류 `{issue_document, send, sign, pay}`. 데몬 운영 수준 규칙(D10)이 이 값을 본다.
- `bundlesUsed[]`: 참조하는 번들 ID·버전·다이제스트. 번들 정의는 엔진·게이트웨이가 같은 빌드 산출물을 쓰고, 다이제스트 불일치면 게이트웨이가 409를 돌려준다(D04 §3).
- 스키마 파일: `playbook-ir`, `manifest`, `selectors`, `bundle`, `policy`, `hotfix` 6종이 M1-4 착수 전에 완성되어야 한다(현재 저장소에는 `playbook-ir`·`remote-envelope`만 있음).

### 2.1 셀렉터 사전 항목

```json
"hometax.invoice.form.issueButton": {
  "candidates": [{"kind": "role", "role": "button", "name": "발급하기"}, {"kind": "css", "value": "#btnIssue"}],
  "expect": {"visible": true, "enabled": true},
  "role": "button",
  "namePattern": "^발급하기$",
  "frame": "main",
  "landmark": "hometax.invoice.form.root",
  "commits": true,
  "lastVerified": "2026-10-20"
}
```

| 속성 | 의미 |
|---|---|
| `candidates[]` | 순서대로 시도. `css`는 ID/속성 셀렉터만(범용 클래스 금지) |
| `expect` | 가시성·활성 조건 |
| `role`, `namePattern` | 기대 역할과 접근성 이름 패턴. L2 수리 후보 검증에 쓴다(모델이 주장한 이름은 쓰지 않음) |
| `frame`, `landmark` | 프레임 식별자와 가장 가까운 `form`/`dialog` 랜드마크 stable_id |
| `commits` | **이 요소를 누르면 포털에 비가역 제출이 일어난다.** 비가역성의 유일한 원천 |
| `secretSlot` | 비밀 타이피스트가 입력할 수 있는 칸. 스냅샷에서 값 제거 대상 |
| `closeAffordance` | L1 팝업 처리에서 눌러도 되는 닫기 요소(X·닫기·취소). 이름이 `/확인|예|OK|발급|제출|전송|동의/`이면 등록 금지 |
| `readbackOf` | 어느 입력 필드의 화면 값을 되읽는 요소인지(`fieldKey`) |
| `fieldKey` | 입력 필드의 의미 키(`supplyAmount`, `taxAmount`, `counterpartBizNo` …). readback 비교와 L2 동일성 검사에 쓴다 |
| `commitEndpoints[]` | (포털 공통 섹션) 커밋으로 간주할 네트워크 요청 패턴(메서드+경로). 커밋 가드가 사용 |

`commits`·`secretSlot`·`closeAffordance` 항목은 **셀렉터 핫픽스 채널로 바꿀 수 없다**(정식 버전 + 전체 리플레이 필수, D12 §3).

## 3. IR 최상위 구조

```json
{
  "ir": 2,
  "id": "hometax.invoice.issue", "version": "2.0.0", "portal": "hometax",
  "profileKinds": ["business"],
  "effects": ["issue_document", "send"],
  "inputs": {
    "counterpart": {"type": "counterparty", "required": true},
    "amounts": {"type": "amounts", "required": true},
    "items": {"type": "line_items", "required": true, "minItems": 1},
    "issueDate": {"type": "date", "default": "today"},
    "email": {"type": "email", "required": false}
  },
  "preconditions": [{"profileHas": "signMethod"}, {"inputVerified": "counterpart"}],
  "steps": [ ... ],
  "postconditions": [{"varSet": "approvalNo"}, {"artifact": "pdf"}],
  "recovery": {"default": {"retry": 2, "then": "recover"}},
  "pacing": {"profile": "interactive"}
}
```

- 입력 타입은 엔진 내장(`counterparty`, `amounts`, `line_items`, `date`, `email`, `enum`, `string`, `number`, `boolean`, `secret_ref`). 기본값(`today` 등)은 **`prepare()`에서 한 번만 확정**되어 입력에 고정된다(리모트 명령은 폰에서 확정).
- `preconditions`/`postconditions`도 열거형 객체다(§4.1). 미니 언어 없음.
- `pacing.profile`은 트리거보다 느린 쪽만 고를 수 있다(`effective = slower(trigger, ir)`).

## 4. 스텝 어휘

공통 필드: `id`(`^s[0-9]{1,3}$`, 전역 유일), `type`, `label`(strings 키), `pace`(`normal`|`slow`), `timeoutMs`, `onFail`(§5), `loopGuard`(순환에 참여하는 스텝의 상한).

| 타입 | 필드 | 동작 | 비가역 |
|---|---|---|---|
| `goto` | `url`(https만, 허용 도메인) | 이동 후 로드 대기 | 아니오 |
| `click` | `target` | 후보 순서대로 탐색 후 클릭. 타깃이 `commits:true`면 **비가역 스텝**(V-03g) | 타깃에 따라 |
| `fill` | `target`, `value`, `keyEvents?` | 기존 값 제거 → 입력(`fill()` 기본, `keyEvents`면 사람 간격 키 입력) → readback 일치 확인 | 아니오 |
| `select` | `target`, `option` | 드롭다운 선택 | 아니오 |
| `press` | `key`, `target?` | 키 입력. 폼 안에서 `Enter`는 커밋 가능성이 있어 `target.commits` 평가 대상 | 타깃에 따라 |
| `wait` | `for`: `selector`\|`navigation`\|`text`\|`idle`, `value?` | 조건 대기(결정적) | 아니오 |
| `assert` | `cond` | 거짓이면 실패 | 아니오 |
| `extract` | `name`, `from`: `{selector}`\|`{regex:{target,pattern}}`\|`{a11y:{target}}` | 변수 저장. `readback:true`면 readback 전용 | 아니오 |
| `decide` | `bundle`, `scope`(`root`\|targetRef), `on`{outcome→stepRef\|handoff\|abort} | 번들 실행 후 분기. `recover`는 목적지로 쓸 수 없음 | 아니오 |
| `checkpoint` | `name`(전역 유일), `expect`(도착 조건), `url?`, `sessionRequired?` | 복귀 지점. **유일한 선언 방식** | 아니오 |
| `readback` | `fields[fieldKey]` | 비가역 스텝이 제출할 필드를 화면에서 되읽어 정규화·비교(`readbackOf` 요소, 수리된 셀렉터 미사용). 게이트 직전 필수 | 아니오 |
| `gate` | `card`, `authorizes[stepRef]`, `waitMs` | 사용자 승인. 카드는 **readback 값**을 표시. 승인 시 `authorizes`의 스텝 집합에 대한 단일 사용 토큰 발급 | 아니오 |
| `human` | `kind`: `captcha`\|`otp`\|`secret`\|`manual`, `prompt`, `region?`, `target?`(secret·otp 입력 대상), `inputSpec?`, `ttlMs` | 사람 입력. `secret`은 타이피스트 경유 | 아니오 |
| `human_commit` | `prompt`, `verify`, `followUpOf?` | 사람이 직접 누르는 비가역(운영 수준 `assisted`). 토큰 소비 → `armed` → 사람 → 증언 → `verify`. 증언은 verify를 대신하지 못함 | **예** |
| `secret_fill` | `target`(`secretSlot` 필수), `secret`: `cert_password`\|`portal_password`\|`security_card`, `rowFrom?` | **금고가 직접 입력**. 보안카드는 `rowFrom`(화면에서 읽은 칸 번호 변수) | 아니오 |
| `sign` | `method`, `then[]` | 포털 서명 흐름 래퍼(모듈 위임). 내부 동작도 Actuator를 거침 | 아니오 |
| `submit` | `target`(`commits:true`), `intent: "$intent.id"`, `verify`(stepRef), `expectConfirm?` | 비가역 제출. `retry: 0` 고정, `onFail.then ∈ {handoff, abort}` | **예** |
| `verify` | `lookup`: `{playbook, match{fieldKey: valueRef}, window}`, `on`{`committed`\|`not_committed`\|`unknown` → stepRef\|handoff\|abort} | **포털 조회 하위 흐름**으로 제출 여부를 결정적으로 비교. 화면 판정 아님 | 아니오 |
| `capture` | `name`, `from` | 승인번호 등 결과 캡처 | 아니오 |
| `save_pdf` | `strategy`, `docType`, `nameTemplate` | 저장 → 보관함 | 아니오 |
| `send_email` | `via`, `to`(`$inputs.*`만), `attach`(`$artifacts.*`만), `followUpOf`(stepRef), `verify` | 후속 비가역. 선행 커밋 시 함께 발급된 후속 토큰 사용 | **예** |
| `branch` | `on`, `cases`{value→stepRef}, `default` | 정적 분기 | 아니오 |
| `repeat` | `max`(≤ 20), `until`, `steps[]` | 유한 반복. `max` 소진은 실패(`onFail`) | 아니오 |
| `handoff` | `reason`, `resumeAt`(stepRef, 필수) | 사람에게 화면 넘김 | 아니오 |
| `end` | `status` | 종료 | 아니오 |

`batch_gate`(묶음 발급, 건별 토큰)는 Phase 3에서 별도 타입으로 설계한다. `repeat` 안의 비가역은 금지(V-03e).

### 4.1 조건식

열거형 객체만: `{exists}`, `{textMatches:{target, patternRef}}`, `{varEquals}`, `{varSet}`, `{inputPresent}`, `{sumEquals}`, `{all}`, `{any}`, `{not}`. `patternRef`는 strings 파일의 정규식 키(RE2 호환 하위 집합). 임의 스크립트 없음.

### 4.2 값 참조

`$inputs.X`(선언된 입력만), `$vars.X`(지배하는 `extract`/`capture`가 있어야 함), `$human.sN`(sN이 `human`이고 사용 지점을 지배), `$profile.X`(비밀 없음), `$intent.id`, `$artifacts.X`. 상수는 사용자 데이터 형식 리터럴 금지(V-13).

### 4.3 제어 흐름 의미론 (정적 분석기의 간선 정의)

1. **폴스루**: 같은 `steps` 배열의 다음 원소. `repeat` 본문 마지막 → `repeat` 헤더. 헤더는 `until` 참이면 다음 원소, `max` 소진이면 **실패**로 `onFail`.
2. **비가역 스텝의 다음은 항상 `verify`**(`submit.verify`, `human_commit.verify`, `send_email.verify`). 폴스루 없음.
3. **의사 동작**: `handoff` → 합성 노드 H, 재개 간선은 `resumeAt`으로 반드시 명시. `recover` → 그 스텝을 지배하는 모든 체크포인트로 가는 간선(복구 성공 시 **실패한 그 스텝**을 재실행하는 간선 포함). `checkpoint:n` → 이름 n인 단일 스텝. `abort` → 종료 노드. `human:secret` → 같은 위치의 합성 `human` 노드 → 원래 다음 스텝.
4. **엔진 암묵 전이**(세션 만료 → `session` 체크포인트, 팝업 처리 → 같은 스텝 재시도, 이중로그인 → 일시정지)도 합성 간선으로 CFG에 넣는다.
5. `repeat` 경계를 넘는 점프 금지.
6. 도달성: 모든 노드에서 `end` 또는 `abort`에 도달 가능. `repeat` 밖의 모든 순환은 참여 스텝에 `loopGuard.max`가 있어야 한다(V-18).

## 5. 실패 정책

```json
"onFail": {"retry": 2, "then": "recover" | "checkpoint:<name>" | "handoff" | "abort" | "human:secret"}
```
- 재시도 지연은 IR에 없다. **정책(`policy.retries`)이 소유**한다(Equal Jitter, 하한 = `stepDelayMs` 하한).
- 비가역 스텝과 커밋 구간 안 스텝: `retry: 0`, `then ∈ {handoff, abort}`(V-03f). 커밋 셀렉터 실패 시 할 수 있는 일은 `verify` → handoff뿐이다.
- `recover`는 D03 §5의 복구 계층(L1 `recovery_v1` 판정 → L2 수리 → 핸드오프)을 탄다. L2 상한은 실행당 `policy.l2MaxAttempts`(기본 1) 하나뿐이다.

## 6. 정적 검증 규칙 (로드 시 전부 통과해야 함)

| 규칙 | 내용 |
|---|---|
| V-01 | JSON Schema 적합(`unevaluatedProperties: false`, 미정의 필드 거부) |
| V-02 | 모든 `target`이 `selectors.json`에 존재하고 속성 요구(`secret_fill`→`secretSlot`, `submit`→`commits`)를 만족 |
| **V-03a** | 비가역 스텝 X(= `submit`, `human_commit`, `send_email`, `commits:true` 타깃의 `click`/`press`)마다 `authorizes`에 X를 담은 게이트 `G(X)`가 **정확히 하나** |
| **V-03b** | 진입점에서 X로 가는 모든 경로(§4.3 간선 전부)는 `G(X)`를 지난다(지배) |
| **V-03c** | 커밋 구간 `W(X)`(G(X)→X 경로 위 노드) \ {G, X}의 스텝 타입은 `{wait, assert, decide(sideEffectFree 번들), extract(readback:true)}`만. `goto, fill, select, press, click, human, handoff, secret_fill, sign, repeat, branch, checkpoint, save_pdf, capture, send_email, submit` 금지 |
| **V-03d** | `W(X) \ {G}`로 들어오는 모든 간선(의사 동작·`onFail`·`resumeAt`·암묵 전이 포함)의 출발점은 `W(X)` 안이다(단일 진입) |
| **V-03e** | X는 `repeat` 본문 안에 있을 수 없다 |
| **V-03f** | X와 `W(X)` 안 스텝의 `onFail` = `{retry:0, then∈{handoff,abort}}`. `W(X)` 안 `decide.on` 목적지는 `W(X)` 안·`handoff`·`abort`. `verify.not_committed`에서 X로 돌아오는 모든 경로는 `G(X)`를 다시 지난다 |
| **V-03g** | `click`/`press` 타깃이 `commits:true`인데 게이트 허가가 없으면 오류. 타깃이 `commits`가 아닌데 `submit` 타입이면 오류 |
| **V-03h** | `G(X).card`의 필드 집합 ⊇ 카드 템플릿 필수 필드 ∪ X의 모든 파라미터(`to`, `attach`, 제출 폼의 `readback` 필드) ∪ `intent.id`. 게이트 직전에 `readback` 스텝이 있고 그 `fields`가 X의 제출 필드를 덮는다 |
| V-04 | 모든 비가역 스텝은 `intent: "$intent.id"`와 `verify`를 가진다. `verify.lookup.match`는 `readback` 필드를 포함 |
| V-05 | `repeat.max ≤ 20`, 중첩 ≤ 2 |
| V-06 | `goto.url`을 WHATWG URL로 파싱: `https:`, userinfo 없음, 포트 없음, `hostname ∈ manifest.domains` |
| V-07 | `decide.on` 키 집합 = 번들 결과 − `reservedOutcomes`(엔진 처리: `blocked`, `logged_out_by_other_session`) 이고 `unknown` 포함. V-07b: `unknown`의 목적지는 `handoff`/`abort`, 또는 비가역 스텝을 거치지 않고 같은 `decide`로 돌아오는 대기 루프(`loopGuard` 필수) |
| V-08 | `secret_fill`은 `value` 없음, `secret` 열거값, 보안카드는 `rowFrom` 필수 |
| V-09 | `pace`는 `normal`/`slow`뿐(없음 선택 불가) |
| V-10 | `human.kind=captcha`는 `region` 필수. 이어지는 `fill`의 값은 `$human.sN`만. `kind=secret|otp`는 `target` 필수 |
| V-11 | 도달성(§4.3-6) |
| V-12 | `profileKinds`와 입력·비밀 종류 일치 |
| V-13 | 상수에 사용자 데이터 형식 리터럴 금지 |
| V-14 | `manifest.effects` ⊇ 플레이북이 실제로 포함하는 비가역 효과. `pacing.profile=daemon` 플레이북은 `effects ⊆ {issue_document}` |
| V-15 | 모든 `$inputs.X` 선언됨, `$vars.X`·`$human.sN` 지배 관계 성립, 선택 입력을 쓰는 비가역 스텝 앞에 `branch{inputPresent}` 존재 |
| V-16 | `send_email.to`·`attach`는 참조만(상수 금지) |
| V-17 | 체크포인트 이름 전역 유일, `checkpoint:` 참조가 실재 |
| V-18 | `repeat` 밖 순환의 참여 스텝에 `loopGuard.max ≤ 5` |
| V-19 | 스텝 `id` 전역 유일(중첩 `repeat` 포함) |

CE-1~CE-6(REVIEW-A §1)은 검증기 퍼징의 고정 회귀 세트이며, 이 규칙으로 모두 거부되어야 한다.

## 7. 의도 키와 중복 판정

- **`intentId`**(ULID)는 `prepare()`가 만들고 카드에 표시한다. 리모트 명령은 폰이 만든 `cmd_id`를 그대로 쓴다. 아이덴포턴시 원장(D07 `irreversible_log`)의 키다.
- **업무 중복 키** = JCS(RFC 8785)로 정규화한 `(profile.bizNo, counterpart.bizNo, supply, tax, issueDate, items[].name)`의 해시. 원장에 같은 키의 `armed|dispatched|in_doubt|committed`가 있으면 **차단하지 않고 카드에 경고**를 띄워 명시 확인을 받는다(정당한 동일 거래 2건을 막지 않기 위해).
- 선택안: 사용자 동의 시 비고란에 짧은 의도 코드(`AX-7K3P`)를 적어 조회 정확도를 높인다.

## 8. 예시: H-01 전자세금계산서 건별발급 v2 (발췌)

```json
{
  "ir": 2, "id": "hometax.invoice.issue", "version": "2.0.0", "portal": "hometax",
  "profileKinds": ["business"], "effects": ["issue_document", "send"],
  "inputs": {"counterpart": {"type": "counterparty", "required": true}, "amounts": {"type": "amounts", "required": true},
             "items": {"type": "line_items", "required": true}, "issueDate": {"type": "date", "default": "today"},
             "email": {"type": "email", "required": false}},
  "preconditions": [{"profileHas": "signMethod"}, {"inputVerified": "counterpart"}],
  "steps": [
    {"id": "s0", "type": "checkpoint", "name": "session", "expect": {"exists": "hometax.nav.home"}, "url": "https://hometax.go.kr/", "sessionRequired": true},
    {"id": "s1", "type": "goto", "url": "https://hometax.go.kr/"},
    {"id": "s2", "type": "decide", "bundle": "screen_state_v2", "scope": "root", "loopGuard": {"max": 3},
     "on": {"logged_in": "s10", "login_required": "s3", "captcha": "s90", "mfa_pending": "s5", "error": "handoff", "unknown": "handoff"}},
    {"id": "s3", "type": "click", "target": "hometax.login.simpleAuthButton"},
    {"id": "s4", "type": "sign", "method": "$profile.signMethod", "then": ["human:secret"]},
    {"id": "s5", "type": "wait", "for": "text", "value": "hometax.login.successMarker", "timeoutMs": 120000, "pace": "slow"},
    {"id": "s6", "type": "decide", "bundle": "screen_state_v2", "scope": "root", "loopGuard": {"max": 3},
     "on": {"logged_in": "s10", "login_required": "handoff", "captcha": "s90", "mfa_pending": "s5", "error": "handoff", "unknown": "handoff"}},
    {"id": "s10", "type": "goto", "url": "https://hometax.go.kr/invoice/issue"},
    {"id": "s11", "type": "checkpoint", "name": "form", "expect": {"exists": "hometax.invoice.form.root"}},
    {"id": "s12", "type": "fill", "target": "hometax.invoice.form.counterpartBizNo", "value": "$inputs.counterpart.bizNo"},
    {"id": "s13", "type": "click", "target": "hometax.invoice.form.lookupCounterpart"},
    {"id": "s14", "type": "assert", "cond": {"textMatches": {"target": "hometax.invoice.form.counterpartName", "patternRef": "counterpart.nameRegex"}}},
    {"id": "s15", "type": "fill", "target": "hometax.invoice.form.item1.name", "value": "$inputs.items[0].name"},
    {"id": "s16", "type": "fill", "target": "hometax.invoice.form.item1.supply", "value": "$inputs.amounts.supply"},
    {"id": "s17", "type": "fill", "target": "hometax.invoice.form.item1.tax", "value": "$inputs.amounts.tax"},
    {"id": "s18", "type": "decide", "bundle": "form_ready_v2", "scope": "hometax.invoice.form.root",
     "on": {"ready": "s19", "validation_error": "handoff", "unknown": "handoff"}},
    {"id": "s19", "type": "readback", "fields": ["counterpartBizNo", "counterpartName", "itemName", "supplyAmount", "taxAmount", "totalAmount", "issueDate"]},
    {"id": "s20", "type": "gate", "card": "invoice.confirm", "authorizes": ["s21", "s33"], "waitMs": 600000},
    {"id": "s21", "type": "submit", "target": "hometax.invoice.form.issueButton", "intent": "$intent.id", "verify": "s30", "expectConfirm": "confirm.issue",
     "onFail": {"retry": 0, "then": "handoff"}},
    {"id": "s30", "type": "verify", "lookup": {"playbook": "hometax.invoice.lookup", "match": {"counterpartBizNo": "$inputs.counterpart.bizNo", "issueDate": "$inputs.issueDate", "supplyAmount": "$inputs.amounts.supply", "taxAmount": "$inputs.amounts.tax"}, "window": "issueDate"},
     "on": {"committed": "s31", "not_committed": "s11", "unknown": "handoff"}},
    {"id": "s31", "type": "capture", "name": "approvalNo", "from": {"regex": {"target": "hometax.invoice.result.approvalNo", "patternRef": "approvalNo"}}},
    {"id": "s32", "type": "save_pdf", "strategy": "print", "docType": "tax_invoice", "nameTemplate": "세금계산서/{yyyy}/{MM}/{counterpart.name}_{yyyyMMdd}_{approvalNo}.pdf"},
    {"id": "s32b", "type": "branch", "on": {"inputPresent": "email"}, "cases": {"true": "s33"}, "default": "s34"},
    {"id": "s33", "type": "send_email", "via": "portal", "to": "$inputs.email", "followUpOf": "s21", "verify": "s33v", "onFail": {"retry": 0, "then": "handoff"}},
    {"id": "s33v", "type": "verify", "lookup": {"playbook": "hometax.invoice.emailStatus", "match": {"approvalNo": "$vars.approvalNo"}, "window": "today"},
     "on": {"committed": "s34", "not_committed": "handoff", "unknown": "handoff"}},
    {"id": "s34", "type": "end", "status": "success"},
    {"id": "s90", "type": "human", "kind": "captcha", "region": "hometax.captcha.image", "prompt": "captcha.prompt", "ttlMs": 90000},
    {"id": "s91", "type": "fill", "target": "hometax.captcha.input", "value": "$human.s90"},
    {"id": "s92", "type": "click", "target": "hometax.captcha.submit"},
    {"id": "s93", "type": "decide", "bundle": "screen_state_v2", "scope": "root", "loopGuard": {"max": 2},
     "on": {"logged_in": "s10", "login_required": "s3", "captcha": "handoff", "mfa_pending": "s5", "error": "handoff", "unknown": "handoff"}}
  ],
  "postconditions": [{"varSet": "approvalNo"}, {"artifact": "pdf"}]
}
```

검증 근거: 비가역 스텝은 `s21`(commits 타깃)과 `s33`이며 `G = s20`이 둘을 `authorizes`한다(V-03a). `W(s21) = {s20, s21}`로 사이에 아무 스텝이 없고(V-03c), `s30.not_committed → s11`은 게이트 앞 체크포인트로 가서 재진입 시 `s20`을 다시 지난다(V-03f). `s33`은 `followUpOf: s21`로 선행 커밋 시 발급된 후속 토큰을 쓰며 `s32b`가 선택 입력 존재를 확인한다(V-15). 카드 `invoice.confirm` 템플릿은 `readback` 7개 필드 + `email` + `intent.id`를 표시한다(V-03h). `blocked`·`logged_out_by_other_session`은 예약 결과라 `on`에 없다(V-07). `s22↔s30` 순환은 사라졌고 PUSH 대기는 결정적 `wait`(s5)다. 로그인은 사업자 간편인증을 기본 경로로 두고(`s3`), 공동인증서 경로는 가상키패드 때문에 `sign.then`의 `human:secret`로 떨어진다(D05 §4).

주의: URL·셀렉터는 스파이크 S1에서 확정한다. `hometax.invoice.lookup`·`emailStatus`는 조회 전용 하위 플레이북(비가역 없음)이다.

## 9. 운영 수준별 실행 변환

`portalMode`(D03 §12)에 따라 엔진이 IR을 변환하되, **변환 결과를 같은 검증기로 다시 검증**하고 실패하면 그 모드에서 실행하지 않는다.
- `postprocess`: 실행하지 않고 `guide` 변환본(체크리스트·복사 버튼·파일 감시)만. 복사 버튼은 30초 뒤 클립보드를 비운다(값이 그대로일 때만).
- `assisted`: 로그인 구간(`checkpoint: session`까지)과 모든 비가역 스텝(`submit`·`send_email`)을 `human_commit`으로, `sign`을 `human(manual)`로 치환. `human_commit`도 토큰 소비·`armed`·`verify` 규칙을 그대로 따른다.

## 10. 버전·호환

- `version` semver. major = 입력 스키마 변경. `ir` 버전이 다르면 엔진 호환 범위를 따른다.
- 셀렉터 핫픽스 패키지는 `commits`·`secretSlot`·`closeAffordance` 항목을 바꿀 수 없고, 핫픽스 다이제스트는 게이트 토큰의 `packageDigest`에 포함된다.
