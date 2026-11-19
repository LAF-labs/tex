# ADR-056. 시험 기간에는 생성 호출만 Anthropic으로: 판정(jev)은 그대로 둔다

> 상태: 채택(2026-11-19 yulmu, "테스트하는 동안 오픈라우터 대신 Claude 조직 크레딧을 쓰게"). 시험 기간 한정 운영 스위치다.
> 잇는 결정: [ADR-015](ADR-015-sovereign-model-infra-strategy.md)(공급사 종속 코드는 게이트웨이 `providers.ts` 한 곳), [ADR-051](ADR-051-chat-harness-route-tools-reply.md)(판정 jev → 도구 → 답), 법적 검토 R14 ①(OpenRouter 라우팅 고정)

## 맥락

PC 대화, 폰 대화, 대화 요약, 선택자 수리, 예상 밖 화면 판정, 브라우저 에이전트, 화면 보기는 모두 게이트웨이 `/v1/respond` 한 곳을 거쳐 OpenRouter로 간다. PC와 폰은 공급사를 모른다(응답 항목 꼴만 안다). 대표에게 Anthropic 조직 크레딧이 매월 생기는데 시험 중에 쓰이지 않는다.

L1 판정(`/v1/decide`)과 결정 모델 고르기(`decision_pick`)는 OpenRouter decisions의 jev가 낸 확률과 임계값 프로필에 묶여 있고, ADR-051 1단계 평가 기준선(362건, 93.1%)도 jev로 쟀다. Anthropic에는 생성 없이 확률만 내는 판정 엔드포인트가 없다.

## 결정

1. 게이트웨이에 `GW_RESPOND_PROVIDER`(`base` 기본 | `anthropic`)를 둔다. `anthropic`이면 생성 호출만 Anthropic Messages API로 보내고, 판정과 결정 모델 고르기는 `GW_PROVIDER` 공급사에 그대로 둔다. 기본값은 지금과 같다(값을 지우고 재배포하면 되돌아간다).
2. 모델은 `ANTHROPIC_MODEL_RESPOND`(기본 `claude-opus-5-5`), `ANTHROPIC_MODEL_AGENT`(기본은 RESPOND와 같다). 툴셋의 effort, 출력 스키마, 도구, 최대 토큰은 그대로 옮긴다. 사고는 모델 기본(적응형)이다.
3. PC와 폰은 바꾸지 않는다. 응답의 assistant 내용 원본(사고 블록 서명 포함)은 첫 출력 항목 `reasoning`에 실려 가고, 클라이언트가 지금처럼 태그와 함께 되돌려 보내면 게이트웨이가 그대로 다시 싣는다. 그래서 게이트웨이와 PC 앱을 같은 커밋으로 내는 규칙이 이 변경에는 걸리지 않는다(게이트웨이만 바뀐다).
4. Anthropic 구조화 출력이 받지 않는 제약(`maxLength`, `maximum`, `maxItems`, `pattern` 등)은 빼고 보낸다. 받은 출력과 도구 인자는 PC와 폰이 원래 스키마로 다시 검사한다(지금과 같다).
5. 일 한도 단가(`LIMIT_PRICES`)는 바꾸지 않는다. 시험 중 실제 비용은 한도 계산보다 크고, 상한은 계정 월 토큰 한도다.

## 결과

- 시험 중 생성 비용은 조직 크레딧에서 나가고, OpenRouter 비용은 판정(호출당 약 0.15원)만 남는다.
- **실고객을 받기 전에 정한다**: 대화 글(가린 글)이 Anthropic(미국)으로 간다. 처리방침 6항의 국외 이전과 수탁 목록에 Anthropic이 없으므로, 실고객 전에는 `GW_RESPOND_PROVIDER`를 지우거나 처리방침을 고친다. Anthropic API는 기본 보관 30일이고 학습에 쓰지 않는다. 무보관(ZDR)은 별도 계약이다.
- 판정 평가(`tests/chat-eval/route`)는 jev 그대로라 다시 잴 필요가 없다. 대화 답 품질은 모델이 바뀐다. `tests/chat-eval/run.ts` 러너는 OpenRouter 직결이라 Claude로 재려면 러너에 공급사를 더해야 한다(후속).
