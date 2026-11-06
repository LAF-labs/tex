# 릴레이 API(D14 M7-3)

내용을 볼 수 없는 우편함. 프로토콜·한도의 정본은 D08 §8(우편함)·§7(큐)·§4.2(페어링 룸)이고, 이 문서는 서버 경로와 형식만 적는다.

## 인증 두 겹

| 레이어 | 무엇 | 왜 |
|---|---|---|
| 기기 범위 토큰 | `Authorization: DPoP <token>` + `DPoP: <증명>`(`relay` 범위, 계정 서비스 발급, 공통 [CONTRACT.md](../shared/CONTRACT.md)) | 남용 방지·긴급 정지. 정지·폐기된 기기는 `403 relay.device_suspended`, 계정 세션 토큰은 `401 relay.unauthorized` |
| 우편함 능력 토큰 | `X-Mbx-Read: <tok_read>` / `X-Mbx-Write: <tok_write>`(32B base64url 43자) | 우편함 접근 권한. PC가 CSPRNG로 만들어 `PAIR_OK`로 폰에 준다(D08 §4.2 7단계). 서버는 SHA-256 해시만 저장 |

- 우편함 ID·토큰이 틀리거나 우편함이 없으면 모두 `404 relay.mailbox_not_found`(존재 오라클 없음). 실패는 IP(당일 솔트 HMAC, DB 카운터라 인스턴스 합산)당 10분 20회까지, 넘으면 맞는 토큰도 창이 끝날 때까지 `429 policy.rate_limited`.
- 서버는 두 레이어의 연결(어느 기기가 어느 우편함을 쓰는지)을 **저장하지 않는다**. 같은 요청에서 둘을 함께 보므로 운영자는 상관시킬 수 있다(정직한 서술, D08 §8).
- 쪽(side)은 토큰의 역할에서 정한다(데스크톱 `d`, 모바일 `m`). 클라이언트가 고르지 않는다.

## HTTP

| 경로 | 역할 | 우편함 토큰 | 본문 | 성공 | 오류 |
|---|---|---|---|---|---|
| `POST /v1/mailboxes` | 데스크톱 | — | `{mbxId, tokRead, tokWrite}`(서로 다른 32B base64url) | `201 {ok:true}` | `relay.mailbox_limit`(기기당 3), 중복·같은 값 `request.param_rejected` |
| `DELETE /v1/mailboxes/:id` | 데스크톱 | 쓰기 | — | `204` | 큐·번들도 삭제, 라이브 연결 종료(재발급 `mbx.reissue` 뒤 옛 우편함) |
| `POST /v1/mailboxes/:id/envelopes` | 모바일 | 쓰기 | `{v:1, kind:"ENV", enc, ct}`(intent-envelope 바깥 객체, `ct` ≤ 65,536자, 서버는 봉투 종류를 보지 않고 크기만 검사) | `202 {seq}` | `relay.queue_full`(우편함당 160건·6 MiB), 그 밖 필드 `request.param_rejected` |
| `GET /v1/mailboxes/:id/envelopes` | 데스크톱 | 읽기 | — | `200 {envelopes:[{seq, env}]}` | 만료(72시간)분은 빠진다. 사진 24시간은 봉투 안 서명된 `exp`로 PC가 집행(서버는 종류를 모른다) |
| `POST /v1/mailboxes/:id/ack` | 데스크톱 | 읽기 | `{seq}` | `200 {deleted}` | `seq` 이하 삭제(D08 §7 `ACK{seq}`) |
| `PUT /v1/mailboxes/:id/bundle` | 데스크톱 | 쓰기 | `{bundle: base64}`(≤ 2KB) | `204` | 우편함 번들 슬롯(`Vx` 서명 `{Qx, valid_from, valid_to, seq}`, 릴레이는 검증하지 않음) |
| `GET /v1/mailboxes/:id/bundle` | 둘 다 | 읽기 | — | `200 {bundle}` | 없으면 `relay.mailbox_not_found` |
| `POST /v1/rooms` | 데스크톱 | — | `{roomId}`(16B base64url 22자, QR의 `room_id`) | `201 {expiresAt}` | 계정당 시간당 5개 `policy.rate_limited`, 중복 `request.param_rejected` |
| `POST /internal/v1/devices/:id/stopped` | 내부(서명, [계정 API](../account/API.md) 인증 표기) | — | — | `200 {closed}` | 계정 서비스의 긴급 정지·폐기 훅: 그 기기의 라이브 연결을 즉시 끊는다 |
| `POST /internal/v1/queues/purge` | 내부 | — | — | `200 {deleted}` | 릴레이 침해 대응: 큐 전면 폐기(D09 §11) |
| `POST /internal/v1/rooms/:id/redeem` | 내부 | — | `{deviceId}`(등록하는 데스크톱) | `200 {ok:true}` | 계정 서비스의 폰 대리 등록(팀장 결정 2026-11-06). 그 데스크톱이 만든 룸이고, 정원 2가 한 번 찼고(폰이 붙음), 만료 전이고, 아직 쓰지 않았으면 한 번만 소비한다(룸은 닫지 않는다). 이미 쓴 룸이면 `409 relay.room_used`(그 PC에만 보인다). 그 밖은 모두 `404 relay.room_unavailable` |

## WSS

### 라이브 우편함 `GET /v1/mailboxes/:id/live`(Upgrade)

헤더: 기기 범위 토큰 + DPoP(`GET`, `htu = origin + 경로`) + `X-Mbx-Read` + `X-Mbx-Write`. 하나라도 틀리면 업그레이드 전에 `{error}`로 거절한다.

- 쪽마다 연결 하나. 같은 쪽 새 연결이 옛 연결을 닫는다(close `4002`).
- **바이너리 프레임** = D08 §6 바깥 프레임 그대로: `ver(1B)=1 ‖ kind(1B) ‖ ctr(8B, DATA만) ‖ len(2B) ‖ 암호문`. `kind` HS=1, DATA=2만 받는다(ENV는 HTTP 큐 경로). `len`이 실제 길이와 같아야 한다. 맞으면 상대 쪽에 바이트 그대로 전달, 상대가 없으면 드롭(프로토콜이 재전송).
- 프레임 ≤ 65,535B(넘으면 close `1009`), 조각 프레임 없음, 우편함당 초당 20개(초과분 드롭), 형식이 틀린 프레임·텍스트 프레임 5번이면 close `1008`, 120초 무통신이면 종료(클라이언트 30초 ping).
- 서버 → 클라이언트 **텍스트 프레임**(제어, 내용 없음): `{"t":"peer","online":bool}`(상대 연결 여부), `{"t":"env"}`(데스크톱에게: 큐에 봉투가 있음 → HTTP로 꺼낸다).
- 기기 범위 토큰 만료(15분) 때 서버가 끊는다(close `4001`). 재연결 때 다시 인증하므로 정지·폐기가 늦어도 토큰 수명 안에 반영되고, 정지 훅이 오면 즉시 끊는다.

### 페어링 룸 `GET /v1/rooms/:roomId`(Upgrade)

인증 없음(폰은 아직 기기 토큰이 없다, D08 §4.2). `room_id`(16B 난수, QR로만 전달)를 아는 두 연결만.

- 정원 2, 발급 후 120초 안에만 참가, 1회용: 한쪽이 나가면 룸을 폐기하고 다른 쪽도 끊는다. 120초가 지나면 연결도 끊는다.
- 바이너리 프레임 규칙은 라이브 우편함과 같다(HS·DATA, Noise 핸드셰이크·전송).
- 룸 레코드는 메모리에만 있고 계정이 없다. 룸과 그 뒤 만들어지는 영구 우편함의 연관은 기록하지 않는다.
- 폰 대리 등록용으로 룸을 만든 데스크톱 기기 ID의 sha256, 정원이 찼는지, 등록에 썼는지만 같은 메모리 레코드에 둔다(룸이 폐기되면 함께 사라진다). 그래서 PC는 **룸이 열려 있는 동안**, 즉 7단계에서 `PAIR_OK`를 보내기 전에 `POST /v1/devices/enroll`을 부른다.

## 오류 코드

`relay.unauthorized`(401), `relay.device_suspended`(403), `relay.mailbox_not_found`(404), `relay.room_unavailable`(404, 업그레이드 거절), `relay.mailbox_limit`(409), `relay.queue_full`(429), `policy.rate_limited`(429, `Retry-After`), `account.scope_denied`(403, 역할·범위 불일치), `request.param_rejected`(400). 본문은 `{"error": "<코드>"}`만. 프로토콜 오류(`replay_detected` 등)는 로컬 UI 전용이라 서버가 보내지 않는다(D08 §6).
