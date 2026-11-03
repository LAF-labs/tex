// 금고 런타임 송신 모듈 차단(N-32). entry.ts가 맨 먼저 불러온다.
// 정적 import는 링크 단계에서 이미 풀리므로 이 훅은 동적 로드(import()·require) 방어다. 1차 방어는 린트다.
// child_process는 Chrome 기동에 필요해 허용한다(Node 내부 모듈끼리의 require는 훅을 지나지 않는다).
import module from 'node:module';

const DENIED = new Set(['net', 'http', 'https', 'tls', 'dgram', 'dns', 'http2', 'electron']);

export function netDenied(specifier: string): boolean {
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  return DENIED.has(bare.split('/')[0]!);
}

type ResolveHook = (specifier: string, context: unknown, next: (specifier: string, context: unknown) => unknown) => unknown;
const registerHooks = (module as unknown as { registerHooks?: (hooks: { resolve: ResolveHook }) => unknown }).registerHooks;

/** 훅을 걸었으면 true. 이 Node에 registerHooks가 없으면 false(entry.ts가 vault.net_deny_unavailable을 남긴다). */
export const netDenyInstalled: boolean = (() => {
  if (typeof registerHooks !== 'function') return false;
  registerHooks({
    resolve(specifier, context, next) {
      if (netDenied(specifier)) throw Object.assign(new Error(`module denied in vault: ${specifier}`), { code: 'ERR_SAX_NET_DENIED' });
      return next(specifier, context);
    },
  });
  return true;
})();
