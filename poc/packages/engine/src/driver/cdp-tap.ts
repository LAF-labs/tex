import type { CdpSessionLike } from '../commitguard/cdp.ts';
import type { CdpTransport } from '../vault-client.ts';

type Json = Record<string, unknown>;

export const TAP_ID_BASE = 1_000_000_000;

export class CdpTap {
  readonly transport: CdpTransport;
  private readonly inner: CdpTransport;
  private nextId = TAP_ID_BASE;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly sessions = new Map<string, string>();
  private readonly waiters = new Map<string, Array<(sid: string) => void>>();
  private readonly listeners = new Map<string, Map<string, Set<(p: Json) => void>>>();
  private closed: string | null = null;

  constructor(inner: CdpTransport) {
    this.inner = inner;
    const outer: CdpTransport = {
      send: (m) => inner.send(m),
      close: () => inner.close(),
    };
    this.transport = outer;
    inner.onmessage = (m) => this.onInner(m, outer);
    inner.onclose = (reason) => {
      this.closed = reason ?? 'closed';
      for (const p of this.pending.values()) p.reject(new Error(`cdp closed: ${this.closed}`));
      this.pending.clear();
      outer.onclose?.(reason);
    };
  }

  session(targetId: string, timeoutMs = 10_000): Promise<CdpSessionLike> {
    const sid = this.sessions.get(targetId);
    if (sid) return Promise.resolve(this.make(sid));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('page session not attached')), timeoutMs);
      const list = this.waiters.get(targetId) ?? [];
      list.push((s) => {
        clearTimeout(timer);
        resolve(this.make(s));
      });
      this.waiters.set(targetId, list);
    });
  }

  private make(sessionId: string): CdpSessionLike {
    const subs = () => {
      let m = this.listeners.get(sessionId);
      if (!m) this.listeners.set(sessionId, (m = new Map()));
      return m;
    };
    return {
      send: (method, params = {}) => {
        if (this.closed) return Promise.reject(new Error(`cdp closed: ${this.closed}`));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
          this.pending.set(id, { resolve, reject });
          this.inner.send({ id, method, params, sessionId });
        });
      },
      on: (event, fn) => {
        const m = subs();
        if (!m.has(event)) m.set(event, new Set());
        m.get(event)!.add(fn);
      },
      off: (event, fn) => void subs().get(event)?.delete(fn),
    };
  }

  private onInner(m: Json, outer: CdpTransport): void {
    if (typeof m.id === 'number' && m.id >= TAP_ID_BASE) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      if (!p) return;
      const err = m.error as { message?: string } | undefined;
      if (err) p.reject(new Error(String(err.message ?? 'cdp error')));
      else p.resolve(m.result ?? {});
      return;
    }
    const method = typeof m.method === 'string' ? m.method : '';
    const params = (m.params ?? {}) as Json;
    if (method === 'Target.attachedToTarget' && m.sessionId === undefined) {
      const info = (params.targetInfo ?? {}) as Json;
      const sid = String(params.sessionId ?? '');
      if (info.type === 'page' && sid) {
        const tid = String(info.targetId ?? '');
        this.sessions.set(tid, sid);
        for (const w of this.waiters.get(tid)?.splice(0) ?? []) w(sid);
      }
    } else if (method === 'Target.detachedFromTarget' && m.sessionId === undefined) {
      const sid = String(params.sessionId ?? '');
      for (const [t, s] of this.sessions) if (s === sid) this.sessions.delete(t);
      this.listeners.delete(sid);
    }
    if (method && typeof m.sessionId === 'string') {
      const fns = this.listeners.get(m.sessionId)?.get(method);
      if (fns) for (const fn of [...fns]) fn(params);
      if (method.startsWith('Fetch.')) return;
    }
    outer.onmessage?.(m);
  }
}
