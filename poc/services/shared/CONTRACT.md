# 클라우드 공통 계약(services/shared)

계정(M4-5)·게이트웨이(M4-6)·레지스트리(M4-7)·릴레이·푸시(M7-3)가 함께 쓰는 형식이다. 클라이언트(apps/desktop·모바일)가 붙을 때 이 문서와 `tests/services-kit.ts`(참조 구현)를 기준으로 한다.

근거: ADR-029(서버는 열쇠가 없다), D09 §1·§3·§10, D08 §2.1·§9, D16 §2(오류 코드).

## 1. 서명 입력 규칙

모든 Ed25519 서명의 입력은 `utf8(맥락 문자열) ‖ utf8(JCS(객체))`다. JCS는 RFC 8785(엔진 `gate.ts`의 `jcs`와 같은 규칙: 키 정렬, 공백 없음, 정수만). 서명·공개키는 표준 base64(패딩 있음)로 싣는다. 단 토큰·DPoP의 바깥 형식은 base64url(패딩 없음)이다.

| 맥락 | 서명자 | 대상 객체 | 출처 |
|---|---|---|---|
| `SAX-devlist-v1` | AIK | 기기 목록 항목 `{device_id, role, Sx, Vx, registered_at, list_version}` | D08 §2.1, remote-envelope 스키마 |
| `SAX-revoke-v1` | AIK | 폐기 레코드 `{device_id, revoked_at}` | D08 §2.1 |
| `SAX-cert-v1` | AIK | 기기 인증서 `{device_id, role, Sx, Vx, Kx?, Px?, not_after}` | D08 §2.1 |
| `SAX-acct-op-v1` | AIK | 계정 작업 `{op, account_id, target, ts}` | 신규(서버 전용), §5 |
| `SAX-dpop-v1` | 기기 Vx | DPoP 증명 `{htm, htu, iat, jti, ath}` | 신규(서버 전용), §3 |
| `SAX-token-v1` | 계정 서비스 토큰 키 | 기기 범위 토큰 클레임 | 신규(서버 전용), §2 |
| `SAX-run-token-v1` | 게이트웨이 | runToken 클레임 | 신규(서버 전용), M4-6 |

시각은 모두 UTC 밀리초 정수다(DPoP `iat`만 초).

## 2. 기기 범위 토큰(D09 §2.2 "기기 범위 토큰")

```
sxd1.<b64u(JCS(claims))>.<b64u(Ed25519(SAX-token-v1 ‖ JCS(claims)))>
claims = { v:1, typ:"device", kid, acc, dev, role:"desktop"|"mobile", scp:[...], cnf:<Vx 표준 base64>, iat, exp, jti }
```

- 발급: 계정 서비스 `POST /v1/device-tokens`(AIK 인증서 + Vx DPoP). 수명 15분. 비밀(계정 세션·로그인 토큰)과 분리된다.
- 검증: 각 서비스가 계정 서비스의 토큰 공개키(`kid`별, 회전 중 둘 이상)로 오프라인 검증한다. 가운데 JSON이 JCS 정규형이 아니면 거부한다.
- 범위(`scp`): 데스크톱 `gateway, relay, wake, slots, devlist, acct_op`, Phase 1 모바일 `relay, push`(정보 모드 원칙상 폰은 모델·슬롯·기기 목록 권한이 없다).
- 사용: `Authorization: DPoP <token>` + `DPoP: <증명>`. 토큰만으로는 쓸 수 없다(§3).
- 긴급 정지: 각 서비스는 토큰 검증 뒤 계정 서비스의 기기 상태(`GET /internal/v1/devices/:id`, 5초 캐시)를 보고 `active`가 아니면 거부한다. 정지·폐기 시 계정 서비스가 릴레이·푸시에 `POST /internal/v1/devices/:id/stopped`를 보내 캐시를 즉시 버리게 한다.

## 3. DPoP(SAX-dpop-v1)

```
DPoP: <b64u(JCS(proof))>.<b64u(Ed25519_Vx(SAX-dpop-v1 ‖ JCS(proof)))>
proof = { htm:"POST", htu:"https://<서비스 공개 origin><경로>", iat:<초>, jti:<16~64자 b64u>, ath:b64u(sha256(token)) }
```

- 키는 정확히 다섯 개, JCS 정규형만. `htu`는 쿼리 없는 공개 주소. 시계 오차 ±60초. `jti`는 5분 동안 1회.
- `POST /v1/device-tokens`에서는 아직 토큰이 없으므로 `ath = b64u(sha256(JCS(cert)))`(제시하는 인증서 객체)다.

## 4. 계정 세션

`Authorization: Bearer sxs1.<43자 b64u>`. 서버는 sha256 해시만 저장한다. 30일. 계정 서비스만 받는다(다른 서비스는 기기 범위 토큰만 받는다). 계정 웹(긴급 정지·결제·슬롯 조회)과 데스크톱 첫 로그인용이다.

## 5. 계정 작업(SAX-acct-op-v1)

`{ op, account_id, target, ts }` + `aikSig`. `ts`는 서버 시각 ±5분. 서명된 작업만 서버 상태를 되돌릴 수 있다(계정 세션만 탈취한 공격자는 정지만 할 수 있고 해제는 못 한다).

| op | target | 용도 |
|---|---|---|
| `device.reactivate` | 기기 ID | 긴급 정지 해제 |
| `slot.rebind_rk` | `<slotToken>:<새 bizHmac>` | RK 교체에 따른 사업자 HMAC 재등록(D08 §9.4). 90일 재바인딩 횟수에 세지 않는다 |

## 6. 사업자번호 HMAC 형식

`bizHmac` = 소문자 hex 32자(16바이트). 클라이언트가 `HMAC(RK에서 파생한 키, 사업자번호)`를 만들어 보낸다(D09 §2 "사업자 HMAC은 RK 파생 키로", D08 §9.4). 서버는 평문도 키도 받지 않는다.

## 7. 오류 본문

모든 오류는 `{"error":"<영역>.<코드>"}` 하나뿐이다. 입력값·스택·내부 메시지를 되풀이하지 않는다. 한도 초과는 `Retry-After`(초) 헤더를 함께 준다. 코드 목록과 HTTP 상태는 `src/errors.ts`의 `ERROR_STATUS`, D16에 아직 없는 코드는 `PROPOSED_D16`(D16 추가 제안)이다.

## 8. 로그(D09 §3·§10)

- 접근 로그는 고정 필드만: `t, svc, m, route(패턴, 예 /v1/devices/:id), status, code, bytesIn, bytesOut, ms, aid?`. 본문·쿼리·IP·헤더·경로 변수 값은 남기지 않는다.
- `aid`는 계정 ID의 일 회전 HMAC(KST 날짜마다 메모리 안 무작위 솔트, 영속하지 않음). 하루가 지나면 그날의 키를 다시 계산할 수 없다.
- 한도 키는 §10의 HMAC이다(IP·이메일은 당일 솔트, 계정·기기 ID는 서버 비밀). 평문은 카운터에도 없다.
- `looksSensitive`(주민번호·사업자번호·카드·이메일·긴 토큰·IPv4 탐지기)를 시험에서 모든 로그 줄에 돌린다. 운영에서는 싱크 앞단에 둔다.

## 9. 저장(DB)

운영 PostgreSQL(`DATABASE_URL`), 시험 `node:sqlite`. 마이그레이션은 `services/<이름>/migrations/NNN_*.sql`, 서비스별 `schema_migrations(service, version)`. 시험이 마이그레이션의 실제 컬럼을 각 서비스의 가시성 표(`src/visibility.ts`)와 맞춰 보고, 금지 컬럼 이름(`ip, body, content, prompt, response, bizno, rrn, password, secret, plaintext …`)을 막는다.

## 10. 한도(팀장 결정 2026-11-05 (가), D09 §4·D08 §8)

함수 인스턴스가 여럿이어도 같은 한도를 보도록 카운터와 키 솔트를 각 서비스 DB에 둔다(`src/limits.ts`, 공용 마이그레이션 `migrations/001_limits.sql`, `migrate(db, 'limits', LIMITS_MIGRATIONS_DIR)`). 서비스마다 자기 DB에 만든다(릴레이 DB는 계정 DB와 분리, D08 §8).

- 카운터 `lim_windows`: 고정 창. 한 문장 upsert라 동시 요청도 한도를 넘겨 통과시키지 않는다. 횟수는 한도 + 1에서 멈춘다. 창이 끝난 행은 1분마다 sweep으로 지운다(창은 길어야 1시간).
- 솔트 `lim_salts`: (용도, KST 날짜)마다 무작위 32바이트 한 행. 처음 쓰는 인스턴스가 만들고 모두 같은 행을 읽는다. 날짜가 바뀐 뒤 처음 읽을 때와 1분 sweep에서 지난 날 행을 지운다(자기 날짜보다 **앞선** 행만: 시계가 조금 늦은 인스턴스가 자정 직후 기동해도 새 날 행을 지우지 않는다) → 지난 날의 HMAC은 다시 계산할 수 없다.
- 계정·기기 ID 키는 DB 솔트가 아니라 서버 비밀 `LIMIT_ID_KEY` HMAC(용도 ‖ KST 날짜 ‖ ID)이다(`idSalt`). 비밀은 환경 변수로만 주입되어 DB를 읽어도 다시 계산할 수 없고, 날짜가 들어가 키가 날마다 바뀐다.
- 노출 면(D09 §4에 추가 제안, IP·이메일 키): Phase 1 다중 인스턴스에서는 솔트가 당일 DB 행이라 DB를 읽는 사람은 당일 키를 다시 계산할 수 있다(당일 한정). Supabase에서는 별도 스키마에 두고 함수 역할만 읽고 쓴다(supabase/migrations 내보내기 PR).
- IP 한도는 이 DB 카운터와 Vercel 방화벽(1차 방어) 둘 다다. 방화벽 규칙은 배포 체크리스트에 둔다.
- 라이브 연결(WSS, Phase 1 기본 꺼짐)의 프레임 속도는 연결이 붙은 인스턴스 메모리에서만 센다.
- `DATABASE_URL`이 없는 단위 시험·로컬은 `memoryLimits`(같은 인터페이스, 메모리 솔트).
- PostgreSQL 시험: `SAX_PG_TEST_URL=postgres://…`이면 `tests/services-limits.test.ts`가 SQLite와 같은 시험(연결 넷 병렬 증가 N → 정확히 N, KST 자정 솔트 생성 경합, 자정 시계 어긋남, 만료 정리)을 PG에도 돌린다. 기본은 꺼짐(빈 DB 하나면 된다, 시험이 마이그레이션을 적용한다).
