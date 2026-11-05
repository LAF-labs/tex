// M7-3 릴레이·푸시(D08 §4.2·§7·§8·§8.1·§9.3, D09 §4·§4.2·§10). 계정 서비스가 실제로 발급한 기기 범위 토큰으로 붙는다. 푸시 공급사는 모의.
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FORBIDDEN_COLUMN, Logger, createServer, listen, looksSensitive, migrate, openSqlite, schemaColumns, type Sql } from '../services/shared/src/index.ts';
import { MIGRATIONS_DIR as RELAY_MIGRATIONS, OUTER, RELAY, RELAY_VISIBILITY, RelayHub, RelayService, newRoomId } from '../services/relay/src/index.ts';
import { ApnsSender, FcmSender, MIGRATIONS_DIR as PUSH_MIGRATIONS, MockPushSender, PUSH_VISIBILITY, PushService, WAKE, pushRouter } from '../services/push/src/index.ts';
import { D, H, client } from './services-kit.ts';
import { accountStack, signedDesktop, signedPhone, type Signed, type Stack } from './services-stack.ts';

const RO = 'https://relay.test.invalid';
const PO = 'https://push.test.invalid';

type Who = Pick<Signed, 'token' | 'headers'>;

interface Env {
  s: Stack;
  db: Sql;
  pushDb: Sql;
  svc: RelayService;
  hub: RelayHub;
  relay: Server;
  push: Server;
  sender: MockPushSender;
  r: ReturnType<typeof client>;
  p: ReturnType<typeof client>;
  wsBase: string;
  logs: string[];
  pc: Signed;
  phone: Who & { id: string };
  call(who: Who, method: string, path: string, o?: { body?: unknown; headers?: Record<string, string> }): ReturnType<Env['r']>;
  pcall(who: Who, method: string, path: string, body?: unknown): ReturnType<Env['p']>;
  wsHeaders(who: Who, path: string, extra?: Record<string, string>): Promise<Record<string, string>>;
}

/** 기기 토큰 캐시(계정 서비스 발급 한도 60회/시를 시험이 태우지 않게). 시계가 10분 넘게 가면 새로 받는다. */
function cached(who: Who, s: Stack): Who {
  let t: { token: string; at: number } | null = null;
  return {
    token: async () => {
      if (!t || s.clock.now() - t.at > 10 * 60_000) t = { token: await who.token(), at: s.clock.now() };
      return t.token;
    },
    headers: who.headers,
  };
}

async function start(): Promise<Env> {
  const s = await accountStack();
  const db = openSqlite();
  await migrate(db, 'relay', RELAY_MIGRATIONS);
  const pushDb = openSqlite();
  await migrate(pushDb, 'push', PUSH_MIGRATIONS);
  const logs: string[] = [];
  const logger = new Logger('relay', (l) => logs.push(l), s.clock.now);
  const svc = new RelayService({ db, queueKey: randomBytes(32), now: s.clock.now });
  const hub = new RelayHub({ svc, verifier: s.verifier, directory: s.directory, publicOrigin: RO, internalSecret: 'internal-test', logger });
  const relay = createServer(hub.router, { logger });
  hub.attach(relay);
  const rbase = await listen(relay);
  const sender = new MockPushSender();
  const psvc = new PushService({ db: pushDb, tokenKey: randomBytes(32), sender, now: s.clock.now });
  const push = createServer(pushRouter({ svc: psvc, verifier: s.verifier, directory: s.directory, publicOrigin: PO, internalSecret: 'internal-test' }), { logger: new Logger('push', (l) => logs.push(l), s.clock.now) });
  const pbase = await listen(push);
  const r = client(rbase);
  const p = client(pbase);
  // 계정 서비스의 정지 훅 → 릴레이·푸시 내부 API(운영과 같은 HTTP 경로)
  for (const base of [rbase, pbase]) s.hooks.push({ stopped: async (id) => void (await client(base)('POST', `/internal/v1/devices/${id}/stopped`, { headers: { authorization: 'Internal internal-test' } })) });
  const pc0 = await signedDesktop(s, 'relay@example.com');
  const pc = { ...pc0, ...cached(pc0, s) };
  const ph = await signedPhone(s, pc0);
  const phone = { ...cached(ph, s), id: ph.d.id };
  return {
    s,
    db,
    pushDb,
    svc,
    hub,
    relay,
    push,
    sender,
    r,
    p,
    wsBase: rbase.replace('http://', 'ws://'),
    logs,
    pc,
    phone,
    call: async (who, method, path, o = {}) => r(method, path, { headers: { ...who.headers(method, RO, path, await who.token()), ...(o.headers ?? {}) }, body: o.body }),
    pcall: async (who, method, path, body) => p(method, path, { headers: who.headers(method, PO, path, await who.token()), body }),
    wsHeaders: async (who, path, extra = {}) => ({ ...who.headers('GET', RO, path, await who.token()), ...extra }),
  };
}

const stop = (e: Env) => {
  e.hub.closeAll();
  e.relay.close();
  e.push.close();
  e.s.close();
};

const id32 = () => randomBytes(32).toString('base64url');
const newMailbox = () => ({ mbxId: id32(), tokRead: id32(), tokWrite: id32() });
const envelope = () => ({ v: 1, kind: 'ENV', enc: randomBytes(32).toString('base64'), ct: randomBytes(600).toString('base64') });
const hs = (n: number) => {
  const b = Buffer.alloc(4 + n);
  b[0] = OUTER.ver;
  b[1] = OUTER.HS;
  b.writeUInt16BE(n, 2);
  randomBytes(n).copy(b, 4);
  return b;
};
const data = (n: number) => {
  const b = Buffer.alloc(12 + n);
  b[0] = OUTER.ver;
  b[1] = OUTER.DATA;
  b.writeBigUInt64BE(1n, 2);
  b.writeUInt16BE(n, 10);
  randomBytes(n).copy(b, 12);
  return b;
};

interface Sock {
  ws: WebSocket;
  msgs: Array<Buffer | Record<string, unknown>>;
  closed: Promise<void>;
  next(pred?: (m: Buffer | Record<string, unknown>) => boolean): Promise<Buffer | Record<string, unknown>>;
}

/** WebSocket 연결. 열리면 Sock, 업그레이드가 거절되면 null. */
async function open(url: string, headers: Record<string, string> = {}): Promise<Sock | null> {
  const ws = new WebSocket(url, { headers } as never);
  ws.binaryType = 'arraybuffer';
  const msgs: Sock['msgs'] = [];
  const waiters: Array<() => void> = [];
  ws.onmessage = (ev) => {
    msgs.push(typeof ev.data === 'string' ? (JSON.parse(ev.data) as Record<string, unknown>) : Buffer.from(ev.data as ArrayBuffer));
    for (const w of waiters.splice(0)) w();
  };
  const closed = new Promise<void>((res) => ws.addEventListener('close', () => res()));
  const ok = await new Promise<boolean>((res) => {
    ws.onopen = () => res(true);
    ws.onerror = () => res(false);
  });
  if (!ok) return null;
  let cursor = 0;
  const next: Sock['next'] = async (pred = () => true) => {
    for (;;) {
      while (cursor < msgs.length) {
        const m = msgs[cursor++]!;
        if (pred(m)) return m;
      }
      await Promise.race([new Promise<void>((r) => waiters.push(r)), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]);
    }
  };
  return { ws, msgs, closed, next };
}

const isPeer = (m: Buffer | Record<string, unknown>) => !Buffer.isBuffer(m) && m.t === 'peer';

describe('M7-3 릴레이: 우편함 등록·능력 토큰·기기 토큰', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => stop(e));

  it('PC가 만든 난수 ID·토큰을 등록, 서버에는 해시만. 기기당 3개, 폰·계정 세션은 등록 불가', async () => {
    const m = newMailbox();
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m })).status, 201);
    const rows = await e.db.all<Record<string, unknown>>('SELECT * FROM mailboxes');
    const dump = JSON.stringify(rows);
    for (const v of Object.values(m)) {
      assert.ok(!dump.includes(v), 'ID·토큰 원문이 DB에 없다');
      assert.ok(!dump.includes(Buffer.from(v, 'base64url').toString('hex')));
    }
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m })).json.error, 'request.param_rejected');
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: { ...newMailbox(), tokWrite: m.tokRead } })).status, 201);
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: newMailbox() })).status, 201);
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: newMailbox() })).json.error, 'relay.mailbox_limit');
    assert.equal((await e.call(e.phone, 'POST', '/v1/mailboxes', { body: newMailbox() })).json.error, 'account.scope_denied');
    assert.equal((await e.r('POST', '/v1/mailboxes', { headers: { authorization: `Bearer ${e.pc.session}` }, body: newMailbox() })).json.error, 'relay.unauthorized');
    const x = newMailbox();
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: { ...x, tokRead: x.mbxId } })).json.error, 'request.param_rejected');
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: { ...x, extra: 1 } })).json.error, 'request.param_rejected');
    // 삭제하면 개수가 돌아온다(재발급 mbx.reissue)
    assert.equal((await e.call(e.pc, 'DELETE', `/v1/mailboxes/${m.mbxId}`, { headers: { 'x-mbx-write': m.tokRead } })).json.error, 'relay.mailbox_not_found');
    assert.equal((await e.call(e.pc, 'DELETE', `/v1/mailboxes/${m.mbxId}`, { headers: { 'x-mbx-write': m.tokWrite } })).status, 204);
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: newMailbox() })).status, 201);
  });

  it('토큰이 틀리면 우편함이 없을 때와 같은 응답, IP당 10분 20회 실패 뒤에는 맞는 토큰도 거부', async () => {
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    const none = await e.call(e.pc, 'GET', `/v1/mailboxes/${id32()}/envelopes`, { headers: { 'x-mbx-read': m.tokRead } });
    const wrong = await e.call(e.pc, 'GET', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-read': m.tokWrite } });
    assert.deepEqual([none.status, none.json], [wrong.status, wrong.json]);
    assert.deepEqual(wrong.json, { error: 'relay.mailbox_not_found' });
    for (let i = 2; i < RELAY.authFailuresPerIp; i++) await e.call(e.pc, 'GET', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-read': id32() } });
    assert.equal((await e.call(e.pc, 'GET', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-read': m.tokRead } })).json.error, 'policy.rate_limited');
    e.s.clock.advance(RELAY.authFailureWindowMs);
    assert.equal((await e.call(e.pc, 'GET', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-read': m.tokRead } })).status, 200);
  });
});

describe('M7-3 릴레이: 오프라인 의도 봉투 큐(72시간·5건·ACK)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => stop(e));

  it('폰이 쓰기 토큰으로 넣고 PC가 읽기 토큰으로 꺼낸 뒤 ACK로 지운다. 바깥 {v, kind, enc, ct}만 받는다', async () => {
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    const path = `/v1/mailboxes/${m.mbxId}/envelopes`;
    const env1 = envelope();
    const put = await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: env1 });
    assert.equal(put.status, 202, put.text);
    assert.deepEqual(put.json, { seq: 1 });
    assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokRead }, body: envelope() })).json.error, 'relay.mailbox_not_found');
    assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: { ...envelope(), pair_id: 'x' } })).json.error, 'request.param_rejected');
    assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: { ...envelope(), kind: 'DATA' } })).json.error, 'request.param_rejected');
    assert.equal((await e.call(e.phone, 'GET', path, { headers: { 'x-mbx-read': m.tokRead } })).json.error, 'account.scope_denied');
    assert.equal((await e.call(e.pc, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).json.error, 'account.scope_denied');
    const got = await e.call(e.pc, 'GET', path, { headers: { 'x-mbx-read': m.tokRead } });
    assert.deepEqual(got.json, { envelopes: [{ seq: 1, env: env1 }] });
    // 저장은 봉인본: 암호문 원문도 DB에 그대로 있지 않다
    const raw = await e.db.all<{ sealed: Buffer }>('SELECT sealed FROM queue');
    assert.ok(!raw[0]!.sealed.toString('latin1').includes(env1.ct.slice(0, 40)));
    for (let i = 0; i < 4; i++) assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).status, 202);
    assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).json.error, 'relay.queue_full');
    assert.deepEqual((await e.call(e.pc, 'POST', `/v1/mailboxes/${m.mbxId}/ack`, { headers: { 'x-mbx-read': m.tokRead }, body: { seq: 3 } })).json, { deleted: 3 });
    assert.deepEqual(((await e.call(e.pc, 'GET', path, { headers: { 'x-mbx-read': m.tokRead } })).json.envelopes as Array<{ seq: number }>).map((x) => x.seq), [4, 5]);
    // 72시간 만료
    e.s.clock.advance(72 * H);
    assert.deepEqual((await e.call(e.pc, 'GET', path, { headers: { 'x-mbx-read': m.tokRead } })).json, { envelopes: [] });
    await e.svc.sweep();
    assert.equal((await e.db.all('SELECT seq FROM queue')).length, 0);
    assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).json.seq, 6);
  });

  it('우편함 번들 슬롯: PC가 게시하고 폰이 읽는다. 큐 전면 폐기는 내부 API', async () => {
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    const bundle = randomBytes(300).toString('base64');
    assert.equal((await e.call(e.phone, 'PUT', `/v1/mailboxes/${m.mbxId}/bundle`, { headers: { 'x-mbx-write': m.tokWrite }, body: { bundle } })).json.error, 'account.scope_denied');
    assert.equal((await e.call(e.pc, 'PUT', `/v1/mailboxes/${m.mbxId}/bundle`, { headers: { 'x-mbx-write': m.tokWrite }, body: { bundle } })).status, 204);
    assert.deepEqual((await e.call(e.phone, 'GET', `/v1/mailboxes/${m.mbxId}/bundle`, { headers: { 'x-mbx-read': m.tokRead } })).json, { bundle });
    await e.call(e.phone, 'POST', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() });
    assert.equal((await e.r('POST', '/internal/v1/queues/purge')).json.error, 'account.unauthorized');
    assert.deepEqual((await e.r('POST', '/internal/v1/queues/purge', { headers: { authorization: 'Internal internal-test' } })).json, { deleted: 1 });
  });
});

describe('M7-3 릴레이: 라이브 우편함(WSS)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => stop(e));

  async function live(m: ReturnType<typeof newMailbox>, who: Who) {
    const path = `/v1/mailboxes/${m.mbxId}/live`;
    return open(e.wsBase + path, await e.wsHeaders(who, path, { 'x-mbx-read': m.tokRead, 'x-mbx-write': m.tokWrite }));
  }

  it('PC·폰이 붙으면 상대 온라인 알림, HS·DATA 프레임만 상대에게 그대로, 형식이 틀린 프레임 5번이면 끊는다', async () => {
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    const pc = (await live(m, e.pc))!;
    assert.deepEqual(await pc.next(isPeer), { t: 'peer', online: false });
    const ph = (await live(m, e.phone))!;
    assert.deepEqual(await ph.next(isPeer), { t: 'peer', online: true });
    assert.deepEqual(await pc.next(isPeer), { t: 'peer', online: true });
    const f1 = hs(48);
    ph.ws.send(f1);
    assert.deepEqual(await pc.next(Buffer.isBuffer), f1);
    const f2 = data(1000);
    pc.ws.send(f2);
    assert.deepEqual(await ph.next(Buffer.isBuffer), f2);
    // 폰이 의도 봉투를 넣으면 붙어 있는 PC에 내용 없이 알린다
    await e.call(e.phone, 'POST', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() });
    assert.deepEqual(await pc.next((x) => !Buffer.isBuffer(x) && x.t === 'env'), { t: 'env' });
    // 틀린 버전·ENV kind·길이 불일치·텍스트는 전달하지 않고 센다
    const bad = [Buffer.from([2, 1, 0, 0]), Buffer.from([1, 3, 0, 0]), Buffer.concat([hs(10).subarray(0, 4), randomBytes(3)])];
    for (const b of bad) ph.ws.send(b);
    ph.ws.send('hello');
    ph.ws.send(Buffer.from([9]));
    await ph.closed;
    assert.ok(pc.msgs.filter(Buffer.isBuffer).length === 1, '형식이 틀린 프레임은 전달되지 않았다');
    assert.deepEqual(await pc.next(isPeer), { t: 'peer', online: false });
    const stats = await e.db.all<{ kind: string; size_bucket: number; n: number }>('SELECT kind, size_bucket, n FROM relay_stats ORDER BY kind');
    assert.deepEqual(stats.map((s) => [s.kind, Number(s.size_bucket), Number(s.n)]), [['DATA', 1024, 1], ['ENV', 1024, 1], ['HS', 256, 1]]);
    pc.ws.close();
  });

  it('프레임 65,535B 초과면 끊고, 토큰이 하나라도 없으면 업그레이드 거절, 같은 쪽 새 연결이 옛 연결을 대신한다', async () => {
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    const path = `/v1/mailboxes/${m.mbxId}/live`;
    assert.equal(await open(e.wsBase + path, await e.wsHeaders(e.phone, path, { 'x-mbx-read': m.tokRead })), null);
    assert.equal(await open(e.wsBase + path, { 'x-mbx-read': m.tokRead, 'x-mbx-write': m.tokWrite }), null);
    assert.equal(await open(e.wsBase + `/v1/mailboxes/${id32()}/live`, await e.wsHeaders(e.phone, `/v1/mailboxes/${id32()}/live`, { 'x-mbx-read': m.tokRead, 'x-mbx-write': m.tokWrite })), null);
    const a = (await live(m, e.phone))!;
    const b = (await live(m, e.phone))!;
    await a.closed;
    b.ws.send(Buffer.alloc(RELAY.frameMax + 1, 1));
    await b.closed;
  });

  it('계정 웹 긴급 정지: 폰의 라이브 연결이 즉시 끊기고 우편함·푸시 호출이 막힌다', async () => {
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    assert.equal((await e.pcall(e.phone, 'PUT', '/v1/push-token', { platform: 'apns', token: 'a'.repeat(64) })).status, 204);
    const ph = (await live(m, e.phone))!;
    const pc = (await live(m, e.pc))!;
    const s = await e.s.req('POST', `/v1/devices/${e.phone.id}/suspend`, { headers: { authorization: `Bearer ${e.pc.session}` } });
    assert.equal(s.status, 204, s.text);
    await ph.closed;
    assert.deepEqual(await pc.next((x) => isPeer(x) && x.online === false), { t: 'peer', online: false });
    assert.equal((await e.call(e.phone, 'POST', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).json.error, 'relay.device_suspended');
    const path = `/v1/mailboxes/${m.mbxId}/live`;
    assert.equal(await open(e.wsBase + path, await e.wsHeaders(e.phone, path, { 'x-mbx-read': m.tokRead, 'x-mbx-write': m.tokWrite })), null);
    assert.equal((await e.pushDb.all('SELECT device_id FROM push_tokens')).length, 0, '푸시 토큰 즉시 삭제');
    assert.equal((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id })).json.error, 'push.target_not_found');
    pc.ws.close();
  });
});

describe('M7-3 릴레이: 1회용 페어링 룸(정원 2·120초·계정 없음)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => stop(e));

  it('PC가 발급, 둘만 참가, 프레임 중계, 한쪽이 나가면 폐기되어 다시 들어갈 수 없다', async () => {
    const roomId = newRoomId();
    assert.equal((await e.call(e.phone, 'POST', '/v1/rooms', { body: { roomId } })).json.error, 'account.scope_denied');
    const c = await e.call(e.pc, 'POST', '/v1/rooms', { body: { roomId } });
    assert.equal(c.status, 201);
    assert.equal(c.json.expiresAt, e.s.clock.now() + 120_000);
    const url = `${e.wsBase}/v1/rooms/${roomId}`;
    const a = (await open(url))!;
    const b = (await open(url))!;
    assert.equal(await open(url), null, '정원 2');
    const f = hs(96);
    b.ws.send(f);
    assert.deepEqual(await a.next(), f);
    a.ws.close();
    await b.closed;
    assert.equal(await open(url), null, '1회용');
  });

  it('120초가 지나면 참가할 수 없고, 계정당 시간당 5개', async () => {
    const roomId = newRoomId();
    await e.call(e.pc, 'POST', '/v1/rooms', { body: { roomId } });
    e.s.clock.advance(120_000);
    assert.equal(await open(`${e.wsBase}/v1/rooms/${roomId}`), null);
    for (let i = 0; i < 4; i++) assert.equal((await e.call(e.pc, 'POST', '/v1/rooms', { body: { roomId: newRoomId() } })).status, 201);
    assert.equal((await e.call(e.pc, 'POST', '/v1/rooms', { body: { roomId: newRoomId() } })).json.error, 'policy.rate_limited');
  });
});

describe('M7-3 푸시: 내용 없는 깨우기(/v1/wake)', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => stop(e));

  it('폰이 자기 토큰을 올리고(봉인 저장) PC가 같은 계정의 폰만 깨운다. 기기당 분당 3회·시간당 20회', async () => {
    const tok = 'b'.repeat(64);
    assert.equal((await e.pcall(e.phone, 'PUT', '/v1/push-token', { platform: 'apns', token: 'xyz' })).json.error, 'request.param_rejected');
    assert.equal((await e.pcall(e.phone, 'PUT', '/v1/push-token', { platform: 'apns', token: 'Z'.repeat(64) })).json.error, 'request.param_rejected');
    assert.equal((await e.pcall(e.pc, 'PUT', '/v1/push-token', { platform: 'apns', token: tok })).json.error, 'account.scope_denied');
    assert.equal((await e.pcall(e.phone, 'PUT', '/v1/push-token', { platform: 'apns', token: tok })).status, 204);
    const stored = await e.pushDb.all<{ sealed_token: Buffer }>('SELECT sealed_token FROM push_tokens');
    assert.ok(!stored[0]!.sealed_token.toString('latin1').includes(tok.slice(0, 16)), '푸시 토큰은 봉인 저장');
    assert.equal((await e.pcall(e.phone, 'POST', '/v1/wake', { deviceId: e.phone.id })).json.error, 'account.scope_denied');
    assert.equal((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.pc.d.id })).json.error, 'push.target_not_found');
    for (let i = 0; i < 3; i++) assert.deepEqual((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id })).json, { sent: true });
    assert.equal((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id })).json.error, 'policy.rate_limited');
    assert.deepEqual(e.sender.sent, Array.from({ length: 3 }, () => ({ platform: 'apns', token: tok })));
    let sent = 3;
    for (let m = 1; sent < 20; m++) {
      e.s.clock.advance(61_000);
      for (let i = 0; i < 3 && sent < 20; i++, sent++) assert.equal((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id })).status, 202);
    }
    e.s.clock.advance(61_000);
    assert.equal((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id })).json.error, 'policy.rate_limited');
    // 다른 계정의 PC는 이 폰을 깨울 수 없다(없는 기기와 같은 응답)
    const other = await signedDesktop(e.s, 'other@example.com');
    assert.equal((await e.pcall(other, 'POST', '/v1/wake', { deviceId: e.phone.id })).json.error, 'push.target_not_found');
  });

  it('공급사가 토큰 무효를 알리면 지우고, 일시 장애는 sent:false, 폰이 해제하면 삭제', async () => {
    const tok = 'c'.repeat(64);
    await e.pcall(e.phone, 'PUT', '/v1/push-token', { platform: 'apns', token: tok });
    e.sender.failNext = 1;
    assert.deepEqual((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id })).json, { sent: false });
    e.sender.invalid.add(tok);
    assert.equal((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id })).json.error, 'push.token_not_found');
    assert.equal((await e.pushDb.all('SELECT device_id FROM push_tokens')).length, 0);
    await e.pcall(e.phone, 'PUT', '/v1/push-token', { platform: 'fcm', token: 'f'.repeat(152) });
    assert.equal((await e.pcall(e.phone, 'DELETE', '/v1/push-token')).status, 204);
    assert.equal((await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id })).json.error, 'push.token_not_found');
  });
});

describe('M7-3 푸시 어댑터: 내용 없는 페이로드(APNs 샌드박스·FCM v1 형식)', () => {
  it('APNs: ES256 제공자 토큰·alert 푸시·현지화 키뿐, 410이면 invalid', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const seen: Array<{ headers: http2.IncomingHttpHeaders; body: string }> = [];
    const srv = http2.createServer();
    srv.on('stream', (st, headers) => {
      let body = '';
      st.on('data', (d: Buffer) => (body += d.toString()));
      st.on('end', () => {
        seen.push({ headers, body });
        const path = String(headers[':path']);
        if (path.endsWith('dead'.repeat(16))) st.respond({ ':status': 410 });
        else if (path.endsWith('bad0'.repeat(16))) st.respond({ ':status': 400 });
        else st.respond({ ':status': 200 });
        st.end(path.endsWith('bad0'.repeat(16)) ? JSON.stringify({ reason: seen.length % 2 ? 'BadTopic' : 'BadDeviceToken' }) : undefined);
      });
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as { port: number }).port;
    const s = new ApnsSender({ origin: `http://127.0.0.1:${port}`, teamId: 'TEAM123456', keyId: 'KEY1234567', p8: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, topic: 'dev.sax.app', now: () => Date.UTC(2026, 10, 10) });
    assert.equal(await s.send('apns', 'ab'.repeat(32)), 'ok');
    assert.equal(await s.send('apns', 'dead'.repeat(16)), 'invalid');
    assert.equal(await s.send('apns', 'not-hex'), 'invalid');
    assert.equal(await s.send('apns', 'bad0'.repeat(16)), 'retry', '400 BadTopic(설정 오류)은 토큰을 지우지 않는다');
    assert.equal(await s.send('apns', 'bad0'.repeat(16)), 'invalid', '400 BadDeviceToken은 무효');
    s.close();
    srv.close();
    const h = seen[0]!.headers;
    assert.deepEqual(JSON.parse(seen[0]!.body), WAKE.apns);
    assert.equal(h['apns-push-type'], 'alert');
    assert.equal(h['apns-topic'], 'dev.sax.app');
    assert.equal(h['apns-collapse-id'], 'sax-wake');
    const [hd, cl, sig] = String(h.authorization).replace('bearer ', '').split('.');
    assert.deepEqual(JSON.parse(Buffer.from(hd!, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567' });
    assert.deepEqual(JSON.parse(Buffer.from(cl!, 'base64url').toString()), { iss: 'TEAM123456', iat: Date.UTC(2026, 10, 10) / 1000 });
    assert.ok(createVerify('sha256').update(`${hd}.${cl}`).verify({ key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url')));
  });

  it('FCM: 서비스 계정 JWT → 접근 토큰(캐시) → data 메시지 {t: wake}만, UNREGISTERED면 invalid', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const calls: Array<{ url: string; body: string; auth?: string }> = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body), auth: (init.headers as Record<string, string>).authorization });
      if (url === 'https://oauth.test.invalid/token') return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200 });
      const tok = (JSON.parse(String(init.body)) as { message: { token: string } }).message.token;
      return tok.startsWith('gone') ? new Response('{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}', { status: 404 }) : new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const sa = JSON.stringify({ client_email: 'push@sax.test.invalid', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth.test.invalid/token' });
    const s = new FcmSender({ projectId: 'sax-dev', serviceAccountJson: sa, endpointBase: 'https://fcm.test.invalid', fetchFn });
    assert.equal(await s.send('fcm', 'a'.repeat(152)), 'ok');
    assert.equal(await s.send('fcm', 'gone' + 'a'.repeat(148)), 'invalid');
    assert.equal(calls.filter((c) => c.url.includes('oauth')).length, 1, '접근 토큰 캐시');
    const msg = calls.find((c) => c.url.includes('messages:send'))!;
    assert.equal(msg.url, 'https://fcm.test.invalid/v1/projects/sax-dev/messages:send');
    assert.equal(msg.auth, 'Bearer at-1');
    assert.deepEqual(JSON.parse(msg.body), { message: { token: 'a'.repeat(152), data: { t: 'wake' }, android: { priority: 'HIGH', ttl: '60s', collapse_key: 'sax-wake' } } });
  });
});

describe('M7-3 저장 컬럼(D09 §1.1)·로그', () => {
  it('마이그레이션의 저장 컬럼 = 가시성 표, 금지 컬럼 없음', () => {
    for (const [dir, vis] of [
      [RELAY_MIGRATIONS, RELAY_VISIBILITY],
      [PUSH_MIGRATIONS, PUSH_VISIBILITY],
    ] as const) {
      const cols = schemaColumns(dir);
      assert.deepEqual(Object.fromEntries(Object.entries(cols).map(([t, cs]) => [t, [...cs].sort()])), Object.fromEntries(Object.entries(vis).map(([t, cs]) => [t, Object.keys(cs).sort()])));
      for (const [t, cs] of Object.entries(cols)) for (const c of cs) assert.ok(!FORBIDDEN_COLUMN.test(c), `${t}.${c}`);
    }
  });

  it('접근 로그는 라우트 패턴뿐: 우편함 ID·토큰·룸 ID·IP·계정 식별자 없음', async () => {
    const e = await start();
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    await e.call(e.phone, 'POST', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() });
    const path = `/v1/mailboxes/${m.mbxId}/live`;
    const ws = (await open(e.wsBase + path, await e.wsHeaders(e.pc, path, { 'x-mbx-read': m.tokRead, 'x-mbx-write': m.tokWrite })))!;
    ws.ws.close();
    const roomId = newRoomId();
    await e.call(e.pc, 'POST', '/v1/rooms', { body: { roomId } });
    await open(`${e.wsBase}/v1/rooms/${roomId}`);
    await e.pcall(e.phone, 'PUT', '/v1/push-token', { platform: 'apns', token: 'd'.repeat(64) });
    await e.pcall(e.pc, 'POST', '/v1/wake', { deviceId: e.phone.id });
    stop(e);
    assert.ok(e.logs.some((l) => l.includes('"route":"/v1/mailboxes/:id/live"') && l.includes('"status":101')));
    assert.ok(e.logs.some((l) => l.includes('"route":"/v1/rooms/:id"')));
    for (const l of e.logs) {
      assert.ok(!looksSensitive(l), l);
      for (const v of [m.mbxId, m.tokRead, m.tokWrite, roomId, e.phone.id, '127.0.0.1', 'd'.repeat(64)]) assert.ok(!l.includes(v), l);
      assert.ok(!l.includes('"aid"'), l);
    }
  });
});

void D;
