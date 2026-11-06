// 기동: 환경 변수(ENV.md) → DB 마이그레이션 → HTTP. 비밀은 KMS가 환경 변수로 주입한다(저장소·이미지에 없음).
import { fileURLToPath } from 'node:url';
import { Logger, TokenIssuer, TokenVerifier, createServer, ed25519Private, ed25519RawPublic, key32, listen, migrate, openFromEnv, LIMITS_MIGRATIONS_DIR, sqlLimits } from '@sax/svc-shared';
import { MockMailSender, MockPaymentGateway, type DeviceStopHook, type MailSender, type PaymentGateway } from './adapters.ts';
import { accountRouter } from './app.ts';
import { AccountService } from './service.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** 내부 HTTP 정지 알림(릴레이·푸시 서비스의 /internal/v1/devices/:id/stopped). */
export function httpStopHook(base: string, secret: string, fetchFn: typeof fetch = fetch): DeviceStopHook {
  return {
    async stopped(deviceId) {
      await fetchFn(`${base}/internal/v1/devices/${encodeURIComponent(deviceId)}/stopped`, { method: 'POST', headers: { authorization: `Internal ${secret}` }, redirect: 'error' });
    },
  };
}

export async function startAccount(env: NodeJS.ProcessEnv = process.env, deps: { mail?: MailSender; payments?: PaymentGateway } = {}) {
  const db = openFromEnv(env);
  await migrate(db, 'account', MIGRATIONS_DIR);
  await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
  const kid = env.TOKEN_KID ?? 'k1';
  const signKey = ed25519Private(key32(env.TOKEN_SIGNING_SEED, 'TOKEN_SIGNING_SEED'));
  const publicOrigin = env.ACCOUNT_PUBLIC_ORIGIN ?? fail('ACCOUNT_PUBLIC_ORIGIN');
  if (env.PG_PROVIDER !== 'mock' || env.MAIL_PROVIDER !== 'mock') {
    if (!deps.mail || !deps.payments) throw new Error('config_provider: 이 저장소에는 모의 어댑터만 있다(PG_PROVIDER=mock, MAIL_PROVIDER=mock)');
  }
  const svc = new AccountService({
    db,
    mail: deps.mail ?? new MockMailSender(),
    payments: deps.payments ?? new MockPaymentGateway(env.MOCK_PG_SECRET),
    tokens: new TokenIssuer(kid, signKey),
    codeMacKey: key32(env.CODE_MAC_KEY, 'CODE_MAC_KEY'),
    rp: { rpId: env.WEBAUTHN_RP_ID ?? fail('WEBAUTHN_RP_ID'), origins: (env.WEBAUTHN_ORIGINS ?? fail('WEBAUTHN_ORIGINS')).split(',') },
    publicOrigin,
    billingReturnUrl: env.BILLING_RETURN_URL ?? fail('BILLING_RETURN_URL'),
    stopHooks: (env.STOP_HOOK_URLS ?? '').split(',').filter(Boolean).map((u) => httpStopHook(u, env.INTERNAL_TOKEN ?? '')),
  });
  const limits = sqlLimits(db, svc.now, key32(env.LIMIT_ID_KEY, 'LIMIT_ID_KEY'));
  const router = accountRouter({ svc, verifier: new TokenVerifier({ [kid]: ed25519RawPublic(signKey) }), publicOrigin, internalSecret: env.INTERNAL_TOKEN ?? fail('INTERNAL_TOKEN'), limits });
  const server = createServer(router, { logger: new Logger('account'), trustProxy: env.TRUST_PROXY === '1' });
  const url = await listen(server, Number(env.PORT ?? 8080), env.HOST ?? '0.0.0.0');
  const timer = setInterval(() => void Promise.all([svc.sweep(), limits.limiter.sweep()]).catch(() => undefined), 60_000);
  timer.unref();
  return { svc, server, url, close: async () => (clearInterval(timer), server.close(), await db.close()) };
}

function fail(name: string): never {
  throw new Error(`config_${name}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startAccount().catch((e: Error) => {
    process.stderr.write(`account start failed: ${e.message}\n`);
    process.exit(1);
  });
}
