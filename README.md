# tex — 소버린 AX 하네스 기획·설계 저장소

자영업자·중소기업·스타트업이 **본인 PC에서, 본인 인증수단으로** 홈택스(전자세금계산서)와 정부24(민원서류) 업무를 처리하도록 돕는 로컬 에이전트 하네스. 비밀값은 기기 밖으로 나가지 않고, 서류는 로컬 보관 + 종단간 암호화 백업, 모델은 월 구독으로 제공한다.

> 모토: 본인의 데이터는 본인이 갖고 있어야 한다 — 소버린 AX

## 저장소 구성

| 경로 | 내용 | 상태 |
|---|---|---|
| [sovereign-ax/README.md](sovereign-ax/README.md) | 기획서 입구: 원칙, 사업 범위, 확인된 외부 사실, 결정 사항 | v1.0 확정 |
| [sovereign-ax/01-business-plan.md](sovereign-ax/01-business-plan.md) ~ [06-feasibility.md](sovereign-ax/06-feasibility.md) | 사업·서비스 기획, 아키텍처 개요, 로드맵, 접근 허용·봇탐지, 가능성 검토 | v1.0 확정 |
| [sovereign-ax/design/](sovereign-ax/design/00-overview.md) | 개발 설계서 D00~D18, JSON 스키마 4종, ADR 11건 | v1.2 (Opus 검수 3건 반영) |
| [sovereign-ax/research/](sovereign-ax/research/) | 리서치 노트 R1~R5(Sonnet)와 검수 보고서 REVIEW-A/B/C(Opus) | 참고 |

코드는 아직 없다. 개발 착수 게이트(기획 확정 · 법률 1차 의견 · 운영기관 공문 발송)는 [04-roadmap.md](sovereign-ax/04-roadmap.md)에 있다.

## 읽는 순서

1. 기획 요약 → `sovereign-ax/README.md`
2. 왜 이 사업인가 → `01-business-plan.md`, `06-feasibility.md`
3. 무엇을 만드는가 → `02-product-spec.md`
4. 어떻게 만드는가 → `design/00-overview.md`부터 번호순, 결정 이유는 `design/adr/`
5. 근거가 궁금하면 → `research/`

## 문서 규약

- 한국어. 숫자는 출처가 있으면 출처, 없으면 "가설"로 표기.
- 설계 변경은 ADR 추가 또는 갱신으로 남긴다.
- 비밀값·실제 사업자 데이터는 어떤 문서에도 넣지 않는다.
