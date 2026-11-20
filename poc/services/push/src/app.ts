import { DeviceAuth, Router, fail, json, validator, memoryLimits, type Ctx, type DeviceDirectory, type InternalCheck, type Limits, type TokenVerifier } from '@sax/svc-shared';
import { PUSH, type PushService } from './service.ts';
import { PLATFORMS, WAKE_KINDS, type Platform, type WakeKind } from './senders.ts';

const V = {
  token: validator<{ platform: Platform; token: string }>({
    type: 'object',
    additionalProperties: false,
    required: ['platform', 'token'],
    properties: { platform: { enum: [...PLATFORMS] }, token: { type: 'string', pattern: '^[A-Za-z0-9_:-]{32,4096}$' } },
  }),
  wake: validator<{ deviceId: string; kind?: WakeKind }>({
    type: 'object',
    additionalProperties: false,
    required: ['deviceId'],
    properties: { deviceId: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' }, kind: { enum: [...WAKE_KINDS] } },
  }),
};

export interface PushAppOpts {
  svc: PushService;
  verifier: TokenVerifier;
  directory: DeviceDirectory & { invalidate?(deviceId: string): void };
  publicOrigin: string;
  internal: InternalCheck;
  limits?: Limits;
}

export function pushRouter(o: PushAppOpts): Router {
  const { svc } = o;
  const r = new Router();
  const auth = new DeviceAuth({ verifier: o.verifier, directory: o.directory, publicOrigin: o.publicOrigin, now: svc.now });
  const limits = o.limits ?? memoryLimits(svc.now);
  const salt = limits.idSalt('push-limit');
  const limit = async (key: string, n: number, windowMs: number) => {
    const h = await limits.limiter.hit(key, n, windowMs);
    if (!h.ok) fail('policy.rate_limited', { retryAfterSec: h.retryAfterSec });
  };
  const phone = async (ctx: Ctx) => {
    const c = await auth.check(ctx, 'push', 'push.unauthorized', 'push.device_suspended');
    if (c.role !== 'mobile') fail('account.scope_denied');
    return c;
  };

  r.add('PUT', '/v1/push-token', async (ctx) => {
    const c = await phone(ctx);
    const b = V.token(ctx.body);
    if (b.platform !== 'fcm' && !/^[0-9a-f]{64,200}$/.test(b.token)) fail('request.param_rejected');
    await svc.register(c.dev, b.platform, b.token);
    return json(204, undefined);
  });
  r.add('DELETE', '/v1/push-token', async (ctx) => {
    const c = await phone(ctx);
    await svc.remove(c.dev);
    return json(204, undefined);
  });
  r.add('POST', '/v1/wake', async (ctx) => {
    const c = await auth.check(ctx, 'wake', 'push.unauthorized', 'push.device_suspended');
    if (c.role !== 'desktop') fail('account.scope_denied');
    const { deviceId, kind } = V.wake(ctx.body);
    const t = await o.directory.get(deviceId);
    if (!t || t.accountId !== c.acc || t.role !== 'mobile' || t.state !== 'active') fail('push.target_not_found');
    const k = await salt.hash(deviceId);
    await limit(`wake-m:${k}`, PUSH.wakePerMinute, 60_000);
    await limit(`wake-h:${k}`, PUSH.wakePerHour, 3600_000);
    return json(202, await svc.wake(deviceId, kind ?? 'update'));
  });
  r.add(
    'POST',
    '/internal/v1/devices/:id/stopped',
    async (ctx) => {
      await o.internal.check(ctx);
      o.directory.invalidate?.(ctx.params.id!);
      return json(200, { deleted: await svc.remove(ctx.params.id!) });
    },
    { raw: true },
  );
  r.add('GET', '/healthz', () => json(200, { ok: true }));
  return r;
}
