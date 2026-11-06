// 실행 탭의 CDP 세션을 엔진이 직접 쓰는 길(M2-4 D, 커밋 가드 R-C1 ②③).
// 금고 중계는 Target.attachToTarget을 열지 않으므로(엔진이 세션을 따로 열 수 없다) Playwright가 auto-attach로 받은
// 그 페이지 세션에 명령을 끼워 넣는다. Playwright와 금고 사이 transport를 감싸:
// - 끼운 명령은 큰 id(TAP_ID_BASE~)를 쓰고 그 응답은 Playwright에 넘기지 않는다.
// - Fetch.* 이벤트는 Playwright에 넘기지 않는다(Playwright가 자기 인터셉트로 알고 이어 보내지 않게, 커밋 가드만 판정).
// - 그 밖의 이벤트는 Playwright와 끼운 세션 구독자 둘 다 받는다.
// 금고 정책(호스트 고정 Fetch 패턴, 막은 요청 이어 보내기 금지)은 그대로 적용된다.
import type { CdpSessionLike } from '../commitguard/cdp.ts';
import type { CdpTransport } from '../vault-client.ts';

type Json = Record<string, unknown>;

export const TAP_ID_BASE = 1_000_000_000;

export class CdpTap {
  /** Playwright에 주는 transport. */
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

  /** 이 타깃의 페이지 세션(auto-attach가 올 때까지 기다린다). */
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
