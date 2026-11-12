// 칸이 끝난 뒤의 판정(D03 §4.2): 실행의 자기 보고가 아니라 같은 발급 키의 원장 행으로 정한다. Verdict는 이 모듈만 만든다.
import type { LedgerRow, LedgerState } from '@sax/db';
import { branchOf } from './routes.ts';
import type { AttemptEnd, IssueRows, RouteId, Verdict } from './types.ts';

export const API_PLAYBOOK = 'api.taxinvoice.issue@1';
export const MANUAL_PLAYBOOK = 'hometax.taxinvoice.manual@1';

/** 원장 행이 어느 칸에서 생겼는지(플레이북 id로). */
export function routeOfRow(r: LedgerRow): RouteId {
  if (r.playbookId === API_PLAYBOOK) return 'api';
  if (r.playbookId === MANUAL_PLAYBOOK) return 'hometax.manual';
  return 'hometax.auto';
}

type Open = Exclude<LedgerState, 'committed' | 'not_committed'>;

export function verdictOf(rows: IssueRows, end: AttemptEnd, routeOf: (r: LedgerRow) => RouteId | null = routeOfRow): Verdict {
  const committed = rows.find((r) => r.state === 'committed');
  if (committed) return { kind: 'issued', route: routeOf(committed), ref: committed.verifyRef } as Verdict;
  const open = rows.find((r) => r.state !== 'not_committed');
  if (open) return { kind: 'held', state: open.state as Open } as Verdict;
  const code = end.code ?? 'issue.end_without_code';
  return { kind: 'not_issued', branch: branchOf(code, end.stoppedAtStep), code } as Verdict;
}
