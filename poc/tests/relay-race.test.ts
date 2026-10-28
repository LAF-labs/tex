// 경쟁 회귀(Bugbot 4차): expose()·attachEngine()의 await 사이에 허용 밖 이동(originLeft)이 끼어들어도
// 거부된 타깃의 attachedToTarget이 엔진에 가지 않아야 한다. 가짜 CDP 연결로 순서를 결정적으로 만든다.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { FileEventLog } from '@sax/platform';
import { Relay } from '@sax/vault';
import { testPolicy } from './harness.ts';

type Json = Record<string, unknown>;
type CdpMessage = { method?: string; params?: Json; sessionId?: string };
type Handler = (params: Json, sessionId?: string) => Json | Promise<Json>;

class FakeConn extends EventEmitter {
  private nextId = 1;
  readonly sent: Array<{ method: string; params: Json; sessionId?: string }> = [];
  readonly handlers = new Map<string, Handler>();
  send<T = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    this.sent.push({ method, params, sessionId });
    const h = this.handlers.get(method);
    return Promise.resolve(h ? h(params, sessionId) : {}) as Promise<T>;
  }
  allocId(): number {
    return this.nextId++;
  }
  sendRaw(): void {}
  emitEvent(method: string, params: Json, sessionId?: string): void {
    const m: CdpMessage = { method, params };
    if (sessionId) m.sessionId = sessionId;
    this.emit('message', m);
  }
}

function deferred<T = Json>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const tick = () => new Promise((r) => setTimeout(r, 10));

/** 실행 page(RUN)를 노출하고 엔진 루트 자동 부착까지 마친 Relay. */
async function setup() {
  const conn = new FakeConn();
  const toEngine: Json[] = [];
  const log = new FileEventLog(null, 'vault');
  const relay = new Relay({ conn: conn as never, policy: testPolicy({ allowedHosts: ['127.0.0.1'] }), log, toEngine: (raw) => toEngine.push(JSON.parse(raw) as Json) });
  let sessions = 0;
  conn.handlers.set('Browser.getVersion', () => ({ product: 'Chrome/156' }));
  conn.handlers.set('Target.createTarget', () => {
    setTimeout(() => conn.emitEvent('Target.attachedToTarget', { sessionId: 'V-RUN', targetInfo: { targetId: 'RUN', type: 'page', url: 'about:blank' }, waitingForDebugger: true }), 0);
    return { targetId: 'RUN' };
  });
  conn.handlers.set('Page.getFrameTree', (_p, sid) => ({ frameTree: { frame: { id: sid === 'V-POP' ? 'POP' : 'RUN', url: 'http://127.0.0.1:1/ok' } } }));
  conn.handlers.set('Target.attachToTarget', () => ({ sessionId: `E-${++sessions}` }));
  conn.handlers.set('Target.getTargetInfo', (p) => ({ targetInfo: { targetId: p.targetId, type: 'page', url: '' } }));
  await relay.init();
  await relay.createRunPage();
  relay.onEngineMessage(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }));
  await tick();
  const attachedTo = () => toEngine.filter((m) => m.method === 'Target.attachedToTarget').map((m) => ((m.params as Json).targetInfo as Json).targetId);
  assert.deepEqual(attachedTo(), ['RUN']);
  // 노출 페이지가 연 팝업(목적지 모름)
  conn.emitEvent('Target.attachedToTarget', { sessionId: 'V-POP', targetInfo: { targetId: 'POP', type: 'page', url: '', openerId: 'RUN' }, waitingForDebugger: true });
  await tick();
  return { conn, relay, log, toEngine, attachedTo };
}

describe('relay 경쟁: expose 중 originLeft', () => {
  it('expose()의 Page.enable await 사이에 허용 밖 이동 시작 → 엔진에 부착 안 감, 부착 시도도 없음', async () => {
    const { conn, relay, log, attachedTo } = await setup();
    const gate = deferred();
    conn.handlers.set('Page.enable', (_p, sid) => (sid === 'V-POP' && relay.targets.get('POP')?.pendingPopup === false ? gate.promise : {}));
    // 허용 커밋 → confirmPopup → expose(POP) 진입, Page.enable에서 멈춤
    conn.emitEvent('Page.frameNavigated', { frame: { id: 'POP', url: 'http://127.0.0.1:1/ok' } }, 'V-POP');
    await tick();
    assert.equal(relay.targets.get('POP')!.exposing, true, 'expose 진행 중');
    assert.equal(relay.targets.get('POP')!.mainFrameId, undefined, 'mainFrameId가 아직 없다');
    // 이때 허용 밖 이동 시작(targetId 기준 판정)
    conn.emitEvent('Page.frameStartedNavigating', { frameId: 'POP', url: 'https://evil.example/' }, 'V-POP');
    await tick();
    assert.equal(relay.targets.get('POP')!.revoked, true, '세션이 없어도 상태를 먼저 revoked로 기록');
    gate.resolve({});
    await tick();
    assert.deepEqual(attachedTo(), ['RUN'], '거부된 팝업의 attachedToTarget이 엔진에 가지 않는다');
    assert.ok(!conn.sent.some((m) => m.method === 'Target.attachToTarget' && m.params.targetId === 'POP'), '부착 시도 자체가 없다');
    assert.equal(relay.targets.get('POP')!.exposed, false);
    assert.ok(log.lines.some((l) => l.includes('vault.origin_left')));
  });

  it('attachEngine()의 Target.attachToTarget·getTargetInfo await 사이에 거부 → 새 세션을 분리하고 알리지 않는다', async () => {
    for (const holdOn of ['Target.attachToTarget', 'Target.getTargetInfo'] as const) {
      const { conn, relay, attachedTo } = await setup();
      const gate = deferred();
      const orig = conn.handlers.get(holdOn)!;
      conn.handlers.set(holdOn, async (p, sid) => {
        if (p.targetId === 'POP') {
          await gate.promise;
        }
        return orig(p, sid);
      });
      conn.emitEvent('Page.frameNavigated', { frame: { id: 'POP', url: 'http://127.0.0.1:1/ok' } }, 'V-POP');
      await tick();
      assert.equal(relay.targets.get('POP')!.exposed, true, `${holdOn}: expose는 끝났고 attachEngine이 멈춰 있다`);
      conn.emitEvent('Page.frameStartedNavigating', { frameId: 'POP', url: 'https://evil.example/' }, 'V-POP');
      await tick();
      assert.equal(relay.targets.get('POP')!.revoked, true);
      gate.resolve({});
      await tick();
      await tick();
      assert.deepEqual(attachedTo(), ['RUN'], `${holdOn}: attachedToTarget 비전달`);
      const attached = conn.sent.filter((m) => m.method === 'Target.attachToTarget' && m.params.targetId === 'POP').length;
      const detached = conn.sent.filter((m) => m.method === 'Target.detachFromTarget' && String(m.params.sessionId).startsWith('E-')).length;
      assert.ok(attached <= 1 && detached >= attached, `${holdOn}: 만든 엔진 세션은 모두 분리(attach ${attached}, detach ${detached})`);
      // 이후 허용 이동에도 재노출 없음(단조)
      conn.emitEvent('Page.frameNavigated', { frame: { id: 'POP', url: 'http://127.0.0.1:1/again' } }, 'V-POP');
      await tick();
      assert.deepEqual(attachedTo(), ['RUN']);
    }
  });
});
