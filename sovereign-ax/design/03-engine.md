# D03. 플레이북 엔진

## 1. 책임

IR 로드·검증, 실행, 체크포인트·재개, 게이트 강제, 사람 입력 조율, 복구 계층, 사람 속도 정책 집행, 감사 이벤트 방출, 텔레메트리 요약. 엔진은 `engine` 유틸리티 프로세스에서 돌며 Playwright로 Chrome을 제어한다.

## 2. 실행 상태 머신

```text
            load()            start()
 [Unloaded] ──────▶ [Loaded] ────────▶ [Preparing]  (전제조건·입력 검증·세션 확인)
                                           │
                                           ▼
                      ┌─────────────── [Running:step i] ◀────────────────┐
                      │                 │      │     │                    │
            gate 도달 │     human 도달  │      │     │ 실패               │ 재개
                      ▼                 ▼      │     ▼                    │
              [WaitingGate]     [WaitingHuman] │  [Recovering] ─ 복귀 ──▶ 체크포인트
                      │ 승인/거부        │ 입력/TTL│     │ 실패 상한
                      ▼                 ▼      │     ▼
                 Running / Aborted   Running / Paused  [HandedOff] ──사용자 재개──▶ Running
                                               │
                                               ▼
                               [Completed] | [Failed] | [Aborted] | [Paused]
```

상태 전이 규칙:
- `Running → WaitingGate`는 `gate` 스텝에서만. 승인 없이 `Running`으로 돌아가는 전이는 **존재하지 않는다**(코드상 전이표에 없음). 거부 → `Aborted`. TTL 초과 → `Paused`(재개 시 게이트부터).
- `irreversible` 스텝 진입 전 엔진은 `gateToken`(게이트 승인 시 발급, 실행 ID·스텝 ID·입력 해시에 바인딩, 10분 유효)을 검사한다. 토큰 불일치 → 실행 중단 + 보안 이벤트. 이것이 정적 검증(V-03)의 런타임 이중 안전장치다.
- `Paused`는 디스크에 직렬화된다(실행 컨텍스트: 입력, 변수, 현재 체크포인트, 게이트 토큰 제외). 비밀은 직렬화하지 않는다.
- 사용자는 어느 상태에서든 `abort()` 가능. 비가역 스텝이 "제출 중"이면 완료를 기다린 뒤 중단하고 결과를 기록한다.

## 3. 스텝 실행 루프

```text
for step in plan(currentStep):
  policy.beforeStep(step)            # 사람 속도 지연, 세션·일일 상한 검사, 쿨다운 검사
  audit.emit(step.started)
  try:
    result = handler[step.type](ctx, step)
  except StepError as e:
    result = failurePolicy(step, e)   # retry → recover → handoff/abort/checkpoint
  audit.emit(step.finished, result.code)
  telemetry.count(step.stableId, result.code)
  next = resolveNext(step, result)
```

- `plan()`은 `branch`·`decide.on`·`repeat`를 풀어 다음 스텝을 정한다. 동적 스텝 생성은 없다.
- 핸들러는 순수 함수에 가깝게: `(ctx, step) → StepResult`. `ctx`는 `page`, `vars`, `inputs`(읽기 전용), `profile`(비밀 없음), `policy`, `audit`, `redaction`, `model`, `vaultClient`(핸들 기반), `human`(요청 큐)로 구성된다.

## 4. 체크포인트와 재개

- 체크포인트 = `{name, expect(cond), url?, sessionRequired}`. 등록 시점의 URL과 기대 조건을 저장한다.
- 복귀 절차: (1) 현재 탭에서 `expect` 평가 → 참이면 그 지점부터 재실행, (2) 거짓이면 `url`로 이동 후 재평가, (3) 세션 만료 판정(`screen_state_v1.login_required`)이면 `session` 체크포인트로 상향 복귀, (4) 그래도 실패 → 핸드오프.
- 재실행은 체크포인트 **이후** 스텝만. 체크포인트 이전에 수행된 비가역 스텝은 `runRecord.irreversibleDone[]`에 기록되어 다시 실행되지 않는다(아이덴포턴시 키로 식별).

## 5. 복구 계층

| 계층 | 트리거 | 수단 | 상한 | 출력 범위 |
|---|---|---|---|---|
| L0 재시도 | 셀렉터 미스, 타임아웃 | 백오프 후 같은 스텝 재시도, 셀렉터 후보 순회 | `onFail.retry` ≤ 3 | — |
| L1 판정 | L0 소진, 미지 모달, 상태 불명 | Decisions 번들(`screen_state_v1`, `popup_class_v1`) | 스텝당 2회 | 열거된 결과 중 하나 또는 `unknown` |
| L2 수리 | L1이 "화면은 맞는데 요소를 못 찾음"으로 판정 | Terra에 마스킹된 서브트리 + 실패 셀렉터 + 기대 역할을 주고 **후보 셀렉터**를 받음. 엔진이 후보를 검증(`expect`)한 뒤에만 사용 | 실행당 `handoffAfter`(기본 1) | 셀렉터 문자열 목록만. 네비게이션·제출 도구 없음 |
| L3 핸드오프 | L2 실패, 캡차 TTL 초과, 보안 경고 | 사람에게 화면 전달, 재개 지점 명시 | — | — |

L2 세부:
- Terra에 주는 도구: `get_a11y_subtree(scopeId, maxBytes)`, `find_candidates(role, nameRegex)`, `propose_selectors(list)` 세 가지. 모두 읽기 전용이고 `propose_selectors`는 결과를 돌려줄 뿐 적용하지 않는다.
- 적용은 엔진이 한다: 후보를 순서대로 `expect` 검사 → 통과한 첫 후보로 스텝 재실행 → 성공하면 `selectorRepairs` 텔레메트리(stable_id, 후보 형태만) → 레지스트리 핫픽스 후보로 올라간다.
- L2가 고친 셀렉터는 **이 실행에서만** 유효하다. 영속 반영은 사람이 검토한 핫픽스 패키지로만(D12 §4).

## 6. 사람 속도 정책 (운영 정책 집행)

정책은 서명된 `policy.json`으로 배포되며 플레이북은 완화할 수 없다(강화만 가능).

```json
{
  "version": "2026.10",
  "pace": {
    "interactive": {"stepDelayMs": [800, 2500], "keyEventDelayMs": [90, 260], "afterNavSettleMs": [600, 1500]},
    "daemon":      {"stepDelayMs": [1200, 3500], "keyEventDelayMs": [120, 300], "afterNavSettleMs": [800, 2000]}
  },
  "limits": {
    "hometax": {"perSession": 10, "perDay": 20, "concurrent": 1},
    "gov24":   {"perSession": 5,  "perDay": 20, "concurrent": 1},
    "sminfo":  {"perSession": 2,  "perDay": 5,  "concurrent": 1}
  },
  "retries": {"stepMax": 3, "runMax": 1, "backoff": "full_jitter", "baseMs": 800, "capMs": 10000},
  "portalMode": {"hometax": "auto", "gov24": "postprocess", "sminfo": "postprocess", "insure4": "postprocess"},
  "cooldown": {"onBlockSignalHours": 24, "onCaptchaBurst": {"window": 10, "count": 3, "action": "slow+notify"}},
  "daemonWindowJitterMin": 30
}
```

집행 지점:
- `policy.beforeStep`: 균등 분포 지연(지터 포함), 상한 카운터(SQLite `rate_counters`) 증가·검사, 쿨다운 중이면 실행 거부(사용자에게 이유 표시).
- `fill` 핸들러: 기본은 `fill()`로 즉시 입력한다. 사람 타이핑을 흉내 내는 글자당 지연은 **쓰지 않는다**(평균 타자 속도보다 빠른 모사는 그 자체가 표식이고, 모사는 우리 원칙과 맞지 않는다). 키 이벤트가 필요한 칸(`keyEvents: true`, 보안 모듈·비밀 타이피스트)만 90~260ms 간격. 커널 드라이버 기반 키보드 보안이 걸린 칸은 합성 입력이 닿지 않으므로 `human`으로 넘긴다.
- 레이트 제한: 포털별 토큰 버킷(세션·일일)과 카운터는 SQLite에 영속해 크래시 후에도 이어진다. 재시도는 Full Jitter 백오프, 스텝당 최대 3회.
- 차단 신호 감지: `screen_state_v1.blocked`·`security_warning` 결과, HTTP 403/429 급증, 연속 추가 인증 요구 → 즉시 중단, `cooldown` 기록, 사용자 알림, 텔레메트리 `block_signal`.
- 캡차 버스트: 10분 창에 3회 이상 → 지연 범위 1.5배, 세션 상한 절반, 운영팀 알림.
- 데몬 프로파일은 더 느리고, 실행 시각 ±30분 지터.

우리가 하지 않는 것(정책 파일에 필드 자체가 없음): UA 변경, 지문 조작, `navigator.webdriver` 조작, 헤드리스, 프록시 로테이션, 타이핑 모사, 캡차 자동 입력.

## 7. 사람 입력 조율 (`human` 스텝)

- 요청 객체: `{runId, stepId, kind, prompt, imageCrop?(캡차), ttlMs, inputSpec}`.
- 라우팅: 데스크톱 활성(최근 입력 60초 이내 또는 창 포커스) → 로컬 UI. 아니면 리모트 세션이 살아 있으면 폰. 둘 다 없으면 즉시 `Paused` + 알림.
- 응답 처리: `kind=secret`은 응답이 엔진에 오지 않는다. 폰 → 릴레이 → 데스크톱 `vault`로 직접 복호화되어 타이피스트가 입력한다(D05 §5, D08 §6). `captcha`·`otp`·`manual`은 엔진이 값을 받아 `fill`한다. 감사 로그에는 값 대신 길이와 해시 앞 4자만.
- TTL 초과 → 체크포인트 복귀 후 `Paused`. 자동 재요청 없음.

## 8. 게이트 카드

- 템플릿 ID(`invoice.confirm`, `doc.issue.confirm`, `daemon.renew.confirm`)별 렌더러가 데스크톱·모바일 양쪽에 있다. 카드는 `fields`에 열거된 변수만 보여준다.
- 승인 결과: `{approved, at, channel: local|mobile, gateToken}`. 토큰은 HMAC(runKey, runId|stepId|inputsHash|exp).
- 묶음 승인(Phase 3 일괄 발급)은 카드 하나에 N건을 나열하고 토큰을 건별로 발급한다. 토큰 없는 건은 실행되지 않는다.

## 9. 감사 이벤트 (로컬 전용, D07 `run_events`)

| 이벤트 | 필드(값 없음 원칙) |
|---|---|
| `run.started` | runId, playbookId@version, profileId, trigger(local/remote/daemon), inputsHash |
| `step.started/finished` | stepId, type, code, durationMs, attempt |
| `gate.requested/approved/denied/expired` | stepId, channel, cardId |
| `human.requested/answered/expired` | stepId, kind, channel, answerLen |
| `secret.used` | secretKind, viaTypist(bool) — 값·길이 없음 |
| `model.called` | layer(L1/L2), bundleId 또는 toolset, inputBytesRedacted, redactionCount, latencyMs, cost |
| `decide.result` | bundleId, outcome, confidence(소수 2자리) |
| `irreversible.executed` | stepId, idempotencyKey(해시), verified(bool) |
| `artifact.saved` | docType, path(상대), bytes, sha256 |
| `block.signal` / `cooldown.started` | reason, until |
| `run.finished` | status, totalMs, l1Calls, l2Calls, handoffs |

이벤트는 해시 체인(`prevHash`)으로 연결해 로컬 변조를 탐지할 수 있게 한다(D11).

## 10. 동시성과 자원

- 포털당 실행 1개. 다른 포털은 병렬 가능하되 Chrome 창은 하나(탭 분리).
- Chrome은 `launchPersistentContext({channel: 'chrome', ignoreDefaultArgs: true, args: ['--remote-debugging-pipe', '--user-data-dir=<전용>', …최소 플래그]})`로 띄운다. `--no-sandbox`와 `--disable-extensions`는 넣지 않는다(확장 기반 보안 모듈 호환). Chrome 136+는 전용 `user-data-dir`을 요구한다. 파이프 연결이라 `navigator.webdriver=true`가 노출되며 이를 바꾸지 않는다(ADR-010). 앱 종료 시 Chrome도 종료. 비정상 종료 복구: 다음 시작 시 잠금 파일 정리 후 세션 쿠키는 유지(사용자 로그인 유지 가치) — 단 `profile.keepSession=false`면 매번 삭제.
- 메모리: 접근성 트리 스냅샷은 스텝 종료 시 폐기. 캡차 이미지는 응답 후 즉시 폐기.

## 11. 공개 인터페이스 (TypeScript 시그니처 초안)

```ts
interface Engine {
  load(pkg: SignedPackage): Promise<LoadedPlaybook>;         // 서명·스키마·정적 규칙 검증
  prepare(pb: LoadedPlaybook, inputs: Inputs, profile: ProfileRef): Promise<RunPlan>; // 전제조건, 카드 데이터
  start(plan: RunPlan, opts: {trigger: 'local'|'remote'|'daemon'}): RunHandle;
  resume(runId: string): RunHandle;
  abort(runId: string): Promise<void>;
  on(event: EngineEvent, cb): Unsubscribe;
}
interface RunHandle { id: string; state(): RunState; answerGate(token: GateDecision): void; answerHuman(stepId, value: HumanAnswer): void; }
```

`HumanAnswer`에는 `secret`이 없다. 비밀 응답은 `VaultClient.typist.fillFromRemote(sessionId, stepId)`로만 처리된다.

## 12. 운영 수준(portalMode)과 세션 종료 처리

- `policy.portalMode[portal]`이 `postprocess`면 엔진은 Playwright를 띄우지 않고 `guide` 변환(D02 §10)을 렌더러에 넘긴다. 파일 감시기가 저장된 PDF를 보관함으로 옮기고 `docparse`가 메타데이터를 만든다. 감사 로그 `run.started.mode = postprocess`.
- `assisted`면 로그인 구간과 비가역 스텝이 `human(kind=manual)`로 치환된 플랜을 실행한다.
- 수준 변경은 정책 서명 배포로만 가능하고, 변경 시 사용자에게 알린다.
- 홈택스 이중로그인: `screen_state_v1.logged_out_by_other_session ≥ 0.85`면 `session` 체크포인트로 복귀하지 않고 **일시정지**한다. 자동 재로그인으로 상대 세션을 끊지 않는다. 사용자가 "재개"를 누르면 로그인부터 다시.
- 화면 잠금·절전·RDP 끊김 중 헤드풀 Chrome의 안정성은 S14에서 확인하고, 실패 모드별 재개 규칙을 추가한다.
