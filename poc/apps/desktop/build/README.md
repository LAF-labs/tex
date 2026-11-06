# 데스크톱 패키징(D14 M4-9)

> 2026-11-06 팀장 결정: 산출물 `release-readiness.json` 설명을 바뀐 `betaDistributable` 규칙(beta 채널은 미서명 허용, 실기기 보고서로 `windows_run_unverified` 해제)에 맞춤. 스크립트는 코드 후속.

Windows NSIS 설치본을 만든다. 서명 온보딩은 [SIGNING-SETUP.md](SIGNING-SETUP.md), 업데이트 검증은 [`@sax/updater`](../../../packages/updater/README.md).

```
cd poc/apps/desktop
pnpm package:win            # 결과: poc/.tmp/package-win/
```

| 파일 | 내용 |
|---|---|
| `app-identity.json` | 앱 ID·이름·설치 폴더 이름·표시 이름·서명 주체·진입점·채널. **앱 이름 미정**이라 설정값으로 둔다 |
| `electron-builder.config.mjs` | electron-builder 설정(`makeConfig`)과 서명 판정(`signingFrom`) |
| `installer.nsh` | NSIS 추가: 데이터 루트 안 설치 거부, 제거 시 데이터 보존 |
| `icons/` | 아이콘 자리(`icon.ico`) |
| `../../../scripts/package-win.mjs` | 빌드 → `pnpm deploy` → dist 줄이기 → electron-builder → 퓨즈 확인 → 보고서 |

## 결정

- **설치 경로**: 사용자별 `%LOCALAPPDATA%\Programs\SovereignAX`(관리자 권한 없음, `perMachine: false`, `allowElevation: false`). 데이터 루트 `%LOCALAPPDATA%\SovereignAX`(D07 §1.1)와 **나눈다**: 데이터 루트는 DACL 소유자 + SYSTEM·색인 제외를 앱이 매 기동 확인하는 곳이고, 설치·업데이트·제거는 그 폴더를 건드리지 않는다. `installer.nsh`가 `/D`로 데이터 루트 안에 설치하는 것을 막는다.
- **이름**: `productName`·`installDirName` = `SovereignAX`(실행 파일·설치 폴더, 바꾸면 업데이트 경로가 바뀐다). 사용자에게 보이는 이름은 `displayName`(바로가기·프로그램 추가/제거).
- **asar + 무결성 + 퓨즈**(D11 §4): `RunAsNode` off, `EnableNodeOptionsEnvironmentVariable` off, `EnableNodeCliInspectArguments` off, `EnableEmbeddedAsarIntegrityValidation` on, `OnlyLoadAppFromAsar` on, `EnableCookieEncryption` on, `GrantFileProtocolExtraPrivileges` off. 스크립트가 만든 실행 파일의 퓨즈를 다시 읽어 다르면 실패한다. electron-builder 26은 asar 무결성 리소스를 쓰고 퓨즈를 뒤집은 다음 서명한다(둘 다 서명 전이고, 퓨즈는 asar를 바꾸지 않는다).
- **포함·제외**(ADR-035 W-7): 앱 `dist`는 진입점(`app-identity.json` `entry`)에서 상대 import로 닿는 파일만 남긴다. 그래서 `demo-shell.js`·`demo-*.js`·`docparse-e2e.js`·`smoke-plan.js`는 빠진다(개발 콘솔 `main.js`는 W-1에서 지웠고, e2e·측정은 `apps/desktop/e2e`에서 `e2e-dist`로 따로 컴파일해 앱 `dist`에 없다). 닿는데 이름이 데모·e2e·fixture·mock인 파일은 `release-readiness.json`의 `dev_only_code_included`로 적는다(지금 셸 진입점이 목업 어댑터 `shell-mock`·`onboarding-mock`에 닿는다 — 실제 저장소로 바꾸면 없어진다). 모든 패키지에서 `.ts`·`.d.ts`·`.map`·`src/`·문서는 뺀다. 네이티브는 Windows x64만(`better-sqlite3-multiple-ciphers/prebuilds/win32-x64.node`, `@napi-rs/keyring-win32-x64-msvc`), `.node`는 `asar.unpacked`. pdfjs의 `@napi-rs/canvas`는 docparse가 렌더러 샌드박스라 쓰지 않아 뺀다.
- **macOS에서 Windows 빌드**: `pnpm deploy --os=win32 --cpu=x64 --ignore-scripts`로 잠금 파일 그대로 Windows 선택 의존성을 받고, 네이티브는 미리 빌드된 바이너리를 쓴다(`npmRebuild: false`). 실행 파일 리소스는 resedit(순수 JS)라 Wine이 필요 없다. 빌드 때 electron-builder가 Electron zip·NSIS·7zip을 GitHub 릴리스에서 받는다(체크섬 확인은 electron-builder가 한다).
- **블록맵 차등 업데이트 끔**(`differentialPackage: false`): 서명된 `latest.json`이 다루지 않는 파일을 두지 않는다. 전체 설치본 sha512만 본다.
- **게시 없음**(`publish: null`): `latest.yml`은 레지스트리가 서명된 `latest.json`에서만 만든다.

## 산출물(`poc/.tmp/package-win/`)

- `dist/SovereignAX-Setup-<ver>.exe`, `dist/win-unpacked/`
- `report.json`: 설치본 크기·sha512·sha256, asar 크기·파일 수·패키지별 크기, `asar.unpacked` 목록, 퓨즈 상태, 앱 dist 포함·제외 목록, 배포 판정
- `release-readiness.json`: `betaDistributable`(막는 것 목록). 팀장 결정(2026-11-06): beta 채널에서는 `unsigned_build`가 블로커가 아니고 stable에서만 블로커다. `windows_run_unverified`는 실기기 보고서의 설치·첫 실행 통과가 있으면 빠진다. 스크립트는 아직 옛 규칙이라 지금은 늘 false다(코드 후속, [SIGNING-SETUP.md §4](SIGNING-SETUP.md))
- `asar-files.txt`: asar 안 파일 전체 목록
- 앱 안 `build-info.json`: 버전·채널·커밋·`signing`(`azure`|`unsigned`)·`devOnlyIncluded`

## 데스크톱 트랙에 제안하는 인터페이스(팀장 경유, `src/**`는 이 트랙이 고치지 않는다)

### 1. 기동 자기 점검(`harden.ts`)에 더할 것

```ts
/** 앱 안 build-info.json(scripts/package-win.mjs가 쓴다) */
export interface BuildInfo { productName: string; version: string; channel: 'stable' | 'beta'; signing: 'azure' | 'unsigned'; commit: string; devOnlyIncluded: string[]; testBuild?: boolean }

/**
 * 패키지된 앱만(app.isPackaged). 빈 배열이면 통과. 'fatal:'로 시작하면 열지 않는다, 'warn:'은 배너.
 * - fatal:not_asar            app.getAppPath()가 resources\app.asar가 아니다(OnlyLoadAppFromAsar 퓨즈가 꺼졌거나 다른 실행 파일)
 * - fatal:install_in_data_root process.execPath가 %LOCALAPPDATA%\SovereignAX 아래다(D07 §1.1 DACL 루트와 섞임)
 * - fatal:build_info_missing  build-info.json이 없거나 모양이 틀리다
 * - warn:install_unexpected   %LOCALAPPDATA%\Programs\<productName> 밖(사용자 /D 설치·복사본)
 * - warn:unsigned_build       signing !== 'azure' → 화면 상단 "미서명 빌드" 표시, 베타 배포본이 아니다
 * - warn:dev_code_included    devOnlyIncluded가 비어 있지 않다
 * - warn:test_build           testBuild가 true다 → "실계정 시험 빌드" 배지
 */
export function packagedProblems(o: { isPackaged: boolean; appPath: string; execPath: string; localAppData: string; buildInfo: unknown }): string[];
```

- asar 내용 변조는 `EnableEmbeddedAsarIntegrityValidation` 퓨즈가 Electron 단계에서 막는다(앱 코드가 돌기 전에 종료). 자기 점검은 그 퓨즈가 실제로 걸린 실행 파일인지(asar에서 로드됐는지)만 본다.
- 실계정 시험 빌드는 `node scripts/package-win.mjs --test-build`(poc에서)로 만든다. build-info `testBuild: true`이고 release-readiness에 `test_build` 블로커가 붙는다(배포 불가). 앱은 `isTestBuild(buildInfo)`일 때만 업데이트 투명성 확인 끄기 설정을 받는다(팀장 결정 11-05, update-host `updatePolicy`). 칸이 없거나 모양이 틀리면 제품 빌드다.
- 서명 상태는 `build-info.json`으로 보인다. 실행 중인 exe의 Authenticode를 앱이 직접 확인하는 것(PowerShell·WinVerifyTrust)은 프로세스를 띄우거나 네이티브가 필요해 Phase 1에서는 하지 않는다. 업데이트 설치 전 DN 검사는 electron-updater(`verifyUpdateCodeSignature`)가 한다.

### 2. 업데이트 배선(main, `update-host.ts` 같은 새 파일)

electron-updater ≥ 6.3.0-alpha.6(CVE-2024-39698, D11 §4), 지금 6.8.x. `autoDownload = false`, `autoInstallOnAppQuit = false`, 피드는 `generic` `https://<registry>/releases/<channel>/`. 순서는 [`@sax/updater` README "배선 순서"](../../../packages/updater/README.md#배선-순서).

### 3. 진입점

지금 `entry`는 `dist/shell.js`(PoC-9 셸)다. 제품 진입점이 정해지면 `app-identity.json` `entry`만 바꾼다. 셸은 앱 밖 `sovereign-ax/design-system/tokens.json`·`components/bundle.css`를 런타임에 읽어(`shell-tokens.ts`) **설치본에서는 기동하지 못할 수 있다** → `runtime_reads_outside_app`. ADR-028 결정 7의 빌드 시 생성(`tokens.gen.ts`)이 필요하다.
