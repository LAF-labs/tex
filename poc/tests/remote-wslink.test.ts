// 릴레이 WSS 클라이언트(ws-link, services/relay/API.md): 주입한 소켓만 쓰고, wss 강제(로컬 개발만 ws),
// 경로 규칙(룸·우편함 라이브), 우편함 헤더(기기 토큰 DPoP + X-Mbx-Read/Write), 토큰은 URL에 없고, 프레임 순서를 지킨다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { allowDevLanHosts, b64url, encodeHs, relayOrigin, relayUrl, wsRelayClient, KIND, RELAY_CLOSE, type WebSocketLike } from '@sax/remote';

class FakeWs implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  pings = 0;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  readonly headers: Record<string, string> | undefined;
  constructor(url: string, headers?: Record<string, string>) {
    this.url = url;
    this.headers = headers;
  }
  send(d: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(typeof d === 'string' ? d : new Uint8Array(d as ArrayBuffer));
  }
  ping() {
    this.pings++;
  }
  close(code = 1000) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  msg(data: unknown) {
    this.onmessage?.({ data });
  }
}

const MBX = new Uint8Array(32).fill(1);
const TOK = { read: new Uint8Array(32).fill(2), write: new Uint8Array(32).fill(3) };
const ROOM = new Uint8Array(16).fill(4);

function harness(o: { pingMs?: number; auth?: boolean } = {}) {
  const made: FakeWs[] = [];
  const authCalls: { htm: string; htu: string }[] = [];
  const c = wsRelayClient({
    host: 'relay.tex.test',
    open: (u, h) => {
      const w = new FakeWs(u, h);
      made.push(w);
      queueMicrotask(() => w.open());
      return w;
    },
    deviceAuth:
      o.auth === false
        ? undefined
        : async (htm, htu) => {
            authCalls.push({ htm, htu });
            return { Authorization: 'DPoP sxd1.test', DPoP: 'proof' };
          },
    joinTimeoutMs: 200,
    pingMs: o.pingMs ?? 0,
  });
  return { c, made, authCalls };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('ws-link(services/relay/API.md)', () => {
  it('경로·스킴: wss만, 로컬 개발만 ws·http, 이상한 호스트 거부', () => {
    assert.equal(relayUrl('relay.tex.laf-co.com', '/v1/rooms/x'), 'wss://relay.tex.laf-co.com/v1/rooms/x');
    assert.equal(relayUrl('localhost:8787', '/v1/rooms/x', true), 'ws://localhost:8787/v1/rooms/x');
    assert.equal(relayOrigin('relay.tex.laf-co.com'), 'https://relay.tex.laf-co.com');
    assert.equal(relayOrigin('localhost:8787', true), 'http://localhost:8787');
    assert.throws(() => relayOrigin('mac-mini.local:8787', true), /insecure only/, 'mDNS 평문은 기본 꺼짐(릴리스)');
    allowDevLanHosts(true);
    try {
      assert.equal(relayOrigin('mac-mini.local:8787', true), 'http://mac-mini.local:8787', '실기기 개발 빌드: 같은 LAN의 mDNS 이름');
      for (const h of ['192.168.0.10:8787', 'a.b.local:8787']) assert.throws(() => relayOrigin(h, true), /insecure only/, h);
    } finally {
      allowDevLanHosts(false);
    }
    for (const h of ['192.168.0.10:8787', 'relay.tex.laf-co.com', 'evil.local.example.com:8787', 'a.b.local:8787']) assert.throws(() => relayOrigin(h, true), /insecure only/, h);
    assert.throws(() => relayUrl('relay.tex.laf-co.com', '/', true));
    assert.throws(() => relayUrl('evil.com/x?y', '/'));
    assert.throws(() => relayUrl('a b', '/'));
  });

  it('룸: GET /v1/rooms/<22자>, 인증 헤더 없음, 열리면 입장(폰은 상대가 있다고 본다)', async () => {
    const { c, made, authCalls } = harness();
    const link = await c.joinRoom(ROOM, 'mobile');
    const ws = made[0]!;
    assert.equal(ws.url, `wss://relay.tex.test/v1/rooms/${b64url(ROOM)}`);
    assert.equal(b64url(ROOM).length, 22);
    assert.equal(ws.headers, undefined);
    assert.equal(authCalls.length, 0);
    let peer = false;
    link.onPeer(() => (peer = true));
    assert.equal(peer, true);
    const desk = await c.joinRoom(ROOM, 'desktop');
    let deskPeer = false;
    desk.onPeer(() => (deskPeer = true));
    assert.equal(deskPeer, false);
  });

  it('우편함 라이브: 경로·헤더(기기 토큰 DPoP, htu = https origin + 경로, 두 토큰), URL에 토큰 없음', async () => {
    const { c, made, authCalls } = harness();
    const p = c.joinMailbox(MBX, TOK, 'mobile');
    await tick();
    const ws = made[0]!;
    const path = `/v1/mailboxes/${b64url(MBX)}/live`;
    assert.equal(ws.url, `wss://relay.tex.test${path}`);
    assert.deepEqual(authCalls, [{ htm: 'GET', htu: `https://relay.tex.test${path}` }]);
    assert.deepEqual(ws.headers, { Authorization: 'DPoP sxd1.test', DPoP: 'proof', 'X-Mbx-Read': b64url(TOK.read), 'X-Mbx-Write': b64url(TOK.write) });
    assert.ok(!ws.url.includes(b64url(TOK.read)) && !ws.url.includes(b64url(TOK.write)));
    assert.equal(ws.sent.length, 0); // 첫 메시지(join)는 없다
    ws.msg(JSON.stringify({ t: 'peer', online: false }));
    const link = await p;
    let peers = 0;
    link.onPeer(() => peers++);
    assert.equal(peers, 0);
    ws.msg(JSON.stringify({ t: 'peer', online: true }));
    assert.equal(peers, 1);
    ws.msg(JSON.stringify({ t: 'peer', online: true }));
    assert.equal(peers, 1);
    // 상대가 나갔다 다시 오면 다시 알린다
    ws.msg(JSON.stringify({ t: 'peer', online: false }));
    ws.msg(JSON.stringify({ t: 'peer', online: true }));
    assert.equal(peers, 2);
    let envs = 0;
    link.onEnv(() => envs++);
    ws.msg(JSON.stringify({ t: 'env' }));
    ws.msg('not json');
    ws.msg(JSON.stringify({ t: 'other' }));
    assert.equal(envs, 1);
    const hs = encodeHs(new Uint8Array([9]));
    link.send(hs);
    assert.deepEqual(ws.sent[0], hs);
  });

  it('우편함: 기기 토큰이 없으면 들어가지 않고, 토큰 길이가 틀리면 거부', async () => {
    await assert.rejects(harness({ auth: false }).c.joinMailbox(MBX, TOK, 'mobile'), /device auth/);
    await assert.rejects(harness().c.joinMailbox(MBX, { read: new Uint8Array(16), write: TOK.write }, 'mobile'), /token/);
    await assert.rejects(harness().c.joinMailbox(new Uint8Array(16), TOK, 'mobile'), /mailbox id/);
  });

  it('업그레이드 전 거절(닫힘)은 입장 실패, 응답이 없으면 시간 초과', async () => {
    const h = harness();
    const p = h.c.joinMailbox(MBX, TOK, 'mobile');
    await tick();
    h.made[0]!.close(1006);
    await assert.rejects(p, /rejected/);
    await assert.rejects(harness().c.joinMailbox(MBX, TOK, 'mobile'), /timeout/);
  });

  it('닫힘 코드: 4001(기기 토큰 만료)·4002(대체됨)를 링크에 남긴다', async () => {
    const h = harness();
    const p = h.c.joinMailbox(MBX, TOK, 'desktop');
    await tick();
    h.made[0]!.msg(JSON.stringify({ t: 'peer', online: true }));
    const link = await p;
    assert.equal(link.closeCode, null);
    h.made[0]!.onclose?.({ code: RELAY_CLOSE.tokenExpired });
    assert.equal(link.closed, true);
    assert.equal(link.closeCode, 4001);
  });

  it('프레임은 순서대로(Blob 섞여도), 큰 프레임은 버리고, ENV·상한 초과는 보내지 않는다', async () => {
    const { c, made } = harness();
    const link = await c.joinRoom(ROOM, 'mobile');
    const ws = made[0]!;
    const got: number[] = [];
    link.onFrame((f) => got.push(f[0]!));
    const slowBlob = { arrayBuffer: () => new Promise<ArrayBuffer>((r) => setTimeout(() => r(new Uint8Array([1]).buffer), 20)) };
    ws.msg(slowBlob);
    ws.msg(new Uint8Array([2]).buffer);
    ws.msg(new Uint8Array(65_536)); // 상한 초과
    ws.msg(new Uint8Array([3]));
    await tick(60);
    assert.deepEqual(got, [1, 2, 3]);
    assert.throws(() => link.send(new Uint8Array(65_536)), /too large/);
    assert.throws(() => link.send(Uint8Array.of(1, KIND.ENV, 0, 0)), /queue/);
    let closed = false;
    link.onClose(() => (closed = true));
    ws.close();
    assert.ok(closed && link.closed);
  });

  it('입장 뒤 ping을 보내고, 닫히면 멈춘다', async () => {
    const { c, made } = harness({ pingMs: 10 });
    const link = await c.joinRoom(ROOM, 'mobile');
    await tick(45);
    const n = made[0]!.pings;
    assert.ok(n >= 2);
    link.close();
    await tick(30);
    assert.equal(made[0]!.pings, n);
  });
});
