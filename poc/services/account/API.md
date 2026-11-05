# 계정·구독 서비스 API(M4-5)

근거: D09 §2·§2.1·§2.2·§10, D08 §2.1·§9.4, ADR-029·034, B-28, C-09·C-30. 공통 형식(토큰·DPoP·서명 입력·오류 본문)은 [`../shared/CONTRACT.md`](../shared/CONTRACT.md). 요청 스키마는 `src/app.ts`의 `V`(ajv, `additionalProperties: false`)가 정본이고, 아래 표는 그 요약이다. 스키마 밖 필드·형식이 틀린 값은 모두 `400 request.param_rejected`.

인증 표기: **없음**, **세션**(`Authorization: Bearer sxs1.…`), **기기:범위**(`Authorization: DPoP sxd1.…` + `DPoP:` 증명, 그 범위가 토큰에 있어야 함), **내부**(`Authorization: Internal <INTERNAL_TOKEN>`).

공통 오류: `401 account.unauthorized`(세션·토큰 없음·만료·위조), `403 account.scope_denied`, `401 account.dpop_invalid`, `403 account.device_suspended`(정지·폐기·대기 기기), `429 policy.rate_limited`(+`Retry-After`), `413 request.too_large`(본문 64KB), `415 request.unsupported_media`(JSON만), `404 request.not_found`, `405 request.method_not_allowed`, `500 server.internal`.

## 로그인

| 메서드·경로 | 인증 | 요청 | 응답 | 오류·한도 |
|---|---|---|---|---|
| `POST /v1/auth/code` | 없음 | `{email}` | `200 {loginId, expiresInSec:600}` | 이메일당 5회/시, IP당 30회/시 |
| `POST /v1/auth/code/verify` | 없음 | `{loginId, code: 6자리}` | `200 {session, expiresInSec}` | `account.code_invalid`(틀림·만료·다른 loginId), 5회째 틀리면 `account.code_locked`(코드 폐기). IP당 60회/시. 첫 검증 때 계정 생성 |
| `POST /v1/auth/passkey/options` | 없음 | — | `200 {challenge, rpId, userVerification:"required", timeout}` | |
| `POST /v1/auth/passkey/verify` | 없음 | `{challenge, credentialId, clientDataJSON, authenticatorData, signature, userHandle?}`(b64u) | `200 {session, expiresInSec}` | `account.passkey_invalid`(origin·rpId·UV·카운터 되감기·챌린지 재사용/만료 5분) |
| `POST /v1/auth/logout` | 세션 | — | `204` | |

로그인 코드는 `loginId`(요청한 창에 결속)와 함께여야만 통한다. 서버는 코드 평문을 저장하지 않는다(HMAC).

## 데스크톱 루프백 + PKCE(RFC 8252)

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `POST /v1/oauth/authorize` | 세션(계정 웹) | `{client_id:"sax-desktop", redirect_uri, code_challenge(43자), code_challenge_method:"S256", state(16~128 b64u)}` | `200 {redirect}` = `redirect_uri?code=…&state=…` | `account.redirect_not_loopback`: `http://127.0.0.1:<1024~65535>` 또는 `http://[::1]:<포트>`만(localhost·https·외부 호스트 거부) |
| `POST /v1/oauth/token` | 없음 | `{grant_type:"authorization_code", code, code_verifier, redirect_uri, client_id}` | `200 {session, expiresInSec}` | `account.pkce_invalid`(검증자·주소·클라이언트 불일치, 60초 만료, 1회용: 틀린 시도에도 소진) |

디바이스 코드 플로우는 없다(D09 §2.2).

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
| `POST /v1/billing/checkout` | 세션 | — | `200 {checkoutUrl}` | 이미 활성이면 `400 request.param_rejected` |
| `GET /v1/billing/subscription` | 세션 | — | `200 {subscription: {plan:"standard", status, renewAt, amountKrw:9900, period:"month"} \| null}` | |
| `POST /v1/billing/cancel` | 세션 | — | `204` | |
| `POST /v1/billing/webhook` | PG 서명 | PG 원본 본문(16KB) | `200 {ok:true}` | `400 account.billing_signature_invalid`. 모의 PG: `x-mock-pg-signature` = HMAC-SHA256 hex. 상태 전이만 반영: 해지는 끝 상태(늦은 활성·갱신 이벤트 무시, 다시 구독은 checkout이 새 PG 참조로 연다), 갱신은 `renewAt`이 앞으로 갈 때만, 결제 실패는 active에서만 |

PG에는 무작위 `pgCustomerRef`만 넘기고 이메일을 주지 않는다. 결제 수단은 PG에만 있다. 이 저장소에는 모의 어댑터(`MockPaymentGateway`)만 있다.

## 기기(계정 세션)

| 메서드·경로 | 인증 | 요청 | 응답 | 오류 |
|---|---|---|---|---|
| `POST /v1/aik` | 세션 | `{aikPub, deviceList:{listVersion:1, entries:[자기 항목], revoked:[]}, platform:"windows"\|"macos", name}` | `201 {deviceId}` | `account.aik_already_pinned`, `account.aik_signature_invalid`. 계정당 1회, 알림 메일 |
| `GET /v1/devices` | 세션 또는 기기:devlist | — | `200 {devices:[{deviceId, role, platform, name, state, registeredAt, Sx, Vx, holdUntil, deleteAfter}]}` | |
| `POST /v1/devices/enroll` | 세션 | `{deviceId(uuid4), role, platform, name, Sx, Vx}` | `201 {holdUntil}` | 플랫폼·역할 불일치 400, `account.device_limit`(데스크톱 2·모바일 3, 폐기 제외), `account.device_churn_limit`(30일 추가 데스크톱 3·모바일 5), 이미 있는 기기 ID 400 |
| `POST /v1/devices/:id/activate` | 세션 | — | `204` | `423 account.device_hold`(+`Retry-After`): 이메일만으로 추가한 기기는 72시간 뒤. `account.not_pending`, `account.device_not_found` |
| `POST /v1/devices/:id/suspend` | 세션 | — | `204` | 긴급 정지. 즉시 릴레이·푸시 정지 훅 + 알림 메일 |
| `POST /v1/devices/:id/delete-request` | 세션 | — | `202 {deleteAfter}` | 7일 유예 + 알림 메일 |
| `POST /v1/devices/:id/delete-cancel` | 세션 | — | `204` | `account.device_not_found`(유예 중 아님). 폐기 유예(7일 미만 데스크톱의 폐기)도 여기서 취소된다 |
| `GET /v1/device-list` | 세션 또는 기기:devlist | — | `200 {aikPub, deviceList}` | 페어링 3단계(폰이 AIK 서명 목록 확인) |

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
| `GET /healthz` | 없음 | `200 {ok:true}` |

정지 훅(나가는 쪽): `POST <STOP_HOOK_URL>/internal/v1/devices/:id/stopped`, `Authorization: Internal <INTERNAL_TOKEN>`, 본문 없음.

## 주기 작업(60초)

만료 로그인 코드·인가 코드·패스키 챌린지·세션 삭제, 30일 지난 기기 교체 이력 삭제, 7일 지난 대기 기기 삭제, 삭제·폐기 유예가 끝난 기기 폐기(+정지 훅).
