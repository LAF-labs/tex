import type { RunHistoryRow } from '@sax/engine';
import type { LogFields } from '@sax/platform';
import { NOTE, UNKNOWN_STOP_NOTE } from './shell-runs.ts';

export type PastKind = 'issued' | 'unsure' | 'not_issued' | 'stopped_before_gate';

export interface PastRun {
  runId: string;
  kind: PastKind;
  who: string | null;
  supply: number | null;
  tax: number | null;
  total: number | null;
  day: string | null;
  time: string | null;
  approvalNo: string | null;
  documentId: string | null;
  mail: 'sent' | 'unconfirmed' | null;
  note: string | null;
}

export const INVOICE_PLAYBOOK = 'hometax.invoice.issue';

const UNSURE_TEXT = '발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 발급하지 마세요.';
const STOPPED_BEFORE_GATE_TEXT = '승인 전에 앱이 꺼져 멈췄어요. 아무것도 발급하지 않았어요.';
const NOT_COMMITTED_TEXT = '발급되지 않은 것으로 판정됐어요. 홈택스에는 아무것도 발급되지 않았어요.';
const INTERRUPTED_TEXT = '앱이 꺼져 멈췄어요. 아무것도 발급하지 않았어요.';

const AFTER_COMMIT = new Set(['mail.not_confirmed', 'save_pdf.failed', 'portal.blocked_after_commit', 'post_commit.error']);

const BY_LEDGER: Record<string, { kind: PastKind; note: (code: string | null) => string | null }> = {
  committed: { kind: 'issued', note: (c) => (c && AFTER_COMMIT.has(c) ? NOTE[c]! : null) },
  in_doubt: { kind: 'unsure', note: () => UNSURE_TEXT },
  armed: { kind: 'unsure', note: () => UNSURE_TEXT },
  dispatched: { kind: 'unsure', note: () => UNSURE_TEXT },
  observed_manual: { kind: 'unsure', note: () => UNSURE_TEXT },
  not_committed: { kind: 'not_issued', note: () => NOT_COMMITTED_TEXT },
};

function beforeArm(row: RunHistoryRow): { kind: PastKind; note: string } {
  if (row.status === 'interrupted') return row.gated ? { kind: 'stopped_before_gate', note: STOPPED_BEFORE_GATE_TEXT } : { kind: 'not_issued', note: INTERRUPTED_TEXT };
  return { kind: 'not_issued', note: (row.code && NOTE[row.code]) || UNKNOWN_STOP_NOTE };
}

const KST_MS = 9 * 3_600_000;

export function pastRun(row: RunHistoryRow): PastRun {
  const by = row.ledger === null ? null : (BY_LEDGER[row.ledger] ?? BY_LEDGER.in_doubt!);
  const { kind, note } = by ? { kind: by.kind, note: by.note(row.code) } : beforeArm(row);
  const ms = Date.parse(row.startedAt);
  const kst = Number.isFinite(ms) ? new Date(ms + KST_MS).toISOString() : null;
  return {
    runId: row.runId,
    kind,
    who: row.counterpartyName,
    supply: row.supply,
    tax: row.tax,
    total: row.supply !== null && row.tax !== null ? row.supply + row.tax : null,
    day: kst?.slice(0, 10) ?? null,
    time: kst?.slice(11, 16) ?? null,
    approvalNo: kind === 'issued' ? row.approvalNo : null,
    documentId: kind === 'issued' ? row.documentId : null,
    mail: kind === 'issued' ? (row.mailConfirmed === true ? 'sent' : row.mailConfirmed === false ? 'unconfirmed' : null) : null,
    note,
  };
}

export function pastRuns(rows: readonly RunHistoryRow[], onBad: (runId: unknown) => void = () => {}): PastRun[] {
  const out: PastRun[] = [];
  for (const r of rows) {
    try {
      if (r.playbookId === INVOICE_PLAYBOOK) out.push(pastRun(r));
    } catch {
      onBad(r?.runId);
    }
  }
  return out;
}

export async function readPastRuns(rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>, logEvent: (name: string, data: LogFields) => void, limit = 50): Promise<PastRun[]> {
  try {
    const r = await rpc('db.query.runs.history', { limit });
    return pastRuns(Array.isArray(r) ? (r as RunHistoryRow[]) : [], () => logEvent('main.past_row_skipped', {}));
  } catch (e) {
    logEvent('main.past_failed', { error: String((e as Error)?.message ?? e).slice(0, 80) });
    return [];
  }
}
