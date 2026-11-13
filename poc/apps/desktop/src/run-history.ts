// 지난 실행(재시작 뒤 활동 기록, U5): 엔진 실행 이력(db.query.runs.history, main 전용)을 사장님 눈의 상태 하나로 바꾼다.
// 판정은 원장이 먼저다. 원장이 발급 여부의 근거이기 때문이다. 화면은 kind와 note만 본다(끝 코드는 보이지 않는다).
import type { RunHistoryRow } from '@sax/engine';
import type { LogFields } from '@sax/platform';
import { NOTE, UNKNOWN_STOP_NOTE } from './shell-runs.ts';

export type PastKind = 'issued' | 'unsure' | 'not_issued' | 'stopped_before_gate';

/** 렌더러로 가는 지난 실행 한 건. 화면이 그리는 데 필요한 것만 둔다. */
export interface PastRun {
  runId: string;
  kind: PastKind;
  /** 거래처 이름(지운 거래처·입력 요약을 못 읽으면 null). */
  who: string | null;
  supply: number | null;
  tax: number | null;
  total: number | null;
  /** 시작 시각의 KST 날짜 YYYY-MM-DD와 시각 HH:MM. 이력의 시각을 읽지 못하면 null(화면은 "시각 모름"). */
  day: string | null;
  time: string | null;
  approvalNo: string | null;
  /** 보관함 문서 id([PDF 열기]). */
  documentId: string | null;
  /** 발급된 건의 받는 사람 메일: 보냄 확인·확인 못 함. 발급 안 된 건·기록 없는 옛 실행은 null(B5 문서함). */
  mail: 'sent' | 'unconfirmed' | null;
  /** 사용자 문구. 없으면 null. */
  note: string | null;
}

/** 활동 기록에 남기는 실행: 세금계산서 발급(H-01)만. */
export const INVOICE_PLAYBOOK = 'hometax.invoice.issue';

export const UNSURE_TEXT = '발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 발급하지 마세요.';
export const STOPPED_BEFORE_GATE_TEXT = '승인 전에 앱이 꺼져 멈췄어요. 아무것도 발급하지 않았어요.';
export const NOT_COMMITTED_TEXT = '발급되지 않은 것으로 판정됐어요. 홈택스에는 아무것도 발급되지 않았어요.';
export const INTERRUPTED_TEXT = '앱이 꺼져 멈췄어요. 아무것도 발급하지 않았어요.';

/** 발급된 실행에 붙이는 끝 코드(발급 뒤 단계의 일). 그 밖의 코드 문구는 "발급하지 않았어요"일 수 있어 발급된 실행에 붙이지 않는다. */
const AFTER_COMMIT = new Set(['mail.not_confirmed', 'save_pdf.failed', 'portal.blocked_after_commit', 'post_commit.error']);

/** 원장 상태 → 종류. 표에 없는 상태(새 상태)는 안전한 쪽(unsure)으로 본다. armed·dispatched·observed_manual은 기동 때 in_doubt로 오른다. */
const BY_LEDGER: Record<string, { kind: PastKind; note: (code: string | null) => string | null }> = {
  committed: { kind: 'issued', note: (c) => (c && AFTER_COMMIT.has(c) ? NOTE[c]! : null) },
  in_doubt: { kind: 'unsure', note: () => UNSURE_TEXT },
  armed: { kind: 'unsure', note: () => UNSURE_TEXT },
  dispatched: { kind: 'unsure', note: () => UNSURE_TEXT },
  observed_manual: { kind: 'unsure', note: () => UNSURE_TEXT },
  not_committed: { kind: 'not_issued', note: () => NOT_COMMITTED_TEXT },
};

/** 원장이 없다(비가역 단계를 무장한 적 없음 = 발급 요청을 보낸 적 없음). */
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

/** 이력(최근 순) → 활동 기록의 지난 실행. 세금계산서 발급 실행만 남긴다. 바꾸지 못한 줄(망가진 행)은 건너뛴다. 한 줄 때문에 앱이 열리지 않으면 안 된다. */
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

/**
 * 기동 때 지난 실행을 읽는다(엔진 db.query.runs.history, main 전용, 최근 50건). 무엇이 틀려도 던지지 않는다:
 * 이력을 못 읽으면(db_not_ready 등) 빈 목록, 망가진 줄은 그 줄만 빼고 기록한다(값 없이 사유만).
 */
export async function readPastRuns(rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>, logEvent: (name: string, data: LogFields) => void): Promise<PastRun[]> {
  try {
    const r = await rpc('db.query.runs.history', { limit: 50 });
    return pastRuns(Array.isArray(r) ? (r as RunHistoryRow[]) : [], () => logEvent('main.past_row_skipped', {}));
  } catch (e) {
    logEvent('main.past_failed', { error: String((e as Error)?.message ?? e).slice(0, 80) });
    return [];
  }
}
