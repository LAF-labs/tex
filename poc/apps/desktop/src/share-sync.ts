import {
  fromB64, openShareRow, sealShareRow, shareEpoch, SHARE_MAX_EPOCH,
  type DeviceListJson, type ShareBodies, type ShareKind, type ShareRowCore, type ShareVerifyKeys,
} from '@sax/remote';
import type { AccountClient, DeviceAuth, ShareServerRow, ShareVault } from './remote-ports.ts';

export type ShareOutItem = { [K in ShareKind]: { rowId: string; kind: K; at: number; body: ShareBodies[K]; taskId?: string } }[ShareKind];

export interface ShareInRow {
  seq: number;
  row: ShareRowCore;
}

export interface ShareStore {
  pending(limit: number): Promise<ShareOutItem[]>;
  sent(rowId: string, seq: number | null): Promise<void>;
  dropped(rowId: string, reason: string): Promise<void>;
  cursor(): Promise<number>;
  apply(rows: ShareInRow[], cursor: number): Promise<{ parties?: number } | void>;
}

export interface ShareDevice {
  readonly deviceId: string;
  readonly deviceList: DeviceListJson;
  auth: DeviceAuth;
  clearToken(): void;
}

interface ShareSyncOptions {
  client: Pick<AccountClient, 'putShareRow' | 'shareRows'> | null;
  device: () => ShareDevice | null | Promise<ShareDevice | null>;
  vault: () => Promise<ShareVault>;
  store: ShareStore;
  collect?: () => Promise<unknown>;
  refreshDeviceList?: () => Promise<void>;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number | boolean>) => void;
}

type ShareSyncState =
  | 'ok'
  | 'not_needed'
  | 'failed';

interface ShareSyncResult {
  state: ShareSyncState;
  code?: string;
  pulled: number;
  applied: number;
  rejected: Partial<Record<'key' | 'shape' | 'mismatch' | 'signer' | 'signature', number>>;
  pushed: number;
  dropped: number;
  parties: number;
}

const SHARE_PUSH_BATCH = 50;
export const SHARE_PULL_PAGES = 25;

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : 'share.failed';
};

class Keys {
  readonly #vault: ShareVault;
  readonly #byEpoch = new Map<number, Uint8Array>();
  #signPub: Uint8Array | null = null;
  constructor(vault: ShareVault) {
    this.#vault = vault;
  }
  async key(epoch: number): Promise<Uint8Array> {
    const have = this.#byEpoch.get(epoch);
    if (have) return have;
    const r = await this.#vault.key(epoch);
    this.#byEpoch.set(epoch, r.key);
    this.#signPub = r.signPub;
    return r.key;
  }
  async signPub(): Promise<Uint8Array> {
    if (!this.#signPub) await this.key(0);
    return this.#signPub!;
  }
  wipe(): void {
    for (const k of this.#byEpoch.values()) k.fill(0);
    this.#byEpoch.clear();
  }
}

function mobileSignPubs(list: DeviceListJson): (deviceId: string) => Uint8Array | null {
  const m = new Map<string, Uint8Array>();
  for (const e of list.entries) if (e.entry.role === 'mobile') m.set(e.entry.device_id, fromB64(e.entry.Vx));
  return (id) => m.get(id) ?? null;
}

export class ShareSync {
  readonly #o: ShareSyncOptions;
  readonly #now: () => number;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(o: ShareSyncOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  sync(): Promise<ShareSyncResult> {
    const p = this.#chain.then(() => this.#run());
    this.#chain = p.catch(() => {});
    return p;
  }

  async #run(): Promise<ShareSyncResult> {
    const out: ShareSyncResult = { state: 'ok', pulled: 0, applied: 0, rejected: {}, pushed: 0, dropped: 0, parties: 0 };
    const started = this.#now();
    let keys: Keys | null = null;
    try {
      const client = this.#o.client;
      const dev = client ? await this.#o.device() : null;
      if (!client || !dev || dev.deviceList.entries.length < 2) {
        out.state = 'not_needed';
        return out;
      }
      keys = new Keys(await this.#o.vault());
      await this.#pull(client, dev, keys, out);
      await this.#o.collect?.();
      await this.#push(client, dev, keys, out);
    } catch (e) {
      out.state = 'failed';
      out.code = codeOf(e);
    } finally {
      keys?.wipe();
      if (out.state !== 'not_needed') {
        const rejected = Object.values(out.rejected).reduce((a, b) => a + (b ?? 0), 0);
        this.#o.log?.('main.share_sync', { result: out.code ?? out.state, pulled: out.pulled, applied: out.applied, rejected, pushed: out.pushed, dropped: out.dropped, parties: out.parties, ms: this.#now() - started });
      }
    }
    return out;
  }

  async #call<T>(dev: ShareDevice, f: (auth: DeviceAuth) => Promise<T>): Promise<T> {
    try {
      return await f(dev.auth);
    } catch (e) {
      if (codeOf(e) !== 'account.unauthorized') throw e;
      dev.clearToken();
      return f(dev.auth);
    }
  }

  async #refresh(): Promise<boolean> {
    if (!this.#o.refreshDeviceList) return false;
    try {
      await this.#o.refreshDeviceList();
      return true;
    } catch {
      return false;
    }
  }

  async #pull(client: NonNullable<ShareSyncOptions['client']>, dev: ShareDevice, keys: Keys, out: ShareSyncResult): Promise<void> {
    let cursor = await this.#o.store.cursor();
    let refreshed = false;
    for (let page = 0; page < SHARE_PULL_PAGES; page++) {
      const got = await this.#call(dev, (auth) => client.shareRows(auth, cursor));
      if (got.head < cursor) {
        this.#o.log?.('main.share_head_regressed', { behind: cursor - got.head });
        throw Object.assign(new Error('head'), { code: 'share.head_regressed' });
      }
      if (!got.rows.length) return;
      if (!refreshed && got.epoch > shareEpoch(dev.deviceList)) refreshed = await this.#refresh();
      let opened = await this.#open(got.rows, dev, keys);
      if (!refreshed && opened.rejected.signer && (refreshed = await this.#refresh())) opened = await this.#open(got.rows, dev, keys);
      const last = got.rows[got.rows.length - 1]!.seq;
      const done = await this.#o.store.apply(opened.rows, last);
      if (done && Number.isSafeInteger(done.parties) && done.parties! > 0) out.parties += done.parties!;
      cursor = last;
      out.pulled += got.rows.length;
      out.applied += opened.rows.length;
      for (const [k, n] of Object.entries(opened.rejected) as Array<[keyof ShareSyncResult['rejected'], number]>) out.rejected[k] = (out.rejected[k] ?? 0) + n;
      if (!got.more) return;
    }
  }

  async #open(rows: ShareServerRow[], dev: ShareDevice, keys: Keys): Promise<{ rows: ShareInRow[]; rejected: ShareSyncResult['rejected'] }> {
    const verify: ShareVerifyKeys = { sharePub: await keys.signPub(), mobileSignPub: mobileSignPubs(dev.deviceList) };
    const ok: ShareInRow[] = [];
    const rejected: ShareSyncResult['rejected'] = {};
    for (const r of rows) {
      const res = r.epoch > SHARE_MAX_EPOCH ? ({ ok: false, reason: 'shape' } as const) : openShareRow(await keys.key(r.epoch), { rowId: r.rowId, kind: r.kind, epoch: r.epoch, body: r.body }, verify);
      if (res.ok) ok.push({ seq: r.seq, row: res.row });
      else rejected[res.reason] = (rejected[res.reason] ?? 0) + 1;
    }
    return { rows: ok, rejected };
  }

  async #push(client: NonNullable<ShareSyncOptions['client']>, dev: ShareDevice, keys: Keys, out: ShareSyncResult): Promise<void> {
    const items = await this.#o.store.pending(SHARE_PUSH_BATCH);
    if (!items.length) return;
    const vault = await this.#o.vault();
    let refreshed = false;
    for (const item of items) {
      for (;;) {
        const epoch = shareEpoch(dev.deviceList);
        const core = { v: 1, row_id: item.rowId, kind: item.kind, epoch, at: item.at, dev: dev.deviceId, by: 'desktop', body: item.body } as ShareRowCore;
        let wire;
        try {
          wire = await sealShareRow(await keys.key(epoch), core, (msg) => vault.sign(msg));
        } catch (e) {
          if (!(e instanceof Error) || !/^share: (row shape|row too large)$/.test(e.message)) throw e;
          await this.#o.store.dropped(item.rowId, 'shape');
          out.dropped++;
          break;
        }
        try {
          const r = await this.#call(dev, (auth) => client.putShareRow(auth, item.taskId === undefined ? wire : { ...wire, taskId: item.taskId }));
          await this.#o.store.sent(item.rowId, r.seq);
          out.pushed++;
          break;
        } catch (e) {
          const code = codeOf(e);
          if (code === 'account.share_row_conflict') {
            await this.#o.store.sent(item.rowId, null);
            out.pushed++;
            break;
          }
          if (code === 'account.task_not_claimed' || code === 'account.task_closed' || code === 'account.task_not_found') {
            await this.#o.store.dropped(item.rowId, code);
            out.dropped++;
            break;
          }
          if (code === 'account.share_epoch_stale' && !refreshed && (refreshed = await this.#refresh()) && shareEpoch(dev.deviceList) > epoch) continue;
          throw e;
        }
      }
    }
  }
}

type ShareEngineRpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

export function engineShareStore(rpc: ShareEngineRpc): ShareStore {
  const bad = (): never => {
    throw Object.assign(new Error('share store'), { code: 'share.store_failed' });
  };
  return {
    async pending(limit) {
      const r = (await rpc('db.query.share.pending', { limit })) as { rows?: unknown } | null;
      return Array.isArray(r?.rows) ? (r.rows as ShareOutItem[]) : bad();
    },
    async sent(rowId, seq) {
      await rpc('share.sent', { rowId, seq });
    },
    async dropped(rowId, reason) {
      await rpc('share.dropped', { rowId, reason });
    },
    async cursor() {
      const r = (await rpc('db.query.share.cursor')) as { cursor?: unknown } | null;
      return Number.isSafeInteger(r?.cursor) && (r!.cursor as number) >= 0 ? (r!.cursor as number) : bad();
    },
    async apply(rows, cursor) {
      const r = (await rpc('share.apply', { rows, cursor })) as { parties?: { added?: unknown; updated?: unknown; removed?: unknown } } | null;
      const n = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? (v as number) : 0);
      return { parties: n(r?.parties?.added) + n(r?.parties?.updated) + n(r?.parties?.removed) };
    },
  };
}
