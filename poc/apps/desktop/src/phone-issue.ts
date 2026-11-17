// 폰 발급 명령 받기(remote-envelope v1.8, ADR-046 결정 2, D08 §6 "폰 발급 명령").
// - 폰 cmd.run{playbookId: hometax.invoice.issue}을 받아 PC 셸에 발급 초안을 만들고 [홈택스에서 준비]를 바로 시작한다(대화 0클릭 준비와 같은 길).
// - 답은 cmd.ack 하나. 폰 승인(gate.request 중계)은 아직 PC에 없어서 시작한 건은 모두 pc_only다(승인은 PC 승인 바에서).
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

/** 폰에 보낼 진행 이벤트(runId는 폰 쪽 ULID). 발급이 끝났으면 승인번호·합계·메일 확인·보관 문서 id만 싣는다. */
export function eventOf(r: RunView, runId: string, cmdId: string, at: number): RunEventBody {
  const phase = phaseOf(r);
  const ev: RunEventBody = { runId, cmdId, at, event: phase === 'done' || phase === 'stopped' ? 'end' : 'phase', phase, status: r.status };
  if (phase === 'verify' && Number.isSafeInteger(r.verifyAttempt) && r.verifyAttempt! >= 1) ev.attempt = Math.min(r.verifyAttempt!, 99);
  if (phase === 'done' && r.result && APPROVAL_NO.test(r.result.approvalNo) && Number.isSafeInteger(r.total) && r.total >= 0) {
    ev.result = { approvalNo: r.result.approvalNo, total: r.total, emailSent: r.result.mailConfirmed };
    if (UUID4.test(r.result.docId)) ev.result.docId = r.result.docId;
  }
  if (phase === 'stopped' && r.inDoubt) ev.code = 'in_doubt';
  return ev;
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

/** 셸 실행 쪽(ShellRuns 일부와 shell-app의 준비 함수) */
export interface PhoneIssuePorts {
  counterparty: (ref: string) => Counterparty | null;
  createDraft: (cp: Counterparty, supply: number, item: string) => RunView;
  /** [홈택스에서 준비](shell-app prepareNow). 막히면 던진다(초안 카드에 이유가 남고 PC에서 다시 누를 수 있다). */
  prepare: (id: string) => Promise<unknown>;
  anyActive: () => boolean;
  get: (id: string) => RunView | undefined;
  /** 초안이 생겼다(판·대화에 카드를 그린다). */
  onDraft?: (run: RunView) => void;
  cmds: Pick<CmdLog, 'get' | 'put'>;
  now?: () => number;
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
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

  /** 셸 실행이 바뀔 때(ShellRuns 'update'). 폰이 시킨 건이면 단계가 바뀐 때만 보낸다. */
  update(r: RunView): void {
    const t = this.#runs.get(r.id);
    if (t) this.#emit(r, t, false);
  }

  #emit(r: RunView, t: Tracked, force: boolean): void {
    const ev = eventOf(r, t.runId, t.cmdId, this.#now());
    const key = `${ev.phase}:${ev.attempt ?? ''}:${ev.result ? 'r' : ''}`;
    if (!force && key === t.last) return;
    t.last = key;
    const sink = this.#sinks.get(t.pairId);
    if (!sink) return;
    try {
      sink.send('run.event', ev);
    } catch {
      // 끝 소식도 못 보냈으면 지우지 않는다(다음 세션 attach에서 다시 보낸다)
      this.#log('event_send_failed');
      return;
    }
    if (ev.event === 'end') this.#runs.delete(r.id);
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
    const t: Tracked = { pairId, cmdId: body.cmdId, runId, last: '' };
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
    return { cmdId: body.cmdId, state: 'pc_only', runId };
  }
}
