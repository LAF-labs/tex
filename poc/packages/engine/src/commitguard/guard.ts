import type { ArmRow, Ledger } from '@sax/db';
import type { ActResult } from '../core/page.ts';
import { sv06 } from '../core/selector-ci.ts';
import type { CommitEndpoint, Effect, EndpointMatch, PortalMode, Violation } from '../core/types.ts';
import { EndpointClassifier, pathGlob, rc1Candidates, type GuardRequest } from './endpoints.ts';
import type { CommitBodyComparedEvent, CommitMatch, VaultCommitPort } from './rc1.ts';

export type GuardMode = 'running' | 'observing';
export type GuardDecision = 'continue' | 'fail';

/** 금고 대조 결과를 기다리는 최대 시간(그 요청이 엔진에 온 뒤). */
export const RC1_RESULT_WAIT_MS = 5_000;

export interface CommitGuardInput {
  runId: string;
  targetId: string;
  mode: PortalMode;
  endpoints: readonly CommitEndpoint[];
  known: readonly EndpointMatch[];
  domains: readonly string[];
  vault: VaultCommitPort;
  ledger: Pick<Ledger, 'resolve' | 'attestManual' | 'get'>;
  manualRow: () => ArmRow | null;
  now: () => number;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  security: (code: string, payload?: Record<string, string | number | boolean>) => void;
  stop: (code: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ArmInput {
  intentId: string;
  stepId: string;
  effect: Effect;
  armedUntil: number;
  readbackHash?: string;
  pageUrl: string;
}

export type ArmPlan = { ok: true; bodyFieldMap: Record<string, string> | null } | { ok: false; code: string };

interface Armed {
  intentId: string;
  stepId: string;
  effect: Effect;
  until: number;
  used: Map<number, number>;
  rc1: { index: number; seen: boolean; result: CommitMatch | null; waiters: Array<(m: CommitMatch) => void> } | null;
}

export class CommitGuard {
  private readonly i: CommitGuardInput;
  private readonly cls: EndpointClassifier;
  private mode: GuardMode = 'running';
  private armed: Armed | null = null;
  private readonly shapes = new Set<string>();
  private stopped = false;
  private observed = false;

  private constructor(i: CommitGuardInput) {
    this.i = i;
    this.cls = new EndpointClassifier(i.endpoints, i.known, i.domains);
  }

  static create(i: CommitGuardInput): { ok: true; guard: CommitGuard } | { ok: false; violations: Violation[] } {
    const v = sv06(i.endpoints, i.mode);
    if (v.length) return { ok: false, violations: v };
    return { ok: true, guard: new CommitGuard(i) };
  }

  setMode(m: GuardMode): void {
    if (this.mode === 'observing' && m === 'running') this.stopped = false;
    this.mode = m;
  }

  get currentMode(): GuardMode {
    return this.mode;
  }

  get observedManual(): boolean {
    return this.observed;
  }

  get isArmed(): boolean {
    return !!this.armed && this.i.now() < this.armed.until;
  }

  plan(effect: Effect): ArmPlan {
    if (!this.i.endpoints.some((e) => e.effect === effect)) return { ok: false, code: 'commit_guard.arm_refused' };
    const c = rc1Candidates(this.i.endpoints, effect);
    if (c.length > 1) return { ok: false, code: 'commit_guard.arm_refused' };
    return { ok: true, bodyFieldMap: c.length ? { ...this.i.endpoints[c[0]!]!.bodyFieldMap! } : null };
  }

  async arm(a: ArmInput): Promise<ActResult> {
    const refuse = (reason: string): ActResult => {
      this.i.journal('commit_guard.arm_refused', { reason });
      return { ok: false, code: 'commit_guard.arm_refused' };
    };
    if (this.stopped) return refuse('stopped');
    if (this.armed) return refuse('already_armed');
    if (a.armedUntil <= this.i.now()) return refuse('expired');
    const plan = this.plan(a.effect);
    if (!plan.ok) return refuse('no_endpoint');
    let rc1: Armed['rc1'] = null;
    if (plan.bodyFieldMap) {
      const index = rc1Candidates(this.i.endpoints, a.effect)[0]!;
      const ep = this.i.endpoints[index]!;
      const glob = pathGlob(ep.match);
      let host: string;
      try {
        const u = new URL(a.pageUrl);
        host = u.protocol === 'https:' ? (ep.match.host ?? u.host) : '';
      } catch {
        host = '';
      }
      if (!glob || !host) return refuse('endpoint_unmappable');
      if (!a.readbackHash || !/^[0-9a-f]{64}$/.test(a.readbackHash)) return refuse('bad_hash');
      const r = await this.i.vault.arm({
        runId: this.i.runId, intentId: a.intentId, stepId: a.stepId, targetId: this.i.targetId,
        endpoint: `https://${host}${glob}`, method: ep.match.method, bodyFieldMap: { ...ep.bodyFieldMap! }, expectedHash: a.readbackHash,
      });
      if (!r.armed) return refuse(`vault_${r.reason ?? 'refused'}`);
      rc1 = { index, seen: false, result: null, waiters: [] };
    }
    this.armed = { intentId: a.intentId, stepId: a.stepId, effect: a.effect, until: a.armedUntil, used: new Map(), rc1 };
    this.i.journal('commit_guard.armed', { effect: a.effect, rc1: !!rc1 });
    return { ok: true };
  }

  async disarm(): Promise<void> {
    const a = this.armed;
    this.armed = null;
    if (!a) return;
    for (const w of a.rc1?.waiters ?? []) w('expired');
    if (a.rc1 && !a.rc1.seen) await this.i.vault.disarm({ intentId: a.intentId, stepId: a.stepId }).catch(() => {});
  }

  onBodyCompared(ev: CommitBodyComparedEvent): void {
    const a = this.armed;
    if (!a?.rc1 || a.intentId !== ev.intentId || a.stepId !== ev.stepId || a.rc1.result !== null) return;
    a.rc1.result = ev.match;
    for (const w of a.rc1.waiters.splice(0)) w(ev.match);
    if (ev.match === false) {
      this.i.security('security.commit_payload_mismatch', { effect: a.effect });
      try {
        this.i.ledger.resolve(a.intentId, a.stepId, 'not_committed', 'payload_mismatch');
      } catch (e) {
        this.i.journal('commit_guard.ledger_failed', { code: (e as { code?: string }).code ?? 'error' });
      }
      this.halt('security.commit_payload_mismatch');
    } else if (ev.match === 'expired' && !a.rc1.seen) this.i.journal('commit_guard.arm_expired', { effect: a.effect });
  }

  async onRequest(r: GuardRequest): Promise<GuardDecision> {
    const c = this.cls.classify(r);
    if (c.kind === 'outside' || c.kind === 'known') return 'continue';
    if (c.kind === 'unclassified') {
      if (!this.shapes.has(c.pathPattern)) {
        this.shapes.add(c.pathPattern);
        this.i.journal('commit_guard.unclassified', { pathPattern: c.pathPattern });
      }
      return 'continue';
    }
    const ep = c.endpoint;
    if (this.mode === 'observing') {
      this.observeManual(ep.effect);
      return 'continue';
    }
    const a = this.armed;
    const pathPattern = ep.match.pathPattern.slice(0, 120);
    const used = a?.used.get(c.index) ?? 0;
    if (this.stopped || !a || this.i.now() >= a.until || a.effect !== ep.effect || used >= ep.maxRequests) {
      this.i.security('commit_guard.blocked_request', { effect: ep.effect, pathPattern, armed: !!a });
      this.halt('commit_guard.blocked_request');
      return 'fail';
    }
    a.used.set(c.index, used + 1);
    if (a.rc1 && a.rc1.index === c.index && !a.rc1.seen) {
      a.rc1.seen = true;
      const m = await this.result(a);
      if (m !== true && m !== 'opaque') {
        if (m !== false) this.i.journal('commit_guard.rc1_missing', { effect: ep.effect, result: String(m) });
        if (m !== false) this.halt('commit_guard.blocked_request');
        return 'fail';
      }
      this.i.journal('commit_guard.passed', { effect: ep.effect, match: String(m) });
      return 'continue';
    }
    this.i.journal('commit_guard.passed', { effect: ep.effect, match: 'none' });
    return 'continue';
  }

  onUnintercepted(r: GuardRequest): void {
    const c = this.cls.classify(r);
    if (c.kind !== 'commit') return;
    if (this.mode === 'observing') return this.observeManual(c.endpoint.effect);
    this.i.journal('commit_guard.unintercepted', { effect: c.endpoint.effect, pathPattern: c.endpoint.match.pathPattern.slice(0, 120) });
    const a = this.armed;
    if (a) {
      try {
        this.i.ledger.resolve(a.intentId, a.stepId, 'in_doubt');
      } catch (e) {
        this.i.journal('commit_guard.ledger_failed', { code: (e as { code?: string }).code ?? 'error' });
      }
    }
    this.halt('commit_guard.unintercepted');
  }

  private observeManual(effect: Effect): void {
    this.observed = true;
    const row = this.i.manualRow();
    if (!row) {
      this.i.journal('ledger.observed_manual', { effect, bound: false });
      return;
    }
    try {
      const step = this.i.ledger.attestManual(row);
      if (this.i.ledger.get(row.intentId, step)?.state !== 'committed') this.i.ledger.resolve(row.intentId, step, 'in_doubt');
      this.i.journal('ledger.observed_manual', { effect, bound: true, intentId: row.intentId, stepId: step, state: 'in_doubt' });
    } catch (e) {
      this.i.journal('ledger.observed_manual', { effect, bound: true, intentId: row.intentId, stepId: row.stepId, code: (e as { code?: string }).code ?? 'error' });
    }
  }

  private result(a: Armed): Promise<CommitMatch> {
    const rc1 = a.rc1!;
    if (rc1.result !== null) return Promise.resolve(rc1.result);
    const sleep = this.i.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
    return Promise.race([new Promise<CommitMatch>((res) => rc1.waiters.push(res)), sleep(RC1_RESULT_WAIT_MS).then(() => 'expired' as const)]);
  }

  private halt(code: string): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.disarm();
    this.i.stop(code);
  }
}
