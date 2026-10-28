# D16. 오류·결과 코드 체계 (초안)

모든 `StepResult.code`, 텔레메트리 `code`, 데몬 원인 코드, 게이트웨이 응답, 핸드오프 사유, 사용자 메시지는 이 체계에서 나온다. 형식 `<영역>.<코드>`, 소문자 스네이크. 값(화면 텍스트·입력)은 코드에 넣지 않는다.

| 영역 | 코드 | 뜻 | 사용자 메시지 키 | 복구 |
|---|---|---|---|---|
| `step` | `selector_miss` | 셀렉터 후보 전부 실패 | `err.step.selector_miss` | L0→L1 |
| `step` | `timeout` | 스텝 타임아웃 | `err.step.timeout` | L0 |
| `step` | `assert_failed` | 조건 거짓 | `err.step.assert_failed` | onFail |
| `step` | `readback_mismatch` | 되읽은 값 ≠ 입력값 | `err.step.readback_mismatch` | 재게이트 |
| `gate` | `denied` / `expired` / `token_invalid` / `token_consumed` | 승인 거부 / 대기 만료 / 위조·타 실행 토큰(보안 이벤트) / 재사용 | `err.gate.*` | Aborted / Paused / 중단 / 중단 |
| `human` | `ttl_expired` / `channel_unavailable` | 입력 TTL 초과 / 로컬·폰 모두 없음 | `err.human.*` | Paused |
| `vault` | `denied` / `not_secret_slot` / `origin_not_allowed` / `blocked_by_module` / `locked` | 타이피스트 거부 사유 | `err.vault.*` | human:secret |
| `ledger` | `in_doubt` / `duplicate_business_key` | 결과 미확정 / 업무 키 중복 경고 | `err.ledger.*` | InDoubt / 카드 경고 |
| `commit_guard` | `blocked_request` | 무장 없이 커밋 요청 시도(보안 이벤트) | `err.commit_guard.blocked` | 중단 |
| `verify` | `committed` / `not_committed` / `unknown` | 조회 결과 | — | 분기 |
| `decide` | `unknown` / `refusal` / `budget_exceeded` / `unavailable` | 판정 불가 / 질문 거절 / 실행 예산 초과 / 게이트웨이 불가 | `err.decide.*` | handoff |
| `recover` | `l2_rejected_identity` / `l2_exhausted` | 동일성 8항 실패 / 시도 상한 | `err.recover.*` | handoff |
| `policy` | `rate_limited` / `cooldown` / `clock_rollback` / `portal_mode_denied` | 상한·쿨다운·시계 역행·운영 수준 불허 | `err.policy.*` | 대기/거부 |
| `portal` | `blocked` / `logged_out_other_session` / `captcha` / `mfa_pending` / `session_expired` | 포털 상태 | `err.portal.*` | 중단+쿨다운 / 일시정지 / human / wait / checkpoint |
| `browser` | `launch_failed` / `webdriver_selfcheck_failed` / `profile_locked` / `crashed` | 금고의 Chrome 기동·점검 | `err.browser.*` | 사용자 안내 |
| `gateway` | `unauthorized` / `quota_exceeded` / `digest_mismatch`(409) / `param_rejected`(400) / `upstream_error` | 게이트웨이 응답 | `err.gateway.*` | — |
| `remote` | `pairing_failed` / `sas_mismatch` / `device_revoked` / `envelope_rejected` / `replay_detected` | 리모트 프로토콜 | `err.remote.*` | — |
| `daemon` | `window_closed` / `pc_busy` / `in_doubt_pending` / `consent_missing` / `demoted_to_notify` | 스케줄러 | `err.daemon.*` | — |
| `postprocess` | `file_not_detected` / `pdf_unreadable` / `meta_extraction_failed` / `sync_folder_warning` | 후처리 모드 | `err.postprocess.*` | 수동 메타 입력 |
| `run` | `completed` / `completed_with_issues` / `failed` / `aborted` / `interrupted` / `in_doubt` | 종료 상태 | `run.status.*` | — |

규칙: 보안 이벤트는 `gate.token_invalid`, `gate.token_consumed`, `commit_guard.blocked_request`, `remote.replay_detected`, `vault.origin_not_allowed`뿐이다. 만료·거부는 보안 이벤트가 아니다. 텔레메트리에는 코드만 보내고 메시지 키는 로컬에서 해석한다.
