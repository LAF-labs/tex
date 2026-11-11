# Windows 코드서명 온보딩 체크리스트 (Artifact Signing)

> D14 P0-13·M4-9, ADR-028 결정 1·4·5, D11 §4 자동 업데이트 행. 대표·yulmu가 해야 할 일이다. 리드타임은 신원 확인 1~20영업일이다(P0-13).
> 2026-11-06 정합(팀장 지시, 큐 1~15), yulmu 결정 2026-11-05: 서명은 **법인 설립 뒤** 이 체크리스트대로 한다. 그 전 베타 설치본은 미서명 빌드로 배포한다(앱 상단 "미서명 빌드" 표시, SmartScreen 경고 안내는 D15 F-06·D12 §8.5). 자동 업데이트는 서명 전까지 보류한다(ADR-028 결정 4 비고, D14 M4-9).
> 2026-11-06 팀장 결정: `betaDistributable`을 미서명 베타 결정(2026-11-05)에 맞춘다. `unsigned_build`는 beta 채널에서 블로커가 아니고 stable 채널에서만 블로커다. `windows_run_unverified`는 조건 없이 넣지 않고, Windows 실기기 점검 보고서의 설치·첫 실행 통과가 있으면 뺀다. 필드 이름은 그대로다(§4). 판정은 `poc/scripts/release-readiness.mjs`가 한다(`package-win.mjs`가 부른다, 시험 `poc/tests/release-readiness.test.ts`).
> 이 문서의 가격·지원 국가·리전은 2026-11-05 작성 시점에 공식 문서로 다시 확인해야 한다(아래 "확인 필요" 표시).

지금 상태: 인증서 없음. `pnpm package:win`은 **미서명 빌드**를 만들고 `release-readiness.json`에 `unsigned_build`를 적어 ~~**베타 배포 불가**~~ 미서명 빌드로 표시한다. 법인 설립 전 베타는 이 미서명 빌드를 배포한다(위 결정). `betaDistributable`은 이 결정에 맞춰 beta 채널에서 `unsigned_build`를 블로커로 세지 않는다(팀장 결정 2026-11-06, §4). 미서명 beta가 통과해도 `signed: false`는 그대로 남는다.

## 1. 무엇을 누가 갖는가(ADR-028 결정 5: 역할당 1인 1키)

| 키 | 보관 | 하는 일 | 보유자 |
|---|---|---|---|
| 코드서명(Artifact Signing) | Microsoft가 보관하는 **외부 단일 키**(정직 고지, ADR-028 결정 4) | 설치본·실행 파일 Authenticode 서명. SmartScreen·설치 신뢰 | CI 서비스 주체(서명만), 신원 확인은 대표 |
| 앱 릴리스 매니페스트 `latest.json` | Ed25519 하드웨어 토큰 1개 | 버전·sha512·만료 서명. 클라이언트가 설치 전에 검증(`@sax/updater`) | **비운영자 1인**. CI·레지스트리 호스팅 권한자와 겹치지 않는다 |
| 루트 2-of-3 | 오프라인 스마트카드 3장 | 뿌리 변경 릴리스(핀 키·허용 목록·상한 변경)에 동봉(ADR-028 결정 3) | 서로 다른 3인 |

코드서명만으로는 업데이트가 설치되지 않는다. 클라이언트는 `latest.json` 서명·만료·버전을 먼저 보고, Authenticode 서명 주체 DN 검사는 2차 방어다.

## 2. 사람이 할 일(순서대로)

- [ ] **자격 확인(확인 필요)**: Artifact Signing의 공개 신뢰(Public Trust) 인증서 프로필이 **한국 법인**을 받는지, 업력 요건이 있는지 Microsoft Learn "Artifact Signing" 문서에서 확인한다. 받지 않으면 §5 대안으로 간다.
- [ ] **Azure 구독**: 회사 명의 Microsoft Entra ID 테넌트와 종량제 구독. 결제 수단 등록(대표).
- [ ] **리소스 공급자 등록**: 구독에서 `Microsoft.CodeSigning` 등록.
- [ ] **Artifact Signing 계정 만들기**: 이름(= `SAX_AZSIGN_ACCOUNT`), 지원 리전 중 하나(리전마다 엔드포인트가 다르다 = `SAX_AZSIGN_ENDPOINT`, 예 `https://<region>.codesigning.azure.net`). 요금제 Basic(월 정액 + 서명 건수 한도, **가격 확인 필요**).
- [ ] **신원 확인(Identity validation) 신청**: 조직(Organization) 유형. 사업자등록증·법인 등기·대표 확인. 확인자 역할 `Artifact Signing Identity Verifier`는 대표 계정에만. **1~20영업일**. 승인되면 인증서 주체(CN·O)가 정해진다.
- [ ] **인증서 프로필 만들기**: Public Trust 프로필(= `SAX_AZSIGN_PROFILE`).
- [ ] **서명 주체 고정**: 승인된 주체 CN을 `apps/desktop/build/app-identity.json`의 `publisherName`과 CI 시크릿 `SAX_AZSIGN_PUBLISHER`에 **정확히 같게** 넣는다. 출시 전 고정(D11 §4). 바꾸면 electron-updater의 DN 검사가 기존 설치본에서 실패한다.
- [ ] **CI 서비스 주체**: Entra ID 앱 등록 1개(서명 전용). 인증서 프로필 범위에 `Artifact Signing Certificate Profile Signer` 역할만 준다(구독 소유자·기여자 아님). 비밀(client secret)은 만료 90일 이하, 가능하면 GitHub OIDC 페더레이션으로 비밀 없이.
- [ ] **CI 시크릿 등록**(GitHub Actions `production-signing` 환경, 보호 규칙: 필수 리뷰어 = yulmu):

| 시크릿 이름 | 값 |
|---|---|
| `SAX_AZSIGN_ENDPOINT` | 계정 리전 엔드포인트 URL |
| `SAX_AZSIGN_ACCOUNT` | Artifact Signing 계정 이름 |
| `SAX_AZSIGN_PROFILE` | 인증서 프로필 이름 |
| `SAX_AZSIGN_PUBLISHER` | 인증서 주체 CN(= `publisherName`) |
| `AZURE_TENANT_ID` | Entra 테넌트 ID |
| `AZURE_CLIENT_ID` | 서명 서비스 주체 앱 ID |
| `AZURE_CLIENT_SECRET` | 서비스 주체 비밀(OIDC면 없음) |

- [ ] **릴리스 매니페스트 키**: Ed25519를 지원하는 하드웨어 토큰 1개를 비운영자 1인에게(D09 §8.2 "앱 릴리스 매니페스트" 행). 공개키는 앱 핀(`TrustRoot.keys.release`)에 들어간다. SP-4 서명 의식 리허설에서 함께 정한다.

## 3. 서명 빌드가 도는 곳

- **Windows 러너에서만** 서명한다. electron-builder가 `Invoke-TrustedSigning` PowerShell 모듈로 서명하므로 macOS·Linux에서는 시크릿이 있어도 미서명 빌드가 된다(`signing_needs_windows_host`).
- 명령: `pnpm install --frozen-lockfile` → `cd apps/desktop && pnpm package:win`. 시크릿 7개가 모두 있으면 `electron-builder.config.mjs`의 `signingFrom`이 서명을 켠다.
- 순서: 퓨즈 → asar 무결성 리소스 → 서명(D11 §4). 서명 뒤에는 실행 파일을 고치지 않는다.
- 산출물: 서명된 `SovereignAX-Setup-<ver>.exe`, `report.json`(sha512·sha256), `release-readiness.json`.
- 그다음 릴리스 절차(D12 §6, 레지스트리 API.md): CI가 sha512·크기로 `latest.json` 서명 대상만 만든다(서명 권한 없음) → 투명성 로그 선기록 → 릴리스 키 보유자가 하드웨어 토큰으로 서명 → `PUT /admin/v1/releases/{channel}`.

## 4. 베타 배포 조건(`release-readiness.json`이 `betaDistributable: true`)

채널은 `app-identity.json` `channel`이다(지금 `beta`). 아래 표가 팀장 결정(2026-11-06) 기준이다. 판정은 `poc/scripts/release-readiness.mjs`, 채널별 판정표 시험은 `poc/tests/release-readiness.test.ts`다. 모르는 채널은 판정하지 않는다(빌드 실패). 필드 이름 `betaDistributable`은 그대로 둔다. `release-readiness.json`에 `channel`이 함께 적힌다.

| 막는 것 | 푸는 방법 |
|---|---|
| `unsigned_build` | **stable 채널에서만** 블로커다. beta 채널은 미서명 빌드를 배포한다(yulmu 결정 2026-11-05, 앱 상단 "미서명 빌드" 표시). stable은 위 2~3 |
| `publisher_dn_unset` | `app-identity.json` `publisherName` |
| `dev_only_code_included` | 진입점이 데모·가짜 포털 코드에 닿지 않게(ADR-035 W-7, 데스크톱 트랙) |
| `runtime_reads_outside_app` | 디자인 토큰을 빌드 때 앱 안으로(ADR-028 결정 7 `tokens.gen.ts`, 데스크톱 트랙) |
| `windows_run_unverified` | 조건 없이 넣지 않는다. Windows 실기기 점검 보고서 `poc/reports/WIN-REALDEVICE.md`(PR #152)에 설치·첫 실행 통과가 있으면 뺀다. **표시 형식**: 요약 표에 항목 칸이 정확히 `설치·첫 실행`인 행이 하나 있고, 결과 칸이 `✅`로 시작하며 `⚠️`·`❌`·`⏳`가 섞이지 않아야 한다. 행이 없거나 둘 이상이면 통과가 아니다(실패 닫힘). 보고서의 설치 파일 항목은 #152의 둘째 PR 범위다 |

Windows 실기기 확인(보류): 설치 경로 `%LOCALAPPDATA%\Programs\SovereignAX`, 관리자 권한 요청 없음, 데이터 폴더 `%LOCALAPPDATA%\SovereignAX` 분리, asar 변조 시 기동 거부, SmartScreen 표시, 제거 후 데이터 폴더 남음.

## 5. 자격이 안 될 때의 대안(팀장 결정 필요)

- OV 코드서명 인증서 + 클라우드 HSM 서명(인증서 발급사 원격 서명 서비스). 키는 여전히 외부 단일 키다(ADR-028 결정 4 문구 그대로).
- EV는 SmartScreen을 우회하지 않는다(D11 §4). 비용만 늘어난다.
- 어느 쪽이든 `signingFrom`에 서명 방식 하나를 더하는 일이고, `latest.json` 검증 구조는 바뀌지 않는다.

## 6. macOS Developer ID 서명·공증 (고객 PoC, 2026-11-11)

지금 상태: 인증서 없음 → `pnpm package:mac`·`package:mac:x64`는 **애드혹 서명**(`identity: '-'`)이다. 받은 dmg는 Gatekeeper가 막고(공증 없음), 지정 요구사항이 cdhash라 새 판마다 키체인 허용 창이 다시 뜬다(`sovereign-ax/install-guide/CUSTOMER-DIST.md` §2).

사람이 할 일(대표):
- [ ] Apple Developer Program 가입(법인 또는 개인). 법인이면 D-U-N-S 번호가 필요하다(확인 필요).
- [ ] **Developer ID Application** 인증서 발급 → 빌드 Mac 로그인 키체인에 설치(사용자가 직접, 개인키 포함). 인증서 이름 = `SAX_MAC_IDENTITY`(예: `Developer ID Application: LAF (ABCDE12345)`).
- [ ] App Store Connect > 사용자 및 액세스 > 통합 > **App Store Connect API** 키(역할: Developer) 발급. `.p8` 파일은 저장소 밖에 두고 그 경로 = `APPLE_API_KEY`, 키 ID = `APPLE_API_KEY_ID`, 발급자 ID = `APPLE_API_ISSUER`.

빌드:

| 환경 변수 | 값 |
|---|---|
| `SAX_MAC_IDENTITY` | 키체인의 Developer ID Application 인증서 이름 |
| `APPLE_API_KEY` | `.p8` 파일 경로 |
| `APPLE_API_KEY_ID` | API 키 ID |
| `APPLE_API_ISSUER` | 발급자 ID(UUID) |

- 넷이 모두 있고 macOS 호스트면 `macSigningFrom`이 `developer_id`를 고른다 → 서명 + 하드닝 런타임 + `build/entitlements.mac.plist`(allow-jit·allow-unsigned-executable-memory) + 공증(notarytool, 스테이플). 하나라도 없으면 애드혹(빌드는 실패하지 않는다).
- build-info `signing: developer_id` → 앱의 "미서명 빌드" 배지가 사라진다(`apps/desktop/src/harden.ts`).
- 확인: `spctl --assess --type execute -vv <앱>` → `accepted`·`source=Notarized Developer ID`, `xcrun stapler validate <dmg>`.
- 키체인: 애드혹 빌드가 만든 항목(`SovereignAX`/`db-key` 등)은 첫 서명 판에서 한 번 더 허용 창이 뜬다(ACL에 옛 cdhash만 있음). 그 뒤 판부터는 뜨지 않는다.
- 하드닝 런타임에서 네이티브 모듈(`@napi-rs/keyring`, `better-sqlite3-multiple-ciphers`)이 열리는지 첫 서명 판을 Mac에서 띄워 확인한다(CUSTOMER-DIST §5). 열리지 않으면 `disable-library-validation`을 더하는 대신 `.node` 서명 상태부터 본다.
