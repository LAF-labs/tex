# tex — 소버린 AX 하네스 기획·설계 저장소

자영업자·중소기업·스타트업이 **본인 PC에서, 본인 인증수단으로** 홈택스(전자세금계산서)와 정부24(민원서류) 업무를 처리하도록 돕는 로컬 에이전트 하네스. 비밀값은 기기 밖으로 나가지 않고, 서류는 로컬 보관 + 종단간 암호화 백업, 모델은 월 구독으로 제공한다.

> 모토: 본인의 데이터는 본인이 갖고 있어야 한다 — 소버린 AX

## 저장소 구성

| 경로 | 내용 | 상태 |
|---|---|---|
| [sovereign-ax/README.md](sovereign-ax/README.md) | 기획서 입구: 원칙, 사업 범위, 확인된 외부 사실, 결정 사항 | v1.2 + 설계 v1.3 결정 |
| [sovereign-ax/01-business-plan.md](sovereign-ax/01-business-plan.md) ~ [06-feasibility.md](sovereign-ax/06-feasibility.md) | 사업·서비스 기획, 아키텍처 개요, 로드맵, 접근 허용·봇탐지, 가능성 검토 | v1.2 (기준 시나리오·검수 반영) + 서류 카탈로그 반영(ADR-018) |
| [sovereign-ax/07-document-catalog.md](sovereign-ax/07-document-catalog.md) | 사업자 서류 카탈로그: 공고문 36건 수요 집계, 상황별 세분화, 플레이북 우선순위 근거 | v0.1 (2026-10-30) |
| [sovereign-ax/08-screen-plan.md](sovereign-ax/08-screen-plan.md) | 화면·기능 기획: 화면 34개(PC 27·모바일 7), 채팅 온보딩, 작업 상태 흐름, 예외 상태, Claude Design 전달 사항 | v0.1 (2026-10-30) |
| [sovereign-ax/design-system/](sovereign-ax/design-system/README.md) | 디자인 시스템: 토큰(라이트·다크), 데이터 위계, 컴포넌트 13개 | v1 (2026-10-30) |
| [sovereign-ax/design/](sovereign-ax/design/00-overview.md) | 개발 설계서 D00~D19, JSON 스키마 9종, ADR 19건 | v1.3 (공격표면 감사 3건 반영, [D19](sovereign-ax/design/19-attack-surface.md)) |
| [sovereign-ax/research/](sovereign-ax/research/) | 리서치 노트 R1~R8(Sonnet), R9 공고문 제출서류 집계·R10 서류 발급 사실표, 검수 REVIEW-A/B/C와 공격표면 감사 AUDIT-A/B/C(Opus) | 참고 |

기획 최종본은 Claude Docs 아티팩트([최종본 요약 + 탭 9개(개발 설계 요약 v1.3, 공격표면 감사·소버린 결정 포함)](https://claude.ai/artifact/CPYTrcP1Rb1rn35ig7bEPv))로도 볼 수 있으며 이 저장소의 문서와 같은 내용이다. 화면·기능 기획은 와이어프레임이 들어간 [별도 Claude Docs](https://claude.ai/artifact/9rBKqQmQ3Thoaii3r1aMpi)로, 디자인 시스템은 미리보기가 렌더되는 [Design System 아티팩트](https://claude.ai/artifact/EqjRNi8i9CYd4qkSo9qz3N)로도 볼 수 있다.

코드는 아직 없다. 개발 착수 게이트(기획 확정 · 법률 1차 의견 · 운영기관 공문 발송)는 [04-roadmap.md](sovereign-ax/04-roadmap.md)에 있다. 작업판은 https://project.laf-co.com/p/tex (P0-14 공격표면 감사, P0-15 소버린 대안 평가).

## 읽는 순서

1. 기획 요약 → `sovereign-ax/README.md`
2. 왜 이 사업인가 → `01-business-plan.md`, `06-feasibility.md`
3. 무엇을 만드는가 → `02-product-spec.md`, 어떤 서류부터인가 → `07-document-catalog.md`, 어떤 화면인가 → `08-screen-plan.md`, 어떻게 보이는가 → `design-system/`
4. 어떻게 만드는가 → `design/00-overview.md`부터 번호순, 결정 이유는 `design/adr/`
5. 근거가 궁금하면 → `research/`

## 문서 규약

- 한국어. 숫자는 출처가 있으면 출처, 없으면 "가설"로 표기.
- 설계 변경은 ADR 추가 또는 갱신으로 남긴다.
- 비밀값·실제 사업자 데이터는 어떤 문서에도 넣지 않는다.
