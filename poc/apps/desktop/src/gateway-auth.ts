import { GATEWAY_ORIGIN, GATEWAY_PATHS } from '@sax/net';

export type GwAuthRequest = { t: 'gw.auth'; id: number; htm: string; htu: string } | { t: 'gw.auth.invalidate' };

export type GwAuthCode = 'auth.denied' | 'auth.bad_request' | 'account.signed_out' | 'account.scope_unavailable' | 'auth.unavailable' | 'consent.model_declined';

export type GwAuthResult = { t: 'gw.auth.result'; id: number; headers: { authorization: string; dpop: string } } | { t: 'gw.auth.result'; id: number; code: GwAuthCode };

export interface GatewayDevice {
  gatewayAuth(htm: 'POST', htu: string): Promise<Record<string, string>>;
  clearGatewayToken(): void;
}

interface GatewayAuthHostOptions {
  device: () => GatewayDevice | null | Promise<GatewayDevice | null>;
  log?: (name: string, data: Record<string, string | number>) => void;
  now?: () => number;
  onIssued?: (path: string) => void;
  modelAllowed?: () => boolean;
}

export const GATEWAY_AUTH_HTU: ReadonlySet<string> = new Set(Object.values(GATEWAY_PATHS).map((p) => GATEWAY_ORIGIN + p));

export const GW_INVALIDATE_PER_MIN = 6;

const SIGNED_OUT = new Set(['account.keys_unavailable', 'account.cert_invalid']);

const ID_MAX = 2 ** 31;

export function authPortResponder(handler: () => ((m: unknown) => Promise<GwAuthResult | null>) | null, post: (r: GwAuthResult) => void): (m: unknown) => Promise<void> {
  let q: Promise<void> = Promise.resolve();
  const one = async (m: unknown): Promise<void> => {
    const req = m as { t?: unknown; id?: unknown } | null;
    const id = req?.t === 'gw.auth' && typeof req.id === 'number' && Number.isSafeInteger(req.id) ? req.id : null;
    const h = handler();
    let r: GwAuthResult | null;
    try {
      r = h ? await h(m) : id === null ? null : { t: 'gw.auth.result', id, code: 'account.signed_out' };
    } catch {
      r = id === null ? null : { t: 'gw.auth.result', id, code: 'auth.unavailable' };
    }
    if (r) post(r);
  };
  return (m) => (q = q.then(() => one(m)).catch(() => {}));
}

export class GatewayAuthHost {
  readonly #o: GatewayAuthHostOptions;
  readonly #now: () => number;
  #invalidations: number[] = [];

  constructor(o: GatewayAuthHostOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  async handle(raw: unknown): Promise<GwAuthResult | null> {
    const m = raw as Partial<{ t: unknown; id: unknown; htm: unknown; htu: unknown }> | null;
    if (!m || typeof m !== 'object') return null;
    if (m.t === 'gw.auth.invalidate') {
      await this.#invalidate();
      return null;
    }
    if (m.t !== 'gw.auth') return null;
    const id = m.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= ID_MAX) return null;
    if (typeof m.htm !== 'string' || typeof m.htu !== 'string') return this.#fail(id, 'auth.bad_request');
    if (m.htm !== 'POST' || !GATEWAY_AUTH_HTU.has(m.htu)) return this.#fail(id, 'auth.denied');
    if (this.#o.modelAllowed && !this.#o.modelAllowed()) return this.#fail(id, 'consent.model_declined');
    let device: GatewayDevice | null;
    try {
      device = await this.#o.device();
    } catch {
      device = null;
    }
    if (!device) return this.#fail(id, 'account.signed_out');
    try {
      const h = await device.gatewayAuth('POST', m.htu);
      const authorization = h.Authorization;
      const dpop = h.DPoP;
      if (typeof authorization !== 'string' || typeof dpop !== 'string') return this.#fail(id, 'auth.unavailable');
      this.#o.onIssued?.(m.htu.slice(GATEWAY_ORIGIN.length));
      return { t: 'gw.auth.result', id, headers: { authorization, dpop } };
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      if (code === 'account.scope_unavailable') return this.#fail(id, 'account.scope_unavailable');
      return this.#fail(id, typeof code === 'string' && SIGNED_OUT.has(code) ? 'account.signed_out' : 'auth.unavailable');
    }
  }

  async #invalidate(): Promise<void> {
    const now = this.#now();
    this.#invalidations = this.#invalidations.filter((t) => now - t < 60_000);
    if (this.#invalidations.length >= GW_INVALIDATE_PER_MIN) {
      this.#o.log?.('main.gw_auth_invalidate', { result: 'limited' });
      return;
    }
    this.#invalidations.push(now);
    (await Promise.resolve(this.#o.device()).catch(() => null))?.clearGatewayToken();
    this.#o.log?.('main.gw_auth_invalidate', { result: 'ok' });
  }

  #fail(id: number, code: GwAuthCode): GwAuthResult {
    this.#o.log?.('main.gw_auth', { result: code });
    return { t: 'gw.auth.result', id, code };
  }
}
