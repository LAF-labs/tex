// 계정·릴레이 서비스 목적지(데스크톱 계정 로그인·기기 토큰·페어링, 팀장 결정 2026-11-06). Egress.cloud()·openCloudSocket()이 이 표만 연다.
// HTTP origin은 앱 내장 상수 https://tax.laf-co.com 하나(계정·릴레이 HTTPS가 같은 origin, services/deploy/README.md 1절).
// WSS는 룸 호스트 하나(함수는 WSS를 못 받는다): 페어링 룸과 라이브 우편함. 메서드·경로는 정확히 일치해야 하고 쿼리·조각·인코딩은 받지 않는다.
// 개발 스택(http/ws://localhost·127.0.0.1)은 Egress 생성 때 cloudDevLocal을 켠 경우에만 연다.

export const CLOUD_ORIGIN = 'https://tax.laf-co.com';
/** 룸 호스트(QR의 릴레이 호스트, WSS 전용) */
export const CLOUD_WS_HOST = 'rooms.tax.laf-co.com';
/** 응답 상한(기기 목록·클레임·토큰은 작다) */
export const CLOUD_MAX_BYTES = 256 * 1024;
/** 요청 본문 상한(서버 기본 64KB와 같다) */
export const CLOUD_MAX_BODY = 64 * 1024;

const ID22 = '[A-Za-z0-9_-]{22}';
const ID43 = '[A-Za-z0-9_-]{43}';

export type CloudMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** HTTP 경로(서버 정본: services/account/API.md, services/relay/API.md). 이름은 감사 기록에 쓴다(경로의 ID를 남기지 않는다). */
export const CLOUD_ROUTES: ReadonlyArray<{ name: string; method: CloudMethod; path: RegExp }> = [
  { name: 'auth.code', method: 'POST', path: /^\/v1\/auth\/code$/ },
  { name: 'auth.verify', method: 'POST', path: /^\/v1\/auth\/code\/verify$/ },
  { name: 'auth.logout', method: 'POST', path: /^\/v1\/auth\/logout$/ },
  { name: 'deviceList.get', method: 'GET', path: /^\/v1\/device-list$/ },
  { name: 'deviceList.put', method: 'PUT', path: /^\/v1\/device-list$/ },
  { name: 'aik.pin', method: 'POST', path: /^\/v1\/aik$/ },
  { name: 'deviceTokens', method: 'POST', path: /^\/v1\/device-tokens$/ },
  { name: 'acctClaim', method: 'GET', path: /^\/v1\/acct-claim$/ },
  { name: 'devices.enroll', method: 'POST', path: /^\/v1\/devices\/enroll$/ },
  { name: 'rooms.create', method: 'POST', path: /^\/v1\/rooms$/ },
  { name: 'mailboxes.create', method: 'POST', path: /^\/v1\/mailboxes$/ },
  { name: 'mailboxes.delete', method: 'DELETE', path: new RegExp(`^/v1/mailboxes/${ID43}$`) },
];

/** WSS 경로: 페어링 룸 참가(인증 없음, Noise XX), 라이브 우편함(기기 토큰 + 우편함 토큰 헤더) */
export const CLOUD_WS_ROUTES: ReadonlyArray<{ name: string; path: RegExp }> = [
  { name: 'rooms.join', path: new RegExp(`^/v1/rooms/${ID22}$`) },
  { name: 'mailboxes.live', path: new RegExp(`^/v1/mailboxes/${ID43}/live$`) },
];

/** 호출자가 붙일 수 있는 헤더(소문자). 그 밖(쿠키·Host·프록시 헤더 등)은 거부한다 */
export const CLOUD_HEADERS: ReadonlySet<string> = new Set(['authorization', 'dpop', 'x-mbx-read', 'x-mbx-write']);

const DEV_HTTP = /^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/;
const DEV_WS = /^ws:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}$/;
const SAFE = /^[A-Za-z0-9:/._-]+$/;

export type CloudOriginKind = 'prod' | 'dev' | null;

function parse(url: unknown): URL | null {
  // 쿼리·조각·퍼센트 인코딩·사용자 정보·백슬래시·공백은 문자 단계에서 거부한다(허용 경로는 이 문자만 쓴다)
  if (typeof url !== 'string' || url.length > 512 || !SAFE.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  // 정규화로 바뀌는 입력(`..`, 중복 슬래시, 기본 포트 등)은 거부: 원문이 origin + 경로와 같아야 한다
  if (u.search || u.hash || u.username || u.password || u.origin + u.pathname !== url) return null;
  return u;
}

/** HTTP 요청이 허용 목록에 맞으면 {route, kind}. origin이 다르면 'origin', 경로·메서드가 다르면 'path' */
export function cloudRequestCheck(method: string, url: string): { route: string; kind: 'prod' | 'dev' } | 'origin' | 'path' {
  const u = parse(url);
  if (!u) return typeof url === 'string' && (url.startsWith(`${CLOUD_ORIGIN}/`) || /^http:\/\/(localhost|127\.0\.0\.1):[0-9]{1,5}\//.test(url)) ? 'path' : 'origin';
  const kind: CloudOriginKind = u.origin === CLOUD_ORIGIN ? 'prod' : DEV_HTTP.test(u.origin) ? 'dev' : null;
  if (!kind) return 'origin';
  const r = CLOUD_ROUTES.find((x) => x.method === method && x.path.test(u.pathname));
  return r ? { route: r.name, kind } : 'path';
}

/** WSS 주소가 허용 목록에 맞으면 {route, kind}. 그 밖은 null */
export function cloudSocketCheck(url: string): { route: string; kind: 'prod' | 'dev' } | null {
  const u = parse(url);
  if (!u) return null;
  const kind: CloudOriginKind = u.origin === `wss://${CLOUD_WS_HOST}` ? 'prod' : DEV_WS.test(u.origin) ? 'dev' : null;
  if (!kind) return null;
  const r = CLOUD_WS_ROUTES.find((x) => x.path.test(u.pathname));
  return r ? { route: r.name, kind } : null;
}

/** 호출자 헤더 검사: 허용 이름만, 값은 출력 가능한 ASCII 4096자 이하(줄바꿈 없음). 이름은 소문자로 바꿔 돌려준다 */
export function cloudHeaders(h: Record<string, string> | undefined): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h ?? {})) {
    const name = k.toLowerCase();
    if (!CLOUD_HEADERS.has(name) || Object.hasOwn(out, name) || typeof v !== 'string' || v.length > 4096 || !/^[\x20-\x7e]*$/.test(v)) return null;
    out[name] = v;
  }
  return out;
}
