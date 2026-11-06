// 최소 WebSocket 서버(RFC 6455). 의존성을 늘리지 않으려고(ADR-028) 릴레이가 쓰는 부분만 직접 구현한다:
// 마스킹된 클라이언트 프레임, 텍스트·바이너리·close·ping·pong, 조각 프레임 거부, 프레임 ≤ maxPayload(D08 §8: 65,535B).
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const CLOSE = { normal: 1000, protocol: 1002, unsupported: 1003, policy: 1008, tooBig: 1009, gone: 4001, replaced: 4002 } as const;

/** 업그레이드 요청이 형식에 맞으면 101을 쓰고 true. 아니면 400을 쓰고 끊는다. */
export function acceptUpgrade(req: IncomingMessage, socket: Duplex): boolean {
  const key = req.headers['sec-websocket-key'];
  if (req.method !== 'GET' || String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    rejectUpgrade(socket, 400);
    return false;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return true;
}

/** 업그레이드 전 거절. 본문은 오류 코드뿐(입력을 되풀이하지 않는다). */
export function rejectUpgrade(socket: Duplex, status: number, code = ''): void {
  const body = code ? JSON.stringify({ error: code }) : '';
  socket.end(`HTTP/1.1 ${status} ${status === 101 ? '' : 'Rejected'}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

export interface WsHandlers {
  onMessage(data: Buffer, text: boolean): void;
  onClose(): void;
}

export class WsConn {
  private buf: Buffer = Buffer.alloc(0);
  private closed = false;
  private readonly socket: Duplex;
  private readonly maxPayload: number;
  private h: WsHandlers = { onMessage: () => undefined, onClose: () => undefined };

  constructor(socket: Duplex, opts: { maxPayload: number; idleMs: number }) {
    this.socket = socket;
    this.maxPayload = opts.maxPayload;
    const s = socket as Duplex & { setTimeout?: (ms: number, cb: () => void) => void; setNoDelay?: (v: boolean) => void };
    s.setNoDelay?.(true);
    s.setTimeout?.(opts.idleMs, () => this.close(CLOSE.policy));
    socket.on('data', (d: Buffer) => this.feed(d));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  on(h: WsHandlers): void {
    this.h = h;
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  send(data: Buffer | string): void {
    if (this.closed) return;
    const text = typeof data === 'string';
    this.frame(text ? 0x1 : 0x2, text ? Buffer.from(data, 'utf8') : data);
  }

  close(code: number = CLOSE.normal): void {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.frame(0x8, p);
    this.closed = true;
    this.socket.end();
    this.h.onClose();
  }

  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.h.onClose();
  }

  private frame(opcode: number, payload: Buffer): void {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), u64(n)]);
    this.socket.write(Buffer.concat([head, payload]));
  }

  private feed(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (!this.closed) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0]!;
      const b1 = this.buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      if ((b0 & 0x70) !== 0 || (b1 & 0x80) === 0) return this.close(CLOSE.protocol); // RSV 비트·마스크 없음(클라이언트 프레임은 반드시 마스킹)
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(this.maxPayload)) return this.close(CLOSE.tooBig);
        len = Number(big);
        off = 10;
      }
      if (len > this.maxPayload) return this.close(CLOSE.tooBig);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i]! ^= mask[i & 3]!;
      this.buf = this.buf.subarray(off + 4 + len);
      if (!fin || opcode === 0x0) return this.close(CLOSE.unsupported); // 조각 프레임은 받지 않는다(프레임 하나 = 메시지 하나)
      if (opcode === 0x8) return this.close(CLOSE.normal);
      if (opcode === 0x9) {
        if (len > 125) return this.close(CLOSE.protocol);
        this.frame(0xa, payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode !== 0x1 && opcode !== 0x2) return this.close(CLOSE.protocol);
      this.h.onMessage(payload, opcode === 0x1);
    }
  }
}

function u64(n: number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}
