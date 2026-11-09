# ADR-042. 원장 시도 번호: 같은 실행의 재게이트는 새 시도로 남긴다

> 상태: 채택(팀장 결정 2026-11-09, (가) 채택·(나)(다) 기각, 조건 5개) · 엔진 M2-3 PR-D
> 관련: D07 §2 `irreversible_log`·B-10, D03 §2(전이표 `rewind.pre_gate`)·§4(원장), D02 §8 H-01(`s30.not_committed → s11`)·§7(직전 시도 경고), [ADR-021](ADR-021-pc-approval-evidence-main-approval-bar.md)(원장 HMAC·증언), [ADR-024](ADR-024-cross-pc-duplicate-warning.md)(verify_ref)

## 맥락

- D02 §8은 발급 안 됨(`s30.not_committed`)을 `s11`로 보내 폼을 다시 읽고 `s20` 게이트를 다시 지나게 한다. D03 §2도 `pre_dispatch_mismatch`·verify `not_committed`에서 `rewind.pre_gate`(게이트 앞으로)다.
  - 팀장 결정 2026-11-09: IR 전환 때 이 두 경우는 설계대로 같은 실행에서 두 번째 게이트를 연다. 재시도에는 반드시 새 사람 승인이 걸린다.
- 그런데 원장 키는 `PRIMARY KEY(intent_id, step_id)`다(D07 B-10). `not_committed`는 바뀌지 않는 종결이라, 같은 실행·같은 의도·같은 `s21`의 두 번째 무장은 `ledger_not_committed`로 거부된다.
  - 가짜 H-01 페이지로 끝까지 돌려 확인했다: 두 번째 승인 → `ledger.arm_failed` → 실패.
  - D02 §8·D03 §2의 재게이트와 D07 키가 서로 맞지 않았다.

## 선택지

| | (가) 시도 번호 | (나) 같은 행 다시 열기 | (다) 재게이트 안 함 |
|---|---|---|---|
| 방법 | 키를 `(intent_id, step_id, attempt)`로. 재게이트 때 새 번호로 `armed` | `not_committed → armed`를 새 토큰 소비와 한 트랜잭션에서만 허용 | H01처럼 실행을 끝내고 새 의도로 다시 |
| 첫 시도의 사유·`verify_ref` | 행으로 남는다(감사 근거) | 덮인다(저널에만) | 남는다 |
| 바뀌는 곳 | 스키마 판 올림(v8)과 이전 | 원장 API만 | 없음 |
| 결정 | **채택** | 기각: 감사 근거가 사라진다 | 기각: 팀장 결정 2026-11-09와 어긋난다 |

## 결정

1. **키**: `irreversible_log`의 키를 `PRIMARY KEY(intent_id, step_id, attempt)`로 바꾼다. `attempt`는 1부터다(`CHECK(attempt >= 1)`).
2. **불변식은 그 (intent, step)의 모든 시도에 건다.**
   - 어느 시도든 `committed`가 있으면 새 시도는 영원히 금지다(`ledger_committed`).
   - 종결되지 않은 행(`armed`·`dispatched`·`in_doubt`·`observed_manual`)이 하나라도 있으면 새 시도를 금지한다(`ledger_<상태>`).
   - 앞선 시도가 모두 `not_committed`일 때만 다음 번호를 허용한다.
   - 같은 의도의 재게이트만 새 시도다. 앞선 시도와 `playbook_id`·`inputs_hash`가 다르면 거부한다(`ledger_intent_mismatch`, B-10과 같은 뜻).
   - DB에도 건다: 부분 유일 색인 `ux_irr_live ON (intent_id, step_id) WHERE state <> 'not_committed'`. 그래서 (intent, step)마다 `not_committed`가 아닌 행은 많아야 하나다.
3. **새 시도는 새 게이트 토큰 소비와 같은 트랜잭션에서만 만든다**(`Ledger.consumeAndArm`).
   - 관측(`observedManual`, R-C2)은 새 시도를 만들지 않는다. 마지막 시도가 종결이면 지금처럼 던진다.
   - 후속 단계(`armFollowUp`)는 시도 1만 갖는다. 주 단계의 `committed`는 언제나 마지막 시도다.
4. **읽기**:
   - `Ledger.get(intent, step)`은 마지막 시도를 돌려준다. 열린 행은 있으면 언제나 마지막 시도다(결정 2).
   - `attempts(intent, step)`는 모든 시도를 돌려준다.
   - `checkIntent`는 모든 시도를 본다. 우선순위는 committed → 미종결 → 모두 not_committed다.
   - 업무 키 경고(`businessKeyStates`·`priorNotCommitted`, D02 §7)는 지금처럼 모든 행을 시간 순으로 본다. 그래서 재게이트 카드에 `$dup.priorNotCommitted`가 붙는다.
   - 실행의 원장 상태(`statesByRun`)도 모든 시도다. 앞선 committed가 있으면 정지 분기가 CompletedWithIssues다(D03 §2).
5. **이전(마이그레이션 v8)**:
   - 사용자 PC의 DB는 앱 업데이트 뒤 처음 열 때 자동으로 옮긴다. 방법은 표를 새로 만들어 이전 행을 `attempt = 1`로 옮기고, 색인 셋을 다시 만들고, `ix_irr_run`·`ux_irr_live`를 더하는 것이다.
   - 기존 이전 체계(D07 §7)를 따른다: 한 트랜잭션, 적용 전 암호문 백업. 실패하면 판 번호만 담은 `MigrationError`로 열지 않는다(fail-closed). DB는 이전 판 그대로 남는다.
   - 엔진은 DB를 열지 못하면 기동을 거부한다(`fatal`).
6. 실행 토큰·게이트 토큰·승인 근거는 바뀌지 않는다. 시도마다 게이트 요청(reqId)·토큰·승인이 새로 생긴다.

## 영향과 잔여 위험

- PoC 실발급 상한(ADR-025 결정 1)은 `committed·in_doubt·armed·dispatched` 행 수를 센다. `not_committed` 시도는 세지 않는다(지금과 같다).
- 같은 의도가 몇 번까지 재게이트할 수 있는지는 원장이 제한하지 않는다. 시도마다 사람 승인이 필요하고, 요청률 정책(D03 §7)이 상한이다.
- 원장을 직접 쓰는 코드는 `Ledger` 밖에 없다. 시험의 직접 INSERT는 `attempt`를 명시하도록 고쳤다(기본값을 두지 않는다).
- 시험:
  - `packages/db/test/ledger-attempt.test.ts`
    - ① 두 번째 승인으로 발급까지(첫 시도의 사유·verify_ref가 남음)
    - ② committed 뒤 새 시도 거부
    - ③ in_doubt 등 미종결이 남았을 때 거부
    - ④ v7 → v8 전후 동치·실패 시 fail-closed
    - 관측·다른 입력 거부, DB 불변식
  - `tests/h01-golden.test.ts` `[IR ①]`·`[IR ②]`: 가짜 H-01 페이지에서 두 번째 승인 → 발급

## 문서 반영

- D07 §2 DDL·B-10: 키와 불변식
- D03 §4: 원장 키와 재실행 금지 문장
- D02 §8 `s30`: 재게이트는 새 시도라는 한 줄
