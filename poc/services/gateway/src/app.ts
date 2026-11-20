import { DailySalt, DeviceAuth, Router, fail, json, validator, type Ctx, type DeviceDirectory, type TokenVerifier } from '@sax/svc-shared';
import { CodefUnavailable, type CodefTokenSource } from './codef.ts';
import { AGENT_TOOLSETS } from '@sax/model';
import { GATEWAY } from './constants.ts';
import { decideAllowed, toolsetAllowed, type GatewayService } from './service.ts';

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
  codefToken: validator<Record<string, never>>({ type: 'object', additionalProperties: false, properties: {} }, 'gateway.param_rejected'),
};

export interface GatewayAppOpts {
  svc: GatewayService;
  verifier: TokenVerifier;
  directory: DeviceDirectory;
  publicOrigin: string;
  codef?: CodefTokenSource | null;
}

export function gatewayRouter(o: GatewayAppOpts): Router {
  const { svc } = o;
  const r = new Router();
  const auth = new DeviceAuth({ verifier: o.verifier, directory: o.directory, publicOrigin: o.publicOrigin, now: svc.now });
  const idSalt = new DailySalt('aid', svc.now);
  const limitSalt = svc.limits.idSalt('gw-limit');
  const limit = async (prefix: string, id: string, n: number, windowMs: number) => {
    const h = await svc.limits.limiter.hit(`${prefix}:${await limitSalt.hash(id)}`, n, windowMs);
    if (!h.ok) fail('policy.rate_limited', { retryAfterSec: h.retryAfterSec });
  };
  const device = async (ctx: Ctx, logAid = true) => {
    const c = await auth.check(ctx, 'gateway', 'gateway.unauthorized', 'gateway.device_suspended');
    if (c.role !== 'desktop') fail('account.scope_denied');
    if (logAid) ctx.logAid = idSalt.hash(c.acc);
    return c;
  };
  const chatter = async (ctx: Ctx) => {
    const c = await auth.check(ctx, ['gateway', 'chat'], 'gateway.unauthorized', 'gateway.device_suspended');
    if (!c.scp.includes(c.role === 'desktop' ? 'gateway' : 'chat')) fail('account.scope_denied');
    ctx.logAid = idSalt.hash(c.acc);
    return c;
  };

  r.add('POST', '/v1/run-tokens', async (ctx) => {
    const c = await chatter(ctx);
    const b = V.runToken(ctx.body);
    if (c.role === 'mobile' && !('chatSessionId' in b)) fail('account.scope_denied');
    await limit('rt', c.dev, GATEWAY.runTokensPerDeviceHour, 60 * MIN);
    return json(200, await svc.issueRunToken(c, b));
  });
  r.add(
    'POST',
    '/v1/decide',
    async (ctx) => {
      const c = await chatter(ctx);
      if (!decideAllowed(c.role, (ctx.body as { bundleId?: unknown } | null)?.bundleId)) fail('account.scope_denied');
      await limit('l1', c.acc, GATEWAY.l1PerMinute, MIN);
      return json(200, await svc.decide(c, ctx.body));
    },
    { maxBodyBytes: 64 * 1024 },
  );
  r.add(
    'POST',
    '/v1/respond',
    async (ctx) => {
      const c = await chatter(ctx);
      const toolset = (ctx.body as { toolset?: unknown } | null)?.toolset;
      if (!toolsetAllowed(c.role, toolset)) fail('account.scope_denied');
      if ((AGENT_TOOLSETS as readonly unknown[]).includes(toolset)) await limit('agent', c.acc, GATEWAY.agentPerMinute, MIN);
      else await limit('l2', c.acc, GATEWAY.l2PerMinute, MIN);
      return json(200, await svc.respond(c, ctx.body));
    },
    { maxBodyBytes: 1024 * 1024 },
  );
  r.add('GET', '/v1/usage', async (ctx) => json(200, await svc.dailyUsage(await chatter(ctx))));
  r.add('POST', '/v1/biz/status', async (ctx) => {
    const c = await device(ctx, false);
    const b = V.biz(ctx.body);
    await limit('biz', c.acc, GATEWAY.bizPerMinute, MIN);
    return json(200, await svc.bizStatus(b.b_no));
  });
  r.add('POST', '/v1/codef/token', async (ctx) => {
    const c = await device(ctx, false);
    V.codefToken(ctx.body ?? {});
    if (!o.codef) fail('gateway.codef_off');
    await limit('codef', c.dev, GATEWAY.codefTokenPerDeviceHour, 60 * MIN);
    let t;
    try {
      t = await o.codef.token();
    } catch (e) {
      if (e instanceof CodefUnavailable) fail('gateway.upstream_error');
      throw e;
    }
    return json(200, { accessToken: t.accessToken, expiresAt: new Date(t.expiresAt).toISOString(), env: o.codef.env, publicKey: o.codef.publicKey });
  });
  r.add('GET', '/healthz', () => json(200, { ok: true }));
  return r;
}
