
import { isDevPlainHost } from './devhosts.ts';
import { b64url } from './bytes.ts';
import { KIND } from './frame.ts';
import type { Link, MailboxTokens, RelayClient } from './relay.ts';

export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  ping?(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number } | unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WsRelayOptions {
  host: string;
  open: (url: string, headers?: Record<string, string>) => WebSocketLike;
  deviceAuth?: (htm: 'GET', htu: string) => Promise<Record<string, string>>;
  insecureLocal?: boolean;
  joinTimeoutMs?: number;
  pingMs?: number;
  now?: () => number;
}

/** 서버 프레임 상한(services/relay RELAY.frameMax). */
export const RELAY_FRAME_MAX = 65_535;
/** 우편함 앱 수준 keepalive(서버 services/relay가 pong으로 답한다). */
export const RELAY_PING = '{"t":"ping"}';
export const RELAY_CLOSE = { tokenExpired: 4001, replaced: 4002, policy: 1008, tooBig: 1009 } as const;

function checkHost(host: string, insecureLocal: boolean): void {
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[::1\](:\d{1,5})?$/.test(host)) throw new Error('relay: bad host');
  if (insecureLocal && !isDevPlainHost(host.replace(/:\d+$/, ''))) throw new Error('relay: insecure only for localhost');
}

/** DPoP htu의 origin(https, 로컬 개발만 http). */
export function relayOrigin(host: string, insecureLocal = false): string {
  checkHost(host, insecureLocal);
  return `${insecureLocal ? 'http' : 'https'}://${host}`;
}

export function relayRoomPath(roomId: Uint8Array): string {
  if (roomId.length !== 16) throw new Error('relay: bad room id');
  return `/v1/rooms/${b64url(roomId)}`;
}

export function relayMailboxPath(mbxId: Uint8Array): string {
  if (mbxId.length !== 32) throw new Error('relay: bad mailbox id');
  return `/v1/mailboxes/${b64url(mbxId)}/live`;
}

export function relayUrl(host: string, path: string, insecureLocal = false): string {
  checkHost(host, insecureLocal);
  return `${insecureLocal ? 'ws' : 'wss'}://${host}${path}`;
}

/** ws-link가 돌려주는 링크. Link에 더해 서버 제어 메시지와 닫힘 코드를 준다. */
export interface RelayLink extends Link {
  onEnv(cb: () => void): void;
  readonly closeCode: number | null;
}

export interface WsRelayClient extends RelayClient {
  joinRoom(roomId: Uint8Array, role: 'desktop' | 'mobile'): Promise<RelayLink>;
  joinMailbox(mbxId: Uint8Array, tok: MailboxTokens, role: 'desktop' | 'mobile'): Promise<RelayLink>;
}

class WsLink implements RelayLink {
  #ws: WebSocketLike;
  #frame: ((f: Uint8Array) => void)[] = [];
  #peer: (() => void)[] = [];
  #env: (() => void)[] = [];
  #close: (() => void)[] = [];
  #gone: (() => void)[] = [];
  #hasPeer: boolean;
  #closed = false;
  closeCode: number | null = null;
  constructor(ws: WebSocketLike, peer: boolean) {
    this.#ws = ws;
    this.#hasPeer = peer;
  }
  get closed() {
    return this.#closed;
  }
  _frame(f: Uint8Array) {
    for (const cb of this.#frame) cb(f);
  }
  _peer(online: boolean) {
    if (!online) {
      const was = this.#hasPeer;
      this.#hasPeer = false;
      if (was) for (const cb of this.#gone) cb();
      return;
    }
    if (this.#hasPeer) return;
    this.#hasPeer = true;
    for (const cb of this.#peer) cb();
  }
  _env() {
    for (const cb of this.#env) cb();
  }
  _closed(code: number | null) {
    if (this.#closed) return;
    this.#closed = true;
    this.closeCode = code;
    for (const cb of this.#close) cb();
  }
  send(frame: Uint8Array) {
    if (this.#closed) return;
    if (frame.length > RELAY_FRAME_MAX) throw new Error('relay: frame too large');
    if (frame[1] === KIND.ENV) throw new Error('relay: ENV goes through the queue');
    this.#ws.send(frame);
  }
  onFrame(cb: (f: Uint8Array) => void) {
    this.#frame.push(cb);
  }
  onPeer(cb: () => void) {
    this.#peer.push(cb);
    if (this.#hasPeer) cb();
  }
  onPeerGone(cb: () => void) {
    this.#gone.push(cb);
  }
  onEnv(cb: () => void) {
    this.#env.push(cb);
  }
  onClose(cb: () => void) {
    if (this.#closed) cb();
    else this.#close.push(cb);
  }
  close() {
    try {
      this.#ws.close(1000);
    } catch {
      /* 이미 닫힘 */
    }
    this._closed(this.closeCode);
  }
}

async function toBytes(d: unknown): Promise<Uint8Array | null> {
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
  const blob = d as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (blob && typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return null;
}

const codeOf = (ev: unknown): number | null => {
  const c = (ev as { code?: unknown } | null)?.code;
  return typeof c === 'number' ? c : null;
};

function join(o: WsRelayOptions, url: string, headers: Record<string, string> | undefined, kind: 'room' | 'mailbox', role: 'desktop' | 'mobile'): Promise<RelayLink> {
  return new Promise((resolve, reject) => {
    let ws: WebSocketLike;
    try {
      ws = o.open(url, headers);
    } catch {
      return reject(new Error('relay: open failed'));
    }
    ws.binaryType = 'arraybuffer';
    let link: WsLink | null = null;
    let chain: Promise<void> = Promise.resolve();
    let ping: ReturnType<typeof setInterval> | null = null;
    const t = setTimeout(() => fail('relay: join timeout', null), o.joinTimeoutMs ?? 10_000);
    let ended = false;
    const now = o.now ?? Date.now;
    let lastIn = 0;
    function fail(msg: string, code: number | null) {
      if (ended) return;
      ended = true;
      clearTimeout(t);
      if (ping) clearInterval(ping);
      ws.onclose = ws.onerror = ws.onmessage = ws.onopen = null;
      try {
        ws.close();
      } catch {
        /* 이미 닫힘 */
      }
      if (link) link._closed(code);
      else reject(new Error(msg));
    }
    const ready = (peer: boolean) => {
      clearTimeout(t);
      link = new WsLink(ws, peer);
      const pingMs = o.pingMs ?? 30_000;
      if (pingMs > 0 && kind === 'mailbox') {
        lastIn = now();
        ping = setInterval(() => {
          if (now() - lastIn > pingMs * 2.5) return fail('relay: stale', null);
          try {
            ws.send(RELAY_PING);
          } catch {
            /* 닫히는 중 */
          }
        }, pingMs);
      } else if (pingMs > 0 && typeof ws.ping === 'function') {
        ping = setInterval(() => {
          try {
            ws.ping!();
          } catch {
            /* 닫히는 중 */
          }
        }, pingMs);
      }
      (ping as { unref?: () => void } | null)?.unref?.();
      link.onClose(() => {
        if (ping) clearInterval(ping);
      });
      resolve(link);
    };
    ws.onopen = () => {
      if (kind === 'room') ready(role === 'mobile');
    };
    ws.onerror = () => fail(link ? 'relay: socket error' : 'relay: rejected', null);
    ws.onclose = (ev) => fail(link ? 'relay: closed' : 'relay: rejected', codeOf(ev));
    ws.onmessage = (ev) => {
      lastIn = now();
      if (typeof ev.data === 'string') {
        let m: { t?: unknown; online?: unknown };
        try {
          m = JSON.parse(ev.data) as typeof m;
        } catch {
          return;
        }
        if (kind !== 'mailbox') return;
        if (m.t === 'peer') {
          if (!link) ready(m.online === true);
          else link._peer(m.online === true);
        } else if (m.t === 'env' && link) link._env();
        return;
      }
      if (!link) return fail('relay: frame before join', null);
      const l = link;
      const data = ev.data;
      chain = chain
        .then(() => toBytes(data))
        .then((b) => {
          if (b && b.length <= RELAY_FRAME_MAX) l._frame(b);
        })
        .catch(() => fail('relay: bad frame', null));
    };
  });
}

/** 릴레이 WSS 클라이언트. */
export function wsRelayClient(o: WsRelayOptions): WsRelayClient {
  const local = o.insecureLocal ?? false;
  return {
    joinRoom: (roomId, role) => join(o, relayUrl(o.host, relayRoomPath(roomId), local), undefined, 'room', role),
    joinMailbox: async (mbxId, tok, role) => {
      if (!o.deviceAuth) throw new Error('relay: device auth required');
      if (tok.read.length !== 32 || tok.write.length !== 32) throw new Error('relay: bad mailbox token');
      const path = relayMailboxPath(mbxId);
      const auth = await o.deviceAuth('GET', relayOrigin(o.host, local) + path);
      const headers = { ...auth, 'X-Mbx-Read': b64url(tok.read), 'X-Mbx-Write': b64url(tok.write) };
      return join(o, relayUrl(o.host, path, local), headers, 'mailbox', role);
    },
  };
}
