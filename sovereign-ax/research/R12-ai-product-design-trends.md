# R12. 2026 AI 제품 UI 디자인 수렴 조사: 디자인 시스템 v1.2의 근거

> 조사일: 2026-11-02 · 대상: 실리콘밸리 AI 제품(대화형 에이전트·AI 우선 SaaS)의 UI가 2025~2026년에 수렴한 시각·상호작용 규칙 · 용도: 디자인 시스템 v1.2("더 조용하고, 더 적게, 더 분명하게") 결정 입력
> **검증 수준**: 웹 검색 4회와 공개 페이지 열람으로 만든 짧은 메모다. 사용자 조사·실기 측정은 없다. 출처가 없는 항목은 **가설**로 표시했다.

출처 표기: **[공식]** 표준 문서·플랫폼 제작사 1차 자료, **[2차]** 디자인 에이전시·도구 업체·실무자 글, **[관찰]** 제품 화면을 직접 본 기억에 기댄 서술(출처 없음 → 가설), **[추론]** 내 추론. 열람에 실패해 제목만 확인한 페이지는 "본문 미확인"으로 적었다.

## 핵심 10줄

1. AI는 대화 상자 하나로 화면을 차지하지 않고 **구조화된 화면 옆 패널·접히는 영역**에 놓인다. 규제 산업·기업용에서 특히 그렇다. [2차: Tubik, Fuselab, GoodBarber]
2. 에이전트가 일을 대신하면 **승인/거절/수정, 되돌리기, 실행 전 미리보기, 단계 표시, 실행 기록**이 제품의 일부가 된다. [2차: Outcrowd 2026-03-10]
3. 진행 중 표시는 **회전 스피너보다 맥락 있는 상태 글자와 스트리밍 자리 표시**로, 움직임은 읽기를 방해하지 않게 작게. [2차: uxpatterns.dev "AI loading states", inference.sh]
4. **점진 공개**: 기본 화면에는 요약과 상태만, 로그·기술 세부는 사용자가 열 때만. [2차: Indulge, inference.sh]
5. 움직임은 장식이 아니라 상태 변화를 알리는 기능 층이다. **300ms 이하, 이징 곡선, `prefers-reduced-motion` 존중**. [2차: UXPin 2026-06-12]
6. 라이트·다크는 한쪽에서 파생하지 않고 **함께 설계**하며, 시스템 설정(`prefers-color-scheme`)을 따르고 수동 전환을 더한다. [2차: 2026 웹 디자인 트렌드 글 다수]
7. **비텍스트 대비 3:1**: 조작 요소의 식별 정보와 포커스 표시는 인접 색과 3:1 이상. 글자가 있는 버튼은 테두리가 유일한 식별 수단이 아니면 테두리에 3:1을 요구하지 않는다. 빈 입력 칸은 요구한다. [공식: W3C WCAG 2.2 Understanding 1.4.11]
8. 플랫폼 제작사의 2025년 디자인 갱신은 **조작·탐색 층을 콘텐츠 위에 띄우고 콘텐츠를 앞세우는** 방향이다(Apple Liquid Glass 2025-06-09). Google Material 3 Expressive(2025-05)는 물리 기반 움직임과 모양 확대를 내세우지만 공식 본문은 미확인이다. [공식: Apple Newsroom] [2차: M3 Expressive 서드파티 구현 문서]
9. 디자인 토큰이 도구·플랫폼을 잇는 공용어이고, 테마 전환(다크·고대비·브랜드)은 토큰 교체로 한다. [2차: UXPin]
10. "조용한 무채 면 + 강조색 하나", "시스템/가변 서체", "4/8pt 간격 격자", "최소한의 테두리와 은은한 높이"는 **검색으로 출처를 확정하지 못했다**. 주요 대화형 AI 제품 화면에 대한 관찰에 기댄 **가설**이며, v1.2는 이 네 가지를 "서류와 도장" 방향(2026-10-30 결정)과 모순되지 않는 범위에서만 적용했다.

## 1. 배치: 대화 중심 캔버스와 옆 패널

| 발견 | 출처 | 신뢰 |
|---|---|---|
| 대화 층이 기존 UI 위에 얹히고, 사용자는 평소 흐름을 따르거나 말로 요청할 수 있다. 기업용·규제 산업은 열린 대화 상자보다 구조화된 뷰 옆에 AI를 둔다 | https://fuselabcreative.com/ui-ux-design-trends-2026-modern-ui-trends-ux-trends-guide/ | [2차] |
| AI는 사이드바·오버레이·접히는 패널에 살며 흐름을 가로채지 않고 맥락을 돕는다 | https://tubikstudio.com/blog/ui-design-trends-2026/ | [2차] |
| 메인 화면에 "무엇이든 물어보세요" 입력이 숫자 바로 아래에 놓이는 어시스턴트 바가 늘었다 | https://www.goodbarber.com/blog/design-trends-2026-ai-leaves-the-chat-the-design-system-makes-the-rule-a1608/ | [2차] |

소버린 AX 대조: 메인은 대화 하나 + 작업 패널(ADR-019)로 이미 이 구조다. v1.2는 패널·레일·제목줄을 같은 `surface`에 `line` 하나로 구분해 "옆 패널이 대화를 가로채지 않는" 인상을 강화했다.

## 2. 통제: 승인·단계·기록

| 발견 | 출처 | 신뢰 |
|---|---|---|
| "완전 자동 실행 대신 승인/거절/수정", 되돌리기, 자율 행동의 한도, 실행 전 단계 미리보기, 진행 중 상태, 실행 기록(action log) | https://www.outcrowd.io/blog/2026-design-trends-for-ai-first-saas-products (2026-03-10) | [2차] |
| 설명 가능성·감사 가능성·규정 준수를 설계에 넣는다 | 같은 글 | [2차] |

소버린 AX 대조: 승인 바(ADR-021), StepList, 결과 카드의 "어디로 무엇이 갔는지", 활동 기록이 이 패턴이다. v1.2는 바꾸지 않았다. 승인 바는 오히려 업계 평균보다 엄격하다(main 소유, 무장 지연, 머무름, 키보드 승인 없음).

## 3. 상태 표시: 스트리밍과 조용한 움직임

| 발견 | 출처 | 신뢰 |
|---|---|---|
| AI 로딩 상태의 구성: 요청 → 스트리밍 자리 표시 → 상태 라벨(생각 중·찾는 중·만드는 중) → 취소 조작 → 폴백. "읽기를 방해하지 않는 작은 움직임" | https://skillselion.com/skills/thedaviddias/ux-patterns-for-developers/ai-loading-states (uxpatterns.dev 미러) | [2차] |
| 몇 초마다의 상태 갱신이 몰입을 유지한다. 조용한 대기는 안티패턴. 맥락 있는 상태가 일반 애니메이션보다 낫다 | https://inference.sh/blog/ux-agent-ux-patterns | [2차] |
| 움직임은 상태 전이·주의 유도·진행 표시에만. 300ms 이하, 이징 곡선, `prefers-reduced-motion` 존중 | https://www.uxpin.com/studio/blog/ui-ux-design-trends/ (2026-06-12) | [2차] |

소버린 AX 대조: 진행은 StepList 현재 점과 "n회째" 같은 글자로 보여 준다(회전 아이콘 금지는 유지). v1.2는 `motion` 토큰(120/160/220ms, ease-out)과 현재 점의 2.4초 숨 쉬기 하나만 더했고, 동작 줄이기에서 모두 끈다. 승인 바는 애니메이션 없음(ADR-021).

## 4. 점진 공개

| 발견 | 출처 | 신뢰 |
|---|---|---|
| 전문가에게는 깊은 가시성, 초보자에게는 요약. 기술 로그는 요청할 때만(예: Meta Muse) | https://inference.sh/blog/ux-agent-ux-patterns | [2차] |
| 생성형 인터페이스에서 점진 공개 패턴의 쓰임 | https://indulge.digital/intelligence/articles/progressive-disclosure-design-pattern-ai-generated-interfaces | [2차] |

소버린 AX 대조: 결과 카드의 접힘 영역, 활동 기록의 "모델로 보낸 내용 보기"(기본 접힘)가 이미 있다. v1.2는 접힘 머리 줄을 조용한 글자와 꺾쇠로 통일했다.

## 5. 대비·테마·토큰

| 발견 | 출처 | 신뢰 |
|---|---|---|
| UI 구성 요소의 식별 정보와 상태, 포커스 표시는 인접 색과 3:1 이상. 글자·아이콘으로 식별되는 조작은 경계선이 필수가 아니다("경계는 다른 시각 수단이 없을 때만 필요"). 비활성 요소는 예외 | https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html | [공식] |
| 라이트·다크를 함께 설계, `prefers-color-scheme` + 수동 전환. 다크의 깊이 표현은 흰 바탕과 전혀 다른 값이 필요 | https://line25.com/articles/web-design-trends-2026/ 등 2026 트렌드 글 | [2차] |
| 토큰은 도구·플랫폼을 잇는 공용어, 테마 전환은 토큰 교체 | https://www.uxpin.com/studio/blog/ui-ux-design-trends/ | [2차] |

소버린 AX 대조: v1.1부터 토큰 하나로 두 테마를 쓴다. v1.2는 (1) 빈 입력 칸의 `line-strong`(3:1)은 의무로 두고, (2) 글자가 있는 작은 보조 버튼(복사·빠른 실행·필터)과 무채 칩은 `line` 또는 테두리 없음으로 낮췄다. 이 구분의 근거가 WCAG 2.2 1.4.11 해설이다. 모든 글자 색은 네 면(`canvas`·`surface`·`surface-tint`·`surface-overlay`) 위에서 4.5:1 이상을 다시 계산했다(tokens.json 설명).

## 6. 플랫폼 제작사의 2025 갱신

| 발견 | 출처 | 신뢰 |
|---|---|---|
| Apple Liquid Glass(2025-06-09): 반투명 재질, 라이트·다크 적응. "조작은 앱 위의 별도 기능 층이며 스크롤하면 콘텐츠에 자리를 내준다". iOS·iPadOS·macOS·watchOS·tvOS 26 | https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/ | [공식] |
| Google Material 3 Expressive(2025-05, I/O): 스프링 물리 움직임, 모양 35종 확대, 유연한 타이포. 공식 블로그 본문은 열람 실패 | https://m3.material.io/blog/building-with-m3-expressive (본문 미확인) · https://pub.dev/documentation/material_3_expressive/1.0.8/ 등 | [2차] |

소버린 AX 대조: 둘 다 "콘텐츠가 먼저, 조작은 그 위의 얇은 층"이라는 점만 가져온다. 반투명 재질·스프링 움직임·표현적 모양은 Windows 데스크톱 업무 앱이자 "서류" 방향과 맞지 않아 쓰지 않는다. Windows 11 자체 규칙(Mica·둥근 모서리)은 ADR-008에서 이미 창 틀 기준이다.

## 7. 출처를 확정하지 못한 것 (가설)

다음은 주요 대화형 AI 제품(2026년 기준 ChatGPT·Claude·Gemini·Linear·Raycast류)의 화면을 본 기억과 위 2차 자료의 분위기 서술에 기댄 **가설**이다. 검색으로 1차 출처를 찾지 못했다.

- **가설 A. 조용한 무채 면 + 강조색 하나.** 바탕과 카드의 명도 차를 작게 두고, 색은 사용자의 행동이 필요한 곳에만 쓴다. → v1.1의 "파랑 한 색" 원칙과 같아서 그대로 두고, 면의 단을 넷으로 정리했다.
- **가설 B. 시스템·가변 서체와 굵기 셋.** UI 글자는 400/500/600 세 굵기로 끝내고 700은 거의 쓰지 않는다. → v1.2 서체 규칙. 승인 바는 시스템 서체(CSP 제약)라 애초에 같다.
- **가설 C. 4/8pt 간격 격자.** 반 칸 값(14·18)을 쓰지 않는다. → v1.2 간격 규칙.
- **가설 D. 최소한의 테두리, 은은한 높이.** 카드는 얇은 선, 그림자는 입력창과 떠 있는 것에만. → v1.2 `shadow-raised` 하나만 더했다. 카드 그림자 금지는 유지.
- **가설 E. 명령 팔레트(Ctrl K)가 데스크톱 AI 앱의 표준 탐색.** 08 §5 M-03(Phase 1)과 같다. 디자인만 검색 칸을 테두리 없는 `surface-tint`로 바꿨다.
- **가설 F. 입력창이 화면에서 가장 "떠 있는" 요소다**(큰 모서리, 은은한 그림자, 원형 보내기 버튼). → v1.2 Composer. 승인 대기 중 입력창의 높이 규칙(ADR-021)은 그대로다.

## 8. v1.2에 적용한 것과 적용하지 않은 것

| 수렴 항목 | 적용 | 비고 |
|---|---|---|
| 대화 중심 캔버스 + 옆 패널 | 유지 | ADR-019 |
| 승인/거절, 단계, 실행 기록 | 유지 | ADR-021, 더 엄격 |
| 스트리밍·상태 라벨, 작은 움직임 | 부분 적용 | `motion` 토큰, 현재 점 숨 쉬기. 스피너 금지 유지 |
| 점진 공개 | 유지·정리 | 접힘 머리 줄 통일 |
| 비텍스트 대비 3:1 | 적용 | 입력 칸 의무, 글자 있는 작은 버튼은 완화(WCAG 해설 근거) |
| 다크 동등 | 적용 | 면 네 단, 다크는 위로 갈수록 밝게 |
| 토큰 중심 | 유지·확장 | 새 토큰 8개, 이름 변경 없음 |
| 반투명 재질, 스프링 움직임, 표현적 모양 | 미적용 | "서류" 방향과 Windows 업무 앱에 맞지 않음 |
| 무채 면·강조색 하나·4/8pt·최소 테두리(가설) | 적용 | 1차 출처 없음. 사용자 시연에서 확인(조건) |

## 조건

- 가설 A~F는 PoC 시연(사용자 20회 습관 클릭 시험과 같은 자리)에서 "조용해졌는데 분명한가"를 사용자에게 묻는 것으로 확인한다. 특히 무채 칩의 테두리 제거와 오늘 요약의 상자 제거가 상태를 덜 보이게 하지 않는지.
- Material 3 Expressive 공식 본문은 열람하지 못했다. 인용이 필요해지면 다시 연다.
- 2차 출처는 대부분 에이전시·도구 업체 블로그다. 수치 주장(예: 앱 다크 모드 비율)은 쓰지 않았다.

## Sources

- https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html — W3C, WCAG 2.2 Understanding SC 1.4.11 Non-text Contrast (열람함)
- https://www.apple.com/newsroom/2025/06/apple-introduces-a-delightful-and-elegant-new-software-design/ — Apple Newsroom, 2025-06-09 (열람함)
- https://m3.material.io/blog/building-with-m3-expressive — Google Material Design 블로그 (제목만 확인, 본문 미확인)
- https://pub.dev/documentation/material_3_expressive/1.0.8/ — M3 Expressive 서드파티 Flutter 구현 문서 (검색 요약만)
- https://www.outcrowd.io/blog/2026-design-trends-for-ai-first-saas-products — Outcrowd, 2026-03-10 (열람함)
- https://www.uxpin.com/studio/blog/ui-ux-design-trends/ — UXPin, 2026-06-12 (열람함)
- https://tubikstudio.com/blog/ui-design-trends-2026/ — Tubik Studio (검색 요약만)
- https://fuselabcreative.com/ui-ux-design-trends-2026-modern-ui-trends-ux-trends-guide/ — Fuselab Creative (검색 요약만)
- https://www.goodbarber.com/blog/design-trends-2026-ai-leaves-the-chat-the-design-system-makes-the-rule-a1608/ — GoodBarber (검색 요약만)
- https://skillselion.com/skills/thedaviddias/ux-patterns-for-developers/ai-loading-states — uxpatterns.dev "AI loading states" 미러 (검색 요약만)
- https://inference.sh/blog/ux-agent-ux-patterns — inference.sh, "Agent UX Patterns That Work" (검색 요약만)
- https://indulge.digital/intelligence/articles/progressive-disclosure-design-pattern-ai-generated-interfaces — Indulge (검색 요약만)
- https://line25.com/articles/web-design-trends-2026/ — Line25, Web Design Trends 2026 (검색 요약만)
