// 레지스트리 함수 배포(Vercel, tax.laf-co.com, 팀장 결정 2026-11-06). 계정·게이트웨이 함수와 실패 영역을 나눈다:
// 레지스트리 구성이 없거나 틀려도 로그인·게이트웨이는 그대로 돈다.
// - 공개 정적 GET(/registry/*·/policy/*·/packages/*·/releases/*)은 이 함수를 거치지 않는다: Vercel 외부 재작성이 공개 버킷으로 보낸다.
// - 이 함수(api/registry)는 투명성 로그 GET(/registry/log/*)과 게시 PUT(/admin/v1/*)만 받는다. 그 밖은 404.
// - 정리 함수(api/registry-cron)는 타임스탬프 자동 재서명(resign.ts)을 한다.
// - 서명 의식 전이라 TRUST_ROOT_JSON이 없으면 두 함수 모두 503 registry.unavailable이다. 타임스탬프 키의 공개키가 핀 고정 timestamp 키와 다르거나
//   다른 역할 키와 같으면 기동을 거부한다(logSigningKey, config_REGISTRY_LOG_SIGNING_KEY → 503, 로그에는 설정 이름만).
// - 함수는 DDL을 하지 않는다(Supabase 마이그레이션은 배포 절차가 적용한다). 개발·시험의 메모리 저장소만 기동 때 마이그레이션한다.
import type http from 'node:http';
import { Logger, openFromEnv, openSqlite, requestListener, restorePath, safeEqual, serviceEnv } from '@sax/svc-shared';
import { registryRouter } from './app.ts';
import { TransparencyLog, logSigningKey } from './log.ts';
import { parseTrustRoot } from './main.ts';
import { resignAll, type ResignReport } from './resign.ts';
import { DirStore, MemoryStore, type Store } from './store.ts';
import { s3StoreFromEnv } from './store-s3.ts';

type Listener = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

function need(name: string): never {
  throw new Error(`config_${name}`);
}

/** env(REGISTRY__ 접두를 뗀 값)로 조립. 실패는 config_<이름> */
export async function buildRegistryDeploy(env: NodeJS.ProcessEnv, deps: { store?: Store; now?: () => number; logger?: Logger } = {}) {
  const now = deps.now ?? Date.now;
  const trust = parseTrustRoot(env.TRUST_ROOT_JSON);
  const signer = logSigningKey(env.REGISTRY_LOG_SIGNING_KEY, trust);
  const adminToken = env.REGISTRY_ADMIN_TOKEN && env.REGISTRY_ADMIN_TOKEN.length >= 32 ? env.REGISTRY_ADMIN_TOKEN : need('REGISTRY_ADMIN_TOKEN');
  const store = deps.store ?? s3StoreFromEnv(env) ?? (env.REGISTRY_DIR ? new DirStore(env.REGISTRY_DIR) : env.REGISTRY_STORE === 'memory' ? new MemoryStore() : need('S3_ENDPOINT'));
  const memoryDb = !env.DATABASE_URL && !env.SAX_SQLITE_FILE && env.REGISTRY_STORE === 'memory';
  const db = env.DATABASE_URL || env.SAX_SQLITE_FILE ? openFromEnv(env) : memoryDb ? openSqlite() : need('DATABASE_URL');
  const log = await TransparencyLog.open({ db, signer, now, migrate: memoryDb });
  const logger = deps.logger ?? new Logger('registry');
  const router = registryRouter({ store, trust, adminToken, now, onEvent: (e) => logger.event(e), log });
  const listener = requestListener(router, { logger, trustProxy: env.TRUST_PROXY === '1' });
  const resign = (): Promise<ResignReport> => resignAll({ store, trust, log, signer, now, onEvent: (e) => logger.event(e) });
  return { trust, store, db, log, logger, router, listener, resign, close: () => db.close() };
}

type Built = Awaited<ReturnType<typeof buildRegistryDeploy>>;

const reply = (res: http.ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(Buffer.byteLength(payload)), 'cache-control': 'no-store' });
  res.end(payload);
};

/** 이 함수가 받는 경로: 투명성 로그 GET과 게시 PUT. 공개 정적 파일은 버킷 재작성으로 간다 */
export function registryFunctionPath(method: string, pathname: string): boolean {
  if (method === 'GET') return pathname.startsWith('/registry/log/');
  if (method === 'PUT') return pathname.startsWith('/admin/v1/');
  return false;
}

const startError = (e: unknown) => {
  const m = (e as Error)?.message ?? '';
  return /^config_[A-Z0-9_]+$/.test(m) ? m : 'error';
};

/** 한 번 조립(실패하면 다음 요청에서 다시). TRUST_ROOT_JSON이 없으면(서명 의식 전) 조립하지 않는다 */
function lazy(env: NodeJS.ProcessEnv, logger: Logger, deps: Parameters<typeof buildRegistryDeploy>[1]) {
  let built: Promise<Built> | null = null;
  return async (): Promise<Built | null> => {
    if (!env.TRUST_ROOT_JSON) return null;
    built ??= buildRegistryDeploy(env, { logger, ...deps });
    try {
      return await built;
    } catch (e) {
      built = null;
      logger.event(`registry.start_failed.${startError(e)}`);
      return null;
    }
  };
}

/** 레지스트리 함수(`api/registry.js`). env는 공통 + `REGISTRY__` 접두 */
export function registryFunction(rawEnv: NodeJS.ProcessEnv = process.env, deps: Parameters<typeof buildRegistryDeploy>[1] = {}): Listener {
  const env = serviceEnv('REGISTRY', rawEnv);
  const logger = deps.logger ?? new Logger('registry');
  const get = lazy(env, logger, deps);
  return async (req, res) => {
    const restored = restorePath(req.url);
    if (!restored) return reply(res, 404, { error: 'request.not_found' });
    const u = new URL(restored, 'http://fn.invalid');
    if (!registryFunctionPath(req.method ?? 'GET', u.pathname)) return reply(res, 404, { error: 'request.not_found' });
    const b = await get();
    if (!b) return reply(res, 503, { error: 'registry.unavailable' });
    req.url = u.pathname + u.search;
    await b.listener(req, res);
  };
}

/** 재서명 함수(`api/registry-cron.js`): 플랫폼 cron이 `GET` + `Authorization: Bearer <CRON_SECRET>`(32자 이상)으로 부른다 */
export function registryCronFunction(rawEnv: NodeJS.ProcessEnv = process.env, deps: Parameters<typeof buildRegistryDeploy>[1] = {}): Listener {
  const env = serviceEnv('REGISTRY', rawEnv);
  const logger = deps.logger ?? new Logger('registry');
  const get = lazy(env, logger, deps);
  return async (req, res) => {
    const auth = String(req.headers.authorization ?? '');
    const secret = env.CRON_SECRET;
    if (req.method !== 'GET' || !secret || secret.length < 32 || !safeEqual(auth, `Bearer ${secret}`)) return reply(res, 401, { error: 'account.unauthorized' });
    const b = await get();
    if (!b) return reply(res, 503, { error: 'registry.unavailable' });
    // 결과는 대상별 상태 이름만(resigned·fresh·missing·changed·rejected:<코드>)
    return reply(res, 200, { ok: true, ...(await b.resign()) });
  };
}
