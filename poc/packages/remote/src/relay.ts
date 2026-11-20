
export interface Link {
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
  onPeer(cb: () => void): void;
  onClose(cb: () => void): void;
  onPeerGone?(cb: () => void): void;
  close(): void;
  readonly closed: boolean;
}

/** 페어링 룸(1회용, 정원 2, TTL 120초)과 우편함 라이브 연결. */
export interface RelayClient {
  joinRoom(roomId: Uint8Array, role: 'desktop' | 'mobile'): Promise<Link>;
  joinMailbox(mbxId: Uint8Array, tok: MailboxTokens, role: 'desktop' | 'mobile'): Promise<Link>;
}

/** 우편함 능력 토큰(각 32B). PC가 만들어 PAIR_OK로 폰에 준다(D08 §4.2 7단계). */
export interface MailboxTokens {
  read: Uint8Array;
  write: Uint8Array;
}

/** 한 프레임을 받을 때까지 기다린다(시간 초과·signal 중단은 null. 중단되면 그 뒤 프레임은 다음 대기자가 받는다). */
export function nextFrame(link: Link, timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const q = queueFor(link);
    let done = false;
    const finish = (v: Uint8Array | null) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      q.drop(onFrame);
      resolve(v);
    };
    const onFrame = (f: Uint8Array) => finish(f);
    const t = setTimeout(() => finish(null), timeoutMs);
    if (link.closed || signal?.aborted) return finish(null);
    q.wait(onFrame);
    link.onClose(() => finish(null));
    signal?.addEventListener('abort', () => finish(null), { once: true });
  });
}

/** 이미 받아 둔 프레임이 있으면 하나 꺼낸다(기다리지 않는다). */
export function queuedFrame(link: Link): Uint8Array | null {
  return queueFor(link).take();
}

class FrameQueue {
  #buf: Uint8Array[] = [];
  #waiters: ((f: Uint8Array) => void)[] = [];
  push(f: Uint8Array) {
    const w = this.#waiters.shift();
    if (w) w(f);
    else this.#buf.push(f);
  }
  wait(cb: (f: Uint8Array) => void) {
    const f = this.#buf.shift();
    if (f) cb(f);
    else this.#waiters.push(cb);
  }
  drop(cb: (f: Uint8Array) => void) {
    this.#waiters = this.#waiters.filter((x) => x !== cb);
  }
  take(): Uint8Array | null {
    return this.#buf.shift() ?? null;
  }
}
const queues = new WeakMap<Link, FrameQueue>();
function queueFor(link: Link): FrameQueue {
  let q = queues.get(link);
  if (!q) {
    q = new FrameQueue();
    const qq = q;
    link.onFrame((f) => qq.push(f));
    queues.set(link, q);
  }
  return q;
}
/** nextFrame 대기 전에 큐를 붙인다(첫 프레임을 놓치지 않게). */
export function attachQueue(link: Link): void {
  queueFor(link);
}

export interface Faults {
  drop?: number;
  duplicate?: number;
  tamper?: number;
  rand?: () => number;
}

class MemLink implements Link {
  #frameCbs: ((f: Uint8Array) => void)[] = [];
  #peerCbs: (() => void)[] = [];
  #closeCbs: (() => void)[] = [];
  #goneCbs: (() => void)[] = [];
  #peer: MemLink | null = null;
  #closed = false;
  private relay: MemoryRelay;
  private chan: string;
  constructor(relay: MemoryRelay, chan: string) {
    this.relay = relay;
    this.chan = chan;
  }
  get closed() {
    return this.#closed;
  }
  connect(p: MemLink) {
    this.#peer = p;
    for (const cb of this.#peerCbs.splice(0)) cb();
  }
  deliver(f: Uint8Array) {
    if (this.#closed) return;
    for (const cb of this.#frameCbs) cb(f);
  }
  send(frame: Uint8Array): void {
    if (this.#closed) return;
    this.relay.observe(this.chan, frame);
    const peer = this.#peer;
    if (!peer) return;
    const f = this.relay.faults;
    const r = f.rand ?? Math.random;
    if (f.drop && r() < f.drop) return;
    let out = frame.slice();
    if (f.tamper && r() < f.tamper && out.length > 0) {
      const i = Math.floor(r() * out.length);
      out[i] = out[i]! ^ 0x01;
    }
    queueMicrotask(() => peer.deliver(out));
    if (f.duplicate && r() < f.duplicate) {
      out = out.slice();
      queueMicrotask(() => peer.deliver(out));
    }
  }
  onFrame(cb: (f: Uint8Array) => void) {
    this.#frameCbs.push(cb);
  }
  onPeer(cb: () => void) {
    if (this.#peer) cb();
    else this.#peerCbs.push(cb);
  }
  onClose(cb: () => void) {
    if (this.#closed) cb();
    else this.#closeCbs.push(cb);
  }
  onPeerGone(cb: () => void) {
    this.#goneCbs.push(cb);
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const cb of this.#closeCbs.splice(0)) cb();
    const p = this.#peer;
    this.#peer = null;
    if (p && !p.closed) {
      if (this.relay.mailboxKeepsPeer && this.chan.startsWith('mbx:')) p.detach();
      else p.close();
    }
    this.relay.leave(this.chan, this);
  }
  detach() {
    this.#peer = null;
    queueMicrotask(() => {
      for (const cb of this.#goneCbs) cb();
    });
  }
}

/**
 * D08 §8 우편함 릴레이의 메모리 구현. 페어링 룸은 정원 2·1회용, 우편함은 토큰 해시로 연다.
 * observed에는 릴레이가 본 프레임이 그대로 남는다(평문이 새지 않는지 시험에서 확인).
 */
export class MemoryRelay implements RelayClient {
  faults: Faults = {};
  readonly mailboxKeepsPeer: boolean;
  constructor(o: { mailboxKeepsPeer?: boolean } = {}) {
    this.mailboxKeepsPeer = o.mailboxKeepsPeer ?? false;
  }
  readonly observed: { chan: string; frame: Uint8Array }[] = [];
  #chans = new Map<string, { desktop?: MemLink; mobile?: MemLink; used: boolean }>();
  #mailboxes = new Map<string, { read: string; write: string; frozen: boolean }>();

  observe(chan: string, frame: Uint8Array) {
    this.observed.push({ chan, frame: frame.slice() });
  }
  leave(chan: string, l: MemLink) {
    const c = this.#chans.get(chan);
    if (!c) return;
    if (c.desktop === l) delete c.desktop;
    if (c.mobile === l) delete c.mobile;
  }

  registerMailbox(mbxId: Uint8Array, tokReadHash: string, tokWriteHash: string) {
    this.#mailboxes.set(hex(mbxId), { read: tokReadHash, write: tokWriteHash, frozen: false });
  }
  revokeMailbox(mbxId: Uint8Array) {
    const m = this.#mailboxes.get(hex(mbxId));
    if (m) m.frozen = true;
    const c = this.#chans.get(`mbx:${hex(mbxId)}`);
    c?.desktop?.close();
    c?.mobile?.close();
  }
  tokenHash: (tok: Uint8Array) => string = hex;

  async joinRoom(roomId: Uint8Array, role: 'desktop' | 'mobile'): Promise<Link> {
    return this.#join(`room:${hex(roomId)}`, role, true);
  }

  async joinMailbox(mbxId: Uint8Array, tok: MailboxTokens, role: 'desktop' | 'mobile'): Promise<Link> {
    const m = this.#mailboxes.get(hex(mbxId));
    if (!m || m.frozen || m.read !== this.tokenHash(tok.read) || m.write !== this.tokenHash(tok.write)) throw new Error('relay: mailbox refused');
    return this.#join(`mbx:${hex(mbxId)}`, role, false);
  }

  #join(chan: string, role: 'desktop' | 'mobile', oneShot: boolean): MemLink {
    let c = this.#chans.get(chan);
    if (!c) {
      c = { used: false };
      this.#chans.set(chan, c);
    }
    if (c[role]) throw new Error('relay: slot taken');
    if (oneShot && c.used && !c.desktop && !c.mobile) throw new Error('relay: room used');
    const l = new MemLink(this, chan);
    c[role] = l;
    const other = role === 'desktop' ? c.mobile : c.desktop;
    if (other) {
      c.used = true;
      l.connect(other);
      other.connect(l);
    }
    return l;
  }
}

function hex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
