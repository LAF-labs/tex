import type http from 'node:http';
import { buildAccount } from '@sax/svc-account';
import { buildGateway, type DeviceSuspender } from '@sax/svc-gateway';
import { buildPush } from '@sax/svc-push';
import { buildRelay } from '@sax/svc-relay';
import { cronEntry, functionEntry, requestListener, serviceEnv, type DeviceDirectory, type Router } from '@sax/svc-shared';

type Listener = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

/** 네 서비스 조립. 정지 알림은 같은 배포 안이면 함수 호출(푸시 토큰 삭제), 룸 호스트는 계정의 STOP_HOOK_URLS(서명 HTTP) */
export async function buildCloud(env: NodeJS.ProcessEnv = process.env) {
  let push: Awaited<ReturnType<typeof buildPush>> | null = null;
  let relayRef: Awaited<ReturnType<typeof buildRelay>> | null = null;
  const stopped = async (id: string) => {
    await push?.svc.remove(id);
    await relayRef?.svc.freePeer(id);
  };
  const account = await buildAccount(serviceEnv('ACCOUNT', env), { stopHooks: [{ stopped }] }, { migrate: false });
  const directory: DeviceDirectory = { get: (id) => account.svc.deviceRecord(id) };
  const suspender: DeviceSuspender = { suspend: async (id) => void (await account.svc.autoSuspend(id)) };
  const gateway = await buildGateway(serviceEnv('GATEWAY', env), { directory, suspender }, { migrate: false });
  const relay = await buildRelay(serviceEnv('RELAY', env), { migrate: false, stateful: false }, { directory });
  relayRef = relay;
  push = await buildPush(serviceEnv('PUSH', env), { directory }, { migrate: false });
  const trust = (e: NodeJS.ProcessEnv) => e.TRUST_PROXY === '1';
  const services: { router: Router; listener: Listener }[] = [
    { router: account.router, listener: requestListener(account.router, { logger: account.logger, trustProxy: trust(serviceEnv('ACCOUNT', env)) }) },
    { router: gateway.router, listener: requestListener(gateway.router, { logger: gateway.logger, trustProxy: trust(serviceEnv('GATEWAY', env)) }) },
    { router: relay.hub.router, listener: requestListener(relay.hub.router, { logger: relay.logger, trustProxy: trust(serviceEnv('RELAY', env)) }) },
    { router: push.router, listener: requestListener(push.router, { logger: push.logger, trustProxy: trust(serviceEnv('PUSH', env)) }) },
  ];
  const listener: Listener = async (req, res) => {
    const { pathname } = new URL(req.url ?? '/', 'http://fn.invalid');
    const s = services.find((x) => x.router.match(req.method ?? 'GET', pathname) !== null) ?? services[0]!;
    await s.listener(req, res);
  };
  const sweep = async () => void (await Promise.all([account.sweep(), gateway.sweep(), relay.sweep(), push.sweep()]));
  const close = async () => void (await Promise.all([account.db.close(), gateway.db.close(), relay.db.close(), push.db.close()]));
  return { account, gateway, relay, push, directory, suspender, services, listener, sweep, close };
}

/** 공개 함수(`api/sax.js`): 공개 경로만. `/internal/*`은 어떤 경로로 와도 404 */
export function cloudFunction(env: NodeJS.ProcessEnv = process.env): Listener {
  return functionEntry({ build: async () => (await buildCloud(env)).listener });
}

/** 내부 함수가 받는 경로: 룸 호스트의 기기 상태 조회 하나(GET). 자동 정지는 같은 배포 안에서 함수로 부르므로 HTTP로 열지 않는다 */
export const INTERNAL_FUNCTION_ROUTES: readonly { method: string; re: RegExp }[] = [{ method: 'GET', re: /^\/internal\/v1\/devices\/[A-Za-z0-9_.@-]{1,128}$/ }];

/** 내부 함수(`api/internal.js`): 위 목록만, 그리고 계정 서비스의 서명 검사(INTERNAL_CALL_KEY, ±60초, 1회용 nonce)를 거친다. 그 밖은 404 */
export function internalFunction(env: NodeJS.ProcessEnv = process.env): Listener {
  return functionEntry({
    internal: (method, pathname) => INTERNAL_FUNCTION_ROUTES.some((r) => r.method === method && r.re.test(pathname)),
    build: async () => {
      const e = serviceEnv('ACCOUNT', env);
      const b = await buildAccount(e, {}, { migrate: false });
      return requestListener(b.router, { logger: b.logger, trustProxy: e.TRUST_PROXY === '1' });
    },
  });
}

/** 정리 함수(`api/cron.js`): 플랫폼 cron이 `Authorization: Bearer <CRON_SECRET>`으로 부른다 */
export function cronFunction(env: NodeJS.ProcessEnv = process.env): Listener {
  let built: ReturnType<typeof buildCloud> | null = null;
  return cronEntry({
    cronSecret: env.CRON_SECRET,
    sweep: async () => {
      built ??= buildCloud(env);
      const b = await built.catch((e: unknown) => {
        built = null;
        throw e;
      });
      await b.sweep();
    },
  });
}
