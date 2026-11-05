// D08 §8 릴레이 WSS 클라이언트(초안 프로토콜, services/relay가 정본이 되면 맞춘다). 전송은 주입한 WebSocket 생성자로만 한다:
// 폰은 RN 내장 WebSocket, PC는 @sax/net egress가 만든 것을 넘긴다(D01 §3, 이 패키지는 소켓을 직접 열지 않는다).
//  1) 연결 후 첫 텍스트 메시지 {"op":"join", room | mbx+token, role}
//  2) 서버 {"op":"joined","peer":bool}, 상대가 오면 {"op":"peer"}, 거부는 {"op":"error","code"} 뒤 닫기
//  3) 그 뒤 바이너리 메시지 하나 = 전송 프레임 하나(릴레이는 내용을 모른다)
// 토큰은 URL 쿼리에 넣지 않는다(접근 로그 노출 방지).

import { b64url } from './bytes.ts';
import type { Link, RelayClient } from './relay.ts';

export interface WebSocketLike {
  binaryType: string;
  readonly readyState: number;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WsRelayOptions {
  host: string;
  open: (url: string) => WebSocketLike;
  /** 개발용 로컬 릴레이(ws://, localhost만). */
  insecureLocal?: boolean;
  joinTimeoutMs?: number;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const MAX_FRAME = 65_535 + 64;

export function relayUrl(host: string, insecureLocal = false): string {
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[::1\](:\d{1,5})?$/.test(host)) throw new Error('relay: bad host');
  const bare = host.replace(/:\d+$/, '');
  if (insecureLocal) {
    if (!LOCAL.has(bare)) throw new Error('relay: insecure only for localhost');
    return `ws://${host}/v1/connect`;
  }
  return `wss://${host}/v1/connect`;
}

class WsLink implements Link {
  #ws: WebSocketLike;
  #frame: ((f: Uint8Array) => void)[] = [];
  #peer: (() => void)[] = [];
  #close: (() => void)[] = [];
  #hasPeer = false;
  #closed = false;
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
  _peer() {
    if (this.#hasPeer) return;
    this.#hasPeer = true;
    for (const cb of this.#peer) cb();
  }
  _closed() {
    if (this.#closed) return;
    this.#closed = true;
    for (const cb of this.#close) cb();
  }
  send(frame: Uint8Array) {
    if (this.#closed) return;
    if (frame.length > MAX_FRAME) throw new Error('relay: frame too large');
    this.#ws.send(frame);
  }
  onFrame(cb: (f: Uint8Array) => void) {
    this.#frame.push(cb);
  }
  onPeer(cb: () => void) {
    if (this.#hasPeer) cb();
    else this.#peer.push(cb);
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
    this._closed();
  }
}

async function toBytes(d: unknown): Promise<Uint8Array | null> {
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice();
  const blob = d as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (blob && typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return null;
}

function join(o: WsRelayOptions, hello: Record<string, string>): Promise<Link> {
  return new Promise((resolve, reject) => {
    const ws = o.open(relayUrl(o.host, o.insecureLocal));
    ws.binaryType = 'arraybuffer';
    let link: WsLink | null = null;
    // Blob으로 오는 환경에서도 프레임 순서를 지킨다.
    let chain: Promise<void> = Promise.resolve();
    const t = setTimeout(() => fail('relay: join timeout'), o.joinTimeoutMs ?? 10_000);
    let ended = false;
    function fail(msg: string) {
      if (ended) return;
      ended = true;
      clearTimeout(t);
      ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* 이미 닫힘 */
      }
      if (link) link._closed();
      else reject(new Error(msg));
    }
    ws.onopen = () => ws.send(JSON.stringify({ op: 'join', ...hello }));
    ws.onerror = () => fail('relay: socket error');
    ws.onclose = () => fail('relay: closed');
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m: { op?: string; peer?: boolean; code?: string };
        try {
          m = JSON.parse(ev.data);
        } catch {
          return fail('relay: bad control');
        }
        if (m.op === 'joined' && !link) {
          clearTimeout(t);
          link = new WsLink(ws, m.peer === true);
          resolve(link);
        } else if (m.op === 'peer' && link) link._peer();
        else if (m.op === 'error') fail(`relay: ${String(m.code ?? 'error').slice(0, 32)}`);
        return;
      }
      if (!link) return fail('relay: frame before join');
      const l = link;
      const data = ev.data;
      chain = chain
        .then(() => toBytes(data))
        .then((b) => {
          if (b && b.length <= MAX_FRAME) l._frame(b);
        })
        .catch(() => fail('relay: bad frame'));
    };
  });
}

/** 릴레이 WSS 클라이언트. */
export function wsRelayClient(o: WsRelayOptions): RelayClient {
  return {
    joinRoom: (roomId, role) => join(o, { room: b64url(roomId), role }),
    joinMailbox: (mbxId, token, role) => join(o, { mbx: b64url(mbxId), token: b64url(token), role }),
  };
}
