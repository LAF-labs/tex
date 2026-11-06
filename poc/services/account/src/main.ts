// 기동: 환경 변수(ENV.md) → DB 마이그레이션 → HTTP. 비밀은 KMS가 환경 변수로 주입한다(저장소·이미지에 없음).
import { fileURLToPath } from 'node:url';
import { InternalAuth, InternalClient, Logger, SqlNonceStore, TokenIssuer, TokenVerifier, createServer, ed25519Private, ed25519RawPublic, key32, listen, migrate, openFromEnv, LIMITS_MIGRATIONS_DIR, sqlLimits } from '@sax/svc-shared';
import { MockMailSender, MockPaymentGateway, type DeviceStopHook, type MailSender, type PairingRooms, type PaymentGateway } from './adapters.ts';
import { AcctClaimSigner } from './acct-claim.ts';
import { accountRouter } from './app.ts';
import { AccountService } from './service.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/** 내부 HTTP 정지 알림(룸 호스트 등 다른 호스트의 /internal/v1/devices/:id/stopped, 서명 호출). 같은 배포 안의 서비스는 함수로 부른다(cloud 진입점). */
export function httpStopHook(base: string, key: Buffer, fetchFn: typeof fetch = fetch): DeviceStopHook {
  const c = new InternalClient({ base, key, fetchFn });
  return {
    async stopped(deviceId) {
      await c.request('POST', `/internal/v1/devices/${encodeURIComponent(deviceId)}/stopped`);
    },
  };
}

/** 룸 호스트 내부 API의 페어링 룸 소비(/internal/v1/rooms/:id/redeem, 서명 호출). 200만 성공, 409는 이미 사용, 그 밖(404·401·장애·시간 초과)은 사용 불가로 본다. */
export function httpPairingRooms(base: string, key: Buffer, fetchFn: typeof fetch = fetch, timeoutMs = 5000): PairingRooms {
  const c = new InternalClient({ base, key, fetchFn, timeoutMs });
  return {
    async redeem(roomId, desktopDeviceId) {
      const res = await c.request('POST', `/internal/v1/rooms/${encodeURIComponent(roomId)}/redeem`, { deviceId: desktopDeviceId }).catch(() => null);
      return res?.status === 200 ? 'ok' : res?.status === 409 ? 'used' : 'unavailable';
    },
  };
}

export interface AccountBuildDeps {
  mail?: MailSender;
  payments?: PaymentGateway;
  /** 같은 배포 안 서비스의 정지 처리(함수 직접 호출). STOP_HOOK_URLS(다른 호스트, 서명 HTTP) 앞에 붙는다 */
  stopHooks?: DeviceStopHook[];
}

/** 조립(라우터·서비스·정리). 상시 서버(`startAccount`)와 함수 진입점(`@sax/svc-cloud`)이 같은 것을 쓴다. 함수는 DDL을 하지 않는다(migrate: false, 마이그레이션은 배포 절차). */
export async function buildAccount(env: NodeJS.ProcessEnv = process.env, deps: AccountBuildDeps = {}, o: { migrate: boolean } = { migrate: true }) {
  const db = openFromEnv(env);
  if (o.migrate) {
    await migrate(db, 'account', MIGRATIONS_DIR);
    await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
  }
  const kid = env.TOKEN_KID ?? 'k1';
  const signKey = ed25519Private(key32(env.TOKEN_SIGNING_SEED, 'TOKEN_SIGNING_SEED'));
  // acct_claim 전용 키. 없으면 그 경로가 닫힌다. 기기 토큰 키와 같은 값이면 기동하지 않는다(키를 섞지 않는다)
  if (env.ACCT_CLAIM_SIGNING_KEY !== undefined && env.ACCT_CLAIM_SIGNING_KEY === env.TOKEN_SIGNING_SEED) fail('ACCT_CLAIM_SIGNING_KEY');
  const acctClaims = env.ACCT_CLAIM_SIGNING_KEY !== undefined ? AcctClaimSigner.fromSeedHex(env.ACCT_CLAIM_SIGNING_KEY) : undefined;
  const publicOrigin = env.ACCOUNT_PUBLIC_ORIGIN ?? fail('ACCOUNT_PUBLIC_ORIGIN');
  const internalKey = key32(env.INTERNAL_CALL_KEY, 'INTERNAL_CALL_KEY');
  if (env.INTERNAL_CALL_KEY === env.TOKEN_SIGNING_SEED || env.INTERNAL_CALL_KEY === env.ACCT_CLAIM_SIGNING_KEY) fail('INTERNAL_CALL_KEY');
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
    stopHooks: [...(deps.stopHooks ?? []), ...(env.STOP_HOOK_URLS ?? '').split(',').filter(Boolean).map((u) => httpStopHook(u, internalKey))],
    acctClaims,
    pairing: env.RELAY_INTERNAL_URL ? httpPairingRooms(env.RELAY_INTERNAL_URL, internalKey) : undefined,
  });
  const limits = sqlLimits(db, svc.now, key32(env.LIMIT_ID_KEY, 'LIMIT_ID_KEY'));
  const router = accountRouter({ svc, verifier: new TokenVerifier({ [kid]: ed25519RawPublic(signKey) }), publicOrigin, internal: new InternalAuth({ key: internalKey, nonces: new SqlNonceStore(db), now: svc.now }), limits });
  const sweep = async () => void (await Promise.all([svc.sweep(), limits.limiter.sweep()]));
  return { db, svc, router, sweep };
}

export async function startAccount(env: NodeJS.ProcessEnv = process.env, deps: AccountBuildDeps = {}) {
  const { db, svc, router, sweep } = await buildAccount(env, deps, { migrate: env.MIGRATE_ON_START !== '0' });
  const server = createServer(router, { logger: new Logger('account'), trustProxy: env.TRUST_PROXY === '1' });
  const url = await listen(server, Number(env.PORT ?? 8080), env.HOST ?? '0.0.0.0');
  const timer = setInterval(() => void sweep().catch(() => undefined), 60_000);
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
