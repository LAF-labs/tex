# SP-1 폰 키 백업 제외 · ThisDeviceOnly 확인 절차 (M7-1·M7-8)

근거: D08 §3.1(모바일 저장 규칙), ADR-029(서버는 열쇠를 갖지 않는다), ADR-034 결정 9(사진 보호), D07.
통과 기준(D08 §3.1): iCloud 암호화 백업을 다른 iPhone에 복원했을 때 키·키 링 0개, Android 백업·기기 이전 뒤 키 0개.

## 1. 무엇을 어떻게 지키나

| 대상 | 저장 | 보호 |
|---|---|---|
| `Sm`(X25519)·`Vm`(Ed25519)·`Km`(X25519)·파일 키 | SecureStore 항목 하나(`sax.device.v1`, 서비스 `com.lafco.tex.keys`) | iOS `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY` + `requireAuthentication`(biometryCurrentSet). Android Keystore 사용자 인증 키로 래핑. 저장 실패 시 약한 등급으로 내려가지 않는다 |
| 우편함 쓰기 토큰·페어링 기록·기기 목록·현금매출 기록 | `sax/state.bin` | 파일 키로 XChaCha20-Poly1305 봉인 + 파일 보호 Complete + 백업 제외 |
| 보낼 사진·현금매출 | `sax/outbox/<id>.p`·`.m` | 파일 키 봉인(AD = 파일 이름) + Complete + 백업 제외. PC가 stored로 답하면 지운다 |
| 카메라·편집 임시 파일 | 앱 캐시 | 봉인해 옮긴 뒤 바로 지운다. 사진 앱·갤러리에는 쓰지 않는다 |
| 설치 표지 `sax-install.json` | 문서 폴더 | 백업 제외. 없으면 첫 실행으로 보고 키체인 항목을 지운다(재설치) |

시뮬레이터 개발 빌드(`__DEV__ && !Device.isDevice`)만 키 항목을 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`·생체 없이 저장한다(시뮬레이터에는 암호가 없다). 여전히 ThisDeviceOnly다. 릴리스 빌드와 실기기에서는 이 분기가 없다.

우편함 토큰은 D08 §3.1 표의 "키·토큰" 행에 있다. 이 앱은 토큰을 키체인에 따로 두지 않고, 키체인의 파일 키로 봉인한 상태 파일에 둔다(같은 표의 "래핑 키 링" 방식). 백업이 복원돼도 파일 키가 없으므로 토큰은 열리지 않는다. 다르게 해야 하면 팀장에게 ADR로 올린다.

## 2. 기계 확인(CI)

`pnpm test`(apps/mobile) → `test/sp1-config.spec.ts`:
- 키체인 등급이 ThisDeviceOnly뿐이고, SecureStore 호출은 keyring.ts에만 있다
- Android `allowBackup=false`, secure-store 백업 규칙 끔, `plugins/with-no-backup.cjs`가 cloud-backup·device-transfer 모든 도메인을 뺀다
- iOS 기본 파일 보호 Complete, 파일 공유 끔, 사진 라이브러리 권한·의존성 없음, 마이크 권한 없음
- 보관 파일은 봉인 후 보호 지정, 네이티브 모듈이 없으면 저장 거부
- OTA 없음(`updates.enabled=false`, expo-updates 없음), 앱 소스에 console 호출 없음

## 3. 기기 확인(사람, 출시 전 한 번 + 키 저장 방식을 바꿀 때)

준비: 실기기 2대(A: 시험 폰, B: 복원 대상), 같은 Apple ID, PC 더미(`pnpm dummy-pc`) 또는 실제 PC.

1. A에 앱 설치 → 첫 실행 키 만들기 → PC와 연결 → 영수증 1장을 찍고 PC를 끈 상태로 둔다(보관함에 1건).
2. A의 [PC 연결] → [이 폰 보호 상태 보기]: "열쇠·파일 보호 정상", 열쇠 `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY · 생체 필요`, 모든 파일 `백업 제외 · NSFileProtectionComplete`인지 본다. 화면을 찍어 `poc/reports/raw/mobile/sp1-A.png`로 둔다.
3. A를 iCloud로 백업한다(설정 > Apple ID > iCloud > iCloud 백업 > 지금 백업). Finder 암호화 백업도 한 번 만든다.
4. B를 초기화하고 그 백업으로 복원한다.
5. B에서 앱을 연다. 기대: 첫 실행 화면("이 폰에만 있는 열쇠를 만들어요")이 뜨고, PC 연결 상태가 "연결 전"이며 보관함 0건이다. 앱이 보이지 않으면(백업에서 빠짐) 그것도 통과다.
6. (선택) Finder 백업을 iMazing 등으로 열어 `com.lafco.tex` 앱 데이터에 `sax/`·`sax-install.json`이 없는지, 키체인 백업에 `com.lafco.tex.keys`가 없는지 본다.
7. Android: A에서 `adb shell bmgr backupnow com.lafco.tex` → "Backup is not allowed" 또는 데이터 0. 기기 이전(Smart Switch·Google 기기 간 이전) 뒤 B에서 첫 실행 화면이면 통과.
8. 결과를 `poc/reports/raw/mobile/sp1-result.md`에 날짜·기기·OS 버전·통과/실패로 적는다(값·토큰은 적지 않는다).

실패하면: 키 저장 코드를 바꾸지 말고 팀장에게 알린다(ADR-029 위반 가능).
