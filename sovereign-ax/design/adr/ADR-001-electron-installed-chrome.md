# ADR-001 Electron + Playwright + 사용자 설치 Chrome

상태: 채택 · 2026-10-28 · 개정 메모 v1.3(아래)

## 맥락
데스크톱 셸과 브라우저 자동화 수단을 정해야 한다. 요구: Windows 우선·macOS 후속, 정부 포털 보안 모듈·간편인증 팝업 호환, 탐지 신호를 만들지 않음(헤드리스·자동화 전용 플래그·번들 브라우저 지양), 팀 속도.

## 결정
- 셸은 Electron + TypeScript. 엔진·금고는 `utilityProcess`로 분리.
- 자동화는 Playwright가 **사용자가 설치한 Chrome**(`channel: 'chrome'`)을 전용 `user-data-dir`로 헤드풀, 최소 플래그 모드(`ignoreDefaultArgs: true` + 파이프, `--no-sandbox`·`--disable-extensions` 없음)로 실행한다. 자동화 전용 플래그·배너는 켜지 않되, 가짜 값 주입·지문 조작은 하지 않는다. 파이프 연결에서 `navigator.webdriver=true`가 노출되는 것은 그대로 둔다(ADR-010).

## 대안
- Tauri + 사이드카: 바이너리 작음, Rust 보안 이점. 그러나 Playwright·IPC 생태계가 Node 중심이라 초기 속도 손해. Phase 3에서 재평가.
- 번들 Chromium: 버전 고정의 편의가 있으나 보안 모듈 호환과 "사람과 같은 브라우저"라는 원칙에 불리.
- CDP로 사용자가 이미 켠 Chrome에 연결: 프로필 격리가 어렵고 사용자의 일반 브라우징과 섞인다. 폴백으로만 유지.

## 결과
- Chrome 미설치 사용자에게는 설치 안내(대상 세그먼트에서 드묾).
- Chrome 자동 업데이트로 셀렉터·동작 변동 가능 → 리플레이 하네스와 핫픽스 파이프라인으로 흡수.

## 개정 메모 (v1.3, 공격표면 감사 반영, A/C-10)
- **기동 주체는 금고다.** 위 결정의 "Playwright가 … 실행한다"는 v1.3부터 "금고가 설치 Chrome을 `--remote-debugging-pipe`로 기동하고(인자 없는 `browser.launch()`, 프로필 경로·플래그는 금고 상수), 엔진의 Playwright는 금고 중계 전송 위에서 연결만 한다"로 읽는다(ADR-005 v3, D05 §3.1~§3.3). Playwright의 `launch` 경로는 쓰지 않는다.
- 이 구조는 **S6b 결과에 조건부**다. Playwright가 MessagePort 또는 토큰 WS 폴백(D05 §3.2) 위에서 브라우저 타깃 없이 동작하지 않으면, 이 ADR과 ADR-005를 함께 재검토한다.
- 대안 절의 "CDP로 사용자가 이미 켠 Chrome에 연결 — 폴백으로만 유지"는 **폐기**한다. 사용자 일상 프로필에 디버깅 연결을 붙이는 경로는 금고의 프로필 경로 상수·재분석 지점 검사(D05 §3.1)와 양립하지 않는다.
- Phase 3에 고수준 동작 브로커(ADR-005 대안)를 검토할 때 Playwright를 무권한 드라이버 프로세스로 옮기는 안과 함께 이 ADR을 재검토한다.
