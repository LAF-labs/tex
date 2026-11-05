// 금고 시험용 가짜 CDP 연결과 노출 실행 page 하나(Chrome 없음). audit-v의 setup과 같은 모양이며 금고 Phase 1 시험이 같이 쓴다.
import { EventEmitter } from 'node:events';
import { FileEventLog } from '@sax/platform';
import { Relay, SecretOps, type RelayPolicy, type SecretOpsOptions } from '@sax/vault';
import { testPolicy } from './harness.ts';

export type Json = Record<string, unknown>;
type Handler = (params: Json, sessionId?: string) => Json | Promise<Json>;

export class FakeConn extends EventEmitter {
  private nextId = 1000;
  readonly sent: Array<{ method: string; params: Json; sessionId?: string }> = [];
  /** 중계(sendRaw)로 Chrome에 넘어간 엔진 명령. */
  readonly raw: Json[] = [];
  readonly handlers = new Map<string, Handler>();

  send<T = Json>(method: string, params: Json = {}, sessionId?: string): Promise<T> {
    this.sent.push({ method, params, sessionId });
    const h = this.handlers.get(method);
    return Promise.resolve(h ? h(params, sessionId) : {}) as Promise<T>;
  }

  allocId(): number {
    return this.nextId++;
  }

  sendRaw(m: Json): void {
    this.raw.push(m);
  }

  emitEvent(method: string, params: Json, sessionId?: string): void {
    const m: Json = { method, params };
    if (sessionId) m.sessionId = sessionId;
    this.emit('message', m);
  }

  /** 중계된 엔진 명령에 Chrome이 답한 것처럼. */
  reply(id: number, result: Json, sessionId?: string): void {
    const m: Json = { id, result };
    if (sessionId) m.sessionId = sessionId;
    this.emit('message', m);
  }
}

export const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

export interface FakePage {
  type: string;
  active: boolean;
  connected: boolean;
  len: number;
  value: string;
  /** 보안카드 칸 번호 요소의 글자(FillRequest.rowLabel 셀렉터로 금고가 읽는다). null이면 요소 없음. */
  rowLabel: string | null;
}

export interface FakeRelay {
  conn: FakeConn;
  relay: Relay;
  log: FileEventLog;
  toEngine: Json[];
  page: FakePage;
  ops: SecretOps;
  events: Array<{ to: readonly string[]; name: string; data: Json }>;
  /** 엔진 세션 ID(실행 page). */
  sid: string;
  /** 엔진이 보낸 것처럼 명령을 넣고, 결과(엔진이 받은 응답)를 돌려준다. 중계되면 Chrome 응답을 result로 흉내 낸다. */
  call(method: string, params?: Json, result?: Json): Promise<Json>;
}

export async function fakeRelay(opts: { policy?: Partial<RelayPolicy>; ops?: SecretOpsOptions; frameUrl?: string } = {}): Promise<FakeRelay> {
  const conn = new FakeConn();
  const toEngine: Json[] = [];
  const log = new FileEventLog(null, 'vault');
  const policy = testPolicy({ keyDelayMs: 0, ...opts.policy });
  const relay = new Relay({ conn: conn as never, policy, log, toEngine: (raw) => toEngine.push(JSON.parse(raw) as Json) });
  let sessions = 0;
  const frameUrl = opts.frameUrl ?? 'http://127.0.0.1:1/login';
  conn.handlers.set('Browser.getVersion', () => ({ product: 'Chrome/156' }));
  conn.handlers.set('Target.createTarget', () => {
    setTimeout(() => conn.emitEvent('Target.attachedToTarget', { sessionId: 'V-RUN', targetInfo: { targetId: 'RUN', type: 'page', url: 'about:blank' }, waitingForDebugger: true }), 0);
    return { targetId: 'RUN' };
  });
  conn.handlers.set('Page.getFrameTree', () => ({ frameTree: { frame: { id: 'RUN', url: frameUrl } } }));
  conn.handlers.set('Target.attachToTarget', () => ({ sessionId: `E-${++sessions}` }));
  conn.handlers.set('Target.getTargetInfo', (p) => ({ targetInfo: { targetId: p.targetId, type: 'page', url: '' } }));
  const page: FakePage = { type: 'password', active: true, connected: true, len: 0, value: '', rowLabel: null };
  conn.handlers.set('Page.createIsolatedWorld', () => ({ executionContextId: 1 }));
  conn.handlers.set('Runtime.evaluate', (p) => (p.returnByValue && String(p.expression).includes('textContent') ? { result: { value: page.rowLabel } } : { result: { objectId: 'OBJ' } }));
  conn.handlers.set('DOM.describeNode', () => ({ node: { backendNodeId: 7 } }));
  conn.handlers.set('Runtime.callFunctionOn', (p) =>
    String(p.functionDeclaration).includes('return typeof this.value')
      ? { result: { value: page.value } }
      : { result: { value: { type: page.type, active: page.active, connected: page.connected, len: page.len } } },
  );
  conn.handlers.set('Input.insertText', async (p) => {
    page.value += String(p.text);
    page.len = [...page.value].length;
    return {};
  });
  await relay.init();
  await relay.createRunPage();
  relay.onEngineMessage(JSON.stringify({ id: 1, method: 'Target.setAutoAttach', params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true } }));
  await tick();
  const events: FakeRelay['events'] = [];
  const ops = new SecretOps(relay, policy, log, { emit: (to, name, data) => events.push({ to, name, data }), ...opts.ops });
  ops.openBlocker = async () => null;
  ops.runTriggers.set('r1', 'local');
  const sid = 'E-1';
  let nextEngineId = 100;
  const call = async (method: string, params: Json = {}, result: Json = {}): Promise<Json> => {
    const id = nextEngineId++;
    const before = conn.raw.length;
    relay.onEngineMessage(JSON.stringify({ id, method, params, sessionId: sid }));
    await tick(1);
    const fwd = conn.raw.slice(before).find((m) => m.method === method);
    if (fwd) conn.reply(Number(fwd.id), result, sid);
    await relay.drained();
    await tick(1);
    return toEngine.filter((m) => m.id === id).at(-1) ?? {};
  };
  return { conn, relay, log, toEngine, page, ops, events, sid, call };
}
