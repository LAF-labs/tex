// D08 §8 릴레이 WSS 초안 클라이언트(ws-link): 주입한 소켓만 쓰고, wss 강제(로컬 개발만 ws), 토큰은 URL에 없고, 프레임 순서를 지킨다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { relayUrl, wsRelayClient, type WebSocketLike } from '@sax/remote';

class FakeWs implements WebSocketLike {
  binaryType = 'blob';
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
  }
  send(d: string | ArrayBufferLike | ArrayBufferView) {
    this.sent.push(typeof d === 'string' ? d : new Uint8Array(d as ArrayBuffer));
  }
  close() {
    this.readyState = 3;
    this.onclose?.({});
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  msg(data: unknown) {
    this.onmessage?.({ data });
  }
}

function harness() {
  const made: FakeWs[] = [];
  const c = wsRelayClient({ host: 'relay.tex.test', open: (u) => {
    const w = new FakeWs(u);
    made.push(w);
    queueMicrotask(() => w.open());
    return w;
  }, joinTimeoutMs: 200 });
  return { c, made };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('ws-link', () => {
  it('wss만, 로컬 개발만 ws, 이상한 호스트 거부', () => {
    assert.equal(relayUrl('relay.tex.laf-co.com'), 'wss://relay.tex.laf-co.com/v1/connect');
    assert.equal(relayUrl('localhost:8787', true), 'ws://localhost:8787/v1/connect');
    assert.throws(() => relayUrl('relay.tex.laf-co.com', true));
    assert.throws(() => relayUrl('evil.com/x?y'));
    assert.throws(() => relayUrl('a b'));
  });

  it('우편함 입장: 토큰은 첫 메시지로만, URL에는 없다 → joined → peer', async () => {
    const { c, made } = harness();
    const p = c.joinMailbox(new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), 'mobile');
    await tick();
    const ws = made[0]!;
    assert.ok(!ws.url.includes('token') && !ws.url.includes('AgIC'));
    const hello = JSON.parse(ws.sent[0] as string);
    assert.deepEqual(Object.keys(hello).sort(), ['mbx', 'op', 'role', 'token']);
    assert.equal(hello.role, 'mobile');
    ws.msg(JSON.stringify({ op: 'joined', peer: false }));
    const link = await p;
    let peer = false;
    link.onPeer(() => (peer = true));
    assert.equal(peer, false);
    ws.msg(JSON.stringify({ op: 'peer' }));
    assert.equal(peer, true);
    link.send(new Uint8Array([1, 2, 3]));
    assert.deepEqual(ws.sent[1], new Uint8Array([1, 2, 3]));
  });

  it('거부(error)는 입장 실패', async () => {
    const { c, made } = harness();
    const p = c.joinRoom(new Uint8Array(16), 'desktop');
    await tick();
    made[0]!.msg(JSON.stringify({ op: 'error', code: 'mailbox_refused' }));
    await assert.rejects(p, /mailbox_refused/);
  });

  it('응답이 없으면 시간 초과', async () => {
    const { c } = harness();
    await assert.rejects(c.joinRoom(new Uint8Array(16), 'mobile'), /timeout/);
  });

  it('입장 전 프레임은 거부, 입장 뒤 프레임은 순서대로(Blob 섞여도), 큰 프레임은 버린다', async () => {
    const { c, made } = harness();
    const p = c.joinRoom(new Uint8Array(16), 'mobile');
    await tick();
    const ws = made[0]!;
    ws.msg(JSON.stringify({ op: 'joined', peer: true }));
    const link = await p;
    const got: number[] = [];
    link.onFrame((f) => got.push(f[0]!));
    const slowBlob = { arrayBuffer: () => new Promise<ArrayBuffer>((r) => setTimeout(() => r(new Uint8Array([1]).buffer), 20)) };
    ws.msg(slowBlob);
    ws.msg(new Uint8Array([2]).buffer);
    ws.msg(new Uint8Array(70_000)); // 상한 초과
    ws.msg(new Uint8Array([3]));
    await new Promise((r) => setTimeout(r, 60));
    assert.deepEqual(got, [1, 2, 3]);
    let closed = false;
    link.onClose(() => (closed = true));
    ws.close();
    assert.ok(closed && link.closed);
  });

  it('프레임 크기 상한을 넘으면 보내지 않는다', async () => {
    const { c, made } = harness();
    const p = c.joinRoom(new Uint8Array(16), 'mobile');
    await tick();
    made[0]!.msg(JSON.stringify({ op: 'joined' }));
    const link = await p;
    assert.throws(() => link.send(new Uint8Array(70_000)));
  });
});
