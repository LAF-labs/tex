# D08. 리모트 컨트롤 프로토콜

> 근거: [research/R4-e2ee-security.md](../research/R4-e2ee-security.md). `[제안]`은 R4의 설계 제안이며 1차 출처로 확정되지 않은 수치, `[검토]`는 암호 전문가 리뷰가 필요한 분석이다.

## 1. 목표와 가정

- 릴레이 서버는 암호문·우편함 ID·크기·시각만 본다(TB-6). 키도, 계정과 우편함의 연관도 모른다.
- 데스크톱과 폰은 서로를 기기별 장기 키로 식별하고, 페어링 때 사람이 6자리 코드를 **PC에 입력**해 확인한다.
- 폰은 명령·승인·캡차 답·비밀을 보내고, 진행 이벤트·승인 카드·캡차 이미지·결과 파일을 받는다. **비밀은 라이브 세션에서만 오가고 큐에 들어가지 않는다.**
- 데스크톱이 꺼져 있으면 "의도(intent)"만 암호 봉투로 큐에 ≤ 72시간 대기하고, 켜진 뒤에도 실행이 아니라 **새 승인 요청**으로 바뀐다.

## 2. 암호 스위트

| 용도 | 선택 |
|---|---|
| 핸드셰이크·전송 | Noise(X25519, ChaCha20-Poly1305, BLAKE2b). 페어링 `Noise_XXpsk0`, 상시 세션 `Noise_IK`. Noise 내부는 **카운터 논스만** |
| 비동기 봉투 | HPKE Base(RFC 9180, X25519-HKDF-SHA256, ChaCha20-Poly1305) + Ed25519 서명 |
| 파일·DEK 래핑·로컬 저장 | XChaCha20-Poly1305(랜덤 24B 논스). Noise 밖에서만 |
| 서명 | Ed25519(소프트웨어). 모바일 승인 서명은 선택적으로 Secure Enclave/StrongBox P-256(추출 불가) |
| KDF | HKDF-SHA256, 컨텍스트 문자열로 도메인 분리 |
| 라이브러리 | 데스크톱 `sodium-native` + Noise 구현(`noise-handshake` 계열), 모바일은 `@noble/*`(react-native-libsodium은 secretstream·raw X25519·Argon2가 빠져 프로토콜 계층에 부적합) |

## 3. 키 계층

```text
복구 문구(BIP39 12단어, 128비트) ── HKDF("SAX-RK-v1") ──▶ RK(루트 키, 데스크톱 키체인, 서버 미보관)
  RK ─ HKDF("aik")        → AIK   Ed25519 계정 신원 키(기기 인증서·폐기 목록 서명)
     ─ HKDF("kek/blob/vN")→ KEK_N 파일별 DEK 래핑 키(모바일에도 전달, 생체 보호)
     ─ HKDF("idx/hmac")   → K_idx 메타데이터 dedup 태그 키(서버 비공개)
     ─ HKDF("meta/sig")   → K_meta 인덱스 레코드 무결성
     ─ HKDF("audit")      → K_audit 감사 로그 체크포인트 MAC(폰과 공유)
기기별 랜덤 키(복구 문구와 무관, 기기 밖으로 안 나감)
  Sx X25519 정적키(Noise) · Vx Ed25519 서명키(승인·체크포인트·봉투) · Qx X25519 inbox 키(HPKE, 7일 로테이션 [제안]) · Lx 로컬 래핑 키 · Px(모바일 선택) SE/StrongBox P-256
파일별  DEK_f(랜덤 256비트) ── XChaCha20-Poly1305 ──▶ wDEK_f(KEK_N으로 래핑)
```

규칙: 모바일은 RK·AIK 개인키를 갖지 않는다(받는 것은 KEK_N, K_meta, K_audit). 서버·릴레이는 RK 파생 키를 하나도 갖지 않는다. 계정 인증(이메일 OTP·패스키)과 암호 키는 완전히 분리한다. 비밀번호에서 키를 만들지 않는다.

## 4. 페어링 (Noise_XXpsk0, 광학 채널 + 계정 기기 목록 + 6자리 코드)

QR 페이로드(바이너리, URL 아님): `SAXP|v1 | intent | 릴레이 호스트 | room_id(16B) | Sd(32B) | ps(32B, 1회용 PSK) | exp(기본 120초)`.

1. [PC] "기기 추가" → OS 사용자 존재 확인(Windows Hello/Touch ID) → `room_id`·`ps`·`exp` 생성 → 클라우드 API에서 1회용 룸 발급(정원 2, TTL 120초, 룸 레코드에 계정 ID 없음, 계정당 시간당 5회 [제안]).
2. [PC] QR 표시, 룸에서 응답자로 대기.
3. [폰] 앱 내부 스캐너로만 스캔. 검사: `exp` 미경과, 릴레이 호스트 허용 목록, **`Sd`가 내 계정의 데스크톱 기기 목록에 있음**(없으면 중단 — 원격 피싱 차단).
4. [폰→PC] `Noise_XXpsk0_25519_ChaChaPoly_BLAKE2b`, 개시자 폰, `psk=ps`, prologue=`"SAX-pair-v1"‖room_id‖릴레이‖exp`. msg2에서 폰은 `rs == Sd` 확인. msg3 페이로드: 기기 이름·플랫폼·`Vm`·푸시 토큰.
5. [양쪽] 핸드셰이크 해시 `h`로 `SAS = HKDF(h,"SAX-SAS-v1") mod 10^6`. 폰이 6자리 표시.
6. [PC] 사용자가 **폰의 6자리를 PC에 입력**("일치" 버튼 금지). 3회 실패·TTL 경과 시 룸 폐기. 동시에 PC는 폰의 `Sm`이 **폰이 계정에 직접 등록한 기기 키 목록**에 있는지 확인(QR 유출 공격자는 계정 로그인 없이는 통과 불가).
7. [PC] AIK로 `Cert_M = Sign{device_id, Sm, Vm, role, not_after}` 발급 → 수립된 Noise 채널 안에서 `PAIR_OK{Cert_M, AIK_pub, 기기 목록 버전, KEK_N, K_meta, K_audit}` 전송. 영구 우편함 `mbx_id`, `tok_read`, `tok_write` = HKDF(h, 컨텍스트)로 생성(릴레이는 페어링 룸과 우편함의 연관을 모름).
8. [양쪽] `ps`·임시키·룸 폐기. 폰은 키를 생체 바인딩 저장소로 이동.

QR을 스캔할 수 없을 때: 8~9개 BIP39 단어(88~99비트)를 `ps`로 직접 입력(Keybase KEX 방식). 새 프리미티브(PAKE)는 추가하지 않는다.

20비트 SAS가 충분한 이유는 폰이 QR로 PC를 인증하므로 브리징 MITM이 성립하지 않기 때문이다 `[검토]`.

## 5. 상시 세션과 키 교체

1. 폰이 WSS 연결 후 우편함 토큰 제시. PC 온라인이면 릴레이가 두 소켓을 잇는다.
2. `Noise_IK`, 개시자 폰, prologue=`"SAX-session-v1"‖pair_id`. **msg1 페이로드는 단조 타임스탬프 8바이트뿐**(명령 없음). PC는 `Sm` 미폐기 여부와 타임스탬프 단조성을 확인하고 아니면 **무응답으로 버린다**(오라클 방지).
3. 전송 키 수립 후 `HELLO{기기 목록 버전, 비동기 seq 최고값}`.
4. 키 교체: 연결마다 새 핸드셰이크(전방 비밀성) + 연결 중 `Rekey()` 1시간 또는 2^20 메시지마다 [제안]. 정적키 교체는 연 1회 또는 의심 시 `ROTATE_STATIC{Sx', Sign_Vx}`.
5. 종료는 인증된 `CLOSE`.

## 6. 메시지 프레이밍

```text
outer = ver(1B) ‖ kind(1B: HS/DATA/ENV) ‖ ctr(8B, DATA만) ‖ len(2B)
DATA  = outer ‖ ChaCha20-Poly1305(k_tx, nonce=0^32‖LE64(ctr), ad=outer, pt=pad(inner))
inner = 결정적 CBOR {t, id: UUIDv7, seq, ts, ttl, body}
pad   = ISO/IEC 7816-4, 버킷 {256, 512, 1K, 4K, 16K, 64K−오버헤드}
```

- 수신 측은 `ctr` 슬라이딩 윈도(1024)로 중복·역전을 거른다. Noise 전송 한도 65,535B. **PDF·이미지는 릴레이로 보내지 않고** 블롭 저장소에 올린 뒤 `blob_id`와 래핑 DEK만 보낸다(캡차 크롭 ≤ 200KB는 예외적으로 인라인 허용, 버킷 패딩).
- 서명·MAC 입력에는 항상 컨텍스트 문자열, `pair_id`, 방향(`from/to`)을 포함한다(반사 공격 무효).

메시지 타입(스키마: [schemas/remote-envelope.schema.json](schemas/remote-envelope.schema.json)):

| type | 방향 | body | 비고 |
|---|---|---|---|
| `hello` | 양방향 | `{appVersion, protocol, deviceListVersion, asyncSeqMax, capabilities[]}` | 세션 시작 |
| `cmd.run` / `cmd.abort` / `cmd.resume` | 폰→PC | `{playbookId, inputs, idempotency}` 등 | 엔진 화이트리스트·입력 스키마 검증 |
| `run.event` | PC→폰 | D03 §9 이벤트 사용자용 서브셋 | 값 없음 |
| `gate.request` | PC→폰 | `{runId, stepId, cardId, fields, actionHash, challenge(32B), exp(120s)}` | 카드 텍스트는 PC가 신뢰 계획값에서 렌더링 |
| `gate.response` | 폰→PC | `{runId, stepId, approved, sig = Sign_Vm("SAX-approve-v1"‖pair_id‖reqId‖challenge‖actionHash‖decision)}` | 생체 인증 후 서명. PC가 챌린지·exp·서명·actionHash 검증 → gateToken 발급 |
| `human.request` | PC→폰 | `{runId, stepId, kind, prompt, image?, ttl}` | `secret`은 이미지 없음 |
| `human.response` | 폰→PC | `{runId, stepId, value}` 또는 `{runId, stepId, sealedForVault}` | 비밀은 `sealedForVault`(금고 공개키 `crypto_box_seal`)만. 라이브 세션 전용 |
| `file.offer` | PC→폰 | `{docId, docType, bytes, blobId, wDEK}` | 본문은 블롭 경유 |
| `query.*` | 폰→PC | 보관함 조회 | |
| `rotate.static` / `close` / `ping` / `pong` | | | |

## 7. 오프라인 큐(의도 봉투)

- 큐에는 **비밀과 캡차 답을 넣지 않는다.** "PC 켜지면 실행" 같은 의도만.
- 각 기기는 `Qx`를 7일마다 갱신하고 `{Qx, valid_from, valid_to, seq}`를 `Vx`로 서명해 우편함 번들 슬롯에 게시. 개인키는 `valid_to`+큐 TTL 뒤 삭제(전방 비밀성 창 ≈ 10일 [제안]).
- 폰: `Intent{pair_id, from, to, seq, iat, exp, cmd_id, playbookId, inputs, action_hash}` → Ed25519 서명 → HPKE 봉인(`pkR=Q_D`, info `"SAX-env-v1"`, aad `pair_id‖seq‖exp`) → 우편함(TTL 72시간, 최대 50건 [제안]).
- PC 부팅 → IK 세션 → 드레인: 개봉 실패는 조용히 폐기, 서명·`exp`·`seq` 윈도·`cmd_id` 미실행·화이트리스트 검사, 통과해도 **즉시 실행하지 않고 새 `gate.request`(새 챌린지)를 만든다.** `ACK{seq}` 후 서버가 삭제. 수신 상태(`max_seq`, 비트맵, 처리 `cmd_id`)는 디스크 영속.
- 실패는 모두 무응답·정상 처리와 시간 차 최소화, 오류 코드 없음. 우편함당 실패 상한 후 연결 종료.

## 8. 릴레이(영지식 우편함)

- WSS. 우편함 = 32B 무작위 ID + 능력 토큰(`tok_read`/`tok_write`, 서버는 해시만 저장). 계정과 우편함의 연관을 서버가 모른다. 기기 인증 토큰은 별도 레이어(남용 방지용, 우편함 ID와 조인 불가하게 분리 저장).
- 큐: 우편함당 50건·10MB·72시간 [제안]. 길이 패딩 버킷으로 크기 유출 완화.
- 남용 방지: 우편함당 초당 메시지 20, 기기당 우편함 3, 연결당 실패 상한.
- 푸시는 **내용 없는 깨우기 + fetch**: iOS는 알림 푸시(+Notification Service Extension), Android는 FCM data 메시지. 무음 푸시에 의존하지 않는다. 승인·캡차 알림은 "알림 푸시 → 탭 → IK 핸드셰이크" 순서로 10초 핸드오프를 맞춘다(지연은 S-1에서 측정).
- 릴레이가 아는 것: 우편함 ID, 메시지 크기 버킷·시각, 접속 IP(30일 후 삭제). 모르는 것: 평문, 키, 계정↔우편함 연관, 메시지 종류.

## 9. 기기 분실·폐기·복구

- 폰 분실: PC에서 기기 해제 → AIK로 서명한 폐기 목록 갱신 → 해당 `Sm` 핸드셰이크 거부, 큐 봉투 개봉 불가(Q_D 로테이션), 폰 쪽 KEK_N은 생체 보호 저장소에 있으나 KEK를 `N+1`로 회전해 재래핑.
- PC 분실: 폰은 발급·조회만 가능. 새 PC는 복구 문구로 RK 재생성 → AIK로 새 기기 인증서 발급 → 폰과 재페어링(의도 `복구`).
- 복구 문구 분실: 백업 복구 불가(서버 에스크로 없음). 온보딩에서 강하게 안내하고, 기존 기기 승인으로 KEK 공유 경로를 둔다.

## 10. 감사 로그 앵커

- 로컬 감사 로그는 해시 체인. 체인만으로는 끝부분 절단을 못 막으므로, 하루 1회 `Checkpoint{seq, head_hash, ts}`를 `Vd`로 서명하고 `K_audit` MAC을 붙여 폰에 보낸다. 폰은 최근 체크포인트를 보관해 PC 로그 변조·절단을 탐지한다.

## 11. 위협 대응 요약

| 위협 | 대응 |
|---|---|
| 릴레이 운영자(우리)·네트워크 도청 | Noise E2E, 릴레이는 키·연관 없음, 패딩 |
| 브리징 MITM | 폰이 QR의 `Sd`로 PC 인증, PSK, 6자리 코드 PC 입력 |
| QR 사진·어깨너머·원격 피싱 | 계정 기기 목록 대조(양방향), 룸 1회용·120초, 앱 내 스캐너만 |
| 핸드셰이크·메시지·봉투 재전송 | 연결마다 새 키, `ctr` 윈도, 단조 타임스탬프, `seq`+`exp`+`cmd_id` 영속, 큐는 실행이 아니라 새 승인 |
| 재전송 오라클 | 실패 무응답, 오류 코드 없음, 시간 차 최소화 |
| 폰 분실 | 기기 해제·폐기 목록, 생체 바인딩, 비밀 비저장, KEK 회전 |
| 엔진 침해로 비밀 탈취 | 비밀은 금고 키로 이중 봉인, 라이브 세션 전용 |
| 메타데이터 추론 | 패딩 버킷, 큐 크기 제한, 푸시 내용 없음 |
| 로그 변조·절단 | 해시 체인 + 서명 체크포인트 폰 앵커 |

## 12. 스파이크

S-1 페어링·IK 지연(푸시 → 탭 → 핸드셰이크 포함) 실측 / S-2 Expo에서 `@noble/*` + SecureStore + 생체 바인딩 / S-3 iOS NSE 기반 깨우기 성공률 / S-4 블롭 v1 포맷·패딩 / S-5 SE P-256 승인 서명 / S-6 암호 전문가 리뷰(SAS 20비트, prologue, 도메인 분리).
