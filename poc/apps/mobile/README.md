# tex 폰 앱 (Phase 1, ADR-034)

Expo SDK 58 · React Native 0.88. 프로토콜은 `poc/packages/remote`(@sax/remote, D08 정본)를 소스 그대로 묶는다(metro.config.cjs).
poc pnpm 작업공간 밖의 독립 패키지다(`poc/pnpm-workspace.yaml`의 `!apps/mobile`). 의존성은 이 폴더에서 `pnpm install`.

| 화면 | 08 ID | 파일 |
|---|---|---|
| 잠금(생체, 백그라운드 30초 뒤 재잠금, 앱 전환기 가림) | P-01 | `src/screens/LockScreen.tsx`, `App.tsx` |
| 첫 화면: [영수증 찍기] [오늘 현금 매출] + PC 연결 상태 줄 | 08 §10 | `src/screens/HomeScreen.tsx` |
| 폰 연결(QR 스캔 → 24시간 경고 → 6자리 + "PC 화면에만 입력" 경고) | S-03 | `src/screens/PairScreen.tsx` |
| 연결 상태(켜짐·꺼짐, 마지막 접속, 보낼 것 건수, 연결 해제, SP-1 보호 상태) | P-06 | `src/screens/ConnectionScreen.tsx` |
| 종이 증빙 촬영(앱 안 카메라 → 자르기 → 기기 안 OCR → 확인 → 보관함 → PC) | P-08 | `src/screens/CaptureScreen.tsx`, `src/capture/*` |
| 현금매출(하루 숫자 하나, 날짜별) | P-09 | `src/screens/CashScreen.tsx` |

폰 승인(P-03, M7-7)은 제안 상태라 넣지 않았다.

## 지키는 것

- 키: `src/keyring.ts` — ThisDeviceOnly + 생체, 백업 제외, 서버로 가지 않는다(ADR-029, D08 §3.1). 절차·통과 기준은 [docs/sp1-key-backup.md](docs/sp1-key-backup.md).
- 사진: 앱 안 카메라만, 갤러리 가져오기·카메라 롤 저장 없음, 봉인 + 파일 보호 Complete + 백업 제외(`src/storage/*`, `modules/sax-native`).
- 업데이트: 스토어 서명 빌드만, OTA 없음(`updates.enabled=false`, D01 §6·ADR-028). 릴레이 허용 목록은 `src/config.ts`에 내장.
- 로그: 앱 소스에 console 호출 없음(시험이 막는다). 비밀·사진·금액을 로그에 넣지 않는다.
- OCR: iOS Vision(기기 안, 모델 없음) → 규칙 파서(`src/capture/parser.ts`) → 사장님 확인. 값은 후보일 뿐이고 PC docparse가 정본(ADR-034 결정 9). Android·OCR 불가 기기는 사진만 보낸다.

## 개발

```bash
pnpm install
pnpm typecheck && pnpm test     # 파서·자르기·SP-1 설정 시험(node --test)
pnpm dummy-pc                   # 더미 PC + 개발 릴레이(localhost:8787)
pnpm smoke                      # Node 폰으로 더미 PC와 페어링·전송 스모크
npx expo prebuild -p ios && npx expo run:ios   # 시뮬레이터
```

시뮬레이터 개발 빌드(`__DEV__ && !Device.isDevice`)에서만: QR 대신 [개발: 더미 PC의 QR 받기], 카메라 대신 [개발: 견본 영수증으로 찍기](앱에 묶인 견본, 갤러리 아님), 키 항목은 생체 없이(여전히 ThisDeviceOnly), 릴레이 `localhost:8787`(ws) 허용. 더미 PC에 6자리 입력은 `curl -XPOST localhost:8787/dev/sas -d '{"code":"123456"}'`.

시뮬레이터 빌드: 키체인은 entitlement가 있어야 열리므로 서명 없는 빌드(`CODE_SIGNING_ALLOWED=NO`)는 잠금 화면에서 멈춘다(의도한 동작, `reports/raw/mobile/00`). `ios/`에서 애드혹 서명으로 빌드한다.

```bash
xcodebuild -workspace tex.xcworkspace -scheme tex -configuration Debug -sdk iphonesimulator -destination 'name=iPhone 17 Pro' -derivedDataPath build/dd CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES DEVELOPMENT_TEAM= build
```

실기기·EAS 빌드: Apple 팀 ID는 저장소에 두지 않고 `APPLE_TEAM_ID`(10자) 환경 변수로만 넘긴다(`app.config.js`가 `ios.appleTeamId`로 얹는다).

빌드 설정은 `eas.json`(simulator·preview·production). 스토어 제출은 하지 않는다(M4-9 패키징·서명 뒤).

## 다른 트랙에 기대는 것

- 계정 서버의 AIK_pub·기기 목록 조회와 폰 계정 로그인(`src/net/account.ts`의 `AccountApi`) — 클라우드 트랙. 지금은 개발 구현만 있다.
- 릴레이 WSS(`packages/remote/src/ws-link.ts` 머리말의 초안 프로토콜) — 클라우드 트랙 services/relay.
- App Attest·Play Integrity 등록 확인(D08 §3.1) — 클라우드 트랙.
- 분실 폰 해제: [docs/lost-phone-rehearsal.md](docs/lost-phone-rehearsal.md).
