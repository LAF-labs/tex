// 함수 배포(Vercel 등) 공용: 서비스별 환경 변수 접두, 경로 복원, 내부·정리 경로 보호.
// 한 프로젝트에 여러 서비스를 함수로 올리면 환경 변수가 프로젝트 전체에 공유된다. 그래서 서비스별 값은 `<서비스>__<이름>`으로 두고
// 진입점이 접두를 벗겨 그 서비스의 env로 쓴다(공통 값은 접두 없이). 공급사 이름에 묶인 코드는 없다(ADR-015).
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

/** `/api/x?__p=/v1/a&q=1` → `/v1/a?q=1`. `__p`가 없거나 `/`로 시작하지 않으면 null */
export function restorePath(url: string | undefined): string | null {
  const u = new URL(url ?? '/', 'http://fn.invalid');
  const p = u.searchParams.get(PATH_PARAM);
  if (!p || !p.startsWith('/') || p.startsWith('//')) return null;
  u.searchParams.delete(PATH_PARAM);
  const q = u.searchParams.toString();
  return q ? `${p}?${q}` : p;
}

export interface FunctionEntryOpts {
  /** 요청 처리기(서비스 라우터). 처음 요청 때 한 번 만든다 */
  build(): Promise<{ listener: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>; sweep(): Promise<void> }>;
  /** 정리 작업 호출(`/internal/v1/cron`)의 `Authorization: Bearer <비밀>`(플랫폼 cron 비밀) */
  cronSecret: string | undefined;
}

const reply = (res: http.ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)), 'cache-control': 'no-store' });
  res.end(payload);
};

/**
 * 함수 진입점. 경로를 복원하고, `/internal/v1/cron`(정리)은 cron 비밀로만 받는다. 다른 `/internal/*`은 서비스의 내부 비밀 검사로 간다
 * (함수 플랫폼에는 사설망이 없어 내부 API가 인터넷에 닿는다. 공개 재작성 규칙에는 넣지 않는다).
 */
export function functionEntry(o: FunctionEntryOpts): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  let built: ReturnType<FunctionEntryOpts['build']> | null = null;
  return async (req, res) => {
    const path = restorePath(req.url);
    if (!path) return reply(res, 404, { error: 'request.not_found' });
    if (path === '/internal/v1/cron' || path.startsWith('/internal/v1/cron?')) {
      const auth = String(req.headers.authorization ?? '');
      if (!o.cronSecret || o.cronSecret.length < 32 || !safeEqual(auth, `Bearer ${o.cronSecret}`)) return reply(res, 401, { error: 'account.unauthorized' }); // requireInternal과 같은 코드
      built ??= o.build();
      await (await built).sweep();
      return reply(res, 200, { ok: true });
    }
    req.url = path;
    built ??= o.build();
    const b = await built.catch((e: unknown) => {
      built = null; // 다음 요청에서 다시 시도(설정 오류는 로그에 이름만)
      throw e;
    });
    await b.listener(req, res);
  };
}
