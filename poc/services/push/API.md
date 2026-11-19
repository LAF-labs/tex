# 푸시 디스패처 API(D14 M7-3)

내용 없는 깨우기(D08 §8.1, D09 §4.2, ADR-053). PC가 폰을 깨우면 폰에 종류별 고정 글 알림이 뜨고, 사장님이 누르면 앱이 PC와 종단간 세션을 붙여 내용을 받는다. 승인은 푸시로 하지 않는다(ADR-052 그대로). 우편함 ID는 이 경로에 없다.

인증: 기기 범위 토큰 + DPoP(공통 [CONTRACT.md](../shared/CONTRACT.md)). 계정 세션 토큰은 `401 push.unauthorized`, 정지·폐기 기기는 `403 push.device_suspended`.

| 경로 | 역할·범위 | 본문 | 성공 | 오류 |
|---|---|---|---|---|
| `PUT /v1/push-token` | 모바일 `push` | `{platform: "apns"\|"apns_dev"\|"fcm", token}`(APNs 소문자 hex 64~200자, FCM `[A-Za-z0-9_:-]` 32~4,096자). `apns_dev`는 개발 빌드(Apple 샌드박스), `apns`는 TestFlight·스토어 빌드 | `204` | 자기 기기 것만. `PUSH_TOKEN_KEY`로 봉인 저장 |
| `DELETE /v1/push-token` | 모바일 `push` | — | `204` | 앱 해제·알림 끄기 |
| `POST /v1/wake` | 데스크톱 `wake` | `{deviceId, kind?}`. `kind`는 `approve`\|`update`(없으면 `update`). 그 밖 칸은 `400` | `202 {sent: bool}` | 같은 계정의 **활성 폰**만. 다른 계정·없는 기기·데스크톱·정지 기기는 모두 `404 push.target_not_found`. 토큰이 없거나 공급사가 무효라고 하면 `404 push.token_not_found`(무효 토큰은 삭제). 기기당 분당 3회·시간당 20회 `429 policy.rate_limited`. 공급사 일시 장애는 `sent:false` |
| `POST /internal/v1/devices/:id/stopped` | 내부 | — | `200 {deleted}` | 계정 서비스의 긴급 정지·폐기 훅: 푸시 토큰 즉시 삭제 |

## 보내는 것(공급사 와이어는 [`src/senders.ts`](src/senders.ts) 한 곳)

| 공급사 | 형식 | 내용 |
|---|---|---|
| APNs(Apple Inc., 미국) | HTTP/2 `POST /3/device/{token}`, ES256 제공자 토큰, `apns-push-type: alert`, `apns-priority: 10`, `apns-expiration`·`apns-collapse-id`는 아래 종류 표. 주소는 토큰 플랫폼으로: `apns_dev` → `api.sandbox.push.apple.com`, `apns` → `api.push.apple.com`(`PUSH_PROVIDER=apns`일 때만) | `{"aps":{"alert":{"loc-key":"SAX_WAKE_APPROVE"},"sound":"default"}}` — 문구는 앱 번들의 현지화 키. Notification Service Extension 없음(`mutable-content` 없음, ADR-053 결정 6) |
| FCM(Google LLC, 미국) | HTTP v1 `messages:send`, 서비스 계정 JWT → OAuth 접근 토큰(캐시). `FCM_PROJECT_ID`가 있을 때만 | `{"message":{"token":…, "data":{"t":"wake","k":"update"}, "android":{"priority":"HIGH","ttl":"43200s","collapse_key":"sax-wake-update"}}}` |

| 종류 | 현지화 키 | 앱 글 | 유효 시간 | 접힘 ID |
|---|---|---|---|---|
| `approve` | `SAX_WAKE_APPROVE` | 승인을 기다리는 발급이 있어요 | 10분(승인 게이트가 열려 있는 시간) | `sax-wake-approve` |
| `update` | `SAX_WAKE_UPDATE` | 맡긴 일에 새 소식이 있어요 | 12시간 | `sax-wake-update` |

종류는 저장하지 않는다. 서버는 글을 보내지 않는다(글은 앱 번들에 있다).

공급사는 깨우기 시각과 종류(현지화 키)를 본다. 거래처·금액·계정·어느 PC인지는 보지 않는다. 처리방침의 수탁·국외이전 기재 대상이다(D09 §4.2).
