// 기동: 핀 키(TRUST_ROOT_JSON, 공개키만) → 저장소(REGISTRY_DIR) → HTTP. 서명 키는 이 서비스·이미지·CI 어디에도 없다(ADR-013·028).
import { fileURLToPath } from 'node:url';
import { Logger, createServer, fromB64, listen } from '@sax/svc-shared';
import { registryRouter } from './app.ts';
import { DirStore, MemoryStore, type Store } from './store.ts';
import type { Role, TrustRoot } from './verify.ts';

const ROLES: readonly Role[] = ['root', 'package', 'policy', 'timestamp', 'emergency', 'release'];
const NEED: Record<Role, number> = { root: 3, package: 3, policy: 3, timestamp: 1, emergency: 1, release: 1 };

function fail(name: string): never {
  throw new Error(`config_${name}`);
}

/** {"keyEpoch":1,"keys":{"root":{"<keyId>":"<base64 32B>",…},…}}. 역할마다 정해진 개수(루트·패키지·정책 3, 나머지 1), 역할 사이 키 재사용 금지. */
export function parseTrustRoot(v: string | undefined): TrustRoot {
  let t: TrustRoot;
  try {
    t = JSON.parse(v ?? '') as TrustRoot;
  } catch {
    return fail('TRUST_ROOT_JSON');
  }
  if (!Number.isSafeInteger(t?.keyEpoch) || t.keyEpoch < 1 || !t.keys) fail('TRUST_ROOT_JSON');
  const seen = new Set<string>();
  for (const role of ROLES) {
    const ks = t.keys[role] ?? {};
    if (Object.keys(ks).length !== NEED[role]) fail('TRUST_ROOT_JSON');
    for (const [id, pub] of Object.entries(ks)) {
      if (!fromB64(pub, 32) || seen.has(pub) || seen.has(`id:${id}`)) fail('TRUST_ROOT_JSON');
      seen.add(pub);
      seen.add(`id:${id}`);
    }
  }
  return t;
}

export async function startRegistry(env: NodeJS.ProcessEnv = process.env, deps: { store?: Store } = {}) {
  const store = deps.store ?? (env.REGISTRY_DIR ? new DirStore(env.REGISTRY_DIR) : env.REGISTRY_STORE === 'memory' ? new MemoryStore() : fail('REGISTRY_DIR'));
  const logger = new Logger('registry');
  const router = registryRouter({ store, trust: parseTrustRoot(env.TRUST_ROOT_JSON), adminToken: env.REGISTRY_ADMIN_TOKEN ?? fail('REGISTRY_ADMIN_TOKEN'), now: Date.now, onEvent: (e) => logger.event(e) });
  const server = createServer(router, { logger, trustProxy: env.TRUST_PROXY === '1' });
  const url = await listen(server, Number(env.PORT ?? 8082), env.HOST ?? '0.0.0.0');
  return { server, url, close: () => server.close() };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  startRegistry().catch((e: Error) => {
    process.stderr.write(`registry start failed: ${e.message}\n`);
    process.exit(1);
  });
}
