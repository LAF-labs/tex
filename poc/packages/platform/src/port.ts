// Electron MessagePortMain과 Node worker_threads MessagePort를 같은 모양으로 다룬다.
export interface PortLike {
  postMessage(msg: unknown): void;
  onMessage(fn: (msg: unknown) => void): void;
  close(): void;
}

interface NodeStylePort {
  postMessage(msg: unknown): void;
  on(ev: 'message', fn: (arg: unknown) => void): unknown;
  start?(): void;
  close(): void;
}

/** Electron MessagePortMain은 이벤트 객체({data})로, Node MessagePort는 값으로 전달한다. */
export function wrapPort(raw: NodeStylePort, kind: 'node' | 'electron'): PortLike {
  return {
    postMessage: (m) => raw.postMessage(m),
    onMessage: (fn) => {
      raw.on('message', (arg) => fn(kind === 'electron' ? (arg as { data: unknown }).data : arg));
      raw.start?.();
    },
    close: () => raw.close(),
  };
}

/** 누출 스캐너가 IPC 캡처를 보도록 양방향 메시지를 기록한다. */
export function tapPort(port: PortLike, sink: (dir: 'in' | 'out', msg: unknown) => void): PortLike {
  return {
    postMessage: (m) => {
      sink('out', m);
      port.postMessage(m);
    },
    onMessage: (fn) => port.onMessage((m) => {
      sink('in', m);
      fn(m);
    }),
    close: () => port.close(),
  };
}
