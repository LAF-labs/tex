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

/**
 * 금고의 브라우저 CDP 연결(브라우저 수준, flatten 세션). 전송만 다르다: 설치 Chrome 파이프(PipeConnection)와
 * 앱 안 브라우저(PortConnection: main이 WebContentsView의 webContents.debugger로 브라우저 수준 CDP를 흉내 낸다).
 */
export abstract class CdpConnection extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void; method: string }>();
  private closed = false;

  protected abstract write(msg: CdpMessage): void;

  protected receive(msg: CdpMessage): void {
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.message));
      else p.resolve(msg.result ?? {});
    } else {
      this.emit('message', msg);
    }
  }

  protected onClose(): void {
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
      this.write(msg);
    });
  }

  /** 중계 요청: 응답은 'message' 이벤트로 돌아온다. id 공간은 send()와 겹치지 않게 할당한다. */
  allocId(): number {
    return this.nextId++;
  }

  sendRaw(msg: CdpMessage): void {
    if (!this.closed) this.write(msg);
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** Chrome `--remote-debugging-pipe`: fd3(쓰기)·fd4(읽기)에 NUL로 끝나는 JSON. */
export class PipeConnection extends CdpConnection {
  private readonly out: Writable;
  private buf = '';

  constructor(out: Writable, inp: Readable) {
    super();
    this.out = out;
    inp.setEncoding('utf8');
    inp.on('data', (chunk: string) => this.onData(chunk));
    inp.on('close', () => this.onClose());
    out.on('error', () => this.onClose());
  }

  protected write(msg: CdpMessage): void {
    this.out.write(JSON.stringify(msg) + '\0');
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\0')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.receive(JSON.parse(raw) as CdpMessage);
    }
  }
}

/**
 * 앱 안 브라우저(main의 embedded-browser.ts)와 잇는 'browser' 포트 위 연결. 포트 메시지 하나가 CDP 프레임 하나({t:'cdp', m}),
 * {t:'cdp_closed'}는 닫힘이다. 포트는 금고가 한 번만 듣고(feed) 지금 연결에만 넘긴다: 닫힌 옛 연결은 새 브라우저의 프레임을 받지 않는다.
 */
export class PortConnection extends CdpConnection {
  private readonly post: (m: unknown) => void;

  constructor(post: (m: unknown) => void) {
    super();
    this.post = post;
  }

  feed(raw: unknown): void {
    const m = raw as { t?: unknown; m?: unknown } | null;
    if (m?.t === 'cdp_closed') this.onClose();
    else if (m?.t === 'cdp' && typeof m.m === 'string') this.receive(JSON.parse(m.m) as CdpMessage);
  }

  protected write(msg: CdpMessage): void {
    this.post({ t: 'cdp', m: JSON.stringify(msg) });
  }

  /** 금고가 내린다: main에 알리고(보기를 닫는다) 이쪽도 닫는다. */
  close(): void {
    if (this.isClosed) return;
    this.post({ t: 'cdp_closed' });
    this.onClose();
  }
}

export class CdpError extends Error {
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
  }
}
