import { PHASE_OF } from '../run/service-ir.ts';
import type { Branch, RouteId, RouteSpec } from './types.ts';

/** 표의 순서가 사다리 순서다. 무료가 먼저, API가 마지막(대표 지시 2026-11-12). 속도는 추정이다(결정안 §1). */
export const ROUTES: readonly RouteSpec[] = [
  {
    id: 'hometax.auto', kind: 'portal', costKrw: 0, costBasis: '홈택스 무료',
    speed: '3~6분(추정: 로그인 사람 차례 1~2분 + 입력 1분 + verify 하한 60초·조회 2번)',
    ownerDoes: '로그인·서명 차례, 승인 카드', needs: ['chrome', 'hometax.package'],
  },
  {
    id: 'hometax.manual', kind: 'human', costKrw: 0, costBasis: '홈택스 무료',
    speed: '10분 이상(추정, 사람이 직접 입력)',
    ownerDoes: '홈택스에서 직접 발급하고 [발급했어요] 또는 [못 해요]', needs: [],
  },
  {
    id: 'api', kind: 'api', costKrw: null, costBasis: '원천마다 다름: 팝빌 200원(웹 종량제, 파트너 원가 미확인), CODEF 미확인',
    speed: '수 초(추정, CODEF 타임아웃 200초)',
    ownerDoes: '동의 카드 [동의하고 발급]', needs: ['popbill.partner_key | codef.issue_product', 'popbill.member_cert'],
  },
];

export const routeSpec = (id: RouteId): RouteSpec => ROUTES.find((r) => r.id === id)!;

const EXACT: Readonly<Record<string, Branch | 'human_wait'>> = {
  'login.not_implemented': 'fallthrough',
  'sign.password_wrong': 'fallthrough',
  'sign.password_retry_limit': 'fallthrough',
  'sign.no_path': 'fallthrough',
  'sign.method_unknown': 'fallthrough',
  'sign.unsupported': 'fallthrough',
  'portal.logged_out_by_other_session': 'fallthrough',
  'step.selector_miss': 'fallthrough',
  'step.target_not_found': 'fallthrough',
  'step.identity_mismatch': 'fallthrough',
  'step.commit_shadow': 'fallthrough',
  'checkpoint.expect_failed': 'fallthrough',
  'portal.unexpected_page': 'fallthrough',
  'portal.unknown_screen': 'fallthrough',
  'portal.unobservable': 'fallthrough',
  'wait.timeout': 'fallthrough',
  'verify.baseline_missing': 'fallthrough',
  'portal.blocked': 'fallthrough',
  'portal.captcha': 'fallthrough',
  'portal.mfa_pending': 'fallthrough',
  'portal.extra_auth_repeat': 'fallthrough',
  'portal.busy': 'fallthrough',
  'policy.cooldown': 'fallthrough',
  'chrome.not_installed': 'fallthrough',
  'package.not_loaded': 'fallthrough',
  'package.load_failed': 'fallthrough',
  'package.app_old': 'fallthrough',
  selector_placeholder: 'fallthrough',
  'verify.not_committed': 'fallthrough',
  pre_dispatch_mismatch: 'fallthrough',
  'step.pre_dispatch_mismatch': 'fallthrough',
  'issue.manual_declined': 'fallthrough',
  'api.refused': 'fallthrough',
  'api.not_committed': 'fallthrough',
  'run.handoff_timeout': 'human_wait',
  'human.ttl_expired': 'human_wait',
  'step.timeout': 'human_wait',
  bad_amount: 'stop',
  item_missing: 'stop',
  counterparty_missing: 'stop',
  profile_missing: 'stop',
  'input.missing': 'stop',
  'counterpart.bizno_rejected': 'stop',
  'step.fill_mismatch': 'stop',
  'run.stopped': 'stop',
  'run.aborted': 'stop',
  'gate.stopped': 'stop',
  'gate.denied': 'stop',
  'gate.expired': 'stop',
  'issue.consent_declined': 'stop',
  'issue.locked_elsewhere': 'stop',
  'issue.lock_unavailable': 'stop',
  'issue.lock_lost': 'stop',
  'commit.precheck_failed': 'stop',
  'issue.manual_reported': 'stop',
  'policy.irreversible_per_day': 'stop',
  'policy.poc_irreversible_total': 'stop',
  'policy.playbook_killed': 'stop',
  'policy.portal_mode_denied': 'stop',
  'vault.leak_suspected': 'stop',
  'ledger.issue_committed': 'stop',
  'ledger.issue_open': 'stop',
  'ledger_issue_committed': 'stop',
  'ledger_issue_open': 'stop',
};

const PREFIX: ReadonlyArray<readonly [string, Branch]> = [
  ['assert.', 'stop'],
  ['policy.', 'stop'],
  ['login.', 'fallthrough'],
  ['ir.', 'fallthrough'],
];

export function branchOf(code: string, stoppedAtStep?: string): Branch {
  const b = EXACT[code] ?? PREFIX.find(([p]) => code.startsWith(p))?.[1] ?? 'stop';
  if (b !== 'human_wait') return b;
  return stoppedAtStep !== undefined && PHASE_OF[stoppedAtStep] === 'login' ? 'fallthrough' : 'stop';
}
