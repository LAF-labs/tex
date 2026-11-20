// 폰 승인 중계와 검증(ADR-052 결정 4·5, D08 §6·§6.1). main 전용: 엔진은 폰 링크도 연결 기록도 없다.
// - 폰이 cmd.run으로 시작한 발급이 커밋 게이트에 오면, 조건이 맞을 때 그 폰에 gate.request를 보낸다(PC 승인 바는 그대로 뜬다).
//   조건: 그 폰에 받은 승인 키(Px)가 있고, 세금계산서 카드이고, 값 대조·무장 검사를 지났고, 처음 거래처·처음 보내는 이메일이 아니고,
//   오늘(한국 시간) 폰 승인이 한도 미만이다. 아니면 이유 코드(pc_*)를 run.event에 실어 폰이 "PC에서 승인"을 보이게 한다.
// - 답(gate.response)은 열린 요청·runId·stepId·sigAlg·actionHash·만료·서명(지금 기록의 키)·한도 순으로 본다. 챌린지는 1회용이다.
// - 통과한 승인은 디스크(remote-approvals.json)에 먼저 적고 넘긴다. 승인 근거(LocalApproval remote+px) 발급과 엔진 전달은 shell-app이 한다.
// - 폰 세션이 없으면(앱이 뒤에 있다) 내용 없는 알림으로 깨운다(ADR-053 결정 2, phone-wake.ts). 게이트당 최대 2번(열 때, 60초 뒤).
//   보낸 뒤 답 없이 세션이 닫혀도 5초 뒤 안 붙었으면 깨운다. 깨우기는 덤이라 실패해도 흐름은 같다.
// - 로그는 결과 코드만(거래처·금액·서명 없음).
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  approveMessage, b64, fromB64, ulid, verifyApprove,
  type GateRefreshBody, type GateRequestBody, type GateResolvedBody, type GateResolvedBy, type GateResponseBody, type PxHw,
} from '@sax/remote';
import { gateSelfCheck, remotePresenceRefusal, type GateRequest } from '@sax/engine/gate';
import { kstToday, summarize } from './approval-gate.ts';
import { WAKE_APPROVE_AGAIN_MS, WAKE_DETACHED_MS, type WakeKind } from './phone-wake.ts';

/** 폰 응답 챌린지 수명(D03 §3 gate.request.exp). 지나면 폰이 gate.refresh로 새 챌린지를 청한다. */
export const PHONE_GATE_TTL_MS = 120_000;
/** remote.irreversiblePerDay 앱 내장 상한(정책은 더 엄격하게만 바꾼다, D08 §6.1). */
export const REMOTE_PER_DAY = 5;
/** 같은 게이트에서 틀린 서명을 이만큼 받으면 그 게이트는 폰으로 더 보내지 않는다. */
export const BAD_SIG_MAX = 3;
const LOG_KEEP = 200;
const STEP_REF = /^s[0-9]{1,3}[a-z]?$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 폰으로 보내지 않는 이유(run.event.code). pc_only = 그 밖(카드 종류·값 대조 등). */
type PcOnlyCode = 'pc_key' | 'pc_first' | 'pc_limit' | 'pc_only';

interface ApprovalRow {
  at: number;
  /** 한국 시간 날짜(하루 한도) */
  day: string;
  pairId: string;
  deviceId: string;
  /** gate.request.reqId(ULID) */
  reqId: string;
  /** 엔진 gate_requests.req_id */
  gateReqId: string;
  actionHash: string;
  /** 폰 서명(r‖s, b64). 나중에 "누가 승인했나"를 다시 확인할 수 있게 남긴다 */
  sig: string;
  challenge: string;
}

const isRow = (x: unknown): x is ApprovalRow => {
  const r = x as Partial<ApprovalRow> | null;
  return !!r && typeof r === 'object' && Number.isSafeInteger(r.at) && typeof r.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.day) && typeof r.reqId === 'string';
};

/** 폰 승인 기록(remote-approvals.json, 0600). 하루 한도를 세고, 승인마다 서명을 남긴다. 파일이 깨졌으면 그날은 폰 승인을 받지 않는다. */
export class ApprovalLog {
  #file: string;
  #rows: Promise<ApprovalRow[] | null> | null = null;
  #write: Promise<void> = Promise.resolve();
  constructor(file: string) {
    this.#file = file;
  }
  #load(): Promise<ApprovalRow[] | null> {
    this.#rows ??= fs.readFile(this.#file, 'utf8').then(
      (t) => {
        try {
          const j = JSON.parse(t) as { v?: number; rows?: unknown };
          return j.v === 1 && Array.isArray(j.rows) && j.rows.every(isRow) ? (j.rows as ApprovalRow[]) : null;
        } catch {
          return null;
        }
      },
      // 파일이 없으면 빈 기록이다. 있는데 읽지 못하면(권한 등) 셀 수 없으므로 닫는다.
      (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? [] : null),
    );
    return this.#rows;
  }
  /** 그날(한국 시간) 폰 승인 수. 기록을 읽지 못하면 Infinity(폰 승인을 닫는다). */
  async countOn(day: string): Promise<number> {
    const rows = await this.#load();
    return rows ? rows.filter((r) => r.day === day).length : Infinity;
  }
  /** 적은 뒤에 돌아온다(엔진에 넘기기 전). 기록을 읽지 못했거나 쓰지 못하면 던진다. */
  async put(row: ApprovalRow): Promise<void> {
    const rows = await this.#load();
    if (!rows) throw new Error('approval_log.unreadable');
    rows.push(row);
    if (rows.length > LOG_KEEP) rows.splice(0, rows.length - LOG_KEEP);
    const snapshot = JSON.stringify({ v: 1, rows });
    const run = async () => {
      const tmp = `${this.#file}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, this.#file);
    };
    const p = this.#write.then(run, run);
    this.#write = p.catch(() => undefined);
    await p;
  }
}

/** 그 폰의 라이브 세션 채널(approve.v1을 알린 세션만 붙인다) */
export interface GateSink {
  send(type: 'gate.request', body: GateRequestBody): unknown;
  /** v1.11: 보낸 게이트가 닫혔다(폰 승인 시트를 바로 닫게). sync.v1을 모르는 폰에는 phone-session이 보내지 않는다. */
  send(type: 'gate.resolved', body: GateResolvedBody): unknown;
}

interface PhoneGatePorts {
  /** 지금 그 폰의 승인 키(phone-link PhoneLink.px). 답이 올 때마다 다시 읽는다. */
  px: (pairId: string) => { pub: Uint8Array; hw: PxHw; deviceId: string } | null;
  /** 셸 실행 id → 그 실행을 맡긴 폰과 폰 쪽 runId(phone-issue PhoneIssue.trackedOf). 폰이 시작한 실행이 아니면 null. */
  tracked: (shellRunId: string) => { pairId: string; runId: string } | null;
  /** 승인 단계 이유가 바뀌었다(PhoneIssue가 run.event를 다시 보낸다). */
  poke: (shellRunId: string) => void;
  approvals: Pick<ApprovalLog, 'countOn' | 'put'>;
  perDay?: number;
  now?: () => number;
  random?: (n: number) => Uint8Array;
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
  /** 폰 깨우기(phone-wake PhoneWaker.wake). 던지지 않는다. 없으면 깨우지 않는다. */
  wake?: (pairId: string, kind: WakeKind) => unknown;
  /** 폰 세션이 붙었다(깨우기 쪽이 "토큰 없음"으로 쉬던 것을 푼다. 폰이 막 토큰을 올렸을 수 있다). */
  attached?: (pairId: string) => void;
  /** 다시 깨우기 타이머(시험용). 기본은 unref된 setTimeout. */
  timers?: { set: (f: () => void, ms: number) => unknown; clear: (h: unknown) => void };
}

const systemTimers = {
  set: (f: () => void, ms: number) => {
    const t = setTimeout(f, ms);
    t.unref?.();
    return t;
  },
  clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

interface GateHandlers {
  /** 폰이 승인했다(서명 검증·기록 끝). 한 번만 불린다. */
  approve: () => void | Promise<void>;
  /** 폰이 거절했다([중지]와 같다). 한 번만 불린다. */
  deny: () => void | Promise<void>;
}

interface OpenGate {
  shellRunId: string;
  req: GateRequest;
  pairId: string;
  /** 폰 쪽 runId(ULID) */
  runId: string;
  /** 와이어 reqId(ULID). 엔진 req.reqId와 1:1 */
  reqId: string;
  on: GateHandlers;
  /** 폰으로 보내지 않는 이유. null이면 폰 승인 가능 */
  refusal: PcOnlyCode | null;
  /** 지금 살아 있는 챌린지(1회용). 아직 못 보냈으면 null */
  pending: { challenge: Uint8Array; exp: number } | null;
  badSigs: number;
  /** 폰에 gate.request를 한 번이라도 보냈다(닫힐 때 gate.resolved를 보낼 대상) */
  sent: boolean;
  /** 이 게이트로 폰을 깨운 횟수(최대 2) */
  wakes: number;
  /** 60초 뒤 다시 깨우기 */
  again: unknown;
}

type AnswerResult =
  | 'approved' | 'denied'
  | 'no_request' | 'wrong_gate' | 'sig_alg' | 'wrong_action' | 'expired' | 'no_key' | 'bad_sig' | 'limit' | 'log_failed';

/** PC 하나에 하나. 폰마다 지금 세션(sink)을 붙였다 뗀다. */
export class PhoneGate {
  #o: PhoneGatePorts;
  #sinks = new Map<string, GateSink>();
  /** 셸 실행 id → 열린 게이트 */
  #open = new Map<string, OpenGate>();
  #turn: Promise<unknown> = Promise.resolve();
  constructor(o: PhoneGatePorts) {
    this.#o = o;
  }
  #now(): number {
    return (this.#o.now ?? Date.now)();
  }
  #log(result: string): void {
    this.#o.log?.('main.phone_gate', { result });
  }
  #perDay(): number {
    return Math.min(this.#o.perDay ?? REMOTE_PER_DAY, REMOTE_PER_DAY);
  }

  /** 이 폰이 지금 승인 요청을 받을 수 있는가(approve.v1 세션이 붙어 있고 받은 승인 키가 있다). cmd.ack accepted·pc_only를 가른다. */
  canApprove(pairId: string): boolean {
    return this.#sinks.has(pairId) && !!this.#o.px(pairId);
  }

  /** 오늘(한국 시간) 남은 폰 승인 수(폰 사본 todayApprovalsLeft). */
  async leftToday(): Promise<number> {
    const used = await this.#o.approvals.countOn(kstToday(this.#now()));
    return Math.max(0, this.#perDay() - used);
  }

  /** 승인 단계 이유(run.event.code). 폰 승인으로 보냈거나 폰이 시작한 실행이 아니면 undefined. */
  codeOf(shellRunId: string): PcOnlyCode | undefined {
    return this.#open.get(shellRunId)?.refusal ?? undefined;
  }

  /** approve.v1 세션이 열렸다. 이 폰에 열려 있는 게이트를 새 챌린지로 다시 보낸다. */
  attach(pairId: string, sink: GateSink): void {
    this.#sinks.set(pairId, sink);
    this.#o.attached?.(pairId);
    for (const g of this.#open.values()) {
      if (g.pairId !== pairId) continue;
      this.#stopAgain(g);
      if (!g.refusal) this.#send(g);
    }
  }
  /**
   * 세션이 닫혔다. 그 폰에 보낸 채 답이 없는 게이트가 남아 있으면, 잠깐 뒤에도 다시 안 붙을 때 approve로 깨운다.
   * 앱이 뒤로 간 직후 몇 초 동안은 세션이 살아 있어 gate.request를 받고도 사람이 못 볼 수 있다(실기기 시험 11/19).
   */
  detach(pairId: string, sink: GateSink): void {
    if (this.#sinks.get(pairId) !== sink) return;
    this.#sinks.delete(pairId);
    for (const g of this.#open.values()) {
      if (g.pairId !== pairId || g.refusal || !g.sent || g.wakes >= 2) continue;
      this.#stopAgain(g);
      g.again = (this.#o.timers ?? systemTimers).set(() => {
        g.again = null;
        if (this.#open.get(g.shellRunId) === g && !g.refusal && !this.#sinks.has(g.pairId)) this.#wakeApprove(g);
      }, WAKE_DETACHED_MS);
    }
  }

  /**
   * 엔진이 게이트를 열었다(main 'gate'). 폰이 시작한 실행이면 맡아서 true를 돌려준다(폰으로 보냈든, 이유를 달아 PC에 남겼든).
   * 폰이 시작한 실행이 아니면 아무것도 하지 않고 false.
   */
  async offer(shellRunId: string, req: GateRequest, on: GateHandlers): Promise<boolean> {
    const t = this.#o.tracked(shellRunId);
    if (!t) return false;
    const g: OpenGate = { shellRunId, req, pairId: t.pairId, runId: t.runId, reqId: ulid(this.#now()), on, refusal: null, pending: null, badSigs: 0, sent: false, wakes: 0, again: null };
    const prev = this.#open.get(shellRunId);
    if (prev) this.#stopAgain(prev);
    this.#open.set(shellRunId, g);
    g.refusal = await this.#refusal(g);
    // 기다리는 동안 닫혔거나(PC 승인·중지) 새 게이트로 바뀌었으면 보내지 않는다
    if (this.#open.get(shellRunId) !== g) return true;
    if (g.refusal) this.#log(g.refusal);
    else {
      this.#send(g);
      if (!this.#sinks.has(g.pairId)) this.#wakeApprove(g);
    }
    this.#o.poke(shellRunId);
    return true;
  }

  /** 폰으로 보낼 수 있는 게이트인데 그 폰 세션이 없다: 깨우고, 60초 뒤에도 안 붙었으면 한 번 더(ADR-053 결정 2). */
  #wakeApprove(g: OpenGate): void {
    if (!this.#o.wake || g.wakes >= 2) return;
    g.wakes++;
    this.#o.wake(g.pairId, 'approve');
    if (g.wakes >= 2) return;
    g.again = (this.#o.timers ?? systemTimers).set(() => {
      g.again = null;
      if (this.#open.get(g.shellRunId) === g && !g.refusal && !this.#sinks.has(g.pairId)) this.#wakeApprove(g);
    }, WAKE_APPROVE_AGAIN_MS);
  }

  #stopAgain(g: OpenGate): void {
    if (g.again === null) return;
    (this.#o.timers ?? systemTimers).clear(g.again);
    g.again = null;
  }

  #drop(g: OpenGate): void {
    this.#stopAgain(g);
    if (this.#open.get(g.shellRunId) === g) this.#open.delete(g.shellRunId);
  }

  async #refusal(g: OpenGate): Promise<PcOnlyCode | null> {
    if (!this.#o.px(g.pairId)) return 'pc_key';
    const why = remotePresenceRefusal(g.req);
    if (why === 'first') return 'pc_first';
    if (why) return 'pc_only';
    // PC 승인 바와 같은 검사: 값 대조(해시)와 무장 검사(빠진 값·쓸 수 없는 문자). 바가 무장하지 않을 카드는 폰에도 보내지 않는다.
    if (gateSelfCheck(g.req) !== null || !Array.isArray(summarize(g.req, kstToday(this.#now())))) return 'pc_only';
    if (!STEP_REF.test(g.req.gateStepId) || !ULID.test(g.req.cardHashInputs.intentId)) return 'pc_only';
    if ((await this.#o.approvals.countOn(kstToday(this.#now()))) >= this.#perDay()) return 'pc_limit';
    return null;
  }

  #send(g: OpenGate): void {
    const sink = this.#sinks.get(g.pairId);
    if (!sink) {
      g.pending = null;
      return;
    }
    const challenge = (this.#o.random ?? ((n: number) => new Uint8Array(randomBytes(n))))(32);
    const exp = this.#now() + PHONE_GATE_TTL_MS;
    const body: GateRequestBody = {
      runId: g.runId,
      stepId: g.req.gateStepId,
      reqId: g.reqId,
      cardId: 'invoice.confirm',
      gateKind: 'commit',
      effects: ['issue_document', 'send'],
      fields: g.req.fields.map((f) => ({ key: f.fieldKey, value: f.value })),
      cardHashInputs: g.req.cardHashInputs,
      actionHash: g.req.actionHash,
      requiredSigAlg: 'p256',
      challenge: b64(challenge),
      exp,
    };
    try {
      sink.send('gate.request', body);
      g.pending = { challenge, exp };
      g.sent = true;
      this.#log('sent');
    } catch {
      // 봉투 규칙에 맞지 않는 값(너무 긴 칸 등)이거나 채널이 닫혔다. 다음 세션에서 다시 보낸다.
      g.pending = null;
      this.#log('send_failed');
    }
  }

  /** 폰이 새 챌린지를 청했다(120초가 지났다). 게이트가 아직 열려 있을 때만 다시 보낸다. */
  refresh(pairId: string, body: GateRefreshBody): void {
    const g = [...this.#open.values()].find((x) => x.pairId === pairId && x.reqId === body.reqId && x.runId === body.runId);
    if (!g || g.refusal) return;
    this.#send(g);
  }

  /**
   * 게이트가 닫혔다(PC에서 승인·중지, 대기 만료, 실행 끝). 그 뒤의 폰 답은 받지 않는다.
   * 폰에 보낸 게이트였으면 gate.resolved로 알려 폰 승인 시트를 바로 닫게 한다(다음 run.event를 기다리지 않게).
   * 폰이 지금 붙어 있지 않으면 보내지 않는다: 다시 붙으면 attach가 닫힌 게이트를 다시 보내지 않고, 진행은 run.event로 안다.
   */
  close(shellRunId: string, gateReqId?: string, by: GateResolvedBy = 'pc'): void {
    const g = this.#open.get(shellRunId);
    if (!g || (gateReqId !== undefined && g.req.reqId !== gateReqId)) return;
    this.#drop(g);
    if (g.sent) this.#resolved(g, by);
  }

  #resolved(g: OpenGate, by: GateResolvedBy): void {
    const sink = this.#sinks.get(g.pairId);
    if (!sink) return;
    try {
      sink.send('gate.resolved', { runId: g.runId, reqId: g.reqId, by });
      this.#log(`resolved_${by}`);
    } catch {
      this.#log('resolved_send_failed');
    }
  }

  /** 폰의 답(gate.response). 한 번에 하나씩 판정한다(같은 답이 두 번 와도 한 번만 승인). */
  answer(pairId: string, body: GateResponseBody): Promise<AnswerResult> {
    const turn = this.#turn.then(() => this.#answer(pairId, body));
    this.#turn = turn.catch(() => undefined);
    return turn.then((r) => {
      this.#log(r);
      return r;
    });
  }

  async #answer(pairId: string, body: GateResponseBody): Promise<AnswerResult> {
    const g = [...this.#open.values()].find((x) => x.pairId === pairId && x.reqId === body.reqId);
    if (!g || g.refusal || !g.pending) return 'no_request';
    if (body.runId !== g.runId || body.stepId !== g.req.gateStepId) return 'wrong_gate';
    if (body.sigAlg !== 'p256') return 'sig_alg';
    if (body.actionHash !== g.req.actionHash) return 'wrong_action';
    const now = this.#now();
    if (now > g.pending.exp) return 'expired';
    const key = this.#o.px(pairId);
    if (!key) {
      g.refusal = 'pc_key';
      g.pending = null;
      this.#o.poke(g.shellRunId);
      return 'no_key';
    }
    const input = { pairId, reqId: g.reqId, challenge: g.pending.challenge, actionHash: g.req.actionHash, decision: body.decision };
    let sig: Uint8Array;
    try {
      approveMessage(input);
      sig = fromB64(body.sig);
    } catch {
      sig = new Uint8Array(0);
    }
    if (!verifyApprove(key.pub, input, sig)) {
      if (++g.badSigs >= BAD_SIG_MAX) {
        g.refusal = 'pc_only';
        g.pending = null;
        this.#o.poke(g.shellRunId);
      }
      return 'bad_sig';
    }
    // 여기부터 챌린지는 쓴 것이다(1회용)
    const challenge = g.pending.challenge;
    g.pending = null;
    if (body.decision === 'deny') {
      this.#drop(g);
      this.#resolved(g, 'phone');
      await g.on.deny();
      return 'denied';
    }
    const day = kstToday(now);
    if ((await this.#o.approvals.countOn(day)) >= this.#perDay()) {
      g.refusal = 'pc_limit';
      this.#o.poke(g.shellRunId);
      return 'limit';
    }
    // 기다리는 동안 PC가 먼저 승인·중지했으면 이 답은 버린다
    if (this.#open.get(g.shellRunId) !== g) return 'no_request';
    try {
      await this.#o.approvals.put({ at: now, day, pairId, deviceId: key.deviceId, reqId: g.reqId, gateReqId: g.req.reqId, actionHash: g.req.actionHash, sig: b64(sig), challenge: b64(challenge) });
    } catch {
      g.refusal = 'pc_only';
      this.#o.poke(g.shellRunId);
      return 'log_failed';
    }
    if (this.#open.get(g.shellRunId) !== g) return 'no_request';
    this.#drop(g);
    this.#resolved(g, 'phone');
    await g.on.approve();
    return 'approved';
  }
}
