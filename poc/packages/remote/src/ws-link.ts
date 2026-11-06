// 릴레이 WSS 클라이언트. 서버 정본은 services/relay/API.md(D14 M7-3, 팀장 결정):
//  - 페어링 룸  GET /v1/rooms/:roomId(22자 b64url)          인증 없음(Noise XX가 지킨다). PC가 먼저 POST /v1/rooms로 만든다.
//  - 라이브 우편함 GET /v1/mailboxes/:mbxId(43자)/live       헤더 Authorization: DPoP <기기 토큰> + DPoP(GET, htu = https://host + 경로)
//                                                           + X-Mbx-Read + X-Mbx-Write(각 32B b64url). 틀리면 업그레이드 전에 거절.
//  - 바이너리 메시지 하나 = D08 §6 바깥 프레임 하나(ver=1, kind HS=1·DATA=2, ≤ 65,535B). ENV(3)는 HTTPS 큐 경로라 여기로 보내지 않는다.
//  - 서버 → 클라이언트 텍스트(우편함만): {"t":"peer","online":bool}, {"t":"env"}(PC에게: 큐에 봉투가 있다).
//  - close 4001 = 기기 토큰 만료(다시 인증해 재연결), 4002 = 같은 쪽 새 연결이 대신함, 1008·1009 = 형식·크기 위반.
//  - 120초 무통신이면 서버가 끊는다: 30초마다 ping(소켓이 ping을 지원할 때. RN·Node ws 모두 있다).
// 전송은 주입한 WebSocket 생성자로만 한다: 폰은 RN 내장 WebSocket(헤더는 세 번째 인자), PC는 @sax/net egress가 만든 것을 넘긴다.
// 토큰은 URL에 넣지 않는다(접근 로그 노출 방지).

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
  /** 소켓을 연다. headers는 우편함 라이브에만 있다(RN: new WebSocket(url, undefined, { headers })). */
  open: (url: string, headers?: Record<string, string>) => WebSocketLike;
  /**
   * 우편함 라이브의 기기 범위 토큰 헤더(Authorization + DPoP). 보통
   * `deviceAuthHeaders(await cache.token(), key, htm, htu)`(devauth.ts). 없으면 우편함에 들어가지 않는다.
   */
  deviceAuth?: (htm: 'GET', htu: string) => Promise<Record<string, string>>;
  /** 개발용 로컬 릴레이(ws://, localhost 또는 같은 LAN의 mDNS `*.local` 이름만. 실기기 개발 빌드가 맥의 개발 스택에 붙을 때). */
  insecureLocal?: boolean;
  joinTimeoutMs?: number;
  /** ping 간격(기본 30초, 0이면 끈다). */
  pingMs?: number;
}

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
/** mDNS 링크 로컬 이름(맥의 LocalHostName.local). IP 주소·공개 도메인은 평문을 허용하지 않는다. */
const MDNS_LOCAL = /^[A-Za-z0-9-]{1,63}\.local$/;
/** 서버 프레임 상한(services/relay RELAY.frameMax). */
export const RELAY_FRAME_MAX = 65_535;
export const RELAY_CLOSE = { tokenExpired: 4001, replaced: 4002, policy: 1008, tooBig: 1009 } as const;

function checkHost(host: string, insecureLocal: boolean): void {
  if (!/^[A-Za-z0-9.-]+(:\d{1,5})?$|^\[::1\](:\d{1,5})?$/.test(host)) throw new Error('relay: bad host');
  const name = host.replace(/:\d+$/, '');
  if (insecureLocal && !LOCAL.has(name) && !MDNS_LOCAL.test(name)) throw new Error('relay: insecure only for localhost');
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
  /** PC에게: 큐에 봉투가 있다({"t":"env"}) → HTTPS GET /v1/mailboxes/:id/envelopes로 꺼낸다. */
  onEnv(cb: () => void): void;
  /** 서버가 보낸 close 코드(RELAY_CLOSE). 닫히기 전이나 모르면 null. */
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
    // 상대가 나갔다 다시 오면 onPeer를 다시 부른다(폰은 그때 IK를 새로 연다).
    if (!online) {
      this.#hasPeer = false;
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

/**
 * room: 열리면 바로 링크(서버가 상대 알림을 보내지 않는다. PC가 먼저 들어가 있으므로 폰은 상대가 있다고 보고,
 *       PC는 폰의 msg1을 기다린다). mailbox: 첫 {"t":"peer"}를 받으면 링크.
 */
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
    // Blob으로 오는 환경에서도 프레임 순서를 지킨다.
    let chain: Promise<void> = Promise.resolve();
    let ping: ReturnType<typeof setInterval> | null = null;
    const t = setTimeout(() => fail('relay: join timeout', null), o.joinTimeoutMs ?? 10_000);
    let ended = false;
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
      if (pingMs > 0 && typeof ws.ping === 'function') {
        ping = setInterval(() => {
          try {
            ws.ping!();
          } catch {
            /* 닫히는 중 */
          }
        }, pingMs);
      }
      link.onClose(() => {
        if (ping) clearInterval(ping);
      });
      resolve(link);
    };
    ws.onopen = () => {
      if (kind === 'room') ready(role === 'mobile');
    };
    // 업그레이드 전 거절(404 relay.room_unavailable·relay.mailbox_not_found, 401·403 기기 토큰)은 브라우저·RN에서 코드 없이 닫힌다.
    ws.onerror = () => fail(link ? 'relay: socket error' : 'relay: rejected', null);
    ws.onclose = (ev) => fail(link ? 'relay: closed' : 'relay: rejected', codeOf(ev));
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let m: { t?: unknown; online?: unknown };
        try {
          m = JSON.parse(ev.data) as typeof m;
        } catch {
          return; // 알 수 없는 제어 메시지는 무시한다
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
