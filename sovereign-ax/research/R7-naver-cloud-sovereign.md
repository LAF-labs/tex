# R7. 네이버클라우드 이전안 · 국산 모델(HyperCLOVA X 등) 대안 평가 — 사실 조사

> 조사일·확인일: 2026-10-28 (표의 "확인일"은 별도 표기가 없으면 모두 이 날짜)
> 대상 설계: `design/09-cloud-services.md`, `design/01-system-architecture.md` §6, `design/04-model-layer.md`, `research/R1-openai-decisions-responses.md`(OpenAI 쪽 수치의 출처)
> 읽는 법: 각 사실 끝의 `[S#]`는 맨 끝 출처 표의 번호다. **신뢰도** — A: 1차 원자료를 직접 열람·파싱(가격 API, KISA 목록, API 문서 .md) / B: 1차 문서이나 요약 도구를 거쳐 읽음 / C: 언론·제3자 / D: 검색 스니펫만 본 것. 확인 못 한 것은 **미확인**이라고 썼다.
> 한계: 검색 도구는 요약 응답이고 미국 기준이다. 네이버클라우드 요금 페이지는 화면에서 값이 비어 있어(JS 렌더링) 같은 사이트가 쓰는 공개 가격 API(`/api/fees/price/KR/KRW`)를 직접 받아 파싱했다[S1]. AWS 가격은 AWS 공개 가격 파일(ap-northeast-2)에서 뽑았다[S4]. 실제 계약가·할인·VAT·환율은 반영하지 않았다. 법률 해석(CLOUD Act 등)은 변호사 검토가 필요하다.

---

## 0. 요약 (설계에 주는 함의)

1. **인프라만 옮기는 것은 비용 중립이다.** 사용자 1천 명 가정에서 월 약 47만 원(AWS 서울) 대 약 46만~56만 원(NCP, KMS를 HSM으로 쓰면 상단). 비용 차이는 모델 계층 차이에 비하면 오차다(§1.3).
2. **D09 §8의 "Ed25519 서명키를 KMS/HSM에"는 NCP KMS에서 불가능하다.** NCP KMS 키 타입은 `AES256 | RSA2048 | ECDSA(P-256)`뿐이다[S6]. 같은 설계가 AWS KMS에서는 2025-11부터 Ed25519(`ECC_NIST_EDWARDS25519`)를 지원한다[S7]. NCP로 가면 서명 알고리즘 변경(ECDSA P-256) 또는 외부 HSM이 필요하다.
3. **NCP의 CSAP IaaS 인증은 "공공기관용 네이버클라우드플랫폼"에 한정되고 2027-02-23 만료다.** 일반(상용) ncloud.com 리전에 CSAP가 붙는지는 KISA 목록 문구상 확인되지 않는다. AWS 서울은 하등급(다 그룹) IaaS, 2025-03-28~2030-03-27이다[S5]. KISA 목록에 "상등급/중등급"이 표기된 항목은 0건이다(하등급 5건). 소상공인·스타트업 판매에는 CSAP가 필요 없고, 공공 조달(공공 AX)에서만 의미가 있다.
4. **외국법 노출은 NCP 공식 입장 문구를 못 찾았다(미확인).** AWS는 미국 사업자라 일반론상 CLOUD Act 대상이고, AWS 공식 FAQ는 "법적 구속력 있는 정부 명령"에 따른 공개 예외를 인정한다[S19]. NCP도 해외 리전(미국 서부·독일 등)을 운영해[S21] "미국 관할 접점이 없다"고 단정할 수 없다.
5. **모델 쪽은 가격·기능 모두 Decisions 대체가 어렵다.** CLOVA Studio 최신 API 모델은 HCX-007(2025-07-29)이고 입력 1,250원/출력 5,000원 per 1M 토큰[S1·S8]. 확률/신뢰도(logprobs) 미지원[S8], 캐시 가격 항목 없음[S1]. 설계의 L1 판정만 비교하면 사용자당 월 약 1,600원 대 OpenAI Decisions 약 166원(약 9.6배), L1+L2 합계는 약 2,300원 대 약 990원(약 2.3배)이다(§3.2).
6. **"국산 소버린" 마케팅 근거로서 네이버의 지위가 약해졌다.** 독자 AI 파운데이션 모델 1차 평가에서 2026-01-15 탈락(독자성 기준 미달), 이후 2026-09-03 사이버보안 특화 모델 사업자로 선정[S10]. Upstage는 정예팀에 남았지만 API 호스팅 제공자는 AWS로 표기되어 있다[S13].
7. **주권 이득의 크기는 데이터 종류에 달려 있다.** 블롭은 E2EE 암호문이라 저장소를 국내 사업자로 옮겨도 기술적 노출 감소는 작고(조달·마케팅 이득이 큼), 마스킹된 평문이 흐르는 **모델 경로**가 실질적 주권 변수다(§5).
8. **완전 소버린이 되어도 남는 외국 의존**: APNs/FCM(대안 없음), 앱 스토어(iOS는 Apple 단일), 코드서명 CA(국내 발급 대안 미확인), npm/GitHub(자체 미러 외 대안 없음). PG·이메일은 국내 대안이 있다(§4.2).
9. **운영 위험 신호**: 2026-02-20 블록스토리지 장애(약 5시간, 일부 VM 파일시스템 손상 가능성 공지)[S11], 2026-10 연속 서비스 종료 공지[S23], ALB의 WebSocket 지원은 문서에 없음(미확인)[S22]. Terraform provider는 활발(v4.0.7, 2026-07-27)[S12].
10. **권고 방향(조사자 의견)**: 전면 이전은 근거 부족. 선택지는 (a) 저장·릴레이만 NCP(공공 조달·마케팅 목적, 서명 알고리즘 변경 필요), (b) 모델은 Decisions 유지 + HCX/Solar를 L2·"국내 처리" 옵션 플랜용 어댑터로 준비. 두 경우 모두 §7의 PoC(WSS, ECDSA 서명, S3 호환 범위, HCX 보존 정책) 후 결정.

---

## 1. 서비스 매핑과 가격

### 1.1 서비스 매핑표 (NCP 가격: 원, VAT 별도, 서울/한국 리전 KR, 확인일 2026-10-28, 출처 [S1][S2] 신뢰 A)

| 설계 구성요소 | NCP 서비스 | NCP 가격(공개 가격 API) | AWS 서울 대응·가격 [S4] | 비고·제약 |
|---|---|---|---|---|
| 컴퓨팅(게이트웨이·API·릴레이) | Server (VPC) High CPU 2vCPU/4GB, SSD 50GB | 시간 100원, 월 상한 72,000원 | c7g.large(2vCPU/4GB) $0.0816/h(≈월 $59.6) | 동급 비교는 근사. NCP 서버 월 단가는 720h 환산 |
| Kubernetes | Ncloud Kubernetes Service(NKS) | 마스터 노드 0원, 워커는 서버 요금 | EKS 클러스터 $0.10/h(≈월 $73) + 노드 | 소규모에서는 VM 직배포가 더 단순 |
| 함수 | Cloud Functions | 월 40만 GB·초, 100만 요청까지 무료, 초과 0.017원/GB·초, 200원(요청 단위 해석 미확정) | Lambda(ARM) $0.0000133334/GB·s, 요청 $0.0000002 | 요청-응답형. **WSS 릴레이에는 부적합**(장기 연결 기능 문서 미확인) |
| 블롭 | Object Storage (S3 호환, `kr.object.ncloudstorage.com`, SigV4) | 저장 28원/GB·월(1PB 이하), PUT/POST/LIST 0.0045원/건, GET 0.0004원/건, 외부 전송 100원/GB(구간 일부 무료 가능) | S3 Standard $0.025/GB·월, PUT $0.0045/1k, GET $0.0035/10k, 송신 $0.126/GB(월 100GB 무료) | 저장 단가는 NCP가 약 18% 저렴. **S3 호환 범위가 좁다**(§6) |
| PostgreSQL | Cloud DB for PostgreSQL (VPC) | AMD High CPU 2vCPU/4GB **시간 158원/서버**(월 약 113,760원), HA는 Primary+Secondary 선택. 백업 100원/GB·월, 블록스토리지 0.16원/GB·h | RDS PG db.t4g.medium Single-AZ $0.102/h, Multi-AZ $0.203/h, gp3 $0.131/GB(Multi-AZ $0.262) | PG 버전·확장(extension) 목록은 문서에 없음(미확인)[S22]. HA 요금이 서버 2대분인지 미확인 |
| 키 관리/서명 | Key Management Service | 일반 키 1,000원/키·월(2026-09-17부터 2,000·3,000원 항목 추가, 적용 대상 미확인), **HSM(`COMMON_HSM`) 50,000원/키·월**, 요청 2만 건 초과분 30원/1만 건 | AWS KMS $1/키·월, 요청 $0.03/10k(비대칭 $0.15/10k) | **Ed25519 없음**(AES256/RSA2048/ECDSA P-256), Sign 입력 최대 8KB[S6] |
| 로드밸런서 | Application LB(Small) / Network LB / Network Proxy LB | ALB Small 26원/h, 규칙 5개 무료, 인바운드 9원/GB | ALB ≈ $0.0225/h + LCU $0.008/h(시간당 단가는 가격 파일의 3개 동일가 항목 중 ALB로 추정) | ALB 문서에 **WebSocket 언급 없음**(HTTP/HTTPS 리스너만), NPLB는 TCP/TLS 리스너[S22] |
| 푸시 | SENS | SMS 9원, LMS 30원, MMS 100원, 알림톡 7.5원. **푸시 요금 항목은 가격 API에서 발견 못 함(미확인)** | SNS 모바일 푸시 월 100만 건 무료 | SENS 푸시는 FCM/APNs 인증서를 등록해 쓰는 중계다[S14]. 즉 **FCM/APNs를 대체하지 않는다** |
| 이메일 | SENS Mail (Cloud Outbound Mailer 통합, 2026-09-17) | 1,000건 초과분 0.45원/건으로 보임(해석 미확정) | SES(서울) $0.00015/건 | 구 Outbound Mailer API는 2027-12까지 제공[S14]. 통계·구독 관리 페이지 등 일부 기능 종료 보도 |
| CDN | Global CDN / Local CDN (CDN+는 Deprecated) | Local CDN 전송 90원/GB(0~512GB 구간) 등 구간제 | CloudFront(서울) 가격 미조사 | 레지스트리는 정적 소량이라 영향 작음 |
| 로그·모니터링 | Cloud Log Analytics, Cloud Insight | Insight 기본 지표 무료. Log Analytics 1GB 초과분 800원 수준(단위 해석 미확정) | CloudWatch 미조사 | 비교 표에서 제외 |
| 관리형 Kafka | Cloud Data Streaming Service(Kafka+ZooKeeper 자동 구성, 한국·싱가포르·일본)[S22] | 미조사 | MSK 미조사 | 설계에 Kafka는 불필요 |
| 관리형 Redis | Cloud DB for Cache — **Valkey 기반**, Redis 호환(2026-01 보도)[S22] | 미조사 | ElastiCache 미조사 | 릴레이 큐는 디스크 큐 설계라 영향 없음 |
| 인증서 | Certificate Manager Cloud Basic | 0원 | ACM 무료 | |
| CI/CD | SourceCommit/Build/Pipeline/Deploy | 가격 API에 항목 존재 | GitHub Actions 등 | 성숙도 미확인 |

### 1.2 비용 비교 가정 (사용자 1천 명, 월)

- 블롭 저장 1,000GB(1인 평균 1GB), PUT/LIST 30만 건, GET 100만 건, 외부 송신 총 130GB.
- 앱 노드 2대(2vCPU/4GB, SSD 50GB)에 게이트웨이·API·릴레이·정적 레지스트리를 얹음. LB 1대.
- PostgreSQL HA(2vCPU/4GB, 50GB), 키 4개(서명 2 + 암호화 2), 이메일 5천 건, 푸시 10만 건.
- NAT·공인 IP·로그·CDN은 양쪽 모두 제외. 환율은 NCP 가격 API 환율 1USD≈1,358원[S3].

### 1.3 월 비용 추정 (확인일 2026-10-28, 신뢰 A~B: 단가는 원자료, 수량은 가정)

| 항목 | AWS 서울 (USD) | NCP (원) |
|---|---|---|
| 앱 노드 2대 + 디스크 | 119.1 + 9.1 | 144,000 |
| DB(HA) + 스토리지 + 백업 | 148.2 + 13.1 | 227,520 + 11,520 + 5,000 (HA=서버 2대분 가정) |
| LB | 22.3 | 18,720 |
| 블롭 1TB + 요청 | 26.7 | 29,750 |
| KMS | 4.0 | 104,000 (HSM 키 2 + 일반 키 2) / 8,000 (HSM 없이) |
| 이메일 | 0.75 | 1,800 |
| 송신 130GB | 3.8 | 13,000 |
| **합계** | **약 $347 ≈ 471,000원** | **HSM 포함 약 555,000원(≈$409), HSM 없이 약 459,000원(≈$338)** |

해석: NCP는 저장이 싸고 DB·KMS(HSM)가 비싸다. HA 요금이 서버 1대분이면 NCP는 약 114,000원 줄어든다. **인프라 비용만으로는 이전 사유도 반대 사유도 되지 않는다.** 콘솔 계산기로 실측해야 정확하다(미확인: 최소 스토리지, 요금 단위 해석).

---

## 2. 주권·인증 비교 (AWS 서울 vs 네이버클라우드)

| 항목 | AWS 서울 리전 | 네이버클라우드 | 출처·신뢰 |
|---|---|---|---|
| CSAP IaaS 등급 | **하등급(다 그룹) IaaS**, CSAP-2025-014, 2025-03-28~2030-03-27. 서울 리전 대상 | 상용 일반 리전이 아니라 **"네이버클라우드플랫폼 공공기관용(IaaS)"**, CSAP-2017-001, 2022-02-24~**2027-02-23**. 등급(상/중/하) 표기 없음(구 단일등급) | KISA 목록 298건 전수 파싱[S5] A |
| 상·중등급 표기 | 목록 전체에서 상/중 표기 항목 **0건**, 하등급 5건(AWS·Google·Microsoft·SKT GPUaaS 등) | 위와 같음. 보도에 따르면 기존 IaaS·SaaS 표준·DaaS 인증은 신 체계에서 "중등급" 인정, SaaS 간편은 "하등급" 인정[S17] | [S5] A, [S17] D |
| AWS의 중·상등급 | 2026년 취득 보도 못 찾음(미확인) | — | [S18] 검색 |
| 기타 CSAP | — | SaaS 표준: Cloud DB(2024-03-28~2029-03-27), SECaaS 등. DaaS: Cloud Desktop | [S5] A |
| ISMS-P / ISMS | AWS 공식 페이지에 K-ISMS 링크는 있으나 본 조사에서 인증 여부 미확인 | ISMS-P·ISMS 2024-10-16~2027-10-15. ISO 27001/27017/27018/27701, SOC 1/2/3, CSA STAR, PCI DSS, MTCS L3, CBPR(2026-06-03~2027-06-02) | [S9] B |
| 공공·금융 전용 | 해당 없음(공공은 CSAP 하등급 범위만) | 별도 사이트·존: 공공기관용(gov-ncloud.com), 금융기관용(fin-ncloud.com). 금융은 "CSP금융(금융분야 클라우드 이용 가이드 준수)" 표기 | [S9] B. 공공용 요금·서비스 범위는 미확인 |
| 가용 영역 | 서울 4개 AZ(보도) | 한국 KR-1, KR-2 존(문서). 데이터센터 위치 미확인 | [S18] C, [S6 kms-spec] B |
| 데이터 소재지 문구 | "고객이 리전을 선택, 법률·구속력 있는 정부 명령에 필요한 경우를 제외하고 동의 없이 리전 밖으로 이동·복제하지 않음" | **"고객의 데이터는 고객 소유", 동의 없이 접근하지 않음**. 리전·국외 이전·정부 접근 요청 문구는 해당 페이지에 **없음(미확인)** | AWS [S19] B / NCP [S9 securityPrivacy] B |
| 외국 법률(CLOUD Act) | 사업자가 미국 기업. 공식 FAQ에 "CLOUD Act" 용어 없음. 일반론상 미국 관할 사업자는 저장 위치와 무관하게 영장 대상(개념 설명 자료 기준) | **공식 입장 문구 미확인.** 국내 사업자라는 점과 2022년 Thales 기반 고객 키 독점 HSM 서비스 보도가 있으나 CLOUD Act와 직접 연결한 자료는 없음. NCP도 미국 서부 등 해외 리전 운영 | [S19][S21][S20] C~D. 법률 검토 필요 |
| 소버린 오퍼링 | 한국용 소버린 리전 발표는 확인 못 함(유럽 소버린 클라우드는 2026-01 독일 출시 보도) | "전용·프라이빗 클라우드에 AI 얹어 제공"(2026-05 DTW 발언) | [S10] C |
| 지배구조 | 미국 | 한국 | — |

참고: Gartner는 "서버·데이터를 국내에 두는 것만으로 주권이 보장되지 않고, 장애·페일오버·유지보수 시 데이터 경로와 관리 기능 위치를 지속 검증해야 한다"고 경고했다(2026-08)[S20, C]. 즉 어느 쪽으로 가든 **운영 중 데이터 경로 검증**이 필요하다.

공공 AX 관점: 공공이 SaaS를 쓰려면 CSAP 인증 제품이어야 하고(표준은 중요 데이터 포함 서비스, 그 외는 간편)[S17 D], 하부 IaaS 요건과의 관계는 미확인이다. NCP 측은 "CSAP 취득 기업의 82%가 네이버클라우드 IaaS 기반"이라 밝혔다는 보도가 있으나 회사 측 주장이고 시점 불명이다(C).

---

## 3. 모델 계층

### 3.1 HyperCLOVA X / CLOVA Studio 사실 (확인일 2026-10-28)

| 항목 | 내용 | 출처·신뢰 |
|---|---|---|
| 최신 API 모델 | **HCX-007**(하이브리드 추론, 2025-07-29 출시), HCX-005(비전), HCX-DASH-002(경량), HCX-003, HCX-DASH-001. 릴리스 노트의 최신 항목은 2026-01-22(문서 안내)이며 2026년 신규 API 모델 출시는 **확인 못 함**. 문서 페이지에 "stale" 표시 있음 | [S8] B |
| 신규 모델 소식 | 2026-05-28 "차세대 하이퍼클로바X"를 네이버 AI탭(6월 정식)에 적용 — 외부 API 제공 여부 언급 없음. 2025-12-29 오픈소스 SEED 8B Omni·SEED 32B Think 공개(API 아님). 2026-06 SEED 4B 경량 옴니 보도 | [S10] B~C |
| 컨텍스트 | HCX-007 128K(최대 출력 32,768), HCX-005 128K(출력 4,096), DASH-002 32K(출력 4,096) | [S8] B |
| 가격(원/토큰, Basic 추론) | HCX-007 입력 0.00125 / 출력 0.005 → **1,250원 / 5,000원 per 1M**(≈$0.92 / $3.68). HCX-005 동일. DASH-002 250원 / 1,000원 per 1M. 튜닝 모델 추론은 2배(예: HCX-005 2,500/10,000). Exclusive(전용) HCX-005 월 25,000,000원, DASH-002 월 11,000,000원. 추론 토큰은 TotalToken에 포함되어 과금(운영자 답변)이므로 출력 단가 적용으로 가정 | [S1] A |
| 캐시 | 가격 항목에 캐시 읽기/쓰기 없음. 문서에서도 프롬프트 캐싱 언급 못 찾음 → **캐시로 판정 비용을 낮출 수단 없음(미지원으로 보임, 미확인)** | [S1][S8] |
| Structured outputs | **HCX-007만**. JSON Schema 일부(`enum`, `anyOf`, string/number/array/object, `minimum` 등), `pattern` 불가. 추론·function calling과 동시 사용 불가, `thinking.effort`는 `none`만. 문서 내 예시와 서술이 서로 충돌하므로 실측 필요 | [S8] B |
| Function calling | HCX-007·HCX-005·DASH-002 표에 ○. `maxTokens`≥1024, 추론·이미지와 동시 사용 불가, 튜닝 모델 불가 | [S8] B |
| logprobs / 확률 | **OpenAI 호환 API에서 `logprobs`·`top_logprobs`·`prompt_cache_key`·`store`·`safety_identifier` 미지원.** 네이티브 응답에도 확률 필드 없음 | [S8] A(.md 원문) |
| 분류 전용 수단 | **Router**: 질의를 사전 정의한 "도메인"으로 분류하고 콘텐츠·세이프티 필터 결과를 반환. 신뢰도 점수 없음. 단가 DASH-002 학습 모델 기준 500원/1M 토큰 수준 | [S8][S1] A |
| 레이트 리밋(2025-07-17 기준, 갱신 안 됨) | 서비스 앱 기준 HCX-007 **180 QPM / 300,000 TPM**, HCX-005 300 / 180,000, DASH-002 450 / 240,000. TPM은 입력+`maxTokens`로 계산. 429 반환 | [S8] A |
| 데이터 보존·학습 이용 | 공식 문서에서 **API 입력 데이터의 저장·학습 이용 문구를 찾지 못함(미확인)**. 약관·개인정보처리방침 본문 확인 필요. 구 제안서(v1.16)에는 "튜닝 학습 데이터는 학습 후 파기" 문구 | [S8] 미확인 |
| 리전 | Korea only(VPC·Classic) | [S8] B |
| OpenAI 호환 | `https://clovastudio.stream.ntruss.com/v1/openai/`, 지원 모델 예시 HCX-005, `response_format.type=json_schema`만, `n=1`, `reasoning_effort` none/low/medium/high | [S8] A |

### 3.2 모델 비교표 (OpenAI Decisions/Terra vs HyperCLOVA X vs Solar)

| 항목 | OpenAI Decisions(`gpt-6-luna`) | OpenAI Terra(`gpt-6.1-terra`) | HyperCLOVA X(CLOVA Studio, HCX-007) | Upstage Solar Pro 4 / Pro 3 |
|---|---|---|---|---|
| 용도(설계) | L1 열거형 판정 | L2 도구 제한 추론 | L1/L2 모두 대체 시도 | 대체 시도 |
| 입력 단가 /1M | $0.10 | $1.00 | 1,250원(≈$0.92) | Pro 4 $0.30, Pro 3 $0.15 |
| 출력 단가 /1M | 무료 | $5.00 | 5,000원(≈$3.68) | Pro 4 $1.20, Pro 3 $0.60 |
| 캐시 읽기 /1M | $0.01(쓰기 $0.125) | $0.05(쓰기 $1.25) | 해당 항목 없음 | $0.06(Pro 4), $0.015(Pro 3) |
| 컨텍스트 | 창 1.05M | 창 1.05M, 출력 128K | 128K, 출력 32,768 | Pro 4 512K·출력 128K, Pro 3 128K |
| 확률/신뢰도 | **확률·confidence 반환** | — | **없음**(logprobs 미지원) | logprobs 문서 언급 없음 |
| Structured output | 질문 단위 predicate/choice/score | 지원 | HCX-007만, thinking none 제약 | 지원 |
| Function calling | 해당 없음 | 지원 | 지원(제약 있음) | 지원 |
| 레이트 리밋 | Decisions 전용 미확인 | Build 1M TPM~ | 180 QPM/300K TPM(서비스 앱, 2025-07 기준) | 미확인 |
| 데이터 보존 | 남용 로그 최대 30일, ZDR 승인 필요 | `store:false`, ZDR 승인 필요 | **미확인** | "데이터 수집 안 함·학습 미사용(필요 목적 외 저장 안 함)" 문서 표기 |
| 처리·호스팅 위치 | 처리: 미국·EU·UAE만, 한국은 저장만(R1) | 동일 | Korea only(NCP) | 호스팅 제공자 "Amazon Web Services", 리전 미표기 |
| 상태 | GA 2026-10-22 | 2026-10-26 출시 | 최신 API 모델 2025-07 | Pro 4 2026-08-06 출시, **Pro 3·Mini는 2026-10-30 종료** |
| 출처 | R1[S24] | R1[S24] | [S1][S8] | [S13] |

비용 환산(설계 04 §6 사용자당 월 가정: L1 350회×입력 3.5k, L2 40회×6k/0.8k, 복구 3회×2턴×20k/3k, 환율 1,358원):

| 구성 | 사용자당 월(원) | OpenAI 대비 |
|---|---|---|
| OpenAI (Decisions + Terra low/medium, 캐시 효과 0) | 약 990(=$0.73) | 1.0× |
| L1을 HCX-007(`thinking none`, 열거형 출력)로, L2도 HCX-007 | 약 2,300 | **약 2.3×** (L1만 보면 약 9.6×) |
| L1을 HCX-DASH-002(function calling으로 열거형 강제)로 | L1 약 320원 | L1 약 1.9× (기능·정확도 실측 필요) |

→ 사용자 1천 명이면 월 모델 비용 차이가 약 130만 원(≈$960)이어서 §1.3의 인프라 차이(±수만 원)보다 훨씬 크다. 9,900원 요금제 기준 모델 원가가 약 10% → 약 23%로 오른다. 확률이 없으므로 설계 04의 `confidence` 임계값(라벨 코퍼스로 재산정, 설계 04의 검증 항목 S7)을 쓰는 방식은 그대로 이식할 수 없고, 자기일관성(여러 번 호출)이나 `seed` 고정 후 투표 같은 대체가 필요하며 비용이 더 늘어난다(조사자 추정).

"판정(열거형 분류)을 싸게 하는 수단" 점검: 로그프롭 없음 / 분류 전용 API는 Router(도메인 단위, 신뢰도 없음) / 캐시 없음 / 가장 싼 후보는 DASH-002(250원 /1M 입력)이나 Structured Outputs 미지원(function calling 우회) → **HCX는 Decisions에 대응하는 수단이 없다.** 단 L2(자유 추론·도구)는 HCX-007이 단가상 Terra와 같은 수준(L2 low 약 460원 대 약 543원)이다.

### 3.3 마켓플레이스·모델 가든·정부 프로젝트

- **NCP에서 제3사 모델(Upstage Solar 등) 제공 여부: 확인 못 함.** 가격 API의 AI Services 항목에 Solar 등 제3사 모델 과금 항목이 없고(CLOVA, OCR, Speech, RAG, MLX GPU 등만 확인), 마켓플레이스 등재 여부는 검색에서도 확인되지 않았다(A: 가격 API / D: 검색). 자체 호스팅용으로는 MLX(GPU H100/H200, H200 단위가격 15,245원 항목)가 있다[S1].
- **HyperCLOVA X SEED 32B Think(오픈 가중치)**: 128K, 모델 라이선스는 별도 계약서(상업 이용 조건·매출 제한은 페이지에 없음, 미확인), 권장 4×A100 80GB. function calling·구조화 출력은 모델 카드에 언급 없음[S10 HF, B].
- **Upstage**: Solar Pro 4(512K, API는 OpenAI 호환 `api.upstage.ai/v1`), 오픈웨이트 Solar Open 2(MoE 250B/활성 15B, H200 2장 구동 주장)[S13, C]. 업스테이지 정부 프로젝트 지위: 정예팀 유지(2026 상반기 기준 LG AI연구원·SKT·업스테이지·모티프테크놀로지스 4곳)[S10, C].
- **네이버의 독자 AI 파운데이션 모델 프로젝트 지위**: 2025-08 정예팀 5곳 선정 → **2026-01-15 1차 평가 탈락**(점수는 상위권, 비전 인코더가 Qwen 2.5 인코더와 코사인 유사도 99.51%로 독자성 기준 미달 판정; 네이버는 추론 엔진은 100% 자체 기술이라 해명) → 2026-09-03 사이버보안 특화 AI 모델 사업자 선정(B200 256장, 10개월) → 모두의 AI 공모에는 불참(모델 목록에서 제외)[S10, C]. 네이버클라우드 대표는 2027년까지 HyperCLOVA X를 계속 고도화하겠다고 밝혔다[S10].

---

## 4. 운영 현실과 "남는 외국 의존"

### 4.1 운영 (확인일 2026-10-28)

| 항목 | 사실 | 출처·신뢰 |
|---|---|---|
| 스타트업 크레딧 | **그린하우스**: 제휴 AC/VC 투자 또는 제휴기관 지원사업 수혜 스타트업 대상, 최대 1억 원 크레딧을 최대 2년 분할 지급, 사업자 계정만(개인 가입 불가), 신청 후 영업일 평균 5일 이내 지급(공식 안내). 비제휴는 오픈이노베이션 공모 최대 2천만 원(2025년 공고, 2026년 공고는 미확인). 이미 NCP를 쓰는 기업은 별도 검토. 2026-06-29~09-30 신규 가입 20만 원 프로모션(블로그, 종료됨) | [S15] C~B |
| 가입·심사 리드타임 | 일반 사업자 가입은 사업자등록증+법인카드+휴대폰 인증(블로그). **심사 소요 기간·SENS 발신번호 등록 소요는 미확인.** 공공기관용은 사전 컨설팅과 회원가입코드 필요 | [S9] C, 미확인 |
| 지원 품질 | 공식 SLA·지원 응답 시간 자료는 미확인. 2026-02-20 장애 때 고객사 공지문이 기사화된 사례만 확인 | 미확인 |
| 장애 이력 | **2026-02-20 15:26경 블록스토리지 장비 장애 → 일부 VM 불안정, 약 5시간 후(20시 이후) 복구, 일부 VM 파일시스템 손상 가능성으로 전 이용자에게 최소 1회 재부팅·무결성 점검 권고, 보상 언급 없음.** 2026-09-03 "일부 VM HA 발생 및 복구 지연" 공지 제목만 확인(상세 미확인) | [S11] C |
| 서비스 종료 공지 | 2026-10-07~13 연속: App Safer, File Safer·Web/System Security Checker·Webshell Behavior Detector, SSL VPN, Live Station, VOD Station 등 **2027-01-21 종료**. Cloud Outbound Mailer는 SENS로 통합(2026-09-17). CDN+ Deprecated, API Workflow Deprecated | [S23] B, [S1] A |
| IaC | Terraform provider `NaverCloudPlatform/ncloud` **v4.0.7(2026-07-27)**, 레지스트리 누적 다운로드 약 62만, 63개 버전, 최근 릴리스 4.0.5(2026-03-17)→4.0.6(2026-07-13)→4.0.7, GitHub 별 120·오픈 이슈 33, MPL-2.0, 마지막 push 2026-09-02. KMS·Object Storage·PostgreSQL·LB 리소스 지원 범위는 미조사(미확인) | [S12] A |
| 관리형 서비스 공백 | Kafka(CDSS) 있음, Redis는 Valkey 기반 Cache DB로 대체, PostgreSQL 있음(버전·확장 미확인). **WSS를 지원하는 L7 LB는 문서상 미확인**, Cloud Functions는 이벤트형 | [S22] B |
| 키 서명 | ECDSA P-256 + SHA-256, ASN.1 DER, 최대 8KB, 토큰 인증 API 있음 | [S6] A |

### 4.2 완전 소버린 구성 시 남는 외국 의존

| 의존 | 현재 설계 | 국내/비외국 대안 | 판단 (확인일 2026-10-28) |
|---|---|---|---|
| iOS 푸시(APNs) | 내용 없는 깨우기 푸시 | **없음.** NCP SENS 푸시도 APNs/FCM 인증서를 등록하는 중계일 뿐[S14]. 네이버가 제3자 앱에 제공하는 자체 푸시는 검색에서 못 찾음(미확인) | 폴백은 앱 포그라운드 WSS·주기 폴링뿐. 설계의 "내용 없는 깨우기" 원칙이 이미 최선 |
| Android 푸시(FCM) | FCM data | **없음**(구글 서비스 없는 기기 대응은 상시 연결 서비스뿐, 배터리 비용) — 일반 지식, 이번 조사 미검증 | 위와 동일 |
| 앱 스토어 | App Store / Play | iOS는 Apple 단일. 한국의 대체 마켓 허용은 2026-10 기준 확정 근거 못 찾음(방통위·공정위 조치 미확인). Android는 국내 마켓·직접 설치 가능(일반 지식, 미검증) | 대안 사실상 없음(iOS) |
| 코드서명 CA | Authenticode/공증 | **Microsoft Artifact Signing**: 한국 조직 Public Trust 신청 가능, 한국 중부 리전 지원(문서 2026-10-08 갱신), 조직 검증 1~20영업일 — 단 미국 기업 서비스. Sectigo·DigiCert·SSL.com 등 해외 CA. **Windows가 신뢰하는 국내 발급 CA는 검색에서 못 찾음(미확인)**. macOS 공증은 Apple 필수 | 외국 의존 잔존 |
| PG(결제) | PG 결제 | 토스페이먼츠·포트원 등 국내 PG. 정기결제(빌링키)는 빌링용 MID를 별도 심사받아야 함(포트원 블로그 2026-04-01, 마케팅 콘텐츠) | 국내 대안 있음 |
| 이메일 발송 | 이메일 발송 | SENS Mail(국내). 도달률·평판은 미확인. AWS SES도 선택지 | 국내 대안 있음 |
| GitHub/CI | (설계 미기재) | NCP SourceCommit/Build/Pipeline/Deploy 존재(가격 항목 확인), 성숙도 미확인. 자체 호스팅 GitLab/Gitea도 가능(일반 지식) | 대안 있으나 전환 비용 큼 |
| npm 공급망 | npm | NCP 내 npm 레지스트리 서비스는 못 찾음. 사설 미러(Verdaccio 등)+lockfile 무결성 고정이 현실적(일반 지식) | 공급망 의존은 소버린으로 해결 안 됨 |
| 모델 공급사 | OpenAI | HyperCLOVA X, Solar(위 §3) | 비용·기능 손실 동반 |
| DNS·TLS | (설계 미기재) | NCP Certificate Manager Cloud Basic 0원 | 대안 있음 |

---

## 5. 혼합안 (주권 이득과 비용)

| 안 | 구성 | 국외로 나가는 것 | 주권 이득 | 비용 영향 |
|---|---|---|---|---|
| A | 저장·메타데이터·릴레이·레지스트리는 NCP, 모델은 OpenAI | 모델에 보내는 **마스킹된 평문**(화면 텍스트·질의 요약)이 미국·EU·UAE에서 처리됨(OpenAI 리전 처리 한계, R1). 푸시 토큰은 APNs/FCM | 블롭은 E2EE 암호문이라 저장소 이전의 **기술적** 노출 감소는 작음. 메타데이터(doc_type 열거형, 만료일)·계정 이메일·계량 레코드가 국내 사업자·국내 법 관할로 이동. 공공 조달 시 "공공기관용 NCP" 사용 가능성 | 인프라 ±수만 원(§1.3). 서명 알고리즘 변경 공수, S3 호환 보정, PoC 필요. 크레딧 최대 1억 원(조건부)이 있으면 초기 비용은 오히려 감소 가능 |
| B | 저장은 AWS 서울 유지, 모델만 HyperCLOVA X(NCP) | 모델 입력이 국내(NCP)에서 처리되어 평문 경로가 국내에 머묾. 게이트웨이(AWS)→NCP 호출은 AWS 쪽 장비가 평문을 거침 | 평문이 흐르는 경로의 주권은 가장 큼. 단 게이트웨이 운영자(우리)가 AWS 위에 있어 "완전 국내"라고 표기할 수 없음 | 모델 비용 약 2.3×(L1 약 9.6×), 확률 부재로 판정 설계 변경, 레이트 리밋 300K TPM 한계, 보존 정책 미확인 |
| C | 둘 다 NCP + HyperCLOVA X | 위 둘의 합. 외국 의존은 푸시·스토어·서명·npm만 | 마케팅상 가장 강함. 단 네이버 모델은 독자 파운데이션 1차 탈락 이력이 있어 "국산 독자 모델" 문구는 주의 | A+B 비용·공수 합산 |
| D | 현행(AWS + OpenAI) + 모델 어댑터만 다중화 | 현행과 같음 | 소버린 플랜 옵션을 빠르게 열 수 있음. 설계 04의 `ModelAdapter`에 HCX/Solar 구현체 추가 | 평시 비용 0, 개발 공수만 |

핵심: **E2EE 설계에서는 저장소가 아니라 모델이 주권의 병목**이다. 블롭 암호문을 지키는 것은 암호가 하고, 사업자 국적은 메타데이터·가용성·조달 요건에만 영향을 준다. 다만 모델을 국산으로 바꾸면 비용이 오르고 확률이 사라지는 대가가 크다(조사자 해석).

---

## 6. 전환 시 설계 변경점 (NCP로 옮길 경우)

| 문서 | 변경 | 이유·근거 |
|---|---|---|
| D09 §8 레지스트리 | 서명 알고리즘을 **ECDSA P-256 + SHA-256(DER)**로 변경하거나 Ed25519를 외부 HSM에서 운용. 인덱스·정책은 8KB 이내로 서명하고 패키지는 인덱스 안 해시로 연결. 클라이언트 핀 고정 공개키·"로드할 때마다 재검증" 원칙은 유지. CI의 2인 승인 단계가 NCP KMS Sign(토큰 인증·IP ACL)을 호출 | KMS 키 타입에 Ed25519 없음, Sign 8KB 제한[S6]. 서명 키는 `COMMON_HSM`(50,000원/키·월)으로 생성해야 HSM 보관(BASIC은 내부 스토리지 암호화 저장) |
| D09 §4 릴레이 | WSS 종단을 **Network Proxy LB(TCP/TLS)**로 하거나 서버가 직접 TLS 종단. ALB는 문서에 WebSocket 언급이 없어 PoC 전 사용 금지. LB idle timeout 기본값·상한 미확인 → 앱 레벨 ping 간격 설계 | [S22] |
| D09 §4 푸시 | SENS 푸시는 APNs/FCM 인증서 등록 중계이므로 이점 없음 → 릴레이가 직접 APNs/FCM 호출 유지 | [S14] |
| D09 §5 블롭 | NCP S3 호환은 버킷 오퍼레이션이 ACL·CORS·List Multipart 위주이고 `ListObjectsV2` 미지원, 객체 오퍼레이션은 PUT/COPY/GET/HEAD/DELETE/멀티파트 중심. **버전 관리·Object Lock·서버측 암호화·버킷 정책 API가 목록에 없음**(수명주기는 콘솔 기능만 확인). → "삭제 7일 유예", "백업 30일"은 앱 레벨 소프트 삭제·별도 버킷 복제로 구현. SigV4 사용, 프리사인 URL 지원은 PoC | [S21] A |
| D09 §10 / 처리방침 | 데이터 보존표의 "블롭 삭제 + 백업 30일" 실현 방식 갱신 | 위와 같음 |
| D09 §3 게이트웨이 | 공급사가 HCX일 경우 `safety_identifier`·`prompt_cache_key`·`store`를 보낼 수 없음(OpenAI 호환 API 미지원 필드)[S8]. 계정 단위 남용 방지는 게이트웨이 자체 해시로. 레이트 리밋 300K TPM·180 QPM 상한이 계정 풀 전체에 걸림 → 증설 문의 필요(미확인) | |
| D04 모델 계층 | `decide`의 `confidence` 임계값 방식이 HCX에선 성립하지 않음. 열거형 판정은 HCX-007(`thinking:none` + `enum`) 또는 function calling 강제로 구현하고, 정확도는 설계 04의 검증 항목 S7 코퍼스(300장+)로 재측정 | [S8] |
| 운영 | 데이터 경로 점검(장애·페일오버 시)을 정례화, NCP 서비스 종료 공지 모니터링, 키 로테이션 정책을 KMS 자동 회전(API 2.0)에 맞춤 | [S20][S23] |
| IaC | Terraform `ncloud` provider 사용. 리소스 범위 검증 필요 | [S12] |

---

## 7. 미확인 목록과 확인 방법

| # | 미확인 | 확인 방법 |
|---|---|---|
| 1 | NCP의 CLOUD Act·정부 접근 요청 대응 공식 입장, 투명성 보고서 | 네이버클라우드 영업/법무 문의, 이용약관·DPA 본문, 변호사 검토 |
| 2 | 상용 ncloud.com 한국 리전에 CSAP 인증이 적용되는지(KISA 문구는 "공공기관용"), 공공기관용 요금·서비스 범위 | KISA 인증서 PDF, 공공용 요금 페이지, NCP 담당자 |
| 3 | AWS 서울 중·상등급 계획, AWS ISMS-P 현황 | KISA 목록 재조회(분기), AWS 코리아 공공부문 문의 |
| 4 | CLOVA Studio 입력·출력 데이터 보존·학습 이용, SLA, 레이트 리밋 증설 절차 | CLOVA Studio 이용약관·개인정보처리방침 본문, 기술지원 티켓 |
| 5 | HCX 신규 API 모델(2026년) 및 HCX-007 종료 일정 | CLOVA Studio 릴리스 노트(갱신 중단 상태), 영업 문의 |
| 6 | HCX-007의 `enum` 구조화 출력이 `thinking:none`과 함께 실제로 동작하는지(문서 내 충돌), 판정 정확도·재현성 | 설계 04의 검증 항목 S7 코퍼스로 2일 PoC |
| 7 | ALB 및 NPLB에서의 WebSocket(WSS) 유지·idle timeout 상한 | 소형 PoC(장기 연결 24시간 시험) |
| 8 | NCP Object Storage 프리사인 URL, 멀티파트 한도, 수명주기 API, 서버측 암호화 | 샌드박스 계정에서 AWS SDK 호환 테스트 |
| 9 | Cloud DB for PostgreSQL 버전·확장·최소 스토리지, HA 요금이 서버 2대분인지 | 콘솔 요금 계산기, 문서 상세 |
| 10 | SENS 푸시 요금, SENS Mail 요금 단위, 도달률 | 콘솔 계산기, 시험 발송 |
| 11 | NCP 제3사 모델(Upstage 등) 제공 여부, Solar 호스팅 위치(AWS 리전) | NCP 마켓플레이스 직접 검색, Upstage 영업 문의 |
| 12 | HyperCLOVA X SEED 상업 라이선스 조건 | HF 저장소의 LICENSE 파일 |
| 13 | 가입·심사 리드타임, SENS 발신번호 등록 기간, 지원 응답 품질 | 가입 시도 및 지원 티켓 테스트 |
| 14 | 2026-09-03 "VM HA 복구 지연" 공지 상세, 2026-02-20 장애 사후 분석·보상 | NCP 공지 원문 |
| 15 | 국내 발급 Windows 신뢰 코드서명 CA 유무, 한국 iOS 대체 마켓 정책 | MS Trusted Root 목록, 방통위·공정위 발표 |
| 16 | 그린하우스 2026년 모집 현황, 본 팀 자격(제휴 AC/VC 여부) | greenhouse.oopy.io 신청 안내 |
| 17 | 환율·VAT·약정 할인 반영한 실제 월 비용 | NCP 계산기·AWS Pricing Calculator 입력 |

---

## 8. 출처 (확인일 2026-10-28)

| # | 내용 | URL | 신뢰 |
|---|---|---|---|
| S1 | NCP 공개 가격 API(한국 리전): Object Storage, Server, Cloud DB, KMS 외(공통), LB, SENS, CLOVA Studio 토큰 단가 | https://www.ncloud.com/api/fees/price/KR/KRW | A |
| S2 | NCP 공개 가격 API(공통): KMS, Cloud Insight, Certificate Manager | https://www.ncloud.com/api/fees/price/COM/KRW | A |
| S3 | NCP 환율 API(KRW→USD 7.362E-4) | https://www.ncloud.com/api/fees/exchange-rate/KRW/USD | A |
| S4 | AWS 가격 파일(서울): S3(공표 2026-10-15), KMS(10-26), RDS(10-26), EC2(10-27), ELB(09-11), SES(10-27), SNS(09-15), 데이터 전송(09-16), EKS(10-27), Lambda(10-22) | https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/{AmazonS3,awskms,AmazonRDS,AmazonEC2,AWSELB,AmazonSES,AmazonSNS,AWSDataTransfer,AmazonEKS,AWSLambda}/current/ap-northeast-2/index.json | A |
| S5 | KISA CSAP 인증서 발급현황(전체 298건 중 전 페이지 파싱) | https://isms-p.or.kr/sttus/vrtl/selectVrtlCrtfctList.do | A |
| S6 | NCP KMS API: Create Key(`keyType`, `protectionType`), Sign, 목록, 사용 준비 | https://api.ncloud-docs.com/docs/security-kms2-create-key , https://api.ncloud-docs.com/docs/security-kms-sign , https://api.ncloud-docs.com/docs/security-kms , https://guide.ncloud-docs.com/docs/kms-spec | A~B |
| S7 | AWS KMS Ed25519(EdDSA) 지원 발표 2025-11 | https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/ | D(검색 요약) |
| S8 | CLOVA Studio: 모델, 이용량 제어, 릴리스 노트, OpenAI 호환, Structured Outputs, Function calling, Thinking, Router, 사용 준비 | https://guide.ncloud-docs.com/docs/clovastudio-model , https://guide.ncloud-docs.com/docs/clovastudio-ratelimiting , https://guide.ncloud-docs.com/docs/clovastudio-releasenote , https://api.ncloud-docs.com/docs/clovastudio-openaicompatibility , https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-so , https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-fc , https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3-thinking , https://api.ncloud-docs.com/docs/clovastudio-router , https://guide.ncloud-docs.com/docs/clovastudio-spec | A~B |
| S9 | NCP 인증·프라이버시 센터 | https://www.ncloud.com/certificate , https://gov-ncloud.com/certificate , https://privacy.navercloudcorp.com/ko/Compliance/certificate_ncc , https://www.ncloud.com/intro/securityPrivacy | B |
| S10 | 네이버 독자 AI 프로젝트·HyperCLOVA X 동향 | https://www.e-focus.co.kr/news/articleView.html?idxno=3002822 , https://www.etnews.com/20260520000317 , https://www.aitimes.com/news/articleView.html?idxno=211020 , https://www.navercloudcorp.com/ko/media/pressrelease/view/?seq=34213 , https://huggingface.co/naver-hyperclovax/HyperCLOVAX-SEED-Think-32B , https://namu.wiki/w/HyperCLOVA | B~C |
| S11 | 2026-02-20 NCP 블록스토리지 장애 | https://zdnet.co.kr/view/?no=20260220200227 , https://ceoscoredaily.com/page/view/2026022023332673412 | C |
| S12 | Terraform provider ncloud, GitHub 저장소 | https://registry.terraform.io/v1/providers/NaverCloudPlatform/ncloud , https://api.github.com/repos/NaverCloudPlatform/terraform-provider-ncloud | A |
| S13 | Upstage Solar Pro 3/4 사양·가격, 가격 페이지, Solar Open 2 | https://console.upstage.ai/docs/models/solar-pro-3 , https://console.upstage.ai/docs/models/solar-pro-4 , https://www.upstage.ai/pricing , https://www.opensourceforu.com/2026/07/upstage-releases-open-source-solar-open-2-ai-agent-model/ | B~C |
| S14 | SENS/Outbound Mailer 통합, SENS 푸시 인증서 | https://m.news.nate.com/view/20260826n27002 , https://guide.ncloud-docs.com/docs/en/sens-certificate | B~C |
| S15 | 그린하우스(스타트업 크레딧) | https://greenhouse.oopy.io/ , https://greenhouse.oopy.io/application | C |
| S16 | Microsoft Artifact Signing 퀵스타트(한국 조직 가능, 한국 중부 리전, 2026-10-08 갱신) | https://learn.microsoft.com/azure/artifact-signing/quickstart | A |
| S17 | CSAP 등급제 개편(기존 IaaS=중등급 인정), SaaS 표준/간편 | https://zdnet.co.kr/view/?no=20230207093729 | D |
| S18 | AWS CSAP 하등급 보도 | https://byline.network/2025/04/1-1292/ , https://zdnet.co.kr/view/?no=20250401173707 | C |
| S19 | AWS 데이터 프라이버시 FAQ | https://aws.amazon.com/compliance/data-privacy-faq/ | B |
| S20 | Gartner 소버린 클라우드 경고(ZDNet 2026-08-08), NCP HSM 서비스 보도(2022) | https://zdnet.co.kr/view/?no=20260808140522 , https://www.businesswire.com/news/home/20220620005225/en | C |
| S21 | NCP Object Storage S3 호환 API 개요(리전 엔드포인트 5곳, 지원 오퍼레이션) | https://api.ncloud-docs.com/docs/storage-objectstorage | A |
| S22 | NCP LB(ALB, NPLB), Cloud DB for PostgreSQL 사용 준비, CDSS, Cache DB(Valkey) | https://guide.ncloud-docs.com/docs/loadbalancer-application-vpc , https://guide.ncloud-docs.com/docs/loadbalancer-proxylb-vpc , https://guide.ncloud-docs.com/docs/clouddbforpostgresql-spec , https://guide.ncloud-docs.com/docs/cdss-overview , https://www.etnews.com/20260102000088 | B |
| S23 | NCP 금융 클라우드 공지(서비스 종료 안내 2026-10) | https://www.fin-ncloud.com/support/notice/all | B |
| S24 | 내부 문서: OpenAI Decisions/Terra 수치 | /Users/kibum/Documents/tex/sovereign-ax/research/R1-openai-decisions-responses.md , /Users/kibum/Documents/tex/sovereign-ax/design/04-model-layer.md | — |
