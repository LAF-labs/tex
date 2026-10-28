# 감사 A. 로컬 데스크톱 신뢰 경계

> 감사 범위: 금고 프로세스·OS 키체인·메모리, Chrome 파이프 소유와 중계 CDP, 비밀 타이피스트·DOM 되읽기, 전용 Chrome 프로필·확장·플래그, Electron 하드닝, docparse 격리, 보관함·SQLite 키 관리, 로컬 경로·권한, 로그·덤프·텔레메트리, 자동 업데이트, 로컬 위협 주체(같은 OS 사용자 악성코드, 다른 OS 사용자, 관리자), 키보드 보안 모듈·가상키패드와의 상호작용, NPKI 폴더 접근.
> 작성일 2026-10-28 · 대상: 설계 v1.2(코드 없음)

## 0. 머리말

### 0.1 읽은 문서

- 기획: `README.md`, `02-product-spec.md`(관련 절), `03-architecture.md`(§2~§5), `05-access-and-detection.md`(관련 행)
- 설계: `design/00`, `01`, `02`, `03`, `05`, `06`, `07`, `10`, `11`, `12`, `13`, `14`(관련 행), `15`, `16`, `17`, `18`. `04`·`08`·`09`는 관련 부분만 grep으로 교차 확인했다(BYOK, 이미지 경로, 로컬 승인, 업데이트, 서명키 분리).
- ADR: ADR-001~011 전부, `adr/README.md`
- 스키마: 이번 감사에서는 직접 인용하지 않았다(`policy.schema.json`에 금고·중계 관련 필드가 없음을 grep으로 확인).
- 리서치: `research/REVIEW-B-security.md`(§0, A, D-4~D-7, G 전체), `research/R3-desktop-platform.md`(§1.3~1.4, §2, §4.1, §5.1~5.2)

### 0.2 전제

1. **위협 주체와 판정 기준**
   - E: 엔진 RCE. 포털 화면 텍스트, 모델 응답, 리모트 메시지, 의존성 취약점을 통해 생긴다.
   - P: 서명된 악성·오류 플레이북. 서명키 유출이나 내부 실수로 생긴다.
   - R: 렌더러 침해. 화면에 표시되는 제3자 텍스트를 통해 생긴다.
   - D: docparse 침해. 악성 PDF를 통해 생긴다.
   - M: 같은 OS 사용자 권한으로 도는 악성코드.
   - U: 같은 PC의 다른 OS 사용자.
   - A: 관리자, SYSTEM, 커널.
   - A는 범위 밖이다. 문서에도 그렇게 명시하라고 권고한다(A-31). M은 D11 T2가 "경계가 아님"이라고 이미 인정했다. 이 감사는 E·P·R·D를 금고 앞에서 멈추는 것과, M이 **조용히, 사용자 모르게** 얻는 것을 줄이는 데 초점을 둔다.
2. "위생 장치" 주장도 **침해가 없는 정상 경로**에서는 지켜져야 한다고 본다. 정상 경로에서 평문이 엔진 힙에 들어가면 D05 §1의 약속 자체가 깨진 것으로 판정한다.
3. 외부 사실(Electron·Chromium·Windows)은 감사자 지식으로 보강했다. 불확실한 것은 "확인 필요"로 표시했다.
4. 캡차 자동 풀이, 탐지 회피, 위조·은폐, 정부24 자동화는 권고하지 않는다. 키보드 보안 모듈·가상키패드의 내부 동작을 분석하거나 조작하는 권고도 하지 않는다.
5. 공격 시나리오는 "누가, 어떤 전제에서, 어떤 단계로"를 개념 수준으로만 적는다.

---

## 1. 발견 요약표

| ID | 제목 | 심각도 | 비용 | 비고 |
|---|---|---|---|---|
| A-01 | 중계 CDP가 '타이핑 구간 보류' 방식의 거부 목록뿐이고, 엔진에 브라우저 타깃과 전 도메인이 열려 있다 | High | Phase 1 (+스파이크) | ADR-005 v3 |
| A-02 | 정상 경로에서 Network·Fetch 이벤트를 통해 비밀이 엔진 힙에 들어온다(커밋 가드 포함) | High | Phase 1 | 위생 주장 위반 |
| A-03 | 네트워크 커밋 가드가 엔진 프로세스 안에 있어 E에 무력하다 | Medium | Phase 2 | 기존 인정(D03 §1) |
| A-04 | 접근성 트리·DOMSnapshot·스크린샷으로 보안카드 칸 값이 엔진에 들어온다. 필터가 수신 뒤 엔진 안에서 돈다 | High | Phase 1 | |
| A-05 | 정적 검증기에 "secretSlot 칸을 읽는 스텝 금지" 규칙이 없다 | High | 설계만 | 신규 V-20 |
| A-06 | `human:secret`(홈택스 공동인증서 기본 경로) 구간에는 중계 차단 규칙이 적용되지 않는다 | High | Phase 1 | |
| A-07 | 타이핑 후 되읽기와 미리 심어 둔 페이지 스크립트: 완화 선택지가 문서에 없다 | High | Phase 2 | 기존 인정(T2), 완화 부족 |
| A-08 | `browser.launch(profileDir)`: 엔진이 프로필 경로를 정하고, 기동 플래그 허용 목록이 없다 | Medium | 설계만 | |
| A-09 | WS 프록시 폴백의 토큰 전달·바인딩·연결 규칙이 없다. MessagePort 위 Playwright 가능성도 미확인 | Medium | 스파이크 | |
| A-10 | 전용 프로필 설정을 Chrome **엔터프라이즈 정책 이름**으로 적었다. 적용하면 전역에 걸리고, 안 하면 비밀번호 저장 경로가 열린다 | High | 설계만 | |
| A-11 | 전용 프로필의 확장 프로그램이 비밀 칸을 읽을 수 있는데 점검 규칙이 없다 | Medium | Phase 1 | REVIEW-B G-7 미반영 |
| A-12 | 대상 탭·origin 제한을 엔진이 스스로 집행한다. 금고 중계에서 다시 집행하지 않는다 | Medium | Phase 1 | |
| A-13 | 다운로드·인쇄 저장 경로를 엔진이 CDP로 바꿀 수 있다 | Medium | 설계만 | |
| A-14 | docparse의 "권한 없음"이 OS 수준으로 뒷받침되지 않는다(utilityProcess는 샌드박스가 아님). 다운로드 폴더를 자동 파싱한다 | High | Phase 1 | |
| A-15 | 로컬 게이트 승인이 렌더러가 보고하는 `isTrusted`·카드 해시에 의존한다 | High | Phase 1 | |
| A-16 | Electron 하드닝 체크리스트 누락: CSP 세부, 권한·탐색 핸들러, 발신자 검증, 환경 변수 정리 | Medium | 설계만 | |
| A-17 | `shell.openExternal` 허용 목록의 출처·스킴 규칙이 없다 | Medium | 설계만 | |
| A-18 | Electron `userData` 기본값이 로밍 `%APPDATA%`다. 로그·덤프·렌더러 저장소 경로가 정의되지 않았다 | Medium | 설계만 | |
| A-19 | 사용자 지정 보관함 폴더에서 T9("사용자 권한 폴더")가 성립하지 않는다 | Medium | Phase 1 | 기존 인정(T9), 완화 부족 |
| A-20 | 금고 크래시 덤프를 막는 방법이 없고, WER·Crashpad·메모리 잠금이 명세되지 않았다 | Medium | Phase 1~2 | REVIEW-B A-7 미반영 |
| A-21 | CDP 프로토콜 디버그 로깅과 로그 위치·보존이 명세되지 않았다 | Medium | 설계만 | |
| A-22 | 키체인 등급이 비밀별로 정해지지 않았고, 지속성(`Local`) 고정과 잠금 해제 TTL이 없다 | Medium | Phase 1 (S10) | 기존 인정(M) |
| A-23 | 데몬 `semi_auto`(PC 유휴 시 실행)와 대화형 등급(Hello 결박)이 충돌한다 | Medium | 설계만 | |
| A-24 | DB 키 보유 주체가 불명확하다(main 스케줄러). SQLite 키·임시 파일 처리가 명세되지 않았다 | Medium | 설계만 | REVIEW-B D-7 미반영 |
| A-25 | 보관함 평문 PDF: at-rest 암호화의 효과 범위와 디스크 암호화 점검이 없다 | Medium | Phase 2 | 기존 인정(T9) |
| A-26 | Actuator의 "타이피스트 타이밍 허가"가 엔진에 비밀 길이를 알려 준다 | Medium | 설계만 | 상충 C-04 |
| A-27 | 전용 Chrome 프로필의 잔존 데이터: `keep_session`, Chrome 자체 크래시 리포트, S1b 인증서 사본 | Medium | 설계만 | |
| A-28 | NPKI 폴더 "자동 탐지"와 "열지 않는다"의 경계가 정의되지 않았다 | Medium | 설계만 | |
| A-29 | 자동 업데이트: 매니페스트 서명·동결 대응·사용자 단위 설치 무결성·커밋 구간 중 적용 | Medium | Phase 1 | REVIEW-B G-5 미반영 |
| A-30 | 비밀 입력 창과 복구 문구 화면의 캡처 방지·입력 위생 | Low | 설계만 | |
| A-31 | 관리자·커널 위협이 범위 밖이라는 명시가 없다. Electron 앱 자체의 Chromium 디버그 스위치 | Low | 설계만 | 확인 필요 |
| A-32 | 클립보드 기록·클라우드 클립보드, HAR 녹화 산출물 | Low | Phase 1 | REVIEW-B G-6 미반영 |

---

## 2. 발견 상세

각 항목은 (1) 위치 (2) 공격 시나리오 (3) 현재 통제 (4) 구멍 (5) 권고 (6) 심각도 (7) 비용 순서로 적는다.

### A-01 중계 CDP가 '타이핑 구간 보류' 방식의 거부 목록뿐이다

1. **위치**: `design/05-vault-secrets.md:30-31`, `design/adr/ADR-005-vault-typist.md:9`, `design/03-engine.md:180`, `design/01-system-architecture.md:27`
2. **공격 시나리오**: E. 엔진 RCE가 생긴다는 전제다.
   - 엔진은 중계를 통해 타이핑 구간 밖에서는 모든 CDP 메서드를 쓸 수 있다.
   - 공격자는 브라우저 수준 세션에 붙어 전용 프로필 전체의 쿠키·저장소를 읽는다. 다운로드 경로를 바꾸거나 새 브라우저 컨텍스트·타깃을 만들어 허용 목록 밖으로 이동하는 것도 가능하다.
   - 결과: 로그인된 홈택스 세션 탈취, 사용자 파일 시스템 쓰기.
   - 엔진을 나중에 샌드박스에 넣더라도 Chrome(사용자 권한)을 통해 샌드박스 밖으로 나가는 통로가 된다.
3. **현재 통제**: 금고가 파이프의 단독 소유자다. 포트는 금지했다. 엔진은 CDP 엔드포인트를 지정할 수 없다. 타이핑 구간에는 `Input.*`·`DOM.focus`·`Target.activateTarget`·`Emulation.*`을 보류한다.
4. **구멍**
   - 중계가 "메시지 전달 + 소수의 차단 규칙"으로만 정의되어 있다(05:30). 상시 허용 목록, 브라우저 타깃 차단, 세션 범위 제한이 없다.
   - ADR-001(Playwright)과 함께 쓰면 엔진이 브라우저 수준 프로토콜을 사실상 전부 요구하게 될 가능성이 높다(확인 필요).
5. **권고**
   - D05 §3에 다음 문장을 넣는다. "금고 중계는 **기본 거부 허용 목록**이다. 엔진은 금고가 이번 실행을 위해 만든 page 타깃과, 그 타깃이 연 허용 origin 팝업의 세션에만 붙는다. 브라우저 타깃 세션은 엔진에 노출하지 않는다."
   - 금고 바이너리에 내장하는 상수를 둔다. 플레이북·운영 정책으로는 바꿀 수 없다.
     - `relay.allowedDomains = [Page, Runtime, DOM, Accessibility, Input, Network(읽기 전용), Fetch(커밋 엔드포인트 한정 — A-03), Emulation(포커스 관련만), Log]`
     - `relay.deniedMethods ⊇ {Target.createBrowserContext, Target.exposeDevToolsProtocol, Target.attachToBrowserTarget, Browser.*, Storage.*, SystemInfo.*, Tracing.*, IO.*, Page.setDownloadBehavior, Network.getAllCookies, Network.getCookies(허용 origin 밖)}`
   - `Target.setAutoAttach`는 금고만 호출하고, 결과 세션 중 허용 origin만 엔진에 전달한다.
   - 이 구조 변경은 **ADR-005 v3**로 기록한다. 허용 목록 없이 엔진을 샌드박스에 넣는 것은 의미가 없다는 점을 ADR에 함께 적는다(§4 참조).
   - S6에 "브라우저 타깃·Storage 도메인 호출 시 거부 + 보안 이벤트 `vault.cdp_denied`"를 넣는다. D16 보안 이벤트 목록에도 `vault.cdp_denied`를 추가한다.
6. **심각도**: High
7. **비용**: Phase 1(M1-3에 포함). 착수 전에 Playwright 최소 메서드 집합 스파이크가 필요하다(§6 S6b).

### A-02 정상 경로에서 Network·Fetch 이벤트를 통해 비밀이 엔진 힙에 들어온다

1. **위치**: `design/03-engine.md:108-110`(커밋 가드 = Playwright 라우팅), `design/05-vault-secrets.md:9`(위생 범위), `design/13-testing.md:72-76`(스캐너 대상)
2. **공격 시나리오**: 침해 없이 일어난다.
   - 금고가 포털 비밀번호나 보안카드 칸을 채우고 로그인·확인 요청이 전송된다.
   - 엔진은 Playwright 라우팅(Fetch 도메인)과 페이지 추적(Network 도메인)을 켜 두었으므로 요청 이벤트의 `postData`를 받는다.
   - 결과: 평문 비밀이 엔진 힙에 들어가고, 디버그 로그(A-21)나 덤프(A-20)에도 남을 수 있다.
   - E라면 같은 경로를 의도적으로 쓴다.
3. **현재 통제**: D05 §1은 "평문이 엔진 힙에 남지 않게"라고 약속한다. 누출 스캐너는 로그·IPC·CDP 메시지 캡처를 본다.
4. **구멍**
   - 요청 바디 경로가 위협 모델과 스캐너 대상에서 빠졌다.
   - 커밋 가드를 엔진 쪽 Fetch로 구현하면 모든 포털 요청 바디를 엔진이 보게 된다.
   - 포털이 자체 모듈로 전송 전에 값을 암호화하는지는 확인 필요다. 그와 관계없이 설계는 평문 전송을 가정해야 한다.
5. **권고**
   - D05 §3 중계 규칙에 추가한다. "금고는 **비밀 오염 프레임**(비밀 창 A-06이 열린 프레임과 그 하위)에서 시작된 요청에 대해, 엔진으로 가는 `Network.requestWillBeSent`·`Fetch.requestPaused` 이벤트의 `postData`·`postDataEntries`·`hasPostData`를 제거하고, 엔진의 `Network.getRequestPostData`·`Fetch.getRequestPostData`를 거부한다. 오염은 해당 프레임의 다음 문서 커밋까지 유지한다."
   - D13 §6 스캐너 대상에 "엔진이 받은 CDP 이벤트 스트림(요청 바디 포함)"을 넣는다.
   - D11 T2 '통제' 칸에 "요청 바디 제거(중계)"를 추가한다.
6. **심각도**: High. 제품의 핵심 약속이 정상 경로에서 깨진다.
7. **비용**: Phase 1. 측정은 스파이크 S6c.

### A-03 네트워크 커밋 가드가 엔진 프로세스 안에 있다

1. **위치**: `design/03-engine.md:9`, `:106-110`
2. **공격 시나리오**: E. 침해된 엔진이 게이트 토큰 로직과 `net/commitguard`의 무장 상태를 직접 조작해, 승인 없이 커밋 엔드포인트로 요청을 보낸다. 결과는 비가역 발급이다.
3. **현재 통제**: D03 §1이 "엔진 침해 시 토큰·원장은 무력"이라고 인정하고, 가드를 별도 모듈에 둔다(버그 격리 목적).
4. **구멍**: 가드가 같은 프로세스에 있어 E에 대해서는 경계가 없다. 폰 승인 서명(`Sign_Vm`)은 엔진만 검증한다.
5. **권고**
   - 커밋 엔드포인트에 대한 Fetch 인터셉트를 **금고 중계**로 옮긴다.
   - 금고는 "무장" 근거를 엔진의 주장이 아니라 다음 중 하나로 직접 검증하고, 근거 하나당 요청 1회와 `commitWindowMs`를 집행한다.
     - (a) 폰의 `Sign_Vm("SAX-approve-v1"‖…‖actionHash‖decision)`. 금고는 `remote_devices.noise_pub`과 `Cert_M`을 읽기 전용으로 받는다.
     - (b) main이 네이티브 승인 창(A-15)에서 발급한 `LocalApproval{runId, gateStepId, actionHash, exp}`. 서명 키는 main↔vault 사이 기동 시 교환한 키를 쓴다.
   - 잔여 위험도 문서에 적는다. 금고는 요청 바디가 카드와 일치하는지까지는 검증하지 못하므로, 이 장치는 **승인 없는 발급의 횟수**만 제한한다.
   - 기존 인정 항목이지만 완화가 부족하므로 올린다. ADR 필요(ADR-005 v3에 포함 가능).
6. **심각도**: Medium
7. **비용**: Phase 2

### A-04 접근성 트리·DOMSnapshot·스크린샷으로 보안카드 칸 값이 엔진에 들어온다

1. **위치**: `design/06-redaction.md:42`, `:46`, `design/03-engine.md:133`
2. **공격 시나리오**
   - 침해 없이: 보안카드 칸(`type=text|tel`)에 금고가 입력한 직후 엔진이 `decide`나 복구용으로 접근성 스냅샷을 찍으면, 응답의 `value`에 숫자가 실려 엔진 힙에 들어온다. 스크린샷 경로(L2·`doc_meta_check`)에서는 칸의 숫자가 이미지로 보인다.
   - E: 같은 응답을 그대로 수집한다.
3. **현재 통제**: 마스킹 계층이 스냅샷에서 `type=password`·`secretSlot`·최근 타이피스트 대상의 값을 제거한다.
4. **구멍**
   - 필터가 **엔진 안에서, 수신한 뒤에** 돈다. 위생 주장(힙에 남지 않음)과 맞지 않는다.
   - 마스킹 사전은 2~4자리 숫자를 식별자로 보지 않으므로, 필터를 놓친 값은 모델로도 나갈 수 있다.
5. **권고**
   - D06 §4 "인증서 비밀번호·보안카드" 행을 고친다. "값 제거는 **금고 중계에서** 한다. 금고는 자기가 입력한 노드의 `backendNodeId` 목록과 모든 `type=password` 노드에 대해 `Accessibility.*`·`DOMSnapshot.captureSnapshot`·`DOM.describeNode` 응답의 값 필드를 지운 뒤 엔진에 전달한다."
   - 중계 규칙을 추가한다. "오염 노드가 값을 가진 동안 해당 타깃의 `Page.captureScreenshot`·`Page.startScreencast`는 거부한다."
   - D06 §8 `snapshot()`의 사전조건에 "중계 필터 통과본만"을 적는다.
6. **심각도**: High
7. **비용**: Phase 1. Chrome 156 응답 필드 측정은 스파이크 S6d.

### A-05 정적 검증기에 "secretSlot 칸을 읽는 스텝 금지" 규칙이 없다

1. **위치**: `design/02-playbook-dsl.md:51-54`(`secretSlot`·`readbackOf`·`fieldKey`), `:99`(`extract`), `:148-175`(V-규칙), `:245`(guide 변환)
2. **공격 시나리오**: P. 서명된 오류·악성 플레이북이 다음 스텝을 둔다.
   - `extract{from:{selector: secretSlot 칸}}`나 `assert textMatches`, `decide.scope`, `readback`으로 금고가 입력한 값을 변수로 읽는다.
   - 그 값을 허용 origin 안의 다른 칸에 `fill`하거나(예: 화면에 보이는 메모 칸), 모델 판정 입력에 섞는다.
   - 내장 origin 허용 목록은 이 경로를 막지 못한다.
3. **현재 통제**: V-02는 `secret_fill → secretSlot` 방향만 검사한다. 핫픽스로는 `secretSlot`을 바꿀 수 없다.
4. **구멍**: 역방향, 즉 "비밀 칸은 비밀 입력 외 어떤 스텝의 타깃·범위도 될 수 없다"는 규칙이 없다.
5. **권고**
   - 신규 규칙 **V-20**을 넣는다. "`secretSlot:true` 항목, 또는 `type=password`를 기대하는 항목은 `secret_fill`·`human(kind=secret)`의 `target` 외 어떤 스텝의 `target`·`from`·`scope`·`cond.target`·`readback.fields`에도 쓸 수 없다. 해당 항목은 `readbackOf`·`fieldKey`를 가질 수 없다. `decide.scope` 서브트리가 secretSlot 항목의 `landmark`를 포함하면 오류다."
   - guide 변환 규칙도 넣는다. "`secret_fill`·`human:secret`은 복사 버튼으로 변환하지 않는다(변환 후 재검증에서 오류)."
   - CE 회귀 세트에 CE-7(비밀 칸 extract)과 CE-8(비밀 칸 포함 decide scope)을 추가한다.
6. **심각도**: High. 비용 대비 효과가 매우 크다.
7. **비용**: 설계만

### A-06 `human:secret` 구간에는 중계 차단 규칙이 적용되지 않는다

1. **위치**: `design/05-vault-secrets.md:31`, `:65`, `design/02-playbook-dsl.md:104`, `:132`(`human:secret` 의사 노드), `:238`, `design/01-system-architecture.md:72`
2. **공격 시나리오**: E.
   - 홈택스 공동인증서 경로는 사용자가 가상키패드로 비밀번호를 직접 입력한다(D05 §4). 이 경로가 제품의 기본 경로 중 하나다.
   - 이 구간에는 금고 타이핑이 없으므로 보류 규칙이 동작하지 않는다. 엔진은 그 프레임에 대해 스크린샷·DOM·이벤트 수신을 계속할 수 있다.
   - 결과: 사용자가 입력하는 동안 화면과 페이지 상태를 엔진이 관찰한다.
   - 감사자는 가상키패드의 내부 동작을 분석하지 않았다. 어떤 정보가 노출되는지는 확인 필요다.
3. **현재 통제**: "사용자 직접 입력"이라는 설명뿐이다. D01 §3은 이 경우를 TB-1 예외로만 적는다.
4. **구멍**: 비밀이 화면에 입력되는 두 경로(타이피스트와 사용자 직접 입력) 중 하나만 보호 대상이다.
5. **권고**
   - D05 §3에 **비밀 창(secret window)** 개념을 넣는다. "비밀 창은 (a) 타이피스트 입력, (b) `human(kind=secret)`, (c) `fillFromRemote` 중 하나가 시작될 때 금고가 연다. 비밀 창이 열린 동안 금고는 해당 타깃에서 엔진의 `Input.*`·`DOM.focus`·`Page.captureScreenshot`·`Page.startScreencast`·`Accessibility.*`·`DOMSnapshot.*` 명령을 거부하고, `Runtime.bindingCalled`·`Runtime.consoleAPICalled` 이벤트를 엔진에 전달하지 않는다. 비밀 창은 해당 프레임의 다음 문서 커밋 또는 대상 노드 분리 시 닫히고, 엔진은 `secret_window.closed{ok}`만 받는다."
   - D02 §4.3 3항의 `human:secret` 의사 노드를 "금고 경유 합성 노드"로 고친다.
   - S6 통과 기준에 "`human:secret` 구간에 엔진이 받은 CDP 메시지 목록 = 허용 목록"을 넣는다. 보안 모듈 동작은 분석·조작하지 않는다.
6. **심각도**: High
7. **비용**: Phase 1

### A-07 타이핑 후 되읽기와 미리 심어 둔 페이지 스크립트 — 기존 인정, 완화 부족

1. **위치**: `design/11-security.md:22`(T2), `design/05-vault-secrets.md:9`, `:31`, `design/adr/ADR-005-vault-typist.md:10`
2. **공격 시나리오**: E.
   - 비밀 창이 열리기 전에, 엔진이 그 origin의 문서에 실행될 스크립트를 등록하거나 페이지에 콜백 바인딩을 둔다.
   - 비밀 창 동안 페이지 안에서 수집된 값이 비밀 창이 닫힌 뒤 엔진에 전달된다.
   - 또는 비밀 창이 닫힌 직후 엔진이 입력 칸의 값을 읽는다.
3. **현재 통제**: 문서는 "막을 수 없다"고 정직하게 인정한다. 완화로는 "엔진 공격면 축소·생체 결박"을 든다.
4. **구멍**
   - 생체 결박은 키체인 읽기만 막고 이 경로에는 효과가 없다.
   - 실제로 기준을 올릴 수 있는 중간 선택지가 문서에 없다.
5. **권고**: 아래 세 단계를 D05 §4와 ADR-005 v3에 선택지로 적고, (a)를 채택한다.
   - **(a) 원자적 타이핑(Phase 2)**
     - `secret_fill`에 선택 필드 `submitWith`(셀렉터 사전의 `role=button`, `commits:false`, 로그인·확인 전용 `secretSubmit:true` 항목)를 둔다.
     - 금고는 비밀 창 안에서 입력 → `submitWith` 클릭 → 대상 노드 분리 또는 문서 커밋까지 보류한다. 페이지가 남아 있으면 값이 비워졌는지 확인한다.
     - 비밀 창을 열기 전에 금고는 이번 실행에서 엔진이 등록한 문서 스크립트·바인딩 목록(중계를 지나갔으므로 금고가 안다)을 점검한다. 비밀 origin에 등록된 것이 있으면 비밀 창 개시를 거부한다(`vault.preinjected_script`).
     - 정책 상수: `relay.denyOnSecretOrigins = [Page.addScriptToEvaluateOnNewDocument, Runtime.addBinding]`. Playwright 호환성은 확인 필요.
   - **(b) 고수준 동작 브로커(Phase 3, 별도 ADR)**: 엔진은 원시 CDP를 받지 않고 `click(stableId)`·`fill(stableId, value)`·`readback(fieldKey)`·`snapshot(scopeId)`만 요청한다. Playwright는 무권한 드라이버 프로세스로 옮긴다. ADR-001 재검토가 필요하다.
   - **(c) 수용**: 현 문구를 유지한다.
   - 사용자 고지 문구는 (a) 채택 후에도 바꾸지 않는다.
6. **심각도**: High
7. **비용**: (a) Phase 2, (b) Phase 3

### A-08 `browser.launch(profileDir)`: 엔진이 프로필 경로를 정하고, 기동 플래그 허용 목록이 없다

1. **위치**: `design/05-vault-secrets.md:43`, `:54`, `design/03-engine.md:180`
2. **공격 시나리오**: E 또는 버그.
   - 엔진이 사용자의 일상 Chrome 데이터 폴더나 임의 폴더를 `profileDir`로 넘긴다. 금고는 그 프로필에 파이프로 붙는다.
   - 결과: 사용자 일상 세션에 대한 제어권. Chrome 136+는 기본 데이터 폴더에서 원격 디버깅 스위치를 무시하지만, 명시 경로를 줬을 때 어떻게 판정하는지는 확인 필요다.
   - 기동 인자(인쇄·로그 관련 플래그)를 엔진이나 정책이 추가할 수 있다면 같은 문제가 생긴다.
3. **현재 통제**: "엔진은 CDP 엔드포인트를 지정할 수 없다." 같은 원칙이 경로에는 적용되지 않았다.
4. **구멍**: 인자 이름 하나로 원칙이 무너진다.
5. **권고**
   - `browser.launch()`를 **인자 없이** 정의한다. 다음 상수는 금고 바이너리에 내장한다.
     - `vault.chromeProfileDir = %LOCALAPPDATA%\SovereignAX\chrome-profile`
     - `vault.chromeArgs` 허용 목록: `--remote-debugging-pipe`, `--user-data-dir=<상수>`, `--no-first-run`, 그리고 S3a 결과에 따라 `--kiosk-printing`
   - 기동 전 확인 규칙: 경로가 상수와 같고, 재분석 지점(심볼릭 링크·정션)이 아니고, ACL이 사용자 전용이어야 한다.
   - Chrome 자식 프로세스 환경 변수는 화이트리스트로 정리한다.
   - `launch` 호출 주체를 엔진 포트로 한정한다고 명시한다.
6. **심각도**: Medium
7. **비용**: 설계만

### A-09 WS 프록시 폴백의 규칙이 없다

1. **위치**: `design/05-vault-secrets.md:30`, `design/adr/ADR-001-electron-installed-chrome.md:10`, `design/03-engine.md:7`
2. **공격 시나리오**: M 또는 U.
   - 폴백을 쓰면 로컬 WS 포트가 열린다.
   - 경로 토큰이 명령줄, 환경 변수, 파일, 로그 중 한 곳에라도 남으면 같은 사용자의 다른 프로세스가 엔진 대신 붙을 수 있다.
   - Host·Origin 검사가 없으면 브라우저 페이지가 DNS 재바인딩으로 접근을 시도할 수 있다.
3. **현재 통제**: `/json` 디스커버리 없음, 256비트 경로 토큰.
4. **구멍**
   - 토큰 전달 경로, 바인딩 주소, 연결 수, Host·Origin 검사가 정의되지 않았다.
   - Playwright가 공개 API로 MessagePort 같은 사용자 정의 전송을 받는지 확인되지 않았다(확인 필요). 받지 않으면 "권장"안이 실현되지 않고 폴백이 기본이 된다.
5. **권고**
   - D05 §3에 적는다. "폴백은 S6b가 MessagePort 불가를 증명한 경우에만 허용한다."
   - 폴백 사용 시 규칙:
     - 127.0.0.1 무작위 포트
     - 토큰은 MessagePort로만 전달(명령줄·환경 변수·파일·로그 금지)
     - 첫 연결 1건 수락 후 리스너 종료
     - `Origin` 헤더가 있는 요청과 `Host ≠ 127.0.0.1:<port>` 요청 거부
     - 실행 종료 시 폐기
   - 정책 상수: `relay.transport ∈ {messageport, ws_fallback}`. 기본값 `messageport`.
6. **심각도**: Medium
7. **비용**: 스파이크(Phase 0, S6b)

### A-10 전용 프로필 설정을 엔터프라이즈 정책 이름으로 적었다

1. **위치**: `design/05-vault-secrets.md:33`, `design/07-data-model.md:163`, REVIEW-B A-4.6
2. **공격 시나리오**: 침해 없이 일어난다.
   - `ignoreDefaultArgs:true`이므로 Playwright 기본 인자가 빠지고, 전용 프로필에서도 비밀번호 저장 제안과 자동완성이 동작한다.
   - 사용자가 "저장"을 누르면 포털 비밀번호와 보안카드 칸 값이 Chrome 비밀번호 저장소로 간다. 프로필에 Google 계정이 로그인되어 있으면 동기화될 수 있다.
   - 반대로 문서의 정책 이름(`PasswordManagerEnabled` 등)을 레지스트리 정책으로 적용하면 사용자의 **일상 Chrome 전체**에 적용된다. "시스템 설정을 바꾸지 않는다"는 원칙(R3 §5.2)과도 충돌한다.
3. **현재 통제**: "끔"이라고만 적혀 있다.
4. **구멍**: 적용 수단이 정의되지 않았다. 정책은 프로필 단위가 아니다.
5. **권고**
   - D05 §3을 다음으로 바꾼다. "Chrome 정책(레지스트리)은 쓰지 않는다. 금고는 매 기동 전에 전용 프로필의 `Preferences`에 `credentials_enable_service=false`, `profile.password_manager_enabled=false`, `autofill.profile_enabled=false`, `autofill.credit_card_enabled=false`를 기록하고, 기동 후 값을 다시 읽어 확인한다. 불일치면 비밀 창을 열지 않는다(`vault.profile_prefs_mismatch`)."
   - 동기화는 전용 프로필에서 Google 로그인을 감지하면 비밀 창을 거부하는 것으로 처리한다. `--disable-sync` 스위치의 현재 효과는 확인 필요다.
   - 이것은 사용자 측 설정이며 포털이 보는 값을 바꾸지 않으므로 위조·은폐가 아님을 함께 적는다.
6. **심각도**: High. 비밀이 우리 통제 밖의 다른 저장소로 영속된다. 수정 비용은 작다.
7. **비용**: 설계만. 확인은 스파이크 S6e.

### A-11 전용 프로필의 확장 프로그램

1. **위치**: `design/01-system-architecture.md:28`(`--disable-extensions` 없음), `design/13-testing.md:60`(S15), `05-access-and-detection.md:26`, REVIEW-B G-7
2. **공격 시나리오**: 사용자가 전용 프로필에 임의 확장을 설치했거나, 보안 모듈 확장이 취약하다. 확장 권한으로 비밀 칸과 페이지를 읽는다. 엔진 침해와 같은 효과다.
3. **현재 통제**: 없다. 보안 모듈은 "설치 안내 후 공존"이다.
4. **구멍**: 확장 목록 점검, 공식 배포처 제한, 보안 공지 추적이 문서에 없다.
5. **권고**
   - D05 §3에 추가한다. "금고는 기동 시 전용 프로필의 설치 확장 ID를 읽어 내장 허용 목록(보안 모듈 공식 확장 ID, 앱 업데이트로만 갱신)과 비교한다. 목록 밖 확장이 있으면 비밀 창을 열지 않고 사용자에게 제거를 안내한다."
   - D12에 KISA 보안 공지 추적을 운영 절차로 넣는다. 설치 안내는 운영기관 공식 배포처만 가리킨다.
   - 정책 상수: `vault.extensionAllowlist`
6. **심각도**: Medium
7. **비용**: Phase 1

### A-12 대상 탭·origin 제한을 금고 중계에서 다시 집행하지 않는다

1. **위치**: `design/02-playbook-dsl.md:24`, `design/05-vault-secrets.md:34`, REVIEW-B G-7
2. **공격 시나리오**: 사용자가 자동화 창에서 다른 사이트(메일 등)를 열거나, 포털 페이지가 외부 origin 팝업을 연다. E이거나 엔진 버그라면 그 탭도 조작·관찰된다.
3. **현재 통제**: 엔진이 `domains[]`와 내장 eTLD+1로 이동을 감시한다.
4. **구멍**: 제약받는 주체(엔진)가 스스로 집행한다.
5. **권고**
   - 중계 규칙을 추가한다. "금고는 엔진에 노출된 각 타깃의 현재 origin이 `내장 eTLD+1 ∩ manifest.domains`에 있는지 매 문서 커밋마다 확인한다. 벗어나면 엔진 세션을 분리하고 `vault.origin_left`를 기록한다."
   - "사용자가 연 탭(엔진이 만들지 않았고 허용 팝업도 아닌 탭)은 엔진에 노출하지 않는다"고 적는다.
6. **심각도**: Medium
7. **비용**: Phase 1(A-01과 함께)

### A-13 다운로드·인쇄 저장 경로를 엔진이 바꿀 수 있다

1. **위치**: `design/02-playbook-dsl.md:111`(`save_pdf`), `design/13-testing.md:51`(S3a `--kiosk-printing`), R3 §5.2 `staging\`
2. **공격 시나리오**: E가 다운로드 동작 설정으로 Chrome의 저장 위치를 시작 프로그램 폴더 같은 임의 경로로 바꾼다. 결과는 사용자 권한 파일 쓰기와 지속성 확보다. 엔진 샌드박스화 이후에는 이것이 탈출 통로가 된다.
3. **현재 통제**: 없다.
4. **구멍**: 저장 경로 소유자가 정의되지 않았다.
5. **권고**
   - "다운로드·인쇄 저장 폴더는 금고가 상수 `%LOCALAPPDATA%\SovereignAX\staging\`로 설정하고, 엔진의 `Browser.setDownloadBehavior`·`Page.setDownloadBehavior`는 거부한다(A-01 목록)."
   - "staging의 파일은 docparse(A-14)를 거쳐 보관함으로 이동하고, 24시간 뒤 삭제한다."
6. **심각도**: Medium
7. **비용**: 설계만

### A-14 docparse의 "권한 없음"이 OS 수준으로 뒷받침되지 않는다

1. **위치**: `design/01-system-architecture.md:26`, `design/11-security.md:51-52`, `design/17-postprocess-mode.md:9-10`, `:27`, `design/07-data-model.md:157-158`
2. **공격 시나리오**: D.
   - 웹사이트가 사용자 클릭 없이 다운로드 폴더에 PDF를 떨어뜨린다.
   - 후처리 모드의 파일 감시가 "작업 시작 이후 생성된 PDF"를 자동으로 docparse에 넘긴다.
   - pdf.js 계열 취약점으로 docparse에서 코드가 실행된다.
   - utilityProcess는 Node가 켜진 무샌드박스 사용자 권한 프로세스이므로, DB 파일과 키체인(같은 사용자는 조용히 읽을 수 있음)에 닿는다. 사실상 M과 같다.
3. **현재 통제**: 별도 프로세스, 파일 핸들만 전달, 네트워크·키체인 "접근 없음", 처리 시간·메모리 상한.
4. **구멍**
   - "접근 없음"은 코드 관례일 뿐이다. D11:51은 utilityProcess가 샌드박스가 아님을 인정하면서도 D01:26에는 "권한 없음"이라고 적었다.
   - pdf.js의 `isEvalSupported` 설정이 명세되지 않았다.
   - 감시 대상이 다운로드 폴더 전체다.
5. **권고**
   - D01·D11·D17을 고친다. "docparse는 **Chromium 렌더러 샌드박스 안**에서 돈다. 숨김 `BrowserWindow`(`sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, 네트워크를 차단한 전용 `session` 파티션, preload는 MessagePort 수신만)에 pdf.js와 tesseract.js(wasm)를 두고, 입력은 바이트, 출력은 JSON Schema로 검증한 `{text, pages, hasTextLayer}`뿐이다."
   - 대안은 별도 실행 파일을 AppContainer 또는 Low IL 제한 토큰으로 띄우는 것이다(§4).
   - `pdfjs isEvalSupported:false`, 버전 고정, 월 감사.
   - 감시 대상 축소: "다운로드 폴더는 작업 시작 후 + 사용자 확인 후보만, 자동 파싱은 staging(A-13)과 사용자가 고른 파일만."
   - NPKI `signCert.der` 파싱(A-28)도 같은 샌드박스에서 한다.
6. **심각도**: High. 클릭 없이 열리는 경로이고, 결과가 엔진 이상의 권한이다.
7. **비용**: Phase 1(M1-8 공수에 +2~3일 추정). 성능·호환은 스파이크 S13b.

### A-15 로컬 게이트 승인이 렌더러의 보고에 의존한다

1. **위치**: `design/03-engine.md:66`(로컬 승인 = 렌더러 `isTrusted` + 카드 렌더 해시를 main이 검증), `design/01-system-architecture.md:24`, `:86`(대화창), `design/11-security.md:24`(T4 제3자 텍스트)
2. **공격 시나리오**: R.
   - 제3자 텍스트(거래처 상호, 포털 오류 문구)나 그것을 반영한 모델 대화 응답이 렌더러에 표시된다.
   - 마크다운 렌더 등에서 스크립트 실행이 생긴다.
   - 침해된 렌더러는 `isTrusted=true`와 올바른 카드 해시를 **보고만** 하고, 실제로는 다른 내용을 보여 주거나 승인을 자동으로 누른다.
   - 결과: 비가역 발급.
3. **현재 통제**: 렌더러는 네트워크가 없다(CSP `connect-src 'none'`). main이 해시를 검증한다.
4. **구멍**: main은 `isTrusted`를 검증할 수 없다(렌더러가 보고하는 값). 카드 해시도 렌더러가 계산한다.
5. **권고**
   - D03 §3을 고친다. "로컬 비가역 승인은 **별도 승인 창**에서만 한다. main이 신뢰 계획값으로 정적 HTML을 만들고(텍스트는 `textContent`로만, 스크립트 없음, CSP `default-src 'none'; style-src 'self'`), 승인 입력은 main이 그 창의 `before-input-event`로 직접 관찰한 실제 키·클릭으로만 인정한다. 일반 렌더러의 승인 신호는 '승인 창 열기' 요청일 뿐이다."
   - 선택 옵션(설정): 비가역 승인에 Windows Hello `UserConsentVerifier`를 요구할 수 있게 한다.
   - 대화창의 모델 출력 렌더는 마크다운 → 허용 태그 화이트리스트 sanitizer, 원시 HTML 금지.
6. **심각도**: High
7. **비용**: Phase 1(M4-2)

### A-16 Electron 하드닝 체크리스트 누락

1. **위치**: `design/11-security.md:50-60`, R3 §4.1, REVIEW-B G-2
2. **공격 시나리오**: R 또는 M.
   - 탐색·새 창 핸들러가 없으면 렌더러가 원격 페이지를 로드할 수 있다.
   - 권한 핸들러 기본값은 모두 승인이다.
   - `file://` 특권이 남아 있으면 로컬 파일을 읽을 수 있다.
   - 발신자 검증이 없으면 다른 프레임이 IPC를 호출할 수 있다.
   - 환경 변수(`ELECTRON_ENABLE_LOGGING` 등)로 로그가 파일에 쓰인다.
3. **현재 통제**: contextIsolation·sandbox·nodeIntegration 설정, 퓨즈 6종, CSP 3지시어, webview 비활성.
4. **구멍**: 아래 항목이 문서에 없다.
5. **권고**: D11 §4에 표로 고정하고 CI로 검증한다.
   - CSP: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; connect-src 'none'; img-src 'self' data:; require-trusted-types-for 'script'`. 커스텀 프로토콜 `app://`의 응답 헤더로 설정한다.
   - 퓨즈: `GrantFileProtocolExtraPrivileges` 끔. 빌드 순서(퓨즈 → ASAR 무결성 → 서명)를 CI로 검증한다.
   - 전역 핸들러: `session.setPermissionRequestHandler`·`setPermissionCheckHandler` 전부 거부, `will-navigate`·`will-redirect` 거부, `setWindowOpenHandler` → `deny`, 프로덕션 `devTools:false`.
   - IPC: `event.senderFrame.url`이 `app://` 최상위 프레임인지 확인한다. preload는 `contextBridge`로 좁은 함수만 노출한다(raw `ipcRenderer` 금지).
   - `utilityProcess.fork`: `execArgv` 고정. `env`는 화이트리스트(`DEBUG`, `NODE_DEBUG`, `NODE_OPTIONS`, `ELECTRON_*`, `PLAYWRIGHT_*`, `DEBUG_COLORS` 제거).
   - `app.setPath('userData', …LocalAppData…)`(A-18).
   - `app.setAsDefaultProtocolClient`를 쓰면 인자를 무신뢰 입력으로 다루고 동사 화이트리스트를 둔다.
6. **심각도**: Medium
7. **비용**: 설계만

### A-17 `shell.openExternal` 허용 목록의 출처·스킴 규칙이 없다

1. **위치**: `design/11-security.md:55`, `design/17-postprocess-mode.md:7`, `design/03-engine.md:199`
2. **공격 시나리오**: P 또는 R. guide 변환본의 URL이나 렌더러가 넘긴 문자열이 비 https 스킴(Windows URI 핸들러 계열)이나 허용 밖 호스트를 가리키고, 사용자 PC의 다른 프로그램이 실행된다.
3. **현재 통제**: "허용 목록"이라는 한 단어뿐이다.
4. **구멍**: 목록이 어디서 오는지, 스킴 제한, 호출 주체가 정의되지 않았다.
5. **권고**
   - "`openExternal`은 main만 호출하고, 렌더러는 URL이 아니라 **키**(`portalId` 또는 strings 키)만 넘긴다."
   - "URL은 WHATWG 파싱 결과 `https:`, userinfo·포트 없음, 호스트 ∈ 엔진 내장 eTLD+1 허용 목록(패키지로 변경 불가)."
   - D13 §8에 "비 https·허용 밖 호스트 거부" 회귀를 넣는다.
6. **심각도**: Medium
7. **비용**: 설계만

### A-18 Electron `userData` 기본값이 로밍 `%APPDATA%`다

1. **위치**: `design/07-data-model.md:7-9`, R3 §5.2(권고 레이아웃), REVIEW-B D-5
2. **공격 시나리오**: 도메인 가입 PC에서 로밍 프로필이 렌더러 저장소·로그·Crashpad 덤프(`crashDumps` 기본 경로가 userData 하위)를 서버로 복사한다. 결과: 업무 데이터·DB 키 포함 덤프가 PC 밖으로 나간다.
3. **현재 통제**: DB·보관함만 `%LOCALAPPDATA%`로 정의되어 있다.
4. **구멍**: userData, logs, crashDumps, chrome-profile, staging, tmp 경로가 D07에 없다.
5. **권고**
   - D07 §1에 경로 표를 추가한다.
     - `%LOCALAPPDATA%\SovereignAX\{userData, db, vault, chrome-profile, staging, logs, crashDumps}`
     - `app.setPath('userData'|'logs'|'crashDumps', …)`를 앱 준비 이전에 설정한다.
   - 루트 폴더 DACL 규칙: "소유자 + SYSTEM, 상속 차단. 매 기동 시 확인하고, 다르면 복구 + 경고."
   - Windows 검색 색인 제외 속성은 루트 전체에 적용한다.
6. **심각도**: Medium
7. **비용**: 설계만

### A-19 사용자 지정 보관함 폴더에서 T9가 성립하지 않는다 — 기존 인정, 완화 부족

1. **위치**: `design/11-security.md:29`, `design/07-data-model.md:8`
2. **공격 시나리오**: U. 사용자가 보관함을 `D:\서류`나 공용 폴더로 지정한다. 보조 NTFS 볼륨 루트의 기본 ACL은 인증된 사용자에게 수정 권한을 주는 경우가 많다(확인 필요: OS 버전·포맷 방식에 따라 다름). 그러면 다른 OS 사용자가 등본·세금계산서 PDF를 읽는다.
3. **현재 통제**: "사용자 권한 폴더". 동기화 루트 감지·경고.
4. **구멍**: 사용자 프로필 밖 폴더의 ACL을 점검·설정하지 않는다. FAT/exFAT·네트워크 공유·이동식 디스크 처리가 없다.
5. **권고**
   - D07 §1에 추가한다. "사용자가 보관함 폴더를 고르면 (1) 파일 시스템이 NTFS가 아니거나 네트워크·이동식 경로면 거부 또는 강한 경고, (2) 폴더에 보호 DACL(소유자 + SYSTEM, 상속 차단)을 설정하고 확인, (3) 실패하면 기본 위치를 권고."
   - 오류 코드: `postprocess.sync_folder_warning`과 함께 `storage.acl_weak`을 D16에 추가한다.
6. **심각도**: Medium
7. **비용**: Phase 1

### A-20 금고 크래시 덤프를 막는 방법이 없다

1. **위치**: `design/05-vault-secrets.md:93`, `design/07-data-model.md:162`, `design/11-security.md:58`, `design/01-system-architecture.md:27`("메모리 잠금"), REVIEW-B A-7·D-4
2. **공격 시나리오**
   - 침해 없이: 금고가 비정상 종료한다. Electron Crashpad(앱 단위 핸들러)나 Windows WER이 금고 메모리를 담은 덤프를 만든다. 업로드에 동의했거나 WER 보고가 나가면 비밀이 PC 밖으로 나간다.
   - M: 로컬 덤프 파일을 읽는다.
   - 페이지 파일·최대 절전 파일에 비밀 페이지가 남는다.
3. **현재 통제**: "금고는 덤프 생성을 비활성화한다." 방법은 적혀 있지 않다.
4. **구멍**
   - Crashpad를 utility 프로세스별로 뺄 수 있는지 확인되지 않았다(확인 필요).
   - WER 제외는 실행 파일 이름 단위라 main과 같은 exe인 금고만 따로 뺄 수 없다.
   - "메모리 잠금"의 수단(VirtualLock·`sodium_mlock`)과, JS 문자열은 잠글 수 없다는 한계가 적혀 있지 않다.
5. **권고**
   - D05 §8을 고친다.
     - (Phase 1) 금고 비밀 버퍼는 `sodium_malloc`(가드 페이지, mlock 시도)으로 만든다. 네이티브 헬퍼로 `WerRegisterExcludedMemoryBlock`을 써서 비밀 버퍼를 WER 덤프에서 뺀다.
     - (Phase 2) 금고를 Electron 밖 별도 실행 파일(Rust)로 분리해 Crashpad·WER을 자체 설정한다.
   - 엔진·main 덤프: "로컬 생성도 사용자 요청 시에만, 업로드는 금지(힙 없는 구조화 오류 보고만 옵트인)." D11:58 문구를 이에 맞춘다(상충 C-03).
   - 최대 절전·페이지 파일 잔존은 잔여 위험 표에 적는다.
6. **심각도**: Medium
7. **비용**: Phase 1(버퍼·WER), Phase 2(분리)

### A-21 CDP 프로토콜 디버그 로깅과 로그 위치·보존

1. **위치**: `design/11-security.md:60`, `design/05-vault-secrets.md:94`, `design/12-observability-ops.md:40`
2. **공격 시나리오**: 지원 과정에서 개발자 안내로 디버그 환경 변수를 켜면 엔진·금고의 CDP 클라이언트가 모든 프로토콜 메시지(A-02의 요청 바디, 금고의 글자 단위 입력)를 로그에 남긴다. 이 로그가 진단 내보내기에 섞인다.
3. **현재 통제**: 비밀 타입 포맷터, 레벨별 보존, 내보내기 시 마스킹.
4. **구멍**: 포맷터는 `SecretBytes` 타입만 잡는다. 라이브러리 내부 프로토콜 로깅은 타입 밖이다. 로그 경로·보존 기간 수치가 없다.
5. **권고**
   - "릴리스 빌드에서 금고·엔진 CDP 클라이언트의 프로토콜 로깅 코드 경로를 제거한다(빌드 플래그). 런타임 환경 변수로 켤 수 없다."
   - "로그는 `%LOCALAPPDATA%\SovereignAX\logs`, 결과 코드와 ID만, 14일 보존(`log.retentionDays=14`)."
   - "진단 내보내기 전에 누출 스캐너 규칙(테스트 패턴 + 인코딩 변형)을 로컬에서 실행한다."
6. **심각도**: Medium
7. **비용**: 설계만

### A-22 키체인 등급이 비밀별로 정해지지 않았다 — 기존 인정(M)

1. **위치**: `design/05-vault-secrets.md:17-25`, `:85`, `:88`, R3 §2.2·§2.5
2. **공격 시나리오**: M. Credential Manager의 일반 자격 증명은 같은 사용자의 어떤 프로세스든 사용자 모르게 읽을 수 있다. 항목 이름(`securitycard/<profile>/<row>`)도 예측할 수 있다. 인증서 파일(NPKI)과 저장된 비밀번호를 함께 가져가면 인증서 전체가 넘어간다.
3. **현재 통제**: 대화형 등급(Hello 결박)과 무인 등급을 나눈다는 원칙이 있다(S10).
4. **구멍**
   - 어떤 비밀이 어느 등급인지 표에 없다. 보안카드·인증서 비밀번호의 대화형 전용 여부가 정해지지 않았다.
   - `@napi-rs/keyring`의 지속성 기본값이 확인되지 않았다(ENTERPRISE면 로밍).
   - 잠금 해제 유효 시간이 없다.
5. **권고**
   - D05 §2 표에 '등급' 열을 추가한다.
     - 대화형 전용: 인증서 비밀번호, 포털 비밀번호, 보안카드. Credential Manager에는 Hello 결박 KEK로 암호화한 암호문만 둔다.
     - 무인: DB 키, 기기 키, `Kv`.
   - 상수
     - `vault.unlockTtlSec=300`
     - `vault.credPersist=LOCAL_MACHINE`(통합 테스트로 고정)
     - `vault.helloPromptShowsTaskAndPortal=true`
   - 저장 화면 문구(REVIEW-B A-8 그대로): "인증서 파일과 비밀번호가 같은 PC에 함께 있으면 악성코드 한 번에 인증서 전체가 넘어갑니다."
6. **심각도**: Medium
7. **비용**: Phase 1(S10 결과 반영)

### A-23 데몬 `semi_auto`와 대화형 등급이 충돌한다

1. **위치**: `design/10-daemon.md:12`, `:20`(PC 유휴 5분 이상), `design/05-vault-secrets.md:88`
2. **공격 시나리오**: 위협이라기보다 설계 압력이다. 유휴 시간에 실행되는 갱신 작업에서 저장 비밀이 필요하면 Hello 프롬프트를 아무도 받을 수 없다. 그래서 구현 단계에서 비밀을 무인 등급에 저장하게 된다. 결과적으로 M이 사용자 모르게 읽을 수 있는 비밀이 늘어난다.
3. **현재 통제**: `auto` 보류. `semi_auto`는 폰 승인을 쓴다.
4. **구멍**: 데몬 실행에서 키체인 비밀 사용 여부에 대한 규칙이 없다.
5. **권고**
   - D10 §6에 추가한다. "데몬 실행(`trigger:'daemon'`)은 키체인에 저장된 비밀을 쓰지 않는다. 로그인은 간편인증 PUSH 또는 폰 봉인 비밀(`fillFromRemote`, 라이브 세션)만 쓴다. 금고는 `trigger=daemon` 실행의 `typist.fill`을 `denied`로 거부한다."
   - D05 §2 '무인 등급'에 사람 비밀이 없음을 명시한다.
6. **심각도**: Medium
7. **비용**: 설계만

### A-24 DB 키 보유 주체와 SQLite 세부

1. **위치**: `design/05-vault-secrets.md:23`, `:50`, `design/10-daemon.md:19`(스케줄러 = main, SQLite), `design/01-system-architecture.md:23-25`, REVIEW-B D-7, R3 §5.1
2. **공격 시나리오**: main도 DB를 열려면 키가 필요하다. 문서가 없으니 구현 단계에서 키를 두 프로세스에 주거나 main에서 키체인을 직접 읽게 된다. 정렬용 임시 파일이 평문으로 디스크에 남거나, `PRAGMA key` 문자열이 힙에 남는다.
3. **현재 통제**: `getDbKeyOnce()`로 엔진에 1회 전달한다.
4. **구멍**: 보유 주체가 불명확하다. 알고리즘, 키 전달 형식, `temp_store`가 없다.
5. **권고**
   - D05 §2와 D07 §1에 적는다. "DB 소유 프로세스는 엔진 하나다. main의 스케줄러와 렌더러의 감사 로그 뷰는 엔진의 읽기 전용 IPC 질의(`db.query.*` 스키마)를 쓴다."
   - "`getDbKeyOnce`는 금고 기동당 1회, 두 번째 호출은 보안 이벤트 `vault.dbkey_requested_twice`."
   - "`cipher=sqlcipher, legacy=4`(또는 chacha20) 명시, 키는 Buffer를 함수형 `key()`로 전달, `PRAGMA temp_store=MEMORY`."
6. **심각도**: Medium
7. **비용**: 설계만

### A-25 보관함 평문 PDF — 기존 인정(T9)

1. **위치**: `design/07-data-model.md:8`, `design/11-security.md:29`
2. **공격 시나리오**: 노트북 분실(디스크 암호화 없음), 백업 도구의 사본, 동기화 오설정, U(A-19)로 등본·세금계산서 평문이 유출된다.
3. **현재 통제**: 파일명 PII 제거, 색인 제외, 동기화 루트 경고, "OS 디스크 암호화 안내", 중기 과제로 파일별 DEK.
4. **구멍**
   - 중기 과제의 시점과 키 위치가 없다.
   - at-rest 암호화가 무엇을 막고 무엇을 못 막는지(M은 못 막음) 적혀 있지 않다.
   - 디스크 암호화 상태를 확인하지 않는다.
5. **권고**
   - D07 §1을 보강한다.
     - "(Phase 2) 파일별 DEK를 `K_store`(키체인, 무인 등급)로 래핑. 앱 뷰어는 메모리에서 복호화하고, 외부 뷰어로 열기는 '내보내기'(평문 사본, 사용자 동작)로만."
     - "효과 범위: 분실·백업·동기화·U. M에는 효과 없음."
   - 온보딩에서 시스템 드라이브의 BitLocker·장치 암호화 상태를 **읽기 전용으로** 확인해 꺼져 있으면 안내한다. 설정을 바꾸지 않는다. 관리자 권한 없이 상태를 읽는 방법은 확인 필요다.
6. **심각도**: Medium
7. **비용**: Phase 2(암호화), Phase 1(점검 안내)

### A-26 Actuator의 "타이피스트 타이밍 허가"가 엔진에 비밀 길이를 알려 준다

1. **위치**: `design/03-engine.md:97`, `design/05-vault-secrets.md:60`
2. **공격 시나리오**: 침해 없이: 키마다 엔진의 Actuator에 허가를 받으면 엔진(그리고 저널·로그)이 비밀 길이를 알게 된다. E는 그 길이를 대입 공격 범위를 줄이는 데 쓴다.
3. **현재 통제**: D05는 금고가 정책 상수 150ms로 입력한다고 적었다.
4. **구멍**: 두 문서가 서로 다르게 말한다(상충 C-04).
5. **권고**
   - D03 §5.2를 고친다. "금고 타이피스트는 Actuator에서 **비밀 창 개시 허가 1회**만 받는다(`kind:'secret_window'`). 글자 간격은 금고가 실행 시작 때 받은 `policy.pace.*.keyEventDelayMs`로 스스로 집행한다. 엔진·저널·텔레메트리에 길이를 기록하지 않는다."
   - D03 §9 `secret.used{kind, viaTypist}`에 길이 필드가 없음을 명시한다.
6. **심각도**: Medium
7. **비용**: 설계만

### A-27 전용 Chrome 프로필의 잔존 데이터

1. **위치**: `design/07-data-model.md:20`(`keep_session DEFAULT 1`), `:163`, `design/05-vault-secrets.md:33`, `:79`(S1b), `design/13-testing.md:50`
2. **공격 시나리오**
   - M·U: 프로필의 세션 쿠키·HTTP 캐시(발급 PDF·조회 화면)·방문 기록을 읽는다.
   - Chrome 자체의 사용 통계·크래시 리포트가 전용 프로필에서 켜져 있으면, 비밀 칸이 있는 렌더러 크래시가 Chrome 공급사로 보고될 수 있다(전용 `user-data-dir`의 기본값은 확인 필요).
   - S1b 경로에서는 암호화된 개인키 사본이 사이트 저장소에 남는다.
3. **현재 통제**: 종료 시 캐시 정리, `keep_session` 기본 꺼짐(D05), 비밀번호 저장·동기화 끔.
4. **구멍**
   - D07 DDL 기본값이 1이다(상충 C-01).
   - 정리 수단과 대상이 없다.
   - Chrome 자체 리포트 설정이 없다.
   - S1b 사본의 위치와 삭제 절차가 없고, "종료 시 정리"가 그 사본을 지우는지 정하지 않았다.
5. **권고**
   - DDL을 `DEFAULT 0`으로 고친다.
   - D05 §3에 추가한다. "종료 시 금고가 `Network.clearBrowserCache`와 허용 origin별 `Storage.clearDataForOrigin(cache_storage, service_workers …)`을 실행한다. 쿠키는 `keep_session=0`이면 함께 지운다. 이것은 사용자 데이터 정리이며 감사 로그는 남는다."
   - "기동 전 `Local State`의 사용 통계·크래시 보고 설정을 끔으로 기록하고 확인한다(사용자 측 설정)."
   - "S1b를 채택하면 인증서 사본은 홈택스 origin 저장소에만 있고, 사용자가 '브라우저 인증서 삭제'를 누르거나 앱을 제거할 때 지운다. 캐시 정리 대상에서 해당 저장소 종류는 제외한다."
6. **심각도**: Medium
7. **비용**: 설계만

### A-28 NPKI 폴더 "자동 탐지"와 "열지 않는다"의 경계

1. **위치**: `02-product-spec.md:15`(NPKI 폴더 자동 탐지), `design/14-work-breakdown.md:68`(온보딩 NPKI 탐지), `design/05-vault-secrets.md:16`, `:76-79`, `03-architecture.md:70`
2. **공격 시나리오**
   - 구현자가 "탐지"를 위해 NPKI 폴더 전체를 읽거나 감시하고 로그에 경로를 남긴다.
   - 인증서 DER을 엔진에서 파싱하다가 조작된 파일(LocalLow는 낮은 무결성 프로세스도 쓸 수 있는 위치)로 파서가 공격받는다.
   - 결과: 약속 위반, 그리고 공격면 증가.
3. **현재 통제**: "하네스는 개인키 파일을 열지 않는다."
4. **구멍**: 허용되는 동작의 목록이 없다.
5. **권고**
   - D05 §6에 허용 목록을 쓴다. "(1) NPKI 디렉터리 열거, (2) `signCert.der`(공개 인증서)만 읽어 주체·만료를 표시하며 파싱은 docparse 샌드박스에서, (3) `signPri.key`는 열거만 하고 열지 않는다(S1b에서는 사용자 동작으로 파일 선택 칸에 경로를 넘길 뿐 내용을 읽지 않는다), (4) NPKI 경로는 파일 감시 대상이 아니다, (5) 경로·파일명은 텔레메트리·모델·로그로 보내지 않는다."
   - D13 §6 스캐너에 "`signPri.key` 열기 0회(파일 접근 감사)"를 넣는다.
6. **심각도**: Medium
7. **비용**: 설계만

### A-29 자동 업데이트

1. **위치**: `design/11-security.md:57`, `design/01-system-architecture.md:144`, `03-architecture.md:43`, REVIEW-B G-5
2. **공격 시나리오**
   - 업데이트 서버가 장악되면 "업데이트 없음"을 계속 응답해 취약 버전에 묶어 둔다(동결).
   - 사용자 단위 설치 경로는 사용자가 쓸 수 있으므로 M이 실행 파일을 바꿔치기한다. ASAR 무결성 검증은 exe 자체가 교체되면 소용없다.
   - 커밋 구간 중에 업데이트 재시작이 일어난다.
3. **현재 통제**: `electron-updater` ≥ 6.3.0-alpha.6, 서명 검증, 다운그레이드 금지, 단계적 롤아웃, DN 고정.
4. **구멍**: 업데이트 매니페스트(`latest.yml`) 자체의 서명·만료가 없다. 동결 감지, 설치 경로 무결성 한계, 실행 중 적용 규칙도 없다.
5. **권고**
   - D11 §4를 보강한다.
     - "`latest.yml`을 별도 Ed25519 키(플레이북·정책 키와 분리)로 서명하고 `expires`·단조 `version`을 포함한다. 앱이 검증한다."
     - "업데이트 확인 성공이 `update.maxStaleDays=14`일 동안 없으면 사용자에게 알린다."
     - "실행 중·커밋 구간·데몬 실행 중에는 설치하지 않는다."
     - "사용자 단위 설치는 M에 대한 바이너리 무결성 경계가 없음을 잔여 위험으로 적는다. 기업 고객용 기기 단위(Program Files) 설치 옵션은 Phase 3에서 검토한다."
6. **심각도**: Medium
7. **비용**: Phase 1

### A-30 비밀 입력 창과 복구 문구 화면

1. **위치**: `design/05-vault-secrets.md:39`(전용 입력 창), `design/07-data-model.md:145`(복구 문구 BIP39)
2. **공격 시나리오**: 화면 녹화 도구, 원격 지원 도구, 화면 캡처형 악성코드가 비밀 입력 창이나 복구 문구 표시 화면을 캡처한다.
3. **현재 통제**: 모바일 쪽은 스크린샷 차단이 있다. 데스크톱 쪽은 없다.
4. **구멍**: 데스크톱 창 보호와 입력 위생 규칙이 없다.
5. **권고**
   - D05 §3에 적는다. "전용 비밀 입력 창과 복구 문구 표시 창은 `setContentProtection(true)`(Windows 캡처 제외 표시 속성), 입력란 `autocomplete=off`·`spellcheck=false`, 입력 즉시 `TextEncoder`로 바이트화 후 입력란 비움, 창 닫을 때 DOM 제거."
   - 이것이 단호한 M을 막지는 못한다는 점을 함께 적는다.
6. **심각도**: Low
7. **비용**: 설계만

### A-31 범위 밖 위협의 명시와 Electron 앱 자체의 디버그 스위치

1. **위치**: `design/11-security.md:17-34`
2. **공격 시나리오**
   - A(관리자·커널)는 모든 통제를 무력화하는데, 문서에 범위 밖이라는 선언이 없다. 그래서 대외 문구가 과장될 위험이 있다.
   - M이 우리 앱을 Chromium 디버그 스위치와 함께 실행하면 렌더러 DevTools에 접근할 수 있다. 퓨즈는 Node 쪽 인자만 막는다. 시작 시점 처리 가능 여부는 확인 필요다.
3. **현재 통제**: 퓨즈 `EnableNodeCliInspectArguments` 끔.
4. **구멍**: 위협 주체 표가 없다. Chromium 스위치 처리 규칙이 없다.
5. **권고**
   - D11 §1 앞에 위협 주체 표(E·P·R·D·M·U·A)와 "A는 범위 밖"을 넣는다.
   - "main은 기동 직후 `remote-debugging-port`·`remote-debugging-pipe`·`enable-logging`·`log-file` 스위치가 있으면 종료한다(best-effort, M 대상)."
6. **심각도**: Low
7. **비용**: 설계만

### A-32 클립보드 기록과 HAR 녹화 산출물

1. **위치**: `design/17-postprocess-mode.md:8`, `design/07-data-model.md:165`, `design/13-testing.md:24`, `design/18-test-environment-plan.md:31`, REVIEW-B G-6
2. **공격 시나리오**
   - 복사 버튼으로 넣은 사업자번호·주소는 30초 뒤 클립보드를 비워도 Windows 클립보드 기록·클라우드 클립보드에 남는다.
   - 리플레이 녹화 HAR에는 로그인 POST 바디와 쿠키가 남는다(입력 스텝만 제외하므로).
3. **현재 통제**: 30초 비움. 비밀 입력 단계 녹화 제외. 2026년 말 삭제.
4. **구멍**: 클립보드 기록 제외 형식이 없다. HAR 정리·암호화 규칙이 없다.
5. **권고**
   - "클립보드에 쓸 때 기록·클라우드 제외 형식(`ExcludeClipboardContentFromMonitorProcessing`, `CanIncludeInClipboardHistory=0`, `CanUploadToCloudClipboard=0`)을 같은 쓰기에 포함한다. Electron 사용자 정의 형식 쓰기 가능 여부는 확인 필요, 불가하면 네이티브 헬퍼."
   - "HAR은 저장 전에 인증 경로 바디·`Cookie`·`Set-Cookie`·`Authorization`을 제거하고 암호화해 보관한다."
6. **심각도**: Low
7. **비용**: Phase 1

---

## 3. 상충 발견 (문서 간 보안 서술 불일치)

| ID | 문서 A | 문서 B | 내용 | 정정안 |
|---|---|---|---|---|
| C-01 | `design/05-vault-secrets.md:33`, `design/07-data-model.md:163`: `keep_session` 기본 꺼짐 | `design/07-data-model.md:20`: `keep_session INTEGER NOT NULL DEFAULT 1` | 세션 쿠키 유지 기본값이 반대다 | DDL `DEFAULT 0` |
| C-02 | `design/07-data-model.md:9`: 로컬 임시 `tmp/` 평문 24시간(마스킹 미리보기·캡차 크롭) / `design/06-redaction.md:61`: 미리보기 본문은 "로컬 임시 저장" | `design/07-data-model.md:164`: 미리보기·캡차 크롭은 디스크 대신 DB 암호화 컬럼 | 임시 데이터의 저장 위치와 암호화 여부가 서로 다르다 | §1 표를 §9에 맞추고, 캡차 크롭은 메모리만 쓴다 |
| C-03 | `design/05-vault-secrets.md:93`, `design/07-data-model.md:162`, `03-architecture.md:79`: 엔진·main 덤프 업로드 금지 | `design/11-security.md:58`: "나머지는 비밀 없음 확인 후 옵트인"(업로드) | 덤프 업로드 허용 여부가 다르다 | D11을 "업로드 금지, 힙 없는 구조화 오류 보고만 옵트인"으로(A-20) |
| C-04 | `design/03-engine.md:97`: Actuator가 "금고 타이피스트의 타이밍 허가"를 집행 | `design/05-vault-secrets.md:60`: 금고가 정책 상수 150ms로 입력 | 엔진이 키별 허가를 하면 길이가 새어 나간다 | A-26 |
| C-05 | `design/adr/ADR-005-vault-typist.md:15`: "엔진에 짧게 평문 전달 — 폴백으로만" | `design/01-system-architecture.md:72`, `design/05-vault-secrets.md:7-8`: TB-1→TB-2 평문 금지(예외는 human뿐) | ADR 대안 절에 금지된 경로가 '폴백'으로 남아 있다 | ADR-005 대안에서 '폴백' 문구 삭제(기각으로 표기) |
| C-06 | `design/01-system-architecture.md:26`: docparse "권한 없음" / `design/11-security.md:56`: "금고는 추가로 … 샌드박스 프로파일 검토" | `design/11-security.md:51`: "utilityProcess는 샌드박스가 아니다 … OS 수준 경계가 아님" | 같은 문서 안에서도 샌드박스 여부 서술이 다르다 | D01 "권한 없음 → 코드상 접근 없음(OS 경계 아님)", A-14로 실제 샌드박스화 |
| C-07 | `design/07-data-model.md:121`: 파일명에 PII 금지, 평면 레이아웃 `{docType}_{yyyyMMdd}_{shortId}.pdf` | `design/02-playbook-dsl.md:222`: H-01 `nameTemplate: "세금계산서/{yyyy}/{MM}/{counterpart.name}_{yyyyMMdd}_{approvalNo}.pdf"`, `design/07-data-model.md:8`: `세금계산서/2026/10/…pdf` | 골든 IR이 거래처명·승인번호를 파일명에 넣는다 | `nameTemplate`을 IR에서 제거하고 엔진 고정 템플릿 사용. 표시 이름은 DB에. 검증 규칙 V-21 "`save_pdf.nameTemplate` 금지 또는 허용 토큰만" |
| C-08 | `design/05-vault-secrets.md:23`: DB 키 → "엔진 시작 시 1회 전달, 사용 주체 엔진" | `design/10-daemon.md:19`: 스케줄러는 `main`, SQLite `schedules` 기반 / `design/01-system-architecture.md:23`: main 업데이트·스케줄러 | main이 DB를 읽으려면 키가 필요하다 | A-24(엔진 단일 소유 + 질의 IPC) |
| C-09 | `design/05-vault-secrets.md:92`: "비밀은 Uint8Array/네이티브 버퍼로만, 문자열 금지" | `design/05-vault-secrets.md:61`: JS 문자열 영화 불가, Rust는 Phase 2 / R3 §2.1: `@napi-rs/keyring`은 문자열 API | Phase 1 구현으로는 규칙을 지킬 수 없다 | §8에 "Phase 1 한계: 키체인 읽기와 CDP JSON 메시지에서 문자열 사본 발생"을 명시 |
| C-10 | `design/adr/ADR-001-electron-installed-chrome.md:10`, `design/03-engine.md:7`: "Playwright가 설치 Chrome을 … 실행/제어" | `design/05-vault-secrets.md:29-30`, `design/03-engine.md:180`: 금고가 기동, 엔진은 MessagePort 중계 CDP | 기동 주체와 Playwright 연결 방식이 문서마다 다르다. MessagePort 위 Playwright 가능성 미확인 | ADR-001에 "기동은 금고, 엔진의 Playwright는 중계 전송(S6b 결과에 조건부)"을 추가 |
| C-11 | `design/11-security.md:22` T2 완화: "생체 결박 등급" | `design/05-vault-secrets.md:88`: 무인 등급(결박 없음) 존재, 비밀별 등급 미정 | T2의 완화 수단이 실제로 어느 비밀에 적용되는지 정해지지 않았다. 생체 결박은 DOM 되읽기에는 효과가 없다 | A-22. T2 완화 칸에서 "생체 결박"을 "M의 무음 키체인 읽기 완화"로 한정 |
| C-12 | `design/adr/README.md:9`: ADR-005 "스파이크 S1·S6 조건부" | `design/adr/ADR-005-vault-typist.md:3`: "S1b·S6" | 조건 스파이크 이름이 다르다 | README를 S1b·S6으로 |
| C-13 | `design/11-security.md:29` T9: "옵션 폴더 암호화(Phase 3)" | `design/07-data-model.md:8`: "중기 과제: 파일별 DEK로 at-rest 암호화" | 시점과 방식이 다르다 | A-25(Phase 2, `K_store`)로 통일 |
| C-14 | `design/01-system-architecture.md:28`: Chrome 네트워크 "내장 eTLD+1 허용 목록 + 패키지 도메인" | `design/05-vault-secrets.md:34`: 허용 목록은 엔진이 가진다(집행 주체 엔진) | Chrome 수준 제한처럼 읽히지만 실제로는 엔진의 자기 집행이다 | A-12(금고 중계 재집행)와 문구 정정 |

---

## 4. D11 T2 "위생 장치이지 경계가 아니다"를 더 닫는 선택지 평가

판정: ○ 실질적으로 막음, △ 기준을 올림, ✕ 효과 없음. 대상 주체는 §0.2 참조.

| 선택지 | E(엔진 RCE) | D(docparse) | R(렌더러) | M(같은 사용자) | U(다른 사용자) | 현실성·비용 | 권고 |
|---|---|---|---|---|---|---|---|
| **중계 CDP 기본 거부 허용 목록 + 세션 범위 제한(A-01, A-12, A-13)** | △ 세션 탈취·파일 쓰기 차단, 되읽기는 남음 | — | — | ✕ | — | 중간. Playwright 호환성 스파이크 필요 | **채택(Phase 1)**. 이후 모든 격리의 전제 |
| **중계 응답 정리: 요청 바디·AX/DOMSnapshot 값·스크린샷(A-02, A-04)** | △ 정상 경로 누출 차단, 의도적 Runtime 읽기는 남음 | — | — | ✕ | — | 낮음~중간 | **채택(Phase 1)** |
| **비밀 창: typist·human:secret·remote 공통(A-06)** | △ | — | — | ✕ | — | 중간 | **채택(Phase 1)** |
| **원자적 타이핑(입력→제출→분리까지 보류) + 비밀 origin 사전 스크립트 금지(A-07a)** | △~○ 대부분의 되읽기 창을 닫음. 격리 월드 리스너 등 잔여 있음(확인 필요) | — | — | ✕ | — | 중간. 포털별 `secretSubmit` 셀렉터 필요 | **채택(Phase 2)** |
| **고수준 동작 브로커(엔진에 원시 CDP 없음, A-07b)** | ○ 엔진은 비밀 칸을 읽을 수단이 없음 | — | — | ✕ | — | 높음. Playwright를 무권한 드라이버 프로세스로 이동, ADR-001 재검토 | Phase 3 ADR로 결정 |
| **커밋 가드를 금고로, 무장 근거는 승인 서명(A-03)** | △ 승인 없는 발급 횟수 제한 | — | △ | ✕ | — | 중간 | Phase 2 |
| **docparse를 Chromium 렌더러 샌드박스로(A-14)** | — | ○ 키체인·DB·네트워크 접근 차단 | — | — | — | 낮음~중간. pdf.js는 브라우저용이라 적합 | **채택(Phase 1)**. ROI 최고 |
| **엔진을 AppContainer/Low IL 별도 실행 파일로** | △~○ 허용 목록 중계가 **먼저** 있어야 의미 있음. 없으면 Chrome을 통해 탈출 | — | — | ✕ | — | 높음. Electron utilityProcess는 AppContainer 기동 API가 없으므로(확인 필요) Node SEA·Rust 별도 실행 파일 + 데이터 폴더 ACL에 AppContainer SID 부여 + `internetClient` 능력 필요 | Phase 3 검토(브로커와 함께) |
| **금고를 AppContainer/Low IL로** | — | — | — | ✕ | — | 비현실적. 금고는 키체인 읽기와 Chrome 자식 기동이 필요하고, Chrome은 사용자 무결성 수준으로 돌아야 한다 | 비권고 |
| **금고를 Electron 밖 Rust 별도 실행 파일로** | △ 금고 자체 공격면·의존성 축소 | — | — | △ 덤프·디버그 설정 자체 통제 | — | 중간~높음. Bitwarden 방식 | Phase 2(A-20과 함께) |
| **Windows Hello(TPM) 결박 KEK(대화형 등급, A-22)** | ✕ 사용 시점 노출과 무관 | — | — | △ 무음 키체인 읽기 차단. 사용자를 속이는 가짜 프롬프트와 메모리 읽기는 남음 | ○ 이미 사용자별 | 중간(S10) | **채택(Phase 1~2)** |
| **DPAPI-NG(CNG DPAPI) 보호 기술자** | ✕ | — | — | ✕ `LOCAL=user`는 기존 DPAPI와 같은 범위, 사용자 존재 확인 없음 | ○ | 낮음 | 이점 없음. 비권고 |
| **VBS/Credential Guard** | ✕ | — | — | ✕ 앱 비밀이 아니라 LSASS 자격 증명 보호 | — | 해당 없음 | 비권고 |
| **VBS 엔클레이브(서드파티 엔클레이브 API)** | ✕ 비밀은 결국 Chrome 렌더러 DOM에 평문으로 입력됨 | — | — | ✕ 같은 이유 | — | 매우 높음. 특수 서명, Windows 11 24H2 이상(확인 필요) | 비권고(사용 시점 노출이 상한) |
| **별도 OS 계정에서 금고+Chrome 실행** | △ | — | — | △ 메모리 직접 읽기는 막지만, 같은 데스크톱에 창이 떠서 화면·입력 관찰은 남음 | — | 매우 높음. 관리자 권한으로 계정 생성, NPKI가 사용자 프로필 아래 있음, 보안 모듈·네이티브 메시징 호스트를 계정별 설치 | 비권고 |
| **프로세스 완화 정책(금고)**: 확장 지점 비활성, 원격·낮은 무결성 이미지 로드 금지, 엄격 핸들 검사 | — | — | — | △ 전역 훅·DLL 주입 계열만 차단. 같은 사용자의 프로세스 메모리 읽기는 못 막음 | — | 낮음~중간(네이티브 헬퍼). ACG는 V8 JIT와 충돌, `--jitless` 조합 가능 여부 확인 필요. 자식 프로세스 금지는 Chrome 기동과 충돌 | Phase 2 선택 |
| **프로세스 DACL 강화(금고·Chrome)**: 다른 프로세스의 VM 읽기 권한 제거 | — | — | — | △ 범용 인포스틸러는 막을 수 있음. 소유자는 DACL을 다시 쓸 수 있어 단호한 공격자는 통과 | — | 낮음 | Phase 2 선택. 잔여 위험 명시 |
| **Protected Process Light** | — | — | — | — | — | 불가(마이크로소프트 안티멀웨어 서명 필요) | 비권고 |
| **메모리 잠금(`sodium_malloc`/VirtualLock) + WER 제외 블록(A-20)** | — | — | — | △ 덤프·페이지 파일 잔존 감소 | — | 낮음 | **채택(Phase 1)** |

결론
- T2의 정직한 문구는 그대로 둔다.
- E에 대해서는 **중계 허용 목록 → 응답 정리 → 비밀 창 → 원자적 타이핑** 순서로 "엔진이 정상적으로는 비밀을 볼 수 없고, 침해되어도 되읽기 창이 아주 좁다"까지 올릴 수 있다. 완전한 경계는 고수준 브로커(Phase 3)뿐이다.
- M에 대해 의미 있는 것은 Hello 결박과 무인 등급 축소(A-22, A-23)뿐이다. 나머지 OS 기능은 비밀이 결국 사용자 권한 Chrome에 입력된다는 사실 때문에 상한이 낮다.
- D11 T2 '완화' 칸 정정안: "엔진: 중계 허용 목록·응답 정리·비밀 창(Phase 1), 원자적 타이핑(Phase 2), 고수준 브로커 검토(Phase 3). 같은 사용자 악성코드: Hello 결박 대화형 등급, 데몬의 저장 비밀 미사용, docparse 샌드박스로 무클릭 경로 제거."

---

## 5. 우선순위 Top 10

1. **A-02** 정상 경로에서 요청 바디로 비밀이 엔진 힙에 들어온다 → 중계에서 바디 제거, 스캐너 대상 추가(Phase 1)
2. **A-05** 검증기 V-20 "secretSlot 칸을 읽는 스텝 금지" + guide 변환 복사 버튼 금지(설계만)
3. **A-14** docparse를 Chromium 렌더러 샌드박스로. 다운로드 자동 파싱 축소, `isEvalSupported:false`(Phase 1)
4. **A-01** 중계 CDP를 기본 거부 허용 목록으로, 브라우저 타깃 비노출. ADR-005 v3(Phase 1 + S6b)
5. **A-06** 비밀 창을 `human:secret`·`fillFromRemote`까지 확장(Phase 1)
6. **A-10** 전용 프로필 설정은 엔터프라이즈 정책이 아니라 프로필 `Preferences`로, 기동 후 확인(설계만)
7. **A-04** AX·DOMSnapshot 값과 스크린샷 정리를 금고 중계에서(Phase 1)
8. **A-15** 로컬 비가역 승인을 main이 만드는 별도 승인 창으로, 실제 입력 관찰(Phase 1)
9. **A-07** 원자적 타이핑 + 비밀 origin 사전 스크립트 금지(Phase 2). 브로커는 Phase 3 ADR
10. **A-22·A-23** 비밀별 등급(사람 비밀은 Hello 결박 전용), 데몬의 저장 비밀 사용 금지(Phase 1, 설계)

차순위: A-20(덤프), A-18(경로·로밍), A-08(launch 인자 제거), C-07(골든 IR 파일명 PII), A-29(업데이트 매니페스트 서명).

---

## 6. 설계 문서만으로는 결정할 수 없고 스파이크가 필요한 것

| ID(제안) | 질문 | 관련 |
|---|---|---|
| S6b | Playwright가 금고 중계(MessagePort 또는 토큰 WS) 위에서 동작하는가? 브라우저 타깃 없이 쓸 수 있는 최소 CDP 메서드·도메인 집합은 무엇인가? `addScriptToEvaluateOnNewDocument`·`addBinding`을 비밀 origin에서 막아도 동작하는가? | A-01, A-07, A-09, C-10 |
| S6c | 테스트 사업자 계정으로 홈택스 로그인·보안카드·포털 비밀번호 제출 시 엔진이 받는 Network·Fetch 이벤트에 평문이 나타나는가? 중계 제거 후 0건인가? (정부24 제외, 보안 모듈 동작 분석 없음) | A-02 |
| S6d | Chrome 156에서 `type=password`와 `type=text` 비밀 칸 값이 `Accessibility.getFullAXTree`·`DOMSnapshot.captureSnapshot`·`DOM.describeNode` 응답 어디에 실리는가? | A-04 |
| S6e | 프로필 `Preferences` 기록만으로 비밀번호 저장 제안·자동완성·동기화가 실제로 꺼지는가(정책 없이)? `--disable-sync` 효과와 `Local State` 보고 설정의 기본값은? | A-10, A-27 |
| S6f | `human:secret` 구간에 엔진에 도달하는 CDP 메시지 목록을 측정하고, 비밀 창 적용 후 허용 목록과 일치하는지 확인한다(가상키패드·보안 모듈은 관찰·조작하지 않음) | A-06 |
| S6g | 금고 utilityProcess에서 Crashpad 제외가 가능한가? WER 동작과 `WerRegisterExcludedMemoryBlock` 효과는? Rust 별도 실행 파일과의 비용 비교 | A-20 |
| S13b | pdf.js + tesseract.js(wasm)를 샌드박스된 숨김 렌더러에서 돌릴 때 한글 추출률·처리 시간·메모리는? AppContainer 실행 파일 대안과 비교 | A-14 |
| S10(보강) | 비패키지 데스크톱 앱에서 `KeyCredentialManager` 키의 범위(앱별인지 사용자별인지), 프롬프트 전면 표시, 잠금 해제 TTL 구현 | A-22 |
| S10b | `@napi-rs/keyring`의 지속성 기본값과 바이트 API 유무. 없으면 Rust 헬퍼 필요 범위 | A-22, C-09 |
| S6h | 금고 프로세스에 적용 가능한 완화 정책 조합(확장 지점 비활성·이미지 로드 제한·엄격 핸들·`--jitless`+ACG)과 Node/Chrome 기동 호환성 | §4 |
| S6i | 전용 프로필 설치 확장을 파일(`Secure Preferences`·Extensions 폴더)로 신뢰성 있게 열거할 수 있는가? 보안 모듈 공식 확장 ID 목록 | A-11 |
| S6j | Chrome 136+에서 `--user-data-dir`에 기본 데이터 폴더 경로를 명시하면 파이프 디버깅이 거부되는가? | A-08 |
| S6k | Electron 앱이 Chromium 디버그 스위치와 함께 실행될 때, main JS가 실행되기 전에 DevTools 서버가 열리는가? | A-31 |
| S6l | Electron에서 클립보드 기록·클라우드 제외 형식을 같은 쓰기로 넣을 수 있는가? | A-32 |
| S6m | 비관리자 권한으로 시스템 드라이브 BitLocker·장치 암호화 상태를 읽을 수 있는가? 보조 NTFS 볼륨 루트의 기본 ACL은? | A-25, A-19 |
