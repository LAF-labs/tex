# D03. 플레이북 엔진

> v1.3.2 — AUDIT-D 반영 2026-11-03: 재시작 복원은 테이블 상태 승격·`run.reverify`(§2), 게이트 대기 10분·금고 잠금 시 바 내림(§3), 작성일자 KST·s19e 대조(§5), 확인 불가 fail-closed·입력 잠금 두 구간·trial 클릭(§5.3), verify 상한 5분·실패 신호 쌍(§5.6), 포털 문구 표시(§6), 2차 인증·모르는 화면·로그인 실패·시계 전진·PoC 상한(§7·§7.1), 체인 자체 검증(§9)(ADR-022·023·024, D19 §3.5). v1.3.1 — ADR-021 반영: 로컬 승인 근거를 main 소유 승인 바로 바꿨다(§1·§2·§3·§11). v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영. 바뀐 절에는 근거 ID를 괄호로 붙였다. 이전 판 v1.1은 Review A를 반영해 상태 머신 전이표, 아이덴포턴시 원장, 게이트 토큰, 커밋 구간 런타임 규칙, Actuator 기반 요청률 집행, 복구 계층의 비가역 차단, 운영 수준을 정의했다.

## 1. 책임

IR 로드·검증, **패키지 로더(서명·핫픽스·정책·레지스트리 status 소비)**, 실행, 체크포인트·재개, 게이트·토큰·원장 관리, 커밋 가드, 사람 입력 조율, 복구 계층, 요청률 정책 집행(Actuator), 감사 저널, 텔레메트리 요약. `engine` 유틸리티 프로세스에서 돌며 Playwright로 Chrome을 제어한다(CDP는 금고 중계).

토큰·원장은 **엔진 로직 버그**를 막는 장치다. 엔진 프로세스가 침해되면 무력하다. 네트워크 커밋 가드(§5.4)는 별도 모듈(요청 인터셉터)에 두어 두 장치가 같은 버그로 함께 뚫리지 않게 한다. 다만 가드도 같은 프로세스에 있으므로 엔진 RCE에 대해서는 경계가 아니다. 커밋 요청 **본문 대조(R-C1)는 Phase 1부터 금고 중계가 수행**한다(§5.4, E-02). 엔진은 요청 바디를 보지 않는다. 커밋 엔드포인트 인터셉트 자체를 금고로 옮기고 금고가 승인 근거(폰의 `Sign_Vm`, main 승인 바가 발급한 `LocalApproval`, ADR-021)를 직접 검증해 근거 하나당 요청 1회를 집행하는 안(무장 근거 검증)은 **Phase 2**다(A-03, ADR-005 v3). 본문이 암호화(`opaque`)되면 금고도 대조하지 못하므로, 그 경우 이 장치는 "승인 없는 발급의 횟수"만 제한한다.

## 2. 실행 상태와 전이표

상태: `Unloaded, Loaded, Preparing, Running, WaitingGate, WaitingHuman, Recovering, HandedOff, Paused, Interrupted, InDoubt, Completed, CompletedWithIssues, Failed, Aborted`.

| 현재 | 이벤트 | 다음 | 부수효과 |
|---|---|---|---|
| Loaded | start | Preparing | intentId 생성(로컬) 또는 수신(리모트), 기본값 확정, `inputs_hash` 계산. 원장에 같은 intentId 행이 있는데 `inputs_hash`·`playbook_id`가 다르면 거부 + `ledger.intent_reuse`(B-10) |
| Preparing | 전제조건 실패 | Failed | |
| Preparing | 준비 완료 | Running | 저널 `run.started` |
| Running | gate 도달 | WaitingGate | **진입 전**(W 밖): 사전 안전 판정(§5.3) 통과, verify 기준선 B₀ 조회(실패 시 handoff + `verify.baseline_missing`, B-07), 기기 간 업무 키 조회(§4, B-30). 진입 시: 카드 = readback 값(앱 내장 라벨), 포털 탭 입력 잠금(R-G6), 승인 요청 발행(main 승인 바·폰) |
| WaitingGate | 승인(먼저 도착한 결정) | Running | `gate_requests` 원자 전이 후 토큰 발급(§3, R-G8), 거부 우선 창 2초 |
| WaitingGate | 거부 | Aborted | |
| WaitingGate | 사용자 "수정하기" | Running(게이트 앞 체크포인트) | 게이트 취소, 입력 잠금 해제, 게이트 앞으로 되감기(R-G6, B-06) |
| WaitingGate | `waitMs` 초과 | Paused | 게이트 **앞** 체크포인트로 되감아 저장 |
| Running | human 도달 | WaitingHuman | 토큰 폐기(R-G2) |
| WaitingHuman | 입력 | Running | |
| WaitingHuman | TTL 초과 | Paused | 체크포인트 되감기 |
| Running | 스텝 실패(재시도 소진) | Recovering | 토큰 폐기 |
| Recovering | 복구 성공 | Running | 실패한 그 스텝 재실행 |
| Recovering | 복구 실패 | HandedOff / Failed | onFail에 따름 |
| HandedOff | 가드가 커밋 요청 관측 | HandedOff | 원장 `observed_manual` → `in_doubt`, `ledger.observed_manual`(R-C2, B-04) |
| HandedOff | 사용자 "직접 발급함" | Running(verify) | 원장 `observed_manual` 기록 후 그 X의 verify 실행 |
| HandedOff | 사용자 재개 | Running | 원장이 `in_doubt`이면 `resumeAt` 대신 **verify 먼저**: `committed` → 사후 스텝, `not_committed` → 게이트 앞, `unknown` → InDoubt. 아니면 `resumeAt`부터. 토큰은 이미 폐기됨 |
| HandedOff | 30분 경과 | Paused | 포털 동시 실행 슬롯 해제 |
| Running | 비가역 스텝 진입 | Running(commit section) | **R-G7 순서**: 토큰 검증 → 원장 `armed` + 토큰 소비(한 트랜잭션, `synchronous=FULL`) → readback 재계산 → 가드 무장 → 클릭(B-06) |
| Running(commit) | readback 재계산 불일치 또는 타깃 동일성 불일치(R-A1) | Running(게이트 앞 체크포인트) / HandedOff | 클릭하지 않음. 원장 `not_committed`(사유 `pre_dispatch_mismatch`·`identity_mismatch`). readback 불일치는 게이트 앞으로, 동일성 불일치는 핸드오프 |
| Running(commit) | 클릭 반환 | Running(commit) | 원장 `dispatched` |
| Running(commit) | verify `committed` | Running | 원장 `committed`, 기기 간 업무 키 표시 업로드 |
| Running(commit) | verify `not_committed` | Running | 원장 `not_committed`, 게이트 앞 체크포인트로(`reload`) |
| Running(commit) | verify `unknown` / 상한 초과 | InDoubt | 원장 `in_doubt`, 기기 간 업무 키 표시 업로드 |
| InDoubt | 조회 재시도 성공 또는 사용자 증언("발급목록에 없음 확인") | Running / Failed | 증언은 main 승인 바로 받아 `LocalAttestation`(승인 근거와 다른 HMAC 문맥)으로 엔진에 넘기고 저널에 기록한다(ADR-021 결정 5). 증언은 `armed_at`부터 `policy.verify.minElapsedMs`가 지나고 조회 재시도를 1회 더 한 뒤에만 받으며, 승인 바에 "발급목록 반영이 늦을 수 있습니다"를 고정 표시한다(E-13) |
| Running | 모든 스텝 완료 | Completed | |
| Running | 비가역 커밋 뒤 후속(이메일 확인·PDF) 실패, 또는 `end: completed_with_issues` | CompletedWithIssues | UI 고정 문구 "재실행하지 마세요. 발급은 완료되었습니다" |
| Paused | 사용자 재개 | Running | 같은 `package_digest`가 설치되어 있을 때만. 아니면 '다시 시작'만. `prepare()`와 KST 날짜가 다르면 카드 고정 경고(B-13) |
| (아무 상태) | abort() | Aborted (커밋 구간이면 verify 후, 상한 120초 초과 시 InDoubt) | 간편인증 PUSH가 떠 있으면 "홈택스 앱 요청을 거절하세요" 안내 |
| (비종료 상태) | 프로세스 재시작 | Interrupted | 저널로 복원. 원장 `armed\|dispatched\|observed_manual` 행은 `in_doubt`로 승격 → InDoubt |

규칙:
- `WaitingGate → Running`은 승인 이벤트로만. 전이표에 다른 길이 없다.
- `Paused`는 디스크에 직렬화한다(입력·변수·현재 체크포인트·intentId·`package_digest`). 토큰과 `runKey`는 직렬화하지 않으므로 재개 시 반드시 재게이트된다.
- 저널(`run_events`)이 상태 전이의 기록이다. 재시작 복원은 저널 재생이 아니라 원장·게이트·실행 테이블 상태 승격이다(D-45(N-71)).
- InDoubt → 재조회: `run.reverify{intentId}`(조회만, 새 탭, 비가역 없음)는 앱 기동 시 1회 자동, 카드의 [발급목록 다시 확인], 같은 업무 키의 새 실행 시작 전에 돈다. B₁∖B₀가 정확히 1건이면 `committed`로 바꾸고 그 밖은 `in_doubt`를 유지한다(Phase 1, ADR-024, D-18(N-22)).
- 커밋 구간(토큰 소비 ~ verify 완료) 동안 앱 종료를 막고 확인 대화상자를 띄운다. OS 종료 신호를 받으면 저널에 `in_doubt`를 먼저 쓴다.
- **앱 업데이트는 실행 중·커밋 구간·데몬 실행 중에는 설치하지 않는다.** 내려받기는 해도 되지만, 설치·재시작은 모든 실행이 끝난 뒤 사용자 확인을 받아 한다(A-29). 업데이트 매니페스트 서명·동결 감지는 D11 §4.
- 운영 수준 `postprocess`에서는 이 상태 머신을 쓰지 않고 안내 패널·파일 감시만 동작한다(§12).

## 3. 게이트 토큰과 승인

```text
actionHash = SHA-256(CBOR{cardHash, readbackHash, authorizes[], packageDigest, intentId})
  cardHash      = 게이트 요청 fields 배열 전체(fieldKey·값·순서). 엔진이 계산하고, main(승인 바)과 폰이 받은 fields로 다시 계산해 일치해야 함
  readbackHash  = readback 스텝이 되읽은 필드값(JCS 정규화)
  packageDigest = IR + selectors + 적용된 핫픽스 + lookupsUsed 다이제스트 + 정책 버전 + 프로필 버전   (B-08)
token = HMAC(runKey, CBOR{runId, gateStepId, actionHash, exp, nonce})
  exp = 승인시각 + min(policy.run.commitWindowMs, Wmax(X))                                          (R-G8)
  Wmax(X) = W(X)의 정적 상한. W(X) = {G, X}이면 60초 + signFlow.maxWaitMs, W 안에 wait·assert·extract가 있으면 그 timeoutMs 합을 더한다
```

- `runKey`는 실행마다 32바이트 무작위, 메모리에만.
- 토큰은 **단일 사용**이고 **주 비가역 1개**에 대해서만 소비된다(V-03i, B-12). 후속 비가역(`followUpOf`)의 토큰은 **같은 실행 안에서** 주 비가역이 `committed`로 전이하는 순간 별도 1회 토큰으로 발급된다(B-10).
- **게이트 요청은 원자적이다**(R-G8, B-33). `gate_requests(req_id PK, run_id, state, decided_by, decided_at)` 행을 승인 처리와 같은 트랜잭션에서 `open→approved|denied`로 바꾼다. 이미 `open`이 아니면 두 번째 결정은 무시하고 거부만 기록한다. 토큰을 소비하면 `consumed`, 대기가 끝나면 `expired`다. `req_id`당 토큰은 최대 1개다(DDL은 D07).
- 소비는 원장 `armed` 기록과 한 트랜잭션.
- readback은 토큰 소비 **뒤**, 클릭 **직전**에 다시 계산해 `readbackHash`와 비교한다(R-G7). 재계산과 클릭 사이에는 디스크 I/O를 두지 않는다. 불일치면 클릭하지 않고 원장을 `not_committed`(`pre_dispatch_mismatch`)로 종결한 뒤 게이트 앞으로 돌아간다(보안 이벤트 아님).
- 토큰 폐기(R-G2): `Recovering`, `WaitingHuman`, `HandedOff`, `Paused`, `Interrupted` 진입, 체크포인트 복귀, 게이트 "수정하기", L2 셀렉터 적용, 핫픽스 적용 중 하나라도 일어나면 미소비 토큰 전부 폐기.
- 보안 이벤트는 위조·다른 실행의 토큰·이미 소비된 토큰에만. 만료는 보안 이벤트가 아니다.
- **로컬 승인**(A-15, ADR-021): 비가역 승인은 **main 소유 승인 바**에서만 한다. 대화 카드에는 승인 버튼이 없고, 카드의 렌더러 신호는 승인 근거가 아니다.
  - 승인 바는 main이 메인 창에 자식으로 붙이는 `WebContentsView`다(`sandbox`, `javascript:false`, preload 없음, 전용 세션 파티션). 내용은 main이 신뢰 계획값(readback 값 + 앱 내장 라벨)으로 만든 정적 HTML(CSP `default-src 'none'; style-src 'self'`)이고, 요약 3줄 이하와 "승인하고 발급"이 한 버튼이다. H-01 요약은 공급받는자(상호·사업자번호), 합계와 세액, 받는 이메일이다.
  - 위치는 main이 창 크기만으로 정한다(대화 열 하단, 입력창 예약 영역 위). 렌더러가 보고하는 좌표는 쓰지 않는다. 앱 내장 요약 표에 없는 서류 종류의 커밋 게이트는 패키지 로더가 거부한다(§3.1).
  - 승인 입력은 main이 그 뷰의 `before-mouse-event`로 **직접 관찰한 클릭**(바 안 왼쪽 down → up)만 인정한다. 바가 보이거나 요약·동작이 바뀌거나, 창이 옮겨지거나 다시 보이거나 활성화된 뒤 600ms는 무시하고(무장 전 mouseDown이면 다시 시작, 바를 눌러 창을 활성화한 경우는 예외), 바 안에서 실제로 움직인 뒤 150ms가 지난 mouseDown만 인정한다. 대화 화면 커서가 숨겨지거나 바뀌어 있으면 무장하지 않는다. **키보드 승인은 없다**(Enter·조합키 모두).
  - 바는 `WaitingGate`(main이 엔진에서 직접 받은 상태)일 때만 뜨고, 한 게이트에서 한 번 뜨면 게이트가 끝날 때까지 남는다(렌더러의 숨김 요청은 무시). `trigger=local`이 아닌 실행에서는 자동으로 띄우지 않는다.
  - main은 받은 `fields`·`cardHashInputs`로 `actionHash`를 다시 계산해 일치할 때만 무장한다. 승인되면 `LocalApproval{runId, gateStepId, reqId, approvalNonce, actionHash, exp, presence}`를 발급한다. `approvalNonce`는 엔진이 게이트 요청마다 만들고 `gate.waitMs` 동안 유효하며 폰 챌린지와 분리된다(아래 토큰 식의 `nonce`와 다른 값). 엔진은 이것을 main↔엔진 전용 포트로만 받는다(§11). Phase 1에는 HMAC을 검증하는 쪽이 없고 포트 출처만 믿는다.
  - 설정에서 Windows Hello 확인을 켜면(기본 꺼짐) 바 클릭 뒤 main이 `UserConsentVerifier`를 부른다. `Verified`이면 `presence: click+hello`로 발급하고, `Canceled`·`DeviceBusy`·`RetriesExhausted`이면 승인 대기를 유지한다. Hello를 쓸 수 없으면(`DeviceNotPresent`·`NotConfiguredForUser`·`DisabledByPolicy`, 원격 데스크톱 등) 한 번 다시 시도한 뒤 바가 "이번만 Hello 없이 승인" 상태가 되고, 그 클릭은 `presence: click+waiver`로 발급하며 알림·활동 기록을 남긴다(ADR-021 결정 3).
  - 같은 사용자 권한 프로세스의 합성 입력(`SendInput`)은 실제 입력과 구분되지 않으므로 M·E에 대해서는 경계가 아니다(E-06). 상세는 ADR-021.
- **폰 승인**: `gate.request{reqId, fields[{key: fieldKey, value}](readback 값), cardHashInputs{readbackHash, packageDigest, authorizes, intentId}, actionHash, challenge, exp 120s}`. 폰은 앱 내장 라벨 사전으로 `fields`를 렌더링하고, 표시한 값으로 `cardHash`를 직접 계산해 `actionHash`를 다시 계산한 뒤 일치할 때만 승인 버튼을 활성화한다(B-29). 승인은 `Sign_Vm("SAX-approve-v1"‖pair_id‖reqId‖challenge‖actionHash‖decision)` → 엔진 검증 후 토큰 발급(D08 §6). 시작 동의는 별도 메시지(`consent.*`, 서명 문맥 `SAX-consent-v1`)이고 게이트 검증기는 받지 않는다(B-27, D08).
- **원격 비가역 승인 상한**(C-06): 엔진은 `policy.remote.irreversiblePerDay`(≤ 5)를 넘는 원격 승인, 처음 쓰는 거래처·이메일 수신자에 대한 원격 승인(`newCounterpartyRequiresLocal`)을 받지 않고 로컬 승인(승인 바)으로 돌린다. 원격으로 승인된 비가역이 `committed`가 되면 `notifyOnIrreversible` 채널로 알린다. 비가역 원격 승인을 하드웨어 키(P-256, SE/StrongBox) 서명으로만 받는 규칙은 정책 필드가 아니라 엔진이 `authorizes`의 `commitEffect`로 `requiredSigAlg`를 계산하는 **앱 상수 규칙**이며, 원격 기능과 함께 Phase 2다(D08 §6.1, 오류 코드 `remote.hw_key_required`). 원격 승인이 거부되어 로컬로 돌린 경우(하드웨어 키 없는 폰, 처음 쓰는 거래처, 일일 상한) PC 승인 바는 **자동으로 뜨지 않는다**(`trigger=local`이 아닌 실행은 모두 같다). 실행은 "PC에서 승인 필요" 상태로 대기하고 폰·PC에 그 사실을 알리며, 사용자가 PC에서 그 작업 카드를 열면 바가 뜬다(E-06, ADR-021 결정 4).
- 두 채널 중 먼저 도착한 결정이 이기며, 승인 뒤 커밋 직전까지 다른 채널의 거부가 오면 중단한다.
- `gate.waitMs` 기본값은 10분(상한 1시간)이다. 금고가 잠기거나 앱이 트레이로 내려가면 바를 내리고, 사용자가 카드를 다시 열면 같은 게이트로 다시 띄운다(ADR-023, D-01(N-07)).
- 타이밍 이름: `gate.waitMs`(승인 대기, 기본 10분, ≤ 1시간), `policy.run.commitWindowMs`(승인 후 커밋 구간 상한, 기본 10분 — 실제 토큰 수명은 위 `exp` 식), `gate.request.exp`(폰 응답 챌린지 120초, 만료 시 재요청. 재요청해도 `req_id`는 그대로다). 검증기는 `commitWindowMs ≥ signFlow.maxWaitMs + verify 상한`을 확인한다(B-09).

### 3.1 패키지 로더 (B-01, B-08, B-22, C-26)

로드할 때마다(설치 시 한 번이 아니라) 다음을 순서대로 확인하고, 하나라도 실패하면 로드하지 않는다.

1. **서명**: [manifest.schema.json](schemas/manifest.schema.json) 적합, `signatures[]`에 앱에 핀 고정된 패키지 서명 키 3개 중 **서로 다른 2개 이상**의 유효 서명(2-of-3). 폐기 목록(`revoked_keys.json`, 오프라인 루트 키 서명, D09)에 있는 키의 서명은 세지 않고 `registry.key_revoked`를 남긴다. 부족하면 `registry.signature_insufficient`.
2. **내용 결속**: `contentDigests`가 playbook·selectors·strings와 일치.
3. **버전**: 같은 `keyEpoch` 안에서만 버전을 비교한다. 새 단조 값은 저장값보다 커야 하고 `+1000` 이하여야 한다(넘으면 `registry.version_jump_rejected`, 버전 인플레이션 잠금 공격 방지). 패키지·핫픽스·정책·인덱스에 같은 규칙을 쓴다.
4. **번들**: `bundlesUsed[].digest`가 앱 바이너리에 내장된 번들 다이제스트 허용 목록에 있다(BV-06).
5. **조회 하위 플레이북**: `lookupsUsed[]`의 각 패키지가 설치되어 있고, 서명·`kind: lookup`·다이제스트가 일치한다(V-22).
6. **정적 검증**: 스키마 + V-01~V-24. 셀렉터 CI 규칙 SV-01~06은 **레지스트리 CI에서만** 돌고, 2-of-3 서명이 그 통과를 전제로 한다(클라이언트는 녹화 DOM·HAR이 없어 다시 돌리지 않는다). 대신 클라이언트는 런타임에 R-A1·R-A2·`DENY_ACTION_NAME` 검사를 **매번** 한다(§5.2). 이 문장이 SV 실행 위치의 정본이다(D02 §2.2·§6.3, D12 §3, ADR-012, E-03).
7. **핫픽스**([hotfix.schema.json](schemas/hotfix.schema.json)): `appliesTo.packageDigest`가 정확히 이 패키지, 2-of-3 서명, 단조 `monotonic`, `expiresAt − issuedAt ≤ 14일`이고 만료 전, `entries`의 각 항목이 적격 항목(D02 §2.2: 비커밋·비비밀·비readback 조건에 더해, 어떤 항목의 `landmark` 값으로 쓰이는 stable_id, IR의 `decide.scope`·조건식(`cond`)·`signFlow.rowLabel`·`readback.fields`·`signFlow.confirmTarget`이 참조하는 항목, 어떤 커밋 구간 `W(X)` 안 스텝이 참조하는 항목은 **불가** — 엔진이 IR에서 참조 집합을 계산해 확인, E-03)이며, `commitEndpointsAdd`는 추가만. 반영한 사전에 6단계를 **다시 돌리고**, 실패하면 핫픽스를 거부(`registry.hotfix_rejected`)하고 패키지는 원래 후보로 돈다. 조회 패키지에 대한 핫픽스는 항상 거부한다.
8. **승인 바 요약 표**(ADR-021): 커밋 게이트가 있는 패키지는 그 서류 종류가 앱 내장 승인 바 요약 표에 있어야 하고, 요약 줄에 쓰는 `fieldKey`가 게이트 카드 필드에 모두 있어야 한다. 없으면 `loader.approval_summary_missing`으로 로드하지 않는다(PC에서 무장할 수 없는 게이트를 미리 막는다).

**레지스트리 status 소비**(B-22, E-05): 엔진은 `/registry/status.json`(포털별 `portalModeCeiling`과 `killPlaybooks[]`)을 받아 `portalModeCeiling`은 정책 위의 **하향 전용** 상한으로, `killPlaybooks`는 실행 거부로 적용한다. 서명 규칙: 내용은 정책 키 2-of-3 또는 1인 긴급 키(하향·킬스위치 추가만, §7.1 보수성 판정)로 서명하고, 신선도는 온라인 타임스탬프 키(HSM 안, 자동)가 **48시간마다 재서명**한다(만료 ≤ 48시간). status는 하향·킬스위치만 표현할 수 있으므로 내용 변경에 단일 긴급 키를 허용한다. **1인 긴급 키만으로 서명된 하향 status는 72시간 뒤 자동 만료**되고, 그 안에 2-of-3 재확인이 없으면 엔진은 마지막 2-of-3 서명 status 값으로 되돌린다. `issuedAt`이 현재 시각 + 5분보다 미래인 status는 거부한다. 마지막 유효 status가 48시간을 넘으면 stale(`registry.status_stale`)로 표시하고, **72시간** 동안 갱신을 받지 못하면 데몬 실행을 멈추고, 홈택스 `auto` 실행마다 "최신 운영 정책을 확인하지 못했습니다" 경고를 띄운다. 투명성 로그의 포함 증명이 없는 인덱스를 거부하는 규칙은 **Phase 2**다. **Phase 1 split-view 점검**(E-14): 폰이 없는 Phase 1에서도 엔진은 투명성 로그 트리 헤드를 레지스트리와 **별도 호스트(다른 도메인·다른 운영 계정)의 미러 1곳**에서 함께 받아 비교하고, 같은 트리 크기에서 헤드가 다르거나 미러가 일관성 증명을 줄 수 없으면 `registry.head_mismatch`(보안 이벤트)를 남기고 새 패키지·정책·핫픽스 적용을 보류한다. 키 운영·투명성 로그·status 발행 절차는 D09 §8과 ADR-013에 있다.

### 3.2 번들 정의 검증 (BV-01~06, B-14)

엔진 로더와 번들 CI가 같은 규칙을 쓴다([bundle.schema.json](schemas/bundle.schema.json)).

| 규칙 | 내용 |
|---|---|
| BV-01 | 매핑의 마지막 행은 `{"outcome":"unknown","when":"always"}`다 |
| BV-02 | 거절 단조성: 각 질문에 `onRefusal` 가정값을 대입했을 때 도달할 수 있는 결과 집합이, 그 질문의 모든 가능한 값으로 도달할 수 있는 결과 중 `kind:progress`를 새로 포함하면 안 된다. 결과적으로 `security_warning`·`asks_to_proceed_or_issue`·`page_text_addresses_agent`·`has_error_modal`은 `assume_true`, 진행 조건 predicate(`issuance_success_text` 등)는 `assume_false` 또는 `unknown`이다. 인젝션 필터 predicate의 refusal은 "지시문 있음"이다 |
| BV-03 | `riskClass: pre_commit\|post_commit`의 `progress` 결과로 가는 모든 조건은 `gte`·`confidenceGte` ≥ 0.95, `safety`의 중단 결과는 ≤ 0.80, 그 외 `progress`는 ≥ 0.85 |
| BV-04 | 모든 `choice`에 `unknown` 또는 `none_of_these`(스키마) |
| BV-05 | `reservedOutcomes`의 행은 매핑에서 모든 `progress` 행보다 앞에 있다 |
| BV-06 | 번들 정의는 **앱 바이너리에만** 포함하고 레지스트리로 배포하지 않는다. 다이제스트 허용 목록은 앱에 내장되고 앱 업데이트로만 바뀐다(ADR-003) |

게이트웨이 응답은 비신뢰 입력이다. 엔진은 결과 매핑·임계값을 **로컬 번들 정의**로 다시 계산하고, Terra 응답의 도구 호출이 로컬 툴셋 정의에 없는 이름·스키마면 버린다(C-24). 요청 본문 규범은 [gateway-request.schema.json](schemas/gateway-request.schema.json) 하나다(B-20).

## 4. 아이덴포턴시 원장 (B-04, B-07, B-10, B-30)

`irreversible_log(PRIMARY KEY(intent_id, step_id), run_id, playbook_id, business_key, inputs_hash, package_digest, action_hash, state, reason, armed_at, dispatched_at, resolved_at, verify_ref, device_id)` (DDL은 D07. `reason`은 `not_committed` 종결 사유 `pre_dispatch_mismatch`·`identity_mismatch`·`payload_mismatch`·`verify`)

- 행은 입력(`inputs_hash`)·패키지(`package_digest`)·승인 내용(`action_hash`)에 결속된다. 같은 의도의 비가역 둘(주·후속)은 `step_id`로 구분되어 서로 덮어쓰지 않는다.
- 상태: `armed → dispatched → committed | not_committed | in_doubt`. 그리고 `observed_manual`: 핸드오프·`human(manual)` 중 가드가 관측한 커밋 요청 또는 사용자의 "직접 발급함"(R-C2). `observed_manual`은 verify로 `committed`/`not_committed`가 되거나 `in_doubt`로 남는다.
- 순서: 토큰 소비 + `armed` 기록 커밋 → readback 재계산 → 클릭 → `dispatched` → verify → 종결 상태.
- 재시작 시 `armed|dispatched|observed_manual`은 모두 `in_doubt`로 승격.
- **의도 재사용 거부**: 같은 `intent_id`로 들어온 새 실행의 `inputs_hash`나 `playbook_id`가 원장의 것과 다르면 거부하고 보안 이벤트 `ledger.intent_reuse`를 남긴다.
- 같은 `(intent_id, step_id)`에 종결되지 않은 행이 있으면 재실행 금지. `committed`이면:
  - **같은 `run_id`의 재개**일 때만 verify 결과(`bind` 포함)를 재사용해 사후 스텝으로 점프한다.
  - 다른 실행에서 `committed`를 발견하면 "InDoubt 아님, 이미 완료" 카드만 띄우고 사후 스텝(특히 `send_email`·PDF 저장·백업)은 실행하지 않는다.
  - "건너뛰기"는 존재하지 않는다.
- 같은 `business_key`의 `armed|dispatched|in_doubt|committed|not_committed|observed_manual`은 카드 경고(차단 아님). `not_committed`면 직전 시도 고정 문구를 넣는다(D02 §7).
- **기기 간 업무 키 표시**(B-30, Phase 1, E-07·E-13): 계정의 '백업(메타데이터 동기화)' 스위치를 켠 경우에만 동작한다(옵트인과 같은 스위치. Phase 1에는 블롭 백업이 없으므로 이 스위치는 업무 키 표시만 켠다). 켜져 있으면 `armed`·`committed`·`in_doubt`·`observed_manual`로 전이할 때 `HMAC(K_idx, businessKey)`와 상태를 메타데이터 서버에 올린다(`armed`는 원장 기록 직후 비동기로 올리고 재계산~클릭 사이에 기다리지 않는다, R-G7). 서버 레코드는 `{account_id, hmac, state, day}`(일 단위)이고 `armed` 행은 10분 뒤 서버가 지우므로 "`armed` 행이 있다 = 10분 이내"다. 게이트 직전(W 밖)에 같은 HMAC을 조회해 다른 기기의 `committed`·`in_doubt`·`observed_manual`이 있으면 경고하고, 로컬 원장에 없는 `armed`가 있으면 카드에 "다른 PC에서 같은 건 진행 중"을 표시한다(모두 차단 아님). 오프라인이면 "다른 PC 기록 확인 불가"를, 스위치가 꺼져 있으면 "기기 간 중복 경고 꺼짐(백업 꺼짐)"을 카드에 표시한다. 두 PC가 수 초 안에 동시에 게이트를 통과하는 창은 막지 못한다(잔여 위험, D19 §8). 인증은 데스크톱 AIK 인증서 기반 기기 범위 토큰이다(D09 §2.1·§6).
- `in_doubt` 해소 수단은 둘뿐: 조회형 verify 재시도, 사용자의 명시 증언. 데몬은 `in_doubt`가 있는 서류를 자동 재시도하지 않는다(D10).
- 라이브 `cmd.run`도 디스크에 영속된 처리 완료 `cmdId` 집합과 대조한다(D08 §6).

### 4.1 크래시 시점별 결과 (B-10, E-13)

| 크래시 시점 | 디스크 원장 | 재시작 후 | verify로 가능한 결론 | 중복 위험 |
|---|---|---|---|---|
| 승인 전(WaitingGate) | 행 없음 | Interrupted → 재게이트(토큰은 메모리) | — | 없음 |
| 토큰 소비·`armed` 트랜잭션 커밋 전 | 행 없음(원자) | 재게이트 | — | 없음 |
| `armed` 후, 재계산·클릭 전 | `armed` → `in_doubt` | InDoubt | `committed` 불가(`B₁ \ B₀` = 0). `not_committed`는 "명시적 실패 신호"가 없어 불가 → `unknown` | 사용자 증언이 틀릴 때 |
| 클릭 요청 전송 중(반환 전) | `armed` → `in_doubt` | InDoubt | 반영 뒤 `committed`, 그 전 `unknown` | 반영 지연 중 증언 시 |
| `dispatched` 후 verify 전·중 | `dispatched` → `in_doubt` | InDoubt → 조회 재시도 | `committed`/`unknown` | 같음 |
| `committed` 기록 후 업무 키 표시 업로드 전 | `committed` | 같은 run 재개면 사후 스텝, 다른 run이면 "이미 완료" | — | 다른 PC 경고 누락 |
| 후속 비가역(`send_email`) `armed` 후 | (intent, 후속 step) `in_doubt`, 주 비가역 `committed` 유지 | InDoubt(후속만) | 재발송 목록 조회 | 재발송 중복(가역성 낮음) |
| 핸드오프 중, 사용자가 전용 Chrome 밖에서 발급 | 기록 없음 | 재개 시 `resumeAt` | 가드가 볼 수 없음 | **있음**(배너 문구만) |

"중복 0건"은 **한 PC 안의 엔진 로직 버그** 범위에서 성립한다. 반영 지연 중의 사용자 증언, 두 PC의 동시 게이트, 전용 Chrome 밖 수동 발급은 경고만 한다(D13 §3, D19 §8).

## 5. 스텝 실행과 커밋 구간

작성일자는 실행 시작 시 유효 시각의 KST 날짜다. H-01은 `s19e readbackEquals{issueDate, $inputs.issueDate}`(`assert.issue_date_mismatch`)로 포털 값과 대조한다(ADR-024, D-20(N-26)).

### 5.1 루프

```text
for step in plan(current):
  actuator.policy.beforeStep(step)
  journal(step.started)
  result = handler[step.type](ctx, step)      # 페이지에 닿는 모든 동작은 ctx.actuator 경유
  journal(step.finished, result.code)
  next = resolveNext(step, result)            # D02 §4.3 간선 정의 그대로
```

`plan()`은 D02 §4.3 의미론을 그대로 구현한다. 동적 스텝 생성은 없다.

### 5.2 Actuator

페이지에 영향을 주는 **모든** 동작(클릭, 키 입력, 네비게이션, 대화상자 응답, 셀렉터 수리 적용, `sign`·`signFlow` 내부 동작, 금고 타이피스트의 비밀 창 개시)은 `Actuator` 인터페이스 하나를 거친다. `policy.beforeAction(kind, portal)`이 여기서 지연·카운터·쿨다운·실행당 동작 상한(`maxActuationsPerRun`, 기본 150)·벽시계 상한을 집행한다. 스텝 핸들러·복구기·금고 모두 우회할 수 없다.

- **타이피스트**(A-26, A/C-04): 금고 타이피스트는 Actuator에서 **비밀 창 개시 허가를 1회**만 받는다(`kind:'secret_window'`). 글자 간격은 금고가 실행 시작 때 받은 `policy.pace.*.keyEventDelayMs`로 스스로 집행한다. 엔진·저널·텔레메트리는 비밀의 길이를 기록하지 않는다.
- **R-A1 액추에이션 시 동일성 검사**(B-01): Actuator는 `click`·`press`·`fill`·`select` 직전에 해석된 요소의 실제 역할과 접근성 이름(NFKC·제로폭 제거·공백 정규화 뒤)이 사전의 `role`·`namePattern`과 일치하는지, 같은 `frame`·`landmark` 안인지 **매번** 확인한다(§6 동일성 검사 (1)(2)(4)(5)(6)과 같은 함수). 불일치는 `step.identity_mismatch`로 `onFail`에 넘긴다. 커밋 구간의 X에서 불일치하면 클릭하지 않는다(§2 전이표).
- **R-A2 비커밋 액추에이션의 커밋 충돌 검사**(B-01, E-03): `commits:false` 항목을 클릭·입력하기 **직전마다** 같은 랜드마크의 모든 `commits:true` 항목을 해석해, 해석된 요소가 **같은 요소**이면 동작하지 않고 보안 이벤트 `step.commit_shadow`를 남긴다(SV-01의 런타임판). 해석에 실패한 커밋 항목은 비교에서 빼고 저널에만 남긴다.
- **커밋 그림자 검사**: `commits:false` 항목으로 해석된 요소가 같은 랜드마크 안 `commits:true` 항목의 `namePattern`에 맞거나, `DENY_ACTION_NAME`(§7.1)에 맞으면 클릭하지 않고 보안 이벤트 `step.commit_shadow`를 남긴다. SV-02에 따라 `reviewNote`로 검토된 항목은 `DENY_ACTION_NAME` 검사에서 빼고 `commits:true` 항목과의 대조만 한다.

### 5.3 커밋 구간 런타임 규칙

- **진입 전(W 밖) 사전 안전 판정**(B/C-03, C-24): 게이트 진입 직전에 (a) 직전 `decide` 결과가 `blocked`·`security_warning` 쪽이 아니고, (b) 결정적 차단 신호(§7 차단 신호 사전, HTTP 403/429 급증, 연속 추가 인증)가 없어야 한다. 커밋 구간 안에서는 모델을 부르지 않으므로 이 판정이 마지막이다. 사전 안전 판정(게이트 직전·커밋 직전)에서 화면 확인이 금고 거부·시간 초과로 불가하면 `handoff(portal.unobservable)`로 멈춘다(ADR-022, D-13(N-20)).
- 관리자 강제 설치 확장(`ExtensionInstallForcelist`)이 전용 프로필에서 탐지되면 카드에 "이 PC에는 관리자가 설치한 확장이 있어 화면과 제출 값이 다를 수 있습니다"를 고정 표시한다(B-06, 탐지는 금고, D05). 허용 목록 밖 확장이 있으면 금고가 비밀 창을 열지 않는다(`vault.extension_not_allowed`, A-11).
- **R-G6 입력 잠금**(B-06, Phase 1): 입력 잠금은 '게이트 열림 ~ 토큰 소비·재계산 완료'와 'verify 구간' 두 구간이다. 엔진의 발급 버튼 클릭 직전에만 풀고 클릭 직후 다시 건다(`setIgnoreInputEvents`가 CDP 입력도 막는다는 실측). 잠금에 실패하면 게이트를 열지 않는다. 발급 버튼은 동작 가능성 사전 확인(`trial`, 1.5초)을 통과해야 누르며, 사전 확인 실패는 `not_committed(identity_mismatch)`다. 이어지는 실제 클릭의 예외만 `dispatched`다(ADR-024, D-40(N-21)). 잠금 구간 동안 금고 중계로 포털 탭에 `Input.setIgnoreInputEvents(true)`를 걸고, 앱 UI에 "승인 대기 중 화면 잠금(중단 가능)"을 표시한다. 편집하려면 "수정하기"를 눌러 게이트를 취소한다. `signFlow`의 `human:secret` 단계 동안에는 금고가 **서명 대화상자(비밀 창 대상)만** 입력을 풀고 폼의 나머지는 잠금을 유지했다가 단계가 끝나면 다시 잠근다(E-02). 대화상자가 별도 타깃(팝업·프레임)이면 그 타깃만 풀고, 같은 탭 안 요소라 `Input.setIgnoreInputEvents`(탭 단위)로 나눌 수 없으면 해제 범위를 **S15**에서 정한다. 그 구간의 화면 편집은 금고의 본문 대조(R-C1, §5.4)가 잡는다(본문이 `opaque`면 못 잡음, D19 §8). 보안 모듈·간편인증 팝업과의 간섭은 확인 필요(S15).
- **진입(R-G7)**: 토큰 검증 → 원장 `armed` + 토큰 소비(fsync) → readback 재계산 → 커밋 가드 **무장**(토큰당 커밋 요청 `maxRequests`회) → 클릭.
- 구간 안에서는 L1 팝업 처리·L2 수리·핸드오프·**모델 호출**을 하지 않는다. 실패는 곧바로 `verify`.
- `submit.signFlow`는 X의 일부로 구간 안에서 돈다(D02 §4.5): 방식별 `human:secret`·`secret_fill:security_card`·`wait:push`, `confirmTarget` 클릭(R-A1 적용), `maxWaitMs` 초과·실패 시 verify. 실제 순서는 확인 필요(S1).
- `expectConfirm`이 선언된 경우에만, 무장 상태에서 앵커된 패턴과 일치하는 `confirm`만 수락하고 텍스트 해시를 `commit.confirm_accepted`로 남긴다(V-24, §6 대화상자 정책).
- abort는 verify 뒤에만 유효(상한 120초, 초과 시 InDoubt).

### 5.4 네트워크 커밋 가드

- Playwright 라우팅으로 포털 요청을 감시한다. 기준은 같은 포털의 설치된 모든 패키지 `commitEndpoints`의 **합집합**(+ 적용된 핫픽스의 `commitEndpointsAdd`)이다. `match` = 메서드 + 경로 패턴 + 선택적 액션 파라미터. 홈택스는 대부분 POST라 경로·액션 ID 단위 분류가 필요하다(확인 필요, S1).
- `Running` 중에 맞는 요청은 **무장된 토큰이 있을 때만 통과**시키고, 그 외에는 차단 + 저널 `commit_guard.blocked_request` + 실행 중단(InDoubt 아님 — 요청이 나가지 않았으므로).
- 무장 상태는 토큰당 `maxRequests`회 요청으로 소진된다(포털이 같은 제출에 여러 요청을 보내는 패턴은 S1에서 측정해 선언).
- **R-C1 본문 대조**(B-03, Phase 1, S1 조건부, E-02): `commitEndpoints[].bodyFieldMap{fieldKey → 요청 파라미터 경로}`가 선언된 경우, 대조는 **금고 중계가 수행**한다. 엔진은 무장할 때 `commit.arm{intentId, stepId, endpoint, bodyFieldMap, expectedHash}`를 금고에 보내고(`expectedHash` = readback 기대값을 `bodyFieldMap` 순서로 정규화한 해시, 비밀 아님), 금고는 해당 커밋 요청 본문을 같은 규칙으로 정규화·해시해 `{match: true|false|opaque}`만 돌려준다. **엔진은 요청 바디를 보지 않으므로** 비밀 오염 프레임의 바디 제거(D05 §3.4)와 충돌하지 않는다. `false`면 금고가 요청을 중단하고 엔진은 `security.commit_payload_mismatch`를 남기며, 요청이 나가지 않았으므로 원장은 `not_committed`(`payload_mismatch`)로 종결한다. 본문이 평문일 때만 대조할 수 있고, 보안 모듈이 본문을 암호화하면(`encoding: opaque`) 대조할 수 없어 "화면 값 ≠ 제출 값"을 탐지하지 못한다는 잔여 위험을 D11 T1·T4에 둔다.
- **R-C2 핸드오프 중 관측**(B-04): `HandedOff`·`WaitingHuman(manual)` 중에는 가드가 커밋 요청을 **차단하지 않고 관측**한다. 관측되면 현재 의도의 해당 스텝으로 원장에 `observed_manual`을 쓰고 상태를 `in_doubt`로 둔다. 재개 시 `in_doubt`이면 `resumeAt` 대신 verify를 먼저 실행한다(§2). 핸드오프 배너 고정 문구: "직접 발급하셨다면 '직접 발급함'을 눌러 주세요. 다시 실행하면 중복 발급됩니다."
- **R-C3 미분류 요청 기록**(B-03): 실행 중 포털 호스트로 가는 요청 중 `commitEndpoints`에도 `knownEndpoints`에도 없는 것은 저널 `commit_guard.unclassified`로 남긴다(경로 패턴만, 본문·쿼리 없음). 커밋 랜드마크가 화면에 있는 동안 이런 요청을 차단하도록 승격할지는 S1·베타 데이터로 정한다(**Phase 2**).
- `commitEndpoints` 합집합이 비어 있는 포털은 `auto`·`assisted`에서 실행하지 않는다(SV-06과 같은 조건을 엔진이 실행 시에도 확인).
- 가드는 엔진의 토큰 로직과 다른 모듈(`net/commitguard`)에 두고, 토큰 검증 결과를 `armedUntil`·`intentId`·`stepId`·`readbackHash`만으로 받는다. R-C1 본문 대조는 Phase 1부터 금고, 인터셉트와 무장 근거 검증을 금고로 옮기는 것은 Phase 2(A-03, §1).
- 라우팅과 본문 검사가 포털 쪽에서 관측 가능한 차이(지연·헤더)를 만드는지는 확인 필요(S8).

### 5.5 체크포인트와 복귀

- 체크포인트 `expect`는 **도착 조건**(그 스텝을 지난 뒤 참). 복귀 절차: `reentry: reload`면 항상 `url`로 새로 로드한 뒤 `expect` 평가. `reuse`면 현재 탭에서 `expect` 평가 → 참이면 다음 스텝부터, 거짓이면 `url`로 이동 후 재평가. `sessionRequired`인데 로그아웃 상태면 `session` 체크포인트로 상향 → 그래도 실패면 핸드오프.
- 게이트를 지배하는 복귀 지점은 `reload`이므로(V-03l) 이전 시도·핸드오프 중 사용자 편집·포털 오류 상태가 폼에 남지 않는다(B-13).
- `fill`은 기존 값을 지우고 입력한 뒤 readback으로 일치를 확인하므로 복귀 후 재입력이 안전하다. `keyEvents` 칸은 전체 선택 → 삭제 → 입력. `ifAbsent: clear`는 칸을 비운다.
- 복귀는 토큰을 폐기한다(R-G2). 커밋 구간을 지난 비가역은 원장이 막는다.
- Paused 재개는 같은 `package_digest`일 때만, 날짜가 바뀌었으면 고정 경고: "작성일자가 어제(YYYY-MM-DD)로 고정되어 있습니다. 오늘 날짜로 바꾸려면 다시 시작하세요"(B-13).

### 5.6 verify 실행 (B-07, B-08)

- verify(와 게이트 직전 기준선 조회)는 **새 탭**에서 조회 하위 플레이북을 실행하고 끝나면 탭을 닫는다. 원래 탭의 결과 화면은 건드리지 않는다.
- 판정은 D02 §4.4: `B₁ \ B₀`가 정확히 1건이면 `committed`(승인번호는 `bind`로), 부재의 증거(`minElapsedMs`, `lookups`회 연속 0건, 명시적 실패 신호)가 모두 있을 때만 `not_committed`, 나머지는 `unknown`. 정책 하한은 `policy.verify`.
- 조회 패키지 안에서는 모델 호출·L1·L2·핸드오프가 없다(V-22). 어떤 실패도 `unknown`이다.
- verify 동안 원래 탭의 입력 잠금(R-G6)은 유지된다.
- verify는 `minElapsedMs`·`lookups` 하한을 넘긴 뒤에도 `verify.maxMs`(앱 하한 300초)까지 지수 간격(10·20·40초)으로 조회하고, 상한에서만 `in_doubt`로 끝낸다. `not_committed`는 (css, `^…$` 문구) 쌍으로 정의된 실패 신호가 클릭 뒤 새로 보일 때만 성립한다(ADR-022·024, D-18(N-22), D-05(N-02)).

## 6. 복구 계층

| 계층 | 트리거 | 수단 | 상한 | 금지 |
|---|---|---|---|---|
| L0 | 셀렉터 미스·타임아웃 | 정책 지연 후 재시도, 후보 순회 | `onFail.retry ≤ 3` | 비가역 스텝은 0 |
| L1 | L0 소진·미지 모달 | `recovery_v1` 번들(결과: `element_missing_same_screen`, `different_screen`, `modal_blocking`, `session_expired`, `unknown`) → 각각 L2 / 체크포인트 / 팝업 처리 / `session` 복귀 / 핸드오프 | 실행 전체 연속 `unknown` 2회 → L3 | 커밋 구간 안 금지 |
| L2 | `element_missing_same_screen` | Terra `selector_repair`(읽기 도구 3종, `scopeId`는 엔진이 요청마다 채운 열거값, 이름은 정규식이 아닌 부분 문자열 `nameContains`, B/C-07) → 엔진이 동일성 검사 10항 통과 후 **그 실행에서만** 적용. **자동 적용은 `fill`·`select`·`wait`·`extract` 타깃에만**(되돌릴 수 있고 readback으로 검증됨). `click`·`press` 타깃의 제안은 핸드오프 카드("이 버튼을 누를까요?" + 요소 하이라이트)로 사용자가 확인해야 적용한다(B-16) | 실행당 `policy.run.l2MaxAttempts`(기본 1) | 비가역 스텝·`commits:true`·`secretSlot`·`password`·커밋 구간·조회 패키지 금지 |
| L3 | 그 외 | 핸드오프(`resumeAt`), 토큰 폐기 | — | — |

L2 동일성 검사(모두 통과해야 적용): (1) strict 1개 일치 (2) 같은 프레임 (3) 스텝 `scope` 서브트리 안 (4) 사전의 `role` 일치 (5) 실제 접근성 이름이 사전 `namePattern`(앵커 필수, SV-04)과 일치(모델 제안 이름 미사용) (6) `landmark` 일치 (7) `fill`이면 readback 일치 (8) `css`는 ID/허용 속성 셀렉터만 (9) 실제 이름이 `DENY_ACTION_NAME`에 맞으면 버림(B-16, B-32) (10) 모델 출력의 `risk_flags`가 비어 있지 않거나 `outcome ≠ repaired`면 적용하지 않음(B-17, 출력 스키마는 D04 §4.1). 복구 성공 → **실패한 그 스텝**을 재실행. L2 입력은 텍스트뿐이며 **Phase 1에서는 이미지를 모델로 보내지 않는다**(B-18).

팝업 처리(L1 `modal_blocking`): 셀렉터 사전에 `closeAffordance:true`로 등록된 요소만 클릭한다. 실제 접근성 이름을 NFKC·제로폭 제거·공백 제거로 정규화한 뒤 `DENY_ACTION_NAME`(§7.1)에 맞으면 하드 금지(B-32). 등록된 닫기 요소가 없으면 핸드오프.

대화상자 정책: `alert` → accept, 텍스트를 판정 입력으로. `confirm`/`beforeunload` → **무장된 커밋 구간 + 선언된 `expectConfirm` 패턴(앵커, V-24) 일치**일 때만 accept + `commit.confirm_accepted{textHash}`, 그 외 dismiss + 저널. `prompt` → dismiss. 리스너는 엔진이 항상 등록한다(Playwright 기본 동작에 의존하지 않음). 실행이 닫은 포털 대화상자의 마지막 문구(NFKC, 200자)는 실행 메모리에만 두고 실패·핸드오프 카드에 '홈택스 안내: …'로 보인다. 저널·텔레메트리·모델에는 넣지 않는다. `step.target_not_found`·`checkpoint.expect_failed`는 "예상한 홈택스 화면이 아니에요" 문구로 보인다(ADR-022, D-10(N-16)).

스냅샷 필터와 비밀 칸 가드: `type=password` 또는 사전 `secretSlot` 또는 최근 타이피스트 대상 요소의 값은 접근성 스냅샷에서 제거한다. 엔진의 DOM 읽기 함수(Actuator·readback·스냅샷·`extract` 공통)는 이 요소들의 `value`를 아예 읽지 않는다(V-20 런타임 가드, A-05, B-26). 타이피스트는 키 입력마다 `activeElement`와 `type`을 재확인한다. 스냅샷은 모델로 가기 전에 D06 절단·구분자 규칙과 D04 결정적 사전 필터를 지난다.

## 7. 요청률 정책 (서명 배포, 플레이북은 강화만 가능)

정책 파일 예시([policy.schema.json](schemas/policy.schema.json) 적합, `signatures`·`timestamp` 생략, B/C-10):

```json
{
  "version": "2026.10", "monotonic": 41, "keyEpoch": 1,
  "issuedAt": "2026-10-28T00:00:00+09:00", "expiresAt": "2026-10-31T00:00:00+09:00",
  "pace": {"interactive": {"stepDelayMs": [800, 2500], "keyEventDelayMs": 150, "afterNavSettleMs": [600, 1500], "slowFactor": 1.5},
           "daemon":      {"stepDelayMs": [1200, 3500], "keyEventDelayMs": 150, "afterNavSettleMs": [800, 2000], "slowFactor": 1.5}},
  "browser": {"remoteDebuggingPort": "forbidden", "webdriverSelfCheck": true},
  "captchaRelay": {"hometax": "allowed", "gov24": "disabled_until_permission", "sminfo": "disabled", "insure4": "disabled"},
  "limits": {"hometax": {"runsPerDayPerProfile": 40, "irreversiblePerDayPerProfile": 30, "runsPerLoginSession": 15, "navigationsPerMin": 12, "loginsPerDay": 6, "concurrent": 1},
             "gov24":   {"runsPerDayPerProfile": 20, "irreversiblePerDayPerProfile": 5,  "runsPerLoginSession": 5,  "navigationsPerMin": 12, "loginsPerDay": 6, "concurrent": 1},
             "sminfo":  {"runsPerDayPerProfile": 10, "irreversiblePerDayPerProfile": 3,  "runsPerLoginSession": 5,  "navigationsPerMin": 10, "loginsPerDay": 4, "concurrent": 1},
             "insure4": {"runsPerDayPerProfile": 10, "irreversiblePerDayPerProfile": 3,  "runsPerLoginSession": 5,  "navigationsPerMin": 10, "loginsPerDay": 4, "concurrent": 1}},
  "retries": {"stepMax": 3, "backoff": "equal_jitter", "baseMs": 800, "capMs": 10000},
  "run": {"maxActuationsPerRun": 150, "maxWallClockMs": 1800000, "commitWindowMs": 600000, "l2MaxAttempts": 1},
  "cooldown": {"onBlockSignalHours": 24, "onCaptchaBurst": {"windowMin": 10, "count": 3, "action": "slow+notify"}, "positiveDetectionsForCooldown": 2},
  "daemon": {"windowJitterMin": 30, "gapBetweenRunsMin": [5, 15], "startupGraceMin": 10, "retryAfterMin": 30, "autoAllowed": false},
  "portalMode": {"hometax": "auto", "gov24": "postprocess", "sminfo": "postprocess", "insure4": "postprocess"},
  "verify": {"minElapsedMs": 60000, "lookups": 2},
  "remote": {"irreversiblePerDay": 5, "newCounterpartyRequiresLocal": true, "notifyOnIrreversible": ["desktop", "email"], "minProtocolVersion": 1, "disabledFeatures": []},
  "queue": {"maxIntentsPerPair": 5, "ttlHours": 72}
}
```

카운터 정의(모두 SQLite 영속, KST, 증가 커밋 → 행동 순서):
- `runs/day/profile/portal`: `start` 시점. `irreversible/day/profile/portal`: `armed` 시점. `navigations/min/portal`: 네비게이션 이벤트. `logins/day/portal`: 로그인 성공 판정. `login_failures/day/profile/portal`: 포털의 명시적 인증 실패(`auth_failed`). 세션 = 포털 로그인 세션(로그인 성공 판정 ~ 로그아웃·만료). 원격 승인 비가역은 `remote_irreversible/day`로 따로 센다.
- 캡차 이벤트도 `rate_counters`에 기록(재시작에 살아남음).
- "마지막으로 본 시각"을 저장해 시계 역행을 감지하고, 역행하면 보수 모드(지연 1.5배, 상한 절반).
- 시계 전진은 단조 시간으로 판정하지 않는다. `lastSeen`이 마지막으로 검증한 서명 타임스탬프 + 72시간보다 미래면 불가능한 미래로 보고 재설정한다(`clock.future_reset`). 쿨다운 해제는 벽시계와 그 뒤 새로 검증한 서명 시각이 모두 `until` 이후일 때다(D-46(N-72)).
- **차단 신호**: (a) `blocked` 예약 결과, (b) HTTP 403/429 급증, (c) 연속 추가 인증, (d) **결정적 차단 신호 사전** — 차단 안내 페이지 URL 패턴과 안내 문구(앱 내장 사전 ∪ `policy.cooldown.blockSignalsAdd`, 정책은 추가만 가능). 모델 판정은 게이트웨이를 거치므로 (d)는 모델 판정과 독립으로 매 네비게이션·대화상자에서 본다(C-24). 차단 신호 → 즉시 중단 + 쿨다운. **거절(refusal)에서 나온 중단은 쿨다운이 아니라 핸드오프**. 쿨다운은 양성 탐지가 2회 연속일 때(PoC 빌드는 1회, 아래).
- (c) 추가 인증 연속 판정은 플레이북이 예상하지 않은 위치(로그인 구간 밖)의 추가 인증만 센다. 로그인 구간의 추가 인증은 `human(otp)` 핸드오프다. 로그인 성공은 연속 횟수를 0으로 되돌린다. 이 경로의 종료 코드는 `portal.extra_auth_repeat`이며 차단 신호 보고(D18 §3)에서 뺀다(ADR-022, D-09(N-14)).
- 기대 화면에 도착하지 못하고 끝난 실행은 `unknown_screen_streak`을 올린다. 2회 연속이면 보수 모드, 3회 연속이면 양성 탐지 1회다. 네비게이션 뒤 문서 경로가 플레이북 기대 경로 집합 밖이고 대기열 신호도 아니면 `portal.unexpected_page`로 멈춘다. 신호 사전에 block·extra_auth·captcha 항목이 없으면 시작 때 `run.signal_dict_empty`를 남긴다(ADR-022, D-06(N-03)).
- 포털의 명시적 인증 실패(`auth_failed`) 1회 뒤 같은 저장 자격은 사용자가 금고에서 확인하기 전까지 다시 입력하지 않는다. 타이피스트 `blocked_by_module`·네트워크·셀렉터 실패는 인증 실패로 세지 않는다(ADR-023, D-19(N-25)).
- PoC 빌드(`POC_BUILD`)는 홈택스 정책을 PoC-1 위험 수용 기록에 맞춰 엄격한 방향으로만 덮는다: 하루 실행 20·하루 비가역 1·하루 로그인 3·양성 1회 쿨다운·누적 실발급 3건(원장 `committed|in_doubt|armed|dispatched`). 누적 3건이면 `policy.poc_irreversible_total`로 시작을 거부한다(ADR-022, D-04(N-01)).
- 프로필은 트리거가 정하고 IR은 더 느린 쪽만 고를 수 있다. `slow`는 `slowFactor` 배수.
- 입력: 기본 `fill()`(즉시). 키 이벤트가 필요한 칸만 **고정 간격 150ms**. 비밀 창 안의 간격은 금고가 집행한다(§5.2, A-26). 타이핑 모사·지터는 쓰지 않는다. 스텝 간 지연 범위는 요청률 제한이지 행동 모사가 아니며, 문서·UI에서 '사람 수준'이라는 표현을 쓰지 않는다('요청률 상한').
- 캡차 중계: `policy.captchaRelay[portal]`이 허용이고 `CAPTCHA_RELAY_CEILING`이 허용할 때만 폰으로 보낸다(정부24는 허락 회신 전 비활성이고 공문에 중계 방식을 명시한다). 캡차는 사람이 푼다(ADR-004).
- 텔레메트리 옵트아웃 사용자의 운영 알림은 로컬 알림으로 대체.

우리가 하지 않는 것(정책 파일에 필드 자체가 없음): UA 변경, 지문 조작, `navigator.webdriver` 조작, 헤드리스, 프록시 로테이션, 타이핑 모사, 캡차 자동 입력.

### 7.1 앱 내장 상한·하한 (앱 업데이트로만 변경, B-23, B-22, B-32, C-26)

| 상수 | 값 |
|---|---|
| `PORTAL_MODE_CEILING` | `{hometax: auto, gov24: postprocess, sminfo: postprocess, insure4: postprocess, iros: postprocess, public_api: postprocess}` |
| `CAPTCHA_RELAY_CEILING` | `{hometax: allowed, 그 외: disabled_until_permission}` |
| `POLICY_FLOOR` | `stepDelayMs.min ≥ 800`, `afterNavSettleMs.min ≥ 600`, `onBlockSignalHours ≥ 24`, `positiveDetectionsForCooldown ≤ 2`, `onCaptchaBurst.count ≤ 3`, `onCaptchaBurst.windowMin ≥ 10`, `commitWindowMs ≤ 900000`, `l2MaxAttempts ≤ 2`, `remote.irreversiblePerDay ≤ 5`, `queue.maxIntentsPerPair ≤ 5`, `queue.ttlHours ≤ 72`, `verify.minElapsedMs ≥ 30000`, `verify.lookups ≥ 2`, `verify.maxMs ≥ 300000`(홈택스, ADR-024), `loginFailuresPerDay ≤ 2`(ADR-023, D-19(N-25)) |
| `DENY_ACTION_NAME` | `/(확인\|예\|네\|발급\|제출\|전송\|동의\|신청\|승인\|저장\|등록\|계속\|다음\|진행\|서명\|결제\|삭제\|ok\|yes\|confirm\|submit\|send\|issue\|apply\|agree\|next\|continue)/i`, NFKC + 제로폭 제거 + 공백 제거 뒤 적용 |
| `BLOCK_SIGNAL_DICT` | 차단 안내 URL 패턴·문구 사전(정책은 추가만) |
| `POLICY_MAX_VALIDITY_H` | 72 (정책 신선도 `expiresAt − issuedAt`) |
| `TIMESTAMP_RESIGN_H` | 48 (타임스탬프 키의 정책·status 신선도 재서명 주기, 운영 목표) |
| `POLICY_STALE_FALLBACK_H` | 168 (정책 만료 후 전 포털 `postprocess`로 내려가기까지) |
| `ISSUED_AT_MAX_SKEW_MIN` | 5 (`issuedAt` > 현재 시각 + 5분이면 거부) |
| `EMERGENCY_STATUS_TTL_H` | 72 (1인 긴급 키만으로 서명된 하향 status의 자동 만료) |
| `INDEX_MAX_VALIDITY_D` / `HOTFIX_MAX_VALIDITY_D` | 14 / 14 |
| `VERSION_JUMP_MAX` | 1000 (같은 `keyEpoch` 안) |
| `STATUS_MAX_AGE_H` / `STATUS_STALE_DAEMON_STOP_H` | 48 / 72 |
| `W_STATIC_BOUND_MS` | 60000 (`W(X) = {G, X}`의 토큰 수명 상한, `signFlow.maxWaitMs` 별도) |

적용 규칙:
- 정책 값이 상한·하한을 넘으면 **그 필드만** 내장 값으로 고정하고 `policy.clamped`(필드 이름만)를 저널과 텔레메트리에 남긴다. 정책 전체를 거부하지 않는다.
- **범위 역전은 하한 우선**(E-17): `[min, max]` 쌍(`stepDelayMs`·`afterNavSettleMs`·`daemon.gapBetweenRunsMin`)이 클램프 뒤 `max < min`이 되면 `max = min`으로 둔다(보수 쪽). 이것도 `policy.clamped`로 남긴다.
- 포털 키가 없으면 그 포털은 `postprocess`다(fail-closed). 대소문자가 다른 키는 스키마에서 거부된다.
- **정책 서명과 신선도**(C-26, E-05): 정책 **내용**(`issuedAt`·`expiresAt`·`timestamp`를 뺀 본문)은 정책 키 2-of-3(또는 아래 긴급 키 규칙)으로 서명하고, 내용이 바뀌면 `monotonic`을 올린다. **내용이 바뀌지 않는 재발행**은 온라인 타임스탬프 키(국내 HSM 안, 자동)가 `{contentDigest, monotonic, issuedAt, expiresAt}`에 `timestamp` 서명을 붙여 48시간마다 한다. 사람 쿼럼은 내용이 바뀔 때만 필요하다.
- `expiresAt − issuedAt > 72시간`이거나 `issuedAt`이 현재 시각 + 5분보다 미래인 정책은 그 파일을 거부하고(`policy.issued_in_future` 또는 `registry.*`) 마지막 유효 정책을 유지한다. 처음 설치해 유효 정책이 한 번도 없으면 가장 보수적인 내장 정책(모든 포털 `postprocess`)으로 동작한다.
- **정책 만료 시**: 즉시 전 포털을 내리지 않는다. **마지막 유효 정책을 유지**하되 (a) 완화 방향 변경을 받지 않고(신선한 2-of-3 정책이 오기 전까지는 긴급 키의 보수 변경만 반영), (b) 데몬 실행을 멈추고, (c) 핫픽스 로드를 거부하며, (d) 홈택스 `auto` 실행마다 "최신 운영 정책을 확인하지 못했습니다" 경고를 띄운다(`policy.stale`). 만료 후 **168시간(7일)**이 지나도 신선한 정책을 받지 못하면 전 포털 `postprocess`로 내린다. 약관 준수 목적(정부24 등)은 앱 내장 `PORTAL_MODE_CEILING`이 이미 달성하므로 만료 직후 홈택스까지 내릴 이유가 없다. 패키지 인덱스 만료는 14일을 유지한다.
- 버전은 같은 `keyEpoch` 안에서만 비교하고 `+1000`을 넘는 점프는 거부한다(§3.1).
- 정책은 2-of-3 서명으로 받는다. **1인 긴급 키 하나로만 서명된 정책은 현재 정책보다 엄격하게 보수적일 때만 수용한다**(C-26, E-04). "엄격하게 보수적"은 **정책의 모든 필드**에 대해 다음 방향을 모두 만족하고 적어도 하나가 엄격할 때다. 하나라도 반대 방향이거나 아래 목록에 없는 필드가 바뀌면 거부하고 `policy.rejected_not_conservative`를 남긴다.

  | 필드 | 보수 방향 |
  |---|---|
  | `portalMode.*` | 하향만(`postprocess < assisted < auto`) |
  | `captchaRelay.*` | `disabled` 방향만(`disabled < disabled_until_permission < allowed`) |
  | `limits.*.*` | ≤ 현재 |
  | `cooldown.onBlockSignalHours` | ≥ 현재 |
  | `cooldown.positiveDetectionsForCooldown` | ≤ 현재 |
  | `cooldown.onCaptchaBurst.count` / `.windowMin` / `.action` | count ≤, windowMin ≥, action은 `slow+notify → pause` 방향만 |
  | `cooldown.blockSignalsAdd` | 현재의 상위 집합(⊇) |
  | `pace.*.*`(`stepDelayMs`·`afterNavSettleMs`의 두 값, `keyEventDelayMs`, `slowFactor`) | ≥ 현재 |
  | `run.*`(`maxActuationsPerRun`, `maxWallClockMs`, `commitWindowMs`, `l2MaxAttempts`) | ≤ 현재 |
  | `retries.*` | `stepMax` ≤ 현재, `baseMs`·`capMs` ≥ 현재 |
  | `remote.irreversiblePerDay` | ≤ 현재 |
  | `remote.minProtocolVersion` | ≥ 현재 |
  | `remote.disabledFeatures` | 현재의 상위 집합(⊇) |
  | `remote.notifyOnIrreversible` | 현재의 상위 집합(⊇) |
  | `queue.*` | ≤ 현재 |
  | `verify.minElapsedMs` / `verify.lookups` | ≥ 현재 |
  | `daemon.windowJitterMin`·`gapBetweenRunsMin`·`startupGraceMin`·`retryAfterMin`(간격) | ≥ 현재 |
  | `killPlaybooks`(status) | 현재의 상위 집합(⊇) |
  | 그 밖의 필드(`browser`, `daemon.autoAllowed`, `remote.newCounterpartyRequiresLocal` 등) | 같음만 |

  판정기는 이 표를 policy.schema의 필드 목록에서 생성하고, 표에 없는 필드는 "같음만"으로 처리한다. 긴급 키 산출물도 투명성 로그에 기록하고 다른 키 보유자에게 자동 알린다(D09 §8.5).
- 정부24 등 `postprocess` 상한 포털의 상향은 공문 회신 뒤 **앱 업데이트로 상한을 올려야** 가능하다. 정책 배포만으로는 불가능하다(ADR-011, ADR-012).

## 8. 사람 입력 조율 (`human` 스텝)

- 요청: `{runId, stepId, reqId, kind, prompt, imageCrop?(16KB 청크), ttlMs, inputSpec, vaultChallenge?(secret)}`. 라우팅: 데스크톱 활성(최근 입력 60초·포커스) → 로컬, 아니면 라이브 리모트 세션 → 폰(`captchaRelay` 허용 포털만), 둘 다 없으면 `Paused` + 알림. 캡차 이미지 크롭은 사람에게만 가고 모델로는 가지 않는다.
- 핸드오프 지연 목표는 세 구간으로 나눠 측정한다: `T_detect`(판정까지) ≤ 2초, `T_notify`(알림 도달) ≤ 3초, `T_open`(사용자가 열어 입력 시작)은 측정만. '10초'는 앞 두 구간의 합 + 사용자 반응의 목표치다.
- `kind=secret`의 응답은 엔진에 오지 않는다(폰 → 금고 이중 봉인 → 타이피스트). `captcha`·`otp`·`manual`은 엔진이 받아 입력하고 로그에는 길이만(비밀 아님).
- TTL 초과 → 게이트 앞 체크포인트로 되감아 `Paused`. 자동 재요청 없음.

## 9. 감사 저널 (로컬 전용, D07 `run_events`, 해시 체인 + 폰 앵커)

Phase 1은 체인 자체 검증(`RunJournal.verify`)만 한다. 지원 번들 내보내기 직전과 기동 시 미종결 실행에서 재계산하고 불일치면 `journal.chain_broken{runId}`를 남겨 번들에 표시한다. 절단 탐지는 Phase 2 폰 앵커다(D-45(N-71)).

`run.started{mode}`, `step.*`, `step.identity_mismatch`, `step.commit_shadow`, `step.pre_dispatch_mismatch`, `gate.*{actionHash}`, `human.*`, `secret.used{kind, viaTypist}`(길이 필드 없음, A-26), `model.called`, `decide.result`, `ledger.*{intentId, stepId, state}`(`ledger.observed_manual`, `ledger.intent_reuse` 포함), `commit_guard.*`(`commit_guard.unclassified{pathPattern}` 포함), `security.commit_payload_mismatch`, `commit.confirm_accepted{textHash}`, `verify.baseline_missing`, `policy.clamped{field}`, `policy.rejected_not_conservative`, `policy.stale`, `policy.issued_in_future`, `registry.*`(`registry.head_mismatch` 포함), `daemon.effects_denied`, `artifact.saved`, `block.signal`, `cooldown.*`, `run.finished{status}`. 값 없음 원칙(해시·필드 이름·코드만). 로컬 승인 바(ADR-021): `gate.bar_shown`, `gate.bar_arm_refused{reason}`, `gate.approved{presence}`, `gate.hello{result}`, `gate.hello_waived`, `gate.attested`, `settings.hello_changed`, 보안 이벤트 `security.gate_answer_from_relay`.

## 10. 동시성·브라우저

- 포털당 실행 1개. Chrome 창 하나, 탭 분리. verify·기준선 조회는 별도 탭(§5.6).
- Chrome 기동: **금고가** `channel:'chrome'`, `ignoreDefaultArgs:true`, `--remote-debugging-pipe`, 전용 `--user-data-dir`, 최소 플래그로 띄우고 파이프의 단독 소유자가 된다(ADR-005 v3, D05 §3). 엔진은 금고가 MessagePort로 중계하는 CDP를 쓴다. **`--remote-debugging-port`는 정책 상수로 금지**한다. `--no-sandbox`·`--disable-extensions` 없음. 기동 시 `navigator.webdriver === true` 자기 점검(거짓이면 자동화 거부, ADR-010). 이 플래그들은 자동화 표식을 지우는 것이 아니라 제어 채널을 여는 것이며, 문서에서 '자동화 플래그 미사용'이라 쓰지 않고 '`--enable-automation` 배너 플래그 미사용, 표식은 그대로'라고 쓴다.
- 다운로드·인쇄 저장 폴더는 금고가 상수 staging 폴더로 설정하고, 엔진이 보낸 `Browser.setDownloadBehavior`·`Page.setDownloadBehavior`는 중계에서 거부된다(`vault.cdp_denied`, A-13). staging의 파일은 docparse를 거쳐 보관함으로 옮긴다(D05·D07).
- 이중로그인 감지(`logged_out_by_other_session` 예약 결과) → 일시정지, 자동 재로그인 없음.
- 메모리: 스냅샷은 스텝 종료 시 폐기, 캡차 이미지는 응답 후 즉시 폐기.

## 11. 공개 인터페이스

```ts
interface Engine {
  load(pkg: SignedPackage): Promise<LoadedPlaybook>;                              // §3.1 로더 규칙 전부
  prepare(pb, inputs, profile, opts: {trigger, intentId?}): Promise<RunPlan>;   // 기본값 확정, inputs_hash, 카드 데이터, 업무 중복 경고
  start(plan: RunPlan): RunHandle;  resume(runId): RunHandle;  abort(runId): Promise<AbortResult>;
  on(event, cb): Unsubscribe;
}
interface RunHandle {
  id; state();
  answerGate(d: GateDecision & {actionHash, approvalEvidence});   // approvalEvidence = main 승인 바가 발급한 LocalApproval(main↔엔진 전용 포트로만, 렌더러 명령 중계 경로에서 오면 거부 + `security.gate_answer_from_relay`, ADR-021) 또는 폰 서명(원격 채널, D08)
  cancelGateForEdit(): void;                                       // "수정하기"(R-G6)
  answerHuman(stepId, v: HumanAnswer);
  attestNotCommitted(intentId, stepId, note, evidence: LocalAttestation): void;   // main 승인 바의 증언 근거(ADR-021 결정 5). main↔엔진 전용 포트로만
  attestManualCommit(intentId, stepId): void;                      // "직접 발급함"(R-C2)
}
```
`HumanAnswer`에는 `secret`이 없다. 비밀은 `VaultClient.typist.*`만.

## 12. 운영 수준(portalMode)과 데몬 권한

- `postprocess`: Chrome·CDP를 **전혀 띄우지 않고** 포털 URL은 `shell.openExternal`로 **사용자의 기본 브라우저**에서 연다(자동화 프로필로 열면 `webdriver=true` 세션이 되어 사용자가 매크로 이용자로 제재받을 수 있다). `openExternal`은 **main만** 호출하고, 렌더러는 URL이 아니라 키(`portalId` 또는 strings 키)만 넘긴다. URL은 WHATWG 파싱 결과 `https:`, userinfo·포트 없음, 호스트 ∈ 엔진 내장 eTLD+1 허용 목록(패키지로 변경 불가)이어야 한다(A-17). `guide` 변환(D02 §9), 파일 감시·메타데이터·만료 추적만. 테스트로 "이 모드에서 CDP 연결 0건"과 "비 https·허용 밖 호스트 거부"를 고정한다(D17, D13).
- `assisted`: 변환 IR을 재검증 후 실행. `human_commit`도 토큰·원장·verify 규칙 동일.
- 수준은 서명 정책 배포로 바뀌지만 `PORTAL_MODE_CEILING`과 레지스트리 status의 `portalModeCeiling` 중 낮은 쪽을 넘지 못한다(§7.1, §3.1). 변경 시 사용자 알림.
- **R-D1 데몬 효과 제한**(B-27): `trigger=daemon`이면 `manifest.effects ⊆ {issue_document}`를 **런타임에** 검사한다(IR `pacing`과 무관). 위반하면 실행하지 않고 `daemon.effects_denied`를 남긴다.
- 데몬: "시작 동의"(스케줄러 수준, `consent.*` 메시지)와 "커밋 게이트"는 별개다. 동의는 `{playbookId, major, effects[], docType, profileId, consentedAt, deviceSig}`에 결속되고, 설치된 패키지의 major나 effects가 다르면 `notify`로 강등하고 재동의를 받는다(형식은 D07 `schedules.consent_json`). `auto`는 `StandingAuthorization{scheduleId, playbookId@major, docType, profileId, maxPerPeriod, expiresAt, userSignature}`에서 엔진이 **건별 단일 사용 토큰**을 만드는 설계이지만, `schedules.mode='auto'` 행은 정책 `daemon.autoAllowed`와 앱 빌드 플래그가 **모두 참일 때만** 실행하며 현재는 항상 거부한다(스키마상 `autoAllowed`는 `false` 고정). 홈택스 로그인이 사람 없이 끝나지 않으므로(가상키패드·PUSH) Phase 2의 데몬은 `notify`·`semi_auto`만 출시한다(D10).
- 레지스트리 status를 72시간 갱신하지 못하거나 정책이 만료되면 데몬은 실행하지 않는다(§3.1, §7.1).
