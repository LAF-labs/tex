// 기동: 환경 변수(ENV.md) → DB 마이그레이션 → HTTP. 공급사 키·K_sid·캐시 비밀은 KMS가 환경 변수로 주입한다(D09 §3 키 관리).
import { fileURLToPath } from 'node:url';
import { BundleCatalog } from '@sax/model';
import { HttpDeviceDirectory, InternalClient, Logger, TokenVerifier, createServer, ed25519Private, fromB64, key32, listen, migrate, openFromEnv, LIMITS_MIGRATIONS_DIR, sqlLimits, type DeviceDirectory } from '@sax/svc-shared';
import { gatewayRouter } from './app.ts';
import { ZERO_PRICES, type Prices } from './constants.ts';
import { MockNtsSource, OdcloudNtsSource, type BizStatusSource } from './nts.ts';
import { MockProvider, OpenAICompatProvider, OpenRouterProvider, SplitProvider, UpstageSystemOneStub, parseOpenRouterRouting, type ModelProvider } from './providers.ts';
import { GatewayService, type DeviceSuspender } from './service.ts';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

/**
 * 계정 서비스의 내부 자동 정지 API(다른 호스트일 때만 서명 HTTP. 같은 배포 안이면 함수로 부른다). 응답이 늦으면 `timeoutMs`에서 끊고 실패로 본다(다음 위반에서 다시 시도).
 * 200 `{suspended:false}`는 이미 활성이 아닌 기기(정지·폐기됨)라서 더 할 일이 없으므로 성공으로 본다.
 */
export function httpSuspender(base: string, key: Buffer, fetchFn: typeof fetch = fetch, timeoutMs = 5000): DeviceSuspender {
  const c = new InternalClient({ base, key, fetchFn, timeoutMs });
  return {
    async suspend(deviceId) {
      const res = await c.request('POST', `/internal/v1/devices/${encodeURIComponent(deviceId)}/auto-suspend`);
      if (res.status !== 200) throw new Error('suspend_failed');
    },
  };
}

function fail(name: string): never {
  throw new Error(`config_${name}`);
}

/** 진위확인 원천. 서비스 키는 서버 환경 변수 NTS_BIZ_API_KEY로만 읽는다(저장소·로그·메시지 금지). */
export function ntsFromEnv(env: NodeJS.ProcessEnv): BizStatusSource {
  if (env.NTS_PROVIDER === 'mock') return new MockNtsSource();
  if (env.NTS_PROVIDER !== 'odcloud') return fail('NTS_PROVIDER');
  const base = env.NTS_BIZ_API_BASE ?? 'https://api.odcloud.kr/api';
  if (!/^https:\/\/[^/?#]+(\/[^?#]*)?$/.test(base)) fail('NTS_BIZ_API_BASE');
  return new OdcloudNtsSource({ serviceKey: env.NTS_BIZ_API_KEY || fail('NTS_BIZ_API_KEY'), baseUrl: `${base.replace(/\/$/, '')}/nts-businessman/v1` });
}

/** 양의 정수만(NaN·0·음수·소수면 기동 거부). 잘못된 한도가 조용히 한도 없음이 되지 않게 */
export function positiveInt(v: string, name: string): number {
  if (!/^[1-9][0-9]{0,14}$/.test(v)) fail(name);
  return Number(v);
}

/** TOKEN_PUBLIC_KEYS = "kid:base64(32B),kid2:…" (계정 서비스 토큰 키, 회전 중 둘 이상) */
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

function openRouterFromEnv(env: NodeJS.ProcessEnv, onEvent?: (e: string) => void): OpenRouterProvider {
  // ZDR·데이터 수집 거부·공급자 고정이 환경에 정확히 없으면 기동하지 않는다(R14 ①)
  const routing = parseOpenRouterRouting(env);
  if (!routing) fail('OPENROUTER_ROUTING');
  return new OpenRouterProvider({ apiKey: env.OPENROUTER_API_KEY ?? fail('OPENROUTER_API_KEY'), routing, onEvent });
}

export function providerFromEnv(env: NodeJS.ProcessEnv, onEvent?: (e: string) => void): ModelProvider {
  switch (env.GW_PROVIDER) {
    case 'openrouter':
      return openRouterFromEnv(env, onEvent);
    case 'openai+openrouter': {
      // L1 판정은 OpenAI Decisions 직결, 응답은 OpenRouter(팀장 결정 2026-11-05). 키는 서버 환경 변수만.
      const openai = new OpenAICompatProvider({ baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com', apiKey: env.OPENAI_API_KEY ?? fail('OPENAI_API_KEY') });
      return new SplitProvider(openai, openRouterFromEnv(env, onEvent));
    }
    case 'openai-compat':
      return new OpenAICompatProvider({ baseUrl: env.PROVIDER_BASE_URL ?? fail('PROVIDER_BASE_URL'), apiKey: env.PROVIDER_API_KEY ?? fail('PROVIDER_API_KEY') });
    case 'upstage-systemone':
      return new UpstageSystemOneStub();
    case 'mock':
      return new MockProvider();
    default:
      return fail('GW_PROVIDER');
  }
}

export interface GatewayBuildDeps {
  provider?: ModelProvider;
  nts?: BizStatusSource;
  /** 같은 배포 안의 계정 서비스(함수 직접 호출). 없으면 ACCOUNT_INTERNAL_URL로 서명 HTTP */
  directory?: DeviceDirectory;
  suspender?: DeviceSuspender;
}

/** 조립(라우터·서비스·정리). 상시 서버와 함수 진입점(`@sax/svc-cloud`)이 같은 것을 쓴다. 함수는 DDL을 하지 않는다(migrate: false). */
export async function buildGateway(env: NodeJS.ProcessEnv = process.env, deps: GatewayBuildDeps = {}, o: { migrate: boolean } = { migrate: true }) {
  if (env.GW_ALLOW_IMAGES && env.GW_ALLOW_IMAGES !== 'false') fail('GW_ALLOW_IMAGES'); // Phase 1: 이미지 없음(B-18)
  const db = openFromEnv(env);
  if (o.migrate) {
    await migrate(db, 'gateway', MIGRATIONS_DIR);
    await migrate(db, 'limits', LIMITS_MIGRATIONS_DIR);
  }
  const prices: Prices = env.GW_PRICES_JSON ? { ...ZERO_PRICES, ...(JSON.parse(env.GW_PRICES_JSON) as Partial<Prices>) } : ZERO_PRICES;
  // 계정 서비스가 다른 호스트일 때만 서명 HTTP(주입받으면 키·주소가 필요 없다)
  const remote = () => ({ base: env.ACCOUNT_INTERNAL_URL ?? fail('ACCOUNT_INTERNAL_URL'), key: key32(env.INTERNAL_CALL_KEY, 'INTERNAL_CALL_KEY') });
  const nts = deps.nts ?? ntsFromEnv(env);
  const logger = new Logger('gateway');
  const svc = new GatewayService({
    db,
    onEvent: (e) => logger.event(e),
    provider: deps.provider ?? providerFromEnv(env, (e) => logger.event(e)),
    catalog: BundleCatalog.load(),
    runKey: ed25519Private(key32(env.RUN_TOKEN_SEED, 'RUN_TOKEN_SEED')),
    cacheSecret: key32(env.CACHE_KEY_SECRET, 'CACHE_KEY_SECRET'),
    sidKey: key32(env.SAFETY_ID_KEY, 'SAFETY_ID_KEY'),
    tagKey: key32(env.REPLAY_TAG_KEY, 'REPLAY_TAG_KEY'),
    scopeKey: key32(env.RUN_SCOPE_KEY, 'RUN_SCOPE_KEY'),
    models: { decide: env.MODEL_DECIDE ?? fail('MODEL_DECIDE'), respond: env.MODEL_RESPOND ?? fail('MODEL_RESPOND') },
    monthlyTokens: env.GW_MONTHLY_TOKENS === undefined ? undefined : positiveInt(env.GW_MONTHLY_TOKENS, 'GW_MONTHLY_TOKENS'),
    prices,
    nts,
    suspender: deps.suspender ?? httpSuspender(remote().base, remote().key),
    limits: sqlLimits(db, Date.now, key32(env.LIMIT_ID_KEY, 'LIMIT_ID_KEY')),
  });
  const directory = deps.directory ?? new HttpDeviceDirectory(remote());
  const router = gatewayRouter({ svc, verifier: new TokenVerifier(parseTokenKeys(env.TOKEN_PUBLIC_KEYS)), directory, publicOrigin: env.GATEWAY_PUBLIC_ORIGIN ?? fail('GATEWAY_PUBLIC_ORIGIN') });
  return { db, svc, router, logger, sweep: () => svc.sweep() };
}

export async function startGateway(env: NodeJS.ProcessEnv = process.env, deps: GatewayBuildDeps = {}) {
  const { db, svc, router, logger } = await buildGateway(env, deps, { migrate: env.MIGRATE_ON_START !== '0' });
  const server = createServer(router, { logger, trustProxy: env.TRUST_PROXY === '1' });
  const url = await listen(server, Number(env.PORT ?? 8081), env.HOST ?? '0.0.0.0');
  const timer = setInterval(() => void svc.sweep().catch(() => undefined), 60_000);
  timer.unref();
  return { svc, server, url, close: async () => (clearInterval(timer), server.close(), await db.close()) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startGateway().catch((e: Error) => {
    process.stderr.write(`gateway start failed: ${e.message}\n`);
    process.exit(1);
  });
}
