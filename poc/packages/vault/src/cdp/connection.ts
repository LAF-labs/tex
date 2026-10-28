import { EventEmitter } from 'node:events';
import type { Readable, Writable } from 'node:stream';

export interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
  sessionId?: string;
}

/** Chrome `--remote-debugging-pipe`: fd3(쓰기)·fd4(읽기)에 NUL로 끝나는 JSON. */
export class PipeConnection extends EventEmitter {
  private readonly out: Writable;
  private buf = '';
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; method: string }>();
  private closed = false;

  constructor(out: Writable, inp: Readable) {
    super();
    this.out = out;
    inp.setEncoding('utf8');
    inp.on('data', (chunk: string) => this.onData(chunk));
    inp.on('close', () => this.onClose());
    out.on('error', () => this.onClose());
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\0')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const msg = JSON.parse(raw) as CdpMessage;
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new CdpError(p.method, msg.error.message));
        else p.resolve(msg.result ?? {});
      } else {
        this.emit('message', msg);
      }
    }
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error('cdp pipe closed'));
    this.pending.clear();
    this.emit('close');
  }

  /** 금고 자신의 요청. */
  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    if (this.closed) return Promise.reject(new Error('cdp pipe closed'));
    const id = this.nextId++;
    const msg: CdpMessage = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: Record<string, unknown>) => void, reject, method });
      this.out.write(JSON.stringify(msg) + '\0');
    });
  }

  /** 중계 요청: 응답은 'message' 이벤트로 돌아온다. id 공간은 send()와 겹치지 않게 할당한다. */
  allocId(): number {
    return this.nextId++;
  }

  sendRaw(msg: CdpMessage): void {
    if (!this.closed) this.out.write(JSON.stringify(msg) + '\0');
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

export class CdpError extends Error {
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
  }
}
