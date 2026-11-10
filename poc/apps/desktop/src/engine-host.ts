// main이 금고·엔진을 띄우고 잇는다(D01 §2.1). main↔엔진은 두 통로다(ADR-021).
// - 중계 통로(엔진 parentPort): main 질의·렌더러 명령·실행 명령, 엔진 → main 실행 이벤트.
// - 게이트 포트(MessageChannelMain): 게이트 요청·닫힘과 InDoubt 증언 요청·철회(엔진 → main), LocalApproval·LocalAttestation(main → 엔진)만.
//   answerGate()·answerAttest() 둘로만 쓴다.
// - auth 포트(MessageChannelMain, 세 번째 전달 포트): 엔진 → 게이트웨이 요청 헤더(gateway-auth.ts). 엔진 init 포트 순서는 [중계, 게이트, auth]다.
//   답하는 쪽은 setGatewayAuth로 붙인다. 붙기 전에는 account.signed_out으로 답한다(엔진은 decide.unavailable, 대화는 연결 안 됨).
// 렌더러 IPC 처리기는 answerGate·answerAttest를 부르지 않는다(tests/h01-guards.test.ts가 소스로 확인한다).
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import type { AttestRejectCode, AttestRequest, AttestWithdrawReason, GatePortMessage, GateRequest, LocalApproval, LocalAttestation } from '@sax/engine/gate';
import type { EngineInit, EnginePortal } from '@sax/engine/protocol';
import { wrapPort, type EventLog, type PortLike } from '@sax/platform';
import { childEnv } from './child-env.ts';
import { authPortResponder, type GwAuthResult } from './gateway-auth.ts';
import type { SecretInputBind } from './secret-labels.ts';

const require = createRequire(import.meta.url);

/** main 프로세스 안에서 도는 금고(시험 정책·메모리 키, fixture 시연·e2e 전용). 앱 금고 entry는 설정을 받지 않는다. */
export interface InlineVault {
  /** secretInput 포트는 결속값(I-1)과 함께 붙인다. 금고는 그 값으로 한 번만 받는다. */
  attachPort(kind: 'engine' | 'control' | 'secretInput', port: PortLike, bind?: SecretInputBind): void;
  shutdown(): Promise<void>;
}

export interface EngineHostOptions {
  /** 'process'면 utilityProcess 금고(앱 폴더·OS 키체인). */
  vault: 'process' | InlineVault;
  /** 엔진 앱 폴더. 없으면 기본 위치. */
  root?: string;
  portal: EnginePortal;
  log: EventLog;
  /**
   * 앱 판(app.getVersion(), semver). 엔진이 레지스트리 항목 minAppVersion과 대조한다(엔진 #243, D09 §8).
   * 없으면 minAppVersion이 있는 패키지는 받지도 돌리지도 않는다(엔진 fail-closed).
   */
  appVersion?: string;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * 게이트 답의 결과. verdict가 판정의 출처다.
 * - engine: 엔진이 보낸 판정(gate.answer.result).
 * - not_sent: 보내기 전에 막았다(엔진·금고가 이미 끝남). 엔진은 근거를 받지 않았다.
 * - unknown: 보낸 뒤 판정을 받지 못했다(엔진·금고 종료, 같은 게이트 다시 보냄). 엔진이 받았는지 모른다.
 */
export type GateAnswerResult = { ok: boolean; code?: string; verdict: 'engine' | 'not_sent' | 'unknown' };
/** 증언 판정(attest.answer.result). code는 엔진 거부 코드(AttestRejectCode)이거나 보내지 못한 이유다. */
export type AttestAnswerResult = { ok: boolean; code?: AttestRejectCode | string; verdict: 'engine' | 'not_sent' | 'unknown' };
export type AttestWithdrawn = { runId: string; attestReqId: string; reason: AttestWithdrawReason };

/**
 * 이벤트: 'run'(엔진 실행 이벤트 data) · 'gate'(GateRequest) · 'gate-closed'({runId, reqId, reason})
 * · 'attest'(AttestRequest) · 'attest-withdrawn'(AttestWithdrawn) · 'exit'(who, code)
 * · 'vault-event'(name, data: 금고 control 포트의 {t:'ev'}, I-2). 끝난 뒤의 호출은 바로 실패한다.
 */
export class EngineHost extends EventEmitter {
  readonly ready: Promise<void>;
  private readonly opts: EngineHostOptions;
  private readonly engine: UtilityProcess;
  private readonly vaultProc: UtilityProcess | null;
  private readonly controlPort: MessagePortMain;
  private readonly gatePort: MessagePortMain;
  private readonly authPort: MessagePortMain;
  private gatewayAuth: ((m: unknown) => Promise<GwAuthResult | null>) | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly answers = new Map<string, (r: GateAnswerResult) => void>();
  private readonly attestAnswers = new Map<string, (r: AttestAnswerResult) => void>();
  private nextId = 1;
  /** 엔진·금고가 끝났으면 그 이유. 이후 호출은 기다리지 않고 바로 실패한다. */
  private dead: string | null = null;
  private failReady: ((e: Error) => void) | null = null;

  constructor(opts: EngineHostOptions) {
    super();
    this.opts = opts;
    this.engine = utilityProcess.fork(require.resolve('@sax/engine/entry'), [], { serviceName: 'sax-engine', stdio: 'ignore', env: childEnv(), execArgv: [] });
    const relay = new MessageChannelMain();
    const ctl = new MessageChannelMain();
    const gate = new MessageChannelMain();
    const auth = new MessageChannelMain();
    this.controlPort = ctl.port2;
    this.controlPort.on('message', (e) => {
      const m = e.data as { t?: string; name?: unknown; data?: unknown };
      // 금고가 main에 알리는 것(secret.needed 등). 판단은 받는 쪽(shell-app)이 main 내장 표로 한다.
      if (m?.t === 'ev' && typeof m.name === 'string') this.emit('vault-event', m.name, m.data);
      else this.onReply(e.data);
    });
    this.controlPort.start();
    this.gatePort = gate.port2;
    this.gatePort.on('message', (e) => this.onGate(e.data as GatePortMessage));
    this.gatePort.start();
    this.authPort = auth.port2;
    // 받은 순서대로 하나씩(invalidate가 다음 gw.auth보다 먼저 토큰을 지운다).
    const onAuth = authPortResponder(
      () => this.gatewayAuth,
      (r) => {
        if (!this.dead) this.authPort.postMessage(r);
      },
    );
    this.authPort.on('message', (e) => void onAuth(e.data));
    this.authPort.start();
    if (opts.vault === 'process') {
      this.vaultProc = utilityProcess.fork(require.resolve('@sax/vault/entry'), [], { serviceName: 'sax-vault', stdio: 'ignore', env: childEnv(), execArgv: [] });
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
    // appVersion은 엔진 #243의 EngineInit 칸이다(그 전 엔진은 모르는 칸을 무시한다)
    const init: EngineInit & { appVersion?: string } = { t: 'init', root: opts.root, portal: opts.portal, ...(opts.appVersion ? { appVersion: opts.appVersion } : {}) };
    this.engine.postMessage(init, [relay.port2, gate.port1, auth.port1]);
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
    for (const a of this.attestAnswers.values()) a({ ok: false, code: `${who}_exit`, verdict: 'unknown' });
    this.attestAnswers.clear();
    this.emit('exit', who, code);
  }

  /** auth 포트에 답하는 쪽(shell-app이 계정을 만든 뒤 GatewayAuthHost.handle을 붙인다). */
  setGatewayAuth(handler: (m: unknown) => Promise<GwAuthResult | null>): void {
    this.gatewayAuth = handler;
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
    } else if (m?.t === 'attest.request') this.emit('attest', m.req satisfies AttestRequest);
    else if (m?.t === 'attest.withdrawn') this.emit('attest-withdrawn', { runId: m.runId, attestReqId: m.attestReqId, reason: m.reason } satisfies AttestWithdrawn);
    else if (m?.t === 'attest.answer.result') {
      const a = this.attestAnswers.get(m.attestReqId);
      this.attestAnswers.delete(m.attestReqId);
      a?.({ ok: m.ok === true, code: m.code, verdict: 'engine' });
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

  /**
   * 증언 바가 발급한 LocalAttestation을 게이트 포트로 보낸다(ADR-021 결정 5). 엔진의 판정(attest.answer.result)을 돌려준다.
   * note는 로컬 저널에만 남는다(텔레메트리 금지). 중계 통로로는 보내지 않는다(엔진이 security.gate_answer_from_relay로 거부).
   */
  answerAttest(attestation: LocalAttestation, note?: string): Promise<AttestAnswerResult> {
    if (this.dead) return Promise.resolve({ ok: false, code: this.dead, verdict: 'not_sent' });
    return new Promise((resolve) => {
      this.attestAnswers.get(attestation.attestReqId)?.({ ok: false, code: 'superseded', verdict: 'unknown' });
      this.attestAnswers.set(attestation.attestReqId, resolve);
      this.gatePort.postMessage({ t: 'attest.answer', attestation, ...(note ? { note } : {}) } satisfies GatePortMessage);
    });
  }

  // ---- 비밀 입력 포트: secretInputPort() 아래로는 게이트 포트를 쓰지 않는다(tests/h01-guards.test.ts가 이 경계를 본다) ----

  /** 비밀 입력 창용 금고 직결 포트(I-1). 결속값과 함께 넘긴다. main은 포트를 넘기기만 하고 내용을 읽지 않는다. */
  secretInputPort(bind: SecretInputBind): MessagePortMain {
    const ch = new MessageChannelMain();
    if (this.vaultProc) this.vaultProc.postMessage({ ports: ['secretInput'], bind }, [ch.port1]);
    else (this.opts.vault as InlineVault).attachPort('secretInput', wrapPort(ch.port1, 'electron'), bind);
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
