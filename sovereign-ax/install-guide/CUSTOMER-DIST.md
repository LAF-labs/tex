# 고객 PC 배포 점검 (PoC, 2026-11-11)

> 대상: 이번 주 PoC 고객의 Windows·Mac PC에 설치본을 깔아 실제 홈택스로 쓰게 하는 것(대표 결정 2026-11-11: 완료 기준 = 고객 PC에서 실제 홈택스로 된다).
> 근거는 main `771805e`의 코드·[WIN-REALDEVICE](../../poc/reports/WIN-REALDEVICE.md)(Windows 실기기 2026-11-06·11-09)·0.1.8 설치본을 읽기 전용으로 점검한 결과다. 실기기에서만 확인되는 것은 §5에 따로 모았다.
> 고객이 읽는 문서: [customer-install-guide.md](customer-install-guide.md). 대표 몫: §4.

심각도: **설치 불가** · **로그인 불가** · **인증서 등록 불가** · **발급 불가** · **불편**. 상태: ✅ 확인 · ⚠️ 문제 · 🔧 이 PR에서 고침 · ⏳ 실기기 확인 필요.

## 0. 요약: 고객 PC에서 막는 것 (심각도순)

| # | OS | 심각도 | 무엇 | 지금 할 수 있는 길 |
|---|---|---|---|---|
| 1 | 공통 | 로그인 불가 | SES 샌드박스면 인증된 주소 말고는 코드 메일이 안 감(`POST /v1/auth/code` 500) | 대표: 프로덕션 승인 제출, 또는 고객 주소를 SES "인증된 ID"로 추가(§4-1) |
| 2 | 공통 | 로그인 불가 | 회사망 프록시: PC 쪽 송신이 Node `fetch`라 OS 프록시를 따르지 않음 | 고객 망 사전 확인. 프록시 필수 망이면 이번 주는 다른 망(테더링 등) |
| 3 | 공통 | 발급 불가 | 실제 홈택스 H-01이 아직 한 번도 성공하지 않음 | 다른 세션 진행 중. 고객에게는 "첫 발급은 함께" |
| 4 | 공통 | 발급 불가 | Chrome 미설치(또는 Mac `~/Applications` 설치)면 금고가 `chrome not installed`로 실행 실패 | 안내서 §0에 Chrome 필수 명시 |
| 5 | Mac(Intel) | 설치 불가 | arm64만 빌드해 Intel Mac에서 실행 불가 | 🔧 `pnpm package:mac:x64`(이 PR). x64 dmg 빌드·Rosetta 기동까지 확인 |
| 6 | Mac | 설치 불가 | macOS 12 이하는 실행 불가(`LSMinimumSystemVersion` 13.0) | 고객 OS 사전 확인 |
| 7 | Mac | 설치 불가(우회 가능) | 애드혹 서명·공증 없음 → Gatekeeper 차단 | 안내서 §2-3([그래도 열기]). 근본: Developer ID(§4-2, 🔧 빌드 설정은 이 PR) |
| 8 | Win | 설치 불가(우회 가능) | 미서명 → SmartScreen 차단. 회사 정책으로 [실행]이 숨겨지면 설치 불가 | 안내서 §1-2([추가 정보] → [실행]). 근본: 코드 서명(§4-3) |
| 9 | 공통 | 발급 불가 | 첫 실행은 인터넷 필수(레지스트리 동기화 전엔 플레이북 없음) | 안내서 §0 |
| 10 | 공통 | 인증서 등록 불가(일부) | USB에만 있는 공동인증서·금융인증서는 목록에 안 나옴 | PC로 복사, 또는 간편인증 |
| 11 | 공통 | 인증서 등록 불가(일부) | 보안카드 등록은 모든 OS에서 막혀 있음("이 빌드에서는 아직 보안카드를 등록할 수 없어요") | 공동인증서·간편인증 |
| 12 | Mac | 불편 | 새 판마다 키체인 허용 창(항목마다), 답할 때까지 부팅 멈춤 | 안내서 §2-4. 근본: Developer ID |
| 13 | 공통 | 불편 | 자동 업데이트 미연결 → 새 판 = 재설치 | §3 |
| 14 | 공통 | 불편 | 국세청 상태조회가 늘 "조회하지 못했어요" → [맞습니다]로만 진행 | 안내서 §4 |
| 15 | 공통 | 불편 | 앱 안에서 판(버전)을 볼 곳이 없음 | 안내서 §7(OS 앱 목록·정보 가져오기) |
| 16 | Win | 불편 | 첫 기동 첫 화면 약 22초(저사양 Celeron 실측) | 안내서에 고지 |

**Windows 금고 저장 경로는 이번 주 막힘이 아니다**(아래 §1.3). 네이티브 헬퍼 개발은 하지 않는다.

## 1. Windows

### 1.1 설치
| 항목 | 사실 | 근거 |
|---|---|---|
| 형식 | NSIS 원클릭, 사용자별(`perMachine:false`, `allowElevation:false`), `requestedExecutionLevel: asInvoker` → **관리자 권한·UAC 없음** ✅ | `poc/apps/desktop/build/electron-builder.config.mjs` `nsis`·`win`, WIN-REALDEVICE §10.2(`consent.exe` 0회) |
| 설치 위치 | `%LOCALAPPDATA%\Programs\SovereignAX` ✅ | 같은 설정 `extraMetadata.name`, WIN-REALDEVICE §10.2 |
| 데이터 위치 | `%LOCALAPPDATA%\SovereignAX`(db·vault·chrome-profile·staging·logs·userData). 제거해도 남음 ✅ | `poc/packages/platform/src/paths.ts:20-42`, `installer.nsh` customUnInstall, `deleteAppDataOnUninstall:false` |
| SmartScreen | "Windows의 PC 보호" → [추가 정보] → 게시자 "알 수 없는 게시자" → [실행] ✅ | WIN-REALDEVICE §7 |
| 최소 OS | Windows 10 64비트(Electron 45). x64 설치본 하나. Windows on ARM은 x64 에뮬레이션(미확인 ⏳) | `package-win.mjs` TARGET |
| 첫 기동 | 첫 화면 22.2초·두 번째 9.8초, 최대 메모리 약 650MB(Celeron 3855U, RAM 8GB) | WIN-REALDEVICE §10.7 |

### 1.2 전용 Chrome
- 후보 세 곳만 찾는다: `%ProgramFiles%`, `%ProgramFiles(x86)%`, `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe` (`poc/packages/vault/src/constants.ts:8-11`). x86 위치는 실기기 확인 ✅(WIN-REALDEVICE §5).
- 없으면 `service.ts:458` `chrome not installed` → 엔진 실행 실패. 사람 문구로 바꾸는 일은 엔진·데스크톱 영역(후속).
- 전용 프로필은 `%LOCALAPPDATA%\SovereignAX\chrome-profile`. Google 로그인·확장이 감지되면 비밀 창을 열지 않는다(`shell-runs.ts:158·166` 문구).

### 1.3 금고의 비밀 저장 (TPM·DPAPI·네이티브 헬퍼)
| 비밀 | Windows에서 | 근거 |
|---|---|---|
| DB 키(`db-key`) | Credential Manager에 직접 저장(래핑 없음) → **됨** ✅. 재설치·제거 뒤에도 남음 | `vault/src/keystore.ts` `OsKeyStore`, WIN-REALDEVICE §4·§10.2 |
| 공동인증서 비밀번호 | **저장 기능 자체가 없음**. 실행마다 금고 비밀 창에서 입력 → 헬퍼와 무관 ✅ | `vault/src/keychain/human.ts:5` |
| 보안카드·홈택스 비밀번호 | 슬롯 KEK를 TPM→DPAPI로 래핑해야 하는데 네이티브 헬퍼(S10c)가 없어 `vault.native_helper_missing`으로 저장 거부(실패 닫힘) | `vault/src/keychain/backend.ts:177-191·249`, WIN-REALDEVICE §4 |
| 계정 갱신 토큰 | 같은 래핑이라 Windows에서 거부되지만 데스크톱이 아직 쓰지 않음. 로그인 유지는 신원 파일(`userData/remote-identity.json`)로 됨 | `vault/src/keychain/account.ts`, `apps/desktop/src/remote-account.ts` |

화면에서는: 제품 진입점이 보안카드 등록을 **모든 OS에서** "지금은 등록할 수 없음"으로 끝낸다(`apps/desktop/src/shell-app.ts:676` `registerSecrets → unavailable`, 문구 `onboarding.ts:611` "이 빌드에서는 아직 보안카드를 등록할 수 없어요. 다른 인증으로 바꿔 주세요."). 그래서 헬퍼가 없어도 이번 주 흐름(공동인증서·간편인증)은 Windows에서 막히지 않는다.

보안카드 등록(T-06)을 켤 때 Windows에서 필요한 것(범위·대안, 팀장 판단용):
- (가) Rust N-API 헬퍼: `CryptProtectData`(DPAPI) + TPM(`MS_PLATFORM_CRYPTO_PROVIDER`). 3 OS CI·서명·prebuild 배포까지 며칠 단위.
- (나) DPAPI만 PowerShell `ProtectedData`로(실기기 동작 확인됨, WIN-REALDEVICE §4). 헬퍼보다 빠르지만 KEK가 자식 프로세스 표준 입출력을 지나므로 금고 경계 결정이 필요.
- (다) 보안카드를 쓰지 않고 공동인증서·간편인증만(지금 상태). **이번 주 권장.**

### 1.4 공동인증서(NPKI)·간편인증
- 찾는 곳: `%USERPROFILE%\AppData\LocalLow\NPKI`, `%ProgramFiles%\NPKI`(`vault/src/npki-scan.ts:25-33`). LocalLow 인증서 1개 열거·`signPri.key` 접근 0회 실기기 확인 ✅(WIN-REALDEVICE §10.5).
- USB(이동식 드라이브)는 훑지 않는다 ⚠️(WIN-REALDEVICE §3). 금융인증서(클라우드)는 PC 목록에 없다.
- 간편인증은 금고 저장이 없다(`onboarding.ts` `AUTH_SIGN_METHOD.simple`). 실제 홈택스 동작은 H-01 성공 전 미확인 ⏳.

### 1.5 한글 사용자 이름·경로, 보안 프로그램
- 한글 사용자 이름: `icacls` 출력이 CP949라 계정 이름 비교가 깨지는 문제를 SID 비교로 피한다(`platform/src/acl.ts:173`). 경로는 인자·환경 변수로만 넘긴다(`acl.ts:192·317`). 한글 이름 계정 실기기는 아직 없다 ⏳.
- 백신: Defender 실시간 보호 켠 채로 설치·실행 확인 ✅(WIN-REALDEVICE §1). 다른 백신 ⏳.
- 홈택스 보안 프로그램(AnySign4PC·MagicLine 등, `research/R2-korean-portals.md:35·148`)은 전용 Chrome 프로필에서도 같은 로컬 에이전트를 쓴다고 보지만 공존은 미확인 ⏳.

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

### 2.2 Gatekeeper에서 여는 길(OS별)
- macOS 15 이상: 우클릭 [열기] 우회가 없다. 첫 실행 차단 창 [완료] → 시스템 설정 > 개인정보 보호 및 보안 > [그래도 열기] → 암호 → [그래도 열기].
- macOS 13·14: Control-클릭 → [열기] → [열기].
- 실제 창 문구(특히 "손상되었기 때문에 열 수 없습니다"가 뜨는지)는 다른 Mac 실기기에서 확인해야 한다 ⏳. 그 문구가 뜨면 고객과 통화하며 `xattr -dr com.apple.quarantine /Applications/SovereignAX.app`(그 앱 하나의 격리 속성만 지움)을 안내하는 것이 마지막 우회로다. 고객 문서에는 넣지 않았다.

### 2.3 Apple Silicon·Intel
- 지금까지 arm64만 빌드했다. 🔧 이 PR: `pnpm package:mac:x64`(`--mac --arch x64`). `@napi-rs/keyring-darwin-x64`·`better-sqlite3` `darwin-x64.node`가 잠금 파일·패키지에 이미 있다.
- 확인(이 PR, 판 0.0.1 시험 빌드): `SovereignAX-0.0.1-x64.dmg` 159MB, 실행 파일·`.node` 2개 모두 `x86_64`, `codesign --verify --deep --strict` 통과, `devOnlyIncluded` `[]`. Apple Silicon에서 Rosetta로 임시 HOME 기동 → `vault.started` 뒤 임시 HOME이라 "default keychain" 오류로 멈춤(정상, 데스크톱 인계 함정 1). Intel 실기기 ⏳.
- 유니버설 dmg는 네이티브 모듈 합치기가 필요해 쓰지 않는다. 고객 칩에 맞는 파일을 준다.

### 2.4 키체인 허용 창
- 앱이 쓰는 키체인 서비스 `SovereignAX`: 기동 때 금고가 `db-key`를 읽고(`keystore.ts`), `settings/strict`는 있으면 읽는다(`human.ts` 생성자). 보안카드 등록이 막혀 있어 `wrapkey/dev`·`kek/*`·`securitycard/*`는 만들어지지 않는다. Electron 쿠키 암호화(퓨즈 `enableCookieEncryption`)용 "SovereignAX Safe Storage" 항목도 있을 수 있다.
- **첫 설치**: 항목을 이 앱이 처음 만들므로 허용 창이 없을 것으로 본다 ⏳.
- **새 판(애드혹)**: 지정 요구사항이 cdhash라 기존 항목마다 허용 창(로그인 암호 + [항상 허용]). 답하기 전까지 `vault.started`에서 부팅이 멈춘다(2026-11-10 대표 Mac 0.1.3 → 0.1.4 실측). [거부]하면 DB를 못 연다.
- Developer ID 서명이면 지정 요구사항이 팀 ID 기준이 되어 새 판에서도 창이 뜨지 않는다.

### 2.5 Developer ID 서명·공증 (🔧 빌드 설정은 이 PR)
- `electron-builder.config.mjs` `MAC_SIGNING_ENV`·`macSigningFrom`: `SAX_MAC_IDENTITY`(키체인의 "Developer ID Application: … (팀 ID)"), `APPLE_API_KEY`(.p8 경로), `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`가 **모두 있고 Mac 호스트일 때만** 서명 + 하드닝 런타임 + `entitlements.mac.plist`(allow-jit·allow-unsigned-executable-memory) + 공증. 하나라도 없으면 지금처럼 애드혹.
- build-info `signing`이 `developer_id`면 앱의 "미서명 빌드" 배지가 사라진다(`apps/desktop/src/harden.ts`).
- 절차는 [SIGNING-SETUP.md §6](../../poc/apps/desktop/build/SIGNING-SETUP.md). 서명된 첫 빌드는 Mac에서 띄워 금고·DB가 열리는지 확인한다(§5).

## 3. 새 빌드 전달

### 3.1 이번 주에 쓸 길: 다시 설치
- 자동 업데이트(`packages/updater`, `apps/desktop/src/update-host.ts`)는 코드가 있지만 **제품 진입점에 연결돼 있지 않다**: `apps/desktop/src/shell.ts` `startShell(...)`이 `update`를 넘기지 않고, `shell-app.ts:1214`는 `opts.update`가 있을 때만 업데이터를 띄운다. 켜려면 서명된 `latest.json`(릴리스 키 하드웨어 토큰, SIGNING-SETUP §1), 레지스트리 `/releases/{channel}` 게시, 투명성 로그(팀장 결정 11-05: `requireTransparency` 기본 true → 지금은 모든 업데이트 보류), Windows 코드 서명(`verifyUpdateCodeSignature`)이 필요하다. **이번 주는 켜지 않는다.**
- 데이터 유지: 앱 자료는 설치 폴더 밖(`%LOCALAPPDATA%\SovereignAX`, `~/Library/Application Support/SovereignAX`)이고 `appId`(`com.laf.sovereignax`)·`productName`·설치 폴더가 고정이다(`app-identity.json`). DB 키는 OS 키체인, 로그인은 `userData/remote-identity.json`, 사업자·거래처·인증 선택은 DB에 있다 → 재설치·덮어 설치로 사라지지 않는다. Windows 제거 뒤 재설치도 남는다(WIN-REALDEVICE §10.2).
- 고객이 보는 것: Windows는 SmartScreen 한 번 더 → 덮어 설치(앱이 떠 있으면 닫으라는 창). Mac은 [대치] → Gatekeeper 한 번 더 → (애드혹이면) 키체인 허용 창.

### 3.2 절차 (만드는 쪽)
1. 머지된 main을 분리 체크아웃 → `pnpm install --frozen-lockfile` → `rm -f apps/desktop/tsconfig.tsbuildinfo` (데스크톱 인계 문서와 같다).
2. `cd apps/desktop`
   - `SAX_APP_VERSION=<판> pnpm package:mac` (Apple Silicon)
   - `SAX_APP_VERSION=<판> pnpm package:mac:x64 --skip-build` (Intel, 필요한 고객이 있을 때)
   - `SAX_APP_VERSION=<판> pnpm package:win --skip-build`
3. 산출물 옆에 `<설치본>.sha256`이 생긴다(이 PR). `report.json`의 `installer.sha256`, `buildInfo.commit`·`dirty:false`·`devOnlyIncluded:[]`를 확인한다.
4. `~/sax-installers/<판>/`에 설치본과 `SHA256SUMS.txt`(세 줄)를 모은다.
5. 대표가 고객에게 **설치 파일은 링크로, SHA-256은 다른 경로(문자·카카오톡)로** 보낸다. 같은 메일에 둘을 같이 넣지 않는다.
6. 판을 올릴 때마다 판 번호를 키운다(레지스트리 `minAppVersion` 대조, 엔진 #243).

고객 쪽 대조: Windows `Get-FileHash <파일> -Algorithm SHA256`, Mac `shasum -a 256 <파일>`(안내서 §6).

## 4. 대표 몫 (계정·인증서·콘솔·결정)

| # | 할 일 | 없으면(우회로) |
|---|---|---|
| 4-1 | **SES 프로덕션 액세스**: AWS 콘솔에 채워 둔 양식의 약관 체크 → [요청 제출](인계 문서 §6). 승인 여부 확인 | 샌드박스 그대로 SES 콘솔 > 자격 증명(Identities) > **이메일 주소 추가**로 고객 주소마다 인증 → 고객이 AWS 확인 메일 링크 클릭. 고객 수가 적은 이번 주엔 이걸로 충분 |
| 4-2 | **Apple Developer Program** 가입(법인 또는 개인, 연회비) → Developer ID Application 인증서를 빌드 Mac 키체인에 설치(사용자가 직접) → App Store Connect API 키(.p8, 키 ID, 발급자 ID) 발급 → 빌드 때 환경 변수 4개(§2.5) | 애드혹 + 안내서 §2-3·§2-4(첫 실행 [그래도 열기], 새 판마다 키체인 [항상 허용]) |
| 4-3 | **Windows 코드 서명**: Artifact Signing(법인 설립 뒤, SIGNING-SETUP §2) 또는 다른 CA의 OV 인증서(SIGNING-SETUP §5). 서명해도 SmartScreen 평판은 쌓일 때까지 경고가 남을 수 있다 | 미서명 + 안내서 §1-2([추가 정보] → [실행]) |
| 4-4 | **PoC 약관·개인정보 동의 문안**(F-06 전문이 아직 없음, 화면은 "곧 여기서 열어 볼 수 있어요") | PoC 참여 동의서(위탁 처리 내용·AI 모델 처리·사용 기록·데이터 보관 위치·중단·삭제 요청 방법)를 앱 밖에서 서면·메일로 받는다 |
| 4-5 | **고객 PC 사전 확인**(고객에게 직접): OS·판, Mac 칩(Apple/Intel), Chrome 설치 위치, 공동인증서가 PC에 있는지(USB만인지), 간편인증 앱, 회사 보안망(프록시·SmartScreen 정책), 로그인할 이메일 | 첫 설치를 원격 지원(화면 공유)으로 함께 |
| 4-6 | **전달 채널** 결정: 설치 파일 링크(약 120~160MB라 메일 첨부 불가) + SHA-256을 보낼 다른 경로 | 대표 Google Drive 공유 링크 + 카카오톡으로 해시 |
| 4-7 | **§5 실기기 확인**을 고객 첫 설치 때 함께 보고 결과를 팀장에게 전달 | — |

## 5. 고객·대표 실기기 확인 목록

첫 고객 설치 때 아래를 보고 결과(✅/❌ + 캡처)를 팀장에게 넘긴다.

**Windows**
- [ ] SmartScreen 창 문구와 [추가 정보] → [실행] 버튼이 보이는지(회사 PC 정책)
- [ ] 브라우저(Chrome·Edge) 내려받기 경고 문구
- [ ] 설치 뒤 앱이 저절로 뜨는지, 첫 화면까지 걸린 시간
- [ ] 한글 사용자 이름 계정이면: 첫 기동 성공("저장소 권한" 오류 창이 없는지)
- [ ] 공동인증서 목록에 PC 인증서가 보이는지
- [ ] [홈택스에서 준비] → 전용 Chrome이 뜨는지, 홈택스 보안 프로그램 설치 요구가 나오는지
- [ ] 백신(Defender 말고) 경고·격리

**Mac**
- [ ] 받은 dmg를 처음 열 때 창 문구(“확인할 수 없습니다” vs “손상되었기 때문에”), [그래도 열기] 위치
- [ ] **첫 설치에서 키체인 허용 창이 뜨는지**(뜨지 않을 것으로 봄)
- [ ] 새 판으로 바꿀 때 키체인 허용 창 개수와 항목 이름
- [ ] Intel Mac이면 x64 dmg 설치·기동
- [ ] Chrome이 `/Applications`에 있는지(아니면 실행 실패)

**공통**
- [ ] 고객 이메일로 코드가 오는지(SES)
- [ ] 첫 기동 `logs/engine.log`에 `registry.synced`(fresh true)가 있는지
- [ ] 실제 홈택스 로그인(공동인증서 비밀 창·간편인증)과 승인 카드

**Developer ID 첫 서명 빌드(4-2 뒤)**
- [ ] `spctl --assess --type execute -vv` → accepted, `source=Notarized Developer ID`
- [ ] 다른 Mac에서 받아 열 때 경고가 "인터넷에서 받은 앱" 확인 하나뿐인지
- [ ] 금고·DB가 열리는지(하드닝 런타임에서 네이티브 모듈 로드), 새 판에서 키체인 창이 사라졌는지

## 6. 고객이 문제를 넘길 때

- 로그: `logs/main.log`·`engine.log`·`vault.log`(`%LOCALAPPDATA%\SovereignAX\logs`, `~/Library/Application Support/SovereignAX/logs`). 한 줄 = `{at, c, code, …}`이고 문자열 값은 `[A-Za-z0-9_.:-]{0,80}`일 때만 남고 나머지는 `[dropped]`(`poc/packages/platform/src/log.ts:11·29`) → 이메일(`@`)·한글 이름·비밀번호 원문은 남지 않는다. 오류 메시지 앞부분이 밑줄로 이어져 남을 수 있다(예: `main.engine_fatal` `code_`). 회전이 없어 계속 커진다(후속).
- 보내지 말 것: `db/`(암호화된 장부), `vault/`, `chrome-profile/`, `staging/`, `userData/`(로그인 신원 파일).
- `crashDumps/`는 비밀이 담길 수 있어 요청하지 않는다.

## 7. 이 PR에서 고친 것

- `poc/scripts/package-win.mjs`: `--mac --arch arm64|x64`, electron-builder 출력 폴더(`mac-arm64`·`mac`), 설치본 옆 `<설치본>.sha256`, macOS 서명 판정 연결.
- `poc/apps/desktop/build/electron-builder.config.mjs`: `MAC_SIGNING_ENV`·`macSigningFrom`, mac 대상 CPU·파일 이름 `-${arch}`, Developer ID면 하드닝 런타임·권한·공증.
- `poc/apps/desktop/build/entitlements.mac.plist`(새 파일), `poc/apps/desktop/package.json` `package:mac:x64`.
- `poc/apps/desktop/src/harden.ts`: build-info `signing: 'developer_id'`를 받고, "미서명 빌드" 배지는 `unsigned`일 때만.
- 시험 `poc/tests/updater-packaging.test.ts`(macOS 서명 판정·설정·자기 점검·스크립트).

후속(이 PR 밖): Chrome 없음·`chrome not installed`의 사람 문구(엔진·데스크톱), 앱 안 판 표시, 로그 회전, USB NPKI, Mac `~/Applications` Chrome 후보, 보안카드 Windows 래핑(§1.3).
