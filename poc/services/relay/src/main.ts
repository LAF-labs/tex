// 기동: 환경 변수(ENV.md) → DB 마이그레이션 → HTTP + WSS. TLS는 서버 직접 또는 L4/TLS 프록시(D09 §4, 특정 LB 기능에 의존하지 않음).
import { fileURLToPath } from 'node:url';
import { HttpDeviceDirectory, Logger, TokenVerifier, createServer, fromB64, key32, listen, migrate, openFromEnv, LIMITS_MIGRATIONS_DIR, sqlLimits } from '@sax/svc-shared';
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

/**
 * 조립. 상시 서버(룸 호스트)와 함수 진입점(`vercel.ts`, HTTPS 큐만)이 같은 것을 쓴다.
 * 페어링 룸(`RELAY_ROOMS=1`, "룸 켬")과 우편함 라이브 WSS(`RELAY_LIVE=1`)는 켤 때만 연다(Phase 1 기본 꺼짐, 팀장 결정 2026-11-05·11-06).
 */
export async function buildRelay(env: NodeJS.ProcessEnv = process.env, o: { migrate: boolean; stateful: boolean } = { migrate: true, stateful: true }) {
  const db = openFromEnv(env);
  if (o.migrate) {
    await migrate(db, 'relay', MIGRATIONS_DIR);
    await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
  }
  for (const k of ['RELAY_ROOMS', 'RELAY_LIVE'] as const) if (env[k] !== undefined && env[k] !== '0' && env[k] !== '1') fail(k);
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
    limits: sqlLimits(db, Date.now, key32(env.LIMIT_ID_KEY, 'LIMIT_ID_KEY')),
    // 함수 인스턴스는 메모리 룸·연결을 이어 갈 수 없어 늘 끈다
    rooms: o.stateful && env.RELAY_ROOMS === '1',
    live: o.stateful && env.RELAY_LIVE === '1',
  });
  return { db, svc, hub, logger, sweep: async () => void (await Promise.all([hub.sweep(), svc.sweep()])) };
}

export async function startRelay(env: NodeJS.ProcessEnv = process.env) {
  const { db, svc, hub, logger } = await buildRelay(env, { migrate: env.MIGRATE_ON_START !== '0', stateful: true });
  const server = createServer(hub.router, { logger, trustProxy: env.TRUST_PROXY === '1' });
  hub.attach(server);
  const url = await listen(server, Number(env.PORT ?? 8083), env.HOST ?? '0.0.0.0');
  const timer = setInterval(() => {
    void Promise.all([hub.sweep(), svc.sweep()]).catch(() => undefined);
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
