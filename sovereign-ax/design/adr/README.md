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
| [ADR-013](ADR-013-registry-threshold-signing-transparency.md) | 레지스트리 2-of-3 임계 서명, 투명성 로그, 키 세대·폐기, 자체 HSM | 채택(SP-4·SP-6·S18 조건부, 투명성 로그 강제는 Phase 2) |
| [ADR-014](ADR-014-docparse-sandbox-local-approval-window.md) | docparse 렌더러 샌드박스, main 승인 창 기반 로컬 비가역 승인 | 채택(S13b 조건부), §2는 ADR-020으로 대체, 로컬 승인 근거는 ADR-021 |
| [ADR-015](ADR-015-sovereign-model-infra-strategy.md) | 소버린 모델·인프라 전환 전략: 공급사 중립 설계, 조달 트리거, System One 호환 | 채택 |
| [ADR-016](ADR-016-account-trust-anchor-hardware-approval.md) | 계정 신뢰 앵커(AIK 고정·서명 기기 목록), 원격 비가역 승인은 하드웨어 키 | 채택(SP-1·2 조건부), 복구 문구 경로는 ADR-020으로 대체 |
| [ADR-017](ADR-017-poc-scope-and-start.md) | PoC 범위와 착수 결정: 공문 회신 없이 홈택스 범위로 4주 PoC, 정부24 제외 | 채택(2026-11-02 개정 메모: 법률 질의 6건) |
| [ADR-018](ADR-018-document-demand-priority.md) | 서류 수요 기반 플레이북 우선순위: 홈택스 민원증명 묶음을 MVP 코어로, 법인등기·위택스 베타, 공고문 → 서류 꾸러미 | 채택, 결정 3·조건의 W-01·S-03·S-02를 켜는 방법은 ADR-022로 정정 |
| [ADR-019](ADR-019-single-session-chat-ui.md) | 단일 메인 세션과 대화 중심 화면, PC·폰 공용 타임라인(원본은 PC 로컬 DB, 서버 무저장) | 채택 |
| [ADR-020](ADR-020-design-review-issuance-auth-approval.md) | 화면 디자인 검토 결정: 발급 인증 고정·설정 변경, 보안카드 완전 위임(로컬 암호화), 카드 승인(별도 승인 창 폐지), 응답 끊김 자동 조회, 부가세 토글, 새 PC는 폰 승인·PASS | 채택(PoC 확인 조건 있음), 결정 4의 버튼 위치·승인 근거는 ADR-021 |
| [ADR-021](ADR-021-pc-approval-evidence-main-approval-bar.md) | PC 승인의 근거: main 소유 승인 바(스크립트 없는 `WebContentsView`, main이 위치를 정하고 클릭을 직접 관찰, 대화 카드에는 승인 버튼 없음)와 선택 Windows Hello 확인 | 채택(PoC-6 확인·PoC-9 배치 선택 조건 있음) |
| [ADR-022](ADR-022-wetax-portal-ceiling.md) | 위택스 운영 수준 상한(`wetax: postprocess`)과 포털 상한 판정 기준: 사전 허락이 필요한 포털은 허락 회신 + 앱 업데이트 뒤에만 자동화 | 채택 |
| [ADR-023](ADR-023-policy-poll-interval.md) | 운영 정책·status 조회 주기(15분 + 실행 직전 재조회)와 반영 시간 목표(켜진 앱 20분) | 채택 |
