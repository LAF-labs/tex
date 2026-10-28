// 금고 포트 메시지(D01 §2.1: MessagePort 기반 타입드 IPC). 포트는 세 종류다.
// - engine: CDP 프레임(cdp)과 RPC(typist·secretWindow·browser·getDbKeyOnce)
// - control(main): 실행 트리거 통지, 사용자 "입력 완료", 상태
// - secretInput(금고 직결 입력 창): 한 번 쓰는 비밀 제공. main은 이 포트의 내용을 보지 않는다.
export type PortKind = 'engine' | 'control' | 'secretInput';

export type InboundMessage =
  | { t: 'cdp'; m: string }
  | { t: 'rpc'; id: number; method: string; params?: Record<string, unknown> };

export type OutboundMessage =
  | { t: 'cdp'; m: string }
  | { t: 'rpc'; id: number; result?: unknown; error?: string }
  | { t: 'ev'; name: string; data: Record<string, unknown> };

export const RPC_BY_PORT: Record<PortKind, readonly string[]> = {
  engine: ['browser.launch', 'browser.shutdown', 'typist.fill', 'secretWindow.openForHuman', 'secretWindow.requestClose', 'getDbKeyOnce'],
  control: ['run.begin', 'run.end', 'secretWindow.userDone', 'status'],
  secretInput: ['secret.provide'],
};
