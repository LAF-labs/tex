// 서비스 오류 코드(D16 형식 `<영역>.<코드>`). 응답 본문은 코드뿐이고 입력을 되풀이하지 않는다(D12 §1, gateway-request 규칙).
// D16 표에 이미 있는 코드는 그대로 쓰고, 표에 없는 코드는 PROPOSED_D16에 모아 D16 추가를 제안한다(팀장 보고).
export const ERROR_STATUS = {
  // D16 기존
  'gateway.unauthorized': 401,
  'gateway.quota_exceeded': 429,
  'gateway.digest_mismatch': 409,
  'gateway.param_rejected': 400,
  'gateway.upstream_error': 503,
  'gateway.pii_tripwire': 400,
  'account.recovery_hold': 423,
  'policy.rate_limited': 429,
  'registry.signature_insufficient': 422,
  'registry.version_jump_rejected': 422,
  'registry.key_revoked': 422,
  'registry.status_stale': 422,
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
  'account.code_locked': 429,
  'account.pkce_invalid': 400,
  'account.redirect_not_loopback': 400,
  'account.passkey_invalid': 400,
  'account.passkey_required': 403,
  'account.slot_limit': 409,
  'account.slot_not_found': 404,
  'account.rebind_too_soon': 409,
  'account.device_limit': 409,
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
  'gateway.run_token_invalid': 401,
  'gateway.run_budget_exceeded': 429,
  'gateway.device_suspended': 403,
  'registry.expired': 422,
  'registry.issued_in_future': 422,
  'registry.not_found': 404,
  'registry.revocation_stale': 422,
  'registry.not_conservative': 422,
  'registry.portal_blocked': 422,
  'registry.content_digest_mismatch': 422,
  'registry.unauthorized': 401,
  'relay.mailbox_limit': 409,
  'relay.queue_full': 429,
  'relay.mailbox_not_found': 404,
  'push.token_not_found': 404,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/** D16 표에 아직 없는 코드(추가 제안). 테스트가 ERROR_STATUS와 이 목록의 합이 D16 기존 + 제안과 같은지 본다. */
export const PROPOSED_D16: readonly ErrorCode[] = (Object.keys(ERROR_STATUS) as ErrorCode[]).filter(
  (c) => !['gateway.unauthorized', 'gateway.quota_exceeded', 'gateway.digest_mismatch', 'gateway.param_rejected', 'gateway.upstream_error', 'gateway.pii_tripwire', 'account.recovery_hold', 'policy.rate_limited', 'registry.signature_insufficient', 'registry.version_jump_rejected', 'registry.key_revoked', 'registry.status_stale', 'registry.revocation_stale'].includes(c),
);

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
