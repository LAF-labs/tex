// 기동: 환경 변수(ENV.md) → DB 마이그레이션 → HTTP. 공급사 자격 증명은 KMS가 주입하고 저장소·이미지에 두지 않는다(절대 규칙 ⑥).
import { fileURLToPath } from 'node:url';
import { HttpDeviceDirectory, Logger, TokenVerifier, createServer, fromB64, key32, listen, migrate, openFromEnv, LIMITS_MIGRATIONS_DIR, sqlLimits } from '@sax/svc-shared';
import { pushRouter } from './app.ts';
import { ApnsSender, FcmSender, MockPushSender, RoutingSender, type PushSender } from './senders.ts';
import { PushService } from './service.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

function fail(name: string): never {
  throw new Error(`config_${name}`);
}

export function parseTokenKeys(v: string | undefined): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const part of (v ?? '').split(',').filter(Boolean)) {
    const [kid, b64] = part.split(':');
    const raw = fromB64(b64, 32);
    if (!kid || !raw) fail('TOKEN_PUBLIC_KEYS');
    out[kid] = raw;
  }
  if (!Object.keys(out).length) fail('TOKEN_PUBLIC_KEYS');
  return out;
}

/** PUSH_PROVIDER=mock(기본·Phase 1) | sandbox(APNs 샌드박스 + FCM, 자격 증명 주입 필요) */
export function senderFromEnv(env: NodeJS.ProcessEnv): PushSender {
  if ((env.PUSH_PROVIDER ?? 'mock') === 'mock') return new MockPushSender();
  if (env.PUSH_PROVIDER !== 'sandbox') return fail('PUSH_PROVIDER');
  if (env.APNS_ORIGIN && env.APNS_ORIGIN !== 'https://api.sandbox.push.apple.com') fail('APNS_ORIGIN'); // Phase 1: 운영 APNs 금지
  return new RoutingSender({
    apns: new ApnsSender({ teamId: env.APNS_TEAM_ID ?? fail('APNS_TEAM_ID'), keyId: env.APNS_KEY_ID ?? fail('APNS_KEY_ID'), p8: env.APNS_P8 ?? fail('APNS_P8'), topic: env.APNS_TOPIC ?? fail('APNS_TOPIC') }),
    fcm: new FcmSender({ projectId: env.FCM_PROJECT_ID ?? fail('FCM_PROJECT_ID'), serviceAccountJson: env.FCM_SERVICE_ACCOUNT_JSON ?? fail('FCM_SERVICE_ACCOUNT_JSON') }),
  });
}

export async function startPush(env: NodeJS.ProcessEnv = process.env, deps: { sender?: PushSender } = {}) {
  const db = openFromEnv(env);
  await migrate(db, 'push', MIGRATIONS_DIR);
  await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
  const logger = new Logger('push');
  const svc = new PushService({ db, tokenKey: key32(env.PUSH_TOKEN_KEY, 'PUSH_TOKEN_KEY'), sender: deps.sender ?? senderFromEnv(env), now: Date.now, onEvent: (e) => logger.event(e) });
  const internal = env.INTERNAL_TOKEN ?? fail('INTERNAL_TOKEN');
  const limits = sqlLimits(db, Date.now, key32(env.LIMIT_ID_KEY, 'LIMIT_ID_KEY'));
  const router = pushRouter({
    svc,
    verifier: new TokenVerifier(parseTokenKeys(env.TOKEN_PUBLIC_KEYS)),
    directory: new HttpDeviceDirectory({ base: env.ACCOUNT_INTERNAL_URL ?? fail('ACCOUNT_INTERNAL_URL'), secret: internal }),
    publicOrigin: env.PUSH_PUBLIC_ORIGIN ?? fail('PUSH_PUBLIC_ORIGIN'),
    internalSecret: internal,
    limits,
  });
  const server = createServer(router, { logger, trustProxy: env.TRUST_PROXY === '1' });
  const url = await listen(server, Number(env.PORT ?? 8084), env.HOST ?? '0.0.0.0');
  const timer = setInterval(() => void limits.limiter.sweep().catch(() => undefined), 60_000);
  timer.unref();
  return { svc, server, url, close: async () => (clearInterval(timer), server.close(), await db.close()) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startPush().catch((e: Error) => {
    process.stderr.write(`push start failed: ${e.message}\n`);
    process.exit(1);
  });
}
