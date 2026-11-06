// 게이트웨이 HTTP. 데스크톱 기기 범위 토큰(gateway 범위) + DPoP만 받는다. 계정 세션 토큰은 거부(규칙: X-Device-Id는 토큰에서 유도, N-41).
import { DailySalt, DeviceAuth, RateLimiter, Router, fail, json, validator, type Ctx, type DeviceDirectory, type TokenVerifier } from '@sax/svc-shared';
import { GATEWAY } from './constants.ts';
import type { GatewayService } from './service.ts';

const MIN = 60_000;
const id64 = { type: 'string', pattern: '^[A-Za-z0-9_.-]{8,64}$' };

const V = {
  runToken: validator<{ runId: string } | { chatSessionId: string }>(
    {
      oneOf: [
        { type: 'object', additionalProperties: false, required: ['runId'], properties: { runId: id64 } },
        { type: 'object', additionalProperties: false, required: ['chatSessionId'], properties: { chatSessionId: id64 } },
      ],
    },
    'gateway.param_rejected',
  ),
  biz: validator<{ b_no: string[] }>(
    { type: 'object', additionalProperties: false, required: ['b_no'], properties: { b_no: { type: 'array', minItems: 1, maxItems: GATEWAY.bizPerRequest, items: { type: 'string', pattern: '^[0-9]{10}$' } } } },
    'gateway.param_rejected',
  ),
};

export interface GatewayAppOpts {
  svc: GatewayService;
  verifier: TokenVerifier;
  directory: DeviceDirectory;
  publicOrigin: string;
}

export function gatewayRouter(o: GatewayAppOpts): Router {
  const { svc } = o;
  const r = new Router();
  const auth = new DeviceAuth({ verifier: o.verifier, directory: o.directory, publicOrigin: o.publicOrigin, now: svc.now });
  const limits = new RateLimiter(svc.now);
  const idSalt = new DailySalt('aid', svc.now);
  const limitSalt = new DailySalt('gw-limit', svc.now);
  const limit = (key: string, n: number, windowMs: number) => {
    if (!limits.hit(key, n, windowMs)) fail('policy.rate_limited', { retryAfterSec: limits.retryAfter(key, windowMs) });
  };
  /** logAid=false: 진위확인 경로는 접근 로그에 계정 식별자도 남기지 않는다(D09 §4.1) */
  const device = async (ctx: Ctx, logAid = true) => {
    const c = await auth.check(ctx, 'gateway', 'gateway.unauthorized', 'gateway.device_suspended');
    if (c.role !== 'desktop') fail('account.scope_denied');
    if (logAid) ctx.logAid = idSalt.hash(c.acc);
    return c;
  };

  r.add('POST', '/v1/run-tokens', async (ctx) => {
    const c = await device(ctx);
    const b = V.runToken(ctx.body);
    limit(`rt:${limitSalt.hash(c.dev)}`, GATEWAY.runTokensPerDeviceHour, 60 * MIN);
    return json(200, await svc.issueRunToken(c, b));
  });
  r.add(
    'POST',
    '/v1/decide',
    async (ctx) => {
      const c = await device(ctx);
      limit(`l1:${limitSalt.hash(c.acc)}`, GATEWAY.l1PerMinute, MIN);
      return json(200, await svc.decide(c, ctx.body));
    },
    { maxBodyBytes: 64 * 1024 },
  );
  r.add(
    'POST',
    '/v1/respond',
    async (ctx) => {
      const c = await device(ctx);
      limit(`l2:${limitSalt.hash(c.acc)}`, GATEWAY.l2PerMinute, MIN);
      return json(200, await svc.respond(c, ctx.body));
    },
    { maxBodyBytes: 1024 * 1024 },
  );
  r.add('POST', '/v1/biz/status', async (ctx) => {
    const c = await device(ctx, false);
    const b = V.biz(ctx.body);
    limit(`biz:${limitSalt.hash(c.acc)}`, GATEWAY.bizPerMinute, MIN);
    return json(200, await svc.bizStatus(b.b_no));
  });
  r.add('GET', '/healthz', () => json(200, { ok: true }));
  return r;
}
