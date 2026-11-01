# PoC-6 H-01 발급 플레이북 — 맥 선행분(홈택스 없는 부분) 결과

- 날짜: 2026-11-01 · 브랜치 `claude/focused-meninsky-2c5965` · 폐기 전제 코드(ADR-017)
- 범위: 홈택스와 무관한 부분을 먼저 만들었다. PoC-3이 로그인 순서·셀렉터·`signFlow`를 넘기면 실제 페이지만 붙이면 된다. **실발급(관계사 실거래 소액 2~3건)은 하지 않았다.** 정부24 자동화, 캡차 풀기, 탐지 회피는 하지 않는다.
- 환경: macOS arm64 개발기, Electron 45.1.0. Windows 11 확인은 아직 하지 않았다(§6).
- 실행: `cd poc && pnpm demo`(셸 + 가짜 H-01 페이지, 실행 Chrome이 화면에 뜬다. 숨기려면 `SAX_DEMO_HEADLESS=1`), `pnpm demo:e2e`(셸 e2e → `reports/raw/poc-6/shell/`).
- 결과: 셸 e2e 51/51(`reports/raw/poc-6/shell/shell-e2e.json`), 전체 테스트 210/210(엔진 H-01 20건, 셸 실행·해석 11건, 승인 경계 정적 3건 포함), `pnpm build`·`lint` 통과.
- 검수: Opus 2회(1차 엔진 골격 15건, 2차 셸 연결 8건). 모두 반영했다(§8).

## 1. 합격 기준 대조(D14 §0 PoC-6)

| 기준 | 맥 선행분 | 남은 것 |
|---|---|---|
| 커밋 랜드마크 전체 readback | s19b: 랜드마크(`#invoice-form`) 안 13칸을 DOM 값과 Playwright aria 스냅숏 값으로 읽어 정규화. 둘이 다르면 멈춤 | 홈택스 셀렉터·랜드마크(PoC-3). 숨은 칸·`readbackOf` 3값 대조 |
| `supplierBizNo == $profile.bizNo` | s19c `readbackEquals` assert. 다르면 게이트를 열지 않는다(e2e "공급자 불일치") | — |
| 게이트 토큰(근거는 main 승인 바, 렌더러 승인 경로 없음) | 승인 바가 `LocalApproval` v2를 발급해 main↔엔진 전용 게이트 포트로 보내고, 엔진이 열린 게이트와 맞춰 본 뒤 토큰을 만든다. 중계 통로로 온 승인은 `forbidden_channel` + 보안 이벤트 | Windows OS 입력 시험(§6) |
| 원장 `(intent_id, step_id)` | `irreversible_log` 행: armed → dispatched → committed / not_committed / in_doubt. 토큰 소비와 armed는 한 트랜잭션(`synchronous=FULL`) | — |
| verify(게이트 직전 기준선 대비 새 1건) | 기준선 조회 → 클릭 → 최소 경과·횟수만큼 다시 조회, 새 1건이면 committed. 부재 증거 + 클릭 뒤 새로 보인 실패 문구가 함께 있을 때만 not_committed, 나머지는 in_doubt | 홈택스 발급목록 조회 화면(PoC-3) |
| 홈택스 자동 이메일 + 메일발송목록 verify | s33: 승인번호로 메일발송목록 조회. 못 찾으면 "발급 완료, 메일 확인 필요"(completed_with_issues) | 실제 메일 수신 확인 |
| 실거래 verify 일치, 중복 0건, 이메일 수신 | 가짜 페이지에서 승인번호·값 일치, 같은 건 두 번째는 `$dup` 경고 | **실발급 2~3건(이 브랜치 범위 밖)** |

## 2. 무엇을 만들었나

| 영역 | 파일 | 내용 |
|---|---|---|
| 게이트 해시 | `packages/engine/src/gate.ts`(`@sax/engine/gate`) | D03 §3 식. main과 엔진이 같은 함수를 쓴다(§3). `GateRequest` v2, `LocalApproval` v2, 게이트 포트 메시지, `gateSelfCheck`, `buildGateRequest` |
| 원장 | `packages/db/src/ledger.ts`, 스키마 v2 | `RunRepo`·`GateRepo`(open → approved/denied/expired → consumed)·`Ledger`·`RunJournal`(해시 체인). 공급받는자·받는 이메일 HMAC 열(`ledgerHmacKey = HKDF(DB 키, 'SAX-ledger-hmac-v1')`). 평문 거래처·이메일은 원장에 없다 |
| 플레이북 | `packages/engine/src/h01/playbook.ts`·`portal.ts`·`runner.ts` | D02 §8 s10~s37 부분집합. 포털 설정 두 벌(fixture 실제 값, hometax 자리표시). R-A1 식별(역할 + 접근 이름이 같은 요소), 커밋 그림자 확인, 조회는 허용 출처 팝업 |
| 실행 조율 | `packages/engine/src/runs.ts`, `entry.ts` | `RunService`: 시작 검사, 게이트 열기·만료·거부 우선 창(승인 뒤 2초 안 [중지]가 이김), 토큰, R-G7 순서(토큰 확인 → armed + 소비 → readback 재계산 → 클릭 → dispatched → verify), 재시작 정리(armed/dispatched → in_doubt, 열린 게이트 만료). 엔진 init은 한 번만, 실행 중 개발 콘솔 브라우저 명령 거부 |
| main 쪽 | `apps/desktop/src/engine-host.ts`, `shell-app.ts`, `shell-runs.ts` | 셸 main이 금고·엔진을 띄운다(`EngineHost`, 중계·제어·게이트 세 채널). 목업 실행기 대신 엔진 이벤트(`ShellRuns`). 프로필·거래처는 `db.query.*` |
| 승인 바 | `approval-gate.ts`, `approval-bar.ts` | v2 근거, `gateSelfCheck`로 무장 판단, `$dup.*` 표시("같은 건 기록 있음", "직전 시도 발급 안 됨")와 동작 글자 "같은 건 기록을 확인했고 발급" |
| 가짜 페이지 | `apps/desktop/src/h01-fixture.ts`, `fixture-mode.ts` | 127.0.0.1 H-01 흉내(발급 폼·발급·발급목록·메일발송목록). 시험 손잡이: 공급자 바꾸기, 게이트 뒤 값 바꾸기, 반영 지연, 목록 누락, 발급 거절, 조회 지연. fixture 모드는 임시 앱 폴더, 메모리 키, main 안 금고(시험 정책 127.0.0.1)로 돈다. 앱 금고 entry는 설정을 받지 않는다 |

## 3. 해시·근거 정의(D03 §3 구현)

- `cardHash = SHA-256(CBOR([[fieldKey, value], …]))`: 배열 전체(키·값·순서). fields는 readback 13칸(`READBACK_KEYS` 순서) 뒤에 예약 키(`$first.bizNo`, `$first.email`, 있으면 `$dup.businessKey`, `$dup.priorNotCommitted`).
- `readbackHash = SHA-256(JCS{fieldKey: 정규화 값})`.
- `actionHash = SHA-256(CBOR{cardHash, readbackHash, authorizes, packageDigest, intentId})`. 해시 셋은 CBOR 바이트열(major 2)로 넣는다.
- CBOR는 RFC 8949 §4.2.1 결정적 인코딩을 손으로 썼다(의존성 없음): 길이 최소 인코딩, 맵 키는 인코딩된 바이트의 사전순, 정수는 0 이상 안전 정수만(`cbor_bad_length`), 문자열에 짝 없는 서로게이트가 있으면 거부(`cbor_bad_string`). 부동소수·음수·태그는 쓰지 않는다.
- JCS는 RFC 8785를 이 PoC 값 범위(문자열·정수·불리언·null·배열·객체)만 구현했다. `undefined` 키는 뺀다.
- 게이트 토큰 = `HMAC(runKey, CBOR{runId, gateStepId, actionHash, exp, nonce})`. 한 번 쓰고, 게이트당 비가역 1개(`authorizes: ['s21']`).
- `LocalApproval` v2 = `{v:2, runId, gateStepId, reqId, approvalNonce, actionHash, exp(+120초), presence:'click', mac}`. MAC은 `HMAC(main 키, 'SAX-local-approval-v2' ‖ CBOR([v, runId, gateStepId, reqId, approvalNonce, actionHash, exp, presence]))`. Phase 1과 같이 엔진은 키가 없어 MAC을 검증하지 않고 **게이트 포트 출처**와 다섯 값 일치만 본다. MAC은 main 자기 확인용이다.
- main은 게이트 요청을 받으면 fields로 readbackHash·cardHash·actionHash를 다시 계산하고, 닫힌 목록 밖 키·중복 키·예약 키 위치를 본다(`gateSelfCheck`). 하나라도 어긋나면 "값 대조가 맞지 않아 승인할 수 없어요"로 무장 거부. 엔진 버그를 잡는 장치이지 엔진 침해 방어가 아니다(ADR-021).

## 4. e2e로 확인한 것(셸 51개 중 PoC-6 항목)

| 항목 | 결과 |
|---|---|
| 사업자 프로필·거래처가 DB(엔진 `db.query.*`)에서 온다 | 통과 |
| 게이트 요청: 엔진이 되읽은 13칸 + 예약 키, main 재계산 일치, 원장이 비었으면 처음 거래·처음 보내는 주소 | 통과 |
| 중계 통로(엔진 parentPort)로 `gate.answer`·`answerGate`·`attestNotCommitted` → `forbidden_channel`, 저널에 `security.gate_answer_from_relay` | 통과 |
| 렌더러 메서드 전부를 불러도 승인되지 않음, 발급 POST 0 | 통과 |
| 바 클릭 → 바가 내려가고 거부 우선 창 2초 → 발급 → 가짜 페이지 승인번호 = 결과 카드 승인번호, 메일 확인 | 통과 |
| 원장 committed, 저널 `gate.requested`·`gate.approved`·`ledger.armed`·`ledger.dispatched`·`ledger.committed`·`run.ended`, 발급 POST 1 | 통과 |
| 같은 건 다시: `$dup.businessKey = committed`, 합계 줄 "같은 건 기록 있음", 바 글자 "같은 건 기록을 확인했고 발급", 카드 고정 경고 | 통과(스크린샷 17) |
| 승인 대기에서 [중지] → 원장 행 없음, 발급 POST 없음 | 통과 |
| 승인 뒤 가짜 페이지가 공급가액을 바꿈 → 클릭 전 readback 재계산이 막음, 원장 not_committed(`pre_dispatch_mismatch`) | 통과(스크린샷 19) |
| 로그인 사업자 ≠ 프로필 → 바를 띄우지 않고 멈춤 | 통과(스크린샷 20) |
| fields에서 예약 키를 뺀 게이트 요청 → 바 무장 거부 | 통과 |
| LocalApproval v2 필드(reqId·approvalNonce·presence) | 통과 |
| 승인 대기 중 엔진 프로세스 종료 → 바가 내려가고 "승인 전에 끝났어요"(발급 없음), 이후 엔진 호출은 기다리지 않고 `engine_exit` | 통과(스크린샷 28) |

엔진 단위 시험(`tests/h01-engine.test.ts`)은 위에 더해 목록 반영 누락 → in_doubt, 명시적 실패 문구 + 부재 → not_committed와 다음 시도의 "직전 시도 발급 안 됨", 기준선 조회 중 [중지], 승인 직후 [중지](거부 우선 창), 커밋 구간 [중지] 거부(`already_issuing`), 대기 만료, 위조 근거 9종 거부, 원장에 평문 없음, 재시작 정리를 본다.

## 5. 관찰·한계

1. **readback 두 출처가 입력 칸에서는 같은 값이다.** DOM `value`와 aria 스냅숏 값은 `<input>`에서 둘 다 `.value`에서 온다. 화면에 보이는 글자와 제출 값이 다른 경우(숨은 칸, 마스킹)는 잡지 못한다. D02의 `readbackOf` 3값 대조(표시 글자·제출 값·aria)는 홈택스 화면 구조를 본 뒤 PoC-3 셀렉터와 함께 넣는다.
2. **조회 팝업의 opener가 남는다.** 금고 중계가 `Target.createTarget`을 거부해 조회는 `window.open`으로 허용 출처 팝업을 연다. `noopener` 팝업은 Playwright에 보이지 않아(측정) opener를 끊지 못했다. 같은 출처라 위험은 낮지만 잔여로 둔다.
3. **가짜 페이지 시험이다.** 홈택스 보안 모듈, 실제 발급목록 반영 지연, 메일발송목록 형식, 세션 만료는 없다. 홈택스 포털 설정은 셀렉터가 모두 `TODO(PoC-3)`라 `selector_placeholder`로 시작을 거부하고, verify 하한(최소 60초·2회)을 둔다.
4. **셸 e2e에서 가려진 창의 렌더러가 대화 열 폭을 늦게 잡았다.** 다른 창에 가려진 동안 ResizeObserver가 돌지 않아, 900 → 1280 DIP로 창을 되돌린 뒤 대화 열 폭(`--col-w`)이 900일 때 값에 머물렀다(바와 74 DIP 어긋남, 3회 중 3회). 창이 다시 보이면 회복한다. e2e 창에 `setBackgroundThrottling(false)`를 주고 나서 7회 연속 통과했다. 대화 열 폭을 CSS만으로 정하면 이 의존이 없어진다(PoC-9 렌더러 후속).
5. **첫 실행에서 "멈춘 커서 아래 바" 항목이 1번 실패했다**(이후 11회 통과, 재현 못 함). 바 판정 기록(`judged`)·커서·창 위치를 그 항목의 실패 기록에 남기도록 했다.
6. 엔진은 끝 스텝에서 마지막 구간의 완료를 따로 보내지 않는다. 셸이 확정된 실행의 진행 중 단계를 완료로 바꾼다.
7. 품목은 DB 거래처에 열이 없어 fixture 시연 값(`itemHints`)을 쓴다. 문서함은 아직 목업이다(PoC-8 보관함과 잇지 않음).
8. **받는 이메일이 없으면 바가 "없음 · 메일을 보내지 않아요"를 보인다.** PoC-9 바는 빈 이메일을 무장 거부했는데, H-01은 이메일 없이도 발급하고(s15가 칸을 비움, 메일 verify 건너뜀) 그 경우 홈택스가 메일을 보내지 않는다. 빈 값을 감추지 않고 보이는 쪽으로 바꿨다. 다른 칸(공급받는자·사업자번호·합계·세액)의 빈 값은 그대로 무장 거부다.
9. **엔진이 끝나면** 셸이 진행 중인 실행을 끝낸다. 승인 근거를 보내기 전이면 "발급 없음", 보냈거나 발급 중이었으면 in_doubt("발급됐는지 모릅니다… 중복 발급될 수 있어요"). 원장 행은 다음 기동 때 엔진이 in_doubt로 올린다. 셸이 엔진을 다시 띄우지는 않는다(앱 재시작).

## 6. Windows·실발급에서 확인할 것

- [ ] ADR-021 "조건"의 PoC-6 목록(OS 수준 입력): 배율 100·125·150%와 모니터 이동 뒤 `before-mouse-event` 좌표와 그려진 위치, 비활성 창의 mousemove·클릭 활성화 순서, 크기 변경·최소화·복원 뒤 재배치, 렌더러 팝업(`<select>`·날짜 선택기·자동완성·툴팁)이 바를 덮는지, 페이지 교체 중 down·up 쌍, 알림 창이 덮고 사라질 때 mouseLeave·movement 0, 멈춘 커서 아래 바, 인증서 비밀번호 입력 직후 클릭이 실패로 보이지 않는지, 패키지 앱 `--remote-debugging-port` 종료.
- [ ] 터치 탭에서 `before-mouse-event`가 뜨는지(R11 Q1).
- [ ] PoC-3 산출물 붙이기: 로그인(s0~s6)·캡차 분기 없음 확인, `HOMETAX_PORTAL` 셀렉터·랜드마크·발급목록/메일발송목록 조회 정의, `signFlow`(간편인증·인증서·보안카드)를 s20과 s21 사이에. 셀렉터 자리표시가 하나라도 남으면 시작하지 않는다.
- [ ] 실발급 2~3건: verify 일치, 중복 0건, 이메일 수신, 원장·저널 확인.
- [ ] PR #9(Windows 호스트)와 `entry.ts` 실행 페이지 부분이 겹친다. 나중에 머지되는 쪽이 `RunBrowserSlot.open(prepare?)`으로 맞춘다.

## 7. 하지 않은 것

- 원격(폰) 승인, 데몬 실행, `$dup.otherDevice`(메타데이터 서버 없음), Windows Hello(`presence: click+hello`·`click+waiver`), 증언 바(InDoubt "발급목록에 없음을 확인했어요").
- 네트워크 커밋 가드(D03 §5.4)와 패키지 서명 검증. `packageDigest`는 IR·포털 설정·프로필 버전의 해시로만 만든다.
- 게이트 바 저널(`gate.bar_shown`·`gate.bar_arm_refused`)은 엔진 저널에 넣지 않았다(main 로그만).
- 개발 콘솔(`main.ts`)의 금고·엔진 기동은 그대로 두었다(옛 `vault-port` 기동, 실행 명령 없음). PR #9와 겹치는 줄을 피했다.

## 8. 검수 반영

### 1차(Opus, 엔진 골격)

| 지적 | 반영 |
|---|---|
| 기준선 조회 중 [중지]가 게이트를 막지 못함 | 기준선 뒤 정지 확인, 게이트 열기 전 확인, 정지 뒤 온 근거 거부 |
| WAL 기본 `synchronous=NORMAL`이라 armed가 전원 차단에 남지 않을 수 있음 | `synchronous=FULL` |
| 실패 판정이 클릭 전부터 보이던 문구를 셈 | 클릭 뒤 새로 보인 실패 신호만 |
| readback 두 출처가 같은 값 | 한계로 적음(§5-1) |
| 토큰 소비가 게이트 직후라 거부 우선 창이 없음 | 소비·armed를 비가역 스텝 진입으로, 승인 뒤 2초 거부 우선 창 |
| 조회가 결과 준비를 기다리지 않음 | `data-count` 준비 신호 + 행 수 일치 |
| 합계 대조 없음 | s19d `sumEquals` |
| 식별한 요소와 클릭한 요소가 다를 수 있음 | 식별 → readback → 같은 핸들 클릭 |
| 확정 뒤 오류가 실패로 보임 | completed_with_issues(`post_commit.error`) |
| 같은 게이트 답 두 번 | 앞 기다림 `superseded` |
| 재시작 정리 없음 | armed/dispatched → in_doubt, 열린 게이트 만료, 실행 중 → interrupted |
| init 재수신·실행 중 브라우저 명령 | init 한 번, 실행 중 `busy` |
| CBOR 서로게이트, main 자기 확인 범위 | `cbor_bad_string`, `gateSelfCheck` |

### 2차(Opus, 셸 연결)

| 지적 | 반영 |
|---|---|
| (높음) 같은 업무 키에 발급 안 됨과 발급된 건이 같이 있으면 바·카드가 "직전 시도 발급 안 됨"만 보여 발급된 건을 가림 → 중복 발급 | "직전"은 가장 최근 시도만(원장). 바는 발급됐거나 모르는 건(committed·in_doubt·armed·dispatched)이 있으면 "같은 건 기록 있음"이 먼저, 카드는 해당 경고를 모두. 원장·바·카드 시험 |
| (중간) 엔진 종료를 아무도 듣지 않아 카드가 "발급 중"에 머물고, 이후 호출이 영영 기다림 | 엔진 종료 시 진행 중 실행을 끝냄(승인 보낸 뒤면 in_doubt), 바 닫기, 끝난 뒤 호출은 바로 실패, ready도 실패로 끝냄. 승인 표시는 근거를 보내기 전에. e2e로 실제 엔진 종료 |
| (낮음) 시작 중(run.begin 대기) [중지]가 사라짐 | 시작 중 [중지]를 기억해 run.start를 보내지 않거나, 보낸 뒤 바로 run.stop |
| (낮음) 받는 이메일이 없으면 영영 승인 못 함 | 바에 "없음 · 메일을 보내지 않아요"(§5-8) |
| (낮음) in_doubt 문구를 코드로 골라 중복 위험 경고가 빠질 수 있음 | in_doubt는 상태로 문구를 고름. 확정 뒤 오류(`post_commit.error`) 문구도 추가 |
| (낮음) 자기 확인이 `$first.*`를 요구하지 않음 | 둘 다 있어야 무장 |
| (낮음, 잠재) 키보드 승인 경로가 무장 거부를 보지 않음 | 꺼져 있지만 켜도 무장 거부·숨김 중에는 승인 안 함 |
| (낮음) 종료 순서·정리 | 엔진이 실제로 끝난 뒤 임시 앱 폴더 삭제(최대 3초 대기), 셸 생성 중 실패 시 fixture 정리, 데모 시작 실패 시 정리 후 종료 |

수정 확인 검수(Opus)에서 8건 모두 닫혔고, 수정이 남긴 낮은 지적 3개를 더 반영했다: 금고가 끝나면 엔진도 끝내 실행을 정리한다(금고만 끝나면 호스트가 호출을 막아 열린 게이트를 아무도 멈추지 못했다), 셸 생성이 엔진을 띄운 뒤 실패하면 엔진을 먼저 끝내고 임시 폴더를 지운다, 엔진이 근거를 거부하면 "승인했어요" 안내를 바로 거두고 코드 없는 in_doubt 문구는 "발급 요청은 보냈지만"이라고 단정하지 않는다.
