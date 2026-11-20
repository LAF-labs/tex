import type http from 'node:http';
import { safeEqual } from './crypto.ts';

/** `ACCOUNT__DATABASE_URL` → 계정 서비스의 `DATABASE_URL`. 접두 붙은 값이 접두 없는 공통 값보다 앞선다. 다른 서비스 접두 값은 넘기지 않는다. */
export function serviceEnv(prefix: string, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!/^[A-Z]+$/.test(prefix)) throw new Error('config_service_prefix');
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!/^[A-Z]+__/.test(k)) out[k] = v;
  for (const [k, v] of Object.entries(env)) if (k.startsWith(`${prefix}__`)) out[k.slice(prefix.length + 2)] = v;
  return out;
}

/** 재작성 규칙이 원래 경로를 `__p`로 넘긴다. 함수 런타임이 req.url을 어떻게 주든 서비스는 원래 경로·쿼리를 본다(DPoP htu = origin + 경로). */
export const PATH_PARAM = '__p';

/**
 * 재작성 규칙 소스의 이름 붙은 매개변수(`/registry/log/:path*`의 `path`, `/…/devices/:id`의 `id`). 플랫폼이 목적지에서 이미 쓴 매개변수도
 * 쿼리에 다시 붙여 넘긴다(2026-11-06 운영 확인: `/registry/log/head.json` → `?__p=/registry/log/head.json&path=head.json`).
 * 원래 요청의 쿼리가 아니므로 복원할 때 뺀다. 서비스 라우터는 이 이름을 쿼리 키로 쓰지 않는다(시험이 vercel.json·라우터와 대조한다).
 */
export const REWRITE_PARAMS = ['path', 'id'] as const;

/**
 * `/api/x?__p=/v1/a&q=1` → `/v1/a?q=1`. `__p`가 없거나 `/`로 시작하지 않으면 null.
 * 재작성 매개변수(REWRITE_PARAMS)는 값이 모두 `__p`의 끝 구간(또는 빈 값)일 때만 뺀다. 그 밖의 값이면 원래 요청에서 온 것으로 보고 남긴다(라우터가 거부한다).
 */
export function restorePath(url: string | undefined): string | null {
  const u = new URL(url ?? '/', 'http://fn.invalid');
  const p = u.searchParams.get(PATH_PARAM);
  if (!p || !p.startsWith('/') || p.startsWith('//')) return null;
  u.searchParams.delete(PATH_PARAM);
  for (const name of REWRITE_PARAMS) {
    const vals = u.searchParams.getAll(name);
    if (vals.length && vals.every((v) => v === '' || p.endsWith(`/${v}`))) u.searchParams.delete(name);
  }
  const q = u.searchParams.toString();
  return q ? `${p}?${q}` : p;
}

export interface FunctionEntryOpts {
  build(): Promise<(req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>>;
  internal?: (method: string, pathname: string) => boolean;
}

const reply = (res: http.ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)), 'cache-control': 'no-store' });
  res.end(payload);
};

const isInternal = (pathname: string) => pathname === '/internal' || pathname.startsWith('/internal/');

/**
 * 함수 진입점(팀장 결정 2026-11-06 #135 (1): 내부 API를 공개 경로로 노출하지 않는다). 경로를 복원해 점 구간(`..`, `%2e%2e`)을 먼저 정규화한 뒤
 * 공개·내부를 가른다(라우터가 보는 경로와 같은 값으로 판단한다).
 */
export function functionEntry(o: FunctionEntryOpts): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  let built: ReturnType<FunctionEntryOpts['build']> | null = null;
  return async (req, res) => {
    const restored = restorePath(req.url);
    if (!restored) return reply(res, 404, { error: 'request.not_found' });
    const u = new URL(restored, 'http://fn.invalid');
    const allowed = o.internal ? isInternal(u.pathname) && o.internal(req.method ?? 'GET', u.pathname) : !isInternal(u.pathname);
    if (!allowed) return reply(res, 404, { error: 'request.not_found' });
    req.url = u.pathname + u.search;
    built ??= o.build();
    const listener = await built.catch((e: unknown) => {
      built = null;
      throw e;
    });
    await listener(req, res);
  };
}

/** 정리 함수(플랫폼 cron). `GET` + `Authorization: Bearer <CRON_SECRET>`(32자 이상)만. 다른 일은 하지 않는다. */
export function cronEntry(o: { cronSecret: string | undefined; sweep(): Promise<void> }): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async (req, res) => {
    const auth = String(req.headers.authorization ?? '');
    if (req.method !== 'GET' || !o.cronSecret || o.cronSecret.length < 32 || !safeEqual(auth, `Bearer ${o.cronSecret}`)) return reply(res, 401, { error: 'account.unauthorized' });
    await o.sweep();
    return reply(res, 200, { ok: true });
  };
}
