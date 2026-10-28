# D01. 시스템 아키텍처

## 1. 컨텍스트 (C4 L1)

```text
 사용자(대표/경영지원) ──사용──▶ [데스크톱 하네스] ──조작──▶ 홈택스 / 정부24 / SMINFO / 4대보험센터
        │                           │  ▲
        │ 승인·지시·조회             │  │ 암호문 메시지 (릴레이 경유)
        ▼                           ▼  │
   [모바일 앱] ◀──────────────▶ [클라우드: 계정·게이트웨이·릴레이·블롭·메타데이터·레지스트리]
                                        │ 마스킹된 프롬프트만
                                        ▼
                                  OpenAI (Decisions / Responses)
   거래처 사업자번호 검증 ──────▶ 공공데이터포털 국세청 진위확인 API (서비스 키 필요 → 게이트웨이 프록시 또는 BYO 키, D09 §4.1)
```

## 2. 컨테이너와 프로세스 모델 (C4 L2)

### 2.1 데스크톱 하네스 (Electron)

| 프로세스 | 역할 | 권한 | 네트워크 |
|---|---|---|---|
| `main` | 앱 수명주기, 창 관리, 스케줄러(데몬), IPC 라우터, 업데이트 | 전체 | 업데이트 서버, 클라우드 API(계정·메타데이터·블롭 업로드) |
| `renderer` (sandbox, contextIsolation) | UI. 작업 카드, 대화창, 확인 카드, 감사 로그 뷰 | 없음(프리로드 API만) | 없음(직접 fetch 금지, CSP `connect-src 'none'`) |
| `engine` (utilityProcess) | 플레이북 해석·실행, Playwright로 Chrome 제어, 마스킹, 모델 호출 조립 | 파일: 보관함 쓰기, DB 읽기/쓰기 | **오직 `net/egress` 모듈을 통해** 게이트웨이·릴레이 |
| `vault` (utilityProcess, 별도) | 비밀 저장·복호화·서명 보조, **비밀 타이피스트**(CDP 직결) | OS 키체인, 메모리 잠금 | 없음(아웃바운드 금지, CDP 로컬 소켓만) |
| `chrome` (사용자 설치 Chrome, 전용 프로필, 최소 플래그 모드) | 포털 세션. `ignoreDefaultArgs: true` + CDP 파이프 + `--user-data-dir`, `--no-sandbox`·`--disable-extensions` 없음. `navigator.webdriver=true`는 그대로(ADR-010) | 사용자 권한 | 포털 도메인(엔진이 허용 목록으로 감시) |

프로세스 간 통신은 Electron `MessagePort` 기반 IPC. 모든 메시지는 타입드 스키마(`ipc/*.schema.json`)로 검증한다. `renderer`는 `engine`·`vault`와 직접 통신하지 않고 `main`이 중계한다.

### 2.2 모바일 앱 (React Native/Expo)

| 모듈 | 역할 |
|---|---|
| `pairing` | QR 스캔, Noise XX 핸드셰이크, 장기 키 보관(Secure Enclave/Keystore) |
| `remote` | 명령 전송, 승인 카드, 캡차·비밀 입력 중계, 진행 이벤트 수신 |
| `vaultview` | E2EE 블롭 내려받아 복호화·열람, 폰으로 받은 PDF 공유 |
| `query` | 클라우드 조회 에이전트 UI(메타데이터만), 본문 요약은 명시 동의 후 마스킹 전송 |
| `notify` | 내용 없는 푸시 수신 → 앱이 릴레이에서 암호문 fetch |

### 2.3 클라우드 (D09 상세)

| 서비스 | 저장하는 것 | 저장하지 않는 것 |
|---|---|---|
| Accounts/Billing | 이메일, 구독 상태, 프로필 슬롯 수(≤2), 기기 등록(공개키) | 비밀번호 외 비밀, 사업자번호 |
| Gateway | 계량 레코드(토큰 수, 번들 ID, 플레이북 ID, 지연, 모델) | 프롬프트·응답 본문 |
| Relay | 룸 ID, 암호문 큐(≤7일), 크기·시각 | 평문, 키 |
| Blob Store | 암호문 블롭, blob_id, 크기 | 복호화 키, 파일명 |
| Metadata Index | 문서 종류, 발급일, 만료일, 프로필 종류, 크기, dedup 토큰(HMAC) | 상호·사업자번호·주민번호·금액·파일명 |
| Playbook Registry | 서명된 IR 패키지, 운영 정책, 채널(stable/beta) | — |
| Query Agent | 세션 없는 질의 처리(메타데이터 → 게이트웨이) | 대화 로그 본문 |

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
TB-4 클라우드(우리): 암호문·메타데이터·계량만.   TB-5 모델 공급사: 마스킹본만.
TB-6 릴레이: 암호문만.   TB-7 포털: 사용자 세션(우리 코드가 아닌 사용자 행위).
```

경계 규칙:
- TB-1 → TB-2 평문 비밀 전달 금지. 비밀이 필요한 입력은 vault가 CDP로 직접 수행(ADR-005). 예외: 포털 모듈이 CDP 입력을 거부하는 칸은 사용자 직접 입력(`human` 스텝).
- TB-2 → TB-4/5 송신은 `net/egress` 단일 모듈. `engine` 코드베이스에서 `fetch`/`net`/`http` 직접 import는 ESLint 규칙으로 금지(`no-restricted-imports`), CI에서 검사.
- TB-5로 가는 페이로드는 `redaction.apply()`의 반환 타입(`RedactedPayload` 브랜드 타입)만 받도록 `egress.toModel()` 시그니처로 강제.

### 2.4 포털별 운영 수준

엔진은 서명된 운영 정책의 `portalMode`에 따라 세 수준으로 동작한다(기획 05 문서 §7). `postprocess`에서는 브라우저 자동화를 전혀 하지 않고(접근성 트리 수집 포함) 안내 패널·파일 감시·메타데이터·만료 추적만 수행한다. `assisted`는 로그인 후 비식별 입력 자동 채움과 화면 판정까지, `auto`는 플레이북 전체. 정부24는 사전 허락 회신 전 `postprocess`가 기본값이다.

## 4. UI 셸 (렌더러) 구성

- 홈: 프로필 스위치, 자주 쓰는 작업(실행 횟수·최근성 가중), 포털별 작업 목록(프로필 호환 필터), 만료 임박 서류, 최근 실행, 대화창.
- 실행 뷰: 스텝 진행(사람이 읽는 라벨), 게이트 카드, 핸드오프 배너("지금 사람이 필요합니다"), 중단 버튼(항상 가능).
- 설정: 프로필·인증수단, 보관함 위치, 백업 ON/OFF, 운영 기준 보기, 공문 회신 상태, "서버가 가진 내 데이터".
- 감사 로그: 실행 단위 타임라인, 모델 전송 미리보기(마스킹본), 내보내기.
- 대화창은 의도 → 플레이북 인자 채우기 → 확인 카드. 대화 내역은 로컬 DB에만.

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
  engine → vault: typist.fill(step=cert_password)                   # 평문은 vault에만
  vault ⇄ chrome(CDP): 비밀번호 입력 → 완료 신호(값 없음)
  engine: decide(screen_state_v2) → 로그인 성공 확인
  ... 건별발급 화면 입력(engine), assert(합계)
engine: readback(제출 필드 되읽기) → renderer: gate 카드(readback 값, intentId) ─ 사용자 승인 ─▶ 토큰 발급
engine: submit → 원장 armed + 토큰 소비 → 커밋 가드 무장 → 클릭 → dispatched → verify(발급목록 조회) → committed
engine: capture(승인번호) → save_pdf → send_email(후속 토큰) → verify(전송 상태)
engine → main: run.completed + audit events → DB
main → cloud: metadata.upsert(doc_type, issued_at, hash_token) / blob.put(E2EE)   # 옵션
```

### 5.2 리모트 발급 (폰에서 지시)

```text
mobile → relay → engine: cmd.run(H-01, inputs)  [Noise 세션]
engine: 준비 → gate.request(card) → relay → mobile 승인 → gate.response
engine: 실행 … 간편인증 PUSH 발생 → 사용자가 홈택스 앱에서 승인(우리 채널 밖)
engine: wait(로그인 성공 마커, 결정적) → decide(screen_state_v2) 1회
… 캡차 등장 → human.request(captcha_image) → mobile 입력 → human.response → vault typist 또는 engine fill(비밀 아님)
engine: 완료 → run.event(done) + file.offer(pdf, E2EE) → mobile
```

### 5.3 데몬 갱신 (반자동)

```text
main.scheduler: 만료 D-7 → job(G-02 지방세 납세증명) 생성
main → mobile(push, 내용 없음) → mobile fetch → gate.request("갱신 시작할까요")
승인 → engine run … 간편인증 PUSH → 사용자 승인 → 저장 → metadata 갱신
미승인 24h → job 보류, 알림 1회 재전송, D-1 재시도
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

- 데스크톱: 코드서명된 설치본(Windows: Authenticode, macOS: 공증), 자동 업데이트(electron-updater, 단계적 롤아웃). 플레이북·운영 정책은 **앱 업데이트와 분리**된 레지스트리 채널에서 받으며 Ed25519 서명 검증 후 로드.
- 클라우드: 단일 리전(국내) 우선. 게이트웨이·릴레이는 무상태 수평 확장. 블롭은 S3 호환, 메타데이터는 PostgreSQL. 비밀 없음이라 침해 반경이 작다는 점을 운영 문서에 명시.
- 모바일: 스토어 배포. 릴레이 주소와 레지스트리 공개키는 앱에 핀 고정.

## 7. 모듈 경계 (모노레포, 개발 착수 시 생성)

| 패키지 | 책임 | 의존 허용 |
|---|---|---|
| `engine` | IR 로더·검증기, 실행기, 스텝 핸들러, 복구기, 정책 집행 | `redaction`, `model`, `net`, `docparse`, `protocol` |
| `playbooks` | IR 문서, 번들 카탈로그, 포털별 셀렉터 사전 | 없음(데이터) |
| `vault` | 키체인 어댑터, 타이피스트, 비밀 핸들 | OS API만 |
| `redaction` | 트리 절단, 엔티티 치환, 역치환, 스크린샷 마스킹 | 없음 |
| `model` | `decide()`/`respond()` 계약, 어댑터, 번들 실행기, 임계값 정책 | `net` |
| `net` | `egress` 단일 송신 모듈, 게이트웨이·릴레이 클라이언트 | `protocol` |
| `protocol` | 리모트 메시지 스키마, Noise 래퍼, 블롭 봉투 | libsodium |
| `docparse` | PDF 텍스트 추출, 메타데이터 규칙 | 없음 |
| `db` | SQLite 스키마·마이그레이션·저장소 인터페이스 | 없음 |
| `apps/desktop` | Electron 셸, IPC, 스케줄러, UI | 위 전부 |
| `apps/mobile` | Expo 앱 | `protocol` |
| `apps/cloud-*` | 게이트웨이, 릴레이, API, 레지스트리 | `protocol` |
