// 게이트웨이 HTTP. 데스크톱 기기 범위 토큰(gateway 범위) + DPoP만 받는다. 계정 세션 토큰은 거부(규칙: X-Device-Id는 토큰에서 유도, N-41).
import { DailySalt, DeviceAuth, Router, fail, json, validator, type Ctx, type DeviceDirectory, type TokenVerifier } from '@sax/svc-shared';
import { CodefUnavailable, type CodefTokenSource } from './codef.ts';
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
  codefToken: validator<Record<string, never>>({ type: 'object', additionalProperties: false, properties: {} }, 'gateway.param_rejected'),
};

export interface GatewayAppOpts {
  svc: GatewayService;
  verifier: TokenVerifier;
  directory: DeviceDirectory;
  publicOrigin: string;
  /** CODEF 토큰 원천(계좌 자동조회). 없으면 /v1/codef/token은 503 gateway.codef_off */
  codef?: CodefTokenSource | null;
}

export function gatewayRouter(o: GatewayAppOpts): Router {
  const { svc } = o;
  const r = new Router();
  const auth = new DeviceAuth({ verifier: o.verifier, directory: o.directory, publicOrigin: o.publicOrigin, now: svc.now });
  // 한도는 서비스와 같은 카운터·솔트(DB면 인스턴스 공유). 로그용 aid 솔트는 메모리만(DB에 둘 이유 없음)
  const idSalt = new DailySalt('aid', svc.now);
  const limitSalt = svc.limits.idSalt('gw-limit');
  const limit = async (prefix: string, id: string, n: number, windowMs: number) => {
    const h = await svc.limits.limiter.hit(`${prefix}:${await limitSalt.hash(id)}`, n, windowMs);
    if (!h.ok) fail('policy.rate_limited', { retryAfterSec: h.retryAfterSec });
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
    await limit('rt', c.dev, GATEWAY.runTokensPerDeviceHour, 60 * MIN);
    return json(200, await svc.issueRunToken(c, b));
  });
  r.add(
    'POST',
    '/v1/decide',
    async (ctx) => {
      const c = await device(ctx);
      await limit('l1', c.acc, GATEWAY.l1PerMinute, MIN);
      return json(200, await svc.decide(c, ctx.body));
    },
    { maxBodyBytes: 64 * 1024 },
  );
  r.add(
    'POST',
    '/v1/respond',
    async (ctx) => {
      const c = await device(ctx);
      await limit('l2', c.acc, GATEWAY.l2PerMinute, MIN);
      return json(200, await svc.respond(c, ctx.body));
    },
    { maxBodyBytes: 1024 * 1024 },
  );
  r.add('POST', '/v1/biz/status', async (ctx) => {
    const c = await device(ctx, false);
    const b = V.biz(ctx.body);
    await limit('biz', c.acc, GATEWAY.bizPerMinute, MIN);
    return json(200, await svc.bizStatus(b.b_no));
  });
  // CODEF 접근 토큰(계좌 자동조회, 대표 결정 2026-11-12). 시크릿은 서버에만 있고 PC에는 토큰·만료·환경·공개키만 간다.
  // 계정 식별자도 접근 로그에 남기지 않는다(진위확인과 같다). 토큰은 응답 본문에만 있고 로그·이벤트에 쓰지 않는다.
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
