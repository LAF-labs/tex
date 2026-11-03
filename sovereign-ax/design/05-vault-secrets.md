# D05. 금고와 비밀 처리

> AUDIT-D 반영 2026-11-03: 사람 비밀 등급을 칸 단위·TPM 결박 KEK·Windows 세션 추종 금고·엄격 모드 Hello로 정합(§2·§7, ADR-026), PDF 열기 암호·DB 키 유실 규칙(§2), 쿠키 헤더·MHTML·다운로드 경로·Crashpad·개시 조건 재검사·창 상태 머신·1회용 비밀 TTL·`secret.needed`·trigger 허용 목록·T-06 OS 프레임(§3.3~§3.8), kind↔칸 결박(§4), 실사용 누출 트립와이어(§8)(ADR-025·026·029, D19 §3.5).
> 2026-11-02 — ADR-020 결정 2·3 반영(outreach/06 §3 #4·#5·#18): 공동·금융인증서 비밀번호는 저장·자동 입력하지 않고, 보안카드 번호와 보안카드 경로의 홈택스 아이디·비밀번호는 **위임** 등급(AES-256-GCM 암호문, 열쇠는 DPAPI·자격 증명 관리자, Windows Hello에는 결박하지 않음)으로 둔다. 아래 v1.2의 '보안카드 칸 단위 저장'을 대체한다. 위임 등급의 저장 방식(JSON 묶음·DPAPI)은 바로 위 줄의 ADR-026이 다시 대체한다(공동·금융인증서 비밀번호를 저장·자동 입력하지 않는 규칙은 그대로).
> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영: 중계 CDP 기본 거부 허용 목록과 세션 범위 제한, 비밀 오염 프레임의 응답 정리, **비밀 창**(타이피스트·`human:secret`·`fillFromRemote` 공통), `browser.launch()` 인자 제거, 전용 프로필 `Preferences` 기록·확인, 확장 허용 목록, 비밀별 키체인 등급, 금고 키 연산(`noiseDH`·`signVd`·`hpkeOpen`), 덤프·로그 위생 수단 명시. 원자적 타이핑은 Phase 2, 고수준 브로커는 Phase 3 ADR 예약(ADR-005 v3).
> v1.2 — Review B(research/REVIEW-B-security.md) 반영: 금고가 Chrome 파이프의 단독 소유자, 엔진은 토큰 보호 중계 CDP, 비밀 입력 전용 창, 금고 전용 키 `Kv`와 인증 봉인, 보안카드 칸 단위 저장, 과장 문구 정정.

## 1. 목표와 정직한 범위

- 비밀(인증서 비밀번호, 포털 비밀번호, 보안카드 번호표, 기기 키, BYOK 키)이 평문으로 존재하는 장소를 **금고 프로세스 하나**로 제한한다.
- 비밀이 화면에 입력될 때도 엔진 프로세스를 거치지 않는다(비밀 타이피스트). 사용자가 직접 입력하는 구간(`human:secret`)과 폰에서 온 비밀(`fillFromRemote`)도 같은 **비밀 창** 규칙으로 보호한다(§3.5). (A-06)
- **정상 경로 약속**: 침해가 없는 정상 실행에서는 평문 비밀이 엔진 힙에 들어오지 않는다. 요청 바디(`postData`), 접근성 트리·DOMSnapshot 값, 스크린샷이 모두 이 약속의 대상이며, 금고 중계가 엔진에 전달하기 **전에** 지운다(§3.4). 엔진 안에서 받은 뒤 거르는 방식은 이 약속을 지키지 못한다. (A-02, A-04)
- **범위**: 이 설계는 평문이 엔진의 힙·로그·크래시 덤프·모델 페이로드에 남지 않게 하는 **위생 장치**다. 같은 OS 사용자의 악성코드나 엔진 RCE에 대한 **경계가 아니다**. 엔진이 침해되면 그 실행 중에 입력된 비밀은 DOM 되읽기로 노출될 수 있다(구체적으로는 비밀 창의 **오염 상태**에서 `Runtime.evaluate`로 칸 값을 읽는 경로, §3.5). 이 문장은 D00·D01·D08·D11·README와 사용자 고지에 같은 표현으로 들어간다.
- **T2 완화(경계가 아님을 전제로 기준을 올리는 수단)** (감사 A §4 결론): 엔진에 대해서는 중계 허용 목록·응답 정리·비밀 창(Phase 1), 원자적 타이핑(Phase 2), 고수준 브로커 검토(Phase 3). 같은 사용자 악성코드에 대해서는 기기 결박 KEK(오프라인 복호 차단)·Windows 세션 추종 금고·엄격 모드 Hello(ADR-026), 데몬의 사람 비밀 미사용, docparse 샌드박스로 무클릭 경로 제거. 금고가 열린 동안의 무음 사용은 막지 못한다. 이 문장은 D11 T2 '완화' 칸과 같은 표현을 쓴다. 생체 결박은 "같은 사용자 악성코드의 **무음** 키체인 읽기 완화"이며 DOM 되읽기에는 효과가 없다. (A/C-11)
- **금고는 오라클이 된다**: 장기 개인키는 금고 밖으로 나가지 않지만, 침해된 엔진은 금고에 허용 목록 안의 연산(Noise DH·`Vd` 서명·HPKE 개봉)을 **요청**할 수 있다. 금고는 용도 문자열 허용 목록·호출 감사·횟수 이상 탐지로 남용을 좁힐 뿐 막지 못한다. 키 유출(영구 사칭)을 연산 남용(침해 기간 한정)으로 바꾸는 것이 이 구조의 효과다. (C-19)
- **범위 밖**: 관리자·SYSTEM·커널 권한 공격자는 모든 통제를 무력화하며 이 설계의 대상이 아니다. 대외 문구에서 이를 암시하는 표현을 쓰지 않는다. (A-31)
- 사용자가 저장을 원하지 않으면 저장하지 않고도 모든 작업이 돌아간다(매번 입력).

## 2. 비밀 목록과 정책

등급 (A-22, C-22, ADR-026)
- **사람 비밀(세션 결박)**(ADR-020의 '위임', 저장 방식은 ADR-026): 사용자가 발급을 맡기려고 한 번 등록한 사람 비밀이다. 보안카드 번호와, 보안카드를 발급 인증으로 고른 경우의 홈택스 아이디·비밀번호가 여기에 든다. 공동·금융인증서 비밀번호는 저장하지 않으므로 이 등급에 없다(ADR-020 결정 2). 칸 단위 항목(`securitycard/<profile>/<row>`, `portal/<profile>/id`·`pw`)을 슬롯 KEK로 암호화한다. 슬롯 KEK는 이 PC TPM의 내보낼 수 없는 키(Microsoft Platform Crypto Provider, UI 정책 없음)로 래핑하고, TPM이 없으면 DPAPI(CurrentUser)로 대신한다. Hello가 Available인 PC는 Hello 결박 래핑 사본을 하나 더 둔다(ADR-026, D-01(N-07)).
- 금고 열림 = Windows 세션 열림 ∧ 시스템 유휴 < `vault.idleLockSec`(900) ∧ 열린 지 < `vault.unlockMaxSec`(28800). 화면 잠금·절전·사용자 전환·원격 세션 전환이면 즉시 잠그고 슬롯 KEK를 지운다. Windows 잠금 해제는 사람 확인이므로 프롬프트 없이 다시 연다. 유휴 잠금 뒤에는 Hello 사본 또는 Windows 잠금·해제로만 다시 연다(ADR-026, D-01(N-07)).
- 엄격 모드(설정 '발급마다 Windows Hello 확인')는 TPM 무프롬프트 래핑을 지우고 발급마다 Hello 사본을 연다(`vault.unlockTtlSec = 300`). 승인 바 Hello와 금고 Hello는 한 번의 프롬프트로 합친다(ADR-026, D-01(N-07)).
- **대화형 전용**: 꺼낼 때마다 Windows Hello 확인이 필요한 비밀(Hello 결박 KEK 암호문, 유효 시간 `vault.unlockTtlSec`). Phase 1에는 이 등급에 드는 사람 비밀이 없고, Phase 2의 AIK가 쓴다.
- **무인**: 앱 내부 키. 사용자 존재 확인 없이 금고가 꺼낸다. 데몬은 사람 비밀을 쓰지 않는다. 금고가 `trigger` 허용 목록(`local`·`remote`)으로 집행한다(A-23, ADR-025·026, D-01(N-07), D-48(N-77)).
- 발급 1회에 요청된 칸만 복호한다. 포털의 명시적 인증 실패(`auth_failed`) 1회 뒤 그 kind·scope는 `vault.credential_suspect`이며, 사용자가 금고 창에서 확인·수정하기 전에는 타이피스트가 다시 넣지 않는다(ADR-026, D-19(N-25)).
- 데몬이 사람 비밀을 쓰지 않으므로 보안카드 사용자의 Phase 2 승인형 갱신은 아이디 로그인과 보안카드 칸을 폰 봉인 입력(`fillFromRemote`)으로 채워야 한다(D10 §6). 금고가 열린 동안 같은 Windows 사용자 권한의 악성코드가 금고에 사용을 요청하는 것은 막지 못한다(엄격 모드에서만 줄어든다). 등록 화면에서 이를 고지한다.

| 비밀 | 등급 | 저장 기본값 | 저장소 | 사용 주체 | 로그 |
|---|---|---|---|---|---|
| 공동인증서 개인키 파일(`signPri.key`, PBKDF1+SEED-CBC 또는 PBES2) | —(저장 안 함) | 저장 안 함(원위치 참조) | 사용자 NPKI 폴더 | 포털 서명 모듈(브라우저). **하네스는 파일을 열지 않는다**(§6) | 남기지 않음(§6 (5)) |
| 공동·금융인증서 비밀번호 | —(저장 안 함) | **저장하지 않는다.** 저장 기능을 두지 않는다(ADR-020 결정 2). 공동·금융인증서 비밀번호 칸은 가상키패드·키보드 보안으로만 받으므로 앱이 넣으려면 보안 모듈을 우회해야 한다 | — | 사용자가 브라우저 창에 직접 입력(`human:secret`, 비밀 창 (b)). 타이피스트는 입력하지 않는다 | `human.*`(값 없음) |
| 포털 아이디·비밀번호 | **사람 비밀(세션 결박)** | 보안카드를 발급 인증으로 고른 경우에만 금고 창(08 T-06)에서 한 번 등록한다(보안카드는 아이디 로그인 때만 쓸 수 있다, ADR-020 결정 2). 다른 발급 인증에서는 저장하지 않는다 | 칸 단위 항목 `portal/<profile>/id`·`pw`(슬롯 KEK 암호문, TPM 결박 또는 DPAPI) | 타이피스트(아이디 로그인) | 〃 |
| 보안카드 번호표 | **사람 비밀(세션 결박)** | 보안카드를 발급 인증으로 고르면 금고 창(08 T-06)에서 30개 번호를 한 번 등록한다(ADR-020 완전 위임. 사진으로 채우면 Windows 기본 OCR로 금고 안에서 숫자만 읽고 사진은 바로 지운다). PoC-3에서 보안카드 칸이 가상키패드로 확인되면 미저장·사용자 직접 입력 | **칸 단위 항목**(`securitycard/<profile>/<row>`, 각 항목 슬롯 KEK 암호문(AES-256-GCM, AAD = 항목 이름), ≤ 2,560B). DB에는 두지 않는다 | 타이피스트(해당 칸만) | 칸 번호만 |
| 간편인증 | — | 저장 없음 | 사용자 폰 | 사용자 | — |
| 기기 장기 키(`Sx`, `Vx`, `Qx`), 금고 키 `Kv` | 무인 | 저장 | 키체인 | 금고. **개인키는 금고 밖으로 나가지 않는다**. 엔진은 §5.1 연산만 요청 (C-19) | 연산 감사(용도·횟수) |
| AIK 개인키 | **대화형**(Hello 결박 래핑 키로 암호화, 사용할 때마다 사용자 존재 확인) — **Phase 2**. Phase 1은 무인 저장이며 잔여 위험으로 적는다 | 저장 | 키체인 | 금고. 기기 추가·폐기·삭제·KEK 회전 때만. **데몬은 AIK를 쓰지 않는다** (C-22) | 연산 감사 |
| `KEK_N`, `K_idx`(사업자 HMAC, Phase 2부터 업무 키 표시, ADR-024), `K_audit`(RK 파생) | 무인(백업 큐가 무인으로 돈다) | 저장 | 키체인. RK는 복구 문구가 아니라 첫 PC가 무작위로 만들고, 래핑 사본은 페어링된 폰과 사용자가 고른 두 번째 PC에만 둔다. `K_chk`는 없다(ADR-016 v2·ADR-029, D-16(N-09)). ADR-024 결정 6이 열어 둔 RK 보관 방식은 ADR-029 결정 1로 정했다 | 금고 | — |
| DB 암호화 키 | 무인 | 저장 | 키체인 → `getDbKeyOnce()`로 엔진에 금고 기동당 1회 전달 | **엔진 하나**(DB 소유 프로세스). main 스케줄러·렌더러 감사 로그 뷰는 엔진의 **읽기 전용 IPC 질의**(`db.query.*`)를 쓰고 키를 갖지 않는다 (A-24) | 두 번째 호출 = 보안 이벤트 `vault.dbkey_requested_twice`. 키 항목이 없는데 `db\db.sqlite`가 있으면 새로 만들지 않고 `db.key_missing`, 길이가 다르면 덮어쓰지 않고 `vault.keystore_mismatch`로 기동을 거부한다. 회전은 `PRAGMA rekey` 트랜잭션 + WAL 체크포인트이며 원장 HMAC 키는 회전 대상이 아니다(키체인 루트 키에서 별도 info로 파생)(ADR-029, D-22(N-30)) |
| BYOK API 키 | 무인 | 저장(옵트인) | 키체인 → `net/egress` 모듈 메모리(엔진 프로세스 안). 평문이 엔진에 있다는 사실을 문서화. **Phase 2**: 금고가 키를 보관하고 egress에는 호출 단위로 서명된 요청을 만들어 주는 방식을 검토 (B-21) | egress | — |
| 계정 토큰 | 무인 | 저장 | 키체인 → main/egress | | — |
| `K_store`(보관함 파일별 DEK 래핑, **Phase 2**) | 무인 | 저장 | 키체인 | 엔진(D07 §1) | — |
| PDF 열기 암호 | 낮음 | 미저장 | 작업당 docparse 창 메모리 | docparse | 남기지 않음 — 메인 렌더러 입력 허용, 파일당 5회 틀리면 선택을 닫는다(ADR-026, D-42(N-31)) |

상수(금고 바이너리 내장, 정책·플레이북으로 바꿀 수 없음) (A-22)
- `vault.unlockTtlSec = 300` — 엄격 모드에서 Hello 확인 1회로 사람 비밀을 꺼낼 수 있는 시간. 실행이 끝나면 즉시 잠근다.
- `vault.idleLockSec = 900`, `vault.unlockMaxSec = 28800` — 금고 유휴 잠금·최대 열림 시간(ADR-026).
- `vault.secretTtlMs = 300000` — 1회용 비밀 보관 상한(§3.8, ADR-025). `vault.humanSettleMs = 1500` — 사람 입력 창 종료 조건 (나)의 정착 시간(§3.5).
- `vault.credPersist = LOCAL_MACHINE` — Credential Manager 지속성. 로밍(`ENTERPRISE`)을 쓰지 않는다. 이름과 달리 사용자 범위 항목이며, 통합 테스트로 고정한다. `@napi-rs/keyring`의 기본값과 바이트 API 유무는 **S10b**에서 확인하고, 불가하면 Rust 헬퍼로 대체한다.
- `vault.helloPromptShowsTaskAndPortal = true` — Hello 프롬프트에 작업명과 포털명을 표시한다. Hello 프롬프트는 진짜 창의 구별 단서로 쓰지 않는다(Hello 없는 PC가 있다, ADR-026). 등록 창은 OS 프레임으로 구별한다(§3.8). 비패키지 앱에서 `KeyCredentialManager` 키 범위·프롬프트 전면 표시·TTL 구현은 **S10 보강**에서 확인한다.

저장 화면 고정 문구: ~~(REVIEW-B A-8) "인증서 파일과 비밀번호가 같은 PC에 함께 있으면 악성코드 한 번에 인증서 전체가 넘어갑니다."~~ 인증서 비밀번호를 저장하지 않으므로(ADR-020 결정 2) 이 문구는 쓰지 않는다. 보안카드 등록 화면(08 T-06)은 ADR-020 결정 3의 고지(같은 Windows 사용자 권한의 악성코드는 막지 못한다)를 쓴다.

## 3. 프로세스 구조: 금고가 Chrome을 소유하고, 중계는 기본 거부다 (ADR-005 v3)

금고 프로세스가 Chrome을 `--remote-debugging-pipe`로 띄우고 파이프의 단독 소유자가 된다. `--remote-debugging-port`는 **사용 금지**(정책 상수·린트). 포트가 있으면 같은 PC의 다른 OS 계정·인포스틸러가 로그인된 포털 세션을 조종할 수 있다. 엔진은 금고가 중계하는 CDP만 쓴다. **허용 목록 없이 엔진을 샌드박스에 넣는 것은 의미가 없다**(엔진이 사용자 권한 Chrome을 통해 밖으로 나간다). 이후 모든 격리의 전제가 이 절이다.

### 3.1 기동 (A-08)

- `browser.launch()`는 **인자가 없다**. 엔진은 프로필 경로·기동 플래그·CDP 엔드포인트를 지정할 수 없다. 호출 주체는 엔진 포트로 한정한다.
- 금고 바이너리 상수:
  - `vault.chromeProfileDir = %LOCALAPPDATA%\SovereignAX\chrome-profile`
  - `vault.chromeArgs`(허용 목록, 이 밖의 인자는 붙이지 않는다): `--remote-debugging-pipe`, `--user-data-dir=<vault.chromeProfileDir>`, `--no-first-run`, 그리고 S3a 결과에 따라 `--kiosk-printing`.
- 기동 전 확인: 경로가 상수와 같다, 경로의 어느 구성 요소도 재분석 지점(심볼릭 링크·정션)이 아니다, 폴더 ACL이 사용자 전용(소유자 + SYSTEM, 상속 차단)이다. 하나라도 어긋나면 기동하지 않는다. Chrome 136+가 기본 데이터 폴더를 명시 경로로 받았을 때 파이프 디버깅을 거부하는지는 **S6j**에서 확인한다(확인과 무관하게 위 규칙으로 막는다).
- Chrome 자식 프로세스 환경 변수는 화이트리스트로 정리한다(디버그·로깅·프록시 관련 변수 제거).

### 3.2 전송 (A-09)

- 정책 상수 `relay.transport ∈ {messageport, ws_fallback}`, 기본값 `messageport`(Electron `MessagePort`).
- `ws_fallback`은 **S6b가 MessagePort 위 Playwright 불가를 증명한 경우에만** 허용한다. 쓸 때의 규칙: `127.0.0.1` 무작위 포트, `/json` 디스커버리 없음, 256비트 경로 토큰은 **MessagePort로만** 전달(명령줄·환경 변수·파일·로그 금지), 첫 연결 1건 수락 후 리스너 종료, `Origin` 헤더가 있는 요청과 `Host ≠ 127.0.0.1:<port>` 요청 거부, 실행 종료 시 폐기.

### 3.3 중계 허용 목록과 세션 범위 (A-01, A-12, A-13)

- 금고 중계는 **기본 거부 허용 목록**이다. 아래 상수는 금고 바이너리에 내장하고 플레이북·운영 정책으로 바꿀 수 없다. 최소 집합은 **S6b**가 확정하며, 그 전까지 아래가 초기값이다.
  - `relay.allowedDomains = [Page, Runtime, DOM, Accessibility, Input, Network(이벤트 수신·읽기 전용), Fetch(커밋 가드용, `manifest.commitEndpoints` 패턴에 한함), Emulation(포커스 관련만), Log]`
  - `relay.deniedMethods ⊇ {Target.createBrowserContext, Target.exposeDevToolsProtocol, Target.attachToBrowserTarget, Target.setAutoAttach, Browser.*, Storage.*, SystemInfo.*, Tracing.*, IO.*, Page.setDownloadBehavior, Network.getAllCookies, Network.getCookies, Network.getResponseBodyForInterception, Network.streamResourceContent, Page.captureSnapshot, Page.getResourceContent, DOMSnapshot.getSnapshot}`
- `Network.getCookies`·`getAllCookies`는 전부 거부한다. `Network.*ExtraInfo`·`requestWillBeSent`·`responseReceived`의 `Cookie`·`Set-Cookie`·`Authorization` 헤더와 `associatedCookies`·`blockedCookies`·`exemptedCookies`·`headersText`는 제자리에서 지운 뒤 넘긴다. `Network.getResponseBody`·`Fetch.getResponseBody`는 허용 목록에 없고 `Network.getResponseBodyForInterception`·`Network.streamResourceContent`는 거부한다(ADR-025, D-33(N-51)).
- **세션 범위**: 엔진은 금고가 이번 실행을 위해 만든 page 타깃과, 그 타깃이 연 허용 origin 팝업의 세션에만 붙는다. **브라우저 타깃 세션은 엔진에 노출하지 않는다.** `Target.setAutoAttach`는 금고만 호출하고, 결과 세션 중 허용 origin만 엔진에 전달한다.
- **사용자 탭 비노출**: 사용자가 연 탭(엔진이 만들지 않았고 허용 팝업도 아닌 탭)은 엔진에 노출하지 않는다.
- **origin 재집행**: 금고는 엔진에 노출된 각 타깃의 현재 origin이 `내장 eTLD+1 ∩ manifest.domains` 안에 있는지 **매 문서 커밋마다** 확인한다. 벗어나면 그 타깃의 엔진 세션을 분리하고 `vault.origin_left`를 기록한다. 엔진의 이동 감시는 버그 조기 발견용으로 남기되, 집행 주체는 금고다(Chrome 수준 네트워크 제한이 아니라 금고 중계 재집행이다). (A/C-14)
- **다운로드·인쇄 경로**: 저장 폴더는 금고가 상수 `%LOCALAPPDATA%\SovereignAX\staging\`로 설정한다. 엔진의 `Browser.setDownloadBehavior`·`Page.setDownloadBehavior`는 거부한다. staging의 파일은 docparse 샌드박스(ADR-014)를 거쳐 보관함으로 옮긴 즉시 삭제하고, 기동 시 잔존 파일을 정리한다(D07 §1). 금고는 전용 프로필 Preferences에 `download.default_directory`·`savefile.default_directory` = `staging\`, `download.prompt_for_download = false`를 기록·검증하고, 금고 세션에서 `Browser.setDownloadBehavior{behavior:'allow', downloadPath: staging, eventsEnabled:true}`를 건다. 엔진에는 `download.completed{fileId}` 이벤트만 간다(Phase 1, ADR-025, D-29(N-45)).
- 거부된 호출은 엔진에 오류로 돌려주고 보안 이벤트 `vault.cdp_denied{method}`(인자 없음)를 남긴다.
- **(Phase 1) 커밋 본문 대조 R-C1** (B-03, E-02): 엔진이 무장할 때 보내는 `commit.arm{intentId, stepId, endpoint, bodyFieldMap, expectedHash}`를 받아, 금고가 그 커밋 요청의 본문을 `bodyFieldMap` 순서로 정규화·해시해 `expectedHash`와 비교하고 엔진에는 `{match: true|false|opaque}`만 돌려준다. `false`면 금고가 요청을 중단한다(`Fetch.failRequest`). 본문은 엔진에 가지 않으므로 §3.4의 바디 제거와 충돌하지 않는다. 본문이 보안 모듈로 암호화되어 있으면 `opaque`이고 대조할 수 없다(D03 §5.4).
- **(Phase 2) 커밋 가드 이전** (A-03): 커밋 엔드포인트 Fetch 인터셉트와 무장 근거 검증까지 금고 중계로 옮긴다. 금고는 무장 근거를 엔진의 주장이 아니라 (a) 폰의 `Sign_Vm("SAX-approve-v1"‖…‖actionHash‖decision)` 또는 (b) main 승인 바(ADR-021)가 발급한 `LocalApproval{runId, gateStepId, reqId, approvalNonce, actionHash, exp, presence}`로 직접 검증하고(Phase 1에는 검증하는 쪽이 없고 엔진이 main↔엔진 전용 포트의 출처만 믿는다), 근거 하나당 요청 1회와 `commitWindowMs`를 집행한다. 본문 대조는 Phase 1부터 금고가 하지만 본문이 `opaque`면 불가하므로, 그 경우 이 장치는 **승인 없는 발급의 횟수**만 제한한다.

### 3.4 응답 정리: 정상 경로에서 평문이 엔진에 들어오지 않게 (A-02, A-04)

- **비밀 오염 범위**(E-18): 비밀 창(§3.5)이 열린 프레임, 그 하위 프레임, **그 부모 프레임들, 같은 탭의 워커(전용·공유·서비스 워커)**. 오염은 비밀 창의 활성 상태와 오염 상태(§3.5) 내내, 곧 해당 프레임의 다음 문서 커밋까지 유지한다.
- **요청 바디 제거**: 비밀 오염 범위(부모 프레임·워커 발신 요청 포함)에서 시작된 요청에 대해, 엔진으로 가는 `Network.requestWillBeSent`·`Fetch.requestPaused` 이벤트의 `postData`·`postDataEntries`·`hasPostData`를 제거하고, 엔진의 `Network.getRequestPostData`·`Fetch.getRequestPostData`를 거부한다. 측정은 **S6c**(테스트 사업자 계정, 정부24 제외, 보안 모듈 동작 분석 없음).
- **값 필드 제거**: 금고는 자기가 입력한 노드, `human:secret`(`openForHuman`)과 `fillFromRemote`의 대상 노드의 `backendNodeId` 목록과 모든 `type=password` 노드에 대해 `Accessibility.*`·`DOMSnapshot.captureSnapshot`·`DOM.describeNode` 응답의 값 필드를 지운 뒤 엔진에 전달한다. Chrome 156에서 값이 실리는 필드 위치는 **S6d**에서 측정한다. D06의 마스킹 계층은 이 **중계 필터 통과본만** 입력으로 받는다(D06 §8 사전조건).
- **스크린샷 거부**: 오염 노드가 값을 가진 동안 해당 타깃의 `Page.captureScreenshot`·`Page.startScreencast`는 거부한다.
- **`Runtime` 결과 정리(오염 상태, 시도)**: 오염 상태에서 엔진의 `Runtime.evaluate`·`Runtime.callFunctionOn` 요청 중 대상 노드의 `value`에 접근하는 거부 목록 패턴(`.value`, `getAttribute('value')`, `FormData`, `innerText` 직렬화 등)을 금고가 차단 **시도**한다. 패턴 차단은 우회될 수 있으므로 경계가 아니다(§3.5 정직 문구).
- 오염 상태의 `Runtime` 표현식 거부 패턴은 엔진의 고정 화면 확인 식(SHA-256 `712e7330…598944`) 하나만 정확 일치로 면제한다. 알려진 값 치환은 오염 상태 동안의 보조 위생 장치이며 변환 표현식에 우회된다. 변형 목록은 타깃별로 두고 창 종료(커밋·분리)와 `run.end`에서 지운다(ADR-025, D-13(N-20), D-49(N-78)).

### 3.5 비밀 창(secret window) (A-06)

- 비밀 창은 다음 중 하나가 시작될 때 금고가 연다: (a) 타이피스트 입력(`typist.fill`), (b) `human(kind=secret)`(사용자가 가상키패드 등으로 직접 입력하는 구간, 홈택스 공동인증서 기본 경로), (c) `fillFromRemote`.
- 비밀 창은 **두 상태**로 나뉜다(E-01).
  - **① 활성 창**(금고가 타이핑 중이거나 사용자가 직접 입력 중): 금고는 대상 타깃에서 엔진의 `Input.*`·`DOM.focus`·`Target.activateTarget`·`Emulation.*`·`Page.captureScreenshot`·`Page.startScreencast`·`Accessibility.*`·`DOMSnapshot.*`, 그리고 **대상 프레임의 `Runtime.*`**(`evaluate`·`callFunctionOn`·`getProperties` 등) 명령을 거부하고, `Runtime.bindingCalled`·`Runtime.consoleAPICalled` 이벤트를 엔진에 전달하지 않는다. (a)에서는 `Input.setIgnoreInputEvents(true)`로 사용자 입력도 잠깐 막는다((b)는 사용자가 입력해야 하므로 막지 않는다).
  - 활성 창의 **종료 조건**(하나라도): (가) 금고 타이핑 완료, (나) `human:secret`에서 사용자가 "입력 완료"를 누르거나, 'blur + 값 있음이 1.5초(`vault.humanSettleMs`) 동안 값 길이·포커스 변화 없이 유지'됨을 금고가 확인(D-53(N-47)), (다) 해당 프레임의 문서 커밋 또는 대상 노드 분리, (라) 엔진의 `secret_window.close` 요청에 대해 금고가 대상 노드의 포커스 해제를 확인한 뒤 승인. 엔진은 `secret_window.closed{ok}`만 받는다(값·길이 없음). 엔진의 `secretWindow.requestClose`는 human 창만 닫을 수 있다. 창 개시 검사는 원자적이다(같은 타깃에 열린 창이나 여는 중인 창이 있으면 거부, ADR-025, D-28(N-43)).
  - **② 오염 상태**(활성 창 종료 후 그 프레임의 다음 문서 커밋까지): 엔진의 `Input.*`은 다시 허용한다(로그인 버튼 클릭 가능, SPA 로그인의 교착 방지). 응답 정리(§3.4: 요청 바디·AX/DOMSnapshot 값 제거, `Runtime` 결과 중 대상 노드 `value` 접근의 거부 목록 패턴 차단 시도)는 유지한다.
- **개시 조건**(하나라도 어긋나면 열지 않고 `{ok:false, reason:'secret_window_refused'}`): 전용 프로필 `Preferences` 확인 일치(§3.6), 확장 허용 목록 일치(§3.6), 전용 프로필에 Google 로그인 없음(§3.6), 실행의 `trigger ≠ daemon`(타이피스트 한정, §4), (Phase 2) 비밀 origin에 엔진이 등록한 문서 스크립트·바인딩 없음(§4.1).
- `Page.captureSnapshot`·`Page.getResourceContent`·`DOMSnapshot.getSnapshot`은 상시 거부한다. 오염 상태의 `Runtime.getProperties`는 비밀 노드에서 나온 objectId의 값 항목만 지운다(Phase 1)(ADR-025, D-17(N-12)).
- `human:secret`의 IR 의사 노드는 엔진이 직접 관찰하는 노드가 아니라 **금고 경유 합성 노드**다(D02 §4.3과 같은 정의).
- 비밀 창은 보안 모듈·가상키패드의 동작을 분석하거나 조작하지 않는다. 금고는 엔진이 받는 CDP 메시지만 줄인다. 통과 기준은 **S6f**(아래 정직 문구 끝 참조).
- **정직 문구**: 오염 상태에서 침해된 엔진은 `Runtime.evaluate`로 비밀 칸 값을 읽을 수 있다(거부 목록 패턴은 우회 가능하다). 창이 열리기 전에 심어 둔 페이지 스크립트가 수집한 값을 나중에 읽는 경로도 Phase 1에서 막지 못한다. 이것이 §1 범위 문구의 실체이며, Phase 2 원자적 타이핑(입력 → 제출 → 대상 노드 분리까지 활성 창 유지, §4.1)이 이 창을 닫는다. 통과 기준 S6f는 "활성 창 동안 엔진이 받은 CDP 메시지(`Runtime` 응답 포함) = 허용 목록"이다.

### 3.6 전용 Chrome 프로필 (A-10, A-11, A-27)

- **Chrome 정책(레지스트리)은 쓰지 않는다.** 정책은 프로필 단위가 아니라 사용자의 일상 Chrome 전체에 걸리고, "시스템 설정을 바꾸지 않는다"는 원칙과 충돌한다. 금고는 매 기동 전에 전용 프로필의 `Preferences`에 `credentials_enable_service=false`, `profile.password_manager_enabled=false`, `autofill.profile_enabled=false`, `autofill.credit_card_enabled=false`를 기록하고, 기동 후 값을 다시 읽어 확인한다. 불일치면 비밀 창을 열지 않는다(`vault.profile_prefs_mismatch`). 이것은 사용자 측 설정이며 포털이 보는 값을 바꾸지 않으므로 위조·은폐가 아니다. `Preferences` 기록만으로 저장 제안·자동완성·동기화가 실제로 꺼지는지는 **S6e**에서 확인한다.
- 비밀 창 개시 조건(Preferences·확장·Google 로그인)은 창을 열 때마다 다시 확인한다. 거부하면 `secret_window.refused{reason}`를 엔진과 main에 보낸다(ADR-025, D-12(N-18)).
- **동기화**: 전용 프로필에서 Google 계정 로그인을 감지하면 비밀 창을 거부하고 로그아웃을 안내한다. `--disable-sync` 스위치의 현재 효과는 **S6e**에서 확인한다(허용 목록에 넣지 않는다).
- **확장 허용 목록**: 금고는 기동 시 전용 프로필의 설치 확장 ID를 읽어 내장 허용 목록 `vault.extensionAllowlist`(보안 모듈 공식 확장 ID, 앱 업데이트로만 갱신)와 비교한다. 목록 밖 확장이 있으면 비밀 창을 열지 않고 사용자에게 제거를 안내한다. 파일(`Secure Preferences`·Extensions 폴더)로 신뢰성 있게 열거할 수 있는지와 공식 확장 ID 목록은 **S6i**. 설치 안내는 운영기관 공식 배포처만 가리킨다.
- **종료 시 정리**: 금고가 `Network.clearBrowserCache`와 허용 origin별 `Storage.clearDataForOrigin(cache_storage, service_workers …)`을 실행한다(엔진에는 거부된 `Storage.*`를 금고 자신은 쓴다). 쿠키는 `keep_session=0`이면 함께 지운다. 이것은 사용자 데이터 정리이며 감사 로그는 남는다.
- `keep_session` 기본값은 **꺼짐(0)**이다(사용자가 켤 수 있음, D07 DDL `DEFAULT 0`, A/C-01).
- **Chrome 자체 보고**: 기동 전 `Local State`의 사용 통계·크래시 보고 설정을 끔으로 기록하고 확인한다(사용자 측 설정). Chrome 인자에 `--disable-breakpad`를 넣는다. 금고는 기동 전·종료 시 `<profile>\Crashpad\`를 지우고 `vault.chrome_dump_removed{count}`를 남긴다(ADR-025, D-07(N-04)). 전용 `user-data-dir`의 기본값은 **S6e**에서 확인한다.
- **S1b 사본**: S1b(브라우저 인증서 가져오기)를 채택하면 암호화된 인증서 사본은 홈택스 origin 저장소에만 있다. 사용자가 '브라우저 인증서 삭제'를 누르거나 앱을 제거할 때 지운다. 종료 시 캐시 정리 대상에서 해당 저장소 종류는 제외한다.

### 3.7 허용 목록과 자기 점검

- 엔진에는 포털 eTLD+1 **내장 허용 목록**(hometax.go.kr, gov.kr, 간편인증·서명 모듈 도메인)을, 금고에는 **비밀 종류별 origin 허용 목록**을 둔다. 둘 다 앱 업데이트로만 바뀐다(서명키 유출 시 피해 반경 제한, D11 T1). 집행은 §3.3의 금고 재집행이 최종이다.
- 기동 자기 점검: 금고가 `about:blank`에서 `navigator.webdriver === true`를 확인하고, 거짓이면 자동화를 거부한다(ADR-010을 연결 방식 변경이 깨지 않게 함).

### 3.8 인터페이스

```ts
interface VaultAPI {
  unlock(reason: string): Promise<void>;                        // 사람 비밀: Windows 세션 추종(§2). 유휴 잠금 뒤·엄격 모드는 Hello 사본(Rust N-API), TTL vault.unlockTtlSec
  // 저장: 전용 입력 창(금고와 직결된 MessagePort)에서만 호출된다. main·renderer 본체는 평문을 중계하지 않는다
  store(kind: SecretKind, scope: ProfileId, consent: ConsentRecord): Promise<SecretHandle>;   // 값은 전용 입력 창에서 금고로 직접 온다. 보안카드는 칸별 항목 `securitycard/<profile>/<row>`로 저장(세션 결박 등급, ADR-026)
  forget(handle: SecretHandle): Promise<void>;
  has(kind: SecretKind, scope: ProfileId): Promise<boolean>;
  browser: { launch(): Promise<void>; relayPort(): MessagePort; shutdown(): Promise<void>; };   // launch 인자 없음 (A-08)
  typist: {
    fill(req: {runId: string; targetId: string; frame: FrameId; element: ElementLocator; secret: {kind: SecretKind; scope: ProfileId; row?: number}; slot: {secretKind: SecretKind; purpose: 'login'|'sign'}}):
      Promise<{ok: boolean; reason?: 'denied'|'not_found'|'blocked_by_module'|'origin_not_allowed'|'not_secret_slot'|'secret_window_refused'|'secret_missing'}>;
    fillFromRemote(req: {sealed: Uint8Array; reqId: string}): Promise<{ok: boolean}>;   // 폰에서 온 인증 봉인문, 비밀 창 (c)
    newVaultChallenge(reqId: string): Uint8Array;                                         // human.request에 실어 보냄
  };
  secretWindow: {
    openForHuman(req: {runId: string; targetId: string; frame: FrameId; element: ElementLocator}): Promise<{ok: boolean; reason?: 'secret_window_refused'|'origin_not_allowed'}>;  // 비밀 창 (b)
    requestClose(req: {runId: string; targetId: string}): Promise<{ok: boolean}>;   // 활성 창 종료 요청 — 금고가 대상 노드 포커스 해제를 확인한 뒤 승인 (§3.5 (라))
    // 엔진은 'secret_window.closed{ok}' 이벤트만 받는다
  };
  commitGuard: {
    arm(req: {runId: string; intentId: string; stepId: string; endpoint: string; bodyFieldMap: Record<string, string>; expectedHash: string}): Promise<{armed: boolean}>;   // R-C1 (§3.3)
    // 결과는 'commit.body_compared{intentId, stepId, match: true|false|opaque}' 이벤트로만. 본문은 엔진에 가지 않는다
  };
  crypto: VaultCrypto;                                          // §5.1
  getDbKeyOnce(): Promise<Uint8Array>;                          // 금고 기동당 1회. 2회째는 거부 + vault.dbkey_requested_twice (A-24)
}
```

규칙: 어떤 메서드도 평문 비밀을 반환하지 않는다(`getDbKeyOnce` 예외는 앱 내부 키). 타이피스트·비밀 창은 `engine` 포트에서만, `store`는 전용 입력 창 포트에서만 호출 가능. 엔진은 CDP 엔드포인트·프로필 경로·기동 인자를 **지정할 수 없다**(인자 자체가 없다).

비밀 입력 포트와 트리거 규칙(ADR-025·026·029):
- `secretInput` 포트는 main이 `{runId, kind, scope, row?}`와 함께 넘긴다. 금고는 그 포트의 `secret.provide`를 그 값으로 고정해 1회만 받고 포트를 닫는다. `kind`는 `SECRET_ORIGINS` 키만 받는다. 1회용 비밀은 5분(`vault.secretTtlMs`) 또는 `run.end`에서 0으로 덮어 지우고 `secret.expired{runId, kind}`를 보낸다. 타이피스트가 비밀이 없으면 `secret.needed{runId, targetId, kind, scope, row?}`를 main에 보낸다(D-15(N-44)).
- `run.begin.trigger`는 `local|remote|daemon` 밖이면 거부한다. `typist.fill`은 `local`·`remote`만 허용하고, `remote`는 엔진이 넘긴 시작 게이트 통과 플래그가 있을 때만이다(D-48(N-77), D-34(N-13)).
- T-06 등록 창은 OS 프레임·제목줄(`금고 · 보안카드 등록`)이 있는 별도 최상위 창이다. 앱 본체에는 main이 그리는 덮개 뷰만 둔다. 렌더러 번들은 `type=password` 입력과 `sx-secret-*` 클래스를 쓸 수 없다(lint)(ADR-026, D-03(N-11)).

## 4. 비밀 타이피스트

1. 엔진이 `secret_fill`에 도달하면 Actuator에서 **비밀 창 개시 허가 1회**(`kind:'secret_window'`)만 받고, `targetId`·프레임·요소 로케이터·비밀 종류를 금고에 넘긴다. 키마다 허가를 받지 않는다(엔진·저널이 비밀 길이를 알게 되므로). (A-26, A/C-04)
2. 금고는 자기 파이프 세션으로 요소를 찾아 다음을 **모두** 확인한다: 실행의 `trigger ∈ {local, remote}`(그 밖·없음은 `denied`, `remote`는 시작 게이트 통과 플래그 필요, A-23·ADR-029), 현재 프레임 origin이 비밀 종류의 허용 목록 안, 요소가 `type=password` 그리고 셀렉터 사전 항목의 `secretKind`가 요청 비밀 종류와 같음, 요소가 `activeElement`, 보안카드면 `row`가 화면에서 읽은 값과 일치, §3.5 개시 조건. 하나라도 어긋나면 입력하지 않는다.
3. 비밀 창(활성) 개시 + `setIgnoreInputEvents(true)` → `Input.dispatchKeyEvent`로 글자 단위 입력 → 키 입력마다 `activeElement`·`type` 재확인 → 완료 후 입력 차단 해제, 활성 창 종료 → 오염 상태(§3.5 ②)로 전환. 글자 간격은 금고가 실행 시작 때 받은 `policy.pace.*.keyEventDelayMs`(초기값 150ms)로 **스스로 집행**한다. '사람 수준'이라는 표현은 쓰지 않는다. 엔진·저널·텔레메트리에 비밀 길이를 기록하지 않는다(`secret.used{kind, viaTypist}`에 길이 필드 없음). (A-26)
4. 비밀 버퍼는 즉시 0으로 덮는다(`sodium_memzero`). Phase 1에서 생기는 문자열 사본의 한계는 §8에 적는다. 글자 단위 변환을 Rust 헬퍼로 옮기는 것은 Phase 2(금고 별도 실행 파일과 함께).
5. 엔진은 `{ok, reason}`과 `secret_window.closed{ok}`만 받는다.

제약:
- 홈택스 브라우저 인증서 모드는 **가상키패드 필수**다. 키로거 방지 장치이므로 타이피스트가 대신 누르지 않는다 → `human:secret`(사용자 직접, 비밀 창 (b)). 커널 드라이버 기반 키보드 보안(nxKey 계열) 칸도 합성 입력이 닿지 않을 가능성이 높다(S1b 확인). 따라서 홈택스 공동인증서 경로는 **매번 사용자가 비밀번호를 입력**하고, 간편인증 PUSH는 폰 승인이다. 타이피스트의 실제 가치는 포털 비밀번호·보안카드 등 모듈 없는 칸에 있다.
- 보안카드는 칸마다 별도 `secret_fill`로 나눈다(한 스텝에서 여러 칸 금지).
- `typist.fill`은 요청 비밀 종류와 셀렉터 사전 항목의 `secretKind`가 같고 `secretPurpose`(login·sign)가 그 흐름일 때만 입력한다. 실행당 종류별 1회(보안카드는 칸별 1회)를 `runId`로 집행한다(ADR-026, D-30(N-46)).
- 보안카드 입력칸이 가상키패드로 확인되면 위임을 보류하고 사용자 직접 입력(`human:secret`)으로 바꾼다(ADR-020 조건, PoC에서 확인).
- 데몬 실행(`trigger:'daemon'`)은 키체인에 저장된 비밀을 쓰지 않는다. 로그인은 간편인증 PUSH 또는 폰 봉인 비밀(`fillFromRemote`, 라이브 세션)만 쓴다(D10 §6). (A-23)

### 4.1 되읽기·사전 스크립트 완화 단계 (A-07)

| 단계 | 내용 | 시점 |
|---|---|---|
| (a) **원자적 타이핑** | 활성 창을 입력 → 제출 → 대상 노드 분리까지 유지해 §3.5의 오염 상태 되읽기 창을 닫는다. `secret_fill`에 선택 필드 `submitWith`(셀렉터 사전의 `role=button`, `commits:false`, 로그인·확인 전용 `secretSubmit:true` 항목)를 둔다. 금고는 비밀 창 안에서 입력 → `submitWith` 클릭 → 대상 노드 분리 또는 문서 커밋까지 엔진 명령을 보류한다. 페이지가 남아 있으면 칸 값이 비워졌는지 확인한다. 비밀 창을 열기 전에 금고는 이번 실행에서 엔진이 등록한 문서 스크립트·바인딩 목록(중계를 지나갔으므로 금고가 안다)을 점검해, 비밀 origin에 등록된 것이 있으면 개시를 거부한다(`vault.preinjected_script`). 정책 상수 `relay.denyOnSecretOrigins = [Page.addScriptToEvaluateOnNewDocument, Runtime.addBinding]`. Playwright 호환성은 **S6b**. 격리 월드 리스너 등 잔여 경로는 확인 필요 | **Phase 2** (채택) |
| (b) **고수준 동작 브로커** | 엔진은 원시 CDP를 받지 않고 `click(stableId)`·`fill(stableId, value)`·`readback(fieldKey)`·`snapshot(scopeId)`만 요청한다. Playwright는 무권한 드라이버 프로세스로 옮긴다. ADR-001 재검토 필요. 엔진 AppContainer/Low IL 분리와 함께 검토 | **Phase 3**, 별도 ADR 예약 |
| (c) 수용 | §1 문구 유지 | (a) 채택 전까지의 상태 |

사용자 고지 문구(§1 범위 문장)는 (a) 채택 후에도 바꾸지 않는다.

## 5. 폰에서 온 비밀 (라이브 세션 전용)

- 금고 전용 키 `Kv`(X25519, 금고가 생성, 기기 밖으로 안 나감). `Vd`로 서명해 `PAIR_OK`·`HELLO`로 폰에 배포하고 연 1회 회전.
- 봉인: 폰 전용 키로 **인증 모드**(HPKE Auth 또는 `crypto_box`)로 봉인하고, AAD = `{pair_id, runId, stepId, reqId, vaultChallenge, exp, origin, secretKind}`. `vaultChallenge`는 **금고가** 만들어 `human.request`에 실어 보내고 1회 사용 후 폐기한다. `crypto_box_seal`(익명 봉인)은 쓰지 않는다.
- 금고는 챌린지·exp·origin·secretKind가 현재 프레임·허용 목록과 맞을 때만 입력한다. 입력은 비밀 창 (c) 안에서 한다(§3.5). 침해된 엔진이 과거 봉인문을 재생해도 챌린지가 맞지 않아 거부된다.
- 큐 금지: 비밀·캡차 답은 오프라인 의도 봉투에 넣지 않는다(D08 §7).
- 폰 쪽: 비밀 입력란은 스크린샷 차단, 클립보드 금지, 자동완성 금지, 저장 옵션 없음.

### 5.1 금고 키 연산 (C-19)

장기 개인키(`Sd`, `Vd`, `Q_D`, `Kv`, AIK)는 **금고 밖으로 나가지 않는다**. 엔진(`net/egress`의 Noise 세션·봉투 처리)은 아래 연산을 금고에 요청한다.

```ts
interface VaultCrypto {
  kvPublic(): PublicKey;
  noiseStatic(): PublicKey;
  noiseDH(remotePub: PublicKey, ctx: 'SAX-pair-v1'|'SAX-session-v1'): SharedSecretHandle;   // 정적키 DH만, 결과는 핸드셰이크 상태에 바로 쓰인다
  signVd(purpose: VdPurpose, msg: Uint8Array): Signature;                                   // purpose ∈ vault.vdPurposes
  hpkeOpen(enc: Uint8Array, ct: Uint8Array, info: 'SAX-env-v1', aad: Uint8Array): Uint8Array; // Q_D로 의도 봉투 개봉(비밀 봉투는 큐 금지)
  signAik(purpose: AikPurpose, msg: Uint8Array): Promise<Signature>;                        // Phase 2: 매 호출 Hello 확인, trigger=daemon이면 거부 (C-22)
  wrapDEK(dek, blobId, kekVer): Wrapped;
  unwrapDEK(w, blobId): DEK;
}
```

- **용도 문자열 허용 목록**: `vault.vdPurposes`는 금고 바이너리 상수이며 D08이 정의한 서명 문맥(`Kv` 배포, 우편함 번들, 감사 체크포인트, 인덱스 레코드 서명, 정적키 교체 등)만 담는다. 목록 밖 `purpose`는 거부한다. 서명 대상은 `purpose‖msg`로 도메인 분리한다. 목록의 정본은 D08 §2.1(서명·MAC 용도 컨텍스트 표)이다.
- **호출 감사**: 연산별 호출 횟수·용도를 금고 감사 로그에 남기고, 실행당·시간당 기대치를 넘으면 보안 이벤트 `vault.crypto_rate_anomaly`를 남긴다.
- 한계: 금고는 오라클이 된다(§1). 침해된 엔진은 침해 기간 동안 허용 용도 안의 서명·개봉을 요청할 수 있다. 키 자체는 유출되지 않으므로 침해 종료 후 영구 사칭은 막는다.

용도 문자열 정본(D08 §2.1): `vdPurposes` = {`SAX-qbundle-v1`, `SAX-ckpt-v1`, `SAX-docrec-v1`, `SAX-consent-v1`(로컬), `SAX-dpop-v1`, `SAX-rotate-v1`, `SAX-kv-v1`}, `AikPurpose` = {`SAX-devlist-v1`, `SAX-revoke-v1`, `SAX-cert-v1`, `SAX-aik-rotate-v1`, `SAX-kek-v1`, `SAX-acct-op-v1`}. `hpkeOpen`의 aad는 `"SAX-env-v1"‖mbx_epoch`(D08 §7). 레코드 무결성 키 `K_meta`는 v1.3에서 삭제되었다(레코드는 `Vd` 서명).

## 6. 공동인증서(NPKI) 입장

- 하네스는 개인키 파일을 **열지 않는다**. 서명은 포털 모듈이 한다. 하네스는 인증서 선택까지만 하고, 공동·금융인증서 비밀번호는 **사용자가 브라우저 창에 직접 입력**한다(`human:secret`, ADR-020 결정 2). 타이피스트는 인증서 비밀번호를 입력하지 않는다(가상키패드가 없는 칸이어도 같다). 로컬 서명은 Phase 3 이후 Rust 옵션으로만 검토.
- **허용 동작 목록**(이 밖의 NPKI 접근은 없다) (A-28):
  1. NPKI 디렉터리 열거.
  2. `signCert.der`(공개 인증서)만 읽어 주체·만료를 표시한다. **파싱은 docparse 샌드박스에서** 한다(ADR-014). LocalLow는 낮은 무결성 프로세스도 쓸 수 있는 위치이므로 파일 내용을 비신뢰 입력으로 다룬다.
  3. `signPri.key`는 열거만 하고 열지 않는다. S1b에서는 사용자 동작으로 파일 선택 칸에 경로를 넘길 뿐 내용을 읽지 않는다.
  4. NPKI 경로는 파일 감시 대상이 아니다.
  5. 경로·파일명은 텔레메트리·모델·로그로 보내지 않는다.
- S1b(브라우저 인증서 가져오기)는 인증서 **파일을 업로드 칸에 넣는 동작**이다. 이는 "파일을 연다"가 아니라 사용자의 파일을 포털에 전달하는 것이며, 비밀번호는 여전히 사용자가 입력한다. 사본 처리는 §3.6.
- 누출 스캐너(D13 §6)는 "`signPri.key` 열기 0회(파일 접근 감사)"를 확인한다.

## 7. OS 저장소

| OS | 저장 | 보호 | 한계 |
|---|---|---|---|
| Windows | Credential Manager(`@napi-rs/keyring` v2.1.x, 지속성 `vault.credPersist=LOCAL_MACHINE`), 항목당 ≤ 2,560B | 사용자 로그온 자격 증명에 바인딩. **사람 비밀 항목은 슬롯 KEK 암호문만** 저장하고, 슬롯 KEK는 TPM 내보낼 수 없는 키로 래핑(없으면 DPAPI), Hello PC는 Hello 결박 사본(서명-챌린지 → KEK)을 더 둔다(ADR-026) | 같은 사용자의 다른 프로세스가 항목을 읽을 수 있다. TPM 래핑 항목은 다른 기기에서 열 수 없지만, 금고가 열린 동안의 금고 메모리 읽기와 TPM 없는 PC의 DPAPI 복호는 남는다 |
| macOS | Keychain(`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, 동기화 금지) | 코드서명 기반 ACL(Electron fuses 전제), Touch ID 결박 옵션 | 동일 |

`keytar`는 아카이브됨, Electron `safeStorage`는 메인 프로세스 전용이라 부적합. 등급 배정은 §2 표가 정본이다. 확인 스파이크: **S10 보강**(`KeyCredentialManager` 키 범위·프롬프트 전면 표시·TTL), **S10b**(`@napi-rs/keyring` 지속성 기본값·바이트 API). TPM 무프롬프트 키·Hello KeyCredential·세션 잠금 이벤트(WTS)는 **S10c**에서 확인한다. 불가하면 DPAPI 폴백과 등록 화면 고지 문구로 간다(ADR-026, D-01(N-07)).

## 8. 메모리·로그·덤프 위생

- **비밀 버퍼**: 비밀은 `Uint8Array`/네이티브 버퍼로만. 문자열·JSON 직렬화 금지(린트 `no-secret-stringify`). (Phase 1) 금고 비밀 버퍼는 `sodium_malloc`(가드 페이지, mlock 시도)으로 만들고, 네이티브 헬퍼로 `WerRegisterExcludedMemoryBlock`을 호출해 WER 덤프에서 뺀다. (A-20)
- **Phase 1 한계** (A/C-09): 위 규칙은 우리 코드에 대한 규칙이며, Phase 1 구현에서는 **키체인 읽기**(`@napi-rs/keyring`의 문자열 API, S10b 결과에 따라)와 **CDP JSON 메시지**(`Input.dispatchKeyEvent`의 `text` 필드 직렬화)에서 JS 문자열 사본이 생긴다. 이 사본은 0으로 덮을 수 없고 GC 전까지 금고 힙에 남는다. 엔진 힙에는 생기지 않는다.
- **(Phase 2) 금고 분리**: 금고를 Electron 밖 별도 실행 파일(Rust)로 분리해 Crashpad·WER·메모리 잠금을 자체 설정하고 위 문자열 사본을 없앤다. utilityProcess에서 Crashpad 제외 가능 여부·`WerRegisterExcludedMemoryBlock` 효과·비용 비교는 **S6g**.
- **덤프 정책** (A/C-03): 금고는 크래시 덤프 생성을 비활성화한다. **엔진·main의 덤프는 로컬 생성도 사용자 요청 시에만, 업로드는 금지**한다(DB 키·토큰·PII 포함 가능). 옵트인으로 보낼 수 있는 것은 **힙 없는 구조화 오류 보고**(오류 코드·모듈·버전·스택 프레임 이름, 메모리 내용 없음)뿐이다. D11·D07·03 문서의 덤프 문구는 이 문장에 맞춘다.
- 최대 절전 파일·페이지 파일에 비밀 페이지가 남을 수 있다. 잔여 위험으로 적는다(mlock은 시도일 뿐 보장이 아니다).
- **로그** (A-21): 로그 포맷터는 `SecretBytes`를 `[secret]`로 치환한다. 그러나 포맷터는 라이브러리 내부 프로토콜 로깅을 잡지 못하므로, **릴리스 빌드에서 금고·엔진 CDP 클라이언트의 프로토콜 로깅 코드 경로를 제거**한다(빌드 플래그). 런타임 환경 변수로 켤 수 없다. 로그는 `%LOCALAPPDATA%\SovereignAX\logs`에 결과 코드와 ID만 남기고 14일 보존(`log.retentionDays=14`). 진단 내보내기 전에 누출 스캐너 규칙(테스트 패턴 + 인코딩 변형)을 로컬에서 실행하고, 형식 기반 2차 검사(D12 §5)를 더한다.
- **비밀 입력 창·등록 창(T-06)** (A-30): `setContentProtection(true)`(Windows 캡처 제외 표시 속성), 입력란 `autocomplete=off`·`spellcheck=false`, 입력 즉시 `TextEncoder`로 바이트화한 뒤 입력란을 비움, 창을 닫을 때 DOM 제거. 화면 녹화 도구·원격 지원 도구의 기본 캡처를 줄일 뿐 단호한 악성코드는 막지 못한다.
- **클립보드** (A-32): 금고는 비밀을 클립보드에 쓰지 않는다. 앱이 클립보드에 쓰는 모든 값(D17 복사 버튼)은 같은 쓰기에 기록·클라우드 제외 형식(`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory=0`, `CanUploadToCloudClipboard=0`)을 포함한다. Electron에서 사용자 정의 형식을 같은 쓰기로 넣을 수 있는지는 **S6l**, 불가하면 네이티브 헬퍼.
- **누출 스캐너**(D13 §6)는 글자 단위 CDP 메시지·IPC 캡처·클립보드·전용 프로필 디스크에 더해 **엔진이 받은 CDP 이벤트 스트림(요청 바디 포함)**을 본다(A-02). S6 통과 기준에 다음을 넣는다: "다른 OS 사용자 계정에서 CDP 접속 불가", "엔진이 지정한 엔드포인트로 금고가 접속하지 않음(인자 없음)", "브라우저 타깃·`Storage` 도메인 호출 시 거부 + `vault.cdp_denied`", "비밀 창 활성 상태의 엔진 수신 메시지(`Runtime` 응답 포함) = 허용 목록"(S6f).
- 금고는 비밀 사용 직후 그 값의 변형으로 `logs\`·`staging\`을 스캔해 건수만 `vault.leak_scan{files, findings}`로 남긴다(PoC 빌드). 알려진 값 치환이 적중하면 `secret_window.leak_suspected{hits}`를 엔진·main에 보내 실행을 멈춘다. 전용 Chrome의 로컬 크래시 덤프는 만들지 않고 남은 것은 지운다(ADR-025, D-11(N-17), D-07(N-04)).
- **금고 보안 이벤트**(D16 등록 교차 요청): `vault.cdp_denied`, `vault.origin_left`, `vault.profile_prefs_mismatch`, `vault.extension_not_allowed`, `vault.google_signin_detected`, `vault.secret_window_refused`, `vault.preinjected_script`(Phase 2), `vault.dbkey_requested_twice`, `vault.crypto_rate_anomaly`, `vault.secret_window_close_denied`, `vault.chrome_dump_removed`, `vault.leak_scan`, `secret_window.leak_suspected`, `secret_window.refused`, `vault.secret_input_unbound`, `vault.keystore_mismatch`, `vault.credential_suspect`(AUDIT-D). 모두 인자·값 없이 코드와 타깃 ID만 남긴다.

## 9. 동의와 투명성

- 저장 시점 UI(보안카드 등록, 08 T-06): 무엇을, 어디에, 왜 저장하는지 + 저장하지 않는 선택지(발급 인증을 간편인증·인증서로 바꾸기) 동등 노출 + §1의 범위 문구("같은 PC의 악성코드로부터 보호하지 못합니다") + ADR-020 결정 3의 고지. 인증서 비밀번호는 저장 UI가 없다.
- 설정 "저장된 비밀" 목록 + 개별 삭제. 감사 로그 `secret.used`로 "언제 쓰였는지" 열람.

## 10. 검토한 OS 격리 수단 (감사 A §4)

| 수단 | 판정 | 이유 |
|---|---|---|
| 중계 허용 목록 + 세션 범위(§3.3) | **채택, Phase 1** | 이후 모든 격리의 전제 |
| 응답 정리(§3.4) | **채택, Phase 1** | 정상 경로 누출 차단 |
| 비밀 창(§3.5) | **채택, Phase 1** | 비밀이 입력되는 세 경로 공통 |
| 원자적 타이핑 + 사전 스크립트 금지(§4.1 (a)) | **채택, Phase 2** | 대부분의 되읽기 창을 닫음 |
| 고수준 동작 브로커(§4.1 (b)) | Phase 3 ADR로 결정 | 엔진에 원시 CDP가 없게 하는 유일한 완전 경계 |
| 커밋 가드 금고 이전(§3.3) | Phase 2 | 승인 없는 발급 횟수 제한 |
| `sodium_malloc` + WER 제외 블록(§8) | **채택, Phase 1** | 덤프·페이지 파일 잔존 감소 |
| 금고 Rust 별도 실행 파일(§8) | Phase 2 | 금고 공격면·덤프 설정 자체 통제 |
| 사람 비밀 세션 결박 등급(§2, ADR-026: TPM 결박 KEK·Windows 세션 추종·엄격 모드 Hello) | **채택, Phase 1~2**(AIK는 Phase 2) | 다른 기기에서의 오프라인 복호와 잠긴 PC에서의 사용 차단. 열린 금고의 무음 사용은 엄격 모드에서만 줄인다 |
| 엔진 AppContainer/Low IL 별도 실행 파일 | Phase 3 검토(브로커와 함께) | 허용 목록 중계가 먼저 있어야 의미가 있음 |
| 금고 프로세스 완화 정책(확장 지점 비활성·이미지 로드 제한·엄격 핸들), 프로세스 DACL 강화 | Phase 2 선택 | 전역 훅·범용 인포스틸러만 차단. 조합 호환성은 **S6h** |
| 금고를 AppContainer/Low IL로 | 비권고 | 키체인 읽기·사용자 무결성 Chrome 기동과 충돌 |
| DPAPI-NG 보호 기술자 | 비권고 | `LOCAL=user`는 기존 DPAPI와 같은 범위, 사용자 존재 확인 없음 |
| VBS/Credential Guard | 비권고 | 앱 비밀이 아니라 LSASS 자격 증명 보호 |
| VBS 엔클레이브 | 비권고 | 비밀은 결국 Chrome 렌더러 DOM에 평문으로 입력됨(사용 시점 노출이 상한) |
| 별도 OS 계정에서 금고+Chrome 실행 | 비권고 | 관리자 권한 계정 생성, NPKI·보안 모듈 계정별 설치, 같은 데스크톱 화면·입력 관찰은 남음 |
| Protected Process Light | 비권고 | 마이크로소프트 안티멀웨어 서명이 필요해 불가 |
