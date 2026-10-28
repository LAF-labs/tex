import type { PortLike } from '@sax/platform';

type Json = Record<string, unknown>;

/** Playwright 서버 쪽 ConnectionTransport 모양(1.64 connectOverCDP(transport) 오버로드). */
export interface CdpTransport {
  send(message: Json): void;
  close(): void;
  onmessage?: (message: Json) => void;
  onclose?: (reason?: string) => void;
}

/**
 * 엔진이 쓰는 금고 포트. 엔진은 금고 중계 CDP와 RPC만 쓴다.
 * 엔진은 CDP 엔드포인트·프로필 경로·기동 인자를 지정할 수 없다(launch 인자 없음).
 */
export class VaultClient {
  private readonly port: PortLike;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Map<string, Set<(data: Json) => void>>();
  private transport: CdpTransport | null = null;

  constructor(port: PortLike) {
    this.port = port;
    port.onMessage((raw) => {
      const msg = raw as { t: string; id?: number; result?: unknown; error?: string; m?: string; name?: string; data?: Json };
      if (msg.t === 'cdp' && typeof msg.m === 'string') {
        this.transport?.onmessage?.(JSON.parse(msg.m) as Json);
      } else if (msg.t === 'rpc' && typeof msg.id === 'number') {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!p) return;
        if (msg.error) p.reject(new Error(`vault: ${msg.error}`));
        else p.resolve(msg.result);
      } else if (msg.t === 'ev' && msg.name) {
        for (const fn of this.listeners.get(msg.name) ?? []) fn(msg.data ?? {});
      }
    });
  }

  rpc<T>(method: string, params: Json = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.port.postMessage({ t: 'rpc', id, method, params });
    });
  }

  on(name: string, fn: (data: Json) => void): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  /** 다음 이벤트 한 건(조건 일치)을 기다린다. */
  once(name: string, pred: (d: Json) => boolean = () => true, timeoutMs = 120_000): Promise<Json> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timeout waiting ${name}`));
      }, timeoutMs);
      const off = this.on(name, (d) => {
        if (!pred(d)) return;
        clearTimeout(timer);
        off();
        resolve(d);
      });
    });
  }

  cdpTransport(): CdpTransport {
    const t: CdpTransport = {
      send: (message) => this.port.postMessage({ t: 'cdp', m: JSON.stringify(message) }),
      close: () => {
        this.transport = null;
        t.onclose?.('closed');
      },
    };
    this.transport = t;
    return t;
  }
}
