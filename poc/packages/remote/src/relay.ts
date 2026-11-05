// 릴레이(D08 §8) 연결 추상화. 릴레이는 프레임 바이트만 나른다(내용·키를 볼 수 없다).
// 실제 WSS 클라이언트는 ws-link.ts, 시험·더미용 메모리 릴레이는 MemoryRelay.

export interface Link {
  send(frame: Uint8Array): void;
  onFrame(cb: (frame: Uint8Array) => void): void;
  /** 상대가 들어오면(룸·우편함 모두) 한 번 부른다. 이미 있으면 바로. */
  onPeer(cb: () => void): void;
  onClose(cb: () => void): void;
  close(): void;
  readonly closed: boolean;
}

/** 페어링 룸(1회용, 정원 2, TTL 120초)과 우편함 라이브 연결. */
export interface RelayClient {
  /** 페어링 룸. PC는 응답자로 먼저 들어가 기다리고, 폰이 개시자로 들어온다. */
  joinRoom(roomId: Uint8Array, role: 'desktop' | 'mobile'): Promise<Link>;
  /** 우편함 라이브 연결. PC는 tokRead, 폰은 tokWrite를 낸다(D08 §8, 서버는 토큰 해시만 저장). */
  joinMailbox(mbxId: Uint8Array, token: Uint8Array, role: 'desktop' | 'mobile'): Promise<Link>;
}

/** 한 프레임을 받을 때까지 기다린다(시간 초과는 null). */
export function nextFrame(link: Link, timeoutMs: number): Promise<Uint8Array | null> {
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
    if (link.closed) return finish(null);
    q.wait(onFrame);
    link.onClose(() => finish(null));
  });
}

/** Link 위의 단순 수신 큐(onFrame 콜백을 하나만 걸고 여러 대기자에 나눈다). */
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

// ---- 메모리 릴레이(시험·더미 PC) ----

export interface Faults {
  /** 0~1, 프레임을 버릴 확률 */
  drop?: number;
  /** 0~1, 같은 프레임을 한 번 더 보낼 확률(재전송 공격) */
  duplicate?: number;
  /** 0~1, 한 바이트를 바꿀 확률(변조) */
  tamper?: number;
  /** 결정적 시험용 난수 */
  rand?: () => number;
}

class MemLink implements Link {
  #frameCbs: ((f: Uint8Array) => void)[] = [];
  #peerCbs: (() => void)[] = [];
  #closeCbs: (() => void)[] = [];
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
  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const cb of this.#closeCbs.splice(0)) cb();
    const p = this.#peer;
    this.#peer = null;
    if (p && !p.closed) p.close();
    this.relay.leave(this.chan, this);
  }
}

/**
 * D08 §8 우편함 릴레이의 메모리 구현. 페어링 룸은 정원 2·1회용, 우편함은 토큰 해시로 연다.
 * observed에는 릴레이가 본 프레임이 그대로 남는다(평문이 새지 않는지 시험에서 확인).
 */
export class MemoryRelay implements RelayClient {
  faults: Faults = {};
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

  /** PC가 페어링 7단계 뒤 우편함을 등록한다(서버는 토큰 해시만 저장). */
  registerMailbox(mbxId: Uint8Array, tokReadHash: string, tokWriteHash: string) {
    this.#mailboxes.set(hex(mbxId), { read: tokReadHash, write: tokWriteHash, frozen: false });
  }
  /** 기기 해제·긴급 정지(§9.2·§9.3): 우편함 토큰 무효화. */
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

  async joinMailbox(mbxId: Uint8Array, token: Uint8Array, role: 'desktop' | 'mobile'): Promise<Link> {
    const m = this.#mailboxes.get(hex(mbxId));
    const want = role === 'desktop' ? m?.read : m?.write;
    if (!m || m.frozen || want !== this.tokenHash(token)) throw new Error('relay: mailbox refused');
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
