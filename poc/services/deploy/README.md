# 배포 구성: Supabase(PostgreSQL) + Vercel(tax.laf-co.com) + 룸 호스트

Phase 1 클라우드 배포 구성이다. 근거는 다음과 같다.
- 팀장 결정 2026-11-05: 배포 전제, 한도 (가)·(다), 릴레이 HTTPS 폴링
- 팀장 결정 2026-11-06: 룸 켬, 폰 대리 등록
- D09 §1~§4·§9.1, D08 §4.2·§8, ADR-015·029

이 저장소에는 **구성과 절차만** 있다. 실제 배포 명령(로그인·연결·`db push`·도메인 연결)은 사용자 계정 작업이라 아래 절차대로 사용자가 직접 한다. 비밀 값은 저장소·메시지·로그 어디에도 두지 않는다. 아래 env 표는 **이름만** 적는다.

## 1. 구성

| 경로(공개 origin `https://tax.laf-co.com`) | 어디서 | 비고 |
|---|---|---|
| `/v1/auth/*` `/v1/oauth/*` `/v1/passkeys*` `/v1/me` `/v1/consents` `/v1/billing/*` `/v1/devices*` `/v1/device-tokens` `/v1/device-list` `/v1/acct-claim` `/v1/aik` `/v1/slots*` | Vercel 함수 `api/sax`(계정 라우터) | |
| `/v1/run-tokens` `/v1/decide` `/v1/respond` `/v1/biz/status` | Vercel 함수 `api/sax`(게이트웨이 라우터) | 최대 60초 |
| `/v1/mailboxes*`(HTTPS 큐만) | Vercel 함수 `api/sax`(릴레이 라우터) | 라이브 WSS 꺼짐(D08 §8 Phase 1) |
| `/v1/push-token` `/v1/wake` | Vercel 함수 `api/sax`(푸시 라우터) | 푸시 공급사는 모의(Phase 1) |
| `/v1/rooms`(룸 발급) | Vercel 외부 재작성 → **룸 호스트** `https://rooms.tax.laf-co.com` | |
| `wss://rooms.tax.laf-co.com/v1/rooms/:roomId`(룸 참가) | **룸 호스트** 직접(QR의 릴레이 호스트) | 함수는 WSS를 못 받는다 |
| `/registry/*` `/policy/*` `/packages/*` `/releases/*` | (후속 PR) Supabase Storage + CDN 정적 GET | 이 PR에 없음 |
| `/api/internal/internal/v1/devices/:id`(GET 하나) | Vercel 함수 `api/internal`(`INTERNAL_CALL_KEY` 서명) | 룸 호스트의 기기 상태 조회 전용. 아래 6절 ① |
| `/api/cron` | Vercel 함수 `api/cron`(`Bearer <CRON_SECRET>`) | 네 서비스 정리 |
| `/internal/*`, `/healthz` | 공개 경로로 닿지 않음. `api/sax`는 `/internal/*`을 점 구간·인코딩 우회까지 모두 404 | 시험이 확인 |

- **Vercel 프로젝트 루트**: [`vercel/`](vercel/)(`vercel.json`·`api/*.js`·`public/`).
  - 함수는 셋이다: 공개 `api/sax`, 내부 `api/internal`, 정리 `api/cron`. 모두 `pnpm build`가 만든 `services/cloud/dist/index.js`를 쓴다.
  - 조립은 `services/cloud/src/index.ts`(`@sax/svc-cloud`)다. 네 서비스를 한 프로세스에서 조립하고, 서비스 사이 호출(기기 상태·자동 정지·정지 알림)은 **HTTP 없이 함수로** 부른다(팀장 결정 2026-11-06 #135 (1)). 서비스마다 자기 DB 역할·키를 따로 쓰고, 상시 서버의 `build*`와 같은 코드다.
- **경로 복원**: 재작성 규칙이 원래 경로를 `__p`로 넘기고 진입점이 되살린다(`services/shared/src/deploy.ts`). DPoP `htu`는 공개 origin에 원래 경로를 붙인 값이다.
- **정리**: Vercel Cron이 매시 `/api/cron`을 `Authorization: Bearer <CRON_SECRET>`으로 부른다. 정리 대상은 만료 행, 한도 창, 지난 날 솔트다. Hobby 플랜에서는 cron이 하루 1회뿐이라 Pro가 필요하다.
- **DB**: Supabase 프로젝트 하나, PostgreSQL 하나다. 서비스마다 스키마 `<서비스>`, 한도 스키마 `<서비스>_limits`, 로그인 역할 `sax_<서비스>`를 둔다.
  - 역할은 자기 두 스키마의 **행만** 읽고 쓴다. DDL 권한도, 다른 서비스 스키마 권한도 없다(시험이 PG 17에서 확인).
  - 함수는 DDL을 하지 않는다. 마이그레이션은 아래 절차의 `supabase db push`가 적용한다.
- **룸 호스트**: 상시 Node 프로세스 한 대(`services/relay/Dockerfile`)다. "룸 켬" `RELAY_ROOMS=1`이다. 메모리 룸이라 **인스턴스는 한 대**여야 한다. 공급사는 미정이다(ADR-015, 컨테이너가 도는 곳이면 된다).

## 2. 필요 env(이름만, Vercel 프로젝트 → Settings → Environment Variables, Production)

함수 env는 프로젝트 전체에 공유된다. 그래서 서비스별 값은 `<서비스>__<이름>`으로 넣는다. 공통 값은 접두 없이 넣는다(`serviceEnv`).

| 공통(접두 없음) | |
|---|---|
| `INTERNAL_CALL_KEY` ⚿ | 내부 호출 서명 키(hex 64자). 룸 호스트와 같은 값. 다른 어떤 키와도 다른 값 |
| `CRON_SECRET` ⚿ | Vercel Cron 비밀(32자 이상). 진입점이 32자 미만이면 거부 |
| `TOKEN_PUBLIC_KEYS` | `k1:<base64>`. 계정 `TOKEN_SIGNING_SEED`의 공개키(공개 값, [`token-public-key.ts`](token-public-key.ts)로 만든다, 시드는 표준 입력으로). 게이트웨이·릴레이·푸시·룸 호스트 |
| `TRUST_PROXY` | `1` |
| `DATABASE_POOL_MAX` | `1`(서비스당 연결. 한 함수 인스턴스가 네 서비스 역할로 4개를 연다) |

| 서비스 | 이름(`<서비스>__` 접두) |
|---|---|
| 계정 `ACCOUNT__` | `DATABASE_URL` ⚿, `TOKEN_SIGNING_SEED` ⚿, `TOKEN_KID`, `CODE_MAC_KEY` ⚿, `LIMIT_ID_KEY` ⚿, `ACCT_CLAIM_SIGNING_KEY` ⚿(`TOKEN_SIGNING_SEED`와 다른 값, 아래 3절 3.10), `ACCOUNT_PUBLIC_ORIGIN`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `BILLING_RETURN_URL`, `PG_PROVIDER`(`mock`), `MOCK_PG_SECRET` ⚿, `MAIL_PROVIDER`(`mock`, 아래 ⑤), `STOP_HOOK_URLS`, `RELAY_INTERNAL_URL` |
| 게이트웨이 `GATEWAY__` | `DATABASE_URL` ⚿, `GATEWAY_PUBLIC_ORIGIN`, `RUN_TOKEN_SEED` ⚿, `LIMIT_ID_KEY` ⚿, `CACHE_KEY_SECRET` ⚿, `SAFETY_ID_KEY` ⚿, `REPLAY_TAG_KEY` ⚿, `RUN_SCOPE_KEY` ⚿, `GW_PROVIDER`(`openai+openrouter`), `OPENAI_API_KEY` ⚿, `OPENROUTER_API_KEY` ⚿, `OPENROUTER_ZDR`, `OPENROUTER_DATA_COLLECTION`, `OPENROUTER_PROVIDERS`, `MODEL_DECIDE`, `MODEL_RESPOND`, `GW_MONTHLY_TOKENS`, `GW_PRICES_JSON`, `NTS_PROVIDER`(`odcloud`), `NTS_BIZ_API_KEY` ⚿, `NTS_BIZ_API_BASE` |
| 릴레이 `RELAY__` | `DATABASE_URL` ⚿, `QUEUE_KEY` ⚿, `LIMIT_ID_KEY` ⚿, `RELAY_PUBLIC_ORIGIN` |
| 푸시 `PUSH__` | `DATABASE_URL` ⚿, `PUSH_TOKEN_KEY` ⚿, `LIMIT_ID_KEY` ⚿, `PUSH_PUBLIC_ORIGIN`, `PUSH_PROVIDER`(`mock`) |

**룸 호스트 env**(접두 없음, 그 호스트에만): `DATABASE_URL` ⚿(`sax_relay`), `QUEUE_KEY` ⚿(릴레이 함수와 같은 값), `LIMIT_ID_KEY` ⚿(릴레이 함수와 같은 값), `RELAY_PUBLIC_ORIGIN`, `TOKEN_PUBLIC_KEYS`, `ACCOUNT_INTERNAL_URL`, `INTERNAL_CALL_KEY` ⚿, `RELAY_ROOMS`(**`1` = 룸 켬**), `RELAY_LIVE`(`0`), `MIGRATE_ON_START`(`0`), `TRUST_PROXY`, `PORT`.

값의 형식(hex 64자 등)은 각 서비스 `ENV.md`가 정본이다. 키 값은 사용자가 로컬에서 `openssl rand -hex 32`로 만들어 비밀번호 관리자에 두고, Vercel·룸 호스트 env 화면에 직접 붙여 넣는다.

내부 주소 값은 다음과 같다(비밀 아님).
- `ACCOUNT_INTERNAL_URL`(룸 호스트만) = `https://tax.laf-co.com/api/internal`
- `ACCOUNT__STOP_HOOK_URLS` = `https://rooms.tax.laf-co.com`(룸 호스트만. 같은 배포 안 푸시는 함수 호출)
- `ACCOUNT__RELAY_INTERNAL_URL` = `https://rooms.tax.laf-co.com`
- `*_PUBLIC_ORIGIN`·`WEBAUTHN_ORIGINS` = `https://tax.laf-co.com`, `WEBAUTHN_RP_ID` = `tax.laf-co.com`

## 3. 사용자가 직접 할 단계(로그인·연결)

순서대로 한다. 각 단계 결과(프로젝트 ref, 리전 등 비밀 아닌 것)만 팀장에게 알린다.

1. **리전 결정**(미정, R14): 서울이면 Supabase `ap-northeast-2`, Vercel 함수 `icn1`이다. 처리방침은 어느 쪽이든 "국외 이전 가능"으로 쓴다.
2. **Supabase**
   1. supabase.com에 로그인해 새 프로젝트를 만든다(위 리전). DB 비밀번호는 비밀번호 관리자에만 둔다.
   2. Project Settings → Database에서 **직접 연결 URL**(5432, `postgres`)과 **트랜잭션 풀러 URL**(6543)을 확인한다.
   3. 이 PC에서 Supabase CLI로 마이그레이션을 적용한다(아래 4절).
   4. SQL Editor에서 서비스 역할 비밀번호 4개를 정한다: `ALTER ROLE sax_account WITH PASSWORD '…';`. `sax_gateway`·`sax_relay`·`sax_push`도 같다. 값은 비밀번호 관리자에서 만들고 SQL 기록에 남지 않게 한 번만 실행한다.
   5. 서비스별 `DATABASE_URL` = 트랜잭션 풀러 URL. 사용자명은 `sax_<서비스>.<프로젝트 ref>`, 비밀번호는 위 값이다. TLS 검증은 아래 "알려진 차이" ③을 본다.
   6. Database → Settings에서 **Network Restrictions**는 열어 둔다(Vercel 함수 IP가 고정이 아니다). API(PostgREST)의 노출 스키마에 `account` 등을 **넣지 않는다**(기본값 그대로).
3. **Vercel**
   1. vercel.com에 로그인해 GitHub `LAF-labs/tex`를 Import한다.
   2. **Root Directory** = `poc/services/deploy/vercel`로 두고 "Include files outside the root directory"를 켠다. Framework Preset은 Other다. 설치·빌드 명령은 `vercel.json`에 있다.
   3. Node.js 버전: 저장소 `engines`는 26.x다. Vercel 함수 런타임이 26을 지원하지 않으면 지원하는 최신 버전으로 두고 스모크로 확인한다(아래 6절 ④).
   4. Settings → Functions → Region을 1번 결정대로 둔다.
   5. 2절의 env를 Production에 넣는다.
   6. Settings → Domains에 `tax.laf-co.com`을 추가한다. Vercel이 보여 주는 DNS 값을 4번(GoDaddy)에 넣는다.
   7. Deployment Protection은 Production 도메인에 걸지 않는다(클라이언트 API다). Preview에는 걸어 둔다.
   8. Firewall에 IP 한도 규칙을 넣는다(#108 체크리스트: `/v1/auth/*`, `/v1/mailboxes/*`, `/v1/device-tokens`, 초과 시 429, Attack Challenge Mode는 API 경로에 쓰지 않음). `/api/internal*`에도 IP당 분당 상한을 둔다(호출하는 곳은 룸 호스트 한 대뿐이다).
   9. Pro 플랜이면 Cron이 매시 돈다. Hobby면 `vercel.json`의 `schedule`을 하루 1회로 바꿔야 한다(팀장 결정).
   10. **acct_claim 공개키 고정**(D08 §4.2 7단계, #125): `ACCOUNT__ACCT_CLAIM_SIGNING_KEY`를 `TOKEN_SIGNING_SEED`와 다른 새 값으로 만든다. 공개키(공개 값)를 `cd poc && node --conditions=development services/account/src/acct-claim-pubkey-cli.ts < 시드_파일`로 뽑아 팀장(폰 앱 고정값)에 알린다. 시드 값은 비밀번호 관리자에만 둔다. 키를 바꾸면 폰 앱 고정값도 함께 바꿔야 한다.
4. **GoDaddy DNS**(laf-co.com 도메인 관리 → DNS)
   - `tax`: Vercel이 보여 준 값(보통 CNAME `cname.vercel-dns.com`). 소유 확인 TXT `_vercel`를 요구하면 그것도 넣는다.
   - `rooms.tax`: 룸 호스트의 A/AAAA 또는 CNAME(5번에서 정해짐).
   - SES(6번)가 주는 DKIM CNAME 3개, MAIL FROM MX·SPF TXT, `_dmarc` TXT.
5. **룸 호스트**(공급사 미정)
   1. 상시 컨테이너 한 대로 `services/relay/Dockerfile`을 빌드해 실행한다.
   2. TLS 인증서는 호스트나 앞단에서 받는다(`rooms.tax.laf-co.com`, WSS).
   3. 2절의 룸 호스트 env를 넣는다. `RELAY_ROOMS=1`, `MIGRATE_ON_START=0`이다.
   4. 인스턴스는 한 대로 고정한다(자동 확장 끔). 재시작하면 진행 중인 페어링만 다시 하면 된다.
6. **AWS SES**(메일, 아래 ⑤ 어댑터 PR과 함께)
   1. AWS 콘솔 → SES(1번 리전)에서 도메인 identity `tax.laf-co.com`을 만든다. Easy DKIM CNAME 3개를 GoDaddy에 넣고 Verified를 기다린다.
   2. Custom MAIL FROM(`mail.tax.laf-co.com`)의 MX·SPF를 GoDaddy에 넣는다. DMARC는 `v=DMARC1; p=quarantine`부터 시작한다.
   3. **Production access**를 요청한다. 샌드박스는 확인된 수신자에게만 보낸다. 용도는 로그인 코드·기기 알림 트랜잭션 메일이다.
   4. IAM 사용자(또는 역할)에 `ses:SendEmail` 권한만, 그 identity로 한정해 준다. 자격 증명은 Vercel `ACCOUNT__…`에 넣는다(이름은 SES 어댑터 PR에서 정한다).
7. 배포한 뒤 아래 5절 스모크를 돌리고 결과를 팀장에게 알린다.

## 4. 마이그레이션 적용 절차

생성 파일은 [`supabase/migrations/`](supabase/migrations/)에 있다.
- `20261106000000_sax_roles.sql`: 역할·스키마, 비밀번호 없음
- 서비스별 4개: 테이블, `schema_migrations` 기록, 권한

```bash
cd poc
# 1) 서비스 마이그레이션을 바꿨으면 다시 만든다(시험이 저장소 파일과 대조한다)
node --conditions=development services/deploy/export-supabase.ts
# 2) 적용(사용자 PC, 직접 연결 URL은 그때만 붙여 넣고 셸 기록에 남기지 않는다)
supabase db push --workdir services/deploy --db-url "<직접 연결 URL>"
```

- 이미 적용한 파일은 Supabase가 건너뛴다(`supabase_migrations.schema_migrations`).
- 서비스 마이그레이션을 새로 더하면 `services/<서비스>/migrations/NNN_*.sql`을 추가하고 1)을 다시 돌린다.
  - 지금 내보내기는 서비스마다 파일 하나에 전부 넣는다. **이미 적용된 뒤에는 새 번호만 담은 파일을 따로 내보내야 한다**. 첫 변경 때 내보내기를 "적용 이후 증분"으로 바꾼다(후속).
- 확인(선택):
  ```bash
  SAX_PG_TEST_URL=postgres://<슈퍼유저>@<빈 시험 DB> node --conditions=development --test tests/services-deploy.test.ts
  ```
  - 빈 시험 DB에 적용하고, 역할마다 자기 스키마만 읽고 쓰는지, 다른 서비스 테이블과 DDL이 거부되는지 본다.
  - 운영 DB에는 돌리지 않는다(스키마를 지우고 다시 만든다).

## 5. 배포 뒤 스모크(사용자 또는 팀장)

| 요청 | 기대 |
|---|---|
| `GET https://tax.laf-co.com/v1/me` | `401 {"error":"account.unauthorized"}`. 재작성과 경로 복원이 동작함 |
| `POST /v1/auth/code {"email":…}` | `200 {loginId, expiresInSec}`. ⑤ 전에는 메일이 가지 않는다 |
| `GET /healthz`, `GET /internal/v1/devices/x` | 404(Vercel) |
| `GET /api/sax?__p=/internal/v1/devices/x`, `GET /api/sax?__p=/v1/%2e%2e/internal/v1/devices/x` | `404`(공개 함수는 내부 경로를 받지 않는다) |
| `GET /api/internal/internal/v1/devices/x`(서명 없이) | `401` |
| `POST /api/internal?__p=/internal/v1/devices/x/auto-suspend`, `GET /api/internal?__p=/v1/me` | `404`(내부 함수는 기기 상태 GET 하나만) |
| 룸 호스트 로그의 기기 상태 조회 | `200`(서명 호출이 통과함). 계정 함수 로그에 `/api/internal` 호출은 룸 호스트에서만 |
| Vercel 로그의 Cron 호출 | `200`, 접근 로그에 본문·IP 없음 |
| 데스크톱 앱 로그인 → 기기 토큰 → 게이트웨이 `run-tokens` | `200`. DPoP `htu`가 공개 origin + 원래 경로와 맞음 |
| 폰 페어링(룸 발급 → QR → `wss://rooms.tax.laf-co.com` → enroll) | `201 {expiresAt}`, 등록 `201` |

## 6. 알려진 차이·미검증(팀장 확인)

1. **내부 API는 공개 경로로 노출하지 않는다**(팀장 결정 2026-11-06 #135 (1)). Vercel에는 사설망이 없어 이렇게 나눈다.
   - 같은 배포 안의 서비스 호출(기기 상태·자동 정지·정지 알림)은 HTTP 없이 함수로 부른다(`@sax/svc-cloud`). 공개 함수 `api/sax`는 `/internal/*`을 모두 404로 막는다.
   - HTTP가 꼭 필요한 곳은 룸 호스트(다른 호스트)뿐이다.
     - 룸 호스트 → 계정 기기 상태: 내부 함수 `api/internal`이 `GET /internal/v1/devices/:id` 하나만 받는다. `vercel.json`의 내부 재작성도 이 하나뿐이다(기본 거부).
     - 계정 → 룸 호스트: 룸 소비(`/internal/v1/rooms/:id/redeem`)·정지 알림(`/internal/v1/devices/:id/stopped`).
   - 위 HTTP는 모두 `INTERNAL_CALL_KEY` HMAC-SHA256 서명만 받는다. 서명 범위는 메서드·경로(쿼리 포함)·본문 SHA-256·시각(±60초)·nonce다. nonce는 1회용이고 각 서비스 한도 스키마의 `int_nonces`에 기록한다(인스턴스 사이 공유). 비교는 상수 시간이다.
   - 시험: 서명 없음 401, 오래된·미래 ts 401, 재전송 401(다른 인스턴스 포함), 공개 경로에서 404, 점 구간·`%2e%2e` 우회 404, 내부 함수의 허용 목록 밖 경로 404.
   - 남는 노출: `api/internal`과 룸 호스트의 `/internal/*`은 인터넷에서 닿는다(서명 없이는 401). 함수 파일 경로는 Vercel이 늘 공개하기 때문이다.
2. **D08 §8 "릴레이 DB는 계정 DB와 다른 DB"를 같은 PostgreSQL 안의 스키마·역할 분리로 구현했다.** Phase 1에 한해 승인됐다(팀장 결정 2026-11-06 #135 (2)).
   - 조건은 시험으로 고정했다(PG 17): 역할 간 교차 GRANT 0(모든 역할 쌍에서 다른 서비스 스키마의 USAGE·CREATE, 표 권한 없음), 역할 구성원 없음, `search_path`는 역할 설정으로 자기 두 스키마만(`public` 없음). 릴레이 역할은 `account.accounts`를 읽을 수 없고 계정 역할은 `relay.mailboxes`를 읽을 수 없다.
   - 잔여 위험: DB 관리자(Supabase `postgres`)나 DB가 침해되면 두 스키마를 연결할 수 있다. Phase 2에 DB를 분리한다(D19 잔여 위험 행은 설계 세션이 넣는다).
   - 분리할 때는 릴레이·푸시를 별도 Supabase 프로젝트로 옮긴다. env만 바뀌고 코드 변경은 없다.
3. **TLS 검증**: node-pg는 연결 문자열의 `sslmode`로 TLS를 정한다.
   - Supabase CA로 서버 인증서를 검증하려면 `sslrootcert`가 필요하다. 함수 번들에 CA 파일을 넣는 방법은 배포 때 확인한다.
   - 그 전까지 `sslmode=require`의 검증 수준을 스모크로 확인한다. 검증하지 않는 설정은 쓰지 않는다.
4. **Vercel 동작 미검증**(이 저장소에서는 배포하지 않았다):
   - 재작성 목적지 쿼리의 `:path*` 치환
   - 외부 재작성(룸 발급)이 `Authorization`·`DPoP`·`X-Forwarded-For`를 넘기는지
   - `/api/internal/internal/v1/devices/:id` 재작성(함수 파일 `api/internal.js`와 같은 접두)
   - 한 함수에 네 서비스(번들 크기·콜드 스타트·인스턴스당 DB 연결 4개)
   - Cron 경로
   - pnpm 워크스페이스 밖 import 번들링
   - 함수 런타임의 Node 버전(저장소는 26.x를 요구한다)
   - 확인 수단은 5절 스모크다. 로컬 시험은 같은 진입점을 Node HTTP 서버로 돌려 경로 복원·cron·조립을 본다.
5. **메일**: 저장소에는 모의 메일만 있다(`MAIL_PROVIDER=mock`). SES 어댑터 PR 전에는 로그인 코드가 발송되지 않아 실제 로그인을 할 수 없다.
6. **레지스트리**(Supabase Storage + CDN)는 후속 PR이다. 그 전까지 `/registry/*` 등은 404다.
   - 실물을 Storage에 두더라도 공개 경로는 `https://tax.laf-co.com` 아래 Vercel 재작성으로 둔다(`/releases/*`·`/registry/*`·`/registry/log/*`·`/policy/*`·`/packages/*`).
   - 클라이언트 egress 허용 목록은 이 origin 하나로 고정한다. Supabase 도메인은 클라이언트에 넣지 않는다(팀장 결정 2026-11-06).
7. **릴레이 큐 GET 응답 상한**: Vercel 함수 응답은 4.5MB다. 큐 상한 6 MiB 전부를 한 번에 돌려줄 수 없다. 큐 GET 페이지 나누기가 후속 PR이다(그 전에는 큐가 4.5MB를 넘으면 실패한다).
