# D03. 플레이북 엔진

> v1.1 — Review A 반영: 상태 머신 전이표, 아이덴포턴시 원장, 게이트 토큰 재정의, 커밋 구간 런타임 규칙, Actuator 기반 사람 속도 집행, 복구 계층의 비가역 차단, 운영 수준.

## 1. 책임

IR 로드·검증, 실행, 체크포인트·재개, 게이트·토큰·원장 관리, 커밋 가드, 사람 입력 조율, 복구 계층, 사람 속도 정책 집행(Actuator), 감사 저널, 텔레메트리 요약. `engine` 유틸리티 프로세스에서 돌며 Playwright로 Chrome을 제어한다.

토큰·원장은 **엔진 로직 버그**를 막는 장치다. 엔진 프로세스가 침해되면 무력하다. 네트워크 커밋 가드(§5.4)는 별도 계층(요청 인터셉터)에 두어 두 장치가 같은 버그로 함께 뚫리지 않게 한다.

## 2. 실행 상태와 전이표

상태: `Unloaded, Loaded, Preparing, Running, WaitingGate, WaitingHuman, Recovering, HandedOff, Paused, Interrupted, InDoubt, Completed, CompletedWithIssues, Failed, Aborted`.

| 현재 | 이벤트 | 다음 | 부수효과 |
|---|---|---|---|
| Loaded | start | Preparing | intentId 생성(로컬) 또는 수신(리모트), 기본값 확정 |
| Preparing | 전제조건 실패 | Failed | |
| Preparing | 준비 완료 | Running | 저널 `run.started` |
| Running | gate 도달 | WaitingGate | 카드 = readback 값, `gate.request` 발행(로컬·폰) |
| WaitingGate | 승인(먼저 도착한 결정) | Running | 토큰 발급(§3), 거부 우선 창 2초 |
| WaitingGate | 거부 | Aborted | |
| WaitingGate | `waitMs` 초과 | Paused | 게이트 **앞** 체크포인트로 되감아 저장 |
| Running | human 도달 | WaitingHuman | 토큰 폐기(R-G2) |
| WaitingHuman | 입력 | Running | |
| WaitingHuman | TTL 초과 | Paused | 체크포인트 되감기 |
| Running | 스텝 실패(재시도 소진) | Recovering | 토큰 폐기 |
| Recovering | 복구 성공 | Running | 실패한 그 스텝 재실행 |
| Recovering | 복구 실패 | HandedOff / Failed | onFail에 따름 |
| HandedOff | 사용자 재개 | Running | `resumeAt`부터. 토큰은 이미 폐기됨 |
| HandedOff | 30분 경과 | Paused | 포털 동시 실행 슬롯 해제 |
| Running | 비가역 스텝 진입(토큰 검증·readback 재계산 일치) | Running(commit section) | 원장 `armed` + 토큰 소비(한 트랜잭션, `synchronous=FULL`) |
| Running(commit) | 클릭 반환 | Running(commit) | 원장 `dispatched` |
| Running(commit) | verify `committed` | Running | 원장 `committed` |
| Running(commit) | verify `not_committed` | Running | 원장 `not_committed`, 게이트 앞 체크포인트로 |
| Running(commit) | verify `unknown` / 상한 초과 | InDoubt | 원장 `in_doubt` |
| InDoubt | 조회 재시도 성공 또는 사용자 증언("발급목록에 없음 확인") | Running / Failed | 증언은 로컬 `human(manual)` 카드, 저널에 기록 |
| Running | 모든 스텝 완료 | Completed | |
| Running | 비가역 커밋 뒤 후속(이메일·PDF) 실패 | CompletedWithIssues | UI 고정 문구 "재실행하지 마세요. 발급은 완료되었습니다" |
| (아무 상태) | abort() | Aborted (커밋 구간이면 verify 후, 상한 120초 초과 시 InDoubt) | 간편인증 PUSH가 떠 있으면 "홈택스 앱 요청을 거절하세요" 안내 |
| (비종료 상태) | 프로세스 재시작 | Interrupted | 저널로 복원. 원장 `armed|dispatched` 행은 `in_doubt`로 승격 → InDoubt |

규칙:
- `WaitingGate → Running`은 승인 이벤트로만. 전이표에 다른 길이 없다.
- `Paused`는 디스크에 직렬화한다(입력·변수·현재 체크포인트·intentId). 토큰과 `runKey`는 직렬화하지 않으므로 재개 시 반드시 재게이트된다.
- 저널(`run_events`)이 상태 전이의 단일 진실이다. 재시작 시 저널을 재생해 상태를 복원한다.
- 커밋 구간(토큰 소비 ~ verify 완료) 동안 앱 종료를 막고 확인 대화상자를 띄운다. OS 종료 신호를 받으면 저널에 `in_doubt`를 먼저 쓴다.
- 운영 수준 `postprocess`에서는 이 상태 머신을 쓰지 않고 안내 패널·파일 감시만 동작한다(§12).

## 3. 게이트 토큰과 승인

```text
actionHash = SHA-256(CBOR{cardHash, readbackHash, authorizes[], packageDigest, intentId})
  cardHash      = 카드에 표시된 값(렌더 측과 엔진 측이 각각 계산해 일치해야 함)
  readbackHash  = readback 스텝이 되읽은 필드값(JCS 정규화)
  packageDigest = IR + selectors + 적용된 핫픽스 + 정책 버전 + 프로필 버전
token = HMAC(runKey, CBOR{runId, gateStepId, actionHash, exp = 승인시각 + policy.commitWindowMs, nonce})
```

- `runKey`는 실행마다 32바이트 무작위, 메모리에만.
- 토큰은 **단일 사용**이며 `authorizes`의 비가역 스텝 집합에 대해 발급된다. 후속 비가역(`followUpOf`)의 토큰은 선행 커밋이 `committed`가 되는 순간 함께 발급된다.
- 소비는 원장 `armed` 기록과 한 트랜잭션.
- 비가역 스텝 진입 직전에 readback을 다시 계산해 `readbackHash`와 비교한다. 불일치면 **재게이트**(보안 이벤트 아님).
- 토큰 폐기(R-G2): `Recovering`, `WaitingHuman`, `HandedOff`, `Paused`, `Interrupted` 진입, 체크포인트 복귀, L2 셀렉터 적용, 핫픽스 적용 중 하나라도 일어나면 미소비 토큰 전부 폐기.
- 보안 이벤트는 위조·다른 실행의 토큰·이미 소비된 토큰에만. 만료는 보안 이벤트가 아니다.
- 폰 승인: `gate.request{reqId, cardFields, actionHash, challenge, exp 120s}` → 폰이 `Sign_Vm("SAX-approve-v1"‖pair_id‖reqId‖challenge‖actionHash‖decision)` → 엔진 검증 후 토큰 발급(D08 §6). 로컬 승인은 렌더러의 신뢰 사용자 제스처(`isTrusted`)와 카드 렌더 해시를 `main`이 검증한다. 두 채널 중 먼저 도착한 결정이 이기며, 승인 뒤 커밋 직전까지 다른 채널의 거부가 오면 중단한다.
- 타이밍 이름: `gate.waitMs`(승인 대기, ≤ 1시간), `policy.commitWindowMs`(승인 후 커밋 구간 상한, 기본 10분), `gate.request.exp`(폰 응답 챌린지 120초, 만료 시 재요청).

## 4. 아이덴포턴시 원장

`irreversible_log(intent_id PK, run_id, step_id, business_key, state, armed_at, dispatched_at, resolved_at, verify_ref, device_id)`

- 상태: `armed → dispatched → committed | not_committed | in_doubt`.
- 순서: 토큰 소비 + `armed` 기록 커밋 → 클릭 → `dispatched` → verify → 종결 상태.
- 재시작 시 `armed|dispatched`는 모두 `in_doubt`로 승격.
- 같은 `intent_id`에 종결되지 않은 행이 있으면 재실행 금지. `committed`면 verify 결과를 재사용해 **사후 스텝**(`capture` 이후)으로 점프한다. "건너뛰기"는 존재하지 않는다.
- 같은 `business_key`의 `armed|dispatched|in_doubt|committed`는 카드 경고(차단 아님). 선택안: 업무 키 HMAC을 메타데이터 서버에 올려 기기 간 경고.
- `in_doubt` 해소 수단은 둘뿐: 조회형 verify 재시도, 사용자의 명시 증언. 데몬은 `in_doubt`가 있는 서류를 자동 재시도하지 않는다(D10).

## 5. 스텝 실행과 커밋 구간

### 5.1 루프

```text
for step in plan(current):
  actuator.policy.beforeStep(step)
  journal(step.started)
  result = handler[step.type](ctx, step)      # 페이지에 닿는 모든 동작은 ctx.actuator 경유
  journal(step.finished, result.code)
  next = resolveNext(step, result)            # §4.3 간선 정의 그대로
```

`plan()`은 D02 §4.3 의미론을 그대로 구현한다. 동적 스텝 생성은 없다.

### 5.2 Actuator

페이지에 영향을 주는 **모든** 동작(클릭, 키 입력, 네비게이션, 대화상자 응답, 셀렉터 수리 적용, `sign` 내부 동작, 금고 타이피스트의 타이밍 허가)은 `Actuator` 인터페이스 하나를 거친다. `policy.beforeAction(kind, portal)`이 여기서 지연·카운터·쿨다운·실행당 동작 상한(`maxActuationsPerRun`, 기본 150)·벽시계 상한을 집행한다. 스텝 핸들러·복구기·금고 모두 우회할 수 없다.

### 5.3 커밋 구간 런타임 규칙

- 비가역 스텝 진입: 토큰 검증 → readback 재계산 일치 → 원장 `armed` + 토큰 소비 → 커밋 가드 **무장**(토큰당 커밋 요청 1회) → 클릭.
- 구간 안에서는 L1 팝업 처리·L2 수리·핸드오프를 하지 않는다. 실패는 곧바로 `verify`.
- `expectConfirm`이 선언된 경우에만 포털의 `confirm` 대화상자를 수락한다(§6 대화상자 정책).
- abort는 verify 뒤에만 유효(상한 120초, 초과 시 InDoubt).

### 5.4 네트워크 커밋 가드

- Playwright 라우팅으로 포털 요청을 감시한다. `selectors.json`의 `commitEndpoints[]`(메서드+경로 패턴)에 맞는 요청은 **무장된 토큰이 있을 때만 통과**시키고, 그 외에는 차단 + 저널 `security.commit_guard` + 실행 중단(InDoubt 아님 — 요청이 나가지 않았으므로).
- 무장 상태는 토큰당 1회 요청으로 소진된다. 포털이 같은 제출에 요청을 여러 번 보내는 패턴이 확인되면 사전에 `commitEndpoints[].maxRequests`로 선언한다(S1에서 측정).
- 가드는 엔진의 토큰 로직과 다른 모듈(`net/commitguard`)에 두고, 토큰 검증 결과를 `armedUntil`·`intentId`만으로 받는다.

### 5.5 체크포인트와 복귀

- 체크포인트 `expect`는 **도착 조건**(그 스텝을 지난 뒤 참). 복귀 절차: 현재 탭에서 `expect` 평가 → 참이면 다음 스텝부터, 거짓이면 `url`로 이동 후 재평가 → `sessionRequired`인데 로그아웃 상태면 `session` 체크포인트로 상향 → 그래도 실패면 핸드오프.
- `fill`은 기존 값을 지우고 입력한 뒤 readback으로 일치를 확인하므로 복귀 후 재입력이 안전하다. `keyEvents` 칸은 전체 선택 → 삭제 → 입력.
- 복귀는 토큰을 폐기한다(R-G2). 커밋 구간을 지난 비가역은 원장이 막는다.

## 6. 복구 계층

| 계층 | 트리거 | 수단 | 상한 | 금지 |
|---|---|---|---|---|
| L0 | 셀렉터 미스·타임아웃 | 정책 지연 후 재시도, 후보 순회 | `onFail.retry ≤ 3` | 비가역 스텝은 0 |
| L1 | L0 소진·미지 모달 | `recovery_v1` 번들(결과: `element_missing_same_screen`, `different_screen`, `modal_blocking`, `session_expired`, `unknown`) → 각각 L2 / 체크포인트 / 팝업 처리 / `session` 복귀 / 핸드오프 | 실행 전체 연속 `unknown` 2회 → L3 | 커밋 구간 안 금지 |
| L2 | `element_missing_same_screen` | Terra `selector_repair`(읽기 도구 3종, `scopeId`는 엔진이 정한 열거값, `nameRegex` 대신 부분 문자열) → 엔진이 동일성 검사 8항 통과 후 **그 실행에서만** 적용 | 실행당 `policy.l2MaxAttempts`(기본 1) | 비가역 스텝·`commits:true`·`secretSlot`·커밋 구간 금지 |
| L3 | 그 외 | 핸드오프(`resumeAt`), 토큰 폐기 | — | — |

L2 동일성 검사(모두 통과해야 적용): (1) strict 1개 일치 (2) 같은 프레임 (3) 스텝 `scope` 서브트리 안 (4) 사전의 `role` 일치 (5) 실제 접근성 이름이 사전 `namePattern`과 일치(모델 제안 이름 미사용) (6) `landmark` 일치 (7) `fill`이면 readback 일치 (8) `css`는 ID/속성 셀렉터만. 복구 성공 → **실패한 그 스텝**을 재실행.

팝업 처리(L1 `modal_blocking`): 셀렉터 사전에 `closeAffordance:true`로 등록된 요소만 클릭한다. 접근성 이름이 `/확인|예|OK|발급|제출|전송|동의/`인 요소는 하드 금지. 등록된 닫기 요소가 없으면 핸드오프.

대화상자 정책: `alert` → accept, 텍스트를 판정 입력으로. `confirm`/`beforeunload` → **무장된 커밋 구간 + 선언된 `expectConfirm` 패턴 일치**일 때만 accept, 그 외 dismiss + 저널. `prompt` → dismiss. 리스너는 엔진이 항상 등록한다(Playwright 기본 동작에 의존하지 않음).

스냅샷 필터: `type=password` 또는 사전 `secretSlot` 또는 최근 타이피스트 대상 요소의 값은 접근성 스냅샷에서 제거한다. 타이피스트는 키 입력마다 `activeElement`와 `type`을 재확인한다.

## 7. 사람 속도 정책 (서명 배포, 플레이북은 강화만 가능)

```json
{
  "version": "2026.10",
  "pace": {"interactive": {"stepDelayMs": [800, 2500], "keyEventDelayMs": 150, "afterNavSettleMs": [600, 1500], "slowFactor": 1.5},
           "daemon":      {"stepDelayMs": [1200, 3500], "keyEventDelayMs": 150, "afterNavSettleMs": [800, 2000], "slowFactor": 1.5}},
  "browser": {"remoteDebuggingPort": "forbidden", "webdriverSelfCheck": true},
  "captchaRelay": {"hometax": "allowed", "gov24": "disabled_until_permission"},
  "limits": {"hometax": {"runsPerDayPerProfile": 40, "irreversiblePerDayPerProfile": 30, "runsPerLoginSession": 15, "navigationsPerMin": 12, "loginsPerDay": 6, "concurrent": 1},
             "gov24":   {"runsPerDayPerProfile": 20, "irreversiblePerDayPerProfile": 5,  "runsPerLoginSession": 5,  "navigationsPerMin": 12, "loginsPerDay": 6, "concurrent": 1}},
  "retries": {"stepMax": 3, "backoff": "equal_jitter", "baseMs": 800, "capMs": 10000},
  "run": {"maxActuationsPerRun": 150, "maxWallClockMs": 1800000, "commitWindowMs": 600000, "l2MaxAttempts": 1},
  "cooldown": {"onBlockSignalHours": 24, "onCaptchaBurst": {"windowMin": 10, "count": 3, "action": "slow+notify"}, "positiveDetectionsForCooldown": 2},
  "daemon": {"windowJitterMin": 30, "gapBetweenRunsMin": [5, 15], "startupGraceMin": 10, "retryAfterMin": 30},
  "portalMode": {"hometax": "auto", "gov24": "postprocess", "sminfo": "postprocess", "insure4": "postprocess"}
}
```

카운터 정의(모두 SQLite 영속, KST, 증가 커밋 → 행동 순서):
- `runs/day/profile/portal`: `start` 시점. `irreversible/day/profile/portal`: `armed` 시점. `navigations/min/portal`: 네비게이션 이벤트. `logins/day/portal`: 로그인 성공 판정. 세션 = 포털 로그인 세션(로그인 성공 판정 ~ 로그아웃·만료).
- 캡차 이벤트도 `rate_counters`에 기록(재시작에 살아남음).
- "마지막으로 본 시각"을 저장해 시계 역행을 감지하고, 역행하면 보수 모드(지연 1.5배, 상한 절반).
- 차단 신호(`blocked` 예약 결과, HTTP 403/429 급증, 연속 추가 인증) → 즉시 중단 + 쿨다운. **거절(refusal)에서 나온 중단은 쿨다운이 아니라 핸드오프**. 쿨다운은 양성 탐지가 2회 연속일 때.
- 프로필은 트리거가 정하고 IR은 더 느린 쪽만 고를 수 있다. `slow`는 `slowFactor` 배수.
- 입력: 기본 `fill()`(즉시). 키 이벤트가 필요한 칸만 **고정 간격 150ms**. 타이핑 모사·지터는 쓰지 않는다. 스텝 간 지연 범위는 요청률 제한이지 행동 모사가 아니며, 문서·UI에서 '사람 수준'이라는 표현을 쓰지 않는다('요청률 상한').
- 캡차 중계: `policy.captchaRelay[portal]`이 허용일 때만 폰으로 보낸다(정부24는 허락 회신 전 비활성이고 공문에 중계 방식을 명시한다).
- 텔레메트리 옵트아웃 사용자의 운영 알림은 로컬 알림으로 대체.

우리가 하지 않는 것(정책 파일에 필드 자체가 없음): UA 변경, 지문 조작, `navigator.webdriver` 조작, 헤드리스, 프록시 로테이션, 타이핑 모사, 캡차 자동 입력.

## 8. 사람 입력 조율 (`human` 스텝)

- 요청: `{runId, stepId, reqId, kind, prompt, imageCrop?(16KB 청크), ttlMs, inputSpec, vaultChallenge?(secret)}`. 라우팅: 데스크톱 활성(최근 입력 60초·포커스) → 로컬, 아니면 라이브 리모트 세션 → 폰(`captchaRelay` 허용 포털만), 둘 다 없으면 `Paused` + 알림.
- 핸드오프 지연 목표는 세 구간으로 나눠 측정한다: `T_detect`(판정까지) ≤ 2초, `T_notify`(알림 도달) ≤ 3초, `T_open`(사용자가 열어 입력 시작)은 측정만. '10초'는 앞 두 구간의 합 + 사용자 반응의 목표치다.
- `kind=secret`의 응답은 엔진에 오지 않는다(폰 → 금고 이중 봉인 → 타이피스트). `captcha`·`otp`·`manual`은 엔진이 받아 입력하고 로그에는 길이만.
- TTL 초과 → 게이트 앞 체크포인트로 되감아 `Paused`. 자동 재요청 없음.

## 9. 감사 저널 (로컬 전용, D07 `run_events`, 해시 체인 + 폰 앵커)

`run.started{mode}`, `step.*`, `gate.*{actionHash}`, `human.*`, `secret.used{kind, viaTypist}`, `model.called`, `decide.result`, `ledger.*{intentId, state}`, `commit_guard.*`, `artifact.saved`, `block.signal`, `cooldown.*`, `run.finished{status}`. 값 없음 원칙.

## 10. 동시성·브라우저

- 포털당 실행 1개. Chrome 창 하나, 탭 분리.
- Chrome 기동: **금고가** `channel:'chrome'`, `ignoreDefaultArgs:true`, `--remote-debugging-pipe`, 전용 `--user-data-dir`, 최소 플래그로 띄우고 파이프의 단독 소유자가 된다(ADR-005 v2, D05 §3). 엔진은 금고가 MessagePort로 중계하는 CDP를 쓴다. **`--remote-debugging-port`는 정책 상수로 금지**한다. `--no-sandbox`·`--disable-extensions` 없음. 기동 시 `navigator.webdriver === true` 자기 점검(거짓이면 자동화 거부, ADR-010). 이 플래그들은 자동화 표식을 지우는 것이 아니라 제어 채널을 여는 것이며, 문서에서 '자동화 플래그 미사용'이라 쓰지 않고 '`--enable-automation` 배너 플래그 미사용, 표식은 그대로'라고 쓴다.
- 이중로그인 감지(`logged_out_by_other_session` 예약 결과) → 일시정지, 자동 재로그인 없음.
- 메모리: 스냅샷은 스텝 종료 시 폐기, 캡차 이미지는 응답 후 즉시 폐기.

## 11. 공개 인터페이스

```ts
interface Engine {
  load(pkg: SignedPackage): Promise<LoadedPlaybook>;
  prepare(pb, inputs, profile, opts: {trigger, intentId?}): Promise<RunPlan>;   // 기본값 확정, 카드 데이터, 업무 중복 경고
  start(plan: RunPlan): RunHandle;  resume(runId): RunHandle;  abort(runId): Promise<AbortResult>;
  on(event, cb): Unsubscribe;
}
interface RunHandle { id; state(); answerGate(d: GateDecision & {actionHash}); answerHuman(stepId, v: HumanAnswer); attestNotCommitted(intentId, note): void; }
```
`HumanAnswer`에는 `secret`이 없다. 비밀은 `VaultClient.typist.*`만.

## 12. 운영 수준(portalMode)과 데몬 권한

- `postprocess`: Chrome·CDP를 **전혀 띄우지 않고** 포털 URL은 `shell.openExternal`로 **사용자의 기본 브라우저**에서 연다(자동화 프로필로 열면 `webdriver=true` 세션이 되어 사용자가 매크로 이용자로 제재받을 수 있다). `guide` 변환(D02 §9), 파일 감시·메타데이터·만료 추적만. 테스트로 "이 모드에서 CDP 연결 0건"을 고정한다(D17).
- `assisted`: 변환 IR을 재검증 후 실행. `human_commit`도 토큰·원장·verify 규칙 동일.
- 수준 변경은 서명 정책 배포로만, 변경 시 사용자 알림.
- 데몬: "시작 동의"(스케줄러 수준)와 "커밋 게이트"는 별개다. `auto`는 `StandingAuthorization{scheduleId, playbookId@major, docType, profileId, maxPerPeriod, expiresAt, userSignature}`에서 엔진이 **건별 단일 사용 토큰**을 만든다. `effects ⊆ {issue_document}`인 플레이북만 허용(V-14). 현실적으로 홈택스 로그인이 사람 없이 끝나지 않으므로(가상키패드·PUSH) Phase 2의 데몬은 `notify`·`semi_auto`만 출시한다(D10).
