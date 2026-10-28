# R6. Upstage Solar 제품군 — 모델 계층 대안 평가 (사실 조사)

> 조사일: 2026-10-28 · 대상: Solar Pro 4, Solar Mini 4, **Solar Decide(System One)**, Document Parse / OCR / Information Extract, Solar Open 2, 독자 AI 파운데이션 모델(독파모) 프로젝트
> 근거 우선순위: Upstage 공식 콘솔 문서(`console.upstage.ai`, 각 페이지의 `.md` 원문 경로), 가격 페이지(`upstage.ai/pricing`), 공식 changelog·모델 이력, 공식 블로그, 과기정통부 브리핑(korea.kr). 보도·집계 사이트는 보조 근거로만 쓰고 표에 `[보도]` `[집계]`로 표시했다.
> **검증 수준 주의**: API 키로 실제 호출하지 않았다(문서 조사 전용). 페이지는 요약 도구를 거쳐 읽었으므로 숫자는 가능한 한 원문 인용이 확인된 것만 "확정"으로 적었다. 문서에 없으면 **미확인**이다. 아래 모든 "확인일"은 2026-10-28이다.
> 비교 기준 설계: R1(OpenAI Decisions / Responses)과 `design/04-model-layer.md`의 번들 8종(질문 1~10개, 입력 약 4,500토큰 가정).

---

## 0. 요약 (설계에 주는 함의)

1. **판정 계층에 상응하는 상품이 있다.** Upstage `solar-decide`(Solar Mini 4 기반, `POST /v1/systemone`, 베타, 2026-09-22 출시)는 choice/score/noul(=예/아니오) 질문에 보정 확률을 반환하고, 입력 $0.10/1M·출력 무료로 OpenAI Decisions와 단가가 같다. 이 스키마는 TypeSafe Jev에서 나온 멀티벤더 계약(AWS Strands Decider, Ollama 포함)이라 `adapters/`에 `systemone` 어댑터 하나로 여러 공급사를 받을 수 있다.
2. **Decide의 차이가 설계에 걸린다.** choice 선택지 2~26개(OpenAI 2~255), 질문당 거절(refusal) 개념 없음, 요청당 질문 수 상한·캐시 동작·이미지 입력은 **문서에 없음(미확인)**, 베타라 스키마가 GA 전에 바뀔 수 있다고 명시. 번들의 `onRefusal` 규칙은 사실상 죽은 코드가 되고 임계값 처리로 대체해야 한다.
3. **주권 이점은 판정 계층에서만 의미 있다.** Upstage **한국 리전**(`kr.api.upstage.ai`, 요청과 처리 데이터가 한국 내에서만 처리)은 **비공개 베타(별도 승인)**이고 지원 모델은 Solar Mini 4·Solar Decide·Document Parse/OCR·Information Extract(KR 전용 모델명)뿐이다. **Solar Pro 4는 한국 리전 목록에 없다.** OpenAI는 한국 리전이 저장(storage)만이고 처리는 미국·EU·UAE다(R1).
4. **추론 계층 대안은 Solar Pro 4(또는 Mini 4)이고 가격은 큰 폭으로 싸다.** Pro 4는 현재 $0.15/$0.60(정가 $0.30/$1.20의 50% 프로모션, 종료일 미표기), Mini 4는 $0.10/$0.40, Terra는 $1/$5. 호출당 비용은 Terra의 약 1/4~1/10. 다만 Pro 4의 한국어 수치는 전부 Upstage 자체 평가(KMMLU-Pro 79.2 등)이고 Terra와의 직접 비교 자료는 없다.
5. **Responses API가 있다(Pro 4·Mini 4).** 단 stateless(`previous_response_id`·`store:true`·`conversation`·`background` 거부), 텍스트 전용, reasoning 항목은 원문 텍스트만(요약 없음·`encrypted_content` 언급 없음). 현 설계가 이미 `store:false` + 출력 재생 방식이라 구조는 맞지만 **reasoning 항목 재생과 strict 도구 보장은 실측 필요**(tool calling 문서는 strict 모드를 설명하지 않음).
6. **SLA·안정성이 약하다.** 월 가용성 "95.0% 초과"(약 36시간/월 장애 허용), 보상은 전월 사용료의 1.5배 크레딧(신청제). 모델 수명도 짧다: Solar Pro 3은 2026-01-26 출시 → 2026-10-30 전면 종료(약 9개월), 스냅샷은 출시 3~5개월 후 폐기. 별칭(`solar-pro4`)이 아니라 스냅샷 고정 + 분기별 이관 계획이 필요하다.
7. **서류 처리(Document Parse/OCR/IE)는 클라우드 호출이 기본이고 온디바이스는 불가능**(온프레미스는 영업 문의). 마스킹 전 PDF를 보내야 하므로 "마스킹된 접근성 텍스트만 전송" 원칙과 충돌한다. **로컬 pdfjs + tesseract 유지**가 맞고, Upstage는 사용자 동의 기반 선택 기능이나 서버 측 온프레미스 옵션으로만 검토한다.
8. **독파모: Upstage는 2차 평가(2026-08-18)를 통과해 3개 팀(Upstage·SKT·LG) 중 하나로 3단계에 있다.** 3단계 일정·예산은 정부가 "검토 중"이라 밝혔고 10월 시점 진행 상황은 확인하지 못했다. CSAP 인증·네이버/KT/삼성SDS 마켓플레이스·AWS Bedrock(Pro 4) 제공은 **확인되지 않았다**(Pro 4/Mini 4는 콘솔과 온프레미스만).
9. **권고(조사 기준)**: (a) 판정 계층은 `systemone` 어댑터를 추가해 Solar Decide를 **한국 리전 승인 후 2순위/주권 옵션**으로 병행 평가, (b) 추론 계층은 Solar Pro 4를 **비용·주권 옵션**으로 어댑터만 만들고 S7 코퍼스로 A/B 측정, (c) 문서 AI는 도입하지 않는다. 판단은 §6의 실측 계획 결과로 한다.
10. **범위 밖이지만 중요한 발견**: 같은 `/v1/systemone` 계약을 AWS Strands Decider 2B(Apache 2.0 가중치. "RTX 3090 중앙값 115ms"는 보도가 아니라 저장소 README의 자체 GPU 측정이며 CPU 수치가 아니다 — R8에서 정정)와 Ollama가 구현한다. 화면 판정을 **완전 로컬**로 돌리는 경로는 R8에서 별도 조사했다(결론: 한국어 파인튜닝 없이는 L1 대체 불가, Windows 런타임 미검증).

---

## 1. 사실 표

표기: `[공식]` 벤더 문서·가격 페이지·changelog / `[벤더자체]` 벤더 자체 평가 / `[보도]` 언론 / `[집계]` 제3자 집계·블로그 / `[정부]` 정부 브리핑.

### 1.1 모델 라인업·API (조사 항목 1)

| 항목 | 값 | 출처 | 근거 등급 |
|---|---|---|---|
| 최신 플래그십 | **Solar Pro 4** (`solar-pro4` 별칭 = `solar-pro4-260806`), 2026-08-06 출시, 가중치 비공개(독점) | https://console.upstage.ai/docs/models/solar-pro-4.md · https://console.upstage.ai/docs/resources/changelog.md | [공식] |
| 경량 모델 | **Solar Mini 4** (`solar-mini4` = `solar-mini4-260922`), 2026-09-22, 35B 총/3B 활성 MoE | https://console.upstage.ai/docs/models/solar-mini-4.md · https://www.upstage.ai/blog/en/solar-mini-4 | [공식] |
| 판정 전용 | **Solar Decide** (`solar-decide`, 한국 리전 문서에는 `solar-decide-flash`도 표기), Solar Mini 4 기반, **베타**, 2026-09-22 | https://console.upstage.ai/docs/models/solar-decide.md · https://console.upstage.ai/api/systemone | [공식] |
| 오픈 가중치 | **Solar Open 2** 250B/활성 15B, 1M 컨텍스트, Upstage Solar License, 2026-07-22경 공개. **API 서빙은 2026-08-12 종료**(가중치는 HF 유지) | https://huggingface.co/upstage/Solar-Open2-250B · changelog | [공식] |
| 기타 | `syn-pro-251021` 활성. Solar Pro 3 / Pro 2 / Mini는 **2026-10-30(KST) 전면 종료** | https://console.upstage.ai/docs/models/history.md | [공식] |
| 엔드포인트 | `https://api.upstage.ai/v1/chat/completions`, `/v1/responses`, `/v1/systemone`, `/v1/embeddings` | https://console.upstage.ai/api/chat.md · /api/responses.md · /api/systemone | [공식] |
| OpenAI 호환 | 공식 문서가 "Solar is compatible with the OpenAI API"로 명시, OpenAI SDK의 `base_url`만 바꿔 사용. 구현된 파라미터만 처리하고 나머지 OpenAI 파라미터는 **무시**(Responses 문서) | https://console.upstage.ai/docs/capabilities/generate/chat.md · /api/responses.md | [공식] |
| 컨텍스트 | Pro 4·Mini 4·Decide 모두 **512K**, 최대 출력 128K (집계 한 곳은 510K 표기) | solar-pro-4.md, solar-mini-4.md, solar-decide.md | [공식] |
| 지원 언어 | 영어·한국어·일본어(입출력) | solar-pro-4.md | [공식] |
| 학습 컷오프 | 2026-02 | solar-pro-4.md | [공식] |
| 추론(reasoning) | **기본 꺼짐**. `reasoning_effort`: `none`/`minimal`/`null`=끔, `low`~`max`=켬. 사고 과정은 `message.reasoning`으로 반환. 추론 토큰은 출력 토큰으로 과금, `max_tokens`가 작으면 content가 `null`·`finish_reason: length` | https://console.upstage.ai/docs/capabilities/generate/reasoning.md | [공식] |
| Structured Output | `response_format: {type:"json_schema", json_schema:{name, strict:true, schema}}`. 루트 object, 모든 속성 required(선택은 `["string","null"]`), `additionalProperties:false` 필수, 중첩 10단계, 로컬 `$defs/$ref` 가능. **`enum` 지원**. 미지원: `allOf/oneOf/not/if-then-else/patternProperties`, 재귀 `$ref`. 중첩 `anyOf`는 별칭에 따라 불안정 | https://console.upstage.ai/docs/capabilities/generate/structured-outputs.md | [공식] |
| Function calling | `tools`(function만), `tool_choice`: `none/auto/required`/특정 함수, `parallel_tool_calls`(기본 true). **strict 모드는 문서에 설명 없음**("JSON이 항상 유효하지는 않을 수 있다" 경고). 도구 수 상한 미기재 | https://console.upstage.ai/docs/capabilities/generate/tool-calling.md · /api/chat.md | [공식] |
| 샘플링 파라미터 | `temperature`(0~2, 기본 1), `top_p`, `frequency_penalty`(기본 **1.1**), `presence_penalty`, `max_tokens`, `stream` | /api/chat.md | [공식] |
| 로그프롭·seed·stop | **요청 파라미터로 문서화되지 않음.** 응답 스키마에 `choices[].logprobs`, `system_fingerprint` 필드는 있음. 실제 동작은 **미확인** → 실측 필요 | /api/chat.md · OpenRouter 지원 파라미터 목록에도 없음(https://openrouter.ai/upstage/solar-pro4) | [공식]+[집계] |
| 프롬프트 캐시 | 가격표에 "캐시 입력" 단가 존재(Pro 4 $0.06, Mini 4 $0.01), 요청에 `prompt_cache_key` 파라미터, 응답 `usage.prompt_tokens_details.cached_tokens`. **캐시 방식(자동/명시)·최소 길이·TTL은 문서에 없음(미확인).** Responses 문서에는 `prompt_cache_key`가 "미기재 → 무시"로 되어 있음 | /api/chat.md · /api/responses.md · https://www.upstage.ai/pricing | [공식] |
| 토크나이저 | `upstage/solar-pro4-tokenizer`(Pro 4·Mini 4 공용), HF `tokenizers`로 로컬 계산 가능. **한국어 토큰 효율 수치는 문서에 없음.** 제3자 벤치 작성자는 "Solar 토크나이저는 영어 쪽으로 장황"이라고 기록 | https://console.upstage.ai/docs/guides/counting-tokens.md · https://github.com/umstek/zero-shot-ie-bench/pull/17 | [공식]+[집계] |
| Responses API | Pro 4·Mini 4에서 사용(예시 기준; 지원 모델 목록은 문서에 없음). **stateless**: `previous_response_id`·`conversation`·`background`·`store:true`는 400. **텍스트 전용**(`input_image`·`input_file` 거부). reasoning 항목은 원문 텍스트, `summary`는 항상 빈 배열. 스트림에 `[DONE]` 없음 | https://console.upstage.ai/api/responses.md | [공식] |

### 1.2 가격·레이트 리밋

| 항목 | 값 | 출처 | 근거 등급 |
|---|---|---|---|
| Solar Pro 4 정가 | 입력 $0.30 / 캐시 $0.06 / 출력 $1.20 (1M, VAT 10% 별도) | https://www.upstage.ai/pricing · solar-pro-4.md | [공식] |
| Solar Pro 4 **현재 적용가** | 가격 페이지의 시간표: 2026-08-05~08-11 무료 → 08-11~09-11 정가의 10%(0.03/0.006/0.12) → 09-11~10-20 30%(0.09/0.018/0.36) → **2026-10-20 이후 50%(0.15/0.03/0.60), 종료일 미표기.** changelog도 "10-20 할인 70%→50%"로 일치 | https://www.upstage.ai/pricing · changelog | [공식] (표는 라벨 없는 원문 행 해석) |
| Solar Mini 4 | 정가 입력 $0.10 / 캐시 $0.01 / 출력 $0.40. 프로모션(30%→50% 가격)은 **2026-10-23 종료** → **오늘은 정가로 추정**(종료 후 표 행 없음). 블로그는 할인 문구가 서로 충돌("10-22까지 50%" vs "10-10까지 70%") | pricing · https://www.upstage.ai/blog/en/solar-mini-4 | [공식] |
| Solar Decide | 입력 **$0.10/1M**, 출력 **무료**, 캐시 토큰 **$0.10(할인 없음)**. OpenRouter 경유는 $0.05(제3자 벤치 작성 시 50% 할인 중이라고 기록) | solar-decide.md · https://github.com/umstek/zero-shot-ie-bench/pull/17 | [공식]+[집계] |
| 이전 세대 | Solar Pro 3 / Pro 2 정가 $0.15 / 캐시 $0.015 / 출력 $0.60. → Pro 4는 **정가 2배 인상** | pricing · https://artificialanalysis.ai/articles/upstage-solar-pro-4 (Pro 3 캐시를 $0.02로 표기해 공식 표와 1건 불일치) | [공식]+[집계] |
| 레이트 리밋(분당) | 티어는 **크레딧 구매액으로 자동 부여**. Pro 4: Tier0 100RPM/250K TPM, T1 400/500K, T2 2,000/750K, T3 4,000/1.5M, T4(엔터프라이즈) 8,000/3M. Mini 4와 **Decide**: T0 100/50K, T1 400/150K, T2 2,000/750K, T3 4,000/1.5M, T4 8,000/3M. 초과 시 429 | https://console.upstage.ai/docs/guides/rate-limits.md | [공식] |
| 레거시 티어 | 구 체계 사용자는 Pro 4·Mini 4·Decide가 티어 무관 100RPM/50K TPM 고정(2025-11-04 가격 개편 이전 체계) | rate-limits.md | [공식] |
| 계산(우리 게이트웨이) | 4,500토큰 번들 기준 50K TPM ≈ 11호출/분, 150K ≈ 33/분, 750K ≈ 166/분. 한도는 조직(키) 단위이므로 게이트웨이 한 키로 전 사용자를 받으면 T1 이상 필요 | 위 표로 계산한 추정 | 추정 |

### 1.3 성능·지연 (한국어 포함)

| 항목 | 값 | 출처 | 근거 등급 |
|---|---|---|---|
| Pro 4 종합 | Artificial Analysis Intelligence Index **42**(Pro 3은 14). 출력 약 43K토큰/과제로 "장황". 과제당 평균 8.6분(Pro 3은 6.0분). (한 검색 요약은 "27"로 표기했으나 AA 기사 원문과 불일치 → 42 채택) | https://artificialanalysis.ai/articles/upstage-solar-pro-4 · https://www.fnnews.com/news/202608140929331965 | [집계]+[보도] |
| Pro 4 환각 | AA-Omniscience −1(Pro 3은 −53)인데 주로 **답변 회피 증가**(시도율 92%→41%). 환각률 88%→24% | AA 기사 | [집계] |
| Pro 4 한국어 | KMMLU-Pro **79.2**, KBL(법) 77.5, KorMedMCQA 93.2, Ko-GDPval 87.3 — 전부 **Upstage 자체 평가(별표)**, 독립 검증 없음. Terra 등 타사 모델과의 한국어 비교표 없음 | https://www.upstage.ai/blog/en/solar-pro-4 | [벤더자체] |
| Pro 4 에이전트 | Terminal-Bench v2.1 57.0, τ³-Banking 23.0, AA-LCR 71.0, GPQA-D 89.0 (일부 벤더 하니스) | 위 블로그 | [벤더자체] |
| Mini 4 | AA Intelligence Index v4.3.2 **24.1**("3B 활성 모델 중 최고"), τ³-Banking 47.2, AA-LCR 83.3. **한국어 벤치 없음.** 자체 서빙 시 H100 2장·동시 32요청에서 요청당 70tok/s 이상(4K in/1K out, 프리픽스 캐시 없음) | https://www.upstage.ai/blog/en/solar-mini-4 | [벤더자체] |
| Solar Decide 정확도 | 문서에 **벤치마크 없음**(Upstage 미공개). 제3자(umstek/zero-shot-ie-bench PR): 주제 분류 48문항 **95.8%**(46/48), 9개 언어 54문 **100%**(한국어 포함 여부 미확인). **한국어 UI 상태 판정과는 무관한 소규모 영어/다국어 주제 분류**라 참고만 | https://github.com/umstek/zero-shot-ie-bench/pull/17 · https://www.digitalapplied.com/blog/decision-models-probabilities-not-text-api | [집계] |
| Solar Decide 지연 | 공식: "질문당 포워드 패스 1회", 속도 등급 5(Fast), 수치 없음. 제3자(OpenRouter 경유): 48문항 2요청 0.308초/문항, 9개 언어 텍스트당 0.885초(요청 1건씩) | solar-decide.md · 위 PR | [공식]+[집계] |
| Pro 4 지연 | OpenRouter 최근 1주 중앙값 TTFT 0.98초, 73tok/s(비교 페이지는 1.5~2.9초, 55~79tok/s로 편차). AA 1차 API: 109tok/s이나 **첫 답변 토큰까지 20초**(추론 기본 ON으로 측정한 것으로 추정). 우리 설정(추론 꺼짐/low)과 조건이 다름 | https://openrouter.ai/upstage/solar-pro4 (검색 요약) · https://artificialanalysis.ai/models/solar-pro4/providers (검색 요약) | [집계] 불일치 큼 |
| 한국 → API 왕복 | 측정 불가(실호출 안 함). 글로벌 엔드포인트의 호스팅 위치도 문서에 없음 | — | **미확인** |

### 1.4 Solar Decide 인터페이스 (조사 항목 2)

| 항목 | 값 | 출처 |
|---|---|---|
| 요청 | `POST /v1/systemone` `{model:"solar-decide", state: string|임의 JSON, questions: { <이름>: {type, instructions, criteria} }}`. `choice`는 `criteria`가 {라벨: 설명} 객체, `score`는 순서 있는 배열, `noul`은 `criteria` 없음(제3자 벤치는 "noul에 criteria를 넣지 말라"고 기록) | https://console.upstage.ai/api/systemone |
| 응답 | `answers[이름]`: choice → `choice`, `probabilities`(합 1), `confidence`; score → `score`(기대값 0~levels−1), `legend`, `probabilities`, `confidence`; noul → `noul`(예일 확률, confidence 없음). `usage.input_tokens`, `usage.output_tokens`(질문당 1토큰, 과금 안 함) | 동일 |
| 한도 | choice **2~26개**(내부적으로 단일 토큰 라벨 A~Z로 채점), 초과 시 422 `validation_failed`. 해결책은 질문 분할 또는 후보 축소. **요청당 최대 질문 수는 문서에 없음(미확인)** | 동일 |
| 문서에 없는 것 | 캐시 동작, 질문별 거절/기권, 이미지 입력(Responses·Chat은 텍스트 전용이고 Decide `state`도 문자열/JSON만 명시), 지연 SLO, 한국어 보정 데이터, `solar-decide-flash` 설명 | 동일 + 한국 리전 문서 |
| 상태 | "베타 — `/v1/systemone` 스키마는 GA 전에 바뀔 수 있다" | 동일 |
| 생태계 | 같은 계약을 TypeSafe Jev가 먼저 정의했고 AWS Strands Decider 2B, Ollama(0.35+/0.40+ 보도 불일치)가 구현했다는 보도. OpenAI는 별도 비공개 스키마 | https://thenewstack.io/decision-models-system-one/ (검색 요약만 읽음) · https://daily.dev/posts/aws-upstage-and-ollama-agree-on-a-decision-model-api-openai-hasn-t-signed-on--rqm13zwq2 · https://ollama.com/library/strands-decider |

### 1.5 데이터 처리·주권·배포 (조사 항목 3)

| 항목 | 값 | 출처 | 등급 |
|---|---|---|---|
| 학습 사용 | API(실시간·비동기) 입출력은 서비스 R&D·모델 학습에 쓰지 않음. 플레이그라운드·데모는 학습에 쓸 수 있음 | https://console.upstage.ai/docs/resources/faq.md | [공식] |
| 보존 | 실시간 API는 메모리에서 처리하고 저장하지 않음. **비동기 API**: 입력 문서 추론 완료까지(최대 3일), 출력 최대 30일 보관. 삭제 요청 시 즉시 영구 삭제. 모델 페이지: "서비스 제공에 필요하고 명시된 경우를 제외하고 입력을 저장하지 않음" (예외 범위·**악용 모니터링 로그 보존은 미확인**) | faq.md · solar-mini-4.md | [공식] |
| ZDR 상당 | "ZDR" 명칭의 별도 승인 프로그램은 문서에 **없음**(FAQ가 ZDR 미다룸 명시). 기본 정책이 "비저장·비학습"에 가까움. OpenAI처럼 승인·부속계약이 필요한지는 **미확인** | faq.md | [공식]+미확인 |
| 인증 | SOC 2, HIPAA, ISO/IEC 27001·27701, GDPR 원칙, DPA 제공. **CSAP·ISMS-P는 문서·검색에서 확인되지 않음**(KISA·ISMS-P 발급 현황 검색에도 항목 없음) | faq.md · solar-pro-4 블로그 · 검색 | [공식]+미확인 |
| 처리 리전 | 글로벌 `api.upstage.ai`: 위치 **미명시**. **한국 `kr.api.upstage.ai`: 비공개 베타(영업 문의에 "Korea region Closed Beta" 명시), 요청과 처리 데이터가 한국 내에서만 처리.** 지원: Mini 4(Chat), Decide(System One), Document Parse/OCR, Information Extract(`information-extract-kr-260904`). **Pro 4 없음.** Document Parse/IE는 standard만, IE는 베타·동기·분당 60페이지. "글로벌 대비 성능이 다를 수 있음" | https://console.upstage.ai/docs/guides/region-usage.md | [공식] |
| 기업 계약 | 엔터프라이즈: 커스텀 가격, 유연한 레이트 리밋, 전담 지원, SLA | pricing · faq.md | [공식] |
| 온프레미스 | "모든 모델 온프레미스 가능"(영업 문의). Pro 4·Mini 4 모델 페이지에 on-prem 표기. Mini 4는 양자화로 **H100 80GB 1장**. Pro 4는 파라미터·하드웨어 요구 **미공개**. 라이선스 형태·가격 **미확인** | solar-mini-4 블로그 · https://console.upstage.ai/docs/deployment-options.md | [공식] |
| 가중치 공개 | Pro 4·Mini 4·Decide: **비공개**. 공개 가중치는 **Solar Open 2**(250B/15B, Upstage Solar License: 상업 이용·파인튜닝·증류 허용, 파생 모델명 "Solar" 접두 + "Built with Solar" 표기 + 라이선스 동봉). 최소 4×H200, 권장 8×H200(보도의 "H200 2장"은 양자화 전제). llama.cpp·vLLM 메인라인 지원은 8월 기준 미병합 보도 | https://huggingface.co/upstage/Solar-Open2-250B · https://www.orcarouter.ai/blog/solar-open-2-250b-explained | [공식]+[집계] |
| AWS | **Bedrock 제공은 Solar Pro 2·Mini만.** Pro 4·Mini 4·Pro 3은 콘솔+온프레미스만. Azure는 Studio·Information Extract만, Snowflake는 Document Parse만 | https://console.upstage.ai/docs/deployment-options.md | [공식] |
| 국내 CSP | 네이버클라우드·KT클라우드·삼성SDS·NHN 마켓플레이스 제공 소식은 검색 2회에서 **찾지 못함**(AWS 2024-12 출시 기사만 확인). 미확인으로 처리 | 검색 | **미확인** |
| 유통 | OpenRouter(Pro 4·Decide), Hermes Agent, SolarChat, Upstage Studio. OpenRouter에는 Upstage ZDR 엔드포인트가 있다고 제3자가 기록 | solar-pro-4 블로그 · umstek PR | [공식]+[집계] |

### 1.6 문서 AI (조사 항목 4)

| 항목 | 값 | 출처 |
|---|---|---|
| Document Parse | 표준 **$0.01/페이지**, Enhanced $0.03(Auto 모드가 페이지별 선택). 최신 `document-parse-260930`(2026-09-30): Enhanced는 end-to-end VLM 파서, 디지털 PDF는 텍스트 레이어와 교차 검증. HTML/Markdown 출력. 약 0.6페이지/초. 형식: PDF, 이미지, DOCX/PPTX/XLSX, **HWP/HWPX**. 동기 100페이지·100MB, 비동기 2,000페이지·500MB | https://console.upstage.ai/docs/models/document-parse.md · input-requirements.md · pricing |
| OCR | **$0.0015/페이지**, 한글·한자·영숫자 완전 지원, 100페이지·100MB. 정확도 수치 **문서에 없음** | https://console.upstage.ai/docs/models/document-ocr.md |
| Information Extract | **$0.04/페이지**(Enhanced $0.06). 스키마 없이 임의 문서에서 JSON 키-값 추출, 정확도 수치 **없음**. 동기 100페이지·50MB. 사업자등록증·민원서류 전용 프리빌트 모델은 **확인 못함**(프리빌트는 수출 신고필증·인보이스 등 물류·영수증 계열이며 2026-05-06 폐기 표기) | https://console.upstage.ai/docs/models/information-extract.md · history.md |
| 실행 위치 | 콘솔(클라우드) / AWS Marketplace(OCR·Parse, IE) / Azure(IE) / Snowflake(Parse) / **온프레미스(영업 문의)**. **온디바이스(사용자 PC) 배포는 제공되지 않음.** 한국 리전은 표준 모드만 | document-parse.md · region-usage.md |
| 데이터 | "API 입력은 수집·학습·저장하지 않음". 비동기는 §1.5의 3일/30일 보관 | document-parse.md · faq.md |
| 비용 계산 | 1페이지 서류: Parse $0.01 + IE $0.04 = $0.05, OCR만 $0.0015 | 가격표로 계산 |
| **원칙 충돌** | 현 설계는 로컬 pdfjs + tesseract이고 서버에는 마스킹된 텍스트만 간다. Upstage 문서 AI는 **원본 PDF/이미지 전체(주민번호·사업자번호·대표자명 포함)**를 외부로 보내야 하므로 **충돌**한다. 온프레미스가 아니면 "로컬 처리 원칙"을 깨뜨림 | 설계 문서(`design/04`, `design/06`) 대비 |

### 1.7 독파모·공공 (조사 항목 5)

| 항목 | 값 | 출처 | 등급 |
|---|---|---|---|
| 2차 평가 | 2026-08-18 발표: **Upstage·SK텔레콤·LG AI연구원 3팀 통과, 모티프테크놀로지스 탈락.** 평가: 벤치마크 40(AAII 25 + NIA 15) + 전문가 35 + 사용자 25 | https://www.korea.kr/briefing/policyBriefingView.do?newsId=156774781 | [정부] |
| Upstage 평가 의견 | 퓨리오사AI NPU 결합과 포털 '다음' 서비스 PoC 실증이 우수 사례로 언급 | 동일 | [정부] |
| 점수 | 정부 브리핑은 "팀별 순위·항목별 점수는 공개하지 않았다"고 명시. 그런데 뉴스핌(8-27)은 총점 SKT 70.6 / **Upstage 69.9(2위)** / LG 69.0 / 모티프 65.8과 항목별 점수를 보도. **정부 비공개 vs 보도 불일치 → 점수는 참고만** | https://www.newspim.com/news/view/20260827001289 | [보도] 불일치 |
| 모델 | Solar Open 2 AAII 37점대(4팀 모두 31점 이상) | https://www.aieconlab.com/post/trend21_dokpamo_2nd_eval/ | [보도] |
| 3단계 | 통과 팀 GPU 확대 지원(팀당 약 400억 원 규모 6개월 임대 추정), 3단계 구조·예산은 정부가 "검토 중, 크게 바뀔 수 있음"이라 밝힘. 보도는 "내년 초 최종 2팀 선발". **10월 시점 진행 상황은 검색에서 못 찾음** | korea.kr · https://www.mt.co.kr/tech/2026/08/18/2026081811163731186(제목만) | [정부]+[보도] |
| 공공 사례 | (1) 과기정통부 **정부 R&D 예산 심의 AI**를 Solar 기반으로 구축(KISTI·ETRI 협업, 2026-05-14 보도, 호스팅 형태 미명시). (2) 포털 '다음' 검색에 솔라 탑재(2026-07, 제목만 확인). (3) **아이티로그인**과 공공 조달 파트너십(2026-10-14 보도): 중앙부처·지자체·공공기관에 Solar LLM·Document AI를 **온프레미스 소버린 AI**로 공급, 로드쇼 10-27(부산)~11-12(서울). 나라장터 등록 여부·CSAP는 기사에 없음 | https://m.news.nate.com/view/20260514n29948 · https://www.denews.co.kr/news/articleView.html?idxno=42720 | [보도] |
| CSAP 맥락 | 2026-04 정부가 공공 클라우드 보안검증을 국정원 중심으로 일원화(CSAP 개편, 2027-07 시행 보도, 기존 인증은 유효기간 인정). **Upstage의 CSAP 인증은 확인되지 않음.** 이 제도 기사는 검색 요약만 읽음 | https://zdnet.co.kr/view/?no=20260420130424 | [보도] 원문 미열람 |
| 이점(해석) | 정부 프로젝트 3강, 국산 모델, 한국 리전(베타), 온프레미스 옵션은 "공공 AX 영업 자료"에서 설득력이 있다. 다만 **CSAP·ISMS-P 미확인이므로 공공기관이 클라우드 API를 직접 쓰는 경로는 아직 증명되지 않았다**(온프레미스 경로만 사례 존재) | 위 종합 | 해석 |

### 1.8 리스크 (조사 항목 6)

| 항목 | 값 | 출처 | 등급 |
|---|---|---|---|
| 모델 수명 | Pro 3: 2026-01-26 출시 → 2026-10-30 전면 종료(약 9개월). Pro 2: 2025-07(250710) → 2026-10-30. 스냅샷: `solar-pro3-260126`은 출시 3개월 뒤(04-30) 폐기, `solar-pro2-250909`는 2026-01-06 폐기. Solar Open 2: 07-08 공개 → 08-12 API 종료(5주) | history.md · changelog | [공식] |
| 문서 AI 수명 | Document Parse·OCR·IE 스냅샷은 4~9개월마다 교체, 구버전은 폐기(예: `document-parse-260630`은 2026-11-02 종료). 프리빌트 추출 모델 일괄 2026-05-06 폐기 | history.md | [공식] |
| 고지 기간 | Pro 3 종료는 2026-09-30에 공지, 시행 2026-10-30(약 30일) | changelog | [공식] |
| 별칭 | `solar-pro4`는 별칭이라 스냅샷이 바뀔 수 있음. 스냅샷 고정 모델명(`solar-pro4-260806`) 존재 | solar-pro-4.md | [공식] |
| 가격 변동 이력 | 세대 교체 시 정가 2배(Pro 3→4), 대폭 프로모션(무료→10%→30%→50%)이 단계적으로 줄어드는 구조(종료일 미표기), 2025-11-04 가격·티어 개편, 2025-12-04 Pro 2 캐시 단가 분리, 임베딩 2026-08-24 유료화 | pricing · changelog · rate-limits.md | [공식] |
| SLA | 월 가용성 **95.0% 초과**(채팅·임베딩·OCR·IE·Parse·Classify 대상; **Decide·Responses 언급 없음**), 500/502/503/504만 오류로 계산, 보상은 전월 사용료의 1.5배 크레딧(1개월 내 신청서 제출). 지원 응답시간 미기재. 무료 티어 제외 | https://console.upstage.ai/docs/terms/sla.md | [공식] |
| 회사 | 2026-04 시리즈C 1차 1,800억 원, 누적 약 4,000억 원, 기업가치 1조 원 이상(국내 생성형 AI 첫 유니콘). 연 130%+ 매출 성장이라 주장. 보도상 2024 매출 139억 원·영업손실 402억 원, IPO 주관사 선정(원문 일부 미열람) | https://www.newspim.com/news/view/20260415001058 · 검색 요약 | [보도] |
| 한국어 외 성능 | 영어·일본어 입출력 지원. Pro 4 일본어 Arena-Hard v2 81.9 등(벤더 자체). 그 외 언어는 지원 대상 아님 | solar-pro-4 블로그 | [벤더자체] |
| 응답 형식 주의 | Mini 4 블로그 자체가 "벤더 내부 테스트이며 결과는 워크로드에 따라 다르다"고 명시 | solar-mini-4 블로그 | [공식] |

---

## 2. OpenAI 현행 대비 비교표

가정(R1 번들 예시 기준): 판정 1호출 = 고정 접두 2,000 + 화면 1,500 + 질문 1,000 = 입력 4,500토큰. 추론 1호출 = 입력 8,000 + 출력(추론 포함) 1,500토큰. Solar 토큰 수는 OpenAI와 동일하다고 가정했으나 **한국어에서 Solar 토크나이저가 더 많은 토큰을 낼 수 있어(미확인) 최대 1.3~1.5배 보정 여지**가 있다.

### 2.1 판정 계층

| 항목 | OpenAI Decisions (`gpt-6-luna`) | Upstage Solar Decide (`/v1/systemone`) | Solar Mini 4 Chat 흉내(json_schema enum) |
|---|---|---|---|
| 상태 | GA(2026-10-22) | **베타**(스키마 변경 가능) | GA급(모델), 방식은 우회 |
| 입력 단가 | $0.10/1M | $0.10/1M(OpenRouter $0.05) | $0.10/1M (캐시 $0.01) |
| 출력 단가 | 무료 | 무료 | $0.40/1M |
| 캐시 | 명시 모드, 읽기 $0.01, **쓰기 $0.125(프리미엄)**, 최소 접두 1,024토큰 | 캐시 단가가 입력과 동일($0.10) → 할인·쓰기 프리미엄 모두 없음(동작 미확인) | 읽기 $0.01, 방식 미확인 |
| 4,500토큰 번들 1회 비용 | 비캐시 $0.00045, 명시 캐시 적중 $0.00027 | **$0.00045**(토큰 1.3배면 $0.00059) | 입력 $0.00045 + 출력 200토큰 $0.00008 = **$0.00053** |
| 월 사용자당 수십만 토큰(30만 가정) | $0.03 | $0.03 | $0.03~0.04 |
| 지연 | 절대 수치 미확인(R1) | 질문당 포워드 1회, 제3자 측정 0.3~0.9초(OpenRouter 경유) | 출력 약 200토큰 ÷ 70tok/s ≈ 3초 + TTFT. 질문이 늘면 출력이 선형 증가(400문항 ≈ 8,000토큰 → 100초대) |
| 질문 수 | 1~400 | **미확인** | 스키마 크기에 의존(property 수 상한 미확인) |
| 선택지 수 | choice 2~255, score 2~10단계 | choice **2~26**, score 수준 수 상한 미확인 | enum 크기 상한 미확인 |
| 확률 출력 | `probabilities[]` + `confidence`(보정 보증 없음) | `probabilities` + `confidence`, **"보정됨"이라 주장하나 근거 벤치 없음** | 로그프롭 **미확인**. 없으면 확률 불가 → 자기 보고 신뢰도(보정 나쁨) 또는 샘플링 |
| 질문 독립성 | 질문끼리 답을 못 봄 | 질문당 포워드 패스 → 독립으로 추정(문서에 명시 없음) | **독립 아님**(자기회귀라 앞 답이 뒤 답에 영향) |
| 질문별 거절 | 있음(`refusal`) | **없음**(문서 언급 없음) | 모델이 스키마 enum 밖으로 못 나감, `unknown` 라벨로 대체 |
| 이미지 입력 | 지원 | 텍스트/JSON `state`만 명시 | Chat 텍스트 전용 확인 안 됨(Responses는 텍스트 전용) |
| 데이터 주권 | 한국 리전은 저장만, 처리는 미국·EU·UAE. ZDR은 승인형 | **한국 리전 처리**(비공개 베타·승인 필요), 기본 비저장·비학습 | 한국 리전에 Mini 4 Chat 포함 |
| 레이트 | Decisions 전용 수치 미확인 | T0 100RPM/50K TPM … T2 750K TPM | 동일 |
| 신뢰도 근거 | 공식 정식 출시, 시스템카드 | 제3자 소규모 벤치만 | 자체 검증 필요 |

### 2.2 추론 계층

| 항목 | OpenAI GPT-6.1 Terra | Solar Pro 4 | Solar Mini 4 |
|---|---|---|---|
| 입력/캐시/출력 (1M) | $1 / $0.05 / $5 | 정가 $0.30 / $0.06 / $1.20, **현재 $0.15 / $0.03 / $0.60**(프로모션) | $0.10 / $0.01 / $0.40 |
| 호출 1회(8K in + 1.5K out) | $0.0155 | 정가 $0.0042 / 현재 **$0.0021** | **$0.0014** |
| 컨텍스트 | 1,050,000 | 512K, 출력 128K | 512K, 출력 128K |
| Responses API | 네이티브(stateful 가능) | **있음, stateless**(`store:true`·`previous_response_id` 거부) | 동일 |
| strict 함수 도구 | 보장(`additionalProperties:false`+전부 required) | 문서에 strict 설명 없음, **json_schema `strict:true`는 문서화**. 도구 인자 스키마 준수는 실측 필요 | 동일 |
| reasoning | none~max 6단계, 기본 medium | 기본 **꺼짐**, `low`~`max`, 사고 원문 반환(요약 없음) | 동일 |
| 한국어 근거 | R1 외 비교 없음 | KMMLU-Pro 79.2 등 **자체 평가**만 | 한국어 벤치 없음 |
| 지연 | 미측정 | OpenRouter 중앙값 TTFT 1~2초대, 55~80tok/s(편차 큼). 추론 켜면 20초대 보고(AA) | 자체 서빙 70tok/s+ |
| 데이터 주권 | 미국·EU·UAE 처리, ZDR 승인형 | **글로벌 엔드포인트만**(한국 리전에 Pro 4 없음) → 위치 미명시. 기본 비저장·비학습 | 한국 리전 가능 |
| SLA | 미확인(R1 범위 밖) | >95% | >95%(Responses 포함 여부 미기재) |
| 수명 | — | 별칭 교체·약 9개월 수명 | 신규(2026-09) |
| 온프레미스 | 불가 | 영업 문의(Pro 4 스펙 미공개) | 양자화 H100 1장 |

---

## 3. 전환 시 설계 변경점 추정 (`model/adapters/*`)

1. **어댑터 추가(파일 단위로 격리 가능)**
   - `adapters/upstage-systemone.ts`: `decide()` 구현. 요청 매핑: `predicate` → `noul`(criteria 생략), `choice` → `criteria{label: description}`(**26개 상한**), `score` → 배열. 응답 매핑: `noul` → `probability`, 나머지는 `probabilities`/`confidence`. `answers`는 **객체(이름 키)**라서 OpenAI의 배열(`answers[]`, 순서) 가정과 다르므로 이름 기반 조인으로 정규화한다.
   - `adapters/upstage-responses.ts`: `respond()` 구현. `baseURL=https://api.upstage.ai/v1`로 기존 OpenAI SDK를 재사용할 수 있으나 **파라미터가 조용히 무시**되므로 응답 검증을 어댑터가 소유(예: `prompt_cache_key`·`safety_identifier`는 무시될 가능성).
   - `adapters/upstage-chat-enum.ts`(Decide 불가 시 대체): 번들 → 단일 json_schema 객체(질문별 enum 속성), 시스템 프롬프트에 `unknown` 허용 규칙.
2. **`DecideResult` 계약 보강**: `refusals`는 Upstage에서 항상 빈 배열. 번들 정의의 `onRefusal`은 유지하되, Upstage 경로에서는 임계값 미달이 곧 `unknown`이 되는지 S7 코퍼스로 확인한다. `confidence` 의미도 공급사마다 다르므로 **임계값은 공급사별 번들 오버라이드**(`thresholds.<vendor>`)를 허용해야 한다(R1·D04가 이미 "보정 보증 없음"으로 재산정 예정).
3. **캐시 설계**: `prompt_cache_options`(명시 브레이크포인트)는 OpenAI 전용이다. Decide는 캐시 할인이 없어 고정 접두를 줄이는 쪽이 이득이고, 번들당 1,100~2,000토큰 접두 규약(D04 §2.1)은 Upstage 경로에서 의미가 사라진다. 비용은 센트 미만이라 문제 없다.
4. **선택지 상한 대응**: `intent_route_v1`은 플레이북 15개 + `none_of_these` = 16개로 상한 26 안에 있지만, 카탈로그가 26개를 넘으면 2단계 분류(도메인 → 플레이북)로 분할해야 한다. 번들 빌드 단계에서 정적 검증으로 막는다.
5. **게이트웨이**: 공급사별 레이트 한도가 다르다(Decide T0 50K TPM). 게이트웨이는 Upstage 키 1개로 전 사용자를 받으면 T1(150K TPM, 크레딧 구매) 이상이 필요하고 429 처리(Upstage 코드표는 미조사)를 어댑터 재시도 정책에 추가한다. 한국 리전은 별도 도메인·승인이 필요하다.
6. **데이터 거주 플래그**: 사용자·테넌트 단위로 `region=kr`이면 `kr.api.upstage.ai` + Decide/Mini 4만 허용하고 Pro 4는 금지하도록 라우팅 정책을 둔다(Pro 4가 한국 리전에 없기 때문). 현재 추론 계층은 OpenAI이므로 주권 요구가 강한 테넌트에는 **Mini 4 + Responses를 한국 리전에서 쓸 수 있는지**(한국 리전 문서는 Mini 4의 Chat Completions만 표기)가 핵심 미확인 사항이다.
7. **버전 고정·이관 주기**: 모델 ID는 스냅샷 고정(`solar-pro4-260806` 등)으로 쓰고, 번들·툴셋 회귀 스위트(D13)를 분기마다 신규 스냅샷에 돌린다. 폐기 공지가 약 30일이므로 CI에서 changelog를 감시한다.
8. **문서 AI**: 코드 변경 없음(도입하지 않음). 필요 시 `doc-extract` 어댑터를 **옵트인 서버 처리**로만 열고, 온프레미스 계약 전에는 마스킹 전 PDF를 보내지 않는다.
9. **테스트 환경**: 모의 서버가 `/v1/systemone` 응답 형태(객체형 answers)를 낼 수 있어야 한다. 이 계약은 Ollama/Strands Decider로 로컬에서도 재현 가능하다는 보도가 있어 **오프라인 CI 픽스처**로 활용할 수 있다(미검증).

---

## 4. 판정 흉내 낼 때 추정 방법 (Decisions 대안이 막힐 경우)

Decide가 한국 리전·GA에서 쓸 수 없을 때를 가정한 Mini 4 / Pro 4 Chat 방식.

- **비용**: 입력은 판정과 동일 단가. 출력만 추가: 질문당 약 15~25토큰(JSON 키 + enum 값) → 10문항 번들 약 200토큰 ≈ $0.00008(Mini 4). 400문항이어도 약 $0.003 수준이라 비용보다 **지연**이 문제다.
- **지연**: 출력이 자기회귀이므로 `출력 토큰 ÷ 토큰속도 + TTFT`. 70tok/s 가정 시 10문항 ≈ 3초 안팎, 40문항 ≈ 12초. Decide(0.3~0.9초대 보고)보다 한 자릿수 느리다. 실시간 화면 판정(예: 매 스텝)에는 번들당 3~4초가 실행 시간을 직접 늘린다. **측정 필요**(한국 egress p50/p95).
- **결정성·확률**: `temperature:0`을 권하지만 `seed`는 문서에 없다. 로그프롭이 동작하면 enum 첫 토큰 확률로 확률을 얻을 수 있으나 **문서화되지 않아 미확인**이다(`logprobs:true`로 1회 호출 검증). 불가하면 (a) 자기 보고 신뢰도 필드(보정 불량), (b) n회 샘플링(비용·지연 n배, `n` 지원 미확인) 중 선택해야 한다.
- **정확도 추정 절차**: D04 S7 라벨 코퍼스(화면 최소 수백 건, 한국어 의도 300문장)를 같은 번들 정의로 3경로(Luna Decisions / Solar Decide / Mini 4 Chat)에 돌린다. 지표: 정확도, `unknown` 비율, 임계값(.85/.95)에서의 정밀도·재현율, ECE(보정 오차), 경로 간 불일치율. **비가역 직전 판정(`form_ready_v2`)은 위양성률 상한을 보증해야 하므로** 오답 0건 300건이면 95% 신뢰 상한 약 1%(3/n 규칙)이므로 양성 샘플 300건 이상이 필요하다.
- **독립성 보정**: Chat 방식은 질문 순서에 따라 답이 영향받을 수 있으므로, 위험 질문(`security_warning`, `captcha_visible`)은 번들을 분리하거나 순서를 바꿔 두 번 호출해 비교한다.

---

## 5. 지금까지 확인한 상충·주의 사항

- **Solar Pro 4 출시일**: 콘솔 모델 페이지·changelog는 2026-08-06, 보도는 08-10/08-11/08-13/08-14로 표기(발표·유료 개시 시점 차이로 보임). 공식값 08-06 채택.
- **AA Intelligence Index**: 42(AA 기사·보도) vs 27(검색 요약 한 건) → 42 채택.
- **Pro 4 가격**: 일부 집계는 OpenRouter $0.15/$0.60을 기재(프로모션가와 일치). 정가는 $0.30/$1.20. **할인은 영구가 아니므로 예산은 정가 기준으로 잡아야 한다.**
- **독파모 점수**: 정부 비공개 vs 보도 공개 불일치(§1.7).
- **Solar Decide 컨텍스트**: 한 집계 페이지가 4K로 표기했으나 공식은 512K.
- **Decide 경로**: 문서 본문 일부가 `/systemone`, 다른 곳이 `/v1/systemone`로 표기. 최종 URL은 `https://api.upstage.ai/v1/systemone`(예시 코드 기준).
- 이 조사에서 WebFetch는 요약 모델을 거쳤으므로, 가격·한도 같은 핵심 숫자는 **키 발급 후 콘솔 화면과 1회 호출 응답으로 재확인**해야 한다.

---

## 6. 미확인 목록과 확인 방법

| # | 미확인 | 확인 방법 | 영향 |
|---|---|---|---|
| 1 | Decide 요청당 최대 질문 수, 점수 단계 수 상한, 이미지 입력, 캐시 동작 | 콘솔 키 발급 후 OpenAPI(`openapi-systemone.yaml`) 열람 + 질문 50/100/400개 요청 시험 | 번들 구성(질문 최대 10개 가정)에 직접 영향 낮음, 확장 시 영향 |
| 2 | Decide 질문별 기권/거절, 확률의 실제 보정도 | S7 코퍼스로 ECE 측정, 모호 입력에서 응답 분포 관찰 | 임계값 정책(.85/.95) |
| 3 | Solar Decide 한국어 정확도 | 한국어 화면 텍스트 코퍼스 A/B | 채택 여부의 핵심 |
| 4 | 한국 리전 신청 조건·소요, Pro 4 추가 예정, Responses API 지원 여부 | Upstage 영업에 "Korea region Closed Beta" 문의(문서 안내 그대로) | 주권 요구 테넌트 라우팅 |
| 5 | 글로벌 엔드포인트의 호스팅 위치, 하위 처리자(AWS 등), 악용 모니터링 로그 보존, ZDR 상당 계약 문구 | DPA·개인정보처리방침(한국어판 `privacy-policy-ko`)과 영업 문의 | 법무·개인정보 위탁 문서 |
| 6 | CSAP·ISMS-P 인증 | KISA CSAP 인증 목록, ISMS-P 발급 현황 조회 + 영업 문의 | 공공기관 직접 도입 가능성 |
| 7 | 네이버클라우드·KT클라우드·삼성SDS·NHN 마켓플레이스 제공 | 각 CSP 마켓플레이스 직접 검색 | 국내 CSP 경유 조달 |
| 8 | 로그프롭·seed·`n` 지원, strict 도구 호출 보장, 프롬프트 캐시 방식 | 1회씩 실호출 (`logprobs:true`, 동일 요청 2회 `cached_tokens` 확인, strict 스키마 위반 유도) | Chat 방식 판정 흉내 가능 여부 |
| 9 | Responses에서 reasoning 항목 재생(암호화 없음) 시 다회 도구 루프 정상 여부 | `selector_repair` 툴셋 모의 대화 스파이크 | 추론 계층 이식 비용 |
| 10 | 실제 지연(한국 egress p50/p95), 429 코드 체계 | 실측 | 사용자 체감, 재시도 정책 |
| 11 | Pro 4 프로모션 종료일, 향후 정가·티어 정책 | 가격 페이지 주기 확인, 영업 문의로 연간 약정 가격 | 예산 |
| 12 | 온프레미스 라이선스 모델·가격·Pro 4 하드웨어 요구 | 영업 문의 | 기관 설치형 |
| 13 | 사업자등록증·민원서류에 대한 IE/Parse 정확도 | 샘플 문서(비식별) 10~30건 플레이그라운드 시험 | 문서 AI 도입 가치(현재 비도입 권고) |
| 14 | 독파모 3단계 진행·결과, 2차 점수 공식 공개 여부 | 과기정통부 보도자료, NIPA 공지 | 신뢰도 신호 |
| 15 | AWS Strands Decider / Ollama `/v1/systemone` 로컬 판정 실현성 | 별도 조사(R7) + 한국어 정확도 시험 | 판정 계층 완전 로컬화 |

---

## 7. 출처 모음 (전부 2026-10-28 확인)

- Upstage 콘솔 문서: https://console.upstage.ai/llms.txt (페이지 목록) · /docs/models/solar-pro-4.md · /docs/models/solar-mini-4.md · /docs/models/solar-decide.md · /api/systemone · /api/chat.md · /api/responses.md · /docs/capabilities/generate/structured-outputs.md · /reasoning.md · /tool-calling.md · /docs/guides/rate-limits.md · /docs/guides/region-usage.md · /docs/guides/counting-tokens.md · /docs/resources/changelog.md · /docs/resources/faq.md · /docs/models/history.md · /docs/deployment-options.md · /docs/terms/sla.md · /docs/models/document-parse.md · /document-ocr.md · /information-extract.md · /docs/capabilities/parse/input-requirements.md
- 가격: https://www.upstage.ai/pricing
- 블로그: https://www.upstage.ai/blog/en/solar-pro-4 · https://www.upstage.ai/blog/en/solar-mini-4
- 모델 카드: https://huggingface.co/upstage/Solar-Open2-250B
- 제3자: https://artificialanalysis.ai/articles/upstage-solar-pro-4 · https://openrouter.ai/upstage/solar-pro4 · https://benchlm.ai/models/solar-pro-4 · https://github.com/umstek/zero-shot-ie-bench/pull/17 · https://systemonemodels.org/models/ · https://www.digitalapplied.com/blog/decision-models-probabilities-not-text-api · https://daily.dev/posts/aws-upstage-and-ollama-agree-on-a-decision-model-api-openai-hasn-t-signed-on--rqm13zwq2 · https://thenewstack.io/decision-models-system-one/ · https://ollama.com/library/strands-decider · https://www.orcarouter.ai/blog/solar-open-2-250b-explained
- 정부·보도: https://www.korea.kr/briefing/policyBriefingView.do?newsId=156774781 · https://www.newspim.com/news/view/20260827001289 · https://www.aieconlab.com/post/trend21_dokpamo_2nd_eval/ · https://www.fnnews.com/news/202608140929331965 · https://www.newspim.com/news/view/20260415001058 · https://www.denews.co.kr/news/articleView.html?idxno=42720 · https://m.news.nate.com/view/20260514n29948 · https://zdnet.co.kr/view/?no=20260420130424
