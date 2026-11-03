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
  | { t: 'ev'; name: string; data: Record<string, unknown> }
  /** 금고가 Chrome을 내렸거나 Chrome이 끝났다. 엔진은 CDP transport를 닫는다. */
  | { t: 'cdp_closed' };

export const RPC_BY_PORT: Record<PortKind, readonly string[]> = {
  engine: ['browser.launch', 'browser.shutdown', 'typist.fill', 'secretWindow.openForHuman', 'secretWindow.requestClose', 'getDbKeyOnce'],
  control: ['run.begin', 'run.end', 'secretWindow.userDone', 'status'],
  secretInput: ['secret.provide'],
};

/**
 * 비밀 입력 포트 결속(I-1, N-44). main이 secretInput 포트를 넘길 때 함께 준다.
 * 금고는 이 포트에서 이 값으로 secret.provide를 한 번만 받는다. 결속이 없거나 틀리면 포트를 붙이지 않는다.
 */
export type SecretInputBind = {
  runId: string;
  kind: 'cert_password' | 'portal_password' | 'security_card';
  scope: 'business' | 'personal';
  row?: number;
};

/** 실행 트리거(I-9). 금고는 이 밖을 bad_trigger로 거부한다. */
export const RUN_TRIGGERS = ['local', 'remote', 'daemon'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** 금고 → main(control 포트) 이벤트(I-2). 엔진 포트에는 secret_window.refused·leak_suspected만 간다(I-3). */
export type VaultEventName = 'secret.needed' | 'secret.expired' | 'secret_window.refused' | 'secret_window.leak_suspected';
