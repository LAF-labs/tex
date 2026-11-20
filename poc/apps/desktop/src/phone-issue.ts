import fs from 'node:fs/promises';
import { checkIssueRequest, ISSUE_PLAYBOOK, ulid, type CmdAckBody, type CmdRejectReason, type CmdRunBody, type PhoneIssueRequest, type RunEventBody, type RunPhase } from '@sax/remote';
import { kstToday } from './approval-gate.ts';
import type { Counterparty, RunView } from './shell-model.ts';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPROVAL_NO = /^[0-9-]{8,40}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CMD_KEEP = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseIssueInputs(inputs: unknown): PhoneIssueRequest | null {
  if (!isObj(inputs) || !isObj(inputs.counterpart) || !isObj(inputs.amounts) || !Array.isArray(inputs.items) || inputs.items.length !== 1 || !isObj(inputs.items[0])) return null;
  const allowed = new Set(['counterpart', 'amounts', 'items', 'issueDay']);
  if (Object.keys(inputs).some((k) => !allowed.has(k)) || Object.keys(inputs.counterpart).some((k) => k !== 'counterpartyRef')) return null;
  const r = {
    counterpartyRef: inputs.counterpart.counterpartyRef,
    supply: inputs.amounts.supply,
    tax: inputs.amounts.tax,
    item: inputs.items[0].name,
    day: inputs.issueDay,
  };
  if (typeof r.counterpartyRef !== 'string' || typeof r.item !== 'string' || typeof r.day !== 'string' || typeof r.supply !== 'number' || typeof r.tax !== 'number') return null;
  const req = r as PhoneIssueRequest;
  if (checkIssueRequest(req)) return null;
  const line = inputs.items[0];
  if (line.supply !== req.supply || line.tax !== req.tax) return null;
  return req;
}

export function phaseOf(r: RunView): RunPhase {
  if (r.status === 'done') return 'done';
  if (r.status === 'stopped' || r.discarded || (r.status === 'attention' && r.endedAt !== undefined)) return 'stopped';
  if (r.status === 'waiting') return 'approve';
  if (r.status === 'draft') return 'prepare';
  const i = r.steps.findIndex((s) => s.state === 'now' || s.state === 'attention');
  const at = i >= 0 ? i : Math.max(0, r.steps.filter((s) => s.state === 'done').length);
  return (['login', 'prepare', 'prepare', 'readback', 'approve', 'issue', 'verify', 'verify'] as const)[Math.min(at, 7)]!;
}

export function eventOf(r: RunView, runId: string, cmdId: string, at: number, approveCode?: string): RunEventBody {
  const phase = phaseOf(r);
  const turn = phase !== 'done' && phase !== 'stopped' && r.status === 'turn' && !!r.handoff;
  const ev: RunEventBody = { runId, cmdId, at, event: phase === 'done' || phase === 'stopped' ? 'end' : turn ? 'turn' : 'phase', phase, status: r.status };
  if (turn) ev.code = turnCode(r.handoff!, r);
  if (turn && r.handoff!.code === 'login.simple_sent' && r.simpleAuth) ev.deadline = r.simpleAuth.deadline;
  if (phase === 'verify' && Number.isSafeInteger(r.verifyAttempt) && r.verifyAttempt! >= 1) ev.attempt = Math.min(r.verifyAttempt!, 99);
  if (phase === 'done' && r.result && APPROVAL_NO.test(r.result.approvalNo) && Number.isSafeInteger(r.total) && r.total >= 0) {
    ev.result = { approvalNo: r.result.approvalNo, total: r.total, emailSent: r.result.mailConfirmed };
    if (UUID4.test(r.result.docId)) ev.result.docId = r.result.docId;
  }
  if (phase === 'stopped' && r.inDoubt) ev.code = 'in_doubt';
  else if (phase === 'stopped' && r.endCode === 'package.app_old' && !r.result) ev.code = 'app_old';
  else if (phase === 'stopped' && (r.redo || r.handoffEnd || r.discarded) && !r.result) ev.code = 'not_issued';
  if (phase === 'approve' && approveCode) ev.code = approveCode;
  return ev;
}

const TURN_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;
const CERT_TURN: ReadonlySet<string> = new Set(['login.simple_auth', 'login.simple_sent']);
const SA_REQ = /^sa1:req:([a-z]{2,10})(?:-(s|k|l|sa|ka|la))?:(\d{8}):(01\d{8,9}):([^:]{1,20})$/;
export function parseSimpleAnswer(v: unknown): { op: 'request'; d: { provider: string; birth: string; phone: string; name: string; carrier?: string } } | { op: 'complete' } | null {
  if (v === 'sa1:done') return { op: 'complete' };
  const m = typeof v === 'string' ? SA_REQ.exec(v) : null;
  return m ? { op: 'request', d: { provider: m[1]!, birth: m[3]!, phone: m[4]!, name: m[5]!, ...(m[2] ? { carrier: m[2].toUpperCase() } : {}) } } : null;
}
function turnCode(h: NonNullable<RunView['handoff']>, r?: RunView): string {
  if (h.code === 'login.simple_sent' && r?.simpleAuth && /^[a-z]{2,10}$/.test(r.simpleAuth.provider)) return `login.simple_sent.${r.simpleAuth.provider}`;
  if (h.code && TURN_CODE.test(h.code) && h.code.length <= 40) return h.code;
  return `turn.${h.kind ?? 'other'}`;
}

export class CmdLog {
  #file: string;
  #rows: Promise<Array<{ cmdId: string; runId: string; at: number }>> | null = null;
  #write: Promise<void> = Promise.resolve();
  constructor(file: string) {
    this.#file = file;
  }
  #load(): Promise<Array<{ cmdId: string; runId: string; at: number }>> {
    this.#rows ??= fs.readFile(this.#file, 'utf8').then(
      (t) => {
        const j = JSON.parse(t) as { v?: number; cmds?: unknown };
        return Array.isArray(j.cmds)
          ? (j.cmds as unknown[]).filter((x): x is { cmdId: string; runId: string; at: number } => isObj(x) && typeof x.cmdId === 'string' && ULID.test(x.cmdId) && typeof x.runId === 'string' && ULID.test(x.runId) && Number.isSafeInteger(x.at))
          : [];
      },
      () => [],
    ).catch(() => []);
    return this.#rows;
  }
  async get(cmdId: string): Promise<string | null> {
    return (await this.#load()).find((x) => x.cmdId === cmdId)?.runId ?? null;
  }
  async put(cmdId: string, runId: string, at: number): Promise<void> {
    const rows = await this.#load();
    rows.push({ cmdId, runId, at });
    if (rows.length > CMD_KEEP) rows.splice(0, rows.length - CMD_KEEP);
    const snapshot = JSON.stringify({ v: 1, cmds: rows });
    const run = async () => {
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.#file);
    };
    this.#write = this.#write.then(run, run);
    await this.#write;
  }
}

export interface CmdResumeBody {
  runId: string;
}

export interface PhoneIssuePorts {
  counterparty: (ref: string) => Counterparty | null;
  createDraft: (cp: Counterparty, supply: number, item: string) => RunView;
  prepare: (id: string) => Promise<unknown>;
  anyActive: () => boolean;
  retryCert?: (id: string) => Promise<unknown>;
  simpleAuth?: (id: string, op: 'request' | 'complete', d?: { provider: string; name: string; birth: string; phone: string; carrier?: string }) => Promise<unknown>;
  get: (id: string) => RunView | undefined;
  onDraft?: (run: RunView) => void;
  cmds: Pick<CmdLog, 'get' | 'put'>;
  approver?: (pairId: string) => boolean;
  approveCode?: (shellRunId: string) => string | undefined;
  now?: () => number;
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
  wake?: (pairId: string, kind: 'update') => unknown;
}

export function wakeWorthy(ev: RunEventBody): boolean {
  if (ev.event === 'end' || ev.event === 'turn') return true;
  return ev.phase === 'approve' && typeof ev.code === 'string' && ev.code.startsWith('pc_');
}

export interface PhoneSink {
  send(type: 'cmd.ack', body: CmdAckBody): unknown;
  send(type: 'run.event', body: RunEventBody): unknown;
}

interface Tracked {
  pairId: string;
  cmdId: string;
  runId: string;
  last: string;
  simpleReq?: string;
  rev: number;
  deniedByPhone?: boolean;
}

export class PhoneIssue {
  #o: PhoneIssuePorts;
  #sinks = new Map<string, PhoneSink>();
  #runs = new Map<string, Tracked>();
  #queue: Promise<void> = Promise.resolve();
  constructor(o: PhoneIssuePorts) {
    this.#o = o;
  }
  #now(): number {
    return (this.#o.now ?? Date.now)();
  }
  #log(result: string): void {
    this.#o.log?.('main.phone_issue', { result });
  }

  attach(pairId: string, sink: PhoneSink): void {
    this.#sinks.set(pairId, sink);
    for (const [id, t] of this.#runs) {
      if (t.pairId !== pairId) continue;
      const r = this.#o.get(id);
      if (r) this.#emit(r, t, true);
    }
  }
  detach(pairId: string, sink: PhoneSink): void {
    if (this.#sinks.get(pairId) === sink) this.#sinks.delete(pairId);
  }

  update(r: RunView): void {
    const t = this.#runs.get(r.id);
    if (t && !(r.replaced && phaseOf(r) === 'stopped')) this.#emit(r, t, false);
  }

  relink(from: string, to: string): void {
    const t = this.#runs.get(from);
    if (!t) return;
    this.#runs.delete(from);
    this.#runs.set(to, t);
    const r = this.#o.get(to);
    if (r) this.#emit(r, t, false);
  }

  trackedOf(shellRunId: string): { pairId: string; runId: string } | null {
    const t = this.#runs.get(shellRunId);
    return t ? { pairId: t.pairId, runId: t.runId } : null;
  }

  deniedByPhone(shellRunId: string): void {
    const t = this.#runs.get(shellRunId);
    if (t) t.deniedByPhone = true;
  }

  poke(shellRunId: string): void {
    const t = this.#runs.get(shellRunId);
    const r = t && this.#o.get(shellRunId);
    if (t && r) this.#emit(r, t, false);
  }

  #emit(r: RunView, t: Tracked, force: boolean): void {
    const ev = eventOf(r, t.runId, t.cmdId, this.#now(), this.#o.approveCode?.(r.id));
    const key = `${ev.event}:${ev.phase}:${ev.attempt ?? ''}:${ev.result ? 'r' : ''}:${ev.phase === 'approve' || ev.event === 'turn' ? (ev.code ?? '') : ''}`;
    if (!force && key === t.last) return;
    t.last = key;
    const sink = this.#sinks.get(t.pairId);
    if (!sink) {
      if (!force && wakeWorthy(ev) && !(t.deniedByPhone && ev.event === 'end')) this.#o.wake?.(t.pairId, 'update');
      return;
    }
    ev.rev = ++t.rev;
    try {
      sink.send('run.event', ev);
      if (ev.event === 'turn' && ev.code === 'login.simple_auth' && this.#o.simpleAuth) {
        t.simpleReq ??= ulid(this.#now());
        (sink.send as unknown as (ty: string, b: object) => unknown)('human.request', { runId: t.runId, stepId: 's7e', reqId: t.simpleReq, kind: 'manual', prompt: 'simple_auth', ttl: 600 });
      }
    } catch {
      this.#log('event_send_failed');
      return;
    }
    if (ev.event === 'end') this.#runs.delete(r.id);
  }

  async resume(pairId: string, sink: PhoneSink, body: CmdResumeBody): Promise<boolean> {
    const at = [...this.#runs].find(([, t]) => t.pairId === pairId && t.runId === body?.runId);
    if (!at) return (this.#log('resume_unknown'), false);
    const [id, t] = at;
    const r = this.#o.get(id);
    const ok = !!r && !!this.#o.retryCert && r.status === 'turn' && CERT_TURN.has(r.handoff?.code ?? '') && !r.handoff!.afterGate;
    if (ok) {
      try {
        await this.#o.retryCert!(id);
        this.#log('resume_cert');
        return true;
      } catch {
        // 다시 시도하지 못했다: 지금 상태를 다시 보낸다
      }
    }
    this.#log('resume_refused');
    this.#sinks.set(pairId, sink);
    if (r) this.#emit(r, t, true);
    return false;
  }

  async human(pairId: string, sink: PhoneSink, body: { runId?: unknown; reqId?: unknown; value?: unknown }): Promise<boolean> {
    const at = [...this.#runs].find(([, x]) => x.pairId === pairId && x.runId === body?.runId && !!x.simpleReq && x.simpleReq === body?.reqId);
    if (!at || !this.#o.simpleAuth) return (this.#log('human_unknown'), false);
    const [id, t] = at;
    const a = parseSimpleAnswer(body.value);
    const r = this.#o.get(id);
    if (a && r && r.status === 'turn' && CERT_TURN.has(r.handoff?.code ?? '')) {
      try {
        await this.#o.simpleAuth(id, a.op, a.op === 'request' ? a.d : undefined);
        this.#log(a.op === 'request' ? 'simple_requested' : 'simple_completed');
        return true;
      } catch {
        // 아래에서 실패를 알린다
      }
    }
    this.#log('simple_failed');
    this.#sinks.set(pairId, sink);
    try {
      sink.send('run.event', { runId: t.runId, cmdId: t.cmdId, at: this.#now(), event: 'turn', phase: 'login', status: 'turn', code: 'login.simple_failed' });
    } catch {
      // 다음 세션에서 지금 상태를 다시 보낸다
    }
    const now = this.#o.get(id);
    if (now) this.#emit(now, t, true);
    return false;
  }

  async handle(pairId: string, sink: PhoneSink, body: CmdRunBody): Promise<CmdAckBody> {
    const turn = this.#queue.then(() => this.#decide(pairId, body));
    this.#queue = turn.then(
      () => undefined,
      () => undefined,
    );
    const ack = await turn;
    try {
      sink.send('cmd.ack', ack);
    } catch {
      this.#log('ack_send_failed');
    }
    this.#log(ack.state === 'rejected' ? ack.reason! : ack.state);
    return ack;
  }

  async #decide(pairId: string, body: CmdRunBody): Promise<CmdAckBody> {
    const reject = (reason: CmdRejectReason, runId?: string): CmdAckBody => ({ cmdId: body.cmdId, state: 'rejected', reason, ...(runId ? { runId } : {}) });
    if (body.playbookId !== ISSUE_PLAYBOOK) return reject('playbook_unavailable');
    const seen = await this.#o.cmds.get(body.cmdId);
    if (seen) return reject('duplicate', seen);
    const req = parseIssueInputs(body.inputs);
    if (!req || req.day !== kstToday(this.#now()) || req.tax !== Math.floor(req.supply / 10)) return reject('input_invalid');
    const cp = this.#o.counterparty(req.counterpartyRef);
    if (!cp) return reject('counterparty_unknown');
    if (this.#o.anyActive()) return reject('pc_busy');
    const runId = ulid(this.#now());
    await this.#o.cmds.put(body.cmdId, runId, this.#now());
    const draft = this.#o.createDraft(cp, req.supply, req.item.trim());
    const t: Tracked = { pairId, cmdId: body.cmdId, runId, last: '', rev: 0 };
    this.#runs.set(draft.id, t);
    this.#o.onDraft?.(draft);
    setImmediate(() => {
      this.#o.prepare(draft.id).catch(() => {
        this.#log('prepare_blocked');
        const r = this.#o.get(draft.id);
        if (r) this.#emit(r, t, true);
      });
    });
    return { cmdId: body.cmdId, state: this.#o.approver?.(pairId) ? 'accepted' : 'pc_only', runId };
  }
}
