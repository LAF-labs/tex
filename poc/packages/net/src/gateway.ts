// 모델 게이트웨이 클라이언트 계약(D04 §7, D09 §3, gateway-request.schema.json). 송신 자체는 Egress.toGateway()만 한다.
// 인증: 기기 범위 토큰 + DPoP 증명(SAX-dpop-v1, ADR-029). 서명은 금고(crypto.signVd)가 하므로 이 모듈은 헤더를 만드는 콜백만 받는다.
// 응답은 비신뢰 입력이다(C-24): 이 모듈은 JSON 모양만 확인하고, 질문 해시 대조·매핑은 model 계층이 로컬 번들로 한다.

/** 게이트웨이 경로(D04 §7 표). 이 밖의 경로는 보내지 않는다. */
export const GATEWAY_PATHS = { decide: '/v1/decide', respond: '/v1/respond', runTokens: '/v1/run-tokens', usage: '/v1/usage/me' } as const;
export type GatewaySurface = keyof typeof GATEWAY_PATHS;

/**
 * 게이트웨이 origin. 클라우드 트랙이 호스트를 정하기 전까지 `.invalid`(RFC 2606, 해석 불가)로 둔다 — 실수로도 나가지 않는다.
 * 앱 내장 상수라 설정·환경 변수로 바꿀 수 없다(D01 §3 내장 허용 목록). 시험은 EgressOptions.testOrigins.gateway로만 바꾼다.
 */
export const GATEWAY_ORIGIN = 'https://gateway.sax.invalid';

/** DPoP 헤더 생성기(금고 연결). htm·htu·본문 해시를 받아 Authorization·DPoP 헤더를 돌려준다. 토큰·증명은 기록하지 않는다. */
export interface GatewayAuth {
  headers(req: { method: 'GET' | 'POST'; url: string; bodySha256: string | null }): Promise<Record<string, string>>;
}

/** 게이트웨이 오류 코드(D16 `gateway` 계열 + 전송 계층). 응답 본문은 코드만 싣는다(입력 반향 없음, gateway-request 설명). */
export type GatewayErrorCode =
  | 'gateway.pii_tripwire'
  | 'gateway.digest_mismatch'
  | 'gateway.param_rejected'
  | 'gateway.image_rejected'
  | 'gateway.budget_exceeded'
  | 'gateway.rate_limited'
  | 'gateway.quota'
  | 'gateway.auth'
  | 'gateway.device_suspended'
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

const KNOWN_CODES = new Set<string>(['gateway.pii_tripwire', 'gateway.digest_mismatch', 'gateway.param_rejected', 'gateway.image_rejected', 'gateway.budget_exceeded', 'gateway.rate_limited', 'gateway.quota', 'gateway.auth', 'gateway.device_suspended']);

/** 상태코드·본문 code → 오류 코드. 본문 code는 알려진 값만 믿는다. */
export function gatewayErrorOf(status: number, body: unknown): GatewayError {
  const code = (body as { code?: unknown } | null)?.code;
  if (typeof code === 'string' && KNOWN_CODES.has(code)) return new GatewayError(code as GatewayErrorCode, status);
  if (status === 409) return new GatewayError('gateway.digest_mismatch', status);
  if (status === 401 || status === 403) return new GatewayError('gateway.auth', status);
  if (status === 429) return new GatewayError('gateway.rate_limited', status);
  if (status >= 400 && status < 500) return new GatewayError('gateway.param_rejected', status);
  return new GatewayError('gateway.unavailable', status);
}

/** /v1/decide 응답(비신뢰): Decisions 응답 + usage(cached_tokens 없음) + questionsDigest(D04 §7). */
export interface GatewayDecideResponse {
  model: string;
  answers: unknown;
  usage?: { input_tokens?: number; output_tokens?: number };
  questionsDigest: string;
}

/** /v1/respond 응답(비신뢰): Responses 응답 + output[i]의 게이트웨이 태그 tags[i](D04 §7). */
export interface GatewayRespondResponse {
  status?: string;
  output?: Array<Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number };
  tags: string[];
}

export function isDecideResponse(v: unknown): v is GatewayDecideResponse {
  const o = v as GatewayDecideResponse | null;
  return !!o && typeof o === 'object' && typeof o.model === 'string' && typeof o.questionsDigest === 'string' && /^[0-9a-f]{64}$/.test(o.questionsDigest);
}

export function isRespondResponse(v: unknown): v is GatewayRespondResponse {
  const o = v as GatewayRespondResponse | null;
  return !!o && typeof o === 'object' && Array.isArray(o.tags) && o.tags.every((t) => typeof t === 'string') && (o.output === undefined || (Array.isArray(o.output) && o.output.length === o.tags.length));
}

/** 보안 이벤트(본문·식별자 없음, 코드·표면만). D06 §4 egress 트립와이어. */
export interface EgressSecurityEvent {
  code: 'egress.pii_tripwire' | 'egress.image_rejected' | 'egress.unminted_text';
  surface: 'decide' | 'respond';
  path: 'byok' | 'gateway';
}
