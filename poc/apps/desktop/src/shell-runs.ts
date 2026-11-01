import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { GateRequest } from '@sax/engine/gate';
import { dupMayBeIssued } from './approval-gate.ts';
import type { EngineHost } from './engine-host.ts';
import { dayOffset, hm, parseAmount, split, type Counterparty, type Doc, type Drafts, type RunView, type StepState, type VatMode } from './shell-mock.ts';

// 셸의 발급 실행(PoC-6). 초안은 main이 만들고(요청 해석은 아직 정규식 목업), [홈택스에서 준비]부터는 엔진이 H-01 플레이북을 돈다.
// 실행 단계·승인 대기·발급 확정·승인번호는 엔진 이벤트에서 온다. 게이트 요청은 게이트 포트로 와서 승인 바가 받는다(shell-app).

const STEPS = ['홈택스 로그인', '건별발급 화면', '입력', '되읽기', '승인', '전자서명', '발급목록 확인', '메일 전송 확인'];
const PHASES = ['login', 'form', 'input', 'readback', 'gate', 'sign', 'verify', 'mail'] as const;
type Phase = (typeof PHASES)[number];

type EngineEvent =
  | { runId: string; type: 'phase'; phase: Phase; state: 'now' | 'done' | 'attention'; code?: string }
  | { runId: string; type: 'waiting'; reqId: string }
  | { runId: string; type: 'end'; status: string; code?: string; approvalNo?: string; mailConfirmed?: boolean };

/** 엔진 결과 코드 → 사용자 문구. 값은 넣지 않는다. */
const NOTE: Record<string, string> = {
  'login.session_assumed': '가짜 페이지라 로그인을 건너뛰었어요',
  'run.stopped': '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'gate.stopped': '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'gate.expired': '승인을 기다리다 시간이 지나 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'assert.supplier_mismatch': '홈택스에 로그인한 사업자가 이 프로필과 달라서 멈췄어요. 아무것도 발급하지 않았어요.',
  'assert.fields_missing': '홈택스 화면에 비어 있는 칸이 있어 멈췄어요. 아무것도 발급하지 않았어요.',
  pre_dispatch_mismatch: '승인한 뒤 홈택스 화면 값이 바뀌어 발급 버튼을 누르지 않았어요. 아무것도 발급하지 않았어요.',
  'step.identity_mismatch': '홈택스 화면이 예상과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  'step.readback_mismatch': '홈택스 화면 값을 확실히 읽지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'verify.baseline_missing': '홈택스 발급목록을 미리 확인하지 못해 승인을 열지 않았어요.',
  'verify.not_committed': "직전 시도는 '발급 안 됨'으로 판정되었어요. 홈택스 발급목록을 직접 확인한 뒤 다시 준비해 주세요.",
  'verify.unknown': '발급 요청은 보냈지만 발급목록에서 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  in_doubt: '발급 단계에서 멈춰 발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  'mail.not_confirmed': '발급은 완료되었어요. 메일 발송은 홈택스 메일발송목록에서 확인해 주세요.',
  selector_placeholder: '홈택스 화면 정보(셀렉터)가 아직 확정되지 않아 시작하지 않았어요.',
  'answer.rejected': '승인을 엔진에 전달하지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'bar.load_failed': '승인 바를 띄우지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'post_commit.error': '발급은 확정됐지만 그 뒤 단계에서 오류가 났어요. 다시 실행하지 말고 홈택스 발급목록에서 확인해 주세요.',
  'engine.exit_before_approval': '엔진이 멈춰 승인 전에 끝났어요. 홈택스에는 아무것도 발급되지 않았어요. 앱을 다시 시작해 주세요.',
  'engine.exit': '엔진이 발급 도중에 멈춰 발급됐는지 모릅니다. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
};
/** in_doubt(발급됐는지 모름)는 코드와 관계없이 중복 위험을 알린다. 코드별 문구는 이 목록만. */
const IN_DOUBT_NOTE = new Set(['verify.unknown', 'engine.exit']);
const note = (code?: string) => (code && NOTE[code]) || (code ? `멈췄어요(${code}).` : '멈췄어요.');

/** 승인 대기 카드에 붙는 중복 경고(D02 §7 고정 문구). 해당하는 것을 모두 둔다. 바에는 가장 위험한 하나가 표시된다. */
function dupWarnings(req: GateRequest): string[] {
  const f = new Map<string, string>(req.fields.map((x) => [x.fieldKey, x.value]));
  const out: string[] = [];
  if (dupMayBeIssued(f)) out.push('같은 거래처·금액·날짜·품목으로 발급했거나 발급 여부를 모르는 기록이 있어요. 같은 건을 두 번 발급하는 것이 아닌지 확인해 주세요.');
  if (f.get('$dup.priorNotCommitted') === 'true') out.push("직전 시도는 '발급 안 됨'으로 판정되었습니다. 홈택스 발급목록을 직접 확인한 뒤 승인하세요.");
  if (!out.length && f.has('$dup.businessKey')) out.push('같은 거래처·금액·날짜·품목의 기록이 있어요. 같은 건을 두 번 발급하는 것이 아닌지 확인해 주세요.');
  return out;
}

export type RunHost = Pick<EngineHost, 'on' | 'control' | 'rpc'>;

export interface ShellRunsSource {
  counterparties(): Counterparty[];
  auth(): string;
}

/** 이벤트: 'update'(RunView) · 'gate'(runId, GateRequest) · 'gate-closed'(runId, reqId, reason) · 'doc'(Doc). */
export class ShellRuns extends EventEmitter implements Drafts {
  private readonly runs = new Map<string, RunView>();
  /** main이 게이트를 닫은 이유(엔진 종료 코드 대신 보일 문구). 렌더러로 보내지 않는다. */
  private readonly endCodes = new Map<string, string>();
  /** run.start 전후로 [중지]가 온 실행. 시작 중에는 엔진에 실행이 없어 run.stop이 아무것도 멈추지 못한다. */
  private readonly starting = new Set<string>();
  private readonly stopEarly = new Set<string>();
  private readonly host: RunHost;
  private readonly src: ShellRunsSource;
  /** 앱이 되물은 것(입력 보완). 대화(세션)마다 하나. */
  readonly pending: { cp: Counterparty | null; asked: 'amount' | 'counterparty' | null; amount: number | null } = { cp: null, asked: null, amount: null };

  constructor(host: RunHost, src: ShellRunsSource) {
    super();
    this.host = host;
    this.src = src;
    host.on('run', (e: EngineEvent) => this.onEngine(e));
    host.on('gate', (req: GateRequest) => this.onGate(req));
    host.on('gate-closed', (e: { runId: string; reqId: string; reason: string }) => this.emit('gate-closed', e.runId, e.reqId, e.reason));
    host.on('exit', (who: string) => {
      if (who === 'engine') this.engineGone();
    });
  }

  /**
   * 엔진이 끝났다. 진행 중인 실행을 끝낸다. 승인을 보냈거나 발급 중이었으면 발급됐는지 모른다(in_doubt, 중복 위험 문구).
   * 원장 행은 다음 기동 때 엔진이 in_doubt로 올린다(D03 §4).
   */
  private engineGone(): void {
    for (const r of this.runs.values()) {
      if (!['preparing', 'turn', 'waiting', 'issuing'].includes(r.status)) continue;
      const unsure = r.status === 'issuing' || r.approvedPending === true;
      this.end(r, unsure ? { status: 'in_doubt', code: 'engine.exit' } : { status: 'failed', code: 'engine.exit_before_approval' });
    }
  }

  get counterparties(): Counterparty[] {
    return this.src.counterparties();
  }

  get(id: string): RunView | undefined {
    return this.runs.get(id);
  }

  createDraft(cp: Counterparty, amount: number, vat: VatMode | null): RunView {
    const s = split(amount, vat ?? 'separate');
    const run: RunView = {
      id: `run-${randomUUID().slice(0, 8)}`,
      doc: 'H-01',
      status: 'draft',
      createdAt: hm(),
      // 처음 거래·처음 보내는 주소는 게이트 때 엔진이 원장으로 판정한다(초안에서는 모름).
      counterparty: { id: cp.id, name: cp.name, bizNo: cp.bizNo, first: false },
      email: { value: cp.email, first: false },
      amount,
      vat: vat ?? 'separate',
      vatGuessed: vat === null,
      ...s,
      item: cp.item,
      writeDate: dayOffset(0),
      auth: this.src.auth(),
      steps: STEPS.map((label) => ({ label, state: 'todo' as StepState })),
      turn: null,
      confirmed: false,
      result: null,
      warnings: [],
    };
    this.runs.set(run.id, run);
    return run;
  }

  updateDraft(id: string, patch: { vat?: VatMode; amount?: number; amountText?: string }): RunView {
    if (patch.amountText !== undefined) {
      const t = patch.amountText.trim();
      const v = parseAmount(/^[\d,]+$/.test(t) ? `${t}원` : t);
      if (v === null) throw new Error('bad_amount');
      patch = { ...patch, amount: v };
    }
    const r = this.mustDraft(id);
    if (patch.vat) {
      r.vat = patch.vat;
      r.vatGuessed = false;
    }
    if (patch.amount !== undefined) {
      if (!Number.isInteger(patch.amount) || patch.amount <= 0 || patch.amount > 1e12) throw new Error('bad_amount');
      r.amount = patch.amount;
    }
    Object.assign(r, split(r.amount, r.vat));
    this.emit('update', r);
    return r;
  }

  private mustDraft(id: string): RunView {
    const r = this.runs.get(id);
    if (!r || r.status !== 'draft') throw new Error('not_draft');
    return r;
  }

  private busy(): boolean {
    return [...this.runs.values()].some((x) => ['preparing', 'turn', 'waiting', 'issuing'].includes(x.status));
  }

  /** [홈택스에서 준비]: 엔진 run.start. 실행은 한 번에 하나다(08 §5). 엔진이 시작 전에 거부하면 확인 필요로 둔다. */
  async prepare(id: string): Promise<RunView> {
    const r = this.mustDraft(id);
    if (this.busy()) throw new Error('busy');
    r.status = 'preparing';
    this.step(r, 'login', 'now');
    this.emit('update', r);
    this.starting.add(r.id);
    try {
      await this.host.control('run.begin', { runId: r.id, trigger: 'local' });
      if (this.stopEarly.has(r.id)) {
        this.end(r, { status: 'stopped', code: 'run.stopped' });
        return r;
      }
      await this.host.rpc('run.start', { runId: r.id, counterpartyId: r.counterparty.id, supply: r.supply, tax: r.tax, itemName: r.item, email: r.email.value || null });
      // 시작하는 동안 온 [중지]를 이제 엔진에 전한다(엔진은 다음 정지 확인에서 멈춘다. 게이트 전이다).
      if (this.stopEarly.has(r.id)) await this.host.rpc('run.stop', { runId: r.id }).catch(() => {});
    } catch (e) {
      this.end(r, { status: 'failed', code: (e as Error).message });
    } finally {
      this.starting.delete(r.id);
      this.stopEarly.delete(r.id);
    }
    return r;
  }

  /** [중지]·[취소]: 초안이면 바로, 실행 중이면 엔진에 알린다(커밋 구간이면 엔진이 거부). */
  async stop(id: string): Promise<RunView> {
    const r = this.runs.get(id);
    if (!r) throw new Error('no_run');
    if (r.status === 'draft') {
      r.status = 'stopped';
      r.stoppedNote = '취소했어요.';
      this.emit('update', r);
      return r;
    }
    if (!['preparing', 'turn', 'waiting'].includes(r.status)) {
      if (r.status === 'issuing') throw new Error('already_issuing');
      return r;
    }
    if (this.starting.has(id)) {
      this.stopEarly.add(id);
      return r;
    }
    await this.host.rpc('run.stop', { runId: id });
    return r;
  }

  /**
   * 승인 바에서 승인했다(근거를 게이트 포트로 보내기 직전에 부른다). 거부 우선 창(2초) 동안은 [중지]가 이긴다.
   * 보낸 뒤 엔진이 끝나면 발급됐는지 모르는 쪽으로 다룬다(engineGone).
   */
  approved(runId: string): void {
    const r = this.runs.get(runId);
    if (!r || r.status !== 'waiting') return;
    r.approvedPending = true;
    this.step(r, 'gate', 'now', '승인했어요. 2초 안에 [중지]하면 발급하지 않아요');
    this.emit('update', r);
  }

  /**
   * 엔진이 근거를 받지 않았다(토큰 없음, 발급 없음). "승인했어요" 안내를 바로 거둔다. [중지]·만료가 먼저 게이트를
   * 닫은 경우(경쟁)도 여기까지만 한다. 끝 이유는 엔진의 것(중지·만료)이 맞다.
   */
  answerNotTaken(runId: string, note = '승인이 반영되지 않았어요'): void {
    const r = this.runs.get(runId);
    if (!r || r.status !== 'waiting') return;
    r.approvedPending = false;
    this.step(r, 'gate', 'now', note);
    this.emit('update', r);
  }

  /** 승인 근거를 엔진이 거부했거나 바를 띄우지 못했다. 열린 게이트를 중지로 닫는다(안전한 실패). */
  async abortGate(runId: string, code: string): Promise<void> {
    if (!this.runs.has(runId)) return;
    this.answerNotTaken(runId, '승인을 전하지 못해 멈추고 있어요');
    this.endCodes.set(runId, code);
    await this.host.rpc('run.stop', { runId }).catch(() => {});
  }

  private step(r: RunView, phase: Phase, state: StepState, noteText?: string): void {
    const i = PHASES.indexOf(phase);
    r.steps[i] = { label: STEPS[i]!, state, note: noteText };
  }

  private onEngine(e: EngineEvent): void {
    const r = this.runs.get(e.runId);
    if (!r) return;
    if (e.type === 'phase') {
      // 가짜 페이지는 서명이 없다(signFlow는 PoC-3에서 실제 순서를 본 뒤).
      const n = e.phase === 'sign' && e.state === 'now' ? '가짜 페이지는 서명 단계가 없어요' : e.code ? NOTE[e.code] : undefined;
      this.step(r, e.phase, e.state === 'attention' ? 'attention' : e.state, n);
      if (['sign', 'verify', 'mail'].includes(e.phase) && r.status === 'waiting') {
        r.status = 'issuing';
        r.approvedPending = false;
        this.step(r, 'gate', 'done');
      }
      this.emit('update', r);
      return;
    }
    if (e.type === 'waiting') return; // 게이트 요청(게이트 포트)이 따로 온다
    this.end(r, e);
  }

  private end(r: RunView, e: { status: string; code?: string; approvalNo?: string; mailConfirmed?: boolean }): void {
    if (['draft', 'done', 'stopped', 'attention'].includes(r.status)) return;
    void this.host.control('run.end', { runId: r.id }).catch(() => {});
    r.turn = null;
    r.approvedPending = false;
    // in_doubt는 main이 닫은 이유("아무것도 발급하지 않았어요")로 덮지 않는다. 발급됐는지 모른다는 것이 먼저다.
    const code = e.status === 'in_doubt' ? (IN_DOUBT_NOTE.has(e.code ?? '') ? e.code : 'in_doubt') : (this.endCodes.get(r.id) ?? e.code);
    this.endCodes.delete(r.id);
    if ((e.status === 'success' || e.status === 'completed_with_issues') && e.approvalNo) {
      const doc: Doc = { id: `d-${r.id}`, name: `세금계산서 · ${r.counterparty.name}`, kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(0), expiresOn: null, source: '앱이 발급' };
      r.status = 'done';
      // 엔진은 끝 스텝에서 마지막 구간의 done을 따로 보내지 않는다. 확정된 실행에서 진행 중이던 단계는 끝난 것이다.
      r.steps = r.steps.map((s) => (s.state === 'now' ? { ...s, state: 'done' } : s));
      r.result = { approvalNo: e.approvalNo, mailTo: r.email.value, docId: doc.id, doneAt: hm(), mailConfirmed: e.mailConfirmed === true };
      if (!e.mailConfirmed) {
        this.step(r, 'mail', 'attention', r.email.value ? NOTE['mail.not_confirmed'] : '받는 이메일이 없어 보내지 않았어요');
        if (r.email.value) r.warnings = [NOTE['mail.not_confirmed']!];
      }
      this.emit('doc', doc);
    } else if (e.status === 'stopped' || e.status === 'expired') {
      r.status = 'stopped';
      r.stoppedNote = note(code);
    } else {
      // 실패·in_doubt는 사용자가 볼 일이 있다(확인 필요). 지금 단계를 표시하고 이유를 보인다.
      r.status = 'attention';
      r.stoppedNote = note(code);
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      if (now >= 0) r.steps[now] = { ...r.steps[now]!, state: 'attention' };
    }
    r.steps = r.steps.map((s) => (s.state === 'now' ? { ...s, state: 'todo', note: undefined } : s));
    this.emit('update', r);
  }

  /** 게이트 요청: 카드·패널은 엔진이 되읽은 값(같은 fields)으로 바꿔 그린다. 바는 shell-app이 띄운다. */
  private onGate(req: GateRequest): void {
    const r = this.runs.get(req.runId);
    if (!r || !['preparing', 'turn'].includes(r.status)) return;
    const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
    const num = (k: string) => Number(f.get(k as never) ?? NaN);
    const before = { name: r.counterparty.name, bizNo: r.counterparty.bizNo, email: r.email.value, supply: r.supply, tax: r.tax, item: r.item };
    r.counterparty = { ...r.counterparty, name: f.get('counterpartName') ?? '', bizNo: f.get('counterpartBizNo') ?? '', first: f.get('$first.bizNo') === 'true' };
    r.email = { value: f.get('counterpartEmail') ?? '', first: f.get('$first.email') === 'true' };
    r.supply = num('supplyAmount');
    r.tax = num('taxAmount');
    r.total = num('totalAmount');
    r.item = f.get('itemName') ?? '';
    r.writeDate = f.get('issueDate') ?? r.writeDate;
    r.confirmed = true;
    const after = { name: r.counterparty.name, bizNo: r.counterparty.bizNo, email: r.email.value, supply: r.supply, tax: r.tax, item: r.item };
    r.readbackDiffers = JSON.stringify(before) !== JSON.stringify(after);
    r.warnings = dupWarnings(req);
    r.status = 'waiting';
    for (const p of ['login', 'form', 'input', 'readback'] as const) if (r.steps[PHASES.indexOf(p)]!.state !== 'done') this.step(r, p, 'done');
    this.step(r, 'gate', 'now', '아래 [승인하고 발급]을 기다려요');
    this.emit('update', r);
    this.emit('gate', r.id, req);
  }
}
