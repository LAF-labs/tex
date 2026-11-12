// 발급 사다리의 홈택스 칸 둘(D03 §4.2): 자동(H-01 실행)과 직접(사장님이 홈택스에서 발급하고 알려 준다).
import { LedgerError, Ledger, RunJournal, RunRepo, type Db } from '@sax/db';
import { RunEnd } from '../run-end.ts';
import { ulid, type RunEvent, type RunService } from '../runs.ts';
import { routeSpec } from './routes.ts';
import type { AttemptEnd, Rung } from './types.ts';
import { MANUAL_PLAYBOOK } from './verdict.ts';

export const errorCode = (e: unknown): string => (e instanceof RunEnd || e instanceof LedgerError ? e.code : 'engine.error');

/** H-01 실행 하나를 끝까지 기다린다. 발급 여부는 사다리가 원장으로 본다. */
export function hometaxAutoRung(runs: RunService): Rung {
  return {
    route: routeSpec('hometax.auto'),
    available: () => ({ ok: true }),
    run: (req) =>
      new Promise<AttemptEnd>((resolve) => {
        const runId = `issue-${ulid()}`;
        const onEvent = (e: RunEvent) => {
          if (e.runId !== runId || e.type !== 'end') return;
          runs.off('event', onEvent);
          resolve({ ...(e.code ? { code: e.code } : {}), ...(e.stoppedAt ? { stoppedAtStep: e.stoppedAt.stepId } : {}) });
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
  const repo = new RunRepo(db);
  const ledger = new Ledger(db);
  const journal = new RunJournal(db);
  return {
    route: routeSpec('hometax.manual'),
    available: () => ({ ok: true }),
    run: async (req, io) => {
      const answer = await io.askHuman();
      if (answer === 'cannot') return { code: 'issue.manual_declined' };
      const runId = `issue-${ulid()}`;
      try {
        const p = runs.prepareIssue(req, { runId, stepId: 'manual.issue', playbookId: MANUAL_PLAYBOOK, irreversible: false });
        repo.create({ id: runId, playbookId: MANUAL_PLAYBOOK, playbookVersion: '1', packageDigest: p.row.packageDigest, profileId: p.profileId, trigger: 'local', inputsHash: p.row.inputsHash });
        journal.append(runId, 'issue.rung', { issueKey: req.issueKey, rung: 'hometax.manual' });
        ledger.observedManual(p.row);
        journal.append(runId, 'ledger.observed_manual');
        repo.finish(runId, 'handoff');
        return { code: 'issue.manual_reported' };
      } catch (e) {
        if (repo.status(runId) === 'running') repo.finish(runId, 'failed');
        return { code: errorCode(e) };
      }
    },
  };
}
