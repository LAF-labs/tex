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
| 결과 | `pnpm build`·`pnpm lint` 통과, `pnpm test` **117/117**(DACL 파서·복구 테스트 2건 추가 후), e2e **14/14**(OS 배율 150%, 앱 배율 강제 125%·150% 각 14/14), 앱 스모크 통과. 원자료 [raw/win/](raw/win/) |

Windows에서 처음 돌렸을 때 실패한 원인과 고친 것:

| 증상 | 원인 | 수정 |
|---|---|---|
| 번들 8종 BV-06 digest 불일치 | Git for Windows 기본 `core.autocrlf=true`로 접두 텍스트가 CRLF로 체크아웃됨 | 저장소 루트 `.gitattributes`(`* text=auto eol=lf`) |
| `prepareLayout` 실패 → 이후 테스트 연쇄 실패·10분 넘게 멈춤 | `whoami`를 PATH로 찾아 Git의 `whoami`가 돌았다 | `whoami`·`icacls`·`attrib`를 System32 절대 경로로(`windowsTool`) |
| (잠재) 한글 사용자 이름에서 DACL 판정 오류 | `icacls` 출력의 계정 이름은 콘솔 코드 페이지(CP949) | `icacls /save`의 SDDL로 SID 비교(`readDacl`) |
| (잠재) 누가 직접 더한 ACE가 복구 뒤에도 남음 | `/inheritance:r`은 상속 ACE만 지운다 | 사용자·SYSTEM 밖 SID를 `/remove`로 제거, 테스트에 Users 읽기 ACE 복구 추가 |
| (잠재) 조건부 ACE(`XA`, Everyone 허용 등)를 못 보고 통과 · 무결성 레이블(`S:`)을 다른 계정으로 오탐 | SDDL을 필드 6개짜리 정규식으로 읽었다 | 괄호 단위 파서(`parseDacl`), 읽지 못한 ACE·null DACL은 실패로. `icacls /remove`가 콜백 ACE를 못 지우므로 남으면 DACL 전체를 바꾼다(.NET `Directory.SetAccessControl`, 비승격 가능. `icacls /restore`는 SeRestorePrivilege가 필요해 못 씀) |
| 재분석 지점 테스트 EPERM | Windows 심볼릭 링크는 개발자 모드·권한 필요 | 테스트를 권한 없이 만들 수 있는 정션으로 |

## 6. S6m 측정(P0-1 흡수분) — (1) ✅ 관리자 계정 비승격 / (2) ⏳

승격하지 않은 토큰으로(관리자 계정 비승격, 이어서 표준 사용자 계정) (1) BitLocker·장치 암호화 상태 읽기 가능 여부, (2) 보조 볼륨 새 폴더의 기본 ACL을 기록한다(D19 A-19·A-25).

(1) 시스템 드라이브 `C:`, 토큰 비승격(무결성 Medium):

| 방법 | 결과 |
|---|---|
| Shell 속성 `System.Volume.BitLockerProtection`(`Shell.Application`) | **읽힘**, 값 `0` |
| 레지스트리 `HKLM\SYSTEM\CurrentControlSet\Control\BitLockerStatus\BootStatus` | **읽힘**, 값 `0` |
| `manage-bde -status` | 거부(관리자 권한 필요) |
| `Get-BitLockerVolume`, WMI `Win32_EncryptableVolume` | 거부 |
| `fsutil fsinfo volumeinfo` | 거부 |

비관리자로 상태를 읽는 경로는 Shell 속성이다(D07 §1 온보딩 안내에 쓸 후보). 값 `0`이 "꺼짐"인지 "해당 없음"(Home에 장치 암호화가 켜지지 않은 상태)인지는 승격 `manage-bde -status C:` 결과와 한 번 대조해야 확정된다(사람이 실행). 표준 사용자 계정에서 같은 표를 다시 채운다.

(2) 이 기기에는 `C:` 하나뿐이라 보조 볼륨이 없다. VHDX 하나를 만들어 붙이거나(관리자 승격, 사람이 실행) USB 드라이브를 NTFS로 포맷해 측정한다.

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
- [ ] S6m 기록(§6): (1) 관리자 계정 비승격 완료, 승격 대조·표준 계정·(2) 보조 볼륨 남음
- [ ] 인증수단 수령 일정 표 채움(§8)
