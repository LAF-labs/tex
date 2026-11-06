# Windows 실기기 검증 (Phase 1, 2026-11-06)

범위: Phase 1 Windows 실기기 검증 1~3번(NPKI 열거, 금고 키체인, 전용 Chrome 프로필, 첫 PR)과 준비 단계(install·build·test), 4~5번(서명 없는 설치 파일, 측정, 둘째 PR).
원자료: [raw/win-realdevice/](raw/win-realdevice/). 점검 스크립트: `tests/win-realdevice.ts`·`tests/win-realdevice-launch.ps1`(수동 실행, 아래 각 절의 "재실행").

상태 표기: ✅ 확인 · ⚠️ 설계와 다름·문제 · 🔧 이 PR에서 고침 · ⏳ 남음.

가린 것: 인증서 소유자 이름(CN)·일련번호·주민번호·인증서 폴더 경로는 보고서와 원자료 어디에도 적지 않는다. 비밀번호는 입력하지 않았다. 홈택스·정부24에는 접속하지 않았다. 이 PC는 GitHub self-hosted 러너로 등록하지 않았다.

## 0. 요약

| # | 항목 | 결과 |
|---|---|---|
| 준비 | `pnpm install`·`pnpm build` | ✅ build 통과. ⚠️ install 뒤 Electron 바이너리 없음(§2.1) |
| 준비 | `pnpm test` | 1,599개 중 **pass 1,540 · fail 27 · cancelled 18** · skipped 4 · todo 10(§2.2). Windows 이식성(5개 파일은 main #137과 겹침)·확장 기록 항목을 고친 뒤 해당 파일 재실행 fail 0. 나머지는 부하 시간 초과(단독 통과, §2.3) |
| 1 | NPKI 열거 | ✅ 금고 `scanNpki`가 LocalLow 인증서 1개를 찾고 개인키는 열지 않음. ⚠️ USB는 훑지 않음(설계상 후속), ⚠️ 데스크톱 온보딩 목록은 모의 데이터(§3) |
| 2 | 금고 키체인 | ✅ Credential Manager 저장·읽기·삭제, 2,560B 상한, 40개. ⚠️ 지속성 ENTERPRISE(설계 LOCAL_MACHINE). TPM 없음 → DPAPI 등급, 네이티브 헬퍼가 없어 저장 거부(설계대로 실패 닫힘)(§4) |
| 3 | 전용 Chrome 프로필 | ✅ 13회 기동·CDP(파이프)·종료·잔존물 삭제, EBUSY/EPERM 0회. ⚠️ 강제 종료 뒤 자식 프로세스가 남아 프로필 전체 삭제는 EBUSY 1회(§5). 🔧 새 프로필 기동 뒤 10~20초 비밀 창 거부(확장 기록 항목, §5.1) |
| — | 금고 ACL 점검(PowerShell `Get-Acl`) | ⚠️ 이 PC에서 3.4~15초, 부하 때는 30초 상한 초과 → Chrome 기동 실패(§6.1) |
| 4 | 서명 없는 설치 파일 | 🔧 빌드 스크립트 Windows 실패 2건, **설치본이 기동하지 못하던 포장 제외 패턴**, 로그 이벤트 이름 덮어쓰기를 고침. ✅ 설치·첫 실행·제거. ⚠️ 설치 폴더 `sovereign-ax`(앱은 "예상 밖 설치 위치" 배지). ⏳ SmartScreen 경고 화면(§7) |
| 5 | 측정 | 첫 기동 첫 화면 **21.0초**(두 번째 11.5초), 최대 메모리 **681 MB**, docparse OCR 1건 **5.4초**(e2e 최대 534 MB)(§8) |

## 1. 기기

| 항목 | 값 |
|---|---|
| 모델 | Samsung 500R4L(노트북) |
| CPU | Intel Celeron 3855U @ 1.60GHz, 2코어 2스레드 |
| RAM | 7.9 GB |
| OS | Windows 10 Pro 22H2, 빌드 19045.3086, x64, ko-KR |
| TPM | **없음**(`tpmtool getdeviceinformation` → `0x800710DF` 장치 준비 안 됨, 보안 장치 클래스 PnP 장치 없음) |
| 저장소 | `C:` 118 GB 단일 볼륨, 이동식 드라이브 없음 |
| 백신 | Microsoft Defender 실시간 보호 켜짐 |
| 계정 | 관리자 계정(UAC 켜짐), 승격하지 않고 실행 |
| Chrome | 156.0.8078.80, **`%ProgramFiles(x86)%`** 설치(사용자 설치 Chrome stable) |
| 도구 | Node 26.13.0(winget `OpenJS.NodeJS.LTS`), pnpm 12.11.2(`npm i -g`, Node 26에는 corepack이 없다), Git 2.56.0, gh 2.103.3 |

PoC-1 기기(Ryzen 5 7500F, 32 GB, Windows 11)보다 훨씬 느린 보급형 PC다. 아래 시간 값은 이 차이를 반영한다.

## 2. 준비

### 2.1 install·build

| 단계 | 결과 | 시간 |
|---|---|---|
| `pnpm install` | 통과(398 패키지). 회선이 느려 tarball 경고 다수 | 15분 |
| Electron 바이너리 | ⚠️ install 뒤 `node_modules/electron/dist/electron.exe`가 없었다. `allowBuilds.electron: true`인데 설치 스크립트 로그가 없다. `node node_modules/electron/install.js`로 받았다 | 88초 |
| `pnpm build`(`tsc -b`) | ✅ 통과 | 200초 |

재현: 새 클론에서 `pnpm install` → `Test-Path node_modules\electron\dist\electron.exe`가 `False`. 다른 Windows 기기에서 같은지 확인이 필요하다(원인 미확정, 느린 회선의 다운로드 실패를 pnpm이 삼켰을 가능성).

### 2.2 `pnpm test`

1,599개, **pass 1,540 · fail 27 · cancelled 18** · skipped 4 · todo 10. 7,072초(아래 멈춤 80분 포함). 실패 목록: [raw/win-realdevice/pnpm-test.txt](raw/win-realdevice/pnpm-test.txt). 클론 시점 main `6253fc1`(#110) 기준이다.

| 원인 | 파일(실패 수) | 처리 |
|---|---|---|
| `new URL(…).pathname`을 경로로 씀(Windows `/C:/…`) | `model-s7`(2), `remote-envelope`(1: `C:\C:\…`) | 같은 날 main #137(`windows-latest` CI)이 같은 방식(`fileURLToPath`)으로 고침 → 병합해 main 쪽을 따름 |
| 절대 경로를 그대로 `import()`(ESM은 `file://`만) | `shell-tokens`(파일 전체) | main #137(`pathToFileURL`) |
| 경로 구분자 `\` | `core-registry-samples`(1) | main #137 |
| 열린 SQLite 파일 삭제 EPERM | `core-run`(1) | main #137 |
| `fs.symlink` 유형 없음 → **표준 권한** Windows에서 EPERM(관리자 권한인 GitHub `windows-latest`에서는 통과) | `vault-npki`(2), `vault-s6-regress`(1) | 🔧 디렉터리는 정션(다른 시험과 같은 방식), 파일 링크는 권한 없으면 그 경우만 빼고 본다 |
| 금고 ACL 점검 30초 초과로 before 실패 → 파일 전체 취소, 그 뒤 프로세스가 끝나지 않음(80분, 수동 종료) | `h01-policy`(16 cancelled + 1) | ⚠️ §6.1·§6.2 |
| 60초·30초 시간 초과, 앞 시험이 끝나지 않아 `busy` 연쇄 | `audit-v`(2), `h01-engine`(15) | ⏳ §2.3 |
| relay 활성 창 단언 불일치 | `playwright-relay`(2), `vault-relay`(2) | ⏳ §2.3 |

고친 7개 파일 재실행(병합 전 이 브랜치의 같은 수정): 112개 중 pass 111 · skipped 1(원래 win32에서 건너뛰는 시험) · fail 0.

### 2.3 relay·Chrome 시험 단독 재실행

전체 실행에서 실패·취소된 relay·Chrome 시험 파일을 PC가 한가할 때 하나씩 다시 돌렸다(`node --test <파일>`).

| 파일 | 전체 실행 | 단독 실행 | 판단 |
|---|---|---|---|
| `h01-policy` | fail 1 · cancelled 16(멈춤) | 16/16 pass, 155초 | 부하 때 ACL 점검 30초 초과(§6.1) |
| `h01-engine` | fail 15(첫 시험 30초 초과 → `busy` 연쇄) | 25/25 pass, 135초 | 부하 |
| `audit-v` | fail 2(60초 초과) | 35/35 pass, 70초 | 부하 |
| `playwright-relay` | fail 2 | 7/7 pass, 81초 | 부하 |
| `vault-relay` | fail 2 | **fail 2**(24/26) | 🔧 확장 기록 항목(§5.1) |
| `vault-s6-regress` | fail 1(링크 EPERM) | **fail 3**(4/7) | 🔧 링크(§2.2) + 확장 기록 항목(§5.1) |

남은 5건은 모두 비밀 창이 `secret_window_refused`로 거부된 것이었고 원인은 §5.1이다. 고친 뒤 `audit-v`·`vault-s6-regress`·`vault-relay` 함께 실행: **68/68 pass**(637초).

main(#137까지) 병합 뒤 관련 9개 파일 함께 실행(`vault-npki`·`model-s7`·`remote-envelope`·`shell-tokens`·`core-registry-samples`·`core-run`·`audit-v`·`vault-s6-regress`·`vault-relay`): 180개 중 **pass 177 · fail 1 · cancelled 1 · skipped 1**(881초). 둘 다 시간 문제다.
- `audit-v` "SignalWatch.inspect … tainted state" 60초 초과(앞 단독 실행에서는 통과).
- `vault-relay` "응답 없는 Chrome에 붙는 중이면 상한에서 내리고 실패한다": 경과 시간 단언(`상한 15초 + 15초`)에 Chrome을 띄우기 전 ACL 점검(§6.1)이 들어가 넘었다.

정리: 전체 실행의 실패·취소 중 Windows 이식성(7개 파일 9건, 그중 5개 파일은 main #137과 겹침)과 확장 기록 항목(`vault-relay` 2건)은 고쳤고, 나머지(`audit-v`·`h01-engine`·`h01-policy`·`playwright-relay`)는 이 PC의 부하에 따른 시간 초과다(단독 실행 통과). 시간 초과 중 `h01-policy`는 제품 경로(§6.1)가 원인이다.

## 3. NPKI 열거(1번)

| 항목 | 결과 | 남은 것 |
|---|---|---|
| 금고 기본 위치(`npkiRoots`) | ✅ `%USERPROFILE%\AppData\LocalLow\NPKI`·`%ProgramFiles%\NPKI` 둘 다 있음 | — |
| `scanNpki()`(=`npki.list`) | ✅ 인증서 1개(LocalLow, KICA, `hasKey: true`), 건너뜀 0, 40~54 ms | — |
| 개인키 접근 | ✅ 실기기 위치로 도는 `vault-npki` "기본 위치(이 PC)" 시험 통과(signPri.key 열기·stat 0회) | — |
| 공개 인증서 파싱(`readCertInfo`) | ✅ 소유자 CN(가림)·발급 기관·만료(2027-10, 유효) 읽힘 | 일련번호는 파서가 읽지 않는다(DN의 serialNumber만) |
| USB 인증서 | ⚠️ 기본 스캔에 이동식 드라이브가 없다(`npki-scan.ts` 주석, 프로토콜 §9 "사용자가 고른 파일만, 후속"). 이 PC에 USB가 없어 USB 루트를 준 스캔도 못 돌렸다 | ⏳ 사람이 NPKI USB를 꽂고 `win-realdevice.ts npki` 재실행(이동식 드라이브의 `X:\NPKI`를 같은 스캐너로 읽는다) |
| 데스크톱 온보딩 인증서 목록 | ⚠️ 실기기 목록이 아니다. `shell-app.ts`가 `MockOnboardingPorts`를 쓰고 `onboarding-mock.ts findCerts()`가 고정 인증서 2개를 돌려준다. `apps/desktop/src`에서 `npki.list`를 부르는 곳이 없다 | ⏳ 온보딩 포트를 금고 `npki.list` + docparse `certInfo`에 잇기(데스크톱 트랙). 화면은 둘째 PR 첫 실행 때 남긴다 |

재실행: `node --conditions=development tests/win-realdevice.ts npki`(원자료 [npki.json](raw/win-realdevice/npki.json)).

## 4. 금고 키체인(2번)

시험 항목은 서비스 `SovereignAX`, 이름 `rd-test/<무작위>/…`로만 만들고 끝나면 지웠다(남은 항목 0). 실제 `db-key`는 건드리지 않았다.

| 항목 | 결과 | 근거 |
|---|---|---|
| 저장·읽기·삭제(`KeyringItemStore`) | ✅ 1·32·256·2,560B 왕복 일치, 삭제 뒤 `null`, 없는 항목 삭제 `false` | W-4 |
| 항목 크기 상한 | ✅ 앱 검사 2,561B → `vault.item_too_large`. OS도 2,561B·5,120B를 거부(`CRED_MAX_CREDENTIAL_BLOB_SIZE` 2,560B와 일치). 다만 @napi-rs/keyring 오류는 `GenericFailure`라 원인이 드러나지 않는다 | D05 §2 |
| 항목 개수 | ✅ 40개(슬롯 1개 최대치: 보안카드 35칸 + kek 2 + consent + 전역 2) 쓰기 2.1~8.0초, `cmdkey /list`에 40개, 전부 읽힘, 지운 뒤 0개. 개수 상한은 코드에 없다 | `keychain/human.ts` |
| DB 키 경로(`OsKeyStore`) | ✅ 없으면 `null` → 만들기 → 되읽기 일치, 길이 다르면 `vault.keystore_mismatch`(덮지 않음) | N-30 |
| **지속성** | ⚠️ `CredReadW`로 읽은 `Persist` = **ENTERPRISE**(3). 설계는 LOCAL_MACHINE(2). PoC-1 §9와 같은 결과. `cmdkey /list`는 ENTERPRISE면 지속성 줄을 출력하지 않는다 | W-4, D05 §2 |
| TPM | 없음(§1). `keychainBackend('win32')` 등급 = `dpapi` | W-1 |
| DPAPI 대체 경로 | ✅ 이 PC에서 `ProtectedData.Protect/Unprotect(CurrentUser, 엔트로피)` 동작(시험 바이트, 262B). ⚠️ 금고는 네이티브 헬퍼가 없어 `wrap` → `vault.native_helper_missing`, 사람 비밀 저장 거부(설계대로 실패 닫힘) | W-2 |
| Windows Hello | `UnavailableHello`(사용 안 함) | W-3 |
| vault 시험(`node scripts/run-tests.mjs vault-`) | §2.2·§2.3. 모두 메모리 저장소(`MemoryKeyStore` 등)를 쓰므로 실 Credential Manager는 위 스크립트로만 확인된다 | — |

재실행: `node --conditions=development tests/win-realdevice.ts keychain`(원자료 [keychain.json](raw/win-realdevice/keychain.json)).

## 5. 전용 Chrome 프로필(3번)

금고와 같은 함수(`findInstalledChrome` → `writeProfileSettings` → `launchChrome` → 닫기 → `removeProfileResidue`·`removeCrashDumps`)를 임시 프로필로 13회 돌렸다. 매회 127.0.0.1 가짜 페이지 2개(쿼리·해시·폼 포함)를 열어 기록을 만들고, 닫은 **직후** 지웠다(금고 `shutdown()`과 같은 순서). 10회는 `Browser.close`, 3회는 브라우저 프로세스 강제 종료.

| 항목 | 결과 |
|---|---|
| Chrome 찾기 | ✅ 후보 두 번째 `%ProgramFiles(x86)%`에서 찾음(PoC-1은 첫 번째만 확인) |
| 기동 → CDP 응답(`--remote-debugging-pipe`) | ✅ 1.7~2.9초. `DevToolsActivePort` 없음(포트 미개방) |
| 실행 중 프로세스 | 12~23개 |
| 닫기(`Browser.close` → 종료) | 2.0~10.3초 |
| 잔존물 | 닫은 직후 8~12개 경로(History·Sessions·Visited Links·Favicons 등) → **13회 모두 0개로 삭제**, 27~112 ms, EBUSY/EPERM **0회** |
| 크래시 덤프 폴더 | `--disable-breakpad`여도 `Crashpad` 아래 파일 2개가 생기고 매회 지워짐 |
| 닫은 뒤 남은 자식 프로세스 | `Browser.close`: 10회 중 1회 2개. 강제 종료: 3회 중 2회 6~7개 |
| 임시 프로필 폴더 전체 삭제 | 강제 종료 1회에서 **EBUSY**(남은 자식이 잡은 파일). 재시도로 지워짐 |

판단: 금고가 지우는 잔존물 경로는 이 PC에서 잠금 때문에 실패하지 않았다. 다만 `Vault.removeDumps`가 `removeProfileResidue(…).catch(() => 0)`이라 잠금으로 실패해도 기록이 없다(§6.3).

재실행: `node --conditions=development tests/win-realdevice.ts chrome`(`SAX_RD_CHROME_RUNS`로 횟수, 원자료 [chrome.json](raw/win-realdevice/chrome.json)).

### 5.1 새 프로필 기동 뒤 10~20초 동안 비밀 창이 거부된다 🔧

증상: `vault-relay`·`vault-s6-regress`의 비밀 창 시험 5건이 단독 실행에서도 `secret_window_refused`로 실패했다(Preferences 불일치·Google 로그인은 없음).

원인: 이 PC의 Chrome 156은 새 프로필로 뜨면 **Chrome 웹 스토어 결제**(`nmmhkkegccagdldgiimedpiccmgmieda`)를 외부 구성요소(location 10)로 받는다. 받는 동안 `Default/Secure Preferences`의 `extensions.settings`에 업데이트 확인 기록 `{"lastpingday": …}`만 든 항목이 먼저 생기고, 설치가 끝나면 location·path·manifest가 채워진다. 금고 `listInstalledExtensions`는 location이 없는 항목을 설치 확장으로 세어 `extension_not_allowed` → 창을 열 때마다 다시 읽는 `profileBlocker`가 거부했다.

| 기동 뒤 | 항목 | 금고 판정(고치기 전) |
|---|---|---|
| 5초 | 없음 | 통과 |
| 10초 | `{lastpingday}`만 | **허용 밖 확장 1개 → 거부** |
| 20초(헤드리스)·25초(헤드풀) | location 10, `from_webstore`, manifest "Chrome 웹 스토어 결제" | 통과(외부 구성요소) |

헤드리스(시험)·헤드풀(앱) 모두 같았다. 빠른 기기에서는 이 구간이 짧아 시험이 비켜 간 것으로 보인다. 실제 앱에서는 첫 기동(새 전용 프로필) 직후 포털 로그인 비밀 창이 거부될 수 있다.

고침: `packages/vault/src/chrome/profile.ts` — location·path·manifest가 **모두** 없는 항목(불러올 확장이 없는 기록)은 세지 않는다. 셋 중 하나라도 있으면 그대로 센다. Preferences를 쓸 수 있는 공격자는 이미 location 5를 써서 통과할 수 있으므로 판정이 약해지지 않는다. 시험: `audit-v` V2에 기록만 든 항목·설치 완료(10)·path만 있는 항목 경우를 더했다.

재현(고치기 전 코드): 새 임시 프로필로 `launchChrome`(헤드리스) 뒤 2초마다 `listInstalledExtensions`를 읽으면 10초 무렵 `nmmhkkegccagdldgiimedpiccmgmieda`가 허용 밖으로 나오고 20초 무렵 사라진다.

## 6. 고치지 않은 문제(재현 절차)

### 6.1 금고 ACL 점검이 느린 PC에서 30초 상한을 넘는다 ⚠️

`WindowsDirGuard.checkPrivate` → `readOwner`가 매번 `powershell.exe -Command Get-Acl …`을 띄운다(`packages/platform/src/acl.ts`). 주석은 "PowerShell 기동 약 0.3초(PoC-1 실측)"이지만 이 PC에서는 Chrome 하나가 떠 있는 상태로 3.4·5.5·5.7·6.3·15.2초였다. `pnpm test` 부하에서는 `TOOL_TIMEOUT_MS`(30초)를 넘어 SIGTERM으로 죽었다. 금고 `startChrome()`은 기동마다 앱 루트·프로필을 이 점검으로 확인하므로, 같은 PC에서 앱의 Chrome 기동이 실패하거나 수십 초 걸릴 수 있다.

재현(이 PC, PowerShell):
```powershell
$env:SAX_ACL_TARGET = $env:TEMP
1..5 | % { $sw = [Diagnostics.Stopwatch]::StartNew(); $null = powershell -NoProfile -NonInteractive -Command '(Get-Acl -LiteralPath $env:SAX_ACL_TARGET).GetOwner([System.Security.Principal.SecurityIdentifier]).Value'; $sw.ElapsedMilliseconds }
```
고칠 방향(설계 결정이라 이 PR에서 바꾸지 않음): 소유자 SID를 PowerShell 없이 읽기(네이티브 헬퍼 `GetNamedSecurityInfoW`, 또는 `icacls /save`처럼 가벼운 도구), 기동당 한 번만 읽기, 상한을 기기 성능에 맞게.

### 6.2 `h01-policy` 시험이 before 실패 뒤 끝나지 않는다 ⚠️

§6.1로 `before`가 던지면 파일의 시험이 모두 취소되지만, 시험 프로세스가 살아 남아 `run-tests.mjs`(시간 상한 없음)가 80분 동안 기다렸다. 띄운 Chrome·서버를 `after`에서 닫지 못하는 것으로 보인다.
재현: 부하를 건 상태에서 `node scripts/run-tests.mjs h01-policy` → "✖ H-01 요청률 정책 …" 뒤 프로세스가 끝나지 않음.

### 6.3 잔존물 삭제 실패가 기록되지 않는다

`service.ts removeDumps()`가 `removeCrashDumps`·`removeProfileResidue` 실패를 `.catch(() => 0)`으로 삼킨다. 잠금(EBUSY/EPERM)으로 History를 못 지워도 `vault.chrome_residue_removed`가 안 남을 뿐 실패 이벤트가 없다. 이 PC에서는 실패가 재현되지 않아 코드는 바꾸지 않았다(§5).

### 6.4 Credential Manager 지속성 ENTERPRISE

§4. @napi-rs/keyring 2.1.2가 지속성을 고르게 하지 않는다. LOCAL_MACHINE으로 쓰려면 네이티브 헬퍼나 다른 바인딩이 필요하다(W-4).

## 7. 서명 없는 설치 파일(4번)

빌드: `node scripts/package-win.mjs`(서명 환경 변수가 없으면 자동으로 미서명). 이 PC에서 처음엔 빌드도, 만든 설치본의 기동도 실패했고 아래 셋을 고친 뒤 통과했다.

| 증상 | 원인 | 수정 |
|---|---|---|
| `pnpm build → null`(1초 만에 실패) | `spawnSync('pnpm')`: Windows의 pnpm은 `pnpm.cmd` 심이라 셸 없이 띄울 수 없다(ENOENT) | 🔧 `scripts/package-win.mjs`: win32에서 pnpm만 셸로(인자 따옴표 처리), 오류에 `r.error.code` |
| 설치본을 만든 뒤 `"node_modules/@napi-rs/keyring" was not found in this archive` | asar 목록을 `/`로 바꾼 경로로 `statFile` → `@electron/asar`는 Windows에서 `\`로 나눈다 | 🔧 같은 파일: 원래 경로로 `statFile`, 보고서에는 `/` |
| **설치본이 기동 뒤 30초쯤 스스로 꺼짐**(첫 화면 없음, stderr `shell start failed: engine_exit`, DB·`db-key` 안 생김) | 제외 패턴 `'!**/src/**'`가 node_modules 전체의 `src/`를 지워 실행 코드가 `src/` 아래인 의존성(`officecrypto-tool` `./src/util/common`, `debug`·`tesseract.js`의 main)이 빠짐 → 엔진이 import에서 끝남. 같은 Electron 45를 Node 모드로 띄워 설치본 asar의 `@sax/engine/dist/entry.js`를 import해 `MODULE_NOT_FOUND`로 확인 | 🔧 `apps/desktop/build/electron-builder.config.mjs`: `'!src/**'`, `'!node_modules/@sax/*/src/**'`로 좁힘. `tests/updater-packaging.test.ts`가 전체 `src` 제외를 막는다. 운영체제와 무관한 문제다(설치본을 실행해 본 적이 없어 드러나지 않았다: `windows_run_unverified`) |

결과(고친 뒤):

| 항목 | 값 |
|---|---|
| 빌드 시간 | 9분 14초(`--skip-build`, Electron zip·NSIS 내려받기 포함) |
| 설치 파일 | `SovereignAX-Setup-0.0.0.exe` 119.1 MB, sha256 `e8516046…5460c44`, Authenticode `NotSigned` |
| 앱 | asar 110.0 MB(파일 3,594개, 고치기 전 3,516개), 압축 해제 423.2 MB |
| 배포 판정 | `unsigned_build`·`publisher_dn_unset`·`dev_only_code_included`(`dist/onboarding-mock.js`·`dist/shell-mock.js`, §3 온보딩 모의와 같은 뿌리)·`windows_run_unverified` |
| 설치 | 사용자별, UAC 없음, 60~76초. 바탕화면·시작 메뉴 바로가기 "소버린 AX(가칭)", 제거 키 `HKCU\…\Uninstall\45454e41-6e5b-5ebd-a579-cc345390db8d`(게시자 칸 빈칸, 버전 0.0.0) |
| **설치 폴더** | ⚠️ `%LOCALAPPDATA%\Programs\sovereign-ax`. README·`installer.nsh`·`harden.ts`는 `…\Programs\SovereignAX`를 기대해 앱이 **"예상 밖 설치 위치" 배지**를 띄운다(화면). 원클릭 사용자별 설치는 폴더 이름을 `extraMetadata.name`(`'sovereign-ax'`)에서 가져온다. 업데이트 경로가 걸린 결정이라 고치지 않았다 |
| 설치 후 자동 실행(`runAfterFinish`) | 탐색기로 연 설치에서는 끝난 뒤 앱이 떴다. 에이전트 PowerShell `Start-Process`로 연 두 번은 뜨지 않았다(실행 환경 차이로 본다) |
| 첫 화면 | [screens/first-launch-0.png](raw/win-realdevice/screens/first-launch-0.png): 약관 화면, 배지 "견본 데이터 · PoC 데모"·"예상 밖 설치 위치"·"미서명 빌드"·"개발용 코드 포함 빌드" |
| 제거(`Uninstall SovereignAX.exe /currentuser /S`) | 3초. 설치 폴더·바로가기·제거 키 삭제(시작 메뉴 바로가기는 몇 초 뒤 지워짐). `%LOCALAPPDATA%\SovereignAX`는 남김(설계, `deleteAppDataOnUninstall: false`) |

**SmartScreen** ⏳: 인터넷 표시(Zone.Identifier `ZoneId=3`)를 붙인 설치 파일을 `ShellExecute`로 연 두 번은 `smartscreen.exe`가 떠서 약 7초 검사한 뒤 **경고 없이 실행**됐고, 그 뒤 파일의 인터넷 표시가 지워져 있었다. 탐색기로 연 세 번째는 에이전트 쪽에서 대화상자를 볼 수 없었다. 사람이 탐색기에서 더블클릭해 화면을 확인한다(§9).

로그 문제(🔧): `main.log`가 `{"code":1}` `{"code":"engine_exit"}` `{"code":0}`처럼 이벤트 이름 없이 남았다. `FileEventLog.event`가 필드를 머리 키 뒤에 펼쳐 `code` 필드(`main.engine_exit {code}`·`run.signal {code}`·`main.gate_answer_not_ok {code}` 등)가 이벤트 이름을 덮었다. `packages/platform/src/log.ts`: 머리 키(`at`·`c`·`code`)와 같은 필드는 `<키>_`로 적는다. 시험 `tests/platform-log.test.ts`.

재현(고치기 전 설정): `node scripts/package-win.mjs` → 설치 → `SovereignAX.exe` 실행 → 30초쯤 뒤 종료, `%LOCALAPPDATA%\SovereignAX\db`가 비어 있음. 확인: `$env:ELECTRON_RUN_AS_NODE=1; node_modules\electron\dist\electron.exe -e "import('file:///<설치 폴더>/resources/app.asar/node_modules/@sax/engine/dist/entry.js').catch(e=>console.error(e.message))"` → `Cannot find module './src/util/common'`.

## 8. 측정(5번)

기기는 §1(Celeron 3855U 2C/2T, RAM 7.9 GB, Windows 10 Pro 22H2, TPM 없음). 앱에는 기동 시간 기록·측정 스위치가 없어(디버그 스위치·RunAsNode 퓨즈 거부) 밖에서 쟀다: `tests/win-realdevice-launch.ps1`(로그 줄의 `at`과 메인 프로세스 StartTime 차이, 창·버튼은 250 ms·1초 폴링, 메모리는 같은 이름 프로세스 전체 작업 집합 합을 250 ms마다).

| 항목 | 첫 기동(데이터·`db-key` 없음) | 두 번째 기동 |
|---|---|---|
| 창 핸들 | 14.6초 | 6.6초 |
| `vault.started` | 15.6초 | 7.8초 |
| `engine.db_opened` | 19.5초 | 9.6초 |
| **첫 화면**(약관 '동의하고 시작' 버튼) | **21.0초** | **11.5초** |
| 최대 메모리(작업 집합 / 전용) | **681 MB** / 402 MB, 프로세스 7개 | 621 MB / 362 MB, 7개 |

첫 기동의 처음 약 13.5초는 메인 프로세스 하나(82 MB)만 떠 있다(두 번째 기동은 약 6초). Electron ready 전에 앱 데이터 폴더를 만들고 ACL을 거는 단계(`prepareLayout` → icacls·PowerShell)로, §6.1과 같은 비용이다. 원자료 [first-launch.json](raw/win-realdevice/first-launch.json)·[second-launch.json](raw/win-realdevice/second-launch.json).

| docparse OCR 1건 | 값 |
|---|---|
| 방법 | `electron apps/desktop/e2e-dist/ocr-e2e.js`(개발 Electron 45.1.0, 설치본은 측정 스위치가 없다). 합성 사업자등록증 PNG, `ocrInSandbox` |
| 시간 | **5,389 ms**(숨은 샌드박스 창 생성 → 페이지 → OCR 워커 → 한국어 모델 로드 → 인식, 나눠 재지 않음), 신뢰도 90 |
| 결과 | 등록번호·상호·대표자·개업일 맞음, 주소 글자 1~2개 오인. e2e 9개 항목 모두 통과(O-02 그림·PDF, 샌드박스 네트워크 차단, certInfo) |
| 최대 메모리 | e2e 전체(22.3초) 동안 Electron 프로세스 6개 합 **533.5 MB** / 전용 339.1 MB |

원자료 [ocr-e2e.json](raw/win-realdevice/ocr-e2e.json)·[ocr-measure.json](raw/win-realdevice/ocr-measure.json). 설치본에서 OCR(온보딩 "사업자등록증 올리기")은 사람 클릭과 파일 선택이 필요해 재지 않았다.

재실행: `powershell -NoProfile -File tests/win-realdevice-launch.ps1 -Exe "$env:LOCALAPPDATA\Programs\sovereign-ax\SovereignAX.exe" -OutJson <json> [-ShotPrefix <png 접두>] [-AttachWaitSec 900]`(`-AttachWaitSec`: 설치 마법사가 띄운 첫 실행에 붙는다).

## 9. 남은 것

- [ ] USB NPKI 열거(사람이 USB를 꽂고 §3 재실행)
- [ ] 데스크톱 온보딩 인증서 목록을 실 `npki.list`에 잇기(데스크톱 트랙). 설치본의 `dev_only_code_included`(모의 온보딩·셸)와 같은 일
- [ ] 금고 ACL 점검을 PowerShell 없이(§6.1), `h01-policy` 정리(§6.2), 잔존물 삭제 실패 기록(§6.3), Credential Manager 지속성(§6.4) — 금고·플랫폼 트랙 결정
- [ ] 설치 폴더 이름 `sovereign-ax` vs 문서·앱 기대 `SovereignAX`(§7) — 업데이트 경로 결정
- [ ] SmartScreen 화면: 사람이 인터넷 표시가 있는 설치 파일을 탐색기에서 더블클릭(§7)
- [ ] Electron 바이너리 누락(§2.1)을 다른 Windows 기기에서 재확인
