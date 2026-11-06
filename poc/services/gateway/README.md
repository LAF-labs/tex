# 모델 게이트웨이(D14 M4-6)

마스킹된 입력만 받아 번들·툴셋 정의를 서버에서 주입하고 공급사로 넘긴다. 요청·응답 본문은 메모리에서만 다룬다(D09 §3). API는 [API.md](API.md), 환경 변수는 [ENV.md](ENV.md).

**침해되면 무엇이 새는가**(D09 §1): 계정별 월 토큰 수·비용, 35일 안의 호출 기록(계정·기기·번들/툴셋 ID·토큰 수·시각), 계정 없는 운영 통계. 침해 시점에 처리 중이던 마스킹된 프롬프트·응답은 메모리에서 볼 수 있다. 마스킹 전 원문·비밀·볼트 열쇠는 이 서비스에 오지 않는다(ADR-029). 진위확인 프록시를 지나는 거래처 사업자번호는 저장하지 않는다.

## 저장 컬럼 ↔ D09 §1.1 "모델 게이트웨이"

`tests/services-gateway.test.ts`가 `migrations/*.sql`의 실제 컬럼과 `src/visibility.ts`를 대조한다.

| 테이블 | 컬럼 | D09 §1.1 항목·§3 계량 분리 |
|---|---|---|
| usage_monthly | account_id, month, input_tokens, output_tokens, cost_micro_usd | 계정, 토큰 수 — (1) 결제 레코드 `{account, month, tokens, cost}` |
| call_records | call_id, account_id, device_id, at, surface, input_tokens, output_tokens | 계정, `X-Device-Id`, 번들·툴셋 ID, 토큰 수, 시각 — (3) 호출 단위 계정 연결 35일 |
| ops_stats | day, surface, outcome, n, latency_ms_sum | 번들·툴셋 ID, 지연 — (2) 운영 통계(계정·기기 없음) |
| run_scopes | scope_hash, kind, l1, l2_calls, l2_turns, expires_at | **D09 추가 필요**: 실행 예산 카운터(범위는 HMAC, runId 원문 없음, 2시간) |
| lim_salts | label, day, salt | 한도 키 솔트(KST 당일 행만, 다음 날 삭제). 공용 마이그레이션 `shared/migrations` |
| lim_windows | k, start_ms, n, expires_at | 한도 창(키는 HMAC만: IP·이메일은 당일 솔트, 계정·기기 ID는 서버 비밀. 창이 끝나면 sweep 삭제) |
| int_nonces | nonce, expires_at | 내부 호출 서명의 1회용 무작위 값(요청 내용·출처 없음). 서명 시각 + 60초 뒤 삭제 |

D09 §3 (2)의 운영 통계 키 `playbook`은 게이트웨이 요청에 플레이북 ID가 없어 담지 않는다(번들·툴셋 단위).

## 공급사 중립(ADR-015)

공급사 와이어(필드 이름·경로)는 [`src/providers.ts`](src/providers.ts) 한 곳이다. 본체는 공급사 중립 요청(`DecideSpec`·`RespondSpec`)만 만든다.

- `OpenAICompatProvider`: OpenAI 호환 `/v1/decisions`·`/v1/responses`(주소·키는 환경 변수, 리다이렉트 금지). 본문 모양은 BYOK 어댑터(`packages/model` `OpenAIDecisionsAdapter.buildRequest`)와 같고 캐시 키·`safety_identifier`만 게이트웨이 정본이다(시험이 대조).
- `UpstageSystemOneStub`: S7 실측 전 자리. 호출하지 않고 `503`.
- `MockProvider`: 시험·개발용.
- 진위확인: `OdcloudNtsSource`(서비스 키는 환경 변수), `MockNtsSource`.

## 실행

```bash
cd poc && pnpm build
GW_PROVIDER=mock NTS_PROVIDER=mock … node services/gateway/dist/main.js
```

컨테이너: `docker build -f services/gateway/Dockerfile .`(빌드 컨텍스트 `poc/`). 실제 배포는 Phase 1 범위 밖이다.

## 아직 하지 않는 것

- 스트리밍 프록시(지금은 공급사 응답 전체를 받아 돌려준다. 본문은 여전히 메모리에서만).
- `summarize`·`intent_fill` 툴셋(정의가 `packages/model`에 생기면 붙는다).
