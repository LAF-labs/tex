import module from 'node:module';

const DENIED = new Set(['net', 'http', 'https', 'tls', 'dgram', 'dns', 'http2', 'electron']);

function netDenied(specifier: string): boolean {
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
