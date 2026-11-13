// CODEF 목적지(계좌 자동조회, 대표 결정 2026-11-12 "CODEF 공동인증서 방식"). 송신은 Egress.toCodef()만 한다.
// - origin은 환경(게이트웨이가 토큰과 함께 알려 준 env)마다 하나로 고정, 경로는 아래 목록만. 리디렉션은 따르지 않는다.
// - CODEF 와이어 규칙(공식 라이브러리 easycodef와 같다): 요청 본문은 JSON을 URL 인코딩한 문자열, 응답 본문도 URL 인코딩된 JSON이다.
// - 본문(인증서 파일·감싼 비밀번호·계좌·거래내역)과 토큰은 감사 기록·로그에 남기지 않는다(목적지·경로 이름·상태만).

export const CODEF_ORIGINS = {
  sandbox: 'https://sandbox.codef.io',
  demo: 'https://development.codef.io',
  prod: 'https://api.codef.io',
} as const;
export type CodefEnv = keyof typeof CODEF_ORIGINS;
export const isCodefEnv = (v: unknown): v is CodefEnv => typeof v === 'string' && Object.hasOwn(CODEF_ORIGINS, v);

/** 쓰는 CODEF 경로(이 밖은 보내지 않는다). 계정(connectedId) 만들기·추가·삭제·목록, 은행 보유계좌·수시입출 거래내역(개인 p·기업 b) */
export const CODEF_PATHS = [
  '/v1/account/create',
  '/v1/account/add',
  '/v1/account/delete',
  '/v1/account/list',
  '/v1/kr/bank/p/account/account-list',
  '/v1/kr/bank/b/account/account-list',
  '/v1/kr/bank/p/account/transaction-list',
  '/v1/kr/bank/b/account/transaction-list',
] as const;
export type CodefPath = (typeof CODEF_PATHS)[number];
export const isCodefPath = (p: unknown): p is CodefPath => typeof p === 'string' && (CODEF_PATHS as readonly string[]).includes(p);

/** 요청 본문 상한(인증서 der·key base64 몇 KB + 감싼 비밀번호). 넘으면 보내지 않는다 */
export const CODEF_MAX_BODY = 64 * 1024;
/** 응답 상한(거래내역이 길 수 있다) */
export const CODEF_MAX_BYTES = 8 * 1024 * 1024;
/** 은행 조회는 CODEF가 은행에 붙어 긁어 오므로 느리다(수십 초) */
export const CODEF_TIMEOUT_MS = 120_000;

/** 접근 토큰 모양(보이는 ASCII, 헤더 주입 없음) */
export const CODEF_TOKEN_RE = /^[\x21-\x7e]{16,4096}$/;

/** CODEF 요청 본문: JSON → URL 인코딩 */
export function encodeCodefBody(body: object): string {
  return encodeURIComponent(JSON.stringify(body));
}

/** CODEF 응답 본문: URL 인코딩된 JSON(공백은 + 로 올 수 있다). 인코딩 안 된 JSON도 받는다. 못 읽으면 null */
export function decodeCodefBody(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t.startsWith('{') || t.startsWith('[') ? t : decodeURIComponent(t.replace(/\+/g, ' ')));
  } catch {
    return null;
  }
}
