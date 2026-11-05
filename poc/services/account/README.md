# 계정·구독 서비스(D14 M4-5)

로그인(이메일 6자리 코드·패스키·데스크톱 루프백 PKCE), 구독(9,900원 한 플랜, ADR-034), 기기(AIK 고정·AIK 서명 기기 목록·긴급 정지·삭제 유예·기기 범위 토큰), 프로필 슬롯·사업자 HMAC 재바인딩(B-28)을 맡는다. API는 [API.md](API.md), 환경 변수는 [ENV.md](ENV.md), 공통 형식은 [../shared/CONTRACT.md](../shared/CONTRACT.md).

**침해되면 무엇이 새는가**(D09 §1): 이메일, 기기 목록(이름·플랫폼·공개키), 구독 상태, 슬롯 수와 사업자 프로필 유무(HMAC), 동의 이력, 패스키 공개키. 대화 본문·화면 텍스트·비밀·사업자번호 평문·결제 수단·IP는 이 서비스에 없다. 사업자 HMAC 키는 클라이언트의 RK에서 파생되어 서버에 없으므로 HMAC으로 사업자번호를 되찾을 수 없다(서버는 열쇠를 갖지 않는다, ADR-029).

## 저장 컬럼 ↔ D09 §1.1 운영자 가시성

`tests/services-account.test.ts`가 `migrations/*.sql`의 실제 컬럼과 `src/visibility.ts`가 같은지, 금지 컬럼 이름이 없는지 시험한다. "D09 추가 필요"는 §1.1 표에 아직 행이 없는 항목이다(팀장에게 표 수정 제안).

| 테이블 | 컬럼 | D09 §1.1 항목 |
|---|---|---|
| accounts | id, email, status, created_at, last_login_at | 계정·이메일·상태·가입·로그인 시각 |
| accounts | aik_pub, aik_pinned_at, device_list_version, device_list_json | AIK_pub, 기기 목록(AIK 서명) |
| accounts | last_biz_change_at | **D09 추가 필요**: 사업자 HMAC 재바인딩 시각(90일 규칙) |
| sessions | token_hash, account_id, auth_method, created_at, expires_at | 세션(토큰 해시만) |
| login_codes | login_id_hash, email, code_mac, attempts, expires_at | 이메일 발송(코드는 HMAC만, 10분) |
| oauth_codes | code_hash, account_id, auth_method, client_id, redirect_uri, code_challenge, expires_at | 루프백 인가 코드(해시, 60초) |
| passkeys | credential_id, account_id, public_key, alg, sign_count, created_at | **D09 추가 필요**: 패스키 공개키·카운터 |
| webauthn_challenges | challenge_hash, account_id, kind, expires_at | 패스키 챌린지(해시, 5분) |
| devices | device_id, account_id, role, platform, name, sx, vx, registered_at, attest_signal, state, email_hold_until, delete_after, revoke_record | 기기 목록, 상태, 72시간 대기, 7일 삭제 유예 |
| device_events | account_id, role, kind, day | 기기 교체 이력(KST 일 단위, 30일) |
| profile_slots | slot_token, account_id, biz_hmac | 프로필 슬롯 수, 사업자 프로필 HMAC 존재 |
| profile_slots | biz_bound_at | **D09 추가 필요**: 바인딩 시각(D09 §2 B-28에는 있음) |
| subscriptions | account_id, plan, status, period, renew_at, pg_customer_ref, pg_event_at | 구독 플랜·상태·갱신일·결제 참조 ID, **추가 필요**: 마지막 반영 PG 이벤트 시각(PG 쪽 시각, 웹훅 순서 판정) |
| consents | account_id, version, at | 동의 이력 |

저장하지 않는 것: IP(한도 키는 일 회전 HMAC, 메모리만), 로그인 코드 평문, 사업자번호, 결제 수단, 접근 로그의 본문·경로 변수 값.

## 어댑터(ADR-015: 공급사 종속 코드는 한 곳)

- 결제: `PaymentGateway`(`src/adapters.ts`). 이 저장소에는 `MockPaymentGateway`만 있다. 실제 PG 어댑터와 자격 증명은 저장소 밖(배포 시 주입)이다.
- 메일: `MailSender`. 이 저장소에는 `MockMailSender`만 있다(국내 발송 사업자 어댑터는 같은 인터페이스로 붙인다). 계정 서버의 "서버 메일 경로"(ADR-034 결정 10)는 구현하지 않는다. 로그인 코드·보안 알림만 보낸다.
- 정지 훅: `DeviceStopHook`. 운영은 내부 HTTP(`STOP_HOOK_URLS`).

## 실행

```bash
cd poc && pnpm build
SAX_SQLITE_FILE=/tmp/account.db TOKEN_SIGNING_SEED=… CODE_MAC_KEY=… … node services/account/dist/main.js
```

컨테이너: `docker build -f services/account/Dockerfile .`(빌드 컨텍스트는 `poc/`). 실제 배포는 Phase 1 범위 밖이다.

## Phase 1에서 하지 않는 것

- AIK 회전·복구 키 대기(D09 §2.2 복구 경로)와 계정 복구 대기(`account.recovery_hold`)는 데스크톱 쪽 흐름이 정해진 뒤 붙인다.
- 서버 메일 경로(ADR-034 결정 10).
