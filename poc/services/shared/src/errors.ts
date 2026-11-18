// 서비스 오류 코드(D16 형식 `<영역>.<코드>`). 응답 본문은 코드뿐이고 입력을 되풀이하지 않는다(D12 §1, gateway-request 규칙).
// D16 표에 이미 있는 코드는 그대로 쓰고, 표에 없는 코드는 PROPOSED_D16에 모아 D16 추가를 제안한다(팀장 보고).
export const ERROR_STATUS = {
  // D16 기존
  'gateway.unauthorized': 401,
  'gateway.quota_exceeded': 429,
  /** 오늘(한국 시간 새벽 4시 기준) 쓸 수 있는 AI 사용 금액을 다 썼다. retry-after = 다음 새벽 4시까지 */
  'gateway.daily_limit': 429,
  'gateway.digest_mismatch': 409,
  'gateway.param_rejected': 400,
  'gateway.upstream_error': 503,
  'gateway.pii_tripwire': 400,
  'account.recovery_hold': 423,
  'policy.rate_limited': 429,
  'registry.signature_insufficient': 422,
  'registry.version_jump_rejected': 422,
  'registry.key_revoked': 422,
  // D16 추가 제안(PROPOSED_D16)
  'request.param_rejected': 400,
  'request.too_large': 413,
  'request.not_found': 404,
  'request.method_not_allowed': 405,
  'request.unsupported_media': 415,
  'server.internal': 500,
  'account.unauthorized': 401,
  'account.scope_denied': 403,
  'account.dpop_invalid': 401,
  'account.code_invalid': 400,
  /** 비밀번호 로그인 실패. 이메일 없음·비밀번호 없음·틀림·잠금 모두 같은 코드·같은 시각(ADR-038 (d)) */
  'account.credentials_invalid': 401,
  'account.password_too_short': 400,
  'account.password_too_long': 400,
  /** 유출·흔한 비밀번호 목록(로컬 상위 목록) */
  'account.password_breached': 400,
  /** 이메일(전체·로컬 부분)이나 서비스명을 포함 */
  'account.password_contains_identity': 400,
  /** 비밀번호 설정·삭제는 최근(10분) 코드·패스키·비밀번호 로그인 세션만 */
  'account.reauth_required': 403,
  /** 비밀번호 바꾸기에 현재 비밀번호가 없다(사용자 확정 2026-11-09) */
  'account.current_password_required': 400,
  /** 비밀번호 바꾸기의 현재 비밀번호 틀림·잠금. 로그인과 같은 5회 잠금·응답 하한(사용자 확정 2026-11-09) */
  'account.current_password_invalid': 403,
  'account.code_locked': 429,
  'account.pkce_invalid': 400,
  'account.redirect_not_loopback': 400,
  'account.passkey_invalid': 400,
  'account.passkey_required': 403,
  'account.slot_limit': 409,
  'account.slot_not_found': 404,
  'account.rebind_too_soon': 409,
  'account.device_limit': 409,
  /** 계정에 남은 마지막 활성 데스크톱은 스스로 나가거나 폰이 정지할 수 없다(ADR-048 결정 6) */
  'account.last_desktop': 409,
  /** 발급 잠금(ADR-048 결정 7): 다른 PC가 잡고 있다 / 내 잠금이 만료됐거나 다른 PC로 넘어갔다 */
  'account.issue_locked': 409,
  'account.issue_lock_lost': 409,
  /** 새 PC 연결 우편함(ADR-048 결정 3): 신청이 없다 / 지금 단계에서 받을 수 없는 메시지다(이미 다른 PC가 답했다 등) */
  'account.link_not_found': 404,
  'account.link_state': 409,
  /** 계정 열쇠 보관(ADR-050): 이 계정이 맡긴 열쇠가 없다(쓰던 PC가 아직 맡기지 않았거나 보관 키가 바뀌었다). 새 PC는 쓰던 PC의 승인으로 넘어간다 */
  'account.escrow_missing': 409,
  /** 계정 공유 기록(ADR-048 결정 5): 같은 줄 id에 다른 내용 / 옛 세대 키로 쓴 줄 / 기기가 하나뿐인 계정(올릴 이유가 없다) / 줄 수 상한 */
  'account.share_row_conflict': 409,
  'account.share_epoch_stale': 409,
  'account.share_single_device': 409,
  'account.share_full': 409,
  /** 맡긴 일: 없음 / 다른 PC가 맡고 있음 / 끝났거나 취소됐거나 유효 시간이 지남 / 내가 맡은 일이 아님 */
  'account.task_not_found': 404,
  'account.task_claimed': 409,
  'account.task_closed': 409,
  'account.task_not_claimed': 409,
  'account.device_churn_limit': 429,
  'account.device_not_found': 404,
  'account.device_suspended': 403,
  'account.aik_not_pinned': 409,
  'account.aik_already_pinned': 409,
  'account.aik_signature_invalid': 400,
  'account.list_version_stale': 409,
  'account.cert_invalid': 401,
  'account.not_pending': 409,
  'account.device_hold': 423,
  'account.billing_signature_invalid': 400,
  /** 체험이 끝났고 구독이 없다(유료 기능: 게이트웨이 범위 토큰). 앱은 구독 화면을 연다 */
  'account.subscription_required': 402,
  /** 청약철회 기간(결제 후 7일)이 지났거나 환불할 결제가 없다 */
  'account.refund_unavailable': 409,
  /** PG가 환불을 거절했거나 결과를 모른다(같은 요청을 다시 해도 두 번 환불되지 않는다) */
  'account.refund_failed': 502,
  'gateway.run_token_invalid': 401,
  'gateway.run_budget_exceeded': 429,
  'gateway.device_suspended': 403,
  /** CODEF 연동이 이 서버에 설정되지 않았다(CODEF_ENV 없음, 계좌 자동조회 꺼짐) */
  'gateway.codef_off': 503,
  // 레지스트리 게시 관문: 엔진 로더(#52)·SIGNING.md와 같은 코드(받지 않을 문서를 올리지 않는다)
  'registry.issued_in_future': 422,
  'registry.not_found': 404,
  'registry.schema_invalid': 422,
  'registry.key_epoch_mismatch': 422,
  'registry.key_epoch_rollback': 422,
  'registry.version_rollback': 422,
  'registry.timestamp_invalid': 422,
  'registry.expired_on_arrival': 422,
  'registry.status_validity_too_long': 422,
  'registry.revoked_validity_too_long': 422,
  'registry.index_validity_too_long': 422,
  'registry.release_validity_too_long': 422,
  'registry.revoked_shrunk': 422,
  'policy.rejected_not_conservative': 422,
  'policy.validity_too_long': 422,
  'policy.issued_in_future': 422,
  'policy.expired_on_arrival': 422,
  'hotfix.validity_too_long': 422,
  'hotfix.expired': 422,
  'sxp.too_large': 422,
  'sxp.malformed': 422,
  'sxp.not_canonical': 422,
  'sxp.unknown_format': 422,
  'registry.portal_blocked': 422,
  'registry.content_digest_mismatch': 422,
  'registry.unauthorized': 401,
  /** 레지스트리 함수가 구성 전(서명 의식 전 TRUST_ROOT_JSON 없음)이거나 구성 오류로 기동하지 않았다(팀장 결정 2026-11-06) */
  'registry.unavailable': 503,
  'relay.mailbox_limit': 409,
  'relay.queue_full': 429,
  'relay.mailbox_not_found': 404,
  'relay.unauthorized': 401,
  'relay.device_suspended': 403,
  'relay.room_unavailable': 404,
  /** 그 PC의 페어링 룸이 이미 폰 등록 한 번에 쓰였다(룸 하나에 enroll 성공 한 번, 팀장 결정 2026-11-06) */
  'relay.room_used': 409,
  'push.unauthorized': 401,
  'push.device_suspended': 403,
  'push.target_not_found': 404,
  'push.token_not_found': 404,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * D16 표에 아직 없는 코드(추가 제안, 팀장 보고). D16 v1.3 + 2026-11-05 반영분에 있는 코드는 빠진다.
 * 레지스트리 게시 관문 코드는 엔진 로더(#52)가 쓰는 이름과 같다.
 */
export const PROPOSED_D16: readonly ErrorCode[] = [
  'registry.schema_invalid',
  'registry.key_epoch_mismatch',
  'registry.key_epoch_rollback',
  'registry.version_rollback',
  'registry.timestamp_invalid',
  'registry.expired_on_arrival',
  'registry.status_validity_too_long',
  'registry.revoked_validity_too_long',
  'registry.index_validity_too_long',
  'registry.release_validity_too_long',
  'policy.validity_too_long',
  'policy.expired_on_arrival',
  'hotfix.validity_too_long',
  'hotfix.expired',
  'sxp.too_large',
  'sxp.malformed',
  'sxp.not_canonical',
  'sxp.unknown_format',
  'registry.portal_blocked',
  'registry.content_digest_mismatch',
  'registry.unauthorized',
  'registry.unavailable',
  'account.credentials_invalid',
  'account.password_too_short',
  'account.password_too_long',
  'account.password_breached',
  'account.password_contains_identity',
  'account.reauth_required',
  'account.current_password_required',
  'account.current_password_invalid',
  'account.last_desktop',
  'account.issue_locked',
  'account.issue_lock_lost',
  'account.link_not_found',
  'account.link_state',
  'account.escrow_missing',
  'account.share_row_conflict',
  'account.share_epoch_stale',
  'account.share_single_device',
  'account.share_full',
  'account.task_not_found',
  'account.task_claimed',
  'account.task_closed',
  'account.task_not_claimed',
  'relay.unauthorized',
  'relay.device_suspended',
  'push.unauthorized',
  'push.device_suspended',
  'push.target_not_found',
];

export class ServiceError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  /** 429·423일 때 Retry-After(초). 값만, 사유 문장은 넣지 않는다. */
  readonly retryAfterSec?: number;
  constructor(code: ErrorCode, opts: { retryAfterSec?: number } = {}) {
    super(code);
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.retryAfterSec = opts.retryAfterSec;
  }
}

export const fail = (code: ErrorCode, opts?: { retryAfterSec?: number }): never => {
  throw new ServiceError(code, opts);
};
