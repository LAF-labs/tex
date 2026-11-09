// 계정 갱신 토큰 보관(ADR-038 (f) 자동 로그인, D05 §2, 팀장 결정 2026-11-09).
// - 사이트 비밀(사람 비밀 슬롯·색인 index/human)과 따로 둔다. secret.list·엄격 모드 전환·사이트 비밀 삭제와 섞이지 않는다.
// - 칸 두 개(a·b)를 번갈아 쓴다. 각 칸은 자기 KEK(32B 무작위, 기기 결박 래핑 kek/account/refresh/<칸>/device)로
//   AES-256-GCM(AAD = 항목 이름)한 {v, g(세대), t(토큰)}이다. 읽을 때는 풀리는 칸 중 세대가 큰 것을 쓴다.
// - 회전 쓰기: 지금 칸이 아닌 쪽에 새 값을 쓰고 되읽어 확인한 뒤에야 옛 칸을 지운다. 중간에 실패하면 옛 칸이 그대로 남고,
//   옛 칸을 지우다 끊기면 두 칸이 남지만 세대가 큰 새 값을 읽는다.
// - 금고가 잠겨 있으면 읽지도 쓰지도 않는다(SessionLock 판정, 사이트 비밀과 같은 잠금). 지우기는 잠겨 있어도 한다.
// - 로그는 이벤트 이름만 남긴다(토큰 값·길이·해시·세대 없음).
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
  /** 엄격 모드 설정을 다 읽을 때까지 기다린다(HumanSecretVault.ready). */
  ready: () => Promise<void>;
  log: EventLog;
}

export class AccountRefreshStore {
  private readonly b: KeychainBackend;
  private readonly lock: SessionLock;
  private readonly ready: () => Promise<void>;
  private readonly log: EventLog;
  /** 읽기·쓰기·지우기를 하나씩(회전 쓰기 사이에 다른 쓰기·지우기가 끼지 않게). */
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
      // 칸을 푸는 사이에 잠겼으면 내주지 않는다.
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

  /** 회전 쓰기. 토큰 모양이 틀리면 Error('bad_params')(값은 오류에 넣지 않는다). */
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
        // 반쯤 쓴 새 칸은 지운다. 옛 칸(other)은 건드리지 않았다.
        await this.deleteSlot(target).catch(() => {});
        this.log.event('vault.account_refresh_write_failed');
        return { ok: false, reason: r };
      }
      // 새 값을 확인한 뒤에야 옛 값을 지운다. 지우다 실패해도 읽기는 세대가 큰 새 값을 고른다.
      await this.deleteSlot(other).catch(() => {});
      this.log.event('vault.account_refresh_stored');
      return { ok: true };
    });
  }

  /** [로그인 상태 유지 끄기]·[모든 기기에서 로그아웃]·서버 거부. 금고가 잠겨 있어도 지운다. */
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
        // 기기 결박 래핑이 안 되면(네이티브 헬퍼 없음) 저장하지 않는다. 약한 등급으로 조용히 내려가지 않는다.
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
    // 되읽어 같은 값이 풀리는지 확인한다(쓰기가 조용히 잘리거나 다른 값이 남은 경우).
    const back = await this.readSlot(s).catch((): SlotRead => 'corrupt');
    return typeof back !== 'string' && back.gen === gen && back.token === token ? 'ok' : 'write_failed';
  }

  /** 칸의 암호문·래핑된 KEK를 지운다. 암호문이 있었으면 true. */
  private async deleteSlot(s: Slot): Promise<boolean> {
    const had = await this.b.items.delete(accountRefreshItem(s));
    await this.b.items.delete(accountRefreshKekItem(s));
    return had;
  }
}
