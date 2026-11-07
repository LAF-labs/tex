// M7-3 릴레이·푸시(D08 §4.2·§7·§8·§8.1·§9.3, D09 §4·§4.2·§10). 계정 서비스가 실제로 발급한 기기 범위 토큰으로 붙는다. 푸시 공급사는 모의.
import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync, randomBytes } from 'node:crypto';
import http2 from 'node:http2';
import type { Server } from 'node:http';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { FORBIDDEN_COLUMN, Logger, createServer, listen, looksSensitive, migrate, openSqlite, schemaColumns, type Sql } from '../services/shared/src/index.ts';
import { MIGRATIONS_DIR as RELAY_MIGRATIONS, OUTER, RELAY, RELAY_VISIBILITY, RelayHub, RelayService, newRoomId } from '../services/relay/src/index.ts';
import { ApnsSender, FcmSender, MIGRATIONS_DIR as PUSH_MIGRATIONS, MockPushSender, PUSH_VISIBILITY, PushService, WAKE, pushRouter } from '../services/push/src/index.ts';
import { D, H, INTERNAL_KEY, client, device, entry, internalAuth, internalHeaders } from './services-kit.ts';
import { DEVICE, httpPairingRooms, httpStopHook } from '../services/account/src/index.ts';
import { ACCOUNT_ORIGIN, accountStack, signedDesktop, signedPhone, type Signed, type Stack } from './services-stack.ts';

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

async function start(flags: { rooms?: boolean; live?: boolean } = {}): Promise<Env> {
  const s = await accountStack();
  const db = openSqlite();
  await migrate(db, 'relay', RELAY_MIGRATIONS);
  const pushDb = openSqlite();
  await migrate(pushDb, 'push', PUSH_MIGRATIONS);
  const logs: string[] = [];
  const logger = new Logger('relay', (l) => logs.push(l), s.clock.now);
  const svc = new RelayService({ db, queueKey: randomBytes(32), now: s.clock.now });
  const hub = new RelayHub({ svc, verifier: s.verifier, directory: s.directory, publicOrigin: RO, internal: internalAuth(), logger, ...flags });
  const relay = createServer(hub.router, { logger });
  hub.attach(relay);
  const rbase = await listen(relay);
  const sender = new MockPushSender();
  const psvc = new PushService({ db: pushDb, tokenKey: randomBytes(32), sender, now: s.clock.now });
  const push = createServer(pushRouter({ svc: psvc, verifier: s.verifier, directory: s.directory, publicOrigin: PO, internal: internalAuth() }), { logger: new Logger('push', (l) => logs.push(l), s.clock.now) });
  const pbase = await listen(push);
  const r = client(rbase);
  const p = client(pbase);
  // 계정 서비스의 정지 훅 → 릴레이·푸시 내부 API(룸 호스트와 같은 서명 HTTP 경로)
  s.pairing.impl = httpPairingRooms(rbase, INTERNAL_KEY);
  for (const base of [rbase, pbase]) s.hooks.push(httpStopHook(base, INTERNAL_KEY));
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
    // DPoP htu = origin + 경로(쿼리 제외, RFC 9449 §4.3)
    call: async (who, method, path, o = {}) => r(method, path, { headers: { ...who.headers(method, RO, path.split('?')[0]!, await who.token()), ...(o.headers ?? {}) }, body: o.body }),
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
    const n = newMailbox();
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: n })).status, 201);
    // 같은 우편함을 동시에 두 번 지워도 개수는 한 번만 줄어든다(한도 우회 없음)
    const del = () => e.call(e.pc, 'DELETE', `/v1/mailboxes/${n.mbxId}`, { headers: { 'x-mbx-write': n.tokWrite } });
    const both = await Promise.all([del(), del(), del()]);
    assert.ok(both.every((r) => r.status === 204 || r.json.error === 'relay.mailbox_not_found'));
    assert.equal((await e.db.one<{ n: number }>('SELECT n FROM mailbox_quota'))!.n, 2);
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: newMailbox() })).status, 201);
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: newMailbox() })).json.error, 'relay.mailbox_limit');
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
    // DB 장애는 토큰 추측으로 세지 않는다(장애가 끝나면 맞는 토큰은 바로 통한다)
    const auth = e.svc.auth.bind(e.svc);
    e.svc.auth = () => Promise.reject(new Error('db down'));
    for (let i = 0; i < RELAY.authFailuresPerIp + 2; i++) assert.equal((await e.call(e.pc, 'GET', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-read': m.tokRead } })).status, 500);
    e.svc.auth = auth;
    assert.equal((await e.call(e.pc, 'GET', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-read': m.tokRead } })).status, 200);
  });
});

describe('M7-3 릴레이: 오프라인 의도 봉투 큐(72시간·160건·6 MiB·ACK)', () => {
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
    assert.deepEqual(got.json, { envelopes: [{ seq: 1, env: env1 }], more: false });
    // 저장은 봉인본: 암호문 원문도 DB에 그대로 있지 않다
    const raw = await e.db.all<{ sealed: Buffer }>('SELECT sealed FROM queue');
    assert.ok(!raw[0]!.sealed.toString('latin1').includes(env1.ct.slice(0, 40)));
    for (let i = 0; i < 4; i++) assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).status, 202);
    for (let i = 5; i < RELAY.queueMaxEnvelopes; i++) {
      e.s.clock.advance(1000); // 우편함당 초당 메시지 한도 밖으로
      assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).status, 202);
    }
    assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).json.error, 'relay.queue_full');
    assert.deepEqual((await e.call(e.pc, 'POST', `/v1/mailboxes/${m.mbxId}/ack`, { headers: { 'x-mbx-read': m.tokRead }, body: { seq: 3 } })).json, { deleted: 3 });
    assert.deepEqual(((await e.call(e.pc, 'GET', path, { headers: { 'x-mbx-read': m.tokRead } })).json.envelopes as Array<{ seq: number }>).map((x) => x.seq), Array.from({ length: RELAY.queueMaxEnvelopes - 3 }, (_, i) => i + 4));
    // 72시간 만료
    e.s.clock.advance(72 * H);
    assert.deepEqual((await e.call(e.pc, 'GET', path, { headers: { 'x-mbx-read': m.tokRead } })).json, { envelopes: [], more: false });
    await e.svc.sweep();
    assert.equal((await e.db.all('SELECT seq FROM queue')).length, 0);
    assert.equal((await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() })).json.seq, RELAY.queueMaxEnvelopes + 1);
  });

  it('큐 크기 한도: ct ≤ 65,536자(종류는 보지 않음), 우편함당 6 MiB면 160건 전에 queue_full', async () => {
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    const path = `/v1/mailboxes/${m.mbxId}/envelopes`;
    const big = (chars: number) => ({ v: 1, kind: 'ENV', enc: randomBytes(32).toString('base64'), ct: 'A'.repeat(chars) });
    const post = (body: unknown) => e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body });
    assert.equal((await post(big(RELAY.envelopeCtMax + 4))).json.error, 'request.param_rejected');
    let n = 0;
    for (;;) {
      e.s.clock.advance(1000);
      const r = await post(big(RELAY.envelopeCtMax));
      if (r.status !== 202) {
        assert.equal(r.json.error, 'relay.queue_full');
        break;
      }
      n++;
    }
    assert.equal(n, Math.floor(RELAY.queueMaxBytes / Buffer.byteLength(JSON.stringify(big(RELAY.envelopeCtMax)))));
    assert.ok(n < RELAY.queueMaxEnvelopes);
  });

  it('큐 GET은 쪽으로 나눈다(Vercel 응답 4.5MB 상한): 3 MiB까지·남으면 more, after로 ACK 전 다음 쪽, 옛 클라이언트(ACK 뒤 다시 읽기)도 전부 받는다', async () => {
    const m = newMailbox();
    await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m });
    const path = `/v1/mailboxes/${m.mbxId}/envelopes`;
    const big = () => ({ v: 1, kind: 'ENV', enc: randomBytes(32).toString('base64'), ct: randomBytes(48_000).toString('base64').slice(0, RELAY.envelopeCtMax) });
    const sent: unknown[] = [];
    for (;;) {
      e.s.clock.advance(1000);
      const b = big();
      const r = await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: b });
      if (r.status !== 202) break;
      sent.push(b);
    }
    const one = Buffer.byteLength(JSON.stringify(sent[0]));
    const perPage = Math.floor(RELAY.queuePageMaxBytes / one);
    assert.ok(sent.length > perPage, `${sent.length} > ${perPage}`);
    const get = (q = '') => e.call(e.pc, 'GET', path + q, { headers: { 'x-mbx-read': m.tokRead } });
    // 첫 쪽: 상한 안, 응답 본문은 Vercel 상한 아래
    const p1 = await get();
    const e1 = p1.json.envelopes as Array<{ seq: number; env: unknown }>;
    assert.equal(p1.json.more, true);
    assert.equal(e1.length, perPage);
    assert.ok(Buffer.byteLength(p1.text) < 4_500_000, `${Buffer.byteLength(p1.text)}`);
    assert.deepEqual(e1.map((x) => x.env), sent.slice(0, perPage));
    // ACK 전에 after로 다음 쪽
    const p2 = await get(`?after=${e1.at(-1)!.seq}`);
    const e2 = p2.json.envelopes as Array<{ seq: number; env: unknown }>;
    assert.deepEqual([...e1, ...e2].map((x) => x.env), sent.slice(0, e1.length + e2.length));
    assert.equal(p2.json.more, e1.length + e2.length < sent.length);
    // 옛 클라이언트: 첫 쪽만 보고 ACK → 다시 읽으면 나머지
    await e.call(e.pc, 'POST', `/v1/mailboxes/${m.mbxId}/ack`, { headers: { 'x-mbx-read': m.tokRead }, body: { seq: e1.at(-1)!.seq } });
    const rest: unknown[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const p = await get();
      const es = p.json.envelopes as Array<{ seq: number; env: unknown }>;
      rest.push(...es.map((x) => x.env));
      if (!es.length) break;
      await e.call(e.pc, 'POST', `/v1/mailboxes/${m.mbxId}/ack`, { headers: { 'x-mbx-read': m.tokRead }, body: { seq: es.at(-1)!.seq } });
      if (!p.json.more) break;
    }
    assert.deepEqual(rest, sent.slice(perPage));
    // 봉투 하나는 상한과 무관하게 들어간다(서비스 계층)
    e.s.clock.advance(1000);
    await e.call(e.phone, 'POST', path, { headers: { 'x-mbx-write': m.tokWrite }, body: big() });
    const key = (await e.db.one<{ mbx_key: string }>('SELECT mbx_key FROM queue LIMIT 1'))!.mbx_key;
    const tiny = await e.svc.list(key, 0, 1);
    assert.equal(tiny.envelopes.length, 1);
    // 형식: after는 0 또는 양의 정수 한 개, 다른 쿼리 키는 거부
    for (const q of ['?after=-1', '?after=01', '?after=x', '?after=1&after=2', '?limit=5', '?after=1e3', '?after=9999999999999999']) {
      assert.equal((await get(q)).json.error, 'request.param_rejected', q);
    }
    assert.deepEqual((await get('?after=0')).json.more, false);
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
    assert.deepEqual((await e.r('POST', '/internal/v1/queues/purge', { headers: internalHeaders('POST', '/internal/v1/queues/purge') })).json, { deleted: 1 });
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
    // PC가 받은 바이너리는 폰이 보낸 f1 하나뿐이다(f2는 PC가 보낸 것). 틀린 프레임은 하나도 오지 않았다
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

describe('폰 대리 등록(팀장 결정 2026-11-06): PC가 데스크톱 기기 토큰 + 소비된 1회용 페어링 룸으로 폰을 등록', () => {
  let e: Env;
  beforeEach(async () => (e = await start()));
  afterEach(() => stop(e));

  const enrollBody = (phone: ReturnType<typeof device>, roomId: string) => ({ deviceId: phone.id, role: 'mobile', platform: 'android', name: '새 폰', Sx: phone.S.b64, Vx: phone.V.b64, roomId });
  const enroll = async (body: object, who: Who = e.pc) => {
    const t = await who.token();
    return e.s.req('POST', '/v1/devices/enroll', { headers: who.headers('POST', ACCOUNT_ORIGIN, '/v1/devices/enroll', t), body });
  };
  /** PC가 룸을 만들고 두 쪽이 붙는다(폰은 아직 기기 토큰이 없다: 룸 참가에는 인증이 없다) */
  const pairedRoom = async (join = 2) => {
    const roomId = newRoomId();
    assert.equal((await e.call(e.pc, 'POST', '/v1/rooms', { body: { roomId } })).status, 201);
    const socks: Sock[] = [];
    for (let i = 0; i < join; i++) socks.push((await open(`${e.wsBase}/v1/rooms/${roomId}`))!);
    return { roomId, socks };
  };

  it('룸이 페어링된 뒤 한 번만 등록되고, 같은 PC의 AIK 서명 기기 목록으로 활성이 되어 폰 기기 토큰을 받는다', async () => {
    const { roomId, socks } = await pairedRoom();
    const phone = device('mobile', e.s.clock.now());
    const r = await enroll(enrollBody(phone, roomId));
    assert.equal(r.status, 201, r.text);
    assert.ok(e.s.mail.outbox.some((m) => m.kind === 'device_enrolled'));
    // 같은 룸 두 번째 enroll은 409(1회용): 다른 폰이든 같은 폰(같은 키)이든
    const second = await enroll(enrollBody(device('mobile', e.s.clock.now()), roomId));
    assert.equal(second.status, 409);
    assert.equal(second.json.error, 'relay.room_used');
    assert.equal((await enroll(enrollBody(phone, roomId))).json.error, 'relay.room_used');
    // 그 뒤 PUT /v1/device-list(같은 PC의 AIK 서명)로 활성
    const cur = (await e.s.req('GET', '/v1/device-list', { headers: { authorization: `Bearer ${e.pc.session}` } })).json.deviceList as { listVersion: number; entries: unknown[] };
    const t = await e.pc.token();
    const up = await e.s.req('PUT', '/v1/device-list', {
      headers: e.pc.headers('PUT', ACCOUNT_ORIGIN, '/v1/device-list', t),
      body: { deviceList: { listVersion: cur.listVersion + 1, entries: [...cur.entries, entry(e.pc.aik, phone, cur.listVersion + 1)], revoked: [] } },
    });
    assert.equal(up.status, 200, up.text);
    const row = await e.s.db.one<{ state: string; role: string }>('SELECT state, role FROM devices WHERE device_id = $1', [phone.id]);
    assert.deepEqual({ ...row }, { state: 'active', role: 'mobile' });
    for (const s of socks) s.ws.close();
  });

  it('페어링되지 않은 룸(폰이 안 붙음)·다른 PC가 만든 룸·없는 룸·만료된 룸은 모두 같은 404', async () => {
    const lone = await pairedRoom(1);
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), lone.roomId))).json.error, 'relay.room_unavailable');
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), newRoomId()))).json.error, 'relay.room_unavailable');
    // 다른 PC(다른 계정)는 이 PC가 만든 룸을 쓸 수 없다
    const { roomId, socks } = await pairedRoom();
    const pc2 = await signedDesktop(e.s, 'other-pc@example.com');
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), roomId), pc2)).json.error, 'relay.room_unavailable');
    const late = await pairedRoom();
    e.s.clock.advance(120_000);
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), late.roomId))).json.error, 'relay.room_unavailable');
    for (const s of [...lone.socks, ...socks, ...late.socks]) s.ws.close();
    // 실패한 시도는 기기를 만들지 않는다
    assert.equal((await e.s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE role = 'mobile'"))!.n, 1);
  });

  it('폰 기기 토큰으로는 등록할 수 없고, 형식(role·플랫폼·roomId)이 틀리면 400, 계정 세션 경로는 roomId를 받지 않는다', async () => {
    const { roomId, socks } = await pairedRoom();
    const phone = device('mobile', e.s.clock.now());
    assert.equal((await enroll(enrollBody(phone, roomId), e.phone)).status, 403);
    for (const bad of [{ role: 'desktop' }, { platform: 'windows' }, { roomId: 'short' }, { extra: 1 }]) assert.equal((await enroll({ ...enrollBody(phone, roomId), ...bad })).status, 400, JSON.stringify(bad));
    const viaSession = await e.s.req('POST', '/v1/devices/enroll', { headers: { authorization: `Bearer ${e.pc.session}` }, body: enrollBody(phone, roomId) });
    assert.equal(viaSession.status, 400);
    // 위 거절들은 룸을 소비하지 않았다
    assert.equal((await enroll(enrollBody(phone, roomId))).status, 201);
    for (const s of socks) s.ws.close();
  });

  it('같은 폰(같은 기기 ID·같은 Sx·Vx) 재등록은 멱등 200: 상한·교체 한도·알림에 다시 넣지 않고, 그 룸은 enroll 사용됨이 된다(팀장 결정 2026-11-06)', async () => {
    const first = await pairedRoom();
    const phone = device('mobile', e.s.clock.now());
    const r1 = await enroll(enrollBody(phone, first.roomId));
    assert.equal(r1.status, 201, r1.text);
    const countState = async () => ({
      devices: Number((await e.s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE role = 'mobile'"))!.n),
      events: Number((await e.s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM device_events WHERE role = 'mobile'"))!.n),
      mails: e.s.mail.outbox.filter((m) => m.kind === 'device_enrolled').length,
    });
    const before = await countState();
    // PC 목록이 낡아 같은 폰을 다시 연결: 새 룸으로 다시 등록 → 200 기존 기록(pending)
    const again = await pairedRoom();
    const r2 = await enroll(enrollBody(phone, again.roomId));
    assert.equal(r2.status, 200, r2.text);
    assert.deepEqual(r2.json, { holdUntil: r1.json.holdUntil, state: 'pending' });
    assert.deepEqual(await countState(), before);
    // 이미 쓴 첫 룸으로는 같은 키라도 409
    assert.equal((await enroll(enrollBody(phone, first.roomId))).json.error, 'relay.room_used');
    for (const s of [...first.socks, ...again.socks]) s.ws.close();
  });

  it('같은 룸 두 번째 enroll 409: 200(같은 키 재등록)으로 쓴 룸도 다른 폰·같은 폰 모두 409이고, 룸 자체는 열려 있다', async () => {
    const a = await pairedRoom();
    const phone = device('mobile', e.s.clock.now());
    assert.equal((await enroll(enrollBody(phone, a.roomId))).status, 201);
    const { roomId, socks } = await pairedRoom();
    assert.equal((await enroll(enrollBody(phone, roomId))).status, 200);
    const before = Number((await e.s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE role = 'mobile'"))!.n);
    for (const body of [enrollBody(device('mobile', e.s.clock.now()), roomId), enrollBody(phone, roomId)]) {
      const r = await enroll(body);
      assert.equal(r.status, 409, r.text);
      assert.equal(r.json.error, 'relay.room_used');
    }
    assert.equal(Number((await e.s.db.one<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE role = 'mobile'"))!.n), before);
    // 룸은 PAIR_OK 전까지 열려 있다: 두 쪽 연결이 그대로 프레임을 주고받는다
    const f = hs(96);
    socks[0]!.ws.send(f);
    assert.deepEqual(await socks[1]!.next(), f);
    // 다른 PC는 이 룸이 쓰였는지 알 수 없다(여전히 404)
    const pc2 = await signedDesktop(e.s, 'other-pc@example.com');
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), roomId), pc2)).json.error, 'relay.room_unavailable');
    for (const s of [...a.socks, ...socks]) s.ws.close();
  });

  it('같은 기기 ID인데 키가 다르거나(Sx·Vx), 폐기·정지된 기록이면 400이고 룸을 소비하지 않는다(폐기 뒤 새 기기 ID로 재등록)', async () => {
    const a = await pairedRoom();
    const phone = device('mobile', e.s.clock.now());
    assert.equal((await enroll(enrollBody(phone, a.roomId))).status, 201);
    const { roomId, socks } = await pairedRoom();
    const other = device('mobile', e.s.clock.now());
    for (const keys of [{ Sx: other.S.b64 }, { Vx: other.V.b64 }, { Sx: other.S.b64, Vx: other.V.b64 }]) {
      const r = await enroll({ ...enrollBody(phone, roomId), ...keys });
      assert.equal(r.status, 400, JSON.stringify(keys));
      assert.equal(r.json.error, 'request.param_rejected');
    }
    // 데스크톱 기기 ID(같은 계정)·다른 계정 PC가 이 폰 ID로는 400
    assert.equal((await enroll({ ...enrollBody(phone, roomId), deviceId: e.pc.d.id })).status, 400);
    const pc2 = await signedDesktop(e.s, 'other-pc@example.com');
    assert.equal((await enroll(enrollBody(phone, roomId), pc2)).status, 400);
    // 정지·폐기된 같은 키 기록은 멱등이 아니다
    await e.s.db.run("UPDATE devices SET state = 'suspended' WHERE device_id = $1", [phone.id]);
    assert.equal((await enroll(enrollBody(phone, roomId))).status, 400);
    await e.s.db.run("UPDATE devices SET state = 'revoked' WHERE device_id = $1", [phone.id]);
    assert.equal((await enroll(enrollBody(phone, roomId))).status, 400);
    // 위 거절들은 룸을 소비하지 않았다: 새 기기 ID로 같은 룸에 등록된다
    assert.equal((await enroll(enrollBody(other, roomId))).status, 201);
    for (const s of [...a.socks, ...socks]) s.ws.close();
  });

  it('활성 폰도 같은 키면 200 {holdUntil:null, state:"active"}', async () => {
    const { roomId, socks } = await pairedRoom();
    const act = (await e.s.db.one<{ sx: string; vx: string }>('SELECT sx, vx FROM devices WHERE device_id = $1', [e.phone.id]))!;
    const r = await enroll({ ...enrollBody(device('mobile', e.s.clock.now()), roomId), deviceId: e.phone.id, Sx: act.sx, Vx: act.vx });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json, { holdUntil: null, state: 'active' });
    for (const s of socks) s.ws.close();
  });

  it('상한에 찬 계정에서도 이미 등록된 폰의 재등록은 200이고 상한 계산은 바뀌지 않는다', async () => {
    const phones: Array<ReturnType<typeof device>> = [];
    for (let i = 1; i < DEVICE.maxMobiles; i++) {
      const { roomId, socks } = await pairedRoom();
      const p = device('mobile', e.s.clock.now());
      assert.equal((await enroll(enrollBody(p, roomId))).status, 201);
      phones.push(p);
      for (const s of socks) s.ws.close();
    }
    for (const p of phones) {
      const { roomId, socks } = await pairedRoom();
      assert.equal((await enroll(enrollBody(p, roomId))).status, 200);
      for (const s of socks) s.ws.close();
    }
    // 여전히 꽉 차 있다(재등록이 칸을 더 쓰지도 비우지도 않았다). 상한 거절은 룸을 쓰지 않는다
    const { roomId, socks } = await pairedRoom();
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), roomId))).json.error, 'account.device_limit');
    await e.s.db.run("UPDATE devices SET state = 'revoked' WHERE device_id = $1", [phones[0]!.id]);
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), roomId))).status, 201);
    for (const s of socks) s.ws.close();
  });

  it('계정당 모바일 상한을 넘으면 룸을 소비하지 않고 account.device_limit', async () => {
    for (let i = 1; i < DEVICE.maxMobiles; i++) {
      const { roomId, socks } = await pairedRoom();
      assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), roomId))).status, 201);
      for (const s of socks) s.ws.close();
    }
    const { roomId, socks } = await pairedRoom();
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), roomId))).json.error, 'account.device_limit');
    // 한 대를 폐기 처리(여기서는 DB로 대신)하면 같은 룸으로 등록할 수 있다
    await e.s.db.run("UPDATE devices SET state = 'revoked' WHERE device_id = $1", [e.phone.id]);
    assert.equal((await enroll(enrollBody(device('mobile', e.s.clock.now()), roomId))).status, 201);
    for (const s of socks) s.ws.close();
  });
});

describe('릴레이 기능 스위치: 룸 꺼짐(RELAY_ROOMS)·라이브 꺼짐(RELAY_LIVE, Phase 1 기본)', () => {
  let e: Env;
  beforeEach(async () => (e = await start({ rooms: false, live: false })));
  afterEach(() => stop(e));

  it('룸이 꺼지면 발급·참가·소비가 모두 404, 라이브가 꺼지면 우편함 WSS는 404이고 HTTPS 큐는 그대로', async () => {
    const roomId = newRoomId();
    assert.equal((await e.call(e.pc, 'POST', '/v1/rooms', { body: { roomId } })).json.error, 'request.not_found');
    assert.equal(await open(`${e.wsBase}/v1/rooms/${roomId}`), null);
    const redeem = await e.r('POST', `/internal/v1/rooms/${roomId}/redeem`, { headers: internalHeaders('POST', `/internal/v1/rooms/${roomId}/redeem`, { deviceId: e.pc.d.id }), body: { deviceId: e.pc.d.id } });
    assert.equal(redeem.json.error, 'relay.room_unavailable');
    const m = newMailbox();
    assert.equal((await e.call(e.pc, 'POST', '/v1/mailboxes', { body: m })).status, 201);
    const path = `/v1/mailboxes/${m.mbxId}/live`;
    assert.equal(await open(e.wsBase + path, await e.wsHeaders(e.pc, path, { 'x-mbx-read': m.tokRead, 'x-mbx-write': m.tokWrite })), null);
    const env = await e.call(e.phone, 'POST', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-write': m.tokWrite }, body: envelope() });
    assert.equal(env.status, 202, env.text);
    assert.equal(((await e.call(e.pc, 'GET', `/v1/mailboxes/${m.mbxId}/envelopes`, { headers: { 'x-mbx-read': m.tokRead } })).json.envelopes as unknown[]).length, 1);
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

  it('FCM: 무응답은 시간 제한으로 끊고, 429·5xx 뒤에는 Retry-After 동안 공급사를 부르지 않는다, 401이면 접근 토큰을 다시 받는다', async () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let now = Date.UTC(2026, 10, 10);
    let mode: 'hang' | '503' | '401' | 'ok' = 'hang';
    const calls: string[] = [];
    const fetchFn = ((url: string, init: RequestInit) => {
      calls.push(url.includes('oauth') ? 'oauth' : 'send');
      if (url.includes('oauth')) return Promise.resolve(new Response(JSON.stringify({ access_token: `at-${calls.length}`, expires_in: 3600 }), { status: 200 }));
      if (mode === 'hang') return new Promise<Response>((_r, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
      if (mode === '503') return Promise.resolve(new Response('', { status: 503, headers: { 'retry-after': '20' } }));
      if (mode === '401') return Promise.resolve(new Response('', { status: 401 }));
      return Promise.resolve(new Response('{}', { status: 200 }));
    }) as unknown as typeof fetch;
    const sa = JSON.stringify({ client_email: 'push@sax.test.invalid', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: 'https://oauth.test.invalid/token' });
    const s = new FcmSender({ projectId: 'sax-dev', serviceAccountJson: sa, endpointBase: 'https://fcm.test.invalid', fetchFn, now: () => now, timeoutMs: 20 });
    const tok = 'a'.repeat(152);
    assert.equal(await s.send('fcm', tok), 'retry');
    mode = '503';
    assert.equal(await s.send('fcm', tok), 'retry');
    const n = calls.length;
    now += 19_000;
    assert.equal(await s.send('fcm', tok), 'retry');
    assert.equal(calls.length, n, '물러서는 동안 공급사를 부르지 않는다');
    now += 2_000;
    mode = '401';
    assert.equal(await s.send('fcm', tok), 'retry');
    mode = 'ok';
    assert.equal(await s.send('fcm', tok), 'ok');
    assert.deepEqual(calls, ['oauth', 'send', 'send', 'send', 'oauth', 'send']);
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
