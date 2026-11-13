// 실행 이력(2026-11-11 리허설 F-05·F-06): 재시작 뒤에도 셸이 활동 기록·결과 카드·"지난번 실행" 안내를 다시 그릴 수 있게 DB에서 모은다.
// 원천: runs(상태·시각, 기동 때 interrupted), run_events(run.ended 상태·코드, gate.*), irreversible_log(원장 상태·승인번호 verify_ref),
// documents(run_id = 실행이 보관한 발급 PDF), runs.inputs_json_enc(실행 입력 요약: 거래처 id·공급가·세액, 컬럼 키로 봉인).
// 거래처 이름은 지금 장부에서 읽는다(지운 거래처면 null). 저널·로그에는 이 값들을 쓰지 않는다(⑦). main 전용 조회다(셸 렌더러로 그대로 가지 않는다).
import type { ColumnCipher, Db } from '@sax/db';

/** 실행 입력 요약(runs.inputs_json_enc). 값이라 봉인한다. 품목·이메일은 두지 않는다(카드를 다시 그리는 데 필요한 것만). */
export interface RunInputsSummary {
  counterpartyId: string;
  supply: number;
  tax: number;
}

export interface RunHistoryRow {
  runId: string;
  playbookId: string;
  /** runs.status: running | success | completed_with_issues | failed | handoff | stopped | expired | in_doubt | interrupted */
  status: string;
  /** run.ended 코드(없으면 null). interrupted는 run.ended가 없다. */
  code: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 이 실행의 마지막 원장 상태(비가역 스텝을 무장한 적이 없으면 null). */
  ledger: string | null;
  /** 발급목록으로 확인한 승인번호(committed). */
  approvalNo: string | null;
  /** 받는 사람 메일 발송을 확인했는가(run.ended mailConfirmed). 기록이 없는 옛 실행은 null. */
  mailConfirmed: boolean | null;
  /** 이 실행이 보관한 발급 PDF(보관함 문서 id). */
  documentId: string | null;
  /** 게이트 요청까지 갔다(승인 카드가 떴다). */
  gated: boolean;
  /** 입력 요약을 읽지 못하면(옛 실행·키 다름) 셋 다 null. */
  counterpartyId: string | null;
  counterpartyName: string | null;
  supply: number | null;
  tax: number | null;
}

const aad = (runId: string) => `runs.inputs_json_enc|${runId}`;

/** 실행 입력 요약을 봉인해 runs 행에 둔다. 행이 없으면 아무것도 하지 않는다. */
export function recordRunInputs(db: Db, cipher: ColumnCipher, runId: string, s: RunInputsSummary): void {
  if (typeof s.counterpartyId !== 'string' || !Number.isSafeInteger(s.supply) || !Number.isSafeInteger(s.tax)) return;
  const blob = cipher.seal(JSON.stringify({ v: 1, counterpartyId: s.counterpartyId, supply: s.supply, tax: s.tax }), aad(runId));
  db.prepare('UPDATE runs SET inputs_json_enc = ? WHERE id = ?').run(blob, runId);
}

function openInputs(cipher: ColumnCipher | null, runId: string, blob: unknown): RunInputsSummary | null {
  if (!cipher || !(blob instanceof Uint8Array) || blob.length === 0) return null;
  try {
    const o = JSON.parse(cipher.open(blob, aad(runId))) as Partial<RunInputsSummary> & { v?: number };
    if (o.v !== 1 || typeof o.counterpartyId !== 'string' || !Number.isSafeInteger(o.supply) || !Number.isSafeInteger(o.tax)) return null;
    return { counterpartyId: o.counterpartyId, supply: o.supply!, tax: o.tax! };
  } catch {
    return null;
  }
}

export const RUN_HISTORY_MAX = 200;

/** 최근 실행부터 limit건(기본 50, 상한 200). 예행(run.rehearsal)은 발급 이력이 아니라서 뺀다. */
export function runHistory(db: Db, cipher: ColumnCipher | null, limit = 50): RunHistoryRow[] {
  const n = Math.max(1, Math.min(RUN_HISTORY_MAX, Number.isInteger(limit) ? limit : 50));
  const runs = db
    .prepare(`SELECT id, playbook_id, status, started_at, finished_at, inputs_json_enc FROM runs WHERE id NOT IN (SELECT run_id FROM run_events WHERE type = 'run.rehearsal') ORDER BY started_at DESC, rowid DESC LIMIT ?`)
    .all(n) as Array<Record<string, unknown>>;
  const ended = db.prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'run.ended' ORDER BY seq DESC LIMIT 1`).pluck();
  const gated = db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND type = 'gate.requested' LIMIT 1`).pluck();
  const ledger = db.prepare('SELECT state, verify_ref FROM irreversible_log WHERE run_id = ? ORDER BY armed_at DESC, attempt DESC, rowid DESC LIMIT 1');
  const doc = db.prepare('SELECT id FROM documents WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').pluck();
  const cpName = db.prepare('SELECT name FROM counterparties WHERE id = ?').pluck();
  return runs.map((r) => {
    const runId = String(r.id);
    let code: string | null = null;
    let mailConfirmed: boolean | null = null;
    const p = ended.get(runId);
    if (typeof p === 'string') {
      try {
        const e = JSON.parse(p) as { code?: unknown; mailConfirmed?: unknown };
        code = typeof e.code === 'string' && e.code ? e.code : null;
        mailConfirmed = typeof e.mailConfirmed === 'boolean' ? e.mailConfirmed : null;
      } catch {
        code = null;
      }
    }
    const l = ledger.get(runId) as { state: string; verify_ref: string | null } | undefined;
    const inputs = openInputs(cipher, runId, r.inputs_json_enc);
    const name = inputs ? cpName.get(inputs.counterpartyId) : undefined;
    const d = doc.get(runId);
    return {
      runId,
      playbookId: String(r.playbook_id),
      status: String(r.status),
      code,
      startedAt: String(r.started_at),
      finishedAt: r.finished_at ? String(r.finished_at) : null,
      ledger: l?.state ?? null,
      approvalNo: l?.state === 'committed' && l.verify_ref ? l.verify_ref : null,
      mailConfirmed,
      documentId: typeof d === 'string' ? d : null,
      gated: gated.get(runId) !== undefined,
      counterpartyId: inputs?.counterpartyId ?? null,
      counterpartyName: typeof name === 'string' ? name : null,
      supply: inputs?.supply ?? null,
      tax: inputs?.tax ?? null,
    };
  });
}
