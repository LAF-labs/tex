# ADR-043. 인덱스의 내용 서명과 신선도 서명을 나눈다

> 상태: 채택(팀장 결정 2026-11-09) · 클라우드 트랙(레지스트리 게시 관문·재서명 cron·게시 도구)과 엔진(`acceptIndex`)
> 관련: [SIGNING.md](../schemas/SIGNING.md) §2·§4, D09 §8.2·§8.4, [ADR-013](ADR-013-registry-threshold-signing-transparency.md)(임계 서명·투명성 로그), [ADR-023](ADR-023-policy-poll-interval.md)(조회 주기), [ADR-028](ADR-028-supply-chain-update-signing-roles.md)(서명 역할), 팀장 결정 2026-11-06(타임스탬프 자동 재서명), [ADR-037](ADR-037-phase1-registry-solo-software-keys.md)(Phase 1 1인 소프트웨어 키)

## 맥락

- 지금 인덱스(`registry/{channel}/index.json`)는 패키지 키 2-of-3이 `JCS(index − signatures)`에 서명한다. `issuedAt`·`expiresAt`(≤ 14일)이 서명 대상에 들어 있고 타임스탬프 서명은 없다(SIGNING.md §2).
- 그래서 인덱스의 신선도를 늘리려면 내용이 그대로여도 사람이 패키지 키로 다시 서명해야 한다.
  - Phase 1에서는 사용자가 14일마다 Touch ID를 2번 눌러야 한다(PUBLISH-H01.md "14일마다").
  - 이것을 놓치면 엔진이 만료된 인덱스를 받지 않는다(`registry.expired_on_arrival`). 설치된 패키지는 계속 돌지만, 새 판 배포와 새 PC 첫 설치가 멈춘다.
- 정책·status·폐기 목록·트리 헤드는 이미 내용 서명과 신선도 서명이 나뉘어 있다. 신선도는 온라인 타임스탬프 키(timestamp-1)로 cron이 다시 서명한다.
  - 근거: 팀장 결정 2026-11-06, `services/registry/src/resign.ts`.
  - TUF의 timestamp 역할과 같은 구조다.

## 선택지

| | (가) 인덱스도 나눈다 | (나) 사람이 14일마다 | (다) 인덱스 기간을 늘린다 |
|---|---|---|---|
| 방법 | 내용 = 패키지 키 2-of-3, 신선도 = timestamp 키(cron 재서명) | 지금 그대로 | 상한을 예컨대 90일로 |
| 사람 일 | 내용이 바뀔 때만 | 14일마다 Touch ID 2번 | 90일마다 |
| 동결 공격(오래된 인덱스를 계속 보여 줌) | 온라인 키가 48시간마다 갱신하므로 창이 48시간 | 14일 | 90일 |
| 결정 | **채택** | 기각: 놓치면 배포가 멈춘다 | 기각: 동결 창이 넓어진다 |

## 결정

1. **내용 서명**
   - 패키지 키 2-of-3이 서명한다. 대상은 `JCS(index − signatures·issuedAt·expiresAt·timestamp)`다. 정책·status·폐기 목록과 같은 "내용 서명 바이트"다(엔진 `contentBytes`, 레지스트리 `contentDigest`).
   - 내용 다이제스트 `contentDigest` = SHA-256(이 바이트)다.
   - 내용(항목·`monotonic`·`channel`·`keyEpoch`)이 바뀔 때만 사람이 서명한다.
2. **신선도 서명**
   - 인덱스에 `timestamp` 필드를 더한다. 필수다.
   - 서명 대상은 `JCS({contentDigest, monotonic, issuedAt, expiresAt})`이고, 온라인 타임스탬프 키 1개가 서명한다(SIGNING.md §4와 같다).
   - 타임스탬프 키가 폐기 목록에 있으면 받지 않는다(`registry.timestamp_invalid`).
3. **기간**
   - 서버는 48시간 기간으로 붙인다(`RESIGN_TTL.index`, status와 같다).
   - 받는 쪽 상한은 14일 그대로다(`registry.index_validity_too_long`). `issuedAt` 미래 금지(+5분)와 도착 시 만료 금지도 그대로다.
4. **누가 붙이나**
   - 게시 관문은 `timestamp` 없이 올라온 인덱스에 첫 게시 도장을 찍는다(정책·status·폐기 목록과 같은 `stamped`). 그다음 같은 규칙으로 검증한다.
   - 정리 cron(`resignAll`)은 채널마다(stable·beta·hotfix) 남은 기간이 절반 아래면 같은 내용에 다시 서명한다.
     - 다시 서명한 문서는 공개 전에 게시 관문과 같은 검증(`verifyIndex`)을 통과해야 한다.
     - 공개 전에 로그를 먼저 쓴다. 그사이 저장본이 바뀌었으면 그 회차는 건너뛴다(`changed`).
   - cron은 내용(항목)을 바꾸지 않는다. 가리키는 패키지도 다시 검증하지 않는다. 그 검증은 게시 때 관문이 했고, 패키지 경로는 불변이다.
5. **단조**
   - 같은 `monotonic`은 내용 다이제스트가 같을 때만 받는다(신선도 재서명). 다른 규칙(저장값 < 새 값 ≤ 저장값 + 1000, keyEpoch 롤백 금지)은 그대로다.
   - 엔진이 저장해 둔 인덱스의 다이제스트도 같은 내용 다이제스트로 센다.
6. **게시 도구(PUBLISH-H01.md)**
   - 사용자가 서명하는 인덱스 초안에 `issuedAt`·`expiresAt`·`timestamp`가 없다. 서버가 올릴 때 붙인다.
   - "14일마다 인덱스 다시 서명" 절차는 없앤다.
   - 착수 전 기준 인덱스가 바뀌었는지는 바이트가 아니라 `monotonic`·내용 다이제스트로 본다. cron 재서명은 바이트만 바꾸기 때문이다.
7. **옛 형식은 받지 않는다.** 운영 레지스트리에 게시된 인덱스가 아직 없고(2026-11-09 확인), 엔진도 아직 배포 전이다. 그래서 옛 형식과 나란히 받는 기간을 두지 않는다. 시험 시료(`tests/fixtures/registry`)는 새 형식으로 다시 만든다.

## 영향과 잔여 위험

- **타임스탬프 키가 새면** 공격자가 지난 인덱스(내용 서명이 유효한 것)에 새 신선도를 붙여 보여 줄 수 있다.
  - 이미 더 새 인덱스를 받은 PC는 단조 규칙으로 거부한다.
  - 처음 받는 PC와 오래 꺼져 있던 PC는 속을 수 있다.
  - 이것은 status·정책·폐기 목록에도 이미 있는 위험이다. 대책은 투명성 로그(모든 게시를 먼저 기록, D09 §8.3), 타임스탬프 키 폐기(루트 2-of-3), Phase 2 외부 증인이다.
  - 옛 방식에서도 패키지 키로 서명된 14일짜리 인덱스는 그 기간 안에는 같은 공격이 됐다.
- **cron이 48시간 넘게 멈추면** 인덱스가 만료된다. 그러면 새 판과 첫 설치가 멈춘다(설치본은 계속 돈다).
  - status도 같은 cron이 48시간으로 갱신한다. 그래서 cron이 멈추면 어차피 데몬이 먼저 멈춘다(`daemon_stop`). 인덱스만의 새 의존은 아니다.
- 핫픽스 채널 인덱스도 같은 규칙이다. 핫픽스 문서 자체의 만료(≤ 14일, 문서 안, 패키지 키 서명)는 그대로라, 인덱스 재서명으로 핫픽스가 연장되지 않는다.
- 바뀌는 곳:
  - SIGNING.md §2·§4, D09 §8.4
  - `services/registry/src/verify.ts` `verifyIndex`, `app.ts`(인덱스 PUT 도장), `resign.ts`(인덱스 채널 재서명)
  - `ceremony/content.ts`(index 내용 바이트·타임스탬프 대상)
  - `publish/pipeline.ts`
  - 엔진 `packages/engine/src/registry-sync.ts` `acceptIndex`·저장 인덱스 다이제스트
  - 시료 `tests/registry-samples.ts`
- 시험:
  - `tests/services-registry.test.ts`: 인덱스 첫 게시 도장, cron 인덱스 재서명, 같은 monotonic 다른 내용 거부
  - `tests/engine-registry-sync.test.ts`: timestamp 없음·틀림·폐기된 timestamp 키 거부, 재서명본 수용
  - `tests/registry-publish.test.ts`: 초안에 신선도 필드 없음, cron 재서명 뒤에도 push 진행
