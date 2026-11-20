import type { DeviceListJson } from '@sax/remote';
import type { AccountClient, DeviceAuth } from './remote-ports.ts';

export type IssueLockRequest = { t: 'lock.acquire'; id: number } | { t: 'lock.renew'; id: number } | { t: 'lock.release' };
export type IssueLockCode = 'issue.locked_elsewhere' | 'issue.lock_unavailable' | 'issue.lock_lost';
export type IssueLockResult = { t: 'lock.result'; id: number; ok: true; held: boolean } | { t: 'lock.result'; id: number; ok: false; code: IssueLockCode };

export const ISSUE_LOCK_RENEW_MS = 30_000;
export const ISSUE_LOCK_MAX_HOLD_MS = 20 * 60_000;

const ID_MAX = 2 ** 31;

export interface IssueLockDevice {
  readonly deviceId: string;
  readonly deviceList: DeviceListJson;
  auth: DeviceAuth;
  clearToken(): void;
}

interface IssueLockTimers {
  every(ms: number, fn: () => void): () => void;
}
const systemTimers: IssueLockTimers = {
  every(ms, fn) {
    const t = setInterval(fn, ms);
    t.unref?.();
    return () => clearInterval(t);
  },
};

interface IssueLockHostOptions {
  client: Pick<AccountClient, 'acquireIssueLock' | 'renewIssueLock' | 'releaseIssueLock'> | null;
  device: () => IssueLockDevice | null | Promise<IssueLockDevice | null>;
  log?: (name: string, data: Record<string, string | number | boolean>) => void;
  now?: () => number;
  timers?: IssueLockTimers;
  onBlocked?: (blocked: boolean) => void;
}

export function issueLockNeeded(list: DeviceListJson): boolean {
  return list.entries.filter((e) => e.entry.role === 'desktop').length >= 2;
}

const codeOf = (e: unknown): string | null => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : null;
};

export class IssueLockHost {
  readonly #o: IssueLockHostOptions;
  readonly #now: () => number;
  readonly #timers: IssueLockTimers;
  #lockId: string | null = null;
  #heldAt = 0;
  #stopRenew: (() => void) | null = null;
  #blocked = false;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(o: IssueLockHostOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
    this.#timers = o.timers ?? systemTimers;
  }

  get held(): boolean {
    return this.#lockId !== null;
  }

  handle(raw: unknown): Promise<IssueLockResult | null> {
    const p = this.#chain.then(() => this.#one(raw));
    this.#chain = p.catch(() => {});
    return p;
  }

  release(): Promise<void> {
    const p = this.#chain.then(() => this.#release());
    this.#chain = p.catch(() => {});
    return p;
  }

  async #one(raw: unknown): Promise<IssueLockResult | null> {
    const m = raw as Partial<{ t: unknown; id: unknown }> | null;
    if (!m || typeof m !== 'object') return null;
    if (m.t === 'lock.release') {
      await this.#release();
      return null;
    }
    if (m.t !== 'lock.acquire' && m.t !== 'lock.renew') return null;
    const id = m.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= ID_MAX) return null;
    const r = m.t === 'lock.acquire' ? await this.#acquire() : await this.#renewForCommit();
    this.#o.log?.('main.issue_lock', { op: m.t === 'lock.acquire' ? 'acquire' : 'renew', result: r === true ? 'held' : r === false ? 'not_needed' : r });
    return typeof r === 'boolean' ? { t: 'lock.result', id, ok: true, held: r } : { t: 'lock.result', id, ok: false, code: r };
  }

  async #need(): Promise<{ client: NonNullable<IssueLockHostOptions['client']>; dev: IssueLockDevice } | null | 'unavailable'> {
    const client = this.#o.client;
    if (!client) return null;
    let dev: IssueLockDevice | null;
    try {
      dev = await this.#o.device();
    } catch {
      return 'unavailable';
    }
    if (!dev || !issueLockNeeded(dev.deviceList)) return null;
    return { client, dev };
  }

  async #call<T>(dev: IssueLockDevice, f: (auth: DeviceAuth) => Promise<T>): Promise<T> {
    try {
      return await f(dev.auth);
    } catch (e) {
      if (codeOf(e) !== 'account.unauthorized') throw e;
      dev.clearToken();
      return f(dev.auth);
    }
  }

  async #acquire(): Promise<boolean | IssueLockCode> {
    const n = await this.#need();
    if (n === 'unavailable') return 'issue.lock_unavailable';
    if (!n) {
      await this.#release();
      return false;
    }
    try {
      const r = await this.#call(n.dev, (auth) => n.client.acquireIssueLock(auth));
      this.#lockId = r.lockId;
      this.#heldAt = this.#now();
      this.#setBlocked(false);
      this.#startRenew();
      return true;
    } catch (e) {
      if (codeOf(e) === 'account.issue_locked') {
        this.#forget();
        this.#setBlocked(true);
        return 'issue.locked_elsewhere';
      }
      return 'issue.lock_unavailable';
    }
  }

  async #renewForCommit(): Promise<boolean | IssueLockCode> {
    const n = await this.#need();
    if (n === 'unavailable') return 'issue.lock_unavailable';
    if (!n) return false;
    const lockId = this.#lockId;
    if (!lockId) return 'issue.lock_lost';
    try {
      await this.#call(n.dev, (auth) => n.client.renewIssueLock(auth, lockId));
      return true;
    } catch (e) {
      if (codeOf(e) === 'account.issue_lock_lost') {
        this.#forget();
        return 'issue.lock_lost';
      }
      return 'issue.lock_unavailable';
    }
  }

  #startRenew(): void {
    this.#stopRenew?.();
    this.#stopRenew = this.#timers.every(ISSUE_LOCK_RENEW_MS, () => void this.#tick());
  }

  async #tick(): Promise<void> {
    const lockId = this.#lockId;
    if (!lockId) return;
    if (this.#now() - this.#heldAt > ISSUE_LOCK_MAX_HOLD_MS) {
      this.#stopRenew?.();
      this.#stopRenew = null;
      this.#o.log?.('main.issue_lock', { op: 'hold', result: 'max_hold' });
      return;
    }
    try {
      const n = await this.#need();
      if (!n || n === 'unavailable') return;
      await this.#call(n.dev, (auth) => n.client.renewIssueLock(auth, lockId));
    } catch (e) {
      if (codeOf(e) === 'account.issue_lock_lost' && this.#lockId === lockId) {
        this.#forget();
        this.#o.log?.('main.issue_lock', { op: 'hold', result: 'issue.lock_lost' });
      }
    }
  }

  #forget(): void {
    this.#lockId = null;
    this.#stopRenew?.();
    this.#stopRenew = null;
  }

  #setBlocked(b: boolean): void {
    if (this.#blocked === b) return;
    this.#blocked = b;
    this.#o.onBlocked?.(b);
  }

  async #release(): Promise<void> {
    this.#setBlocked(false);
    const lockId = this.#lockId;
    this.#forget();
    if (!lockId || !this.#o.client) return;
    const client = this.#o.client;
    try {
      const dev = await this.#o.device();
      if (dev) await this.#call(dev, (auth) => client.releaseIssueLock(auth, lockId));
      this.#o.log?.('main.issue_lock', { op: 'release', result: dev ? 'ok' : 'signed_out' });
    } catch {
      this.#o.log?.('main.issue_lock', { op: 'release', result: 'failed' });
    }
  }
}

export function issueLockResponder(handler: () => ((m: unknown) => Promise<IssueLockResult | null>) | null, post: (r: IssueLockResult) => void): (m: unknown) => void {
  return (m) => {
    const req = m as { t?: unknown; id?: unknown } | null;
    const id = (req?.t === 'lock.acquire' || req?.t === 'lock.renew') && typeof req.id === 'number' && Number.isSafeInteger(req.id) ? req.id : null;
    const h = handler();
    const fail = (): void => {
      if (id !== null) post({ t: 'lock.result', id, ok: false, code: 'issue.lock_unavailable' });
    };
    if (!h) return fail();
    h(m).then((r) => void (r && post(r)), fail);
  };
}

export const isIssueLockMessage = (m: unknown): boolean => {
  const t = (m as { t?: unknown } | null)?.t;
  return t === 'lock.acquire' || t === 'lock.renew' || t === 'lock.release';
};
