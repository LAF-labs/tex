import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { GateRepo, Ledger, LedgerError, RunJournal, RunRepo, type ArmRow, type Db, type PortalProfileKey, type Profile } from '@sax/db';
import type { DiagValue, EventLog } from '@sax/platform';

import type { Page } from 'playwright-core';
import type { DataService } from './data-service.ts';
import { buildGateRequest, cbor, jcs, LOCAL_APPROVAL_TTL_MS, PRESENCE_ACCEPTED, remotePresenceRefusal, sha256hex, type GateField, type GatePortMessage, type GateRequest, type LocalApproval, type ReadbackKey } from './gate.ts';
import { businessKey, canonicalEmail, H01, packageDigest, type Phase } from './h01/playbook.ts';
import { portalProblems, type PortalConfig } from './portal.ts';
import { H01Runner, type Readback, type RunInputs } from './h01/runner.ts';
import { RunEnd, type RunStatus } from './run-end.ts';
import type { IssueLockPort } from './issue-lock.ts';
import { SIGNAL_DICT, type SignalDict } from './signals.ts';
import { issueDateRule } from '@sax/chat-core';
import { kstDay, policyFor, RateGuard, RunPolicy, runPortalConfig, type Clock, type PolicyStatus, type RatePolicy } from './policy.ts';
import { IrRun, type GateHistory, type IrPackage, type IrSourceResult, type StoppedAt } from './run/service-ir.ts';
import { CERT_CARD, certBusinessKey, certInputs, type CertStartParams } from './cert.ts';
import type { HumanPort } from './run/controller.ts';
import type { SimpleAuthIdentity } from './run/simple-auth.ts';
import { ratePolicyFrom, runSignalDict } from './enforcer.ts';
import type { SecretTurnEvent } from './driver/cert-secret.ts';
import type { RunPermit } from './core/permit.ts';
import type { Policy } from './core/types.ts';
import { parseIssueKey, type IssueKey } from './issue/types.ts';
import { REHEARSAL_DONE, REHEARSAL_HANDOFF, rehearsalSnap, RehearsalReport, watchDialogs } from './rehearsal.ts';
import { reverifyInDoubt, type ReverifyResult } from './run/reverify.ts';
import type { RunInputsSummary } from './run-history.ts';

const AI_LOG = /^(locate|fallback|judge|heal|agentpath)\.|^agent\.(start|end|no_plan)$|^(page_judge|browser_agent)\.unavailable$|^actuator\.(why|box_click)$|^branch\.settled$|^portal\.maintenance$/;

type Denied = Extract<RunPermit, { ok: false }>;


export interface StartParams {
  runId: string;
  counterpartyId: string;
  supply: number;
  tax: number;
  itemName: string;
  email?: string | null;
  issueKey?: string;
  rehearsal?: boolean;
  issueDate?: string;
}

/** 발급 사다리의 홈택스 밖 칸(API·직접 발급)이 쓰는 초안. start와 같은 검증을 지난다. */
export type IssueDraft = Omit<StartParams, 'runId' | 'issueKey'> & { issueKey: IssueKey };

/** prepareIssue 결과: 원장 행 재료와, 게이트를 소비하고 무장하는 함수(한 트랜잭션, Ledger.consumeAndArm). */
export interface PreparedIssue {
  row: ArmRow;
  profileId: string;
  inputs: RunInputs;
  supplierBizNo: string;
  arm(reqId: string): void;
}

export type RunEvent =
  | { runId: string; type: 'phase'; phase: Phase; state: 'now' | 'done' | 'attention'; code?: string }
  | { runId: string; type: 'waiting'; reqId: string }
  | ({ runId: string; type: 'secret' } & SecretTurnEvent)
  | { runId: string; type: 'notice'; stepId: string; key: string; text: string; ok: boolean }
  | { runId: string; type: 'end'; status: RunStatus; code?: string; approvalNo?: string; mailConfirmed?: boolean; portalNotice?: string; stoppedAt?: StoppedAt; maintenanceUntil?: string }
  | { runId: string; type: 'handoff'; phase: Phase; code?: string };

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
  halt: RunEnd | null;
  armed: boolean;
  gate: PendingGate | null;
  token: { reqId: string; mac: Buffer; exp: number; used: boolean } | null;
  pendingArm: { req: GateRequest; history: PendingGate['history'] } | null;
  policy: RunPolicy | null;
  ir: IrRun | null;
  issueKey: IssueKey | null;
  pkg: IrPackage | null;
  playbookId: string;
  downgraded: Denied | null;
  portal: PortalConfig;
  signals: SignalDict;
  rehearsal: RehearsalReport | null;
  page: Page | null;
  kind: 'invoice' | 'cert';
  cert: { inputs: Record<string, string>; businessKey: string } | null;
}

export interface RunServiceDeps {
  db: Db;
  data: DataService;
  ledgerKey: Uint8Array;
  portal: PortalConfig;
  page: () => Promise<Page>;
  log: EventLog;
  postGate: (m: GatePortMessage) => void;
  issueLock?: IssueLockPort;
  issueLockWaitMs?: number;
  issueLockRetryMs?: number;
  gateWaitMs?: number;
  policy?: RatePolicy;
  clock?: Clock;
  engine?: 'h01' | 'ir';
  ir?: IrPackage;
  irSource?: () => IrSourceResult;
  rehearsalIrSource?: () => IrSourceResult | null;
  rehearsalSnapDir?: string;
  certSource?: (playbookId: string) => IrSourceResult;
  certRehearsalSource?: (playbookId: string) => IrSourceResult | null;
  permit?: (playbookId: string) => RunPermit;
  receivedPolicy?: () => Policy | null;
  closeBrowser?: () => Promise<void>;
  secretTtlMs?: number;
  trace?: (runId: string, e: { name: string; stepId: string; type: string; code?: string }) => void;
  handoffCapMs?: number;
  lifetimeMs?: number;
  human?: HumanPort;
  currentPage?: () => Page | null;
  runInputs?: (runId: string) => (RunInputsSummary & { startedAt: string }) | null;
}

const COMMIT_WINDOW_MS = 600_000;
const W_MAX_MS = 60_000;
const GATE_STEP = 's20';
/** 승인 뒤 이 시간 동안은 거부([중지])가 이긴다(D03 §2 전이표 "거부 우선 창 2초"). */
export const DENY_PRIORITY_MS = 2_000;
const PRESENCE_OK = PRESENCE_ACCEPTED;

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
  private readonly rate: RateGuard;
  private readonly deviceId: string;
  private active: ActiveRun | null = null;
  private reverifying = false;

  private readonly engine: 'h01' | 'ir';

  constructor(d: RunServiceDeps) {
    super();
    this.d = d;
    this.engine = d.engine ?? 'ir';
    this.runs = new RunRepo(d.db);
    this.gates = new GateRepo(d.db);
    this.ledger = new Ledger(d.db);
    this.journal = new RunJournal(d.db);
    const received = d.receivedPolicy;
    this.rate = new RateGuard(d.db, d.portal.kind, d.policy ?? policyFor(d.portal.kind), d.clock, received ? () => {
      const p = received();
      return p ? ratePolicyFrom(p, 'hometax', 'interactive') : null;
    } : undefined);
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

  private hmac(kind: 'bizno' | 'email' | 'cert', v: string): string {
    return createHmac('sha256', this.d.ledgerKey).update(`SAX-ledger-${kind}\0${v}`).digest('hex');
  }

  private ev(e: RunEvent): void {
    const report = this.active?.runId === e.runId ? this.active.rehearsal : null;
    if (report && e.type === 'phase') report.phase(e.phase, e.state);
    if (report && e.type === 'handoff') {
      report.handoff(e.phase, e.code);
      void this.snapThenStop(this.active!, { phase: e.phase, ...(e.code ? { code: e.code } : {}) });
    }
    this.emit('event', e);
  }

  start(p: StartParams): { runId: string; intentId: string } {
    if (this.active || this.reverifying) throw new RunEnd('failed', 'busy');
    const problems = this.engine === 'ir' ? portalProblems(this.d.portal).filter((x) => x === 'verify_below_floor') : portalProblems(this.d.portal);
    if (problems.length) {
      this.d.log.event('run.portal_not_ready', { kind: this.d.portal.kind, problems: problems.length });
      throw new RunEnd('failed', 'selector_placeholder');
    }
    if (typeof p.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.runId)) throw new RunEnd('failed', 'bad_run_id');
    const issueKey = p.issueKey === undefined ? null : parseIssueKey(p.issueKey);
    if (p.issueKey !== undefined && !issueKey) throw new RunEnd('failed', 'issue.bad_key');
    const { profile, inputs } = this.draft(p);
    if (issueKey) this.refuseIssued(issueKey);
    const intentId = ulid();
    const inputsHash = sha256hex(jcs(inputs));
    const irPkg = this.engine === 'ir' ? this.packageForRun(p.rehearsal === true) : undefined;
    const playbookId = irPkg?.pkg.files.manifest.id ?? H01.id;
    const playbookVersion = irPkg?.pkg.files.manifest.version ?? H01.version;
    const digest = irPkg ? irPkg.pkg.manifestDigest : packageDigest(this.d.portal, profile.updatedAt);
    const a = this.launch({ runId: p.runId, intentId, inputsHash, irPkg, playbookId, playbookVersion, digest, profile, issueKey, rehearsal: p.rehearsal === true, kind: 'invoice', cert: null });
    void this.execute(a, inputs, profile);
    return { runId: p.runId, intentId };
  }

  startCert(p: CertStartParams): { runId: string; intentId: string } {
    if (this.active) throw new RunEnd('failed', 'busy');
    if (this.engine !== 'ir') throw new RunEnd('failed', 'package.not_loaded');
    if (portalProblems(this.d.portal).includes('verify_below_floor')) {
      this.d.log.event('run.portal_not_ready', { kind: this.d.portal.kind, problems: 1 });
      throw new RunEnd('failed', 'selector_placeholder');
    }
    if (typeof p?.runId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p.runId)) throw new RunEnd('failed', 'bad_run_id');
    if (typeof p.playbookId !== 'string' || !/^[a-z0-9_.]{1,80}$/.test(p.playbookId)) throw new RunEnd('failed', 'package.not_loaded');
    const profile = this.d.data.profiles.byKind('business');
    if (!profile?.bizNo) throw new RunEnd('failed', 'profile_missing');
    if (!profile.signMethod) throw new RunEnd('failed', 'profile_missing');
    const rehearsal = p.rehearsal === true;
    const irPkg = this.certPackageFor(p.playbookId, rehearsal);
    const files = irPkg.pkg.files;
    if (files.manifest.id !== p.playbookId || !files.playbook.steps.some((s) => s.type === 'gate' && s.card === CERT_CARD)) throw new RunEnd('failed', 'package.not_loaded');
    const checked = certInputs(files.playbook.inputs, p.inputs);
    if (!checked.ok) {
      this.d.log.event('run.cert_input_refused', { playbook: p.playbookId, code: checked.code, field: checked.field });
      throw new RunEnd('failed', checked.code);
    }
    const inputs = checked.inputs;
    const intentId = ulid();
    const inputsHash = sha256hex(jcs({ playbookId: p.playbookId, inputs }));
    const businessKey = certBusinessKey({ playbookId: p.playbookId, bizNo: profile.bizNo, day: kstDay(this.rate.clock().now), inputs });
    const a = this.launch({
      runId: p.runId, intentId, inputsHash, irPkg, playbookId: files.manifest.id, playbookVersion: files.manifest.version, digest: irPkg.pkg.manifestDigest, profile,
      issueKey: null, rehearsal, kind: 'cert', cert: { inputs, businessKey },
    });
    void this.execute(a, null, profile);
    return { runId: p.runId, intentId };
  }

  private launch(o: {
    runId: string; intentId: string; inputsHash: string; irPkg: IrPackage | undefined; playbookId: string; playbookVersion: string; digest: string; profile: Profile;
    issueKey: IssueKey | null; rehearsal: boolean; kind: ActiveRun['kind']; cert: ActiveRun['cert'];
  }): ActiveRun {
    const { runId, intentId, inputsHash, irPkg, playbookId, playbookVersion, digest, profile, issueKey, rehearsal } = o;
    const pm = this.d.permit?.(playbookId);
    if (pm && !pm.ok) {
      this.d.log.event('run.policy_refused', { kind: this.d.portal.kind, code: pm.code });
      throw new RunEnd('failed', pm.code);
    }
    const check = this.ledger.checkIntent(intentId, 's21', playbookId, inputsHash);
    if (check.kind !== 'new') throw new RunEnd('failed', 'ledger.intent_not_new');
    try {
      this.rate.pinRun();
      this.rate.admit(profile.id, { irreversible: !rehearsal });
    } catch (e) {
      if (e instanceof RunEnd) this.d.log.event('run.policy_refused', { kind: this.d.portal.kind, code: e.code });
      throw e;
    }
    this.runs.create({ id: runId, playbookId, playbookVersion, packageDigest: digest, profileId: profile.id, trigger: 'local', inputsHash });
    this.journal.append(runId, 'run.started', { intentId, portal: this.d.portal.kind, conservative: this.rate.clock().conservative });
    if (issueKey) this.journal.append(runId, 'issue.rung', { issueKey, rung: 'hometax.auto' });
    if (rehearsal) this.journal.append(runId, 'run.rehearsal');
    const gaps = (['block', 'extra_auth', 'captcha'] as const).filter((k) => !SIGNAL_DICT[this.d.portal.kind].some((e) => e.kind === k));
    if (gaps.length) {
      this.journal.append(runId, 'run.signal_dict_empty', { kinds: gaps.join(',') });
      this.d.log.event('run.signal_dict_empty', { kind: this.d.portal.kind, kinds: gaps.join(',') });
    }
    const startPolicy = this.d.portal.kind === 'hometax' ? (this.d.receivedPolicy?.() ?? null) : null;
    const portal = runPortalConfig(this.d.portal, startPolicy);
    this.active = {
      runId, intentId, inputsHash, packageDigest: digest, stop: false, halt: null, armed: false, gate: null, token: null, pendingArm: null, policy: null, ir: null, issueKey, pkg: irPkg ?? null, playbookId, downgraded: null,
      portal, signals: this.runSignals(() => this.ledger.statesByRun(runId).some((st) => st === 'armed' || st === 'dispatched'), startPolicy),
      page: null,
      rehearsal: rehearsal ? new RehearsalReport(irPkg?.local ? `local:${playbookVersion}:${irPkg.local.digest.slice(0, 12)}` : `${irPkg ? 'registry' : 'h01'}:${playbookVersion}`) : null,
      kind: o.kind, cert: o.cert,
    };
    return this.active;
  }

  private draft(p: Omit<StartParams, 'runId' | 'issueKey'>): { profile: Profile; inputs: RunInputs } {
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
    const inputs: RunInputs = {
      counterpart: { id: cp.id, bizNo: cp.bizNo, name: cp.name },
      amounts: { supply: String(supply), tax: String(tax), total: String(supply + tax) },
      items: [{ name: itemName }],
      issueDate: this.issueDate(p.issueDate),
      email,
    };
    return { profile, inputs };
  }

  private issueDate(v: unknown): string {
    const today = kstDay(this.rate.clock().now);
    if (v === undefined || v === null || v === today) return today;
    const t = String(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
    const real = m && new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) === t;
    const rule = real ? issueDateRule(t, today) : null;
    if (rule !== 'ok' && rule !== 'late') throw new RunEnd('failed', 'bad_issue_date');
    return t;
  }

  private refuseIssued(issueKey: IssueKey): void {
    const rows = this.ledger.byIssueKey(issueKey);
    if (rows.some((r) => r.state === 'committed')) throw new RunEnd('failed', 'ledger.issue_committed');
    if (rows.some((r) => r.state !== 'not_committed')) throw new RunEnd('failed', 'ledger.issue_open');
  }

  prepareIssue(p: IssueDraft, o: { runId: string; stepId: string; playbookId: string }): PreparedIssue {
    const { profile, inputs } = this.draft(p);
    this.refuseIssued(p.issueKey);
    const row = this.draftRow(profile, inputs, { intentId: ulid(), runId: o.runId, stepId: o.stepId, playbookId: o.playbookId, inputsHash: sha256hex(jcs(inputs)), packageDigest: sha256hex(o.playbookId), issueKey: p.issueKey });
    return {
      row, profileId: profile.id, inputs, supplierBizNo: profile.bizNo!,
      arm: (reqId) => this.ledger.consumeAndArm(reqId, row),
    };
  }

  private draftRow(profile: Profile, inputs: RunInputs, o: { intentId: string; runId: string; stepId: string; playbookId: string; inputsHash: string; packageDigest: string; issueKey: IssueKey | null }): ArmRow {
    const rb = {
      supplierBizNo: profile.bizNo!, counterpartBizNo: inputs.counterpart.bizNo, supplyAmount: inputs.amounts.supply, taxAmount: inputs.amounts.tax,
      issueDate: inputs.issueDate, itemName: inputs.items[0]!.name,
    } as Readonly<Record<ReadbackKey, string>>;
    return {
      intentId: o.intentId, stepId: o.stepId, runId: o.runId, businessKey: businessKey(rb), playbookId: o.playbookId, inputsHash: o.inputsHash,
      packageDigest: o.packageDigest, actionHash: sha256hex(jcs({ playbookId: o.playbookId, stepId: o.stepId, inputsHash: o.inputsHash, issueKey: o.issueKey })),
      deviceId: this.deviceId, cpBizNoHmac: this.hmac('bizno', inputs.counterpart.bizNo),
      recipientEmailHmac: inputs.email ? this.hmac('email', canonicalEmail(inputs.email)) : null, issueKey: o.issueKey,
    };
  }

  private async execute(a: ActiveRun, inputs: RunInputs | null, profile: Profile): Promise<void> {
    let result: { status: RunStatus; code?: string; approvalNo?: string; mailConfirmed?: boolean; stoppedAt?: StoppedAt; maintenanceUntil?: string };
    let thrown: unknown;
    try {
      this.ev({ runId: a.runId, type: 'phase', phase: 'login', state: 'now' });
      const page = await this.d.page();
      a.page = page;
      if (a.rehearsal) watchDialogs(page);
      if (this.engine !== 'ir') a.policy = new RunPolicy(page, this.rate, a.portal, {
        profileId: profile.id,
        signals: a.signals,
        checkStop: () => this.checkStop(a),
        journal: (type, payload) => this.journal.append(a.runId, type, payload),
        onLatch: (end) => this.latched(a, end),
      });
      if (this.d.portal.login && this.engine !== 'ir') throw new RunEnd('failed', 'login.not_implemented');
      if (this.engine !== 'ir') this.ev({ runId: a.runId, type: 'phase', phase: 'login', state: 'done', code: 'login.session_assumed' });
      if (this.engine === 'ir') {
        a.policy = null;
        result = await this.executeIr(a, page, inputs, profile);
      } else result = await new H01Runner(page, a.portal, inputs!, { bizNo: profile.bizNo! }, this.hooks(a), a.policy!).run();
    } catch (e) {
      thrown = e;
      result = { status: 'failed', code: 'engine.error' };
    }
    await a.policy?.finish({ userStopped: a.stop }).catch(() => {});
    const latched = a.policy?.latched ?? null;
    if (thrown !== undefined) {
      const end = latched ?? (thrown instanceof RunEnd ? thrown : null);
      result = end ? { status: end.status, code: end.code } : { status: 'failed', code: 'engine.error' };
      if (!end) this.d.log.event('run.error', { runId: a.runId, err: (thrown as Error)?.name ?? 'unknown' });
    } else if (latched?.status === 'failed') {
      result = { ...result, status: 'failed', code: latched.code };
    }
    if (latched) this.d.log.event('run.signal', { runId: a.runId, code: latched.code });
    const row = this.ledger.get(a.intentId, 's21');
    if (row && (row.state === 'armed' || row.state === 'dispatched')) {
      this.ledger.resolve(a.intentId, 's21', 'in_doubt');
      result = { status: 'in_doubt', code: result.code ?? 'engine.error' };
    } else if (row?.state === 'in_doubt') result = { ...result, status: 'in_doubt' };
    else if (row?.state === 'committed' && result.status !== 'success' && result.status !== 'completed_with_issues') {
      const code = latched?.status === 'failed' ? 'portal.blocked_after_commit' : 'post_commit.error';
      result = { ...result, status: 'completed_with_issues', code, approvalNo: row.verifyRef ?? result.approvalNo };
    }
    if (a.rehearsal?.gateStep && !row) result = { status: 'stopped', code: REHEARSAL_DONE };
    else if (a.rehearsal?.handedOff && !row) result = { ...result, status: 'stopped', code: REHEARSAL_HANDOFF };
    if (a.rehearsal) this.d.log.event('run.rehearsal_report', a.rehearsal.fields(a.runId, { status: result.status, code: result.code, stepId: result.stoppedAt?.stepId }));
    if ((a.downgraded ?? a.ir?.downgraded)?.hardStop) await this.d.closeBrowser?.().catch(() => {});
    this.closeGate(a, 'run_ended');
    if (a.token && !a.armed && this.gates.withdraw(a.token.reqId, 'run_ended')) this.journal.append(a.runId, 'gate.withdrawn', { reqId: a.token.reqId });
    this.rate.unpinRun();
    this.runs.finish(a.runId, result.status);
    this.journal.append(a.runId, 'run.ended', { status: result.status, code: result.code ?? '', ...(result.mailConfirmed !== undefined ? { mailConfirmed: result.mailConfirmed } : {}), ...(result.stoppedAt ? { stepId: result.stoppedAt.stepId, stepType: result.stoppedAt.type, ...(result.stoppedAt.target ? { target: result.stoppedAt.target } : {}) } : {}) });
    if (result.stoppedAt) this.d.log.event('run.stopped_at', { runId: a.runId, status: result.status, code: result.code ?? '', stepId: result.stoppedAt.stepId, stepType: result.stoppedAt.type, target: result.stoppedAt.target ?? '', playbook: a.playbookId });
    if (inputs && (result.status === 'success' || result.status === 'completed_with_issues')) this.d.data.counterparties.markUsed(inputs.counterpart.id);
    this.active = null;
    const notice = a.policy?.notice ?? a.ir?.notice;
    const showNotice = notice && (result.status === 'failed' || result.status === 'handoff' || result.status === 'in_doubt');
    this.ev({ runId: a.runId, type: 'end', ...result, ...(showNotice ? { portalNotice: notice } : {}) });
  }

  private runSignals(inCommit: () => boolean, startPolicy: Policy | null): SignalDict {
    const builtIn = SIGNAL_DICT[this.d.portal.kind];
    const received = this.d.receivedPolicy;
    if (this.d.portal.kind !== 'hometax' || !received) return builtIn;
    return runSignalDict({
      builtIn, atStart: startPolicy?.cooldown.blockSignalsAdd, current: () => received()?.cooldown.blockSignalsAdd,
      inCommit,
      onDropped: (where) => this.d.log.event('policy.block_signal_dropped', { where }),
    });
  }

  private packageForRun(rehearsal: boolean): IrPackage {
    if (this.d.ir) return this.d.ir;
    const local = rehearsal ? (this.d.rehearsalIrSource?.() ?? null) : null;
    if (local?.ok) return local.ir;
    if (local) {
      this.d.log.event('run.rehearsal_package_refused', { code: local.code });
      throw new RunEnd('failed', local.code);
    }
    const r = this.d.irSource?.() ?? { ok: false as const, code: 'package.not_loaded' };
    if (r.ok) return r.ir;
    if (r.code === 'package.not_loaded') throw new RunEnd('failed', 'package.not_loaded');
    this.d.log.event('run.package_refused', { code: r.code });
    if (r.code === 'registry.app_version_low') throw new RunEnd('failed', 'package.app_old');
    throw new RunEnd('failed', 'package.load_failed');
  }

  private async executeIr(a: ActiveRun, page: Page, inputs: RunInputs | null, profile: Profile): Promise<{ status: RunStatus; code?: string; approvalNo?: string; mailConfirmed?: boolean; stoppedAt?: StoppedAt; maintenanceUntil?: string }> {
    const ir = a.pkg!;
    const playbookId = ir.pkg.files.manifest.id;
    const run = new IrRun({
      runId: a.runId, intentId: a.intentId, packageDigest: a.packageDigest, page, ir, portal: a.portal, signals: a.signals, rate: this.rate,
      profile: { id: profile.id, bizNo: profile.bizNo!, signMethod: profile.signMethod ?? null, certName: profile.certName ?? null },
      profileWrite: async (field, value) => {
        if (field !== 'certName') return false;
        try {
          this.d.data.profiles.setCertName(profile.id, value);
          return true;
        } catch {
          return false;
        }
      },
      ...(this.d.permit ? { permit: () => this.d.permit!(playbookId) } : {}),
      kind: a.kind,
      inputs: inputs ? irInputs(inputs, this.d.data.counterparties.get(inputs.counterpart.id)) : { ...a.cert!.inputs },
      db: this.d.db, ledger: this.ledger, gates: this.gates,
      history: (rb, card) => {
        if (a.kind === 'cert') return card === CERT_CARD ? this.certHistory(a, profile, playbookId) : null;
        if (card !== 'invoice.confirm' || !inputs) return null;
        const h01 = rb as Readonly<Record<ReadbackKey, string>>;
        const history = {
          cpBizNoHmac: this.hmac('bizno', h01.counterpartBizNo),
          recipientEmailHmac: h01.counterpartEmail ? this.hmac('email', canonicalEmail(h01.counterpartEmail)) : null,
          businessKey: businessKey(h01),
        };
        const h = this.ledger.history(history);
        const reserved: GateField[] = [{ fieldKey: '$first.bizNo', value: String(h.firstBizNo) }, { fieldKey: '$first.email', value: String(h.firstEmail) }];
        if (h.businessKeyStates.length) reserved.push({ fieldKey: '$dup.businessKey', value: [...new Set(h.businessKeyStates)].sort().join(',') });
        if (h.priorNotCommitted) reserved.push({ fieldKey: '$dup.priorNotCommitted', value: 'true' });
        return {
          reserved,
          row: (x) => ({
            intentId: a.intentId, stepId: x.stepId, runId: a.runId, businessKey: history.businessKey, playbookId, inputsHash: a.inputsHash,
            packageDigest: a.packageDigest, actionHash: x.actionHash, deviceId: this.deviceId, cpBizNoHmac: history.cpBizNoHmac, recipientEmailHmac: history.recipientEmailHmac,
            issueKey: x.stepId === 's21' ? a.issueKey : null,
          }),
        };
      },
      manualRow: (stepId) => !inputs ? null : this.draftRow(profile, inputs, { intentId: a.intentId, runId: a.runId, stepId, playbookId, inputsHash: a.inputsHash, packageDigest: a.packageDigest, issueKey: stepId === 's21' ? a.issueKey : null }),
      journal: (type, payload) => {
        this.journal.append(a.runId, type, payload);
        a.rehearsal?.journal(type);
        if (type === 'lookup.step_failed' && payload) this.d.log.event('run.lookup_failed', { runId: a.runId, ...payload });
        if (type === 'readback.optional' && payload) this.d.log.event('run.readback_optional', { runId: a.runId, ...payload });
        if (type === 'readback.failed' && payload) this.d.log.event('run.readback_failed', { runId: a.runId, ...payload });
        if (type === 'lookup.table_failed' && payload) this.d.log.event('run.lookup_table_failed', { runId: a.runId, ...payload });
        if (type === 'run.handoff' && payload) this.d.log.event('run.handoff', { runId: a.runId, playbook: a.playbookId, ...payload });
        if (payload && AI_LOG.test(type)) {
          if (this.d.log.diag) this.d.log.diag(type, { runId: a.runId }, payload);
          else this.d.log.event(type, { runId: a.runId, ...payload });
        }
      },
      diag: (code, fields, data) => this.d.log.diag?.(code, { runId: a.runId, playbook: a.playbookId, ...fields }, data as DiagValue),
      phase: (phase, state, code) => this.ev({ runId: a.runId, type: 'phase', phase: phase as Phase, state, ...(code ? { code } : {}) }),
      postGate: (m) => this.gatePort(a, m),
      waiting: (reqId) => this.ev({ runId: a.runId, type: 'waiting', reqId }),
      ...(this.d.gateWaitMs !== undefined ? { gateWaitMs: this.d.gateWaitMs } : {}),
      ...(this.d.issueLock && !a.rehearsal ? { issueLock: this.d.issueLock } : {}),
      ...(this.d.issueLockWaitMs !== undefined ? { issueLockWaitMs: this.d.issueLockWaitMs } : {}),
      ...(this.d.issueLockRetryMs !== undefined ? { issueLockRetryMs: this.d.issueLockRetryMs } : {}),
      ...(this.d.trace ? { trace: (e) => this.d.trace!(a.runId, e) } : {}),
      handoff: (h) => this.ev({ runId: a.runId, type: 'handoff', phase: h.phase as Phase, ...(h.code ? { code: h.code } : {}) }),
      ...(this.d.human ? { human: this.d.human } : {}),
      ...(this.d.handoffCapMs !== undefined ? { handoffCapMs: this.d.handoffCapMs } : {}),
      ...(this.d.lifetimeMs !== undefined ? { lifetimeMs: this.d.lifetimeMs } : {}),
      secretEvent: (e) => this.ev({ runId: a.runId, type: 'secret', ...e }),
      ...(a.rehearsal && this.d.rehearsalSnapDir ? { lookupSnap: (p: Page, at: { stepId: string; code: string }) => rehearsalSnap(p, this.d.rehearsalSnapDir!, `${a.runId}-lookup`, { phase: 'lookup', code: `${at.stepId}:${at.code}` }) } : {}),
      portalNotice: (n) => {
        if (inputs && n.ok && n.key === BIZNO_OK_KEY) this.fromPortal(a.runId, 'counterparty.verified', () => (this.d.data.counterparties.setVerification(inputs.counterpart.id, BIZNO_OK_STATUS), ['verifiedStatus']));
        this.ev({ runId: a.runId, type: 'notice', stepId: n.stepId, key: n.key, text: n.text, ok: n.ok });
      },
      readbackFixed: (rb, card) => {
        if (card !== 'invoice.confirm' || !inputs) return;
        const f = portalFill(rb);
        this.fromPortal(a.runId, 'profile.filled_from_portal', () => this.d.data.profiles.fillFromPortal(profile.id, f.profile));
        this.fromPortal(a.runId, 'counterparty.filled_from_portal', () => this.d.data.counterparties.fillFromPortal(inputs.counterpart.id, f.counterparty));
      },
      ...(this.d.secretTtlMs !== undefined ? { secretTtlMs: this.d.secretTtlMs } : {}),
    });
    a.ir = run;
    const r = await run.run();
    a.armed = run.armed;
    return { status: r.status, ...(r.maintenanceUntil ? { maintenanceUntil: r.maintenanceUntil } : {}), ...(r.code ? { code: r.code } : {}), ...(r.approvalNo ? { approvalNo: r.approvalNo } : {}), ...(r.mailConfirmed !== undefined ? { mailConfirmed: r.mailConfirmed } : {}), ...(r.stoppedAt ? { stoppedAt: r.stoppedAt } : {}) };
  }

  private certHistory(a: ActiveRun, profile: Profile, playbookId: string): GateHistory {
    const cert = a.cert!;
    const cpBizNoHmac = this.hmac('cert', profile.bizNo!.replace(/\D/g, ''));
    const h = this.ledger.history({ cpBizNoHmac, recipientEmailHmac: null, businessKey: cert.businessKey });
    const reserved: GateField[] = [];
    if (h.businessKeyStates.length) reserved.push({ fieldKey: '$dup.businessKey', value: [...new Set(h.businessKeyStates)].sort().join(',') });
    if (h.priorNotCommitted) reserved.push({ fieldKey: '$dup.priorNotCommitted', value: 'true' });
    return {
      reserved,
      row: (x) => ({
        intentId: a.intentId, stepId: x.stepId, runId: a.runId, businessKey: cert.businessKey, playbookId, inputsHash: a.inputsHash,
        packageDigest: a.packageDigest, actionHash: x.actionHash, deviceId: this.deviceId, cpBizNoHmac, recipientEmailHmac: null, issueKey: null,
      }),
    };
  }

  private certPackageFor(playbookId: string, rehearsal: boolean): IrPackage {
    if (this.d.ir && this.d.ir.pkg.files.manifest.id === playbookId) return this.d.ir;
    const local = rehearsal ? (this.d.certRehearsalSource?.(playbookId) ?? null) : null;
    if (local?.ok) return local.ir;
    if (local) {
      this.d.log.event('run.rehearsal_package_refused', { code: local.code, playbook: playbookId });
      throw new RunEnd('failed', local.code);
    }
    const r = this.d.certSource?.(playbookId) ?? { ok: false as const, code: 'package.not_loaded' };
    if (r.ok) return r.ir;
    if (r.code === 'cert.unknown_doc') this.d.log.event('run.cert_unknown_doc', { playbook: playbookId });
    if (r.code === 'package.not_loaded' || r.code === 'cert.unknown_doc') throw new RunEnd('failed', 'package.not_loaded');
    this.d.log.event('run.package_refused', { code: r.code, playbook: playbookId });
    if (r.code === 'registry.app_version_low') throw new RunEnd('failed', 'package.app_old');
    throw new RunEnd('failed', 'package.load_failed');
  }

  private fromPortal(runId: string, type: string, write: () => readonly string[]): void {
    try {
      const keys = write();
      if (keys.length) this.journal.append(runId, type, { fields: keys.join(',') });
    } catch (e) {
      this.d.log.event('run.portal_fill_failed', { runId, type, err: (e as Error)?.message?.slice(0, 40) ?? 'unknown' });
    }
  }

  private checkStop(a: ActiveRun): void {
    if (!a.downgraded) {
      const p = this.d.permit?.(a.playbookId);
      if (p && !p.ok) this.downgradeH01(a, p);
    }
    if (a.halt) throw a.halt;
    if (a.stop) throw new RunEnd('stopped', 'run.stopped');
  }

  private hooks(a: ActiveRun) {
    return {
      phase: (phase: Phase, state: 'now' | 'done' | 'attention', code?: string) => this.ev({ runId: a.runId, type: 'phase', phase, state, code }),
      checkStop: () => this.checkStop(a),
      ...(this.d.trace ? { step: (stepId: string, type: string) => this.d.trace!(a.runId, { name: 'step.started', stepId, type }) } : {}),
      gate: (rb: Readback) => this.openGate(a, rb),
      arm: () => this.arm(a),
      dispatched: () => {
        this.ledger.dispatched(a.intentId, 's21');
        this.journal.append(a.runId, 'ledger.dispatched');
      },
      resolve: (state: 'committed' | 'not_committed' | 'in_doubt', reason: 'pre_dispatch_mismatch' | 'identity_mismatch' | 'signal' | 'verify' | null, ref: string | null) => {
        this.ledger.resolve(a.intentId, 's21', state, reason, ref);
        this.journal.append(a.runId, `ledger.${state}`, { reason: reason ?? '' });
      },
    };
  }

  private async openGate(a: ActiveRun, rb: Readback): Promise<{ readbackHash: string }> {
    this.checkStop(a);
    if (a.policy?.latched) throw a.policy.latched;
    const history = {
      cpBizNoHmac: this.hmac('bizno', rb.counterpartBizNo),
      recipientEmailHmac: rb.counterpartEmail ? this.hmac('email', canonicalEmail(rb.counterpartEmail)) : null,
      businessKey: businessKey(rb),
    };
    const h = this.ledger.history(history);
    const reserved: GateField[] = [{ fieldKey: '$first.bizNo', value: String(h.firstBizNo) }, { fieldKey: '$first.email', value: String(h.firstEmail) }];
    if (h.businessKeyStates.length) reserved.push({ fieldKey: '$dup.businessKey', value: [...new Set(h.businessKeyStates)].sort().join(',') });
    if (h.priorNotCommitted) reserved.push({ fieldKey: '$dup.priorNotCommitted', value: 'true' });
    const waitMs = this.d.gateWaitMs ?? (H01.steps.find((s) => s.id === GATE_STEP) as { waitMs: number }).waitMs;
    const req = buildGateRequest({ runId: a.runId, gateStepId: GATE_STEP, readback: rb, reserved, packageDigest: a.packageDigest, authorizes: ['s21'], intentId: a.intentId, waitMs });
    const rbHash = req.cardHashInputs.readbackHash;
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
    this.gatePort(a, { t: 'gate.request', req });
    this.ev({ runId: a.runId, type: 'waiting', reqId: req.reqId });
    await decided;
    const until = Date.now() + DENY_PRIORITY_MS;
    while (Date.now() < until && !a.stop && !a.halt && !a.policy?.latched) await new Promise((r) => setTimeout(r, 50));
    const halt = a.policy?.latched ?? a.halt ?? (a.stop ? new RunEnd('stopped', 'gate.stopped') : null);
    if (halt) {
      if (this.gates.withdraw(req.reqId, a.stop ? 'local' : 'policy')) this.journal.append(a.runId, 'gate.withdrawn', { reqId: req.reqId });
      this.closeGate(a, a.stop ? 'stopped' : 'signal');
      throw halt;
    }
    const runKey = randomBytes(32);
    const exp = Date.now() + Math.min(COMMIT_WINDOW_MS, W_MAX_MS);
    const mac = createHmac('sha256', runKey).update(cbor({ runId: a.runId, gateStepId: GATE_STEP, actionHash: Buffer.from(req.actionHash, 'hex'), exp, nonce: randomBytes(16) })).digest();
    runKey.fill(0);
    a.token = { reqId: req.reqId, mac, exp, used: false };
    a.pendingArm = { req, history };
    return { readbackHash: rbHash };
  }

  private arm(a: ActiveRun): void {
    const t = a.token;
    const p = a.pendingArm;
    if (a.stop || a.halt) {
      if (t && this.gates.withdraw(t.reqId, a.stop ? 'local' : 'policy')) this.journal.append(a.runId, 'gate.withdrawn', { reqId: t.reqId });
      throw a.halt ?? new RunEnd('stopped', 'gate.stopped');
    }
    if (!t || !p || t.used || Date.now() > t.exp) throw new RunEnd('failed', 'token.invalid');
    t.used = true;
    t.mac.fill(0);
    try {
      this.d.db.transaction(() => {
        a.policy!.commit();
        this.ledger.consumeAndArm(p.req.reqId, {
          intentId: a.intentId, stepId: 's21', runId: a.runId, businessKey: p.history.businessKey, playbookId: H01.id, inputsHash: a.inputsHash,
          packageDigest: a.packageDigest, actionHash: p.req.actionHash, deviceId: this.deviceId, cpBizNoHmac: p.history.cpBizNoHmac, recipientEmailHmac: p.history.recipientEmailHmac,
          issueKey: a.issueKey,
        });
      })();
    } catch (e) {
      if (e instanceof RunEnd) throw e;
      throw new RunEnd('failed', e instanceof LedgerError ? e.code : 'ledger.error');
    }
    a.armed = true;
    a.pendingArm = null;
    this.journal.append(a.runId, 'ledger.armed', { reqId: p.req.reqId });
  }

  private latched(a: ActiveRun, end: RunEnd): void {
    const g = a.gate;
    if (!g) return;
    if (this.gates.decide(g.req.reqId, 'denied', 'policy')) this.journal.append(a.runId, 'gate.denied', { reqId: g.req.reqId, by: 'policy' });
    this.closeGate(a, 'signal');
    g.reject(end);
  }

  private closeGate(a: ActiveRun, reason: string): void {
    const g = a.gate;
    if (!g) return;
    clearTimeout(g.timer);
    a.gate = null;
    this.gatePort(a, { t: 'gate.closed', runId: a.runId, reqId: g.req.reqId, reason });
  }

  private gatePort(a: ActiveRun, m: GatePortMessage): void {
    if (!a.rehearsal) return this.d.postGate(m);
    if (m.t !== 'gate.request' || a.rehearsal.gateStep) return;
    a.rehearsal.gateStep = m.req.gateStepId;
    this.journal.append(a.runId, 'rehearsal.gate_reached', { stepId: m.req.gateStepId });
    this.stopSoon(a, null);
  }

  private async snapThenStop(a: ActiveRun, at: { phase: string; code?: string }): Promise<void> {
    const dir = this.d.rehearsalSnapDir;
    if (dir && a.page && a.rehearsal && !a.rehearsal.snapped) {
      a.rehearsal.snapped = true;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([rehearsalSnap(a.page, dir, a.runId, at).catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, 6_000)))]).finally(() => clearTimeout(timer));
    }
    this.stopSoon(a, 'rehearsal.handoff_stop');
  }

  private stopSoon(a: ActiveRun, journalType: string | null): void {
    if (journalType) this.journal.append(a.runId, journalType);
    setImmediate(() => {
      if (this.active !== a) return;
      try {
        this.stop(a.runId);
      } catch (e) {
        this.d.log.event('run.rehearsal_stop_failed', { runId: a.runId, error: e instanceof RunEnd ? e.code : 'error' });
      }
    });
  }

  answer(x: unknown): { ok: boolean; code?: string } {
    const a = this.active;
    const g = a?.gate;
    const ap = x as Partial<LocalApproval> | null;
    const reject = (code: string) => {
      this.d.log.event('gate.answer_rejected', { code });
      if (a) this.journal.append(a.runId, 'gate.answer_rejected', { code });
      return { ok: false, code };
    };
    if (a?.rehearsal) return reject('rehearsal');
    if (a?.ir) return this.answerIr(a, a.ir, ap, reject);
    if (!a || !g) return reject('no_open_gate');
    if (a.stop) return reject('stopped');
    if (!ap || typeof ap !== 'object' || ap.v !== 2) return reject('bad_version');
    if (ap.runId !== a.runId || ap.gateStepId !== g.req.gateStepId || ap.reqId !== g.req.reqId) return reject('wrong_gate');
    if (ap.approvalNonce !== g.req.approvalNonce) return reject('wrong_nonce');
    if (ap.actionHash !== g.req.actionHash) return reject('wrong_action');
    const now = Date.now();
    if (typeof ap.exp !== 'number' || ap.exp < now || ap.exp > now + LOCAL_APPROVAL_TTL_MS + 5_000) return reject('expired');
    if (now > g.deadline) return reject('gate_expired');
    if (!PRESENCE_OK.has(String(ap.presence)) || (ap.presence === 'click+batch' && g.req.docType !== 'H-01')) return reject('presence_unsupported');
    if (ap.presence === 'remote+px' && remotePresenceRefusal(g.req)) return reject('remote_not_allowed');
    if (typeof ap.mac !== 'string' || !ap.mac) return reject('no_mac');
    if (!this.gates.decide(g.req.reqId, 'approved', ap.presence === 'remote+px' ? 'remote' : 'local')) return reject('not_open');
    this.journal.append(a.runId, 'gate.approved', { reqId: g.req.reqId, presence: String(ap.presence) });
    clearTimeout(g.timer);
    a.gate = null;
    g.resolve();
    return { ok: true };
  }

  private answerIr(a: ActiveRun, run: IrRun, ap: Partial<LocalApproval> | null, reject: (code: string) => { ok: boolean; code?: string }): { ok: boolean; code?: string } {
    const req = run.gateReq;
    if (!req) return reject('no_open_gate');
    if (a.stop) return reject('stopped');
    if (!ap || typeof ap !== 'object' || ap.v !== 2) return reject('bad_version');
    if (ap.runId !== a.runId || ap.gateStepId !== req.gateStepId || ap.reqId !== req.reqId) return reject('wrong_gate');
    if (ap.approvalNonce !== req.approvalNonce) return reject('wrong_nonce');
    if (ap.actionHash !== req.actionHash) return reject('wrong_action');
    const now = Date.now();
    if (typeof ap.exp !== 'number' || ap.exp < now || ap.exp > now + LOCAL_APPROVAL_TTL_MS + 5_000) return reject('expired');
    if (now > run.gateDeadline) return reject('gate_expired');
    if (!PRESENCE_OK.has(String(ap.presence)) || (ap.presence === 'click+batch' && req.docType !== 'H-01')) return reject('presence_unsupported');
    if (ap.presence === 'remote+px' && remotePresenceRefusal(req)) return reject('remote_not_allowed');
    if (typeof ap.mac !== 'string' || !ap.mac) return reject('no_mac');
    const r = run.approve(req.reqId, req.actionHash, ap.presence === 'remote+px' ? 'remote' : 'local');
    if (r.ok) this.journal.append(a.runId, 'gate.presence', { reqId: req.reqId, presence: String(ap.presence) });
    return r.ok ? { ok: true } : reject('not_open');
  }

  answerFromRelay(method: string): never {
    this.d.log.event('security.gate_answer_from_relay', { method: method.slice(0, 40).replace(/[^A-Za-z0-9_.:-]/g, '_') });
    if (this.active) this.journal.append(this.active.runId, 'security.gate_answer_from_relay', {});
    throw new RunEnd('failed', 'forbidden_channel');
  }

  stop(runId: string): { stopped: boolean } {
    const a = this.active;
    if (!a || a.runId !== runId) return { stopped: false };
    if (a.ir?.waiting) {
      this.journal.append(a.runId, 'run.stop_in_wait', { armed: a.ir.armed });
      a.stop = !a.ir.armed;
      a.ir.stop();
      return { stopped: !a.ir.armed };
    }
    if (a.armed || a.ir?.armed) throw new RunEnd('failed', 'already_issuing');
    a.stop = true;
    if (a.ir) {
      a.ir.stop();
      return { stopped: true };
    }
    const g = a.gate;
    if (g) {
      if (this.gates.decide(g.req.reqId, 'denied', 'local')) this.journal.append(a.runId, 'gate.denied', { reqId: g.req.reqId });
      this.closeGate(a, 'stopped');
      g.reject(new RunEnd('stopped', 'gate.stopped'));
    }
    return { stopped: true };
  }

  resume(runId: string): { ok: boolean; code?: string } {
    const a = this.active;
    if (!a || a.runId !== runId || !a.ir) return { ok: false, code: 'not_handed_off' };
    const r = a.ir.command('resume');
    if (r.ok) this.journal.append(a.runId, 'run.resume_requested', {});
    return r;
  }

  async simpleAuth(runId: string, op: 'request' | 'complete', d?: SimpleAuthIdentity): Promise<{ ok: boolean; code?: string }> {
    const a = this.active;
    if (!a || a.runId !== runId || !a.ir) return { ok: false, code: 'not_handed_off' };
    const r = await a.ir.simpleAuth(op, d);
    this.journal.append(a.runId, 'run.simple_auth_requested', { op, ok: r.ok });
    return r;
  }

  manualDone(runId: string): { ok: boolean; code?: string } {
    const a = this.active;
    if (!a || a.runId !== runId || !a.ir) return { ok: false, code: 'not_handed_off' };
    const r = a.ir.command('manual');
    if (r.ok) this.journal.append(a.runId, 'run.manual_done_requested', {});
    return r;
  }

  recheckPermit(): void {
    const a = this.active;
    if (!a) return;
    if (a.ir) return void a.ir.recheck();
    if (a.downgraded) return;
    const p = this.d.permit?.(a.playbookId);
    if (p && !p.ok) this.downgradeH01(a, p);
  }

  private downgradeH01(a: ActiveRun, p: Denied): void {
    a.downgraded = p;
    this.d.log.event('run.downgrade', { code: p.code, armed: a.armed });
    if (a.armed) {
      this.journal.append(a.runId, 'run.downgrade_deferred', { code: p.code });
      return;
    }
    this.journal.append(a.runId, 'run.downgraded', { code: p.code });
    if (a.halt) return;
    const end = new RunEnd('handoff', p.code);
    a.halt = end;
    const g = a.gate;
    if (g) {
      if (this.gates.decide(g.req.reqId, 'denied', 'policy')) this.journal.append(a.runId, 'gate.denied', { reqId: g.req.reqId, by: 'policy' });
      this.closeGate(a, 'stopped');
      g.reject(end);
    }
  }

  leakSuspected(): void {
    const a = this.active;
    this.d.log.event('vault.leak_suspected', { active: !!a, armed: !!a?.armed });
    if (!a) return;
    this.journal.append(a.runId, 'vault.leak_suspected', { armed: a.armed || !!a.ir?.armed });
    if (a.ir) return a.ir.halt('vault.leak_suspected');
    if (a.armed || a.halt) return;
    const end = new RunEnd('failed', 'vault.leak_suspected');
    a.halt = end;
    const g = a.gate;
    if (g) {
      if (this.gates.decide(g.req.reqId, 'denied', 'policy')) this.journal.append(a.runId, 'gate.denied', { reqId: g.req.reqId, by: 'policy' });
      this.closeGate(a, 'signal');
      g.reject(end);
    }
  }

  certInputsOf(runId: string): Readonly<Record<string, string>> | null {
    const a = this.active;
    return a && a.runId === runId && a.cert ? { ...a.cert.inputs } : null;
  }

  async reverify(exclude: string | null = null): Promise<ReverifyResult> {
    const none = { checked: 0, committed: 0, unknown: 0, skipped: 0 };
    if (this.active || this.reverifying) return { ok: false, code: 'busy', ...none };
    if (this.engine !== 'ir') return { ok: false, code: 'reverify.unsupported', ...none };
    const page = this.d.currentPage?.() ?? null;
    const profile = this.d.data.profiles.byKind('business');
    if (!page || page.isClosed()) return { ok: false, code: 'reverify.no_browser', ...none };
    if (!profile) return { ok: false, code: 'profile_missing', ...none };
    this.reverifying = true;
    try {
      const ir = this.packageForRun(false);
      const pm = this.d.permit?.(ir.pkg.files.manifest.id);
      if (pm && !pm.ok) {
        this.d.log.event('run.policy_refused', { kind: this.d.portal.kind, code: pm.code });
        return { ok: false, code: pm.code, ...none };
      }
      const startPolicy = this.d.portal.kind === 'hometax' ? (this.d.receivedPolicy?.() ?? null) : null;
      return await reverifyInDoubt({
        page, ir, portal: runPortalConfig(this.d.portal, startPolicy), ledger: this.ledger, journal: this.journal, rate: this.rate,
        signals: this.runSignals(() => false, startPolicy), profileId: profile.id, log: this.d.log, now: this.rate.clock().now, exclude,
        inputsOf: (runId) => this.d.runInputs?.(runId) ?? null,
        counterpartyBizNo: (id) => this.d.data.counterparties.get(id)?.bizNo ?? null,
        bizNoHmac: (bizNo) => this.hmac('bizno', bizNo),
        admit: () => {
          this.rate.pinRun();
          this.rate.admit(profile.id, { irreversible: false });
        },
      });
    } catch (e) {
      if (e instanceof RunEnd) return { ok: false, code: e.code, ...none };
      this.d.log.event('run.reverify_error', { err: (e as Error)?.name ?? 'unknown' });
      return { ok: false, code: 'engine.error', ...none };
    } finally {
      this.rate.unpinRun();
      this.reverifying = false;
    }
  }

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  inspect(runId: string): { ledger: string | null; journal: string[]; policy: PolicyStatus } {
    const row = this.d.db.prepare('SELECT state FROM irreversible_log WHERE run_id = ? ORDER BY armed_at DESC, attempt DESC LIMIT 1').get(runId) as { state: string } | undefined;
    return { ledger: row?.state ?? null, journal: this.journal.types(runId), policy: this.rate.status(this.d.data.profiles.byKind('business')?.id ?? '') };
  }
}

/**
 * IR 실행 입력. 실화면 H-01(hometax.invoice.issue 2.2.0)은 공급받는자 성명·사업장을 직접 넣고(조회로 채워지지 않는다), 이메일은 아이디·도메인 두 칸,
 * 품목 행의 일(日)은 따로 넣는다. 그래서 거래처의 대표자·주소와 이메일 두 조각, 작성일자의 일을 더 준다(값이 없으면 키를 넣지 않는다).
 */
export function irInputs(inputs: RunInputs, cp: { repName?: string | null; address?: string | null } | null | undefined): Record<string, unknown> {
  const counterpart: Record<string, string> = { ...inputs.counterpart };
  if (cp?.repName) counterpart.repName = cp.repName;
  if (cp?.address) counterpart.address = cp.address;
  const at = inputs.email ? inputs.email.lastIndexOf('@') : -1;
  return {
    counterpart, amounts: inputs.amounts, items: inputs.items, issueDate: inputs.issueDate, issueDay: inputs.issueDate.slice(8, 10),
    ...(inputs.email ? { email: inputs.email } : {}),
    ...(inputs.email && at > 0 ? { emailLocal: inputs.email.slice(0, at), emailDomain: inputs.email.slice(at + 1) } : {}),
  };
}

const BIZNO_OK_KEY = 'counterpart.bizNoOk';
const BIZNO_OK_STATUS = '정상';

/** readback 값 → 비어 있으면 채울 프로필(공급자)·거래처 칸. 패키지가 읽지 않은 칸은 빈 값이라 채우지 않는다. */
export function portalFill(rb: ReadonlyMap<string, string>): { profile: Partial<Record<PortalProfileKey, string>>; counterparty: { repName?: string; address?: string } } {
  const g = (k: string) => rb.get(k) ?? '';
  const id = g('supplierEmailId');
  const dom = g('supplierEmailDomain');
  return {
    profile: { displayName: g('supplierName'), repName: g('supplierRepName'), bizType: g('supplierBizType'), bizItem: g('supplierBizItem'), address: g('supplierAddress'), email: g('supplierEmail') || (id && dom ? `${id}@${dom}` : '') },
    counterparty: { repName: g('counterpartRepName'), address: g('counterpartAddress') },
  };
}
