# 푸시 디스패처(D14 M7-3)

`POST /v1/wake`: PC가 같은 계정의 폰을 내용 없이 깨운다. API는 [API.md](API.md), 환경 변수는 [ENV.md](ENV.md).

**침해되면 무엇이 새는가**(D09 §1): `device_id` ↔ 봉인된 푸시 토큰. `PUSH_TOKEN_KEY`까지 새면 푸시 토큰 원문(공격자가 그 폰에 알림을 보낼 수 있다 = 알림 스팸, 내용 유출은 없다). 우편함 ID·계정·알림 내용·깨우기 이력은 저장하지 않는다. 대응: 키 회전 + 폰 앱의 토큰 재등록.

## 저장 컬럼 ↔ D09 §1.1 "푸시 디스패처"

| 테이블 | 컬럼 | D09 §1.1 항목 |
|---|---|---|
| push_tokens | device_id, platform, sealed_token | `device_id`↔푸시 토큰(별도 키로 봉인) |
| lim_salts | label, day, salt | 한도 키 솔트(KST 당일 행만, 다음 날 삭제). 공용 마이그레이션 `shared/migrations` |
| lim_windows | k, start_ms, n, expires_at | 한도 창(키는 HMAC만: IP·이메일은 당일 솔트, 계정·기기 ID는 서버 비밀. 창이 끝나면 sweep 삭제) |
| int_nonces | nonce, expires_at | 내부 호출 서명의 1회용 무작위 값(요청 내용·출처 없음). 서명 시각 + 60초 뒤 삭제 |

D09 §1.1의 "깨우기 시각"은 이력으로 저장하지 않는다(더 엄격). 깨우기 한도 창(분·시간, 키는 대상 기기 ID의 서버 비밀 HMAC)에 창 시작 시각과 횟수만 창이 끝날 때까지(최대 1시간) 남는다. 접근 로그에는 라우트 패턴·상태·지연만 있고 계정 식별자(`aid`)도 남기지 않는다.

## 공급사 중립(ADR-015)·Phase 1

- `MockPushSender`(기본), `ApnsSender`(HTTP/2, 기본 주소 샌드박스, 운영 주소면 기동 거부), `FcmSender`(HTTP v1). 실제 푸시 발송은 Phase 1에서 하지 않는다(절대 규칙 ⑥). 시험은 APNs를 로컬 HTTP/2 서버로, FCM을 주입한 fetch로 확인한다.
- 국내 푸시 공급사로 옮겨도 iOS·Android OS 푸시 경로(APNs·FCM)는 남는다(D09 §4.2).

## 실행

```bash
cd poc && pnpm build
SAX_SQLITE_FILE=push.db PUSH_TOKEN_KEY=… LIMIT_ID_KEY=… PUSH_PUBLIC_ORIGIN=https://push.example TOKEN_PUBLIC_KEYS=k1:… ACCOUNT_INTERNAL_URL=http://account:8080 INTERNAL_CALL_KEY=… node services/push/dist/main.js
```

컨테이너: `docker build -f services/push/Dockerfile .`(빌드 컨텍스트 `poc/`). 실제 배포는 Phase 1 범위 밖이다.
