import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { GateRepo, Ledger, LedgerError, RunJournal, RunRepo, type Db, type Profile } from '@sax/db';
import type { EventLog } from '@sax/platform';
import type { Page } from 'playwright-core';
import type { DataService } from './data-service.ts';
import { buildGateRequest, cbor, jcs, LOCAL_APPROVAL_TTL_MS, sha256hex, type GateField, type GatePortMessage, type GateRequest, type LocalApproval, type ReadbackKey } from './gate.ts';
import { businessKey, canonicalEmail, H01, packageDigest, type Phase } from './h01/playbook.ts';
import { portalProblems, type PortalConfig } from './portal.ts';
import { H01Runner, type Readback, type RunInputs } from './h01/runner.ts';
import { RunEnd, type RunStatus } from './run-end.ts';
import { SIGNAL_DICT, type SignalDict } from './signals.ts';
import { kstDay, pocTotalRefusal, policyFor, RateGuard, RunPolicy, runPortalConfig, type Clock, type PolicyStatus, type RatePolicy } from './policy.ts';
import { IrRun, type GateHistory, type IrPackage, type IrSourceResult, type StoppedAt } from './run/service-ir.ts';
import { ratePolicyFrom, runSignalDict } from './enforcer.ts';
import { CERT_CARD, certBusinessKey, certInputs, type CertStartParams } from './cert.ts';
import type { RunPermit } from './core/permit.ts';
import type { Policy } from './core/types.ts';

type Denied = Extract<RunPermit, { ok: false }>;

// 실행·게이트·원장 조율(D03 §2~§5). 게이트 요청은 main↔엔진 전용 포트로만 내보내고, 승인 근거(LocalApproval v2)도
// 그 포트로 온 것만 받는다(ADR-021). Phase 1처럼 엔진은 HMAC 키가 없어 MAC을 검증하지 않고 포트 출처만 믿는다.
// 요청률 정책(D03 §7): 시작 때 쿨다운·하루 상한을 보고, 실행마다 RunPolicy가 지연·상한·차단 신호를 집행한다.

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
  /** portalNotice: 실행이 닫은 마지막 포털 대화상자 문구(≤200자, 텍스트로만 보인다). 실패·핸드오프·모름 종료에만 싣는다(I-6). */
  | { runId: string; type: 'end'; status: RunStatus; code?: string; approvalNo?: string; mailConfirmed?: boolean; portalNotice?: string; stoppedAt?: StoppedAt };

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
  /** 엔진 밖 사유의 정지(금고 누출 의심). 커밋 전에만 건다. */
  halt: RunEnd | null;
  /** 토큰 소비 + armed 기록이 끝났다(커밋 구간). 이 뒤로는 중지를 받지 않는다. */
  armed: boolean;
  gate: PendingGate | null;
  /** 게이트 토큰(D03 §3). 비가역 스텝 진입에서 한 번 소비한다. */
  token: { reqId: string; mac: Buffer; exp: number; used: boolean } | null;
  /** 승인된 게이트의 원장 행 재료(arm에서 쓴다). */
  pendingArm: { req: GateRequest; history: PendingGate['history'] } | null;
  /** 페이지를 받은 뒤(로그인보다 먼저) 만든다. */
  policy: RunPolicy | null;
  /** IR 경로(engine 'ir')의 실행. H01 경로면 null. */
  ir: IrRun | null;
  /** 이 실행이 시작할 때 고른 패키지(engine 'ir'). 실행 중에 설치본이 바뀌어도 이 실행은 이것으로 끝난다. */
  pkg: IrPackage | null;
  /** 허가(permit)를 묻는 플레이북 id(IR은 패키지 manifest id, H01은 H01.id). */
  playbookId: string;
  /** H01 경로의 정지 하향 사유(한 번 정해지면 그대로). IR 경로는 IrRun이 갖는다. */
  downgraded: Denied | null;
  /** 이 실행의 포털 설정: verify 타이밍은 시작 때 받은 정책과 내장 값 가운데 엄격한 쪽(홈택스만). 실행 중에는 바꾸지 않는다(verify는 커밋 구간 안이다). */
  portal: PortalConfig;
  /** 이 실행의 신호 사전(runSignals). */
  signals: SignalDict;
  /** 실행 종류: invoice = H-01(run.start), cert = 홈택스 민원증명(run.startCert, IR 경로만). */
  kind: 'invoice' | 'cert';
  /** 민원증명 실행의 검사한 입력과 업무 키(kind cert일 때만). */
  cert: { inputs: Record<string, string>; businessKey: string } | null;
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
  /** 시험용: 포털 kind의 내장 정책 대신 쓸 값. */
  policy?: RatePolicy;
  /** 시험용: 벽시계·단조 시계. */
  clock?: Clock;
  /**
   * 실행기. 'ir'(기본, PR-D1): 로드한 패키지(ir)를 RunController로 돌린다. 패키지가 없으면 시작이 package.not_loaded다.
   * 'h01': H01Runner(TS 플레이북). 제품 entry는 패키지 공급(레지스트리 게시)과 시연 방식이 정해질 때까지 'h01'을 명시한다(PR-D2에서 뺀다).
   */
  engine?: 'h01' | 'ir';
  /** 고정 패키지(시험·골든 대조). 있으면 irSource보다 먼저 쓴다. */
  ir?: IrPackage;
  /**
   * 실행을 시작할 때마다 부르는 패키지 공급(PR-D2, installedIrSource: 레지스트리에서 받아 둔 설치본을 loadPackage로 다시 검증).
   * 실패면 시작이 package.not_loaded(설치본 없음) 또는 package.load_failed(검증 실패, 로그에 코드)다.
   */
  irSource?: () => IrSourceResult;
  /**
   * 민원증명 실행 시작 패키지 공급(run.startCert, engine 'ir'만): 플레이북 id → 설치본(installedIrSource와 같은 재검증).
   * 제품이 받지 않는 id면 { ok: false, code: 'cert.unknown_doc' }. 없으면 민원증명 시작은 package.not_loaded다.
   */
  certSource?: (playbookId: string) => IrSourceResult;
  /**
   * 실행 허가(D03 §2 Running 진입 확인·정지 하향, §3.1 status 소비, §12 실효 수준, ADR-023 결정 5·6). 시작 전, 스텝 경계마다,
   * recheckPermit(레지스트리 동기화 뒤)에서 부른다. 제품 entry는 레지스트리 status로 계산한다(core runPermit). 없으면 늘 허가(시험).
   */
  permit?: (playbookId: string) => RunPermit;
  /** 마지막 유효 서명 정책(레지스트리 동기화, 클램프 뒤). RateGuard가 내장 값과 필드마다 더 엄격한 쪽만 쓴다(홈택스만). */
  receivedPolicy?: () => Policy | null;
  /** 정지 하향이 postprocess·kill(hardStop)이면 실행이 끝난 뒤 자동화 Chrome을 닫는다(D03 §2 하향 행). */
  closeBrowser?: () => Promise<void>;
  /** 시험용(골든 대조): 스텝 궤적. 값 없이 스텝 id·타입·코드만. H01은 step.started만 낸다. */
  trace?: (runId: string, e: { name: string; stepId: string; type: string; code?: string }) => void;
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
  private readonly rate: RateGuard;
  private readonly deviceId: string;
  private active: ActiveRun | null = null;

  /** 실행기(기본 'ir', RunServiceDeps.engine). */
  private readonly engine: 'h01' | 'ir';

  constructor(d: RunServiceDeps) {
    super();
    this.d = d;
    this.engine = d.engine ?? 'ir';
    this.runs = new RunRepo(d.db);
    this.gates = new GateRepo(d.db);
    this.ledger = new Ledger(d.db);
    this.journal = new RunJournal(d.db);
    // 받은 서명 정책은 홈택스 interactive 값으로 바꿔 RateGuard에 준다(그 포털 limits가 없으면 null = 내장 값만).
    const received = d.receivedPolicy;
    this.rate = new RateGuard(d.db, d.portal.kind, d.policy ?? policyFor(d.portal.kind), d.clock, received ? () => {
      const p = received();
      return p ? ratePolicyFrom(p, 'hometax', 'interactive') : null;
    } : undefined);
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

  /** cert는 민원증명 원장 행의 신청 사업자 HMAC이다. 도메인이 달라 H-01 거래처 첫 발급($first.bizNo) 셈에 섞이지 않는다. */
  private hmac(kind: 'bizno' | 'email' | 'cert', v: string): string {
    return createHmac('sha256', this.d.ledgerKey).update(`SAX-ledger-${kind}\0${v}`).digest('hex');
  }

  private ev(e: RunEvent): void {
    this.emit('event', e);
  }

  /** [홈택스에서 준비]. 실행은 한 번에 하나다. 검증에 실패하면 브라우저를 열기 전에 던진다. */
  start(p: StartParams): { runId: string; intentId: string } {
    if (this.active) throw new RunEnd('failed', 'busy');
    // H01Runner는 포털 설정의 셀렉터·화면 경로·조회 표를 쓴다. IR 실행은 셀렉터·화면을 서명 패키지에서 받으므로 verify 하한만 본다.
    const problems = this.engine === 'ir' ? portalProblems(this.d.portal).filter((x) => x === 'verify_below_floor') : portalProblems(this.d.portal);
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
    const inputs: RunInputs = {
      counterpart: { id: cp.id, bizNo: cp.bizNo, name: cp.name },
      amounts: { supply: String(supply), tax: String(tax), total: String(supply + tax) },
      items: [{ name: itemName }],
      // 작성일자는 KST 날짜다(OS 시간대와 무관, 요청률 정책의 유효 시각). s19e가 화면 값과 대조한다.
      issueDate: kstDay(this.rate.clock().now),
      email,
    };
    const intentId = ulid();
    const inputsHash = sha256hex(jcs(inputs));
    const irPkg = this.engine === 'ir' ? this.packageForRun() : undefined;
    const playbookId = irPkg?.pkg.files.manifest.id ?? H01.id;
    const playbookVersion = irPkg?.pkg.files.manifest.version ?? H01.version;
    const digest = irPkg ? irPkg.pkg.manifestDigest : packageDigest(this.d.portal, profile.updatedAt);
    const a = this.launch({ runId: p.runId, intentId, inputsHash, irPkg, playbookId, playbookVersion, digest, profile, kind: 'invoice', cert: null });
    void this.execute(a, inputs, profile);
    return { runId: p.runId, intentId };
  }

  /**
   * 민원증명(H-03·H-04·H-08·H-09) 실행 시작(run.startCert). engine 'ir'에서만 돈다. 검사에 실패하면 브라우저를 열기 전에 던진다.
   * 입력은 그 서명 패키지의 playbook.inputs 선언으로 검사한다(cert.ts certInputs). 사업자번호나 발급 인증이 없으면 profile_missing이다.
   * 거절 코드는 데스크톱 멈춤 문구 표(shell-runs NOTE)에 있는 것을 쓴다: 받을 수 없는 서류·실행 방식은 package.not_loaded(이 서류의 작업 정보가 없다).
   * 그 뒤(허가·원장 의도·요청률·게이트·원장 행)는 H-01과 같은 길이다. 승인 카드는 cert.confirm(docType cert)이다.
   */
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
    const irPkg = this.certPackageFor(p.playbookId);
    const files = irPkg.pkg.files;
    // 민원증명 승인 카드가 있는 플레이북만(H-01 등 다른 패키지를 이 길로 돌리지 않는다).
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
      kind: 'cert', cert: { inputs, businessKey },
    });
    void this.execute(a, null, profile);
    return { runId: p.runId, intentId };
  }

  /** run.start·run.startCert 공통 뒷부분: 서버 긴급 정지 → 원장 의도 → 요청률 → 실행 행·저널 → ActiveRun. 던지면 아무 실행도 없다. */
  private launch(o: {
    runId: string; intentId: string; inputsHash: string; irPkg: IrPackage | undefined; playbookId: string; playbookVersion: string; digest: string; profile: Profile;
    kind: ActiveRun['kind']; cert: ActiveRun['cert'];
  }): ActiveRun {
    const { runId, intentId, inputsHash, irPkg, playbookId, playbookVersion, digest, profile } = o;
    // 서버 긴급 정지(status kill·상한): 브라우저를 열기 전, 요청률 카운터를 쓰기 전에 거부한다.
    const pm = this.d.permit?.(playbookId);
    if (pm && !pm.ok) {
      this.d.log.event('run.policy_refused', { kind: this.d.portal.kind, code: pm.code });
      throw new RunEnd('failed', pm.code);
    }
    const check = this.ledger.checkIntent(intentId, 's21', playbookId, inputsHash);
    if (check.kind !== 'new') throw new RunEnd('failed', 'ledger.intent_not_new');
    // 쿨다운·하루 실행 수·하루 발급 여유(H-01·민원증명은 비가역). 통과하면 증가를 커밋한 뒤 실행을 만든다.
    try {
      const total = pocTotalRefusal(this.ledger, this.d.portal.kind);
      if (total) throw total;
      this.rate.pinRun();
      this.rate.admit(profile.id, { irreversible: true });
    } catch (e) {
      if (e instanceof RunEnd) this.d.log.event('run.policy_refused', { kind: this.d.portal.kind, code: e.code });
      throw e;
    }
    this.runs.create({ id: runId, playbookId, playbookVersion, packageDigest: digest, profileId: profile.id, trigger: 'local', inputsHash });
    this.journal.append(runId, 'run.started', { intentId, portal: this.d.portal.kind, conservative: this.rate.clock().conservative });
    // 차단·추가 인증·캡차 사전이 빈 포털: 시작은 막지 않고(공개 근거가 없다) 남긴다. 모르는 화면 누적이 대신 멈춘다.
    const gaps = (['block', 'extra_auth', 'captcha'] as const).filter((k) => !SIGNAL_DICT[this.d.portal.kind].some((e) => e.kind === k));
    if (gaps.length) {
      this.journal.append(runId, 'run.signal_dict_empty', { kinds: gaps.join(',') });
      this.d.log.event('run.signal_dict_empty', { kind: this.d.portal.kind, kinds: gaps.join(',') });
    }
    // 받은 서명 정책은 홈택스에만 쓴다(fixture는 내장 시험 값). 이 값이 실행 시작 때의 정책이다(RateGuard.pinRun과 같은 때).
    const startPolicy = this.d.portal.kind === 'hometax' ? (this.d.receivedPolicy?.() ?? null) : null;
    const portal = runPortalConfig(this.d.portal, startPolicy);
    this.active = {
      runId, intentId, inputsHash, packageDigest: digest, stop: false, halt: null, armed: false, gate: null, token: null, pendingArm: null, policy: null, ir: null, pkg: irPkg ?? null, playbookId, downgraded: null,
      portal, signals: this.runSignals(runId, startPolicy), kind: o.kind, cert: o.cert,
    };
    return this.active;
  }

  /** inputs: H-01 입력(kind invoice). 민원증명(kind cert)은 null이고 입력은 a.cert에 있다. */
  private async execute(a: ActiveRun, inputs: RunInputs | null, profile: Profile): Promise<void> {
    let result: { status: RunStatus; code?: string; approvalNo?: string; mailConfirmed?: boolean; stoppedAt?: StoppedAt };
    let thrown: unknown;
    try {
      this.ev({ runId: a.runId, type: 'phase', phase: 'login', state: 'now' });
      // 요청률 정책·차단 신호 감시는 로그인보다 먼저 붙인다(로그인 구간이 캡차·추가 인증·대기열이 잘 뜨는 곳이다).
      const page = await this.d.page();
      if (this.engine !== 'ir') a.policy = new RunPolicy(page, this.rate, a.portal, {
        profileId: profile.id,
        signals: a.signals,
        checkStop: () => this.checkStop(a),
        journal: (type, payload) => this.journal.append(a.runId, type, payload),
        onLatch: (end) => this.latched(a, end),
      });
      // 로그인: 가짜 페이지는 세션이 있다고 본다. 홈택스 로그인(s0~s6)은 PoC-3 뒤(RateGuard.beforeLogin·loginSucceeded·continueSession을 부른다).
      // H01Runner에는 홈택스 로그인이 없다. IR 패키지(H-01 s0~s6)는 로그인 스텝을 스스로 돈다.
      if (this.d.portal.login && this.engine !== 'ir') throw new RunEnd('failed', 'login.not_implemented');
      this.ev({ runId: a.runId, type: 'phase', phase: 'login', state: 'done', code: 'login.session_assumed' });
      if (this.engine === 'ir') {
        a.policy = null;
        result = await this.executeIr(a, page, inputs, profile);
      } else result = await new H01Runner(page, a.portal, inputs!, { bizNo: profile.bizNo! }, this.hooks(a), a.policy!).run();
    } catch (e) {
      thrown = e;
      result = { status: 'failed', code: 'engine.error' };
    }
    // 진행 중인 화면 확인을 마친 뒤 사유를 정한다(그 사이 걸린 신호도 이 실행의 것이다).
    await a.policy?.finish({ userStopped: a.stop }).catch(() => {});
    const latched = a.policy?.latched ?? null;
    if (thrown !== undefined) {
      // 신호가 걸렸으면 그 뒤에 난 오류(바뀐 화면에서 요소를 못 찾음 등)보다 신호가 사유다.
      const end = latched ?? (thrown instanceof RunEnd ? thrown : null);
      result = end ? { status: end.status, code: end.code } : { status: 'failed', code: 'engine.error' };
      if (!end) this.d.log.event('run.error', { runId: a.runId, err: (thrown as Error)?.name ?? 'unknown' });
    } else if (latched?.status === 'failed') {
      // 정상으로 끝났어도 그 사이 차단 신호가 걸렸으면 숨기지 않는다(확정 여부는 아래 원장 판정이 정한다).
      result = { ...result, status: 'failed', code: latched.code };
    }
    if (latched) this.d.log.event('run.signal', { runId: a.runId, code: latched.code });
    // 커밋 구간에서 종결되지 않고 빠져나왔으면 in_doubt(중복 위험을 숨기지 않는다).
    const row = this.ledger.get(a.intentId, 's21');
    if (row && (row.state === 'armed' || row.state === 'dispatched')) {
      this.ledger.resolve(a.intentId, 's21', 'in_doubt');
      result = { status: 'in_doubt', code: result.code ?? 'engine.error' };
    } else if (row?.state === 'in_doubt') result = { ...result, status: 'in_doubt' };
    // 발급이 확정된 뒤의 오류는 실패가 아니다. 다시 실행하면 중복이므로 "완료(확인할 것 있음)"로 알린다.
    else if (row?.state === 'committed' && result.status !== 'success' && result.status !== 'completed_with_issues') {
      // 확정 뒤 차단 신호는 숨기지 않는다(다음 발급을 이어가기 전에 알아야 한다). 메일 확인 결과는 그대로 둔다.
      const code = latched?.status === 'failed' ? 'portal.blocked_after_commit' : 'post_commit.error';
      result = { ...result, status: 'completed_with_issues', code, approvalNo: row.verifyRef ?? result.approvalNo };
    }
    // 정지 하향이 postprocess·kill이면 그 포털의 자동화 Chrome을 닫는다(무장 뒤 미룬 H01 하향도 실행이 끝났으니 닫는다).
    if ((a.downgraded ?? a.ir?.downgraded)?.hardStop) await this.d.closeBrowser?.().catch(() => {});
    this.closeGate(a, 'run_ended');
    // 승인됐지만 armed까지 가지 못한 게이트(스텝 지연 중 신호, armed 트랜잭션 거부 등)는 거부로 되돌린다.
    if (a.token && !a.armed && this.gates.withdraw(a.token.reqId, 'run_ended')) this.journal.append(a.runId, 'gate.withdrawn', { reqId: a.token.reqId });
    this.rate.unpinRun();
    this.runs.finish(a.runId, result.status);
    this.journal.append(a.runId, 'run.ended', { status: result.status, code: result.code ?? '', ...(result.stoppedAt ? { stepId: result.stoppedAt.stepId, stepType: result.stoppedAt.type, ...(result.stoppedAt.target ? { target: result.stoppedAt.target } : {}) } : {}) });
    // 실기기 디버깅(팀장 지시 2026-11-09): 어느 스텝·셀렉터에서 멈췄는지 엔진 로그 한 줄로 바로 보인다(스텝 id·셀렉터 키·코드만, ⑦).
    if (result.stoppedAt) this.d.log.event('run.stopped_at', { runId: a.runId, status: result.status, code: result.code ?? '', stepId: result.stoppedAt.stepId, stepType: result.stoppedAt.type, target: result.stoppedAt.target ?? '', playbook: a.playbookId });
    if (inputs && (result.status === 'success' || result.status === 'completed_with_issues')) this.d.data.counterparties.markUsed(inputs.counterpart.id);
    this.active = null;
    // 포털이 한 말은 실패·핸드오프·모름에만 보인다. 저널·로그에는 쓰지 않는다(메모리 → 종료 이벤트만).
    const notice = a.policy?.notice ?? a.ir?.notice;
    const showNotice = notice && (result.status === 'failed' || result.status === 'handoff' || result.status === 'in_doubt');
    this.ev({ runId: a.runId, type: 'end', ...result, ...(showNotice ? { portalNotice: notice } : {}) });
  }

  /** 이 실행의 차단 신호 사전(runSignalDict). 받은 정책은 홈택스만 쓴다. 커밋 구간 = 이 실행의 원장 행이 armed·dispatched. */
  private runSignals(runId: string, startPolicy: Policy | null): SignalDict {
    const builtIn = SIGNAL_DICT[this.d.portal.kind];
    const received = this.d.receivedPolicy;
    if (this.d.portal.kind !== 'hometax' || !received) return builtIn;
    return runSignalDict({
      builtIn, atStart: startPolicy?.cooldown.blockSignalsAdd, current: () => received()?.cooldown.blockSignalsAdd,
      inCommit: () => this.ledger.statesByRun(runId).some((st) => st === 'armed' || st === 'dispatched'),
      onDropped: (where) => this.d.log.event('policy.block_signal_dropped', { where }),
    });
  }

  /** engine 'ir'의 시작 패키지: 고정 패키지(ir) → 공급(irSource). 없거나 검증에 실패하면 브라우저를 열기 전에 던진다. */
  private packageForRun(): IrPackage {
    if (this.d.ir) return this.d.ir;
    const r = this.d.irSource?.() ?? { ok: false as const, code: 'package.not_loaded' };
    if (r.ok) return r.ir;
    if (r.code === 'package.not_loaded') throw new RunEnd('failed', 'package.not_loaded');
    this.d.log.event('run.package_refused', { code: r.code });
    throw new RunEnd('failed', 'package.load_failed');
  }

  /** IR 경로(engine 'ir'): 같은 게이트 예약 키·원장 행 재료·저널로 RunController를 돌린다. */
  private async executeIr(a: ActiveRun, page: Page, inputs: RunInputs | null, profile: Profile): Promise<{ status: RunStatus; code?: string; approvalNo?: string; mailConfirmed?: boolean; stoppedAt?: StoppedAt }> {
    const ir = a.pkg!;
    const playbookId = ir.pkg.files.manifest.id;
    const run = new IrRun({
      runId: a.runId, intentId: a.intentId, packageDigest: a.packageDigest, page, ir, portal: a.portal, signals: a.signals, rate: this.rate,
      profile: { id: profile.id, bizNo: profile.bizNo!, signMethod: profile.signMethod ?? null },
      ...(this.d.permit ? { permit: () => this.d.permit!(playbookId) } : {}),
      kind: a.kind,
      inputs: inputs ? { counterpart: inputs.counterpart, amounts: inputs.amounts, items: inputs.items, issueDate: inputs.issueDate, ...(inputs.email ? { email: inputs.email } : {}) } : { ...a.cert!.inputs },
      db: this.d.db, ledger: this.ledger, gates: this.gates,
      history: (rb, card) => {
        // 원장 행 재료는 실행 종류의 카드만 만든다: run.start = 세금계산서(invoice.confirm), run.startCert = 민원증명(cert.confirm).
        // 실행 종류와 다른 카드는 게이트를 열지 않는다(gate.unavailable).
        if (a.kind === 'cert') return card === CERT_CARD ? this.certHistory(a, profile, playbookId) : null;
        if (card !== 'invoice.confirm') return null;
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
          }),
        };
      },
      journal: (type, payload) => {
        this.journal.append(a.runId, type, payload);
        // 실기기 디버깅: 조회 패키지가 멈춘 스텝·셀렉터 키도 엔진 로그 한 줄로(스텝 id·셀렉터 키·코드만, ⑦).
        if (type === 'lookup.step_failed' && payload) this.d.log.event('run.lookup_failed', { runId: a.runId, ...payload });
      },
      phase: (phase, state, code) => this.ev({ runId: a.runId, type: 'phase', phase: phase as Phase, state, ...(code ? { code } : {}) }),
      postGate: (m) => this.d.postGate(m),
      waiting: (reqId) => this.ev({ runId: a.runId, type: 'waiting', reqId }),
      ...(this.d.gateWaitMs !== undefined ? { gateWaitMs: this.d.gateWaitMs } : {}),
      ...(this.d.trace ? { trace: (e) => this.d.trace!(a.runId, e) } : {}),
    });
    a.ir = run;
    const r = await run.run();
    a.armed = run.armed;
    return { status: r.status, ...(r.code ? { code: r.code } : {}), ...(r.approvalNo ? { approvalNo: r.approvalNo } : {}), ...(r.mailConfirmed !== undefined ? { mailConfirmed: r.mailConfirmed } : {}), ...(r.stoppedAt ? { stoppedAt: r.stoppedAt } : {}) };
  }

  /**
   * 민원증명 게이트의 예약 키·원장 행 재료. 업무 키는 시작 때 만든 것(서류·입력·KST 날짜·사업자)이다.
   * 거래처가 없으므로 $first.*는 내지 않는다(cert 카드 필수 예약 키 없음). 같은 업무 키의 앞선 시도가 있으면 $dup.businessKey·$dup.priorNotCommitted로 카드가 알린다.
   */
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
        packageDigest: a.packageDigest, actionHash: x.actionHash, deviceId: this.deviceId, cpBizNoHmac, recipientEmailHmac: null,
      }),
    };
  }

  /** 민원증명 시작 패키지: 고정 패키지(ir, 시험) → 공급(certSource). 없거나 검증에 실패하면 브라우저를 열기 전에 던진다. */
  private certPackageFor(playbookId: string): IrPackage {
    if (this.d.ir && this.d.ir.pkg.files.manifest.id === playbookId) return this.d.ir;
    const r = this.d.certSource?.(playbookId) ?? { ok: false as const, code: 'package.not_loaded' };
    if (r.ok) return r.ir;
    // 제품이 받지 않는 서류 id(cert.unknown_doc)도 사람에게는 "이 서류의 작업 정보가 없다"와 같다. 로그에는 코드를 남긴다.
    if (r.code === 'cert.unknown_doc') this.d.log.event('run.cert_unknown_doc', { playbook: playbookId });
    if (r.code === 'package.not_loaded' || r.code === 'cert.unknown_doc') throw new RunEnd('failed', 'package.not_loaded');
    this.d.log.event('run.package_refused', { code: r.code, playbook: playbookId });
    throw new RunEnd('failed', 'package.load_failed');
  }

  /** [중지]·엔진 밖 정지 사유가 있으면 던진다(커밋 구간 밖에서만 부른다). */
  private checkStop(a: ActiveRun): void {
    // 스텝 경계: 동기화 알림이 없어도 status가 바뀌었으면 여기서 멈춘다(D03 §2 하향 행 "다음 스텝 경계에서").
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

  /** 게이트 요청(D03 §3): fields = readback 13칸 + 예약 키. 승인되면 토큰 발급 → 소비 + armed(한 트랜잭션). */
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
    this.d.postGate({ t: 'gate.request', req });
    this.ev({ runId: a.runId, type: 'waiting', reqId: req.reqId });
    await decided;
    // 거부 우선 창: 승인 뒤 2초 안에 온 [중지]·차단 신호가 이긴다. 그 뒤에 토큰을 발급한다(D03 §2·§3).
    const until = Date.now() + DENY_PRIORITY_MS;
    while (Date.now() < until && !a.stop && !a.halt && !a.policy?.latched) await new Promise((r) => setTimeout(r, 50));
    const halt = a.policy?.latched ?? a.halt ?? (a.stop ? new RunEnd('stopped', 'gate.stopped') : null);
    if (halt) {
      if (this.gates.withdraw(req.reqId, a.stop ? 'local' : 'policy')) this.journal.append(a.runId, 'gate.withdrawn', { reqId: req.reqId });
      this.closeGate(a, a.stop ? 'stopped' : 'signal');
      throw halt;
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
    if (a.stop || a.halt) {
      if (t && this.gates.withdraw(t.reqId, a.stop ? 'local' : 'policy')) this.journal.append(a.runId, 'gate.withdrawn', { reqId: t.reqId });
      throw a.halt ?? new RunEnd('stopped', 'gate.stopped');
    }
    if (!t || !p || t.used || Date.now() > t.exp) throw new RunEnd('failed', 'token.invalid');
    t.used = true;
    t.mac.fill(0);
    try {
      // 하루 비가역 수·네비게이션 수 증가도 armed와 같은 트랜잭션이다(증가 커밋 → 클릭, D03 §7).
      this.d.db.transaction(() => {
        a.policy!.commit();
        this.ledger.consumeAndArm(p.req.reqId, {
          intentId: a.intentId, stepId: 's21', runId: a.runId, businessKey: p.history.businessKey, playbookId: H01.id, inputsHash: a.inputsHash,
          packageDigest: a.packageDigest, actionHash: p.req.actionHash, deviceId: this.deviceId, cpBizNoHmac: p.history.cpBizNoHmac, recipientEmailHmac: p.history.recipientEmailHmac,
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

  /** 차단 신호·추가 인증·캡차·대기열이 걸쇠에 걸렸다. 승인 대기 중이면 게이트를 닫는다(바뀐 화면을 승인하지 못하게). */
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
    if (!PRESENCE_OK.has(String(ap.presence))) return reject('presence_unsupported');
    if (typeof ap.mac !== 'string' || !ap.mac) return reject('no_mac');
    if (!this.gates.decide(g.req.reqId, 'approved', 'local')) return reject('not_open');
    this.journal.append(a.runId, 'gate.approved', { reqId: g.req.reqId, presence: String(ap.presence) });
    clearTimeout(g.timer);
    a.gate = null;
    g.resolve();
    return { ok: true };
  }

  /** IR 경로의 승인 근거: H01과 같은 대조 뒤 조율기에 승인을 넘긴다(게이트 행 결정·저널은 조율기가 한다). */
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
    if (!PRESENCE_OK.has(String(ap.presence))) return reject('presence_unsupported');
    if (typeof ap.mac !== 'string' || !ap.mac) return reject('no_mac');
    const r = run.approve(req.reqId, req.actionHash);
    return r.ok ? { ok: true } : reject('not_open');
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

  /**
   * 레지스트리 동기화 뒤(entry가 부른다): 진행 중 실행의 허가를 다시 본다. 없어졌으면 정지 하향(D03 §2 하향 행, §7.1 조회와 적용).
   * IR: 조율기 downgrade(승인 대기면 게이트를 닫고, 커밋 구간이면 verify 뒤 정지 분기). H01: 무장 전이면 멈추고, 무장 뒤면 기록만 한다.
   */
  recheckPermit(): void {
    const a = this.active;
    if (!a) return;
    if (a.ir) return void a.ir.recheck();
    if (a.downgraded) return;
    const p = this.d.permit?.(a.playbookId);
    if (p && !p.ok) this.downgradeH01(a, p);
  }

  /**
   * H01 경로의 정지 하향. 무장 전: 누출 의심과 같은 길(a.halt)로 다음 스텝 경계·게이트·무장 확인에서 멈춘다(handoff, 사유 코드).
   * 무장 뒤(커밋 구간): 새 값을 적용하지 않는다(D03 §7.1). H01은 verify 뒤 사후 스텝(메일 확인, 조회만)까지 끝낸다(PR-D2에서 H01이 빠진다).
   */
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

  /**
   * 금고가 알려진 값 치환 적중을 알렸다(secret_window.leak_suspected, I-3). 무장 전이면 발급하지 않고 멈춘다(게이트가 열려 있으면
   * 닫는다). 무장 뒤면 기록만 하고 verify를 계속한다(끊으면 발급됐는지 모름만 생긴다).
   */
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

  get activeRunId(): string | null {
    return this.active?.runId ?? null;
  }

  /** 시험용 읽기(값 없음): 원장 상태(마지막 시도), 저널 종류, 요청률 정책 상태(횟수·쿨다운). */
  inspect(runId: string): { ledger: string | null; journal: string[]; policy: PolicyStatus } {
    const row = this.d.db.prepare('SELECT state FROM irreversible_log WHERE run_id = ? ORDER BY armed_at DESC, attempt DESC LIMIT 1').get(runId) as { state: string } | undefined;
    return { ledger: row?.state ?? null, journal: this.journal.types(runId), policy: this.rate.status(this.d.data.profiles.byKind('business')?.id ?? '') };
  }
}
