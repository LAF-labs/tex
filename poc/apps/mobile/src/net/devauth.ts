// 기기 범위 토큰(계정 서비스 POST /v1/device-tokens, 15분)과 DPoP(Vm, SAX-dpop-v1). 릴레이 우편함 라이브 연결에 쓴다
// (services/relay/API.md "인증 두 겹"). 토큰은 메모리에만 두고 잠그면 버린다. Vm 사본은 서명할 때만 만들고 바로 지운다.
import { DeviceTokenCache, VM_PURPOSES, deviceAuthHeaders, requestDeviceToken, softSigner, type DpopSigner, type HttpJson, type SignedCert } from '@sax/remote';
import { accountOrigin } from './account';

const fetchJson: HttpJson = async (r) => {
  const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
};

async function withVm<T>(vm: Uint8Array, f: (k: DpopSigner) => Promise<T>): Promise<T> {
  const k = softSigner(vm, VM_PURPOSES);
  try {
    return await f(k);
  } finally {
    k.destroy();
  }
}

let cache: { pairId: string; c: DeviceTokenCache } | null = null;

/** 잠글 때·연결 해제 때 부른다. */
export function clearDeviceToken(): void {
  cache?.c.clear();
  cache = null;
}

/** ws-link의 deviceAuth. 토큰이 없거나 만료 1분 전이면 새로 받는다. */
export function deviceAuthFor(pairId: string, cert: SignedCert, vm: Uint8Array): (htm: 'GET', htu: string) => Promise<Record<string, string>> {
  if (!cache || cache.pairId !== pairId) {
    cache = { pairId, c: new DeviceTokenCache(() => withVm(vm, (k) => requestDeviceToken(fetchJson, accountOrigin(), cert, k))) };
  }
  const c = cache.c;
  return async (htm, htu) => {
    const token = await c.token();
    return withVm(vm, (k) => deviceAuthHeaders(token, k, htm, htu));
  };
}
