# D08. 리모트 컨트롤 프로토콜

> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영. 바뀐 절에는 근거 ID를 붙였다(상충 표기 `C/X-nn`은 감사 C §5).
>
> 근거: [research/R4-e2ee-security.md](../research/R4-e2ee-security.md). `[제안]`은 R4의 설계 제안이며 1차 출처로 확정되지 않은 수치, `[검토]`는 암호 전문가 리뷰(S-6, 범위는 SP-5로 확대)가 필요한 분석이다. 관련 ADR: [ADR-007](adr/ADR-007-noise-pairing-zero-knowledge-relay.md), [ADR-016](adr/ADR-016-account-trust-anchor-hardware-approval.md).

## 1. 목표와 가정

- 릴레이 서버는 암호문·우편함 ID·크기 버킷·시각·바깥 헤더의 `kind`만 본다(TB-6). **릴레이는 내용과 키를 볼 수 없다. 계정과 우편함의 연결은 분리 저장·접근 통제·짧은 보존으로 줄이지만, 운영자는 연결 시점·IP 상관으로 언제든 계정↔우편함을 이을 수 있다**(C-14, C/X-17).
- **신뢰 앵커는 계정 신원 키 `AIK`다.** 서버는 기기 목록을 보관·중계할 뿐이며, 폰과 PC는 AIK 서명이 없는 기기 목록 항목을 믿지 않는다(C-01, §4.1). 계정 탈취자(이메일 장악)는 AIK를 갖지 못한다.
- 데스크톱과 폰은 서로를 기기별 장기 키로 식별하고, 페어링 때 사람이 6자리 코드를 **PC에 입력**해 확인한다.
- 폰은 명령·승인·캡차 답·비밀을 보내고, 진행 이벤트·승인 카드·캡차 이미지·결과 파일을 받는다. **비밀은 라이브 세션에서만 오가고 큐에 들어가지 않는다.**
- **사용자 명의 비가역 행위(`issue_document`·`send`·`sign`)의 원격 승인은 하드웨어 키(`Px`)로만 한다**(C-06, §6.1).
- 데스크톱이 꺼져 있으면 "의도(intent)"만 암호 봉투로 큐에 ≤ 72시간 대기하고, 켜진 뒤에도 실행이 아니라 **시작 게이트 → 커밋 게이트**의 새 승인 요청으로 바뀐다(C-17, §7).
- 잔여 위험(TOFU, E-12): 새 폰은 **첫 페어링마다** 서버가 준 `AIK_pub` 외에 독립 앵커가 없다. 계정의 첫 데스크톱 등록 시점뿐 아니라 폰을 바꾸거나 추가할 때마다, 서버(내부자)와 공격자 PC가 공모해 같은 가짜 `AIK_pub`를 주고 사용자가 피싱 QR·6자리에 응하면 그 폰은 공격자 PC와 페어링된다. `PAIR_OK` 대조는 서버와 PC가 같은 값을 주는 공모를 막지 못한다. 이미 페어링된 기기에서의 교체는 §4.1 규칙으로 드러난다. 계정 키 투명성(`AIK_pub` 변경의 로그 기록·포함 증명)은 Phase 3 후보다.

## 2. 암호 스위트

| 용도 | 선택 |
|---|---|
| 핸드셰이크·전송 | Noise(X25519, ChaCha20-Poly1305, BLAKE2b). 페어링 `Noise_XXpsk0`, 상시 세션 `Noise_IK`. Noise 내부는 **카운터 논스만** |
| 비동기 봉투 | HPKE Base(RFC 9180, X25519-HKDF-SHA256, ChaCha20-Poly1305) + Ed25519 서명. 와이어 형식은 [schemas/intent-envelope.schema.json](schemas/intent-envelope.schema.json) |
| 파일·DEK 래핑·로컬 저장 | XChaCha20-Poly1305(랜덤 24B 논스). Noise 밖에서만 |
| 서명 | Ed25519(소프트웨어 키, 래핑 저장). **비가역 원격 승인**은 Secure Enclave/StrongBox P-256 `Px`(추출 불가, 사용자 존재 필요)만 허용(C-06) |
| KDF | HKDF-SHA256, 컨텍스트 문자열로 도메인 분리 |
| 알고리즘 식별자 | Noise 프로토콜 이름, `hello.suites[]`, 의도 봉투 바깥 `v`, 블롭 `header.alg`가 스위트를 지정한다. 양자 내성 하이브리드(X-Wing: ML-KEM-768 + X25519)로의 전환 경로를 이 식별자 위에 예약한다(C-34, 별도 ADR에서 결정) |
| 라이브러리 | 데스크톱 `sodium-native` + Noise 구현(`noise-handshake` 계열), 모바일은 `@noble/*`(react-native-libsodium은 secretstream·raw X25519·Argon2가 빠져 프로토콜 계층에 부적합) |

### 2.1 서명·MAC 용도 컨텍스트 (C-33)

모든 서명·MAC 입력은 아래 컨텍스트 문자열로 시작하고 `pair_id`·방향(`from/to`)을 포함한다(해당 시). 키 하나가 두 용도의 서명을 만들 수 없게 검증기는 컨텍스트를 고정 비교한다. 데스크톱 측 연산은 금고가 이 표를 허용 목록으로 집행한다(§3 규칙).

| 컨텍스트 | 서명 키 | 대상 |
|---|---|---|
| `SAX-approve-v1` | `Vm`(가역) 또는 `Px`(비가역 필수) | `gate.response` (§6) |
| `SAX-consent-v1` | `Vm`/`Px`, 로컬은 `Vd` | `consent.response`, `schedules.consent_json.deviceSig` (B-27). `gate.response` 검증기는 이 문맥을 절대 받지 않는다 |
| `SAX-env-v1` | `Vm` | 의도 봉투 안쪽 서명, HPKE info·aad 접두 (§7) |
| `SAX-qbundle-v1` | `Vd`/`Vm` | 우편함 번들 `{Qx, valid_from, valid_to, seq}` (§7) |
| `SAX-rotate-v1` | `Vx` | `rotate.static` (§5, C-18) |
| `SAX-ckpt-v1` | `Vd` | 감사 로그 체크포인트 (§10) |
| `SAX-devlist-v1` | AIK | `DeviceListEntry`·기기 목록 버전 (§4.1) |
| `SAX-revoke-v1` | AIK | 기기 폐기 레코드 (§9) |
| `SAX-cert-v1` | AIK | 기기 인증서 `Cert_X` (§4) |
| `SAX-aik-rotate-v1` | 옛 AIK | AIK 교체 공지 (§4.1) |
| `SAX-kek-v1` | AIK | `KekRecord{N, salt_N, created_at}` (§3) |
| `SAX-acct-op-v1` | AIK | 즉시 삭제·기기 추가 승인 등 계정 작업 (D09 §2) |
| `SAX-docrec-v1` | `Vd` | 메타데이터 레코드 (D07 §5) |
| `SAX-dpop-v1` | `Vx` | 기기 범위 토큰 요청 증명 (D09 §2) |
| `SAX-kv-v1` | `Vd` | 금고 비밀 봉인 키 `Kv_pub` 배포·연 1회 회전(`PAIR_OK`·`HELLO`, D05 §5) |
| `SAX-SAS-v1`, `SAX-pair-v1`, `SAX-session-v1` | — | SAS 유도, Noise prologue |

## 3. 키 계층

```text
RK(루트 키, 첫 데스크톱이 CSPRNG로 생성, 서버 미보관. ADR-020 결정 7로 복구 문구는 없다. 보관 방식은 미정, ADR-024 결정 6)
  RK ─ HKDF("aik")                  → AIK   Ed25519 계정 신원 키(기기 인증서·기기 목록·폐기·계정 작업 서명)
                                             데스크톱 전용. Windows Hello/Touch ID 결박 래핑 키로 암호화 저장,
                                             사용할 때마다 사용자 존재 확인(C-22, Phase 2. Phase 1은 무인 저장을 잔여 위험으로 둔다, D05 §2).
                                             무인 데몬은 AIK를 쓰지 않는다
     ─ HKDF("kek/blob/vN" ‖ salt_N) → KEK_N 파일별 DEK 래핑 키. salt_N = PC CSPRNG 32B, AIK 서명 KekRecord에 기록(C-07)
     ─ HKDF("idx/hmac/v1")          → K_idx 업무 키 표시 HMAC  = HMAC(K_idx, "SAX-bizkey-v1" ‖ businessKey)[:16] (B-30, Phase 2·데스크톱 2대 계정)
                                            프로필 사업자 HMAC = HMAC(K_idx, "SAX-bizno-v1"  ‖ bizNo)[:16]       (B-28, Phase 1부터)
                                            계정의 모든 데스크톱이 같은 K_idx를 쓴다. 새 PC는 A-03에서 켜져 있는 기존 데스크톱이 넘긴다(ADR-024 결정 4)
                                            서버 dedup 토큰에는 쓰지 않는다(C-13). RK 교체 시 재계산·재등록
     ─ HKDF("key-check")            → K_chk 문구 확인 센티넬: AEAD(K_chk, "SAX-RK-OK")를 서버 계정 레코드에 둔다(C-21)
     ─ HKDF("audit")                → K_audit 감사 로그 체크포인트 MAC(폰과 공유)
  (K_meta는 v1.3에서 삭제. 메타데이터 레코드 무결성은 Sign_Vd, D07 §5)
기기별 랜덤 키(RK와 무관, 기기 밖으로 안 나감)
  Sx X25519 정적키(Noise) · Vx Ed25519 서명키(가역 승인·체크포인트·봉투) · Qx X25519 inbox 키(HPKE, 7일 로테이션 [제안])
  Lx 로컬 래핑 키 · Px(모바일) SE/StrongBox P-256 비가역 승인 키(없으면 비가역 원격 승인 불가)
  Kv(데스크톱 금고 전용 X25519, 비밀 봉인 수신용, Vd로 서명해 배포, 연 1회 회전) · Km(모바일 전용 X25519, 비밀 봉인 발신 인증용)
파일별  DEK_f(랜덤 256비트) ── XChaCha20-Poly1305 ──▶ wDEK_f(KEK_N으로 래핑)
```

규칙:
- 모바일은 RK·AIK 개인키·`K_idx`를 갖지 않는다. 받는 것은 `K_audit`과, 사용자가 별도 단계에서 허용했을 때의 `KEK_N`(§4 8단계)뿐이다. 폰은 문서를 열 때 **그 문서의 wDEK만** 받아 쓰고 대량 동기화하지 않는다(C-07).
- 서버·릴레이는 RK 파생 키를 하나도 갖지 않는다. `K_chk` 센티넬은 오타 검출용이며 128비트 문구라 오프라인 대입 이득이 없다.
- **RK 보관 방식은 열린 문제다**(ADR-024 결정 6). 원래 규칙은 "RK는 상주시키지 않고 파생 키만 저장하며, 필요하면 복구 문구로 재생성한다"였다. ADR-020 결정 7로 문구가 없어져 이 규칙은 성립하지 않는다. RK를 버리면 KEK 회전(`KEK_{N+1}`, §9.2)과 새 PC로 RK를 넘기는 일을 할 수 없다. RK를 키체인에 두면 키체인을 가져간 쪽이 AIK를 다시 만들 수 있어, AIK의 Hello 결박(C-22)과 KEK 회전이 키체인 탈취에 대해 갖는 의미가 약해진다. Phase 1에서 첫 데스크톱이 RK를 만드는 구현보다 먼저 정한다(D15 F-11, SP-5). 새 PC로 RK를 넘길지 파생 키(`K_idx`·`KEK_N` 등)만 넘길지는 새 PC 연결(08 A-03)에서 정한다.
- **데스크톱 장기 키(`Sd`·`Vd`·`Q_D`·`Kv`·AIK) 연산은 금고 안에서만 한다**(C-19). 엔진의 `net/egress`는 암호문 전송만 하고 개인키를 받지 않는다. 금고 인터페이스 확장(`VaultCrypto`: DH·서명·HPKE 개봉, 용도 허용 목록 = §2.1, 호출 감사)은 D05 §5.1이 정의한다. 침해된 엔진이 금고에 연산을 요청할 수 있다는 오라클 한계는 D05 §1의 정직한 범위에 적는다.
- 계정 인증(이메일 코드·패스키)과 암호 키는 완전히 분리한다. 비밀번호에서 키를 만들지 않는다. 키마다 용도가 하나다(Noise·HPKE·봉인·서명 키를 겸용하지 않는다).
- KEK 버전의 `salt_N`은 버전 간 분리가 목적이다. `KekRecord`가 서버에 있으므로 RK 유출을 막지 못하며, RK 유출 대응은 여전히 RK 교체(§9.4)다.

> 복구 문구에 기대는 남은 서술(ADR-024 결정 6 후속): 위 `K_chk` 센티넬, §9.4~§9.7의 문구 발급·문구 복구·문구 분실 절차는 ADR-016의 원래 경로다. ADR-020 결정 7(새 PC는 폰 승인, 폰을 쓸 수 없으면 PASS)에 맞춘 새 PC 연결(08 A-03)과 F-11을 설계할 때 함께 고친다. Phase 1에는 두 번째 PC가 RK·`K_idx`·AIK 인증서를 받는 경로가 없다.

### 3.1 모바일 저장 규칙 (C-05, 스파이크 SP-1)

| 대상 | 규칙 |
|---|---|
| 키·토큰(`Sm`·`Vm`·`Km`·`Qm`·`Lm`·`KEK_N`·`K_audit`·우편함 토큰·기기 범위 토큰) | iOS Keychain `kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly`(Expo `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`) + `requireAuthentication`. Android Keystore 사용자 인증 필수 키로 래핑, StrongBox 있으면 우선 |
| SE/StrongBox 안에 두는 것 | `Px`(P-256)만. X25519·Ed25519 키는 SE/StrongBox가 보호하는 래핑 키로 암호화해 저장한다(키 자체는 SE에 들어가지 않는다) |
| 래핑 키 링·캐시 DB·복호 캐시 | iOS `NSURLIsExcludedFromBackupKey`, Android `android:allowBackup="false"` + `dataExtractionRules`로 클라우드 백업과 기기 간 이전 **모두** 제외 |
| 복호된 PDF | 앱 뷰어 메모리에서만. 디스크 캐시 금지 |
| 재설치 | 첫 실행 표식이 없는데 Keychain 항목이 남아 있으면 모두 삭제하고 재페어링을 요구한다 |
| 기기 증명 | 등록 시 App Attest(iOS)·Play Integrity(Android)를 서버가 확인한다. 변조 앱·에뮬레이터를 줄이는 **신호**이며 경계가 아니다. `Px`의 하드웨어 생성 증명은 §6.1 |
| 앱 잠금 | 앱 진입 시 생체 인증, 백그라운드 30초 후 재잠금(C-06) |

통과 기준(SP-1): iCloud 암호화 백업을 다른 iPhone에 복원했을 때 키·키 링 0개, Android 백업·기기 이전 후 키 0개. Expo SecureStore 기본 접근성은 `WHEN_UNLOCKED`로 알려져 있어(확인 필요, SP-1) 명시 설정이 필수다.

## 4. 페어링 (Noise_XXpsk0, 광학 채널 + AIK 서명 기기 목록 + 6자리 코드)

### 4.1 계정 신원과 기기 목록 (C-01·C-20, ADR-016)

- 계정 기기 목록의 모든 항목은 AIK가 서명한 `DeviceListEntry{device_id, role, Sx, Vx, registered_at, list_version}`이다(`SAX-devlist-v1`). 폰과 PC는 **AIK 서명이 없거나 `list_version`이 이미 본 값보다 낮은 목록을 거부**한다.
- 계정의 `AIK_pub`는 첫 데스크톱 설치 때 **1회 등록해 고정**한다. 교체는 옛 AIK 서명(`SAX-aik-rotate-v1`) + **7일 공지 지연**(`pairing.aikChangeDelayDays = 7`, 기준 시각은 서명 안의 시각이 아니라 **서버 수신 시각**이며 클라이언트는 자기가 처음 관측한 시각과 비교해 늦은 쪽을 쓴다, E-11) + 모든 기기·이메일 알림으로만 한다. 지연 중 다른 교체 요청이나 기존 기기의 거부가 생기면 교체를 멈추고 계정 복구 지원 절차(D11 §7)로 넘긴다.
- 폰은 페어링 때 **서버가 준 계정 `AIK_pub`와 `PAIR_OK`의 `AIK_pub`가 같을 때만** 진행한다. 다르면 중단하고 기존 기기·이메일에 알린다. 이 대조는 서버와 PC가 같은 가짜 값을 주는 공모를 막지 못한다. 새 폰의 첫 페어링마다 이 TOFU 창이 있다(§1, E-12).
- 기기 인증서 `Cert_X.not_after = 발급 + 90일`, PC 온라인 시 자동 갱신한다. 폰은 30일 넘게 기기 목록 갱신이 없으면 경고한다.
- `pairing.newDesktopWarnHours = 24`, `pairing.aikChangeDelayDays = 7`은 앱 내장 상수다. 서명 정책으로 완화할 수 없다. 큐 상수 `queue.*`와 원격 승인 상수 `remote.*`는 policy.schema에 있으며 앱 내장 상한보다 엄격하게만 바꿀 수 있다.

### 4.2 절차

QR 페이로드(바이너리, URL 아님): `SAXP|v1 | intent | 릴레이 호스트 | room_id(16B) | Sd(32B) | ps(32B, 1회용 PSK) | exp(기본 120초)`.

1. [PC] "기기 추가" → OS 사용자 존재 확인(Windows Hello/Touch ID) → `room_id`·`ps`·`exp` 생성 → 클라우드 API에서 1회용 룸 발급(정원 2, TTL 120초, 룸 레코드에 계정 ID 없음, 계정당 시간당 5회 [제안]). QR·SAS 입력 창은 `setContentProtection(true)`로 화면 캡처·원격 공유에서 가린다.
2. [PC] QR 표시, 룸에서 응답자로 대기.
3. [폰] 앱 내부 스캐너로만 스캔. 검사: `exp` 미경과, 릴레이 호스트 허용 목록, 서버에서 받은 기기 목록의 **모든 항목이 계정 `AIK_pub`로 서명되어 있고** `Sd`가 role=desktop 항목에 있음(없으면 중단). 해당 항목의 `registered_at`이 **24시간 이내**면 전면 경고("이 PC는 오늘 등록되었습니다. 직접 등록한 PC가 아니면 중단하세요")를 띄우고 기존 기기·이메일에 알린다(`pairing.newDesktopWarnHours = 24`).
4. [폰→PC] `Noise_XXpsk0_25519_ChaChaPoly_BLAKE2b`, 개시자 폰, `psk=ps`, prologue=`"SAX-pair-v1"‖room_id‖릴레이‖exp`. msg2에서 폰은 `rs == Sd` 확인. msg3 페이로드: 기기 이름·플랫폼·`Vm`·`Km`·`Px_pub`(있으면). 푸시 토큰은 보내지 않는다(깨우기는 서버 경로, §8.1).
5. [양쪽] 핸드셰이크 해시 `h`로 `SAS = HKDF(h,"SAX-SAS-v1") mod 10^6`. 폰이 6자리를 표시하고 **바로 옆에** 경고를 둔다: "이 숫자는 지금 내 앞의 PC 화면에만 입력하세요. 웹페이지·전화·문자로 이 숫자를 요구하면 입력하지 마세요"(C-01).
6. [PC] 사용자가 **폰의 6자리를 PC에 입력**("일치" 버튼 금지). 3회 실패·TTL 경과 시 룸 폐기. 동시에 PC는 폰의 `Sm`이 폰이 계정에 등록한 기기 키 목록에 있는지 확인한다(QR 유출 공격자 차단용. 이 목록은 아직 AIK 서명 전이므로 신뢰 앵커가 아니다).
7. [PC] AIK(사용자 존재 확인)로 `Cert_M = Sign_AIK("SAX-cert-v1"‖{device_id, Sm, Vm, Km, Px_pub?, role, not_after})`와 폰의 새 `DeviceListEntry`(`list_version + 1`)를 서명해 서버에 올린다. 수립된 Noise 채널 안에서 `PAIR_OK{Cert_M, AIK_pub, Kv_pub(Vd 서명, `SAX-kv-v1`), 서명된 기기 목록, mbx_id, tok_read, tok_write, mbx_epoch}`를 보낸다. **`mbx_id`·`tok_read`·`tok_write`는 PC가 CSPRNG로 만든 32B 난수**이며 핸드셰이크 해시 `h`에서 파생하지 않는다. `h`는 SAS와 채널 바인딩에만 쓴다(C-16). `PAIR_OK`에는 `KEK_N`을 넣지 않는다.
8. [PC·폰] **서류 열람 허용(별도 단계)**: 페어링 마지막 화면에서 "이 폰에서 서류 열람 허용"을 물어, 사용자가 허용하면 PC가 다시 Hello 확인을 받고 라이브 세션 안에서 `kek.grant{KEK_N, kek_ver, KekRecord}`를 보낸다(C-01, REVIEW-B C-7). 허용하지 않은 폰은 조회·승인만 한다.
9. [양쪽] `ps`·임시키·룸 폐기. 폰은 §3.1 규칙대로 키를 저장하고, 기기 범위 토큰으로 서버에 푸시 토큰을 등록한다(§8.1).

QR을 스캔할 수 없을 때: 8~9개 BIP39 단어(88~99비트)를 `ps`로 직접 입력(Keybase KEX 방식). 폰은 `Sd`를 AIK 서명 목록에서 고르되, 데스크톱 항목이 둘이면 PC 화면에 표시된 기기 이름과 대조하게 한다. 3단계의 24시간 경고는 그대로 적용한다. 새 프리미티브(PAKE)는 추가하지 않는다.

20비트 SAS가 충분한 이유는 폰이 QR로 PC를 인증하므로 브리징 MITM이 성립하지 않기 때문이다 `[검토]`. SAS는 "공격자 PC로 사용자를 유도하는 원격 피싱"을 막지 못한다. 그 경로는 AIK 서명 기기 목록(계정 탈취자는 목록에 서명할 수 없음)과 24시간 경고·폰 화면 경고로 막는다(C-01).

## 5. 상시 세션과 키 교체

1. 폰이 WSS 연결 후 우편함 토큰 제시. PC 온라인이면 릴레이가 두 소켓을 잇는다.
2. `Noise_IK`, 개시자 폰, prologue=`"SAX-session-v1"‖pair_id`. **msg1 페이로드는 단조 타임스탬프 8바이트뿐**(명령 없음). PC는 `Sm` 미폐기 여부와 타임스탬프 단조성을 확인하고 아니면 **무응답으로 버린다**(오라클 방지). 타임스탬프 최고값은 pair별로 디스크에 영속한다(`remote_pair_state`, C-33).
3. 전송 키 수립 후 `hello{protocol, suites, deviceListVersion, asyncSeqMax, registryHeadHash, capabilities}`.
   - `deviceListVersion`이 서로 다르면 양쪽은 더 높은 버전의 AIK 서명 목록을 상대에게 요청(`devlist.push`)해 검증·적용하기 전까지 **비가역 승인과 비밀 요청을 처리하지 않는다**(C-20).
   - `registryHeadHash`(플레이북 레지스트리 투명성 로그의 본 헤드 해시, D09 §8)가 서로 다르면 양쪽 모두 경고를 띄우고 더 큰 트리 크기 쪽의 일관성 증명을 받을 때까지 새 패키지·정책 적용을 보류한다(C-26 split-view 상호 확인).
   - `protocol`이 정책 `remote.minProtocolVersion`보다 낮으면 세션을 닫고 업데이트를 안내한다(§9.8).
4. 키 교체: 연결마다 새 핸드셰이크(전방 비밀성). 연결 중 `Rekey()`는 시간 기준이 아니라 **`ctr`가 2^20의 배수가 될 때 양쪽이 결정적으로** 한다(전송 중 메시지 복호 실패 방지, C-33).
5. 정적키 교체(`rotate.static`, C-18): 폰의 정적키 교체는 **PC가 새 `Cert_M`을 AIK로 재발급할 때만** 유효하다. PC 화면의 사용자 확인(Hello) 또는 폰 생체 확인 뒤에만 적용하고 모든 기기에 알린다. 서명 입력은 `"SAX-rotate-v1"‖pair_id‖from‖old_static‖new_static‖ts`. PC 정적키 교체는 폰에서 생체 확인 뒤 핀을 갱신한다. 주기는 연 1회 또는 의심 시.
6. 상태 영속: pair별 `{ik_ts_max, async_seq_max, seq 비트맵, 처리한 cmdId, mbx_epoch, qbundle_seq_max}`를 디스크에 영속한다(D07 `remote_pair_state`·`remote_cmd_seen`). 폰 재설치·재페어링 시 `mbx_epoch`을 올리고 이전 상태는 버린다.
7. 종료는 인증된 `close`.

## 6. 메시지 프레이밍

```text
outer = ver(1B) ‖ kind(1B: HS/DATA/ENV) ‖ ctr(8B, DATA만) ‖ len(2B)
DATA  = outer ‖ ChaCha20-Poly1305(k_tx, nonce=0^32‖LE64(ctr), ad=outer, pt=pad(inner))
inner = 결정적 CBOR {t, id: ULID, seq, ts, ttl, body}
pad   = ISO/IEC 7816-4, 버킷 {256, 512, 1K, 4K, 16K, 64K−오버헤드}
```

- 수신 측은 `ctr` 슬라이딩 윈도(1024)로 중복·역전을 거른다. Noise 전송 한도 65,535B. **PDF·이미지는 릴레이로 보내지 않고** 블롭 저장소에 올린 뒤 `blob_id`와 래핑 DEK만 보낸다(캡차 크롭 ≤ 200KB는 예외적으로 인라인 허용, 버킷 패딩).
- 서명·MAC 입력에는 항상 §2.1의 컨텍스트 문자열, `pair_id`, 방향(`from/to`)을 포함한다(반사 공격 무효).
- `inner.ttl`(≤ 86,400초)은 **라이브 메시지 전용**이다. 오프라인 의도의 만료는 의도 봉투 안쪽 `exp`(≤ 72시간)가 정하며 별도 스키마를 쓴다(C/X-14 해소, §7).
- 오류 코드(`sas_mismatch`·`replay_detected`·`envelope_rejected` 등, D16)는 **로컬 UI 전용**이며 프로토콜로 송신하지 않는다(C/X-12).

메시지 타입(스키마: [schemas/remote-envelope.schema.json](schemas/remote-envelope.schema.json)):

| type | 방향 | body | 비고 |
|---|---|---|---|
| `hello` | 양방향 | `{appVersion, protocol, suites[], deviceListVersion, asyncSeqMax, registryHeadHash, capabilities[]}` | 세션 시작. 불일치 처리는 §5 |
| `pair.ok` | PC→폰 | `{cert, aikPub, kvPub, kvSig, deviceList, mbxId, tokRead, tokWrite, mbxEpoch}` | 페어링 7단계 전용 |
| `kek.grant` | PC→폰 | `{kek, kekVer, kekRecord}` | 페어링 8단계(별도 Hello 확인 후). 라이브 세션 전용 |
| `devlist.push` | 양방향 | `{deviceList}`(`listVersion`은 `deviceList` 안) | AIK 서명 목록 동기화(C-20) |
| `mbx.reissue` | PC→폰 | `{mbxId, tokRead, tokWrite, mbxEpoch}` | 우편함 토큰 재발급. CSPRNG 난수, 라이브 세션 안에서만(C-16) |
| `cmd.run` / `cmd.abort` / `cmd.resume` | 폰→PC | `{cmdId(ULID = intentId), playbookId, inputs}` / `{runId}` | 엔진 화이트리스트·입력 스키마 검증. **라이브 `cmd.run`도 처리된 `cmdId` 집합(디스크 영속)과 대조**해 이미 본 값이면 버린다(B-10). 큐에서 온 명령은 실행이 아니라 시작 게이트(§7) |
| `run.event` | PC→폰 | D03 §9 이벤트 사용자용 서브셋 | 값 없음 |
| `gate.request` | PC→폰 | `{runId, stepId, reqId, cardId, gateKind, effects[](필수, 시작 게이트는 빈 배열 가능), fields[{key: fieldKey, value}], cardHashInputs, actionHash, requiredSigAlg, challenge(32B), exp(120s), queuedAt?}` | 카드 필드는 **readback 값**이고 라벨은 `fieldKey`로 앱이 내장 사전에서 렌더링한다(B-24·B-29). 폰은 표시한 `fields`로 `cardHash`를 직접 계산하고 `cardHashInputs`와 함께 `actionHash`(D03 §3)를 다시 계산해 **일치할 때만** 승인 버튼을 활성화한다 |
| `gate.response` | 폰→PC | `{runId, stepId, reqId, decision, actionHash, sigAlg, sig = Sign("SAX-approve-v1"‖pair_id‖reqId‖challenge‖actionHash‖decision)}` | 생체 인증 후 서명. 비가역 카드(`requiredSigAlg = p256`)는 `sigAlg = p256`(`Px`)만 받는다. PC가 챌린지·exp·서명·actionHash·`gate_requests` 단일 사용을 검증 → gateToken 발급 |
| `consent.request` | PC→폰 | `{reqId, scheduleId, playbookId, major, effects[], docType, profileRef, mode, challenge, exp}` | 데몬 스케줄 동의(B-27) |
| `consent.response` | 폰→PC | `{reqId, decision, consentHash, sigAlg, sig = Sign("SAX-consent-v1"‖pair_id‖reqId‖challenge‖consentHash‖decision)}` | `gate.response`와 문맥 분리. 결과는 `schedules.consent_json.deviceSig` |
| `human.request` | PC→폰 | `{runId, stepId, reqId, kind, prompt, imageChunks?, imageSha256?(captcha 필수), ttl, vaultChallenge?, origin?, secretKind?}` | `secret`은 이미지 없음·`vaultChallenge` 필수. 캡차 이미지는 ≤ 200KB를 16KB 청크로 나눠 보낸다(Noise 프레임 상한 65,535B) |
| `human.response` | 폰→PC | `{runId, stepId, reqId, value}` 또는 `{runId, stepId, reqId, sealed}` | 비밀은 `sealed`만: 폰 `Km`으로 인증 봉인(HPKE Auth 또는 `crypto_box`)해 `Kv`로 보내고 AAD = `{pair_id, runId, stepId, reqId, vaultChallenge, exp, origin, secretKind}`. `vaultChallenge`는 금고가 `human.request`에 실어 보낸 1회용 값. 라이브 세션 전용 |
| `file.offer` | PC→폰 | `{docId(UUIDv4), docType, bytes, blobId, wDEK, kekVer}` | 본문은 블롭 경유. 문서 단위 wDEK 1개만 |
| `query.documents` / `query.result` | 폰→PC / PC→폰 | 보관함 조회 | |
| `rotate.static` / `close` / `ping` / `pong` | | `rotate.static{oldStatic, newStatic, ts, sig}` | §5 |

### 6.1 원격 비가역 승인 규칙 (C-06, ADR-016, 스파이크 SP-2)

- 비가역 효과(`issue_document`·`send`·`sign`, 그리고 `pay`)의 원격 승인은 **SE/StrongBox P-256 키 `Px`(사용자 존재 필요)로만** 한다. `gate.request.effects`는 필수이고, 비가역 효과가 하나라도 있으면 스키마가 `requiredSigAlg = p256`을 강제한다(E-10). PC는 `ed25519` 응답을 거부한다. `requiredSigAlg`는 엔진이 `authorizes`의 `commitEffect`로 계산하는 앱 상수 규칙이며 정책으로 끌 수 없다.
- **`Px` 하드웨어 생성 검증**(E-10): Android는 폰 등록 시 **Key Attestation 인증서 체인**(`securityLevel` = StrongBox 또는 TEE, `userAuthenticationRequired`)을 서버 경유로 받아 PC가 검증하고, 검증하지 못한 기기는 비가역 원격 승인을 받지 않는다. iOS는 App Attest로 **앱 무결성만** 확인할 수 있고 Secure Enclave 키 생성 자체를 증명하는 수단은 없다. iOS의 "하드웨어 키"는 정직한 앱을 전제로 한 약속이다(잔여 위험, ADR-016).
- 하드웨어 키가 없는(또는 검증되지 않은) 폰은 **조회·캡차·시작 동의**만 하고, 비가역 승인은 PC 로컬에서만 한다. 이때 PC의 main 승인 바(ADR-021)는 **자동으로 뜨지 않는다**. 실행은 "PC에서 승인 필요" 상태로 대기하고, 폰에는 시작 시점에 "PC 앞에서 승인해야 합니다"를 알리며, 사용자가 PC에서 그 작업 카드를 열면 바가 뜬다(무인 PC의 제3자 승인 방지, E-06, D03 §3). `trigger=local`이 아닌 실행(원격·데몬)의 게이트도 PC 바를 자동으로 띄우지 않는다. 폰이 먼저 결정하면 PC 바는 "폰에서 이미 승인했어요"를 2초 보인 뒤 내려간다.
- 정책 `remote` 블록(스키마는 policy.schema)의 의미:
  - `remote.irreversiblePerDay`(기본 5): 원격 승인으로 일어난 비가역 행위의 KST 일일 상한. 넘으면 그날은 로컬 승인만.
  - `remote.newCounterpartyRequiresLocal`(기본 true): 처음 쓰는 거래처·이메일 수신자(원장 `irreversible_log`의 `committed` 행에 그 사업자번호·이메일 HMAC이 없는 것, ADR-021. 렌더러가 고칠 수 있는 `counterparties.local_approved_at`은 쓰지 않는다)는 원격 승인 불가.
  - `remote.notifyOnIrreversible`(기본 `["desktop","email"]`): 원격 승인으로 비가역 행위가 일어나면 PC 화면 알림과 계정 이메일로 알린다.
  - 정책은 이 값들을 **더 엄격하게만** 바꿀 수 있다(앱 내장 하한).
- 폰 분실·PC 꺼짐 상황의 긴급 정지는 계정 웹의 '기기 긴급 정지'(§9.3)다.
- SP-2: 국내 대상 기기의 SE/StrongBox P-256 커버리지(특히 중저가 Android의 StrongBox 유무, TEE 대체 허용 여부)를 측정해 90% 미만이면 미지원 기기 UX를 확정한다.

## 7. 오프라인 큐(의도 봉투) (C-17·C-34, C/X-14)

- 큐에는 **비밀과 캡차 답을 넣지 않는다.** "PC 켜지면 실행" 같은 의도만. 와이어 형식은 [schemas/intent-envelope.schema.json](schemas/intent-envelope.schema.json)이 정본이다.
- 우편함 번들: 각 기기는 `Qx`를 7일마다 갱신하고 `{Qx, valid_from, valid_to, seq}`를 `Vx`로 서명(`SAX-qbundle-v1`)해 우편함 번들 슬롯에 게시. 개인키는 `valid_to`+큐 TTL 뒤 삭제(전방 비밀성 창 ≈ 10일 [제안]). 폰은 번들 `seq` 최고값을 저장해 더 낮은 번들을 거부하고, **`valid_to`가 지난 `Q_D`로는 봉인하지 않는다**("PC가 오래 꺼져 있어 예약할 수 없습니다" 표시).
- 폰: `Intent{pair_id, from, to, seq, iat, exp, cmd_id, playbookId, playbookMajor, inputs, intent_hash, qbundle_seq}` → `Sign_Vm("SAX-env-v1"‖canonical(Intent))` → HPKE 봉인(`pkR=Q_D`, info `"SAX-env-v1"`, aad `"SAX-env-v1"‖mbx_epoch`) → 우편함.
  - 바깥(릴레이가 보는 것)은 `{v, kind:"ENV", enc, ct}`뿐이다. `pair_id`·`seq`·`exp`는 HPKE 평문 **안**에 있다.
  - `inputs`는 해당 플레이북 입력 스키마를 따르며 `x-secret: true` 필드는 넣을 수 없고 문자열은 200자 이하다. 거래처는 식별값(사업자번호·이메일) 대신 **로컬 거래처 ID 참조**(`counterpartyRef`)를 우선 쓴다(C-34).
  - `intent_hash = SHA-256(CBOR{cmd_id, playbookId, playbookMajor, inputs})`. 실행 시 게이트의 `actionHash`(readback 기반)와 **다른 값**이다(v1.2의 `action_hash`를 개명).
  - `exp ≤ iat + queue.ttlHours`(72시간).
- 큐 상한: `queue.maxIntentsPerPair = 5`(v1.2의 50에서 축소), `queue.ttlHours = 72`.
- PC 부팅 → IK 세션 → 드레인: 개봉 실패는 조용히 폐기, 서명·`exp`·`seq` 윈도·`cmd_id` 미처리·화이트리스트·입력 스키마 검사. 통과한 의도들은 **카드 1장으로 묶어** 보여 준다.
- **2단계 게이트**: 드레인한 의도는 먼저 **시작 게이트**(`gateKind = start`, 새 챌린지, 카드에 `queuedAt`과 "N시간 전 요청" 표시)를 통과해야 실행을 시작한다. 시작 전에는 로그인·화면 조작도 하지 않는다. 비가역 단계에서는 다시 **커밋 게이트**(`gateKind = commit`, readback 카드, §6.1 규칙)를 받는다(D10 `semi_auto`와 같은 구조).
- `ACK{seq}` 후 서버가 삭제. 수신 상태(`max_seq`, 비트맵, 처리 `cmd_id`)는 디스크 영속.
- 실패는 모두 무응답·정상 처리와 시간 차 최소화, 오류 코드 없음. 우편함당 실패 상한 후 연결 종료.

## 8. 릴레이(내용을 볼 수 없는 우편함)

- WSS. 우편함 = 32B CSPRNG ID + 능력 토큰(`tok_read`/`tok_write`, 32B CSPRNG, 서버는 해시만 저장, §4.2 7단계). 기기 인증 토큰은 별도 레이어(남용 방지용, 우편함 ID와 조인되지 않게 분리 저장).
- **정직한 서술(C-14)**: 릴레이는 내용과 키를 볼 수 없다. 계정과 우편함의 연결은 분리 저장·접근 통제·짧은 보존으로 줄이지만, 운영자는 연결 시점·IP 상관으로 언제든 연결할 수 있다. '영지식'이라고 부르지 않는다.
- 접속 IP: 평문 저장 대신 **일 단위 회전 솔트 HMAC**으로만 레이트리밋에 쓴다(솔트는 하루 뒤 폐기). 평문 IP는 법정 접속기록 대상인 운영자 접근 로그에만 둔다(보존은 D09 §10).
- 한도(이 절이 정본, D09 §4는 참조만, C/X-03): 우편함당 초당 메시지 20, 기기당 우편함 3, 연결당 실패 상한, 프레임 ≤ 65,535B, 큐는 우편함당 의도 봉투 `queue.maxIntentsPerPair`(5)건·1MiB·72시간. 길이 패딩 버킷으로 크기 유출 완화.
- 보존(C/X-02): 큐 본문 72시간, 메시지 크기 버킷·시각 메타데이터 7일.
- Phase 3 후보: 남용 방지용 기기 인증을 별도 연결·별도 엔드포인트의 비연결 토큰(Privacy Pass 계열)으로 바꾼다(SP-10).

### 8.1 깨우기 푸시 (C-15, C/X-04, 스파이크 SP-3)

- 깨우기는 릴레이가 아니라 **PC가 기기 범위 토큰으로 `POST /v1/wake{device_id}`**를 호출하는 경로다. 서버(푸시 디스패처)는 `device_id → 암호화된 푸시 토큰`(별도 키)만 가지며, **우편함 ID는 이 경로에 없다.** 다만 운영자는 깨우기 시각과 우편함 접속 시각으로 둘을 상관시킬 수 있다.
- 푸시는 **내용 없는 깨우기 + fetch**: iOS는 알림 푸시(+Notification Service Extension), Android는 FCM data 메시지. 무음 푸시에 의존하지 않는다. 승인·캡차 알림은 "알림 푸시 → 탭 → IK 핸드셰이크" 순서로 10초 핸드오프를 맞춘다(지연은 S-1·SP-3에서 측정).
- Apple(APNs, Apple Inc., 미국)·Google(FCM, Google LLC, 미국)은 깨우기 시각과 일반 알림 문구를 본다. 처리방침에 수탁·국외이전으로 기재한다.
- 속도 제한: 기기당 분당 3회, 시간당 20회. 기기 폐기·긴급 정지 시 푸시 토큰을 **즉시 삭제**한다.

### 8.2 릴레이·푸시 경로에서 운영자가 보는 것

| 본다 | 결합으로 알 수 있다 | 못 본다 |
|---|---|---|
| 우편함 ID, 메시지 수·크기 버킷·시각, 바깥 `kind`(HS/DATA/ENV), 데스크톱 온라인 여부, IP의 일 회전 HMAC, 페어링 룸 발급 시각, `device_id`별 깨우기 시각 | 연결 시점·IP·깨우기 상관으로 계정↔우편함↔대략적 위치, 근무 패턴, 승인·캡차 빈도 | Noise·HPKE 평문(명령·비밀·캡차·서류·의도 내용), 키, 의도 봉투의 `pair_id`·`seq`·`exp` |

## 9. 기기 분실·폐기·복구·사고

### 9.1 KEK 회전의 한계 (C-07, C/X-15)

KEK 회전은 **아직 wDEK를 받지 않은 문서**에 대해서만 폐기 기기의 접근을 막는다. 폐기 전에 기기가 받은 wDEK의 문서는 블롭을 재암호화하지 않으면 계속 열 수 있다. 서버 쪽 방어는 기기 범위 토큰 무효화(접근 통제)다. 또 `KEK_{N+1}`도 같은 RK에서 나오므로 RK를 가진 사람에게 KEK 회전은 의미가 없다. 그래서 절차를 둘로 나눈다.

### 9.2 (a) 폰 분실

PC에서 기기 해제 → AIK 서명 폐기 레코드(`SAX-revoke-v1`)와 새 기기 목록(`list_version + 1`) 게시 → 해당 `Sm` 핸드셰이크 거부 → 서버에서 분실 폰의 **기기 범위 토큰·우편함 토큰·블롭/메타데이터 접근·푸시 토큰 즉시 무효화/삭제** → 남은 기기의 우편함 토큰 재발급(`mbx.reissue`) → 큐 드레인 시 폐기 목록 재검사 → KEK를 `N+1`(새 `salt_N+1`)로 회전해 재래핑 → **선택형 재암호화**(Phase 2: 최근 90일 또는 민감 doc_type부터, SP-11).

### 9.3 계정 웹 '기기 긴급 정지' (C-06)

PC에 갈 수 없을 때 계정 웹에서 '기기 긴급 정지'를 누르면 서버는 해당 기기의 블롭·메타데이터·조회 에이전트·릴레이 우편함·푸시 토큰·깨우기를 즉시 정지한다. 서버 측 임시 조치이며 AIK 서명 폐기 전까지 유효하다. 남용을 막기 위해 긴급 정지는 **정지만** 할 수 있고(삭제·기기 추가 불가), 재활성화는 AIK(PC)가 한다. 단 복구 보류(§9.5) 중에는 같은 문구에서 재생성한 AIK의 재활성화 서명도 서버가 받지 않는다. PC는 다음 기동 때 정지된 기기를 표시하고 폐기 또는 재활성화를 묻는다.

### 9.4 (b) 문구 유출·PC 도난

새 복구 문구 발급(RK′) → AIK′ 전환(§4.1 교체 규칙, 폰 승인) → 모든 기기 인증서 재발급 → **블롭 전체 재암호화 필수**(새 DEK, 새 `KEK′_1`. Phase 2, SP-11: 2GB 기준 1시간 이내·중단 후 재개) → 옛 wDEK·블롭 삭제. `K_idx` 파생값(업무 키 표시·프로필 사업자 HMAC)도 재계산해 재등록한다(재바인딩 횟수에 세지 않는다).

### 9.5 문구로 새 기기 복구 (C-21)

- 복구 문구 입력은 **앱 안에서만** 받는다. 웹 입력 칸을 만들지 않는다. 대외 문구: "소버린 AX는 어떤 경우에도 복구 문구를 묻지 않습니다."
- 입력 직후 `K_chk` 센티넬로 오타를 검출한다.
- 문구로 새 기기를 복구하면 (1) 모든 기존 기기와 이메일에 즉시 알리고 (2) **72시간** 동안 블롭 다운로드와, 그 문구에서 재생성한 AIK의 **모든 서명**(기기 추가·폐기·즉시 삭제·KEK 회전·긴급 정지 해제·AIK 교체)을 서버가 받지 않으며 (3) 기존 AIK 인증 기기(복구 이전에 등록된 기기)가 승인하면 즉시 해제한다. 기존 기기가 하나도 없으면 72시간 대기 후 진행한다. 보류는 서버(블롭·계정 작업)와 클라이언트가 함께 강제하며 앱 내장 값이다.
- **거부**(E-11): 보류 중 기존 AIK 인증 기기가 "내가 한 복구가 아님"을 누르면 서버는 (1) 그 복구 시도를 폐기하고 새 기기의 기기 키를 **영구 차단**하며, (2) 모든 기기·이메일에 알리고, (3) 사용자에게 **새 복구 문구(RK′) 발급 절차**(§9.4: RK′·AIK′ 전환, 전체 재암호화)를 안내한다. 거부 직후의 AIK′ 전환은 기존 기기 승인이 있으므로 §4.1의 7일 지연 없이 진행한다. 지원 절차는 AIK를 바꿀 수 없고 동결·새 계정 이전만 한다(D11 §7).
- **정직한 한계**: 복구 문구 = 계정 신원이므로 문구 보유자는 결국 AIK를 만들 수 있다. 기존 기기의 거부권과 알림이 유일한 방어이며, 기존 기기가 없거나 72시간 안에 거부하지 못하면 막지 못한다(D19 §8).
- Phase 2 후보: SLIP-39 2-of-3 문구 분산(D14 등록).

### 9.6 PC 분실

폰은 조회와 하드웨어 키 범위의 승인만 가능하다. 새 PC는 복구 문구로 RK를 재생성하고(§9.5 보류 적용) AIK로 새 기기 인증서를 발급한 뒤 폰과 재페어링한다(의도 `복구`). 도난 의심이면 §9.4로 간다.

### 9.7 복구 문구 분실

백업 복구 불가(서버 에스크로 없음). 온보딩에서 강하게 안내하고, 기존 기기 승인으로 KEK 공유 경로(§4.2 8단계)를 둔다.

### 9.8 사고 대응 연결과 프로토콜 킬스위치 (C-31)

시나리오별(계정 탈취·릴레이 침해·게이트웨이 침해·문구 유출·폰 분실 + PC 꺼짐·프로토콜 취약점) 탐지 신호·즉시 조치·사용자 통지·복구 표의 정본은 **D11 §7**이다. 이 문서의 대응 수단은 §9.2~§9.5, D09 §2(계정 세션 무효화·신규 기기 동결)다.

정책 `remote` 블록의 킬스위치(스키마는 policy.schema, 서명 배포로 즉시 적용):
- `remote.minProtocolVersion`: 이 값보다 낮은 `hello.protocol`의 세션을 닫고 업데이트를 안내한다. Noise·HPKE 라이브러리 결함 시 특정 프로토콜 버전을 끈다.
- `remote.disabledFeatures[]`: `queue`(의도 봉투), `remote_irreversible`(원격 비가역 승인), `secret_relay`(폰 비밀 전달), `captcha_relay`, `file_offer`, `query`, `pairing` 중 끌 기능의 목록.
- 킬스위치는 기능을 **끄기만** 할 수 있다. 정책으로 꺼진 기능을 켜는 방향의 변경은 일반 정책 서명 규칙(D09 §8)을 따르고, 1인 긴급 키로는 끄는 변경만 할 수 있다.

## 10. 감사 로그 앵커

- 로컬 감사 로그는 해시 체인. 체인만으로는 끝부분 절단을 못 막으므로, 하루 1회 `Checkpoint{seq, head_hash, ts}`를 `Vd`로 서명(`SAX-ckpt-v1`)하고 `K_audit` MAC을 붙여 폰에 보낸다. 폰은 최근 체크포인트를 보관해 PC 로그 변조·절단을 탐지한다.

## 11. 위협 대응 요약

| 위협 | 대응 |
|---|---|
| 릴레이 운영자(우리)·네트워크 도청 | Noise E2E, 의도 봉투 메타데이터도 HPKE 안, 패딩. 운영자의 연결 상관은 잔여 위험(§8) |
| 브리징 MITM | 폰이 QR의 `Sd`로 PC 인증, PSK, 6자리 코드 PC 입력 |
| 계정 탈취자·내부자의 원격 페어링 피싱 | AIK 서명 기기 목록, 계정 `AIK_pub` 고정·교체 7일 지연, `PAIR_OK` AIK 대조, 24시간 신규 데스크톱 경고, 폰 SAS 옆 경고, QR 창 캡처 차단. 새 폰 첫 페어링마다의 TOFU(서버 + 공격자 PC 공모)는 잔여 위험(§1) |
| QR 사진·어깨너머 | 룸 1회용·120초, 앱 내 스캐너만, 우편함 토큰은 `h`와 무관한 난수 |
| 핸드셰이크·메시지·봉투 재전송 | 연결마다 새 키, `ctr` 윈도, 영속 단조 타임스탬프, `seq`+`exp`+`cmd_id` 영속(라이브 포함), 큐는 시작 게이트 → 커밋 게이트 |
| 재전송 오라클 | 실패 무응답, 프로토콜 오류 코드 없음, 시간 차 최소화 |
| 폰 분실·탈옥 폰 | 비가역 원격 승인은 `Px`만(Android 키 증명 검증, iOS는 앱 무결성만), 원격 일일 상한·새 거래처 로컬 승인·알림, 앱 잠금, 계정 웹 긴급 정지, 기기 범위 토큰 즉시 무효화, KEK 회전 + 선택형 재암호화(§9.1 한계 명시) |
| 폰 백업 복원으로 복제 | ThisDeviceOnly·백업 제외·재설치 시 키 삭제(§3.1) |
| 탈취 키로 정상 폰 축출 | `rotate.static`은 AIK 인증서 재발급·사용자 확인·알림 필요 |
| 폐기 은닉(서버가 목록 갱신 숨김) | 인증서 90일, `deviceListVersion` 불일치 시 비가역·비밀 보류, 30일 미갱신 경고 |
| PC 분실·복구 문구 유출 | RK′·AIK′ + 전체 재암호화, 복구 72시간 보류·알림, `K_chk`, 앱 밖 문구 입력 없음 |
| 엔진 침해로 장기 키·비밀 탈취 | 장기 키 연산은 금고 안. 폰 비밀은 `Kv`로 인증 봉인 + 금고 챌린지 결속. 단 입력된 뒤 DOM 되읽기와 금고 연산 오라클은 막지 못한다(D05 §1의 범위) |
| 메타데이터 추론 | 패딩 버킷, 큐 5건 제한, 푸시 내용 없음, IP 일 회전 HMAC |
| 레지스트리 split-view | `hello.registryHeadHash` 상호 확인(D09 §8) |
| 미래 양자 해독(지금 저장, 나중에 해독) | 알고리즘 식별자와 X-Wing 전환 경로 예약, 의도에 로컬 거래처 참조 우선 |
| 로그 변조·절단 | 해시 체인 + 서명 체크포인트 폰 앵커 |

## 12. 스파이크

S-1 페어링·IK 지연(푸시 → 탭 → 핸드셰이크 포함) 실측 / S-2 Expo에서 `@noble/*` + SecureStore + 생체 바인딩 / S-3 iOS NSE 기반 깨우기 성공률 / S-4 블롭 v1 포맷·패딩 / S-5 SE P-256 승인 서명 / S-6 암호 전문가 리뷰(SAS 20비트, prologue, 도메인 분리).

감사 C에서 추가: SP-1 모바일 키 백업 제외·ThisDeviceOnly 검증(§3.1) / SP-2 SE·StrongBox P-256 커버리지(§6.1) / SP-3 `POST /v1/wake` 경로 지연·노출 필드(§8.1) / SP-5 S-6 범위 확대(우편함 토큰 난수화, 의도 봉투 와이어 형식, `rotate.static`, 기기 목록 서명·버전, 키 우선 삭제와 백업) / SP-10 Privacy Pass 계열 비연결 토큰(Phase 3) / SP-11 블롭 전체 재암호화 시간·대역폭(§9.4).
