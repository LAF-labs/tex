# 폰 앱 시뮬레이터 실행 기록 (2026-11-05)

- 기기: iPhone 17 Pro 시뮬레이터, iOS 26.5, Debug 빌드(애드혹 서명 `CODE_SIGN_IDENTITY=-`)
- PC 역할: `apps/mobile/dev/dummy-pc.ts`(시험 더미 — `DesktopPairing`·`acceptDesktopSession`·`ReceiveQueue`를 그대로 쓰고 키만 소프트 키). 릴레이는 같은 프로세스의 `dev/relay-server.ts`(`ws://localhost:8787/v1/connect`, D08 릴레이 초안).
- 영수증은 `assets/dev/sample-receipt.jpg`(견본·개발용·실제 거래 아님 표시) — 시뮬레이터에는 카메라가 없어 DEV 빌드에서만 견본을 쓴다.

| 파일 | 화면(08 화면 ID) | 확인한 것 |
|---|---|---|
| 00-keychain-fail-closed-unsigned.png | P-01 잠금 | 서명 없는 빌드에서 키체인이 −34018로 실패하면 약한 저장소로 물러서지 않고 멈춘다 |
| 01-lock-first-run.png | P-01 잠금(첫 실행) | 이 폰에만 있는 열쇠 만들기 |
| 02-home-unpaired.png | 홈 | 연결 전 |
| 03-pair-scan.png | S-03 폰 연결: QR 스캔(폰 쪽) | 앱 안 카메라 |
| 04-pair-sas.png | S-03 폰 연결: SAS | 6자리 대조. 틀린 SAS는 거부(남은 횟수 2), 맞는 SAS로 paired |
| 05-pair-done.png | S-03 폰 연결 완료 | |
| 06-home-pc-online.png | 홈 | IK 세션이 WS 릴레이로 열림 → "사무실 PC 켜짐" |
| 07-capture-camera-sim.png | P-08 촬영 | 앱 안 카메라 + 가이드 틀(시뮬레이터 카메라는 빈 화면) + DEV 빌드 전용 견본 버튼 |
| 08a/08b-capture-confirm-*.png | P-08 확인 | 폰 iOS Vision OCR + 파서: 12000 / 2026-11-01 / 가나다상회 / 220-81-62517 |
| 09-capture-sent.png | P-08 보냄 | 더미 PC `receipt stored (145271 B)`, 받은 JPEG sha256 = offer의 sha256(`d961f6f3…8439`) |
| 10-cash-entry.png | P-09 현금매출 | 83,000원 → 더미 PC `cash stored 2026-11-05` |
| 11-connection.png | P-06 연결 상태 | 보낼 것 0·0(보낸 뒤 폰에서 지움) |
| 12-connection-sp1-report.png | P-06 보호 상태 | SP-1 보고가 시뮬레이터를 "보호가 약함"으로 정직하게 표시: 열쇠 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`·생체 없음(시뮬레이터 개발), 파일 보호 등급 `none`(시뮬레이터 파일 시스템은 데이터 보호를 지원하지 않음). 백업 제외는 모두 적용 |

더미 PC 상태(마지막): `{"pairing":"paired","pairs":1,"received":{"receipts":1,"cash":1}}`

## 시뮬레이터에서 확인하지 못한 것(실기기 필요)

- `NSFileProtectionComplete` 실제 적용 — 시뮬레이터는 항상 `none`을 돌려준다. 실기기에서 P-06 보호 상태가 "모두 보호됨"이어야 한다.
- 열쇠 `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` + 생체 확인(`requireAuthentication`) — 시뮬레이터 DEV에서만 생체를 끈다.
- 백그라운드 30초 뒤 잠금: 키를 잊고 홈으로 돌아가는 것까지 확인(연결 화면 → 다시 열면 홈). 시뮬레이터 DEV는 생체가 없어 잠금 화면이 곧바로 열려 스크린샷으로는 남지 않는다. 실기기에서는 이 자리에서 Face ID를 묻는다.
- 실제 카메라 촬영·가이드 자르기.
