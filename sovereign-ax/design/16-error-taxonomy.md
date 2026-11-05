# D16. 오류·결과 코드 체계 (초안)

> 팀장 결정 2026-11-05: 클라우드 PR #46 `PROPOSED_D16`의 나머지와 엔진 PR #52의 `registry.revoked_shrunk`를 아래 표와 "서버 응답 코드" 절에 추가.
> 같은 날 팀장 결정: 모델·egress PR #48의 `egress.pii_tripwire`·`egress.image_rejected`·`egress.unminted_text`를 표와 보안 이벤트 목록에 추가.
> 클라우드 PR #46 반영 2026-11-05(팀장 결정): `account.device_hold`(423, 기기 추가 72시간 대기) 추가. PR #46의 나머지 `PROPOSED_D16` 코드는 아직 넣지 않았다.
> v1.3 — 공격표면 감사(research/AUDIT-A·B·C, design/19-attack-surface.md) 반영. 신규 코드와 보안 이벤트를 추가하고 리모트 오류 코드의 송신 범위를 정했다(C/X-12). 재감사(E) 반영 코드: `policy.stale`, `policy.issued_in_future`, `vault.secret_window_close_denied`, `ledger.concurrent_other_pc`, `registry.head_mismatch`(Phase 1 미러 비교). · AUDIT-D 반영 2026-11-03: 아래 `portal`·`policy` 행 뒤의 AUDIT-D 행(ADR-025~029, D19 §3.5).

모든 `StepResult.code`, 텔레메트리 `code`, 데몬 원인 코드, 게이트웨이 응답, 핸드오프 사유, 사용자 메시지는 이 체계에서 나온다. 형식 `<영역>.<코드>`, 소문자 스네이크. 값(화면 텍스트·입력·셀렉터 문자열·비밀 길이)은 코드에 넣지 않는다.

| 영역 | 코드 | 뜻 | 사용자 메시지 키 | 복구 |
|---|---|---|---|---|
| `step` | `selector_miss` | 셀렉터 후보 전부 실패 | `err.step.selector_miss` | L0→L1 |
| `step` | `timeout` | 스텝 타임아웃 | `err.step.timeout` | L0 |
| `step` | `assert_failed` | 조건 거짓 | `err.step.assert_failed` | onFail |
| `step` | `readback_mismatch` | 되읽은 값 ≠ 입력값, 또는 DOM 값·접근성 값·표시 요소 불일치(B-06) | `err.step.readback_mismatch` | 재게이트 |
| `step` | `identity_mismatch` | 액추에이션 직전 실제 역할·이름·랜드마크가 사전과 다름(R-A1, B-01) | `err.step.identity_mismatch` | onFail / 커밋 구간이면 클릭 안 함 → 핸드오프 |
| `step` | `commit_shadow` | 비커밋 항목으로 해석된 요소가 커밋 버튼 이름·`DENY_ACTION_NAME`에 맞거나, 같은 랜드마크의 커밋 항목과 같은 요소로 해석됨(R-A2)(B-01, E-03, **보안 이벤트**) | `err.step.commit_shadow` | 클릭 안 함, 핸드오프 |
| `step` | `pre_dispatch_mismatch` | 토큰 소비 뒤 클릭 직전 readback 재계산 불일치(R-G7) | `err.step.pre_dispatch_mismatch` | 원장 `not_committed`, 게이트 앞 |
| `gate` | `denied` / `expired` / `token_invalid` / `token_consumed` | 승인 거부 / 대기 만료 / 위조·타 실행 토큰(보안 이벤트) / 재사용 | `err.gate.*` | Aborted / Paused / 중단 / 중단 |
| `gate` | `edit_requested` | 승인 대기 중 사용자 "수정하기"(R-G6) | `err.gate.edit_requested` | 게이트 앞으로 |
| `human` | `ttl_expired` / `channel_unavailable` | 입력 TTL 초과 / 로컬·폰 모두 없음 | `err.human.*` | Paused |
| `vault` | `denied` / `not_secret_slot` / `origin_not_allowed` / `blocked_by_module` / `locked` | 타이피스트 거부 사유 | `err.vault.*` | human:secret |
| `vault` | `cdp_denied` | 중계가 거부 목록 CDP 호출(브라우저 타깃·Storage·다운로드 경로 변경 등)을 거부(A-01·A-13, **보안 이벤트**) | `err.vault.cdp_denied` | 중단 |
| `vault` | `preinjected_script` | 비밀 origin에 엔진이 미리 등록한 문서 스크립트·바인딩이 있어 비밀 창 거부(A-07, **보안 이벤트**) | `err.vault.preinjected_script` | human:secret(직접 입력) |
| `vault` | `profile_prefs_mismatch` | 전용 프로필의 비밀번호 저장·자동완성 끄기 설정 재확인 실패(A-10) | `err.vault.profile_prefs_mismatch` | 비밀 창 거부, 사용자 안내 |
| `vault` | `origin_left` | 엔진에 노출된 타깃이 `내장 eTLD+1 ∩ domains` 밖으로 이동(A-12, **보안 이벤트**) | `err.vault.origin_left` | 엔진 세션 분리, 중단 |
| `vault` | `dbkey_requested_twice` | DB 키 요청이 금고 기동당 2회째(A-24, **보안 이벤트**) | `err.vault.dbkey_requested_twice` | 거부 |
| `vault` | `extension_not_allowed` | 전용 프로필에 허용 목록 밖 확장(A-11) | `err.vault.extension_not_allowed` | 비밀 창 거부, 제거 안내 |
| `storage` | `acl_weak` | 사용자 지정 보관함 폴더의 접근 권한이 약함(A-19) | `err.storage.acl_weak` | 경고, 기본 위치 권장 |
| `ledger` | `in_doubt` / `duplicate_business_key` | 결과 미확정 / 업무 키 중복 경고(포털 기존 건은 `portal_existing`, Phase 2 기기 간 표시 포함) | `err.ledger.*` | InDoubt / 카드 경고 |
| `ledger` | `portal_existing` | 게이트 직전 verify 기준선 B₀에 이 PC 원장에 없는 같은 건 승인번호가 있음(다른 PC·포털 직접 발급, `$dup.portalExisting`, ADR-024) | `err.ledger.portal_existing` | 카드 경고(차단 아님) |
| `ledger` | `concurrent_other_pc` | 게이트 직전 조회에서 다른 PC의 `armed` 표시(10분 이내) 발견(E-13, Phase 2·데스크톱 2대 계정, ADR-024) | `err.ledger.concurrent_other_pc` | 카드 경고(차단 아님) |
| `ledger` | `observed_manual` | 핸드오프 중 커밋 요청 관측 또는 "직접 발급함"(R-C2, B-04) | `err.ledger.observed_manual` | 재개 전 verify |
| `ledger` | `intent_reuse` | 같은 intentId에 다른 입력·플레이북(B-10, **보안 이벤트**) | `err.ledger.intent_reuse` | 거부 |
| `commit_guard` | `blocked_request` | 무장 없이 커밋 요청 시도(보안 이벤트) | `err.commit_guard.blocked_request` | 중단 |
| `commit_guard` | `unclassified` | 커밋·알려진 엔드포인트 어디에도 없는 포털 요청(R-C3, 기록만) | — | 없음(Phase 2 승격 검토) |
| `commit` | `confirm_accepted` | 무장 구간에서 `expectConfirm` 일치 confirm 수락, 텍스트 해시 기록(V-24) | — | 저널만 |
| `security` | `commit_payload_mismatch` | 커밋 요청 본문 ≠ readback 값(R-C1, 금고가 대조해 `match:false`, **보안 이벤트**) | `err.security.commit_payload_mismatch` | 요청 중단, 원장 `not_committed`, 핸드오프 |
| `verify` | `committed` / `not_committed` / `unknown` | 조회 결과 | — | 분기 |
| `verify` | `baseline_missing` | 게이트 직전 기준선 조회 실패(B-07) | `err.verify.baseline_missing` | 게이트 열지 않음, 핸드오프 |
| `decide` | `unknown` / `refusal` / `budget_exceeded` / `unavailable` | 판정 불가 / 질문 거절 / 실행 예산 초과 / 게이트웨이 불가 | `err.decide.*` | handoff |
| `recover` | `l2_rejected_identity` / `l2_exhausted` / `l2_needs_confirm` / `l2_risk_flagged` | 동일성 10항 실패 / 시도 상한 / `click`·`press` 제안은 사용자 확인 필요(B-16) / 모델이 `risk_flags`를 붙임(B-17) | `err.recover.*` | handoff |
| `policy` | `rate_limited` / `cooldown` / `clock_rollback` / `portal_mode_denied` / `expired` | 상한·쿨다운·시계 역행·운영 수준 불허·정책 만료 후 168시간 경과(전 포털 postprocess, E-05) | `err.policy.*` | 대기/거부 |
| `policy` | `stale` | 정책 신선도 만료(마지막 유효 정책 유지·완화 금지·데몬 중지·핫픽스 로드 거부, E-05) | `err.policy.stale` | `auto` 실행마다 경고 |
| `policy` | `issued_in_future` | 정책·status의 `issuedAt`이 현재 시각 + 5분보다 미래(E-05, **보안 이벤트**) | — | 그 파일 거부, 마지막 유효 정책 유지 |
| `policy` | `clamped` | 정책 필드가 앱 내장 상한·하한을 넘어 그 필드만 고정(B-23) | — | 저널·텔레메트리 |
| `policy` | `rejected_not_conservative` | 긴급 키 단독 서명 정책이 현재보다 엄격하게 보수적이지 않음(C-26, **보안 이벤트**) | — | 거부, 현재 정책 유지 |
| `registry` | `signature_insufficient` / `hotfix_rejected` | 2-of-3 서명 부족 / 핫픽스 범위·결속·재검증 실패(B-01, B-22) | `err.registry.*` | 로드 거부 |
| `registry` | `status_stale` | 레지스트리 status 48시간 초과(72시간이면 데몬 중지, B-22) | `err.registry.status_stale` | `auto` 실행마다 경고 |
| `registry` | `version_jump_rejected` | 같은 `keyEpoch` 안 버전 점프 > 1000(C-26, **보안 이벤트**) | — | 거부 |
| `registry` | `key_revoked` | 폐기 목록에 있는 키의 서명(C-26, **보안 이벤트**) | — | 그 서명 무시 |
| `portal` | `blocked` / `logged_out_by_other_session` / `captcha` / `mfa_pending` / `session_expired` | 포털 상태(`blocked`는 모델 판정 또는 결정적 차단 신호 사전, C-24) | `err.portal.*` | 중단+쿨다운 / 일시정지 / human / wait / checkpoint |
| `portal` | `unexpected_page` / `extra_auth_repeat` / `unobservable` / `unknown_screen` | 기대 경로 밖 화면, 로그인 밖 반복 추가 인증(차단 신호 보고 제외), 화면 확인 불가로 게이트·커밋 전 정지, 기대 화면 미도착 누적(ADR-025) | `err.portal.*` | handoff / 보수 모드·쿨다운 |
| `policy` | `poc_irreversible_total` | PoC 누적 실발급 3건 도달(ADR-025) | `err.policy.poc_irreversible_total` | 시작 거부 |
| `assert` | `issue_date_mismatch` | 포털 작성일자 ≠ 실행 시작 KST 날짜(ADR-027) | `err.assert.issue_date_mismatch` | 게이트 전 정지 |
| `vault` | `leak_suspected` / `keystore_mismatch` / `credential_suspect` | 알려진 값 치환 적중, DB 키 길이 불일치(기동 거부), 포털 인증 실패 뒤 저장 자격 보류(ADR-025·026·029, **보안 이벤트**: `leak_suspected`·`keystore_mismatch`) | `err.vault.*` | 정지 / 기동 거부 / 금고에서 확인 |
| `db` | `key_missing` / `locked_by_other_instance` | 키 항목 없음 + DB 파일 있음(새 키 생성 금지), 두 번째 인스턴스(ADR-025·029) | `err.db.*` | 기동 거부·복구 화면(Phase 1) |
| `engine` | `env_tampered` / `vault_port_unsupported` | 디버그·TLS 변조 환경 변수, 옛 기동 경로(ADR-025) | `err.engine.*` | 기동 거부 |
| `browser` | `launch_failed` / `webdriver_selfcheck_failed` / `profile_locked` / `crashed` | 금고의 Chrome 기동·점검 | `err.browser.*` | 사용자 안내 |
| `gateway` | `unauthorized` / `quota_exceeded` / `digest_mismatch`(409) / `param_rejected`(400) / `upstream_error` | 게이트웨이 응답. 요청 규범은 `schemas/gateway-request.schema.json` | `err.gateway.*` | — |
| `gateway` | `pii_tripwire` | 게이트웨이 2차 식별자 트립와이어 적중, 공급사로 보내지 않음(B-18, **보안 이벤트**, 카운트만) | `err.gateway.pii_tripwire` | 해당 호출 `unknown` |
| `egress` | `pii_tripwire` / `image_rejected` / `unminted_text` | 클라이언트 송신 직전 검사(BYOK·게이트웨이 두 경로): 마스킹 안 된 식별자 패턴 적중으로 송신 차단 / 이미지 송신 거부 / `RedactedText` 브랜드(`mint()` 영수증)가 없는 문자열 송신 시도. 이벤트는 `{code, surface, path: byok\|gateway}`만 담고 본문은 담지 않는다(PR #48, **보안 이벤트**) | `err.egress.*` | 송신하지 않음, 해당 호출 `unknown`(`guard:*`) |
| `remote` | `pairing_failed` / `sas_mismatch` / `device_revoked` / `envelope_rejected` / `replay_detected` | 리모트 프로토콜. **로컬 UI 전용, 프로토콜로 송신 금지**(실패는 무응답, C/X-12) | `err.remote.*` | — |
| `remote` | `hw_key_required` | 비가역 원격 승인에 하드웨어 키 서명이 없음(C-06, Phase 2). 로컬 UI 전용 | `err.remote.hw_key_required` | 로컬 승인으로 |
| `pairing` | `new_desktop_warning` | 최근 24시간 안에 새 데스크톱이 페어링됨(C-01) | `err.pairing.new_desktop_warning` | 사용자 확인 |
| `vault` | `google_signin_detected` / `secret_window_refused` / `crypto_rate_anomaly` / `secret_window_close_denied` | 전용 프로필에 Google 로그인 감지(A-10) / 비밀 창 개시 거부(사유 포함) / 장기 키 연산 호출 빈도 이상(C-19, **보안 이벤트**) / 엔진의 활성 창 종료 요청을 금고가 거부(대상 노드 포커스 유지, E-01) | `err.vault.*` | 비밀 창 거부·안내 / human:secret / 거부·경고 / 활성 창 유지 |
| `postprocess` | `open_denied` | `openExternal` 대상이 https·내장 eTLD+1 허용 목록 밖(A-17, **보안 이벤트**) | `err.postprocess.open_denied` | 열지 않음 |
| `pairing` | `aik_mismatch` | 서버가 준 `AIK_pub`와 `PAIR_OK`의 값 불일치(C-01, **보안 이벤트**) | `err.pairing.aik_mismatch` | 페어링 중단 |
| `remote` | `daily_limit` / `new_counterparty_local_only` | 원격 비가역 일일 상한 도달 / 처음 쓰는 거래처·수신자는 PC 로컬 승인만(C-06). 로컬 UI 전용 | `err.remote.*` | 로컬 승인으로 |
| `queue` | `qd_expired` | 만료된 `Q_D`로는 의도를 봉인하지 않음(C-17, 폰 UI 전용) | `err.queue.qd_expired` | "PC가 오래 꺼져 있음" 안내 |
| `devlist` | `version_mismatch` | 기기 목록 버전 불일치로 비가역 승인·비밀 요청 보류(C-20) | `err.devlist.version_mismatch` | 목록 갱신 후 재시도 |
| `registry` | `head_mismatch` / `revocation_stale` | 투명성 로그 헤드 불일치: Phase 1은 레지스트리와 별도 호스트 미러의 헤드 비교(E-14), Phase 2부터는 폰·PC 헤드 교환 포함(split-view 의심, **보안 이벤트**) / 폐기 목록 신선도 24시간 초과(C-26) | `err.registry.*` | 경고·새 로드 보류 |
| `account` | `recovery_hold` | 새 PC·PASS 복구 뒤 지연 기간 중(C-21, ADR-029) | `err.account.recovery_hold` | 대기 |
| `account` | `device_hold` | 이메일 세션으로 추가한 기기의 72시간 대기 중(HTTP 423, D09 §2.2, `recovery_hold`와 구분, 클라우드 PR #46) | `err.account.device_hold` | 대기 |
| `registry` | `revoked_shrunk` | 새 `revoked_keys.json`이 저장된 목록보다 짧거나 이전 키가 빠짐(롤백 방지, D09 §8.4, ADR-028 결정 8, 엔진 PR #52, **보안 이벤트**) | — | 그 목록 거부, 마지막 유효 목록 유지 |
| `registry` | `expired` / `issued_in_future` / `not_found` | 레지스트리 메타데이터 만료 / `issuedAt`이 현재 + 5분보다 미래(**보안 이벤트**) / 패키지·파일 없음(클라우드 PR #46) | `err.registry.*` | 로드 거부, 마지막 유효 상태 유지 |
| `daemon` | `window_closed` / `pc_busy` / `in_doubt_pending` / `consent_missing` / `demoted_to_notify` | 스케줄러 | `err.daemon.*` | — |
| `daemon` | `effects_denied` | 데몬 트리거인데 `manifest.effects ⊄ {issue_document}`(R-D1, B-27) | `err.daemon.effects_denied` | 실행 안 함 |
| `postprocess` | `file_not_detected` / `pdf_unreadable` / `meta_extraction_failed` / `sync_folder_warning` | 후처리 모드 | `err.postprocess.*` | 수동 메타 입력 |
| `run` | `completed` / `completed_with_issues` / `failed` / `aborted` / `interrupted` / `in_doubt` | 종료 상태 | `run.status.*` | — |


### 서버 응답 코드 (클라우드 서비스, PR #46 `poc/services/shared/src/errors.ts`)

응답 본문은 코드뿐이고 입력을 되풀이하지 않는다(D12 §1). 괄호 안은 HTTP 상태다. 사용자 메시지 키는 `err.<영역>.*`로 묶고, 데스크톱·폰이 코드별로 해석한다.

| 영역 | 코드(HTTP) | 뜻 | 복구 |
|---|---|---|---|
| `request` | `param_rejected`(400) / `too_large`(413) / `not_found`(404) / `method_not_allowed`(405) / `unsupported_media`(415) | 스키마 밖 필드·본문 크기·없는 경로·메서드·미디어 형식(모든 서비스 공통) | 재시도 안 함(클라이언트 버그로 기록) |
| `server` | `internal`(500) | 서버 내부 오류(본문·스택 없음) | 지수 간격 재시도 |
| `account` | `unauthorized`(401) / `scope_denied`(403) / `dpop_invalid`(401) / `cert_invalid`(401) | 세션·기기 범위 토큰 없음 / 토큰 범위 밖(폰의 `slots` 등) / DPoP 증명 오류(`SAX-dpop-v1`, D08 §2.1) / 기기 인증서 오류 | 다시 로그인·토큰 재발급 |
| `account` | `code_invalid`(400) / `code_locked`(429) / `pkce_invalid`(400) / `redirect_not_loopback`(400) / `passkey_invalid`(400) / `passkey_required`(403) | 이메일 코드 불일치 / 5회 잠금 / PKCE 검증 실패 / 루프백 아닌 주소 / 패스키 검증 실패 / 패스키 계정의 이메일 세션 기기 추가 거부(D09 §2.1·§2.2) | 코드 재요청·패스키로 로그인 |
| `account` | `slot_limit`(409) / `slot_not_found`(404) / `rebind_too_soon`(409) | 프로필 슬롯 2개 초과 / 슬롯 없음 / 사업자 HMAC 재바인딩 90일 안(B-28, D09 §2) | 안내만 |
| `account` | `device_limit`(409) / `device_churn_limit`(429) / `device_not_found`(404) / `device_suspended`(403) / `not_pending`(409) | 기기 수 상한 / 30일 교체 상한(C-32) / 기기 없음 / 긴급 정지·폐기된 기기 / 대기 상태가 아닌 기기 | 안내만. 정지 해제는 AIK 서명 계정 작업 |
| `account` | `aik_not_pinned`(409) / `aik_already_pinned`(409) / `aik_signature_invalid`(400) / `list_version_stale`(409) | AIK 미고정 / 이미 고정 / AIK 서명 오류 / 기기 목록 버전이 저장값보다 낮음(D08 §4.1) | 목록 다시 받기 |
| `account` | `billing_signature_invalid`(400) | PG 웹훅 서명 불일치(**보안 이벤트**) | 무시·기록 |
| `gateway` | `run_token_invalid`(401) / `run_budget_exceeded`(429) / `device_suspended`(403) | `runToken`(`SAX-run-token-v1`) 오류 / 실행당 예산 초과 / 정지된 기기 | 해당 호출 `unknown`, 예산 초과는 핸드오프 |
| `relay` | `mailbox_limit`(409) / `queue_full`(429) / `mailbox_not_found`(404) | 우편함 수 상한 / 큐 가득 참 / 우편함 없음 | 재페어링·나중에 재시도 |
| `push` | `token_not_found`(404) | 등록된 푸시 토큰 없음 | 폰 앱이 다시 등록 |

규칙:
- **보안 이벤트**는 다음뿐이다: `gate.token_invalid`, `gate.token_consumed`, `commit_guard.blocked_request`, `remote.replay_detected`, `vault.origin_not_allowed`, `vault.cdp_denied`, `vault.preinjected_script`, `vault.origin_left`, `vault.dbkey_requested_twice`, `step.commit_shadow`, `security.commit_payload_mismatch`, `ledger.intent_reuse`, `policy.rejected_not_conservative`, `registry.version_jump_rejected`, `registry.key_revoked`, `gateway.pii_tripwire`, `vault.crypto_rate_anomaly`, `postprocess.open_denied`, `pairing.aik_mismatch`, `registry.head_mismatch`, `policy.issued_in_future`, `registry.revoked_shrunk`, `registry.issued_in_future`, `account.billing_signature_invalid`, `egress.pii_tripwire`, `egress.image_rejected`, `egress.unminted_text`(2026-11-05 추가). 만료·거부·불일치(`step.readback_mismatch`, `step.pre_dispatch_mismatch`, `step.identity_mismatch`)는 보안 이벤트가 아니다.
- 리모트 영역 코드(`remote.*`)는 로컬 UI 전용이다. 폰↔PC 프로토콜로 오류 코드를 보내지 않으며, 실패는 무응답으로 처리한다(D08, C/X-12).
- 텔레메트리에는 코드만 보내고 메시지 키는 로컬에서 해석한다. 텔레메트리 집계 단위는 D12 §1(일 단위, 5건 버킷)이다.
