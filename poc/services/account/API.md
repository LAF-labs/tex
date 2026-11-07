# 계정·구독 서비스 API(M4-5)

근거: D09 §2·§2.1·§2.2·§10, D08 §2.1·§9.4, ADR-029·034·038, B-28, C-09·C-30. 공통 형식(토큰·DPoP·서명 입력·오류 본문)은 [`../shared/CONTRACT.md`](../shared/CONTRACT.md). 요청 스키마는 `src/app.ts`의 `V`(ajv, `additionalProperties: false`)가 정본이고, 아래 표는 그 요약이다. 스키마 밖 필드·형식이 틀린 값은 모두 `400 request.param_rejected`.

인증 표기: **없음**, **세션**(`Authorization: Bearer sxs1.…`), **기기:범위**(`Authorization: DPoP sxd1.…` + `DPoP:` 증명, 그 범위가 토큰에 있어야 함), **내부**(`Authorization: SAX-Internal ts=…,nonce=…,sig=…`, `INTERNAL_CALL_KEY` HMAC-SHA256 over `SAX-internal-call-v1`‖메서드‖경로(쿼리 포함)‖sha256hex(본문)‖ts‖nonce, 줄바꿈 구분. 시각 ±60초, nonce 1회용(DB), 실패는 모두 `401 account.unauthorized`. 팀장 결정 2026-11-06 #135).

공통 오류: `401 account.unauthorized`(세션·토큰 없음·만료·위조), `403 account.scope_denied`, `401 account.dpop_invalid`, `403 account.device_suspended`(정지·폐기·대기 기기), `429 policy.rate_limited`(+`Retry-After`), `413 request.too_large`(본문 64KB), `415 request.unsupported_media`(JSON만), `404 request.not_found`, `405 request.method_not_allowed`, `500 server.internal`.

## 로그인

| 메서드·경로 | 인증 | 요청 | 응답 | 오류·한도 |
|---|---|---|---|---|
| `POST /v1/auth/code` | 없음 | `{email}` | `200 {loginId, expiresInSec:600}` | 이메일당 5회/시, IP당 30회/시 |
| `POST /v1/auth/code/verify` | 없음 | `{loginId, code: 6자리, remember?}` | `200 {session, expiresInSec:3600, refreshToken?, refreshExpiresInSec?}` | `account.code_invalid`(틀림·만료·다른 loginId), 5회째 틀리면 `account.code_locked`(코드 폐기). IP당 60회/시. 첫 검증 때 계정 생성 |
| `POST /v1/auth/passkey/options` | 없음 | — | `200 {challenge, rpId, userVerification:"required", timeout}` | |
| `POST /v1/auth/passkey/verify` | 없음 | `{challenge, credentialId, clientDataJSON, authenticatorData, signature, userHandle?}`(b64u), `remember?` | `200 {session, expiresInSec, refreshToken?, refreshExpiresInSec?}` | `account.passkey_invalid`(origin·rpId·UV·카운터 되감기·챌린지 재사용/만료 5분) |
| `POST /v1/auth/logout` | 세션 | — | `204` | |
| `POST /v1/auth/logout-all` | 세션 | — | `204` | [모든 기기에서 로그아웃]: 계정 세션·갱신 토큰 전부(이 세션 포함). 기기 범위 토큰·기기 등록은 그대로 |

세션(`sxs1.`)은 1시간이다. `remember: true`면 갱신 토큰(`sxa1.`)을 함께 준다(아래 자동 로그인).

로그인 코드는 `loginId`(요청한 창에 결속)와 함께여야만 통한다. 서버는 코드 평문을 저장하지 않는다(HMAC).

## 데스크톱 루프백 + PKCE(RFC 8252)

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `POST /v1/oauth/authorize` | 세션(계정 웹) | `{client_id:"sax-desktop", redirect_uri, code_challenge(43자), code_challenge_method:"S256", state(16~128 b64u)}` | `200 {redirect}` = `redirect_uri?code=…&state=…` | `account.redirect_not_loopback`: `http://127.0.0.1:<1024~65535>` 또는 `http://[::1]:<포트>`만(localhost·https·외부 호스트 거부) |
| `POST /v1/oauth/token` | 없음 | `{grant_type:"authorization_code", code, code_verifier, redirect_uri, client_id, remember?}` | `200 {session, expiresInSec, refreshToken?, refreshExpiresInSec?}` | `account.pkce_invalid`(검증자·주소·클라이언트 불일치, 60초 만료, 1회용: 틀린 시도에도 소진) |

교환으로 받은 세션은 원래 세션의 로그인 방식과 **인증 시각**을 잇는다(교환으로 "최근 로그인"을 새로 만들지 않는다).

디바이스 코드 플로우는 없다(D09 §2.2).

## 비밀번호(ADR-038, 선택)

`PASSWORD_PEPPER_KEYS`가 없거나 런타임에 argon2id가 없으면 이 절의 경로는 모두 `404 request.not_found`이고, 다른 로그인은 그대로다.

| 메서드·경로 | 인증 | 요청 | 응답 | 오류·한도 |
|---|---|---|---|---|
| `POST /v1/auth/password` | 없음 | `{email, password, remember?}` | `200 {session, expiresInSec, refreshToken?, refreshExpiresInSec?}` | `401 account.credentials_invalid`: 이메일 없음·비밀번호 없음·틀림·잠금·정지 계정 **모두 같은 본문**이고 모두 argon2id를 한 번 돈 뒤(없으면 더미) 응답 시각 하한 700ms에 맞춘다. IP당 60회/시(`auth-ip`, 코드·패스키와 같은 창). 해시 대기 줄이 차면 `429 policy.rate_limited`(`Retry-After: 1`) |
| `PUT /v1/password` | 세션(최근 10분 안의 코드·패스키·비밀번호 로그인) | `{password}` | `204` + 알림 메일 `password_set` | `403 account.reauth_required`(갱신 세션이거나 인증 뒤 10분 지남), `400 account.password_too_short`·`password_too_long`(NFKC 뒤 코드 포인트 10~128), `account.password_contains_identity`(이메일 전체·로컬 부분 3자 이상·서비스명), `account.password_breached`(로컬 흔한·유출 목록) |
| `DELETE /v1/password` | 세션(위와 같음) | — | `204` | 해시·잠금 행 삭제 |
| `POST /v1/auth/password/reset` | 없음 | `{email}` | `200 {resetId, expiresInSec:600}` | 계정이 있을 때만 메일(6자리)을 보내지만 응답은 같고 시각 하한도 같다. 이메일당 5회/시, IP당 30회/시 |
| `POST /v1/auth/password/reset/verify` | 없음 | `{resetId, code, password, remember?}` | `200 {session, expiresInSec, refreshToken?, …}` | `account.code_invalid`(틀림·만료·다른 resetId·이미 씀), 5회째 틀리면 `account.code_locked`(코드 폐기). 정책 오류(위)는 코드를 남긴다. 성공하면 잠금 해제, **그 계정의 다른 세션·갱신 토큰 전부 폐기**, 알림 메일 `password_reset`. 금고·기기 키·기기 목록·기기 범위 토큰은 건드리지 않는다 |

- 해시: argon2id(m=64MiB, t=3, p=1, 솔트 16B, 출력 32B) over HMAC-SHA256(페퍼, utf8(NFKC(비밀번호))). 매개변수 문자열(`a2id-v1:m65536:t3:p1:k<kid>`)에 페퍼 키 ID가 있고, 현재와 다르면 로그인 성공 때 다시 해시한다.
- 잠금: 계정당 연속 5회 실패면 15분 × 2^단계(상한 24시간), 잠금마다 알림 메일 `password_locked` 1회. 잠금 중에는 맞아도 같은 실패이고 실패 수도 쌓지 않는다. 잠금은 비밀번호만 막는다(코드·패스키 로그인은 그대로). 잠금이 끝나고 하루 동안 실패가 없으면 단계를 지운다.
- 패스키가 있는 계정에서 비밀번호 세션은 패스키 세션이 아니다(기기 추가 등은 `account.passkey_required`, D09 §2.2).

## 자동 로그인: 갱신 토큰(ADR-038 (f))

| 메서드·경로 | 인증 | 요청 | 응답 | 오류·한도 |
|---|---|---|---|---|
| `POST /v1/auth/refresh` | 없음 | `{refreshToken: "sxa1.…"}` | `200 {session, expiresInSec, refreshToken, refreshExpiresInSec}` | 실패는 이유를 가르지 않고 `401 account.unauthorized`. IP당 60회/시(`refresh-ip`) |
| `POST /v1/auth/refresh/revoke` | 없음 | `{refreshToken}` | `204`(없는 토큰도) | [로그인 상태 유지 끄기]: 그 토큰의 회전 계보 전체 폐기 |

- 쓸 때마다 회전한다(새 토큰을 주고 이전 토큰은 "회전됨"). **회전된 토큰이 다시 오면 복제로 보고 그 계정의 세션·갱신 토큰을 모두 폐기**하고 알림 메일 `sessions_revoked`를 보낸다.
- 30일 미사용 만료(회전마다 새로 30일). 서버는 sha256만 저장한다.
- 갱신으로 받은 세션의 방식은 `refresh`다(최근 로그인·패스키 세션으로 치지 않는다).

## 패스키 등록

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `POST /v1/passkeys/options` | 세션 | — | `200 {challenge, rp, user, pubKeyCredParams(ES256·EdDSA), attestation:"none", authenticatorSelection, excludeCredentials, timeout}` | |
| `POST /v1/passkeys` | 세션 | `{challenge, clientDataJSON, attestationObject}` | `201 {credentialId}` | `account.passkey_invalid`(fmt none 아님, UV 없음, 챌린지 재사용) |

패스키가 하나라도 있는 계정은 기기 추가(`/v1/aik`, `/v1/devices/enroll`)에 패스키 세션이 필요하다(`403 account.passkey_required`).

## 계정·동의

| 메서드·경로 | 인증 | 요청 | 응답 |
|---|---|---|---|
| `GET /v1/me` | 세션 | — | `200 {email, status, aikPinned, slotsUsed, hasBizProfile, passkeys, subscription, consents[], authMethod}` |
| `POST /v1/consents` | 세션 | `{version}` | `204` |

## 구독(9,900원 한 플랜, ADR-034)

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `POST /v1/billing/checkout` | 세션 | — | `200 {checkoutUrl}` | 이미 활성이면 `400 request.param_rejected`. pending·past_due는 같은 PG 참조로 다시(동시 클릭도 같은 참조), 해지 뒤는 새 참조 |
| `GET /v1/billing/subscription` | 세션 | — | `200 {subscription: {plan:"standard", status, renewAt, amountKrw:9900, period:"month"} \| null}` | |
| `POST /v1/billing/cancel` | 세션 | — | `204` | |
| `POST /v1/billing/webhook` | PG 서명 | PG 원본 본문(16KB) | `200 {ok:true}` | `400 account.billing_signature_invalid`. 모의 PG: `x-mock-pg-signature` = HMAC-SHA256 hex. 이벤트에 PG 쪽 시각 `at`(필수, 서명 범위 안)이 있고 마지막으로 반영한 이벤트보다 늦은 것만 반영(늦게 온·재전송 이벤트 무시). 해지는 끝 상태(다시 구독은 checkout이 새 PG 참조로 연다), 결제 실패는 active에서만 |

PG에는 무작위 `pgCustomerRef`만 넘기고 이메일을 주지 않는다. 결제 수단은 PG에만 있다. 이 저장소에는 모의 어댑터(`MockPaymentGateway`)만 있다.

## 기기(계정 세션)

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `POST /v1/aik` | 세션 | `{aikPub, deviceList:{listVersion:1, entries:[자기 항목], revoked:[]}, platform:"windows"\|"macos", name}` | `201 {deviceId}` | `account.aik_already_pinned`, `account.aik_signature_invalid`. 계정당 1회, 알림 메일 |
| `GET /v1/devices` | 세션 또는 기기:devlist | — | `200 {devices:[{deviceId, role, platform, name, state, registeredAt, Sx, Vx, holdUntil, deleteAfter}]}` | |
| `POST /v1/devices/enroll` | 세션 | `{deviceId(uuid4), role, platform, name, Sx, Vx}` | `201 {holdUntil}` | 플랫폼·역할 불일치 400, `account.device_limit`(데스크톱 2·모바일 3, 폐기 제외), `account.device_churn_limit`(30일 추가 데스크톱 3·모바일 5), 이미 있는 기기 ID 400 |
| `POST /v1/devices/enroll`(폰 대리 등록) | 데스크톱 기기:devlist | `{deviceId(uuid4), role:"mobile", platform:"ios"\|"android", name, Sx, Vx, roomId}` | `201 {holdUntil}`, 재등록 `200 {holdUntil, state}` | 폰 앱에는 계정 로그인이 없어서 페어링 7단계에서 PC가 대신 등록한다(팀장 결정 2026-11-06, D08 §4.2). `roomId`는 그 PC가 `POST /v1/rooms`로 만들고 폰이 실제로 붙은(정원 2가 찬) 1회용 룸이어야 하고, 등록에 한 번만 쓸 수 있다(릴레이 `/internal/v1/rooms/:id/redeem`). 룸이 없음·만료·미페어링·다른 PC는 모두 `404 relay.room_unavailable`, 그 PC의 룸이 이미 등록에 쓰였으면 `409 relay.room_used`. 폰 토큰 403 `account.scope_denied`. 상한·교체 한도는 세션 경로와 같고 룸을 소비하기 전에 본다. 등록된 폰은 pending이고 같은 PC의 `PUT /v1/device-list`로 활성이 된다. **재등록은 멱등이다**(팀장 결정 2026-11-06): 같은 계정·같은 `deviceId`·같은 `Sx`·`Vx`의 pending/active 폰이면 `200 {holdUntil(pending일 때만, 아니면 null), state}`로 기존 기록을 돌려준다. 이때 상한·교체 한도에 다시 넣지 않고 알림도 없다. **룸 하나에 enroll 성공은 한 번**이다. 200도 룸을 사용됨으로 표시한다(룸은 `PAIR_OK`까지 그대로 열려 있다). 같은 룸의 두 번째 enroll은 키와 무관하게 `409 relay.room_used`다. 같은 `deviceId`인데 키·계정이 다르거나 정지·폐기된 기록이면 `400 request.param_rejected`(룸 소비 전)이고, 폐기 뒤 새 기기 ID로 등록한다. `RELAY_INTERNAL_URL`이 없으면 이 경로는 닫힌다(404) |
| `POST /v1/devices/:id/activate` | 세션 | — | `204` | `423 account.device_hold`(+`Retry-After`): 이메일만으로 추가한 기기는 72시간 뒤. `account.not_pending`, `account.device_not_found` |
| `POST /v1/devices/:id/suspend` | 세션 | — | `204` | 긴급 정지. 즉시 릴레이·푸시 정지 훅 + 알림 메일 |
| `POST /v1/devices/:id/delete-request` | 세션 | — | `202 {deleteAfter}` | 7일 유예 + 알림 메일 |
| `POST /v1/devices/:id/delete-cancel` | 세션 | — | `204` | `account.device_not_found`(유예 중 아님). 폐기 유예(7일 미만 데스크톱의 폐기)도 여기서 취소된다 |
| `GET /v1/device-list` | 세션 또는 기기:devlist | — | `200 {aikPub, deviceList}` | 페어링 3단계(폰이 AIK 서명 목록 확인) |
| `GET /v1/acct-claim` | 데스크톱 기기:devlist | — | `200 {claim:{account_id, email, aik_pub, iat, exp}, sig}` | 서버 서명 계정 클레임(D08 §4.2 7단계, 팀장 결정 2026-11-06). PC가 받아 `PAIR_OK`에 싣고, 폰은 앱에 고정한 공개키로 검증하고 `aik_pub`가 `PAIR_OK`의 `AIK_pub`와 같은지 본다. 서명 입력은 `utf8("SAX-acct-claim-v1")‖JCS(claim)`([CONTRACT §11](../shared/CONTRACT.md)). `email`은 전체(소문자 정규화)이고 가림은 폰 화면에서 한다. `exp = iat + 10분`(밀리초). 클레임은 언제나 토큰 계정의 것이다. 폰 토큰 `403 account.scope_denied`, 정지된 PC `403 account.device_suspended`, AIK 미고정 `409 account.aik_not_pinned`, 기기당 30회/시. `ACCT_CLAIM_SIGNING_KEY`가 없으면 `404` |

등록 신청한 기기는 `pending`이다. 활성화 경로는 둘: 기존 데스크톱이 AIK 서명 목록에 넣는다(즉시), 또는 72시간 뒤 `activate`. 어느 쪽이든 기기 범위 토큰은 AIK 인증서가 있어야 발급되므로 AIK 없이 이메일만 탈취한 공격자는 토큰을 얻지 못한다.

## 기기(데스크톱 기기 범위 토큰 + AIK 서명)

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `PUT /v1/device-list` | 기기:devlist | `{deviceList:{listVersion, entries:[{entry, aikSig}], revoked:[{device_id, revoked_at, aikSig}]}}` | `200 {listVersion}` | `account.aik_not_pinned`, `account.list_version_stale`(저장된 버전 이하), `account.aik_signature_invalid`, 새 항목 키가 등록 신청과 다르면 400, 활성·정지 기기를 폐기 레코드 없이 빼면 400 |
| `POST /v1/devices/:id/reactivate` | 기기:acct_op | `{op:{op:"device.reactivate", account_id, target:<id>, ts}, aikSig}` | `204` | `account.aik_signature_invalid`(서명·대상·±5분) |

폐기: 목록을 올린 데스크톱이 등록 7일 미만이면 폐기는 7일 뒤(유예 중 계정 웹에서 정지 가능), 7일 이상이면 즉시. 유예는 처음 폐기 레코드가 들어온 때부터 세고 목록을 다시 올려도 다시 시작하지 않는다. 폐기되면 정지 훅이 나간다.

## 기기 범위 토큰

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `POST /v1/device-tokens` | DPoP(Vx, `ath = b64u(sha256(JCS(cert)))`) | `{cert:{cert:{device_id, role, Sx, Vx, Kx?, Px?, not_after}, aikSig}}` | `200 {token, expiresAt, scopes}` | `account.cert_invalid`(AIK 서명·만료·91일 초과·키 불일치), `account.device_suspended`, IP당 600회/시(검증 전), 기기당 60회/시(인증서·DPoP 검증 통과 뒤에만 셈) |

## 프로필 슬롯·사업자 HMAC(B-28, C-09)

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `POST /v1/slots` | 기기:slots | — | `201 {slotToken}` | `account.slot_limit`(계정당 2: 개인 1 + 법인 1) |
| `GET /v1/slots` | 세션 또는 기기:devlist | — | `200 {slots:[{slotToken, bound}]}` | |
| `PUT /v1/slots/:slot/biz` | 기기:slots | `{bizHmac: hex32, rkOp?}` | `200 {changed}` | `account.rebind_too_soon`(마지막 바인딩 변경에서 90일 전), `account.slot_not_found` |
| `DELETE /v1/slots/:slot` | 기기:slots | — | `204` | 바인딩된 슬롯 삭제도 "바인딩 변경"으로 세어 삭제로 90일 규칙을 피할 수 없다 |

서버는 슬롯의 종류(개인·법인)를 모른다. 개수만 강제하고 종류 판정은 클라이언트가 한다(C-09).

## 내부

| 메서드·경로 | 인증 | 응답 |
|---|---|---|
| `GET /internal/v1/devices/:id` | 내부 | `200 {accountId, deviceId, role, state}` / `404 account.device_not_found` |
| `POST /internal/v1/devices/:id/auto-suspend` | 내부 | `200 {suspended}`. 게이트웨이 자동 정지(D09 §3): 활성 기기만 정지 + 정지 훅 + 알림 메일 `device_auto_suspended`. 해제는 AIK 서명 재활성화뿐 |
| `GET /healthz` | 없음 | `200 {ok:true}` |

정지 훅(나가는 쪽): `POST <STOP_HOOK_URL>/internal/v1/devices/:id/stopped`, 내부 서명(위 표기), 본문 없음. 같은 배포 안의 서비스는 HTTP 없이 함수로 부른다(`@sax/svc-cloud`).

## 주기 작업(60초)

만료 로그인 코드·인가 코드·패스키 챌린지·세션·갱신 토큰·재설정 코드 삭제, 하루 조용한 비밀번호 잠금 행 삭제, argon2id 실측 이벤트(한 시간에 한 번, `account.argon2_probe_ms`·`account.argon2_probe_rss_mb`, 수치만), 30일 지난 기기 교체 이력 삭제, 7일 지난 대기 기기 삭제, 삭제·폐기 유예가 끝난 기기 폐기(+정지 훅).
