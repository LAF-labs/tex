# ADR 목록

| ID | 제목 | 상태 |
|---|---|---|
| [ADR-001](ADR-001-electron-installed-chrome.md) | Electron + Playwright + 사용자 설치 Chrome | 채택(v1.3 개정) |
| [ADR-002](ADR-002-declarative-playbook-ir.md) | 플레이북은 선언적 JSON IR, 임의 코드 아님 | 채택(v1.3 개정) |
| [ADR-003](ADR-003-decisions-for-judgment-terra-for-reasoning.md) | 판단은 Decisions API, 추론은 GPT-6.1 Terra | 채택(v1.3 개정) |
| [ADR-004](ADR-004-no-captcha-solving-handoff.md) | 캡차 자동 해독 금지, 10초 핸드오프 | 채택 |
| [ADR-005](ADR-005-vault-typist.md) | 비밀 타이피스트: 금고가 Chrome을 소유하고, 엔진에는 기본 거부 중계만 준다 | 채택 v3(v1.3 개정, 스파이크 S1b·S6·S6b~f 조건부) |
| [ADR-006](ADR-006-metadata-plain-body-e2ee.md) | 메타데이터 평문 최소(종류별 서버 색인·월 단위·서명) + 본문 E2EE 분리 | 채택(v1.3 개정) |
| [ADR-007](ADR-007-noise-pairing-zero-knowledge-relay.md) | Noise 페어링 + 내용을 볼 수 없는 릴레이(연결 상관은 가능) | 채택(v1.3 개정) |
| [ADR-008](ADR-008-windows-first.md) | Windows 우선, macOS Phase 3 | 채택 |
| [ADR-009](ADR-009-gateway-metering-byok.md) | 게이트웨이 무저장 계량 + BYOK | 채택(v1.3 개정) |
| [ADR-010](ADR-010-webdriver-flag-left-as-is.md) | `navigator.webdriver` 표식은 그대로 둔다 | 채택 |
| [ADR-011](ADR-011-portal-mode-gov24-postprocess.md) | 포털별 운영 수준, 정부24는 사전 허락 전 후처리 모드 | 채택(v1.3 개정), 포털 상한 판정 기준은 ADR-022 |
| [ADR-012](ADR-012-hotfix-scope-actuation-identity-policy-ceiling.md) | 셀렉터 핫픽스 범위 제한, 액추에이션 시 동일성 검사, 운영 정책 앱 내장 상한 | 채택(조건 항목 있음) |
| [ADR-013](ADR-013-registry-threshold-signing-transparency.md) | 레지스트리 2-of-3 임계 서명, 투명성 로그, 키 세대·폐기, 자체 HSM | 채택(SP-4·SP-6·S18 조건부, 투명성 로그 강제는 Phase 2), 앱 매니페스트 키·역할 배정표는 ADR-028 |
| [ADR-014](ADR-014-docparse-sandbox-local-approval-window.md) | docparse 렌더러 샌드박스, main 승인 창 기반 로컬 비가역 승인 | 채택(S13b 조건부), §2는 ADR-020으로 대체, 로컬 승인 근거는 ADR-021, docparse `disableDialogs`는 ADR-025 |
| [ADR-015](ADR-015-sovereign-model-infra-strategy.md) | 소버린 모델·인프라 전환 전략: 공급사 중립 설계, 조달 트리거, System One 호환 | 채택 |
| [ADR-016](ADR-016-account-trust-anchor-hardware-approval.md) | 계정 신뢰 앵커(AIK 고정·서명 기기 목록), 원격 비가역 승인은 하드웨어 키 | 채택(SP-1·2 조건부), 복구 문구 경로는 ADR-020으로 대체, v2(ADR-029): 열쇠 사본은 기기에만(PASS는 계정만) |
| [ADR-017](ADR-017-poc-scope-and-start.md) | PoC 범위와 착수 결정: 공문 회신 없이 홈택스 범위로 4주 PoC, 정부24 제외 | 채택(2026-11-02 개정 메모: 법률 질의 6건), 결정 4·7은 ADR-035로 대체 |
| [ADR-018](ADR-018-document-demand-priority.md) | 서류 수요 기반 플레이북 우선순위: 홈택스 민원증명 묶음을 MVP 코어로, 법인등기·위택스 베타, 공고문 → 서류 꾸러미 | 채택, 결정 3·조건의 W-01·S-03·S-02를 켜는 방법은 ADR-022로 정정 |
| [ADR-019](ADR-019-single-session-chat-ui.md) | 단일 메인 세션과 대화 중심 화면, PC·폰 공용 타임라인(원본은 PC 로컬 DB, 서버 무저장) | 채택 |
| [ADR-020](ADR-020-design-review-issuance-auth-approval.md) | 화면 디자인 검토 결정: 발급 인증 고정·설정 변경, 보안카드 완전 위임(로컬 암호화), 카드 승인(별도 승인 창 폐지), 응답 끊김 자동 조회, 부가세 토글, 새 PC는 폰 승인·PASS | 채택(PoC 확인 조건 있음), 결정 4의 버튼 위치·승인 근거는 ADR-021, 결정 3의 저장 방식은 ADR-026으로 대체, 결정 7의 복구 경로는 ADR-029로 구체화 |
| [ADR-021](ADR-021-pc-approval-evidence-main-approval-bar.md) | PC 승인의 근거: main 소유 승인 바(스크립트 없는 `WebContentsView`, main이 위치를 정하고 클릭을 직접 관찰, 대화 카드에는 승인 버튼 없음)와 선택 Windows Hello 확인 | 채택(PoC-6 확인·PoC-9 배치 선택 조건 있음), **2026-11-06 개정 결정 7: main 승인 카드 하나(값 전체·[중지]·[승인하고 발급], 기본 포커스 [중지])**, 클릭 활성화 예외·중복 표시는 ADR-027, Hello 합치기는 ADR-026으로 개정 |
| [ADR-022](ADR-022-wetax-portal-ceiling.md) | 위택스 운영 수준 상한(`wetax: postprocess`)과 포털 상한 판정 기준: 사전 허락이 필요한 포털은 허락 회신 + 앱 업데이트 뒤에만 자동화 | 채택 |
| [ADR-023](ADR-023-policy-poll-interval.md) | 운영 정책·status 조회 주기(15분 + 실행 직전 재조회)와 반영 시간 목표(켜진 앱 20분) | 채택 |
| [ADR-024](ADR-024-cross-pc-duplicate-warning.md) | 기기 간 중복 발급 경고: Phase 1은 포털 발급목록 기준선(`$dup.portalExisting`, 서버 기록 없음), 서버 업무 키 표시는 Phase 2·데스크톱 2대 이상 계정만, `K_idx`는 새 PC 연결(A-03)이 넘김 | 채택; 결정 6의 RK 보관 방식은 ADR-029 결정 1이 정함 |
| [ADR-025](ADR-025-poc3-real-account-safety-baseline.md) | PoC-3 실계정 진입 안전 기준선: 앱이 집행하는 PoC 상한, 안전 쪽 실패 해석, 실비밀 경로 하나 | 채택(2026-11-03, AUDIT-D 24건) |
| [ADR-026](ADR-026-human-secret-device-bound-session-vault.md) | 사람 비밀 등급 정합: 기기 결박 열쇠와 Windows 세션을 따르는 금고, 엄격 모드는 발급마다 Hello | 채택(2026-11-03, S10c 조건부, AUDIT-D 5건) |
| [ADR-027](ADR-027-approval-precision.md) | 승인 정밀도: 바의 줄 수를 늘리지 않고 더 정확하게, 사용자 동작은 main이 본 입력에 묶는다 | 채택(2026-11-03, AUDIT-D 6건) |
| [ADR-028](ADR-028-supply-chain-update-signing-roles.md) | 공급망·업데이트·서명 역할: 앱 채널을 레지스트리와 같은 신뢰 수준으로, 5인 팀에서 성립하는 쿼럼 | 채택(2026-11-03, AUDIT-D 4건) |
| [ADR-029](ADR-029-remote-recovery-data-minimization.md) | 원격·복구·데이터 최소화: 서버는 열쇠를 갖지 않고, 폰은 범위만큼만, 문구는 사실대로 | 채택(2026-11-03, SP-2 조건부, AUDIT-D 9건), 결정 1의 PASS 범위는 (가)로 확정 |
| ADR-030 | 구현 결정 대장(`poc/reports/decisions.tsv`를 표로 옮김, RETRO B-17) | 예약 |
| [ADR-031](ADR-031-payroll-ledger-withholding-calc.md) | 급여대장과 원천징수·4대보험 계산 보조: 02 §12 "세액 산정 안 함"을 고친다 | 채택(2026-11-05, 결정 1·2·7: Phase 1 베타), 결정 3~6은 제안 |
| [ADR-032](ADR-032-tax-accountant-bundle.md) | 세무사 꾸러미와 사업용 카드 [최신화] 버튼: 사장님 편 도구, 공통 자료는 UI로 강하게·일부 업체 자료는 추가 항목으로, 카드 조회는 사람이 누를 때만(데몬 아님) | 채택(2026-11-05, 결정 1~5·11: 스타터 포함·Phase 1 베타·모델 비용 0), 결정 6~10은 제안 |
| [ADR-033](ADR-033-home-monthly-board.md) | 홈은 "이번 달 판": 해야 할 일을 기한 순 카드로, ADR-019 결정 2를 대체한다 | 채택(2026-11-05, 결정 1·2), 결정 3~5는 제안 |
| [ADR-034](ADR-034-phase1-scope-single-plan-accountant-link.md) | Phase 1 범위·요금·세무사 연결: 사장님 앱(PC+폰)과 세무사 꾸러미 보내기, 9,900원 한 플랜, 세무사 화면은 다음 단계 | 채택(2026-11-05, 결정 1~9 본문·12의 결정 항목, 같은 날 yulmu 확답으로 결정 8 근무표 범위·결정 9 폰 승인 Phase 2·결정 10 보내는 경로 (가)), 결정 9의 나머지 하위·11·12의 제안 항목은 제안 |
| [ADR-035](ADR-035-poc-promotion-two-week-phase1.md) | PoC 코드를 Phase 1 기반으로 승격, 2주 병렬 개발(트랙·파일 경계·팀장 경유 계약), G1을 통합 판정(G1-a)·출시 판정(G1-b)으로 재정의, D14 공수는 범위 기준량 | 채택(2026-11-05, 결정 1~5 본문), "(제안)" 항목은 제안 |
| [ADR-036](ADR-036-issuance-auth-fallback-pipeline.md) | 발급 인증 폴백 파이프라인: 공동인증서·보안카드·간편인증의 로그인·서명 경로, 화면 판정·복구 단계 0~4(D03 L0~L3·D04 L0/L1/L2 재사용, 커밋 구간은 단계 0만), 발급 취소 H-01c(전액 상쇄 수정세금계산서), 실측 계획 | 채택(2026-11-05, 결정 1~3 본문), 결정 4·5의 일정·경로·공수와 "(제안)" 항목은 제안 |
| [ADR-037](ADR-037-phase1-registry-solo-software-keys.md) | Phase 1 레지스트리 서명 키 단독 보유·소프트웨어 키 모드: 사용자 1인이 루트·패키지·정책·긴급·릴리스 키 보유(macOS 키체인·Touch ID), 2-of-3 형식 유지, 타임스탬프 키는 서버 비밀값, 잃는 성질과 승격 경로 | 채택(사용자 결정 2026-11-06) |
| [ADR-038](ADR-038-email-password-login-auto-login.md) | 이메일·비밀번호 로그인과 자동 로그인: 비밀번호·이메일 코드·패스키, `argon2id` + 서버 페퍼, 계정 잠금·열거 방지, 코드 재설정, 회전 갱신 토큰(재사용 감지 시 전체 폐기), 금고·기기 키와 무관 | 채택(사용자 결정 2026-11-06) |
| [ADR-039](ADR-039-fixture-portal-test-packages.md) | 엔진 시험용 fixture 포털 패키지: `portal: fixture`만 `http://127.0.0.1:PORT`·`http://[::1]:PORT`(V-25), 정적 검증·제품 로더(dist)·레지스트리 게시·배포 세 곳에서 거부, 운영 키 서명 없음, 금고 Chrome 호스트 매핑+시험 인증서 안(나)은 기각 | 채택(팀장 결정 2026-11-06) |
| [ADR-040](ADR-040-engine-gateway-auth-scoped-device-token.md) | 엔진의 게이트웨이 인증: main이 gateway 범위 기기 토큰과 DPoP 헤더를 auth 포트로 요청마다 준다(허용 목록 3경로), `POST /v1/device-tokens` `scopes` 범위 축소·발급 기록, 금고 engine 포트의 장기 키 연산 제거, 401 1회 재시도·403 없음·`signed_out`은 오프라인 | 채택(팀장 결정 2026-11-06) |
| [ADR-041](ADR-041-windows-owner-check-once-per-dir.md) | Windows 폴더 소유자 확인을 폴더(볼륨·파일 ID·생성 시각)마다 프로세스당 한 번으로: 신뢰 소유자만 기억, DACL은 매번 확인, 소유자 읽기 상한 90초, 금고 기동 때 미리 확인, 네이티브 헬퍼가 오면 PowerShell을 뺀다 | 채택(팀장 지시 2026-11-06) |

AUDIT-D(설계 v1.3 + PoC 코드) 확정 53건의 처리 배정은 [D19 §3.5](../19-attack-surface.md)에 있다. ADR-025~029가 48건, D19 등록만이 5건이다. AUDIT-D는 처음에 ADR-022~026으로 적었고, main의 ADR-022·023과 겹쳐 2026-11-03 병합 때 ADR-025~029로 옮겼다(022→025 … 026→029, 예약 027→030).
