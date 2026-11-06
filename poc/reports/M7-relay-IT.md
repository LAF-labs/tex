# M7 시뮬레이터 통합 시험: 실제 릴레이·계정 서비스(#63) 위 큐 사진 전송 (2026-11-06)

**결과: 통과 1회.** 페어링 → 기기 토큰 → 큐 사진 전송 → ack까지 실제 `services/relay`·`services/account`(main d7ba693)로 돌렸다. 라이브 WSS는 꺼 두었다(Phase 1과 같다).

## 구성

- 실행: `cd poc/apps/mobile && STACK_LIVE=0 node --conditions=development dev/stack.ts`
- 앞단 `http://localhost:8787` 하나가 계정·릴레이 공개 origin이다(운영 `https://tax.laf-co.com`과 같은 구조). DPoP `htu`도 이 origin이다.
  - 릴레이: `/v1/mailboxes*`, `/v1/rooms*`(WSS 포함)를 `startRelay`로 보낸다.
  - 계정: 나머지 `/v1/*`를 `startAccount`(모의 메일·PG)로 보낸다.
  - 비밀(`TOKEN_SIGNING_SEED`, `QUEUE_KEY`, `INTERNAL_TOKEN`, `CODE_MAC_KEY`)은 기동마다 새로 만들고 출력하지 않는다.
- PC는 더미다(`dev/stack.ts`): 계정 로그인 → `POST /v1/aik` → 기기 토큰 → 페어링 → 번들 PUT → 2초마다 큐 드레인.
- 폰: iPhone 17 Pro 시뮬레이터, 앱은 바꾸지 않았다(개발 빌드, 견본 영수증).

## 흐름과 결과 ([stack.log](raw/m7-relay-it/stack.log), [relay-access.log](raw/m7-relay-it/relay-access.log))

| 단계 | 호출 | 결과 |
|---|---|---|
| PC 계정·AIK | `POST /v1/auth/code`·`verify`, `POST /v1/aik`, `POST /v1/device-tokens` | 200·200·201·200 |
| 페어링 룸 | `POST /v1/rooms` → WSS `/v1/rooms/:id` 양쪽 | 201, Noise XX·SAS 일치 |
| 폰 등록(대역) | `POST /v1/devices/enroll` (PC 세션) → `PUT /v1/device-list`(AIK 서명 목록, PC 기기 토큰) | 201·200 |
| 우편함 | `POST /v1/mailboxes` → `PUT /v1/mailboxes/:id/bundle`(Q_D, Vd 서명) | 201·204 |
| 폰 기기 토큰 | `POST /v1/device-tokens`(AIK 인증서 + Vm DPoP) | 200 |
| 라이브 시도 | WSS `/v1/mailboxes/:id/live` (PC 없음) | 3초 대기 뒤 큐로 넘어감 |
| 큐 전송 | `GET …/bundle` → `POST …/envelopes` ×6 (offer 1 + 32 KiB 청크 5) | 200 → 202 ×6 |
| PC 수신 | `GET …/envelopes` → 금고 대역 hpkeOpen → Vm 서명·seq 검사 → 저장 → `POST …/ack {seq}` | 4건 ack 4, 2건 ack 6, 버림 0 |
| 확인 | 저장된 JPEG SHA-256 = offer `sha256` | `d961f6f3…6bc8439`, 145,271 B |
| 재실행 | 앱 재시작 뒤 같은 사진 | TTL 안이라 다시 넣지 않음 |

화면:

| 페어링 완료 | 확인(견본) | 맡긴 뒤 | 첫 화면 |
|---|---|---|---|
| ![](raw/m7-relay-it/01-paired.png) | ![](raw/m7-relay-it/02-confirm.png) | ![](raw/m7-relay-it/03-saved.png) | ![](raw/m7-relay-it/04-home-queued.png) |

시험 중 고친 것: 첫 화면 상태 줄의 `queued` 문구가 길어 넘쳤다. "◐ PC 꺼짐 · 맡겨 둠 / 맡긴 것 N건"으로 줄이고 줄바꿈을 허용했다.

## 어긋나는 계약(팀장에게)과 결정

1. **폰 기기 등록 주체가 없다.** → 결정 (나): PC가 페어링 7단계에서 데스크톱 기기 토큰 + 소비된 1회용 룸 id로 대신 등록한다(클라우드 #115, 아래 재실행).
2. **페어링 3단계 `/v1/device-list`를 폰이 부를 수 없다.** → 결정: 3단계 검사는 `PAIR_OK`의 AIK 서명 목록으로 한다. 폰은 기기 목록을 조회하지 않는다(아래 재실행).
3. **번들이 없을 때도 `404 relay.mailbox_not_found`다.** → 결정: 단일 코드로 둔다(존재 오라클 방지). 폰 문구는 "PC와 연결을 확인할 수 없어요. PC를 켜 두거나 다시 연결하세요." + [다시 연결하기](#102). 시뮬레이터에서 번들 없는 실제 릴레이로 확인했다.
4. 큐는 PC → 폰 ack가 없다. → 결정: 이대로 둔다. PC 드레인은 offer id 기준 멱등(시험 `remote-queue` "24시간 뒤 다시 넣은 사진"). 데스크톱 배선은 데스크톱 트랙 몫.

## 재실행: PC 대리 등록·PAIR_OK 목록 검사 (2026-11-06, main 4c7aaee + 이 PR)

**결과: 통과 1회.** 대역(`/dev/account`, PC 세션 enroll)을 모두 뺐다. 폰은 페어링 중 계정 서비스를 부르지 않는다.

| 단계 | 호출 | 결과 |
|---|---|---|
| 폰 스캔 | QR 검사(만료·릴레이 허용 목록)만. 계정 서비스 호출 없음 | 바로 Noise XX·SAS 화면 |
| SAS 일치 뒤 PC 대리 등록 | `POST /v1/devices/enroll`(데스크톱 기기 토큰 DPoP, `roomId`) → 계정이 릴레이 `/internal/v1/rooms/:id/redeem` | 201 |
| 목록·우편함 | `PUT /v1/device-list`(AIK 서명, 폰 활성) → `POST /v1/mailboxes` → `pair.ok` | 200·201 |
| 폰 PAIR_OK 검사 | AIK 서명 목록·QR의 Sd가 데스크톱 항목·Cert_M·Kv 서명 | 통과, 저장 |
| 폰 기기 토큰 | `POST /v1/device-tokens` | 200 |
| 큐 전송 | 번들 GET → `POST …/envelopes` ×6 | 202 ×6 |
| PC 수신 | 개봉·검사·저장 → `POST …/ack {seq:6}` | 처리 6, 버림 0 |
| 확인 | 저장된 JPEG SHA-256 = offer `sha256` | `d961f6f3…6bc8439`, 145,271 B |

순서는 SAS 일치 → 대리 등록 → Cert_M·목록 서명·업로드 → 우편함 → `PAIR_OK`다. 룸은 한쪽이 나가면 폐기되므로 등록은 `PAIR_OK` 전에 한다. 로그: [stack.log](raw/m7-relay-it-2/stack.log), [access.log](raw/m7-relay-it-2/access.log). 기동에는 #115가 더한 `LIMIT_ID_KEY`(계정·릴레이 공통, 기동마다 새로)와 계정의 `RELAY_INTERNAL_URL`이 필요하다.

| 페어링 완료 | 확인(견본) | 맡긴 뒤 |
|---|---|---|
| ![](raw/m7-relay-it-2/01-paired.png) | ![](raw/m7-relay-it-2/02-confirm.png) | ![](raw/m7-relay-it-2/03-saved.png) |

계약 메모(클라우드): 같은 폰을 다시 연결할 때(같은 기기 ID) `POST /v1/devices/enroll`은 `400 request.param_rejected`이고, 룸은 그 전에 소비된다. 그래서 PC는 자기 AIK 서명 목록에 같은 키로 이미 있는 폰이면 등록을 건너뛴다(`DesktopPairing`). 등록만 되고 목록 업로드 전에 실패한 경우는 더미 PC가 `GET /v1/devices`로 같은 키를 확인해 성공으로 본다. 서버가 같은 계정·같은 키 재등록을 200으로 받아 주면 이 확인이 필요 없다.
