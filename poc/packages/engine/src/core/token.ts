// D03 §3 게이트 토큰(R-G2·R-G7·R-G8, B-12·B-10): token = HMAC(runKey, CBOR{runId, gateStepId, actionHash, exp, nonce}),
// exp = 승인시각 + min(policy.run.commitWindowMs, Wmax(X)). runKey는 실행마다 32바이트 무작위, 메모리에만(직렬화하지 않음).
// 단일 사용, 주 비가역 1개에만. 후속 비가역 토큰은 같은 실행에서 주 비가역이 committed가 되는 순간 따로 1회 발급한다.
// 보안 이벤트는 위조·다른 실행·이미 소비된 토큰에만(만료·폐기는 아님).
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { cbor } from '../gate.ts';
import { W_STATIC_BOUND_MS } from './constants.ts';
import type { Analysis } from './validate.ts';

export interface GateToken {
  runId: string;
  gateStepId: string;
  actionHash: string;
  exp: number;
  nonce: string; // hex 16바이트
  mac: string; // hex
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

  /** 승인 직후(gate_requests open → approved 전이가 성공한 뒤에만) 부른다. stepId = 이 토큰이 여는 주 비가역. */
  issue(p: { gateStepId: string; actionHash: string; stepId: string; approvedAt: number; commitWindowMs: number; wmaxMs: number }): GateToken {
    const body = { runId: this.runId, gateStepId: p.gateStepId, actionHash: p.actionHash, exp: p.approvedAt + Math.min(p.commitWindowMs, p.wmaxMs), nonce: randomBytes(16).toString('hex') };
    const token = { ...body, mac: this.#mac(body).toString('hex') };
    this.#recs.set(token.nonce, { stepId: p.stepId, state: 'live', token });
    return token;
  }

  /** 검사만(소비하지 않음). null이면 통과. */
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

  /** 원장 armed 기록 트랜잭션이 커밋된 뒤 부른다(R-G7). 검사를 다시 하고 소비한다. */
  consume(t: GateToken, want: { gateStepId: string; actionHash: string; stepId: string }, now: number): TokenRejection | null {
    const bad = this.check(t, want, now);
    if (bad) return bad;
    this.#recs.get(t.nonce)!.state = 'consumed';
    return null;
  }

  /** R-G2: 미소비 토큰 전부 폐기. 폐기한 수. */
  discardAll(_trigger: TokenDiscardTrigger): number {
    let n = 0;
    for (const r of this.#recs.values())
      if (r.state === 'live') {
        r.state = 'discarded';
        n++;
      }
    return n;
  }

  /**
   * 후속 비가역(followUpOf) 토큰: 같은 실행에서 주 비가역 토큰이 소비됐고 그 비가역이 지금 committed로 전이할 때만(B-10).
   * 주 토큰과 같은 gateStepId·actionHash에 결속한다(카드의 authorizes에 후속 스텝이 있어야 한다는 것은 V-03i가 정적으로 본다).
   */
  issueFollowUp(primary: GateToken, followUpStepId: string, now: number, ttlMs: number): GateToken | null {
    const r = this.#recs.get(primary.nonce);
    if (!r || r.state !== 'consumed' || primary.runId !== this.runId) return null;
    return this.issue({ gateStepId: primary.gateStepId, actionHash: primary.actionHash, stepId: followUpStepId, approvedAt: now, commitWindowMs: ttlMs, wmaxMs: ttlMs });
  }

  /** 미소비 토큰이 있는가(Paused 직렬화 전 확인용). */
  hasLive(): boolean {
    return [...this.#recs.values()].some((r) => r.state === 'live');
  }
}
