import type { VaultClient } from '@sax/engine';

type Json = Record<string, unknown>;

export interface RawMsg {
  id?: number;
  method?: string;
  params?: Json;
  result?: Json;
  error?: { message: string };
  sessionId?: string;
}

/** Playwright 없이 금고 중계를 직접 쓰는 "엔진"(침해된 엔진·측정용). */
export class RawEngine {
  private readonly transport;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Json) => void; reject: (e: Error) => void }>();
  readonly events: RawMsg[] = [];

  constructor(client: VaultClient) {
    this.transport = client.cdpTransport();
    this.transport.onmessage = (m) => {
      const msg = m as RawMsg;
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p?.reject(new Error(msg.error.message));
        else p?.resolve(msg.result ?? {});
      } else {
        this.events.push(msg);
      }
    };
  }

  send<T = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    const msg: RawMsg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: Json) => void, reject });
      this.transport.send(msg as Json);
    });
  }

  async tryCall(method: string, params: Json = {}, sessionId?: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.send(method, params, sessionId);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  /** 루트 자동 부착 → 실행 page 세션을 받는다. */
  async attachRunPage(): Promise<{ sessionId: string; targetId: string }> {
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    const ev = this.events.find((e) => e.method === 'Target.attachedToTarget' && !e.sessionId);
    if (!ev) throw new Error('no run page attached');
    const sessionId = String(ev.params!.sessionId);
    const targetId = String((ev.params!.targetInfo as Json).targetId);
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Network.enable', {}, sessionId);
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    return { sessionId, targetId };
  }

  async navigate(sessionId: string, url: string): Promise<void> {
    const before = this.events.length;
    await this.send('Page.navigate', { url }, sessionId);
    await this.waitEvent((e) => e.method === 'Page.loadEventFired' && e.sessionId === sessionId, before);
  }

  async waitEvent(pred: (e: RawMsg) => boolean, from = 0, timeoutMs = 10_000): Promise<RawMsg> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      const hit = this.events.slice(from).find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('timeout waiting event');
  }

  async evaluate(sessionId: string, expression: string): Promise<unknown> {
    const r = await this.send<{ result: { value?: unknown } }>('Runtime.evaluate', { expression, returnByValue: true, userGesture: true }, sessionId);
    return r.result.value;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
