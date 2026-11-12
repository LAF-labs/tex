# 고객 PC 배포 점검 (PoC, 2026-11-11)

> 대상: 이번 주 PoC 고객의 Windows·Mac PC에 설치본을 깔아 실제 홈택스로 쓰게 하는 것(대표 결정 2026-11-11: 완료 기준 = 고객 PC에서 실제 홈택스로 된다).
> 근거는 main(`771805e` 이후)의 코드·[WIN-REALDEVICE](../../poc/reports/WIN-REALDEVICE.md)(Windows 실기기 2026-11-06·11-09)·0.1.8 설치본을 읽기 전용으로 점검한 결과다. 실기기에서만 확인되는 것은 §5에 모았다.
> 고객이 읽는 문서: [customer-install-guide.md](customer-install-guide.md). 대표 몫: §4.
> 대표 결정(2026-11-11): **Intel Mac 미지원**(Apple Silicon·macOS 13 이상만), **macOS는 이번 주 Developer ID 서명·공증을 켜는 것이 목표**, Windows 코드 서명은 이번 주 없음(SmartScreen 우회 안내), 새 판은 재설치.

심각도: **설치 불가** · **로그인 불가** · **인증서 등록 불가** · **발급 불가** · **불편**. 상태: ✅ 확인 · ⚠️ 문제 · 🔧 이 PR에서 고침 · ⏳ 실기기 확인 필요.

## 0. 요약: 고객 PC에서 막는 것 (심각도순)

| # | OS | 심각도 | 무엇 | 길 |
|---|---|---|---|---|
| 1 | 공통 | 로그인 불가 | SES 샌드박스면 인증된 주소 말고는 코드 메일이 안 감(`POST /v1/auth/code` 500) | 대표: 프로덕션 승인, 또는 고객 주소를 SES 인증된 ID로 추가(§4-1) |
| 2 | 공통 | 로그인 불가 | 회사망 프록시: PC 쪽 송신이 Node `fetch`라 OS 프록시를 따르지 않음(`packages/net/src/egress.ts:239·302·332`) | 이번 주 코드 그대로. 안내서에 "프록시 망에서는 동작하지 않을 수 있음, `tax.laf-co.com`·`rooms.tax.laf-co.com` 443 허용" |
| 3 | 공통 | 발급 불가 | 실제 홈택스 H-01 미성공 | 다른 세션 진행 중. 안내서에 "첫 발급은 함께" |
| 4 | 공통 | 발급 불가 | Chrome 미설치면 실행 실패 | 🔧 금고가 고정 코드 `chrome.not_installed`로 끝내고 엔진이 그 코드로 실행을 끝냄, Mac `~/Applications` 후보 추가. 화면 문구·사전 점검은 desktop-2 |
| 5 | Mac | 설치 불가 | Intel Mac·macOS 12 이하(`LSMinimumSystemVersion` 13.0, arm64 단일) | 미지원(대표 결정). 안내서 §0에 칩·OS 확인과 Intel에서 보이는 것 |
| 6 | Mac | 설치 불가(우회 가능) | 애드혹 서명·공증 없음 → Gatekeeper 차단 | 🔧 Developer ID 서명·공증을 키체인 신원 + notarytool 프로필로 켜는 빌드 설정. 대표 몫 §4-2가 끝나기 전엔 안내서 §2-2(나) |
| 7 | Win | 설치 불가(우회 가능) | 미서명 → SmartScreen 차단. 회사 정책으로 [실행]이 숨겨지면 설치 불가 | 안내서 §1-2([추가 정보] → [실행]) |
| 8 | 공통 | 발급 불가 | 첫 실행은 인터넷 필수(레지스트리 동기화 전엔 플레이북 없음, `engine/src/registry-sync.ts:511`) | 안내서 §0 |
| 9 | 공통 | 인증서 등록 불가(일부) | USB에만 있는 공동인증서·금융인증서는 목록에 안 나옴 | PC로 복사, 또는 간편인증 |
| 10 | 공통 | 인증서 등록 불가(일부) | 보안카드 등록은 모든 OS에서 막혀 있음 | 공동인증서·간편인증 |
| 11 | Mac | 불편 | 애드혹 판은 새 판마다 키체인 허용 창(항목마다), 답할 때까지 부팅 멈춤 | 안내서 §2-3. Developer ID 판부터 사라짐(첫 전환 때 한 번) |
| 12 | 공통 | 불편 | 자동 업데이트 미연결 → 새 판 = 재설치 | §3 |
| 13 | 공통 | 불편 | 국세청 상태조회가 늘 "조회하지 못했어요" → [맞습니다]로만 진행(`apps/desktop/src/shell-app.ts:679`) | 안내서 §4 |
| 14 | 공통 | 불편 | 앱 안에서 판을 볼 곳이 없음 | 안내서 §7(OS 앱 목록·정보 가져오기) |
| 15 | Win | 불편 | 첫 기동 첫 화면 약 22초(저사양 Celeron 실측, WIN-REALDEVICE §10.7) | 안내서에 고지 |

**Windows 금고 저장 경로는 이번 주 막힘이 아니다**(§1.3). 네이티브 헬퍼 개발은 하지 않는다(팀장 동의 2026-11-11).

## 1. Windows

### 1.1 설치
| 항목 | 사실 | 근거 |
|---|---|---|
| 형식 | NSIS 원클릭, 사용자별(`perMachine:false`, `allowElevation:false`), `requestedExecutionLevel: asInvoker` → **관리자 권한·UAC 없음** ✅ | `poc/apps/desktop/build/electron-builder.config.mjs` `nsis`·`win`, WIN-REALDEVICE §10.2(`consent.exe` 0회) |
| 설치 위치 | `%LOCALAPPDATA%\Programs\SovereignAX` ✅ | 같은 설정 `extraMetadata.name`, WIN-REALDEVICE §10.2 |
| 데이터 위치 | `%LOCALAPPDATA%\SovereignAX`(db·vault·chrome-profile·staging·logs·userData). 제거해도 남음 ✅ | `poc/packages/platform/src/paths.ts:20-42`, `installer.nsh` customUnInstall, `deleteAppDataOnUninstall:false` |
| SmartScreen | "Windows의 PC 보호" → [추가 정보] → 게시자 "알 수 없는 게시자" → [실행] ✅ | WIN-REALDEVICE §7 |
| 최소 OS | Windows 10 64비트(Electron 45). 실기기는 Windows 10 Pro 22H2(19045) ✅. x64 설치본 하나 | WIN-REALDEVICE §1, `scripts/package-win.mjs` TARGET |
| 첫 기동 | 첫 화면 22.2초·두 번째 9.8초, 최대 메모리 약 650MB(Celeron 3855U, RAM 8GB) | WIN-REALDEVICE §10.7 |

### 1.2 전용 Chrome
- 후보만 찾는다(`poc/packages/vault/src/constants.ts:5-14`): Windows `%ProgramFiles%`·`%ProgramFiles(x86)%`·`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`(x86은 실기기 ✅, WIN-REALDEVICE §5), Mac `/Applications/…`와 🔧 `~/Applications/Google Chrome.app/…`(이 PR, 홈은 `os.homedir()`). Edge 등 다른 Chromium은 넣지 않는다(검증 안 됨).
- 없으면 🔧 금고 `browser.launch`가 `chrome.not_installed`를 던지고(`vault/src/chrome/find.ts` `CHROME_NOT_INSTALLED`, `service.ts:458`), 엔진 `connectRunBrowser`가 `RunEnd('failed', 'chrome.not_installed')`로 바꿔 실행이 그 코드로 끝난다(`engine/src/browser.ts` `CHROME_NOT_INSTALLED_CODE`, 전에는 `engine.error`). **화면 문구("Chrome이 설치돼 있어야 해요…")와 [홈택스에서 준비] 전 사전 점검은 desktop-2 몫**이다. 문구가 붙기 전에는 일반 멈춤 문구가 나온다(`shell-runs.ts` `UNKNOWN_STOP_NOTE`).
- 전용 프로필은 `%LOCALAPPDATA%\SovereignAX\chrome-profile`. Google 로그인·확장이 감지되면 비밀 창을 열지 않는다(`shell-runs.ts:161·169` 문구).

### 1.3 금고의 비밀 저장 (TPM·DPAPI·네이티브 헬퍼)
| 비밀 | Windows에서 | 근거 |
|---|---|---|
| DB 키(`db-key`) | Credential Manager에 직접 저장(래핑 없음) → **됨** ✅. 제거·재설치 뒤에도 남음 | `vault/src/keystore.ts` `OsKeyStore`, WIN-REALDEVICE §4·§10.2 |
| 공동인증서 비밀번호 | **저장 기능 자체가 없음**. 실행마다 금고 비밀 창에서 입력 → 헬퍼와 무관 ✅ | `vault/src/keychain/human.ts:5` |
| 보안카드·홈택스 비밀번호 | 슬롯 KEK를 TPM→DPAPI로 래핑해야 하는데 네이티브 헬퍼(S10c)가 없어 `vault.native_helper_missing`으로 저장 거부(실패 닫힘) | `vault/src/keychain/backend.ts:177-191·249`, WIN-REALDEVICE §4 |
| 계정 갱신 토큰 | 같은 래핑이라 Windows에서 거부되지만 데스크톱이 아직 쓰지 않음. 로그인 유지는 신원 파일(`userData/remote-identity.json`) | `vault/src/keychain/account.ts`, `apps/desktop/src/remote-account.ts` |

화면에서는: 제품 진입점이 보안카드 등록을 **모든 OS에서** "지금은 등록할 수 없음"으로 끝낸다(`apps/desktop/src/shell-app.ts:681` `registerSecrets → unavailable`, 문구 `onboarding.ts:612` "이 빌드에서는 아직 보안카드를 등록할 수 없어요. 다른 인증으로 바꿔 주세요."). 그래서 헬퍼가 없어도 이번 주 흐름(공동인증서·간편인증)은 Windows에서 막히지 않는다.

보안카드 등록(T-06)을 켤 때 Windows에서 필요한 것(나중 판단용):
- (가) Rust N-API 헬퍼: `CryptProtectData`(DPAPI) + TPM(`MS_PLATFORM_CRYPTO_PROVIDER`). 3 OS CI·prebuild 배포까지 며칠 단위.
- (나) DPAPI만 PowerShell `ProtectedData`로(실기기 동작 확인됨, WIN-REALDEVICE §4). 빠르지만 KEK가 자식 프로세스 표준 입출력을 지나 금고 경계 결정이 필요.
- (다) 보안카드 없이 공동인증서·간편인증만(지금 상태).

### 1.4 공동인증서(NPKI)·간편인증
- 찾는 곳: `%USERPROFILE%\AppData\LocalLow\NPKI`, `%ProgramFiles%\NPKI`(`vault/src/npki-scan.ts:25-33`). LocalLow 인증서 1개 열거·`signPri.key` 접근 0회 실기기 ✅(WIN-REALDEVICE §10.5).
- USB(이동식 드라이브)는 훑지 않는다 ⚠️(WIN-REALDEVICE §3). 금융인증서(클라우드)는 PC 목록에 없다.
- 간편인증은 금고 저장이 없다. 실제 홈택스 동작은 H-01 성공 전 미확인 ⏳.

### 1.5 한글 사용자 이름·경로, 보안 프로그램
- 한글 사용자 이름: `icacls` 출력이 CP949라 계정 이름 비교가 깨지는 문제를 SID 비교로 피한다(`platform/src/acl.ts:173`). 경로는 인자·환경 변수로만 넘긴다(`acl.ts:192·317`). 한글 이름 계정 실기기는 아직 없다 ⏳(§5 W-3).
- 백신: Defender 실시간 보호 켠 채로 설치·실행 ✅(WIN-REALDEVICE §1). 다른 백신 ⏳.
- 홈택스 보안 프로그램(AnySign4PC·MagicLine 등, `research/R2-korean-portals.md:35·148`)은 로컬 에이전트라 전용 Chrome 프로필에서도 같이 쓸 것으로 보지만 공존은 미확인 ⏳(§5 W-5).
- 팀장 확인(2026-11-11 실제 홈택스 발급): 공동인증서(하드디스크) 목록은 PC에 깔린 **MagicLine 로컬 프로그램**(`https://127.0.0.1:42235`)에서 받아 온다 → **홈택스 통합설치 프로그램(인증서 모듈)이 고객 PC의 선행 조건**이다. 발급에 쓸 수 있는 공동인증서는 **사업자범용·전자세금계산서용뿐**(개인용·금융기관용 불가). 그 밖의 갈래는 보안카드·사업자 간편인증.

## 2. macOS

### 2.1 0.1.8 dmg 점검(읽기 전용, 2026-11-11)
`~/sax-installers/0.1.8/SovereignAX-0.1.8-arm64.dmg`를 읽기 전용으로 붙여 앱을 임시 폴더에 복사하고, 내려받은 파일처럼 격리 속성을 붙인 사본으로 확인했다(시스템 설정은 바꾸지 않음).

| 확인 | 결과 |
|---|---|
| `codesign -dv` | `Signature=adhoc`, `TeamIdentifier=not set`, arm64 단일 |
| 지정 요구사항(`codesign -d -r-`) | `designated => cdhash H"…"` → **빌드마다 바뀜** → 키체인 ACL이 새 빌드를 남으로 봄 |
| `spctl --assess --type execute` | **rejected** |
| `syspolicy_check distribution` | "Adhoc Signed App"(경고), **"Notary Ticket Missing"(Fatal)** |
| `LSMinimumSystemVersion` | **13.0** |

### 2.2 Gatekeeper에서 여는 길(공증 전 판)
- macOS 15 이상: 우클릭 [열기] 우회가 없다. 첫 실행 차단 창 [완료] → 시스템 설정 > 개인정보 보호 및 보안 > [그래도 열기] → 암호 → [그래도 열기].
- macOS 13·14: Control-클릭 → [열기] → [열기].
- 실제 창 문구는 다른 Mac에서 확인해야 한다 ⏳(§5 M-1). "손상되었기 때문에 열 수 없습니다"가 뜨면 고객과 통화하며 `xattr -dr com.apple.quarantine /Applications/SovereignAX.app`(그 앱 하나의 격리 속성만 지움)이 마지막 우회로다. 고객 문서에는 넣지 않았다.
- 공증 판은 "인터넷에서 다운로드한 앱입니다. 열겠습니까?" [열기] 한 번이다.

### 2.3 Intel Mac
- 지원하지 않는다(대표 결정 2026-11-11). 빌드는 arm64 하나다. Intel Mac에서 열면 macOS가 "이 Mac에서 지원되지 않아 열 수 없다"는 취지의 창을 띄운다(문구 ⏳). 안내서 §0에서 칩을 먼저 확인하게 했다.
- 참고: x64 dmg는 `pnpm deploy --cpu=x64`로 이미 빌드되는 것을 이 세션에서 한 번 확인했다(Rosetta 기동까지). 나중에 지원하게 되면 옵션 하나로 된다.

### 2.4 키체인 허용 창
- 앱이 쓰는 키체인 서비스 `SovereignAX`: 기동 때 금고가 `db-key`를 읽고(`keystore.ts`), `settings/strict`는 있으면 읽는다(`human.ts` 생성자). 보안카드 등록이 막혀 있어 `wrapkey/dev`·`kek/*`·`securitycard/*`는 만들어지지 않는다. Electron 쿠키 암호화(퓨즈 `enableCookieEncryption`)용 "SovereignAX Safe Storage" 항목도 있을 수 있다. 항목을 읽는 것은 금고·엔진 utilityProcess(Helper 앱)다.
- 키체인 항목의 ACL은 그 항목을 만든 앱의 **지정 요구사항**(designated requirement)을 기억한다.
  - 애드혹: 지정 요구사항 = cdhash → 빌드마다 바뀜 → **새 판마다** 기존 항목마다 허용 창. 답하기 전까지 `vault.started`에서 부팅이 멈춘다(2026-11-10 대표 Mac 0.1.3 → 0.1.4 실측). [거부]하면 DB를 못 연다.
  - Developer ID: 지정 요구사항 = `identifier "com.laf.sovereignax…" and anchor apple generic and certificate leaf[subject.OU] = <팀 ID> …` → 같은 팀 ID로 서명한 판끼리는 같다 → **새 판에서도 창이 뜨지 않는다.**
  - 애드혹 → Developer ID로 **처음 넘어갈 때는 한 번 뜬다**: 기존 항목의 ACL에는 옛 애드혹 cdhash만 있다. 항목마다 [항상 허용] 한 번이면 ACL에 새 지정 요구사항이 들어가고, 그 뒤 판부터는 뜨지 않는다.
  - 처음부터 Developer ID 판으로 설치한 고객(새 Mac): 항목을 그 앱이 만드므로 창이 없다.
  - 서명 팀이 바뀌면(예: 나중에 법인 계정으로 옮김) 지정 요구사항이 바뀌어 다시 한 번 뜬다.

### 2.5 Developer ID 서명·공증 (🔧 빌드 설정은 이 PR)
- 판정(`electron-builder.config.mjs` `macSigningFrom`): macOS 호스트 + 키체인의 `Developer ID Application:` 신원이 **정확히 하나**(여럿이면 `SAX_MAC_IDENTITY`로 고름) + `SAX_NOTARY_PROFILE`(notarytool 키체인 프로필 **이름**)이 있으면 `developer_id`. 하나라도 없으면 지금처럼 애드혹이고 빌드는 실패하지 않는다(이유 코드를 출력: `developer_id_missing`·`developer_id_ambiguous`·`notary_profile_unset`). Apple ID·앱 암호·팀 ID 값은 스크립트·레포·로그에 없다.
- 신원 찾기: `security find-identity -v -p codesigning`의 이름만 읽는다(`parseIdentities`). `Apple Development:` 신원은 쓰지 않는다(배포 서명이 아님).
- 빌드 순서(`scripts/package-win.mjs`): 퓨즈·asar 무결성 → 앱 서명(하드닝 런타임, `entitlements.mac.plist`, Helper 포함) → 앱 공증·스테이플(electron-builder, `APPLE_KEYCHAIN_PROFILE`=프로필 이름) → dmg → **dmg 서명(타임스탬프) → `notarytool submit --keychain-profile <프로필> --wait` → `stapler staple`·`validate`** → `spctl --assess` accepted 확인 → 그 뒤에 SHA-256(스테이플이 dmg를 바꾼다). 공증이 거절되면 제출 ID와 `notarytool log` 명령을 띄우고 빌드가 실패한다.
- build-info `signing: developer_id` → 앱의 "미서명 빌드" 배지가 사라진다(`apps/desktop/src/harden.ts`).
- 권한(`poc/apps/desktop/build/entitlements.mac.plist`): `com.apple.security.cs.allow-jit`, `com.apple.security.cs.allow-unsigned-executable-memory` 둘만.

| 하드닝 런타임에서 도는 것 | 필요한 권한 | 판단 |
|---|---|---|
| 메인·렌더러·utilityProcess(금고·엔진)의 V8 | allow-jit(+ allow-unsigned-executable-memory) | Electron 코드 서명 안내·electron-builder 기본 템플릿과 같다 |
| tesseract.js(OCR, 렌더러 샌드박스의 WebAssembly) | allow-jit로 충분 | V8 WebAssembly 코드도 JIT 메모리를 쓴다 |
| 네이티브 모듈 `@napi-rs/keyring`·`better-sqlite3-multiple-ciphers`(`app.asar.unpacked`) | 없음 | electron-builder가 같은 Developer ID로 서명하므로 라이브러리 검증을 통과한다. `disable-library-validation`은 넣지 않는다 |
| 키체인(@napi-rs/keyring → Security.framework) | 없음 | 앱 샌드박스를 쓰지 않으므로 keychain-access-groups 불필요 |
| 전용 Chrome 띄우기(Google 서명 실행 파일) | 없음 | 자식 프로세스는 부모의 하드닝 런타임 제약을 받지 않는다. Chrome은 자기 서명·키체인 항목을 쓴다 |
| 네트워크(`fetch`)·파일 | 없음 | 샌드박스 없음 |
| `ELECTRON_RUN_AS_NODE`·`DYLD_*` | 쓰지 않음 | 퓨즈 RunAsNode false. allow-dyld-environment-variables 불필요 |

서명 뒤 앱이 뜨는지는 팀장이 대표 Mac에서 확인한다(§5 S-1~S-4).

## 3. 새 빌드 전달

### 3.1 이번 주에 쓸 길: 다시 설치
- 자동 업데이트(`packages/updater`, `apps/desktop/src/update-host.ts`)는 코드가 있지만 **제품 진입점에 연결돼 있지 않다**: `apps/desktop/src/shell.ts:68` `startShell(...)`이 `update`를 넘기지 않고, `shell-app.ts:1243`는 `opts.update`가 있을 때만 업데이터를 띄운다. 켜려면 서명된 `latest.json`(릴리스 키 하드웨어 토큰, SIGNING-SETUP §1), 레지스트리 `/releases/{channel}` 게시, 투명성 로그(팀장 결정 11-05: `requireTransparency` 기본 true → 지금은 모든 업데이트 보류), Windows 코드 서명(`verifyUpdateCodeSignature`)이 필요하다. **이번 주는 켜지 않는다.**
- 데이터 유지: 앱 자료는 설치 폴더 밖(`%LOCALAPPDATA%\SovereignAX`, `~/Library/Application Support/SovereignAX`)이고 `appId`(`com.laf.sovereignax`)·`productName`·설치 폴더가 고정이다(`app-identity.json`). DB 키는 OS 키체인, 로그인은 `userData/remote-identity.json`, 사업자·거래처·인증 선택은 DB에 있다 → 재설치·덮어 설치로 사라지지 않는다. Windows 제거 뒤 재설치도 남는다(WIN-REALDEVICE §10.2).
- 고객이 보는 것: Windows는 SmartScreen 한 번 더 → 덮어 설치. Mac은 [대치] → (공증 판) [열기] / (애드혹) [그래도 열기] → (애드혹이거나 공증 판으로 처음 바꿀 때) 키체인 허용 창. 안내서 §8에 화면 순서대로 적었다.

### 3.2 절차 (만드는 쪽)
1. 머지된 main을 분리 체크아웃 → `pnpm install --frozen-lockfile` → `rm -f apps/desktop/tsconfig.tsbuildinfo`(데스크톱 인계 문서와 같다).
2. `cd apps/desktop`
   - `SAX_NOTARY_PROFILE=sax-notary SAX_APP_VERSION=<판> pnpm package:mac` — 대표 몫 §4-2가 끝난 Mac. 출력 첫머리 `macOS 서명: Developer ID (JA55KTZH34), 공증 프로필 sax-notary`, 끝에 `Developer ID 서명·공증(spctl accepted)`. 끝나지 않았으면 `macOS 서명: 애드혹(<이유>)`.
   - `SAX_APP_VERSION=<판> pnpm package:win --skip-build`
3. 산출물 옆에 `<설치본>.sha256`이 생긴다(이 PR). `report.json`의 `installer.sha256`, `buildInfo.commit`·`dirty:false`·`devOnlyIncluded:[]`, Mac은 `mac.spctl`·`mac.dmgNotarization`을 확인한다.
4. `~/sax-installers/<판>/`에 설치본과 `SHA256SUMS.txt`를 모은다.
5. 대표가 고객에게 **설치 파일은 링크로, SHA-256은 다른 경로(문자·카카오톡)로** 보낸다. 판마다 "공증 판인지"를 함께 알린다(안내서 §2-2 (가)/(나)).
6. 판을 올릴 때마다 판 번호를 키운다(레지스트리 `minAppVersion` 대조, 엔진 #243).

고객 쪽 대조: Windows `Get-FileHash <파일> -Algorithm SHA256`, Mac `shasum -a 256 <파일>`(안내서 §6).

## 4. 대표 몫 (계정·인증서·콘솔·결정)

### 4-1. SES (로그인 메일)
- 기본: AWS 콘솔에 채워 둔 SES 프로덕션 액세스 양식의 약관 체크 → [요청 제출], 승인 확인(팀장이 확인 요청해 둠).
- **우회로(샌드박스 그대로, 고객이 적을 때)**:
  1. AWS 콘솔 → 운영 리전의 **Amazon SES** → 왼쪽 **구성(Configuration) > 자격 증명(Identities)** → **[자격 증명 생성(Create identity)]**.
  2. 자격 증명 유형 **이메일 주소** → 고객이 로그인에 쓸 주소 입력 → **[자격 증명 생성]**.
  3. AWS가 그 주소로 "Amazon Web Services – Email Address Verification Request" 메일을 보낸다. **고객에게 "AWS에서 온 확인 메일의 링크를 눌러 주세요"라고 미리 알린다**(24시간 안).
  4. 자격 증명 목록에서 그 주소의 상태가 **확인됨(Verified)**이면 그 고객은 코드 메일을 받는다.
  - 샌드박스 한도(하루 200통·초당 1통)는 PoC에는 충분하다. 고객마다 1~4를 반복한다.

### 4-2. Apple Developer ID 서명·공증 (이번 주 목표)
대표는 팀 "yanggyun kim"(**팀 ID `JA55KTZH34`**)의 구성원이고 계정 소유자가 아니다. 키체인의 `Apple Development: yanggyun kim (BKDQVFVVU2)`의 괄호 값은 개인 식별자이지 팀 ID가 아니다. Developer ID Application 인증서는 2026-11-12에 발급됐다(주체 `Developer ID Application: yanggyun kim (JA55KTZH34)`, 발급자 Developer ID Certification Authority G2, 만료 2027-12-11). Xcode > Settings > Accounts > Manage Certificates에서 Developer ID Application을 만들면 "This operation can only be performed by the Account Holder."로 거절된다(2026-11-11). Developer ID 인증서는 계정 소유자만 만들 수 있다. 그래서 아래 길로 간다.

**(1) 기본: 대표 Mac에서 CSR → 계정 소유자가 발급 → 대표 Mac에 설치** (개인 키는 대표 Mac 밖으로 나가지 않는다)
1. 대표 Mac에서 **키체인 접근** 앱을 연다(Spotlight ⌘Space → "키체인 접근").
2. 메뉴 **키체인 접근 > 인증서 지원 > 인증 기관에서 인증서 요청…**
3. **사용자 이메일 주소**: 대표 Apple ID 이메일, **일반 이름**: `LAF Developer ID`(아무 이름), **CA 이메일 주소**: 비움, **요청 항목**: **디스크에 저장됨** → [계속] → `CertificateSigningRequest.certSigningRequest`를 저장. (이때 개인 키가 대표 Mac 로그인 키체인에 생긴다.)
4. 그 `.certSigningRequest` 파일을 계정 소유자에게 보낸다(비밀 아님, 메일·메신저 가능).
5. 계정 소유자가 발급(아래 요청문) → `developerID_application.cer`를 돌려받는다.
6. 대표 Mac에서 `.cer`를 두 번 눌러 **로그인** 키체인에 넣는다.
7. 터미널에서 `security find-identity -v -p codesigning` → `"Developer ID Application: yanggyun kim (JA55KTZH34)"` 줄이 보이면 끝. 안 보이면 Apple 중간 인증서 "Developer ID - G2"가 없는 것이다: https://www.apple.com/certificateauthority/ 에서 **Developer ID - G2** 인증서를 받아 두 번 눌러 넣고 다시 본다.

**(2) 차선: 계정 소유자가 자기 Mac에서 만들어 .p12로 넘김** (개인 키가 이동한다)
- 계정 소유자: Xcode > Settings > Accounts > Manage Certificates > [+] > **Developer ID Application** → 키체인 접근에서 그 인증서(개인 키 포함)를 **내보내기** → `.p12`, 긴 암호.
- 전달: `.p12`와 암호를 **다른 경로로**(파일은 메신저, 암호는 전화·대면). 대표가 두 번 눌러 로그인 키체인에 넣은 뒤 **양쪽에서 .p12 파일을 지운다**. 계정 소유자 Mac에도 개인 키가 남는다는 점을 안다.

**(3) 공증 자격 (notarytool 키체인 프로필)**
- 기본: 대표 본인 Apple ID의 앱 암호.
  1. https://appleid.apple.com 로그인 → **로그인 및 보안** → **앱 암호** → [+] → 이름 `sax-notary` → 생성된 `xxxx-xxxx-xxxx-xxxx`를 복사(한 번만 보인다).
  2. 대표 Mac 터미널에서 **대표가 직접**:
     ```
     xcrun notarytool store-credentials sax-notary --apple-id "<대표 Apple ID 이메일>" --team-id JA55KTZH34
     ```
     암호를 물으면 1의 앱 암호를 붙여 넣는다(명령줄에 `--password`로 넣지 않는다: 셸 기록에 남는다).
  3. `notarytool`이 바로 Apple에 자격을 확인한다. "Credentials saved to Keychain"이 나오면 끝. 팀 구성원 Apple ID로 공증을 제출하려면 그 팀에서 Developer 이상 역할이 필요한 것으로 알고 있다(확인 필요). 권한 오류면 아래 대안.
- 대안: 계정 소유자가 App Store Connect API 키를 만들어 준다. App Store Connect → **사용자 및 액세스** → **통합** → **App Store Connect API** → 팀 키 [+] → 이름 `sax-notary`, 역할 **Developer** → `.p8`(한 번만 받을 수 있음)·키 ID·발급자 ID를 대표에게(.p8은 비밀: 다른 경로). 대표 Mac에서 `xcrun notarytool store-credentials sax-notary --key <p8 경로> --key-id <키 ID> --issuer <발급자 ID>` → 그 뒤 `.p8`은 지운다. 프로필 이름이 같으므로 빌드는 바뀌지 않는다.
- (1)·(3)이 끝나면 팀장에게 "끝남"만 알린다. 팀장이 빌드를 요청한다.

**계정 소유자에게 보낼 요청문(복사해서 쓰기)**
> 안녕하세요. 저희 Mac 앱(SovereignAX)을 배포용으로 서명하려고 Developer ID Application 인증서가 필요합니다. 이 인증서는 계정 소유자만 만들 수 있어 부탁드립니다. 5분 정도 걸립니다.
> 1. https://developer.apple.com/account 로그인 → **Certificates, IDs & Profiles** → **Certificates** → 파란 [+]
> 2. **Software** 아래 **Developer ID Application** 선택 → [Continue]
> 3. Profile Type은 **G2 Sub-CA (Xcode 11.4.1 or later)** → 첨부한 `CertificateSigningRequest.certSigningRequest` 파일 선택 → [Continue]
> 4. [Download]로 받은 `developerID_application.cer` 파일을 저에게 보내 주세요.
> (가능하면) App Store Connect → 사용자 및 액세스에서 제 계정 역할이 **Developer 이상**인지도 봐 주세요. 공증 제출에 필요합니다.

- 알아 둘 것: Gatekeeper·`codesign`에 보이는 서명 주체가 **개인 이름 "yanggyun kim"**이다. 나중에 법인 계정으로 옮기면 팀 ID가 바뀌어 고객 Mac에서 키체인 허용 창이 한 번 더 뜬다(§2.4). Developer ID Application 인증서는 계정당 개수 제한이 있다(확인 필요).
- 계정 소유자가 이번 주에 안 되면: 애드혹 그대로(안내서 §2-2 (나)·§2-3).

### 4-3. Windows 코드 서명
- 이번 주 없음(대표 결정). 안내서 §1-2(SmartScreen [추가 정보] → [실행]). 나중 길: SIGNING-SETUP §2(Artifact Signing, 법인 설립 뒤)·§5(OV 대안).

### 4-4. 그 밖의 결정·준비
| 할 일 | 없으면(우회로) |
|---|---|
| **PoC 약관·개인정보 동의 문안**(F-06 전문이 없음, 화면은 "곧 여기서 열어 볼 수 있어요") | PoC 참여 동의서(위탁 처리 내용·AI 모델 처리·사용 기록·데이터 보관 위치·중단·삭제 요청 방법)를 앱 밖에서 서면·메일로 받는다 |
| **고객 PC 사전 확인**: OS·판, Mac 칩(Apple만), Chrome, 공동인증서가 PC에 있는지(USB만인지), **홈택스 통합설치 프로그램(인증서 모듈) 설치 여부**, **인증서 종류(사업자범용·전자세금계산서용만 발급 가능, 개인용·금융기관용 불가)**, 간편인증 앱, 회사 보안망(프록시·SmartScreen 정책), 로그인할 이메일(→ 4-1) | 첫 설치를 원격 지원(화면 공유)으로 함께 |
| **전달 채널**: 설치 파일 링크(약 120~160MB라 메일 첨부 불가) + SHA-256을 보낼 다른 경로 | 대표 Google Drive 공유 링크 + 카카오톡으로 해시 |
| **§5 실기기 확인**을 고객 첫 설치 때 함께 보고 팀장에게 전달 | — |

## 5. 고객·대표 실기기 확인 목록

각 항목은 5분 안에 끝나게 순서와 볼 것을 적었다. 결과는 ✅/❌ + 캡처로 팀장에게.

**Windows**
- **W-1 SmartScreen**(고객 PC, 2분): 받은 `.exe`를 두 번 누름 → "Windows의 PC 보호" 창 캡처 → [추가 정보] 뒤 **[실행] 버튼이 있는지** 캡처. 없으면 회사 정책 차단.
- **W-2 설치·첫 화면**(3분): [실행] 뒤 앱이 저절로 뜨는지, 약관 화면까지 걸린 시간(초), 화면 위 배지가 "미서명 빌드" 하나인지.
- **W-3 한글 사용자 이름**(고객 PC 사용자 이름이 한글일 때, 5분):
  1. 파일 탐색기 주소창에 `%USERPROFILE%` → 위쪽 경로의 사용자 폴더 이름이 한글인지 본다.
  2. 한글이면 앱 첫 기동에서 **"저장소 권한" 오류 창 없이** 약관 화면까지 가는지.
  3. 주소창에 `%LOCALAPPDATA%\SovereignAX\logs` → `vault.log`를 메모장으로 열어 `vault.started`가 있는지, `main.log`에 `main.engine_fatal`이 없는지.
  4. 온보딩 발급 인증에서 공동인증서 목록에 PC 인증서가 보이는지.
- **W-4 공동인증서 목록**(2분): 발급 인증 → 공동인증서 → 목록 캡처(이름은 가림). "찾지 못했어요"면 `%USERPROFILE%\AppData\LocalLow\NPKI` 폴더가 있는지.
- **W-5 홈택스 보안 프로그램(MagicLine·AnySign4PC 등) 공존**(5분):
  1. 고객이 평소 Chrome에서 홈택스 공동인증서 로그인이 되는지 먼저 본다(통합설치 프로그램이 깔려 있는지, 인증서가 사업자범용·전자세금계산서용인지).
  2. 앱에서 [홈택스에서 준비] → 전용 Chrome 창이 뜨면, **"보안 프로그램을 설치해 주세요"** 같은 안내나 설치 페이지로 가는지, 인증서 선택 창이 뜨는지 캡처.
  3. 작업 표시줄 오른쪽 아이콘(숨겨진 아이콘 포함)에 AnySign·MagicLine 아이콘이 있는지.
- **W-6 백신**: Defender 말고 다른 백신이 설치·실행 중 경고·격리를 하는지.

**Mac**
- **M-1 Gatekeeper 창 문구**(다른 Mac, 5분): 대표 Mac이 아닌 Mac에서 **링크로 내려받은** dmg(같은 Mac에서 복사한 것은 격리 속성이 없어 다르게 보인다) → 응용 프로그램으로 옮김 → 두 번 누름 → 첫 창 캡처 → (막히면) 시스템 설정 > 개인정보 보호 및 보안의 [그래도 열기] 칸 캡처 → 암호 뒤 창 캡처. macOS 판(사과 메뉴 > 이 Mac에 관하여)을 함께 적는다.
- **M-2 첫 설치 키체인**(새 Mac, 1분): 처음 설치한 Mac에서 키체인 허용 창이 **뜨지 않는지**.
- **M-3 새 판 키체인**(2분): 새 판으로 [대치] 뒤 처음 켤 때 허용 창 개수와 창에 적힌 항목 이름(예: "SovereignAX", "SovereignAX Safe Storage").
- **M-4 Chrome 위치**: `/Applications`나 `~/Applications`에 Chrome이 있는지.
- **M-5 Intel Mac**(있다면, 1분): 열었을 때 뜨는 창 문구 캡처.

**공통**
- **C-1 로그인 메일**: 고객 이메일로 코드가 오는지(SES, 4-1).
- **C-2 레지스트리**: 첫 기동 뒤 `logs/engine.log`에 `registry.synced`가 있는지.
- **C-3 실제 홈택스**: 공동인증서 비밀 창·간편인증 승인과 승인 카드.

**Developer ID 첫 서명 판(4-2 뒤, 팀장이 대표 Mac에서)**
- **S-1** 빌드 출력 `Developer ID 서명·공증(spctl accepted)`, `report.json` `mac.source`가 `Notarized Developer ID`.
- **S-2** `codesign -d -r- /Applications/SovereignAX.app` → `designated => identifier "com.laf.sovereignax" and anchor apple generic and … leaf[subject.OU] = JA55KTZH34`.
- **S-3** 대표 Mac(애드혹이 만든 항목이 있음)에서 첫 실행 → 허용 창이 항목마다 한 번 → [항상 허용] → `engine.log`에 `engine.db_opened`, `registry.synced`. 금고·DB가 열리면 하드닝 런타임에서 네이티브 모듈이 도는 것이다. 공동인증서 목록·등록증 읽기(OCR)·[홈택스에서 준비](전용 Chrome 기동)까지 한 번씩.
- **S-4** 같은 팀 ID로 판을 하나 더 올려 [대치] → 허용 창이 **뜨지 않는지**.

## 6. 고객이 문제를 넘길 때

- 로그: `logs/main.log`·`engine.log`·`vault.log`(`%LOCALAPPDATA%\SovereignAX\logs`, `~/Library/Application Support/SovereignAX/logs`). 한 줄 = `{at, c, code, …}`이고 문자열 값은 `[A-Za-z0-9_.:-]{0,80}`일 때만 남고 나머지는 `[dropped]`(`poc/packages/platform/src/log.ts:11·29`) → 이메일(`@`)·한글 이름·공백 섞인 글은 남지 않는다. 숫자·하이픈 모양 값(사업자번호 모양)은 이 거르기를 통과하므로, 로그에 그런 값을 넣는 호출이 없는지는 코드 리뷰에 기댄다(지금 `event(` 호출에 사업자번호·이메일 필드 없음을 grep으로 확인). 오류 메시지 앞부분이 밑줄로 이어져 남을 수 있다(예: `main.engine_fatal` `code_`). 회전이 없어 계속 커진다(후속).
- 보내지 말 것: `db/`(암호화된 장부), `vault/`, `chrome-profile/`, `staging/`, `userData/`(로그인 신원 파일).
- `crashDumps/`는 비밀이 담길 수 있어 요청하지 않는다.

## 7. 이 PR에서 고친 것

- `poc/apps/desktop/build/electron-builder.config.mjs`: `macSigningFrom`(키체인 Developer ID 신원 + notarytool 프로필 이름 → `developer_id`, 아니면 애드혹과 이유), `parseIdentities`, Developer ID면 하드닝 런타임·권한(Helper 포함)·공증.
- `poc/apps/desktop/build/entitlements.mac.plist`(새 파일, JIT 둘).
- `poc/scripts/package-win.mjs`: 신원 읽기·서명 판정 출력, `APPLE_KEYCHAIN_PROFILE`, dmg 서명·공증·스테이플·spctl 확인(`report.json` `mac`), 설치본 옆 `<설치본>.sha256`.
- `poc/apps/desktop/src/harden.ts`: build-info `signing: 'developer_id'`를 받고, "미서명 빌드" 배지는 `unsigned`일 때만.
- `poc/packages/vault/src/constants.ts`·`chrome/find.ts`·`service.ts`: Mac `~/Applications` Chrome 후보, `chrome.not_installed` 고정 코드.
- `poc/packages/engine/src/browser.ts`: 금고의 `chrome.not_installed`를 `RunEnd('failed', 'chrome.not_installed')`로.
- 시험: `poc/tests/updater-packaging.test.ts`(macOS 서명 판정·설정·권한·자기 점검·스크립트), `poc/tests/vault-chrome-find.test.ts`(후보·홈 펼치기·코드·엔진 변환).

후속(이 PR 밖): `chrome.not_installed` 화면 문구와 [홈택스에서 준비] 전 Chrome 사전 점검(desktop-2), 앱 안 판 표시, 로그 회전, USB NPKI, 보안카드 Windows 래핑(§1.3), 프록시(고객 망이 필수로 확인되면).
