
export const CODEF_ENVS = ['sandbox', 'demo', 'prod'] as const;
export type CodefEnv = (typeof CODEF_ENVS)[number];

/** 토큰 발급 주소(세 환경 공통). OAuth 2.0 client credentials, Basic 인증 */
export const CODEF_OAUTH_URL = 'https://oauth.codef.io/oauth/token';

/** 토큰이 이만큼 남으면 새로 받는다(서버 캐시). PC는 받은 만료 시각 기준으로 스스로 다시 묻는다. */
export const CODEF_TOKEN_REFRESH_MARGIN_MS = 60 * 60_000;
const FALLBACK_TTL_MS = 60 * 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60_000;

export interface CodefToken {
  accessToken: string;
  expiresAt: number;
}

export interface CodefTokenSource {
  readonly env: CodefEnv;
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
