# R3. 데스크톱 플랫폼 엔지니어링 조사

> 작성일 2026-10-28 · 대상 문서: `03-architecture.md`, `05-access-and-detection.md` · 범위: Electron + Playwright(설치 Chrome) + OS 키체인 + 로컬 DB + 배포
> 제약(고정): 지문 위조 없음, 자동화 은폐용 값 주입 없음, 캡차 풀이 없음, 실제 설치 Chrome을 헤드풀·전용 프로필·자동화 전용 플래그 최소화로 구동.

## 0. 읽는 법과 결론

### 0.1 근거 등급

| 표기 | 뜻 |
|---|---|
| **[실험]** | 이번 조사에서 직접 실행·측정. 환경: macOS(Darwin 25.5), Google Chrome 156.0.8078.73, playwright-core 1.59.1 / 1.64.1, Node 26.11.1. **Windows는 실행하지 못했다.** |
| **[공식]** | 공식 문서·공식 소스코드·npm 레지스트리 메타데이터를 직접 열람 |
| **[2차]** | 블로그·포럼·언론·벤더 글. 방향은 믿되 스파이크로 재확인 필요 |
| **[추론]** | 위 근거에서 내가 도출한 판단. 직접 확인되지 않음 |

### 0.2 한 장 결론

| # | 주제 | 권고 | 가장 큰 단서 |
|---|---|---|---|
| 1 | 브라우저 구동 | Playwright `launchPersistentContext` + `channel:'chrome'` + **최소 플래그 모드**(`ignoreDefaultArgs:true` + `--remote-debugging-pipe`, `--user-data-dir` 등 4개만). 사용자 일상 Chrome에는 붙지 않는다 | Playwright 파이프 구동에서는 `navigator.webdriver`가 **true**다(`--enable-automation` 제거와 무관). 03 문서의 "탐지 신호가 사람 사용과 같다"는 과대 표현이므로 수정 필요 |
| 1 | PDF 저장 | 1순위 포털이 주는 **원본 PDF 바이트**(download/응답 가로채기), 2순위 **Chrome `--kiosk-printing` + "PDF로 저장" 사전 설정**, 3순위 `page.pdf()`(현행 Chrome은 헤드풀에서도 동작), 마지막 수단 Microsoft Print to PDF / UI Automation | 헤드풀 `page.pdf()`와 kiosk-printing은 macOS에서만 검증. Windows 스파이크 필요 |
| 1 | 한국 보안모듈 | 키보드보안(nxKey 계열)이 걸린 입력칸은 **사용자 직접 입력/핸드오프**(05 문서 방침 유지). 확장 기반 모듈을 위해 `--disable-extensions` 제거 필수 | 합성 입력이 드라이버 경로를 우회한다는 점은 [추론]. 실포털 검증 전 단정 금지 |
| 2 | 비밀 저장 | **`@napi-rs/keyring`**(keytar 대체) + 작은 값만 저장(Windows 한 항목 2,560바이트 한도) + 큰 데이터는 봉투 암호화. 비밀 서비스는 `utilityProcess`로 분리하되 "같은 사용자 권한 악성코드에는 경계가 아님"을 문서화. Hello/Touch ID 결박은 **Rust N-API 헬퍼**로 | Electron `promptTouchID`는 UI 게이트일 뿐 데이터를 보호하지 않는다. `safeStorage`는 Main 프로세스 전용 |
| 3 | NPKI | **하네스는 개인키를 복호화하지 않는다.** 포털 모듈(브라우저 인증서 가져오기 포함)에 서명을 위임하고, 비밀번호는 모듈의 입력칸에 넣거나 사용자에게 넘긴다. 로컬 서명은 Phase 3 이후 선택지로만 보류 | 03 문서 4절·플레이북 step 5의 "공동인증서 로컬 서명" 서술을 바꿔야 한다 |
| 4 | Electron 보안·배포 | 기본값(격리·샌드박스) 유지 + Fuses 하드닝 + 사용자 원격 콘텐츠 0. 서명은 **Microsoft Artifact Signing**(한국 법인 가입 가능) 우선 검토, EV는 SmartScreen 목적으로는 불필요. 플레이북 패키지는 **TUF 메타데이터 + Ed25519**, 1단계는 "TUF-lite" | electron-updater 7.0 알파(`next`)에는 Ed25519 서명 업데이트 매니페스트가 문서화되어 있으나 안정판 6.8.11에서는 관련 API를 찾지 못했다 |
| 5 | 로컬 데이터 | **`better-sqlite3-multiple-ciphers`** + 키체인의 32바이트 DB 키. DB·Chrome 프로필은 `%LOCALAPPDATA%`, PDF 기본 저장소는 폴더 접근 제어(CFA) 비보호 경로. PDF 텍스트는 **pdfjs-dist**, OCR은 단계적(내장 Tesseract kor → OS OCR) | `mupdf`(npm)는 AGPL. 기본 배제 |
| 6 | 사람 속도 | 엔진 레벨 `Pacer`(지연 분포) + 포털별 토큰버킷·일일 상한(DB 영속) + 네트워크 요청 예산 + 재시도 예산 + 쿨다운. 입력은 `fill()` 기본, 키 이벤트가 필요한 칸만 `pressSequentially` | 05 문서의 "글자당 40~120ms"는 실측 타이핑 통계상 **가장 빠른 타이피스트 수준 이하**다. 숫자 재검토 권고 |

### 0.3 이번 조사에서 직접 돌린 실험 (재현 가능한 사실)

| ID | 확인한 사실 | 결과 |
|---|---|---|
| E1 | Playwright 1.64.1 기본 실행 인자에 `--enable-automation`이 있는가 | **없음**. 그런데도 `navigator.webdriver === true` |
| E2 | Playwright 1.59.1: `ignoreDefaultArgs:['--enable-automation']`의 효과 | 기본값에는 해당 플래그 있음 → 옵션으로 **제거됨**. 그러나 `navigator.webdriver`는 여전히 **true**. `chromiumSandbox` 기본 false라 `--no-sandbox`가 붙고, `chromiumSandbox:true`로 제거됨 |
| E3 | 직접 spawn한 Chrome(`--remote-debugging-port=9333`, 전용 프로필, 다른 플래그 없음) + `connectOverCDP` | `navigator.webdriver === false`. 다운로드 이벤트·`saveAs`·`context.request.get()`(브라우저 쿠키 공유) 정상 |
| E4 | 헤드풀 Chrome에서 `page.pdf()`와 CDP `Page.printToPDF` | **둘 다 성공**(PDF 생성). `connectOverCDP` 경로에서도 성공 |
| E5 | `--kiosk-printing` + 프로필 `Preferences`에 "Save as PDF" 목적지·`savefile.default_directory`를 미리 써 둔 뒤 `window.print()` | 약 2초 내 **대화상자 없이** `<document.title>.pdf` 저장(한글 파일명 정상). 새 프로필에서도 사전 주입이 먹힘. (Playwright 표준 인자 모드에서 측정) |
| E6 | 위 PDF를 pdfjs-dist 6.4.299로 텍스트 추출 | 한글 정상. 단 **공백이 U+0001 제어문자**로 나옴 → 정규화 필요 |
| E7 | 최소 플래그 모드(플래그 4개)에서 download / popup / dialog / `pressSequentially`(한글) / `setInputFiles` / `page.pdf` | 모두 정상. `navigator.webdriver`는 true |
| E8 | `ignoreDefaultArgs:true` 단독 | **기동 실패**(`--remote-debugging-pipe`·`--user-data-dir`까지 사라짐). 두 플래그를 `args`로 직접 넘겨야 함 |
| E9 | `@electron/asar` 4.3.1로 같은 입력을 mtime만 바꿔 두 번 패킹 | 해시 동일(패킹은 결정적) |
| E10 | Playwright 소스 태그 조사 | `--enable-automation`은 v1.59.1까지 기본 인자, **v1.60.0부터 제거** |
| E11 | Electron 헤더 인덱스 | Electron 45.1.0 = Node 24.22.1, Chromium 156.0.8078.49 |

> E3의 `false`는 Chrome이 원래 내는 값이다. 우리는 이 값을 만들거나 숨기거나 덮어쓰지 않는다. 1.2절의 정책 메모를 먼저 읽을 것.

---

## 1. Playwright + 설치 Chrome

### 1.1 권고 구성 (모드 A: Playwright가 Chrome을 직접 기동)

```ts
// 최소 플래그 모드 — E7/E8 에서 검증한 형태
const ctx = await chromium.launchPersistentContext(profileDir, {
  channel: 'chrome',            // 설치된 Google Chrome (Windows: ...\Google\Chrome\Application\chrome.exe)
  headless: false,
  ignoreDefaultArgs: true,      // Playwright 테스트용 기본 플래그 전부 제외
  args: [
    '--remote-debugging-pipe',  // 이 두 개는 직접 넘겨야 한다 (E8)
    `--user-data-dir=${profileDir}`,
    '--no-first-run', '--no-default-browser-check',
    // 인쇄 저장 세션에서만: '--kiosk-printing'
    'about:blank',
  ],
  acceptDownloads: true, downloadsPath: stagingDir,
});
```

선택 이유

- **`channel:'chrome'`** 은 설치된 branded Chrome을 쓴다. Windows는 `\Google\Chrome\Application\chrome.exe`, macOS는 `/Applications/Google Chrome.app/...`로 해석된다 [공식: playwright-core 소스]. 번들 Chromium을 내려받지 않는다.
- **전용 `--user-data-dir`는 선택이 아니라 필수**다. Chrome 136부터 기본 데이터 디렉터리에는 원격 디버깅 스위치가 먹지 않는다 [공식: developer.chrome.com]. Playwright 문서도 기본 프로필 자동화는 지원 불가라고 명시한다 [공식].
- **최소 플래그 모드**를 권한다. Playwright 기본 인자 약 40개는 테스트 안정성용이다(`--disable-extensions`, `--disable-component-update`, `--disable-background-networking`, `--disable-sync`, `--disable-default-apps`, `--disable-popup-blocking`, `--disable-back-forward-cache`, `--no-sandbox` 등) [공식 소스 + E1 프로세스 인자 목록]. 웹페이지가 직접 읽지는 못하지만 브라우저 행동이 일반 Chrome과 달라진다. 05 문서의 "자동화 전용 플래그 미사용" 원칙에는 최소 모드가 더 가깝다.
- 특히 **`--disable-extensions`는 한국 보안모듈과 충돌**한다(1.4절). 표준 모드를 쓰더라도 이 항목은 `ignoreDefaultArgs` 배열로 제거해야 한다.
- 표준 모드를 쓸 때는 `chromiumSandbox:true`를 반드시 준다. 기본값(false)이면 `--no-sandbox`가 붙는다 [공식 문서 + E2]. 최소 모드에서는 애초에 붙지 않는다(E7).

| 구성 | 장점 | 단점 |
|---|---|---|
| **최소 플래그 모드(권고)** | 일반 Chrome에 가장 가깝다. 확장·컴포넌트 업데이트·샌드박스 기본값 유지 | Playwright 내부 가정(파이프 플래그 이름 등)에 직접 의존 → **Playwright 버전 고정 + Chrome stable/beta 대상 CI 스모크 테스트** 필요. 네트워크 가로채기(route) 같은 고급 기능은 일부 불안정할 수 있음(우리 플레이북은 의존하지 않음) |
| 표준 모드 + 배열 제외 | 공식 경로에 가깝다 | `--disable-extensions` 등을 정확한 문자열로 지정해야 하고(배열은 완전 일치 비교 [공식 소스]), `--disable-features=...`처럼 값이 붙은 플래그는 제거가 번거롭다 |

### 1.2 `ignoreDefaultArgs: ['--enable-automation']` 의 정확한 의미

| 질문 | 답 | 근거 |
|---|---|---|
| Playwright가 `--enable-automation`을 기본으로 주는가 | ≤1.59 예, **≥1.60 아니오** | E10, E1 |
| 제거하면 무엇이 바뀌나 | 그 플래그가 주는 "자동화 중" 표시 계열이 사라진다. Chromium 스위치 목록의 설명은 "브라우저가 자동화로 제어되고 있다는 표시를 켠다"는 취지다 [공식 peter.sh 목록]. 인포바 등 UI 영향이 있다는 것은 일반 지식이며 이번에 화면으로 확인하지는 않았다 | — |
| 제거하면 `navigator.webdriver`가 false가 되나 | **아니오.** 1.59.1에서 제거해도 true | E2 |
| 왜 true인가 | Playwright는 `--remote-debugging-pipe`로 붙는데, 이 구동에서 Chrome이 자동화 제어 상태로 표시한다. MDN은 "`--enable-automation` 또는 `--headless`, 또는 포트 0을 준 `--remote-debugging-port`"를 조건으로 적는다 [공식 MDN]. 파이프에 대한 서술은 MDN에 없고 **관측으로만 확인**(E1, E2, E7) | 부분 [실험] |
| 포트 방식은 | 고정 포트(≠0), 다른 플래그 없음 → **false** | E3 |
| CDP에 자동화 플래그를 덮어쓰는 API가 있나 | 있다(`Emulation.setAutomationOverride` — 자동화 플래그 값을 덮어쓰는 용도) [공식: 번들된 protocol.d.ts]. **사용하지 않는다**(05 위조·은폐 금지) | — |

**정책 메모 (사람이 결정할 사항)**
모드 B(아래 1.3)를 고르면 `navigator.webdriver`가 false로 나온다. 이것이 "자동화를 숨기려는 선택"으로 읽힐 수 있다. 05 문서의 원칙에 맞추려면 (a) 모드 선택 사유를 보안·안정성(파이프는 로컬 포트를 열지 않는다)으로 기록하고, (b) 두 모드가 내는 신호 차이를 공문에 투명하게 적고, (c) 어느 쪽이든 값을 주입·삭제하지 않는다. 기본 권고는 **모드 A(true를 그대로 둔다)** 다. 포털이 true 때문에 문제를 일으키는지는 스파이크 S1에서 두 모드를 비교해 보고, 문제가 생기면 운영기관과 협의한다.

### 1.3 CDP 연결 대안

| 모드 | `navigator.webdriver` | 보안 | 충실도 | 판단 |
|---|---|---|---|---|
| **A. Playwright 파이프 구동** | true [E1,E2,E7] | 네트워크 포트 없음 | 최고(Playwright 프로토콜) | **권고** |
| **B. 직접 spawn + `--remote-debugging-port` + `connectOverCDP`** | false [E3] | 127.0.0.1 포트가 열리고 **CDP는 인증을 수행하지 않는다**(스위치 설명에 명시 [공식 peter.sh]) → 같은 사용자의 다른 프로세스가 브라우저를 조종 가능. `--remote-allow-origins=*`는 쓰지 않는다 | Playwright 문서는 Playwright 프로토콜 연결보다 충실도가 크게 낮다고 경고한다 [공식]. 다운로드·`context.request`는 동작(E3) | 대안. 정책 메모 선결 |
| **C. 사용자 일상 Chrome에 붙기** (Chrome 144+ `chrome://inspect/#remote-debugging` 토글, 연결마다 권한 대화상자) | 미확인 | "에이전트가 프로필의 모든 데이터와 열린 탭에 접근" [공식 developer.chrome.com] | — | **비권고.** 전용 프로필 원칙과 최소 권한 원칙에 어긋남 |

Playwright 소스에는 `connectOverCDP('chrome')`처럼 채널 이름을 주면 기본 프로필의 `DevToolsActivePort`를 읽어 붙는 경로도 있다 [공식 소스]. 이것이 모드 C다.

### 1.4 한국 보안모듈과 자동화

알려진 사실

- 한국 금융·공공 사이트는 여러 로컬 프로그램(TouchEn nxKey, Veraport, IPinside 등)을 요구하고, 이들은 **로컬 웹서버(127.0.0.1)** 와 브라우저 확장으로 사이트와 통신한다 [공식 아님·분석글: Palant 2023].
- **nxKey**: 커널 드라이버가 모든 키보드 입력을 가로채 앱으로 보내 암호화한다. 사이트 SDK가 **암호문을 숨은 폼 필드에 넣고 보이는 필드에는 더미 텍스트**를 둔다. 확장은 네이티브 메시징 중계이고, 신형은 확장 없이 `127.0.0.1:34581` WebSocket으로 직접 통신한다. 보조 프로그램은 `SendInput()`으로 다른 앱에 키를 전달한다 [Palant 2023 분석].
- 같은 분석글 댓글에는 일부 프로그램이 가상머신을 탐지하고, 한 프로그램은 개발자 도구 사용을 막으려 시도한다는 언급이 있다 [2차].
- 홈택스에는 **브라우저 저장소로 인증서를 가져와 보안 프로그램 없이 로그인**하는 방식이 있다고 한다. 로그인 화면에서 저장 위치로 "브라우저"를 고르고 `signCert.der`·`signPri.key`를 지정하며, 그 브라우저·PC에서만 유효하고 목록 조회·출력 화면은 추가 프로그램을 요구할 수 있다 [2차: 2026-10-01자 글 등]. 공식 확인은 못 했다.

이 사실들에서 나오는 판단 [추론]

1. CDP 합성 키 이벤트(`Input.dispatchKeyEvent`)는 렌더러로 직접 들어가므로 OS 키보드 스택의 드라이버를 거치지 않는다. nxKey가 걸린 비밀번호 칸에서는 숨은 암호문 필드가 비어 서버가 거절할 가능성이 높다. **그 칸은 사용자 직접 입력**(05 문서 2절)이 맞다.
2. 따라서 로그인 경로 우선순위는 (i) 홈택스 **브라우저 인증서 방식**(보안프로그램 없음 → 키보드보안 없음, 이 경우만 자동 입력 가능 여부를 스파이크로 확인), (ii) 간편인증(폰 승인), (iii) 사용자 직접 입력 핸드오프다.
3. 포털의 **가상 키보드(마우스 클릭 방식)** 를 Playwright 클릭으로 누르는 방법은 기술적으로 가능해도, "보안 기능을 자동으로 조작"하는 것이라 운영기관 공문에서 명시적으로 허용받기 전에는 쓰지 않는다.
4. **OS 레벨 입력 주입**(`SendInput` 계열)으로 키보드보안을 통과시키려는 시도는 하지 않는다. 보안모듈이 막는 동작이고 05 문서의 "공존" 원칙과 충돌한다.

확장과 네이티브 메시징

- Playwright 표준 모드의 `--disable-extensions` 때문에 확장 기반 모듈은 뜨지 않는다 → 최소 모드 또는 배열 제외.
- Chrome 137부터 branded Chrome은 `--load-extension`을 무시한다(Chrome for Testing·Chromium은 유지) [검색 스니펫만 확인, 미열람: Chromium extensions PSA]. 모듈 확장은 **Chrome 웹스토어에서 전용 프로필에 설치**하는 방식으로 가야 한다.
- 네이티브 메시징 호스트 등록: Windows는 레지스트리(`HKCU`/`HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\...`)라 프로필과 무관하다. **macOS의 사용자 단위 매니페스트는 "사용자 프로필의 `NativeMessagingHosts/`" 아래**라고 문서에 적혀 있다 [공식]. 전용 `--user-data-dir`를 쓰면 기본 위치의 사용자 매니페스트를 못 찾을 수 있다 [추론] → macOS에서 시스템 전역 위치에 설치되는지, 아니면 프로필 폴더로 복사해야 하는지 확인 필요(스파이크 S9). Windows 우선 개발이므로 영향은 작다.

### 1.5 네이티브 대화상자 처리 (헤드풀)

| 대상 | 처리 | 근거 |
|---|---|---|
| JS `alert/confirm/prompt/beforeunload` | `page.on('dialog')` | [공식] + E7 |
| `<input type=file>` | `setInputFiles` / `filechooser` 이벤트 (OS 파일창이 뜨지 않음) | [공식] + E7 |
| 파일 다운로드 | `download` 이벤트 → `saveAs`. "다른 이름으로 저장" 창이 뜨지 않음 | E3, E7 |
| 팝업/새 창 | `popup`, `context.on('page')` | E7 |
| Chrome **인쇄 미리보기**(Chrome 내부 WebUI) | Playwright로 조작 불가 → `--kiosk-printing` 또는 `page.pdf()` | 1.6절 |
| **OS 인쇄/저장 대화상자**(Microsoft Print to PDF의 파일명 창 등) | UI Automation(FlaUI 등)으로만 가능, 취약 | 1.6절 |
| 보안모듈 자체 창(인증서 선택, 설치 안내) | 별도 프로세스. 사용자 핸드오프. 허용되는 경우에 한해 UIA | 1.4절 |
| 권한 요청(알림, 위치 등) | 전용 프로필 `Preferences`에 사전 설정 또는 `context.grantPermissions` | [공식 일반] |

### 1.6 PDF 만들기: `page.pdf()`, `Page.printToPDF`, 그리고 "인쇄 → PDF 저장"

**`page.pdf()`의 "헤드리스 전용" 제약**

- Playwright 문서 v1.40, v1.49에는 "PDF 생성은 현재 Chromium 헤드리스에서만 지원된다"는 취지의 문장이 있었고 **v1.55 및 main 문서에는 이 문장이 없다** [공식: 문서 원문 비교]. 소스(`crPdf.ts`)도 `Page.printToPDF`를 호출할 뿐 헤드리스 검사가 보이지 않는다 [공식].
- 실측: Chrome 156 **헤드풀**에서 `page.pdf()`와 CDP `Page.printToPDF` 모두 성공 [E4]. 따라서 이 제약은 현행 환경에서 **해소된 것으로 본다. 단 macOS 실측뿐이다.** Windows 헤드풀과 구버전 Chrome은 스파이크 S3에서 확인한다. 검색에서 보이는 `PrintToPDF is not implemented` 오류 보고들은 오래된 버전·버전 불일치 사례다 [2차].

**옵션 비교**

| # | 방법 | 동작 | 장점 | 단점/리스크 | 판정 |
|---|---|---|---|---|---|
| a | **원본 PDF 바이트 확보**: `download` 이벤트, 응답 가로채기, `context.request.get(url)` | 포털이 PDF를 주는 경우 | 원본 그대로(위변조방지 요소 보존). 대화상자 없음. `context.request`는 브라우저 쿠키를 공유(E3) | 포털이 PDF를 직접 주지 않으면 불가. 정부24는 "전자문서지갑" 저장 후 PDF 내려받기 경로가 있다는 안내가 있다 [2차] — 이 경로를 1순위로 조사 | **1순위** |
| b | **Chrome `--kiosk-printing` + "PDF로 저장" 사전 설정** | `window.print()`가 미리보기 없이 즉시 저장 | 대화상자 0. 가상 프린터·관리자 권한 불필요. 포털의 "출력" 버튼 흐름을 그대로 탄다 | 프로필 `Preferences` 키(`printing.print_preview_sticky_settings.appState`, `savefile.default_directory`)는 **비공식 레시피**(Selenium 커뮤니티)다. 파일명이 문서 `<title>`에서 나온다(E5) → 저장 후 감시·개명 필요. 그 프로필에서 사용자가 직접 인쇄해도 조용히 저장됨 → 안내 필요. **Windows 미검증** | **2순위** |
| c | `page.pdf()` / `Page.printToPDF` | 우리가 직접 PDF 렌더 | 완전 프로그램 제어(A4, 배경, 머리글 등). 대화상자 없음(E4) | 포털의 인쇄 경로(리포트 뷰어·플러그인)와 **결과가 다를 수 있다**. 2D 바코드·워터마크 가독성, 다중 프레임 문서 확인 필요 | **3순위** |
| d | Microsoft Print to PDF 기본 프린터 + 자동 인쇄 | OS 가상 프린터 | 포털이 가상 프린터를 요구하는 경우 유일한 길일 수 있음(03 문서 S3) | **항상 파일명·위치를 묻는다 — "by design"** [2차: Microsoft Q&A]. 로컬 포트에 고정 경로를 주는 우회가 있으나(검색 스니펫, 미열람) 프린터·포트 생성에 관리자 권한과 시스템 설정 변경이 필요하고 동시성·덮어쓰기 문제가 있다 | 마지막 수단 |
| e | OS 대화상자를 UI Automation으로 조작 | FlaUI(MIT, .NET UIA 래퍼) 등 | 어떤 대화상자든 이론상 가능 | 취약(언어·버전·포커스). 일부 보안모듈이 차단. .NET 사이드카 필요 | 최후 |
| f | Chrome 엔터프라이즈 정책(`PrintPreviewUseSystemDefaultPrinter`, `DefaultPrinterSelection`) | 기본 프린터 선택 | 공식 정책 | 레지스트리 정책은 **사용자의 모든 Chrome에 적용**되고 "조직에서 관리됨" 표시를 만든다. 시스템 설정 변경 → **비권고**. 프로필 Preferences·실행 플래그로 대체 | 비권고 |

`--kiosk-printing`은 인쇄 미리보기에서 인쇄 버튼을 자동으로 누르는 스위치로 설명된다 [공식 peter.sh 목록]. `--disable-print-preview`와 별개다.

**권고 흐름**

1. 포털별로 "원본 PDF를 주는 경로"(다운로드, 전자문서지갑, PDF URL)를 먼저 찾는다.
2. 없으면 포털의 출력 버튼 → `window.print()` 경로에 b를 건다. 저장 폴더는 `%LOCALAPPDATA%` 하위 스테이징으로 두고(5절 CFA 항목), 파일 생성 감시(크기 안정화 후) → SHA-256 → 보관함으로 이동.
3. b가 막히면(포털이 `window.print`를 안 쓰고 플러그인 출력) c를 시험한다. 결과물의 육안·바코드 검증은 문서 종류별로 한 번씩 필요하다.
4. 가상 프린터를 요구하는 포털은 d를 쓰되 **"사용자 저장 대화상자를 사람이 처리"하는 반자동 모드**를 기본으로 하고 UI Automation은 옵션 기능으로만 둔다.

### 1.7 리스크 표 (주제 1)

| 리스크 | 영향 | 가능성 | 완화 | 근거 |
|---|---|---|---|---|
| Playwright 파이프 구동의 `navigator.webdriver=true`를 포털/보안모듈이 문제 삼음 | 로그인·발급 차단 | 중(미확인) | S1에서 포털별 A/B 비교, 문제 시 운영기관과 협의. 값 위조 금지 | E1~E3 |
| 최소 플래그 모드가 Playwright 업그레이드로 깨짐 | 전 기능 정지 | 중 | Playwright 버전 고정, Chrome stable/beta 스모크 CI, 표준 모드로 즉시 폴백하는 설정 | E8 |
| Chrome 자동 업데이트로 CDP 호환 변화 | 간헐 실패 | 중 | 시작 시 Chrome 버전 확인·허용 범위 표시, 실패 시 사용자 안내 | [추론] |
| `--kiosk-printing` 프로필에서 사용자 수동 인쇄가 조용히 저장 | 사용자 혼란 | 중 | 전용 프로필 전용 안내, 인쇄 세션에서만 플래그 사용(재기동) | E5 |
| macOS 실측을 Windows로 일반화 | 설계 오류 | 상 | Windows 스파이크 S3 완료 전 b·c를 "후보"로만 표기 | 한계 |
| 로컬 CDP 포트(모드 B) 악용 | 세션 탈취 | 하(모드 A 채택 시 없음) | 모드 A 기본. B 사용 시 임의 포트·loopback만·`--remote-allow-origins` 미사용 | [공식 peter.sh] |
| 잠금 화면·RDP 끊김·절전 중 헤드풀 실행 | 데몬 실패 | 중(미확인) | 상호작용 세션 필요 여부 스파이크 S14, 실패 시 "사용자 앞에서 실행" 모드 | [추론] |

---

## 2. 데스크톱 비밀 저장

### 2.1 라이브러리 평가

| 후보 | 상태 | 평가 |
|---|---|---|
| `keytar` | 저장소 **2022-12-15 보관(archived)**, 마지막 릴리스 7.9.0(2022-02-17) [공식] | **사용 금지.** 후속 권고 문구도 없음 |
| **`@napi-rs/keyring`** | v2.1.2, **2026-10-19 릴리스**, MIT. Rust `keyring-rs` 바인딩. 사전 빌드: win32 x64/ia32/arm64, darwin x64/arm64 등 [공식 npm/GitHub]. README상 "keytar 100% 호환 대안" | **권고.** API는 `setPassword/getPassword/deletePassword` 중심(문자열). 바이너리 비밀 API는 README에서 확인하지 못함 |
| Electron `safeStorage` | Windows=DPAPI, macOS=Keychain. 문서상 **프로세스: Main** 전용 [공식] | 분리 프로세스 설계와 맞지 않음. 앱 데이터 감싸기(래핑 키 보관)에는 적합. 동기 메서드는 Electron 46에서 제거 예고 → 비동기 API(`encryptStringAsync`) 사용 |
| `@primno/dpapi` | v2.0.1(2025-01), MIT [공식 npm] | Windows DPAPI 직접 호출·엔트로피 지정에 사용 가능. 단일 플랫폼 |
| 자체 **Rust N-API 헬퍼**(`windows`, `security-framework` 크레이트) | — | Hello/Touch ID 결박, 안전 메모리, 프로세스 하드닝이 필요할 때. Bitwarden 데스크톱(Electron + Rust/napi)이 동일 구조 [공식 소스] |

### 2.2 크기·범위·보호 수준

| 항목 | 내용 | 근거 |
|---|---|---|
| Windows 자격 증명 한 항목 비밀 크기 | **`CredentialBlobSize` ≤ 5×512 = 2,560 바이트**. UserName ≤ 513자, Comment ≤ 256자, 일반 TargetName ≤ 32,767자 | [공식 MS CREDENTIAL] |
| Windows 지속성 | `SESSION`(로그온 세션), `LOCAL_MACHINE`(이 PC·같은 사용자), `ENTERPRISE`(**다른 PC로 로밍될 수 있음**) | [공식 MS CREDENTIAL] |
| `keyring-rs` 계열 스토어는 위 세 값을 선택 가능한 타입으로 노출 | `@napi-rs/keyring`이 기본으로 무엇을 쓰는지는 **확인하지 못함** → 구현 전에 `Local` 고정 확인 | [공식 소스] / 미확인 |
| DPAPI 범위 | 기본은 **로그온 자격이 같은 사용자**, 같은 PC. `CRYPTPROTECT_LOCAL_MACHINE`을 주면 **그 PC의 모든 사용자**가 복호화 가능. 선택적 엔트로피로 앱별 비밀 추가 | [공식 MS CryptProtectData] |
| 같은 사용자의 다른 프로세스 | Windows `safeStorage`는 "같은 사용자 공간의 다른 앱은 막지 못한다" [공식]. Credential Manager도 같은 사용자 모든 프로세스가 읽을 수 있다(Bitwarden 소스 주석 요지: 키체인은 사용자 공간의 모든 프로세스가 접근할 수 있다) | [공식] |
| macOS Keychain | 항목 ACL이 앱 서명에 묶임. **서명이 일관되지 않으면 빌드가 다른 앱으로 인식되어 키체인 프롬프트가 반복** [공식 Electron 문서] → 서명·공증된 빌드에서만 테스트 | [공식] |
| macOS 항목 크기 한도 | 이번 조사에서 확인 못 함(32바이트 키·짧은 비밀번호에는 무관) | 미확인 |

**설계 규칙**: 키체인에는 **32바이트 키와 짧은 비밀(인증서 비밀번호)만** 넣는다. 보안카드 표처럼 큰 데이터는 키체인의 DEK로 봉투 암호화해 파일에 둔다.

### 2.3 비밀 처리 프로세스 분리

- Electron `utilityProcess`는 "Node.js와 Message port가 켜진 자식 프로세스"를 Chromium Services API로 띄운다. `child_process.fork` 대체재다. 문서는 **샌드박스 여부를 적지 않는다** [공식] → 샌드박스되지 않은 Node 프로세스로 가정한다. 맥에서 서명되지 않은 라이브러리 로드는 `allowLoadingUnsignedLibraries` 옵션(기본 끔) 영역이다 [공식].
- Fuses에서 `RunAsNode`를 끄면 `child_process.fork`가 막히므로 분리 프로세스는 `utilityProcess`로 쓴다 [공식 Fuses].
- 구조: `vault` 서비스(utilityProcess 또는 별도 Rust 실행파일) ↔ 엔진 프로세스를 **MessageChannelMain 포트**로만 연결하고 렌더러에는 비밀 경로를 두지 않는다. 이름 있는 파이프(named pipe)는 기본 ACL이 느슨할 수 있어 [추론] 쓴다면 DACL 제한과 상대 프로세스 서명 확인이 필요하다.
- **이 분리의 한계를 문서에 명시**한다. 같은 사용자 권한의 악성코드는 프로세스 메모리 읽기·코드 주입이 가능하다. Bitwarden도 소스 주석에서 "코드 주입을 막는 추가 프로세스 격리가 필요"하다고 적는다 [공식 소스]. 분리가 실제로 막는 것은 **렌더러·UI 취약점이 비밀 메모리에 닿는 경로**다. Bitwarden은 Linux에서 `PR_SET_DUMPABLE`로 디버거 부착·메모리 덤프를 막는 `process_isolation` 크레이트와 DPAPI로 보호된 `secure_memory` 크레이트를 둔다 [공식 소스] — 참고 구현으로 삼을 수 있다.

### 2.4 JS의 메모리 영(0)화 한계와 Rust 헬퍼를 쓸 시점

| 사실 | 의미 |
|---|---|
| JS 문자열은 불변이며 V8이 복사·보관한다 → 지울 수 없다 | 비밀번호를 문자열로 만든 순간 수명이 GC에 달림 |
| `Buffer.alloc`은 0으로 채워진 새 메모리, `Buffer.allocUnsafe`는 **풀(pool)에서 미초기화 메모리**를 줄 수 있다. 풀 크기 기본값은 현행 Node 문서 기준 64KiB, 풀 사용 임계는 그 절반 [공식 Node 문서] | 비밀은 `Buffer.alloc`으로만 만들고 사용 후 `fill(0)`. 장수 버퍼는 `allocUnsafeSlow` 계열로 풀 고정 방지 |
| libsodium `sodium_malloc`: 가드 페이지·카나리·`mlock` 시도·해제 시 0 채움. 단 `mlock`은 실패할 수 있고 스택·레지스터는 보호하지 않음 [공식 libsodium] | `sodium-native`(MIT, v5.2.0)로 Node에서 사용 가능 |
| **Playwright `fill(text)`는 JS 문자열을 요구** | 비밀번호를 포털 입력칸에 넣는 순간 엔진 프로세스에 문자열 사본이 반드시 생긴다 → "사용 시점 노출 최소화 + 장수 프로세스 금지" |

권고: 비밀번호는 (1) 키체인에서 `Buffer`로 꺼내고 (2) 입력 직전에만 문자열로 변환하며 (3) **작업 단위로 수명이 짧은 엔진 프로세스**에서 사용하고 종료한다. 네이티브(Rust) 헬퍼로 가야 하는 경우는 다음 셋뿐이다.

1. Windows Hello / Touch ID **결박**(아래 2.5)
2. 복호화된 개인키를 메모리에 올리는 일이 생길 때(3절 Phase 3) — `zeroize`·`mlock` 필요
3. 프로세스 덤프/디버거 부착 차단 등 OS 하드닝

### 2.5 Windows Hello / Touch ID 게이팅

| 플랫폼 | 방법 | 보호 수준 | 근거 |
|---|---|---|---|
| macOS | Electron `systemPreferences.promptTouchID()` | **UI 게이트일 뿐**. 문서가 직접 "이 API 자체는 사용자 데이터를 보호하지 않는다"고 적고, 진짜 보호는 키체인 항목에 `kSecAccessControlUserPresence` 같은 접근 제어를 걸어야 한다고 안내 | [공식 Electron] |
| macOS (실질 결박) | Rust 헬퍼에서 `security-framework`의 `PasswordOptions::set_access_control_options` / `set_access_control` 사용 → 읽을 때마다 생체/암호 요구 | 항목 단위 OS 강제 | [공식 docs.rs] (플래그 의미는 Apple 문서 본문을 열람하지 못해 미확인) |
| Windows (동의만) | `UserConsentVerifier`(예/아니오 결과). 데스크톱 앱은 HWND를 받는 interop 메서드 사용 | 앱이 결과를 믿어야 하는 **동의 게이트** | [공식 MS] |
| Windows (결박) | `KeyCredentialManager`로 TPM 지원 키 생성 → 사용자별 챌린지에 **서명**(결정적) → 서명을 해시해 KEK → 보호 대상 키를 암호화해 보관. Bitwarden 데스크톱이 이 방식 | 사용자 제스처 없이는 서명 불가. 단 "챌린지는 사용자 공간 프로세스가 모두 알 수 있으므로 공격자는 **가짜 Hello 프롬프트**로 사용자를 속여야 함"이 설계상 한계 | [공식 MS + Bitwarden 소스] |

주의점

- **무인 실행(데몬)과 충돌**한다. 03 문서 9절의 "저장된 비밀번호로 무인 갱신"은 사용자 존재 확인을 요구하는 게이트와 양립하지 않는다 → **두 등급**으로 나눈다: (가) 대화형 실행은 Hello/Touch ID로 비밀번호 해제, (나) 무인 실행은 사용자 명시 동의 + 유효기간 한정 + 낮은 상한으로 키체인 직접 사용(위험 수용 기록).
- Bitwarden은 Windows Hello 잠금 해제를 2025-08에 보안 문제로 중단했다가 복구했다는 보도가 있다. Hello 창이 전면에 안 뜨는 문제가 언급됐다 [2차: heise 스니펫]. **프롬프트를 전면 창의 HWND에 붙이는 UX 처리**가 필수다.
- Microsoft Store(MSIX) 빌드에서는 Bitwarden 도움말이 생체 인증이 동작하지 않는다고 적는다 [2차 스니펫]. Store 배포를 검토한다면 Hello/Chrome 실행/파일 접근 제약을 먼저 스파이크해야 한다.

### 2.6 권고 요약과 리스크

**권고**: `packages/vault`에 백엔드 인터페이스를 두고 1차 구현은 `@napi-rs/keyring`(Windows `Local` 지속성 고정 확인) + `utilityProcess` 분리. Hello/Touch ID는 2차 마일스톤에서 Rust N-API 헬퍼로. `safeStorage`는 "래핑 키 보관이 필요 없는 메인 프로세스 전용 데이터"에만 보조 사용.

| 리스크 | 영향 | 가능성 | 완화 |
|---|---|---|---|
| 같은 사용자 악성코드가 키체인·프로세스 메모리 읽기 | 비밀번호 유출 | 중 | 2.3의 한계 문서화, Hello 게이트, 보관 최소화, 서명·공증 빌드로 macOS ACL 활용 |
| 인증서 파일(디스크)과 비밀번호(키체인)를 둘 다 저장 | **인증서 완전 탈취**(파일+비번) | 중 | 비밀번호 저장은 옵트인, 기본은 미저장. 저장 시 2.5의 대화형 등급 우선 |
| Windows 자격 증명이 `ENTERPRISE`로 저장되어 로밍 | 다른 PC로 복제 | 하~중 | `Local` 고정, 통합 테스트로 확인 |
| 2,560바이트 초과 저장 시도 | 저장 실패 | 하 | 봉투 암호화, 값 길이 검사 |
| macOS 서명 불일치로 키체인 프롬프트 반복 | UX 악화 | 중 | 개발 빌드도 일관 서명, 업데이트 시 팀 ID 불변 |
| Hello 프롬프트 위장 | 사용자 속임 | 하 | 프롬프트 문구에 작업명·포털명 표기, 프롬프트는 전면 앱 창에서만 |

---

## 3. 공동인증서(NPKI)

### 3.1 디스크 레이아웃

| 항목 | 내용 | 근거 |
|---|---|---|
| Windows 경로 | `C:\Users\<사용자>\AppData\LocalLow\NPKI\` (구형: `C:\Program Files\NPKI\`, XP 시절 위치) | [2차: extrememanual.net] + [공식 소스: PyPinkSign의 탐색 목록 `~/AppData/LocalLow/NPKI/`, `C:/Program Files/NPKI/`] |
| macOS 경로 | PyPinkSign이 순서대로 탐색: `~/Documents/NPKI/`, `~/NPKI/`, `~/Library/Preferences/NPKI/` | [공식 소스] (경로 표준은 KISA `6.1-KCAC.TS.UI` 명세를 따른다고 소스에 적혀 있으나 원문은 열람 실패) |
| 하위 구조 | `NPKI/<CA명>/USER/cn=<이름>…/` 아래 `signCert.der`(공개 인증서), `signPri.key`(암호화된 개인키). CA 폴더 예: `yessign` (`NPKI\yessign\USER`) | [공식 소스: `USER` 아래 `cn=` 접두 디렉터리 순회] + [2차: ai.bznav.com] |
| 이동식 | USB 등의 `\NPKI\` (PyPinkSign은 이동식 저장소 미지원) | [공식 소스 주석] |

### 3.2 개인키 암호화 규격 (`signPri.key`)

구조: DER `EncryptedPrivateKeyInfo`(PKCS#8 계열). 알고리즘 식별자(OID)에 따라 키 유도가 갈린다. 아래는 오픈소스 PyPinkSign 구현에서 읽은 변형이다 [공식 소스].

| OID | 이름 | 키/IV 유도 | 암호 |
|---|---|---|---|
| `1.2.410.200004.1.15` | pbeWithSHA1AndSEED-CBC (PBES1) | **PBKDF1(SHA-1, 비밀번호, 솔트 8바이트, 반복 보통 2048)** → dk 20바이트. 키 = dk[0:16], **IV = SHA-1(dk[16:20])의 앞 16바이트** | SEED-CBC 128 |
| `1.2.410.200004.1.4` | SEED-CBC (구형) | 같은 PBKDF1, 키 = dk[0:16], **IV 고정 `"0123456789012345"`** | SEED-CBC 128 |
| `1.2.840.113549.1.5.13` | PBES2 | **PBKDF2-HMAC-SHA1**(PyPinkSign 구현 기준), 솔트·반복·**명시적 IV**는 ASN.1에서 읽음 | SEED-CBC 128 |

- 복호화하면 PKCS#8 안에 RSA 개인키가 있고, 일부 키에는 **신원확인용 난수 R**(OID `1.2.410.200004.10.1.1.3`)이 속성으로 들어 있다. PyPinkSign은 이를 별도로 보관하며 "없는 경우도 있다"고 적는다 [공식 소스]. 포털이 본인확인(VID)에 R을 쓰므로 **로컬 서명 구현은 R 처리까지 포함해야** 한다 [추론: 필드 용도는 소스 주석과 일반 지식].
- 비밀번호 기반 암호라 **비밀번호가 약하면 파일만으로 무차별 대입이 가능**하다(NPKICracker 같은 도구가 존재) [공식 GitHub]. 신형 인증서의 PRF·암호 변형(SHA-256 PRF, ARIA 등)은 이번에 규격 원문을 열람하지 못해 **확인 불가** — 구현하게 된다면 KISA 규격 원문과 실제 발급 인증서 테스트 벡터로 확정해야 한다. (KISA PDF 링크는 HTML 페이지를 반환해 열람 실패.)

### 3.3 오픈소스 구현

| 프로젝트 | 언어 | 라이선스 | 상태 | 비고 |
|---|---|---|---|---|
| **PyPinkSign** (bandoche) | Python | MIT | v0.5.4 (2025-10-17) 유지 중 | `load_prikey`, `sign`, `pkcs7_signed_msg`, PBKDF1/PBES2, SEED 순수 구현 폴백. 레퍼런스로 가장 좋음 |
| PnPeople.Security (yourtablecloth) | C# (.NET Standard 2.0+) | MIT | 커밋 25개, 소규모 | SEED 암호화 개인키를 .NET `RSA`로 변환 |
| NPKICracker | C/OpenCL | — | — | 비밀번호 무차별 대입 도구. 복호화기 아님 |
| Node/TypeScript | — | — | **완성된 npm 패키지는 확인하지 못함** | 구현한다면 `asn1js` 등 ASN.1 + SEED-CBC(Node `crypto`의 SEED 지원 여부는 미확인) 조합 필요 |

### 3.4 하네스가 개인키를 복호화해야 하는가

**권고 입장: 아니오. 1~2단계에서 하네스는 `signPri.key`를 읽어 복호화하지 않는다.**

| 구분 | 위임(권고) | 로컬 서명(보류) |
|---|---|---|
| 서명 주체 | 포털의 브라우저 모듈/JS | 우리 코드 |
| 하네스가 하는 일 | (a) 인증서가 모듈에 보이게 한다 — 홈택스 **브라우저 인증서 가져오기**는 파일 선택창에 두 파일을 지정하는 일회성 작업이라 `setInputFiles`로 가능해 보인다 [2차·추론] (b) 비밀번호를 모듈 입력칸에 넣거나 사용자에게 넘긴다 | PKCS#7 서명값, VID(R) 처리, 포털별 서명 프로토콜을 직접 구현 |
| 비밀 노출 | 개인키는 우리 프로세스 밖. 우리는 **비밀번호만** 다룸 | 복호화된 RSA 키가 우리 메모리에 존재 → JS로는 영(0)화 불가, Rust 필요 |
| 유지보수 | 포털 모듈 변경에 UI 레벨만 대응 | 포털 서명 규격 역공학·추적 |
| 규제·신뢰 | "보안 모듈 공존"(05 문서)과 일관 | 모듈을 우회한 서명으로 읽혀 운영기관 공문 약속과 충돌할 수 있음 |
| 리스크 | 키보드보안으로 비밀번호 입력 불가 시 핸드오프 | 위 전부 + 법적 해석 |

- 로컬 서명이 정말 필요해지는 경우(예: 모듈 UI가 자동화·핸드오프 모두 불가한데 포털이 웹표준 서명을 받는 경우)에만 **Phase 3 이후, Rust 격리 프로세스**로 구현한다(PyPinkSign 로직 포팅 + 실제 발급 인증서 테스트 벡터 + 영(0)화 처리). 그 전에는 코드 경로를 만들지 않는다.
- 03 문서 4절 표의 "공동인증서 개인키 — 서명 시 로컬 프로세스 메모리"와 플레이북 step 5 주석 "공동인증서 로컬 서명"은 위 입장에 맞게 고친다(7절).
- 홈택스 브라우저 인증서 방식의 세부(저장 위치, 키보드보안 적용 여부, 출력 화면에서의 추가 프로그램 요구)는 전부 [2차]다. 스파이크 S1에서 확인한다.

| 리스크 | 영향 | 가능성 | 완화 |
|---|---|---|---|
| 브라우저 인증서 방식이 중단·변경 | 인증서 로그인 자동화 불가 | 중 | 간편인증 경로 병행, 사용자 핸드오프 |
| 비밀번호+인증서 파일을 우리가 모두 접근 가능한 상태 | 오용 시 전자서명 대행으로 비칠 위험 | 중 | 비밀번호 저장은 옵트인, 서명은 항상 user_gate 이후, 감사 로그 |
| 브라우저 인증서가 전용 프로필에만 있고 프로필 삭제/손상 | 재가져오기 필요 | 중 | 가져오기 재시도 UX, 프로필 백업 금지(비밀 포함) |

---

## 4. Electron 보안 하드닝·배포·플레이북 서명

### 4.1 창·프로세스 설정 (체크리스트)

기본값과 공식 권고 [공식 Electron 보안 문서]

| 항목 | 값 | 비고 |
|---|---|---|
| `nodeIntegration` | false | 5.0부터 기본 |
| `contextIsolation` | true | 12.0부터 기본 |
| `sandbox` | true | 20.0부터 기본. **UI 렌더러에서 끄지 않는다** |
| 권한 요청 | `setPermissionRequestHandler`로 전부 거부(기본은 전부 승인) | |
| CSP | `script-src 'self'` 계열 최소 허용. 문서 예시는 `script-src 'self' https://apis.example.com` | 커스텀 프로토콜(`app://`)로 UI를 서빙하고 응답 헤더로 CSP 설정 |
| 탐색/새 창 | `will-navigate` 차단 + `setWindowOpenHandler`로 기본 거부 | URL은 파싱 비교 |
| `shell.openExternal` | 허용 목록(https)만 | |
| IPC | **발신자 검증**, preload는 좁은 타입 API만 노출(raw `ipcRenderer` 노출 금지) | |
| `file://` | 사용하지 않음 → 커스텀 프로토콜 | `GrantFileProtocolExtraPrivileges` 퓨즈로도 차단 |
| `<webview>` | 사용하지 않음 | |
| Electron 버전 | 최신 유지 | 현재 stable 45.1.0 = Node 24.22.1, Chromium 156 (E11) |

**원격 콘텐츠 0 원칙**: 포털은 전용 Chrome에서만 열고 Electron 창에는 원격 URL을 로드하지 않는다. 클라우드 리포트처럼 원격 렌더가 꼭 필요하면 preload 없는 별도 샌드박스 창.

**프로토콜 핸들러**: 모바일 승인 등에 `app.setAsDefaultProtocolClient`를 쓰면 외부 웹페이지가 호출할 수 있다. 인자는 **무신뢰 입력**으로 취급하고 동사(verb) 화이트리스트 + 사용자 확인 + `requestSingleInstanceLock`으로 단일 인스턴스 처리. macOS는 `Info.plist`에 선언된 프로토콜만 등록 가능, Windows Store 환경은 매니페스트 선언 필요 [공식 Electron app 문서].

**Fuses** (패키징 시 서명 전에 설정) [공식 Electron Fuses]

| 퓨즈 | 권장 | 메모 |
|---|---|---|
| `RunAsNode` | **끔** | `child_process.fork` 불가 → 분리 프로세스는 `utilityProcess` |
| `EnableCookieEncryption` | **켬** | 일방향. Electron 자체 쿠키 저장소 대상(전용 Chrome 프로필과 무관) |
| `EnableNodeOptionsEnvironmentVariable` | 끔 | |
| `EnableNodeCliInspectArguments` | 끔 | |
| `EnableEmbeddedAsarIntegrityValidation` | **켬** | macOS·Windows |
| `OnlyLoadAppFromAsar` | **켬** | 위와 함께 미검증 코드 로드 방지 |
| `LoadBrowserProcessSpecificV8Snapshot` | 선택 | 시작 시간 비용 |
| `GrantFileProtocolExtraPrivileges` | 끔 | `file://` 미사용 시 |

> 퓨즈 변경이 Playwright의 Chrome 기동(자식 프로세스 spawn)에 영향을 주지 않는다는 것은 [추론]이다. 패키지 빌드에서 스모크 테스트로 확인한다.

### 4.2 자동 업데이트와 코드 서명

**Windows**

| 항목 | 내용 | 근거 |
|---|---|---|
| 업데이트 검증 | `electron-updater`(NSIS)는 다운로드한 설치 파일의 **Authenticode 서명 주체(Subject)를 앱에 박힌 `publisherName`과 비교**하고, sha512를 `latest.yml`과 대조한다. 설정 시 **DN 전체**(`CN=..., O=..., C=...`)로 지정 | [공식 electron-builder 문서] |
| 알려진 취약점 | **CVE-2024-39698 / GHSA-9jxc-qjr9-vjxq**: 서명 검증 우회(≤6.3.0-alpha.5), **6.3.0-alpha.6에서 수정**. 공격 전제는 업데이트 매니페스트 탈취 | [공식 OSV]. 현재 npm 최신 `latest` 6.8.11 — 이 이상 사용 |
| 인증서 교체 | Subject가 바뀌면(CA 변경, OV→Azure 이전 등) 기존 설치가 새 서명을 거부한다 → **두 DN을 함께 적은 브리지 릴리스**를 옛 인증서로 먼저 배포해야 함 | [공식 electron-builder key-rotation] |
| 서명된 업데이트 매니페스트 | **Ed25519 서명 매니페스트 + 키 로테이션**이 electron-builder v27 / electron-updater **7.0 알파**(`next` 태그, 7.0.0-alpha.12)에 문서화되어 있다. 안정판 `latest`(6.8.11)의 타입 정의에서는 관련 API를 찾지 못했다 | [공식 문서 + npm dist-tags + 타입 정의 검색] |
| SmartScreen | **EV 인증서는 더 이상 SmartScreen을 우회하지 못한다.** 평판은 파일 해시와 서명 인증서에 쌓이며 "몇 주, 수백 건의 정상 설치"가 걸릴 수 있다. Microsoft 권장 비-스토어 서명 서비스는 **Artifact Signing**(구 Trusted Signing), 월 $9.99부터, 하드웨어 토큰 불필요 | [공식 MS SmartScreen 문서] |
| Artifact Signing 자격 | 공용 신뢰 인증서는 **한국 포함** 미국·캐나다·EU·영국·호주·뉴질랜드·일본·한국·싱가포르·스위스·노르웨이·이스라엘의 **조직**에 제공(개인은 미국·캐나다만). 신원 검증 처리 **1~20영업일**. 한국 중부(`krc`) 엔드포인트 존재 | [공식 MS quickstart] |
| 인증서 수명 | CA/B 포럼 규정으로 공용 코드서명 인증서 최대 유효기간이 2026-03-01부터 **460일**(DigiCert는 459일)이라는 보도. CSC-31 안건 | [2차 검색 스니펫, 미열람] — 연 1회 이상 교체 업무가 생긴다는 전제로 계획 |
| 설치 방식 | 사용자 단위 NSIS(`perMachine:false`)로 UAC 없이 설치·업데이트 | [추론/일반] |
| 설치 후 지연 설치 | 7.0에서 `autoInstallEvent='onNextLaunch'`로 종료 시 설치 중단 위험 완화 | [공식 문서(7.0)] |

**macOS**

- Developer ID 서명 + 공증(notarization) 필요. Electron 문서: Apple Developer Program, Xcode, 인증서 준비; `@electron/osx-sign`, `@electron/notarize`; **서명되지 않은 앱은 `safeStorage`, `autoUpdater`(Squirrel.Mac은 서명 필수) 등이 비정상 동작** [공식 Electron code-signing].
- electron-updater는 macOS에서 `zip` 타깃이 필수(`latest-mac.yml`), Squirrel.Mac이 **같은 Apple Team ID** 서명만 받는다. Team ID를 바꾸면 업데이트로 이어갈 수 없다 [공식 electron-builder].
- Apple 공증 상세(하드닝 런타임, `notarytool`, 스테이플링)는 Apple 문서 본문을 열람하지 못해 이번에는 검증하지 않았다.

**재현 가능한 빌드(reproducible builds)**

- Electron/electron-builder의 비트 단위 재현 빌드를 공식 지원한다는 근거는 찾지 못했다. Authenticode 서명·타임스탬프가 들어가면 서명 후 바이트 동일성은 원리상 불가하다.
- 실측: ASAR 패킹은 mtime에 영향받지 않는 결정적 결과(E9). NSIS 설치기의 결정성은 미확인.
- 권고 목표를 **"검증 가능한 빌드"** 로 낮춘다: 서명 **전** 산출물(`app.asar`) 해시 기록, `npm ci`+락파일 고정, `--ignore-scripts`, SBOM, 그리고 **GitHub Artifact Attestations**(`actions/attest`, 검증은 `gh attestation verify`)로 빌드 출처 증명 [공식 GitHub docs; SLSA 등급 표기는 해당 문서에 없음].

### 4.3 별도 배포 "플레이북 패키지" 서명·검증

위협: 플레이북은 코드에 가깝다. 서명 키 유출·롤백(구버전 재배포)·동결(업데이트 숨김)·부분 교체가 현실적 위협이다. TUF가 막는 공격군은 **freeze, rollback, 신판이지만 최신 아님, 키 유출** 등이다 [공식 TUF 개요].

**권고 아키텍처 (단계별)**

| 단계 | 방식 |
|---|---|
| **P1 (출시)** | "TUF-lite": `playbook-index.json`(Ed25519 서명, **단조 증가 `version`**, `expires`, 패키지별 SHA-256·`min_engine`·`irreversible_steps` 선언) + 패키지(zip). Node 내장 `crypto`의 Ed25519(`sign(null, …)`/`verify(null, …)`)로 검증 — 추가 의존성 없음 [공식 Node crypto]. 클라이언트는 본 최고 `version`을 DB에 저장해 **롤백 거부**, `expires` 지난 인덱스는 **동결로 간주**. 공개키 2개(현재+다음)를 앱에 내장하고 앱 릴리스로 로테이션 |
| **P2 (규모화)** | **정식 TUF**: `root`(오프라인 하드웨어 키, 2-of-3 임계, 만료 1년) / `targets`(포털별 위임, 임계 서명) / `snapshot`(주 단위) / `timestamp`(일 단위; 후자 둘은 CI의 KMS 온라인 키). 클라이언트는 **`tuf-js`**(MIT, 요구 Node `^22.22.2 \|\| ^24.15.0 \|\| >=26` — Electron 45의 Node 24.22.1과 호환 [E11]). 저장소 쪽 도구는 `tuf-js` README에서 클라이언트 전용 여부가 명시되지 않으므로 Python TUF/RSTUF(TUF as a service, OpenSSF 인큐베이팅이라는 2차 정보) 등을 별도 평가 |
| 공통 | 서명 키와 코드서명 키 분리. 서명 이벤트는 투명 변경 로그(공개 저장소/해시 체인)에 기록. **서명됐다고 안전한 것은 아니다** → 엔진이 비가역 단계 user_gate를 강제하고 플레이북은 선언형 DSL(또는 권한 없는 격리 프로세스)로 제한(03 문서 10절 방침) |

전례: electron-builder 7.0도 업데이트 매니페스트를 Ed25519로 서명하고 **신뢰 공개키 목록을 빌드 시 박아 넣으며 "fail closed"** 한다. "키 로테이션 브리지 릴리스"까지 문서화되어 있어 우리 P1 설계와 같은 방향이다 [공식 문서].

### 4.4 리스크 표 (주제 4)

| 리스크 | 영향 | 가능성 | 완화 |
|---|---|---|---|
| 신규 서명 주체의 SmartScreen 경고 | 설치 이탈 | 상 | Artifact Signing 사용 + 베타 배포로 평판 축적, 설치 안내 화면 |
| 서명 Subject 변경으로 업데이트 단절 | 구버전 고립 | 중 | **서명 서비스를 출시 전에 확정**, `publisherName` DN 명시, 브리지 릴리스 절차 문서화 |
| 인증서 460일 주기 갱신 누락 | 서명 실패 | 중 | 캘린더·CI 만료 감시, Artifact Signing은 로컬 인증서 관리 부담 낮음(공식은 아님) |
| electron-updater 7.0이 아직 알파 | 서명 매니페스트 미사용 | 상 | 6.8.x에서 버전 매니페스트 별도 서명 검증(P1 인덱스 방식 확장), 7.0 안정화 추적 |
| 플레이북 서명키 유출 | 악성 플레이북 배포 | 하~중 | 오프라인 root·임계 서명, 키 분리, 만료 짧은 timestamp, 투명 로그 |
| 퓨즈/ASAR 무결성 설정 후 업데이트·서명 순서 오류 | 기동 실패 | 중 | 퓨즈 → ASAR 무결성 → 코드서명 순으로 빌드 파이프라인 고정, 설치본 스모크 |

---

## 5. 로컬 데이터

### 5.1 암호화 SQLite

| 후보 | 상태 | 평가 |
|---|---|---|
| **`better-sqlite3-multiple-ciphers`** | v13.0.3(2026-08-07), MIT. better-sqlite3 포크에 SQLite3MultipleCiphers 결합. 안정판 버전이 better-sqlite3 13.0.3과 일치. 기본 암호 `sqleet`, SQLCipher 호환(`cipher='sqlcipher'`, `legacy=4`). Electron 사전 빌드 ABI는 README에 명시되지 않음 | **권고.** 동기 API(better-sqlite3) 그대로. 업스트림 SQLite3MultipleCiphers가 **1인 개발**이라는 점과 별도 유지 보수자 단일 의존이 리스크 |
| `@journeyapps/sqlcipher` | v6.0.0(2026-04-29), BSD-3 | SQLCipher 정통. node-sqlite3 계열(비동기) 인터페이스. 빌드·Electron 리빌드 부담 평가 필요 |
| 평문 SQLite + 필드 단위 libsodium 암호화 | — | 스키마·인덱스·행 수 노출, 검색 불가. 감사 로그 무결성에만 보조 |

운용 규칙

- **DB 키 32바이트 난수 → OS 키체인**(2절, Windows 한도 내). 키는 `pragma key`보다 **함수형 `key()`/`rekey()`에 `Buffer`** 로 넘겨 문자열 잔존을 줄인다(README가 두 방식을 모두 소개) [공식]. `pragma` 방식은 JS 문자열이 남는다.
- 키 분실=데이터 분실. 사용자 복구 문구(03 문서 4절 "기기 키")와 연동 정책을 정해야 한다.
- 네이티브 모듈이므로 Electron ABI별 사전 빌드 또는 `@electron/rebuild`, 패키징 시 `.node` 파일 `asarUnpack` 처리 [일반 지식, 미검증].

### 5.2 파일시스템 레이아웃과 Controlled Folder Access

Windows CFA 사실 [공식 MS]

- **기본 꺼짐.** 켜면 보호 폴더(`Documents`, `Favorites`, `Music`, `Pictures`, `Videos`와 `Public` 하위)에서 **신뢰되지 않은 앱의 수정·삭제를 차단**한다. OneDrive 폴더 이동(KFM)을 쓰면 이동된 위치가 보호된다.
- 앱 신뢰는 **보급도·평판**으로 자동 판단된다. 신규 서명 앱은 평판이 쌓일 때까지 차단될 수 있고, 차단 시 사용자에게 알림이 뜬다.
- 허용 목록은 사용자/관리자가 설정(Windows 보안 앱, PowerShell, GPO 등). **제품이 이를 대신 변경하지 않는다**(시스템 보안 설정 변경 금지 원칙).

권고 레이아웃

```
%LOCALAPPDATA%\<Product>\            ← CFA 비보호, 로밍 안 됨
    chrome-profile\                   전용 Chrome 프로필 (세션 쿠키 포함 → 민감)
    staging\                          Chrome이 PDF를 떨구는 임시 폴더 (1.6절)
    db\app.db                         암호화 SQLite
    logs\
%APPDATA%\<Product>\                 ← Electron userData 기본(로밍!). 로밍 불가 데이터는 두지 않는다
[사용자 선택 폴더]\서류보관함\…       ← 기본값을 Documents로 두면 CFA 켜진 PC에서 차단 가능
```

- Electron `userData`는 기본이 `appData`(= `%APPDATA%`) + 앱 이름이다 [공식 Electron app 문서]. DB 키는 PC별 키체인에 있으므로 로밍되는 위치에 DB가 있으면 다른 PC에서 못 열린다 → `app.setPath('userData', …LocalAppData…)`로 옮긴다.
- 서류 보관함 기본 위치는 `%LOCALAPPDATA%` 하위 + "내보내기"는 사용자 동작으로, 또는 사용자가 고른 폴더에 쓰다 `EPERM/EACCES`가 나면 **CFA 가능성 안내**(앱 허용 방법 설명)를 띄운다 [추론]. Chrome(`chrome.exe`)이 쓰는 경로는 평판상 신뢰될 가능성이 높아 인쇄 저장 폴더는 스테이징으로 두고 우리 앱이 이후 이동·개명하는 순서를 쓴다 — 단 최종 폴더가 보호 대상이면 우리 앱의 쓰기가 막힐 수 있다 [추론].
- 전용 Chrome 프로필은 로그인 세션을 담으므로 **백업·동기화 제외**, 폴더 ACL은 사용자 전용(기본 `%LOCALAPPDATA%` 상속), BitLocker/FileVault 권장 안내. (Electron `EnableCookieEncryption` 퓨즈는 이 프로필과 무관하다.)

### 5.3 PDF 텍스트 추출 (한글)

| 라이브러리 | 라이선스·상태 | 한글 처리 | 판정 |
|---|---|---|---|
| **`pdfjs-dist`** 6.4.299 | Apache-2.0, 2026-10-03 | 패키지에 `cmaps/`(1.6MB)가 포함되고 **Korean CMap**(`KSC-*`, `KSCms-UHC-*`, `UniKS-*`)이 들어 있음 [실험: 패키지 파일 목록 확인]. Node에서는 `legacy` 빌드, 옵션 `cMapUrl`·`standardFontDataUrl`(끝에 `/` 필요)로 지정 [공식 소스]. 실측: Chrome이 만든 한글 PDF 추출 정상, 공백이 `U+0001` [E6] | **권고** |
| `pdf-parse` 2.4.5 | Apache-2.0, 2025-10 | pdfjs 래퍼 | 직접 pdfjs 사용이 낫다 |
| `unpdf` 1.9.1 | MIT | pdfjs 서버리스 래퍼 | 대안 |
| **`mupdf`** (npm) 1.28.1 | **AGPL-3.0-or-later** | 우수 | **기본 배제.** 폐쇄 소스 배포에는 Artifex 상용 라이선스 필요 |
| `@hyzyla/pdfium` 3.0.0 | MIT, PDFium WASM | 렌더링→OCR 전처리에 유용 | 대안(내용 본문은 미열람, 메타데이터만 확인) |

- **ToUnicode 맵이 없는 글꼴**은 텍스트가 깨진다. 이 경우를 감지(한글 비율·정규식 실패)하면 OCR로 보낸다. 실제 정부24·홈택스 발급 PDF에서 이 비율이 얼마인지는 **샘플 확인 필요**(스파이크 S13, 03 문서 S4와 연결).
- 위치 정보(`getTextContent`의 x,y)로 줄을 재조립해 규칙 기반 파서를 만든다. U+0001 공백은 정규화.

### 5.4 로컬 OCR 폴백

| 선택지 | 내용 | 평가 |
|---|---|---|
| **tesseract.js** 7.0.0 (Apache-2.0, Node ≥16) | `kor` 학습데이터: `tessdata_fast` **1.68MB**, `tessdata_best` **12.5MB** [실험: HEAD 요청으로 크기 측정]. README는 **PDF 직접 입력 미지원**이라고 명시 → 래스터화 필요. `langPath`로 로컬 번들 가능 | 1차 OCR. 앱에 fast를 동봉(오프라인) |
| Windows 내장 OCR (`Windows.Media.Ocr.OcrEngine`) | **설치된 언어 팩**의 언어만 인식(`AvailableRecognizerLanguages`), 최대 이미지 크기 제한 [공식 MS] | 한국어 팩 유무 확인 필요. 네이티브 호출은 N-API/사이드카 |
| macOS Vision (`VNRecognizeTextRequest`) | 한국어 지원은 Revision 3에서 보인다는 포럼·블로그 보고 [2차, 미확인] | 런타임에 `supportedRecognitionLanguages`로 확인 |
| PaddleOCR PP-OCRv5 한국어(ONNX 약 13MB) | 모델 카드의 한국어 데이터셋 정확도 88.0% 표기 [2차] | 정확도 후보이나 Node용 onnxruntime 전·후처리를 직접 이식해야 함 |

권고 단계: `pdfjs 텍스트` → 날짜·유효기간 정규식 검증 실패 시 → 래스터화(pdfjs canvas 또는 pdfium) → `tesseract kor_fast` → 신뢰도 낮으면 OS OCR → 그래도 실패면 사용자 확인. 이미지를 외부 모델로 보내지 않는다(03 문서 5절).

### 5.5 리스크 표 (주제 5)

| 리스크 | 영향 | 가능성 | 완화 |
|---|---|---|---|
| 암호화 SQLite 포크 유지보수 중단 | 보안 패치 지연 | 중 | SQLCipher 형식(`cipher='sqlcipher'`)으로 저장해 이주 가능성 확보 |
| CFA로 서류 저장 차단 | 사용자 불만, 저장 실패 | 중 | 기본 경로를 비보호로, 오류 감지·안내, 시스템 설정 대행 금지 |
| 로밍 프로필에 DB 생성 | 다른 PC에서 열림 불가·키 불일치 | 중 | `userData` 이전, 설치 시 경로 검사 |
| Korean PDF의 ToUnicode 부재 | 발급일 추출 실패 | 중(미확인) | OCR 폴백, 사용자 확인 |
| AGPL 라이브러리 혼입 | 라이선스 위반 | 하 | 의존성 라이선스 CI 검사 |

---

## 6. 사람 속도 입력과 레이트 제한 (위조 없이)

### 6.1 Playwright가 주는 것과 주지 않는 것

| 기능 | 사실 | 근거 |
|---|---|---|
| `locator.fill(text)` | 값을 한 번에 설정. 문서가 **대부분 이것을 쓰라**고 안내 | [공식 class-locator.md] |
| `locator.pressSequentially(text, {delay})` | 글자마다 `keydown`/`keypress`·`input`/`keyup`을 보냄. 문서: "특수한 키보드 처리가 있을 때만" 필요. `delay`는 **고정 ms**(문서 예: 100) | [공식] + E7(한글 정상) |
| `locator.type()` | 폐기(deprecated) | [공식] |
| `slowMo` | 모든 Playwright 연산 사이의 고정 지연(전역) | [공식 타입 정의] |
| 지터(무작위 간격) | **내장 옵션을 찾지 못함.** 글자 루프(`press` + 자체 sleep) 또는 엔진의 `Pacer`로 구현 | [추론: 문서에서 해당 옵션 미발견] |
| 자동 대기 | 클릭·입력 전에 visible / stable / receives events / enabled / editable을 기다림 → 정확성을 위한 임의 `sleep`은 불필요 | [공식 actionability] |

→ **정확성은 자동 대기에 맡기고, 지연은 포털 부하 분산용으로만** 둔다. 불안정한 셀렉터를 고정 sleep으로 덮지 않는다.

### 6.2 05 문서의 타이핑 수치 재검토

Dhakal 외(CHI 2018, 168,000명·1.36억 키입력): 평균 **51 WPM**, 평균 키 간격(IKI) **약 238ms**, 빠른 타이피스트 평균 IKI **약 120ms**(표준편차 11ms), 느린 타이피스트 **480ms 이상** [공식 논문 본문 직접 추출].
05 문서의 "글자당 40~120ms"는 가장 빠른 집단의 평균(≈120ms)이거나 그보다 빠르다. 사람 속도를 표방한다면 **중앙값 약 170ms, 90~260ms 구간의 오른쪽 꼬리 분포**가 현실에 가깝다. 다만 이 수치의 목적은 변장이 아니라 (1) 키 이벤트 핸들러를 가진 칸이 입력을 놓치지 않게 하고 (2) "사람 한 명이 쓰는 만큼" 부하를 맞추는 것이다. 일반 입력칸은 `fill()`로 충분하다(붙여넣기도 사람의 정상 행동).

### 6.3 엔진 레벨 설계

| 구성 | 설계 | 초안 값 (S8에서 조정) |
|---|---|---|
| **Pacer(스텝 간)** | 절단 로그정규 분포 샘플 + "정착 대기"(진행 중 요청 0건 500ms, DOM 변화 없음 300ms) | 중앙값 1.4s, 최소 0.8s, 최대 2.5s (05 문서 범위 유지) |
| **키 간격** | `pressSequentially`를 쓰는 칸에서만. 글자마다 분포 샘플 | 중앙값 170ms, 90~260ms |
| **포털별 동시성** | 단일 비행 락 — DB 행 잠금 + OS 이름 있는 뮤텍스(데몬·UI 이중 실행 방지) | 포털당 1 |
| **토큰 버킷/상한** | 세션당 작업 수, 일일 작업 수를 SQLite 트랜잭션(`BEGIN IMMEDIATE`)으로 영속 관리 | 홈택스 세션 10, 정부24 세션 5, 일일 20 (05 문서) |
| **네트워크 요청 예산** | `page.on('request')`로 포털 오리진 요청을 분당 집계, 초과 시 다음 스텝 지연. UI 클릭 1번이 요청 여러 개를 만들 수 있어 **클릭 수가 아닌 요청 수**로 제한 | 사람이 같은 작업을 할 때 요청 수를 먼저 측정(스파이크) → 그 1.5배 이내 |
| **재시도** | 스텝 2회, 작업 1회(05). 대기시간은 AWS의 **Full Jitter**(`sleep = random(0, min(cap, base·2^n))`) — AWS 글은 작업량 측면에서 Full Jitter가 가장 유리하다고 정리. 구글 SRE 가이드: **요청당 최대 3회, 클라이언트 전체 재시도 비율 10% 이하**, 과부하 시 재시도하지 않음 | base 3s, cap 30s, 재시도 비율 상한 10% |
| **차단·경고 감지** | 차단 안내 페이지, 비정상 접근 경고, 연속 추가 인증 → 즉시 중단 + `cooldown_until` 영속(앱 재시작에도 유지) | 24시간 (05 문서) |
| **스케줄 지터** | 데몬 실행 시작 ±30분 균등. 정각 집중 회피 | 05 문서 |
| **감사** | 샘플된 지연·한도 판정·쿨다운 이유를 비밀 없이 로컬 로그로 남겨 운영기관 소명에 사용 | 05 문서 3절 |

설정 스니펫(예시)

```yaml
pacing:
  step_delay_ms:   { dist: lognormal, median: 1400, sigma: 0.35, min: 800, max: 2500 }
  key_interval_ms: { dist: lognormal, median: 170,  sigma: 0.40, min: 90,  max: 260 }  # pressSequentially 칸만
  settle:          { quiet_requests_ms: 500, quiet_dom_ms: 300 }
limits:
  per_portal:      { concurrent: 1, session_jobs: { hometax: 10, gov24: 5 }, daily_jobs: 20 }
  request_budget_per_min: TBD   # 사람 수행 실측 후 확정
  retry:           { step: 2, job: 1, backoff: full_jitter, base_ms: 3000, cap_ms: 30000, ratio_cap: 0.10 }
  cooldown_on_block_hours: 24
schedule:          { start_jitter_min: 30 }
```

**하지 않는 것(위조·은폐에 해당)**: 마우스 경로 무작위화, 포인터 이동 시뮬레이션, UA·언어·화면 값 변경, 키 이벤트 속성 조작, `navigator.*` 덮어쓰기. 메뉴 호버가 필요한 화면은 명시적 `hover()`로 처리한다.

### 6.4 리스크 표 (주제 6)

| 리스크 | 영향 | 가능성 | 완화 |
|---|---|---|---|
| 지연 분포 자체가 "사람처럼 보이려는 의도"로 오해 | 운영기관 신뢰 | 중 | 공문에 목적(부하 상한)·수치·로그 제공, 설정 화면에 "운영 기준" 공개(05 문서 6절) |
| 수치 과소/과대 설정 | 차단 또는 작업 지연 | 중 | S8(50회 연속 실행)과 요청 예산 실측으로 조정, 캡차 발생률을 보수화 신호로 사용(05 문서 3-1절) |
| 다중 프로세스에서 일일 상한 경쟁 조건 | 상한 초과 | 중 | DB 트랜잭션 + 단일 비행 락, 데몬/UI가 같은 DB 공유 |
| 재시도 폭주 | 포털 부하 | 하 | 재시도 예산, 차단 신호 시 재시도 금지 |

---

## 7. 03 / 05 문서에 대한 수정 제안 (이 파일은 제안만 한다 — 다른 파일은 수정하지 않음)

| 문서·위치 | 현재 서술 | 제안 | 이유 |
|---|---|---|---|
| 03 §2 브라우저 자동화 행 | "탐지 신호가 사람 사용과 같다" | "실제 Chrome·전용 프로필·최소 플래그 구동. Playwright 구동에서는 표준 신호인 `navigator.webdriver=true`가 그대로 노출됨(숨기지 않음)"으로 정정 | E1~E3. 과대 표현은 공문·신뢰에 위험 |
| 03 §2 브라우저 자동화 행 | (구동 방식 미기재) | "최소 플래그 모드: `ignoreDefaultArgs:true` + 파이프 + 전용 프로필 + `--no-sandbox` 없음, `--disable-extensions` 없음" 추가 | 1.1절 |
| 03 §3 step 5 `sign()` 주석 | "공동인증서 로컬 서명 \| …" | "포털 모듈에 위임(브라우저 인증서 가져오기 + 비밀번호 입력/핸드오프) \| 간편인증 PUSH \| …" | 3.4절 |
| 03 §4 표 첫 행 | 개인키 "서명 시 로컬 프로세스 메모리" | 개인키는 하네스가 읽지 않음. 비밀번호만 사용 시점에 메모리. 로컬 서명은 Phase 3 이후 선택지 | 3.4절 |
| 03 §4 구현 규칙 | "별도 프로세스 … 사용 후 0으로 덮어쓴다" | "같은 사용자 악성코드에는 경계가 아님을 명시. JS는 문자열 영(0)화 불가 → 짧은 수명 프로세스 + Buffer 사용, 필요 시 Rust 헬퍼" | 2.3, 2.4절 |
| 03 §4 / §10 위협 모델 | "서명 시 사용자 존재 확인(옵션: Hello/Touch ID)" | "무인 실행과 양립 불가 → 대화형/무인 두 등급으로 구분" | 2.5절 |
| 03 §2 로컬 DB 행 | "SQLite (암호화 확장)" | `better-sqlite3-multiple-ciphers` + 키체인 32바이트 키, DB는 `%LOCALAPPDATA%` | 5.1, 5.2절 |
| 03 §2 배포·업데이트 행 | "코드서명 + 자동 업데이트" | Windows: Artifact Signing 검토(EV 불필요), 서명 주체(DN) 출시 전 고정, `electron-updater` ≥6.3.0-alpha.6, 7.0 서명 매니페스트 추적. macOS: Developer ID + 공증. 플레이북: TUF-lite → TUF | 4.2, 4.3절 |
| 03 §12 스파이크 | S1~S8 | S9~S14 추가(8절) | — |
| 05 §2 표 "입력 타이핑 글자당 40~120ms" | 40~120ms | 일반 칸은 `fill()`. 키 이벤트가 필요한 칸만 90~260ms(중앙값 ≈170ms) | 6.2절 |
| 05 §2 표 "브라우저" 행 | "자동화 전용 플래그·배너를 켜지 않지만…" | "`--enable-automation` 미사용(Playwright ≥1.60 기본). 단 파이프 연결로 `navigator.webdriver=true`" 병기 | 1.2절 |

---

## 8. 추가 스파이크 제안 (03 문서 §12의 S1~S8에 이어서)

| ID | 질문 | 성공 기준 | 비고 |
|---|---|---|---|
| **S1a** | 모드 A(파이프, webdriver=true)와 모드 B(포트, false)로 홈택스·정부24 로그인·조회를 비교했을 때 동작 차이가 있는가 | 차이 없음 또는 차이 원인 규명 | 차이가 있으면 운영기관과 협의, 값 위조 금지 |
| **S1b** | 홈택스 **브라우저 인증서 가져오기**가 전용 프로필에서 `setInputFiles`로 되는가, 비밀번호 칸에 키보드보안이 걸리는가 | 보안프로그램 없이 로그인 완료 / 걸리면 핸드오프로 완주 | 3.4절 |
| **S3a** | Windows 11 Chrome에서 `--kiosk-printing` + 사전 설정이 무대화상자로 저장되는가, 파일명 충돌 규칙 | macOS(E5)와 동일 | 1.6절 b |
| **S3b** | Windows 헤드풀에서 `page.pdf()`가 되는가, 정부24 출력물과 육안·2D바코드 동등성 | 동등 | 1.6절 c |
| **S3c** | 정부24 "전자문서지갑 → PDF 다운로드" 경로가 자동화 가능한가 | 원본 PDF 확보 | 1.6절 a |
| **S9** | 보안모듈 Chrome 확장(웹스토어)을 전용 프로필에 설치했을 때 동작 + 네이티브 메시징(Windows 레지스트리 / macOS 매니페스트 위치) | 로그인 완료 | 1.4절 |
| **S10** | Rust N-API로 Windows Hello(`KeyCredentialManager` 서명→KEK) / Touch ID(Keychain 접근 제어) 결박 프로토타입 | 프롬프트 전면 표시, 봉인·해제 성공 | Bitwarden 구조 참조 |
| **S11** | CFA 켜진 Windows에서 신규 서명 앱의 PDF·DB 쓰기 동작과 사용자 안내 | 오류 감지·안내 | 5.2절 |
| **S12** | Artifact Signing 온보딩(1~20영업일) + 베타 SmartScreen 관찰 | 경고 빈도 측정 | 4.2절 |
| **S13** | 실제 발급 PDF 샘플에서 pdfjs 한글 추출·ToUnicode 부재율 측정 | 규칙 추출 ≥95%(03 S4) | 5.3절 |
| **S14** | 화면 잠금·RDP 끊김·절전 중 헤드풀 Chrome 실행 안정성 | 실패 모드 목록화 | 1.7절 |

---

## 9. 한계와 미검증 항목

1. **모든 실험은 macOS(Darwin 25.5, Chrome 156.0.8078.73)** 에서 수행했다. Windows 동작(특히 `--kiosk-printing`, 네이티브 메시징, Hello, CFA, 인쇄 대화상자)은 미검증이다.
2. 한국 포털(홈택스·정부24)에 실제로 접속해 보지 않았다. 브라우저 인증서 방식, 정부24 전자문서지갑 경로, 키보드보안 적용 범위는 모두 **2차 자료**다.
3. KISA 규격 원문(`KCAC.TS.ENC`, `KCAC.TS.UI`) PDF는 서버가 HTML을 반환해 **열람하지 못했다.** 개인키 암호 변형 정보는 PyPinkSign 소스에서 읽은 것이며, 신형 인증서의 PRF·암호 변형은 확인하지 못했다.
4. Apple 개발자 문서 페이지(공증, `SecAccessControl` 플래그)는 본문이 JS 렌더링이라 **내용을 확보하지 못했다.** macOS Touch ID 결박은 Electron 문서와 `security-framework` 문서로만 근거를 삼았다.
5. CA/B 포럼 460일 규정은 벤더 블로그 스니펫(미열람)이다. 서명 구매 전에 CA 약관으로 재확인할 것.
6. 이 조사의 "한국 법인의 Artifact Signing 가입 가능"은 Microsoft 문서의 국가 목록에 근거한다. 실제 가입 가능 여부(법인 요건, 사업자 등록 유형)는 온보딩 시 확인된다.
7. 레이트 제한 수치(분당 요청 예산 등)는 **미정**이며 사람 수행 실측 후 정해야 한다.

---

## 10. Sources (실제로 열람한 URL)

**Playwright / Chrome / Chromium**

- https://playwright.dev/docs/api/class-browsertype
- https://playwright.dev/docs/api/class-page
- https://playwright.dev/docs/actionability
- https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/chromiumSwitches.ts
- https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/chromium.ts
- https://raw.githubusercontent.com/microsoft/playwright/main/packages/playwright-core/src/server/chromium/crPdf.ts
- https://raw.githubusercontent.com/microsoft/playwright/v1.40.0/docs/src/api/class-page.md (및 v1.49.0, v1.55.0, main 동일 경로) — `page.pdf` 문구 비교
- https://raw.githubusercontent.com/microsoft/playwright/v1.58.0/packages/playwright-core/src/server/chromium/chromiumSwitches.ts (및 v1.40.0 / v1.49.0 / v1.55.0 / v1.59.0 / v1.59.1 / v1.60.0 / v1.62.0 / v1.64.0 동일 경로) — `--enable-automation` 존재 여부
- https://raw.githubusercontent.com/microsoft/playwright/main/docs/src/api/class-locator.md
- 설치한 `playwright-core@1.59.1`, `1.64.1` 패키지 소스(`lib/coreBundle.js`, `types/protocol.d.ts`)
- https://developer.chrome.com/blog/remote-debugging-port
- https://developer.chrome.com/docs/devtools/agents/use-cases/auto-connect
- https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging
- https://developer.mozilla.org/en-US/docs/Web/API/Navigator/webdriver
- https://peter.sh/experiments/chromium-command-line-switches/
- https://raw.githubusercontent.com/chromium/chromium/main/components/policy/resources/templates/policy_definitions/Printing/PrintPreviewUseSystemDefaultPrinter.yaml (및 `DefaultPrinterSelection.yaml`, `PrintingEnabled.yaml`)
- https://gitlab.com/UnicodeLabs/OpenRPA/-/issues/31 (kiosk-printing + Save as PDF 레시피)
- https://learn.microsoft.com/en-us/answers/questions/1689198/configuring-ms-print-to-pdf-for-silent-printing-au
- https://studygov.kr/blog/0339-government24-print-error-fix/
- https://github.com/FlaUI/FlaUI

**한국 보안모듈 / 인증서 / 홈택스**

- https://palant.info/2023/01/09/touchen-nxkey-the-keylogging-anti-keylogger-solution/
- https://palant.info/2023/01/02/south-koreas-online-security-dead-end/
- https://raw.githubusercontent.com/bandoche/PyPinkSign/master/pypinksign/pypinksign.py
- https://raw.githubusercontent.com/bandoche/PyPinkSign/master/README.md
- https://github.com/ied206/NPKICracker
- https://github.com/yourtablecloth/pnpeople.security
- https://extrememanual.net/8861
- https://ai.bznav.com/contents/3263489
- https://funissu.com/hometax-authorization-certificate-login/
- https://hometax.go.kr/html/pp/info/cncInpGdncPop.html

**비밀 저장 / 프로세스 / 생체 게이팅**

- https://www.electronjs.org/docs/latest/api/safe-storage
- https://www.electronjs.org/docs/latest/api/utility-process
- https://www.electronjs.org/docs/latest/api/system-preferences
- https://www.electronjs.org/docs/latest/api/app
- https://github.com/Brooooooklyn/keyring-node
- https://github.com/atom/node-keytar
- https://docs.rs/keyring/latest/keyring/
- https://raw.githubusercontent.com/open-source-cooperative/windows-native-keyring-store/main/src/utils.rs (및 `cred.rs`)
- https://docs.rs/security-framework/latest/security_framework/passwords/struct.PasswordOptions.html
- https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentiala
- https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata
- https://learn.microsoft.com/en-us/uwp/api/windows.security.credentials.ui.userconsentverifier
- https://learn.microsoft.com/en-us/windows/uwp/security/microsoft-passport (Windows Hello 문서로 리다이렉트)
- https://github.com/bitwarden/clients/tree/main/apps/desktop/desktop_native
- https://raw.githubusercontent.com/bitwarden/clients/main/apps/desktop/desktop_native/biometric/src/windows.rs
- https://raw.githubusercontent.com/bitwarden/clients/main/apps/desktop/desktop_native/process_isolation/src/lib.rs
- https://raw.githubusercontent.com/bitwarden/clients/main/apps/desktop/desktop_native/secure_memory/src/lib.rs
- https://doc.libsodium.org/memory_management
- https://github.com/holepunchto/sodium-native
- https://nodejs.org/api/buffer.html
- https://nodejs.org/api/crypto.html

**Electron 보안 / 배포 / 서명**

- https://www.electronjs.org/docs/latest/tutorial/security
- https://www.electronjs.org/docs/latest/tutorial/fuses
- https://www.electronjs.org/docs/latest/tutorial/code-signing
- https://raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/auto-update.md
- https://raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/signed-update-manifests.md
- https://raw.githubusercontent.com/electron-userland/electron-builder/master/website/docs/features/key-rotation.md
- https://osv.dev/vulnerability/GHSA-9jxc-qjr9-vjxq
- https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- https://github.com/theupdateframework/tuf-js
- https://theupdateframework.io/docs/overview/
- https://repository-service-tuf.readthedocs.io/en/latest/
- https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
- https://electronjs.org/headers/index.json (Electron 버전별 Node/Chromium)
- npm 레지스트리 메타데이터: https://registry.npmjs.org/<패키지명> — `@napi-rs/keyring`, `keytar`, `better-sqlite3-multiple-ciphers`, `better-sqlite3`, `@journeyapps/sqlcipher`, `sodium-native`, `pdfjs-dist`, `pdf-parse`, `mupdf`, `tesseract.js`, `electron-updater`, `tuf-js`, `@primno/dpapi`, `unpdf`, `@hyzyla/pdfium`, `@electron/fuses`, `electron`, `@noble/ed25519`, `sigstore`

**로컬 데이터 / 문서 처리 / OCR**

- https://github.com/m4heshd/better-sqlite3-multiple-ciphers
- https://learn.microsoft.com/en-us/defender-endpoint/controlled-folders
- https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions
- https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/api.js
- https://github.com/naptha/tesseract.js
- https://github.com/tesseract-ocr/tessdata_fast/raw/main/kor.traineddata (HEAD로 크기 측정) 및 `tessdata_best` 동일 경로
- https://learn.microsoft.com/en-us/uwp/api/windows.media.ocr.ocrengine

**사람 속도 / 레이트 제한**

- https://userinterfaces.aalto.fi/136Mkeystrokes/
- https://www.pokristensson.com/pubs/DhakalEtAlCHI2018.pdf (본문 직접 텍스트 추출)
- https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
- https://sre.google/sre-book/handling-overload/

### 부록 A. 열람하지 못했거나 본문을 얻지 못한 URL (참고용, 근거로 쓰지 않음)

- 검색 결과 스니펫으로만 확인: Chromium extensions PSA(`--load-extension` 제거, groups.google.com), CA/B Forum 460일(encryptionconsulting.com, sslinsights.com, DigiCert KB), Doyensec의 electron-updater 2020 분석, Apple Vision 한국어 포럼 글, PaddleOCR 한국어 모델 카드(huggingface.co), Microsoft 지원 문서 "Print to File without user intervention".
- 열람 실패/본문 없음: `rootca.kisa.or.kr/.../2.3-KCAC.TS.ENC.pdf`(HTML 반환), `damoang.net/development/618`(403), Apple 개발자 문서 2건(JS 렌더링), Microsoft 커뮤니티 허브 Artifact Signing GA 글, `chromeenterprise.google/policies`(본문 없음), Bouncy Castle `KISAObjectIdentifiers` javadoc(404).
