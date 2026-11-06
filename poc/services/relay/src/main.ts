// 기동: 환경 변수(ENV.md) → DB 마이그레이션 → HTTP + WSS. TLS는 서버 직접 또는 L4/TLS 프록시(D09 §4, 특정 LB 기능에 의존하지 않음).
import { fileURLToPath } from 'node:url';
import { HttpDeviceDirectory, Logger, TokenVerifier, createServer, fromB64, key32, listen, migrate, openFromEnv } from '@sax/svc-shared';
import { RelayHub } from './app.ts';
import { RelayService } from './service.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

function fail(name: string): never {
  throw new Error(`config_${name}`);
}

/** TOKEN_PUBLIC_KEYS = "kid:base64(32B),…" (계정 서비스 기기 범위 토큰 공개키) */
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

export async function startRelay(env: NodeJS.ProcessEnv = process.env) {
  const db = openFromEnv(env);
  await migrate(db, 'relay', MIGRATIONS_DIR);
  const logger = new Logger('relay');
  const svc = new RelayService({ db, queueKey: key32(env.QUEUE_KEY, 'QUEUE_KEY'), now: Date.now, onEvent: (e) => logger.event(e) });
  const internal = env.INTERNAL_TOKEN ?? fail('INTERNAL_TOKEN');
  const hub = new RelayHub({
    svc,
    verifier: new TokenVerifier(parseTokenKeys(env.TOKEN_PUBLIC_KEYS)),
    directory: new HttpDeviceDirectory({ base: env.ACCOUNT_INTERNAL_URL ?? fail('ACCOUNT_INTERNAL_URL'), secret: internal }),
    publicOrigin: env.RELAY_PUBLIC_ORIGIN ?? fail('RELAY_PUBLIC_ORIGIN'),
    internalSecret: internal,
    logger,
    trustProxy: env.TRUST_PROXY === '1',
  });
  const server = createServer(hub.router, { logger, trustProxy: env.TRUST_PROXY === '1' });
  hub.attach(server);
  const url = await listen(server, Number(env.PORT ?? 8083), env.HOST ?? '0.0.0.0');
  const timer = setInterval(() => {
    hub.sweep();
    void svc.sweep().catch(() => undefined);
  }, 60_000);
  timer.unref();
  return { svc, hub, server, url, close: async () => (clearInterval(timer), hub.closeAll(), server.close(), await db.close()) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startRelay().catch((e: Error) => {
    process.stderr.write(`relay start failed: ${e.message}\n`);
    process.exit(1);
  });
}
