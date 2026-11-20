import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  approveMessage, b64, fromB64, ulid, verifyApprove,
  type GateRefreshBody, type GateRequestBody, type GateResolvedBody, type GateResolvedBy, type GateResponseBody, type PxHw,
} from '@sax/remote';
import { gateSelfCheck, remotePresenceRefusal, type GateRequest } from '@sax/engine/gate';
import { kstToday, summarize } from './approval-gate.ts';
import { WAKE_APPROVE_AGAIN_MS, WAKE_DETACHED_MS, type WakeKind } from './phone-wake.ts';

export const PHONE_GATE_TTL_MS = 120_000;
export const REMOTE_PER_DAY = 5;
export const BAD_SIG_MAX = 3;
const LOG_KEEP = 200;
const STEP_REF = /^s[0-9]{1,3}[a-z]?$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

type PcOnlyCode = 'pc_key' | 'pc_first' | 'pc_limit' | 'pc_only';

interface ApprovalRow {
  at: number;
  day: string;
  pairId: string;
  deviceId: string;
  reqId: string;
  gateReqId: string;
  actionHash: string;
  sig: string;
  challenge: string;
}

const isRow = (x: unknown): x is ApprovalRow => {
  const r = x as Partial<ApprovalRow> | null;
  return !!r && typeof r === 'object' && Number.isSafeInteger(r.at) && typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && typeof r.reqId === 'string';
};

export class ApprovalLog {
  #file: string;
  #rows: Promise<ApprovalRow[] | null> | null = null;
  #write: Promise<void> = Promise.resolve();
  constructor(file: string) {
    this.#file = file;
  }
  #load(): Promise<ApprovalRow[] | null> {
    this.#rows ??= fs.readFile(this.#file, 'utf8').then(
      (t) => {
        try {
          const j = JSON.parse(t) as { v?: number; rows?: unknown };
          return j.v === 1 && Array.isArray(j.rows) && j.rows.every(isRow) ? (j.rows as ApprovalRow[]) : null;
        } catch {
          return null;
        }
      },
      (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : null),
    );
    return this.#rows;
  }
  async countOn(day: string): Promise<number> {
    const rows = await this.#load();
    return rows ? rows.filter((r) => r.day === day).length : Infinity;
  }
  async put(row: ApprovalRow): Promise<void> {
    const rows = await this.#load();
    if (!rows) throw new Error('approval_log.unreadable');
    rows.push(row);
    if (rows.length > LOG_KEEP) rows.splice(0, rows.length - LOG_KEEP);
    const snapshot = JSON.stringify({ v: 1, rows });
    const run = async () => {
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.#file);
    };
    const p = this.#write.then(run, run);
    this.#write = p.catch(() => undefined);
    await p;
  }
}

export interface GateSink {
  send(type: 'gate.request', body: GateRequestBody): unknown;
  send(type: 'gate.resolved', body: GateResolvedBody): unknown;
}

interface PhoneGatePorts {
  px: (pairId: string) => { pub: Uint8Array; hw: PxHw; deviceId: string } | null;
  tracked: (shellRunId: string) => { pairId: string; runId: string } | null;
  poke: (shellRunId: string) => void;
  approvals: Pick<ApprovalLog, 'countOn' | 'put'>;
  perDay?: number;
  now?: () => number;
  random?: (n: number) => Uint8Array;
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
  wake?: (pairId: string, kind: WakeKind) => unknown;
  attached?: (pairId: string) => void;
  timers?: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

const systemTimers = {
  set: (f: () => void, ms: number) => {
    const t = setTimeout(f, ms);
    t.unref?.();
    return t;
  },
  clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface GateHandlers {
  approve: () => void | Promise<void>;
  deny: () => void | Promise<void>;
}

interface OpenGate {
  shellRunId: string;
  req: GateRequest;
  pairId: string;
  runId: string;
  reqId: string;
  on: GateHandlers;
  refusal: PcOnlyCode | null;
  pending: { challenge: Uint8Array; exp: number } | null;
  badSigs: number;
  sent: boolean;
  wakes: number;
  again: unknown;
}

type AnswerResult =
  | 'approved' | 'denied'
  | 'no_request' | 'wrong_gate' | 'sig_alg' | 'wrong_action' | 'expired' | 'no_key' | 'bad_sig' | 'limit' | 'log_failed';

export class PhoneGate {
  #o: PhoneGatePorts;
  #sinks = new Map<string, GateSink>();
  #open = new Map<string, OpenGate>();
  #turn: Promise<unknown> = Promise.resolve();
  constructor(o: PhoneGatePorts) {
    this.#o = o;
  }
  #now(): number {
    return (this.#o.now ?? Date.now)();
  }
  #log(result: string): void {
    this.#o.log?.('main.phone_gate', { result });
  }
  #perDay(): number {
    return Math.min(this.#o.perDay ?? REMOTE_PER_DAY, REMOTE_PER_DAY);
  }

  canApprove(pairId: string): boolean {
    return this.#sinks.has(pairId) && !!this.#o.px(pairId);
  }

  async leftToday(): Promise<number> {
    const used = await this.#o.approvals.countOn(kstToday(this.#now()));
    return Math.max(0, this.#perDay() - used);
  }

  codeOf(shellRunId: string): PcOnlyCode | undefined {
    return this.#open.get(shellRunId)?.refusal ?? undefined;
  }

  attach(pairId: string, sink: GateSink): void {
    this.#sinks.set(pairId, sink);
    this.#o.attached?.(pairId);
    for (const g of this.#open.values()) {
      if (g.pairId !== pairId) continue;
      this.#stopAgain(g);
      if (!g.refusal) this.#send(g);
    }
  }
  detach(pairId: string, sink: GateSink): void {
    if (this.#sinks.get(pairId) !== sink) return;
    this.#sinks.delete(pairId);
    for (const g of this.#open.values()) {
      if (g.pairId !== pairId || g.refusal || !g.sent || g.wakes >= 2) continue;
      this.#stopAgain(g);
      g.again = (this.#o.timers ?? systemTimers).set(() => {
        g.again = null;
        if (this.#open.get(g.shellRunId) === g && !g.refusal && !this.#sinks.has(g.pairId)) this.#wakeApprove(g);
      }, WAKE_DETACHED_MS);
    }
  }

  async offer(shellRunId: string, req: GateRequest, on: GateHandlers): Promise<boolean> {
    const t = this.#o.tracked(shellRunId);
    if (!t) return false;
    const g: OpenGate = { shellRunId, req, pairId: t.pairId, runId: t.runId, reqId: ulid(this.#now()), on, refusal: null, pending: null, badSigs: 0, sent: false, wakes: 0, again: null };
    const prev = this.#open.get(shellRunId);
    if (prev) this.#stopAgain(prev);
    this.#open.set(shellRunId, g);
    g.refusal = await this.#refusal(g);
    if (this.#open.get(shellRunId) !== g) return true;
    if (g.refusal) this.#log(g.refusal);
    else {
      this.#send(g);
      if (!this.#sinks.has(g.pairId)) this.#wakeApprove(g);
    }
    this.#o.poke(shellRunId);
    return true;
  }

  #wakeApprove(g: OpenGate): void {
    if (!this.#o.wake || g.wakes >= 2) return;
    g.wakes++;
    this.#o.wake(g.pairId, 'approve');
    if (g.wakes >= 2) return;
    g.again = (this.#o.timers ?? systemTimers).set(() => {
      g.again = null;
      if (this.#open.get(g.shellRunId) === g && !g.refusal && !this.#sinks.has(g.pairId)) this.#wakeApprove(g);
    }, WAKE_APPROVE_AGAIN_MS);
  }

  #stopAgain(g: OpenGate): void {
    if (g.again === null) return;
    (this.#o.timers ?? systemTimers).clear(g.again);
    g.again = null;
  }

  #drop(g: OpenGate): void {
    this.#stopAgain(g);
    if (this.#open.get(g.shellRunId) === g) this.#open.delete(g.shellRunId);
  }

  async #refusal(g: OpenGate): Promise<PcOnlyCode | null> {
    if (!this.#o.px(g.pairId)) return 'pc_key';
    const why = remotePresenceRefusal(g.req);
    if (why === 'first') return 'pc_first';
    if (why) return 'pc_only';
    if (gateSelfCheck(g.req) !== null || !Array.isArray(summarize(g.req, kstToday(this.#now())))) return 'pc_only';
    if (!STEP_REF.test(g.req.gateStepId) || !ULID.test(g.req.cardHashInputs.intentId)) return 'pc_only';
    if ((await this.#o.approvals.countOn(kstToday(this.#now()))) >= this.#perDay()) return 'pc_limit';
    return null;
  }

  #send(g: OpenGate): void {
    const sink = this.#sinks.get(g.pairId);
    if (!sink) {
      g.pending = null;
      return;
    }
    const challenge = (this.#o.random ?? ((n: number) => new Uint8Array(randomBytes(n))))(32);
    const exp = this.#now() + PHONE_GATE_TTL_MS;
    const body: GateRequestBody = {
      runId: g.runId,
      stepId: g.req.gateStepId,
      reqId: g.reqId,
      cardId: 'invoice.confirm',
      gateKind: 'commit',
      effects: ['issue_document', 'send'],
      fields: g.req.fields.map((f) => ({ key: f.fieldKey, value: f.value })),
      cardHashInputs: g.req.cardHashInputs,
      actionHash: g.req.actionHash,
      requiredSigAlg: 'p256',
      challenge: b64(challenge),
      exp,
    };
    try {
      sink.send('gate.request', body);
      g.pending = { challenge, exp };
      g.sent = true;
      this.#log('sent');
    } catch {
      g.pending = null;
      this.#log('send_failed');
    }
  }

  refresh(pairId: string, body: GateRefreshBody): void {
    const g = [...this.#open.values()].find((x) => x.pairId === pairId && x.reqId === body.reqId && x.runId === body.runId);
    if (!g || g.refusal) return;
    this.#send(g);
  }

  close(shellRunId: string, gateReqId?: string, by: GateResolvedBy = 'pc'): void {
    const g = this.#open.get(shellRunId);
    if (!g || (gateReqId !== undefined && g.req.reqId !== gateReqId)) return;
    this.#drop(g);
    if (g.sent) this.#resolved(g, by);
  }

  #resolved(g: OpenGate, by: GateResolvedBy): void {
    const sink = this.#sinks.get(g.pairId);
    if (!sink) return;
    try {
      sink.send('gate.resolved', { runId: g.runId, reqId: g.reqId, by });
      this.#log(`resolved_${by}`);
    } catch {
      this.#log('resolved_send_failed');
    }
  }

  answer(pairId: string, body: GateResponseBody): Promise<AnswerResult> {
    const turn = this.#turn.then(() => this.#answer(pairId, body));
    this.#turn = turn.catch(() => undefined);
    return turn.then((r) => {
      this.#log(r);
      return r;
    });
  }

  async #answer(pairId: string, body: GateResponseBody): Promise<AnswerResult> {
    const g = [...this.#open.values()].find((x) => x.pairId === pairId && x.reqId === body.reqId);
    if (!g || g.refusal || !g.pending) return 'no_request';
    if (body.runId !== g.runId || body.stepId !== g.req.gateStepId) return 'wrong_gate';
    if (body.sigAlg !== 'p256') return 'sig_alg';
    if (body.actionHash !== g.req.actionHash) return 'wrong_action';
    const now = this.#now();
    if (now > g.pending.exp) return 'expired';
    const key = this.#o.px(pairId);
    if (!key) {
      g.refusal = 'pc_key';
      g.pending = null;
      this.#o.poke(g.shellRunId);
      return 'no_key';
    }
    const input = { pairId, reqId: g.reqId, challenge: g.pending.challenge, actionHash: g.req.actionHash, decision: body.decision };
    let sig: Uint8Array;
    try {
      approveMessage(input);
      sig = fromB64(body.sig);
    } catch {
      sig = new Uint8Array(0);
    }
    if (!verifyApprove(key.pub, input, sig)) {
      if (++g.badSigs >= BAD_SIG_MAX) {
        g.refusal = 'pc_only';
        g.pending = null;
        this.#o.poke(g.shellRunId);
      }
      return 'bad_sig';
    }
    const challenge = g.pending.challenge;
    g.pending = null;
    if (body.decision === 'deny') {
      this.#drop(g);
      this.#resolved(g, 'phone');
      await g.on.deny();
      return 'denied';
    }
    const day = kstToday(now);
    if ((await this.#o.approvals.countOn(day)) >= this.#perDay()) {
      g.refusal = 'pc_limit';
      this.#o.poke(g.shellRunId);
      return 'limit';
    }
    if (this.#open.get(g.shellRunId) !== g) return 'no_request';
    try {
      await this.#o.approvals.put({ at: now, day, pairId, deviceId: key.deviceId, reqId: g.reqId, gateReqId: g.req.reqId, actionHash: g.req.actionHash, sig: b64(sig), challenge: b64(challenge) });
    } catch {
      g.refusal = 'pc_only';
      this.#o.poke(g.shellRunId);
      return 'log_failed';
    }
    if (this.#open.get(g.shellRunId) !== g) return 'no_request';
    this.#drop(g);
    this.#resolved(g, 'phone');
    await g.on.approve();
    return 'approved';
  }
}
