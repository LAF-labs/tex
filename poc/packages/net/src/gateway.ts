// 모델 게이트웨이 클라이언트 계약(D04 §7, D09 §3, gateway-request.schema.json). 송신 자체는 Egress.toGateway()만 한다.
// 와이어 정본은 services/gateway/API.md(M4-6). 인증: 기기 범위 토큰 + DPoP 증명(SAX-dpop-v1, ADR-029). 서명은 금고(crypto.signVd)가 하므로 이 모듈은 헤더를 만드는 콜백만 받는다.
// 응답은 비신뢰 입력이다(C-24): 이 모듈은 JSON 모양만 확인하고, 질문 해시 대조·매핑은 model 계층이 로컬 번들로 한다.

/** 게이트웨이 경로(services/gateway/API.md, D04 §7). 이 밖의 경로는 보내지 않는다. 사용량 조회는 계정 서비스 몫이다. */
export const GATEWAY_PATHS = { decide: '/v1/decide', respond: '/v1/respond', runTokens: '/v1/run-tokens', codefToken: '/v1/codef/token' } as const;
export type GatewaySurface = keyof typeof GATEWAY_PATHS;

/**
 * 게이트웨이 origin(= DPoP htu의 origin, GATEWAY_PUBLIC_ORIGIN). 2026-11-05 팀장 결정. 앱 내장 상수라 설정·환경 변수로
 * 바꿀 수 없다(D01 §3 내장 허용 목록). 시험은 EgressOptions.testOrigins.gateway로 접속 대상만 바꾸고 htu는 이 값 그대로다.
 */
export const GATEWAY_ORIGIN = 'https://tax.laf-co.com';

/** DPoP 헤더 생성기(금고 crypto.signVd purpose SAX-dpop-v1). htm·htu·본문 해시를 받아 Authorization·DPoP 헤더를 돌려준다. 토큰·증명은 기록하지 않는다. */
export interface GatewayAuth {
  headers(req: { method: 'POST'; url: string; bodySha256: string }): Promise<Record<string, string>>;
  /**
   * 게이트웨이가 401(gateway.unauthorized)을 줬다. 캐시한 기기 토큰을 버리게 한다(ADR-040 결정 3·5).
   * 있으면 Egress.toGateway가 이것을 부른 뒤 한 번만 다시 보낸다. 없으면 다시 보내지 않는다(같은 토큰이라 소용없다).
   */
  invalidate?(): void;
}

/**
 * 게이트웨이 오류 코드. 게이트웨이 본문 `{"error": code}`의 코드를 그대로 쓰고(services/gateway/API.md),
 * 다른 계열(account.scope_denied·policy.rate_limited·request.too_large)은 gateway.* 이름으로 접는다. 끝 셋은 전송 계층.
 */
export type GatewayErrorCode =
  | 'gateway.unauthorized'
  | 'gateway.scope_denied'
  | 'gateway.device_suspended'
  | 'gateway.param_rejected'
  | 'gateway.too_large'
  | 'gateway.pii_tripwire'
  | 'gateway.digest_mismatch'
  | 'gateway.run_token_invalid'
  | 'gateway.run_budget_exceeded'
  | 'gateway.quota_exceeded'
  | 'gateway.rate_limited'
  | 'gateway.upstream_error'
  | 'gateway.codef_off'
  | 'gateway.unavailable'
  | 'gateway.timeout'
  | 'gateway.bad_response';

export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly status?: number;
  constructor(code: GatewayErrorCode, status?: number) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const BODY_CODES: Record<string, GatewayErrorCode> = {
  'gateway.unauthorized': 'gateway.unauthorized',
  'account.scope_denied': 'gateway.scope_denied',
  'gateway.device_suspended': 'gateway.device_suspended',
  'gateway.param_rejected': 'gateway.param_rejected',
  'request.too_large': 'gateway.too_large',
  'gateway.pii_tripwire': 'gateway.pii_tripwire',
  'gateway.digest_mismatch': 'gateway.digest_mismatch',
  'gateway.run_token_invalid': 'gateway.run_token_invalid',
  'gateway.run_budget_exceeded': 'gateway.run_budget_exceeded',
  'gateway.quota_exceeded': 'gateway.quota_exceeded',
  'policy.rate_limited': 'gateway.rate_limited',
  'gateway.upstream_error': 'gateway.upstream_error',
  'gateway.codef_off': 'gateway.codef_off',
};

/** 상태코드·본문 error → 오류 코드. 본문 코드는 알려진 값만 믿고, 모르면 상태코드로 접는다. */
export function gatewayErrorOf(status: number, body: unknown): GatewayError {
  const code = (body as { error?: unknown } | null)?.error;
  if (typeof code === 'string' && Object.hasOwn(BODY_CODES, code)) return new GatewayError(BODY_CODES[code]!, status);
  if (status === 409) return new GatewayError('gateway.digest_mismatch', status);
  if (status === 401) return new GatewayError('gateway.unauthorized', status);
  if (status === 403) return new GatewayError('gateway.scope_denied', status);
  if (status === 413) return new GatewayError('gateway.too_large', status);
  if (status === 429) return new GatewayError('gateway.rate_limited', status);
  if (status >= 400 && status < 500) return new GatewayError('gateway.param_rejected', status);
  return new GatewayError(status === 503 ? 'gateway.upstream_error' : 'gateway.unavailable', status);
}

/** /v1/decide 응답(비신뢰): 공급사 answers[] 그대로 + usage(cached_tokens 없음) + questionsDigest. */
export interface GatewayDecideResponse {
  model: string;
  answers: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  questionsDigest: string;
}

/** /v1/respond 응답(비신뢰): 출력 항목마다 게이트웨이 태그(runToken에 묶인 HMAC) + toolsetDigest. */
export interface GatewayRespondResponse {
  model?: string;
  status: string;
  output: Array<{ item: Record<string, unknown>; tag: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
  toolsetDigest: string;
}

/** /v1/run-tokens 응답. runToken은 `sxr1.<claims>.<서명>`이고 클라이언트는 열어 보지 않는다(서버가 검증). */
export interface GatewayRunTokenResponse {
  runToken: string;
  expiresAt?: string | number;
  budget?: { l1?: number; l2?: number };
}

const HEX64 = /^[0-9a-f]{64}$/;

export function isDecideResponse(v: unknown): v is GatewayDecideResponse {
  const o = v as GatewayDecideResponse | null;
  return !!o && typeof o === 'object' && typeof o.model === 'string' && typeof o.questionsDigest === 'string' && HEX64.test(o.questionsDigest);
}

export function isRespondResponse(v: unknown): v is GatewayRespondResponse {
  const o = v as GatewayRespondResponse | null;
  return (
    !!o &&
    typeof o === 'object' &&
    typeof o.status === 'string' &&
    typeof o.toolsetDigest === 'string' &&
    HEX64.test(o.toolsetDigest) &&
    Array.isArray(o.output) &&
    o.output.every((x) => !!x && typeof x === 'object' && !!x.item && typeof x.item === 'object' && typeof x.tag === 'string')
  );
}

export function isRunTokenResponse(v: unknown): v is GatewayRunTokenResponse {
  const o = v as GatewayRunTokenResponse | null;
  return !!o && typeof o === 'object' && typeof o.runToken === 'string' && o.runToken.length >= 16 && o.runToken.length <= 512;
}

/** 보안 이벤트(본문·식별자 없음, 코드·표면만). D06 §4 egress 트립와이어. */
export interface EgressSecurityEvent {
  code: 'egress.pii_tripwire' | 'egress.image_rejected' | 'egress.unminted_text';
  surface: 'decide' | 'respond';
  path: 'byok' | 'gateway';
}
