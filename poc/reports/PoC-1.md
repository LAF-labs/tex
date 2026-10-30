# PoC-1 환경 문서 (2026-10-30, 초안)

범위: D14 §0 PoC-1. PoC-3(홈택스 로그인·S1·S2)부터 PoC-10(S8)까지 쓰는 Windows 환경, 전용 Chrome 프로필, PoC 계정 지정. 인증수단·Artifact Signing 신청은 EX-6이 맡는다. 계정 정지 위험 수용은 [PoC-1-risk-acceptance.md](PoC-1-risk-acceptance.md).

상태 표기: ✅ 확정 · ⏳ 결정·작업 대기 · 📏 PoC-3 첫 접속 때 기록.

## 1. 호스트 ✅(결정) / ⏳(기기 준비)

| 항목 | 값 |
|---|---|
| 개발 Mac | Apple M5 Pro(arm64), macOS 26.5.1, VM 소프트웨어 없음 |
| PoC 실행 호스트 | **x64 Windows 11 실기기 1대**(2026-10-30 결정). 기기 정보는 준비 후 기록 |

Mac 위 VM(Parallels·UTM)은 **Windows 11 ARM**이다. x64 앱은 에뮬레이션으로 돌지만 커널 드라이버는 돌지 않는다. 홈택스가 요구하는 키보드 보안·인증서 모듈 중 드라이버를 쓰는 것이 있으면 ARM VM에서는 로그인부터 막힐 수 있다. 대상 사용자 PC(x64 Windows)와도 다르다. 그래서 ARM VM은 쓰지 않는다.

x64 클라우드 VM은 쓰지 않는다. 데이터센터 IP는 "본인 IP"가 아니라서 05 §비대상화와 맞지 않고 차단 위험이 커진다.

## 2. Windows 이미지 ⏳

| 항목 | 값 | 근거 |
|---|---|---|
| OS | Windows 11 24H2 x64(1차). 23H2는 G1 뒤 행렬에서 | D18 §2 |
| 계정 | 표준 사용자(비관리자)로 실행. 보안 모듈 설치만 관리자 승격 | 대상 사용자와 같은 조건, S6m |
| 백신 | Microsoft Defender 기본값. V3·알약 조합은 Phase 1 행렬 | D18 §2 |
| 디스크 | NTFS 시스템 볼륨 + 보조 볼륨 1개(S6m ACL 측정용) | D19 A-19 |
| 네트워크 | 사무실 또는 본인 회선. VPN·프록시·IP 전환 금지 | 05 §비대상화 |
| 시간대·로캘 | Asia/Seoul, ko-KR | — |

## 3. Chrome·전용 프로필 ✅(설계) / ⏳(설치)

- 사용자 설치 Chrome stable(`%ProgramFiles%\Google\Chrome\Application\chrome.exe`). 자동 업데이트는 끄지 않고, 실행마다 버전을 원장·보고서에 남긴다(ADR-001 결과).
- 전용 프로필은 금고가 만든다: `%LOCALAPPDATA%\SovereignAX\chrome-profile`(`packages/platform/src/paths.ts`). 일상 Chrome 프로필에는 붙이지 않는다(ADR-001 v1.3 보완).
- 기동 인자는 금고 상수 `CHROME_ARG_ALLOWLIST` 3개뿐(`--remote-debugging-pipe`, `--user-data-dir`, `--no-first-run`). `navigator.webdriver=true`는 그대로 둔다(ADR-010).
- 그 Windows 사용자 계정의 일상 Chrome은 PoC 기간에 홈택스에 로그인하지 않는다(세션 혼선 방지).

## 4. 포털 보안 모듈 📏

홈택스 첫 접속에서 설치를 요구하는 프로그램 이름·버전·설치 방식(관리자 승격 여부, 드라이버 여부)을 표로 남긴다. 금고 허용 목록에 넣을 간편인증·서명 모듈 도메인(`PORTAL_ETLD1` 주석)도 이때 채운다.

| 모듈 | 버전 | 드라이버 | 설치일 |
|---|---|---|---|
| (PoC-3에서 기록) | | | |

## 5. 빌드 도구 ⏳

| 항목 | 값 |
|---|---|
| Node.js | 26.x(Mac과 같은 주 버전, 현재 26.11.1) |
| pnpm | 12.11.2(`packageManager`) |
| 네이티브 모듈 | `better-sqlite3-multiple-ciphers` 13.0.3 → 사전 빌드 바이너리가 없으면 Visual Studio Build Tools(C++)·Python 필요 |
| 확인 | `pnpm install && pnpm build && pnpm test`, `electron apps/desktop/dist/e2e.js` 통과 |

## 6. S6m 측정(P0-1 흡수분) ⏳

표준 사용자로 (1) BitLocker 상태 읽기 가능 여부, (2) 보조 볼륨 새 폴더의 기본 ACL을 기록한다. 결과는 이 문서 §6에 추가한다(D19 A-19·A-25).

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

## 9. 완료 체크리스트

- [x] 실행 호스트 결정(§1): x64 실기기
- [ ] 실기기 준비·기기 정보 기록(§1)
- [ ] PoC 계정(관계사 법인) 지정과 위험 수용 서명
- [ ] Windows 설치·표준 사용자·Chrome stable
- [ ] 빌드·테스트 통과(§5)
- [ ] S6m 기록(§6)
- [ ] 인증수단 수령 일정 표 채움(§8)
