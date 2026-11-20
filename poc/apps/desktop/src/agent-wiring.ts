import type { ReactionId, RouteStep, ScreenFrame, StepParams, StepResult } from '@sax/engine';
import { kstToday } from './approval-gate.ts';
import type { AgentChatPorts, AgentPhase, CashFlowValues, DraftCard, DraftExtraValues, DraftPatch, IssuedRow, OpenScreen, ReceivableRow } from './agent-chat.ts';
import { INVOICE_PLAYBOOK } from './run-history.ts';
import type { Vat } from '@sax/chat-core';
import type { Counterparty, RunView } from './shell-model.ts';

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

export const AGENT_HISTORY_LIMIT = 200;

export interface AgentRuns {
  list(): RunView[];
  readonly counterparties: Counterparty[];
  createDraft(cp: Counterparty, amount: number, vat: Vat | null, item?: string | null, extra?: DraftExtraValues): RunView;
  updateDraft(id: string, patch: DraftPatch): RunView;
  discardDraft(id: string): RunView;
}

interface AgentWiring {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  profileId(): string | null;
  runs: AgentRuns;
  setupMissing(): boolean;
  onCreated(run: RunView): void;
  onProgress(phase: AgentPhase): void;
  route?: boolean;
  onReaction?(reaction: ReactionId): void;
  openScreen?(screen: OpenScreen): void;
  receivables?: () => Promise<ReceivableRow[] | null>;
  payables?: () => Promise<ReceivableRow[] | null>;
  cashFlow?: (month: string) => Promise<CashFlowValues | null>;
  pastIssued?: () => IssuedRow[];
  now?: () => number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

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
