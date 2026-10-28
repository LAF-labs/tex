# R8. System One 판정 계약과 로컬 판정 모델 — L1 완전 로컬(egress 0) 대안 평가

> 조사일: 2026-10-28 · 대상: `POST /v1/systemone` 계약, AWS Strands Decider 2B, Ollama `strands-decider`, llama.cpp 디시전 지원, 기타 로컬 소형 판정·한국어 소형 LM, 결정적 규칙 대체 가능성
> 선행: R1(OpenAI Decisions), R6(Upstage Solar). R6 §0-10이 "범위 밖 발견"으로 넘긴 로컬 판정을 이 노트가 맡는다. Upstage Decide의 가격·한국 리전·SLA는 R6에 있으므로 여기서는 계약 필드 비교만 다룬다.
> **검증 수준**: 모델을 내려받아 실행하거나 API를 호출한 것은 **없다**(문서 조사 전용). 모든 페이지는 WebFetch의 요약 모델을 거쳐 읽었으므로 숫자는 원문 인용이 확인된 것만 "확정"으로 썼고, 확인 못 한 것은 **미확인**이다. 확인일은 모두 2026-10-28. 출처 표기: `[1차]` 벤더·저장소·모델 카드, `[공식문서]` Ollama 등 제품 공식 문서, `[커뮤니티]` 제3자 실측·변환본, `[보도]` 언론·집계, `[추정]` 이 노트의 계산·판단.
> **중요한 사실 정정**: R6이 인용한 "RTX 3090 중앙값 115ms"는 보도 숫자가 아니라 **저장소 README의 자체 측정**이다(v1, WSL2 위 RTX 3090, 중앙값 115 ms, p95 299 ms). 다만 이는 GPU 수치이고 **우리 대상(GPU 없는 Windows 노트북)에는 해당하지 않는다.**

---

## 0. 요약 (설계 함의)

1. **System One은 "표준"이 아니라 TypeSafe Jev가 정의한 사실상 계약이다.** 공식 사양서·거버넌스 기구·변경 절차는 어디에도 없다. `systemonemodels.org`는 스스로 "독립 사이트, TypeSafe와 무관"이라 밝힌다. 구현체마다 한도(선택지 26 vs 255, 질문 수, 문맥)가 다르고 OpenAI Decisions는 필드 구조 자체가 다르다. 어댑터가 **정규화**하고 **구현체별 한도·임계값 프로필**을 가져야 한다.
2. **Strands Decider 2B는 가중치·코드·학습 레시피가 Apache-2.0으로 공개**돼 있고(HF `StrandsAgents/…`, GitHub `strands-labs/strands-decider`) 파인튜닝 스크립트도 있다. 그러나 **문맥 4,096토큰**, **영어 중심**(한국어 평가 없음), JevBench 공개셋 정확도 **0.779**(어려운 층 0.586)다. 우리 번들 입력(고정 접두 1~2K + 화면 1.5K+ + 질문)은 **한도에 걸리거나 넘칠 수 있고, 기본 동작은 조용한 절단**이다.
3. **Ollama `strands-decider`는 우리 대상 PC에서 쓸 수 없다.** 라이브러리 페이지가 "Requires Ollama 0.40.0 or later on an Apple silicon Mac … run with MLX"라고 명시하고 태그가 전부 MLX 형식이다. Windows 11 GPU 없는 노트북은 **Ollama 경로 불가**(Ollama의 다른 디시전 모델 일부도 Apple 한정 표기).
4. **Windows CPU에서 실제 돌릴 경로는 셋뿐이고 모두 미검증이다.** (a) Python/PyTorch 참조 구현(CPU 메모리 약 7.9GB, M5 CPU에서 385토큰 2.8초·1,290토큰 5.7초 — 8~16GB 일반 노트북에는 과중), (b) 커뮤니티 ONNX 변환(q4f16 1.09GB / q8 1.80GB, 실측 없음), (c) llama.cpp(`/v1/systemone` 2026-10-02 병합, 그러나 Strands의 pointer head 지원은 **확인되지 않음**). [추정] 3.5~4K토큰 입력이면 M5급 CPU에서도 10초대, 일반 노트북은 그 이상 — 실행당 L1 최대 12회 예산이면 **분 단위 지연**이 된다.
5. **한국어 정확도는 근거가 없다.** Strands 카드는 지원 언어를 명시하지 않았고 한국어 평가가 없다. 가장 가까운 자료는 Laya 다국어(322M)의 한국어 20지선다 의도분류 **0.490**(우연 0.05)과, Kev-4B에 한국어 11라벨 데이터 3,947줄로 파인튜닝한 커뮤니티 모델의 **94.6~96.3%(위험 오류 6건·2건)**뿐이다. 결론: **한국어 파인튜닝 없이는 L1 대체 불가, 하면 가능성은 있음.**
6. **egress 0이 되는 것은 L1 호출분뿐이다.** 마스킹된 접근성 텍스트(≤6KB), 팝업·결과 화면 텍스트, 의도 문장(`intent_route`), 서류 메타가 로컬에서 끝난다. 그러나 L2(Terra 추론)가 같은 마스킹 텍스트를 읽는 한 **전체 egress는 0이 아니다.** "완전 로컬 하네스"를 말하려면 L2 로컬화(별도 조사)가 전제다.
7. **사라지는 위협**: 판정 공급사로의 화면 텍스트 전송·국외 이전, 프롬프트 캐시 적중 오라클, 공급사 ZDR 승인·계정 정지 연쇄, 레이트 한도·장애, 모델 폐기(Upstage는 약 9개월 수명). **새로 생기는 위협**: 모델 파일 공급망(HF 계정 탈취, 커뮤니티 변환본), 인증 없는 로컬 서버(`127.0.0.1`, 인증 없음), 4,096 초과 시 **조용한 절단으로 경고 문구 누락**, 기기별 성능 편차, 정확도 저하로 인한 핸드오프 증가.
8. **하이브리드(로컬 → 임계값 미달 시 클라우드)는 타당하나 "egress 0"은 포기**해야 하고, 로컬 신뢰도는 보정 보증이 없다. 비가역 직전·직후 판정(`form_ready_v2`, `issue_result_v2`)과 보안 판정은 **로컬 단독 통과 금지**가 맞다.
9. **L1 질문 20개 중 약 11개(55%)는 결정적 규칙(DOM 상태·키워드·산술)으로 모델 없이 대체 가능**, 6개는 규칙 1차 + 모델 보조, 3개(`intent_route` 선택, `mentions_tax_advice`, `page_text_addresses_agent`)는 모델이 필요하다고 본다([추정], §5.3). 로컬 모델 도입 전에 **규칙 계층(L0)을 먼저 넓히는 편이 비용 대비 효과가 크다.**
10. **권고**: 지금 설계는 클라우드 L1 유지. ① 규칙 L0 확대 ② `systemone` 어댑터에 구현체별 프로필(한도·임계값·절단 정책) 추가 ③ 스파이크(§7)로 Strands Decider(ONNX/llama.cpp)·Laya 다국어·Kev-4B를 한국어 코퍼스로 측정한 뒤 **옵트인 "엄격 프라이버시 모드"** 여부를 결정. 설치본 +1.1~2GB, 모델 서명 배포는 플레이북 레지스트리 경로 재사용.

---

## 1. System One 계약 (조사 항목 1)

### 1.1 정체·거버넌스·버전

| 항목 | 사실 | 출처 | 등급 |
|---|---|---|---|
| 정의자 | TypeSafe AI가 "System One" 용어를 만들고 2026-09-15 Jev를 첫 모델로 출시. 계약은 Jev의 `/v1/systemone` 요청 형태 | https://systemonemodels.org/guides/what-is-a-system-one-model/ | [보도·독립사이트] |
| 사양서 | 독립 사이트에는 **공식 사양서 없음**. TypeSafe 문서 `models` 페이지는 "System One spec" 절에서 엔드포인트·입력·과금·버전 고정을 설명하나 **개방 표준·거버넌스에 대한 언급은 없다** | https://systemonemodels.org/ · https://docs.typesafe.ai/models | [독립사이트][1차(TypeSafe)] |
| 거버넌스 | 위원회·변경 절차·기여 규칙 **없음**. 사이트가 "Not affiliated with TypeSafe AI or any model vendor"라고 명시. 다른 검색 결과에 나온 NoulXP는 모델 **패키징** 표준이지 거버넌스 기구가 아님 | https://systemonemodels.org/ · 검색 | [독립사이트][보도] |
| 클라이언트 SDK | TypeSafe `typesafe-sdk`(Python), `@typesafe-ai/sdk`(JS)가 사실상 기준 클라이언트. Pydantic AI도 `SystemOneModel`로 임의 base URL 지원, **"각 모델의 confidence는 고유하므로 임계값은 모델 간 이전되지 않는다"**고 경고 | https://typesafe-jev.com/en/guides/api/ (커뮤니티 가이드, 공식과 2026-10-11 일치 주장) · https://pydantic.dev/docs/ai/models/system-one/ | [커뮤니티][1차] |
| 버전 | Jev는 별칭(`jev-latest`, `jev-preview`)과 고정 ID(`jev-1.14.0`, `jev-1.13.0`) 병행. **별칭은 응답 변화를 일으키므로 고정 ID 권장**. 계약 자체의 버전 정책은 `/v1` 경로뿐 | https://docs.typesafe.ai/models | [1차] |
| 변경 위험 | Upstage Decide는 "베타 — 스키마가 GA 전에 바뀔 수 있다"(R6). Perplexity pplx-decider와 Kai는 `/v1/decisions` 경로이며 Jev와 형식이 다르다고 기록 | R6 §1.4 · https://systemonemodels.org/guides/what-is-a-system-one-model/ | [1차][독립사이트] |

### 1.2 구현 목록(2026-10-28 기준)

| 구분 | 구현체 | 비고 | 출처 |
|---|---|---|---|
| 호스팅 | TypeSafe Jev(1.14.0, 입력 $0.042/Mtok, 64k/요청·32k/질문), Upstage Solar Decide(베타), Nace Drex(`/v1/systemone`), OpenRouter 경유 Kev-4B 등 | | https://docs.typesafe.ai/models · https://systemonemodels.org/models/ |
| 로컬 서버 | **Strands Decider**(`strands-decider serve`, `/v1/systemone`), **Ollama**(v0.35.0+, 로컬), **llama.cpp**(`llama serve`, PR #29818, 2026-10-02 병합) | 세 개 모두 로컬 `/v1/systemone` | https://github.com/strands-labs/strands-decider · https://docs.ollama.com/api/systemone · https://github.com/ggml-org/llama.cpp/pull/29818 |
| 개방 가중치(12종 표기) | Strands-Decider 2B(Apache-2.0), H2O-Lightning-4B(Apache-2.0), GLiNER2.5-Decide 340M(Apache-2.0), Kev(0.8B~27B, Apache-2.0), Laya, Von(폐기), OpenJev 27B(CC BY-NC 4.0, 상업 불가) 등 | 라이선스 혼재: 상업 불가 모델 다수 | https://systemonemodels.org/models/ |
| 비공개 가중치 | Jev, OpenAI Decisions, Solar Decide, Microsoft-Decision-1 등 | | 동일 |
| OpenAI | "OpenAI Decisions API"는 목록에 있으나 **Jev 계약과 wire 호환인지 사이트가 밝히지 않음**. 뉴스 헤드라인은 "OpenAI hasn't signed on" | https://systemonemodels.org/ · https://thenewstack.io/decision-models-system-one/ (본문 미열람, 헤드라인만) | 미확인(호환 여부) |

### 1.3 계약 비교표 — OpenAI Decisions vs System One vs Upstage Decide

OpenAI 열은 R1(SDK 소스 기준), System One 열은 TypeSafe 레퍼런스(커뮤니티 가이드)·Ollama·Strands·llama.cpp 문서의 교집합, Upstage 열은 R6 §1.4와 이번에 읽은 solar-decide 모델 페이지다.

| 항목 | OpenAI Decisions (`/v1/decisions`) | System One 공통(Jev 기준 `/v1/systemone`) | Upstage Solar Decide (`/v1/systemone`, 베타) |
|---|---|---|---|
| 모델 지정 | `gpt-6-luna` 만 | `model`: `jev-latest`/`jev-1.14.0` 등; 로컬 서버는 로드된 모델 | `solar-decide` |
| 공유 증거 | `input`: 문자열 또는 메시지 배열(`input_text`/`input_image`/`input_json`, 역할 구분) | `state`: 문자열·객체·배열. 빈 state 허용(Strands) | `state`: 문자열/JSON(R6). Jev와 "동일 스키마"라고만 서술 |
| 질문 컨테이너 | **배열**(순서가 답과 대응, `name`은 SDK상 선택·가이드상 고유 권장) | **객체**(질문 이름 → 질문). 답도 이름 키로 대응 | 객체(R6) |
| 질문 타입 | `predicate` / `choice` / `score` | `noul` / `choice` / `score` (**predicate = noul로 이름 변경**) | `noul`/`choice`/`score` |
| 선택지 표기 | `choices: [{value, description?}]`, 2~255, value는 문자열·불리언 | `criteria`: {라벨: 설명} 객체. Jev 최대 255 | `criteria` 객체, **2~26**(R6) |
| 선택지 상한 | 255 | Jev 255 · **Ollama 26**(Pydantic 문서 기재) · Strands 문서에 상한 없음 | 26 |
| score | `levels: [{label, description?}]`, 2~10 | `criteria` 순서 배열, 2~10 | 순서 배열 |
| noul 보조 | predicate는 필드 없음 | `criteria`는 선택(`{true,false}` 라벨). 일부 서드파티는 criteria를 넣지 말라 권고(R6) | criteria 없음 |
| 질문 수 상한 | **1~400** | Jev: 별도 상한 없음(문맥 안에서). Ollama 로컬: 미명시, **Ollama 클라우드 64**(Pydantic은 64로 기재) | **미확인** |
| 문맥 | 모델 창 1,050,000 | Jev 64k/요청, state+최장 질문 32k. **Strands 4,096**. Ollama 로컬 텍스트 64 KiB | 512K |
| 이미지 | base64 data URL·공개 URL, `detail` | Jev: 텍스트만(오디오·영상 불가). Ollama: Clef 모델만, base64 PNG/JPEG/WebP, URL 거부. Strands: `--vision` 선택 확장, 이미지로 학습하지 않음 | 미확인 |
| 응답 컨테이너 | `answers`: **배열**, 각 항목에 `type`·`name` | `answers`: **객체**(질문 이름 키) | 객체 |
| 불리언 확률 | `probability`(필드명) | `noul`(필드명), **confidence 없음** | `noul`, confidence 없음 |
| choice 응답 | `choice`, `probabilities:[{value, probability}]`, `confidence` | `choice`, `probabilities`, `confidence` (확률 형태는 문서에 없음, 객체/배열 **미확인**) | 동일 필드, 확률 합 1 |
| score 응답 | `score`(기대값), `probabilities:[{value,label,probability}]`, `confidence` | `score`, `legend`, `probabilities`, `confidence` | 동일 |
| confidence 정의 | "보정 보증 없음" | Ollama: **1 − H(p)/ln N**(엔트로피 기반, 정답 보증 아님) | "보정됨" 주장(근거 벤치 없음) |
| **질문별 거절** | **있음**(`type:"refusal"`) | **문서에 없음** | **없음** |
| 캐시 | 명시 브레이크포인트·`prompt_cache_key` | 계약에 없음. Strands는 **한 요청 안**에서 state의 KV를 질문 간 공유 | 캐시 단가 = 입력 단가, 동작 미확인 |
| 사용량 | `usage.input_tokens_details.cached_tokens` 등 | `usage.input_tokens`, `usage.output_tokens`(출력 과금 없음). Strands는 `latency_ms` 추가 | 동일 |
| 인증 | Bearer | Bearer(호스팅). **로컬(Ollama, Strands)은 없음** | Bearer |
| 상태 | GA(2026-10-22) | Jev 정식, 구현체는 제각각 | 베타 |
| 오류 코드 | R1 | 401·422·429·529(Jev). Ollama 400/401/402/404/413/500 | 422 `validation_failed`(R6) |

**어댑터 함의**: OpenAI(배열·predicate·refusal) ↔ System One(객체·noul·거절 없음) 변환은 이름 기반 조인으로 정규화한다. `refusal`이 없는 구현체에서 `onRefusal` 규칙은 "임계값 미달 → unknown"으로 대체(R6 §3과 동일). 구현체별 **프로필**(선택지 상한, 질문 수, 문맥 창, 절단 정책, 임계값)을 번들 정의 옆에 두고, **임계값은 (번들, 모델 해시) 단위**로 재산정한다.

출처: OpenAI 열은 R1 §A.2~A.5. System One 열은 https://typesafe-jev.com/en/guides/api/ · https://docs.typesafe.ai/models · https://docs.ollama.com/api/systemone · https://github.com/strands-labs/strands-decider/blob/main/docs/inference.md · https://pydantic.dev/docs/ai/models/system-one/ · https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 . Upstage는 https://console.upstage.ai/docs/models/solar-decide.md (요청·응답 필드 미기재, 가격 $0.1/M·캐시 $0.1/M·출력 무료·512K·"Jev와 동일 `/v1/systemone` 스키마"·한국어 이해 강조·2026-09-22 출시·리전 미명시).

---

## 2. AWS Strands Decider 2B (조사 항목 2)

확인일 2026-10-28. 현재 참조 체크포인트는 `strands-decider-2B-qwen3.5-v1-2610`(2026-10-09). 이전 `hobson-v19`(최초 공개), `hobson-v21`(2026-10-05).

| 항목 | 사실 | 출처 | 등급 |
|---|---|---|---|
| 공개 여부·라이선스 | 가중치(HF `StrandsAgents` 조직, v1 계열은 `amazon` 조직에도), 코드(GitHub `strands-labs/strands-decider`), 학습 스크립트 공개. **Apache-2.0**(모델 카드·저장소·README). 발표 블로그는 라이선스를 명시하지 않고 "open source"라고만 함 | https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 · https://github.com/strands-labs/strands-decider · https://strandsagents.com/blog/introducing-strands-decider/ | [1차] |
| 구조·파라미터 | `Qwen/Qwen3.5-2B-Base` 몸통 + LM head 제거 + 약 100만 파라미터 pointer head(fp32) + rank-16 LoRA. README는 "1.9B", 모델 카드는 파라미터 수 미기재("2B"는 기반 모델 크기) | 동일 | [1차] |
| 베이스 모델 | Qwen3.5-2B-Base: Apache-2.0, **201개 언어·방언** 확장 주장(한국어 명시 없음), 네이티브 문맥 262,144 | https://huggingface.co/Qwen/Qwen3.5-2B-Base | [1차] |
| 파일/무결성 | `lora/`, `head.safetensors`, `strands_decider_config.json`, `provenance.json`(베이스 리비전·해시), `MANIFEST.sha256`(전체 해시). **safetensors 형식** | 모델 카드 | [1차] |
| 컨텍스트 | 학습·평가 창 **4,096토큰**. 카드는 "최대 문맥 미기재". 서버는 기본으로 창 초과 시 **state를 잘라내고 선택지는 유지(조용한 절단)**, `--strict-window`면 HTTP 422 | https://github.com/strands-labs/strands-decider/blob/main/docs/inference.md · 모델 카드 | [1차] |
| 질문 처리 | state를 한 번 인코딩하고 KV를 질문 간 공유(`--max-batch` 기본 32). 질문 하나 추가당 추가 지연 소량 | 동일 | [1차] |
| 정확도 | JevBench 공개셋(231) **180/231 = 0.779**, Brier 0.280, ECE 0.072. 층별 쉬움 1.000 / 표준 0.931 / **어려움 0.586**. 보류 단문 0.653. 보정 주장: 신뢰도 ≥0.9인 단문 분류의 약 95%가 정답. 단, "단일 실행 간 약 10문항 이내 차이는 의미 없음" | README · 모델 카드 | [1차·자체] |
| 학습 데이터 | 246,678행(단문 80,449 등), 교사 `gemma-4-31B-it`. 상업 제한 데이터셋 4개 제외. **언어 구성은 서술 없음**. 데이터 빌더가 아직 `main`에 없어 재현 불가 | 모델 카드 | [1차] |
| 한국어 | **지원 언어 명시 없음. 한국어 평가 없음.** README 예시는 영어·줄루어·네덜란드어 | README · 모델 카드 · E2B 카드 | **미확인** |
| 한계(자체 기술) | 긴 다단계 문서에 약함, 질문 문구를 바꿔도 답이 안 바뀌는 경향, `score`·`noul`은 훈련 분포 밖 루브릭에 전이 약함, 보정은 단문 분류 기준이므로 자기 트래픽에서 재측정 | 모델 카드 | [1차] |
| 지연(GPU) | **RTX 3090(WSL2) v1 중앙값 115 ms, p95 299 ms**. M3 Pro 웜 중앙값 153 ms. 발표 블로그의 v18 그림은 약 115 ms로 서술, VentureBeat는 v18 106 ms/p95 296 ms. 지연은 토큰 수에 거의 선형 | README · https://strandsagents.com/blog/introducing-strands-decider/ · https://venturebeat.com/technology/amazon-unveils-a-free-fast-open-source-jev-killer-strands-decider-2b-makes-decisions-in-fractions-of-a-second | [1차][보도] |
| 지연(CPU) | 1차 출처에 **CPU 수치 거의 없음**(Gemma 4 계열만: 64 vCPU 서버에서 모델당 16스레드, JevBench 질문당 E2B 4.9초). Xeon 8375C에서 v21 1.6초 한 건. 커뮤니티 실측(M5 16GB, hobson-v19, PyTorch CPU): 385토큰 **2.83초**, 1,290토큰 **5.70초**, 질문 3개 7.67초, 시작 15.7초, 메모리 약 **7.9GB**(MPS 5.8GB, MLX 5.0GB) | inference.md · https://dev.classmethod.jp/en/articles/strands-decider-local-setup/ | [1차][커뮤니티] |
| 양자화 | 1차 문서에 **없음**("MLX 어댑터 병합은 양자화된 베이스를 거부"). Ollama MLX 태그(MXFP8 2.0GB, NVFP4 1.3GB)는 Apple 한정. 커뮤니티 ONNX/GGUF 아래 §3.3 | inference.md · https://ollama.com/library/strands-decider | [1차] |
| 메모리(Gemma 4 계열) | CPU fp32 기준 E2B 약 19GB, E4B 30GB, 12B 46GB. → **8~16GB 노트북에는 부적합** | inference.md | [1차] |
| 파인튜닝 | 지원. 공개 학습 스크립트(`training/recipe.sh`), 단일 RTX 3090 약 11시간 또는 H100 8장 약 1시간 10분, 사용자 작업용 `customize-decider` 스킬 안내. Linux/WSL2+NVIDIA 필요 | README | [1차] |
| 서버 보안 | `strands-decider serve`는 **127.0.0.1 바인딩, 인증 없음**, 동시 요청 동작 미검증, "로컬 실험용" 권고 | inference.md · 모델 카드 | [1차] |
| 저장소 활동 | 별 717·포크 99(검색 요약), 2026-10-26 갱신. CHANGELOG에 "같은 달 두 번째 릴리스는 기존 리포를 갱신하고 `YYMMDD` 리비전 태그를 붙인다" → **리포 이름이 아니라 커밋 해시로 고정해야 함** | https://github.com/strands-labs/strands-decider/blob/main/CHANGELOG.md | [1차] |

**우리 입력 크기와의 충돌**: 설계 번들은 고정 접두 1,100~2,000토큰 + 화면 약 1,500토큰 + 질문 약 1,000토큰으로 약 3,600~4,500토큰이다(04-model-layer §2.1·R6 가정). Strands는 창 4,096이고 한국어 토큰 비율은 모델 토크나이저에 의존한다(커뮤니티 실측은 일본어 약 0.6토큰/문자). 즉 **현재 번들 구성은 4,096을 넘을 수 있다.** 대응: 로컬용 번들에서 고정 접두를 줄이고(질문 `criteria` 설명으로 대체), 화면 텍스트를 선별 서브트리로 제한하며, `--strict-window`(또는 사전 토큰 계수)로 절단을 금지한다.

---

## 3. Ollama `strands-decider`와 임베딩 대안 (조사 항목 3)

### 3.1 Ollama 라이브러리 페이지 (확인일 2026-10-28)

| 항목 | 사실 | 출처 |
|---|---|---|
| 설명 | "Qwen3.5-2B-Base + trained decision head", 라이선스 Apache-2.0(v1-2610 체크포인트), 7,991 다운로드 | https://ollama.com/library/strands-decider |
| 태그 | `latest`=`2b`=`2b-mxfp8` 2.0GB · `2b-mlx-bf16` 3.8GB · `2b-nvfp4` 1.3GB(임베딩은 MXFP8). 전부 문맥 **4K**, 입력 텍스트 전용 | https://ollama.com/library/strands-decider/tags |
| 요구 사양 | **"Requires Ollama 0.40.0 or later on an Apple silicon Mac." "These models run with MLX."** Windows·Linux·CPU 언급 없음 | 동일 |
| 자체 평가 | Apple M5 Pro 64GiB, Ollama 0.40.0: BF16 182/231 중앙값 33.3 ms, MXFP8 183/231 42.5 ms, NVFP4 182/231 41.5 ms(프롬프트 82~3,936토큰). 퍼블리셔 보고 180/231 | 동일 |
| 지원 언어 | 페이지에 명시 없음 | 동일 |
| API | `localhost:11434/v1/systemone`; Ollama 공식 문서는 **로컬 텍스트·스키마 64 KiB, 전체 요청 32 MiB, 입력 절단 없음(전체가 로드된 컨텍스트에 들어와야 함)** | https://docs.ollama.com/api/systemone |
| 릴리스 | Ollama v0.40.0은 Apple 실리콘 MLX 기본. v0.40.4(2026-10-12)에 디시전 모델의 MLX 러너 지원, "긴 state는 거부하지 않고 자른다(clips)"고 서술 — **API 문서의 "절단 없음"과 상충**(미확인). v0.40.12(2026-10-27)에서 d1 2B는 "Apple 하드웨어만, Linux/Windows 곧 지원" | https://github.com/ollama/ollama/releases |

**결론(판단)**: 현재 Ollama에서 `strands-decider`는 Apple 실리콘 전용이다. Windows 11 소상공인 노트북 대상 설계에서는 **쓸 수 없다.** (개발자 맥에서의 CI 픽스처·로컬 재현용으로는 유용하다.)

### 3.2 Ollama를 Electron 앱에 번들하는 경우

| 항목 | 사실 | 출처 | 등급 |
|---|---|---|---|
| 라이선스 | 저장소에 MIT 라이선스 링크(본문 미열람). 재배포 조건 언급 없음 → MIT 일반 조건(저작권·라이선스 고지 동봉) 외 추가 제약은 **미확인** | https://github.com/ollama/ollama | [1차] |
| 설치 형태 | Windows: `OllamaSetup.exe` 설치기 또는 PowerShell 스크립트. 설치기 크기는 2차 출처 다수가 약 1.5~1.6GB(CUDA/ROCm 번들 포함)로 기록. **GitHub 릴리스 자산 목록은 열람 못 함** | https://github.com/ollama/ollama · localaimaster 등 검색 요약 | [1차]+[보도·미확인] |
| 사이드카 관행 | 문서·저장소에서 "Electron 번들/사이드카" 지침은 **확인하지 못함**(미확인). 상용 앱 사례는 조사하지 않음 | — | 미확인 |
| 프라이버시 | 저장소는 "complete privacy" 로컬 실행을 표방하나 클라우드 모델·`ollama launch` 등 외부 연결 기능이 공존. 텔레메트리·업데이트 확인 동작은 **미확인** → 번들 시 egress 차단 설정을 시험해야 함 | 동일 | 미확인 |
| 적합성 | 사용자 PC에 이미 Ollama가 있는 파워유저가 아니면 1.5GB급 설치·사용자 포트 충돌·자동 시작 서비스가 문제. 더구나 §3.1의 이유로 **`strands-decider` 자체를 못 돌린다** | | [추정] |

### 3.3 직접 임베딩 대안과 모델 포맷 호환

| 경로 | 모델 포맷 | 상태 | 비고 | 출처 |
|---|---|---|---|---|
| PyTorch 참조 구현(`pip install strands-decider`) | safetensors + LoRA/head | 공식. CPU 지원(`--device cpu`) | Python 런타임 동봉 필요, CPU 메모리 약 7.9GB, 참조 CPU 경로는 느림(causal-conv1d 대체 커널) | README · inference.md · classmethod |
| **ONNX** `onnx-community/strands-decider-2B-hobson-v19-ONNX` | q8 1.80GB / q4f16 1.09GB, LoRA 병합·LM head 제거·pointer head 융합(입력 `input_ids`,`attention_mask`,`answer_pos`,`option_pos` → `logits [B,K]`, `config.json`의 유형별 온도로 나눈 뒤 softmax) | **커뮤니티 변환(공식 아님)**, Apache-2.0. 카드가 "ONNX Runtime의 CPU 공급자로도 실행 가능"이라 서술하나 실측 없음. 카드는 "typed-decisions 정확도 약 58~59%, q4f16이 장문 근접 동점을 흔든다(q8 권장)"고 기재(지표 정의 미확인) | `v19` 기준(최신 v1-2610 아님) | https://huggingface.co/onnx-community/strands-decider-2B-hobson-v19-ONNX |
| **GGUF** `fabricant451/strands-decider-2B-hobson-v19-GGUF` | Q8_0 2.02GB, pointer head 보존(F32) | 커뮤니티 "Experimental", **"custom Strands-aware llama.cpp/wllama runtime 필요, stock GGUF 클라이언트와 호환 가정 금지"**, 브라우저 픽스처 8개만 시험(최대 확률 오차 <0.006) | 따라서 **stock llama.cpp/node-llama-cpp로는 미확인** | https://huggingface.co/fabricant451/strands-decider-2B-hobson-v19-GGUF |
| **llama.cpp 네이티브** `/v1/systemone` | GGUF(`{arch}.decision.type` 메타데이터) | PR #29818 병합(2026-10-02). 지원 모델: laya, julia-1, lev, openjev(+vision), kev. **Strands pointer head는 PR 어디에도 언급 없음** → 미확인. 플랫폼 백엔드는 PR에 없음. Windows 11에서 `llama.app`으로 Laya가 3질문 78 ms 중앙값(HP ZBook 128GB, CPU/GPU 미기재), LM Studio 번들 llama.cpp는 로드 실패 | | https://github.com/ggml-org/llama.cpp/pull/29818 · https://blog.terenceluk.com/2026/10/llama-cpp-decision-models.html |
| node-llama-cpp | llama.cpp 바인딩(MIT), macOS/Linux/Windows 프리빌드, Metal/CUDA/Vulkan | **디시전/systemone 지원 언급 없음**(미확인), Electron 언급 없음 | 업스트림 추종 속도에 의존 | https://github.com/withcatai/node-llama-cpp |
| WebGPU/브라우저 | `alxnahas/strands-decider-2B-webgpu` 등 커뮤니티 | 포맷 미확인 | 데스크톱 CPU 대상으로는 부적합 | https://huggingface.co/models?search=strands-decider |
| ONNX Runtime·Transformers.js 라이선스·Windows CPU 최적화 | 이번에 **열람하지 않음**(미확인) | | 스파이크에서 확인 | — |

**포맷 호환 요약**: Strands의 head가 "임베딩 그래프 + 결정 head" 구조라 원리상 이식은 쉽지만, **우리가 신뢰할 수 있는 공식 변환 경로는 없다.** 현실적 선택은 (1) ONNX를 우리가 직접 재변환·검증(최신 체크포인트로), (2) Kev(llama.cpp 공식 지원 모델)를 한국어로 파인튜닝해 GGUF 사용, (3) PyTorch 사이드카(무겁다) 중 하나다. 어느 쪽이든 **원본 대비 확률 일치 시험**(ONNX 카드·llama.cpp PR이 하는 방식)을 통과 기준으로 둬야 한다.

---

## 4. 로컬 판정을 쓸 때 설계 함의 (조사 항목 4)

### 4.1 egress 0이 되는 데이터 항목 (L1 호출분)

| 항목 | 현재(클라우드 L1) | 로컬 L1 |
|---|---|---|
| 마스킹된 접근성 텍스트(≤6KB, 화면 상태·팝업·입력 완료·결과) | 게이트웨이 → 공급사 | 기기 내부에서 종료 |
| 사용자 자연어 지시(`intent_route_v1`의 입력, 마스킹 후) | 동일 | 기기 내부 |
| 추출된 서류 메타·금액 파서 결과(`doc_meta_check`, `amount_parse_check`) | 동일 | 기기 내부 |
| 고정 접두(규칙·라벨 정의) | 공급사 캐시에 저장 | 로컬 파일 |
| 번들 호출 메타(계정 해시 `prompt_cache_key`, `safety_identifier`, `runToken`) | 게이트웨이·공급사에 노출 | **불필요**(L1 게이트웨이 계량 제거) |
| **남는 egress** | L2 Terra의 도구 읽기 텍스트, 이미지 크롭(필요 시), 게이트웨이 계량·플레이북 레지스트리 동기화 | 그대로. **L2를 로컬화하지 않으면 전체 egress 0이 아니다** |

### 4.2 위협 변화 표

| 구분 | 위협 | 클라우드 L1 | 로컬 L1 | 비고·완화 |
|---|---|---|---|---|
| 사라짐 | 공급사로의 화면 텍스트 유출·보관(OpenAI ZDR는 승인형, 캐시·CSAM 스캔 예외 — R1) | 있음 | **없음(L1 한정)** | |
| 사라짐 | 국외 이전(OpenAI는 한국 리전이 저장 한정 — R1) | 있음 | 없음 | 개인정보 국외이전 고지·위탁 문서 단순화 |
| 사라짐 | 프롬프트 캐시 적중 오라클(`cached_tokens` 노출) | 계정별 키로 완화 중 | 없음 | 로컬 prefix cache는 프로세스 내부 |
| 사라짐 | 공급사 정책 조치(계정 정지가 조직 전체에 파급), 레이트 한도·장애·SLA, 모델 폐기·스키마 변경(Upstage 약 9개월 수명 — R6) | 있음 | 없음(모델 수명은 우리가 통제) | |
| 새로 생김 | **모델 파일 공급망**: HF 리포 계정 탈취·교체, 커뮤니티 변환본의 검증 불가(ONNX/GGUF는 모두 커뮤니티), 리포 이름이 같아도 내용이 바뀜(Strands CHANGELOG의 같은 달 덮어쓰기) | 해당 없음 | **있음** | 커밋 해시 고정, `MANIFEST.sha256`·`provenance.json` 검증, 우리 서명 후 재배포(§4.4), safetensors 선호. GGUF/ONNX 파서 취약점 이력은 **미확인** |
| 새로 생김 | **로컬 추론 서버 공격면**: Strands `serve`·Ollama 모두 localhost 바인딩에 **인증 없음**. 같은 PC의 다른 프로세스나 웹페이지(DNS 리바인딩 등 — 일반 지식, 이번에 검증 안 함)가 호출·악용 가능 | 해당 없음 | 있음 | 프로세스 내 임베딩(ONNX Runtime) 또는 앱 전용 파이프/임의 포트+토큰, 외부 접속 거부 |
| 새로 생김 | **조용한 절단**: 4,096 초과 시 state 일부를 버리고 선택지는 유지(Strands 기본) → 경고 문구가 잘려도 "정상" 판정 가능 | 해당 없음 | **있음(보안 판정에 치명적)** | 사전 토큰 계수 + `--strict-window`/422, 화면 분할 판정 |
| 새로 생김 | 판정기 자체에 대한 프롬프트 인젝션(로컬이라도 동일). VentureBeat는 "싼 확률적 가드는 보안 경계가 아니다" 지적 | 동일 | 동일(로컬이라고 면역 아님) | 엔진 화이트리스트·결정적 키워드 필터와 병행 |
| 새로 생김 | **성능 편차**: 같은 앱이 i3/8GB와 i7/16GB에서 지연이 10배 이상 다를 수 있음. M5 CPU 실측이 이미 385토큰 2.8초 | 서버 지연 균일 | 기기별 상이 | 시작 시 벤치마크 후 모드 자동 선택(로컬/클라우드/규칙만) |
| 새로 생김 | **정확도 저하 → 핸드오프 증가**: JevBench 어려움 층 0.586, 한국어 미검증, 임계값 .85~.95에서 `unknown` 증가 | 낮음(검증 필요) | 높음 | 하이브리드·규칙 L0·한국어 파인튜닝 |
| 새로 생김 | 보정 오류: Laya 블로그 실측에서 틀린 답이 높은 신뢰도, 옵션 순서에 따라 정확도 51%↔84%. Pydantic도 모델 간 confidence 비이전 경고 | 보증 없음(동일) | 더 큼 | 순서 섞기 이중 호출(위험 질문), 온도 보정, 자기 코퍼스 재산정 |
| 불변 | L2 egress, 게이트웨이 계량, 하네스 자체의 가짜 팝업·악성 페이지 | | | |

### 4.3 배포 크기

| 구성 | 추가 용량 | 근거 |
|---|---|---|
| ONNX q4f16 | 약 **1.09GB** | HF 카드 |
| ONNX q8 | 약 **1.80GB** | HF 카드 |
| GGUF Q8_0 | 약 **2.02GB** | HF 카드 |
| Ollama(Apple 한정이라 Windows 불가) | 모델 1.3~3.8GB + 런타임 약 1.5GB(2차 출처) | Ollama 태그, 검색 요약 |
| PyTorch 사이드카 | 모델 + Python/torch(크기 **미확인**), 실행 메모리 약 7.9GB | classmethod |
| Laya 다국어 | 약 **0.66~0.68GB** | https://ollama.com/library/laya |
| 설치기 전체 | 현재 설치기에 +1.1~2.0GB(런타임 별도). 기기 8GB RAM 환경에서 상시 상주 메모리는 **ONNX q4f16이 실제로 얼마인지 미측정** | |

**권장**: 설치기에는 넣지 않고 **첫 실행 후 선택 다운로드**(서명 검증)로 한다. 소상공인 노트북의 디스크·네트워크 여건과 Windows SmartScreen/백신 오탐도 고려해야 한다(오탐은 이번에 조사하지 않음).

### 4.4 업데이트 경로 — 서명된 모델 파일을 플레이북 레지스트리처럼 배포

- 모델은 `{모델 해시, 베이스 리비전, 변환 도구 버전, 지원 번들 목록, 임계값 프로필}`을 담은 **서명 매니페스트**로 배포한다(플레이북 레지스트리와 동일한 서명 키 체계·롤백 규칙 재사용, ADR 수준 결정은 별도).
- 모델 업데이트는 **번들 버전 업데이트와 함께** 간다: 번들 정의의 임계값은 (번들, 모델 해시)에 묶는다. 모델이 바뀌면 S7 회귀 코퍼스(정확도 98% 미만 배포 금지, 04-model-layer §마지막)를 통과해야 한다.
- 원본 출처(HF)에서 직접 받지 않고 **우리 레지스트리 미러**에서 받게 하며, 원본 대비 확률 일치 시험 결과를 매니페스트에 첨부한다.
- 강제 롤백·킬스위치: 서명된 폐기 목록으로 특정 모델 해시 사용을 중지시키고 클라우드/규칙 모드로 폴백.
- 사용자 PC 쪽 검증 실패 시: 로컬 모드를 끄고 현재 설계의 클라우드 L1(또는 핸드오프)로 폴백.

### 4.5 하이브리드(로컬 1차 → 임계값 미달 시 클라우드 2차) 타당성 평가

| 관점 | 평가 |
|---|---|
| 타당성 | 기술적으로 가능하다. 어댑터 순서(`local → cloud`)와 임계값 프로필만 추가하면 된다. Strands 카드도 "일상 판정은 이 모델, 어려운 건 LLM"이라는 하이브리드를 의도된 용도로 적는다 |
| egress | "0"이 아니라 **감소**다. 올라가는 것은 로컬이 불확실한 화면뿐이지만 그 화면은 오류·예외 화면일 가능성이 높아 전송 내용의 민감도가 낮다고 단정할 수 없다. 마케팅·계약 문구는 "원칙적으로 로컬, 불확실 시에만 마스킹 텍스트 전송"처럼 정확해야 한다 |
| 신뢰도 | 로컬과 클라우드의 `confidence` 정의가 다르다(Ollama: 엔트로피 기반; OpenAI: 보증 없음). 두 단계는 **서로 다른 임계값 프로필**이 필요하고, 로컬이 확신 있게 틀리는 경우(과신)는 하이브리드가 못 잡는다 |
| 지연 | 로컬이 10초 넘게 걸린 뒤 클라우드로 가면 최악 합산. 해결: 로컬 호출에 타임아웃을 두고, 초과 시 즉시 클라우드(또는 규칙) |
| 비가역 판정 | `form_ready_v2`·`issue_result_v2`(.95)와 `security_warning`은 **로컬 단독 통과 금지**. 로컬은 "중단 쪽"으로만 단독 결정 가능(비대칭 규칙): 로컬이 위험이라 하면 중단, 안전이라 하면 규칙 확인 또는 클라우드 확인 |
| 비용 | 클라우드 L1 비용은 호출당 센트 미만이라(R1·R6) 로컬 전환으로 얻는 **경제적 이득은 사실상 없다.** 도입 동기는 프라이버시·오프라인뿐이다 |
| 운영 복잡도 | 모델 서명·배포, 기기별 벤치, 두 경로 회귀 시험 → 엔지니어링 비용이 이득보다 클 수 있다 |
| 권고 | 기본 경로는 **규칙 L0 → 클라우드 L1**을 유지. 로컬 모델은 **옵트인 "엄격 프라이버시 모드"(규칙 L0 → 로컬 → 불확실 시 핸드오프, 클라우드 호출 금지)** 와 **하이브리드 모드**를 스파이크 결과에 따라 후속 결정. 즉 사용자가 egress 0을 고르면 정확도 하락분을 **핸드오프 증가로 감수**하는 선택으로 제시 |

---

## 5. 다른 로컬 소형 판정·분류 대안 (조사 항목 5)

### 5.1 로컬 모델 표

확인일 2026-10-28. RAM·지연은 가능한 한 1차/실측만 적었고, 우리 대상 하드웨어(Windows 11 CPU, 8~16GB)에서의 측정값은 **하나도 없다**.

| 이름 | 크기 | 라이선스 | RAM·디스크 | CPU 지연(공개 수치) | 한국어 | 비고·출처 |
|---|---|---|---|---|---|---|
| **Strands Decider 2B** (qwen3.5-v1-2610) | 약 1.9~2B | Apache-2.0 | PyTorch CPU 약 7.9GB(hobson-v19, 커뮤니티); ONNX 1.09~1.80GB; 문맥 4K | M5 CPU 385토큰 2.8초, 1,290토큰 5.7초(커뮤니티) | **평가 없음(미확인)** | 위 §2·§3. https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 |
| Strands Decider Gemma 4 E2B/E4B/12B/26B-A4B | E2B~26B | Apache-2.0 | CPU fp32 19/30/46/101GB | 64vCPU 서버 질문당 4.9/7.2/13.5/7.8초 | 평가 없음 | 소상공인 PC에 부적합. https://github.com/strands-labs/strands-decider/blob/main/docs/inference.md |
| **Kev-4B** (Jared Palmer) | 4B(Qwen3.5-4B-Base+LoRA+pointer head) | Apache-2.0 | MLX 가중치 8.4GB, CUDA 14.3GB, 8,192 검증·65,536 서빙 주장; llama.cpp 공식 GGUF 지원 모델 | CPU 수치 없음. GPU L40S 6질문 41.5 ms | **영어 전용(카드)**; 한국어 파생 `leapshared/sciedu-router-kev4b` | JevBench 0.758(어려움 0.541). 4B는 8GB 노트북에 무거움. https://huggingface.co/jaredpalmer/kev-4b |
| Kev-4B 한국어 파생(커뮤니티) | 4B, Q4_K_M GGUF 3.03GB, 서빙 시 약 4.7GB VRAM | Apache-2.0(메타데이터) | 위 | RTX 5090 중앙값 52.7 ms | 한국어 발화 11라벨: **94.6%(482줄)/96.3%(508줄)**, 위험 오류 6/2건, 단일 시드, 훈련 3,947줄 | **한국어 파인튜닝이 통한다는 존재 증명**이자 "위험 오류 0" 기준 미달 사례. https://huggingface.co/leapshared/sciedu-router-kev4b |
| **Laya 다국어** | 322M(mmBERT-base), 658~678MB | Apache-2.0 | 문맥 1,024(최대 8,192) | Windows 11에서 Laya(영어판) 3질문 중앙값 78 ms(HP ZBook 128GB, 하드웨어 상세 없음) | MASSIVE 20지선다 의도분류 **한국어 0.490**(영어판 0.110, 우연 0.05); typed-decisions 제로샷은 우연 수준(0.342 vs 0.318), 파인튜닝 권고 | 자체 보고. 과신 경향(보정 안 됨). https://huggingface.co/convaiinnovations/laya-multilingual · https://blog.terenceluk.com/2026/10/llama-cpp-decision-models.html |
| GLiNER2.5-Decide | 340M(HF 메타데이터는 486M로 상이, 미확인) DeBERTa-v3-large | Apache-2.0 | | 48 vCPU Xeon에서 batch 1·64토큰 중앙값 167.3 ms(자체) | **영어 중심**; 다국어판 `multi-Decide`(287M mDeBERTa)는 보도에만 있음, 한국어 미확인 | 자체 17개 데이터셋 60.1%(JevBench 아님). https://fastino.ai/blog/gliner-2-5-decide-open-weight-decision-model · https://www.marktechpost.com/2026/09/24/fastino-releases-gliner2-5-decide-a-340m-open-weight-decision-model-that-runs-on-cpu/ (403, 검색 요약만) |
| Liquid d1 (2B/3B) | 3.7~3.9GB | LFM Open License v1.0 | 문맥 32K/125K | Ollama에서 Apple 한정(Win/Linux "곧") | 미확인 | https://ollama.com/library/d1 |
| H2O-Lightning-4B | 4B | Apache-2.0 | | | 미확인 | https://systemonemodels.org/models/ |
| **Solar Mini 4** (온프레미스) | 파라미터 비공개, 양자화 시 **H100 80GB 1장** | 가중치 비공개, 온프레미스는 영업 문의, 조건·가격 **미확인** | | | 한국어 강점 서술(벤더) | 사용자 PC 로컬 불가. 기관 서버 설치형 후보. R6 §1.5 · https://console.upstage.ai/docs/models/solar-decide.md |
| EXAONE 4.0 1.2B | 약 1.28B(임베딩 제외 1.07B), 문맥 65,536 | **EXAONE AI Model License 1.2 – NC(비상업)**. 상업 이용은 별도 계약. 카드에 "License Updated" 배너와 변경점(출력 소유 주장 삭제 등)이 있으나 NC 명칭 유지 | GGUF 양자화 35종 링크 | 수치 없음 | 영어·한국어·스페인어; KMMLU-Pro 37.5~42.7 | 상업 불가 → **제품 탑재 불가**(별도 계약 전). 비공식 Jev식 파인튜닝 `carrtesy/EXAONE-4.0-1.2B-JEV`는 JevBench 69.7%·영어만·NC. https://huggingface.co/LGAI-EXAONE/EXAONE-4.0-1.2B |
| HyperCLOVA X SEED Text 0.5B / 1.5B | 0.57B / 약 1.5~2B(표기 상이), 문맥 4K / 16K | `hyperclovax-seed` 라이선스: 상업 가능하나 **월간 활성 사용자 1,000만 초과 시 별도 허가**, 제품에 **"Powered by HyperCLOVA X" 표기**, 재배포 시 AUP·고지 동봉, 파생·증류 모델 이름은 "HyperCLOVA X"로 시작, 위반 시 해지 | safetensors, 양자화 19종 링크 | 수치 없음 | KMMLU 0.3815(0.5B)/0.3933(1.5B), KoBEST 0.63~0.65 (자체) | 한국어 강점. 접근 시 동의 필요(1.5B는 HF 로그인 후 약관). https://huggingface.co/naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-1.5B/blob/main/LICENSE · https://huggingface.co/naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-0.5B |
| Kanana 1.5 2.1B | 약 2B, 문맥 32K | **Apache-2.0**(Kakao 발표·HF) | BF16 | 수치 없음 | KMMLU(base) 45.10, HAERAE 77.46 | **Kanana Nano 2.1B는 CC-BY-NC-4.0**이므로 혼동 금지. https://huggingface.co/kakaocorp/kanana-1.5-2.1b-base · https://www.kakaocorp.com/page/detail/11654?lang=ENG |

### 5.2 판정 모델 후보 평가

- **그대로 쓸 수 있는 한국어 판정 모델은 없다.** 개방 System One 모델 12종 중 한국어를 언급하는 것은 Laya 다국어뿐이고(0.49), 나머지는 영어 중심이거나 미평가다. systemonemodels.org 모델 목록도 한국어를 언급하지 않는다.
- **현실 경로는 "한국어 소형 베이스 + pointer head/로짓 판정 파인튜닝"이다.** Strands는 LoRA+pointer head 학습 레시피를 공개했고, 한국어 파생 사례(Kev→3.9K줄)와 EXAONE-JEV(전체 파인튜닝, 로짓 기반)가 같은 방식이 통한다는 간접 증거다. 베이스 후보는 **Qwen3.5-2B(Apache-2.0, 다국어 주장)**, **Kanana 1.5 2.1B(Apache-2.0, KMMLU 45.1)**. HyperCLOVA X SEED는 한국어 최상위 후보이나 MAU 조건·표기·증류 모델 이름 규칙이 있어 법무 검토 후에만. EXAONE 4.0은 NC라 제외.
- 비용: 학습 데이터(번들 20질문 × 화면/문장 수백 건 + 한국어 의도 코퍼스 300문장)는 S7 코퍼스와 겹친다. Strands 학습은 3090 한 장 약 11시간 수준이라 기술적 장벽은 낮다. 장벽은 **라벨 코퍼스 확보와 위험 오류 0 달성**이다(Kev 한국어 파생도 "위험 오류 0" 기준 미달을 자체 기록).

### 5.3 "모델 없이" 결정적 규칙으로 L1 질문을 얼마나 대체할 수 있나 (당신의 평가 요청 — [추정])

전제: 홈택스·정부24 등 **대상 포털이 한정**돼 있고 엔진이 접근성 트리(역할·이름·상태·URL)를 이미 갖고 있다. 아래는 04-model-layer §3의 번들 20개 질문에 대한 판단이며, 실제 비율은 S7 코퍼스(포털 변경 이력 포함)로 **측정해야 확정**된다. 규칙은 위양성(경고를 놓침)이 아닌 위음성(과다 경고) 쪽으로 설계한다.

| 질문 | 규칙 대체 가능성 | 규칙의 근거 신호 | 비고 |
|---|---|---|---|
| `captcha_visible` | **높음** | 이미지+입력란 쌍, 필드 이름·라벨 키워드 | |
| `session_expired_notice` | 높음 | 알려진 문구 사전, URL 리다이렉트 | 문구 변경 시 사전 갱신 |
| `logged_out_by_other_session` | 높음 | 문구 사전 | |
| `mfa_pending` | 높음 | 문구·인증 앱 안내 요소 | |
| `has_error_modal` | 높음 | `role=dialog/alertdialog` + 오류 키워드 | |
| `issuance_success_text` | 높음 | 승인번호 정규식 + 완료 문구 | 확정은 어차피 `verify` 조회 |
| `required_fields_filled` | **높음, 규칙이 모델보다 정확** | `required`/`aria-required` 값 비어있음 | readback과 합치면 모델 불필요 |
| `validation_error_visible` | 높음 | `aria-invalid`, 오류 노드 | |
| `amount_parse_check`(`parse_matches_user_text`) | 높음 | 산술 재계산 | 이미 결정적 파서가 있음 |
| `doc_meta_check` ×2 | 높음 | 날짜 정규식 비교 | |
| 소계 | **11개 / 20개 (55%)** | | |
| `screen`(choice) | 중간 | URL·랜드마크·제목 규칙으로 대부분 분류, 미지 화면은 모델 | 포털 개편 시 취약 |
| `security_warning` | 중간 | 키워드로 상향(규칙 OR 모델), 규칙이 "없음"이라 해도 모델이 유일한 방어일 수 있음 | 규칙은 **경고 쪽 단독 결정만** 허용 |
| `popup`(choice)·`asks_to_proceed_or_issue` | 중간 | 버튼 이름·키워드 | |
| `result`(issue_result choice) | 중간 | 문구 사전 | .95 임계값이라 규칙+readback이 오히려 안전 |
| `situation`(recovery choice) | 중간 | DOM 비교(요소 소멸·URL 변화·모달 존재) | |
| 소계 | **6개 / 20개 (30%)** | | |
| `page_text_addresses_agent`(인젝션) | **낮음** | 알려진 패턴 사전만 가능, 열린 공격 공간 | 모델 필수(방어 심층) |
| `intent_route` 선택 | **낮음** | 정형 문장·서류 속어 사전으로 일부만, 구어체는 모델 | 한국어 코퍼스로 커버리지 측정 |
| `mentions_tax_advice` | 낮음 | 키워드 휴리스틱은 위양성 | |
| 소계 | **3개 / 20개 (15%)** | | |

**평가**: 규칙만으로 100%는 불가능하지만, **질문 수 기준 55%는 모델 없이 정확도 손실 없이(또는 개선하며) 대체 가능**하고 +30%는 규칙 1차·모델 보조로 호출 빈도를 줄일 수 있다. 이 계층(L0)은 클라우드와 로컬 모두에 이득이며 **로컬 모델이 풀어야 할 일을 "한국어 의도 분류·인젝션 탐지·미지 화면"으로 좁혀** 소형 모델의 약점(긴 문서·한국어 일반화)을 피하게 한다. 단 모델 질문이 줄어도 번들 구조(질문 독립성, 순서 있는 결과 매핑)는 그대로 유지해야 하므로, 규칙 결과를 번들 `answers`와 같은 모양으로 생성하는 **규칙 어댑터(가짜 `systemone` 응답, confidence 1.0/0.0)** 로 구현하는 것을 권한다.

---

## 6. 요약 표 — 후보별 한 줄 판정

| 후보 | 판정 |
|---|---|
| Ollama `strands-decider` | **Windows 불가**(Apple 실리콘 전용). 개발·CI용으로만 |
| Strands Decider 2B + ONNX(우리가 재변환) | 후보 1순위 스파이크 대상. 4K 문맥·한국어 미검증 |
| Kev-4B/Qwen3.5 계열 + llama.cpp(GGUF) | 도구 체인은 가장 공식적. 4B는 무겁고 영어 전용 → 한국어 파인튜닝 필수 |
| Laya 다국어 322M | 가장 가볍고 CPU 친화. 한국어 0.49라 **파인튜닝 전제 후보** |
| EXAONE 4.0 | 라이선스 NC → 제외 |
| HyperCLOVA X SEED, Kanana 1.5 | 한국어 강점. 판정 head 파인튜닝 베이스로만 검토, 법무 확인 필요 |
| 규칙 L0 확대 | **가장 먼저 할 일**, 호출 질문의 약 55~85% 흡수 가능(추정) |

---

## 7. 스파이크 제안 — 측정 항목·합격 기준

기간 1~2주. 합격 기준은 이 노트의 **제안값**이며 팀 합의로 조정한다. 데이터는 S7 코퍼스(포털 화면 텍스트·한국어 의도 300문장)를 재사용한다.

### S-L0. 규칙 커버리지(1~2일, 로컬 모델 없이)
- 측정: 20개 질문 각각을 규칙 어댑터로 답했을 때의 정밀도·재현율, 규칙이 `unknown`을 내는 비율.
- 합격: 높음 등급 11개 질문 정밀도 ≥99%·재현율 ≥95%(코퍼스 n ≥ 300/질문), 전체 질문의 ≥50%를 모델 호출 없이 해결.

### S-L1. 한국어 정확도·보정(1주)
- 후보 5종을 같은 번들 정의로: ① Strands v1-2610 제로샷 ② 같은 모델 한국어 LoRA 파인튜닝(`customize-decider`) ③ Kev-4B 제로샷·파인튜닝 ④ Laya 다국어 파인튜닝 ⑤ 기준선 OpenAI Luna Decisions.
- 측정: 번들·질문별 정확도, 임계값(.80/.85/.95)에서 정밀도·재현율, ECE, `unknown` 비율(= 핸드오프 증가분), **위험 오류 건수**(보안 경고 미탐, `ready` 오판, `issued` 오판), 질문 순서 바꿨을 때 불일치율.
- 합격(제안): ① 비가역 아닌 번들 정확도가 클라우드 기준선 −3%p 이내 ② `security_warning` 재현율 ≥99%(규칙 OR 모델 결합 후) ③ `form_ready_v2`·`issue_result_v2` 위양성률 ≤1%(양성 n ≥ 300, 오답 0건이면 95% 신뢰 상한 약 1% — R6 §4의 3/n 규칙) ④ 핸드오프 증가분 ≤ +2%p(대 클라우드) ⑤ ECE ≤0.10.

### S-L2. Windows CPU 성능(3~4일)
- 대상 기기: 소상공인 노트북 대표 3종(예: Core i3/8GB, Core i5/16GB, Ryzen 5/16GB, GPU 없음) × 경로 3종(ONNX Runtime q4f16·q8, llama.cpp GGUF, PyTorch 참조).
- 측정: 입력 토큰 1K/2K/3.5K/4K에서 번들 1회 p50/p95, 질문 2/5/10개, 콜드 스타트, 상주 메모리(최대·유휴), 디스크, 배터리·CPU 점유(앱 동시 사용 중), 동시 요청, Windows Defender 오탐 여부. **실제 한국어 화면의 토큰 수 분포**와 4,096 초과 비율.
- 합격(제안): 번들 1회 p95 ≤5초(16GB)·≤8초(8GB), 상주 추가 메모리 ≤2.5GB(8GB 기기에서 포털 브라우저와 공존), 설치 추가 ≤1.2GB, 4,096 초과 시 절단이 아닌 거부·분할이 보장될 것.

### S-L3. 무결성·공급망·서버(2일)
- 측정: 원본(PyTorch) 대비 ONNX/GGUF 확률 최대 오차(ONNX 카드·llama.cpp PR 방식; 합격 ≤0.01), 매니페스트 서명·해시 검증, 변조된 모델 파일 거부, 로컬 서버 외부 접근 시도 차단.
- 합격: 오차 ≤0.01, 변조 파일 100% 거부, 인증 없는 포트 노출 0.

### S-L4. 하이브리드·폴백(2일)
- 측정: 임계값 미달 시 클라우드 폴백의 총 지연·클라우드로 나가는 호출 비율·절단/타임아웃 시 동작, 로컬 과신 사례 집계.
- 합격: 클라우드 폴백 비율 ≤25%(옵트인 모드 기준 목표치), 폴백 포함 번들 p95 ≤12초, 비가역 판정에서 로컬 단독 통과 0건.

---

## 8. 미확인 목록과 확인 방법

| # | 미확인 | 확인 방법 | 영향 |
|---|---|---|---|
| 1 | Strands Decider(Qwen3.5-2B)의 **한국어 정확도**, 한국어 토큰 효율 | S-L1, 토크나이저로 실제 화면 토큰 계수 | 채택 여부의 핵심 |
| 2 | **Windows CPU**에서의 지연·메모리(ONNX/GGUF/PyTorch 모두) | S-L2 | 사용자 체감, 8GB 기기 지원 |
| 3 | llama.cpp가 Strands pointer head를 지원하는지, 커뮤니티 GGUF의 "custom runtime"이 무엇인지 | llama.cpp `convert` 소스·PR #29818 코드 확인, 커뮤니티 리포 README | 포맷 경로 선택 |
| 4 | 커뮤니티 ONNX의 최신 체크포인트(v1-2610) 변환·정확도(카드의 "58~59%" 지표 정의 포함) | 직접 재변환·확률 일치 시험 | 신뢰 가능한 배포본 |
| 5 | ONNX Runtime·Transformers.js·node-llama-cpp의 라이선스 원문, Windows CPU 최적화 여부, Electron 임베딩 사례 | 각 저장소 LICENSE·문서 열람 | 번들 법무·성능 |
| 6 | Ollama 번들의 재배포·텔레메트리·자동 업데이트 동작, Windows 설치기 정확 크기 | 릴리스 자산 목록 직접 열람, 네트워크 캡처 | Ollama 사이드카 가능성(Windows용 strands-decider가 없어 우선순위 낮음) |
| 7 | Ollama가 입력을 자르는지 여부(v0.40.4 노트 "clips" vs API 문서 "never truncated") | 4,096 초과 입력으로 시험 | 보안 판정 안전성 |
| 8 | Ollama 디시전 모델의 Windows/Linux 지원 범위(strands-decider 포함) | 릴리스 노트 추적, Windows에서 `ollama pull strands-decider` 시험 | |
| 9 | System One 계약의 정식 사양서·OpenAPI·거버넌스 존재 여부, OpenAI Decisions와의 wire 호환 | TypeSafe 공식 `api.md`(docs.typesafe.ai), The New Stack 본문 열람 | 어댑터 안정성 |
| 10 | `probabilities` 필드의 실제 JSON 형태(배열 vs 객체)와 구현체 간 차이, 로컬 서버의 질문 수 상한 | 구현체별 실호출 | 어댑터 정규화 |
| 11 | Upstage Decide 요청당 질문 수·이미지·캐시(R6 §6-1) | R6 방법 | |
| 12 | 모델 파일 파서(GGUF/ONNX) 취약점 이력 | CVE·보안 공지 검색 | 공급망 위험 평가 |
| 13 | EXAONE 4.x 신규 라이선스(배너 "License Updated")의 상업 이용 조건, HyperCLOVA X SEED 0.5B 라이선스 원문 | LGAI·Naver 라이선스 원문, 법무 | 한국어 베이스 선택 |
| 14 | GLiNER2.5-multi-Decide의 실존·한국어 지원 | Fastino 모델 카드 직접 열람 | 경량 후보 |
| 15 | Gemma 4 계열 한국어 성능·E2B 메모리(CPU fp32 19GB) 이외의 양자화 가능성 | 별도 조사 | 대안 베이스 |
| 16 | 한국어 포털 화면에서 Qwen3.5 토크나이저의 토큰/문자 비율 | S-L2 측정 | 문맥 한도 설계 |
| 17 | L2(Terra)까지 로컬화할 경우의 현실성 | 별도 조사(R9 후보) | "완전 로컬 하네스" 주장 가능 여부 |

---

## 9. 출처 (전부 2026-10-28 확인)

**System One 계약·생태계**
- https://systemonemodels.org/ · https://systemonemodels.org/models/ · https://systemonemodels.org/guides/what-is-a-system-one-model/ (독립 사이트, 요약 도구 경유)
- https://typesafe-jev.com/en/guides/api/ (커뮤니티 가이드, "공식 문서와 2026-10-11 일치" 주장) · https://docs.typesafe.ai/models
- https://pydantic.dev/docs/ai/models/system-one/
- https://thenewstack.io/decision-models-system-one/ (제목만 열람)
- https://console.upstage.ai/docs/models/solar-decide.md

**Strands Decider**
- https://strandsagents.com/blog/introducing-strands-decider/ (2026-10-01)
- https://github.com/strands-labs/strands-decider (README) · /blob/main/docs/inference.md · /blob/main/deploy/README.md · /blob/main/CHANGELOG.md
- https://huggingface.co/StrandsAgents/strands-decider-2B-qwen3.5-v1-2610 · https://huggingface.co/StrandsAgents/strands-decider-E2B-gemma4-v1-2610 · https://huggingface.co/models?search=strands-decider
- https://huggingface.co/Qwen/Qwen3.5-2B-Base
- https://venturebeat.com/technology/amazon-unveils-a-free-fast-open-source-jev-killer-strands-decider-2b-makes-decisions-in-fractions-of-a-second
- 커뮤니티 실측: https://dev.classmethod.jp/en/articles/strands-decider-local-setup/
- 커뮤니티 변환: https://huggingface.co/onnx-community/strands-decider-2B-hobson-v19-ONNX · https://huggingface.co/fabricant451/strands-decider-2B-hobson-v19-GGUF

**Ollama·llama.cpp·런타임**
- https://ollama.com/library/strands-decider · /tags · https://ollama.com/library/nimble · /laya · /d1
- https://docs.ollama.com/capabilities/decision · https://docs.ollama.com/api/systemone
- https://github.com/ollama/ollama · /releases · /releases/tag/v0.35.0 · v0.40.0 · v0.40.4 · v0.40.12
- https://github.com/ggml-org/llama.cpp/pull/29818 · https://aicoder.com/news/news-20261003-llamacpp-systemone-decision-models · https://blog.terenceluk.com/2026/10/llama-cpp-decision-models.html
- https://github.com/withcatai/node-llama-cpp

**기타 모델**
- https://huggingface.co/jaredpalmer/kev-4b · https://huggingface.co/leapshared/sciedu-router-kev4b
- https://huggingface.co/convaiinnovations/laya-multilingual
- https://fastino.ai/blog/gliner-2-5-decide-open-weight-decision-model
- https://huggingface.co/LGAI-EXAONE/EXAONE-4.0-1.2B · https://huggingface.co/carrtesy/EXAONE-4.0-1.2B-JEV
- https://huggingface.co/naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-1.5B/blob/main/LICENSE · https://huggingface.co/naver-hyperclovax/HyperCLOVAX-SEED-Text-Instruct-0.5B
- https://huggingface.co/kakaocorp/kanana-1.5-2.1b-base · https://www.kakaocorp.com/page/detail/11654?lang=ENG

**내부 선행 문서**
- R1: /Users/kibum/Documents/tex/sovereign-ax/research/R1-openai-decisions-responses.md
- R6: /private/tmp/claude-501/-Users-kibum-Documents-tex/beea5966-caf5-44db-b739-c4d6dbf950f7/scratchpad/research/R6-upstage-solar.md
- 설계: /Users/kibum/Documents/tex/sovereign-ax/design/04-model-layer.md (번들 카탈로그 §3)
