# ADR-052. 폰에서 발급 승인: 승인 키(Px) 등록, 게이트 중계, PC 검증

> 상태: 채택(2026-11-19). 대표 지시 "모바일에서도 승인 가능하게 해야 함"(2026-11-19 yulmu). 결정 2의 등록 방식은 결정 카드에서 "자동 등록"을 골랐다(2026-11-19 yulmu. 추천안은 "PC에서 한 번 허용"이었다).
> 구현: 1단계(이 PR, tex) PC 쪽 등록·중계·검증과 프로토콜 v1.10. 폰 쪽은 taxoff-mobile PR. iPhone 네이티브 키는 맥북 빌드와 실기기 확인 전이다.
> 잇는 결정: [ADR-016](ADR-016-account-trust-anchor-hardware-approval.md)(원격 비가역 승인은 하드웨어 키만), [ADR-021](ADR-021-pc-approval-evidence-main-approval-bar.md)(승인 근거는 main이 발급), [ADR-046](ADR-046-phone-issuance-approval-phase1.md) 결정 1·4(폰 승인 Phase 1, iPhone 승인 기기)
> 관련: D08 §2.1·§4.2·§6·§6.1, D03 §3, `schemas/remote-envelope.schema.json` v1.10

## 맥락

- 폰이 맡긴 발급(`cmd.run`)은 지금 모두 `pc_only`다. PC가 홈택스에서 값을 다 넣고도 PC 앞에서 [승인하고 발급]을 눌러야 끝난다. 밖에서 거래처 앞에서 끊는 상황을 못 푼다.
- 규칙은 이미 있다(D08 §6.1, ADR-016). 원격 비가역 승인은 폰 하드웨어 P-256 키(`Px`)의 서명으로만 받는다. 없는 것은 그 키를 만들고, PC가 그 키를 알게 되고, 승인 요청이 폰으로 가고, PC가 답을 검증하는 실제 길이다.
- D08 §4.2는 `Px`를 페어링 msg3과 AIK 서명 인증서(`Cert_M`)에 넣는다고 적었지만 구현된 적이 없다. 이미 연결된 폰에는 `Px`가 없다.
- 엔진은 승인 근거(`LocalApproval`)를 게이트 포트로 main에서만 받고 MAC을 검증하지 않는다(ADR-021). 폰 링크와 연결 기록도 main이 가진다. 그래서 폰 서명의 검증자는 main이다.

## 결정

### 1. 승인 키(Px)는 폰 하드웨어 안에서 만들고, 쓸 때마다 생체를 확인한다

- iPhone: Secure Enclave P-256. `kSecAttrTokenIDSecureEnclave`, 접근 제어 `privateKeyUsage + biometryCurrentSet`, `WhenPasscodeSetThisDeviceOnly`. 폰 암호로는 열리지 않는다(앱 잠금과 다르다, D08 §3.1). 백업과 기기 이전에 실리지 않는다.
- 서명할 때마다 OS 생체 창이 뜬다. 이유 글은 앱이 준다("승인하고 발급").
- 생체를 다시 등록하면 OS가 키를 못 쓰게 한다. 폰은 키를 지우고 새로 만들어 다시 등록을 청한다(결정 2의 "PC에서 한 번 허용" 길).
- Android(StrongBox, 없으면 TEE)는 Key Attestation 체인을 PC가 검증한 뒤에만 받는다(D08 §6.1). 검증기는 2단계다. 그때까지 Android 폰은 지금처럼 PC에서 승인한다.
- 승인 키가 없거나 PC가 받지 않은 폰은 조회와 맡기기만 한다.

### 2. 등록: 폰이 PC에 공개키를 알리면 PC가 바로 받는다(자동 등록)

- 새 메시지 `px.enroll`(폰→PC, 라이브 세션): `{pxPub(SEC1 비압축 65바이트), hw(ios_se | android_strongbox | android_tee), sig}`.
  `sig = Ed25519_Vm("SAX-px-enroll-v1" ‖ CBOR([pairId, deviceId, pxPub, hw]))`. 채널은 이미 Noise로 그 폰(`Sm`)임이 확인된다. `Vm` 서명은 기록이 채널 코드와 따로 검증되게 하려는 것이다.
- PC 답 `px.ack`: `{state(enrolled | needs_pc | rejected), pxId}`. `pxId`는 `SHA-256(pxPub)` 앞 8바이트(hex)다.
- 폰은 PC가 `approve.v1`을 알린 세션을 열 때마다 `px.enroll`을 보낸다. 같은 키면 PC는 `enrolled`로 답한다(멱등). PC가 기록을 잃어도 다음 세션에서 스스로 맞춰진다.
- **PC는 연결된 폰이 서명한 등록 알림을 바로 받는다**(대표 결정 2026-11-19 "자동 등록"). 이미 연결된 폰도 앱만 올리면 다음 세션에서 승인 기기가 된다. 키가 바뀌었으면(생체 재등록) 새 키로 바꾼다. PC 앞 확인은 없다.
- 예외: PC에서 그 폰의 승인을 꺼 두었으면(결정 3 `revokePx`) 바로 받지 않고 청한 키를 적어 둔 채 `needs_pc`로 답한다. PC에서 다시 허용(`allowPx`)하면 그 키를 받는다.
- 저장: PC `remote-phones.json`의 그 폰 기록에 `px{pub, hw, enrolledAt, via(auto | pc)}`. 서버에는 올리지 않는다. PC가 여러 대면 PC마다 등록된다(연결이 PC마다 따로다).
- iPhone의 `hw = ios_se`는 "앱이 Secure Enclave에서 만들었다고 알림"이다. App Attest(앱 무결성 신호)는 붙이지 않았다. D08 §6.1의 `ios_app_attest`보다 한 단계 약하다(잔여 위험 참고).
- 받는 종류는 지금 `ios_se`뿐이고, 연결 기록의 플랫폼과 맞아야 한다.

### 3. 폐기

- PC에서 그 폰의 연결을 끊으면 기록과 함께 승인 키가 지워진다(지금 있는 [연결 끊기]). 계정에서 기기를 정지하거나 폐기하면 세션이 열리지 않아 승인도 못 한다(지금 있는 길).
- 폰에서 PC 연결을 지우거나 앱을 지우면 폰의 키를 지운다. 생체 재등록은 OS가 키를 무효로 한다(결정 1).
- PC `PhoneLink.revokePx(pairId)`: 연결은 두고 폰 승인만 끈다. 꺼 둔 동안은 자동 등록도 받지 않는다. `allowPx(pairId)`로 다시 켠다(기기 화면 단추는 화면 작업 때 붙인다).
- 검증은 답이 올 때마다 기록의 키를 다시 읽는다. 폐기는 바로 듣는다.

### 4. 승인 요청 중계와 답

- 폰은 hello에 `approve.v1`을 알린다. PC는 그 폰에 받은 승인 키가 있으면 `cmd.ack.state = accepted`, 없으면 지금처럼 `pc_only`로 답한다.
- 엔진이 커밋 게이트를 열면(main의 `gate` 이벤트) main은 PC 승인 바를 지금처럼 띄우고, 아래를 모두 지키면 그 폰에도 `gate.request`를 보낸다.
  1. 그 폰이 `cmd.run`으로 시작한 실행이다(PC에서 시작한 일은 폰으로 보내지 않는다).
  2. 그 폰 기록에 받은 승인 키가 있다(`hw = ios_se`).
  3. 세금계산서 카드(`invoice.confirm`)이고, main의 자기 일치 확인(`gateSelfCheck`)과 승인 바 무장 검사(`summarize`)를 지났다.
  4. `$first.bizNo`·`$first.email`이 참이 아니다(처음 거래처, 처음 보내는 이메일은 PC에서. `remote.newCounterpartyRequiresLocal`).
  5. 오늘(한국 시간) 폰 승인이 5건 미만이다(`remote.irreversiblePerDay`).
- 보내지 않을 때는 `run.event{phase: approve, code}`로 이유를 알린다: `pc_first`(처음 거래처), `pc_limit`(오늘 한도), `pc_key`(승인 키 없음), `pc_only`(그 밖). 폰은 "PC에서 승인" 줄에 이유를 붙인다.
- `gate.request` 본문은 스키마 그대로다. `fields`는 엔진 되읽기 값, `requiredSigAlg = p256`, `effects = [issue_document, send]`, `challenge`는 main이 요청마다 새로 뽑는 32바이트, `exp = 지금 + 120초`. `reqId`는 main이 엔진 게이트마다 하나 만드는 ULID다(엔진 `reqId`와 1:1, main이 대응을 든다). 세션이 없으면 기다렸다가 그 폰의 세션이 붙을 때 보낸다.
- 폰은 받은 값으로 `cardHash`·`actionHash`를 다시 계산해 맞을 때만 단추를 켠다(이미 있는 승인 시트). 답 `gate.response{runId, stepId, reqId, decision, actionHash, sigAlg: p256, sig}`.
- **서명 입력(D08 §6의 "‖" 표기를 이렇게 정한다):** `ECDSA-P256-SHA256( utf8("SAX-approve-v1") ‖ CBOR([pairId, reqId, challenge(바이트 32), actionHash(바이트 32), decision]) )`. CBOR은 결정적 인코딩(RFC 8949 §4.2.1)이다. `sig`는 r‖s 64바이트의 base64다(네이티브의 DER은 폰이 바꾼다). PC는 high-S도 받는다(Secure Enclave는 low-S를 보장하지 않는다. 재사용은 챌린지 1회용이 막는다).
- 폰이 늦게 열었거나 120초가 지났으면 폰이 `gate.refresh{runId, reqId}`를 보내고, PC는 게이트가 아직 열려 있으면 새 챌린지로 `gate.request`를 다시 보낸다(`reqId`는 그대로). 세션이 다시 붙을 때도 열린 게이트를 새 챌린지로 다시 보낸다.
- (2026-11-19 덧붙임, remote-envelope v1.11) 게이트가 PC에서 승인되거나, 대기가 끝나거나, 실행이 멈추면 PC는 그 게이트를 받은 폰에 `gate.resolved{runId, reqId, by}`를 보내 시트를 바로 닫게 한다. 폰이 답했을 때도 `by: phone`으로 보낸다. 폰이 `sync.v1`을 알렸을 때만 보낸다(Codex app-server `serverRequest/resolved`와 같은 생각).

### 5. PC 검증(main)

답이 오면 순서대로 본다. 하나라도 틀리면 승인하지 않고 결과 코드만 로그에 남긴다.

1. 그 세션의 폰(`pairId`)에 보낸, 아직 열린 요청이 있다(`reqId`). `runId`·`stepId`가 같다.
2. `sigAlg = p256`이다(`ed25519`는 거부).
3. `actionHash`가 보낸 값과 같다.
4. `exp`가 지나지 않았다(PC 시계).
5. 지금 기록의 승인 키로 서명이 맞다. 틀린 서명이 같은 게이트에서 3번이면 이 게이트는 폰으로 더 보내지 않는다(PC에서만).
6. 오늘 한도를 다시 센다.

- 통과하면 챌린지를 지운다(1회용). 같은 답이 다시 오면 열린 요청이 없어 버려진다.
- `approve`: 승인 기록(`remote-approvals.json`: 시각, 기기, `reqId`, `actionHash`, 서명)을 디스크에 먼저 쓰고, main이 `LocalApproval{presence: "remote+px"}`를 발급해 게이트 포트로 엔진에 보낸다. PC 승인 바는 내린다. 그 뒤는 PC 승인과 같은 길이다(2초 뒤 발급, 발급목록 확인).
- `deny`: 실행을 멈춘다([중지]와 같다. 안전한 실패).
- PC 바가 먼저 눌리면 엔진 게이트가 닫혀 폰의 답은 받지 않는다(엔진 `gate_requests` 단일 사용). 폰은 `run.event`로 다음 단계를 본다.
- 엔진은 `presence = remote+px`를 세금계산서 게이트에서만 받고, 게이트 값에 `$first.*`가 참이면 거부한다(main과 같은 규칙을 한 번 더). 게이트 행의 결정자는 `remote`로 남는다.
- 폰 승인으로 발급이 시작되면 PC에 알림을 띄운다("폰에서 승인했어요"). 계정 이메일 알림(`remote.notifyOnIrreversible`의 email)은 계정 서비스에 알림 종류와 호출을 더해야 해서 다음 PR이다.

### 6. 리플레이와 바꿔치기 방지 요약

| 공격 | 막는 것 |
|---|---|
| 옛 승인 답을 다시 보냄 | 챌린지 32바이트 1회용, `exp` 120초, 엔진 게이트 단일 사용 |
| 다른 건의 승인을 이 건에 씀 | 서명에 `actionHash`(되읽기 값·승인 범위·패키지·의도) |
| 다른 PC·다른 연결의 승인을 씀 | 서명에 `pairId`, 세션은 Noise로 그 폰 |
| 보여 준 값과 다른 값을 발급 | 폰이 `fields`로 해시를 다시 계산, PC는 엔진 게이트의 `actionHash`와 대조 |
| 거절을 승인으로 바꿈 | 서명에 `decision` |
| 승인 키 바꿔치기 | 등록 알림은 그 폰의 `Vm` 서명과 Noise 세션(`Sm`)이 있어야 한다. 폰의 소프트웨어 키까지 빼낸 공격자는 막지 못한다(잔여 위험) |
| 릴레이·서버가 끼어듦 | 종단간(Noise) 안에서만 다닌다. 서버는 키도 답도 보지 못한다 |

## 잔여 위험

- **자동 등록이라 폰 소프트웨어 키(`Sm`·`Vm`)가 새면 승인 키도 바꿔치기된다**(대표가 받아들임 2026-11-19). 그 키들은 생체 또는 폰 암호로만 열리는 키체인 항목에 있어서, 꺼내려면 잠금이 풀린 폰과 탈옥 수준의 침해가 필요하다. 그 공격자는 세션을 열어 자기 P-256 키를 등록하고 발급을 승인할 수 있다. 줄이는 것: 하루 5건, 처음 거래처와 처음 보내는 이메일은 PC, PC 알림(이메일 알림은 다음 PR), 계정에서 그 폰 정지, PC에서 폰 승인 끄기. 키가 바뀐 등록은 로그에 `replaced`로 남는다.

- **iPhone 키의 하드웨어 생성은 증명되지 않는다**(ADR-016 E-10, 대표가 받아들임 2026-11-17). 이번에는 App Attest도 없어서, 변조된 앱이 소프트웨어 키를 등록해도 PC가 모른다. 줄이는 것: 하루 5건, 처음 거래처는 PC, PC 알림. App Attest는 계정 서비스 검증이 필요해 뒤로 둔다.
- **PC의 연결 기록 파일을 고칠 수 있는 PC 악성코드**는 승인 키를 바꿀 수 있다. 그 수준의 침해는 엔진과 브라우저도 조종할 수 있어 이 설계의 범위 밖이다(D05 §1).
- **이메일 알림 전**에는 밖에 있는 사장님이 모르는 폰 승인을 바로 알 길이 PC 알림뿐이다. 다음 PR에서 닫는다.
- **PC 승인 바가 폰 발급 명령에도 저절로 뜬다**(D08 §6.1의 "원격 실행은 PC 바를 자동으로 띄우지 않는다"와 다르다). 지금 동작을 그대로 뒀다. 무인 PC 앞의 다른 사람이 누를 수 있다는 위험은 이 ADR 전과 같다.

## 기각

- **등록을 PC 앞에서만 받기**(연결 직후 10분 또는 PC 기기 화면에서 한 번 허용. 추천안이었다): 폰 소프트웨어 키가 새도 승인 키를 못 바꾼다. 대신 이미 연결된 폰과 생체를 다시 등록한 폰은 PC 앞에서 한 번 더 손이 간다. 대표가 자동 등록을 골랐다(2026-11-19).
- **`Px`를 AIK 서명 인증서(`Cert_M`)와 계정 서버 기기 목록에 넣기**(D08 §4.2 원안): 계정 서비스 API와 페어링 프로토콜을 함께 바꿔야 하고, 이미 연결된 폰은 어차피 따로 등록해야 한다. PC 로컬 기록으로 충분하다(승인을 받는 쪽이 그 PC다).
- **엔진이 P-256 서명을 검증**: 엔진은 폰 링크도 연결 기록도 없다. 승인 근거의 발급자는 이미 main이다(ADR-021).
- **`Vm`(소프트웨어 키)으로 승인**: ADR-016 위반.
- **챌린지 없이 `reqId`만으로 1회용**: 다시 요청할 때 `reqId`가 그대로라 옛 서명이 살아난다.

## 남은 일

1. 계정 이메일 알림(계정 서비스 `remote_approved` 알림 + PC 호출).
2. PC 기기 화면: 폰 승인 끄기와 다시 허용 단추, 승인 기기 표시(화면 작업, 맥북 미리보기).
3. Android 키와 Key Attestation 검증.
4. App Attest(iPhone 앱 무결성 신호).
5. iPhone 실기기 확인: Face ID 창, 생체 재등록 뒤 재등록, 120초 만료와 다시 요청.
