# 릴레이(D14 M7-3)

폰 ↔ PC 우편함(WSS)·오프라인 의도 봉투 큐·1회용 페어링 룸. 내용과 키를 볼 수 없다(Noise·HPKE 종단 간 암호문). API는 [API.md](API.md), 환경 변수는 [ENV.md](ENV.md).

**정직한 서술(C-14)**: 릴레이는 내용을 볼 수 없지만 '영지식'이 아니다. 운영자는 연결 시점·IP·깨우기 시각으로 계정↔우편함을 상관시킬 수 있다. 이 서비스는 그 연결을 저장하지 않을 뿐이다.

**침해되면 무엇이 새는가**(D09 §1): 우편함 ID·토큰의 해시(토큰 원문은 없어 우편함을 열 수 없다), 72시간 안의 봉인된 큐(QUEUE_KEY까지 새면 E2E 암호문, 평문은 없다), 7일 메시지 통계(우편함 없음), 기기당 우편함 개수. 침해 시점의 라이브 연결은 프레임 바이트와 접속 IP를 볼 수 있다. 대응: 큐 전면 폐기(`/internal/v1/queues/purge`) + PC의 우편함 재발급(`mbx.reissue`).

## 저장 컬럼 ↔ D09 §1.1 "릴레이"

`tests/services-relay.test.ts`가 `migrations/*.sql`과 [`src/visibility.ts`](src/visibility.ts)를 대조한다.

| 테이블 | 컬럼 | D09 §1.1 항목 |
|---|---|---|
| mailboxes | mbx_key, read_hash, write_hash, next_seq | 우편함 ID(해시만), 능력 토큰 해시, 메시지 수 |
| queue | mbx_key, seq, sealed, bytes, expires_at | 암호문 큐(72시간), 크기, 시각 |
| mailbox_bundles | mbx_key, sealed | **추가 필요**: 우편함 번들 슬롯(D08 §7) |
| mailbox_quota | device_id, n | **추가 필요**: 기기당 우편함 3개 상한용 개수(어느 우편함인지 없음) |
| relay_stats | day, kind, size_bucket, n | 메시지 수·크기 버킷·시각(7일), 바깥 kind |
| lim_salts | label, day, salt | 한도 키 솔트(KST 당일 행만, 다음 날 삭제). 공용 마이그레이션 `shared/migrations` |
| lim_windows | k, start_ms, n, expires_at | 한도 창(키는 HMAC만: IP·이메일은 당일 솔트, 계정·기기 ID는 서버 비밀. 창이 끝나면 sweep 삭제) |

없는 것: 평문 IP(한도 키는 당일 솔트 HMAC만, [CONTRACT §10](../shared/CONTRACT.md)), 계정 ID, 기기↔우편함 연결, 페어링 룸(메모리, 만든 데스크톱 기기 ID의 sha256과 소비 여부만 같이), Noise·HPKE 평문, 의도 봉투의 `pair_id`·`seq`·`exp`. 접근 로그는 라우트 패턴뿐이고 `aid`도 남기지 않는다.

## 구현 메모

- WebSocket은 의존성 없이 [`src/ws.ts`](src/ws.ts)가 RFC 6455의 필요한 부분만 구현한다(ADR-028 의존성 표면).
- 인스턴스 한 대 기준이다. 여러 대로 늘리면 라이브 우편함의 두 쪽이 같은 인스턴스에 붙도록 우편함 키로 L4 고정 라우팅하거나 인스턴스 사이 중계가 필요하다(Phase 1 범위 밖).

## 실행

```bash
cd poc && pnpm build
SAX_SQLITE_FILE=relay.db QUEUE_KEY=… LIMIT_ID_KEY=… RELAY_PUBLIC_ORIGIN=https://relay.example TOKEN_PUBLIC_KEYS=k1:… ACCOUNT_INTERNAL_URL=http://account:8080 INTERNAL_TOKEN=… node services/relay/dist/main.js
```

컨테이너: `docker build -f services/relay/Dockerfile .`(빌드 컨텍스트 `poc/`). 실제 배포는 Phase 1 범위 밖이다.

## 아직 하지 않는 것

- 클라이언트(데스크톱 main·폰 앱)의 Noise·HPKE·의도 봉투 처리: M7-2·M7-4.
- 오래 쓰지 않은 우편함 자동 정리(서버 시각 컬럼을 두지 않아서, ADR-029 결정 6). PC가 해제·재발급 때 지운다.
- 남용 방지 토큰의 비연결화(Privacy Pass 계열): Phase 3(SP-10).
