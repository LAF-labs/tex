import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cbor } from '../gate.ts';
import { W_STATIC_BOUND_MS } from './constants.ts';
import type { Analysis } from './validate.ts';

export interface GateToken {
  runId: string;
  gateStepId: string;
  actionHash: string;
  exp: number;
  nonce: string;
  mac: string;
}

export type TokenRejection = 'other_run' | 'forged' | 'consumed' | 'discarded' | 'expired' | 'wrong_step' | 'action_mismatch';
/** D03 §3: 보안 이벤트는 위조·다른 실행의 토큰·이미 소비된 토큰에만. */
export const SECURITY_REJECTIONS: ReadonlySet<TokenRejection> = new Set(['other_run', 'forged', 'consumed']);

/** R-G2: 이 중 하나라도 일어나면 미소비 토큰 전부 폐기. */
export const TOKEN_DISCARD_TRIGGERS = ['Recovering', 'WaitingHuman', 'HandedOff', 'Paused', 'Interrupted', 'checkpoint_return', 'gate_edit', 'l2_apply', 'hotfix_apply'] as const;
export type TokenDiscardTrigger = (typeof TOKEN_DISCARD_TRIGGERS)[number];

/**
 * Wmax(X) = W(X)의 정적 상한(D03 §3): 60초 + signFlow.maxWaitMs, W 안에 wait·assert·extract가 있으면 그 timeoutMs 합을 더한다.
 * timeoutMs가 없는 wait·assert·extract는 스키마 기본값(defaultTimeoutMs)으로 센다.
 */
export function wmaxMs(analysis: Pick<Analysis, 'cfg' | 'windows' | 'gateOf'>, x: string, defaultTimeoutMs: number): number {
  const w = analysis.windows.get(x);
  const xs = analysis.cfg.info.get(x)?.step;
  if (!w || !xs) throw new Error('wmax_unknown_step');
  let ms = W_STATIC_BOUND_MS + (xs.type === 'submit' ? (xs.signFlow?.maxWaitMs ?? 0) : 0);
  for (const n of w) {
    const s = analysis.cfg.info.get(n)?.step;
    if (s && (s.type === 'wait' || s.type === 'assert' || s.type === 'extract')) ms += s.timeoutMs ?? defaultTimeoutMs;
  }
  return ms;
}

interface Rec {
  stepId: string;
  state: 'live' | 'consumed' | 'discarded';
  token: GateToken;
}

export class GateTokens {
  readonly runId: string;
  readonly #runKey = randomBytes(32);
  readonly #recs = new Map<string, Rec>();

  constructor(runId: string) {
    this.runId = runId;
  }

  #mac(t: Omit<GateToken, 'mac'>): Buffer {
    return createHmac('sha256', this.#runKey).update(cbor({ runId: t.runId, gateStepId: t.gateStepId, actionHash: t.actionHash, exp: t.exp, nonce: t.nonce })).digest();
  }

  issue(p: { gateStepId: string; actionHash: string; stepId: string; approvedAt: number; commitWindowMs: number; wmaxMs: number }): GateToken {
    const body = { runId: this.runId, gateStepId: p.gateStepId, actionHash: p.actionHash, exp: p.approvedAt + Math.min(p.commitWindowMs, p.wmaxMs), nonce: randomBytes(16).toString('hex') };
    const token = { ...body, mac: this.#mac(body).toString('hex') };
    this.#recs.set(token.nonce, { stepId: p.stepId, state: 'live', token });
    return token;
  }

  check(t: GateToken, want: { gateStepId: string; actionHash: string; stepId: string }, now: number): TokenRejection | null {
    if (t.runId !== this.runId) return 'other_run';
    let mac: Buffer;
    try {
      mac = Buffer.from(t.mac, 'hex');
    } catch {
      return 'forged';
    }
    const exp = this.#mac(t);
    if (mac.length !== exp.length || !timingSafeEqual(mac, exp)) return 'forged';
    const r = this.#recs.get(t.nonce);
    if (!r) return 'forged';
    if (r.state === 'consumed') return 'consumed';
    if (r.state === 'discarded') return 'discarded';
    if (t.gateStepId !== want.gateStepId || t.actionHash !== want.actionHash) return 'action_mismatch';
    if (r.stepId !== want.stepId) return 'wrong_step';
    if (now >= t.exp) return 'expired';
    return null;
  }

  consume(t: GateToken, want: { gateStepId: string; actionHash: string; stepId: string }, now: number): TokenRejection | null {
    const bad = this.check(t, want, now);
    if (bad) return bad;
    this.#recs.get(t.nonce)!.state = 'consumed';
    return null;
  }

  discardAll(_trigger: TokenDiscardTrigger): number {
    let n = 0;
    for (const r of this.#recs.values())
      if (r.state === 'live') {
        r.state = 'discarded';
        n++;
      }
    return n;
  }

  issueFollowUp(primary: GateToken, followUpStepId: string, now: number, ttlMs: number): GateToken | null {
    const r = this.#recs.get(primary.nonce);
    if (!r || r.state !== 'consumed' || primary.runId !== this.runId) return null;
    return this.issue({ gateStepId: primary.gateStepId, actionHash: primary.actionHash, stepId: followUpStepId, approvedAt: now, commitWindowMs: ttlMs, wmaxMs: ttlMs });
  }

  hasLive(): boolean {
    return [...this.#recs.values()].some((r) => r.state === 'live');
  }
}
