/** 은행 기관 코드(organization). 화면은 이름만 보인다. 우리은행이 대표 계좌(첫 지원) */
export const CODEF_BANKS = {
  '0020': '우리은행',
  '0004': '국민은행',
  '0088': '신한은행',
  '0081': '하나은행',
  '0003': '기업은행',
  '0011': '농협은행',
  '0002': '산업은행',
  '0007': '수협은행',
  '0023': 'SC제일은행',
  '0027': '씨티은행',
  '0031': '대구은행',
  '0032': '부산은행',
  '0034': '광주은행',
  '0035': '제주은행',
  '0037': '전북은행',
  '0039': '경남은행',
  '0045': '새마을금고',
  '0048': '신협',
  '0071': '우체국',
  '0089': '케이뱅크',
} as const;
export type CodefBankCode = keyof typeof CODEF_BANKS;
export const isCodefBank = (v: unknown): v is CodefBankCode => typeof v === 'string' && Object.hasOwn(CODEF_BANKS, v);

/** 은행 업무 구분: B 기업(개인사업자·법인, 인증서 로그인만), P 개인 */
export type CodefClientType = 'B' | 'P';

/**
 * 사람 말로 접는 실패 갈래. 화면 문구는 desktop이 이 코드로 고른다(값·원문 없음).
 * - password_wrong·password_locked: 인증서 비밀번호
 * - cert_not_registered: 이 인증서가 그 은행에 등록되지 않음(타기관 인증서 등록 안내)
 * - cert_expired: 만료·폐기, cert_kind: 개인/기업 용도가 맞지 않음
 * - identity_required: 은행이 본인인증을 먼저 요구(CF-12831 "본인인증 후 서비스 이용이 가능합니다"). 사람이 그 은행 인터넷뱅킹에서 본인인증을 한 번 마치면 된다
 * - two_way_required: 추가 인증 필요(인증서 로그인에서는 드묾 — 지금은 지원하지 않고 파일 올리기 안내)
 * - bank_error: 은행이 거절(원문은 보이지 않는다), bank_busy: 일시 오류·시간 초과
 * - session_lost: connectedId가 CODEF에 없다(다시 연결), codef_off: 서버에 CODEF 설정 없음, unavailable: 네트워크·CODEF 장애
 */
export type CodefFailure =
  | 'password_wrong'
  | 'password_locked'
  | 'cert_not_registered'
  | 'cert_expired'
  | 'cert_kind'
  | 'two_way_required'
  | 'identity_required'
  | 'withdraw_account_required'
  | 'banking_kind'
  | 'not_enrolled'
  | 'bank_error'
  | 'bank_busy'
  | 'session_lost'
  | 'no_account'
  | 'codef_off'
  | 'signed_out'
  | 'unavailable'
  | 'bad_response'
  | 'rejected'
  | 'cancelled'
  | 'cert_missing'
  | 'bank_not_ready'
  | 'bank_consent_required'
  | 'account_password_required'
  | 'daily_limit'
  | 'too_soon'
  | 'password_retry_limit'
  | 'sms_wrong'
  | 'busy';

const MAP: Record<string, CodefFailure> = {
  'CF-12801': 'password_wrong',
  'CF-12803': 'password_wrong',
  'CF-12302': 'password_wrong',
  'CF-12828': 'password_wrong',
  'CF-12802': 'password_locked',
  'CF-12856': 'password_locked',
  'CF-12805': 'cert_not_registered',
  'CF-12813': 'cert_not_registered',
  'CF-12806': 'cert_expired',
  'CF-12807': 'cert_expired',
  'CF-12808': 'cert_expired',
  'CF-12810': 'cert_kind',
  'CF-03002': 'two_way_required',
  'CF-12831': 'identity_required',
  'CF-12811': 'banking_kind',
  'CF-12812': 'not_enrolled',
  'CF-04008': 'session_lost',
  'CF-04019': 'session_lost',
  'CF-04014': 'session_lost',
  'CF-04038': 'session_lost',
  'CF-12100': 'bank_error',
  'CF-13031': 'account_password_required',
  'CF-13032': 'account_password_required',
  'CF-01004': 'bank_busy',
  'CF-01006': 'bank_busy',
  'CF-01007': 'bank_busy',
  'CF-09999': 'bank_busy',
};

/** 토큰을 버리고 한 번 다시 받을 코드(만료·무효) */
export const CODEF_TOKEN_CODES: ReadonlySet<string> = new Set(['CF-09990', 'CF-09991', 'CF-09992', 'CF-09993', 'CF-09994', 'CF-00026', 'CF-00401']);

export const CODEF_OK = 'CF-00000';

export function failureOf(code: string): CodefFailure {
  return MAP[code] ?? 'rejected';
}

export class CodefError extends Error {
  readonly code: CodefFailure;
  readonly cf: string | null;
  readonly retryAt: string | null;
  readonly param: string | null;
  hint: string | null = null;
  clientType: CodefClientType | null = null;
  also: { clientType: CodefClientType; code: CodefFailure } | null = null;
  withClientType(t: CodefClientType): this {
    this.clientType = t;
    return this;
  }
  constructor(code: CodefFailure, cf: string | null = null, retryAt: string | null = null, param: string | null = null) {
    super(`codef.${code}`);
    this.code = code;
    this.cf = cf && /^CF-\d{5}$/.test(cf) ? cf : null;
    this.retryAt = retryAt;
    this.param = param && /^[A-Za-z_]{1,120}$/.test(param) ? param : null;
  }
}

/** 엔진 RPC 실패 결과({ok:false}). 화면이 사람 말을 고를 코드만 담는다(값·원문 메시지·빠진 키·단서는 로그 전용) */
export function codefFailResult(e: CodefError): Record<string, unknown> {
  return {
    ok: false,
    code: e.code,
    ...(e.cf ? { cf: e.cf } : {}),
    ...(e.retryAt ? { retryAt: e.retryAt } : {}),
    ...(e.clientType ? { clientType: e.clientType } : {}),
    ...(e.also ? { also: { clientType: e.also.clientType, code: e.also.code } } : {}),
  };
}
