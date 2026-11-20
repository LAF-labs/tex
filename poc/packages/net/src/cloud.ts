
export const CLOUD_ORIGIN = 'https://tax.laf-co.com';
/** 룸 호스트(QR의 릴레이 호스트, WSS 전용) */
export const CLOUD_WS_HOST = 'rooms.tax.laf-co.com';
/** 응답 상한(기기 목록·클레임·토큰은 작다) */
export const CLOUD_MAX_BYTES = 256 * 1024;
/** 우편함 큐 GET 한 쪽 상한(서버는 봉투 바이트 3 MiB까지 한 쪽으로 준다, services/relay/API.md #204. JSON 겉과 여유를 더한다) */
export const CLOUD_QUEUE_PAGE_MAX_BYTES = 3 * 1024 * 1024 + 256 * 1024;
/** 계정 공유 기록 한 쪽 상한(서버는 본문 합계 1,000,000자·200줄까지 준다, services/account/API.md. JSON 겉과 여유를 더한다) */
export const CLOUD_SHARE_PAGE_MAX_BYTES = 1_000_000 + 256 * 1024;
/** 요청 본문 상한(서버 기본 64KB와 같다) */
export const CLOUD_MAX_BODY = 64 * 1024;

const ID22 = '[A-Za-z0-9_-]{22}';
const ID43 = '[A-Za-z0-9_-]{43}';
const UUID4 = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

export type CloudMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/** HTTP 경로(서버 정본: services/account/API.md, services/relay/API.md). 이름은 감사 기록에 쓴다(경로의 ID를 남기지 않는다). */
export const CLOUD_ROUTES: ReadonlyArray<{ name: string; method: CloudMethod; path: RegExp; maxBytes?: number }> = [
  { name: 'auth.code', method: 'POST', path: /^\/v1\/auth\/code$/ },
  { name: 'auth.verify', method: 'POST', path: /^\/v1\/auth\/code\/verify$/ },
  { name: 'auth.logout', method: 'POST', path: /^\/v1\/auth\/logout$/ },
  { name: 'auth.password', method: 'POST', path: /^\/v1\/auth\/password$/ },
  { name: 'auth.reset', method: 'POST', path: /^\/v1\/auth\/password\/reset$/ },
  { name: 'auth.resetVerify', method: 'POST', path: /^\/v1\/auth\/password\/reset\/verify$/ },
  { name: 'auth.refresh', method: 'POST', path: /^\/v1\/auth\/refresh$/ },
  { name: 'auth.refreshRevoke', method: 'POST', path: /^\/v1\/auth\/refresh\/revoke$/ },
  { name: 'auth.logoutAll', method: 'POST', path: /^\/v1\/auth\/logout-all$/ },
  { name: 'auth.reauth', method: 'POST', path: /^\/v1\/auth\/reauth$/ },
  { name: 'auth.reauthVerify', method: 'POST', path: /^\/v1\/auth\/reauth\/verify$/ },
  { name: 'me.get', method: 'GET', path: /^\/v1\/me$/ },
  { name: 'password.put', method: 'PUT', path: /^\/v1\/password$/ },
  { name: 'password.delete', method: 'DELETE', path: /^\/v1\/password$/ },
  { name: 'deviceList.get', method: 'GET', path: /^\/v1\/device-list$/ },
  { name: 'deviceList.put', method: 'PUT', path: /^\/v1\/device-list$/ },
  { name: 'aik.pin', method: 'POST', path: /^\/v1\/aik$/ },
  { name: 'deviceTokens', method: 'POST', path: /^\/v1\/device-tokens$/ },
  { name: 'acctClaim', method: 'GET', path: /^\/v1\/acct-claim$/ },
  { name: 'devices.enroll', method: 'POST', path: /^\/v1\/devices\/enroll$/ },
  { name: 'devices.list', method: 'GET', path: /^\/v1\/devices$/ },
  { name: 'devices.leave', method: 'POST', path: /^\/v1\/devices\/self\/leave$/ },
  { name: 'pcLinks.list', method: 'GET', path: /^\/v1\/pc-links$/ },
  { name: 'pcLinks.hello', method: 'PUT', path: new RegExp(`^/v1/pc-links/${UUID4}$`) },
  { name: 'pcLinks.answer', method: 'GET', path: new RegExp(`^/v1/pc-links/${UUID4}$`) },
  { name: 'pcLinks.delete', method: 'DELETE', path: new RegExp(`^/v1/pc-links/${UUID4}$`) },
  { name: 'pcLinks.reveal', method: 'POST', path: new RegExp(`^/v1/pc-links/${UUID4}/reveal$`) },
  { name: 'pcLinks.challenge', method: 'POST', path: new RegExp(`^/v1/pc-links/${UUID4}/challenge$`) },
  { name: 'pcLinks.grant', method: 'POST', path: new RegExp(`^/v1/pc-links/${UUID4}/grant$`) },
  { name: 'keyEscrow.get', method: 'GET', path: /^\/v1\/key-escrow$/ },
  { name: 'keyEscrow.put', method: 'PUT', path: /^\/v1\/key-escrow$/ },
  { name: 'keyEscrow.claim', method: 'POST', path: /^\/v1\/key-escrow\/claim$/ },
  { name: 'keyEscrow.pub', method: 'GET', path: /^\/v1\/key-escrow\/pub$/ },
  { name: 'keyEscrow.reset', method: 'POST', path: /^\/v1\/key-escrow\/reset$/ },
  { name: 'keyEscrow.join', method: 'POST', path: /^\/v1\/key-escrow\/join$/ },
  { name: 'issueLock.get', method: 'GET', path: /^\/v1\/issue-lock$/ },
  { name: 'issueLock.acquire', method: 'POST', path: /^\/v1\/issue-lock\/acquire$/ },
  { name: 'issueLock.renew', method: 'POST', path: /^\/v1\/issue-lock\/renew$/ },
  { name: 'issueLock.release', method: 'POST', path: /^\/v1\/issue-lock\/release$/ },
  { name: 'push.wake', method: 'POST', path: /^\/v1\/wake$/ },
  { name: 'share.put', method: 'PUT', path: new RegExp(`^/v1/share/rows/${ID22}$`) },
  { name: 'share.rows', method: 'GET', path: /^\/v1\/share\/rows$/, maxBytes: CLOUD_SHARE_PAGE_MAX_BYTES },
  { name: 'share.rowsAfter', method: 'GET', path: /^\/v1\/share\/rows\/after\/(0|[1-9][0-9]{0,15})$/, maxBytes: CLOUD_SHARE_PAGE_MAX_BYTES },
  { name: 'share.tasks', method: 'GET', path: /^\/v1\/share\/tasks$/ },
  { name: 'share.taskClaim', method: 'POST', path: new RegExp(`^/v1/share/tasks/${ID22}/claim$`) },
  { name: 'share.taskRelease', method: 'POST', path: new RegExp(`^/v1/share/tasks/${ID22}/release$`) },
  { name: 'share.taskCancel', method: 'POST', path: new RegExp(`^/v1/share/tasks/${ID22}/cancel$`) },
  { name: 'billing.subscription', method: 'GET', path: /^\/v1\/billing\/subscription$/ },
  { name: 'billing.checkout', method: 'POST', path: /^\/v1\/billing\/checkout$/ },
  { name: 'billing.cancel', method: 'POST', path: /^\/v1\/billing\/cancel$/ },
  { name: 'billing.refund', method: 'POST', path: /^\/v1\/billing\/refund$/ },
  { name: 'account.deletion', method: 'GET', path: /^\/v1\/account\/deletion$/ },
  { name: 'account.deleteRequest', method: 'POST', path: /^\/v1\/account\/delete-request$/ },
  { name: 'account.deleteCancel', method: 'POST', path: /^\/v1\/account\/delete-cancel$/ },
  { name: 'rooms.create', method: 'POST', path: /^\/v1\/rooms$/ },
  { name: 'mailboxes.create', method: 'POST', path: /^\/v1\/mailboxes$/ },
  { name: 'mailboxes.delete', method: 'DELETE', path: new RegExp(`^/v1/mailboxes/${ID43}$`) },
  { name: 'mailboxes.envelopes', method: 'GET', path: new RegExp(`^/v1/mailboxes/${ID43}/envelopes$`), maxBytes: CLOUD_QUEUE_PAGE_MAX_BYTES },
  { name: 'mailboxes.ack', method: 'POST', path: new RegExp(`^/v1/mailboxes/${ID43}/ack$`) },
  { name: 'mailboxes.bundle', method: 'PUT', path: new RegExp(`^/v1/mailboxes/${ID43}/bundle$`) },
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
  if (typeof url !== 'string' || url.length > 512 || !SAFE.test(url)) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
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

/** 경로 이름별 응답 상한(기본 CLOUD_MAX_BYTES, 큐 쪽 읽기만 크다) */
export function cloudMaxBytes(route: string): number {
  return CLOUD_ROUTES.find((x) => x.name === route)?.maxBytes ?? CLOUD_MAX_BYTES;
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
