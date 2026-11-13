// 발급 사다리(D03 §4.2): 한 발급 키에 대해 경로 표의 칸을 차례로 돈다. 칸이 끝날 때마다 같은 키의 원장 행으로 판정하고,
// 발급됨·미종결이면 끝, 홈택스 쪽 실패(fallthrough)일 때만 다음 칸으로 간다. 유료 칸 앞에서는 사장님 동의를 기다린다.
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Ledger } from '@sax/db';
import type { EventLog } from '@sax/platform';
import { errorCode } from './hometax.ts';
import { ROUTES } from './routes.ts';
import type { AttemptEnd, ConsentCard, ConsentToken, Fallthrough, IssueKey, IssueRequest, LadderEvent, LadderState, RouteId, Rung, RungIo, Verdict } from './types.ts';
import { verdictOf } from './verdict.ts';

export interface IssueLadderDeps {
  /** 칸들. 경로 표(ROUTES) 순서로 돈다. */
  rungs: readonly Rung[];
  ledger: Pick<Ledger, 'byIssueKey'>;
  log: EventLog;
}

interface Live {
  state: LadderState;
  answerConsent: ((a: 'granted' | 'declined') => void) | null;
  answerHuman: ((a: 'issued' | 'cannot') => void) | null;
}

const isFallthrough = (v: Verdict): v is Fallthrough => v.kind === 'not_issued' && v.branch === 'fallthrough';

export class IssueLadder extends EventEmitter {
  private readonly rungs: readonly Rung[];
  private readonly ledger: IssueLadderDeps['ledger'];
  private readonly log: EventLog;
  /** 진행 중인 키(칸 실행은 키마다 동시에 하나). */
  private readonly live = new Map<IssueKey, Live>();
  private readonly last = new Map<IssueKey, LadderState>();

  constructor(d: IssueLadderDeps) {
    super();
    const order = (id: RouteId) => ROUTES.findIndex((r) => r.id === id);
    this.rungs = [...d.rungs].sort((a, b) => order(a.route.id) - order(b.route.id));
    this.ledger = d.ledger;
    this.log = d.log;
  }

  /** 발급 요청. 같은 키가 진행 중이면 그 상태, 원장에 발급됨·미종결이 있으면 그것을 돌려주고 새 시도를 만들지 않는다. */
  request(req: IssueRequest): LadderState {
    const key = req.issueKey;
    const cur = this.live.get(key);
    if (cur) return cur.state;
    const v = verdictOf(this.ledger.byIssueKey(key), {});
    if (v.kind === 'issued') return this.settle(key, { s: 'issued', route: v.route, ref: v.ref });
    if (v.kind === 'held') return this.settle(key, { s: 'held', state: v.state });
    const live: Live = { state: { s: 'running', route: this.rungs[0]?.route.id ?? 'hometax.auto' }, answerConsent: null, answerHuman: null };
    this.live.set(key, live);
    void this.drive(req, live);
    return this.state(key)!;
  }

  /** 동의 카드 답. consent 상태가 아니면 false. */
  consent(key: IssueKey, answer: 'granted' | 'declined'): boolean {
    const f = this.live.get(key)?.answerConsent;
    if (!f) return false;
    this.live.get(key)!.answerConsent = null;
    f(answer);
    return true;
  }

  /** 홈택스 직접 칸 답: [발급했어요] = issued, [못 해요] = cannot. human 상태가 아니면 false. */
  human(key: IssueKey, answer: 'issued' | 'cannot'): boolean {
    const f = this.live.get(key)?.answerHuman;
    if (!f) return false;
    this.live.get(key)!.answerHuman = null;
    f(answer);
    return true;
  }

  state(key: IssueKey): LadderState | null {
    return this.live.get(key)?.state ?? this.last.get(key) ?? null;
  }

  private emitState(key: IssueKey, state: LadderState): void {
    this.emit('state', { issueKey: key, state } satisfies LadderEvent);
  }

  private settle(key: IssueKey, state: LadderState): LadderState {
    this.live.delete(key);
    this.last.set(key, state);
    this.emitState(key, state);
    return state;
  }

  private async drive(req: IssueRequest, live: Live): Promise<void> {
    const key = req.issueKey;
    const set = (state: LadderState) => {
      live.state = state;
      this.emitState(key, state);
    };
    const tried: Array<{ route: RouteId; code: string }> = [];
    try {
      for (const rung of this.rungs) {
        const route = rung.route.id;
        const av = rung.available();
        if (!av.ok) {
          tried.push({ route, code: av.code });
          this.log.event('issue.rung_skipped', { issueKey: key, rung: route, code: av.code });
          continue;
        }
        let consent: ConsentToken | null = null;
        if (rung.route.costKrw !== 0) {
          const reasonCode = tried.at(-1)?.code ?? 'issue.first_rung';
          // 카드의 "아무것도 발급되지 않았어요"는 지금 원장으로 다시 확인한 값이다.
          const pre = verdictOf(this.ledger.byIssueKey(key), { code: reasonCode });
          if (pre.kind === 'issued') return void this.settle(key, { s: 'issued', route: pre.route, ref: pre.ref });
          if (pre.kind === 'held') return void this.settle(key, { s: 'held', state: pre.state });
          const q = rung.quote?.();
          const card: ConsentCard = {
            issueKey: key, route, provider: q?.provider ?? null, costKrw: q ? q.costKrw : rung.route.costKrw, costBasis: q?.costBasis ?? rung.route.costBasis, reasonCode, nothingIssued: true,
          };
          const answer = await new Promise<'granted' | 'declined'>((resolve) => {
            live.answerConsent = resolve;
            set({ s: 'consent', card });
          });
          this.log.event('issue.consent', { issueKey: key, rung: route, answer });
          if (answer === 'declined') return void this.settle(key, { s: 'stopped', route, code: 'issue.consent_declined' });
          consent = { issueKey: key, route, reqId: randomUUID() } as ConsentToken;
        }
        set({ s: 'running', route });
        const io: RungIo = {
          askHuman: () =>
            new Promise((resolve) => {
              live.answerHuman = resolve;
              set({ s: 'human', route });
            }),
          journal: (type, payload) => this.log.event(type, { issueKey: key, rung: route, ...payload }),
        };
        let end: AttemptEnd;
        try {
          end = await rung.run(req, io, consent);
        } catch (e) {
          end = { code: errorCode(e) };
        }
        const v = verdictOf(this.ledger.byIssueKey(key), end);
        this.log.event('issue.verdict', { issueKey: key, rung: route, verdict: v.kind, code: v.kind === 'not_issued' ? v.code : (end.code ?? '') });
        if (v.kind === 'issued') return void this.settle(key, { s: 'issued', route: v.route, ref: v.ref });
        if (v.kind === 'held') return void this.settle(key, { s: 'held', state: v.state });
        if (!isFallthrough(v)) return void this.settle(key, { s: 'stopped', route, code: v.code });
        tried.push(this.next(route, v));
      }
      this.settle(key, { s: 'exhausted', tried });
    } catch (e) {
      this.log.event('issue.ladder_error', { issueKey: key, err: (e as Error)?.name ?? 'unknown' });
      this.settle(key, { s: 'stopped', route: null, code: 'engine.error' });
    }
  }

  /** 다음 칸으로 가는 길은 원장이 "발급 안 됨 + 홈택스 쪽 실패"로 판정한 것뿐이다. */
  private next(route: RouteId, v: Fallthrough): { route: RouteId; code: string } {
    return { route, code: v.code };
  }
}
