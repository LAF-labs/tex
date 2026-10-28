# D02. 플레이북 IR 스펙

## 1. 설계 결정 요약

- 플레이북은 **TypeScript 빌더로 작성 → JSON IR로 컴파일 → 서명 패키지로 배포 → 엔진이 해석**한다(ADR-002). 사용자 기기에서 임의 코드가 실행되지 않는다. 엔진이 아는 스텝 타입만 실행된다.
- IR은 JSON Schema([schemas/playbook-ir.schema.json](schemas/playbook-ir.schema.json))와 **정적 검증 규칙**(§6)을 모두 통과해야 로드된다.
- 비가역 스텝(`irreversible: true`)은 같은 실행 경로상 앞에 `gate`가 있어야 하고, 아이덴포턴시 키를 가져야 한다.
- 모델은 `decide`(Decisions API)와 `recover` 정책(Terra)에서만 개입한다. 플레이북은 모델에게 "다음 스텝을 정하라"고 할 수 없다. 선택지를 미리 열거해야 한다.

## 2. 패키지 구조

```text
<playbook-id>@<semver>.sxp   (zip)
├── manifest.json      # id, version, portal, title, profileKinds, engineRange, domains[], bundlesUsed[], createdAt
├── playbook.json      # IR 본문
├── selectors.json     # 셀렉터 사전 (stable_id → 후보 목록)
├── strings.ko.json    # 사용자에게 보이는 라벨
└── SIGNATURE          # Ed25519(manifest + playbook + selectors + strings) by registry key
```

- `domains[]`: 이 플레이북이 이동·요청을 허용하는 호스트 목록. 엔진은 Chrome 네비게이션을 감시해 목록 밖 이동을 차단한다.
- `engineRange`: 호환 엔진 버전 범위. 밖이면 로드 거부.
- `bundlesUsed[]`: 참조하는 Decisions 번들 ID·버전. 번들 카탈로그는 엔진 배포에 포함되며 플레이북이 질문을 임의 작성할 수 없다.

## 3. IR 최상위 구조

```json
{
  "ir": 1,
  "id": "hometax.invoice.issue",
  "version": "1.3.0",
  "portal": "hometax",
  "profileKinds": ["business"],
  "inputs": {
    "counterpart": {"type": "counterparty", "required": true},
    "amounts": {"type": "amounts", "required": true},
    "items": {"type": "line_items", "required": true, "minItems": 1},
    "issueDate": {"type": "date", "default": "today"},
    "email": {"type": "email", "required": false}
  },
  "preconditions": ["profile.hasSignMethod", "inputs.counterpart.verified"],
  "checkpoints": ["session", "form"],
  "steps": [ ... ],
  "postconditions": ["vars.approvalNo", "artifacts.pdf"],
  "recovery": {"default": {"retry": 2, "then": "recover", "handoffAfter": 1}},
  "pacing": {"profile": "interactive"}
}
```

입력 타입은 엔진 내장(`counterparty`, `amounts`, `line_items`, `date`, `email`, `enum`, `string`, `number`, `boolean`, `secret_ref`). 각 타입에 검증기와 확인 카드 렌더러가 있다. 임의 JSON은 허용하지 않는다.

## 4. 스텝 어휘

모든 스텝 공통 필드: `id`(플레이북 내 고유), `type`, `label`(사용자 표시), `pace`(`normal`|`slow`|`none`, 기본 `normal`), `timeoutMs`, `onFail`(§5), `checkpoint`(이 스텝이 체크포인트면 이름).

| 타입 | 필드 | 동작 | 비가역 가능 |
|---|---|---|---|
| `goto` | `url` | 허용 도메인 내 이동 후 로드 대기 | 아니오 |
| `click` | `target` | 셀렉터 후보 순서대로 탐색 후 클릭 | 기본 아니오. `irreversible: true` 가능(제출 버튼) |
| `fill` | `target`, `value`(입력 참조·상수·추출 변수), `keyEvents?: true` | 기본 `fill()`(즉시 입력, 타이핑 모사 없음). 보안 모듈이 키 이벤트를 요구하는 칸만 `keyEvents`로 사람 수준 간격 입력 | 아니오 |
| `select` | `target`, `option` | 드롭다운 선택 | 아니오 |
| `press` | `key` | 키 입력 | 아니오 |
| `wait` | `for`: `selector`\|`navigation`\|`text`\|`idle`, `value` | 조건 대기 | 아니오 |
| `assert` | `cond`(§4.1) | 거짓이면 실패 | 아니오 |
| `extract` | `name`, `from`: `selector`\|`regex`\|`a11y`, `pattern` | 변수 저장 | 아니오 |
| `decide` | `bundle`, `scope`(a11y 서브트리 루트 셀렉터), `on`: {outcome: action} | Decisions 번들 실행 후 결과별 분기 | 아니오 |
| `checkpoint` | `name` | 복귀 지점 등록(세션·URL·필수 요소 조건 포함) | 아니오 |
| `gate` | `card`(템플릿 ID), `fields[]`(카드에 보여줄 변수), `ttlMs` | 사용자 승인 대기. 로컬 또는 폰 | 아니오 |
| `human` | `kind`: `captcha`\|`otp`\|`secret`\|`manual`, `prompt`, `region`(캡차 영역 셀렉터), `ttlMs` | 사람 입력 요청. `secret`은 vault 타이피스트 경유 | 아니오 |
| `secret_fill` | `target`, `secret`: `cert_password`\|`security_card:{row}`\|`portal_password` | **vault가 CDP로 직접 입력**. 엔진은 완료 신호만 받음 | 아니오 |
| `sign` | `method`: `cert`\|`simple_auth`\|`security_card`, `then`: 후속 human/secret 허용 목록 | **포털 모듈에 위임**하는 래퍼. `cert`는 인증서 선택 + 비밀번호(타이피스트 또는 핸드오프), 개인키 복호화·서명은 하네스가 하지 않는다. `simple_auth`는 PUSH 승인 폴링 | 아니오(서명 자체는 포털 제출 스텝에서) |
| `submit` | `target`, `idempotencyKey`(변수식), `verify`(제출 후 확인 스텝 ID) | 비가역 제출. **항상 `irreversible: true`** | 예 |
| `capture` | `name`, `from` | 승인번호 등 결과 캡처 | 아니오 |
| `save_pdf` | `strategy`: `print`\|`download`\|`wallet`, `nameTemplate`, `docType` | 파일 저장 → 보관함 | 아니오 |
| `send_email` | `via`: `portal`\|`local`, `to`, `attach` | 이메일 전송 | 예 |
| `branch` | `on`(변수), `cases`{값: 스텝 ID 목록}, `default` | 정적 분기 | 아니오 |
| `repeat` | `max`, `until`(cond), `steps[]` | 유한 반복. `max` 필수(≤ 20) | 아니오 |
| `handoff` | `reason`, `resumeAt`(체크포인트) | 사람에게 화면 넘김, 재개 가능 | 아니오 |
| `end` | `status`: `success`\|`failed` | 종료 | 아니오 |

### 4.1 조건식

조건은 미니 표현식이 아니라 **열거형 객체**다: `{"exists": target}`, `{"textMatches": {target, pattern}}`, `{"varEquals": {name, value}}`, `{"sumEquals": {names[], target}}`, `{"all": [...]}`, `{"any": [...]}`, `{"not": ...}`. 임의 스크립트 평가가 없다.

### 4.2 타깃(셀렉터) 참조

`target`은 `selectors.json`의 `stable_id`를 가리킨다.

```json
"hometax.invoice.form.supplierBizNo": {
  "candidates": [
    {"kind": "role", "role": "textbox", "name": "공급받는자 등록번호"},
    {"kind": "css", "value": "#rcvrBsno"},
    {"kind": "label", "text": "등록번호", "nth": 1}
  ],
  "expect": {"visible": true, "editable": true},
  "lastVerified": "2026-10-20"
}
```

후보는 순서대로 시도한다. 모두 실패하면 `onFail` 정책으로. 텔레메트리는 `stable_id`와 실패한 후보 인덱스만 보낸다(값·텍스트 없음).

## 5. 실패 정책

```json
"onFail": {"retry": 2, "backoffMs": [800, 2000], "then": "recover" | "checkpoint:<name>" | "handoff" | "abort", "handoffAfter": 1}
```

- `recover`: D03 §5 복구 계층(L1 판정 → L2 Terra 수리 → 핸드오프). `handoffAfter`는 L2 시도 횟수 상한(기본 1).
- `submit` 스텝은 `retry: 0` 고정. 실패 시 반드시 `verify` 스텝으로 "실제로 제출됐는지"를 먼저 확인하고(아이덴포턴시 키 조회), 미제출 확인 후에만 체크포인트 복귀.

## 6. 정적 검증 규칙 (로드 시 전부 통과해야 함)

| 규칙 ID | 내용 |
|---|---|
| V-01 | JSON Schema 적합 |
| V-02 | 모든 `target`이 `selectors.json`에 존재 |
| V-03 | `irreversible: true` 스텝은 도달 가능한 모든 경로상 앞에 `gate`가 있어야 한다(제어 흐름 그래프 분석). 게이트와 비가역 스텝 사이에 `goto`·`handoff`가 끼면 위반 |
| V-04 | `submit`은 `idempotencyKey`와 `verify`를 가져야 하고 `retry`는 0 |
| V-05 | `repeat.max ≤ 20`, 중첩 깊이 ≤ 2 |
| V-06 | `goto.url`과 모든 `wait.navigation` 결과 호스트가 `manifest.domains` 안 |
| V-07 | `decide.bundle`이 엔진 번들 카탈로그에 존재하고 `on`이 번들의 가능한 결과 전부를 덮음(기본 분기 포함) |
| V-08 | `secret_fill.secret`이 허용 열거값 안이고, 같은 스텝에 `value` 필드가 없음 |
| V-09 | `pace: none`은 `wait`·`assert`·`extract`·`decide`에만 허용 |
| V-10 | `human.kind = captcha`는 `region`을 가져야 하고, 이어지는 스텝이 `fill`일 때 그 값은 `human` 결과만 참조 |
| V-11 | 모든 경로가 `end`로 끝남, 도달 불가 스텝 없음 |
| V-12 | `profileKinds`와 입력 타입이 일치(개인 프로필 플레이북에 `security_card` 없음 등) |
| V-13 | 문자열 필드에 사용자 데이터 리터럴(사업자번호 형식·주민번호 형식) 포함 금지(패키지에 데이터가 박히는 실수 방지) |

## 7. 예시: H-01 전자세금계산서 건별발급 (발췌)

```json
{
  "ir": 1, "id": "hometax.invoice.issue", "version": "1.3.0", "portal": "hometax",
  "profileKinds": ["business"],
  "inputs": {"counterpart": {"type": "counterparty", "required": true},
             "amounts": {"type": "amounts", "required": true},
             "items": {"type": "line_items", "required": true},
             "issueDate": {"type": "date", "default": "today"}},
  "preconditions": ["profile.hasSignMethod", "inputs.counterpart.verified"],
  "steps": [
    {"id": "s0", "type": "checkpoint", "name": "session",
     "label": "홈택스 접속", "expect": {"exists": "hometax.nav.home"}},
    {"id": "s1", "type": "goto", "url": "https://hometax.go.kr/", "pace": "normal"},
    {"id": "s2", "type": "decide", "bundle": "screen_state_v1", "scope": "root",
     "on": {"logged_in": "s10", "login_required": "s3", "captcha_or_mfa": "s90", "error": "recover", "unknown": "handoff"}},
    {"id": "s3", "type": "click", "target": "hometax.login.certButton"},
    {"id": "s4", "type": "secret_fill", "target": "hometax.login.certPassword", "secret": "cert_password",
     "onFail": {"retry": 0, "then": "human:secret"}},
    {"id": "s5", "type": "wait", "for": "navigation"},
    {"id": "s6", "type": "decide", "bundle": "screen_state_v1", "scope": "root",
     "on": {"logged_in": "s10", "login_required": "handoff", "captcha_or_mfa": "s90", "error": "recover", "unknown": "handoff"}},
    {"id": "s10", "type": "checkpoint", "name": "form", "expect": {"exists": "hometax.invoice.form.root"}},
    {"id": "s11", "type": "goto", "url": "https://hometax.go.kr/…/건별발급"},
    {"id": "s12", "type": "fill", "target": "hometax.invoice.form.counterpartBizNo", "value": "$inputs.counterpart.bizNo"},
    {"id": "s13", "type": "click", "target": "hometax.invoice.form.lookupCounterpart"},
    {"id": "s14", "type": "assert", "cond": {"textMatches": {"target": "hometax.invoice.form.counterpartName", "pattern": "$inputs.counterpart.nameRegex"}}},
    {"id": "s15", "type": "fill", "target": "hometax.invoice.form.item1.name", "value": "$inputs.items[0].name"},
    {"id": "s16", "type": "fill", "target": "hometax.invoice.form.item1.supply", "value": "$inputs.amounts.supply"},
    {"id": "s17", "type": "fill", "target": "hometax.invoice.form.item1.tax", "value": "$inputs.amounts.tax"},
    {"id": "s18", "type": "assert", "cond": {"sumEquals": {"names": ["$inputs.amounts.supply", "$inputs.amounts.tax"], "target": "hometax.invoice.form.total"}}},
    {"id": "s19", "type": "decide", "bundle": "form_ready_v1", "scope": "hometax.invoice.form.root",
     "on": {"ready": "s20", "validation_error": "handoff", "unknown": "handoff"}},
    {"id": "s20", "type": "gate", "card": "invoice.confirm", "fields": ["inputs.counterpart", "inputs.amounts", "inputs.items", "inputs.issueDate"], "ttlMs": 600000},
    {"id": "s21", "type": "submit", "target": "hometax.invoice.form.issueButton", "irreversible": true,
     "idempotencyKey": "$inputs.counterpart.bizNo|$inputs.amounts.total|$inputs.issueDate|$profile.bizNo",
     "verify": "s30"},
    {"id": "s22", "type": "sign", "method": "$profile.signMethod", "then": ["human:secret", "secret_fill:security_card"]},
    {"id": "s30", "type": "decide", "bundle": "issue_result_v1", "scope": "root",
     "on": {"issued": "s31", "pending_auth": "s22", "duplicate": "s31", "rejected": "handoff", "unknown": "handoff"}},
    {"id": "s31", "type": "capture", "name": "approvalNo", "from": {"regex": {"target": "hometax.invoice.result.approvalNo", "pattern": "\\d{8}-\\d{8}-\\d{8}"}}},
    {"id": "s32", "type": "save_pdf", "strategy": "print", "docType": "tax_invoice",
     "nameTemplate": "세금계산서/{yyyy}/{MM}/{counterpart.name}_{yyyyMMdd}_{approvalNo}.pdf"},
    {"id": "s33", "type": "send_email", "via": "portal", "to": "$inputs.email", "irreversible": true},
    {"id": "s34", "type": "end", "status": "success"},
    {"id": "s90", "type": "human", "kind": "captcha", "region": "hometax.captcha.image", "prompt": "보안문자를 입력해 주세요", "ttlMs": 90000},
    {"id": "s91", "type": "fill", "target": "hometax.captcha.input", "value": "$human.s90"},
    {"id": "s92", "type": "click", "target": "hometax.captcha.submit"},
    {"id": "s93", "type": "decide", "bundle": "screen_state_v1", "scope": "root",
     "on": {"logged_in": "s10", "login_required": "s3", "captcha_or_mfa": "handoff", "error": "recover", "unknown": "handoff"}}
  ],
  "postconditions": ["vars.approvalNo", "artifacts.pdf"]
}
```

검증기 통과 근거: `s21`(submit)과 `s33`(send_email) 앞에 `s20` 게이트가 모든 경로에 존재. `s21`은 `verify: s30`. 캡차 경로 `s90`은 `region` 보유, `s91`은 `$human.s90`만 참조.

주의: 실제 URL·셀렉터는 스파이크 S1에서 확정한다. 위 값은 형태 예시다.

## 8. 번들 참조 규약

`decide.on`의 키는 번들이 정의한 결과 라벨이다. 번들은 confidence 임계값을 포함하므로, 임계값 미달은 번들 결과가 `unknown`으로 내려온다. 따라서 모든 `decide`에는 `unknown` 분기가 필수다(V-07).

## 9. 버전·호환

- `version`은 semver. major 증가 = 입력 스키마 변경. 엔진은 같은 major의 최신만 유지하고, 사용자 UI에 변경 요약(`strings.ko.json`의 `changelog`)을 보여준다.
- 셀렉터 사전만 바뀌는 핫픽스는 patch. 레지스트리에서 `selectors.json`만 교체하는 **셀렉터 핫픽스 패키지**를 별도로 허용하되 서명과 `playbookVersionRange`를 가진다.

## 10. 운영 수준별 실행 변환

운영 정책 `portalMode`가 `postprocess`이면 엔진은 해당 포털 플레이북을 **실행하지 않고** `guide` 변환본을 만든다: `goto`는 사용자 Chrome에서 URL 열기, 그 외 스텝은 `label`을 안내 패널의 체크리스트로 바꾸고, `fill`의 값은 '복사' 버튼으로 제공한다. `save_pdf`는 파일 감시(다운로드 폴더·인쇄 출력)로 대체되고 `capture`·메타데이터 추출은 저장된 PDF에서 수행한다. `assisted`이면 로그인 구간(`checkpoint: session`까지)과 `submit`·`sign`을 `human(kind=manual)`로 바꾸고 나머지는 실행한다. 변환 규칙은 엔진에 있고 플레이북은 모른다.
