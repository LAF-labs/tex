// 푸시 디스패처 HTTP. 폰은 push 범위 토큰으로 자기 푸시 토큰만 올리고 지운다. PC는 wake 범위 토큰으로 같은 계정의 활성 폰만 깨운다.
// 접근 로그에 계정 식별자를 남기지 않는다(깨우기 시각과 계정의 결합을 줄인다). 깨우기 시각도 저장하지 않는다.
import { DeviceAuth, Router, fail, json, validator, memoryLimits, type Ctx, type DeviceDirectory, type InternalCheck, type Limits, type TokenVerifier } from '@sax/svc-shared';
import { PUSH, type PushService } from './service.ts';
import type { Platform } from './senders.ts';

const V = {
  token: validator<{ platform: Platform; token: string }>({
    type: 'object',
    additionalProperties: false,
    required: ['platform', 'token'],
    properties: { platform: { enum: ['apns', 'fcm'] }, token: { type: 'string', pattern: '^[A-Za-z0-9_:-]{32,4096}$' } },
  }),
  wake: validator<{ deviceId: string }>({ type: 'object', additionalProperties: false, required: ['deviceId'], properties: { deviceId: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' } } }),
};

export interface PushAppOpts {
  svc: PushService;
  verifier: TokenVerifier;
  directory: DeviceDirectory & { invalidate?(deviceId: string): void };
  publicOrigin: string;
  /** 내부 경로(/internal/*) 서명 검사(INTERNAL_CALL_KEY HMAC, 팀장 결정 2026-11-06 #135) */
  internal: InternalCheck;
  /** 한도 카운터·키 솔트. 배포는 DB(`sqlLimits`, 인스턴스 공유), 없으면 메모리 */
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
    if (b.platform === 'apns' && !/^[0-9a-f]{64,200}$/.test(b.token)) fail('request.param_rejected');
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
    const { deviceId } = V.wake(ctx.body);
    // 같은 계정의 활성 폰만. 다른 계정·없는 기기·정지 기기는 같은 코드(기기 존재 오라클 없음)
    const t = await o.directory.get(deviceId);
    if (!t || t.accountId !== c.acc || t.role !== 'mobile' || t.state !== 'active') fail('push.target_not_found');
    const k = await salt.hash(deviceId);
    await limit(`wake-m:${k}`, PUSH.wakePerMinute, 60_000);
    await limit(`wake-h:${k}`, PUSH.wakePerHour, 3600_000);
    return json(202, await svc.wake(deviceId));
  });
  // 계정 서비스의 긴급 정지·폐기 훅: 푸시 토큰 즉시 삭제(D08 §8.1·§9.3)
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
