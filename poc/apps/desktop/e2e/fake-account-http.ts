// e2e용 계정 서비스 HTTP 앞단: 메모리 가짜 AccountClient를 localhost HTTP로 내놓는다.
// 셸은 이 앞단에 제품 클라이언트(remote-cloud.ts cloudPorts) + 제품 Egress(허용 목록 그대로, cloudDevLocal)로 닿는다.
// 그래서 허용 목록에 없는 경로는 e2e에서도 net.path_not_allowed로 실패한다(#224 결함이 e2e를 지난 것의 재발 방지).
// 응답 모양·상태 코드는 services/account/API.md와 remote-cloud.ts가 기대하는 것과 같다. 기기 범위 호출(토큰·DPoP)은 두지 않는다.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AccountClient } from '../dist/remote-ports.js';

type Route = (c: AccountClient, b: Record<string, unknown>, session: string) => Promise<[number, unknown]>;

const R: Record<string, Route> = {
  'POST /v1/auth/code': async (c, b) => [200, await c.startEmailCode(String(b.email))],
  'POST /v1/auth/code/verify': async (c, b) => [200, await c.verifyEmailCode(String(b.loginId), String(b.code), b.remember === true)],
  'POST /v1/auth/password': async (c, b) => [200, await c.passwordLogin(String(b.email), String(b.password), b.remember === true)],
  'POST /v1/auth/logout': async (c, _b, s) => (await c.logout(s), [204, null]),
  'POST /v1/auth/logout-all': async (c, _b, s) => (await c.logoutAll(s), [204, null]),
  'GET /v1/device-list': async (c, _b, s) => [200, await c.deviceList(s)],
  'POST /v1/aik': async (c, b, s) => [201, await c.pinFirstDesktop(s, b as never)],
  'GET /v1/me': async (c, _b, s) => [200, await c.me(s)],
  'PUT /v1/password': async (c, b, s) => {
    const r = await c.setPassword(s, String(b.password), typeof b.currentPassword === 'string' ? b.currentPassword : undefined);
    return r.refreshToken ? [200, r] : [204, null];
  },
  'DELETE /v1/password': async (c, _b, s) => (await c.deletePassword(s), [204, null]),
  'POST /v1/auth/reauth': async (c, _b, s) => [200, await c.startReauth(s)],
  'POST /v1/auth/reauth/verify': async (c, b, s) => [200, await c.verifyReauth(s, String(b.reauthId), String(b.code))],
  'POST /v1/auth/password/reset': async (c, b) => [200, await c.startPasswordReset(String(b.email))],
  'POST /v1/auth/password/reset/verify': async (c, b) => [200, await c.verifyPasswordReset(String(b.resetId), String(b.code), String(b.password), b.remember === true)],
  'POST /v1/auth/refresh': async (c, b) => [200, await c.refresh(String(b.refreshToken))],
  'POST /v1/auth/refresh/revoke': async (c, b) => (await c.revokeRefresh(String(b.refreshToken)), [204, null]),
};

/** 가짜 클라이언트를 HTTP로 띄운다. hits는 앞단이 받은 "메서드 경로"(허용 목록을 지난 요청만 여기 닿는다). */
export async function serveAccount(client: AccountClient): Promise<{ origin: string; hits: string[]; close(): void }> {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    const key = `${req.method} ${req.url}`;
    hits.push(key);
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      const route = R[key];
      const send = (status: number, body: unknown) => {
        if (body === null) return void res.writeHead(status).end();
        res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      };
      if (!route) return send(404, { error: 'request.not_found' });
      let body: Record<string, unknown>;
      try {
        body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {};
      } catch {
        return send(400, { error: 'request.param_rejected' });
      }
      const session = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      route(client, body, session).then(
        ([status, b]) => send(status, b),
        (e: { code?: string }) => send(e.code === 'account.credentials_invalid' || e.code === 'account.unauthorized' ? 401 : 400, { error: e.code ?? 'server.unknown' }),
      );
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return { origin: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, hits, close: () => srv.close() };
}
