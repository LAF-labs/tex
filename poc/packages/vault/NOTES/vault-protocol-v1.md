# 금고 IPC 계약 v1 (M1-3, 금고 트랙)

정본은 `poc/packages/vault/src/protocol.ts`다. 이 문서는 PoC 대비 바뀐 점과 다른 트랙이 맞춰야 할 것을 정리한다. 기준은 D05 §2·§3·§4·§5·§7·§9, ADR-005 v3·020·025·026·029·035다.

## 1. 포트별 RPC(`RPC_BY_PORT`)

| 포트 | 기존 | 추가 |
|---|---|---|
| engine | browser.launch·shutdown, typist.fill, secretWindow.openForHuman·requestClose, getDbKeyOnce | `typist.authFailed`, `commitGuard.arm`·`commitGuard.disarm`, `pdf.print`·`download.arm`·`download.disarm`. **`crypto.*`는 없다**(2026-11-06 엔진 포트에서 뺌: 엔진이 뚫려도 기기 키로 서명하지 못한다) |
| control(main) | run.begin·run.end, secretWindow.userDone, status | `session.event`, `session.idle`, `vault.unlock`, `vault.setStrict`, `secret.list`·`secret.has`·`secret.forget`, `npki.list`, `crypto.*` 다섯(main 계정·기기·페어링, 이 포트에만) |
| secretInput | secret.provide | `secret.store`(등록 창 T-06 전용) |

commitGuard(#81)·crypto(#87)·npki(§9)는 구현됐다.

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
- 1회용 결속 `{runId, kind, scope, row?}`(mode 생략 = oneshot)는 금고가 `secret.needed`로 부른 것만 붙는다(ADR-025 결정 10, 비밀 창은 금고가 부른다).
  - kind는 `TYPIST_KINDS`(portal_password·security_card)만이다. cert_password는 1회용으로도 받지 않는다(ADR-020 결정 2).
  - 보안카드는 row(1~35) 필수, 포털 비밀번호는 row가 없다.
  - `runId|kind|scope|row`가 살아 있는 `secret.needed`와 같아야 한다. 기록은 `SECRET_TTL_MS` 동안 살고, provide 한 번이나 `run.end`에 지운다.
  - 맞지 않으면 포트를 붙이지 않고(답 없음) `vault.secret_input_unrequested{kind}`만 남긴다. 창을 연 뒤 기록이 사라지면 provide는 `not_requested`다.
  - main은 지금처럼 `secret.needed`를 받았을 때만 1회용 창을 연다. 창은 열리지만 포트가 붙지 않으면 값은 금고에 가지 않는다.
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
  - 보고가 120초 넘게 끊겼다가 다시 오면(공백이 900초 미만이어도) 프롬프트 없이 열지 않는다. 다시 열려면 Hello나 Windows 잠금·해제가 필요하다. 기동 직후 첫 보고는 여기에 해당하지 않는다.
- `vault.unlock{reason:'idle'|'strict_issue', task, portal}` → `{ok, presence, reason?}`. 승인 바 Hello와 금고 Hello를 한 프롬프트로 합친다(ADR-026 결정 4). main은 `presence`를 승인 바 Hello 확인으로 쓴다.
- `vault.setStrict{on}` → `{ok, reason?:'hello_unavailable'|'unlock_required'}`. 설정은 키체인 `settings/strict`에 남아 재시작 뒤에도 이어진다.
- `vault.unlock`의 `presence:true`는 Hello 프롬프트로 사본을 실제로 연 때만 온다.
- control 이벤트: `vault.state{open, reason?}`, `secret.suspect{kind, scope}`.

## 5. 타이피스트 — engine 트랙
- `FillRequest.startGate?: boolean`: trigger=remote인 실행은 시작 게이트를 통과했다는 플래그가 있을 때만 입력한다(ADR-029 결정 2).
- `FillReason`에 `vault_locked`·`credential_suspect`를 더했다.
- 종류 규칙(ADR-020 결정 2, ADR-025 결정 10): 타이피스트는 `TYPIST_KINDS`(portal_password·security_card)만 넣는다. cert_password 요청은 정책이 호스트를 허용해도 `denied`이고 `vault.typist_kind_refused`를 남긴다. 보안카드는 row 필수, 포털은 row 없음(어기면 `denied`).
- `FillRequest.rowLabel?: string`(보안카드 필수): 같은 프레임에서 칸 번호가 보이는 요소의 CSS 셀렉터(256자 이하). 금고가 격리 세계에서 그 요소의 글자를 읽어 숫자가 정확히 하나(전각은 NFKC)이고 `secret.row`와 같을 때만 넣는다. 없거나 다르면 값을 꺼내지 않고 `row_mismatch`(`FillReason` 추가), 로그는 `vault.card_row_mismatch{readable}`(번호·값 없음).
- `typist.authFailed{runId, kind, scope}`: 포털이 명시적 인증 실패(auth_failed)를 1회 알리면 엔진이 보낸다. 금고는 그 슬롯을 suspect로 두고, 다시 등록하기 전에는 입력하지 않는다(ADR-026 결정 7). 차단·셀렉터 실패에는 보내지 않는다.
- 금고가 열려 있고 trigger≠daemon이면, 타이피스트는 1회용 값 대신 저장된 보안카드 칸·포털 비밀번호를 쓴다.
  - 금고가 닫혔으면 `vault_locked`(사람 확인 필요), suspect면 `credential_suspect`로 멈춘다.
  - 금고는 열렸지만 저장본을 못 쓸 때(`kek_unavailable`: 기기 사본 없음·다른 기기·래핑 해제 실패, 또는 `corrupt`)는 1회용 값으로 넘어간다(`secret.needed`).

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
- 동작(구현: `relay/commit-guard.ts`)
  - 엔진은 커밋 엔드포인트를 지금처럼 `Fetch.enable{patterns:[{urlPattern, requestStage:'Request'}]}`로 가로챈다. 금고는 엔진행 `Fetch.requestPaused`를 순서 큐에서 잡아 무장(타깃·method·urlPattern)과 맞으면 대조한다.
  - 일치·opaque: 본문(postData·postDataEntries·hasPostData)을 지운 이벤트를 엔진에 넘긴다. 엔진이 `Fetch.continueRequest`로 이어 보낸다.
  - 불일치: 금고가 `Fetch.failRequest{errorReason:'BlockedByClient'}`로 막고 이벤트는 넘기지 않는다. 그 requestId로 오는 엔진의 `Fetch.*`는 `commit_blocked`로 거부한다.
  - 선언된 형식(form·json·xml)인데 필드가 없거나(form 같은 이름 둘 이상 포함) 해석이 안 되면 불일치로 막는다(fail-closed). 평문 형식이 아니거나 본문이 없으면 opaque다.
  - xml은 잎 요소만 본다(같은 경로가 둘이거나 자식이 있으면 불일치). DOCTYPE은 받지 않는다. 엔티티는 기본 5개와 숫자 참조만 푼다.
  - 무장은 타깃당 하나, 요청 하나다(대조 시작 때 푼다). `commitGuard.disarm`과 `run.end`는 알림 없이 푼다.
  - 무장 대상 요청의 `Network.requestWillBeSent` 본문도 지운다. 엔진의 `Network.getRequestPostData`도 그 요청에는 거부된다.
  - 로그는 `vault.commit_armed{fields}`·`vault.commit_compared{match, why?}`뿐이다. 값·경로·본문은 남기지 않는다.

## 7. 장기 키 연산 — net/remote 트랙
- 구현: `crypto/ops.ts`(`VaultCrypto`). 엔진 포트(모델 게이트웨이 DPoP)와 control 포트(main의 계정·기기·페어링, `apps/desktop/src/remote-keys.ts` `vaultDesktopKeys`)에서 부른다. 비밀 입력 포트에는 없다.
- `crypto.publicKeys` → `{noiseStatic, vd, qd, kv, aik}`(각 32B 공개키). `aik`를 더했다(remote `DesktopKeys.aik.publicKey`).
- `crypto.noiseDH{remotePub(32B), ctx ∈ NOISE_CONTEXTS}` → `{shared}`. 낮은 차수 점은 `bad_point`다. 개인키는 금고 밖으로 나가지 않는다.
- `crypto.signVd{purpose ∈ VD_PURPOSES, msg}` → `{sig}`(Ed25519 64B).
  - 서명 대상은 `utf8(purpose) ‖ msg`이고 구분 바이트가 없다(schemas/SIGNING.md §8). 이전 문서의 `0x00`은 오기였다.
  - 클라우드 대상 Vd 맥락은 `SAX-dpop-v1`뿐이다.
- `crypto.signAik{purpose ∈ AIK_PURPOSES, msg}` → `{sig}`.
  - AIK_PURPOSES = SAX-devlist-v1·SAX-revoke-v1·SAX-cert-v1·SAX-aik-rotate-v1·SAX-kek-v1·SAX-acct-op-v1이다.
  - 서명 대상은 `utf8(ctx) ‖ msg`이고, msg는 호출자가 만든 대상 객체의 JCS 바이트다.
  - AIK = Ed25519(HKDF-SHA256(RK, salt 없음, info "aik", 32))이고, RK는 첫 실행 때 금고가 만든 32B 난수다(D08 §3).
  - Phase 2: 매 호출 Hello 확인과 trigger=daemon 거부(C-22)다. Phase 1은 무인 저장을 잔여 위험으로 둔다.
- `crypto.hpkeOpen{enc(32B), ct, info:'SAX-env-v1', aad}` → `{pt}`.
  - RFC 9180 Base(DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305), seq 0 단발 개봉이고 키는 Qd다.
  - aad는 `utf8("SAX-env-v1")‖mbx_epoch`(뒤 64B 이하)여야 한다. 위조는 `open_failed`다.
- 공통
  - 입력 msg·ct는 64KiB 이하다.
  - 허용 목록 밖 purpose는 `purpose_not_allowed`, 형식 오류는 `bad_params`다.
  - 키는 KeyStore 항목 `device/sd·vd·qd·kv`, `account/rk`에 32B 시드로 둔다. 없으면 만들고(`vault.key_created{name}`), 길이가 틀리면 덮지 않고 `vault.keystore_mismatch`다.
- 감사: 호출마다 `vault.crypto_op{op, purpose?}`를 남긴다. 한 시간 기대치(noiseDH 240·signVd 3600·signAik 60·hpkeOpen 1200)를 넘으면 `vault.crypto_rate_anomaly{op, count}`를 시간당 1회 남긴다(막지 않음). 입력·출력 바이트는 남기지 않는다.

## 8. Windows 네이티브 헬퍼 — 결정 Q-3
- 금고 트랙은 인터페이스·모의 구현·macOS 개발 구현까지 맡는다. 실제 Windows 구현은 2차 배분(Windows 호스트 세션)이 한다.
- 그 전까지 Windows에서는 사람 비밀 저장을 거부한다(`vault.native_helper_missing`, fail-closed).
- 인터페이스: `poc/packages/vault/src/keychain/backend.ts`의 `WindowsKeyHelper`(TPM·DPAPI)와 `HelloProvider`(Hello).
- 필요한 네이티브 호출과 실측 항목: `poc/reports/M1-3-windows.md`(W-1~W-7).

## 9. 공동인증서 탐지 `npki.list` — desktop(main)·docparse 트랙
- control 포트 전용이다. 인자는 없다(`{}`). 결과는 `NpkiListResult{certs: NpkiCertEntry[], skipped}`다. 부를 때 한 번 훑고 감시하지 않는다(D05 §6 (4)).
- 위치(R3 §3)
  - Windows: `%USERPROFILE%\AppData\LocalLow\NPKI`, `%ProgramFiles%\NPKI`
  - macOS: `~/Library/Preferences/NPKI`, `~/Documents/NPKI`, `~/NPKI`
  - 그 밖(개발): `~/NPKI`
  - 이동식 저장소는 자동으로 훑지 않는다(사용자가 고른 파일만, 후속).
- 구조는 `<위치>/<CA>/USER/<cn=…>/signCert.der`다. `USER`·파일 이름은 대소문자를 가리지 않는다. CA 이름은 인쇄 가능한 ASCII 64자 이하만 받는다.
- 항목: `{id(sha256(dir) 앞 16hex), root, ca, dir, certFile, certDer, hasKey}`
  - **금고는 `certDer`를 파싱하지 않는다.** main이 docparse 샌드박스 `certInfo(der)`에 넘기고 고정 4필드 `{subject, issuer, notBefore, notAfter}`를 스키마로 검증해 쓴다(ADR-014 결정 1, D17 §3).
  - `hasKey`는 같은 폴더에 `signPri.key` 이름의 일반 파일 항목이 있다는 뜻이다. **signPri.key는 열지도 stat하지도 않는다**(D05 §6 (3)). 시험이 파일 접근을 감사한다.
  - `dir`·`certFile`·`ca`는 화면과 S1b 파일 선택에만 쓴다. 텔레메트리·모델·로그로 보내지 않는다(D05 §6 (5)). CA·cn은 비신뢰 문자열이니 `textContent`로만 표시한다.
- 비신뢰 위치(LocalLow)라 다음은 읽지 않고 `skipped`에 이유별 개수만 센다.
  - 디렉터리·파일 심볼릭 링크(`symlink`), 일반 파일이 아님(`not_file`), 0바이트(`empty`), 8KB(`NPKI_CERT_MAX_BYTES`) 초과(`too_large`)
  - 열거 뒤 바꿔치기(lstat과 연 파일의 dev·ino 불일치, `changed`), 하드링크(nlink>1, `linked`), 읽기 실패(`unreadable`)
  - CA 32·CA당 cn 64·전체 128 상한(`limit`), 이상한 CA 이름(`bad_name`)
- 로그는 `vault.npki_listed{roots, certs, skipped}` 개수뿐이다.
