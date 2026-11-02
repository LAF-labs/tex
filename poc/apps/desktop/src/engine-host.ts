// main이 금고·엔진을 띄우고 잇는다(D01 §2.1). main↔엔진은 두 통로다(ADR-021).
// - 중계 통로(엔진 parentPort): main 질의·렌더러 명령·실행 명령, 엔진 → main 실행 이벤트.
// - 게이트 포트(MessageChannelMain): 게이트 요청·닫힘(엔진 → main), LocalApproval(main → 엔진)만. answerGate() 하나로만 쓴다.
// 렌더러 IPC 처리기는 answerGate를 부르지 않는다(tests/h01-guards.test.ts가 소스로 확인한다).
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import type { GatePortMessage, GateRequest, LocalApproval } from '@sax/engine/gate';
import type { EngineInit, EnginePortal } from '@sax/engine/protocol';
import { wrapPort, type EventLog, type PortLike } from '@sax/platform';

const require = createRequire(import.meta.url);

/** main 프로세스 안에서 도는 금고(시험 정책·메모리 키, fixture 시연·e2e 전용). 앱 금고 entry는 설정을 받지 않는다. */
export interface InlineVault {
  attachPort(kind: 'engine' | 'control' | 'secretInput', port: PortLike): void;
  shutdown(): Promise<void>;
}

export interface EngineHostOptions {
  /** 'process'면 utilityProcess 금고(앱 폴더·OS 키체인). */
  vault: 'process' | InlineVault;
  /** 엔진 앱 폴더. 없으면 기본 위치. */
  root?: string;
  portal: EnginePortal;
  log: EventLog;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * 게이트 답의 결과. verdict가 판정의 출처다.
 * - engine: 엔진이 보낸 판정(gate.answer.result).
 * - not_sent: 보내기 전에 막았다(엔진·금고가 이미 끝남). 엔진은 근거를 받지 않았다.
 * - unknown: 보낸 뒤 판정을 받지 못했다(엔진·금고 종료, 같은 게이트 다시 보냄). 엔진이 받았는지 모른다.
 */
export type GateAnswerResult = { ok: boolean; code?: string; verdict: 'engine' | 'not_sent' | 'unknown' };

/** 이벤트: 'run'(엔진 실행 이벤트 data) · 'gate'(GateRequest) · 'gate-closed'({runId, reqId, reason}) · 'exit'(who, code). 끝난 뒤의 호출은 바로 실패한다. */
export class EngineHost extends EventEmitter {
  readonly ready: Promise<void>;
  private readonly opts: EngineHostOptions;
  private readonly engine: UtilityProcess;
  private readonly vaultProc: UtilityProcess | null;
  private readonly controlPort: MessagePortMain;
  private readonly gatePort: MessagePortMain;
  private readonly pending = new Map<number, Pending>();
  private readonly answers = new Map<string, (r: GateAnswerResult) => void>();
  private nextId = 1;
  /** 엔진·금고가 끝났으면 그 이유. 이후 호출은 기다리지 않고 바로 실패한다. */
  private dead: string | null = null;
  private failReady: ((e: Error) => void) | null = null;

  constructor(opts: EngineHostOptions) {
    super();
    this.opts = opts;
    this.engine = utilityProcess.fork(require.resolve('@sax/engine/entry'), [], { serviceName: 'sax-engine', stdio: 'ignore' });
    const relay = new MessageChannelMain();
    const ctl = new MessageChannelMain();
    const gate = new MessageChannelMain();
    this.controlPort = ctl.port2;
    this.controlPort.on('message', (e) => this.onReply(e.data));
    this.controlPort.start();
    this.gatePort = gate.port2;
    this.gatePort.on('message', (e) => this.onGate(e.data as GatePortMessage));
    this.gatePort.start();
    if (opts.vault === 'process') {
      this.vaultProc = utilityProcess.fork(require.resolve('@sax/vault/entry'), [], { serviceName: 'sax-vault', stdio: 'ignore' });
      this.vaultProc.postMessage({ ports: ['engine', 'control'] }, [relay.port1, ctl.port1]);
      this.vaultProc.on('exit', (c) => this.exited('vault', c));
    } else {
      this.vaultProc = null;
      opts.vault.attachPort('engine', wrapPort(relay.port1, 'electron'));
      opts.vault.attachPort('control', wrapPort(ctl.port1, 'electron'));
    }
    this.ready = new Promise((resolve, reject) => {
      this.failReady = reject;
      this.engine.on('message', (m: { t?: string; code?: string; name?: string; data?: unknown }) => {
        if (m?.t === 'ready') resolve();
        else if (m?.t === 'fatal') reject(new Error(m.code));
        else if (m?.t === 'ev' && m.name === 'run') this.emit('run', m.data);
        else this.onReply(m);
      });
    });
    // 기다리는 쪽이 없을 때 엔진 fatal이 처리되지 않은 거부로 남지 않게 한다(부르는 쪽은 ready를 await한다).
    this.ready.catch((e: Error) => opts.log.event('main.engine_fatal', { code: e.message.slice(0, 60).replace(/[^A-Za-z0-9_.:-]/g, '_') }));
    const init: EngineInit = { t: 'init', root: opts.root, portal: opts.portal };
    this.engine.postMessage(init, [relay.port2, gate.port1]);
    this.engine.on('exit', (c) => this.exited('engine', c));
  }

  private exited(who: 'engine' | 'vault', code: number): void {
    this.opts.log.event(`main.${who}_exit`, { code });
    this.dead ??= `${who}_exit`;
    // ready 전에 끝났으면 기다리는 쪽이 영영 멈추지 않게 실패로 끝낸다(이미 정해졌으면 아무 일도 없다).
    this.failReady?.(new Error(`${who}_exit`));
    // 금고가 끝나면 엔진도 끝낸다. 이 호스트는 이미 호출을 막았으니(dead) 엔진이 남아 있으면 열린 게이트·실행을 아무도 멈추지 못한다.
    // 엔진이 끝나면 'exit'('engine')이 다시 와서 실행을 끝낸다(ShellRuns).
    if (who === 'vault') this.engine.kill();
    for (const p of this.pending.values()) p.reject(new Error(`${who}_exit`));
    this.pending.clear();
    for (const a of this.answers.values()) a({ ok: false, code: `${who}_exit`, verdict: 'unknown' });
    this.answers.clear();
    this.emit('exit', who, code);
  }

  private onReply(msg: { t?: string; id?: number; result?: unknown; error?: string }): void {
    if (msg?.t !== 'rpc' || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    this.pending.delete(msg.id);
    if (!p) return;
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg.result);
  }

  private onGate(m: GatePortMessage): void {
    if (m?.t === 'gate.request') this.emit('gate', m.req as GateRequest);
    else if (m?.t === 'gate.closed') this.emit('gate-closed', { runId: m.runId, reqId: m.reqId, reason: m.reason });
    else if (m?.t === 'gate.answer.result') {
      const a = this.answers.get(m.reqId);
      this.answers.delete(m.reqId);
      a?.({ ok: m.ok, code: m.code, verdict: 'engine' });
    }
  }

  private call(target: 'engine' | 'control', method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const msg = { t: 'rpc', id, method, params };
      if (target === 'engine') this.engine.postMessage(msg);
      else this.controlPort.postMessage(msg);
    });
  }

  /** 중계 통로 RPC(질의·명령). 승인·증언을 여기로 보내면 엔진이 거부한다. */
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ready;
    return this.call('engine', method, params);
  }

  /** 금고 제어 포트(run.begin 등). */
  control(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.call('control', method, params);
  }

  /** 승인 바가 발급한 근거를 게이트 포트로 보낸다. 엔진의 판정(gate.answer.result)을 돌려준다. */
  answerGate(approval: LocalApproval): Promise<GateAnswerResult> {
    if (this.dead) return Promise.resolve({ ok: false, code: this.dead, verdict: 'not_sent' });
    return new Promise((resolve) => {
      // 같은 게이트로 두 번 보내면 앞의 기다림은 풀어 준다(엔진은 두 번째를 거부한다). 앞 것의 판정은 모른다.
      this.answers.get(approval.reqId)?.({ ok: false, code: 'superseded', verdict: 'unknown' });
      this.answers.set(approval.reqId, resolve);
      this.gatePort.postMessage({ t: 'gate.answer', approval } satisfies GatePortMessage);
    });
  }

  /** 비밀 입력 창용 금고 직결 포트. main은 포트를 넘기기만 하고 내용을 읽지 않는다. */
  secretInputPort(): MessagePortMain {
    const ch = new MessageChannelMain();
    if (this.vaultProc) this.vaultProc.postMessage({ ports: ['secretInput'] }, [ch.port1]);
    else (this.opts.vault as InlineVault).attachPort('secretInput', wrapPort(ch.port1, 'electron'));
    return ch.port2;
  }

  /** 엔진(과 금고)을 끝내고 엔진이 실제로 끝날 때까지(최대 3초) 기다린다. 그 뒤에야 앱 폴더를 지워도 DB·WAL이 열려 있지 않다. */
  async shutdown(): Promise<void> {
    const gone = this.dead ? Promise.resolve() : new Promise<void>((r) => this.engine.once('exit', () => r()));
    this.dead ??= 'shutdown';
    this.engine.kill();
    this.vaultProc?.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
    if (this.opts.vault !== 'process') await this.opts.vault.shutdown().catch(() => {});
  }
}
