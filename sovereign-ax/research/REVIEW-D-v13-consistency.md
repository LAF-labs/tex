# 설계 v1.3 정합성·완전성 검수 (D)

검수 대상: `/Users/kibum/Documents/tex/sovereign-ax` — design/D00~D19, schemas 9종, ADR 16건 + README, adr/README, 기획 02/03/04/06/README.
방법: cat/grep/sed/python3(표준 라이브러리만). 스키마 적합성은 직접 짠 소형 2020-12 검증기로 확인했고(검증기 동작은 변형 입력 3종으로 오류를 잡는지 따로 확인), 등록부 대조는 스크립트로 101행 × 반영 문서 208개 참조를 훑은 뒤 빠진 것을 손으로 확인했다. 파일은 고치지 않았다.

## 0. 총계와 판정

| 심각도 | 건수 |
|---|---|
| Blocker | 0 |
| Major | 15 |
| Minor | 41 |

**판정: Blocker 0이므로 커밋해도 된다.** 다만 Major 15건 중 M1·M2(요약 숫자), M3(반례 번호), M4·M5·M6(스키마·DDL·서명 규칙 충돌), M8(오프라인 큐 스키마)은 다음 패치에서 먼저 고칠 것을 권한다. 구현자가 서로 다른 정본을 고를 수 있는 항목이기 때문이다.

자동 확인 결과 요약
- JSON 9종 모두 파싱된다. `$schema`는 모두 2020-12다. 내부 `$ref`는 전부 해석되고, 외부 `$ref` 2개(hotfix → `selectors.schema.json#/$defs/candidate`, `#/$defs/commitEndpoint`)도 해석된다.
- D02 §8 H-01(32 스텝)은 `playbook-ir.schema.json`에 **오류 0건**이다. D02 §2.1 셀렉터 예시 2개는 `selectors.schema.json#/$defs/entry`에 오류 0건이다. D03 §7 정책 예시는 `policy.schema.json` 기준으로 `signatures` 누락만 있다(본문에 "생략"이라고 적혀 있으므로 정상).
- H-01 `s19b` readback 13개 필드 = `remote-envelope.schema.json` `$defs.fieldKey` enum 13개(차집합 없음). toolset enum(D04 §1 = gateway-request), portal enum(playbook-ir = manifest = selectors = policy portalMap), commitEffect/effect enum(selectors = playbook-ir = manifest = remote-envelope)도 모두 같다.
- remote-envelope `type` enum 22종 = D08 §6 메시지 표 22종.
- 상대 링크는 깨진 것이 없다. 행 번호 참조는 `(R2:86)` 하나뿐이고 실제 위치와 맞다.
- 규칙 ID(V-01~24·V-03a~l·V-03c′·SV-01~06·BV-01~06·R-A1·R-C1~3·R-D1·R-G2·R-G6~8)는 참조된 것이 모두 정의되어 있다. V-20~24의 의미도 문서 간에 같다.
- D03 §7.1 `POLICY_FLOOR` 13개 항목은 policy.schema 범위와 모두 맞는다.
- 상충 해소표(D19 §4)의 정본 17개 중 14개는 모든 문서에서 지켜진다. 어긋나는 것은 dedup 삭제(D01 §5.1), query_agent→query_parse(D11 §2.1), 캐시 키 형식(gateway-request의 `:t:`)이다(아래 M10·M9·M7). 지켜지는 것: 커밋 구간 안 decide 금지, keep_session 0, 임시 데이터 위치, 덤프 업로드 금지, 타이핑 간격 주체, 처리 국가, 큐 72h, 프로필 종류, K_meta 삭제, 디바이스 플로우 삭제, 번들 앱 전용, 정책 72h, `/v1/wake`, 블롭 기기 범위 토큰.

---

## 1. Blocker

없음.

---

## 2. Major

| ID | 위치 | 문제 | 정정안 |
|---|---|---|---|
| M1 | `design/19-attack-surface.md:14`, `:16`, `:178`; `06-feasibility.md:120` | §1 요약 숫자가 같은 문서 §3 등록부와 다르다. 등록부 101행을 세면 심각도 Critical 1·**High 31·Medium 57·Low 12**이다(감사 원문 AUDIT-A/B/C 표의 심각도와 101건 모두 일치). 결정은 **채택 97·변형 3(B-11·C-13·C-27)·수용 1(C-34)**이다. §1은 High 36·Medium 51·Low 13, 채택 92·변형 7·수용 2라고 적었다. :178은 A-07(b)을 수용으로 세지만 :72 결정 열은 "채택"이다. 06 Q16도 "High 36"을 옮겨 적었다 | D19:14 → `| 발견 | 101건 (Critical 1, High 31, Medium 57, Low 12) |`. D19:16 → `| 처리 | 채택 97, 변형 채택 3, 수용 1(C-34), 기각 0. A-07은 (a) 채택·(b) Phase 3 재검토로 나뉜다 |`. D19:178 → `수용 1건: C-34(양자 이후, 전환 경로만 예약). A-07(b) 고수준 브로커는 채택 항목 안의 Phase 3 재검토로 둔다. 기각 0건.` 06:120 → `101건 중 Critical 1·High 31 전부 …` |
| M2 | `design/14-work-breakdown.md:89`, `:3`; `06-feasibility.md:118`; `design/19-attack-surface.md:297` | Phase 1 표(M1-1~M5-3) 공수 열의 합은 **175일**인데 본문은 "약 178 영업일(v1.2 165일 + 감사 반영 13일)"이라고 적었다. D19 §9가 나열한 증분(M1-3 +3, M1-8 +2~3, M4-2 +2, M4-7 +3)은 10~11일이라 +13과도 맞지 않는다. 06 Q14의 "+13일"도 같은 숫자를 따른다 | 표를 정본으로 삼아 D14:89 → `합계(대략): Phase 1 엔지니어 공수 약 **175 영업일**(v1.2 165일 + 감사 반영 10일) → 3인 × 12주(180일)에 여유가 거의 없다.`, D14:3 → `Phase 1 공수 +10일`, 06:118 → `감사 반영으로 공수 +10일`. 반대로 178이 맞다면 빠진 3일을 어느 행에 더할지 정하고 그 행 공수를 고친다 |
| M3 | `design/02-playbook-dsl.md:3`, `:254`~`:263` vs `design/13-testing.md:95` (`design/14-work-breakdown.md:85`) | 반례 번호가 충돌한다. D02는 CE-11 = 커밋 구간 안 `decide`, CE-12 = 후속 비가역 앞 `fill`로 정의하고 "CE-1~CE-12"라고 적었다. D13은 CE-11 = 커밋 랜드마크 `fieldKey` 누락 readback, CE-12 = `nameTemplate` 허용 밖 토큰, CE-13~16까지 둔다. D14 M5-1은 D13을 따라 "CE-7~16"이다 | D13 §7을 정본(CE-1~16)으로 하고 D02 §6.2 표에 행을 추가해 번호를 맞춘다: CE-11 커밋 랜드마크 `fieldKey` 누락 readback(V-03j), CE-12 `nameTemplate` 허용 밖 토큰(V-23), CE-13 `expectConfirm: ".*"`(V-24), CE-14 조회 하위 플레이북의 `decide`(V-22), CE-15 핫픽스의 `commits:true` 항목 변경(핫픽스 CI·R-A1), CE-16 정책 `gov24: auto`(내장 상한), **CE-17** 커밋 구간 안 `decide`(V-03c), **CE-18** 후속 비가역 앞 `fill`(V-03c′). D02:3·:254 → "CE-1~CE-18"로 고치고, D13 §7에도 CE-17·18을 더한다 |
| M4 | `design/07-data-model.md:128` vs `design/03-engine.md:70` | `gate_requests.state`가 다르다. D07 DDL은 `('open','approved','denied','expired','consumed')`이고, D03 §3은 "`pending→decided`로 바꾼다. 이미 `decided`이면 …"이라고 적었다 | D03:70 → `` `gate_requests(req_id PK, run_id, state, decided_by, decided_at)` 행을 승인 처리와 같은 트랜잭션에서 `open→approved|denied`로 바꾼다. 이미 `open`이 아니면 두 번째 결정은 무시하고 거부만 기록한다. 토큰을 소비하면 `consumed`, 대기가 끝나면 `expired`다. `req_id`당 토큰은 최대 1개다(DDL은 D07). `` |
| M5 | `design/03-engine.md:93` vs `design/09-cloud-services.md:163`, `:188`; `design/adr/ADR-013-registry-threshold-signing-transparency.md:22` | `status.json` 서명 주체가 다르다. D03 §3.1은 "2-of-3 서명"이다. D09 §8.2 표는 타임스탬프 온라인 키 1개 또는 1인 긴급 키로 서명한다고 적었다. ADR-013은 "(서명, …)"만 적었다. 클라이언트 검증 규칙이 정해지지 않는다 | 한쪽으로 정한다. 48시간 주기 신선도를 생각하면 D09 쪽이 현실적이다. D03:93 → `엔진은 /registry/status.json(타임스탬프 키 서명 또는 1인 긴급 키 서명, 만료 ≤ 48시간, 포털별 portalModeCeiling과 killPlaybooks[])을 받아 portalModeCeiling은 정책 위의 하향 전용 상한으로, killPlaybooks는 실행 거부로 적용한다. status는 하향·킬스위치만 표현할 수 있으므로 단일 키 서명을 허용한다.` ADR-013:22에도 `(타임스탬프 키 서명, 1인 긴급 키는 보수적 변경만)`을 넣는다 |
| M6 | `design/05-vault-secrets.md:182`, `:186` vs `design/08-remote-protocol.md:31`~`:49`, `:115`, `:132` | 금고 서명 용도 허용 목록과 D08 §2.1 컨텍스트 표가 다르다. (a) D05 `vdPurposes`에는 "`Kv` 배포 서명"이 있는데 D08 §2.1에는 그 컨텍스트 문자열이 없다. D08:31은 "모든 서명·MAC 입력은 아래 컨텍스트 문자열로 시작"이라고 했지만 `PAIR_OK`의 `Kv_pub(Vd 서명)`(:115)은 컨텍스트가 정해지지 않았다. (b) D08 §2.1 `SAX-rotate-v1`(`Vx`, PC 정적키 교체 :132)이 D05 `vdPurposes`에 없어 금고가 PC 쪽 rotate 서명을 거부하게 된다. (c) D05:182는 `vdPurposes`에 "봉투 서명"이 들어간다고 했지만 `SAX-env-v1`의 서명 키는 `Vm`(폰)뿐이다 | D08 §2.1 표에 행 추가: `| SAX-kv-v1 | Vd | 금고 비밀 봉인 키 Kv_pub 배포·연 1회 회전(PAIR_OK·HELLO, D05 §5) |`. D05:186 → `vdPurposes = {SAX-qbundle-v1, SAX-ckpt-v1, SAX-docrec-v1, SAX-consent-v1(로컬), SAX-dpop-v1, SAX-rotate-v1, SAX-kv-v1}`. D05:182 괄호 → `(Kv 배포, 우편함 번들, 감사 체크포인트, 인덱스 레코드 서명, 정적키 교체 등)` |
| M7 | `design/schemas/gateway-request.schema.json:5` (description 규칙 (4)) vs `design/04-model-layer.md:63`, `design/19-attack-surface.md:186` | 캐시 키 형식이 다르다. 규범 스키마는 `'acct:' + HMAC + ':b:' + bundleId (or ':t:' + toolset)`이다. D04 정본은 "Terra 호출은 같은 형식에서 `<bundleId>` 자리에 툴셋 ID를 쓴다", 곧 `:b:<toolset>`이다. D19 §4 정본은 `acct:<HMAC>:b:<bundleId>` 하나다 | 하나로 맞춘다. 네임스페이스를 나누는 편이 안전하므로 D04:63 → `` Terra 호출은 `acct:<HMAC(server_secret, accountId)>:t:<toolsetId>`를 쓴다. `` D19:186 정본 → `` 계정 격리 `acct:<HMAC>:b:<bundleId>`(Decisions)·`acct:<HMAC>:t:<toolsetId>`(Terra) ``. D09:88에도 같은 괄호를 붙인다 |
| M8 | `design/schemas/intent-envelope.schema.json:53`~`:62` vs `design/02-playbook-dsl.md:101`~`:106`, `design/08-remote-protocol.md:189` | `inputValue`가 문자열·숫자·불리언·null·`{counterpartyRef}`·스칼라 배열만 허용한다. H-01의 `amounts`(객체)와 `items`(`line_items`, 객체 배열)는 실을 수 없다. D08 §7은 "inputs는 해당 플레이북 입력 스키마를 따른다"고 했으므로, 지금 스키마대로면 대표 플레이북 H-01을 오프라인 큐로 예약할 수 없다 | `inputValue.anyOf`에 두 가지를 추가한다: `{"type":"object","maxProperties":8,"propertyNames":{"pattern":"^[a-z][A-Za-z0-9]{0,31}$"},"additionalProperties":{"type":["string","number","boolean","null"],"maxLength":200}}`, 그리고 같은 객체를 원소로 갖는 `{"type":"array","maxItems":20,"items":{…}}`. 비밀 필드 금지(`x-secret`)는 플레이북 입력 스키마 검사에서 그대로 집행한다 |
| M9 | `design/11-security.md:67` | Rule of Two 표의 조회 에이전트 행이 "`intent_route_v1` + 서버 결정적 조회"로 되어 있다. D04 §1·§4와 D09 §7은 조회 질문 해석을 Terra 툴셋 `query_parse`로 정했다(D19 §4 query_agent→query_parse) | D11:67 → `` | 조회 에이전트(`query_parse` + 서버 결정적 조회) | 사용자 질문 | 없음(행은 모델에 가지 않음) | 없음 | `query_kind` 열거·열거형 파라미터만, 템플릿 응답만 | `` |
| M10 | `design/01-system-architecture.md:114` | 대표 시퀀스에 `metadata.upsert(doc_type, issued_at, hash_token)`이 남아 있다. D07 §5·D09 §6은 dedup 토큰을 삭제했고 발급일을 월 단위(`issued_month`)로 바꿨으며 레코드에 `Vd` 서명·`rev`를 둔다 | D01:114 → `main → cloud: metadata.put(doc_id, slot_token, doc_type?, issued_month?, expires_on?, blob_id, wdek, kek_ver, rev, sig) / blob.put(E2EE)   # 옵션, doc_type 옵트인 꺼짐이면 doc_keys만` |
| M11 | `README.md:38`, `03-architecture.md:116`, `03-architecture.md:149`, `design/adr/ADR-009-gateway-metering-byok.md:12` | 계량 보존이 D09 §3·§10(C-23 채택안)과 다르다. D09: 결제 레코드(월, 회계 보존) / 호출 단위 계정 연결 레코드 **35일** / 운영 통계(계정·기기 ID 없음) 13개월. README·03은 "호출 단위 90일 → 일 집계 13개월", ADR-009 결정은 "호출 단위 활동 기록 … 보존 13개월"이다. 대외 고지 문구로 쓰일 수 있는 문장이라 영향이 크다 | README:38 괄호 → `(결제 레코드는 월 단위, 호출 단위 계정 연결 레코드는 35일, 운영 통계는 계정 비연결로 13개월)`. 03:116 → `` 게이트웨이는 본문 무저장이며 계량을 셋으로 나눈다: 결제 레코드(월 단위), 호출 단위 계정 연결 레코드(35일, 결제 대사), 운영 통계(계정·기기 ID 없음, 13개월). ``. 03:149 셀 → `결제 레코드 월 단위 · 호출 단위 계정 연결 35일 · 운영 통계(비연결) 13개월`. ADR-009:12 → `계량은 결제 레코드(월 단위)·호출 단위 계정 연결 레코드(35일)·운영 통계(계정 비연결, 13개월)로 나눈다(D09 §3, C-23). '토큰 수만'이라고 말하지 않고 항목·보존을 처리방침에 적는다.` |
| M12 | `02-product-spec.md:91` | PC가 꺼진 상황(§8)에서 "모델에게 본문을 보내야 하는 요약 요청은 사용자가 그 자리에서 허용할 때만, 마스킹 후 전송"이라고 적었다. D09 §7(C-10 채택)은 "본문 요약은 PC가 켜져 있을 때 PC의 마스킹 계층을 거쳐서만, PC가 꺼져 있으면 제공하지 않는다"이다. 폰에는 마스킹 계층이 없다 | 02:91 둘째 문장 → `본문 요약은 PC가 켜져 있을 때 PC의 마스킹 계층(사용자 사전 포함)을 거쳐서만, 사용자가 그 자리에서 허용할 때 한다. PC가 꺼져 있으면 요약하지 않는다(설계 D09 §7).` |
| M13 | `design/02-playbook-dsl.md:32` | "스키마 파일 8종"이라고 적고 `intent-envelope`를 빠뜨렸다. 저장소·README:30·D15 F-01은 9종이다 | D02:32 → `` 스키마 파일 9종이 저장소에 있다(v1.3): `playbook-ir`, `manifest`, `selectors`, `hotfix`, `bundle`, `policy`, `gateway-request`, `remote-envelope`, `intent-envelope`. 앞의 7종은 M1-4 착수 전, 리모트 2종은 Phase 2 착수 전에 동결한다. `` |
| M14 | `design/16-error-taxonomy.md:66` | "보안 이벤트는 다음뿐이다" 목록에 같은 표에서 **보안 이벤트**로 표시한 4개가 빠졌다: `vault.crypto_rate_anomaly`(:52), `postprocess.open_denied`(:53), `pairing.aik_mismatch`(:54), `registry.head_mismatch`(:58) | D16:66 목록 끝에 `` `vault.crypto_rate_anomaly`, `postprocess.open_denied`, `pairing.aik_mismatch`, `registry.head_mismatch` ``를 추가한다 |
| M15 | `design/02-playbook-dsl.md:168` (등록부 A-06 "반영 D02 §4.3") | D02 §4.3 의사 동작에 `human:secret`이 "같은 위치의 합성 `human` 노드"로만 남아 있다. D02 전체에 "비밀 창"이라는 말이 없다. D05:88은 "금고 경유 합성 노드(D02 §4.3 교차 정정)"라고 요청했지만 D02는 고쳐지지 않았다 | D02:168의 해당 구절 → `` `human:secret` → 같은 위치의 **금고 경유 합성 노드**(금고가 비밀 창 (b)를 열고 엔진은 `secret_window.closed{ok}`만 받는다, D05 §3.5) → 원래 다음 스텝. `` |

---

## 3. Minor

### 3.1 등록부 ↔ 본문 (항목 1)

스크립트 결과: 101행의 반영 참조 208개 중 185개는 해당 문서(절이 지정된 경우 해당 절)에 근거 ID가 있다. 나머지 23개는 손으로 확인했다. 그중 16개는 ID 표기 없이 내용만 있다(A-12 D01 §2, A-13 D07 §1, A-14 D01 §2, A-30 D08 §4, B-01 D02 §2.1, B-02·B-05·B-12·B-25 playbook-ir, B-04 D07 DDL, B-28 기획 03:179, C-05 D01 §2.2, C-08 D09 §10, C-12 D08 §3, C-21 D11 §8, C-27 ADR-015:36, C-29 D11 §8·기획 03:121, B-14 D04 §2(§3 아님)). 정상으로 본다. 없거나 일부만 있거나 다른 곳에 있는 것은 다음과 같다.

| ID | 위치 | 문제 | 정정안 |
|---|---|---|---|
| m1 | 등록부 A-03 → `design/adr/ADR-005-vault-typist.md` | ADR-005 v3에 "커밋 가드를 금고 중계로 옮김(Phase 2), 무장 근거는 승인 서명"이 없다. 내용은 D03 §1, D05 §3.3에만 있다 | ADR-005 결정 5 뒤에 `10. **커밋 가드 금고 이전(Phase 2)**: 커밋 엔드포인트 Fetch 인터셉트를 금고 중계로 옮기고, 금고가 폰 Sign_Vm 또는 main 승인 창의 LocalApproval을 직접 검증해 근거 하나당 요청 1회를 집행한다. 본문 대조는 못 하므로 승인 없는 발급 횟수만 제한한다(A-03, D05 §3.3).`를 더한다 |
| m2 | 등록부 A-21 → `design/12-observability-ops.md` §5 | D12 §5(진단 내보내기)에 로그 14일 보존·내보내기 전 누출 스캐너가 없다. D05 §8, D11 §4에만 있다 | D12:59 끝에 `내보내기 전에 누출 스캐너 규칙(테스트 패턴 + 인코딩 변형)을 로컬에서 실행하고, 로그는 14일만 보존한다(A-21, D05 §8).`을 더한다 |
| m3 | 등록부 B-03 → `design/11-security.md:43` (T4) | "본문 암호화 시 화면≠제출 탐지 불가" 잔여 위험이 T1에만 있고 T4에는 없다. D03:167도 "D11 T1·T4"라고 적었다 | D19:105 반영 열을 `D03 §5.4, D11 T1`로 줄이거나, T4 잔여 위험 칸에 `커밋 요청 본문이 암호화되면 R-C1이 불가(D03 §5.4)`를 더한다 |
| m4 | 등록부 C-29 → `design/09-cloud-services.md:240` (§10) | 보존(최대 30일 + 법적 보존)은 있지만 처리 국가 미국·EU·UAE가 없다 | D09:240 보존 칸 → `최대 30일(공급사 남용 모니터링) + 법적 보존 의무 시 연장. 처리 국가 미국·EU·UAE(C-29, SP-7)` |
| m5 | 등록부 C-32 → "기획 02 §13" | 해당 문구는 02 §9(:103)에 있다 | D19:174 반영 열 → `기획 02 §9, D09 §2` |
| m6 | 등록부 A-31 → "D11 §1·§4"; `design/19-attack-surface.md:38` | 위협 주체 표는 D11 §0에 있다. D19 §2는 "D11 §1 앞에 같은 표"라고 했지만 D11 §0에는 P4·P5·P6 행이 없다 | D19:96 → `D11 §0·§4`. D11 §0 표에 D19 §2의 P4(변조 클라이언트)·P5(페이지·DOM 조작자)·P6(페어링된 폰의 버그·악성 앱) 세 행을 그대로 옮긴다 |
| m7 | 등록부 B-24 → `design/19-attack-surface.md:126` | "fieldKey → 앱 내장 라벨, V-24"로 되어 있다. D02에서 라벨은 V-03h, V-24는 `expectConfirm` 앵커다 | `채택: fieldKey → 앱 내장 라벨(V-03h), expectConfirm 앵커(V-24)` |
| m8 | 등록부 A-27 → `design/05-vault-secrets.md:98` | "D07 DDL의 `DEFAULT 1`은 `DEFAULT 0`으로 정정한다(교차 요청)"가 남아 있다. D07:60은 이미 0이다 | `` `keep_session` 기본값은 꺼짐(0)이다(사용자가 켤 수 있음, D07 DDL `DEFAULT 0`, 감사 A C-01). `` |
| m9 | `design/19-attack-surface.md:208` | 상충표 "`assisted` 의미 → D02 §8"인데 해당 본문은 D02 §9(:366)에 있다 | `D02 §9` |
| m10 | `design/19-attack-surface.md:263` vs `design/14-work-breakdown.md:16` | D19 §7은 S6m을 P0-1에 배정했는데 D14 P0-6이 "S6b~S6m(…BitLocker)"를 모두 포함한다 | D14 P0-1 산출물에 `S6m(비관리자 BitLocker 읽기·보조 볼륨 ACL)`을 넣고 P0-6은 `S6b~S6l`로 고친다. 또는 D19 표를 `P0-6(h~m)`으로 고친다 |

### 3.2 문서 간 상충 (항목 2)

| ID | 위치 | 문제 | 정정안 |
|---|---|---|---|
| m11 | `design/05-vault-secrets.md:71` vs `design/07-data-model.md:12`, `:286` | staging 파일 삭제 시점이 다르다: D05는 "보관함으로 옮기고 24시간 뒤 삭제", D07은 "옮긴 즉시 삭제, 기동 시 잔존 정리" | D05:71 끝 → `보관함으로 옮긴 즉시 삭제하고, 기동 시 잔존 파일을 정리한다(D07 §1).` |
| m12 | `design/07-data-model.md:283` vs `design/05-vault-secrets.md:214`, `design/11-security.md:96` | 엔진·main 덤프: D07은 "생성은 허용", D05·D11은 "로컬 생성도 사용자 요청 시에만" | D07:283 → `엔진·메인 크래시 덤프: 로컬 생성은 사용자 요청 시에만, 업로드 금지(DB 키·토큰·PII 포함 가능). 금고는 덤프 비활성(D05 §8).` |
| m13 | `design/04-model-layer.md:161` vs `design/03-engine.md:198` | `propose_selectors` 드라이런이 "동일성 8항"이라고 되어 있다. D03 §6·D16:37은 10항이다 | `(드라이런: 엔진이 D03 §6 동일성 검사 10항을 돌리되 적용하지 않음)` |
| m14 | `design/09-cloud-services.md:85` vs `design/04-model-layer.md:240`, `design/06-redaction.md:67` | Phase 1 이미지 거부 범위: D09는 `/v1/respond`만, D04·D06은 `/v1/respond`·`/v1/decide` 모두 | D09:85 → `Phase 1에서는 /v1/decide·/v1/respond의 이미지 입력을 모두 400으로 거부한다` |
| m15 | `design/01-system-architecture.md:152`, `design/02-playbook-dsl.md:26` vs `design/09-cloud-services.md:167` | "핀 고정 레지스트리 키 3개"라고 했지만 D09 §8.2는 루트 3 + 패키지 3 + 정책 3(+타임스탬프·긴급 키)을 핀 고정한다 | D01:152 → `릴레이 주소·레지스트리 공개키(루트 3, 패키지 3, 정책 3, 타임스탬프·긴급 각 1)·fieldKey 라벨 사전은 앱에 핀 고정.` D02:26 → `앱에 핀 고정된 패키지 서명 키 3개 중 …` |
| m16 | `design/03-engine.md:76` vs `design/schemas/remote-envelope.schema.json` gate.request | D03은 `fields[{fieldKey, value}]`, 스키마·D08:161은 `fields[{key, value}]` | D03:76 → `fields[{key: fieldKey, value}]` |
| m17 | `design/08-remote-protocol.md:157` vs remote-envelope `devlist.push` | D08 본문은 `{deviceList, listVersion}`, 스키마는 `{deviceList}`(버전은 `deviceList.listVersion` 안) | D08:157 body → `{deviceList}` (`listVersion`은 `deviceList` 안) |
| m18 | `design/08-remote-protocol.md:165` vs remote-envelope `human.request` | 스키마는 captcha일 때 `imageSha256`을 필수로 요구하는데 D08 표에 그 필드가 없다 | D08:165 body에 `imageSha256?(captcha 필수)` 추가 |
| m19 | `design/schemas/remote-envelope.schema.json` gate.request `allOf` | `effects`가 선택 필드여서 생략하면 `requiredSigAlg = p256` 강제가 걸리지 않는다. `cardHashInputs.authorizes maxItems 8`은 V-03i(≤ 3)보다 느슨하다 | `"if":{"properties":{"gateKind":{"const":"commit"}}},"then":{"required":["effects"]}`를 추가하고 `authorizes`를 `maxItems: 3`으로 맞춘다 |
| m20 | `design/04-model-layer.md:21`~`:26` vs `design/schemas/gateway-request.schema.json` | D04 `RespondRequest.runToken?`은 선택인데 규범 스키마는 필수다(실행 밖 호출은 `chatSessionId`별 runToken). `chatSessionId` 필드와 `replay` 항목 모양(`kind`/`callId` vs `tag`/`call_id`)도 와이어와 다르다. 클라이언트 내부 타입인지 표시가 없다 | D04:21 → `runToken: RunToken;   // 실행 밖 호출은 chatSessionId별로 게이트웨이가 발급한 runToken`, :17 위에 `// 클라이언트 내부 타입. 와이어 형식은 gateway-request.schema.json(어댑터가 변환)` 주석 추가 |
| m21 | `design/07-data-model.md:115`~`:123` vs `design/03-engine.md:17`, `:36` | 원장 DDL에 `playbook_id`·종결 사유 칼럼이 없다. D03은 "`playbook_id`가 다르면 거부", "원장 `not_committed`(사유 `pre_dispatch_mismatch`·`identity_mismatch`)"라고 적었다 | DDL에 `playbook_id TEXT NOT NULL,`·`reason TEXT,`를 추가하거나, D03에 "playbook_id는 `runs` 조인으로, 사유는 저널 `step.*` 이벤트로"라고 명시한다 |
| m22 | `design/07-data-model.md:72` | 칼럼 이름 `remote_approved_at`인데 주석은 "로컬에서 한 번이라도 승인된 거래처"이다(D08:177도 이 이름을 씀). 의미가 거꾸로 읽힌다 | `local_approved_at`으로 개명하고 D08:177도 같이 고친다 |
| m23 | `design/16-error-taxonomy.md:30`, `:45` | 코드와 메시지 키·예약 결과 이름이 다르다: `commit_guard.blocked_request` ↔ `err.commit_guard.blocked`, `portal.logged_out_other_session` ↔ 예약 결과 `logged_out_by_other_session`(D02·D04) | 메시지 키 → `err.commit_guard.blocked_request`, 코드 → `logged_out_by_other_session` |
| m24 | `design/03-engine.md:282` | "ADR-005 v2"라고 적었다(현행 v3) | `(ADR-005 v3, D05 §3)` |
| m25 | `design/00-overview.md:69` | R9 설계 요소가 "D03 §6 사람 속도 정책"인데 D03 §6은 복구 계층이고 요청률 정책은 §7이다 | `D03 §7 요청률 정책` |
| m26 | `design/13-testing.md:96`; `design/02-playbook-dsl.md:265` | D13은 "H-01 v2(D02 §8)"라고 했지만 현행은 v2.1이다. D02:265는 핫픽스 반례가 "R-A1 회귀(D13 §8)"에 있다고 했지만 D13 §8에는 없고 §7 CE-15에 있다 | D13:96 → `H-01 v2.1(D02 §8)`. D02:265 → `… 핫픽스 CI의 SV-01과 D13 §7 CE-15(런타임 R-A1 회귀)로 고정한다.` |
| m27 | `design/17-postprocess-mode.md:46` vs `design/13-testing.md:51` | docparse `extract` 옵션은 `maxPages: 5`인데 S13b 통과 기준은 "50쪽 ≤ 30초"다 | S13b를 `5쪽 ≤ 3초(작업당), 50쪽 문서는 앞 5쪽만`으로 맞추거나 `maxPages` 상한을 문서화된 값으로 올린다 |
| m28 | `design/17-postprocess-mode.md:31` | 다른 문서에 없는 용어 "대행 모드"를 쓴다(운영 수준은 `auto`/`assisted`/`postprocess`) | `` `auto`·`assisted` 모드에서 금고가 정한 다운로드·인쇄 경로 `` |
| m29 | `design/schemas/intent-envelope.schema.json:43` | `inputs` 주석이 "installed playbook's input schema (manifest inputs)"인데 manifest 스키마에는 `inputs`가 없다(IR `inputs`) | `(playbook IR inputs)` |
| m30 | `design/02-playbook-dsl.md:156` vs `playbook-ir.schema.json` `$defs.cond` | §4.1 조건식 목록에 스키마가 허용하는 `inputVerified`·`profileHas`·`artifact`가 없다(H-01이 이 셋을 쓴다) | §4.1 열거에 `` {inputVerified}, {profileHas}, {artifact} ``(전제·사후조건 전용)를 추가 |
| m31 | `03-architecture.md:155` (§8 4단계), `04-roadmap.md:24`, `06-feasibility.md:94` | 기획 요약이 v1.3을 다 따라오지 않았다: 승인을 "기기 키로 서명"으로만 적었고(비가역은 하드웨어 P-256), S6/G1 조건이 "엔진 중계 CDP"로만 되어 있다(허용 목록·비밀 창, ADR-005는 S6b~f 조건부) | 03:155 → `… 폰은 생체 인증 뒤 서명한 승인을 보낸다(비가역은 SE/StrongBox P-256 하드웨어 키만).` 04:24·06:94 → `금고 소유 파이프 + 기본 거부 허용 목록 중계 + 비밀 창 동작(S6·S6b~S6f)` |

### 3.3 스키마 (항목 3)

| ID | 위치 | 문제 | 정정안 |
|---|---|---|---|
| m32 | `design/schemas/manifest.schema.json` `bundlesUsed.items.id` (`^[a-z_]+$` + `ver`) vs playbook-ir `decide.bundle` (`^[a-z_]+_v\d+$`) | IR은 `screen_state_v2`, manifest·bundle 스키마는 `id: screen_state, ver: 2`다. 이 대응 규칙이 어느 문서에도 없다 | D02 §2 `bundlesUsed` 설명에 `IR의 decide.bundle = "<id>_v<ver>"이며 manifest·bundle 정의는 id와 ver를 나눠 적는다`를 추가 |
| m33 | `design/schemas/bundle.schema.json` `questions.choices.maxItems: 255` vs `design/04-model-layer.md:32` | D04는 System One 호환을 위해 choice ≤ 26을 정적으로 검증한다고 했는데 스키마는 255다(번들 CI가 대신 검사한다고는 적혀 있다) | 스키마 `maxItems: 26`으로 조여 CI와 스키마를 한 곳에서 집행한다(선택) |

### 3.4 문장 품질 (항목 4)

| ID | 위치 | 문제 | 정정안 |
|---|---|---|---|
| m34 | `design/00-overview.md:19`, `:69`, `:87`; `design/11-security.md:129`; `design/13-testing.md:12`; `design/14-work-breakdown.md:20`; `design/adr/ADR-011-portal-mode-gov24-postprocess.md:12`, `:16` | D11 §8 점검표가 금지한 "사람 속도"를 쓴다(D03:239도 문서·UI에서 쓰지 말라고 했다) | 모두 `요청률 상한`(예: D14:20 `S8 요청률 상한 정책 연속 50회`, D11:129 `본인 권한 접근, 요청률 상한, 공문`)으로 바꾼다 |
| m35 | `design/07-data-model.md:49` | "확인 필요(A 스파이크)"에 스파이크 ID가 없다 | `확인 필요(S6m)` |
| m36 | `design/08-remote-protocol.md:93` | "(확인 필요)"에 ID가 없다(같은 단락이 SP-1이긴 하다) | `(확인 필요, SP-1)` |
| m37 | `design/02-playbook-dsl.md:236`, `:274`; `design/03-engine.md:46`, `:103`; `design/11-security.md:93` | 표 칸 안 코드에 이스케이프되지 않은 `|`가 있어 GFM에서 칸이 갈라진다(헤더 2·4칸, 행 3·14·6·3·4칸) | `secret\|otp`, `/발급\|제출\|…/`, `armed\|dispatched\|observed_manual`, `pre_commit\|post_commit`, `'userData'\|'logs'\|'crashDumps'`로 이스케이프 |
| m38 | `design/05-vault-secrets.md:212` | 오타 "이 사본은 영화할 수 없고" | `이 사본은 0으로 덮을 수 없고` |
| m39 | `design/11-security.md:51` | "요청률 상한, 상한," 중복 | `요청률 상한, 차단 신호(…)` |
| m40 | `design/01-system-architecture.md:111`; `:80`; `design/12-observability-ops.md:42` | D01 코드 블록 안의 `B₁ \\ B₀`가 백슬래시 두 개로 그대로 보인다. D01 §2.4가 §3 뒤에 있고, D12 "### 3.4"는 3.1~3.3 없이 나온다 | `B₁ \ B₀`. D01 §2.4를 §3 앞으로 옮기거나 §3.1로 바꾼다. D12 → `### 3.1 L2 제안의 집계` |
| m41 | 머리 버전 표기: `design/15-week1-artifacts.md:3`, `design/18-test-environment-plan.md:1`, `design/adr/ADR-011-…:3`, `design/adr/README.md` | D15는 v1.3 내용(스키마 9종, F-13·F-14)인데 머리에 v1.3 표기가 없다. D18도 없다. ADR-011은 본문에 v1.3 개정이 있는데 상태 줄에는 없다. adr/README는 ADR-006·007에만 "(v1.3 개정)"을 붙이고 001·002·003·005·009·011에는 붙이지 않았다. 012·013·014 상태도 파일의 조건부 표기와 다르다(013 파일은 SP-4·6·S18 조건부, 014는 S13b, 012는 조건 항목 있음). ADR-005 제목이 파일 제목과 다르다. ID 표기 체계도 문서마다 다르다(D07 `A-C-nn/B-C-nn/X-nn`, D04 "감사 B C-17", D02·D03·schemas는 맨 `C-03`·`C-04`처럼 써서 감사 C 발견 ID와 겹친다) | D15:3 끝에 `· v1.3(D19 반영)`, D18 제목 아래 `> v1.3 — 변경 없음(2026-10-28 확인)`, ADR-011:3 → `상태: 채택 · 2026-10-28 · 개정 메모 v1.3(결정 첫 항목·결과)`. adr/README 상태 열에 001·002·003·005·009·011 `(v1.3 개정)`을 붙이고, 012 `채택(조건 항목 있음)`, 013 `채택(SP-4·SP-6·S18 조건부, 투명성 로그 강제는 Phase 2)`, 014 `채택(S13b 조건부)`로 바꾼다. 상충 ID는 D07 머리 규칙(`B-C-03`, `A-C-04`)으로 통일한다. 예: D02:12·:134·:219·:262, D03:147·:153, ADR-002:25, bundle.schema description |

### 3.5 기획 ↔ 설계 (항목 5)

| 항목 | 결과 |
|---|---|
| 공수 178일 | 기획에는 "178"이 없다. 06 Q14 "+13일"은 D14 본문과 같지만 D14 표 합(175, +10)과는 다르다 → M2 |
| ADR 16건 | README:30 = D00:36 = 실제 파일 16개, 일치 |
| 스키마 9종 | README:30 = D15 F-01 = 실제 9개. D02:32만 8종 → M13 |
| D19 존재 | README:31, D00:35, 04:7(G0 ⑤), 06 Q16에서 참조, 파일 존재 |
| Q15·Q16 | 06:119~120에 있다. Q16의 "High 36"은 등록부(31)와 다르다 → M1 |
| G0 ⑤ | 04:7에 있다(공격표면 감사 반영본 확정 + Upstage 베타 신청) |
| 기타 | README:38·03:116·03:149 계량 보존 → M11, 02:91 요약 경로 → M12, 03 §8·04 S6·06 G1 표현 → m31 |

---

## 4. 참고: 근거 명령

- 등록부 집계: `python3`로 `design/19-attack-surface.md`에서 `^\| [ABC]-\d\d \|` 행 101개를 읽어 심각도·결정 열을 셌다. 감사 원문 3개 표의 심각도와 101건 모두 같다.
- 등록부 대조 스크립트: `/private/tmp/claude-501/-Users-kibum-Documents-tex/beea5966-caf5-44db-b739-c4d6dbf950f7/scratchpad/review/reg.py`(결과 `reg.json`).
- 스키마 검증기: `/private/tmp/claude-501/-Users-kibum-Documents-tex/beea5966-caf5-44db-b739-c4d6dbf950f7/scratchpad/review/miniv.py`. H-01 오류 0건. 확인용으로 넣은 변형(미정의 필드, authorizes 4개, 타깃 없는 `press Enter`)은 모두 오류로 잡혔다.
- D14 합계: P0 행 합 46일, M 행 합 175일.
- 상충 건수: AUDIT-A C-xx 14, AUDIT-B C-xx 24, AUDIT-C X-xx 24로 D19 §1의 62건과 같다.
