// 발급 사다리 경로 표와 끝 코드 갈래 표(D03 §4.2). 앱에 내장된 표 하나가 순서와 "다음 길로 가도 되는가"를 정한다.
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

/**
 * 끝 코드 → 갈래. fallthrough = 홈택스 쪽 문제(다음 길로 가도 같은 건이 두 번 생기지 않고 바꾸면 될 수 있다).
 * stop = 바꿔도 안 되거나 바꾸면 안 된다(내용 오류·사장님 선택·상한·서버 정지). 표에 없는 코드는 stop(보이게 멈춘다).
 */
const EXACT: Readonly<Record<string, Branch | 'human_wait'>> = {
  // 로그인·인증
  'login.not_implemented': 'fallthrough',
  'sign.password_wrong': 'fallthrough',
  'sign.password_retry_limit': 'fallthrough',
  'sign.no_path': 'fallthrough',
  'sign.method_unknown': 'fallthrough',
  'sign.unsupported': 'fallthrough',
  'portal.logged_out_by_other_session': 'fallthrough',
  // 화면 불일치
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
  // 차단·캡차·추가 인증·대기열
  'portal.blocked': 'fallthrough',
  'portal.captcha': 'fallthrough',
  'portal.mfa_pending': 'fallthrough',
  'portal.extra_auth_repeat': 'fallthrough',
  'portal.busy': 'fallthrough',
  'policy.cooldown': 'fallthrough',
  // 연결·패키지
  'chrome.not_installed': 'fallthrough',
  'package.not_loaded': 'fallthrough',
  'package.load_failed': 'fallthrough',
  selector_placeholder: 'fallthrough',
  // 발급 안 됨 확정
  'verify.not_committed': 'fallthrough',
  pre_dispatch_mismatch: 'fallthrough',
  'step.pre_dispatch_mismatch': 'fallthrough',
  // 다른 칸
  'issue.manual_declined': 'fallthrough',
  'api.refused': 'fallthrough',
  'api.not_committed': 'fallthrough',
  // 사람 대기 시간 초과: 멈춘 스텝이 로그인 구간이면 fallthrough, 발급 화면 이후면 사장님이 직접 눌렀을 수 있어 stop
  'run.handoff_timeout': 'human_wait',
  'human.ttl_expired': 'human_wait',
  'step.timeout': 'human_wait',
  // 내용 오류
  bad_amount: 'stop',
  item_missing: 'stop',
  counterparty_missing: 'stop',
  profile_missing: 'stop',
  'input.missing': 'stop',
  'counterpart.bizno_rejected': 'stop',
  'step.fill_mismatch': 'stop',
  // 사장님 선택·승인 만료
  'run.stopped': 'stop',
  'run.aborted': 'stop',
  'gate.stopped': 'stop',
  'gate.denied': 'stop',
  'gate.expired': 'stop',
  'issue.consent_declined': 'stop',
  'issue.manual_reported': 'stop',
  'issue.manual_attested': 'stop',
  // 서버 정지·상한
  'policy.irreversible_per_day': 'stop',
  'policy.poc_irreversible_total': 'stop',
  'policy.playbook_killed': 'stop',
  'policy.portal_mode_denied': 'stop',
  'vault.leak_suspected': 'stop',
  // 같은 키가 이미 발급됐거나 결과를 모른다
  'ledger.issue_committed': 'stop',
  'ledger.issue_open': 'stop',
  'ledger_issue_committed': 'stop',
  'ledger_issue_open': 'stop',
};

/** 정확 코드 표에 없을 때의 접두 규칙(소수). */
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
