import type { PortLike } from '@sax/platform';
import type { ActResult } from './core/page.ts';

const ISSUE_LOCK_TIMEOUT_MS = 20_000;
/** 다른 PC가 잡고 있을 때 다시 잡아 보는 간격과 상한(ADR-048 결정 7: 10분까지 스스로 다시 잡아 본다). */
export const ISSUE_LOCK_RETRY_MS = 5_000;
export const ISSUE_LOCK_WAIT_MS = 600_000;

/** 다른 PC가 발급 중이다(끝나면 이어서 한다). */
export const ISSUE_LOCKED_ELSEWHERE = 'issue.locked_elsewhere';
const ISSUE_LOCK_UNAVAILABLE = 'issue.lock_unavailable';
/** 커밋 직전에 잠금이 없다(만료됐거나 다른 PC로 넘어갔다). 누르지 않았다. */
export const ISSUE_LOCK_LOST = 'issue.lock_lost';
const CODES: ReadonlySet<string> = new Set([ISSUE_LOCKED_ELSEWHERE, ISSUE_LOCK_UNAVAILABLE, ISSUE_LOCK_LOST]);

const ID_MAX = 2 ** 31 - 1;

export interface IssueLockPort {
  acquire(): Promise<ActResult>;
  renew(): Promise<ActResult>;
  release(): void;
  close(): void;
}

export function portIssueLock(port: PortLike, o: { timeoutMs?: number } = {}): IssueLockPort {
  const timeoutMs = o.timeoutMs ?? ISSUE_LOCK_TIMEOUT_MS;
  const pending = new Map<number, { done: (r: ActResult) => void; timer: ReturnType<typeof setTimeout> }>();
  let next = 1;
  let closed = false;
  const unavailable: ActResult = { ok: false, code: ISSUE_LOCK_UNAVAILABLE };
  port.onMessage((raw) => {
    const m = raw as { t?: unknown; id?: unknown; ok?: unknown; held?: unknown; code?: unknown } | null;
    if (!m || typeof m !== 'object' || m.t !== 'lock.result' || typeof m.id !== 'number') return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok === true && typeof m.held === 'boolean') p.done({ ok: true });
    else if (m.ok === false && typeof m.code === 'string' && CODES.has(m.code)) p.done({ ok: false, code: m.code });
    else p.done(unavailable);
  });
  const ask = (t: 'lock.acquire' | 'lock.renew'): Promise<ActResult> => {
    if (closed) return Promise.resolve(unavailable);
    const id = next;
    next = next >= ID_MAX ? 1 : next + 1;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        resolve(unavailable);
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { done: resolve, timer });
      port.postMessage({ t, id });
    });
  };
  return {
    acquire: () => ask('lock.acquire'),
    renew: () => ask('lock.renew'),
    release() {
      if (!closed) port.postMessage({ t: 'lock.release' });
    },
    close() {
      closed = true;
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.done(unavailable);
      }
      pending.clear();
    },
  };
}
