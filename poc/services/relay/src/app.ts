// 릴레이 HTTP + WSS. 모든 우편함 호출은 기기 범위 토큰(relay 범위, DPoP)과 우편함 능력 토큰 둘 다 필요하다:
// 기기 토큰은 남용 방지·긴급 정지 레이어, 능력 토큰은 우편함 접근 권한이다(D08 §8). 서버는 둘의 연결을 저장하지 않는다.
// 페어링 룸(D08 §4.2)은 1회용·정원 2·120초이고 레코드에 계정이 없다. 룸 참가는 QR의 room_id만으로 한다(폰은 아직 기기 토큰이 없다).
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { DeviceAuth, RateLimiter, Router, ServiceError, clientIp, fail, json, memoryLimits, safeEqual, sha256hex, validator, type Ctx, type DeviceClaims, type DeviceDirectory, type InternalCheck, type KeySalt, type Limits, type Logger, type TokenVerifier } from '@sax/svc-shared';
import { OUTER, RELAY } from './constants.ts';
import { RelayService, raw32, type OuterEnvelope } from './service.ts';
import { CLOSE, WsConn, acceptUpgrade, rejectUpgrade } from './ws.ts';

const b64 = (max: number) => ({ type: 'string', maxLength: max, pattern: '^[A-Za-z0-9+/]*={0,2}$' });
const id32 = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };

const V = {
  mailbox: validator<{ mbxId: string; tokRead: string; tokWrite: string }>({ type: 'object', additionalProperties: false, required: ['mbxId', 'tokRead', 'tokWrite'], properties: { mbxId: id32, tokRead: id32, tokWrite: id32 } }),
  // intent-envelope.schema.json의 바깥 객체 {v, kind, enc, ct}
  envelope: validator<OuterEnvelope>({ type: 'object', additionalProperties: false, required: ['v', 'kind', 'enc', 'ct'], properties: { v: { enum: [1] }, kind: { const: 'ENV' }, enc: { ...b64(44), minLength: 43 }, ct: { ...b64(RELAY.envelopeCtMax), minLength: 4 } } }),
  ack: validator<{ seq: number }>({ type: 'object', additionalProperties: false, required: ['seq'], properties: { seq: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } } }),
  bundle: validator<{ bundle: string }>({ type: 'object', additionalProperties: false, required: ['bundle'], properties: { bundle: b64(4096) } }),
  room: validator<{ roomId: string }>({ type: 'object', additionalProperties: false, required: ['roomId'], properties: { roomId: { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } } }),
  redeem: validator<{ deviceId: string }>({ type: 'object', additionalProperties: false, required: ['deviceId'], properties: { deviceId: { type: 'string', minLength: 1, maxLength: 64 } } }),
};

type Side = 'd' | 'm';
interface Live {
  ws: WsConn;
  deviceId: string;
  side: Side;
  fails: number;
}
interface Room {
  conns: WsConn[];
  expires: number;
  timer: NodeJS.Timeout;
  /** 룸을 만든 데스크톱 기기 ID의 sha256(메모리만, 계정 ID 없음). 폰 대리 등록 때 같은 PC인지 본다 */
  owner: string;
  /** 정원 2가 한 번이라도 찼다(폰이 실제로 붙었다) */
  paired: boolean;
  /** 계정 서비스가 폰 등록에 한 번 썼다 */
  redeemed: boolean;
}

export interface RelayAppOpts {
  svc: RelayService;
  verifier: TokenVerifier;
  directory: DeviceDirectory & { invalidate?(deviceId: string): void };
  publicOrigin: string;
  /** 내부 경로(/internal/*) 서명 검사(INTERNAL_CALL_KEY HMAC, 팀장 결정 2026-11-06 #135) */
  internal: InternalCheck;
  logger: Logger;
  trustProxy?: boolean;
  /** HTTP 경로 한도 카운터·키 솔트. 배포는 DB(`sqlLimits`, 인스턴스 공유), 없으면 메모리 */
  limits?: Limits;
  /** 1회용 페어링 룸("룸 켬"). 기본 켬(시험), 기동 설정은 `RELAY_ROOMS=1`일 때만 */
  rooms?: boolean;
  /** 우편함 라이브 WSS. 기본 켬(시험), 기동 설정은 `RELAY_LIVE=1`일 때만(Phase 1 꺼짐) */
  live?: boolean;
}

/** D08 §6 바깥 헤더 검사: 라이브 경로는 HS·DATA만(ENV는 큐 경로). 길이 필드가 실제 길이와 맞아야 한다. */
export function outerOk(f: Buffer): 'HS' | 'DATA' | null {
  if (f.length < 4 || f[0] !== OUTER.ver) return null;
  if (f[1] === OUTER.HS) return f.readUInt16BE(2) === f.length - 4 ? 'HS' : null;
  if (f[1] === OUTER.DATA) return f.length >= 12 && f.readUInt16BE(10) === f.length - 12 ? 'DATA' : null;
  return null;
}

export class RelayHub {
  private readonly mailboxes = new Map<string, { d?: Live; m?: Live }>();
  private readonly rooms = new Map<string, Room>();
  readonly router = new Router();
  private readonly o: RelayAppOpts;
  private readonly auth: DeviceAuth;
  private readonly limits: Limits;
  /** 라이브 연결(WSS, Phase 1 기본 꺼짐) 프레임 속도: 연결이 붙은 인스턴스 안에서만 세면 되므로 메모리 */
  private readonly frameLimits: RateLimiter;
  private readonly ipSalt: KeySalt;
  private readonly limitSalt: KeySalt;

  constructor(o: RelayAppOpts) {
    this.o = o;
    const now = o.svc.now;
    this.auth = new DeviceAuth({ verifier: o.verifier, directory: o.directory, publicOrigin: o.publicOrigin, now });
    this.limits = o.limits ?? memoryLimits(now);
    this.frameLimits = new RateLimiter(now);
    this.ipSalt = this.limits.salt('relay-ip');
    this.limitSalt = this.limits.idSalt('relay-limit');
    this.routes();
  }

  private async limit(key: string, n: number, windowMs: number): Promise<void> {
    const h = await this.limits.limiter.hit(key, n, windowMs);
    if (!h.ok) fail('policy.rate_limited', { retryAfterSec: h.retryAfterSec });
  }

  private device(ctx: { method: string; path: string; headers: Ctx['headers'] }): Promise<DeviceClaims> {
    return this.auth.check(ctx, 'relay', 'relay.unauthorized', 'relay.device_suspended');
  }

  /** 우편함 토큰. 실패는 IP(일 회전 HMAC)당 10분 20회까지만(넘으면 맞는 토큰도 창이 끝날 때까지 거부). */
  private async mailbox(ip: string, mbxId: string, token: unknown, which: 'read' | 'write'): Promise<string> {
    const k = `authf:${await this.ipSalt.hash(ip)}`;
    const f = await this.limits.limiter.count(k, RELAY.authFailureWindowMs);
    if (f.n >= RELAY.authFailuresPerIp) fail('policy.rate_limited', { retryAfterSec: f.retryAfterSec });
    try {
      return await this.o.svc.auth(mbxId, token, which);
    } catch (e) {
      // 토큰 추측(우편함 없음·토큰 틀림)만 센다. DB 장애 같은 다른 실패를 세면 정상 토큰이 10분간 막힌다
      if (e instanceof ServiceError && e.code === 'relay.mailbox_not_found') await this.limits.limiter.hit(k, RELAY.authFailuresPerIp, RELAY.authFailureWindowMs);
      throw e;
    }
  }

  /** 주기 정리(만료된 한도 창) */
  async sweep(): Promise<void> {
    await this.limits.limiter.sweep();
  }

  private routes(): void {
    const r = this.router;
    const { svc } = this.o;
    const tok = (ctx: Ctx, h: 'x-mbx-read' | 'x-mbx-write') => {
      const v = ctx.headers[h];
      return Array.isArray(v) ? undefined : v;
    };

    r.add('POST', '/v1/mailboxes', async (ctx) => {
      const c = await this.device(ctx);
      if (c.role !== 'desktop') fail('account.scope_denied');
      await svc.createMailbox(c.dev, V.mailbox(ctx.body));
      return json(201, { ok: true });
    });
    r.add('DELETE', '/v1/mailboxes/:id', async (ctx) => {
      const c = await this.device(ctx);
      if (c.role !== 'desktop') fail('account.scope_denied');
      const key = await this.mailbox(ctx.ip, ctx.params.id!, tok(ctx, 'x-mbx-write'), 'write');
      await svc.deleteMailbox(c.dev, key);
      this.closeMailbox(key, CLOSE.gone);
      return json(204, undefined);
    });
    // 오프라인 의도 봉투: 폰이 넣고(쓰기 토큰) PC가 꺼낸다(읽기 토큰)
    r.add(
      'POST',
      '/v1/mailboxes/:id/envelopes',
      async (ctx) => {
        const c = await this.device(ctx);
        if (c.role !== 'mobile') fail('account.scope_denied');
        const env = V.envelope(ctx.body);
        const key = await this.mailbox(ctx.ip, ctx.params.id!, tok(ctx, 'x-mbx-write'), 'write');
        await this.limit(`mbx:${key}`, RELAY.msgPerSecPerMailbox, 1000);
        const out = await svc.enqueue(key, env);
        this.mailboxes.get(key)?.d?.ws.send(JSON.stringify({ t: 'env' }));
        return json(202, out);
      },
      { maxBodyBytes: RELAY.envelopeCtMax + 4096 },
    );
    r.add('GET', '/v1/mailboxes/:id/envelopes', async (ctx) => {
      const c = await this.device(ctx);
      if (c.role !== 'desktop') fail('account.scope_denied');
      const key = await this.mailbox(ctx.ip, ctx.params.id!, tok(ctx, 'x-mbx-read'), 'read');
      return json(200, { envelopes: await svc.list(key) });
    });
    r.add('POST', '/v1/mailboxes/:id/ack', async (ctx) => {
      const c = await this.device(ctx);
      if (c.role !== 'desktop') fail('account.scope_denied');
      const { seq } = V.ack(ctx.body);
      const key = await this.mailbox(ctx.ip, ctx.params.id!, tok(ctx, 'x-mbx-read'), 'read');
      return json(200, { deleted: await svc.ack(key, seq) });
    });
    // 우편함 번들 슬롯: PC가 게시(쓰기), 폰이 읽기
    r.add('PUT', '/v1/mailboxes/:id/bundle', async (ctx) => {
      const c = await this.device(ctx);
      if (c.role !== 'desktop') fail('account.scope_denied');
      const { bundle } = V.bundle(ctx.body);
      const key = await this.mailbox(ctx.ip, ctx.params.id!, tok(ctx, 'x-mbx-write'), 'write');
      await svc.putBundle(key, Buffer.from(bundle, 'base64'));
      return json(204, undefined);
    });
    r.add('GET', '/v1/mailboxes/:id/bundle', async (ctx) => {
      await this.device(ctx);
      const key = await this.mailbox(ctx.ip, ctx.params.id!, tok(ctx, 'x-mbx-read'), 'read');
      const b = await svc.getBundle(key);
      if (!b) fail('relay.mailbox_not_found');
      return json(200, { bundle: b!.toString('base64') });
    });
    // 1회용 페어링 룸. 레코드(메모리)에 계정 없음. 계정당 시간당 5회는 한도 카운터(당일 솔트 HMAC 키)
    r.add('POST', '/v1/rooms', async (ctx) => {
      if (this.o.rooms === false) fail('request.not_found');
      const c = await this.device(ctx);
      if (c.role !== 'desktop') fail('account.scope_denied');
      const { roomId } = V.room(ctx.body);
      await this.limit(`room:${await this.limitSalt.hash(c.acc)}`, RELAY.roomsPerAccountHour, 3600_000);
      if (this.rooms.has(roomId)) fail('request.param_rejected');
      const expires = svc.now() + RELAY.roomTtlMs;
      const timer = setTimeout(() => this.closeRoom(roomId), RELAY.roomTtlMs);
      timer.unref();
      this.rooms.set(roomId, { conns: [], expires, timer, owner: sha256hex(c.dev), paired: false, redeemed: false });
      return json(201, { expiresAt: expires });
    });
    // 계정 서비스의 긴급 정지·폐기 훅: 그 기기의 라이브 연결을 즉시 끊는다. 이후 연결·호출은 기기 상태 확인에서 막힌다.
    r.add(
      'POST',
      '/internal/v1/devices/:id/stopped',
      async (ctx) => {
        await this.o.internal.check(ctx);
        this.o.directory.invalidate?.(ctx.params.id!);
        return json(200, { closed: this.stopDevice(ctx.params.id!) });
      },
      { raw: true },
    );
    // 계정 서비스의 폰 대리 등록(페어링 7단계): 이 PC가 만든 룸에 폰이 붙었고 아직 쓰지 않았으면 한 번만 소비한다.
    // 없음·만료·미페어링·다른 PC·이미 소비는 모두 같은 404(존재 오라클 없음)
    r.add(
      'POST',
      '/internal/v1/rooms/:id/redeem',
      async (ctx) => {
      await this.o.internal.check(ctx);
      const { deviceId } = V.redeem(ctx.body);
      const room = this.rooms.get(ctx.params.id!);
      if (!room || room.expires <= svc.now() || !room.paired || !safeEqual(room.owner, sha256hex(deviceId))) fail('relay.room_unavailable');
      // 룸 하나에 enroll 성공은 한 번(같은 키 재등록 200 포함). 룸 자체는 PAIR_OK·연결 종료까지 그대로 둔다. 409는 그 룸을 만든 PC에만 보인다
      if (room!.redeemed) fail('relay.room_used');
      room!.redeemed = true;
      return json(200, { ok: true });
      },
      { raw: true },
    );
    r.add(
      'POST',
      '/internal/v1/queues/purge',
      async (ctx) => {
        await this.o.internal.check(ctx);
        return json(200, { deleted: await svc.purgeQueues() });
      },
      { raw: true },
    );
    r.add('GET', '/healthz', () => json(200, { ok: true }));
  }

  /** 서버에 업그레이드 처리기를 붙인다. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
      const started = this.o.svc.now();
      const url = new URL(req.url ?? '/', 'http://relay.invalid');
      const done = (route: string, status: number, code = '') => this.o.logger.access({ m: 'GET', route, status, code, bytesIn: 0, bytesOut: 0, ms: this.o.svc.now() - started });
      const ip = clientIp(req, this.o.trustProxy ?? false);
      const mbx = /^\/v1\/mailboxes\/([A-Za-z0-9_-]{43})\/live$/.exec(url.pathname);
      const room = /^\/v1\/rooms\/([A-Za-z0-9_-]{22})$/.exec(url.pathname);
      const route = mbx ? '/v1/mailboxes/:id/live' : room ? '/v1/rooms/:id' : '-';
      const reject = (e: unknown) => {
        const code = e instanceof ServiceError ? e.code : 'server.internal';
        const status = e instanceof ServiceError ? e.status : 500;
        rejectUpgrade(socket, status, code);
        done(route, status, code);
      };
      socket.on('error', () => undefined);
      void (async () => {
        try {
          await this.limit(`up:${await this.ipSalt.hash(ip)}`, RELAY.attemptsPerIpMinute, 60_000);
          if (mbx && this.o.live !== false) await this.joinMailbox(req, socket, ip, mbx[1]!, url.pathname);
          else if (room && this.o.rooms !== false) this.joinRoom(req, socket, room[1]!);
          else throw new ServiceError('request.not_found');
          done(route, 101);
        } catch (e) {
          reject(e);
        }
      })();
    });
  }

  private async joinMailbox(req: IncomingMessage, socket: Duplex, ip: string, mbxId: string, path: string): Promise<void> {
    const c = await this.device({ method: 'GET', path, headers: req.headers });
    const h = (n: string) => (Array.isArray(req.headers[n]) ? undefined : req.headers[n]);
    const key = await this.mailbox(ip, mbxId, h('x-mbx-read'), 'read');
    await this.mailbox(ip, mbxId, h('x-mbx-write'), 'write');
    if (!acceptUpgrade(req, socket)) return;
    const side: Side = c.role === 'desktop' ? 'd' : 'm';
    const ws = new WsConn(socket, { maxPayload: RELAY.frameMax, idleMs: RELAY.idleMs });
    const me: Live = { ws, deviceId: c.dev, side, fails: 0 };
    const slot = this.mailboxes.get(key) ?? {};
    slot[side]?.ws.close(CLOSE.replaced); // 같은 쪽 새 연결이 옛 연결을 대신한다
    slot[side] = me;
    this.mailboxes.set(key, slot);
    const other = () => this.mailboxes.get(key)?.[side === 'd' ? 'm' : 'd'];
    // 기기 범위 토큰 만료 때 끊는다(재연결 때 다시 인증 = 긴급 정지·폐기가 늦어도 15분 안에 반영)
    const exp = setTimeout(() => ws.close(CLOSE.gone), Math.max(0, c.exp - this.o.svc.now()));
    exp.unref();
    ws.on({
      onMessage: (data, text) => {
        const kind = text ? null : outerOk(data);
        if (!kind) {
          if (++me.fails >= RELAY.failuresPerConnection) ws.close(CLOSE.policy);
          return;
        }
        if (!this.frameLimits.hit(`mbx:${key}`, RELAY.msgPerSecPerMailbox, 1000)) return; // 초과분은 드롭(프로토콜이 재전송)
        void this.o.svc.stat(kind, data.length).catch(() => undefined);
        other()?.ws.send(data);
      },
      onClose: () => {
        clearTimeout(exp);
        const s = this.mailboxes.get(key);
        if (s?.[side] === me) {
          delete s[side];
          if (!s.d && !s.m) this.mailboxes.delete(key);
          else other()?.ws.send(JSON.stringify({ t: 'peer', online: false }));
        }
      },
    });
    const o = other();
    ws.send(JSON.stringify({ t: 'peer', online: !!o }));
    o?.ws.send(JSON.stringify({ t: 'peer', online: true }));
    if (side === 'd' && (await this.o.svc.list(key)).length) ws.send(JSON.stringify({ t: 'env' }));
  }

  private joinRoom(req: IncomingMessage, socket: Duplex, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.expires <= this.o.svc.now() || room.conns.length >= 2) fail('relay.room_unavailable');
    if (!acceptUpgrade(req, socket)) return;
    const ws = new WsConn(socket, { maxPayload: RELAY.frameMax, idleMs: RELAY.roomTtlMs });
    room!.conns.push(ws);
    if (room!.conns.length === 2) room!.paired = true;
    let fails = 0;
    ws.on({
      onMessage: (data, text) => {
        const kind = text ? null : outerOk(data);
        if (!kind) {
          if (++fails >= RELAY.failuresPerConnection) this.closeRoom(roomId);
          return;
        }
        if (!this.frameLimits.hit(`room:${roomId}`, RELAY.msgPerSecPerMailbox, 1000)) return;
        for (const c of room!.conns) if (c !== ws) c.send(data);
      },
      // 1회용: 어느 한쪽이 나가면 룸을 폐기한다(재참가 없음)
      onClose: () => this.closeRoom(roomId),
    });
  }

  private closeRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.rooms.delete(roomId);
    clearTimeout(room.timer);
    for (const c of room.conns) c.close(CLOSE.gone);
  }

  private closeMailbox(key: string, code: number): void {
    const s = this.mailboxes.get(key);
    s?.d?.ws.close(code);
    s?.m?.ws.close(code);
  }

  stopDevice(deviceId: string): number {
    let n = 0;
    for (const s of this.mailboxes.values()) {
      for (const side of ['d', 'm'] as const) {
        if (s[side]?.deviceId === deviceId) {
          s[side]!.ws.close(CLOSE.gone);
          n++;
        }
      }
    }
    return n;
  }

  /** 시험·종료용 */
  closeAll(): void {
    for (const k of [...this.mailboxes.keys()]) this.closeMailbox(k, CLOSE.normal);
    for (const k of [...this.rooms.keys()]) this.closeRoom(k);
  }
}

export const newRoomId = (): string => randomBytes(16).toString('base64url');
export { raw32 };
