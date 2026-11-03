# ADR-008 Windows 우선, macOS Phase 3

상태: 채택 · 2026-10-28 · 보완 2026-11-03(macOS 개발·PoC 호스트)

## 맥락
타깃 세그먼트(소규모 법인·개인사업자)의 데스크톱과 공동인증서·보안 모듈 생태계가 Windows 중심이다. 팀은 5인이다.

## 결정
- MVP와 Phase 2는 Windows 11 전용. macOS는 Phase 3.
- 다만 코드 구조(금고 어댑터, 인쇄 전략, 경로)는 처음부터 OS 추상화 계층을 둔다.

## 대안
- 동시 지원: 스파이크·QA 표면적이 두 배, 보안 모듈 이슈가 OS별로 달라 일정 위험.

## 결과
- macOS 사용자 대기자 명단을 받아 수요를 측정한다.
- 스파이크 S1은 macOS에서도 1회 수행해 아키텍처 가정을 미리 확인한다.

## 보완 (2026-11-03): macOS는 개발·PoC 정식 호스트

팀의 주 작업 환경이 macOS다. 그래서 **제품 출시 범위는 위 결정대로 두고**, 개발과 PoC에서 macOS를 정식으로 지원한다.

- **개발·PoC 정식 호스트.** `pnpm build`·`lint`·`test`와 e2e·스모크는 macOS에서도 통과해야 한다. macOS에서만 깨지는 변경은 머지하지 않는다. OS별 코드는 처음부터 추상화 계층 뒤에 두고, 맥 쪽 구현도 함께 둔다.
  - 금고 키 보관: Keychain(D05 표)
  - 경로·전용 Chrome 프로필
  - 인쇄·PDF 저장
- **PoC의 macOS 실측은 보조 자료다.** PoC 합격 판정(S1 자동 구간 9/10 등, D13)과 Windows 전용 기능의 확인은 Windows 실기기에서 한다. 사람이 조작하는 관찰(PoC-3-mac 절차서)처럼 macOS에서 먼저 모은 값은 Windows에서 다시 확인한다. 해당하는 Windows 전용 기능은 다음과 같다.
  - DPAPI
  - Windows Hello
  - Windows OCR
  - 무대화상자 PDF 저장(S3a)
  - 보안 모듈 동작
- **macOS 제품 출시는 Phase 3 그대로다.** 출시하려면 다음 일이 따로 필요하다. 이 보완은 그 일정을 앞당기지 않는다. 앞당길지는 대기자 명단 수요로 정한다.
  - ADR-020·021이 기대는 Windows 기능을 macOS 대응(Keychain·Touch ID·Vision)으로 다시 검증
  - 홈택스 보안 모듈 실측(S15)
  - Developer ID·공증
  - 맥용 업데이트 경로
