# 푸시 디스패처 API(D14 M7-3)

내용 없는 깨우기(D08 §8.1, D09 §4.2). PC가 폰을 깨우면 폰은 알림을 받고 릴레이 우편함에 붙어 내용을 가져간다. 우편함 ID는 이 경로에 없다.

인증: 기기 범위 토큰 + DPoP(공통 [CONTRACT.md](../shared/CONTRACT.md)). 계정 세션 토큰은 `401 push.unauthorized`, 정지·폐기 기기는 `403 push.device_suspended`.

| 경로 | 역할·범위 | 본문 | 성공 | 오류 |
|---|---|---|---|---|
| `PUT /v1/push-token` | 모바일 `push` | `{platform: "apns"\|"fcm", token}`(APNs 소문자 hex 64~200자, FCM `[A-Za-z0-9_:-]` 32~4,096자) | `204` | 자기 기기 것만. `PUSH_TOKEN_KEY`로 봉인 저장 |
| `DELETE /v1/push-token` | 모바일 `push` | — | `204` | 앱 해제·알림 끄기 |
| `POST /v1/wake` | 데스크톱 `wake` | `{deviceId}` | `202 {sent: bool}` | 같은 계정의 **활성 폰**만. 다른 계정·없는 기기·데스크톱·정지 기기는 모두 `404 push.target_not_found`. 토큰이 없거나 공급사가 무효라고 하면 `404 push.token_not_found`(무효 토큰은 삭제). 기기당 분당 3회·시간당 20회 `429 policy.rate_limited`. 공급사 일시 장애는 `sent:false` |
| `POST /internal/v1/devices/:id/stopped` | 내부 | — | `200 {deleted}` | 계정 서비스의 긴급 정지·폐기 훅: 푸시 토큰 즉시 삭제 |

## 보내는 것(공급사 와이어는 [`src/senders.ts`](src/senders.ts) 한 곳)

| 공급사 | 형식 | 내용 |
|---|---|---|
| APNs(Apple Inc., 미국) | HTTP/2 `POST /3/device/{token}`, ES256 제공자 토큰, `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration: +60초`, `apns-collapse-id: sax-wake` | `{"aps":{"alert":{"loc-key":"SAX_WAKE"},"mutable-content":1}}` — 문구는 앱의 현지화 키, Notification Service Extension이 깨어나 우편함을 확인 |
| FCM(Google LLC, 미국) | HTTP v1 `messages:send`, 서비스 계정 JWT → OAuth 접근 토큰(캐시) | `{"message":{"token":…, "data":{"t":"wake"}, "android":{"priority":"HIGH","ttl":"60s","collapse_key":"sax-wake"}}}` |

공급사는 깨우기 시각과 일반 알림 문구(현지화 키)를 본다. 처리방침의 수탁·국외이전 기재 대상이다(D09 §4.2).
