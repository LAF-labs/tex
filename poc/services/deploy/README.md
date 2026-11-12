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
| `/v1/run-tokens` `/v1/decide` `/v1/respond` `/v1/biz/status` `/v1/codef/token` | Vercel 함수 `api/sax`(게이트웨이 라우터) | 최대 60초 |
| `/v1/mailboxes*`(HTTPS 큐만) | Vercel 함수 `api/sax`(릴레이 라우터) | 라이브 WSS 꺼짐(D08 §8 Phase 1) |
| `/v1/push-token` `/v1/wake` | Vercel 함수 `api/sax`(푸시 라우터) | 푸시 공급사는 모의(Phase 1) |
| `/v1/rooms`(룸 발급) | Vercel 외부 재작성 → **룸 호스트** `https://rooms.tax.laf-co.com` | |
| `wss://rooms.tax.laf-co.com/v1/rooms/:roomId`(룸 참가) | **룸 호스트** 직접(QR의 릴레이 호스트) | 함수는 WSS를 못 받는다 |
| `/registry/*` `/policy/*` `/packages/*` `/releases/*`(공개 GET) | Vercel 외부 재작성 → Supabase Storage **공개 버킷 `sax-registry`**의 같은 경로 | 함수를 거치지 않는다(패키지 16MB가 함수 응답 4.5MB를 넘는다). 7절 |
| `/registry/log/*`(투명성 로그 GET), `/admin/v1/*`(게시 PUT) | Vercel 함수 `api/registry`(레지스트리 라우터) | 로그 재작성이 버킷 재작성보다 앞이다. 7절 |
| `/api/registry-cron` | Vercel 함수 `api/registry-cron`(`Bearer <CRON_SECRET>`) | 타임스탬프 자동 재서명(매시 15분). 7절 |
| `/api/internal/internal/v1/devices/:id`(GET 하나) | Vercel 함수 `api/internal`(`INTERNAL_CALL_KEY` 서명) | 룸 호스트의 기기 상태 조회 전용. 아래 6절 ① |
| `/api/cron` | Vercel 함수 `api/cron`(`Bearer <CRON_SECRET>`) | 네 서비스 정리 |
| `/internal/*`, `/healthz` | 공개 경로로 닿지 않음. `api/sax`는 `/internal/*`을 점 구간·인코딩 우회까지 모두 404 | 시험이 확인 |

- **Vercel 프로젝트 루트**: [`vercel/`](vercel/)(`vercel.json`·`api/*.js`·`public/`).
  - 함수는 다섯이다: 공개 `api/sax`, 내부 `api/internal`, 정리 `api/cron`은 `pnpm build`가 만든 `services/cloud/dist/index.js`를 쓴다. 레지스트리 `api/registry`·`api/registry-cron`은 `services/registry/dist/index.js`를 쓴다(실패 영역 분리: 레지스트리 구성이 틀려도 로그인·게이트웨이는 돈다).
  - 조립은 `services/cloud/src/index.ts`(`@sax/svc-cloud`)다. 네 서비스를 한 프로세스에서 조립하고, 서비스 사이 호출(기기 상태·자동 정지·정지 알림)은 **HTTP 없이 함수로** 부른다(팀장 결정 2026-11-06 #135 (1)). 서비스마다 자기 DB 역할·키를 따로 쓰고, 상시 서버의 `build*`와 같은 코드다.
- **경로 복원**: 재작성 규칙이 원래 경로를 `__p`로 넘기고 진입점이 되살린다(`services/shared/src/deploy.ts`). DPoP `htu`는 공개 origin에 원래 경로를 붙인 값이다.
  - Vercel은 재작성 소스의 이름 붙은 매개변수(`:path*`의 `path`, `:id`의 `id`)를 목적지에서 이미 썼어도 쿼리에 다시 붙인다(2026-11-06 운영 확인: `/registry/log/head.json` → `?__p=/registry/log/head.json&path=head.json`, 레지스트리 로그의 엄격한 쿼리 검사가 400을 냈다).
  - `restorePath`는 값이 `__p`의 끝 구간인 `path`·`id`만 뺀다(`REWRITE_PARAMS`). 다른 값은 원래 요청의 쿼리로 남긴다. 라우터는 이 이름을 쿼리 키로 쓰지 않는다(시험).
  - 배포 전 점검(`check-vercel-output.ts`)은 공개 경로에 이 재작성을 플랫폼처럼 적용해서도 요청한다.
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
| 계정 `ACCOUNT__` | `DATABASE_URL` ⚿, `TOKEN_SIGNING_SEED` ⚿, `TOKEN_KID`, `CODE_MAC_KEY` ⚿, `LIMIT_ID_KEY` ⚿, `ACCT_CLAIM_SIGNING_KEY` ⚿(`TOKEN_SIGNING_SEED`와 다른 값, 아래 3절 3.10), `ACCOUNT_PUBLIC_ORIGIN`, `WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGINS`, `BILLING_RETURN_URL`, `PG_PROVIDER`(`mock`), `MOCK_PG_SECRET` ⚿, `MAIL_PROVIDER`(`mock`, SES를 켤 때만 `ses`, 3절 6번·아래 ⑤), `SES_FROM_ADDRESS`·`SES_ACCESS_KEY_ID` ⚿·`SES_SECRET_ACCESS_KEY` ⚿(`MAIL_PROVIDER=ses`일 때만), `STOP_HOOK_URLS`, `RELAY_INTERNAL_URL`, `PASSWORD_PEPPER_KEYS` ⚿(선택, 없으면 비밀번호 로그인만 닫힘, 아래 3절 3.11) |
| 게이트웨이 `GATEWAY__` | `DATABASE_URL` ⚿, `GATEWAY_PUBLIC_ORIGIN`, `RUN_TOKEN_SEED` ⚿, `LIMIT_ID_KEY` ⚿, `CACHE_KEY_SECRET` ⚿, `SAFETY_ID_KEY` ⚿, `REPLAY_TAG_KEY` ⚿, `RUN_SCOPE_KEY` ⚿, `GW_PROVIDER`(`openai+openrouter`), `OPENAI_API_KEY` ⚿, `OPENROUTER_API_KEY` ⚿, `OPENROUTER_ZDR`, `OPENROUTER_DATA_COLLECTION`, `OPENROUTER_PROVIDERS`, `MODEL_DECIDE`, `MODEL_RESPOND`, `GW_MONTHLY_TOKENS`, `GW_PRICES_JSON`, `NTS_PROVIDER`(`odcloud`), `NTS_BIZ_API_KEY` ⚿, `NTS_BIZ_API_BASE`, `CODEF_ENV`(`demo`·`prod`, 없으면 계좌 자동조회 꺼짐), `CODEF_CLIENT_ID` ⚿, `CODEF_CLIENT_SECRET` ⚿, `CODEF_PUBLIC_KEY` |
| 릴레이 `RELAY__` | `DATABASE_URL` ⚿, `QUEUE_KEY` ⚿, `LIMIT_ID_KEY` ⚿, `RELAY_PUBLIC_ORIGIN` |
| 푸시 `PUSH__` | `DATABASE_URL` ⚿, `PUSH_TOKEN_KEY` ⚿, `LIMIT_ID_KEY` ⚿, `PUSH_PUBLIC_ORIGIN`, `PUSH_PROVIDER`(`mock`) |
| 레지스트리 `REGISTRY__` | `TRUST_ROOT_JSON`(공개 값, 서명 의식 뒤), `REGISTRY_LOG_SIGNING_KEY` ⚿, `REGISTRY_ADMIN_TOKEN` ⚿, `DATABASE_URL` ⚿(`sax_registry`), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` ⚿, `S3_SECRET_ACCESS_KEY` ⚿. 7절 |

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
   4. SQL Editor에서 서비스 역할 비밀번호를 정한다: `ALTER ROLE sax_account WITH PASSWORD '…';`. `sax_gateway`·`sax_relay`·`sax_push`·`sax_registry`도 같다. 값은 비밀번호 관리자에서 만들고 SQL 기록에 남지 않게 한 번만 실행한다.
   5. 서비스별 `DATABASE_URL` = 트랜잭션 풀러 URL **끝에 `?sslmode=verify-full`**. 사용자명은 `sax_<서비스>.<프로젝트 ref>`, 비밀번호는 위 값이다. TLS는 아래 "알려진 차이" ③.
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
   11. **비밀번호 페퍼**(ADR-038): `ACCOUNT__PASSWORD_PEPPER_KEYS` = `k1:<hex 64자>`. 값은 비밀번호 관리자에서 새로 만들고(다른 비밀과 다른 값), 거기에만 둔다. 잃으면 모든 비밀번호가 맞지 않게 된다(사용자는 재설정·코드 로그인으로 복구). 회전은 `k2:<새 값>,k1:<옛 값>`으로 넣고 재배포한다.
4. **GoDaddy DNS**(laf-co.com 도메인 관리 → DNS)
   - `tax`: Vercel이 보여 준 값(보통 CNAME `cname.vercel-dns.com`). 소유 확인 TXT `_vercel`를 요구하면 그것도 넣는다.
   - `rooms.tax`: 룸 호스트의 A/AAAA 또는 CNAME(5번에서 정해짐).
   - SES(6번)가 주는 DKIM CNAME 3개, MAIL FROM MX·SPF TXT, `_dmarc` TXT.
5. **룸 호스트**(공급사 미정)
   1. 상시 컨테이너 한 대로 `services/relay/Dockerfile`을 빌드해 실행한다.
   2. TLS 인증서는 호스트나 앞단에서 받는다(`rooms.tax.laf-co.com`, WSS).
   3. 2절의 룸 호스트 env를 넣는다. `RELAY_ROOMS=1`, `MIGRATE_ON_START=0`이다.
   4. 인스턴스는 한 대로 고정한다(자동 확장 끔). 재시작하면 진행 중인 페어링만 다시 하면 된다.
6. **AWS SES 켜기 — 사용자 단계**(메일, 아래 ⑤). 코드(`services/account/src/mail-ses.ts`)는 저장소에 있고 **꺼져 있다**. 아래 셋을 마치고 env를 넣어야 켜진다. 어댑터는 서울(`ap-northeast-2`)만 받는다(D09 §1). 다른 리전이면 코드를 바꾸는 PR이 먼저다.
   1. **SES 도메인 인증**
      1. AWS 콘솔 → SES(서울)에서 도메인 identity `tax.laf-co.com`을 만든다. Easy DKIM CNAME 3개를 GoDaddy에 넣고 Verified를 기다린다.
      2. Custom MAIL FROM(`mail.tax.laf-co.com`)의 MX·SPF TXT를 GoDaddy에 넣는다. DMARC는 `_dmarc` TXT `v=DMARC1; p=quarantine`부터 시작한다.
      3. **Production access**(샌드박스 해제)를 요청한다. 샌드박스는 확인된 수신자에게만 보낸다. 용도는 로그인·재설정 코드와 기기·보안 알림 트랜잭션 메일이고, 광고 메일은 보내지 않는다.
   2. **IAM 키 발급**
      1. 이 용도 전용 IAM 사용자를 만든다. 정책은 `ses:SendEmail` 하나이고, 리소스는 `arn:aws:ses:ap-northeast-2:<계정 ID>:identity/tax.laf-co.com`으로 한정한다. 콘솔 로그인은 주지 않는다.
      2. 액세스 키를 만든다. 값은 비밀번호 관리자에 두고 Vercel env로만 옮긴다(저장소·메시지·로그에 넣지 않는다). 회전할 때는 새 키를 넣고 재배포한 뒤 옛 키를 비활성화한다.
   3. **env 3개 + 켜기**(Vercel Production, 2절 표)
      - `ACCOUNT__SES_FROM_ADDRESS`: 보내는 주소. 예: `no-reply@tax.laf-co.com`(인증한 도메인 안).
      - `ACCOUNT__SES_ACCESS_KEY_ID` ⚿: 위 2번 키 ID.
      - `ACCOUNT__SES_SECRET_ACCESS_KEY` ⚿: 위 2번 비밀 키.
      - 마지막에 `ACCOUNT__MAIL_PROVIDER`를 `mock`에서 `ses`로 바꾸고 재배포한다. 셋 중 하나라도 없거나 형식이 틀리면 계정 서비스가 기동하지 않는다(`config_SES_…`, 값은 오류에 나오지 않는다).
      - 켠 뒤 5절 스모크에 더해 본인 주소로 로그인 코드를 한 번 받아 본다. 로그에는 `account.mail_ses.sent`가 남는다. 실패하면 `account.mail_ses.<auth_failed|config|throttled|unavailable|rejected>`가 남는다.
7. 배포한 뒤 아래 5절 스모크를 돌리고 결과를 팀장에게 알린다.

## 4. 마이그레이션 적용 절차

생성 파일은 [`supabase/migrations/`](supabase/migrations/)에 있다.
- 단계마다 역할 파일 하나 + 서비스 파일(테이블, `schema_migrations` 기록, 권한). 역할 파일에는 비밀번호가 없다.
  - `2026110600…`: 계정·게이트웨이·릴레이·푸시(`20261106000000_sax_roles.sql` + 서비스 4개). 운영 tex-prod에 적용됨.
  - `2026110601…`: 레지스트리 투명성 로그(`20261106010000_sax_roles_registry.sql` + `20261106010100_sax_registry.sql`). 운영에 적용됨(#161).
  - `2026110602…`: 계정 마이그레이션 002(ADR-038 비밀번호·갱신 토큰, `20261106020100_sax_account.sql`). 역할 파일 없음(역할은 그대로). 기존 세션은 옮겨진다(만료 시각 유지). 운영에 적용됨(#180).
  - `2026110700…`: 계정 마이그레이션 003(알림 메일 발송 큐 `notice_outbox`, `20261107000100_sax_account.sql`). 역할 파일 없음. 새 표 하나와 색인뿐이라 기존 행은 바뀌지 않는다. **코드보다 먼저 적용한다**(새 코드는 잠금 때 이 표에 쓴다).
- **증분 내보내기**: 적용된 단계의 파일은 바꾸지 않는다(Supabase는 파일 이름으로 적용 여부를 기억한다). 시험이 적용된 단계 파일의 SHA-256을 고정한다. 새 서비스나 새 마이그레이션은 `SUPABASE_PHASES`(`services/shared/src/supabase.ts`)에 새 단계로 더한다.

```bash
cd poc
# 1) 서비스 마이그레이션을 바꿨으면 다시 만든다(시험이 저장소 파일과 대조한다)
node --conditions=development services/deploy/export-supabase.ts
# 2) 적용(사용자 PC, 직접 연결 URL은 그때만 붙여 넣고 셸 기록에 남기지 않는다)
supabase db push --workdir services/deploy --db-url "<직접 연결 URL>"
```

- 이미 적용한 파일은 Supabase가 건너뛴다(`supabase_migrations.schema_migrations`).
- 서비스 마이그레이션을 새로 더하면 `services/<서비스>/migrations/NNN_*.sql`을 추가하고 1)을 다시 돌린다.
  - 적용된 단계의 서비스에 새 번호를 더하면 새 번호만 담는 단계를 더한다: 단계의 서비스마다 번호 범위(`svc('account', 2, 2)`)를 둔다. 범위 밖 번호가 생기면 내보내기가 `export_versions_<서비스>`로 멈춘다(적용된 파일이 조용히 바뀌지 않게).
- 확인(선택):
  ```bash
  SAX_PG_TEST_URL=postgres://<슈퍼유저>@<빈 시험 DB> node --conditions=development --test tests/services-deploy.test.ts
  ```
  - 빈 시험 DB에 적용하고, 역할마다 자기 스키마만 읽고 쓰는지, 다른 서비스 테이블과 DDL이 거부되는지 본다.
  - 운영 DB에는 돌리지 않는다(스키마를 지우고 다시 만든다).

### 배포 전 함수 묶음 점검(로컬, 배포 명령 없음)

Vercel 파일 추적이 pnpm 링크 너머 의존성을 빠뜨리면 모든 함수가 `FUNCTION_INVOCATION_FAILED`로 죽는다(2026-11-06: `ajv/dist/2020`). 배포 전에 같은 묶음을 로컬에서 띄워 본다.

```bash
# 프로젝트 tex에 링크된 깨끗한 사본(git archive)에서. env는 내려받지 않는다(vercel pull 없음)
vercel build --yes
cd poc && node --conditions=development services/deploy/check-vercel-output.ts <사본 루트>
```

- [`check-vercel-output.ts`](check-vercel-output.ts)는 `.vercel/output/functions/api/*.func`를 저장소 밖으로 복사하고 `.vc-config.json`의 `filePathMap` 링크를 배포 때처럼 되살린다.
- 그 복사본에서 다섯 함수를 띄워 요청을 보낸다. 네 서비스 조립까지 거친다. 기대: 계정 코드 200, 인증 없는 경로 401, 내부 경로 404, cron 200, 레지스트리: 구성 없음 503 → 시험 구성(공개 시험 trust·메모리 저장소)으로 로그 헤드 200·재서명 cron 200.
- env는 시험용 무작위 값과 sqlite 파일이다. 메일·결제·모델·NTS·푸시는 mock이라 외부 송신이 없다.
- **비밀번호(ADR-038)**: 페퍼를 넣은 `sax(비밀번호)` 점검이 묶음 안에서 argon2id·흔한 목록(`data/common-passwords.txt.gz`)을 실제로 돌린다(로그인 401, 재설정 200). 다섯 묶음 모두 `.node` 네이티브 애드온이 없어야 한다(`네이티브 없음`).
- **레지스트리 묶음의 better-sqlite3**: 레지스트리는 `@sax/engine/core`를 쓰고, 엔진 코어가 `@sax/db`(데스크톱 원장, better-sqlite3-multiple-ciphers)를 값으로 가져온다. 그래서 그 패키지 JS가 묶음에 따라온다. 애드온은 `Database` 생성자에서만 읽고 레지스트리는 열지 않으므로, 플랫폼별 prebuild(16개, 약 20MB)는 `vercel.json`의 레지스트리 두 함수 `excludeFiles`로 뺀다. nft 무시 규칙은 `**`가 `.pnpm` 같은 점 폴더를 지나지 않아, 경로에 `.pnpm`을 직접 쓴다.
- **런타임**: 계정 묶음 `.vc-config.json`의 런타임이 `nodejs24.x` 이상이어야 한다(`node:crypto` argon2는 Node 24.7+). 운영 프로젝트 설정은 `26.x`다(팀장이 Vercel API로 확인, 2026-11-06). 로컬 링크 사본의 `.vercel/project.json`이 오래되면 `nodejs24.x`로 빌드될 수 있으니 점검 출력의 런타임을 본다. 부 버전은 빌드 결과로 알 수 없으므로 배포 뒤 스모크(5절 비밀번호 행)가 실제 런타임 확인이다. 런타임과 같은 주 버전 node가 있으면 `CHECK_NODE=<그 node 경로>`로 묶음을 그 버전에서 돌린다(출력 첫 줄에 쓴 node 버전).
- 소스 규칙: `packages/*/src`·`services/*/src`에서 `createRequire`로 의존성을 부르지 않는다(파일 추적이 못 따라간다). 시험이 막는다.

## 5. 배포 뒤 스모크(사용자 또는 팀장)

| 요청 | 기대 |
|---|---|
| `GET https://tax.laf-co.com/v1/me` | `401 {"error":"account.unauthorized"}`. 재작성과 경로 복원이 동작함 |
| `POST /v1/auth/code {"email":…}` | `200 {loginId, expiresInSec}`. ⑤ 전에는 메일이 가지 않는다 |
| `POST /v1/auth/password {"email":"none@example.invalid","password":"x"}` | 페퍼가 있으면 `401 {"error":"account.credentials_invalid"}`(약 0.7초 뒤). **이것이 운영 런타임에서 argon2id가 도는 확인이다.** 페퍼를 넣었는데 `404`면 런타임에 `crypto.argon2`가 없다(로그 `account.password_disabled.argon2_unavailable`): Vercel Node 버전을 올린다. Vercel 로그의 cron 뒤 `account.argon2_probe_ms`·`account.argon2_probe_rss_mb`(운영 실측) |
| `POST /v1/auth/refresh {"refreshToken":"sxa1.AAAA…(43자)"}` | `401` |
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
3. **TLS 검증**(팀장 결정 2026-11-06): 신뢰 앵커를 **Supabase Root 2021 CA 하나로 고정**하고 체인·만료·호스트 이름을 항상 검증한다([`services/shared/src/pg-tls.ts`](../shared/src/pg-tls.ts)).
   - 앵커는 공개 인증서다. 정본 사본은 [`supabase-root-2021.crt`](supabase-root-2021.crt)이다(SHA-256 `80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA`, 만료 2031-04-26).
     - 공식 배포본 `prod-ca-2021.crt`와 풀러가 보내는 루트가 같다(2026-11-06 확인).
     - 코드에 문자열로 들어 있어 함수 묶음에 항상 포함된다. 시험이 파일과 지문을 대조한다.
   - node-pg는 연결 문자열의 `sslmode`·`sslrootcert`로 우리가 넘긴 TLS 옵션을 덮어쓴다. 그래서 문자열에서 `sslmode`를 빼고 TLS 옵션을 직접 넘긴다.
   - 원격 DB의 `sslmode`
     - `verify-full`을 쓴다. `require`·`verify-ca`도 `verify-full`로 올린다.
     - 없음·`disable`·`prefer`·`allow`·`no-verify`, `sslrootcert`·`sslcert`·`ssl=` 매개변수는 설정 오류다(`config_DATABASE_URL_*`, 이름만).
     - TLS 없는 연결은 localhost·127.0.0.1·::1만이다(로컬 개발·시험).
   - 루트가 바뀌면(2031 만료 전 Supabase 교체 공지) 새 루트를 같은 방식으로 추가하는 PR이 필요하다.
4. **Vercel 동작 미검증**(이 저장소에서는 배포하지 않았다):
   - 재작성 목적지 쿼리의 `:path*` 치환
   - 외부 재작성(룸 발급)이 `Authorization`·`DPoP`·`X-Forwarded-For`를 넘기는지
   - `/api/internal/internal/v1/devices/:id` 재작성(함수 파일 `api/internal.js`와 같은 접두)
   - 한 함수에 네 서비스(번들 크기·콜드 스타트·인스턴스당 DB 연결 4개)
   - Cron 경로
   - pnpm 워크스페이스 밖 import 번들링(묶음 내용은 위 「배포 전 함수 묶음 점검」으로 로컬에서 본다)
   - 함수 런타임의 Node 버전(저장소는 26.x를 요구한다)
   - 확인 수단은 5절 스모크다. 로컬 시험은 같은 진입점을 Node HTTP 서버로 돌려 경로 복원·cron·조립을 본다.
5. **메일**: SES v2 어댑터가 있지만 기본은 모의 메일이다(`MAIL_PROVIDER=mock`). 3절 6번을 마치기 전에는 로그인 코드가 발송되지 않아 실제 로그인을 할 수 없다.
   - 송신 허용 목록은 어댑터가 강제한다. `POST https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails` 하나뿐이고, 리디렉션은 따르지 않는다. PC 엔진의 `packages/net` Egress에는 넣지 않았다. 서버만 SES로 보내므로 PC 허용 목록을 넓히지 않는다.
   - 본문은 종류별 고정 문구다. 값은 6자리 코드뿐이고 본문에만 있다(제목에는 없다). 이메일 주소는 수신자 칸에만 있다.
   - 재시도 분류: 429·한도·5xx·네트워크·시간 초과는 다시 보낼 수 있는 실패다. 401·403(키), 계정 정지·발송 중지·도메인 미인증(설정), 그 밖의 400(거부)은 다시 보내도 같다. 알림 큐는 앞의 것을 백오프로 미루고 뒤의 것은 바로 버린다(`account.notice_dropped.<종류>`). 로그인 코드 송신 실패는 지금처럼 요청 오류로 돌아간다.
   - 실제 AWS에 붙여 본 적은 없다. 시험은 가짜 SES 서버로 서명(AWS 공개 시험 벡터 포함)·본문·오류 분류를 본다.
6. **레지스트리**: 7절. 클라이언트 egress 허용 목록은 `https://tax.laf-co.com` 하나로 고정한다. Supabase 도메인은 클라이언트에 넣지 않는다(팀장 결정 2026-11-06).
7. **릴레이 큐 GET 응답 상한**: Vercel 함수 응답은 4.5MB이고 큐 상한은 6 MiB다. 큐 GET은 봉투 바이트 3 MiB씩 쪽으로 나눠 돌려준다(`more`, 선택 `after`, relay API.md). 클라이언트가 `more`를 보고 곧바로 다음 쪽을 읽게 하는 것은 `packages/remote` `drainQueue` 몫이다(그 전에는 ACK 뒤 다음 폴링에서 받는다).
8. **라이브 우편함(`RELAY_LIVE=1`) 켜기 전 체크**: 데스크톱은 라이브 WSS의 DPoP `htu`를 `https://rooms.tax.laf-co.com/v1/mailboxes/:id/live`(QR 호스트)로 만들고, 룸 호스트의 `RELAY_PUBLIC_ORIGIN`은 `https://tax.laf-co.com`이다. 켜는 PR에서 둘을 맞춘다(팀장 결정 2026-11-06, #145).

## 7. 레지스트리(정적 GET·투명성 로그·게시 관문·타임스탬프 자동 재서명)

팀장 결정 2026-11-06, D09 §8, ADR-013·023·028. 이 PR은 구성만 넣는다. 서명 의식(#149) 전이라 `REGISTRY__TRUST_ROOT_JSON`이 없고, 그동안 함수 경로는 `503 registry.unavailable`이다.

### 7.1 경로
- **공개 정적 GET**(`/registry/*`·`/policy/*`·`/packages/*`·`/releases/*`): Vercel 외부 재작성 → `https://gncmivowifnzqurroecr.supabase.co/storage/v1/object/public/sax-registry/<같은 경로>`.
  - 서명된 파일 그대로라 서버를 거칠 필요가 없다. 클라이언트가 검증한다(엔진 accept, 업데이터 verify).
  - Content-Type·Cache-Control은 게시할 때 객체 메타데이터로 둔다: 패키지 `application/octet-stream` + `max-age=31536000, immutable`, 인덱스·정책·status·폐기 목록 `application/json` + `max-age=60`, 릴리스 `.yml` `text/yaml` + `max-age=60`.
- **함수 `api/registry`**: `GET /registry/log/*`(투명성 로그 헤드·항목·증명)와 `PUT /admin/v1/*`(게시 관문)만 받는다. 그 밖은 404.
  - 게시 관문은 상시 서버와 같은 라우터다(`registryRouter`). 서명·monotonic·롤백 검사를 통과한 파일만 버킷에 쓰고, 쓰기 전에 로그 항목을 남긴다.
- **함수 `api/registry-cron`**(매시 15분, `Bearer <CRON_SECRET>`): 타임스탬프 자동 재서명.

### 7.2 타임스탬프 자동 재서명(`services/registry/src/resign.ts`)
- 키는 `REGISTRY__REGISTRY_LOG_SIGNING_KEY`(타임스탬프 역할 온라인 키, D09 §8.2) 하나다. 공개키가 `TRUST_ROOT_JSON.keys.timestamp`와 다르거나 다른 역할 키와 같으면 기동하지 않는다(503, 로그에는 `registry.start_failed.config_REGISTRY_LOG_SIGNING_KEY`만).
- 대상과 유효 기간: 폐기 목록 24시간, status 48시간, 정책(`current.json`·`{ver}.json`) 48시간, 로그 트리 헤드(30분보다 오래되면 같은 트리에 다시 서명).
  - 남은 기간이 절반 아래로 떨어지면 다시 서명한다(매시 cron이라 여유가 있다).
- **내용은 바꾸지 않는다.** 새로 쓰는 것은 `issuedAt`·`expiresAt`·`timestamp`뿐이다. 내용 서명(루트·정책·긴급 키)은 이 필드를 서명 바이트에서 빼므로 그대로 유효하다(엔진 SIGNING.md). 내용이 바뀌는 서명은 사람이 서명 의식 도구(#149)로 한다.
- 게시 전에 게시 관문과 같은 검증(`verifyRevoked`·`verifyStatus`·`verifyPolicy`, 저장본 대비 같은 monotonic·같은 내용)을 거친다. 저장본이 변조됐거나 정책 `{ver}.json`이 `current.json`과 다르면 다시 서명하지 않는다(`rejected:<코드>`).
- 순서: 로그 항목 → 저장본을 다시 읽어 그대로인지 확인 → 공개. 그사이 운영자 게시가 끼면 덮어쓰지 않고 그 회차를 건너뛴다(`changed`).
- 결과는 대상별 상태 이름만 응답한다: `resigned`·`fresh`·`missing`·`changed`·`rejected:<코드>`.
- 시험(`tests/services-registry-deploy.test.ts`): 재서명본을 엔진 `acceptRevoked`·`acceptStatus`·`acceptPolicy`가 직전 수용본 대비로 받고, 원본을 가진 다른 관문도 PUT으로 받는다. 긴급 키 status도 같다. 로그 헤드는 핀 고정 키로 검증된다.
- **첫 게시 도장**: 같은 키로 게시 관문이 `timestamp` 없이 올라온 정책·status·폐기 목록에 도장을 찍는다(재서명과 같은 `restamp`·유효 기간, [API.md](../registry/API.md) "첫 게시 도장"). 첫 폐기 목록·status는 이렇게 올라간다([PUBLISH-H01.md](../registry/PUBLISH-H01.md)).

### 7.3 사용자가 할 단계
1. **Supabase Storage**
   1. Storage → New bucket `sax-registry`, **Public**을 켠다. 파일 크기 상한은 24MB, 허용 MIME은 비워 둔다.
   2. Storage → Settings → **S3 Connection**을 켜고 **S3 access key**를 하나 만든다. 이 키는 Storage 전용이다(DB 권한 없음, 서비스 역할 키를 쓰지 않는다). 엔드포인트·리전 값을 확인한다.
2. **DB**: 4절대로 `supabase db push`(새 단계 `2026110601…` 두 파일만 적용된다). SQL Editor에서 `ALTER ROLE sax_registry WITH PASSWORD '…';`.
3. **Vercel env**(Production, 이름만. 값은 팀장이 만들어 넣는다)

| 이름 | 값 |
|---|---|
| `REGISTRY__TRUST_ROOT_JSON` | 서명 의식 뒤 핀 고정 공개키(공개 값, `services/registry/ENV.md` 형식). **없으면 레지스트리 함수 503** |
| `REGISTRY__REGISTRY_LOG_SIGNING_KEY` ⚿ | 타임스탬프 역할 시드(hex 64자). 공개키가 위 `keys.timestamp`와 같아야 한다 |
| `REGISTRY__REGISTRY_ADMIN_TOKEN` ⚿ | 게시 PUT의 `Authorization: Admin <token>`(32자 이상). 호스팅 쓰기 권한일 뿐 서명 권한이 아니다 |
| `REGISTRY__DATABASE_URL` ⚿ | 트랜잭션 풀러 URL, 사용자 `sax_registry.<ref>`, 끝에 `?sslmode=verify-full` |
| `REGISTRY__S3_ENDPOINT` | `https://gncmivowifnzqurroecr.supabase.co/storage/v1/s3` |
| `REGISTRY__S3_REGION` | 프로젝트 리전(예 `ap-northeast-2`) |
| `REGISTRY__S3_BUCKET` | `sax-registry` |
| `REGISTRY__S3_ACCESS_KEY_ID` ⚿, `REGISTRY__S3_SECRET_ACCESS_KEY` ⚿ | 1.2의 S3 access key |
| `CRON_SECRET` ⚿ | 공통 값 그대로(이미 있음) |

4. 배포 뒤 스모크
   - 의식 전: `GET /registry/log/head.json` → `503 {"error":"registry.unavailable"}`. `GET /registry/status.json` → Storage의 not found(400/404 JSON, 아직 파일이 없다). `GET /api/registry-cron`(Bearer 없이) → 401.
   - 의식 뒤(`TRUST_ROOT_JSON` 넣고 재배포): 로그 헤드 200, 게시 PUT 200, `GET /registry/status.json` 200(`cache-control: public, max-age=60`), Vercel 로그의 재서명 cron 200과 대상별 결과.

### 7.4 알려진 차이·미검증
- 의식 전 공개 정적 경로는 503이 아니라 Storage의 not found다(함수를 거치지 않기 때문). 본문은 `{"statusCode":"404","error":"not_found","message":"Object not found"}`(400, `max-age=0`)이다.
  - **판단(2026-11-06): 그대로 둔다.** 엔진 `registry-sync`는 404가 아닌 오류를 `registry.fetch_failed`로 다루지만, 어느 단계든 마지막 유효본을 유지하고 업데이터는 `feed_failed`로 멈춘다(fail-closed). 내용에 비밀·내부 정보가 없고 캐시되지 않는다.
  - 고치려면 공개 GET을 함수로 돌리거나(패키지 16MB가 함수 응답 상한을 넘는다) 클라이언트에 공급사 오류 모양을 넣어야 한다(ADR-015 위반). 둘 다 이득보다 비용이 크고, 이 창은 서명 의식에서 닫힌다.
- **패키지 게시 크기**: 게시 PUT 본문은 base64 JSON이라 함수 요청 상한(4.5MB) 때문에 원본 약 3.3MB를 넘는 `.sxp`는 함수로 올릴 수 없다. 그 크기가 생기면 관문 검증 뒤 서명된 업로드 URL로 바로 올리는 경로를 더한다(후속).
- Supabase 공개 객체가 S3로 넣은 `Cache-Control`·`Content-Type`을 그대로 돌려주는지는 배포 뒤 스모크로 확인한다.
- 게시 PUT의 직렬화(`serial`)는 인스턴스 안에서만이다. 운영자 게시 둘이 다른 인스턴스에서 겹치면 나중 쓰기가 이긴다(기존 상시 서버와 같은 한계, 게시는 운영자 한 명이 한다). 재서명과 게시가 겹치는 경우는 위 `changed`로 막는다.
