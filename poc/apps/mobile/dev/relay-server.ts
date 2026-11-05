// 개발용 릴레이(services/relay 대역). 경로·헤더·제어 메시지는 services/relay/API.md와 같고, 저장·한도는 덜어 냈다.
//   WSS GET /v1/rooms/:roomId              인증 없음, PC가 createRoom(= POST /v1/rooms)으로 먼저 만든다. 정원 2, 120초, 1회용.
//   WSS GET /v1/mailboxes/:mbxId/live      Authorization: DPoP + DPoP + X-Mbx-Read + X-Mbx-Write. 쪽은 기기 토큰의 역할.
//   바이너리 = D08 §6 바깥 프레임(ver=1, kind HS=1·DATA=2, len 일치). 텍스트 {"t":"peer","online"}. 4001 토큰 만료, 4002 대체.
// 내용은 모른다(프레임 바이트만 나른다).
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { DevAuth } from './dev-auth.ts';

const ROOM_TTL_MS = 120_000;
const FRAME_MAX = 65_535;
const FAILS_MAX = 5;
const sha = (b64url: string) => createHash('sha256').update(Buffer.from(b64url, 'base64url')).digest('hex');

function outerOk(d: Buffer): boolean {
  if (d.length < 4 || d[0] !== 1) return false;
  if (d[1] === 1) return d.readUInt16BE(2) === d.length - 4;
  if (d[1] === 2) return d.length >= 12 && d.readUInt16BE(10) === d.length - 12;
  return false;
}

function reject(sock: Duplex, status: number, code: string) {
  const body = JSON.stringify({ error: code });
  sock.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

const header = (req: IncomingMessage, n: string) => (Array.isArray(req.headers[n]) ? undefined : (req.headers[n] as string | undefined));

export class DevRelay {
  #rooms = new Map<string, { conns: WebSocket[]; expires: number }>();
  #mbx = new Map<string, { d?: WebSocket; m?: WebSocket }>();
  #tokens = new Map<string, { read: string; write: string }>();
  frames = 0;
  readonly #auth: DevAuth;
  readonly #origin: string;
  constructor(auth: DevAuth, origin: string) {
    this.#auth = auth;
    this.#origin = origin;
  }

  /** POST /v1/rooms 대역(PC만). */
  createRoom(roomIdB64url: string) {
    this.#rooms.set(roomIdB64url, { conns: [], expires: Date.now() + ROOM_TTL_MS });
  }
  /** POST /v1/mailboxes 대역(PC만). 서버는 토큰 해시만 저장한다. */
  registerMailbox(mbxIdB64url: string, readHash: string, writeHash: string) {
    this.#tokens.set(mbxIdB64url, { read: readHash, write: writeHash });
  }
  revokeMailbox(mbxIdB64url: string) {
    this.#tokens.delete(mbxIdB64url);
    const s = this.#mbx.get(mbxIdB64url);
    s?.d?.close(1000);
    s?.m?.close(1000);
  }

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: FRAME_MAX });
    server.on('upgrade', (req: IncomingMessage, sock: Duplex, head: Buffer) => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const room = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})$/.exec(path);
      const mbx = /^\/v1\/mailboxes\/([A-Za-z0-9_-]{43})\/live$/.exec(path);
      if (room) {
        const r = this.#rooms.get(room[1]!);
        if (!r || r.expires <= Date.now() || r.conns.length >= 2) return reject(sock, 404, 'relay.room_unavailable');
        return wss.handleUpgrade(req, sock, head, (ws) => this.#onRoom(ws, room[1]!));
      }
      if (mbx) {
        const dev = this.#auth.check(header(req, 'authorization'), header(req, 'dpop'), 'GET', this.#origin + path);
        if (!dev) return reject(sock, 401, 'relay.unauthorized');
        const tok = this.#tokens.get(mbx[1]!);
        const r = header(req, 'x-mbx-read');
        const w = header(req, 'x-mbx-write');
        if (!tok || !r || !w || sha(r) !== tok.read || sha(w) !== tok.write) return reject(sock, 404, 'relay.mailbox_not_found');
        return wss.handleUpgrade(req, sock, head, (ws) => this.#onMailbox(ws, mbx[1]!, dev.role === 'desktop' ? 'd' : 'm', dev.exp));
      }
      reject(sock, 404, 'request.not_found');
    });
  }

  #onRoom(ws: WebSocket, id: string) {
    const r = this.#rooms.get(id)!;
    r.conns.push(ws);
    let fails = 0;
    const end = () => {
      // 1회용: 한쪽이 나가면 룸을 폐기하고 다른 쪽도 끊는다
      if (this.#rooms.get(id) !== r) return;
      this.#rooms.delete(id);
      for (const c of r.conns) if (c !== ws) c.close(4001);
    };
    const t = setTimeout(() => ws.close(4001), Math.max(0, r.expires - Date.now()));
    ws.on('message', (d: Buffer, bin) => {
      if (!bin || !outerOk(d)) {
        if (++fails >= FAILS_MAX) ws.close(1008);
        return;
      }
      this.frames++;
      for (const c of r.conns) if (c !== ws && c.readyState === c.OPEN) c.send(d, { binary: true });
    });
    ws.on('close', () => {
      clearTimeout(t);
      end();
    });
  }

  #onMailbox(ws: WebSocket, id: string, side: 'd' | 'm', exp: number) {
    const slot = this.#mbx.get(id) ?? {};
    this.#mbx.set(id, slot);
    slot[side]?.close(4002); // 같은 쪽 새 연결이 옛 연결을 대신한다
    slot[side] = ws;
    const other = () => slot[side === 'd' ? 'm' : 'd'];
    const t = setTimeout(() => ws.close(4001), Math.max(0, exp - Date.now()));
    let fails = 0;
    ws.on('message', (d: Buffer, bin) => {
      if (!bin || !outerOk(d)) {
        if (++fails >= FAILS_MAX) ws.close(1008);
        return;
      }
      this.frames++;
      const o = other();
      if (o && o.readyState === o.OPEN) o.send(d, { binary: true });
    });
    ws.on('close', () => {
      clearTimeout(t);
      if (slot[side] !== ws) return;
      delete slot[side];
      const o = other();
      if (o) o.send(JSON.stringify({ t: 'peer', online: false }));
      else this.#mbx.delete(id);
    });
    const o = other();
    ws.send(JSON.stringify({ t: 'peer', online: !!o }));
    o?.send(JSON.stringify({ t: 'peer', online: true }));
  }
}
