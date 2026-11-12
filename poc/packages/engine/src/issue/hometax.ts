// 발급 사다리의 홈택스 칸 둘(D03 §4.2): 자동(H-01 실행)과 직접(사장님이 홈택스에서 발급하고 알려 준다).
import { LedgerError, Ledger, RunJournal, RunRepo, type Db } from '@sax/db';
import { RunEnd } from '../run-end.ts';
import { ulid, type RunEvent, type RunService } from '../runs.ts';
import { routeSpec } from './routes.ts';
import type { AttemptEnd, IssueRequest, Rung } from './types.ts';
import { MANUAL_PLAYBOOK } from './verdict.ts';

export const errorCode = (e: unknown): string => (e instanceof RunEnd || e instanceof LedgerError ? e.code : 'engine.error');

/**
 * H-01 실행 하나를 끝까지 기다린다. 발급 여부는 사다리가 원장으로 본다.
 * 사람 대기에서 [직접 발급함](run.manualDone)을 눌렀는데 이 키의 원장 행이 없으면(IR 조율기의 ledger.observed_manual 효과는
 * 무장 전이라 원장 행을 만들지 못한다) 직접 발급 행을 남긴다. 그러지 않으면 사다리가 "행 없음"으로 보고 다음 길로 갈 수 있다.
 */
export function hometaxAutoRung(runs: RunService, db: Db): Rung {
  const manual = manualRecorder(runs, db);
  return {
    route: routeSpec('hometax.auto'),
    available: () => ({ ok: true }),
    run: (req) =>
      new Promise<AttemptEnd>((resolve) => {
        const runId = `issue-${ulid()}`;
        const onEvent = (e: RunEvent) => {
          if (e.runId !== runId || e.type !== 'end') return;
          runs.off('event', onEvent);
          const end: AttemptEnd = { ...(e.code ? { code: e.code } : {}), ...(e.stoppedAt ? { stoppedAtStep: e.stoppedAt.stepId } : {}) };
          if (runs.inspect(runId).journal.includes('run.manual_done_requested')) return resolve(manual(req, 'issue.manual_attested'));
          resolve(end);
        };
        runs.on('event', onEvent);
        try {
          runs.start({ runId, issueKey: req.issueKey, counterpartyId: req.counterpartyId, supply: req.supply, tax: req.tax, itemName: req.itemName, ...(req.email !== undefined ? { email: req.email } : {}) });
        } catch (e) {
          runs.off('event', onEvent);
          resolve({ code: errorCode(e) });
        }
      }),
  };
}

/**
 * 사장님이 홈택스에서 직접 발급한다. [발급했어요]면 원장 observed_manual(발급목록 대조 전까지 사다리는 멈춘다),
 * [못 해요]면 다음 칸.
 */
export function hometaxManualRung(runs: RunService, db: Db): Rung {
  const manual = manualRecorder(runs, db);
  return {
    route: routeSpec('hometax.manual'),
    available: () => ({ ok: true }),
    run: async (req, io) => {
      const answer = await io.askHuman();
      if (answer === 'cannot') return { code: 'issue.manual_declined' };
      return manual(req, 'issue.manual_reported');
    },
  };
}

/** 직접 발급 행(manual.issue, observed_manual). 같은 키에 이미 발급됨·미종결 행이 있으면 그 행이 판정하므로 쓰지 않는다. */
function manualRecorder(runs: RunService, db: Db): (req: IssueRequest, code: string) => AttemptEnd {
  const repo = new RunRepo(db);
  const ledger = new Ledger(db);
  const journal = new RunJournal(db);
  return (req, code) => {
    if (ledger.byIssueKey(req.issueKey).some((r) => r.state !== 'not_committed')) return { code };
    const runId = `issue-${ulid()}`;
    try {
      const p = runs.prepareIssue(req, { runId, stepId: 'manual.issue', playbookId: MANUAL_PLAYBOOK });
      repo.create({ id: runId, playbookId: MANUAL_PLAYBOOK, playbookVersion: '1', packageDigest: p.row.packageDigest, profileId: p.profileId, trigger: 'local', inputsHash: p.row.inputsHash });
      journal.append(runId, 'issue.rung', { issueKey: req.issueKey, rung: 'hometax.manual' });
      ledger.observedManual(p.row);
      journal.append(runId, 'ledger.observed_manual');
      repo.finish(runId, 'handoff');
      return { code };
    } catch (e) {
      if (repo.status(runId) === 'running') repo.finish(runId, 'failed');
      return { code: errorCode(e) };
    }
  };
}
