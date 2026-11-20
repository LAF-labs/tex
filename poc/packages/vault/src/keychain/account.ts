import { randomBytes } from 'node:crypto';
import type { EventLog } from '@sax/platform';
import { ACCOUNT_REFRESH_TOKEN_RE, type AccountRefreshReadResult, type AccountRefreshWriteResult } from '../protocol.ts';
import { ITEM_MAX_BYTES, open as openSealed, seal, type KeychainBackend } from './backend.ts';
import type { SessionLock } from './session.ts';

const SLOTS = ['a', 'b'] as const;
type Slot = (typeof SLOTS)[number];

export const accountRefreshItem = (s: Slot): string => `account/refresh/${s}`;
export const accountRefreshKekItem = (s: Slot): string => `kek/account/refresh/${s}/device`;

type SlotRead = { gen: number; token: string } | 'missing' | 'corrupt' | 'kek_unavailable';

export interface AccountRefreshStoreOptions {
  backend: KeychainBackend;
  lock: SessionLock;
  ready: () => Promise<void>;
  log: EventLog;
}

export class AccountRefreshStore {
  private readonly b: KeychainBackend;
  private readonly lock: SessionLock;
  private readonly ready: () => Promise<void>;
  private readonly log: EventLog;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(o: AccountRefreshStoreOptions) {
    this.b = o.backend;
    this.lock = o.lock;
    this.ready = o.ready;
    this.log = o.log;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }

  read(): Promise<AccountRefreshReadResult> {
    return this.serial(async () => {
      await this.ready();
      if (!this.lock.check().open) return { ok: false, reason: 'vault_locked' };
      const { best, fails } = await this.current();
      if (!this.lock.check().open) return { ok: false, reason: 'vault_locked' };
      if (best) return { ok: true, token: best.token };
      if (fails.includes('corrupt')) {
        this.log.event('vault.account_refresh_corrupt');
        return { ok: false, reason: 'corrupt' };
      }
      if (fails.includes('kek_unavailable')) return { ok: false, reason: 'kek_unavailable' };
      return { ok: false, reason: 'missing' };
    });
  }

  write(token: string): Promise<AccountRefreshWriteResult> {
    if (typeof token !== 'string' || !ACCOUNT_REFRESH_TOKEN_RE.test(token)) return Promise.reject(new Error('bad_params'));
    return this.serial(async () => {
      await this.ready();
      if (!this.lock.check().open) return { ok: false, reason: 'vault_locked' };
      const { best } = await this.current();
      const target: Slot = best?.slot === 'a' ? 'b' : 'a';
      const other: Slot = target === 'a' ? 'b' : 'a';
      const r = await this.writeSlot(target, (best?.gen ?? 0) + 1, token);
      if (r !== 'ok') {
        await this.deleteSlot(target).catch(() => {});
        this.log.event('vault.account_refresh_write_failed');
        return { ok: false, reason: r };
      }
      await this.deleteSlot(other).catch(() => {});
      this.log.event('vault.account_refresh_stored');
      return { ok: true };
    });
  }

  forget(): Promise<boolean> {
    return this.serial(async () => {
      let removed = false;
      for (const s of SLOTS) if (await this.deleteSlot(s)) removed = true;
      if (removed) this.log.event('vault.account_refresh_forgotten');
      return removed;
    });
  }

  private async current(): Promise<{ best: { slot: Slot; gen: number; token: string } | null; fails: SlotRead[] }> {
    let best: { slot: Slot; gen: number; token: string } | null = null;
    const fails: SlotRead[] = [];
    for (const s of SLOTS) {
      const r = await this.readSlot(s);
      if (typeof r === 'string') {
        if (r !== 'missing') fails.push(r);
        continue;
      }
      if (!best || r.gen > best.gen) best = { slot: s, ...r };
    }
    return { best, fails };
  }

  private async readSlot(s: Slot): Promise<SlotRead> {
    const name = accountRefreshItem(s);
    const blob = await this.b.items.get(name);
    if (!blob) return 'missing';
    const wrapped = await this.b.items.get(accountRefreshKekItem(s));
    if (!wrapped) return 'kek_unavailable';
    let kek: Uint8Array;
    try {
      kek = await this.b.wrapper.unwrap(wrapped, name);
    } catch {
      return 'kek_unavailable';
    }
    let pt: Uint8Array | null = null;
    try {
      pt = openSealed(kek, blob, name);
      const v = JSON.parse(Buffer.from(pt).toString('utf8')) as { v?: unknown; g?: unknown; t?: unknown };
      if (v.v !== 1 || !Number.isSafeInteger(v.g) || (v.g as number) < 1 || typeof v.t !== 'string' || !ACCOUNT_REFRESH_TOKEN_RE.test(v.t)) return 'corrupt';
      return { gen: v.g as number, token: v.t };
    } catch {
      return 'corrupt';
    } finally {
      pt?.fill(0);
      kek.fill(0);
    }
  }

  private async writeSlot(s: Slot, gen: number, token: string): Promise<'ok' | 'kek_unavailable' | 'write_failed'> {
    const name = accountRefreshItem(s);
    const kek = new Uint8Array(randomBytes(32));
    const pt = new TextEncoder().encode(JSON.stringify({ v: 1, g: gen, t: token }));
    try {
      let wrapped: Uint8Array;
      try {
        wrapped = await this.b.wrapper.wrap(kek, name);
      } catch {
        return 'kek_unavailable';
      }
      const blob = seal(kek, pt, name);
      if (blob.length > ITEM_MAX_BYTES) return 'write_failed';
      await this.b.items.set(accountRefreshKekItem(s), wrapped);
      await this.b.items.set(name, blob);
    } catch {
      return 'write_failed';
    } finally {
      kek.fill(0);
      pt.fill(0);
    }
    const back = await this.readSlot(s).catch((): SlotRead => 'corrupt');
    return typeof back !== 'string' && back.gen === gen && back.token === token ? 'ok' : 'write_failed';
  }

  private async deleteSlot(s: Slot): Promise<boolean> {
    const had = await this.b.items.delete(accountRefreshItem(s));
    await this.b.items.delete(accountRefreshKekItem(s));
    return had;
  }
}
