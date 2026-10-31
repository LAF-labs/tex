# D01. 시스템 아키텍처

> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, [D19](19-attack-surface.md)) 반영.

## 1. 컨텍스트 (C4 L1)

```text
 사용자(대표/경영지원) ──사용──▶ [데스크톱 하네스] ──조작──▶ 홈택스 / 정부24 / SMINFO / 4대보험센터
        │                           │  ▲
        │ 승인·지시·조회             │  │ 암호문 메시지 (릴레이 경유)
        ▼                           ▼  │
   [모바일 앱] ◀──────────────▶ [클라우드: 계정·게이트웨이·릴레이·블롭·메타데이터·레지스트리]
                                        │ 마스킹된 프롬프트만
                                        ▼
                                  모델 공급사 (현재 OpenAI Decisions / Responses · 어댑터로 교체 가능, ADR-015)
   거래처 사업자번호 검증 ──────▶ 공공데이터포털 국세청 진위확인 API (서비스 키 필요 → 게이트웨이 프록시 또는 BYO 키, D09 §4.1)
```

## 2. 컨테이너와 프로세스 모델 (C4 L2)

### 2.1 데스크톱 하네스 (Electron)

| 프로세스 | 역할 | 권한 | 네트워크 |
|---|---|---|---|
| `main` | 앱 수명주기, 창 관리, 스케줄러(데몬; DB 키 없음, 엔진의 읽기 전용 질의 IPC 사용), IPC 라우터, 업데이트, **로컬 비가역 승인 바(메인 창에 붙이는 main 소유 `WebContentsView`) 생성·배치와 실제 입력 관찰**(ADR-021) | 전체 | 업데이트 서버, 클라우드 API(계정·메타데이터·블롭 업로드) |
| `renderer` (sandbox, contextIsolation) | UI. 작업 카드, 대화창, 확인 카드, 감사 로그 뷰 | 없음(프리로드 API만) | 없음(직접 fetch 금지, CSP `connect-src 'none'`) |
| `engine` (utilityProcess) | 플레이북 해석·실행, **금고가 중계하는 기본 거부 허용 목록 CDP**(실행 단위 page 세션만, 브라우저 타깃 없음)로 Chrome 제어, 마스킹, 모델 호출 조립. DB의 유일한 소유자(main·렌더러는 읽기 전용 IPC 질의) | 파일: 보관함·staging 쓰기, DB 읽기/쓰기 | **오직 `net/egress` 모듈을 통해** 게이트웨이·릴레이. 장기 키 연산은 금고에 위임 |
| `docparse` (**Chromium 렌더러 샌드박스**: 숨김 `BrowserWindow`, `sandbox`·`contextIsolation`, 네트워크 차단 세션 파티션, ADR-014) | PDF 텍스트 추출·OCR(비신뢰 파일), NPKI `signCert.der` 파싱 | 입력은 바이트, 출력은 JSON Schema 검증 `{text, pages, hasTextLayer}` | 없음(OS 수준 샌드박스) |
| `vault` (utilityProcess, 별도; Phase 2 Rust 별도 실행 파일) | 비밀 저장·복호화(등급 2종), **Chrome 파이프 소유자**, 엔진에 **허용 목록 중계 CDP** 제공(요청 바디·접근성 값·스크린샷 정리, origin 재집행), **비밀 창**·**비밀 타이피스트**, 장기 키 연산(`noiseDH`·`signVd`·`hpkeOpen`), 전용 프로필 설정·확장 점검 | OS 키체인, `sodium_malloc`·WER 제외 | 없음(코드 수준 아웃바운드 금지, OS 경계 아님) |
| `chrome` (사용자 설치 Chrome, 전용 프로필, 최소 플래그 모드) | 포털 세션(`auto`·`assisted`만). 금고가 인자 없는 `launch()`로 내장 프로필 경로·플래그 허용 목록(`--remote-debugging-pipe`, `--user-data-dir`, `--no-first-run`)만으로 기동, `--remote-debugging-port` 금지, `--no-sandbox`·`--disable-extensions` 없음. 프로필 `Preferences`로 비밀번호 저장·자동완성 끔(엔터프라이즈 정책 미사용), 설치 확장은 내장 허용 목록과 대조. `navigator.webdriver=true`는 그대로(ADR-010). `postprocess` 포털은 이 Chrome이 아니라 사용자 기본 브라우저 | 사용자 권한 | 엔진이 `manifest.domains ∩ 내장 eTLD+1`로 이동을 감시하고 **금고가 문서 커밋마다 재집행**(벗어나면 엔진 세션 분리) |

프로세스 간 통신은 Electron `MessagePort` 기반 IPC. 모든 메시지는 타입드 스키마(`ipc/*.schema.json`)로 검증한다. `renderer`는 `engine`·`vault`와 직접 통신하지 않고 `main`이 중계한다. main↔엔진 포트는 둘로 나눈다(ADR-021). **중계 포트**는 렌더러 명령을 엔진에 넘기고, **main 전용 포트**는 승인 바가 발급한 `LocalApproval`·`LocalAttestation`(`answerGate`·`attestNotCommitted`)만 나른다. 엔진은 중계 포트로 온 승인·증언을 거부한다.

### 2.2 모바일 앱 (React Native/Expo)

| 모듈 | 역할 |
|---|---|
| `pairing` | QR 스캔(앱 내 스캐너만), Noise XX 핸드셰이크, AIK 서명 기기 목록·계정 AIK 대조, 장기 키 보관(X25519·Ed25519 키는 SE/StrongBox가 보호하는 래핑 키로 암호화해 `ThisDeviceOnly` 저장, 백업 제외; 비가역 승인 키 `Px`만 SE/StrongBox P-256) |
| `remote` | 명령 전송, 승인 카드(readback 값, `fieldKey` 앱 라벨, `cardHash` 재계산), 하드웨어 키 승인(비가역)·소프트웨어 키 승인(시작 동의·조회), 캡차·비밀 입력 중계, 진행 이벤트 수신 |
| `vaultview` | E2EE 블롭 내려받아 복호화·열람, 폰으로 받은 PDF 공유 |
| `query` | 클라우드 조회 에이전트 UI(질문만 전송, 메타데이터 행은 서버가 조회), 본문 요약은 PC 켜짐 + PC 마스킹 경유만 |
| `notify` | 내용 없는 푸시 수신 → 앱이 릴레이에서 암호문 fetch |

### 2.3 클라우드 (D09 상세)

| 서비스 | 저장하는 것 | 저장하지 않는 것 |
|---|---|---|
| Accounts/Billing | 이메일, 구독 상태, 슬롯 수(≤2)와 사업자 프로필 HMAC(있으면 "사업자 보유"만 앎), 기기 등록(공개키, AIK 서명 목록), 계정 `AIK_pub` | 비밀번호 외 비밀, 사업자번호 평문, 프로필 종류 |
| Gateway | 계량 레코드(계정 연결은 35일, 운영 통계는 비연결), 번들 ID, 플레이북 ID, 지연, 모델 | 프롬프트·응답 본문(처리 중 메모리 체류만) |
| Relay | 우편함 ID, 의도 봉투 암호문 큐(≤72시간, ≤5건), 크기 버킷·시각, 접속 IP 해시(일 회전) | 평문, 키. 단 운영자는 연결 시점·IP 상관으로 계정↔우편함을 이을 수 있다 |
| Blob Store | 암호문 블롭(Padmé 패딩), blob_id, 패딩 후 크기 | 복호화 키, 파일명 |
| Metadata Index | 문서 종류(doc_type별 옵트인), 발급 월, 만료일, 무작위 슬롯 토큰, wDEK(키 객체), `Vd` 서명·`rev` | 상호·사업자번호·주민번호·금액·파일명·정확한 크기·초 단위 시각·dedup 토큰 |
| Playbook Registry | 2-of-3 서명된 IR 패키지·핫픽스·운영 정책, 채널(stable/beta/hotfix), `status.json`(48h), 투명성 로그(Phase 2), 폐기 목록 | — |
| Query Agent | 세션 없는 질의 처리(질문 → `query_kind` 열거 → 서버 결정적 조회 → 템플릿) | 대화 로그 본문, 모델로 가는 메타데이터 행 |

### 2.4 포털별 운영 수준

엔진은 서명된 운영 정책의 `portalMode`에 따라 세 수준으로 동작한다(기획 05 문서 §7). `postprocess`에서는 브라우저 자동화를 전혀 하지 않고(접근성 트리 수집 포함) 안내 패널·파일 감시·메타데이터·만료 추적만 수행한다. `assisted`는 로그인 후 비식별 입력 자동 채움과 화면 판정까지, `auto`는 플레이북 전체. 정부24는 사전 허락 회신 전 `postprocess`가 기본값이다.

## 3. 신뢰 경계

```text
┌──────────── 사용자 기기 (TB-0: 사용자 신뢰) ─────────────┐
│  ┌───── vault (TB-1: 비밀 평문 유일) ─────┐             │
│  │ 키체인 핸들, 평문 비밀, CDP 타이피스트 │             │
│  └────────────────────────────────────────┘             │
│  ┌───── engine (TB-2: 업무 데이터 평문) ──┐             │
│  │ 접근성 트리, 입력값, PDF, 마스킹 전 데이터│             │
│  │   └─ redaction ─▶ net/egress ─────────────┼──▶ TB-4   │
│  └────────────────────────────────────────┘             │
│  renderer (TB-3: 표시만, 네트워크 없음)                   │
└──────────────────────────────────────────────────────────┘
TB-4 클라우드(우리): 암호문·최소 메타데이터·계량만(운영자가 볼 수 있는 것은 D09 §1 표).   TB-5 모델 공급사: 마스킹본만.
TB-6 릴레이: 암호문만(연결 상관은 가능).   TB-7 포털: 사용자 세션(우리 코드가 아닌 사용자 행위).
TB-8 docparse: OS 샌드박스 안, 바이트 입력·JSON 출력만.
```

경계 규칙:
- TB-1 → TB-2 평문 비밀 전달 금지. 비밀이 필요한 입력은 vault가 자기 파이프 세션으로 직접 수행하고(ADR-005 v3), 가상키패드·커널 드라이버 보안 모듈 칸은 사용자 직접 입력(`human:secret`)이되 **비밀 창**으로 같은 보호를 받는다. 중계는 비밀 오염 프레임의 요청 바디와 비밀 칸 값을 엔진에 넘기지 않는다. 이 경계는 정상 경로의 평문 유입을 막는 장치이며 엔진 침해·같은 사용자 악성코드에 대한 경계가 아니다(D05 §1, D11 T2).
- 엔진의 CDP 권한은 금고의 허용 목록이 정한다. 브라우저 타깃·Storage·다운로드 경로 변경·사용자가 연 탭은 엔진에 열리지 않는다.
- TB-2 → TB-4/5 송신은 `net/egress` 단일 모듈. `engine` 코드베이스에서 `fetch`/`net`/`http` 직접 import는 ESLint 규칙으로 금지(`no-restricted-imports`), CI에서 검사.
- TB-5로 가는 페이로드는 `redaction.apply()`의 반환 타입(`RedactedPayload` 브랜드 타입)만 받도록 `egress.toModel()` 시그니처로 강제.

## 4. UI 셸 (렌더러) 구성

- 홈 = 메인 대화(단일 세션 타임라인, ADR-019): 왼쪽 레일(문서함·거래처·내 사업장·활동 기록·설정), 가운데 대화와 오늘 요약(확인 필요·진행 중·만료 임박), 오른쪽 작업 패널. 자주 쓰는 작업(실행 횟수·최근성 가중, 프로필 호환 필터)은 입력창 위 빠른 실행 칩이다. 화면 목록과 ID는 08 문서.
- 실행 뷰: 스텝 진행(사람이 읽는 라벨), 게이트 카드(승인 대기 카드는 되읽은 값을 보여 주고, [승인하고 발급]은 카드 아래 대화 열 하단의 main 승인 바에 있다, ADR-020·021), 핸드오프 배너("지금 사람이 필요합니다 / 직접 발급하셨다면 '직접 발급함'을 눌러 주세요"), 승인 대기 중 화면 잠금 표시, 중단 버튼(항상 가능).
- 설정: 프로필·인증수단, 보관함 위치, 백업 ON/OFF, 운영 기준 보기, 공문 회신 상태, "서버가 가진 내 데이터".
- 감사 로그: 실행 단위 타임라인, 모델 전송 미리보기(마스킹본), 내보내기.
- 대화창은 의도 → 플레이북 인자 채우기 → 확인 카드. 대화 내역의 원본은 로컬 DB이고, 폰은 PC가 켜져 있을 때 E2E 채널로 받아 볼 뿐 서버·릴레이에는 저장하지 않는다(ADR-019). 모델 출력은 구조화 슬롯만 표시하고 마크다운은 허용 태그 sanitizer를 거친다(원시 HTML 금지). 비가역 승인은 대화 열 하단(입력창 위) main 승인 바의 [승인하고 발급]으로만 한다. 승인 바는 렌더러가 아니라 main이 그리는 스크립트 없는 뷰이고, 위치는 main이 창 크기로 정하며, main이 그 뷰의 클릭을 직접 관찰한다. 대화 카드에는 승인 버튼이 없다. 별도 승인 창은 없다(ADR-020·021).

## 5. 대표 시퀀스

### 5.1 세금계산서 발급 (로컬, 공동인증서)

```text
사용자 → renderer: "거래처 A에 330만원"
renderer → main → engine: intent.resolve(text)
engine → redaction → egress → gateway.decide(intent_route_v1)       # L1 (되묻기 필요 여부는 로컬 검사)
engine: H-01 선택, 인자 추출(금액 파서 로컬) → 확인 카드 데이터
renderer: 확인 카드 표시 → 사용자 '발급 준비'
engine: run(H-01) 시작, checkpoint A: ensure_session
  engine → chrome: 홈택스 로그인 페이지 → 공동인증서 선택 화면
  engine → vault: typist.fill(step=cert_password)                   # 평문은 vault에만; 비밀 창 개시 → 엔진 명령 보류
  vault ⇄ chrome(CDP): 비밀번호 입력 → 완료 신호(값 없음)              # 홈택스 가상키패드 칸이면 human:secret, 역시 비밀 창
  engine: decide(screen_state_v2) → 로그인 성공 확인
  ... 건별발급 화면 입력(engine), assert(합계)
engine: verify.baseline(발급목록 승인번호 집합 B₀) → readback(커밋 랜드마크 안 모든 fieldKey: 공급자·거래처·이메일·금액·비고·청구/영수)
  → assert supplierBizNo == $profile.bizNo → main 승인 바(정적 HTML 뷰, 실제 클릭 관찰, ADR-021) ─ 사용자 승인 ─▶ LocalApproval ─▶ 토큰 발급(req_id당 1개)
engine: submit → 원장 armed(intent_id, step_id) + 토큰 소비(fsync) → readback 재계산 → 커밋 가드 무장(R-C1 본문 대조는 금고) → 클릭(R-A1 이름 동일성·R-A2 커밋 충돌 검사) → signFlow(서명) → dispatched
  → verify(새 탭, B₁ \ B₀ = 1건) → committed(승인번호 bind)
engine: save_pdf(V-23 템플릿) → verify(메일발송목록: 홈택스 자동 발송 상태)       # s33 별도 전송은 Phase 1 제외
engine → main: run.completed + audit events → DB
main → cloud: metadata.put(doc_id, slot_token, doc_type?, issued_month?, expires_on?, blob_id, wdek, kek_ver, rev, sig) / blob.put(E2EE)   # 옵션, doc_type 옵트인 꺼짐이면 doc_keys만
```

### 5.2 리모트 발급 (폰에서 지시)

```text
mobile → relay → engine: cmd.run(H-01, inputs)  [Noise 세션, 처리된 cmdId 집합과 대조]
engine: 준비 → gate.request(card: readback 값 + cardHashInputs) → relay → mobile: cardHash 재계산 → P-256 하드웨어 키로 승인(처음 쓰는 거래처면 거부, PC 로컬 승인 안내) → gate.response(sigAlg=p256)
engine: 실행 … 간편인증 PUSH 발생 → 사용자가 홈택스 앱에서 승인(우리 채널 밖)
engine: wait(로그인 성공 마커, 결정적) → decide(screen_state_v2) 1회
… 캡차 등장 → human.request(captcha_image) → mobile 입력 → human.response → vault typist 또는 engine fill(비밀 아님)
engine: 완료 → run.event(done) + file.offer(pdf, E2EE) → mobile
```

### 5.3 데몬 갱신 (반자동, `semi_auto`)

```text
main.scheduler: 만료 D-7 → job(H-04 납세증명, 홈택스) 생성   # 정부24 서류는 허락 전 알림만
main → cloud: POST /v1/wake{device_id} → push(내용 없음) → mobile fetch → consent.request("갱신 시작할까요")   # 게이트와 다른 서명 문맥
시작 동의(consent.response, 소프트웨어 키 가능) → engine run(trigger=daemon: 저장 비밀 미사용, effects ⊆ {issue_document}) … 간편인증 PUSH → 사용자 승인 → readback → 커밋 게이트(폰 하드웨어 키, 건별 토큰) → 발급 → verify → 저장 → metadata 갱신
시작 동의 미응답 → job 보류(gate.waitMs와 무관), 알림 1회 재전송, D-1 재시도
```

### 5.4 캡차 핸드오프

```text
engine: decide(screen_state_v2) → 예약 결과 아님, outcome=captcha (captcha_visible ≥ 0.85)
  → 데스크톱 활성(최근 입력 60s)이면 renderer.focus + 영역 하이라이트
  → 아니면 human.request(kind=captcha, image=crop, ttl=90s) → relay → mobile
mobile 입력 → human.response → engine fill(캡차 답은 비밀 아님, 로그에는 길이만)
90s 무응답 → checkpoint 복귀, run.paused(resumable)
캡차 카운터 증가(rate_counters) → 운영 정책 cooldown.onCaptchaBurst 자동 보수화 판단(D03 §7)
```

## 6. 배포 토폴로지

- 데스크톱: 코드서명된 설치본(Windows: Authenticode, macOS: 공증), 자동 업데이트(electron-updater, `latest.yml` 별도 키 서명·만료, 단계적 롤아웃). 플레이북·핫픽스·운영 정책은 **앱 업데이트와 분리**된 레지스트리 채널에서 받으며 **2-of-3 Ed25519 서명**·`keyEpoch`·폐기 목록·`status.json` 검증 후 로드(ADR-013). 포털별 운영 수준 상한·정책 하한은 앱에 내장된다(ADR-012).
- 클라우드: 단일 리전(국내) 우선, 현재 가정은 AWS 서울이며 설계는 **공급사 중립**(S3 호환 하위 집합, PostgreSQL 표준, 서버 직접 TLS 종단 가능, 서명 키는 국내 자체 HSM). 전환 트리거는 조달·계약(ADR-015). 게이트웨이·릴레이는 무상태 수평 확장. 침해 시 새는 것은 D09 §1 가시성 표가 정본이다.
- 모바일: 스토어 배포, OTA 미사용 원칙. 릴레이 주소·레지스트리 공개키(루트 3, 패키지 3, 정책 3, 타임스탬프·긴급 각 1)·`fieldKey` 라벨 사전은 앱에 핀 고정.

## 7. 모듈 경계 (모노레포, 개발 착수 시 생성)

| 패키지 | 책임 | 의존 허용 |
|---|---|---|
| `engine` | IR 로더·검증기, 실행기, 스텝 핸들러, 복구기, 정책 집행 | `redaction`, `model`, `net`, `docparse`, `protocol` |
| `playbooks` | IR 문서, 번들 카탈로그, 포털별 셀렉터 사전 | 없음(데이터) |
| `vault` | 키체인 어댑터(등급 2종), 중계 허용 목록·응답 정리, 비밀 창·타이피스트, 장기 키 연산, 비밀 핸들 | OS API만 |
| `redaction` | 트리 절단, 엔티티 치환, 역치환, 스크린샷 마스킹 | 없음 |
| `model` | `decide()`/`respond()` 계약, 어댑터, 번들 실행기, 임계값 정책 | `net` |
| `net` | `egress` 단일 송신 모듈, 게이트웨이·릴레이 클라이언트 | `protocol` |
| `protocol` | 리모트 메시지 스키마, Noise 래퍼, 블롭 봉투 | libsodium |
| `docparse` | PDF 텍스트 추출, 메타데이터 규칙(렌더러 샌드박스 안) | 없음 |
| `db` | SQLite 스키마·마이그레이션·저장소 인터페이스 | 없음 |
| `apps/desktop` | Electron 셸, IPC, 스케줄러, UI | 위 전부 |
| `apps/mobile` | Expo 앱 | `protocol` |
| `apps/cloud-*` | 게이트웨이, 릴레이, API, 레지스트리 | `protocol` |
