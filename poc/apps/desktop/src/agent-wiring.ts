// 대화 에이전트 배선(결정안 §14, PR-B): shell-app의 실행·장부·엔진을 AgentChat 포트로 좁힌다.
// - 초안 포트에는 준비·발급이 없다. 여기서도 runs.prepare를 부르지 않는다(발급은 카드 버튼 IPC 하나뿐).
// - 발급 기록은 엔진 원장(db.query.runs.history) 중 승인번호가 있는 실행만이다. 값은 main 안에서만 쓰고 모델에 가지 않는다(C-10).
// - 받을 돈은 #284(BankHost.receivables()) 전에는 null(계좌 연결 전)이다.
import type { ReactionId, RouteStep, ScreenFrame, StepParams, StepResult } from '@sax/engine';
import { kstToday } from './approval-gate.ts';
import type { AgentChatPorts, AgentPhase, CashFlowValues, DraftCard, DraftExtraValues, DraftPatch, IssuedRow, OpenScreen, ReceivableRow } from './agent-chat.ts';
import { INVOICE_PLAYBOOK } from './run-history.ts';
import type { Counterparty, RunView, VatMode } from './shell-model.ts';

/** 엔진 db.query.runs.history 한 행에서 쓰는 칸(run-history.ts RunHistoryRow) */
interface HistoryRow {
  playbookId: string;
  approvalNo: string | null;
  documentId?: string | null;
  mailConfirmed?: boolean | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  supply: number | null;
  tax: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 원장 발급 이력 상한(엔진 RUN_HISTORY_MAX와 같다) */
export const AGENT_HISTORY_LIMIT = 200;

export interface AgentRuns {
  list(): RunView[];
  readonly counterparties: Counterparty[];
  createDraft(cp: Counterparty, amount: number, vat: VatMode | null, item?: string | null, extra?: DraftExtraValues): RunView;
  updateDraft(id: string, patch: DraftPatch): RunView;
  discardDraft(id: string): RunView;
}

export interface AgentWiring {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  profileId(): string | null;
  runs: AgentRuns;
  setupMissing(): boolean;
  /** 대화가 만든 초안. 해석 출처를 적고 이번 달 판을 다시 그린다. */
  onCreated(run: RunView): void;
  onProgress(phase: AgentPhase): void;
  /** 판정을 부르는가(ADR-057). false면 chat.route를 부르지 않는다(판정 없는 시험·시연). */
  route?: boolean;
  /** 사용자 말풍선 반응(턴 이벤트 reaction) */
  onReaction?(reaction: ReactionId): void;
  /** 대화가 고른 앱 안 화면을 연다(open_screen) */
  openScreen?(screen: OpenScreen): void;
  receivables?: () => Promise<ReceivableRow[] | null>;
  /** 낼 돈·돈 흐름(11 §2·§3). 없으면 계좌 연결 전(not_set_up) */
  payables?: () => Promise<ReceivableRow[] | null>;
  cashFlow?: (month: string) => Promise<CashFlowValues | null>;
  /** 원장 밖의 지난 발급(시연 씨앗 이력). 제품은 없다. */
  pastIssued?: () => IssuedRow[];
  now?: () => number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** 원장 이력 → 발급 행. 승인번호가 있는(발급이 확정된) 세금계산서 실행만(민원증명의 접수번호는 발급 기록이 아니다). 날짜는 끝난 시각의 KST 날짜. */
export function issuedRows(rows: unknown): IssuedRow[] {
  if (!Array.isArray(rows)) return [];
  return (rows as HistoryRow[])
    .filter((r) => r && r.playbookId === INVOICE_PLAYBOOK && typeof r.approvalNo === 'string' && r.approvalNo)
    .map((r) => {
      const at = Date.parse(r.finishedAt ?? r.startedAt);
      return {
        counterpartyId: typeof r.counterpartyId === 'string' ? r.counterpartyId : null,
        counterparty: typeof r.counterpartyName === 'string' ? r.counterpartyName : '이름 모름',
        date: Number.isFinite(at) ? kstToday(at) : '',
        total: isNum(r.supply) && isNum(r.tax) ? r.supply + r.tax : null,
        approvalNo: r.approvalNo,
        documentId: typeof r.documentId === 'string' ? r.documentId : null,
        mail: r.mailConfirmed === true ? ('sent' as const) : r.mailConfirmed === false ? ('unconfirmed' as const) : null,
      };
    })
    .filter((r) => r.date);
}

export function draftCard(r: RunView): DraftCard {
  return { runId: r.id, counterpartyId: r.counterparty.id, amount: r.amount, vat: r.vatGuessed ? null : r.vat, item: r.item.trim() ? r.item : null, status: r.status };
}

export function agentPorts(w: AgentWiring): AgentChatPorts {
  return {
    step: (p: StepParams) => w.rpc('chat.step', p as unknown as Record<string, unknown>) as Promise<StepResult>,
    ...(w.route === false ? {} : { route: (p: { text: string; frame: ScreenFrame; profileId: string }) => w.rpc('chat.route', p as unknown as Record<string, unknown>) as Promise<RouteStep> }),
    ...(w.onReaction ? { onReaction: w.onReaction } : {}),
    profileId: () => w.profileId(),
    drafts: {
      list: () => w.runs.list().filter((r) => r.status === 'draft' && !r.cert).map(draftCard),
      setupMissing: () => w.setupMissing(),
      create: (counterpartyId, amount, vat, item, extra) => {
        if (w.setupMissing()) return { setup: true };
        const cp = w.runs.counterparties.find((c) => c.id === counterpartyId);
        if (!cp) throw new Error('no_counterparty');
        const run = extra ? w.runs.createDraft(cp, amount, vat, item, extra) : w.runs.createDraft(cp, amount, vat, item);
        w.onCreated(run);
        return { runId: run.id };
      },
      update: (runId, patch) => void w.runs.updateDraft(runId, patch),
      discard: (runId) => void w.runs.discardDraft(runId),
    },
    issued: async () => [...issuedRows(await w.rpc('db.query.runs.history', { limit: AGENT_HISTORY_LIMIT })), ...(w.pastIssued?.() ?? [])],
    receivables: w.receivables ?? (async () => null),
    payables: w.payables ?? (async () => null),
    cashFlow: w.cashFlow ?? (async () => null),
    counterparties: () => w.runs.counterparties.map((c) => ({ id: c.id, name: c.name, item: c.item.trim() ? c.item : null })),
    today: () => kstToday(w.now?.() ?? Date.now()),
    onProgress: (phase) => w.onProgress(phase),
    ...(w.openScreen ? { openScreen: w.openScreen } : {}),
    ...(w.now ? { now: w.now } : {}),
  };
}
