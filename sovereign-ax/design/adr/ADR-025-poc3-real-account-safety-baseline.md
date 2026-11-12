# ADR-025. PoC-3 실계정 진입 안전 기준선: 앱이 집행하는 PoC 상한, 안전 쪽 실패 해석, 실비밀 경로 하나

> 상태: 채택(2026-11-03) · **결정 1의 PoC 상한은 없앴다(대표 결정 2026-11-12, 아래 상태 메모)** · 관련: ADR-005, ADR-010, ADR-014, ADR-017, ADR-021, D01 §2.1·§3, D02 §4.4·§8, D03 §5·§6·§7, D05 §3·§8, D07 §1.3, D11 §4, D13 §2·§3·§4·§6, D18 §1·§3·§4, [PoC-1 위험 수용 기록](../../../poc/reports/PoC-1-risk-acceptance.md), [RETRO-2026-11-02](../../../poc/reports/RETRO-2026-11-02.md) A-01·A-02·A-04·A-05·A-12·B-04·B-07
> 근거: [AUDIT-D](../../research/AUDIT-D-v13-poc-security.md) N-01·02·03·04·05·12·14·16·17·18·20·23·24·29·43·44·45·47·51·57·58·68·77·78(24건) = [D19 §3.5](../19-attack-surface.md) D-04·05·06·07·08·09·10·11·12·13·14·15·17·28·29·33·37·38·39·41·44·48·49·53

## 상태 메모(2026-11-12)

- 대표 결정은 "우리가 설정한 상한은 웬만해선 닿지 않게 풀어"다. 실제 고객 PoC 단계라 결정 1의 PoC 상한을 엔진에서 지웠다.
- 지운 것은 `POC_BUILD`, `POC_OVERRIDES`(하루 실행 20, 하루 발급 1, 하루 로그인 3, 양성 1회 쿨다운), 누적 실발급 3건(`policy.poc_irreversible_total`)이다.
- 엔진 내장 홈택스 상한은 하루 실행 100, 하루 발급 50, 세션당 실행 30, 하루 로그인 12다. 정책 스키마 최대값과 같다.
- 엔진 내장 쉬기는 양성 2회에 24시간이다(D03 §7 기본값). 시범의 양성 1회만 지웠다. 받은 정책이 1이면 1회에 쉰다.
- 분당 이동 12, 동시 실행 1, 추가 인증 연속 2, 모르는 화면 누적 규칙(결정 3), 원장 규칙은 그대로다.
- 엔진은 받은 서명 정책과 엄격한 쪽으로 합친다. 운영 레지스트리 정책 2026.11(monotonic 1)은 홈택스 20·1·3·양성 1이다. 새 판을 정책 키 2-of-3으로 서명해 게시하기 전까지 고객 PC의 실효 상한과 쉬기는 그 값이다.
- 누적 3건 상한은 다른 건의 미결(in_doubt) 발급이 남아 있을 때 새 발급 시작을 막던 유일한 장치였다. 이제 새 발급은 승인 카드의 업무 중복 경고(같은 업무 키)로만 미결 건을 알린다. 같은 의도의 재시도는 원장 규칙이 그대로 막는다.
- 결정 3의 "PoC 빌드에서는 곧 24시간 쿨다운"과 UX 영향의 PoC 상한 문구 두 줄은 더 이상 맞지 않는다. 하루 발급 상한 문구는 "오늘 홈택스 발급 건수 상한에 닿아 멈췄어요. 아무것도 발급하지 않았어요. 내일 다시 할 수 있어요."다.

## 맥락

- PoC-3은 실제 홈택스, 실제 공동인증서, 관계사 실영업 법인 계정을 처음 쓴다. 대표가 서명할 위험 수용 기록은 "하루 20회·실발급 2~3건·신호 1회 즉시 중단·24시간 쿨다운"을 약속한다. 앱 정책은 40회·30건·연속 2회다(N-01). 어느 항목을 앱이 지키고 어느 항목을 사람이 지키는지도 적혀 있지 않다.
- 실패 해석이 위험 쪽으로 기울어 있다.
  - 실패 신호가 CSS 셀렉터 하나라 성공 안내 레이어도 "발급 안 됨"이 될 수 있다(N-02).
  - 차단 사전이 빈 동안 홈택스 안내 화면은 일반 실패로 끝나 쿨다운에 닿지 않는다(N-03, N-16).
  - 예상된 2차 인증은 거꾸로 차단 신호가 된다(N-14).
  - 오염 상태에서는 본문 신호 탐지가 소리 없이 꺼진다(N-20).
  - 메일 상태 '전송실패'가 '보냈음'이 된다(N-58).
- 실비밀이 지나는 길에 구멍이 있다: 하드닝 안 된 진입점(N-24), 렌더러가 여는 비밀 창(N-44), 자식 프로세스 env 상속(N-23), Crashpad 로컬 덤프(N-04), 녹화(N-05), 테스트 비밀 전용 누출 스캐너(N-17), 1회 캐시된 프로필 점검(N-18), 가상키패드 첫 클릭에 닫히는 비밀 창(N-47), 실 루트를 덮는 스모크(N-57).
- 같은 PR 범위에서 값싸게 닫히는 것을 함께 정한다. 금고 중계 위생(N-12 MHTML, N-51 쿠키 헤더, N-78 알려진 값 보관, N-43 창 상태 머신, N-45 다운로드 경로)과 프로세스 경계(N-29 단일 인스턴스, N-68 docparse 대화상자, N-77 IPC 모양)다. 감사 분류는 Phase 1이지만 실 쿠키·실 비밀이 흐르기 시작하는 시점이 PoC-3이라 앞당긴다.
- 제약: 사용자 마찰은 0이거나 줄어야 한다. 캡차 풀이·탐지 회피·정부24 자동화는 다루지 않는다.

## 결정

1. **PoC 상한은 앱이 집행한다(N-01, D-04).** `engine/policy.ts`에 PoC 브랜치 상수 `POC_BUILD = true`와 `POC_OVERRIDES`를 둔다. 홈택스 정책은 **엄격한 방향으로만**(`Math.min`) 덮는다: `runsPerDayPerProfile 20`, `irreversiblePerDayPerProfile 1`, `loginsPerDay 3`, `positiveDetectionsForCooldown 1`. `EXTRA_AUTH_FOR_SIGNAL`은 2로 둔다(1이면 2차 인증이 상시인 로그인마다 멈춘다). 원장 `committed|in_doubt|armed|dispatched` 누적이 3건이면 `policy.poc_irreversible_total`로 시작을 거부한다(재시작·날짜 무관). 시간대 제한은 앱이 집행하지 않는 사람 규칙으로 위험 수용서에 적는다. 앱은 단일 인스턴스다(`requestSingleInstanceLock`, N-29의 PoC 부분, D-41).
2. **실패 신호는 (셀렉터, `^…$` 문구) 쌍이다(N-02, D-05).** `PortalConfig.failureSignal: Array<{ css; text }>`. 문구 패턴이 없거나 앵커가 없으면 `portalProblems`가 `unanchored:failureSignal`로 실행을 막는다. 클릭 뒤 새로 보이고 문구까지 맞는 요소만 `not_committed` 근거다. PoC-3 S1 산출물 형식을 이 쌍으로 고정한다.
3. **모르는 화면은 쌓인다(N-03, D-06).** 기대 화면(체크포인트)에 닿지 못하고 끝난 실행은 `unknown_screen_streak`을 올린다. 2회 연속이면 보수 모드(지연 ×slowFactor, 상한 절반), 3회 연속이면 양성 탐지 1회로 센다(PoC 빌드에서는 곧 24시간 쿨다운). 네비게이션 뒤 문서 경로가 기대 경로 집합(`issueForm`·`invoiceLookup.path`·`mailLookup.path`·로그인 경로) 밖이고 대기열 신호도 아니면 `portal.unexpected_page`로 멈춘다. 차단 사전이 비어 있으면 시작 때 `run.signal_dict_empty`를 남기되 시작을 막지는 않는다.
4. **예상된 2차 인증은 차단이 아니다(N-14, D-09).** 로그인 구간(`RunPolicy.enterLogin()`~`leaveLogin()`)의 추가 인증은 연속 횟수에 넣지 않고 핸드오프(`portal.mfa_pending`)로만 끝낸다. 로그인 성공은 `extra_auth_streak`을 0으로 되돌린다. 로그인 밖 반복 추가 인증의 종료 코드는 `portal.extra_auth_repeat`이다. 이 코드는 `portal.blocked`와 구분하고 D18 §3 공문 보고 기준에서 뺀다.
5. **포털이 한 말을 보여 준다(N-16, D-10).** 실행이 닫은 마지막 대화상자 문구(NFKC, 200자)는 실행 메모리에만 둔다. 실패·핸드오프 종료 이벤트의 `portalNotice`로 셸 카드에 보인다. 저널·텔레메트리·모델에는 넣지 않는다. `step.target_not_found`·`checkpoint.expect_failed`는 "예상한 홈택스 화면이 아니에요" 문구로 바꾼다. 반복 시 확인 클릭은 두지 않는다.
6. **확인할 수 없으면 승인하지 않는다(N-20, D-13).** 엔진의 화면 확인 식은 고정 문자열 `SIGNAL_INSPECT_EXPR` 하나다. 금고는 오염 상태에서 그 식(SHA-256 `712e733067b2ccebb89ea8e1da5089577095c3954da089592bbb9ee3ec598944`)만 정확 일치로 거부 패턴에서 면제한다(`document.body.innerText`는 입력 값을 포함하지 않는다). 금고가 거부하면 엔진은 `signal.inspect_unavailable{reason}`을 남긴다. 게이트 직전·커밋 직전이면 `handoff(portal.unobservable)`로 멈춘다.
7. **verify·메일 판정은 부정 우선이다(N-58, D-39).** 메일 상태는 NFKC·공백 제거 뒤 `실패|미전송|대기|오류|…중$`이면 `not_committed`, 정확 허용 목록(`전송완료`·`발송완료`, PoC-3 실측으로 확정)이면 확인, 그 밖은 `unknown`이다.
8. **실비밀 진입점은 하드닝된 셸 하나다(N-24·N-68, D-37·D-44).** 두 main(`shell-app.ts`, 개발 콘솔 `main.ts`)은 같은 `hardenApp()`/`hardenWindow()`를 부른다.
   - ready 전 디버그 스위치 9종(`remote-debugging-port`·`remote-debugging-pipe`·`remote-allow-origins`·`enable-logging`·`log-file`·`inspect`·`inspect-brk`·`inspect-port`·`js-flags`)이 있으면 종료한다.
   - 권한 요청, 새 창·이동·리디렉트·webview를 거부한다. `content-bounds-updated`를 막고 배율을 고정한다.
   - `ApprovalBar` 생성자도 스위치를 검사한다.
   - 개발 콘솔의 옛 `vault-port` 기동·수동 `browser.open`·`secret.openInput`은 지운다(RETRO A-02·B-04 일부). PoC-3 실 홈택스 시험은 `pnpm start:hometax`(= `startShell({ engine: { portal: { kind: 'hometax' } } })`)로만 한다.
   - 엔진은 `vault-port`를 받으면 `fatal(engine.vault_port_unsupported)`.
   - docparse 창은 `disableDialogs: true`(N-68).
9. **자식 프로세스는 깨끗한 환경으로 뜬다(N-23, D-14).** 모든 `utilityProcess.fork`에 `env: childEnv()`(허용 목록)와 `execArgv: []`를 준다. 엔진은 첫 import에서 `DEBUG`·`DEBUG_FILE`·`PWDEBUG`·`NODE_OPTIONS`·`NODE_EXTRA_CA_CERTS`·`SSLKEYLOGFILE`·`NODE_TLS_REJECT_UNAUTHORIZED=0`이 보이면 `fatal(engine.env_tampered)`로 기동을 거부한다. egress도 TLS 변조 변수를 보면 모델·odcloud 호출을 끈다(`egress.env_tampered`). Electron은 utilityProcess에 execArgv를 상속하지 않지만(검증자 정정) 명시값으로 고정한다.
10. **비밀 창은 금고가 부른다(N-44, D-15).** 대상은 금고가 입력하는 홈택스 아이디·비밀번호와 보안카드다. 공동·금융인증서 비밀번호는 사용자가 전용 Chrome의 홈택스 칸(가상키패드)에 직접 넣고, 타이피스트·비밀 창은 쓰지 않는다(ADR-020 결정 2, D05 §2: 금고 `SECRET_ORIGINS.cert_password`에 실 포털 origin이 없다). 타이피스트가 비밀이 없으면 금고가 control 포트로 `secret.needed{runId, targetId, kind, scope, row?}`를 보내고 main만 창을 연다. 렌더러 IPC `secret.openInput`은 없다. main은 `secretInput` 포트를 `{runId, kind, scope, row?}`와 함께 넘기고, 금고는 그 포트에서 그 값으로 1회만 받는다. 1회용 비밀은 5분 또는 `run.end`에서 0으로 덮어 지우고 `secret.expired`를 보낸다. 창은 동시에 하나이고 메인 창의 모달이며 제목줄·OS 프레임이 있다(제목 `금고 · <라벨>`). 라벨은 main 내장 표다(N-11의 PoC 부분).
11. **비밀 창 개시 조건은 열 때마다 본다(N-18·N-47·N-43, D-12·D-53·D-28).** Preferences·확장·Google 로그인을 `fill`·`openForHuman` 첫 줄에서 다시 읽는다(수 ms). 거부하면 `secret_window.refused{reason}`를 엔진·main에 보낸다. 사람 입력 창 종료 조건 (나)는 "blur + 값 있음이 1.5초 동안 값 길이·포커스 변화 없이 유지"다(N-47). 엔진의 `requestClose`는 human 창만 닫을 수 있고 창 개시 검사는 원자적이다(N-43).
12. **누출은 실사용에서도 본다(N-17, D-11).** PoC-3은 실비밀 전에 같은 화면에서 테스트 비밀로 캡처·`scanDir(paths.root)` 0건을 확인한다. 금고는 알려진 값 치환이 적중하면 `secret_window.leak_suspected{hits}`를 보내고, 엔진은 커밋 전이면 `failed(vault.leak_suspected)`로 멈춘다. 비밀 사용 직후 금고가 그 값으로 `logs\`·`staging\`을 스캔해 건수만 `vault.leak_scan{files, findings}`로 남긴다(PoC 빌드). 진단 내보내기의 형식 기반 검사는 Phase 1이다(D12 §5).
13. **전용 Chrome 잔존물을 만들지 않는다(N-04·N-05·N-45, D-07·D-08·D-29).**
    - Chrome 인자 허용 목록에 `--disable-breakpad`를 넣는다. 금고가 기동 전·종료 시 `<profile>\Crashpad\`를 지운다(`vault.chrome_dump_removed{count}`). 크래시 유도 누출 시험을 더한다.
    - 화면 영상은 로그인·비밀 창 구간을 찍지 않는다(로그인은 녹화 밖에서 하고 세션을 이어 쓴다). 스파이크 산출물은 `%LOCALAPPDATA%\SovereignAX\spikes\` 한 곳(사용자 전용 DACL, OneDrive 밖, 누출 스캔 대상, 12-31 삭제)에 둔다.
    - 다운로드 경로는 Phase 1에 금고가 `staging\`으로 고정한다(N-45: Preferences `download.default_directory`·`savefile.default_directory` 기록·검증 + `Browser.setDownloadBehavior{eventsEnabled}`).
14. **중계 위생을 앞당긴다(N-12·N-51·N-78, D-17·D-33·D-49).**
    - `Page.captureSnapshot`·`Page.getResourceContent`·`DOMSnapshot.getSnapshot`은 상시 거부한다(Playwright 기본 흐름은 쓰지 않는다).
    - `Network.*ExtraInfo`·`requestWillBeSent`·`responseReceived`의 `Cookie`·`Set-Cookie`·`Authorization` 헤더와 `associatedCookies`·`blockedCookies`·`headersText`를 제자리에서 지운다.
    - `Network.getResponseBody`·`Fetch.getResponseBody`를 허용 목록에서 빼고 `Network.getResponseBodyForInterception`·`Network.streamResourceContent`를 거부한다.
    - 알려진 값 변형은 타깃별 집합으로 두고 창 종료·실행 끝에서 지운다. 이것이 보조 위생 장치임을 D05에 적는다.
    - 오염 상태 `Runtime.getProperties` 값 항목 정리는 Phase 1이다.
15. **프로세스 사이 메시지는 모양을 본다(N-77, D-48).** RETRO A-04(run.begin trigger 열거형)에 더한다. 금고 `typist.fill`은 trigger 허용 목록(`local`·`remote`)으로 뒤집는다. main은 `gate.request`를 `isGateRequest`로 거른 뒤에만 바에 넘기고, 예외는 `gate.malformed`로 게이트를 닫는다. `secret.provide.kind`는 `SECRET_ORIGINS` 키만 받는다. `ipc/*.schema.json`은 Phase 1이다.
16. **시험이 실 데이터를 건드리지 않는다(N-57, D-38).** `tests/app-smoke.ts`는 두 단계 모두 임시 루트로 띄우고, 실 루트에 `db\db.sqlite`가 있으면 시작하지 않는다.

## 대안과 기각 이유

| 대안 | 기각 이유 |
|---|---|
| 차단 사전이 비면 시작 거부(N-03 원안 (1)) | 공개 근거가 없어 PoC-3 실측 전에는 채울 수 없다. 기준선이 PoC-3 자체를 막는다 |
| 차단 뒤 "상태를 확인했어요" 클릭 필수(N-01 (3)·N-16 (2)) | 정상 사용자에게 클릭이 생긴다. 보수 모드·쿨다운이 같은 효과를 마찰 없이 낸다 |
| 추가 인증 1회 = 차단(`EXTRA_AUTH_FOR_SIGNAL 1`) | 아이디 로그인 2차 인증이 상시면 매 로그인이 멈춘다 |
| 시간대 제한을 코드로 집행 | PoC에 무인 실행이 없다. 사람 규칙으로 정직하게 적는다 |
| 오염 상태 `Runtime.getProperties` 전면 거부 | Playwright 핸들 배열 풀기가 깨진다. 값 항목 정리로 Phase 1에 한다 |
| 새 RPC `vault.readVisibleText` | 고정 식 다이제스트 면제로 같은 효과를 내고 표면이 늘지 않는다 |
| 전용 암호화 녹화기·만료 파일명 지금 구현 | M3-2(Phase 1) 범위다. PoC는 "찍지 않음 + 한 폴더 + 스캔"으로 충분하다 |
| 타깃 단위 비동기 뮤텍스 | 동기 개시 표시로 충분하다(검증자 정정) |

## 결과

### 보안 영향

| 주체 | 닫는 것 |
|---|---|
| 포털 사건(공격자 없음) + 테스터 재시도 | 이용 제한 상태 계정에 반복 접근(N-03·N-16), 2차 인증 오경보로 공문 채널 남용(N-14), 위험 수용서와 다른 상한(N-01), 거짓 "발급 안 됨"으로 재발급 유도(N-02), 거짓 "메일 보냄"(N-58) |
| E 엔진 RCE | 쿠키 헤더 수집(N-51), MHTML·리소스로 비밀 칸 수집(N-12), 타이피스트 창 강제 종료(N-43), `DEBUG_FILE`로 CDP 전문 평문 기록(N-23), 신호 탐지 맹점 이용(N-20) |
| R 렌더러 침해 | `secret.openInput`으로 라벨 위조·창 남발(N-44), 개발 콘솔 경로 이용(N-24) |
| M 같은 OS 사용자(경계 밖, 흔적만 줄임) | Crashpad 덤프·녹화·HAR·스모크 산출물의 평문 잔존(N-04·N-05·N-57), 금고 힙의 장기 평문(N-44·N-78) |
| 운영자 실수 | 테스트 비밀 전용 탐지기로 실비밀 누출을 놓침(N-17), 세션 중 Google 로그인(N-18), 두 번째 인스턴스(N-29) |

남는 것: 홈택스 차단·추가 인증·캡차 문구는 PoC-3 실측 전까지 비어 있다. 모르는 화면은 보수 모드·쿨다운으로 막지만 "차단을 봤다"는 보고는 할 수 없다(D19 §8).

### UX 영향(사용자 화면 문장 그대로)

- PoC 상한: "오늘은 PoC 기간 하루 발급 상한(1건)에 닿았어요. 내일 다시 할 수 있어요." / "PoC 기간 전체 실발급 상한(3건)에 닿아 더 발급하지 않아요."
- 모르는 화면: "예상한 홈택스 화면이 아니에요. 전용 Chrome 창에 뜬 안내를 확인해 주세요. 아무것도 발급하지 않았어요." 2회 연속 뒤 카드 꼬리: "홈택스 화면을 연달아 알아보지 못해 당분간 천천히, 횟수를 줄여 실행해요."
- 경로 밖 화면: "홈택스가 예상하지 못한 화면으로 보내 멈췄어요. 전용 Chrome 창의 안내를 확인해 주세요. 아무것도 발급하지 않았어요."
- 포털 문구: 카드 한 줄 "홈택스 안내: “{문구}”"(문구는 텍스트로만 넣는다).
- 반복 추가 인증: "홈택스 추가 인증이 반복돼 앱이 스스로 멈췄어요(차단 신호는 아니에요). 홈택스에서 직접 인증을 마친 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요."
- 쿨다운("두 번 연속" 삭제): "홈택스 차단·경고 신호가 보여 24시간 동안 홈택스 실행을 쉬어요. 아무것도 발급하지 않았어요."
- 확인 불가: "홈택스 화면을 확인하지 못해 승인을 열지 않았어요. 아무것도 발급하지 않았어요."
- 누출 의심: "보안 점검에서 이상이 보여 멈췄어요. 아무것도 발급하지 않았어요. 앱을 다시 시작해 주세요."
- Google 로그인: "전용 Chrome에 Google 계정이 로그인돼 있어 비밀번호 창을 열지 않았어요. 전용 Chrome에서 로그아웃한 뒤 다시 준비해 주세요."
- 비밀 창: 제목줄 "금고 · 홈택스 비밀번호"(종류 라벨은 main 내장 표), 첫 줄 "세금계산서 발급 · 홈택스 · {프로필 이름}", 아래 고정 문구 "앱은 대화창 안에서 비밀번호·카드 번호를 묻지 않아요."
- 비밀 만료: "입력한 비밀번호를 5분 안에 쓰지 않아 지웠어요. 필요할 때 다시 물어볼게요."
- 그 밖(실패 신호 쌍·메일·Crashpad·env·헤더·중계 위생·단일 인스턴스)은 화면 변화가 없다. 두 번째 실행은 기존 창을 앞으로 가져온다. 사용자가 미리 버튼으로 비밀 창을 열어 둘 필요가 없어진다.

### 후속

- PoC-3 S1 산출물: 실패 문구 쌍, 차단·추가 인증·캡차 문구/URL 최소 1건씩(실측 또는 고객센터 안내 인용), 메일 상태 문구, 로그인 경로 집합, `auth_failed` 문구.
- Phase 1 진입 시: `POC_BUILD=false`, `ipc/*.schema.json` 3종, `Runtime.getProperties` 값 정리, 다운로드 경로(N-45), 진단 내보내기 형식 검사, 개발 콘솔 `main.ts` 전체 삭제(B-04), 암호화 스파이크 레코더(M3-2).
- RETRO B-07(Windows 실기기 1회) 체크리스트에 "Crashpad 폴더 0", "레지스트리 `usagestats=0`", "단일 인스턴스" 확인을 넣는다.
- 문서 반영: D01 §2.1·§3·§7, D03 §2·§5.3·§5.6·§6·§7, D05 §3.3~§3.8·§8, D07 §1.3, D11 §4, D13 §2·§3·§4·§6, D18 §1·§3·§4, PoC-1 위험 수용 기록 §2·§3, ADR-014 머리말.
