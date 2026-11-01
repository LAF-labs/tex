# PoC-1 환경 문서 (2026-10-30, 초안)

범위: D14 §0 PoC-1. PoC-3(홈택스 로그인·S1·S2)부터 PoC-10(S8)까지 쓰는 Windows 환경, 전용 Chrome 프로필, PoC 계정 지정. 인증수단·Artifact Signing 신청은 EX-6이 맡는다. 계정 정지 위험 수용은 [PoC-1-risk-acceptance.md](PoC-1-risk-acceptance.md).

상태 표기: ✅ 확정 · ⏳ 결정·작업 대기 · 📏 PoC-3 첫 접속 때 기록.

## 1. 호스트 ✅(결정) / ⏳(기기 준비)

| 항목 | 값 |
|---|---|
| 개발 Mac | Apple M5 Pro(arm64), macOS 26.5.1, VM 소프트웨어 없음 |
| PoC 실행 호스트 | **x64 Windows 11 실기기 1대**(2026-10-30 결정) |
| 기기(2026-10-31 준비) | ASRock A620M-HDV/M.2, AMD Ryzen 5 7500F, RAM 32GB, NTFS `C:` 1TB 단일 볼륨 |
| OS | Windows 11 **Home** 25H2(빌드 26200). 25H2는 24H2 플랫폼 위 활성화 패키지라 §2의 24H2 기준과 같은 계열로 본다. Home에는 BitLocker 관리 도구 대신 장치 암호화만 있다(§6) |

Mac 위 VM(Parallels·UTM)은 **Windows 11 ARM**이다. x64 앱은 에뮬레이션으로 돌지만 커널 드라이버는 돌지 않는다. 홈택스가 요구하는 키보드 보안·인증서 모듈 중 드라이버를 쓰는 것이 있으면 ARM VM에서는 로그인부터 막힐 수 있다. 대상 사용자 PC(x64 Windows)와도 다르다. 그래서 ARM VM은 쓰지 않는다.

x64 클라우드 VM은 쓰지 않는다. 데이터센터 IP는 "본인 IP"가 아니라서 05 §비대상화와 맞지 않고 차단 위험이 커진다.

## 2. Windows 이미지 ⏳

| 항목 | 값 | 근거 |
|---|---|---|
| OS | Windows 11 24H2 x64(1차). 23H2는 G1 뒤 행렬에서 | D18 §2 |
| 계정 | 관리자 계정과 표준 사용자 계정 **둘 다 지원**(2026-10-31 결정, §2.1). 앱·Chrome은 어느 계정에서도 승격하지 않는다. 보안 모듈 설치만 관리자 승격 | 대상 사용자 PC는 대부분 UAC 켜진 관리자 계정, S6m |
| 백신 | Microsoft Defender 기본값. V3·알약 조합은 Phase 1 행렬 | D18 §2 |
| 디스크 | NTFS 시스템 볼륨 + 보조 볼륨 1개(S6m ACL 측정용) | D19 A-19 |
| 네트워크 | 사무실 또는 본인 회선. VPN·프록시·IP 전환 금지 | 05 §비대상화 |
| 시간대·로캘 | Asia/Seoul, ko-KR | — |

### 2.1 계정 두 종류

UAC가 켜진 관리자 계정은 평소 실행 토큰이 **비관리자**다(`Administrators` 거부 전용, 무결성 Medium). 그래서 승격하지 않은 앱은 표준 사용자와 같은 권한으로 돈다. 차이는 승격할 때 암호가 필요한지뿐이다.

| | 관리자 계정(1차) | 표준 사용자 계정(재확인) |
|---|---|---|
| 쓰는 곳 | 빌드·테스트, S6m, 홈택스 실행(PoC-3~10) | 같은 테스트·S6m·DACL 재확인. 홈택스 로그인은 하지 않는다 |
| 보안 모듈 설치 | UAC 동의 | 관리자 암호 입력 |
| 공동인증서(NPKI) | 이 계정 프로필에만 둔다 | 두지 않는다(인증서 복사본을 늘리지 않음) |
| `%LOCALAPPDATA%`·Credential Manager | 계정별로 따로 | 계정별로 따로 |

- 앱을 "관리자 권한으로 실행"하지 않는다. 승격 상태에서 만든 파일은 소유자가 `Administrators`가 되어 루트 DACL(소유자 + SYSTEM) 확인과 어긋날 수 있다.
- 실행 계정: 관리자 계정 `once0`(UAC 켜짐, 동의 프롬프트 기본값). 표준 사용자 계정은 사람이 만든다(에이전트는 OS 계정을 만들지 않는다).

## 3. Chrome·전용 프로필 ✅

- 사용자 설치 Chrome stable(`%ProgramFiles%\Google\Chrome\Application\chrome.exe`). 자동 업데이트는 끄지 않고, 실행마다 버전을 원장·보고서에 남긴다(ADR-001 결과). 2026-10-31 설치 버전 **156.0.8078.47**(Mac 측정은 .73). 금고 후보 경로 첫 번째(`%ProgramFiles%`)에서 찾았다. `(x86)`·`%LOCALAPPDATA%` 설치는 이 기기에 없어 확인하지 않았다.
- 전용 프로필은 금고가 만든다: `%LOCALAPPDATA%\SovereignAX\chrome-profile`(`packages/platform/src/paths.ts`). 일상 Chrome 프로필에는 붙이지 않는다(ADR-001 v1.3 보완).
- 기동 인자는 금고 상수 `CHROME_ARG_ALLOWLIST` 3개뿐(`--remote-debugging-pipe`, `--user-data-dir`, `--no-first-run`). `navigator.webdriver=true`는 그대로 둔다(ADR-010).
- 그 Windows 사용자 계정의 일상 Chrome은 PoC 기간에 홈택스에 로그인하지 않는다(세션 혼선 방지).

## 4. 포털 보안 모듈 📏

홈택스 첫 접속에서 설치를 요구하는 프로그램 이름·버전·설치 방식(관리자 승격 여부, 드라이버 여부)을 표로 남긴다. 금고 허용 목록에 넣을 간편인증·서명 모듈 도메인(`PORTAL_ETLD1` 주석)도 이때 채운다.

| 모듈 | 버전 | 드라이버 | 설치일 |
|---|---|---|---|
| (PoC-3에서 기록) | | | |

## 5. 빌드 도구 ✅(관리자 계정, 2026-10-31)

| 항목 | 값 |
|---|---|
| Node.js | 26.13.0(winget `OpenJS.NodeJS.LTS`, 시스템 전체 설치라 표준 계정도 같은 Node) |
| pnpm | 12.11.2(`npm i -g`, 계정별) |
| 네이티브 모듈 | `better-sqlite3-multiple-ciphers` 13.0.3은 패키지 안 `prebuilds/win32-x64.node`를 쓴다. 빌드 도구 불필요(VS Build Tools 2022·Python 3.14는 있음) |
| Electron | 45.1.0. `pnpm install` 뒤 바이너리가 받아지지 않아 `node_modules/.pnpm/electron@45.1.0/node_modules/electron`에서 `node install.js`를 한 번 돌렸다 |
| 결과 | `pnpm build`·`pnpm lint` 통과, `pnpm test` **119/119**(DACL 파서·복구, 소유자 판정 테스트 4건 추가 후), e2e **14/14**(OS 배율 150%, 앱 배율 강제 125%·150% 각 14/14), 앱 스모크 통과(소유자 확인 추가 뒤 다시 확인). 원자료 [raw/win/](raw/win/) |

Windows에서 처음 돌렸을 때 실패한 원인과 고친 것:

| 증상 | 원인 | 수정 |
|---|---|---|
| 번들 8종 BV-06 digest 불일치 | Git for Windows 기본 `core.autocrlf=true`로 접두 텍스트가 CRLF로 체크아웃됨 | 저장소 루트 `.gitattributes`(`* text=auto eol=lf`) |
| `prepareLayout` 실패 → 이후 테스트 연쇄 실패·10분 넘게 멈춤 | `whoami`를 PATH로 찾아 Git의 `whoami`가 돌았다 | `whoami`·`icacls`·`attrib`를 System32 절대 경로로(`windowsTool`) |
| (잠재) 한글 사용자 이름에서 DACL 판정 오류 | `icacls` 출력의 계정 이름은 콘솔 코드 페이지(CP949) | `icacls /save`의 SDDL로 SID 비교(`readDacl`) |
| (잠재) 누가 직접 더한 ACE가 복구 뒤에도 남음 | `/inheritance:r`은 상속 ACE만 지운다 | 사용자·SYSTEM 밖 SID를 `/remove`로 제거, 테스트에 Users 읽기 ACE 복구 추가 |
| (잠재) 조건부 ACE(`XA`, Everyone 허용 등)를 못 보고 통과 · 무결성 레이블(`S:`)을 다른 계정으로 오탐 | SDDL을 필드 6개짜리 정규식으로 읽었다 | 괄호 단위 파서(`parseDacl`), 읽지 못한 ACE·null DACL은 실패로. `icacls /remove`가 콜백 ACE를 못 지우므로 남으면 DACL 전체를 바꾼다(.NET `Directory.SetAccessControl`, 비승격 가능. `icacls /restore`는 SeRestorePrivilege가 필요해 못 씀) |
| (잠재) 다른 계정이 먼저 만든 폴더를 전용으로 판정 | Windows `checkPrivate`가 소유자를 보지 않았다(POSIX는 `not_owner`를 본다). 소유자는 암묵적 `WRITE_DAC`로 DACL을 다시 열 수 있다(§6 (2)) | 소유자 SID를 읽어(`readOwner`, `icacls /save`에는 없어 .NET `Get-Acl`) 사용자·SYSTEM·Administrators가 아니면 `not_owner`. `ensurePrivate`는 그런 폴더의 DACL을 고치지 않고 실패로 돌려준다 |
| 재분석 지점 테스트 EPERM | Windows 심볼릭 링크는 개발자 모드·권한 필요 | 테스트를 권한 없이 만들 수 있는 정션으로 |

### 5.1 PR #9 리뷰 반영: 전용 프로필 폴더(2026-10-31, Mac에서 확인, Windows 재실행 필요)

Cursor Bugbot(High): `Vault.launch`가 프로필 폴더 `ensurePrivate`의 결과를 버렸다. 위 소유자 수정 뒤로는 다른 계정 소유 폴더에 대해 `ensurePrivate`가 고치지 않고 `not_owner`만 돌려주므로, 그 폴더로 Chrome이 떴다(D05 §3.1 위반). 기동 거부만 넣지 않고, 실패하지 않는 쪽을 먼저 고르도록 바꿨다(`preparePrivateDir`).

| 프로필 폴더 상태 | 처리 |
|---|---|
| 이미 사용자 전용 | 손대지 않는다. 전에는 기동마다 DACL을 다시 써서 프로필 전체로 상속이 전파됐다 |
| 권한만 틀림(`inherited`·`extra_principal`·`others_access`) | 제자리에서 고친다. macOS ACL 항목도 지운다(`chmod -N`). 전에는 남아서 판정이 실패했다 |
| 우리 것이 아님(다른 계정 소유, 링크·정션, 파일, 이 폴더에서만 확인·복구 도구가 접근 거부) | 사용자 전용 루트 안에서 `chrome-profile.untrusted-<시각>-<난수>`로 이름을 바꿔 치우고 새로 만든다. 부모의 FILE_DELETE_CHILD로 하위 권한과 관계없이 이름을 바꿀 수 있다. 치운 항목은 지우지 않는다(링크 대상 보호, 원인 조사). 도구 예외로 판단했으면 부모 확인이 통과한 뒤 한 번 더 확인해서, 일시 실패로 정상 프로필을 치우지 않는다. Windows는 백신 잠금에 대비해 이름 바꾸기를 약 1초 안에서 다시 시도한다 |
| 새 폴더를 만들지 못했거나 맞지 않음(쓰기 도구가 막힌 환경 등) | 새 폴더가 있으면 지우고, 치운 항목을 원래 이름으로 되돌린 뒤 기동하지 않는다. 원래 프로필을 잃지 않고, 재시도마다 치운 폴더가 쌓이지 않는다(만들기 실패 시 되돌리기 누락은 Bugbot 2차 지적으로 수정) |
| 부모가 사용자 전용이 아님 · 도구가 부모에서도 실패 | 손대지 않고 기동하지 않는다(`chrome profile not private: …` 또는 도구 예외) |

- 금고 로그 파일에 `vault.profile_dir_problem`(처음 문제, 치운 이유, 치운 이름, 결과)을 남긴다.
- `prepareLayout`도 하위 폴더 자리에 파일·링크가 있으면 같은 방식으로 치운다. 전에는 파일이면 `mkdir`가 실패해 앱이 창 없이 멈췄고, `staging`이 링크면 기동 정리가 링크 대상의 파일을 지웠다. 치운 항목은 `main.layout_set_aside`로 로그 파일에 남긴다. 준비 중 예외는 대화상자로 알린 뒤 끝낸다.
- 다른 주체 ACE만으로는 프로필을 치우지 않는다. Chrome 샌드박스가 프로필에 ACE를 붙이면 기동마다 프로필을 잃게 되기 때문이다.
- 확인(Mac): `pnpm build`·`pnpm lint` 통과, `pnpm test` 전체 통과(Windows 전용 3건 건너뜀), 앱 스모크 통과. 다음 경우에 해당 테스트가 실패하는 것을 확인했다(변형 시험).
  - 수정 전 코드로 되돌리면 새 기동 테스트 2건이 실패한다.
  - `chmod -N`을 빼면 macOS ACL 테스트가 실패한다.
  - 재확인이나 되돌리기를 빼면 해당 테스트가 실패한다.
  - 새 폴더 만들기 실패를 되돌리지 않으면 해당 테스트가 실패한다.
- 검수: Opus 3회, Bugbot·CodeSolar 재검토(Bugbot Medium 1건 수정, CodeSolar 지적인 테스트의 PowerShell 경로 보간을 환경 변수로).
- **Windows에서 다시 돌릴 것**:
  - `pnpm test`. 새 Windows 전용 테스트 "우리를 막는 DACL(OWNER RIGHTS)"를 포함한다.
  - 앱 스모크.
  - 다른 계정 소유 폴더의 실물 시험은 표준 계정을 만든 뒤 한다.
  - 수동 확인 1건: 우리에게 아무 권한도 주지 않는 DACL(예: `D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;<다른 SID>)`)인 폴더도 부모 권한만으로 이름을 바꿀 수 있는지. `MoveFileExW`가 원본을 SYNCHRONIZE로 연다면 실패한다. 그 경우 그런 폴더는 치우지 못하고 기동하지 않는다(안전한 실패). 자동 테스트로 만들지 않은 이유는 비승격으로는 지울 수 없는 폴더가 남기 때문이다.

후속(이 PR 밖):
- 루트 자체가 다른 계정 소유면 여전히 앱을 시작하지 않는다(사용자 데이터라 치우지 않는다). 복구 방식은 결정이 필요하다.
- (검수 지적, 미확인) 드라이브 문자가 아닌 대상(볼륨 GUID 등)을 가리키는 정션은 Node가 링크로 보고하지 않아 재분석 지점 확인을 지나칠 수 있다. 사용자 전용 루트 안에 심으려면 같은 사용자나 관리자여야 해서 위험은 낮다.

### 5.2 PR #9 후속 반영(2026-11-01, Mac에서 확인, Windows 재실행 필요)

§5.1 후속 셋을 Windows 재실행 전에 고쳐, 재실행 한 번으로 같이 확인한다. Opus 검수 3회의 지적도 함께 반영했다.
- 1차: 멈춘 기동은 닫기로도 풀 수 없음, 두 번 누르면 이동끼리 끊김 등
- 2차: Chrome을 띄우기 전 도구가 멈추면 상한이 듣지 않음, 금고가 Chrome을 내려도 엔진이 모름 등
- 3차: 고치는 도구에 상한을 두면 하위 전파가 끊긴 채 통과함, 내리는 중 들어온 트리거가 버려짐 등

| 후속 | 처리 |
|---|---|
| `userData`·`logs`·`crashDumps`를 확인 전에 Electron에 넘김 | `prepareLayout`을 `app.whenReady()` 안에서 진입점 최상위 `await`로 옮겨 `setPath`보다 먼저 끝낸다. ESM 진입점의 최상위 await가 끝날 때까지 ready가 오지 않고, ready 전 `app.exit`는 바로 끝낸다(Electron 45 실측). 실패하면 대화상자로 알리고 `app.exit(1)`이며, 확인 안 된 경로는 `setPath`에 넘기지 않는다. 앱 스모크 2단계에서 임시 앱 루트의 세 자리에 바깥 폴더로 가는 링크를 심고 띄운다. 새 순서는 바깥 폴더가 비어 있고 세 자리가 실제 폴더이며 `main.layout_set_aside` 3건이 남는다. 옛 순서로 같은 시험을 하면 Electron이 링크 너머에 `DevToolsActivePort`·`GPUPersistentCache`를 먼저 쓴다(실측) |
| 엔진 `browser.open` 동시 호출이면 금고 `launch`가 두 번 돎 | 엔진은 열기·닫기·첫 이동을 한 줄로 세운다(`RunBrowserSlot`). 두 번째 열기는 첫 번째 결과를 받고, 두 번 눌러도 이동끼리 끊지 않는다. 띄우는 중의 닫기는 금고에 내리기를 먼저 보내 기동을 끊고, 다 끝난 뒤 정리한다. 닫기 전에 줄만 서 있던 열기는 Chrome을 새로 띄우지 않고 `browser closed`로 끝난다. 붙이기가 실패하면 금고 쪽 Chrome을 내려 다음 열기가 막히지 않게 한다. 실행 페이지가 닫혔거나 연결이 끊겼으면 금고 쪽까지 내리고 새로 띄운다 |
| 〃 (금고 쪽) | 기동 중의 두 번째 `launch`를 거부한다(같은 프로필 폴더를 두 번 준비하면 한쪽이 다른 쪽 폴더를 치울 수 있다). Chrome을 띄운 뒤 30초 안에 붙지 못하면 Chrome을 내리고 `chrome launch timed out`으로 실패한다(멈춘 파이프의 대기 요청이 거부된다). 그 앞 단계의 폴더 읽기 도구(whoami·`icacls /save`·Get-Acl·ls)는 하나에 30초 상한을 둔다. 고치는 도구(`icacls /grant`·`/remove`, SetAccessControl)에는 두지 않는다. 폴더 DACL을 먼저 쓰고 하위로 전파하므로, 도중에 죽이면 최상위만 고쳐진 채 확인을 통과하고 하위에는 옛 상속 ACE가 남는다. 내리기마다 세대 번호를 올린다. 기동 중에 내리기가 오면 기동이 Chrome을 띄우지 않거나, 띄운 것을 닫고 `launch cancelled`로 끝난다. Chrome을 띄운 뒤 중계 준비가 실패해도 닫고 처음 상태로 돌린다. Chrome 실행 파일을 띄우지 못하면(EACCES 등) 금고가 죽지 않고 거부한다. 전에는 `already launched`로 앱을 다시 켜야 했다 |
| 금고가 Chrome을 내려도 엔진이 모름 | Chrome 파이프가 닫히면 금고가 엔진 포트에 `cdp_closed`를 보내고, 엔진은 CDP transport를 닫는다. Playwright가 `disconnected`를 받아 다음 열기에서 새로 띄운다(실제 금고로 시험). Playwright가 닫힘 콜백을 달기 전에 닫혔으면 다음 요청에서 다시 알린다. 옛 transport를 늦게 닫아도 새 transport는 그대로다. 내린 뒤의 옛 중계 출력은 엔진에 보내지 않는다. 루트 명령·브라우저 이벤트 처리의 거부는 잡아서 오류로 답하거나 기록한다. Chrome이 닫히는 중에 Playwright가 붙으면 처리 안 된 거부로 금고 프로세스가 죽을 수 있었다 |
| 다시 띄울 때 앞 기동 상태가 남거나 사라짐 | 프로필 점검 결과(`profileProblems`)는 기동·내리기마다 비우고, 앞 기동의 늦은 점검이 새 결과를 덮지 않게 했다(새 점검 전에는 비밀 창을 열지 않는다, D05 §3.6). 실행 트리거(`run.begin`)는 Chrome을 다시 띄워도 남긴다. 내리기는 닫기를 기다리기 전에 ops·중계를 떼어 내므로, 닫는 동안 온 트리거·비밀이 버려질 ops에 들어가지 않는다 |
| 사용자에게 권한이 없는 폴더도 통과 | 새 문제 `no_user_access`. Windows는 사용자 SID에 `FA`(또는 `0x1f01ff`)·OI·CI(IO 아님) 허용 ACE가 있어야 한다. 실제 루트 `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;<사용자 SID>)`는 그대로 통과한다. POSIX는 소유자 rwx. 권한 문제라 제자리에서 고친다(소유자는 DACL을 다시 쓸 수 있다). 소유자가 Administrators이고 사용자 ACE가 없는 폴더를 비승격으로 만나면, 전에는 통과한 뒤 Chrome이 실패했고 이제는 프로필은 치우고 새로 만들며 루트는 기동하지 않는다 |

- 확인(Mac): `pnpm build`·`pnpm lint`·`pnpm test` 통과(Windows 전용 3건 건너뜀), 앱 스모크 통과(`electronPathsMatch`·`plantedLinks.ok`). 다음 경우에 해당 테스트가 실패하거나 멈추는 것을 확인했다(변형 시험).
  - 금고 기동 중 거부를 빼면 Chrome 두 개가 같은 프로필을 잡고 테스트가 멈춘다.
  - 상한 초과 시 내리기를 빼면 상한 테스트가 멈춘다.
  - 금고: 중간 실패 정리, 세대 확인, spawn 오류 처리, `cdp_closed` 송수신, 트리거 보존(내리는 중 포함), 점검 결과 비우기를 빼면 해당 테스트가 실패한다.
  - 엔진: 순서 세우기, 실패 정리, 띄우는 중 내리기, 첫 이동 줄 세우기, 닫힌 페이지·끊긴 연결 재기동, 닫기 전 줄 선 열기 거부, transport 닫힘 재통지·현재 transport 확인을 빼면 해당 테스트가 실패한다.
  - POSIX 소유자 권한 검사나 Windows OI·CI·IO 검사를 빼면 해당 테스트가 실패한다.
- 검수: Opus 3회(지적 반영). Bugbot·CodeSolar는 PR에서.
- **Windows에서 다시 돌릴 것**(§5.1 목록에 더해):
  - 새 Windows 전용 테스트 "사용자 자신에게 권한이 없는 폴더"(하위 폴더 없는 루트와 빈 프로필에 ACE 없는 보호 DACL `D:P` → 제자리 복구)와 "Windows 사용자 권한 판정"(순수 함수).
  - 앱 스모크의 `electronPathsMatch`와 `plantedLinks`(정션, `LOCALAPPDATA` 임시 경로).
  - 앱 폴더 준비가 실패할 때 ready 전 오류 대화상자가 앞에 보이는지(수동, 예: 루트 자리에 파일을 둔다).
  - 실행 중인 Chrome의 마지막 창을 사람이 닫은 뒤 `browser.open`이 새로 띄우는지(수동, 금고 `cdp_closed` 경로).

후속(이 PR 밖, 기존 문제):
- 단일 인스턴스 잠금이 없어 두 인스턴스가 동시에 `prepareLayout`을 돌 수 있다(staging 정리가 다른 인스턴스 파일을 지움). `requestSingleInstanceLock`은 userData를 쓰므로 새 순서에서는 그 앞에 둘 수 없다. 루트 안 잠금 파일이 필요하다.
- POSIX에서 `db`·`staging` 등 하위 폴더 권한(소유자 rwx 없음)은 보지 않는다. `staging`이 000이면 정리에서 실패해 기동하지 않는다.
- 내장 Administrator(RID 500)는 SDDL에 `LA` 별칭으로 나와 사용자 SID 비교가 맞지 않는다.
- Windows `checkPrivate`는 폴더 자신의 DACL만 본다. 상속 전파가 중간에 끊긴 흔적(앱이 고치는 도중 강제 종료 등)이 하위에 남으면 알아채지 못한다.

## 6. S6m 측정(P0-1 흡수분) — (1) ✅ 관리자 계정(비승격·승격 대조) / (2) ✅ / 표준 계정 ⏳

승격하지 않은 토큰으로(관리자 계정 비승격, 이어서 표준 사용자 계정) (1) BitLocker·장치 암호화 상태 읽기 가능 여부, (2) 보조 볼륨 새 폴더의 기본 ACL을 기록한다(D19 A-19·A-25).

(1) 시스템 드라이브 `C:`, 토큰 비승격(무결성 Medium):

| 방법 | 결과 |
|---|---|
| Shell 속성 `System.Volume.BitLockerProtection`(`Shell.Application`) | **읽힘**, 값 `0` |
| 레지스트리 `HKLM\SYSTEM\CurrentControlSet\Control\BitLockerStatus\BootStatus` | **읽힘**, 값 `0` |
| `manage-bde -status` | 거부(관리자 권한 필요) |
| `Get-BitLockerVolume`, WMI `Win32_EncryptableVolume` | 거부 |
| `fsutil fsinfo volumeinfo` | 거부 |

비관리자로 상태를 읽는 경로는 Shell 속성이다(D07 §1 온보딩 안내에 쓸 후보).

승격 대조(2026-10-31, `tests/s6m-elevated.ps1`, 관리자 승인 1회, 원자료 [raw/win/s6m/](raw/win/s6m/)): `manage-bde -status C:`는 "BitLocker 버전 없음, 완전 암호 해독됨, 보호 해제, 키 보호기 없음"이었다. `Get-BitLockerVolume`도 `VolumeStatus 0`·`ProtectionStatus 0`이었다. 따라서 이 기기에서 Shell 속성 `0`은 "BitLocker가 한 번도 켜지지 않은 볼륨"이다. 제품 온보딩은 켜짐(`1`)으로 확인된 값만 보호로 보고, 그 밖의 값은 모두 "보호 안 됨"으로 안내한다. 켜진 볼륨에서 나오는 값은 이 기기로 확인하지 못했다. 표준 사용자 계정에서 같은 표를 다시 채운다.

(2) 보조 볼륨: 이 기기에는 `C:` 하나뿐이다. 같은 스크립트로 64MB VHDX를 만들어 GPT·NTFS로 포맷해 붙이고(`D:`) 측정한 뒤 분리·삭제했다.

| 확인 | 결과 |
|---|---|
| 새 NTFS 볼륨 루트 기본 DACL | `Administrators`·`SYSTEM` F, **`Authenticated Users` 수정(M, 하위 상속)**, `Users` 읽기·실행. 보호 플래그 없음 |
| 사용자가(비승격) 루트 아래 만든 폴더 | 위 ACE를 그대로 상속한다. 다른 로컬 계정도 수정할 수 있다. `checkPrivate` → `inherited`·`extra_principal` |
| 그 폴더에 `ensurePrivate`(비승격) | 성공. `D:PAI(SY)(사용자)`로 바뀌고 다시 확인해도 통과 |

A-19(사용자 지정 폴더에서 T9 불성립)는 실제로 일어난다. 앱이 ACL을 직접 설정하는 설계(D07 §1.1)가 보조 볼륨에서도 필요하고, 비승격으로 동작한다.

**발견 → 수정**: 보조 볼륨 루트에서는 `Authenticated Users`가 폴더를 만들 수 있다. 그래서 다른 계정이 같은 경로를 먼저 만들어 두면 그 계정이 소유자로 남는다. 우리 사용자가 DACL을 고쳐도 소유자의 암묵적 `WRITE_DAC`로 다시 열 수 있다. Windows `checkPrivate`가 소유자를 보지 않아 이것을 놓쳤다. 이제 소유자가 사용자·SYSTEM·Administrators가 아니면 `not_owner`로 거부한다(§5 수정 표).
- Administrators를 받아들이는 이유: 승격 상태에서 만든 폴더의 기본 소유자가 Administrators다. 또 관리자는 소유권을 가져오는 특권이 이미 있어 소유자여도 더해지는 힘이 없다.
- 시험 한계: 비승격 테스트로는 다른 계정 소유 폴더를 만들 수 없다. 그래서 TrustedInstaller 소유 `%SystemRoot%`를 읽기만 해 `not_owner`를 확인했고, 판정 함수는 단위 테스트로 확인했다.

참고: 이 기기 `%TEMP%`의 상속 ACL에는 소유자 말고도 다른 로컬 SID(RID 1002)·Codex 샌드박스 SID·AppContainer 능력 SID가 있다. 앱 루트에서 상속을 끊는 설계(D07 §1.1)가 실제로 필요하다. 앱 루트 `%LOCALAPPDATA%\SovereignAX`는 앱 스모크 뒤 `D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;<사용자 SID>)`, 색인 제외 속성 `I`였다.

## 7. 운영 규칙(PoC 기간)

- 홈택스 자동 실행은 하루 20회 이하(S8 측정일 제외), 동시 세션 1(D18 §1.4).
- 차단·경고·추가 인증 신호가 오면 즉시 전부 중단, 24시간 쿨다운, 재개는 PM 판단. 2회면 공문 채널로 설명(D18 §3, ADR-017 조건).
- 정부24는 이 환경에서 자동화하지 않는다(ADR-011·017).
- 스크린숏·HAR 등 산출물은 보관함과 분리된 폴더에 마스킹 후 저장하고 2026-12-31에 삭제한다(D18 §4).
- 인증서 비밀번호·보안카드 값은 저장하지 않고 매번 비밀 창으로 입력한다(ADR-017 결정 5).

## 8. 인증수단 수령 일정(EX-6) ⏳

| 수단 | 신청 | 수령 예정 | 상태 |
|---|---|---|---|
| 사업자범용 공동인증서(관계사 법인) | | | EX-6 확인 대기 |
| 사업자 간편인증 | | | EX-6 확인 대기 |
| 보안카드 | | | EX-6 확인 대기 |
| Artifact Signing 온보딩 | | | 후순위 |

PoC-3(11-05) 전에 공동인증서는 반드시 있어야 하고, 간편인증은 S2(PUSH 대기)에만 필요하다.

## 9. ADR-020이 기대는 Windows 기능(이 기기, 비승격)

| 기능(ADR-020) | 결과 |
|---|---|
| 보안카드 사진 OCR `Windows.Media.Ocr` | 인식 언어 `en-US`, `ko`. ko-KR 지원 True |
| 발급마다 Windows Hello 확인(`UserConsentVerifier`) | `DeviceNotPresent`: 이 계정에 Hello(PIN·생체)가 설정돼 있지 않다. 옵션을 시험하려면 사람이 Hello PIN을 설정해야 한다 |
| 열쇠 보관(자격 증명 관리자) | 앱 DB 키 `db-key.SovereignAX`(32B)가 **`CRED_PERSIST_ENTERPRISE`**로 저장됐다. 설계(S10b)는 `LOCAL_MACHINE`. `@napi-rs/keyring`에는 지속성 선택이 없다 → PoC-4-5 §5 |
| TPM 상태 | 비승격으로 읽기 거부 |

## 10. 완료 체크리스트

- [x] 실행 호스트 결정(§1): x64 실기기
- [x] 실기기 준비·기기 정보 기록(§1)
- [ ] PoC 계정(관계사 법인) 지정과 위험 수용 서명
- [x] 계정 정책: 관리자·표준 둘 다 지원(§2.1)
- [ ] 표준 사용자 계정 만들기(사람)와 재확인 실행(§5 테스트, §6, PoC-4-5 §5 다른 계정 접근 거부)
- [x] Chrome stable(§3)
- [x] 빌드·테스트 통과(§5, 관리자 계정)
- [ ] S6m 기록(§6): (1) 관리자 계정 비승격·승격 대조, (2) 보조 볼륨(VHDX) 완료. 표준 계정 재확인 남음
- [ ] 인증수단 수령 일정 표 채움(§8)
