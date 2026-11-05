# 금고 IPC 계약 v1 (M1-3, 금고 트랙)

정본은 `poc/packages/vault/src/protocol.ts`다. 이 문서는 PoC 대비 바뀐 점과 다른 트랙이 맞춰야 할 것을 정리한다. 기준은 D05 §2·§3·§4·§5·§7·§9, ADR-005 v3·020·025·026·029·035다.

## 1. 포트별 RPC(`RPC_BY_PORT`)

| 포트 | 기존 | 추가 |
|---|---|---|
| engine | browser.launch·shutdown, typist.fill, secretWindow.openForHuman·requestClose, getDbKeyOnce | `typist.authFailed`, `commitGuard.arm`·`commitGuard.disarm`, `crypto.publicKeys`·`crypto.noiseDH`·`crypto.signVd`·`crypto.hpkeOpen` |
| control(main) | run.begin·run.end, secretWindow.userDone, status | `session.event`, `session.idle`, `vault.unlock`, `vault.setStrict`, `secret.list`·`secret.has`·`secret.forget` |
| secretInput | secret.provide | `secret.store`(등록 창 T-06 전용) |

commitGuard·crypto는 타입만 정해 두었다(구현은 다음 PR, 지금은 `not_implemented`).

## 2. 프로필 범위(`ProfileScope`) — 결정 Q-2
- Phase 1은 프로필 하나(사업자)로 운영한다. 값은 `'business'`이고, `'personal'`은 PoC 시험(audit-v V5) 호환으로 남긴다.
- `run.begin{runId, trigger, profile?}`: main은 run을 시작할 때 활성 프로필을 `profile`로 준다. 금고는 run이 끝날 때까지 그 프로필에 고정한다.
  - 다른 scope로 오는 `typist.fill` → `{ok:false, reason:'denied'}`, 로그는 `vault.profile_mismatch`
  - 같은 runId로 다른 profile의 run.begin → `profile_locked`
  - 범위 밖 값 → `bad_profile`
  - `profile`을 생략하면 고정하지 않는다(PoC 호환). Phase 1 main은 항상 준다.
- 프로필 전환은 설정에서만 한다. run이 없고 금고가 잠긴 상태에서만 허용하며, 이 검사는 main이 한다.
- Phase 2(프로필 둘 동시 운영)에서 `ProfileId`로 넓힌다.

## 3. secretInput 결속(`SecretInputBind`) — desktop 트랙
- 기존 1회용 결속 `{runId, kind, scope, row?}`는 그대로 동작한다(mode 생략 = oneshot).
- 등록 결속은 `{mode:'store', kind:'portal_password'|'security_card', scope, notice:{version}}`다. runId·row가 없고, cert_password는 받지 않는다(ADR-020 결정 2).
- store 포트는 `secret.store{entries:[{row?, field?:'pw', bytes}], portalLoginId?}`를 한 번만 받는다.
  - 보안카드는 row(1~35)를 쓰고, 포털은 `field:'pw'`를 쓴다.
  - 결과는 `{handle:{kind,scope}, tier, consent, portalLoginId?}`이고 비밀 값·길이는 없다.
- 결속 모드와 메서드가 맞지 않으면 거부한다(store 포트에 온 provide, oneshot 포트에 온 store).
- 금고가 닫혀 있으면 잠금 사유와 상관없이 저장을 거부한다(`vault_locked`). 이 경우 main은 T-06을 열기 전에 `vault.unlock`(Hello)을 부르거나 Windows 잠금 해제를 기다린다. 엄격 모드에서는 Hello 확인 뒤 300초 안에만 저장된다.
- 다시 등록하다 키체인 쓰기가 실패하면 옛 슬롯을 되돌린다. 그 포트는 이미 쓴 것이라, 다시 시도하려면 main이 등록 창을 새로 연다.

### 포털 아이디 — 결정 Q-1(ADR-035, D05 §2·§4)
- 포털 아이디는 비밀이 아니다. 금고에 칸이 없고(`PortalField = 'pw'`), `SecretKind`도 늘리지 않는다.
- 아이디는 DB `profiles.portal_login_id`(data 트랙)에 두고 엔진 `fill` 스텝이 넣는다. 타이피스트는 type=password 칸에만 넣는다(D05 §4).
- 등록 창이 아이디를 같은 화면에서 받으면 `secret.store`의 `portalLoginId`로 넘긴다. 금고는 이 값을 저장·로그하지 않고 결과의 `portalLoginId`로 그대로 돌려준다(NFC·앞뒤 공백 제거 뒤). main이 그 값을 DB에 쓴다.
  - 1~64자이고 공백·제어 문자가 없어야 한다(`PORTAL_LOGIN_ID_MAX`). 틀리면 `bad_login_id`로 거부하고 비밀도 저장하지 않는다.
  - 보안카드 결속에 아이디가 오면 `bad_login_id`다.
  - `field:'id'` 칸으로 보내면 `bad_cell`이다.

## 4. Windows 세션 추종 — desktop(main) 트랙
utilityProcess에는 powerMonitor가 없어서 main이 이벤트를 넘긴다.
- `session.event{kind}`: kind는 lock-screen·unlock-screen·suspend·resume·session-switch·remote-switch 중 하나다. WTS 세션 전환은 S10c에서 다룬다.
- `session.idle{idleSec}`: `SESSION_IDLE_REPORT_MS`(30초)마다 `powerMonitor.getSystemIdleTime()` 값을 보낸다.
  - 마지막 보고가 `SESSION_IDLE_STALE_MS`(120초)보다 오래되면 금고는 잠근다(fail-closed).
  - 보고 공백이 900초를 넘었으면 다음 보고가 0이어도 프롬프트 없이 열지 않는다.
- `vault.unlock{reason:'idle'|'strict_issue', task, portal}` → `{ok, presence, reason?}`. 승인 바 Hello와 금고 Hello를 한 프롬프트로 합친다(ADR-026 결정 4). main은 `presence`를 승인 바 Hello 확인으로 쓴다.
- `vault.setStrict{on}` → `{ok, reason?:'hello_unavailable'|'unlock_required'}`. 설정은 키체인 `settings/strict`에 남아 재시작 뒤에도 이어진다.
- `vault.unlock`의 `presence:true`는 Hello 프롬프트로 사본을 실제로 연 때만 온다.
- control 이벤트: `vault.state{open, reason?}`, `secret.suspect{kind, scope}`.

## 5. 타이피스트 — engine 트랙
- `FillRequest.startGate?: boolean`: trigger=remote인 실행은 시작 게이트를 통과했다는 플래그가 있을 때만 입력한다(ADR-029 결정 2).
- `FillReason`에 `vault_locked`·`credential_suspect`를 더했다.
- `typist.authFailed{runId, kind, scope}`: 포털이 명시적 인증 실패(auth_failed)를 1회 알리면 엔진이 보낸다. 금고는 그 슬롯을 suspect로 두고, 다시 등록하기 전에는 입력하지 않는다(ADR-026 결정 7). 차단·셀렉터 실패에는 보내지 않는다.
- 금고가 열려 있고 trigger≠daemon이면, 타이피스트는 1회용 값 대신 저장된 보안카드 칸·포털 비밀번호를 쓴다.

## 6. R-C1 커밋 본문 대조 — engine 트랙(커밋 가드)
- `commitGuard.arm{runId, intentId, stepId, targetId, endpoint, method?, bodyFieldMap, expectedHash}` → `{armed, reason?}`.
  - endpoint는 Fetch urlPattern(`*`)이고, 호스트는 엔진 허용 목록 안이어야 한다. method 기본값은 POST다.
  - bodyFieldMap은 fieldKey → 경로다. form은 이름, json은 `a.b[0].c`, xml은 `xml:/root/a/b`로 쓴다.
  - expectedHash는 `commitExpectedHash(values, bodyFieldMap)`(protocol.ts 공통 함수)로 만든다. 엔진은 readback 기대값을 본문 형식에 맞춰 넣는다(쉼표·하이픈 등 형식 맞춤은 엔진 책임).
  - 해시 = sha256("SAX-rc1-v1\n" ‖ JSON.stringify([[key, NFC·trim·공백1칸]...])), 키는 정렬한다. 고정 벡터: `{a:'1', b:'x y'}` → `5809c1c0…4400a`.
- 결과는 engine 이벤트 `commit.body_compared{intentId, stepId, match: true|false|'opaque'|'expired'}`로 온다.
  - false: 금고가 `Fetch.failRequest`로 요청을 막는다.
  - opaque: 평문 형식이 아니라 대조할 수 없다.
  - expired: 무장 뒤 120초(`COMMIT_ARM_TTL_MS`) 안에 맞는 요청이 없었다.

## 7. 장기 키 연산 — net/remote 트랙
- `crypto.publicKeys` → `{noiseStatic, vd, qd, kv}`(각 32B 공개키).
- `crypto.noiseDH{remotePub, ctx}` → `{shared}`. 개인키는 금고 밖으로 나가지 않는다.
- `crypto.signVd{purpose ∈ VD_PURPOSES, msg}` → `{sig}`(Ed25519). 서명 대상은 purpose‖0x00‖msg다.
- `crypto.hpkeOpen{enc, ct, info:'SAX-env-v1', aad}` → `{pt}`. HPKE Base(X25519-HKDF-SHA256, HKDF-SHA256, ChaCha20-Poly1305)다.

## 8. Windows 네이티브 헬퍼 — 결정 Q-3
- 금고 트랙은 인터페이스·모의 구현·macOS 개발 구현까지 맡는다. 실제 Windows 구현은 2차 배분(Windows 호스트 세션)이 한다.
- 그 전까지 Windows에서는 사람 비밀 저장을 거부한다(`vault.native_helper_missing`, fail-closed).
- 인터페이스: `poc/packages/vault/src/keychain/backend.ts`의 `WindowsKeyHelper`(TPM·DPAPI)와 `HelloProvider`(Hello).
- 필요한 네이티브 호출과 실측 항목: `poc/reports/M1-3-windows.md`(W-1~W-7).
