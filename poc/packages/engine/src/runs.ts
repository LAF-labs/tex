import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { GateRepo, Ledger, LedgerError, RunJournal, RunRepo, type Db, type Profile } from '@sax/db';
import type { EventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import type { DataService } from './data-service.ts';
import { actionHash, cardHash, cbor, jcs, LOCAL_APPROVAL_TTL_MS, readbackHash, sha256hex, type GateField, type GatePortMessage, type GateRequest, type LocalApproval } from './gate.ts';
import { businessKey, canonicalEmail, H01, packageDigest, type Phase } from './h01/playbook.ts';
import { portalProblems, READBACK_FIELDS, type PortalConfig } from './h01/portal.ts';
import { H01Runner, RunEnd, type Readback, type RunInputs, type RunStatus } from './h01/runner.ts';

// 실행·게이트·원장 조율(D03 §2~§5). 게이트 요청은 main↔엔진 전용 포트로만 내보내고, 승인 근거(LocalApproval v2)도
// 그 포트로 온 것만 받는다(ADR-021). Phase 1처럼 엔진은 HMAC 키가 없어 MAC을 검증하지 않고 포트 출처만 믿는다.

export interface StartParams {
  runId: string;
  counterpartyId: string;
  supply: number;
  tax: number;
  itemName: string;
  /** 없으면 거래처 이메일. 빈 문자열이면 이메일 칸을 비운다(자동 발송 없음). */
  email?: string | null;
}

export type RunEvent =
  | { runId: string; type: 'phase'; phase: Phase; state: 'now' | 'done' | 'attention'; code?: string }
  | { runId: string; type: 'waiting'; reqId: string }
  | { runId: string; type: 'end'; status: RunStatus; code?: string; approvalNo?: string; mailConfirmed?: boolean };

interface PendingGate {
  req: GateRequest;
  rb: Readback;
  rbHash: string;
  deadline: number;
  timer: NodeJS.Timeout;
  resolve: () => void;
  reject: (e: RunEnd) => void;
  history: { cpBizNoHmac: string; recipientEmailHmac: string | null; businessKey: string };
}

interface ActiveRun {
  runId: string;
  intentId: string;
  inputsHash: string;
  packageDigest: string;
  stop: boolean;
  /** 토큰 소비 + armed 기록이 끝났다(커밋 구간). 이 뒤로는 중지를 받지 않는다. */
  armed: boolean;
  gate: PendingGate | null;
  /** 게이트 토큰(D03 §3). 비가역 스텝 진입에서 한 번 소비한다. */
  token: { reqId: string; mac: Buffer; exp: number; used: boolean } | null;
  /** 승인된 게이트의 원장 행 재료(arm에서 쓴다). */
  pendingArm: { req: GateRequest; history: PendingGate['history'] } | null;
}

export interface RunServiceDeps {
  db: Db;
  data: DataService;
  /** HKDF(DB 키)로 파생한 원장 HMAC 키(ADR-021). */
  ledgerKey: Uint8Array;
  portal: PortalConfig;
  page: () => Promise<Page>;
  log: EventLog;
  /** 게이트 포트로 내보낸다. 이 함수 말고는 게이트 요청이 나가는 길이 없다. */
  postGate: (m: GatePortMessage) => void;
  /** 시험용: gate.waitMs 대신 쓸 값. */
  gateWaitMs?: number;
}

/** policy.run.commitWindowMs 기본값(D03 §3). */
const COMMIT_WINDOW_MS = 600_000;
/** Wmax(X) = 60초 + signFlow.maxWaitMs(PoC: signFlow 없음). */
const W_MAX_MS = 60_000;
const GATE_STEP = 's20';
/** 승인 뒤 이 시간 동안은 거부([중지])가 이긴다(D03 §2 전이표 "거부 우선 창 2초"). */
export const DENY_PRIORITY_MS = 2_000;
const PRESENCE_OK = new Set(['click']); // Hello는 PoC 범위 밖(ADR-021)

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(16);
  let rand = '';
  for (let i = 0; i < 16; i++) rand += CROCKFORD[r[i]! % 32];
  return time + rand;
}

export class RunService extends EventEmitter {
  private readonly d: RunServiceDeps;
  private readonly runs: RunRepo;
  private readonly gates: GateRepo;
  private readonly ledger: Ledger;
  private readonly journal: RunJournal;
  private readonly deviceId: string;
  private active: ActiveRun | null = null;

  constructor(d: RunServiceDeps) {
    super();
    this.d = d;
    this.runs = new RunRepo(d.db);
    this.gates = new GateRepo(d.db);
    this.ledger = new Ledger(d.db);
    this.journal = new RunJournal(d.db);
    // 재시작: 종결되지 않은 원장 행은 in_doubt, 열린 게이트는 만료(토큰은 메모리에만 있었다, D03 §4.1).
    const promoted = this.ledger.promoteInDoubt();
    const expired = this.gates.expireOpen();
    const interrupted = this.runs.interruptRunning();
    if (promoted || expired || interrupted) d.log.event('engine.recovered', { inDoubt: promoted, gatesExpired: expired, interrupted });
    this.deviceId = this.loadDeviceId();
  }

  private loadDeviceId(): string {
    const r = this.d.db.prepare(`SELECT value_json FROM settings WHERE key = 'device.id'`).get() as { value_json: string } | undefined;
    if (r) return JSON.parse(r.value_json) as string;
    const id = randomUUID();
    this.d.db.prepare(`INSERT INTO settings (key, value_json) VALUES ('device.id', ?)`).run(JSON.stringify(id));
    return id;
  }

  private hmac(kind: 'bizno' | 'email', v: string): string {
    return createHmac('sha256', this.d.ledgerKey).update(`SAX-ledger-${kind}\0${v}`).digest('hex');
  }

  private ev(e: RunEvent): void {
    this.emit('event', e);
  }

  /** [홈택스에서 준비]. 실행은 한 번에 하나다. 검증에 실패하면 브라우저를 열기 전에 던진다. */
  start(p: StartParams): { runId: string; intentId: string } {
    if (this.active) throw new RunEnd('failed', 'busy');
    const problems = portalProblems(this.d.portal);
    if (problems.length) {
      this.d.log.event('run.portal_not_ready', { kind: this.d.portal.kind, problems: problems.length });
      throw new RunEnd('failed', 'selector_placeholder');
    }
    if (typeof p.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.runId)) throw new RunEnd('failed', 'bad_run_id');
    const profile = this.d.data.profiles.byKind('business');
    if (!profile?.bizNo) throw new RunEnd('failed', 'profile_missing');
    const cp = this.d.data.counterparties.get(String(p.counterpartyId));
    if (!cp) throw new RunEnd('failed', 'counterparty_missing');
    const amt = (n: unknown) => (Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 1e15 ? (n as number) : null);
    const supply = amt(p.supply);
    const tax = amt(p.tax);
    if (supply === null || tax === null || supply === 0) throw new RunEnd('failed', 'bad_amount');
    const itemName = String(p.itemName ?? '').trim().slice(0, 100);
    if (!itemName) throw new RunEnd('failed', 'item_missing');
    const email = p.email === undefined ? cp.email : p.email ? String(p.email).trim() : null;
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const inputs: RunInputs = {
      counterpart: { id: cp.id, bizNo: cp.bizNo, name: cp.name },
      amounts: { supply: String(supply), tax: String(tax), total: String(supply + tax) },
      items: [{ name: itemName }],
      issueDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      email,
    };
    const intentId = ulid();
    const inputsHash = sha256hex(jcs(inputs));
    const digest = packageDigest(this.d.portal, profile.updatedAt);
    const check = this.ledger.checkIntent(intentId, 's21', H01.id, inputsHash);
    if (check.kind !== 'new') throw new RunEnd('failed', 'ledger.intent_not_new');
    this.runs.create({ id: p.runId, playbookId: H01.id, playbookVersion: H01.version, packageDigest: digest, profileId: profile.id, trigger: 'local', inputsHash });
    this.journal.append(p.runId, 'run.started', { intentId, portal: this.d.portal.kind });
    this.active = { runId: p.runId, intentId, inputsHash, packageDigest: digest, stop: false, armed: false, gate: null, token: null, pendingArm: null };
    void this.execute(this.active, inputs, profile);
    return { runId: p.runId, intentId };
  }

  private async execute(a: ActiveRun, inputs: RunInputs, profile: Profile): Promise<void> {
    let result: { status: RunStatus; code?: string; approvalNo?: string; mailConfirmed?: boolean };
    try {
      // 로그인: 가짜 페이지는 세션이 있다고 본다. 홈택스 로그인(s0~s6)은 PoC-3 뒤.
      this.ev({ runId: a.runId, type: 'phase', phase: 'login', state: 'now' });
      if (this.d.portal.login) throw new RunEnd('failed', 'login.not_implemented');
      this.ev({ runId: a.runId, type: 'phase', phase: 'login', state: 'done', code: 'login.session_assumed' });
      const page = await this.d.page();
      result = await new H01Runner(page, this.d.portal, inputs, { bizNo: profile.bizNo! }, this.hooks(a)).run();
    } catch (e) {
      result = e instanceof RunEnd ? { status: e.status, code: e.code } : { status: 'failed', code: 'engine.error' };
      if (!(e instanceof RunEnd)) this.d.log.event('run.error', { runId: a.runId, err: (e as Error).name });
    }
    // 커밋 구간에서 종결되지 않고 빠져나왔으면 in_doubt(중복 위험을 숨기지 않는다).
    const row = this.ledger.get(a.intentId, 's21');
    if (row && (row.state === 'armed' || row.state === 'dispatched')) {
      this.ledger.resolve(a.intentId, 's21', 'in_doubt');
      result = { status: 'in_doubt', code: result.code ?? 'engine.error' };
    } else if (row?.state === 'in_doubt') result = { ...result, status: 'in_doubt' };
    // 발급이 확정된 뒤의 오류는 실패가 아니다. 다시 실행하면 중복이므로 "완료(확인할 것 있음)"로 알린다.
    else if (row?.state === 'committed' && result.status !== 'success' && result.status !== 'completed_with_issues') {
      result = { status: 'completed_with_issues', code: 'post_commit.error', approvalNo: row.verifyRef ?? undefined };
    }
    this.closeGate(a, 'run_ended');
    this.runs.finish(a.runId, result.status);
    this.journal.append(a.runId, 'run.ended', { status: result.status, code: result.code ?? '' });
    if (result.status === 'success' || result.status === 'completed_with_issues') this.d.data.counterparties.markUsed(inputs.counterpart.id);
    this.active = null;
    this.ev({ runId: a.runId, type: 'end', ...result });
  }

  private hooks(a: ActiveRun) {
    return {
      phase: (phase: Phase, state: 'now' | 'done' | 'attention', code?: string) => this.ev({ runId: a.runId, type: 'phase', phase, state, code }),
      checkStop: () => {
        if (a.stop) throw new RunEnd('stopped', 'run.stopped');
      },
      gate: (rb: Readback) => this.openGate(a, rb),
      arm: () => this.arm(a),
      dispatched: () => {
        this.ledger.dispatched(a.intentId, 's21');
        this.journal.append(a.runId, 'ledger.dispatched');
      },
      resolve: (state: 'committed' | 'not_committed' | 'in_doubt', reason: 'pre_dispatch_mismatch' | 'identity_mismatch' | 'verify' | null, ref: string | null) => {
        this.ledger.resolve(a.intentId, 's21', state, reason, ref);
        this.journal.append(a.runId, `ledger.${state}`, { reason: reason ?? '' });
      },
    };
  }

  /** 게이트 요청(D03 §3): fields = readback 13칸 + 예약 키. 승인되면 토큰 발급 → 소비 + armed(한 트랜잭션). */
  private async openGate(a: ActiveRun, rb: Readback): Promise<{ readbackHash: string }> {
    if (a.stop) throw new RunEnd('stopped', 'run.stopped');
    const history = {
      cpBizNoHmac: this.hmac('bizno', rb.counterpartBizNo),
      recipientEmailHmac: rb.counterpartEmail ? this.hmac('email', canonicalEmail(rb.counterpartEmail)) : null,
      businessKey: businessKey(rb),
    };
    const h = this.ledger.history(history);
    const fields: GateField[] = READBACK_FIELDS.map((k) => ({ fieldKey: k, value: rb[k] }));
    fields.push({ fieldKey: '$first.bizNo', value: String(h.firstBizNo) }, { fieldKey: '$first.email', value: String(h.firstEmail) });
    if (h.businessKeyStates.length) fields.push({ fieldKey: '$dup.businessKey', value: [...new Set(h.businessKeyStates)].sort().join(',') });
    if (h.priorNotCommitted) fields.push({ fieldKey: '$dup.priorNotCommitted', value: 'true' });
    const rbHash = readbackHash(rb);
    const cardHashInputs = { readbackHash: rbHash, packageDigest: a.packageDigest, authorizes: ['s21'], intentId: a.intentId };
    const waitMs = this.d.gateWaitMs ?? (H01.steps.find((s) => s.id === GATE_STEP) as { waitMs: number }).waitMs;
    const req: GateRequest = {
      v: 2,
      runId: a.runId,
      gateStepId: GATE_STEP,
      reqId: randomUUID(),
      approvalNonce: randomBytes(16).toString('base64url'),
      docType: 'H-01',
      trigger: 'local',
      fields,
      cardHashInputs,
      actionHash: actionHash(cardHash(fields), cardHashInputs),
      waitMs,
    };
    this.gates.open(req.reqId, a.runId);
    this.journal.append(a.runId, 'gate.requested', { reqId: req.reqId, first: h.firstBizNo, dup: h.businessKeyStates.length > 0 });
    const decided = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.gates.decide(req.reqId, 'expired', 'timeout')) this.journal.append(a.runId, 'gate.expired', { reqId: req.reqId });
        this.closeGate(a, 'expired');
        reject(new RunEnd('expired', 'gate.expired'));
      }, waitMs);
      a.gate = { req, rb, rbHash, deadline: Date.now() + waitMs, timer, resolve, reject, history };
    });
    this.d.postGate({ t: 'gate.request', req });
    this.ev({ runId: a.runId, type: 'waiting', reqId: req.reqId });
    await decided;
    // 거부 우선 창: 승인 뒤 2초 안에 온 [중지]가 이긴다. 그 뒤에 토큰을 발급한다(D03 §2·§3).
    const until = Date.now() + DENY_PRIORITY_MS;
    while (Date.now() < until && !a.stop) await new Promise((r) => setTimeout(r, 50));
    if (a.stop) {
      if (this.gates.withdraw(req.reqId, 'local')) this.journal.append(a.runId, 'gate.withdrawn', { reqId: req.reqId });
      this.closeGate(a, 'stopped');
      throw new RunEnd('stopped', 'gate.stopped');
    }
    // 토큰(D03 §3): HMAC(runKey, CBOR{runId, gateStepId, actionHash, exp, nonce}). 단일 사용, 주 비가역 1개.
    // 소비는 비가역 스텝 진입에서 gate_requests approved→consumed + 원장 armed 한 트랜잭션이다(arm). 네트워크 커밋 가드(§5.4)는 PoC 범위 밖.
    const runKey = randomBytes(32);
    const exp = Date.now() + Math.min(COMMIT_WINDOW_MS, W_MAX_MS);
    const mac = createHmac('sha256', runKey).update(cbor({ runId: a.runId, gateStepId: GATE_STEP, actionHash: Buffer.from(req.actionHash, 'hex'), exp, nonce: randomBytes(16) })).digest();
    runKey.fill(0);
    a.token = { reqId: req.reqId, mac, exp, used: false };
    a.pendingArm = { req, history };
    return { readbackHash: rbHash };
  }

  /** 비가역 스텝 진입(R-G7): 정지·토큰 확인 → 원장 armed + 토큰 소비(한 트랜잭션, synchronous=FULL). 이 뒤로는 중지를 받지 않는다. */
  private arm(a: ActiveRun): void {
    const t = a.token;
    const p = a.pendingArm;
    if (a.stop) {
      if (t && this.gates.withdraw(t.reqId, 'local')) this.journal.append(a.runId, 'gate.withdrawn', { reqId: t.reqId });
      throw new RunEnd('stopped', 'gate.stopped');
    }
    if (!t || !p || t.used || Date.now() > t.exp) throw new RunEnd('failed', 'token.invalid');
    t.used = true;
    t.mac.fill(0);
    try {
      this.ledger.consumeAndArm(p.req.reqId, {
        intentId: a.intentId, stepId: 's21', runId: a.runId, businessKey: p.history.businessKey, playbookId: H01.id, inputsHash: a.inputsHash,
        packageDigest: a.packageDigest, actionHash: p.req.actionHash, deviceId: this.deviceId, cpBizNoHmac: p.history.cpBizNoHmac, recipientEmailHmac: p.history.recipientEmailHmac,
      });
    } catch (e) {
      throw new RunEnd('failed', e instanceof LedgerError ? e.code : 'ledger.error');
    }
    a.armed = true;
    a.pendingArm = null;
    this.journal.append(a.runId, 'ledger.armed', { reqId: p.req.reqId });
  }

  private closeGate(a: ActiveRun, reason: string): void {
    const g = a.gate;
    if (!g) return;
    clearTimeout(g.timer);
    a.gate = null;
    this.d.postGate({ t: 'gate.closed', runId: a.runId, reqId: g.req.reqId, reason });
  }

  /**
   * 게이트 포트로 온 승인 근거. 열린 게이트와 runId·gateStepId·reqId·approvalNonce·actionHash가 모두 같고,
   * exp가 지나지 않았고(발급 + 120초보다 멀지도 않고), presence가 PoC가 받는 값일 때만 승인한다.
   */
  answer(x: unknown): { ok: boolean; code?: string } {
    const a = this.active;
    const g = a?.gate;
    const ap = x as Partial<LocalApproval> | null;
    const reject = (code: string) => {
      this.d.log.event('gate.answer_rejected', { code });
      if (a) this.journal.append(a.runId, 'gate.answer_rejected', { code });
      return { ok: false, code };
    };
    if (!a || !g) return reject('no_open_gate');
    if (a.stop) return reject('stopped');
    if (!ap || typeof ap !== 'object' || ap.v !== 2) return reject('bad_version');
    if (ap.runId !== a.runId || ap.gateStepId !== g.req.gateStepId || ap.reqId !== g.req.reqId) return reject('wrong_gate');
    if (ap.approvalNonce !== g.req.approvalNonce) return reject('wrong_nonce');
    if (ap.actionHash !== g.req.actionHash) return reject('wrong_action');
    const now = Date.now();
    if (typeof ap.exp !== 'number' || ap.exp < now || ap.exp > now + LOCAL_APPROVAL_TTL_MS + 5_000) return reject('expired');
    if (now > g.deadline) return reject('gate_expired');
    if (!PRESENCE_OK.has(String(ap.presence))) return reject('presence_unsupported');
    if (typeof ap.mac !== 'string' || !ap.mac) return reject('no_mac');
    if (!this.gates.decide(g.req.reqId, 'approved', 'local')) return reject('not_open');
    this.journal.append(a.runId, 'gate.approved', { reqId: g.req.reqId, presence: String(ap.presence) });
    clearTimeout(g.timer);
    a.gate = null;
    g.resolve();
    return { ok: true };
  }

  /** 중계 통로(렌더러 명령이 지나는 길)로 승인·증언이 왔다. 거부하고 보안 이벤트를 남긴다(ADR-021). */
  answerFromRelay(method: string): never {
    this.d.log.event('security.gate_answer_from_relay', { method: method.slice(0, 40).replace(/[^A-Za-z0-9_.:-]/g, '_') });
    if (this.active) this.journal.append(this.active.runId, 'security.gate_answer_from_relay', {});
    throw new RunEnd('failed', 'forbidden_channel');
  }

  /** [중지]: 커밋 구간 전이면 언제든. 승인 대기 중이면 게이트를 거부로 닫는다(안전한 실패). */
  stop(runId: string): { stopped: boolean } {
    const a = this.active;
    if (!a || a.runId !== runId) return { stopped: false };
    if (a.armed) throw new RunEnd('failed', 'already_issuing');
    a.stop = true;
    const g = a.gate;
    if (g) {
      if (this.gates.decide(g.req.reqId, 'denied', 'local')) this.journal.append(a.runId, 'gate.denied', { reqId: g.req.reqId });
      this.closeGate(a, 'stopped');
      g.reject(new RunEnd('stopped', 'gate.stopped'));
    }
    return { stopped: true };
  }

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  /** 시험용 읽기(값 없음): 원장 상태와 저널 종류. */
  inspect(runId: string): { ledger: string | null; journal: string[] } {
    const row = this.d.db.prepare('SELECT state FROM irreversible_log WHERE run_id = ?').get(runId) as { state: string } | undefined;
    return { ledger: row?.state ?? null, journal: this.journal.types(runId) };
  }
}
