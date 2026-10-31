# PoC-4 금고 최소판 · PoC-5 로컬 데이터 — 결과

- 날짜: 2026-10-28 · 브랜치 `claude/poc-vault-localdata-d175a0` · 폐기 전제 코드(ADR-017)
- 환경: macOS arm64 개발기, 설치 Chrome 156.0.8078.73, Electron 45.1.0. **Windows 11 재확인은 2026-10-31 PoC-1 실기기(관리자 계정 비승격)에서 했다**(§5, [PoC-1.md](PoC-1.md) §5). 표준 사용자 계정 재확인은 남았다.
- 전체 테스트: `cd poc && pnpm test` → 40건 통과(PR #1 리뷰 회귀 7건 포함). Electron e2e: `electron apps/desktop/dist/e2e.js` → 14건 통과. 앱 스모크: `node --conditions=development tests/app-smoke.ts`
- S6b 상세: [S6b.md](S6b.md)

## 1. 합격 기준 대조(D14 §0, 보드 acceptance)

| 기준 | 결과 | 근거 |
|---|---|---|
| PoC-4: CDP 이벤트·로그·IPC에 비밀 0건 | **0건**: 테스트 비밀 5개 × 인코딩 변형 12종(utf8·utf16le·json·url·hex·HEX·base64/base64url 3정렬). 대상은 엔진 포트 IPC 1,336건(엔진이 받은 CDP 이벤트·응답 전부 포함), 금고 로그, 종료 후 전용 Chrome 프로필 디스크 418개 파일 | `tests/vault-relay.test.ts` 마지막 케이스, `tests/playwright-relay.test.ts`, `reports/raw/relay-measurements.json` `leakScan` |
| PoC-4: 허용 목록 밖 호출 거부 | 루트 15종·세션 14종 거부 + `vault.cdp_denied`(인자 없이 메서드·사유만). 사용자 탭 비노출, 허용 origin 팝업만 노출(fail-closed: 커밋 + getFrameTree 확인 뒤, 시간 경과로는 노출 안 함), 허용 밖 origin은 엔진 세션 분리, 자식 iframe은 커밋마다 재검사해 그 자식만 분리 | `vault-relay.test.ts` 2~4번 |
| PoC-4: Playwright 중계 동작 여부 확정 | **동작**(MessagePort, WS 폴백 불필요) | [S6b.md](S6b.md) |
| PoC-4: 승인 창이 실제 입력만 인정 | main이 `before-mouse-event`·`before-input-event`로 직접 관찰한다. 600ms 무장 지연, 같은 버튼 안 down/up이나 Alt+Y만 승인, Enter 단독은 무시. 창은 스크립트 없음(`javascript:false`)·CSP·포커스 비탈취이고, 렌더러 신호에는 승인 경로가 없다 | `apps/desktop/src/e2e.ts` 11건, `tests/guards.test.ts` |
| PoC-5: 프로필·거래처 CRUD | 개인 1 + 사업자 1(종류별 유일, 같은 종류는 갱신), 거래처 생성·검색·수정·삭제·중복 거부, 사업자번호 체크섬 | `tests/localdata.test.ts` |
| PoC-5: 사업자등록증 OCR 입력 | tesseract.js kor(로컬 언어 데이터)로 docparse 샌드박스(ADR-014)에서 인식한 뒤 엔진 파서가 필드를 채운다. 사용자 확인 후 `source='ocr'`로 저장 | `tests/ocr.test.ts`, e2e docparse |
| PoC-5: 진위확인 성공 | 상태조회·진위확인 클라이언트와 오류 분류 완료. 모의 서버 기준으로 일치·불일치·키 오류 통과. **실서버 호출은 사용자 공공데이터포털 키가 필요해 미실행**(아래 §4) | `tests/localdata.test.ts` 진위확인 묶음 |
| PoC-5: DB 암호화·`%LOCALAPPDATA%` 경로 | sqlcipher(legacy=4, `key(Buffer)`), `temp_store=MEMORY`, 파일 0600, 평문 SQLite 서명 없음, DB·WAL에 평문 표지 0건, 다른 키로는 열리지 않음. 경로는 `%LOCALAPPDATA%\SovereignAX`(Windows)와 `~/Library/Application Support/SovereignAX`(mac 동등 경로), 루트 0700으로 기동마다 복구, 재분석 지점 거부 | `tests/localdata.test.ts`, `reports/raw/app-smoke.json` |
| DB 소유는 엔진 하나, main은 읽기 IPC | DB 키는 금고 `getDbKeyOnce()`로 엔진에만 1회 전달(2회째 거부 + `vault.dbkey_requested_twice`). main은 `db.query.*`·사용자 명령만 엔진에 중계하고 DB를 열지 않는다 | `packages/engine/src/entry.ts`, `apps/desktop/src/main.ts` |
| engine `fetch/net/http` 직접 import 금지 | ESLint `no-restricted-imports`·`no-restricted-globals`. 위반 예시 테스트가 오류를 낸다 | `eslint.config.mjs`, `tests/guards.test.ts` |

## 2. 스파이크 측정(S6c~S6f, 로컬 픽스처 기준)

홈택스 실측(S6c 본래 정의)은 PoC-1(테스트 계정·인증수단) 이후에 한다. 여기서는 127.0.0.1 픽스처(폼 POST, iframe 폼, 전용 워커 fetch, SPA fetch 로그인)로 메커니즘을 확인했다.

- **S6c(요청 바디)**: 엔진이 받은 POST 요청 이벤트(메인 프레임 폼, 워커 fetch, SPA fetch)에는 `postData`·`hasPostData`가 하나도 없었다. 오염 요청의 `getRequestPostData`는 문서 커밋 이후에도 거부된다. 포털(픽스처)은 실제로 비밀을 받았다.
- **S6d(Chrome 156 값 필드)**: 정리 전 금고 세션에서 측정했다.
  - `DOMSnapshot.captureSnapshot`의 `nodes.inputValue`에 **비밀번호 평문**이 실린다.
  - `Accessibility.getFullAXTree`에는 평문이 없지만 **같은 길이의 •**가 실린다. 칸의 `value`와 안쪽 StaticText 자식의 `name`에 나타나 길이가 드러난다.
  - `DOM.describeNode`에는 값이 없다.
  - 중계는 세 경로를 모두 정리한다: DOMSnapshot 항목 제거, AX의 비밀 노드·자손 value/name 제거, 마스킹 문자만 있는 값 제거.
- **S6e(Preferences)**: 기동 전 기록, 기동 1.5초 뒤 다시 읽기, 확장 열거, Google 로그인 감지를 구현했다. 헤드풀 앱 스모크에서 불일치 이벤트는 없었다. "저장 제안·자동완성이 실제로 꺼지는가"는 Windows 실기기에서 화면으로 확인했다(§5.1).
- **S6f(비밀 창)**: 활성 창 동안 엔진의 `Runtime`·`Input`·`DOM.focus`·`Accessibility`·`DOMSnapshot`·`Emulation`·스크린샷·`Target.activateTarget`은 거부되고, `Runtime.consoleAPICalled`·`bindingCalled`는 엔진에 가지 않았다. 활성 창은 blur + 값 있음, 엔진 종료 요청, 문서 커밋으로 끝난다. 엔진 종료 요청은 포커스가 남아 있으면 거부된다. SPA 로그인에서 종료 뒤 엔진 클릭이 되고 교착은 없었다. 오염 상태에서 패턴 우회 표현식(`['val'+'ue']`)과 Playwright `inputValue`는 알려진 값 지우기로 `[vault-redacted]`가 됐다. 이것은 위생 장치이고 경계가 아니다(D05 §3.5 정직 문구).
- **S6 공통**: Chrome 프로세스의 TCP 수신 소켓은 0개(`lsof`)였고 `DevToolsActivePort` 파일도 없었다. `launch()`에는 인자가 없다. 기동 인자는 허용 목록 3개뿐이고 금지 인자는 거부된다. 환경 변수는 화이트리스트로 정리한다(`HTTPS_PROXY`·`NODE_OPTIONS` 등 제거). `navigator.webdriver === true` 자기 점검도 통과했다.

## 3. 설계와 달라진 점·질문(코드 우회 없이 보드에 질문)

1. **타이피스트 입력 방식**(D05 §4-3): `setIgnoreInputEvents(true)`가 CDP `dispatchKeyEvent`까지 막는다. PoC 기본값은 `insertText`이고 상수로 전환할 수 있다. → 보드 질문.
2. **오염 중 Runtime 패턴 차단**(D05 §3.4)이 Playwright 주입 스크립트 첫 기동과 충돌한다. PoC는 엔진이 비밀 창 전에 world를 미리 만든다. → 보드 질문.
3. **page 수준 `Target.setAutoAttach`**: 엔진에 허용하고, 자식은 금고가 origin으로 거른다. 브라우저 수준은 금고만 한다. → 보드 질문.
4. **오염 범위**: 설계는 창이 열린 프레임·하위·부모·같은 탭 워커다. PoC는 **타깃 전체**(모든 프레임·자식 세션)를 오염으로 본다. 설계보다 넓은 쪽이라 질문하지 않았고, 종료 조건은 설계대로 창 프레임의 다음 문서 커밋이다.
5. **알려진 값 지우기**(추가): 금고가 입력했거나 활성 창 종료 때 읽은 값(6자 이상)의 직렬화 변형을 엔진행 메시지에서 지운다. 설계에 없는 다중 방어이고 금고(TB-1) 안에서만 값을 다룬다.
6. **진위확인 자기 키**: D09 §4.1 (b)는 "금고에 저장"이지만 PoC는 비밀을 저장하지 않으므로 키를 실행 중 엔진 메모리(egress)에만 둔다(D05 §2 BYOK 행과 같은 위치). 키는 `Authorization: Infuser` 헤더로만 보낸다.
7. **패키지 추가**: D01 §7 목록 외에 `platform`(경로·ACL·로그·포트 추상화), `net`(egress), `tests`를 두었다.
8. **OCR 입력 형식**: PoC-5는 이미지(png/jpg)만 받는다. PDF(텍스트 층)는 PoC-8 docparse pdf.js에서 다룬다.

## 4. 남은 일

- **진위확인 실호출**: 공공데이터포털 "국세청 사업자등록정보 진위확인 및 상태조회" 활용신청 후 받은 **본인 키**로 앱의 "진위확인 키" 칸에 넣고 거래처 행의 `상태조회`·`진위확인`을 누른다(키는 저장되지 않음). 성공하면 PoC-5 스레드에 결과 코드만 남긴다.
- **Windows 11 재확인(PoC-1 후)**: §5.
- PoC-6 연결점: R-C1 본문 대조(`commit.arm`), `Fetch.enable` 패턴을 `manifest.commitEndpoints`에 묶기, 게이트 카드를 엔진 신뢰 계획값으로 만들기(`approval.demo` 대체), LocalApproval 키를 금고와 교환.

## 5. Windows 전용 부분 — Windows 11 Home 25H2 x64 실기기, 2026-10-31

원자료 [raw/win/](raw/win/). ✅ 확인 · ⚠️ 설계와 다름 · ⏳ 남음.

| 항목 | 결과 | 남은 것 |
|---|---|---|
| 루트 DACL(소유자 + SYSTEM, 상속 차단) | ✅ 실제 루트 `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;<사용자 SID>)`. 판정을 SID 기준(`icacls /save` SDDL, 괄호 단위 파서)으로 바꾸고, 직접 더한 ACE(Users 읽기)·거부 ACE·조건부 ACE도 잡아 복구하도록 고쳤다. 다른 계정 소유 폴더는 `not_owner`로 거부한다(PoC-1 §5·§6) | ⏳ 다른 사용자 계정에서 접근 거부(표준 계정 만든 뒤) |
| 검색 색인 제외 | ✅ `attrib` 속성 `I`(테스트에 확인 추가) | — |
| 재분석 지점(정션) | ✅ 정션이 `isSymbolicLink()`로 잡혀 `reparse_point` 거부(테스트를 정션으로 바꿈) | — |
| Chrome 경로 후보 | ✅ `%ProgramFiles%` 설치 탐지·기동(156.0.8078.47) | `(x86)`·`%LOCALAPPDATA%` 설치 기기 없음 |
| Credential Manager(`@napi-rs/keyring` 바이트 API) | ✅ 저장·재사용 동작(`db-key.SovereignAX`, 32B). ⚠️ 지속성이 `CRED_PERSIST_ENTERPRISE`(3)다. 설계(S10b)는 `LOCAL_MACHINE`. 도메인 로밍 프로필이면 열쇠가 다른 PC로 따라간다 | Phase 1 키체인 어댑터(M1-3)에서 `CredWriteW` 직접 호출(지속성 2)로 바꿀지 결정. 보드 질문 |
| 파이프 기동·중계 | ✅ `pnpm test` 115/115(S6b 6/6 포함). 차이 1건: 비밀 창 활성 중 엔진에 `Inspector.workerScriptLoaded`(인자 없음)가 1회 전달됐다(Mac 0회). 값은 없고 누출 스캐너 0건 | 허용 목록에서 이 이벤트를 활성 창 동안 막을지 판단 |
| 승인 창 `before-mouse-event` 좌표·DPI | ✅ OS 배율 150%(2560×1440)에서 e2e 14/14, 앱 배율 강제 125%·150%에서도 14/14 | ADR-020으로 제품에서는 별도 승인 창이 없어진다. 대체 승인 근거 재설계 때 다시 잰다 |
| S6e 저장 제안·자동완성 꺼짐 | ✅ `Preferences` 기록만으로 비밀번호·주소·카드 저장 제안과 자동완성 목록이 모두 뜨지 않았다. 대조군(기록 없는 새 프로필)에서는 셋 다 떴다(§5.1) | 사용 통계 보고: 이 기기는 설치 단계 동의가 꺼져 있어 `Local State` 값만의 효과는 판별하지 못했다 |

### 5.1 S6e 화면 확인

`node --conditions=development tests/s6e-screen.ts reports/raw/win/s6e`. 금고와 같은 방식(기동 전 `writeProfileSettings`, 허용 인자 3개, 헤드풀)으로 설치 Chrome 156.0.8078.47을 띄운다. 127.0.0.1 픽스처의 로그인·주소·카드 폼을 CDP 마우스·`insertText`로 채워 제출한다. 그다음 같은 폼을 다시 열어 첫 칸을 누른다. 저장 제안 말풍선은 브라우저 UI라 CDP 스크린샷에 잡히지 않는다. 그래서 Chrome 프로세스의 보이는 최상위 창을 열거해 `PrintWindow`로 남겼다(`tests/s6e-capture.ps1`, 다른 앱 화면은 들어가지 않는다). 폼 값은 합성 값이고 카드는 공개 시험 번호다. 저장 버튼은 누르지 않았다.

| 확인 | 금고 프로필 | 대조군(새 프로필) |
|---|---|---|
| 로그인 제출 뒤 | 본창만 | "비밀번호를 저장하시겠습니까?" 말풍선 |
| 주소 제출 뒤 | 본창만 | "주소를 저장하시겠어요?" 말풍선 |
| 카드 제출 뒤 | 본창만 | "카드를 저장하시겠습니까?" 말풍선 |
| 폼 다시 열고 첫 칸 클릭 | 팝업 없음 | 이전 입력값 자동완성 팝업. 카드 칸은 "보안 연결이 아니라 자동 결제 수단 채우기 중지" 안내 |
| 종료 뒤 `Web Data` `autofill` 행 | 0 | 12 |
| 종료 뒤 필수 값 4개·`Local State` | 기록한 값 유지(불일치 0) | 키 없음(기본값) |

- Chrome은 종료 때 기록한 값을 지우거나 되돌리지 않았다. 새 `user-data-dir`의 `Local State`에는 `user_experience_metrics.reporting_enabled` 키가 없다.
- 이 기기의 설치 단계 사용 통계 동의는 레지스트리 `ClientStateMedium` `usagestats=0`(꺼짐)이다. 설치 때 동의한 PC에서 `Local State` false만으로 보고가 꺼지는지는 판별하지 못했다. 기계 정책 키는 `LocalNetworkAccessAllowedForUrls` 하나뿐이고, 비밀번호·자동완성과는 관계없다.
- 금고 프로필 도구 모음에 "Chrome에 로그인하시겠습니까?" 칩이 보인다. 사용자가 전용 프로필에서 Google에 로그인할 수 있다는 뜻이다. 금고는 로그인을 사후 감지(`hasGoogleSignin`)해 비밀 창을 거부한다(설계대로). `--disable-sync`는 허용 목록 밖이라 시험하지 않았다.

## 6. 앱 스모크가 만든 것(개발기)

`~/Library/Application Support/SovereignAX/`(db·chrome-profile·logs 등)와 키체인 항목 `SovereignAX / db-key`. 지우려면:

```bash
rm -rf ~/Library/Application\ Support/SovereignAX
```

```bash
security delete-generic-password -s SovereignAX -a db-key
```
