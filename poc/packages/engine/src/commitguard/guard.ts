// 네트워크 커밋 가드(D03 §5.4, D02 §2.1, B-03·B-04, 금고 R-C1 #81).
// 엔진 토큰 로직과 다른 모듈이다. 토큰 검증 결과는 armedUntil·intentId·stepId·readbackHash(=R-C1 expectedHash)로만 받는다.
// - Running: 커밋 요청은 무장(같은 효과, 기한 안, 엔드포인트별 maxRequests회)일 때만 통과. 그 밖은 차단 +
//   commit_guard.blocked_request(보안 이벤트) + 실행 중단(요청이 나가지 않았으므로 InDoubt 아님).
// - R-C1: bodyFieldMap이 있는 엔드포인트는 클릭 직전 금고 commitGuard.arm(타깃당 1, TTL 120s). 금고 결과
//   commit.body_compared가 false면 security.commit_payload_mismatch, 원장 not_committed(payload_mismatch), 핸드오프.
//   그 요청이 엔진에 오면(일치·opaque) 결과를 확인한 뒤에만 이어 보낸다. 결과가 없으면 막는다(fail-closed).
// - R-C2: HandedOff·WaitingHuman(manual)에는 막지 않고 관측. 원장 observed_manual → in_doubt, ledger.observed_manual.
// - R-C3: 어느 목록에도 없는 포털 요청은 commit_guard.unclassified{pathPattern}(실행당 모양마다 한 번).
// - 합집합이 비면 auto·assisted에서 만들지 않는다(SV-06을 실행 시 다시 확인).
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
  /** 금고가 노출한 실행 탭 타깃 ID. */
  targetId: string;
  mode: PortalMode;
  /** 합집합(endpointUnion). */
  endpoints: readonly CommitEndpoint[];
  known: readonly EndpointMatch[];
  /** manifest.domains. */
  domains: readonly string[];
  vault: VaultCommitPort;
  ledger: Pick<Ledger, 'resolve' | 'observedManual'>;
  /** R-C2: 지금 의도의 커밋 스텝 행(게이트가 아는 것). 없으면 null. */
  manualRow: () => ArmRow | null;
  now: () => number;
  journal: (type: string, payload?: Record<string, string | number | boolean>) => void;
  /** 보안 이벤트(D16 목록의 코드만). */
  security: (code: string, payload?: Record<string, string | number | boolean>) => void;
  /** 실행을 멈춘다(FORCED_STOPS 코드). */
  stop: (code: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

export interface ArmInput {
  intentId: string;
  stepId: string;
  effect: Effect;
  armedUntil: number;
  /** R-C1 expectedHash(plan이 준 bodyFieldMap으로 commitExpectedHash). R-C1 대상이 없으면 생략. */
  readbackHash?: string;
  /** 지금 페이지 URL(무장할 endpoint의 호스트). */
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

  /** SV-06 실행 시 확인. 합집합이 비고 auto·assisted면 만들지 않는다. */
  static create(i: CommitGuardInput): { ok: true; guard: CommitGuard } | { ok: false; violations: Violation[] } {
    const v = sv06(i.endpoints, i.mode);
    if (v.length) return { ok: false, violations: v };
    return { ok: true, guard: new CommitGuard(i) };
  }

  /** HandedOff·WaitingHuman(manual)이면 observing. 사람 구간에서 Running으로 돌아오면 정지 걸쇠를 푼다(재개는 새 무장부터). */
  setMode(m: GuardMode): void {
    if (this.mode === 'observing' && m === 'running') this.stopped = false;
    this.mode = m;
  }

  get currentMode(): GuardMode {
    return this.mode;
  }

  /** 이 실행에서 R-C2 관측이 있었는가(재개 전 verify). */
  get observedManual(): boolean {
    return this.observed;
  }

  get isArmed(): boolean {
    return !!this.armed && this.i.now() < this.armed.until;
  }

  /** 무장 전: 이 효과의 R-C1 대상 bodyFieldMap(없으면 null). 대상이 둘 이상이면 고를 수 없어 거부. */
  plan(effect: Effect): ArmPlan {
    if (!this.i.endpoints.some((e) => e.effect === effect)) return { ok: false, code: 'commit_guard.arm_refused' };
    const c = rc1Candidates(this.i.endpoints, effect);
    if (c.length > 1) return { ok: false, code: 'commit_guard.arm_refused' };
    return { ok: true, bodyFieldMap: c.length ? { ...this.i.endpoints[c[0]!]!.bodyFieldMap! } : null };
  }

  /** R-G7의 '커밋 가드 무장'(토큰 소비·readback 재계산 뒤, 클릭 직전). */
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
        host = u.protocol === 'https:' ? u.host : '';
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

  /** 커밋 구간 끝·실행 끝·Chrome 재기동. 금고 무장도 푼다(이미 소비됐으면 금고에는 없음). */
  async disarm(): Promise<void> {
    const a = this.armed;
    this.armed = null;
    if (!a) return;
    for (const w of a.rc1?.waiters ?? []) w('expired');
    if (a.rc1 && !a.rc1.seen) await this.i.vault.disarm({ intentId: a.intentId, stepId: a.stepId }).catch(() => {});
  }

  /** 금고 이벤트 commit.body_compared. */
  onBodyCompared(ev: CommitBodyComparedEvent): void {
    const a = this.armed;
    if (!a?.rc1 || a.intentId !== ev.intentId || a.stepId !== ev.stepId || a.rc1.result !== null) return;
    a.rc1.result = ev.match;
    for (const w of a.rc1.waiters.splice(0)) w(ev.match);
    if (ev.match === false) {
      // 금고가 요청을 Fetch.failRequest로 막았다. 요청이 나가지 않았으므로 not_committed.
      this.i.security('security.commit_payload_mismatch', { effect: a.effect });
      try {
        this.i.ledger.resolve(a.intentId, a.stepId, 'not_committed', 'payload_mismatch');
      } catch (e) {
        this.i.journal('commit_guard.ledger_failed', { code: (e as { code?: string }).code ?? 'error' });
      }
      this.halt('security.commit_payload_mismatch');
    } else if (ev.match === 'expired' && !a.rc1.seen) this.i.journal('commit_guard.arm_expired', { effect: a.effect });
  }

  /** 포털 요청 하나(Fetch 요청 단계). */
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

  /**
   * 고정된 호스트 밖이라 Fetch로 잡지 못한 요청(Network 관측). 커밋 요청이면 막을 수 없었으므로
   * 관측 모드는 R-C2, Running은 실행 중단 + 원장 in_doubt(요청이 나갔을 수 있다).
   */
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
      this.i.ledger.observedManual(row);
      this.i.ledger.resolve(row.intentId, row.stepId, 'in_doubt');
      this.i.journal('ledger.observed_manual', { effect, bound: true, intentId: row.intentId, stepId: row.stepId, state: 'in_doubt' });
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

  /** 멈추면 무장도 푼다(같은 토큰으로 다시 나가지 않게). */
  private halt(code: string): void {
    if (this.stopped) return;
    this.stopped = true;
    void this.disarm();
    this.i.stop(code);
  }
}
