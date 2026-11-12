// CODEF 토큰 발급(계좌 자동조회, 대표 결정 2026-11-12 "CODEF 공동인증서 방식"). 게이트웨이는 연동 비밀키로 짧은 접근 토큰만 만들어
// 기기 인증된 PC에 건넨다. 인증서·비밀번호·계좌·거래내역은 PC → CODEF로 바로 가고 이 서버를 지나지 않는다(10-issuance-popbill-fallback §6.2와 같은 원칙).
// - 클라이언트 ID·시크릿은 서버 환경 변수(CODEF_CLIENT_ID·CODEF_CLIENT_SECRET)만. PC·로그·DB·응답에 가지 않는다.
// - 토큰은 만료 전까지 메모리에 둔다(인스턴스마다, 동시 요청은 한 번만 받는다). 토큰 값은 로그·이벤트에 남기지 않는다.
// - 공개키(CODEF_PUBLIC_KEY)는 비밀이 아니다. PC가 인증서 비밀번호를 RSA로 감쌀 때 쓰도록 토큰과 함께 돌려준다.
// 주소 근거: CODEF 공식 라이브러리 easycodef(github.com/codef-io)의 상수와 developer.codef.io 가이드(PR 본문에 출처).

export const CODEF_ENVS = ['sandbox', 'demo', 'prod'] as const;
export type CodefEnv = (typeof CODEF_ENVS)[number];

/** 토큰 발급 주소(세 환경 공통). OAuth 2.0 client credentials, Basic 인증 */
export const CODEF_OAUTH_URL = 'https://oauth.codef.io/oauth/token';

/** 토큰이 이만큼 남으면 새로 받는다(서버 캐시). PC는 받은 만료 시각 기준으로 스스로 다시 묻는다. */
export const CODEF_TOKEN_REFRESH_MARGIN_MS = 60 * 60_000;
/** 응답의 expires_in이 없거나 이상하면 보수적으로 이만큼만 쓴다 */
const FALLBACK_TTL_MS = 60 * 60_000;
/** CODEF 문서상 수명은 7일. 그보다 긴 값은 믿지 않는다 */
const MAX_TTL_MS = 7 * 24 * 60 * 60_000;

export interface CodefToken {
  accessToken: string;
  /** 만료 시각(ms, 서버 시계) */
  expiresAt: number;
}

export interface CodefTokenSource {
  readonly env: CodefEnv;
  /** PC가 비밀번호를 감쌀 공개키(base64 DER SPKI, CODEF 홈페이지 키 관리에 보이는 값) */
  readonly publicKey: string;
  token(): Promise<CodefToken>;
}

export class CodefUnavailable extends Error {}

const TOKEN_RE = /^[\x21-\x7e]{16,4096}$/;

/** CODEF OAuth. 받은 토큰은 만료 1시간 전까지 다시 쓴다. */
export class CodefOAuth implements CodefTokenSource {
  readonly env: CodefEnv;
  readonly publicKey: string;
  private readonly o: { clientId: string; clientSecret: string; fetchFn: typeof fetch; timeoutMs: number; now: () => number; url: string };
  private cached: CodefToken | null = null;
  private inflight: Promise<CodefToken> | null = null;

  constructor(o: { env: CodefEnv; clientId: string; clientSecret: string; publicKey: string; fetchFn?: typeof fetch; timeoutMs?: number; now?: () => number; url?: string }) {
    this.env = o.env;
    this.publicKey = o.publicKey;
    this.o = { clientId: o.clientId, clientSecret: o.clientSecret, fetchFn: o.fetchFn ?? fetch, timeoutMs: o.timeoutMs ?? 10_000, now: o.now ?? Date.now, url: o.url ?? CODEF_OAUTH_URL };
  }

  token(): Promise<CodefToken> {
    const c = this.cached;
    if (c && c.expiresAt - this.o.now() > CODEF_TOKEN_REFRESH_MARGIN_MS) return Promise.resolve(c);
    this.inflight ??= this.fetchToken().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async fetchToken(): Promise<CodefToken> {
    const basic = Buffer.from(`${this.o.clientId}:${this.o.clientSecret}`).toString('base64');
    let res: Response;
    try {
      res = await this.o.fetchFn(this.o.url, {
        method: 'POST',
        headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: 'grant_type=client_credentials&scope=read',
        redirect: 'error',
        signal: AbortSignal.timeout(this.o.timeoutMs),
      });
    } catch {
      throw new CodefUnavailable();
    }
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => undefined);
      throw new CodefUnavailable();
    }
    const d = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
    const at = d?.access_token;
    if (typeof at !== 'string' || !TOKEN_RE.test(at)) throw new CodefUnavailable();
    const sec = typeof d?.expires_in === 'number' ? d.expires_in : Number(d?.expires_in);
    const ttl = Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, MAX_TTL_MS) : FALLBACK_TTL_MS;
    this.cached = { accessToken: at, expiresAt: this.o.now() + ttl };
    return this.cached;
  }
}

/** 모의 원천(시험·개발 스택): 고정 모양의 가짜 토큰. 받은 횟수만 센다. */
export class MockCodefTokenSource implements CodefTokenSource {
  readonly env: CodefEnv = 'sandbox';
  readonly publicKey: string;
  calls = 0;
  constructor(o: { publicKey?: string; now?: () => number; ttlMs?: number } = {}) {
    this.publicKey = o.publicKey ?? 'MOCK-PUBLIC-KEY';
    this.now = o.now ?? Date.now;
    this.ttlMs = o.ttlMs ?? MAX_TTL_MS;
  }
  private readonly now: () => number;
  private readonly ttlMs: number;
  token(): Promise<CodefToken> {
    this.calls++;
    return Promise.resolve({ accessToken: `mock-codef-token-${this.calls.toString().padStart(4, '0')}`, expiresAt: this.now() + this.ttlMs });
  }
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * 환경 변수 → 원천. CODEF_ENV가 없으면 demo(CODEF_CLIENT_ID가 있을 때), 둘 다 없으면 null(기능 꺼짐: 엔드포인트는 503 gateway.codef_off, 다른 경로는 그대로 기동한다).
 * 값이 있는데 형식이 틀리면 기동하지 않는다(조용히 꺼지지 않게).
 */
export function codefFromEnv(env: NodeJS.ProcessEnv, fail: (name: string) => never): CodefTokenSource | null {
  // 기본 환경은 demo(대표 데모 사용신청 2026-11-12: 실제 기관·하루 100회·1개월). 키도 환경도 없으면 꺼짐
  const e = env.CODEF_ENV || (env.CODEF_CLIENT_ID ? 'demo' : '');
  if (!e) return null;
  if (e === 'mock') return new MockCodefTokenSource();
  if (!(CODEF_ENVS as readonly string[]).includes(e)) return fail('CODEF_ENV');
  const clientId = env.CODEF_CLIENT_ID;
  const clientSecret = env.CODEF_CLIENT_SECRET;
  const publicKey = (env.CODEF_PUBLIC_KEY ?? '').replace(/\s+/g, '');
  if (!clientId || !/^[\x21-\x7e]{8,128}$/.test(clientId)) return fail('CODEF_CLIENT_ID');
  if (!clientSecret || !/^[\x21-\x7e]{8,256}$/.test(clientSecret)) return fail('CODEF_CLIENT_SECRET');
  if (publicKey.length < 200 || publicKey.length > 2048 || !B64.test(publicKey)) return fail('CODEF_PUBLIC_KEY');
  return new CodefOAuth({ env: e as CodefEnv, clientId, clientSecret, publicKey });
}
