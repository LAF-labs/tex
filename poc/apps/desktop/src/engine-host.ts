import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { MessageChannelMain, utilityProcess, type MessagePortMain, type UtilityProcess } from 'electron';
import type { AttestRejectCode, AttestRequest, AttestWithdrawReason, GatePortMessage, GateRequest, LocalApproval, LocalAttestation } from '@sax/engine/gate';
import type { EngineInit, EnginePortal } from '@sax/engine/protocol';
import { wrapPort, type EventLog, type PortLike } from '@sax/platform';
import { childEnv } from './child-env.ts';
import { authPortResponder, type GwAuthResult } from './gateway-auth.ts';
import { isIssueLockMessage, issueLockResponder, type IssueLockResult } from './issue-lock-host.ts';
import type { SecretInputBind as OneShotInputBind } from './secret-labels.ts';
import type { CodefNeeded } from './bank-auto.ts';
type SecretInputBind = OneShotInputBind | CodefNeeded | { mode: 'store'; kind: 'cert_password'; scope: 'business' | 'personal'; notice: { version: string } };

const require = createRequire(import.meta.url);

export interface InlineVault {
  attachPort(kind: 'engine' | 'control' | 'secretInput' | 'browser', port: PortLike, bind?: SecretInputBind): void;
  shutdown(): Promise<void>;
}

interface EngineHostOptions {
  vault: 'process' | InlineVault;
  root?: string;
  portal: EnginePortal;
  log: EventLog;
  appVersion?: string;
  embeddedBrowser?: boolean;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export type GateAnswerResult = { ok: boolean; code?: string; verdict: 'engine' | 'not_sent' | 'unknown' };
export type AttestAnswerResult = { ok: boolean; code?: AttestRejectCode | string; verdict: 'engine' | 'not_sent' | 'unknown' };
export type AttestWithdrawn = { runId: string; attestReqId: string; reason: AttestWithdrawReason };

export class EngineHost extends EventEmitter {
  readonly ready: Promise<void>;
  private readonly opts: EngineHostOptions;
  private readonly engine: UtilityProcess;
  private readonly vaultProc: UtilityProcess | null;
  private readonly controlPort: MessagePortMain;
  private readonly gatePort: MessagePortMain;
  private readonly authPort: MessagePortMain;
  private readonly browserPort: MessagePortMain | null;
  private gatewayAuth: ((m: unknown) => Promise<GwAuthResult | null>) | null = null;
  private issueLock: ((m: unknown) => Promise<IssueLockResult | null>) | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly answers = new Map<string, (r: GateAnswerResult) => void>();
  private readonly attestAnswers = new Map<string, (r: AttestAnswerResult) => void>();
  private nextId = 1;
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
      if (m?.t === 'ev' && typeof m.name === 'string') this.emit('vault-event', m.name, m.data);
      else this.onReply(e.data);
    });
    this.controlPort.start();
    this.gatePort = gate.port2;
    this.gatePort.on('message', (e) => this.onGate(e.data as GatePortMessage));
    this.gatePort.start();
    this.authPort = auth.port2;
    const onAuth = authPortResponder(
      () => this.gatewayAuth,
      (r) => {
        if (!this.dead) this.authPort.postMessage(r);
      },
    );
    const onLock = issueLockResponder(
      () => this.issueLock,
      (r) => {
        if (!this.dead) this.authPort.postMessage(r);
      },
    );
    this.authPort.on('message', (e) => (isIssueLockMessage(e.data) ? onLock(e.data) : void onAuth(e.data)));
    this.authPort.start();
    const br = opts.embeddedBrowser ? new MessageChannelMain() : null;
    this.browserPort = br?.port2 ?? null;
    this.browserPort?.on('message', (e) => this.emit('browser', e.data));
    this.browserPort?.start();
    if (opts.vault === 'process') {
      this.vaultProc = utilityProcess.fork(require.resolve('@sax/vault/entry'), [], { serviceName: 'sax-vault', stdio: 'ignore', env: childEnv(), execArgv: [] });
      if (br) this.vaultProc.postMessage({ ports: ['engine', 'control', 'browser'] }, [relay.port1, ctl.port1, br.port1]);
      else this.vaultProc.postMessage({ ports: ['engine', 'control'] }, [relay.port1, ctl.port1]);
      this.vaultProc.on('exit', (c) => this.exited('vault', c));
    } else {
      this.vaultProc = null;
      opts.vault.attachPort('engine', wrapPort(relay.port1, 'electron'));
      opts.vault.attachPort('control', wrapPort(ctl.port1, 'electron'));
      if (br) opts.vault.attachPort('browser', wrapPort(br.port1, 'electron'));
    }
    this.ready = new Promise((resolve, reject) => {
      this.failReady = reject;
      this.engine.on('message', (m: { t?: string; code?: string; name?: string; data?: unknown }) => {
        if (m?.t === 'ready') resolve();
        else if (m?.t === 'fatal') reject(new Error(m.code));
        else if (m?.t === 'ev' && m.name === 'run') this.emit('run', m.data);
        else if (m?.t === 'ev' && m.name === 'codef') this.emit('codef', m.data);
        else this.onReply(m);
      });
    });
    this.ready.catch((e: Error) => opts.log.event('main.engine_fatal', { code: e.message.slice(0, 60).replace(/[^A-Za-z0-9_.:-]/g, '_') }));
    const init: EngineInit & { appVersion?: string } = { t: 'init', root: opts.root, portal: opts.portal, ...(opts.appVersion ? { appVersion: opts.appVersion } : {}) };
    this.engine.postMessage(init, [relay.port2, gate.port1, auth.port1]);
    this.engine.on('exit', (c) => this.exited('engine', c));
  }

  private exited(who: 'engine' | 'vault', code: number): void {
    this.opts.log.event(`main.${who}_exit`, { code });
    this.dead ??= `${who}_exit`;
    this.failReady?.(new Error(`${who}_exit`));
    if (who === 'vault') this.engine.kill();
    for (const p of this.pending.values()) p.reject(new Error(`${who}_exit`));
    this.pending.clear();
    for (const a of this.answers.values()) a({ ok: false, code: `${who}_exit`, verdict: 'unknown' });
    this.answers.clear();
    for (const a of this.attestAnswers.values()) a({ ok: false, code: `${who}_exit`, verdict: 'unknown' });
    this.attestAnswers.clear();
    this.emit('exit', who, code);
  }

  setGatewayAuth(handler: (m: unknown) => Promise<GwAuthResult | null>): void {
    this.gatewayAuth = handler;
  }

  setIssueLock(handler: (m: unknown) => Promise<IssueLockResult | null>): void {
    this.issueLock = handler;
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

  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    await this.ready;
    return this.call('engine', method, params);
  }

  control(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.call('control', method, params);
  }

  answerGate(approval: LocalApproval): Promise<GateAnswerResult> {
    if (this.dead) return Promise.resolve({ ok: false, code: this.dead, verdict: 'not_sent' });
    return new Promise((resolve) => {
      this.answers.get(approval.reqId)?.({ ok: false, code: 'superseded', verdict: 'unknown' });
      this.answers.set(approval.reqId, resolve);
      this.gatePort.postMessage({ t: 'gate.answer', approval } satisfies GatePortMessage);
    });
  }

  answerAttest(attestation: LocalAttestation, note?: string): Promise<AttestAnswerResult> {
    if (this.dead) return Promise.resolve({ ok: false, code: this.dead, verdict: 'not_sent' });
    return new Promise((resolve) => {
      this.attestAnswers.get(attestation.attestReqId)?.({ ok: false, code: 'superseded', verdict: 'unknown' });
      this.attestAnswers.set(attestation.attestReqId, resolve);
      this.gatePort.postMessage({ t: 'attest.answer', attestation, ...(note ? { note } : {}) } satisfies GatePortMessage);
    });
  }

  secretInputPort(bind: SecretInputBind): MessagePortMain {
    const ch = new MessageChannelMain();
    if (this.vaultProc) this.vaultProc.postMessage({ ports: ['secretInput'], bind }, [ch.port1]);
    else (this.opts.vault as InlineVault).attachPort('secretInput', wrapPort(ch.port1, 'electron'), bind);
    return ch.port2;
  }

  browserPost(m: unknown): void {
    if (!this.dead) this.browserPort?.postMessage(m);
  }

  async shutdown(): Promise<void> {
    const gone = this.dead ? Promise.resolve() : new Promise<void>((r) => this.engine.once('exit', () => r()));
    this.dead ??= 'shutdown';
    this.engine.kill();
    this.vaultProc?.kill();
    await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
    if (this.opts.vault !== 'process') await this.opts.vault.shutdown().catch(() => {});
  }
}
