// 폰 발급 명령 받기(remote-envelope v1.8, ADR-046 결정 2, D08 §6 "폰 발급 명령").
// - 폰 cmd.run{playbookId: hometax.invoice.issue}을 받아 PC 셸에 발급 초안을 만들고 [홈택스에서 준비]를 바로 시작한다(대화 0클릭 준비와 같은 길).
// - 답은 cmd.ack 하나. 그 폰이 지금 승인 요청을 받을 수 있으면(받은 승인 키 + approve.v1 세션, ADR-052) accepted, 아니면 pc_only다.
//   승인 단계에서 폰으로 보내지 못하는 건(처음 거래처·오늘 한도 등)은 run.event.code(pc_*)로 이유를 알린다(phone-gate.ts).
// - 진행은 run.event(phase·attempt·result)로 그 폰의 라이브 세션에 보낸다. 세션이 없으면 버리고, 다음 세션을 열 때 지금 상태를 한 번 보낸다.
// - 같은 cmdId는 한 번만 시작한다(B-10): 처리한 cmdId를 디스크에 먼저 적고 시작한다. 다시 오면 rejected/duplicate와 같은 runId로 답한다.
// - 폰 입력의 거래처는 장부 id 참조뿐이다(사업자번호·이메일은 PC 장부 값). 받는 이메일은 거래처에 저장된 값을 쓴다.
// - 로그는 결과 코드만(거래처·금액·품목 없음).
import fs from 'node:fs/promises';
import { checkIssueRequest, ISSUE_PLAYBOOK, ulid, type CmdAckBody, type CmdRejectReason, type CmdRunBody, type PhoneIssueRequest, type RunEventBody, type RunPhase } from '@sax/remote';
import { kstToday } from './approval-gate.ts';
import type { Counterparty, RunView } from './shell-model.ts';

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPROVAL_NO = /^[0-9-]{8,40}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CMD_KEEP = 500;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** cmd.run inputs(issueInputs 모양) → 폰 발급 요청. 모양이 다르면 null. */
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

/** 셸 실행 → 폰 진행 단계. 셸 단계 순서: 로그인·건별발급 화면·입력·되읽기·승인·전자서명·발급목록 확인·메일. */
export function phaseOf(r: RunView): RunPhase {
  if (r.status === 'done') return 'done';
  if (r.status === 'stopped' || r.discarded || (r.status === 'attention' && r.endedAt !== undefined)) return 'stopped';
  if (r.status === 'waiting') return 'approve';
  if (r.status === 'draft') return 'prepare';
  const i = r.steps.findIndex((s) => s.state === 'now' || s.state === 'attention');
  const at = i >= 0 ? i : Math.max(0, r.steps.filter((s) => s.state === 'done').length);
  return (['login', 'prepare', 'prepare', 'readback', 'approve', 'issue', 'verify', 'verify'] as const)[Math.min(at, 7)]!;
}

/**
 * 폰에 보낼 진행 이벤트(runId는 폰 쪽 ULID). 발급이 끝났으면 승인번호·합계·메일 확인·보관 문서 id만 싣는다.
 * approveCode: 승인 단계인데 폰으로 보내지 않는 이유(pc_key·pc_first·pc_limit·pc_only). 없으면 폰 승인(gate.request가 따로 간다)이거나 옛 PC다.
 */
export function eventOf(r: RunView, runId: string, cmdId: string, at: number, approveCode?: string): RunEventBody {
  const phase = phaseOf(r);
  const turn = phase !== 'done' && phase !== 'stopped' && r.status === 'turn' && !!r.handoff;
  // 사람 차례(핸드오프): 'turn' 사건과 그 까닭(엔진 코드, 예: login.simple_auth)을 싣는다. 이게 없으면 폰은 "진행 중"에 머문다(2026-11-19 실기기).
  const ev: RunEventBody = { runId, cmdId, at, event: phase === 'done' || phase === 'stopped' ? 'end' : turn ? 'turn' : 'phase', phase, status: r.status };
  if (turn) ev.code = turnCode(r.handoff!, r);
  if (turn && r.handoff!.code === 'login.simple_sent' && r.simpleAuth) ev.deadline = r.simpleAuth.deadline;
  if (phase === 'verify' && Number.isSafeInteger(r.verifyAttempt) && r.verifyAttempt! >= 1) ev.attempt = Math.min(r.verifyAttempt!, 99);
  if (phase === 'done' && r.result && APPROVAL_NO.test(r.result.approvalNo) && Number.isSafeInteger(r.total) && r.total >= 0) {
    ev.result = { approvalNo: r.result.approvalNo, total: r.total, emailSent: r.result.mailConfirmed };
    if (UUID4.test(r.result.docId)) ev.result.docId = r.result.docId;
  }
  if (phase === 'stopped' && r.inDoubt) ev.code = 'in_doubt';
  // PC 앱 판이 낮아 시작하지 않았다: 폰이 "PC 앱을 업데이트해 주세요"라고 말할 수 있다(아무것도 발급하지 않았다).
  else if (phase === 'stopped' && r.endCode === 'package.app_old' && !r.result) ev.code = 'app_old';
  // 발급 없이 멈췄다(승인 전 실패·핸드오프 끝·버림). 폰은 "아무것도 발급하지 않았어요"를 확실히 말할 수 있다.
  else if (phase === 'stopped' && (r.redo || r.handoffEnd || r.discarded) && !r.result) ev.code = 'not_issued';
  if (phase === 'approve' && approveCode) ev.code = approveCode;
  return ev;
}

/** 사람 차례 까닭(폰에 보내는 코드). 엔진 코드는 패키지 규칙 모양(소문자·점·밑줄)일 때만 그대로, 아니면 종류만(turn.login·turn.sign·turn.other). */
const TURN_CODE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,3}$/;
/** 공동인증서 로그인 실패 차례(엔진 s7e)와, 폰이 시작한 간편인증 승인 대기(셸). 폰 [인증서로 다시 시도]·간편인증을 받는다. */
const CERT_TURN: ReadonlySet<string> = new Set(['login.simple_auth', 'login.simple_sent']);
/** 간편인증 답(human.response value): sa1:req:<앱>[-<통신사>]:<생년월일 8>:<휴대폰 숫자>:<이름> 또는 sa1:done. 통신사는 PASS만(예: pass-sa). */
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

/** 처리한 cmdId(디스크 영속, 0600). 같은 명령을 두 번 시작하지 않는다. */
export class CmdLog {
  #file: string;
  #rows: Promise<Array<{ cmdId: string; runId: string; at: number }>> | null = null;
  #write: Promise<void> = Promise.resolve();
  constructor(file: string) {
    this.#file = file;
  }
  /** 파일은 한 번만 읽고, 그 뒤로는 같은 배열(put이 넣은 행 포함)을 돌려준다. 동시 호출도 같은 읽기를 기다린다. */
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
  /** 적은 뒤에 돌아온다(시작보다 먼저). */
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

/** cmd.resume 본문(schema __body6): 폰 쪽 runId 하나. */
export interface CmdResumeBody {
  runId: string;
}

/** 셸 실행 쪽(ShellRuns 일부와 shell-app의 준비 함수) */
export interface PhoneIssuePorts {
  counterparty: (ref: string) => Counterparty | null;
  createDraft: (cp: Counterparty, supply: number, item: string) => RunView;
  /** [홈택스에서 준비](shell-app prepareNow). 막히면 던진다(초안 카드에 이유가 남고 PC에서 다시 누를 수 있다). */
  prepare: (id: string) => Promise<unknown>;
  anyActive: () => boolean;
  /** [인증서로 다시 시도](ShellRuns.retryCert). 없으면 폰의 cmd.resume을 받지 않는다. */
  retryCert?: (id: string) => Promise<unknown>;
  /** 폰에서 시작한 간편인증(ShellRuns.simpleAuth). 없으면 human.request를 보내지 않는다. */
  simpleAuth?: (id: string, op: 'request' | 'complete', d?: { provider: string; name: string; birth: string; phone: string; carrier?: string }) => Promise<unknown>;
  get: (id: string) => RunView | undefined;
  /** 초안이 생겼다(판·대화에 카드를 그린다). */
  onDraft?: (run: RunView) => void;
  cmds: Pick<CmdLog, 'get' | 'put'>;
  /** 이 폰이 지금 승인 요청을 받을 수 있는가(phone-gate PhoneGate.canApprove). 없으면 늘 pc_only. */
  approver?: (pairId: string) => boolean;
  /** 승인 단계에서 폰으로 보내지 않는 이유(phone-gate PhoneGate.codeOf). */
  approveCode?: (shellRunId: string) => string | undefined;
  now?: () => number;
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
  /** 폰 깨우기(phone-wake PhoneWaker.wake, ADR-053 결정 2). 그 폰 세션이 없을 때 끝·멈춤·사람 차례·PC 승인이 되면 update로 부른다. */
  wake?: (pairId: string, kind: 'update') => unknown;
}

/**
 * 폰이 없을 때 알릴 만한 소식인가(ADR-053 결정 2 update): 발급 끝남, 멈춤, 사람 손이 필요함(핸드오프), PC에서 승인해야 함(pc_*).
 * 폰 승인으로 가는 승인 단계는 phone-gate가 approve로 깨운다.
 */
export function wakeWorthy(ev: RunEventBody): boolean {
  if (ev.event === 'end' || ev.event === 'turn') return true;
  return ev.phase === 'approve' && typeof ev.code === 'string' && ev.code.startsWith('pc_');
}

/** 진행을 받을 곳(그 폰의 라이브 세션 채널) */
export interface PhoneSink {
  send(type: 'cmd.ack', body: CmdAckBody): unknown;
  send(type: 'run.event', body: RunEventBody): unknown;
}

interface Tracked {
  pairId: string;
  cmdId: string;
  runId: string;
  last: string;
  /** 간편인증 답을 받을 요청(human.request reqId). 공동인증서 실패 차례에서 한 번 만든다. */
  simpleReq?: string;
  /** v1.11 run.event.rev: 이 실행에 보낸 run.event 수(보낼 때마다 1씩 올린다) */
  rev: number;
  /** 폰에서 거절해 멈춘 실행: 그 멈춤 소식으로는 깨우지 않는다(사장님이 방금 본 일) */
  deniedByPhone?: boolean;
}

/** PC 하나에 하나. 폰마다 지금 세션(sink)을 붙였다 뗀다. */
export class PhoneIssue {
  #o: PhoneIssuePorts;
  #sinks = new Map<string, PhoneSink>();
  /** 셸 실행 id → 폰 쪽 정보 */
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

  /** 라이브 세션이 열렸다. 이 폰이 시킨 건의 지금 상태를 한 번 보낸다. */
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

  /** 셸 실행이 바뀔 때(ShellRuns 'update'). 폰이 시킨 건이면 단계가 바뀐 때만 보낸다. 새 실행이 대신한 끝(replaced)은 보내지 않는다(relink를 기다린다). */
  update(r: RunView): void {
    const t = this.#runs.get(r.id);
    if (t && !(r.replaced && phaseOf(r) === 'stopped')) this.#emit(r, t, false);
  }

  /** 같은 값의 새 실행이 이어서 한다(ShellRuns 'restart', 인증서 로그인 다시 시도). 폰 쪽 runId·cmdId는 그대로 둔다. */
  relink(from: string, to: string): void {
    const t = this.#runs.get(from);
    if (!t) return;
    this.#runs.delete(from);
    this.#runs.set(to, t);
    const r = this.#o.get(to);
    if (r) this.#emit(r, t, false);
  }

  /** 이 셸 실행을 맡긴 폰과 폰 쪽 runId. 폰이 시작한 실행이 아니면 null. */
  trackedOf(shellRunId: string): { pairId: string; runId: string } | null {
    const t = this.#runs.get(shellRunId);
    return t ? { pairId: t.pairId, runId: t.runId } : null;
  }

  /** 폰에서 거절했다(phone-gate deny). 곧 오는 멈춤은 폰이 이미 아는 소식이라 깨우지 않는다. */
  deniedByPhone(shellRunId: string): void {
    const t = this.#runs.get(shellRunId);
    if (t) t.deniedByPhone = true;
  }

  /** 승인 단계 이유가 바뀌었다(phone-gate). 지금 상태를 다시 본다(달라졌을 때만 보낸다). */
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
      // 바뀐 소식인데 폰이 앱을 닫아 두었다: 깨운다(같은 소식은 key가 같아 한 번만)
      if (!force && wakeWorthy(ev) && !(t.deniedByPhone && ev.event === 'end')) this.#o.wake?.(t.pairId, 'update');
      return;
    }
    // 폰은 적용한 것보다 크지 않은 rev를 버린다(늦게 온 옛 이벤트가 새 상태를 덮지 않게). sync.v1을 모르는 폰에는 phone-session이 뺀다.
    ev.rev = ++t.rev;
    try {
      sink.send('run.event', ev);
      // 공동인증서 실패 차례: 폰이 간편인증 값을 보낼 자리(human.request manual)를 연다. 같은 차례에서는 같은 reqId.
      if (ev.event === 'turn' && ev.code === 'login.simple_auth' && this.#o.simpleAuth) {
        t.simpleReq ??= ulid(this.#now());
        (sink.send as unknown as (ty: string, b: object) => unknown)('human.request', { runId: t.runId, stepId: 's7e', reqId: t.simpleReq, kind: 'manual', prompt: 'simple_auth', ttl: 600 });
      }
    } catch {
      // 끝 소식도 못 보냈으면 지우지 않는다(다음 세션 attach에서 다시 보낸다)
      this.#log('event_send_failed');
      return;
    }
    if (ev.event === 'end') this.#runs.delete(r.id);
  }

  /**
   * 폰 cmd.resume(폰 [인증서로 다시 시도]). 그 폰이 맡긴 건이 공동인증서 로그인 실패 차례(login.simple_auth)일 때만 다시 시도한다.
   * 답은 따로 없다: 다시 준비하면 진행(run.event)이 이어서 가고, 받지 않으면 지금 상태를 한 번 다시 보낸다.
   */
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

  /**
   * 폰 human.response(간편인증 값 또는 "승인했어요"). 그 폰이 맡긴 건, 이 PC가 연 reqId일 때만 받는다.
   * 못 하면 run.event turn code login.simple_failed를 한 번 보내고(폰이 고르기 화면으로 돌아간다) 지금 차례를 다시 보낸다. 값은 로그에 남기지 않는다.
   */
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

  /** 폰 cmd.run 하나. 답(cmd.ack)을 sink로 보내고 그 답을 돌려준다. */
  async handle(pairId: string, sink: PhoneSink, body: CmdRunBody): Promise<CmdAckBody> {
    // 한 번에 하나씩 정한다(같은 cmdId가 두 세션에서 겹쳐 와도, 다른 명령이 겹쳐 와도 둘 다 시작하지 않게)
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
    // 작성일자는 오늘(한국 시간)만: PC 셸은 오늘 날짜로 발급한다. 세액은 공급가액의 10%(원 미만 버림)여야 한다.
    if (!req || req.day !== kstToday(this.#now()) || req.tax !== Math.floor(req.supply / 10)) return reject('input_invalid');
    const cp = this.#o.counterparty(req.counterpartyRef);
    if (!cp) return reject('counterparty_unknown');
    if (this.#o.anyActive()) return reject('pc_busy');
    const runId = ulid(this.#now());
    // 시작보다 먼저 디스크에 적는다(같은 cmdId 재전송이 두 번 시작하지 않게)
    await this.#o.cmds.put(body.cmdId, runId, this.#now());
    const draft = this.#o.createDraft(cp, req.supply, req.item.trim());
    const t: Tracked = { pairId, cmdId: body.cmdId, runId, last: '', rev: 0 };
    this.#runs.set(draft.id, t);
    this.#o.onDraft?.(draft);
    setImmediate(() => {
      this.#o.prepare(draft.id).catch(() => {
        // 초안은 PC에 남는다([홈택스에서 준비]로 다시). 폰에는 준비 단계에 머문 것으로 보인다.
        this.#log('prepare_blocked');
        const r = this.#o.get(draft.id);
        if (r) this.#emit(r, t, true);
      });
    });
    return { cmdId: body.cmdId, state: this.#o.approver?.(pairId) ? 'accepted' : 'pc_only', runId };
  }
}
