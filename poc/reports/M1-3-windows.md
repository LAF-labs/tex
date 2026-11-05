# M1-3 금고: Windows 실측 필요 목록

macOS 개발 호스트에서 돌릴 수 없는 경로. 인터페이스와 모의 구현은 `packages/vault/src/keychain/`에 있고, 실측 전에는 **저장을 거부**한다(약한 등급으로 조용히 내려가지 않는다). 각 항목은 Windows 11 PoC VM(PoC-1)에서 확인한다.

| # | 항목 | 인터페이스 | 지금 동작 | 확인할 것 | 근거 |
|---|---|---|---|---|---|
| W-1 | TPM 결박 KEK | `WindowsKeyHelper.tpmWrap/tpmUnwrap` | 헬퍼 없음 → `vault.native_helper_missing`, 저장 거부 | Rust N-API 헬퍼로 NCrypt Microsoft Platform Crypto Provider 내보낼 수 없는 키(UI 정책 없음) 생성·래핑·해제, 무프롬프트, 대상 PC TPM 보유율 | ADR-026 결정 2, S10c |
| W-2 | DPAPI 폴백 | `WindowsKeyHelper.dpapiProtect/dpapiUnprotect` | 헬퍼 없음 → 저장 거부 | `CryptProtectData`(CurrentUser, 엔트로피 = 슬롯 이름), 금고 프로세스 안에서만(PowerShell 등 다른 프로세스로 KEK를 넘기지 않음) | ADR-026 결정 2 |
| W-3 | Windows Hello 사본 | `HelloProvider` | `UnavailableHello`(Hello 없음과 같음) | `KeyCredentialManager` 비패키지 앱 키 범위, 서명-챌린지 → KEK 파생, 프롬프트 전면 표시·작업명/포털명 문구, 취소 처리 | ADR-026 결정 2·4, S10 보강 |
| W-4 | Credential Manager 지속성 | `KeyringItemStore` | @napi-rs/keyring 기본값 | `vault.credPersist = LOCAL_MACHINE`(로밍 아님), 바이트 API, 항목당 2,560B, 다른 Windows 사용자에서 안 보임 | D05 §2 상수, S10b |
| W-5 | 세션 이벤트 | control `session.event` | main이 보내야 함(desktop 트랙) | Electron powerMonitor `lock-screen`/`unlock-screen`/`suspend`/`resume` 신뢰성, WTS 사용자 전환·원격 세션 전환을 main이 받는 방법 | ADR-026 결정 3, S10c |
| W-6 | 유휴 시간 | control `session.idle` | main이 30초마다 보내야 함 | `powerMonitor.getSystemIdleTime()` 정확도(원격 데스크톱·입력 장치 없음) | ADR-026 결정 3 |
| W-7 | 덤프 제외 | (없음, 네이티브 헬퍼 필요) | 비밀 버퍼는 사용 직후 0으로 덮음만 | `sodium_malloc` 가드 페이지·mlock, `WerRegisterExcludedMemoryBlock`, utilityProcess Crashpad 제외 | D05 §8, S6g |

## macOS 개발 구현(실측 대상 아님)
- `DevKeychainWrapper`: Keychain 항목 `wrapkey/dev`의 무작위 키로 슬롯 KEK를 AES-256-GCM 래핑. 하드웨어 결박이 아니며 등급을 `keychain-dev`로 표시한다(동의 레코드·목록에 그대로 나온다).
- Hello 없음.
