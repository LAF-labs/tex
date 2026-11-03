# D02. 플레이북 IR 스펙

> AUDIT-D 반영 2026-11-03: `secretKind`·`secretPurpose`와 V-02 결박(§2.1·§6), verify `maxMs`·실패 신호 쌍(§4.4), 보조 중복 키 `$dup.recentSameAmount`(§7), 골든 H-01 s19e 작성일자 대조·s33 메일 상태 부정 우선·V-03j′(§6.1·§8)(ADR-025·026·027, D19 §3.5).
> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영. 바뀐 절에는 근거 ID를 괄호로 붙였다. 이전 판 v1.1은 Review A(research/REVIEW-A-ir-engine.md)를 반영해 제어 흐름 의미론, 커밋 구간 규칙(V-03a~h), 셀렉터 사전 속성, 조회형 `verify`, 의도 키를 정의했다. 반례 CE-1~CE-18은 검증기 퍼징의 고정 회귀 세트다(D13 §7).

## 1. 설계 결정 요약

- 플레이북은 **TypeScript 빌더로 작성 → JSON IR로 컴파일 → 서명 패키지(2-of-3 임계 서명)로 배포 → 엔진이 해석**한다(ADR-002, B-22). 사용자 기기에서 임의 코드가 실행되지 않는다.
- IR은 JSON Schema([schemas/playbook-ir.schema.json](schemas/playbook-ir.schema.json)) + **정적 검증 규칙**(§6.1, V-01~V-24·V-03a~l·V-03c′)을 모두 통과해야 로드된다. 셀렉터 사전은 [schemas/selectors.schema.json](schemas/selectors.schema.json)과 **셀렉터 CI 규칙**(§6.3, SV-01~06)을 통과해야 한다. 검증기는 레지스트리 CI와 엔진이 **같은 구현**(Ajv 8, strict, ajv-formats)을 쓰고, 모든 정규식은 RE2로 컴파일한다(B-35).
- 비가역성의 원천은 셀렉터 사전의 **`commits` 속성**이다. 다만 이 값도 사람이 선언한 것이므로 세 겹으로 확인한다(B-01·B-02). ① 셀렉터 CI가 녹화(HAR·DOM)와 대조한다(SV-01 충돌, SV-02 HAR 상관·이름 린트). ② 런타임이 매 액추에이션 직전에 실제 요소의 역할·접근성 이름을 사전과 대조하고(R-A1), 비커밋 항목이 같은 랜드마크의 커밋 항목과 같은 요소로 해석되면 거부한다(R-A2, D03 §5.2). ③ 네트워크 커밋 가드가 요청을 막는다(D03 §5.4). **핫픽스는 이 근거 중 어느 것도 바꿀 수 없다**(§2.2, ADR-012).
- `commits: true` 타깃을 누르는 스텝은 비가역 스텝이며 **커밋 구간 규칙**(V-03a~l, V-03c′)을 만족해야 한다.
- 비가역 스텝의 결과는 화면 판정이 아니라 **포털 조회형 `verify`**로 확정한다. 게이트 직전 기준선과 비교해 "새로 생긴 1건"일 때만 `committed`다(§4.4, B-07). 조회 하위 플레이북은 버전·다이제스트로 고정한다(B-08). 미확정이면 `InDoubt`.
- 모델은 `decide`(Decisions 번들)와 복구 정책에서만 개입한다. **커밋 구간 `W(X)` 안에서는 어떤 모델 호출도 없다**(W 안 `decide` 금지, B/C-03). 차단·보안 경고 판정은 커밋 구간 진입 **전**에 끝낸다(D03 §5.3).
- 승인 카드의 라벨·값 배치·순서·고정 경고는 **앱 소유**다. 패키지 문자열은 카드 제목과 보조 설명만 바꿀 수 있다(V-03h, B-24).

## 2. 패키지 구조

```text
<playbook-id>@<semver>.sxp   (zip)
├── manifest.json      # id, version, kind, portal, title, profileKinds, engineRange, domains[], effects[],
│                      # bundlesUsed[{id,ver,digest}], lookupsUsed[{id,version,digest}], contentDigests{}, createdAt, signatures[≥2]
├── playbook.json      # IR 본문
├── selectors.json     # 셀렉터 사전 (stable_id → 후보·속성, 포털 공통 commitEndpoints·knownEndpoints)
└── strings.ko.json    # 카드 제목·보조 설명·프롬프트·변경 로그 (카드 필드 라벨은 여기 없다 — 앱 내장)
```

- `signatures[]`(B-22): 앱에 핀 고정된 패키지 서명 키 3개 중 **서로 다른 2개 이상**의 Ed25519 서명이다. 서명 대상은 `JCS(manifest − signatures)`이고, manifest의 `contentDigests`가 나머지 세 파일을 묶는다. v1.1의 단일 `SIGNATURE` 파일은 폐지한다. 로드 규칙은 D03 §3.1, 키 운영은 D09 §8·ADR-013.
- `kind`: `playbook` 또는 `lookup`(조회 하위 플레이북, `effects: []`, V-22)(B-08).
- `domains[]`: 이동·요청 허용 호스트(정확 일치, 하위 도메인은 명시 와일드카드만). 엔진이 네비게이션·요청을 감시해 밖으로의 이동을 차단하고, 금고 중계도 매 문서 커밋마다 `내장 eTLD+1 ∩ domains`를 다시 확인한다(D05).
- `effects[]`: 이 플레이북이 일으킬 수 있는 비가역 효과의 종류 `{issue_document, send, sign, pay}`. 데몬 실행 가능 여부는 이 값을 **런타임에** 본다(R-D1, D03 §12, B-27).
- `bundlesUsed[]`: 참조하는 번들 ID·버전·다이제스트. **번들 정의는 앱 바이너리에만 포함되고 레지스트리로 배포하지 않는다**(BV-06, ADR-003). 다이제스트가 앱 내장 허용 목록에 없으면 패키지를 로드하지 않는다. 게이트웨이의 409는 배포 불일치 감지용일 뿐이다(B-14, B-21, B/C-20). 이름 대응: IR의 `decide.bundle`은 `"<id>_v<ver>"`(예: `screen_state_v2`)이고, manifest `bundlesUsed[]`와 번들 정의(bundle.schema)는 `id`(`screen_state`)와 `ver`(`2`)를 나눠 적는다. 로더는 둘을 이 규칙으로 맞춰 본다.
- `lookupsUsed[]`(B-08): `verify`가 부르는 조회 하위 플레이북의 ID·버전·다이제스트. 이 다이제스트는 게이트 토큰의 `packageDigest`에 들어간다(D03 §3). 조회 패키지는 핫픽스 대상이 아니다.
- 스키마 파일 9종이 저장소에 있다(v1.3): `playbook-ir`, `manifest`, `selectors`, `hotfix`, `bundle`, `policy`, `gateway-request`, `remote-envelope`, `intent-envelope`. 앞의 7종은 M1-4 착수 전, 리모트 2종은 Phase 2 착수 전에 동결한다.

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
  "commitEffect": "issue_document",
  "lastVerified": "2026-10-20"
},
"hometax.invoice.form.counterpartEmail": {
  "candidates": [{"kind": "label", "value": "공급받는자 이메일"}, {"kind": "css", "value": "[name=\"dmnrEmail\"]"}],
  "role": "textbox",
  "namePattern": "^(공급받는자 )?이메일$",
  "frame": "main",
  "landmark": "hometax.invoice.form.root",
  "commits": false,
  "inputType": "email",
  "fieldKey": "counterpartEmail",
  "lastVerified": "2026-10-20"
}
```
(값·셀렉터는 예시다. 실제 이름·속성은 S1에서 확정한다.)

| 속성 | 의미 |
|---|---|
| `candidates[]` | 순서대로 시도. `css`는 ID/허용 속성(`id`·`name`·`data-*`·`aria-label`) 셀렉터만(범용 클래스 금지). **핫픽스가 바꿀 수 있는 유일한 속성**이고, 그것도 적격 항목에서만(§2.2) |
| `expect` | 가시성·활성 조건 |
| `role`, `namePattern` | 기대 역할과 접근성 이름 패턴. `namePattern`은 `^…$` 앵커 필수이고 녹화 DOM의 같은 랜드마크 안에서 정확히 1개 요소에만 맞아야 한다(SV-04, B-17). 런타임은 **매 액추에이션**마다 실제 요소를 이 둘과 대조한다(R-A1). L2 수리 후보 검증에도 쓴다(모델이 주장한 이름은 쓰지 않음) |
| `frame`, `landmark` | 프레임 식별자와 가장 가까운 `form`/`dialog` 랜드마크 stable_id |
| `commits` | **필수.** 이 요소를 누르면 포털에 비가역 제출이 일어난다. 비가역성의 원천이며 SV-01·SV-02로 녹화와 대조한다(B-02) |
| `commitEffect` | `commits:true`일 때 필수: `issue_document`\|`send`\|`sign`\|`pay`. V-14·R-D1의 계산 근거 |
| `inputType` | 기대 입력 형식. `password`는 `secretSlot`과 같이 V-20 대상 |
| `secretKind`·`secretPurpose` | `secretSlot`은 `secretKind`(cert_password·portal_password·security_card)와 `secretPurpose`(login·sign)다. V-02: `secret_fill.secret == entry.secretKind`이고 `secretPurpose`는 그 흐름(로그인 구간·signFlow) 안에서만(ADR-026, D-30(N-46)). 이 문서와 다른 문서의 `secretSlot`은 'secretKind가 있는 항목'을 뜻한다. 비밀 타이피스트가 입력할 수 있는 칸. `secret_fill`·`human:secret`의 타깃 외에는 어떤 스텝도 이 칸을 읽거나 범위에 넣을 수 없다(V-20). `readbackOf`·`fieldKey`·`allowedConstants`를 가질 수 없다(스키마) |
| `closeAffordance` | L1 팝업 처리에서 눌러도 되는 닫기 요소(X·닫기·취소). 녹화 이름이 앱 내장 `DENY_ACTION_NAME`(D03 §7.1)에 맞으면 등록 금지(SV-05, B-32) |
| `navigationOnly` | 누르면 조회·이동만 일어나는 요소. 조회 하위 플레이북의 `click`은 이 항목만 쓸 수 있다(V-22) |
| `fieldKey` | 입력 필드의 의미 키(`supplyAmount`, `taxAmount`, `counterpartBizNo`, `counterpartEmail`, `supplierBizNo` …). 커밋 랜드마크 안 모든 입력 칸에 필수(SV-03). 장식·검색 전용 칸은 `"_ignore"` + `reviewNote` |
| `readbackOf` | 어느 입력 필드의 값을 표시하는 별도 요소인지(`fieldKey`) |
| `allowedConstants[]` | `fill.value`·`select.option`에 쓸 수 있는 상수의 전부(예: 청구/영수 라디오 값)(V-21, B-25) |
| `reviewNote` | SV-02 이름 린트 예외·`_ignore`의 검토자 서명과 사유 |
| `commitEndpoints[]` | (포털 공통 섹션) 커밋으로 간주할 요청 패턴(`match` = 메서드 + 경로 + 선택적 액션 파라미터, `effect`, `maxRequests`, `encoding`, `bodyFieldMap`). 가드는 같은 포털의 설치된 모든 패키지 `commitEndpoints`의 **합집합**을 쓴다(D03 §5.4) |
| `knownEndpoints[]` | (포털 공통 섹션) 녹화에서 관측된 일반 요청. 어느 쪽에도 없는 요청은 `commit_guard.unclassified`로 기록(R-C3) |

**readback이 읽는 값**(B-06): readback은 입력 요소 자체의 DOM `value`(CDP `Runtime.callFunctionOn`의 읽기 전용 함수)와 접근성 트리의 값을 **둘 다** 읽어 정규화한 뒤 일치해야 한다. 별도 표시 요소(`readbackOf`)가 있으면 세 값이 모두 일치해야 한다. 하나라도 다르면 `step.readback_mismatch`다. 수리된 셀렉터는 readback에 쓰지 않는다.

### 2.2 셀렉터 핫픽스의 범위 (B-01, ADR-012)

- 핫픽스가 바꿀 수 있는 것은 `commits:false ∧ secretSlot≠true ∧ inputType≠password ∧ closeAffordance≠true ∧ readbackOf 없음 ∧ fieldKey 없음`인 항목의 **`candidates` 배열**(추가·순서 변경·삭제)뿐이다.
- 위 조건을 만족해도 다음 항목은 **핫픽스 불가**다(E-03): (a) 어떤 항목의 `landmark` 값으로 쓰이는 stable_id(랜드마크 항목), (b) IR의 `decide.scope`·조건식(`cond`, 예: `textMatches.target`)·`signFlow.rowLabel`·`readback.fields`·`signFlow.confirmTarget`이 참조하는 항목, (c) 어떤 커밋 구간 `W(X)` 안 스텝(`wait`·`assert`·`extract`)이 참조하는 항목. 엔진은 IR에서 이 참조 집합을 계산해 적격 여부를 확인하고, 레지스트리 핫픽스 CI도 같은 계산을 한다.
- `role`·`namePattern`·`frame`·`landmark`·`expect`·`readbackOf`·`fieldKey`·`commits`·`commitEffect`·`secretSlot`·`closeAffordance`·`navigationOnly`·`allowedConstants`와 IR 본문은 **정식 버전 + 전체 리플레이**로만 바꾼다.
- 포털 공통 `commitEndpoints`는 **추가만**(강화) 핫픽스로 허용한다(`commitEndpointsAdd`). 기존 항목의 수정·삭제는 정식 버전으로만.
- 조회 하위 플레이북(`kind: lookup`)은 핫픽스 대상이 아니다(B-08).
- 형식은 [schemas/hotfix.schema.json](schemas/hotfix.schema.json)이다. 금지 속성은 키 자체가 없어 스키마에서 막히고, 대상 항목의 적격 조건은 엔진이 검사한다. 핫픽스는 `appliesTo.packageDigest`로 **정확히 한 패키지**에 결속되고, 단조 `monotonic`·`keyEpoch`·`expiresAt`(≤ 14일)을 가지며, 2-of-3 서명이 있어야 로드된다(B-22).
- 엔진은 핫픽스를 반영한 사전에 스키마와 V-01~V-24를 다시 돌리고, 하나라도 실패하면 핫픽스를 거부한다(D03 §3.1). **SV 실행 위치**(정본 D03 §3.1-6): SV-01~06은 레지스트리의 패키지·핫픽스 CI에서만 돌고 2-of-3 서명이 그 통과를 전제로 한다. 클라이언트는 SV를 다시 돌리지 않고 런타임에 R-A1·R-A2·`DENY_ACTION_NAME` 검사를 매번 한다.
- 핫픽스 다이제스트는 게이트 토큰의 `packageDigest`에 들어가므로 적용 즉시 진행 중 실행의 미소비 토큰이 폐기된다.

## 3. IR 최상위 구조

```json
{
  "ir": 2,
  "id": "hometax.invoice.issue", "version": "2.1.0", "portal": "hometax",
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

- 입력 타입은 엔진 내장(`counterparty`, `amounts`, `line_items`, `date`, `email`, `enum`, `string`, `number`, `boolean`, `secret_ref`). 기본값(`today` 등)은 **`prepare()`에서 한 번만 확정**되어 입력에 고정된다(리모트 명령은 폰에서 확정). 재개 시점의 KST 날짜가 `prepare()`와 다르면 카드에 고정 경고를 띄운다(D03 §5.5, B-13).
- `preconditions`/`postconditions`도 열거형 객체다(§4.1). 미니 언어 없음.
- `pacing.profile`은 속도만 정하며 트리거보다 느린 쪽만 고를 수 있다(`effective = slower(trigger, ir)`). **데몬 효과 제한은 `pacing`과 무관하게 런타임 R-D1이 `manifest.effects`로 집행한다**(B-27).

## 4. 스텝 어휘

공통 필드: `id`(`^s[0-9]{1,3}[a-z]?$`, 전역 유일 — 스키마와 일치, B/C-08), `type`, `label`(strings 키), `pace`(`normal`|`slow`), `timeoutMs`, `onFail`(§5), `loopGuard`(순환에 참여하는 스텝의 상한).

| 타입 | 필드 | 동작 | 비가역 |
|---|---|---|---|
| `goto` | `url`(https만, 허용 도메인) | 이동 후 로드 대기 | 아니오 |
| `click` | `target` | 후보 순서대로 탐색 → 동일성 검사(R-A1) → 클릭. 타깃이 `commits:true`면 **비가역 스텝**(V-03g) | 타깃에 따라 |
| `fill` | `target`, `value`, `keyEvents?`, `ifAbsent?`(`fail`\|`clear`) | 기존 값 제거 → 입력(`fill()` 기본, `keyEvents`면 고정 간격 키 입력) → readback 일치 확인. 상수 값은 `allowedConstants`만(V-21). 선택 입력이 비었을 때 `clear`면 칸을 비운다(포털 자동 채움 제거용, B-05) | 아니오 |
| `select` | `target`, `option` | 드롭다운 선택. 상수는 `allowedConstants`만(V-21). 타깃이 `commits:true`면 비가역(V-03k) | 타깃에 따라 |
| `press` | `key`, `target`(`Enter`면 필수) | 키 입력. `Enter`의 타깃 랜드마크 안에 `commits:true` 항목이 있으면 비가역(V-03k, B-02) | 타깃에 따라 |
| `wait` | `for`: `selector`\|`navigation`\|`text`\|`idle`, `value?` | 조건 대기(결정적) | 아니오 |
| `assert` | `cond` | 거짓이면 실패 | 아니오 |
| `extract` | `name`, `from`: `{selector}`\|`{regex:{target,pattern}}`\|`{a11y:{target}}` | 변수 저장. `readback:true`면 readback 전용. 비밀 칸은 대상이 될 수 없다(V-20) | 아니오 |
| `decide` | `bundle`, `scope`(`root`\|targetRef), `on`{outcome→stepRef\|handoff\|abort} | 번들 실행 후 분기. `recover`는 목적지로 쓸 수 없음. **커밋 구간 안 금지**(V-03c, B/C-03). `scope`가 비밀 칸의 랜드마크를 포함하면 오류(V-20) | 아니오 |
| `checkpoint` | `name`(전역 유일), `expect`(도착 조건), `url?`, `sessionRequired?`, `reentry?`(`reuse`\|`reload`, 기본 `reuse`) | 복귀 지점. **유일한 선언 방식**. 게이트를 지배하는 복귀 지점은 `url` + `reload` 필수(V-03l, B-13) | 아니오 |
| `readback` | `fields[fieldKey]` | 비가역 스텝이 제출할 필드를 화면에서 되읽어 정규화·비교(§2.1의 세 값 일치). 결과는 `$readback.<fieldKey>`로 참조. 게이트 앞 필수, 범위는 커밋 랜드마크의 `fieldKey` 전부(V-03j) | 아니오 |
| `gate` | `card`(제목 strings 키), `authorizes[stepRef]`(≤ 3), `waitMs` | 사용자 승인. 카드는 **readback 값**을 앱 내장 라벨로 표시(V-03h). `authorizes`는 주 비가역 1개 + 그 후속만(V-03i). 승인 시 주 비가역 1회용 토큰 발급(D03 §3) | 아니오 |
| `human` | `kind`: `captcha`\|`otp`\|`secret`\|`manual`, `prompt`, `region?`, `target?`(secret·otp 입력 대상), `inputSpec?`(RE2), `ttlMs` | 사람 입력. `secret`은 타이피스트 경유 | 아니오 |
| `human_commit` | `prompt`, `verify`, `followUpOf?` | 사람이 직접 누르는 비가역(운영 수준 `assisted`). 토큰 소비 → `armed` → 사람 → 증언 → `verify`. 증언은 verify를 대신하지 못함 | **예** |
| `secret_fill` | `target`(`secretSlot` 필수), `secret`: `cert_password`\|`portal_password`\|`security_card`, `rowFrom?` | **금고가 직접 입력**. 보안카드는 `rowFrom`(화면에서 읽은 칸 번호 변수, 비밀 아님) | 아니오 |
| `sign` | `method`, `then[]` | 로그인 등 **커밋 구간 밖** 포털 서명 흐름 래퍼(모듈 위임). 내부 동작도 Actuator를 거침. 발급 시 전자서명은 `submit.signFlow`로 쓴다 | 아니오 |
| `submit` | `target`(`commits:true`), `intent: "$intent.id"`, `verify`(stepRef), `expectConfirm?`(V-24), `signFlow?`(§4.5) | 비가역 제출. `retry: 0` 고정, `onFail.then ∈ {handoff, abort}` | **예** |
| `verify` | `lookup`: `{playbook, match{fieldKey: $ref}, window, baseline, notCommittedPolicy, bind?}`, `on`{`committed`\|`not_committed`\|`unknown` → stepRef\|handoff\|abort} | **포털 조회 하위 흐름**으로 제출 여부를 결정적으로 비교(§4.4). 새 탭에서 실행. 커밋된 스텝의 포털 측 부수효과(예: 자동 이메일 발송) 확인에도 쓴다 | 아니오 |
| `capture` | `name`, `from` | 결과 화면 값 캡처(보조 대조용). 승인번호의 원천은 `verify.bind`다(B-08) | 아니오 |
| `save_pdf` | `strategy`, `docType`, `nameTemplate?`(V-23) | 저장 → 보관함. 생략 시 엔진 기본 `{docType}_{yyyyMMdd}_{shortId}.pdf`. 다운로드·인쇄 저장 폴더는 금고가 staging으로 고정하고 엔진의 `Browser.setDownloadBehavior`·`Page.setDownloadBehavior`는 거부된다(A-13) | 아니오 |
| `send_email` | `via`, `to`(`$inputs.*`만), `attach`(`$artifacts.*`만), `followUpOf`(stepRef), `verify` | 후속 비가역. 선행 커밋이 같은 실행에서 `committed`가 되는 순간 발급된 후속 토큰 사용. `via:"portal"`은 포털의 **재발송**이다(홈택스는 발급 시 자동 발송, B-11). W 규칙은 V-03c′ | **예** |
| `branch` | `on`, `cases`{value→stepRef}, `default` | 정적 분기 | 아니오 |
| `repeat` | `max`(≤ 20), `until`, `steps[]` | 유한 반복. `max` 소진은 실패(`onFail`) | 아니오 |
| `handoff` | `reason`, `resumeAt`(stepRef, 필수) | 사람에게 화면 넘김. 이 동안 가드는 커밋 요청을 **관측만** 한다(R-C2) | 아니오 |
| `end` | `status`: `success`\|`completed_with_issues`\|`failed` | 종료 | 아니오 |

`batch_gate`(묶음 발급, 건별 토큰)는 Phase 3에서 별도 타입으로 설계한다. `repeat` 안의 비가역은 금지(V-03e).

### 4.1 조건식

열거형 객체만: `{exists}`, `{textMatches:{target, patternRef}}`, `{varEquals}`, `{varSet}`, `{inputPresent}`, `{sumEquals}`, `{readbackEquals:{fieldKey, ref}}`, `{fieldsFilled:{fields[]}}`, `{all}`, `{any}`, `{not}`, 그리고 전제·사후조건 전용 `{inputVerified}`, `{profileHas}`, `{artifact}`. `patternRef`는 strings 파일의 정규식 키이고 RE2로 컴파일되어야 한다(V-01, B-35). 임의 스크립트 없음.
- `readbackEquals`(B-05): readback 값과 `$profile.*`·`$inputs.*` 참조를 정규화해 비교한다. 대표 용도는 `supplierBizNo == $profile.bizNo`로, 잘못된 사업자 세션으로 발급하는 것과 대리 사용(B-28)을 함께 막는다.
- `fieldsFilled`(B-34): 나열한 `fieldKey` 칸이 비어 있지 않은지 엔진이 결정적으로 검사한다(값·길이는 기록하지 않음). 모델 predicate `required_fields_filled`를 대체한다.

### 4.2 값 참조

`$inputs.X`(선언된 입력만), `$vars.X`(지배하는 `extract`/`capture`/`verify.bind`가 있어야 함), `$human.sN`(sN이 `human`이고 사용 지점을 지배), `$profile.X`(비밀 없음), `$readback.F`(지배하는 `readback`이 `F`를 포함, 실제 화면 값, B-07), `$intent.id`, `$artifacts.X`. 상수는 `fill.value`·`select.option`에서 타깃의 `allowedConstants`에 있는 값만 쓸 수 있다(V-21). 비밀 칸에서 파생된 `$vars`는 정의할 수 없다(V-20).

### 4.3 제어 흐름 의미론 (정적 분석기의 간선 정의)

1. **폴스루**: 같은 `steps` 배열의 다음 원소. `repeat` 본문 마지막 → `repeat` 헤더. 헤더는 `until` 참이면 다음 원소, `max` 소진이면 **실패**로 `onFail`.
2. **비가역 스텝의 다음은 항상 `verify`**(`submit.verify`, `human_commit.verify`, `send_email.verify`). 폴스루 없음. `submit.signFlow`는 X 내부 동작이라 CFG에서 X와 한 노드다(B-09).
3. **의사 동작**: `handoff` → 합성 노드 H, 재개 간선은 `resumeAt`으로 반드시 명시. `recover` → 그 스텝을 지배하는 모든 체크포인트로 가는 간선(복구 성공 시 **실패한 그 스텝**을 재실행하는 간선 포함). `checkpoint:n` → 이름 n인 단일 스텝. `abort` → 종료 노드. `human:secret` → 같은 위치의 **금고 경유 합성 노드**(금고가 비밀 창 (b)를 열고 엔진은 `secret_window.closed{ok}`만 받는다, D05 §3.5) → 원래 다음 스텝.
4. **엔진 암묵 전이**(세션 만료 → `session` 체크포인트, 팝업 처리 → 같은 스텝 재시도, 이중로그인 → 일시정지)도 합성 간선으로 CFG에 넣는다. 다음 둘을 추가한다.
   - **verify 기준선 조회**(B-07): `baseline: pre_gate_snapshot`인 verify를 가진 X에 대해, 엔진은 `G(X)` 진입 직전에 같은 조회 하위 플레이북을 새 탭에서 실행한다. CFG에서는 G 바로 앞의 합성 노드다(부수효과 없음).
   - **핸드오프 중 수동 커밋 관측**(R-C2): H에서 재개할 때 원장이 `in_doubt`이면 `resumeAt` 대신 그 X의 `verify`로 가는 합성 간선이 있다. V-03 분석은 이 간선을 포함한다.
5. `repeat` 경계를 넘는 점프 금지.
6. 도달성: 모든 노드에서 `end` 또는 `abort`에 도달 가능. `repeat` 밖의 모든 순환은 참여 스텝에 `loopGuard.max`가 있어야 한다(V-18).

### 4.4 `verify`의 의미와 조회 하위 플레이북 (B-07, B-08)

- **기준선**: 게이트 직전에 같은 하위 플레이북으로 `match`에 맞는 행의 승인번호 집합 B₀를 찍어 둔다. 기준선 조회가 실패하면 게이트를 열지 않고 `verify.baseline_missing`으로 핸드오프한다(아직 커밋 전이므로 안전).
- **판정**: 제출 뒤 매칭 집합 B₁에서 `B₁ \ B₀`가 **정확히 1건**이면 `committed`이고, 그 승인번호를 `bind`로 변수에 묶는다. `B₁ \ B₀`가 0건이면서 `notCommittedPolicy.minElapsedMs`가 지났고 `lookups`회 연속 0건이며 제출 화면에 **명시적 실패 신호**(오류 대화상자 텍스트, 서명 거절 화면 — 신호 목록은 S1에서 확정)가 있을 때만 `not_committed`다. 2건 이상이거나 그 밖의 경우는 모두 `unknown`이다.
- `match`는 참조만 받는다(상수 금지). 비가역 스텝의 확인에는 `$readback.*`(실제 제출 값)을 쓴다(V-04).
- `baseline: none`은 `match`가 앞선 verify의 `bind`로 묶인 `$vars` 값(게이트 전에 존재하지 않던 고유 값, 예: 새 승인번호)을 키로 쓸 때만 허용한다.
- 정책 기본값: `policy.verify.minElapsedMs = 60000`, `policy.verify.lookups = 2`. 플레이북 값은 이보다 엄격한 쪽만 쓴다. 실제 반영 지연 분포는 확인 필요(S1).
- `policy.verify`에 `maxMs`(앱 하한 300초)를 더한다. 하한을 넘긴 뒤에도 `maxMs`까지 지수 간격으로 조회하고 상한에서만 `unknown`이다(D03 §5.6). 실패 신호 목록의 자료형은 (css, `^…$` 문구) 쌍이며 문구 없는 항목은 정적 검증에서 거부한다(V-03j″). 클릭 뒤 새로 보이고 문구까지 맞는 요소만 `not_committed` 근거다(ADR-025·027, D-05(N-02), D-18(N-22)).
- **조회 하위 플레이북**(`kind: lookup`)은 `manifest.lookupsUsed`로 버전·다이제스트가 고정되고 스텝 집합이 제한된다(V-22). 실행은 **새 탭**에서 하고 끝나면 닫는다. 원래 탭의 결과 화면은 건드리지 않는다(D03 §5.6).

### 4.5 발급 시 전자서명: `submit.signFlow` (B-09)

```json
"signFlow": {"method": "$profile.signMethod",
             "steps": {"cert": ["human:secret"], "simple_auth": ["wait:push"], "security_card": ["secret_fill:security_card"]},
             "rowLabel": "hometax.invoice.sign.cardRowLabel",
             "confirmTarget": "hometax.invoice.sign.confirmButton", "maxWaitMs": 120000}
```

- `signFlow`는 비가역 스텝 X의 일부다. 그 안의 사람 입력·금고 타이핑·간편인증 PUSH 대기는 **무장된 커밋 구간 안에서만** 허용되고, 다른 경로로는 W 안에 들어올 수 없다(V-03c).
- `steps`는 서명 방식별 동작이다. 보안카드는 `rowLabel`(칸 번호 표시 요소, 비밀 아님)을 엔진이 읽어 금고에 넘긴다.
- `human:secret` 단계에서 입력 잠금(R-G6)은 서명 대화상자(비밀 창 대상)만 풀고 폼의 나머지는 잠근 채로 둔다. 커밋 요청 본문 대조(R-C1)는 금고가 하므로 서명 대화상자가 비밀 창을 열어 폼 프레임이 오염되어도 대조할 수 있다(본문이 `opaque`면 불가, D03 §5.3·§5.4, E-02).
- `confirmTarget`은 `commits:true`이고 `submit.target`과 같은 `commitEffect`여야 한다(V-02). L1·L2는 금지한다. `maxWaitMs`를 넘기거나 실패하면 곧바로 `verify`로 간다.
- 검증기는 `policy.run.commitWindowMs ≥ signFlow.maxWaitMs + verify 상한`을 확인한다(D03 §3).
- 간편인증이면 카드에 앱 고정 문구 "홈택스 앱에 '전자세금계산서 발급' 서명 요청이 갑니다. 다른 요청이면 거절하세요"를 표시한다.
- **실제 순서(클릭 → confirm → 서명 → 서버 요청)와 서명 거절 시 화면 신호는 확인 필요(S1).** S1 결과가 이 모델과 다르면 스키마를 고친 뒤 M1-4에 들어간다.

## 5. 실패 정책

```json
"onFail": {"retry": 2, "then": "recover" | "checkpoint:<name>" | "handoff" | "abort" | "human:secret"}
```
- `retry`는 첫 시도를 뺀 **재시도 횟수**다(`retry: 2`면 최대 3번 실행). 엔진은 `min(retry, policy.retries.stepMax)`번까지만 다시 시도한다(D03 §7).
- 재시도 지연은 IR에 없다. **정책(`policy.retries`)이 소유**한다(Equal Jitter, 하한 = `stepDelayMs` 하한).
- 비가역 스텝과 커밋 구간 안 스텝: `retry: 0`, `then ∈ {handoff, abort}`(V-03f). 커밋 셀렉터 실패 시 할 수 있는 일은 `verify` → handoff뿐이다.
- `recover`는 D03 §6의 복구 계층(L1 `recovery_v1` 판정 → L2 수리 → 핸드오프)을 탄다. L2 상한은 실행당 `policy.run.l2MaxAttempts`(기본 1) 하나뿐이다. L2 제안의 **자동 적용은 `fill`·`select`·`wait`·`extract` 타깃에만** 하고, `click`·`press` 타깃의 제안은 사용자 확인 없이 적용하지 않는다(B-16, D03 §6).

## 6. 검증 규칙

### 6.1 정적 검증 규칙 (로드 시 전부 통과해야 함)

| 규칙 | 내용 |
|---|---|
| V-01 | JSON Schema 적합(`unevaluatedProperties: false`, 미정의 필드 거부). IR·strings·selectors에서 온 모든 정규식(`patternRef`, `namePattern`, `expectConfirm`, `inputSpec.pattern`, `pathPattern`)은 RE2로 컴파일되어야 하고, 안 되면 로드 거부(B-35) |
| V-02 | 모든 `target`이 `selectors.json`에 존재하고 속성 요구를 만족: `secret_fill`→`secretKind`가 있고 `secret_fill.secret == entry.secretKind`, `secretPurpose`는 그 흐름(로그인 구간·signFlow) 안에서만(ADR-026, D-30(N-46)), `submit`→`commits:true`, `signFlow.confirmTarget`→`commits:true`이며 `submit.target`과 같은 `commitEffect`, `signFlow.rowLabel`→비밀 칸 아님(B-09) |
| **V-03a** | 비가역 스텝 X(= `submit`, `human_commit`, `send_email`, `commits:true` 타깃의 `click`·`press`·`select`, V-03k로 비가역 간주된 `press`)마다 `authorizes`에 X를 담은 게이트 `G(X)`가 **정확히 하나** |
| **V-03b** | 진입점에서 X로 가는 모든 경로(§4.3 간선 전부)는 `G(X)`를 지난다(지배) |
| **V-03c** | 커밋 구간 `W(X)`(G(X)→X 경로 위 노드) \ {G, X}의 스텝 타입은 `{wait, assert, extract(readback:true)}`만. `decide`, `goto, fill, select, press, click, human, handoff, secret_fill, sign, repeat, branch, checkpoint, save_pdf, capture, send_email, submit` 금지(B/C-03: 모델은 커밋 구간에 개입하지 않는다). 사람 입력·타이핑·PUSH 대기가 W 안에 들어오는 유일한 경로는 X의 `submit.signFlow`다(B-09) |
| **V-03c′** | 후속 비가역 Y(`followUpOf: Xc`)에 대해 `W(Y) \ {G, Xc, Y}`에는 `{verify(Xc의 것), capture, save_pdf, wait, assert, extract(readback:true), branch(조건이 inputPresent·varSet뿐)}`만 허용한다. `fill`·`select`·`click`·`press`·`goto`·`human`·`handoff`·`secret_fill`·`sign`·`checkpoint`·`decide`는 금지. Y 직전에 Y의 대상(수신자 칸 등)을 되읽는 `readback`이 있어야 하고, 엔진은 실행 시 그 값이 `G.card`의 해당 필드와 같은지 확인한다(B-11, B/C-04) |
| **V-03d** | `W(X) \ {G}`로 들어오는 모든 간선(의사 동작·`onFail`·`resumeAt`·암묵 전이 포함)의 출발점은 `W(X)` 안이다(단일 진입) |
| **V-03e** | X는 `repeat` 본문 안에 있을 수 없다 |
| **V-03f** | X와 `W(X)` 안 스텝의 `onFail` = `{retry:0, then∈{handoff,abort}}`. `verify.not_committed`에서 X로 돌아오는 모든 경로는 `G(X)`를 다시 지난다 |
| **V-03g** | `click`/`press`/`select` 타깃이 `commits:true`인데 게이트 허가가 없으면 오류. 타깃이 `commits`가 아닌데 `submit` 타입이면 오류 |
| **V-03h** | `G(X).card`의 필드 집합 ⊇ 앱 내장 카드 필수 필드(공급자 = 내 사업자 포함) ∪ X의 모든 파라미터(`to`, `attach`, 제출 폼의 `readback` 필드) ∪ `intent.id`. `G` 앞에 `readback` 스텝 R이 있고 R→G 사이에는 `assert`만 있다. 카드는 엔진이 `fieldKey → 앱 내장 라벨` 사전으로 렌더링하며, 패키지 문자열은 카드 제목과 보조 설명만 바꿀 수 있다. 라벨·값·순서·고정 경고(중복 경고, InDoubt, 공급자 표시, 직전 시도 경고)는 바꿀 수 없다. 폰도 같은 라벨 사전을 앱에 내장한다(B-24, B-05). 사전에는 엔진이 만드는 예약 키 `$first.bizNo`·`$first.email`(처음 거래·처음 보내는 주소)과 `$dup.businessKey`·`$dup.priorNotCommitted`·`$dup.otherDevice`(중복 경고)가 있고, PC에서는 이 값들을 main 승인 바가 보인다(ADR-021) |
| **V-03i** | `gate.authorizes`는 주 비가역 **정확히 1개**와 `followUpOf`가 그 주 비가역인 스텝 0개 이상(스키마 `maxItems: 3`)으로만 구성된다(B-12) |
| **V-03j** | 비가역 스텝 X의 타깃 `landmark` 서브트리 안에서 사전에 `fieldKey`(`_ignore` 제외)를 가진 **모든** 입력 항목은 X 앞 `readback.fields`에 포함되어야 한다(B-05) |
| **V-03j′** | readback에 날짜형 fieldKey(`issueDate` 등)가 있으면 입력값 대조 assert(`readbackEquals{fieldKey, ref:'$inputs.…'}`)가 게이트 앞에 필수다(ADR-027, D-20(N-26)) |
| **V-03j″** | `verify`의 실패 신호 목록 항목은 (css, `^…$` 문구) 쌍이다. 문구가 없거나 앵커가 없는 항목은 거부한다(ADR-025, D-05(N-02)) |
| **V-03k** | `press.key=Enter`는 `target`이 필수다(스키마). 그 타깃의 `landmark` 안에 `commits:true` 항목이 하나라도 있으면 그 `press`는 비가역 스텝으로 간주한다. `select`의 타깃이 `commits:true`이면 비가역 스텝이다(B-02) |
| **V-03l** | 어떤 게이트 G를 지배하면서 G로 가는 경로 위에 있고 복귀 지점(`not_committed`·`recover`·Paused/HandedOff 재개의 목적지)이 될 수 있는 체크포인트는 `url`이 필수이고 `reentry: "reload"`여야 한다(B-13) |
| V-04 | 모든 비가역 스텝은 `intent: "$intent.id"`와 `verify`를 가진다. 그 `verify.lookup.match`는 X 앞 `readback` 필드를 `$readback.*`로 포함하고 `baseline: pre_gate_snapshot`이다(B-07) |
| V-05 | `repeat.max ≤ 20`, 중첩 ≤ 2 |
| V-06 | `goto.url`을 WHATWG URL로 파싱: `https:`, userinfo 없음, 포트 없음, `hostname ∈ manifest.domains` |
| V-07 | `decide.on` 키 집합 = 번들 결과 − `reservedOutcomes`(엔진 처리: `blocked`, `logged_out_by_other_session`) 이고 `unknown` 포함. V-07b: `unknown`의 목적지는 `handoff`/`abort`, 또는 비가역 스텝을 거치지 않고 같은 `decide`로 돌아오는 대기 루프(`loopGuard` 필수) |
| V-08 | `secret_fill`은 `value` 없음, `secret` 열거값, 보안카드는 `rowFrom` 필수. `signFlow.steps`에 `secret_fill:security_card`가 있으면 `rowLabel` 필수 |
| V-09 | `pace`는 `normal`/`slow`뿐(없음 선택 불가) |
| V-10 | `human.kind=captcha`는 `region` 필수. 이어지는 `fill`의 값은 `$human.sN`만. `kind=secret\|otp`는 `target` 필수 |
| V-11 | 도달성(§4.3-6) |
| V-12 | `profileKinds`와 입력·비밀 종류 일치 |
| V-13 | 상수에 사용자 데이터 형식 리터럴 금지(NFKC 정규화·유사 문자 치환 뒤 검사). V-21의 보조 규칙이다 |
| V-14 | `manifest.effects` ⊇ 플레이북이 실제로 포함하는 비가역 효과(커밋 타깃의 `commitEffect`, `send_email`=`send`, 포털이 커밋에 딸려 수행하는 효과는 작성자가 선언). 데몬 효과 제한은 IR `pacing`이 아니라 런타임 R-D1이 집행한다(B-27) |
| V-15 | 모든 `$inputs.X` 선언됨, `$vars.X`·`$human.sN`·`$readback.F` 지배 관계 성립, 선택 입력을 쓰는 비가역 스텝 앞에 `branch{inputPresent}` 존재, 선택 입력을 참조하는 `fill`은 `ifAbsent`를 지정하거나 `branch{inputPresent}`가 지배 |
| V-16 | `send_email.to`·`attach`는 참조만(상수 금지) |
| V-17 | 체크포인트 이름 전역 유일, `checkpoint:` 참조가 실재 |
| V-18 | `repeat` 밖 순환의 참여 스텝에 `loopGuard.max ≤ 5` |
| V-19 | 스텝 `id` 전역 유일(중첩 `repeat` 포함) |
| **V-20** | **비밀 칸 읽기 금지**(A-05, B-26). `secretSlot:true` 또는 `inputType:"password"` 항목은 `secret_fill`·`human(kind=secret)`의 `target` 외 어떤 스텝의 `target`·`from`·`scope`·`cond`(모든 조건식의 `target`)·`readback.fields`에도 쓸 수 없다. 해당 항목은 `readbackOf`·`fieldKey`를 가질 수 없고(스키마), 다른 항목의 `readbackOf`가 그 칸을 가리킬 수 없다. `decide.scope` 서브트리가 그 항목의 `landmark`를 포함하면 오류다. 그 칸에서 파생된 `$vars`는 정의할 수 없다. **런타임 가드**: 엔진의 DOM 읽기 함수(Actuator·readback·스냅샷 공통)는 `secretSlot` 또는 `type=password` 요소의 `value`를 읽지 않는다(위생 장치, D05 §1). guide 변환은 `secret_fill`·`human:secret`을 복사 버튼으로 만들지 않는다(변환 후 재검증에서 오류). 회귀: CE-7, CE-8 |
| **V-21** | **상수 허용 목록**(B-25). `fill.value`·`select.option`의 상수는 타깃 사전 항목의 `allowedConstants[]`에 있는 값만 허용한다. 그 외는 `$inputs`·`$vars`·`$human`·`$profile`·`$readback` 참조만. `verify.lookup.match`는 참조만(스키마) |
| **V-22** | **조회 하위 플레이북 신뢰 경계**(B-08). `verify.lookup.playbook`은 `manifest.lookupsUsed`에 있어야 하고, 그 패키지는 `kind: lookup`, `effects: []`이며, 스텝 타입은 `{goto, wait, assert, extract, select, fill(사전 role이 searchbox·combobox인 검색 조건 칸만), click(사전 navigationOnly:true 항목만), end}`만 쓴다. `decide`·`onFail: recover`·`human`·`secret_fill`·`sign`·`submit`·`send_email`·`human_commit`은 금지하고, `commits:true` 타깃을 참조할 수 없다. 조회 패키지 안의 실패는 모두 `unknown`이다 |
| **V-23** | **`nameTemplate` 토큰 제한**(B-25, A/C-07, B/C-09). `save_pdf.nameTemplate`은 `{docType}`·`{yyyy}`·`{MM}`·`{dd}`·`{yyyyMMdd}`·`{shortId}`와 `[A-Za-z0-9_/-]`만 쓸 수 있다(D07 §4 원칙: 파일명에 PII 없음). 생략하면 엔진 기본 템플릿을 쓴다. 엔진은 최종 경로를 정규화한 뒤 보관함 루트의 하위인지 확인하고, 기존 파일을 덮어쓰지 않는다. 사람이 읽는 이름은 '내보내기' 때 앱이 DB 표시 이름으로 만든다 |
| **V-24** | **`expectConfirm` 앵커**(B-24). `expectConfirm`이 가리키는 정규식은 `^…$` 앵커가 필수이고, 빈 문자열이나 `.*`·`.+`에 맞으면 거부한다. 수락한 confirm 텍스트의 해시를 저널 `commit.confirm_accepted`에 남긴다 |

### 6.2 반례 회귀 세트

CE-1~CE-6(REVIEW-A §1)에 감사 반례를 더한 CE-1~CE-18이 검증기 퍼징의 고정 회귀 세트이며, 모두 거부되어야 한다. 번호의 정본은 D13 §7이고 이 표와 같다.

| ID | 반례 | 거부 규칙 |
|---|---|---|
| CE-7 | 비밀 칸을 `extract`해 다른 칸에 `fill`(A-05, B-26) | V-20 |
| CE-8 | 비밀 칸 랜드마크를 포함하는 `decide.scope`(A-05) | V-20 |
| CE-9 | 타깃 없는 `press Enter`로 폼 암묵 제출(REVIEW-A CE-3의 s2 형태, B-02) | 스키마, V-03k |
| CE-10 | 게이트 하나가 독립 `submit` 둘을 `authorizes`(B-12) | V-03i |
| CE-11 | 커밋 랜드마크 `fieldKey` 누락 readback(B-05) | V-03j |
| CE-12 | `nameTemplate`에 허용 밖 토큰(B-25) | V-23 |
| CE-13 | `expectConfirm: ".*"`(B-24) | V-24 |
| CE-14 | 조회 하위 플레이북의 `decide`(B-08) | V-22 |
| CE-15 | 핫픽스의 `commits:true` 항목·랜드마크 항목 변경(B-01) | 핫픽스 CI(SV-01·적격 조건)·R-A1·R-A2 |
| CE-16 | 정책 `gov24: auto`(B-23) | 내장 상한 `PORTAL_MODE_CEILING` |
| CE-17 | 커밋 구간 안 `decide`(B/C-03) | V-03c |
| CE-18 | 후속 비가역 앞에 `fill`이 낀 H-01 변형(B-11) | V-03c′ |

핫픽스 반례(비커밋 항목의 후보를 발급 버튼으로 바꾸는 것, B-01)는 핫픽스 CI의 SV-01과 D13 §7 CE-15(런타임 R-A1·R-A2 회귀)로 고정한다.

### 6.3 셀렉터 CI 규칙 (패키지·핫픽스 CI 공통)

스키마로 표현할 수 없는 사전 성질이다. SV-01~06은 **레지스트리 CI에서만** 돌고(녹화 DOM·HAR 필요), 2-of-3 서명이 그 통과를 전제로 한다. 클라이언트는 SV를 다시 돌리지 않고 런타임에 R-A1·R-A2·`DENY_ACTION_NAME` 검사를 매번 한다(정본 D03 §3.1-6, E-03).

| 규칙 | 내용 |
|---|---|
| SV-01 | 녹화 DOM에서 모든 `commits:false` 항목의 해석 결과가 어느 `commits:true` 항목의 해석 결과와도 같은 요소가 아니어야 한다(충돌 검사). 핫픽스 CI에도 적용한다(B-01) |
| SV-02 | 녹화 HAR에서 클릭 직후 `commitEndpoints`에 맞는 요청을 만든 요소는 반드시 `commits:true`다. 접근성 이름이 `/발급\|제출\|신청\|전송\|서명\|승인\|저장\|등록\|삭제\|취소\|확인\|계속\|다음/`에 맞는 `button`·`link`·`menuitem`이 `commits:false`이면 `reviewNote`(검토자 서명 포함)가 필수다(B-02) |
| SV-03 | 녹화 DOM에서 `commits:true` 항목의 랜드마크 안 모든 `textbox`·`combobox`·`checkbox`·`radio`·`spinbutton`에는 `fieldKey`가 있어야 한다(장식·검색 전용은 `"_ignore"` + `reviewNote`)(B-05) |
| SV-04 | `namePattern`은 `^…$` 앵커가 필수이고(스키마), 녹화 DOM의 같은 랜드마크 안에서 정확히 1개 요소에만 맞아야 한다(B-17) |
| SV-05 | `closeAffordance:true` 항목의 녹화 이름이 `DENY_ACTION_NAME`(NFKC·제로폭 제거·공백 제거 뒤)에 맞으면 거부한다(B-32) |
| SV-06 | `commitEndpoints` 합집합이 비어 있는 포털은 `auto`·`assisted`에서 실행하지 않는다(B-03) |

번들 정의 검증 BV-01~06은 D03 §3.2와 [schemas/bundle.schema.json](schemas/bundle.schema.json)에 있다.

## 7. 의도 키와 중복 판정

- **`intentId`**(ULID)는 `prepare()`가 만들고 카드에 표시한다. 리모트 명령은 폰이 만든 `cmd_id`를 그대로 쓴다.
- 아이덴포턴시 원장(D07 `irreversible_log`)의 키는 **`(intent_id, step_id)`**이고 행은 `inputs_hash`·`package_digest`·`action_hash`에 결속된다. 같은 `intentId`로 들어온 새 실행의 `inputs_hash`나 `playbook_id`가 다르면 거부한다(`ledger.intent_reuse`). 사후 스텝 점프는 **같은 `run_id`의 재개**에만 적용한다(D03 §4, B-10).
- **업무 중복 키** = JCS(RFC 8785)로 정규화한 `(profile.bizNo, counterpart.bizNo, supply, tax, issueDate, items[].name)`의 해시. 원장에 같은 키의 `armed|dispatched|in_doubt|committed|not_committed|observed_manual`이 있으면 **차단하지 않고 경고**를 띄워 명시 확인을 받는다(정당한 동일 거래 2건을 막지 않기 위해). 경고는 예약 `fieldKey` `$dup.*`로 게이트 `fields`에 넣어 `cardHash`에 묶고, PC에서는 main 승인 바의 "같은 건 기록을 확인했고 발급" 클릭이 명시 확인이다(ADR-021). 렌더러 카드에만 두면 침해된 렌더러가 지울 수 있기 때문이다. `not_committed`가 있으면 앱 고정 문구 "직전 시도는 '발급 안 됨'으로 판정되었습니다(조회 N회, M초 경과). 홈택스 발급목록을 직접 확인한 뒤 승인하세요"를 넣는다(B-07, B-04).
- 보조 중복 키 `$dup.recentSameAmount`: 작성일자를 뺀 (공급자, 공급받는자, 공급가, 세액, 품목명[])이 최근 10일 안에 committed면 바 꼬리 'N일 전 같은 금액 발급 있음'(차단 아님)(Phase 1, ADR-027, D-32(N-50)). 원장 상태별 바 표시(`committed` → "이미 발급됨(승인번호 있음)", `in_doubt`·`armed`·`dispatched`·`observed_manual` → "발급 여부 확인 안 됨", 둘 다 주의 색)는 ADR-027 결정 3이 정본이다(D-18(N-22)).
- **기기 간 업무 키 표시는 필수**다(B-30). `committed`·`in_doubt`·`observed_manual`로 전이할 때 `HMAC(K_idx, businessKey)`와 상태·시각을 메타데이터 서버에 올리고, 게이트 직전에 조회해 다른 기기의 기록이 있으면 경고한다(차단 아님, `$dup.otherDevice`로 승인 바에도 보인다). 오프라인이면 "다른 PC 기록 확인 불가"를 표시한다(D03 §4, 서버 테이블은 D09).
- 선택안: 사용자 동의 시 비고란에 짧은 의도 코드(`AX-7K3P`)를 적어 조회 정확도를 높인다. 비고 칸은 readback 대상이므로 카드에 보인다.

## 8. 예시: H-01 전자세금계산서 건별발급 v2.1 (발췌)

```json
{
  "ir": 2, "id": "hometax.invoice.issue", "version": "2.1.0", "portal": "hometax",
  "profileKinds": ["business"], "effects": ["issue_document", "send"],
  "inputs": {"counterpart": {"type": "counterparty", "required": true}, "amounts": {"type": "amounts", "required": true},
             "items": {"type": "line_items", "required": true}, "issueDate": {"type": "date", "default": "today"},
             "email": {"type": "email", "required": false}},
  "preconditions": [{"profileHas": "signMethod"}, {"inputVerified": "counterpart"}],
  "steps": [
    {"id": "s0", "type": "checkpoint", "name": "session", "expect": {"exists": "hometax.nav.home"}, "url": "https://hometax.go.kr/", "sessionRequired": true, "reentry": "reload"},
    {"id": "s1", "type": "goto", "url": "https://hometax.go.kr/"},
    {"id": "s2", "type": "decide", "bundle": "screen_state_v2", "scope": "root", "loopGuard": {"max": 3},
     "on": {"logged_in": "s10", "login_required": "s3", "captcha": "s90", "mfa_pending": "s5", "error": "handoff", "unknown": "handoff"}},
    {"id": "s3", "type": "click", "target": "hometax.login.simpleAuthButton"},
    {"id": "s4", "type": "sign", "method": "$profile.signMethod", "then": ["human:secret"]},
    {"id": "s5", "type": "wait", "for": "text", "value": "hometax.login.successMarker", "timeoutMs": 120000, "pace": "slow"},
    {"id": "s6", "type": "decide", "bundle": "screen_state_v2", "scope": "root", "loopGuard": {"max": 3},
     "on": {"logged_in": "s10", "login_required": "handoff", "captcha": "s90", "mfa_pending": "s5", "error": "handoff", "unknown": "handoff"}},
    {"id": "s10", "type": "goto", "url": "https://hometax.go.kr/invoice/issue"},
    {"id": "s11", "type": "checkpoint", "name": "form", "expect": {"exists": "hometax.invoice.form.root"}, "url": "https://hometax.go.kr/invoice/issue", "sessionRequired": true, "reentry": "reload"},
    {"id": "s12", "type": "fill", "target": "hometax.invoice.form.counterpartBizNo", "value": "$inputs.counterpart.bizNo"},
    {"id": "s13", "type": "click", "target": "hometax.invoice.form.lookupCounterpart"},
    {"id": "s14", "type": "assert", "cond": {"textMatches": {"target": "hometax.invoice.form.counterpartName", "patternRef": "counterpart.nameRegex"}}},
    {"id": "s15", "type": "fill", "target": "hometax.invoice.form.counterpartEmail", "value": "$inputs.email", "ifAbsent": "clear"},
    {"id": "s16", "type": "fill", "target": "hometax.invoice.form.item1.name", "value": "$inputs.items[0].name"},
    {"id": "s17", "type": "fill", "target": "hometax.invoice.form.item1.supply", "value": "$inputs.amounts.supply"},
    {"id": "s18", "type": "fill", "target": "hometax.invoice.form.item1.tax", "value": "$inputs.amounts.tax"},
    {"id": "s19", "type": "decide", "bundle": "form_ready_v2", "scope": "hometax.invoice.form.root",
     "on": {"ready": "s19a", "validation_error": "handoff", "unknown": "handoff"}},
    {"id": "s19a", "type": "assert", "cond": {"fieldsFilled": {"fields": ["counterpartBizNo", "itemName", "supplyAmount", "taxAmount", "issueDate"]}}},
    {"id": "s19b", "type": "readback", "fields": ["supplierBizNo", "supplierName", "counterpartBizNo", "counterpartName", "counterpartEmail",
                                                  "itemName", "itemCount", "supplyAmount", "taxAmount", "totalAmount", "issueDate", "remark", "receiptType"]},
    {"id": "s19c", "type": "assert", "cond": {"readbackEquals": {"fieldKey": "supplierBizNo", "ref": "$profile.bizNo"}}, "onFail": {"retry": 0, "then": "abort"}},
    {"id": "s19e", "type": "assert", "cond": {"readbackEquals": {"fieldKey": "issueDate", "ref": "$inputs.issueDate"}}, "code": "assert.issue_date_mismatch", "onFail": {"retry": 0, "then": "abort"}},
    {"id": "s20", "type": "gate", "card": "invoice.confirm", "authorizes": ["s21"], "waitMs": 600000},
    {"id": "s21", "type": "submit", "target": "hometax.invoice.form.issueButton", "intent": "$intent.id", "verify": "s30", "expectConfirm": "confirm.issue",
     "signFlow": {"method": "$profile.signMethod", "steps": {"cert": ["human:secret"], "simple_auth": ["wait:push"]},
                  "confirmTarget": "hometax.invoice.sign.confirmButton", "maxWaitMs": 120000},
     "onFail": {"retry": 0, "then": "handoff"}},
    {"id": "s30", "type": "verify", "lookup": {"playbook": "hometax.invoice.lookup",
       "match": {"counterpartBizNo": "$readback.counterpartBizNo", "issueDate": "$readback.issueDate", "supplyAmount": "$readback.supplyAmount", "taxAmount": "$readback.taxAmount"},
       "window": "issueDate", "baseline": "pre_gate_snapshot", "notCommittedPolicy": {"minElapsedMs": 60000, "lookups": 2}, "bind": {"approvalNo": "approvalNo"}},
     "on": {"committed": "s32", "not_committed": "s11", "unknown": "handoff"}},
    {"id": "s32", "type": "save_pdf", "strategy": "print", "docType": "tax_invoice"},
    {"id": "s32b", "type": "branch", "on": {"inputPresent": "email"}, "cases": {"true": "s33"}, "default": "s34"},
    {"id": "s33", "type": "verify", "lookup": {"playbook": "hometax.invoice.email_status", "match": {"approvalNo": "$vars.approvalNo"},
       "window": "today", "baseline": "none", "notCommittedPolicy": {"minElapsedMs": 60000, "lookups": 2}},
     "on": {"committed": "s34", "not_committed": "s35", "unknown": "s35"}},
    {"id": "s34", "type": "end", "status": "success"},
    {"id": "s35", "type": "end", "status": "completed_with_issues", "label": "invoice.emailNotConfirmed"},
    {"id": "s90", "type": "human", "kind": "captcha", "region": "hometax.captcha.image", "prompt": "captcha.prompt", "ttlMs": 90000},
    {"id": "s91", "type": "fill", "target": "hometax.captcha.input", "value": "$human.s90"},
    {"id": "s92", "type": "click", "target": "hometax.captcha.submit"},
    {"id": "s93", "type": "decide", "bundle": "screen_state_v2", "scope": "root", "loopGuard": {"max": 2},
     "on": {"logged_in": "s10", "login_required": "s3", "captcha": "handoff", "mfa_pending": "s5", "error": "handoff", "unknown": "handoff"}}
  ],
  "postconditions": [{"varSet": "approvalNo"}, {"artifact": "pdf"}]
}
```

검증 근거(v1.3):
- 비가역 스텝은 `s21` 하나(`commits:true`, `commitEffect: issue_document`)이고 `G = s20`이 그것만 `authorizes`한다(V-03a, V-03i). `W(s21) = {s20, s21}`로 사이에 아무 스텝이 없다(V-03c). 발급 시 전자서명은 `s21.signFlow`로 X 안에 있다(§4.5, B-09).
- **이메일**(B-05, B-11, B/C-04, B/C-18): 홈택스는 발급과 동시에 매입자에게 이메일을 자동 발송하므로(R2:86) `send`는 `s21` 커밋에 딸린 효과다. v2.0의 별도 `send_email`(옛 s33)은 Phase 1에서 제거했다. 대신 이메일 칸을 `s15`에서 입력하거나 비우고(포털이 미리 채운 이전 주소 제거), readback·카드에 넣으며, 새 `s33`이 메일발송목록을 조회해 발송을 확인한다. 확인되지 않으면 `CompletedWithIssues`("발급은 완료되었습니다. 메일 발송은 홈택스 메일발송목록에서 확인해 주세요")로 끝나고 재실행을 막는다. 재발송 자동화는 Phase 2에서 "미발송·실패일 때만 재발송 + V-03c′"로 설계한다.
- readback `s19b`는 발급 버튼 랜드마크 안 `fieldKey` 전부(V-03j)다. 공급자·비고·청구/영수·품목 수가 카드에 보인다. `s19c`(`supplierBizNo == $profile.bizNo`)는 다른 사업자 세션으로 발급하는 것과 대리 사용을 막고, 실패하면 중단한다(B-05, B-28).
- `s19e`는 포털 작성일자를 실행 시작 시 KST 날짜(`$inputs.issueDate`)와 대조한다. 다르면 게이트 전에 `assert.issue_date_mismatch`로 멈춘다(V-03j′, ADR-027, D-20(N-26)).
- `s33` 메일 상태 판정은 부정 우선이다. NFKC·공백 제거 뒤 실패·미전송·대기·오류·…중이면 `not_committed`, 정확 허용 목록(`전송완료`·`발송완료`, PoC-3 실측으로 확정)이면 `committed`, 그 밖은 `unknown`이다(ADR-025, D-39(N-58)).
- `s19a`는 모델 predicate 대신 결정적 칸 채움 검사다(B-34). 차단·보안 경고는 `s19`(W 밖)와 엔진의 결정적 차단 신호(D03 §7)로 W 진입 전에 판정한다(B/C-03, C-24).
- `s30`은 게이트 직전 기준선 대비 새 건이 정확히 1건일 때만 `committed`이고, 승인번호는 `bind`로 얻는다(B-07, B-08). 결과 화면 `capture`는 쓰지 않는다. `s30.not_committed → s11`은 `reload` 체크포인트로 폼을 새로 읽고(V-03l) `s20`을 다시 지난다(V-03f). 재게이트 카드에는 직전 시도 경고가 붙는다(§7).
- `s0`·`s11`은 게이트를 지배하는 복귀 지점이라 `url` + `reload`다(V-03l). `blocked`·`logged_out_by_other_session`은 예약 결과라 `on`에 없다(V-07). PUSH 대기는 결정적 `wait`(s5)다. 로그인은 사업자 간편인증을 기본 경로로 두고(`s3`), 공동인증서 경로는 가상키패드 때문에 `sign.then`의 `human:secret`로 떨어진다(D05 §4).
- 카드 `invoice.confirm`은 제목 키일 뿐이고, 표시 필드는 앱이 readback 13개 + `intent.id` + 고정 경고로 렌더링한다(V-03h). `save_pdf`는 엔진 기본 파일명을 쓴다(V-23).

주의: URL·셀렉터·서명 흐름 순서·이메일 칸 위치와 자동 채움 여부·빈 이메일일 때 자동 발송 여부·발급목록 반영 지연은 **확인 필요(S1)**다. `hometax.invoice.lookup`·`hometax.invoice.email_status`는 `kind: lookup` 패키지로 `manifest.lookupsUsed`에 고정한다(V-22).

## 9. 운영 수준별 실행 변환

`portalMode`(D03 §12)에 따라 엔진이 IR을 변환하되, **변환 결과를 같은 검증기로 다시 검증**하고 실패하면 그 모드에서 실행하지 않는다. 운영 수준은 앱 내장 상한 `PORTAL_MODE_CEILING`을 넘을 수 없다(D03 §7.1, B-23).
- `postprocess`: 실행하지 않고 `guide` 변환본(체크리스트·복사 버튼·파일 감시)만. 복사 버튼은 30초 뒤 클립보드를 비운다(값이 그대로일 때만). `secret_fill`·`human:secret`은 복사 버튼으로 만들지 않는다(V-20, A-05). 포털 열기는 렌더러가 URL이 아니라 키만 넘기고 main이 내장 허용 목록으로 검사해 `shell.openExternal`을 호출한다(D03 §12, A-17).
- `assisted`: 로그인 구간(`checkpoint: session`까지)과 모든 비가역 스텝(`submit`·`send_email`, `signFlow` 포함)을 `human_commit`으로, `sign`을 `human(manual)`로 치환한다. 식별자형 입력(거래처 사업자번호·이메일·`$profile.bizNo`)을 채우는 `fill`은 `human(manual)` + 복사 보조로 바꾸고, 비식별 입력만 자동으로 채운다(D01의 보수적 정의를 정본으로, 법률·공문 회신에 따라 재검토, B/C-14). `human_commit`도 토큰 소비·`armed`·`verify` 규칙을 그대로 따른다.

## 10. 버전·호환

- `version` semver. major = 입력 스키마 변경. `ir` 버전이 다르면 엔진 호환 범위를 따른다.
- 셀렉터 핫픽스의 범위·결속·재검증은 §2.2를 따른다. 핫픽스 다이제스트는 게이트 토큰의 `packageDigest`에 포함된다.
- Paused 실행의 재개는 **같은 `package_digest`(IR + selectors + 핫픽스 + lookupsUsed)가 설치되어 있을 때만** 한다. minor·patch 갱신이라도 다르면 '다시 시작'만 제공한다(D03 §2, B-13).
