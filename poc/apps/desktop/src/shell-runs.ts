import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { GateRequest } from '@sax/engine/gate';
import { actionText, ISSUED_OR_UNKNOWN } from './approval-gate.ts';
import type { EngineHost, GateAnswerResult } from './engine-host.ts';
import { dayOffset, hm, parseAmount, split, type Counterparty, type Doc, type Drafts, type RunView, type StepState, type VatMode } from './shell-mock.ts';

// 셸의 발급 실행(PoC-6). 초안은 main이 만들고(요청 해석은 아직 정규식 목업), [홈택스에서 준비]부터는 엔진이 H-01 플레이북을 돈다.
// 실행 단계·승인 대기·발급 확정·승인번호는 엔진 이벤트에서 온다. 게이트 요청은 게이트 포트로 와서 승인 바가 받는다(shell-app).

const STEPS = ['홈택스 로그인', '건별발급 화면', '입력', '되읽기', '승인', '전자서명', '발급목록 확인', '메일 전송 확인'];
const PHASES = ['login', 'form', 'input', 'readback', 'gate', 'sign', 'verify', 'mail'] as const;
type Phase = (typeof PHASES)[number];

type EngineEvent =
  | { runId: string; type: 'phase'; phase: Phase; state: 'now' | 'done' | 'attention'; code?: string }
  | { runId: string; type: 'waiting'; reqId: string }
  | { runId: string; type: 'end'; status: string; code?: string; approvalNo?: string; mailConfirmed?: boolean; portalNotice?: string };

/** 모르는 화면(ADR-025 결정 3·5): 일반 실패 코드 대신 보이는 문장. */
const UNKNOWN_SCREEN = '예상한 홈택스 화면이 아니에요. 전용 Chrome 창에 뜬 안내를 확인해 주세요. 아무것도 발급하지 않았어요.';

/** 엔진 결과 코드 → 사용자 문구. 값은 넣지 않는다. */
export const NOTE: Record<string, string> = {
  'login.session_assumed': '가짜 페이지라 로그인을 건너뛰었어요',
  'run.stopped': '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'gate.stopped': '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'gate.expired': '승인을 기다리다 시간이 지나 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'assert.supplier_mismatch': '홈택스에 로그인한 사업자가 이 프로필과 달라서 멈췄어요. 아무것도 발급하지 않았어요.',
  'assert.fields_missing': '홈택스 화면에 비어 있는 칸이 있어 멈췄어요. 아무것도 발급하지 않았어요.',
  pre_dispatch_mismatch: '승인한 뒤 홈택스 화면 값이 바뀌어 발급 버튼을 누르지 않았어요. 아무것도 발급하지 않았어요.',
  'step.identity_mismatch': '홈택스 화면이 예상과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  'step.target_not_found': UNKNOWN_SCREEN,
  'checkpoint.expect_failed': UNKNOWN_SCREEN,
  'portal.unexpected_page': '홈택스가 예상하지 못한 화면으로 보내 멈췄어요. 전용 Chrome 창의 안내를 확인해 주세요. 아무것도 발급하지 않았어요.',
  'portal.unobservable': '홈택스 화면을 확인하지 못해 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'assert.issue_date_mismatch': '홈택스 작성일자가 오늘(한국 시간)과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  'vault.leak_suspected': '보안 점검에서 이상이 보여 멈췄어요. 아무것도 발급하지 않았어요. 앱을 다시 시작해 주세요.',
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
  // 요청률 정책(D03 §7, 코드는 D16 portal.*·policy.*). 숫자·날짜는 보수 모드(시계 역행)에서 바뀌므로 문구에 넣지 않는다.
  'portal.blocked': '홈택스에서 차단·경고 신호(안내 화면, 요청 거부 응답)가 보여 바로 멈췄어요. 그 뒤로 앱은 홈택스에서 아무 동작도 하지 않았고 아무것도 발급하지 않았어요. 홈택스에 직접 접속해 상태를 확인해 주세요.',
  'portal.blocked_in_doubt': '발급 확인 중에 홈택스에서 차단·경고 신호가 보여 멈췄어요. 발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  'portal.blocked_after_commit': '발급은 확정됐지만 그 뒤 홈택스에서 차단·경고 신호가 보여 멈췄어요. 다음 발급을 이어가기 전에 홈택스에 직접 접속해 상태를 확인해 주세요.',
  'policy.cooldown': '홈택스 차단·경고 신호가 보여 24시간 동안 홈택스 실행을 쉬어요. 아무것도 발급하지 않았어요.',
  'portal.mfa_pending': '홈택스가 추가 인증을 요구해 멈췄어요. 아무것도 발급하지 않았어요. 홈택스에서 직접 인증한 뒤 다시 준비해 주세요.',
  'portal.extra_auth_repeat': '홈택스 추가 인증이 반복돼 앱이 스스로 멈췄어요(차단 신호는 아니에요). 홈택스에서 직접 인증을 마친 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  'portal.captcha': '홈택스에 자동입력방지 문자가 떠서 멈췄어요. 아무것도 발급하지 않았어요.',
  'portal.busy': '홈택스 접속 대기열이 떠서 멈췄어요. 아무것도 발급하지 않았어요. 혼잡이 풀린 뒤 다시 준비해 주세요.',
  'policy.runs_per_day': '오늘 홈택스 실행 횟수 상한에 닿아 시작하지 않았어요.',
  // PoC 상한(ADR-025 결정 1). 앱이 집행하는 PoC 값이라 숫자를 문구에 넣는다.
  'policy.irreversible_per_day': '오늘은 PoC 기간 하루 발급 상한(1건)에 닿았어요. 내일 다시 할 수 있어요.',
  'policy.poc_irreversible_total': 'PoC 기간 전체 실발급 상한(3건)에 닿아 더 발급하지 않아요.',
  'policy.runs_per_session': '이번 홈택스 로그인으로 할 수 있는 실행 횟수를 다 써서 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.logins_per_day': '오늘 홈택스 로그인 횟수 상한에 닿아 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.actuations_per_run': '한 번의 실행에서 할 수 있는 동작 수를 넘겨 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.wall_clock': '실행 시간 상한을 넘겨 멈췄어요. 아무것도 발급하지 않았어요.',
};
/** 차단 신호로 끝났는데 발급됐는지 모름(verify 중 신호). */
const BLOCK_CODES = new Set(['portal.blocked', 'policy.cooldown']);
/** in_doubt(발급됐는지 모름)는 코드와 관계없이 중복 위험을 알린다. 코드별 문구는 이 목록만. */
const IN_DOUBT_NOTE = new Set(['verify.unknown', 'engine.exit']);
const note = (code?: string) => (code && NOTE[code]) || (code ? `멈췄어요(${code}).` : '멈췄어요.');

/** 중복 카드 문장(ADR-027 UX). 발급 확정 / 발급 여부 모름 / 직전 시도 미발급. */
export const DUP_NOTE = {
  committed: '이 거래와 같은 건이 이미 발급돼 있어요(승인번호 있음). 한 번 더 발급하면 같은 계산서가 2건이 돼요.',
  unknown: '같은 건이 발급됐는지 아직 확인하지 못했어요. 홈택스 발급목록을 먼저 확인해 주세요.',
  notCommitted: '직전 시도는 발급 안 됨으로 판정했어요. 다시 발급하기 전에 홈택스 발급목록을 한 번 확인해 주세요.',
  other: '같은 거래처·금액·날짜·품목의 기록이 있어요. 같은 건을 두 번 발급하는 것이 아닌지 확인해 주세요.',
} as const;

/** 승인 대기 카드에 붙는 중복 경고(D02 §7). 해당하는 것을 모두 둔다(발급 확정 → 모름 → 직전 미발급). 바에는 가장 위험한 하나가 표시된다. */
function dupWarnings(req: GateRequest): string[] {
  const f = new Map<string, string>(req.fields.map((x) => [x.fieldKey, x.value]));
  const states = (f.get('$dup.businessKey') ?? '').split(',');
  const out: string[] = [];
  if (states.includes('committed')) out.push(DUP_NOTE.committed);
  if (states.some((s) => s !== 'committed' && ISSUED_OR_UNKNOWN.includes(s))) out.push(DUP_NOTE.unknown);
  if (f.get('$dup.priorNotCommitted') === 'true') out.push(DUP_NOTE.notCommitted);
  if (!out.length && f.has('$dup.businessKey')) out.push(DUP_NOTE.other);
  return out;
}

/** 금고 이벤트(I-2) → 카드 문장. runId가 없으면 진행 중인 실행에 붙인다. 모르는 이벤트는 null. */
export function vaultNotice(name: string, data: unknown): { runId?: string; text: string } | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (name === 'secret.expired') return { runId: typeof d.runId === 'string' ? d.runId : undefined, text: '입력한 비밀번호를 5분 안에 쓰지 않아 지웠어요. 필요할 때 다시 물어볼게요.' };
  if (name === 'secret_window.leak_suspected') return { text: NOTE['vault.leak_suspected']! };
  if (name === 'secret_window.refused') {
    return d.reason === 'google_signin_detected'
      ? { text: '전용 Chrome에 Google 계정이 로그인돼 있어 비밀번호 창을 열지 않았어요. 전용 Chrome에서 로그아웃한 뒤 다시 준비해 주세요.' }
      : { text: '전용 Chrome 설정이 바뀌어 비밀번호 창을 열지 않았어요. 앱을 다시 시작해 주세요.' };
  }
  return null;
}

/** 엔진·금고 fatal(I-6) → 기동 거부 대화상자 문장. 해당 없으면 null. */
export function fatalText(code: string): string | null {
  if (code === 'vault: db.key_missing' || code === 'vault: vault.keystore_mismatch') return '이 PC의 자격 증명 관리자에서 앱 열쇠를 찾지 못했어요. 기록을 지키려고 앱을 열지 않았어요.';
  if (code.startsWith('engine.env_tampered')) return '개발용 환경 변수가 켜져 있어 앱을 열지 않았어요.';
  return null;
}

/** 포털이 한 말(ADR-025 결정 5): 텍스트만, 200자. 제어문자는 뺀다. 렌더러는 텍스트 노드로만 넣는다. */
const portalNoticeText = (s: string) => `홈택스 안내: “${s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim().slice(0, 200)}”`;

/** 게이트 없이 끝난 실행이 연달아 이만큼이면 잠시(PREPARE_PAUSE_MS) 준비를 받지 않는다(ADR-027 결정 8). */
export const GATELESS_STREAK_MAX = 3;
export const PREPARE_PAUSE_MS = 60_000;

/** 엔진 answer() 거부 중 [중지]·만료가 먼저 게이트를 닫아서 생긴 것(근거 문제 아님). */
const RACED = new Set(['stopped', 'gate_expired', 'no_open_gate', 'not_open']);

/** 셸이 쓰는 엔진 연결 부분(시험은 가짜로 바꿔 끼운다). 게이트 답을 보내는 메서드는 넣지 않는다(shell-app의 승인 바 결과 처리만 쓴다). */
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
  private readonly clock: () => number;
  /** 게이트 없이 연달아 끝난 실행의 끝 시각(게이트가 뜨면 비운다). */
  private gateless: number[] = [];
  /** 앱이 되물은 것(입력 보완). 대화(세션)마다 하나. */
  readonly pending: { cp: Counterparty | null; asked: 'amount' | 'counterparty' | null; amount: number | null } = { cp: null, asked: null, amount: null };

  constructor(host: RunHost, src: ShellRunsSource, clock: () => number = Date.now) {
    super();
    this.host = host;
    this.src = src;
    this.clock = clock;
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

  /** item: 문장에서 뽑은 품목(시연 모델). 없으면 거래처의 지난 품목. */
  createDraft(cp: Counterparty, amount: number, vat: VatMode | null, item?: string | null): RunView {
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
      item: item || cp.item,
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

  /** 진행 중인 실행인가(비밀 창은 이 실행의 요청만 연다). */
  isActive(runId: string): boolean {
    const r = this.runs.get(runId);
    return !!r && ['preparing', 'turn', 'waiting', 'issuing'].includes(r.status);
  }

  /** 게이트 없이 끝난 실행이 연달아 GATELESS_STREAK_MAX번이고 마지막 끝에서 PREPARE_PAUSE_MS가 안 지났는가. */
  prepareThrottled(): boolean {
    const last = this.gateless.at(-1);
    if (this.gateless.length < GATELESS_STREAK_MAX || last === undefined) return false;
    if (this.clock() - last < PREPARE_PAUSE_MS) return true;
    this.gateless = [];
    return false;
  }

  /** 카드에 문장 하나를 더한다(금고 이벤트 등). runId가 없거나 끝난 실행이면 진행 중인 실행에. 같은 문장은 한 번만. */
  notice(runId: string | undefined, text: string): void {
    const own = runId ? this.runs.get(runId) : undefined;
    const active = [...this.runs.values()].find((x) => this.isActive(x.id));
    const r = own && this.isActive(own.id) ? own : (active ?? own);
    if (!r) return;
    r.notices = [...(r.notices ?? []).filter((t) => t !== text), text];
    this.emit('update', r);
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
   * 게이트 답의 결과를 실행에 반영한다. "발급 없음"이라고 말할 수 있는 것은 엔진이 판정했거나 보내지 않았을 때뿐이다.
   * 보낸 뒤 판정을 못 받았으면(엔진·금고 종료) 승인 표시를 그대로 둔다. 엔진 종료 처리가 발급됐는지 모름으로 끝낸다.
   */
  async onAnswer(runId: string, r: GateAnswerResult): Promise<void> {
    if (r.ok || r.verdict === 'unknown') return;
    // [중지]·대기 만료가 먼저 게이트를 닫았으면(경쟁) 엔진이 그 이유로 실행을 끝낸다. 이유를 덮지 않는다.
    if (r.verdict === 'engine' && RACED.has(r.code ?? '')) return this.answerNotTaken(runId);
    await this.abortGate(runId, 'answer.rejected');
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

  private end(r: RunView, e: { status: string; code?: string; approvalNo?: string; mailConfirmed?: boolean; portalNotice?: string }): void {
    if (['draft', 'done', 'stopped', 'attention'].includes(r.status)) return;
    void this.host.control('run.end', { runId: r.id }).catch(() => {});
    r.turn = null;
    r.approvedPending = false;
    if (!r.confirmed) this.gateless.push(this.clock());
    if (typeof e.portalNotice === 'string' && e.portalNotice.trim()) r.notices = [...(r.notices ?? []), portalNoticeText(e.portalNotice)];
    // in_doubt는 main이 닫은 이유("아무것도 발급하지 않았어요")로 덮지 않는다. 발급됐는지 모른다는 것이 먼저다.
    const code = e.status === 'in_doubt' ? (IN_DOUBT_NOTE.has(e.code ?? '') ? e.code : BLOCK_CODES.has(e.code ?? '') ? 'portal.blocked_in_doubt' : 'in_doubt') : (this.endCodes.get(r.id) ?? e.code);
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
      if (e.code === 'portal.blocked_after_commit') r.warnings = [...r.warnings, NOTE['portal.blocked_after_commit']!];
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
    r.action = actionText(req);
    this.gateless = [];
    r.status = 'waiting';
    for (const p of ['login', 'form', 'input', 'readback'] as const) if (r.steps[PHASES.indexOf(p)]!.state !== 'done') this.step(r, p, 'done');
    this.step(r, 'gate', 'now', '아래 [승인하고 발급]을 기다려요');
    this.emit('update', r);
    this.emit('gate', r.id, req);
  }
}
