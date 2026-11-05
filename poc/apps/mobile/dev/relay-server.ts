// 개발용 릴레이(services/relay가 생기기 전의 대역, D08 §8 초안 프로토콜 = packages/remote/src/ws-link.ts).
// 룸(1회용, 정원 2, TTL 120초)과 우편함(토큰 해시 대조, 역할별 토큰)을 프레임 단위로 중계한다. 내용은 모른다.
import { createHash } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

type Role = 'desktop' | 'mobile';
interface Slot {
  desktop?: WebSocket;
  mobile?: WebSocket;
  createdAt: number;
}

const ROOM_TTL_MS = 120_000;
const MAX_FRAME = 65_535 + 64;
const sha = (b64url: string) => createHash('sha256').update(Buffer.from(b64url, 'base64url')).digest('hex');

export class DevRelay {
  #rooms = new Map<string, Slot>();
  #mbx = new Map<string, Slot>();
  #tokens = new Map<string, { read: string; write: string }>();
  frames = 0;

  registerMailbox(mbxIdB64url: string, readHash: string, writeHash: string) {
    this.#tokens.set(mbxIdB64url, { read: readHash, write: writeHash });
  }
  revokeMailbox(mbxIdB64url: string) {
    this.#tokens.delete(mbxIdB64url);
    const s = this.#mbx.get(mbxIdB64url);
    s?.desktop?.close();
    s?.mobile?.close();
  }

  attach(server: Server) {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME });
    server.on('upgrade', (req: IncomingMessage, sock, head) => {
      if (req.url !== '/v1/connect') return sock.destroy();
      wss.handleUpgrade(req, sock, head, (ws) => this.#onConn(ws));
    });
  }

  #onConn(ws: WebSocket) {
    const t = setTimeout(() => ws.close(4000), 5000);
    ws.once('message', (data, isBinary) => {
      clearTimeout(t);
      if (isBinary) return ws.close(4001);
      let m: { op?: string; room?: string; mbx?: string; token?: string; role?: Role };
      try {
        m = JSON.parse(String(data));
      } catch {
        return ws.close(4001);
      }
      if (m.op !== 'join' || (m.role !== 'desktop' && m.role !== 'mobile')) return ws.close(4001);
      const err = (code: string) => {
        ws.send(JSON.stringify({ op: 'error', code }));
        ws.close(4003);
      };
      let table: Map<string, Slot>;
      let key: string;
      if (m.room && /^[A-Za-z0-9_-]{22}$/.test(m.room)) {
        table = this.#rooms;
        key = m.room;
        const s = table.get(key);
        if (s && Date.now() - s.createdAt > ROOM_TTL_MS) {
          table.delete(key);
          return err('room_expired');
        }
      } else if (m.mbx && m.token) {
        const tok = this.#tokens.get(m.mbx);
        if (!tok || sha(m.token) !== (m.role === 'desktop' ? tok.read : tok.write)) return err('mailbox_refused');
        table = this.#mbx;
        key = m.mbx;
      } else return err('bad_join');
      const slot = table.get(key) ?? { createdAt: Date.now() };
      if (slot[m.role]) return err('role_taken');
      slot[m.role] = ws;
      table.set(key, slot);
      const other = slot[m.role === 'desktop' ? 'mobile' : 'desktop'];
      ws.send(JSON.stringify({ op: 'joined', peer: !!other }));
      if (other) other.send(JSON.stringify({ op: 'peer' }));
      const role = m.role;
      ws.on('message', (d, bin) => {
        if (!bin) return;
        const o = slot[role === 'desktop' ? 'mobile' : 'desktop'];
        this.frames++;
        if (o && o.readyState === o.OPEN) o.send(d, { binary: true });
      });
      ws.on('close', () => {
        // 라이브 연결은 한 쌍이다: 한쪽이 나가면 다른 쪽도 닫고 자리를 비운다(룸은 1회용이라 지운다).
        if (slot[role] === ws) delete slot[role];
        const o = slot[role === 'desktop' ? 'mobile' : 'desktop'];
        if (o) {
          delete slot[role === 'desktop' ? 'mobile' : 'desktop'];
          o.close(1000);
        }
        if (table === this.#rooms || (!slot.desktop && !slot.mobile)) table.delete(key);
      });
    });
  }
}
